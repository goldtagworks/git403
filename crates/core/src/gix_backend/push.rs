//! 긴 작업 `push [--progress] [-u] [<remote> <branch>]`: smart HTTP(S) `git-receive-pack`(v0/v1 광고)을 gix 전송 계층 위에 직접 구현한다.
//! gitoxide 0.90에는 push가 없어서 ① 핸드셰이크(`gix::protocol::handshake`, 인증은 fetch와 같은 `configured_credentials_for_current_url`),
//! ② 명령 줄 `<old> <new> <ref>\0 report-status [side-band-64k] …` + flush, ③ pack(아래 `objects_to_send`·`write_pack`, 델타 없이 전부 base 객체),
//! ④ report-status 파싱을 한다. 앞의 `-c`는 fetch와 같은 규칙(`credential.*`는 gix가 설정에서 직접 읽으므로 무시).
//!
//! 받는 모양: `push [--progress] [-u|--set-upstream] <remote> <branch>`(`<branch>`는 `refs/heads/<branch>`로 있는 로컬 브랜치 하나, 원격 ref는 같은 이름)와
//! `push [--progress]`(추적 정보가 있는 현재 브랜치: `push.default` 없음·`simple`·`current`이고 `branch.<b>.merge`가 같은 이름일 때). 그 밖의 모양(force·`--tags`·`--delete`·refspec의 `:`·`+`·여러 브랜치)은 `Unsupported`.
//! 결과는 git과 같다: fast-forward가 아니면 보내지 않고 `! [rejected] … (non-fast-forward|fetch first)`·`error: failed to push some refs to '<url>'`·`hint:`(종료 1),
//! 서버가 `ng`하면 `! [remote rejected] … (<이유>)`(종료 1), 이미 최신이면 `Everything up-to-date`. 성공하면 원격 추적 ref를 `update by push` reflog와 함께 갱신하고 `-u`는 `branch.<b>.remote|merge`와 stdout 안내를 쓴다.
//! 인증 실패는 `fatal: Authentication failed for '<url>'`(128). 거절(`Unsupported`): ssh·`git://`·상대/호스트 있는 file 주소, 설정에 없는 원격 이름, 푸시 주소 여럿, `pre-push`·`reference-transaction` 훅, `push.followTags`·`push.gpgSign`·
//! `push.recurseSubmodules`·`submodule.recurse`·`push.pushOption`·`remote.<n>.mirror|receivepack|pushOption`·`advice.push*` 설정, 태그와 이름이 겹치는 브랜치, report-status가 없는 서버, v2로만 답하는 서버, sha256.
//! 한계: 델타를 안 만들어 큰 변경은 git보다 많이 올린다(thin pack·델타 재사용 없음), 서버 쪽 `quiet`·push option·atomic 미사용, 진행은 `Enumerating`/`Writing objects` 두 줄과 서버의 `remote:` 줄.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::ops::ControlFlow;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use gix::bstr::ByteSlice;
use gix::protocol::transport::client::{MessageKind, TransportWithoutIO, WriteMode};
use gix::protocol::transport::Service;
use gix::refs::transaction::{PreviousValue, RefEdit};
use gix::remote::Direction;
use gix::url::Scheme;
use gix::ObjectId;
use tokio::sync::mpsc;

use super::common::{committer, fail, open};
use super::fetch::{init_tls, spawn_cancellable, strip_config};
use super::write::active_hook;
use crate::{Error, JobEvent, Result, Spawned};

type Tx = mpsc::UnboundedSender<JobEvent>;

#[derive(Debug)]
struct Args {
    /// `None` = `git push`(현재 브랜치의 추적 정보)
    target: Option<(String, String)>,
    upstream: bool,
}

fn unsupported(what: impl Into<String>) -> Error {
    Error::Unsupported(format!("push({})", what.into()))
}

/// 푸시 argv면 `Some(Args)`, 아니면 `None`(→ fetch 쪽이 해석).
fn parse(argv: &[&str]) -> Result<Option<Args>> {
    let a = strip_config(argv)?;
    if a.first() != Some(&"push") {
        return Ok(None);
    }
    let (mut upstream, mut progress, mut rest) = (false, false, &a[1..]);
    while let Some((flag, tail)) = rest.split_first() {
        match *flag {
            "--progress" if !progress => progress = true,
            "-u" | "--set-upstream" if !upstream => upstream = true,
            _ => break,
        }
        rest = tail;
    }
    let plain = |s: &str| !s.is_empty() && !s.starts_with(['-', '+']) && !s.contains([':', '*', ' ']);
    match rest {
        [] if !upstream => Ok(Some(Args { target: None, upstream })),
        [remote, branch] if plain(remote) && plain(branch) && !branch.starts_with("refs/") && *branch != "HEAD" => {
            super::branch::check_name(branch).map_err(|_| unsupported(format!("branch name {branch}")))?;
            Ok(Some(Args { target: Some(((*remote).to_owned(), (*branch).to_owned())), upstream }))
        }
        _ => Err(Error::Unsupported(format!("spawn_job: {}", argv.join(" ")))),
    }
}

pub(super) fn spawn(repo: &Path, argv: &[&str], ssh_batch: Option<bool>, events: Tx) -> Option<Result<Spawned>> {
    let args = match parse(argv) {
        Ok(Some(a)) => a,
        Ok(None) => return None,
        Err(e) => return Some(Err(e)),
    };
    let repo = repo.to_path_buf();
    Some(Ok(spawn_cancellable(events, move |stop, tx| push(&repo, args, ssh_batch, stop, tx))))
}

fn exit1(stderr: String) -> Error {
    Error::Exit { code: Some(1), stderr }
}

fn truthy(cfg: &gix::config::Snapshot<'_>, key: &str) -> bool {
    cfg.string(key).is_some_and(|v| !matches!(v.to_string().to_ascii_lowercase().as_str(), "false" | "no" | "off" | "0"))
}

/// git과 같게 못 하는 설정·훅이 있으면 거절한다.
fn guard(r: &gix::Repository, remote: &str) -> Result<()> {
    if let Some(h) = active_hook(r, &["pre-push", "reference-transaction"]) {
        return Err(unsupported(format!("hook {h}")));
    }
    let cfg = r.config_snapshot();
    for key in ["push.followTags", "push.gpgSign", "push.recurseSubmodules", "submodule.recurse", "push.pushOption", "push.negotiate"] {
        if truthy(&cfg, key) {
            return Err(unsupported(key));
        }
    }
    for k in ["mirror", "receivepack", "pushOption", "vcs"] {
        let key = format!("remote.{remote}.{k}");
        if cfg.string(key.as_str()).is_some() {
            return Err(unsupported(key));
        }
    }
    // `advice.push*`가 있으면 hint 출력이 달라진다
    for sec in cfg.plumbing().sections_by_name("advice").into_iter().flatten() {
        if let Some(n) = sec.value_names().into_iter().find(|n| n.to_ascii_lowercase().starts_with("push")) {
            return Err(unsupported(format!("advice.{n}")));
        }
    }
    Ok(())
}

/// `refs/heads/<name>`이 `<name>`의 유일한 해석인지(태그·원격 추적 ref 등과 겹치면 git은 경고를 낸다) 확인하고 현재 값을 돌려준다.
fn local_branch(r: &gix::Repository, name: &str) -> Result<Option<ObjectId>> {
    let top_level = r.git_dir().join(name).is_file() || r.common_dir().join("refs").join(name).is_file();
    if top_level {
        return Err(unsupported(format!("ambiguous ref name {name}")));
    }
    for other in [format!("refs/tags/{name}"), format!("refs/remotes/{name}"), format!("refs/remotes/{name}/HEAD")] {
        if r.try_find_reference(other.as_str()).map_err(fail)?.is_some() {
            return Err(unsupported(format!("ambiguous ref name {name}")));
        }
    }
    let Some(mut reference) = r.try_find_reference(format!("refs/heads/{name}").as_str()).map_err(fail)? else { return Ok(None) };
    Ok(Some(reference.peel_to_id().map_err(fail)?.detach()))
}

/// 인자 없는 `git push`가 가는 곳: (원격, 브랜치).
fn default_target(r: &gix::Repository) -> Result<(String, String)> {
    let cfg = r.config_snapshot();
    let Some(head) = r.head_name().map_err(fail)? else { return Err(unsupported("detached HEAD")) };
    let b = head.shorten().to_string();
    if cfg.string("push.default").is_some_and(|v| !matches!(v.to_string().to_ascii_lowercase().as_str(), "simple" | "current")) || cfg.string("remote.pushDefault").is_some() || cfg.string(format!("branch.{b}.pushRemote").as_str()).is_some() {
        return Err(unsupported("push.default / pushRemote"));
    }
    let remote = cfg.string(format!("branch.{b}.remote").as_str()).map(|v| v.to_string());
    let merge = cfg.string(format!("branch.{b}.merge").as_str()).map(|v| v.to_string());
    match (remote, merge) {
        (Some(rm), Some(m)) if rm != "." && m == format!("refs/heads/{b}") && cfg.string(format!("remote.{rm}.push").as_str()).is_none() => Ok((rm, b)),
        _ => Err(unsupported("no usable tracking information")),
    }
}

/// `u`가 보낼 수 있는 주소인지(https·http·호스트 없는 절대 file) 확인한다.
fn check_url(u: &gix::url::Url) -> Result<()> {
    match u.scheme {
        Scheme::Https | Scheme::Http => Ok(()),
        Scheme::File if u.host().is_none() && Path::new(&u.path.to_str_lossy().into_owned()).is_absolute() => Ok(()),
        Scheme::File => Err(unsupported("relative or remote file URL")),
        ref s => Err(unsupported(format!("{} URL", s.as_str()))),
    }
}

/// git이 `To <url>`에 보이는 주소: 사용자 정보(`user:token@`)를 뺀다.
fn display_url(u: &gix::url::Url) -> String {
    let mut u = u.clone();
    u.user = None;
    u.password = None;
    u.to_bstring().to_string()
}

#[derive(Clone, Copy, PartialEq)]
enum Plan {
    UpToDate,
    New,
    FastForward(ObjectId),
    Reject(&'static str),
}

/// 원격 추적 ref: 원격의 fetch refspec 중 `dst`(원격 쪽 ref)를 받는 것의 로컬 이름.
fn tracking_ref(remote: &gix::Remote<'_>, dst: &str) -> Option<String> {
    for spec in remote.refspecs(Direction::Fetch) {
        let spec = spec.to_ref();
        let (Some(src), Some(to)) = (spec.source(), spec.destination()) else { continue };
        let (src, to) = (src.to_string(), to.to_string());
        let local = match (src.strip_suffix('*'), to.strip_suffix('*')) {
            (Some(sp), Some(tp)) => dst.strip_prefix(sp).map(|rest| format!("{tp}{rest}")),
            (None, None) if src == dst => Some(to),
            _ => None,
        };
        if local.is_some() {
            return local;
        }
    }
    None
}

fn push(repo: &Path, args: Args, ssh_batch: Option<bool>, stop: &AtomicBool, events: &Tx) -> Result<()> {
    init_tls();
    let mut r = open(repo)?;
    let (remote_name, branch) = match &args.target {
        Some((rm, b)) => (rm.clone(), b.clone()),
        None => default_target(&r)?,
    };
    guard(&r, &remote_name)?;
    if let Some(batch) = ssh_batch {
        // 인증 입력 창이 없는 백그라운드 실행: 터미널 프롬프트를 끈다 (fetch와 같음)
        let mut c = r.config_snapshot_mut();
        c.set_value(&gix::config::tree::gitoxide::Credentials::TERMINAL_PROMPT, "false").map_err(fail)?;
        if batch {
            c.set_value(&gix::config::tree::Core::SSH_COMMAND, "ssh -o BatchMode=yes").map_err(fail)?;
        }
    }
    let remote = r.find_remote(remote_name.as_str()).map_err(|_| unsupported("remote is not configured"))?;
    {
        let cfg = r.config_snapshot();
        let n = |k: &str| cfg.plumbing().raw_values_by("remote", Some(gix::bstr::BStr::new(&remote_name)), k).map(|v| v.len()).unwrap_or(0);
        if n("pushurl") > 1 || (n("pushurl") == 0 && n("url") > 1) {
            return Err(unsupported("several URLs"));
        }
    }
    let url = remote.url(Direction::Push).ok_or_else(|| unsupported("remote has no URL"))?.clone();
    check_url(&url)?;
    let shown = display_url(&url);
    let who_tracks = tracking_ref(&remote, &format!("refs/heads/{branch}"));
    if args.upstream && who_tracks.is_none() {
        return Err(unsupported("-u: no fetch refspec tracks the branch"));
    }
    let new = local_branch(&r, &branch)?;

    let stopped = || stop.load(Ordering::SeqCst);
    let mut log: Vec<String> = Vec::new();
    let mut say = |s: String| {
        log.push(s.clone());
        let _ = events.send(JobEvent::Progress { line: s });
    };
    let mut conn = remote.connect(Direction::Push).map_err(|e| connect_error(e, &shown))?;
    let mut auth = conn.configured_credentials_for_current_url();
    let transport_url = conn.transport_mut().to_url().into_owned();
    if let Some(opts) = r.transport_options(transport_url.as_bstr(), remote.name().map(|n| n.as_bstr())).map_err(fail)? {
        conn.transport_mut().configure(&*opts).map_err(fail)?;
    }
    let hs = gix::protocol::handshake(conn.transport_mut(), Service::ReceivePack, &mut auth, Vec::new(), &mut gix::progress::Discard).map_err(|e| connect_error(e, &shown))?;
    if stopped() {
        return Err(Error::Cancelled);
    }
    let adv = hs.refs.ok_or_else(|| unsupported("server answered protocol v2"))?;
    let caps = &hs.capabilities;
    if !caps.contains("report-status") {
        return Err(unsupported("server has no report-status"));
    }
    if caps.capability("object-format").and_then(|c| c.value().map(|v| v.to_string())).is_some_and(|v| v != "sha1") {
        return Err(unsupported("object-format"));
    }
    let sideband = caps.contains("side-band-64k");
    let mut remote_value: HashMap<String, ObjectId> = HashMap::new();
    let mut known_tips: Vec<ObjectId> = Vec::new();
    for x in &adv {
        use gix::protocol::handshake::Ref;
        match x {
            Ref::Direct { full_ref_name, object } => {
                remote_value.insert(full_ref_name.to_string(), *object);
                known_tips.push(*object);
            }
            Ref::Peeled { full_ref_name, tag, object } => {
                remote_value.insert(full_ref_name.to_string(), *tag);
                known_tips.push(*object);
            }
            Ref::Symbolic { .. } | Ref::Unborn { .. } => {}
        }
    }

    let dst = format!("refs/heads/{branch}");
    let Some(new) = new else {
        say(format!("error: src refspec {branch} does not match any"));
        say(format!("error: failed to push some refs to '{shown}'"));
        return Err(exit1(log.join("\n")));
    };
    let old = remote_value.get(&dst).copied();
    let plan = match old {
        Some(old) if old == new => Plan::UpToDate,
        None => Plan::New,
        Some(old) if !r.has_object(old) => Plan::Reject("fetch first"),
        Some(old) => {
            let is_commit = |id: ObjectId| r.find_object(id).is_ok_and(|o| o.kind == gix::object::Kind::Commit);
            if !is_commit(old) {
                return Err(unsupported("remote ref is not a commit"));
            }
            if r.merge_base(old, new).ok().flatten().map(gix::Id::detach) == Some(old) { Plan::FastForward(old) } else { Plan::Reject("non-fast-forward") }
        }
    };

    let abbrev = |id: ObjectId| r.find_object(id).map(|o| o.id().shorten_or_id().to_string()).unwrap_or_else(|_| id.to_hex_with_len(7).to_string());
    let width = 17;
    let line = |flag: char, summary: &str, tail: &str| format!(" {flag} {summary:<width$} {branch} -> {branch}{tail}");
    let head_is_dst = r.head_name().ok().flatten().is_some_and(|h| h.as_bstr() == dst.as_bytes());
    let mut ok = matches!(plan, Plan::UpToDate);
    match plan {
        Plan::UpToDate => {
            say("Everything up-to-date".into());
        }
        Plan::Reject(reason) => {
            say(format!("To {shown}"));
            say(line('!', "[rejected]", &format!(" ({reason})")));
            say(format!("error: failed to push some refs to '{shown}'"));
            for h in reject_hint(reason, head_is_dst) {
                say(format!("hint: {h}"));
            }
        }
        Plan::New | Plan::FastForward(_) => {
            let hidden: Vec<ObjectId> = known_tips.iter().copied().filter(|t| r.has_object(*t)).collect();
            let ids = objects_to_send(&r, new, &hidden, stop)?;
            say(format!("Enumerating objects: {}, done.", ids.len()));
            let zero = r.object_hash().null();
            let mut caps_line = String::from("report-status");
            if sideband {
                caps_line.push_str(" side-band-64k");
            }
            if caps.contains("object-format") {
                caps_line.push_str(" object-format=sha1");
            }
            caps_line.push_str(" agent=git403");
            let command = format!("{} {new} {dst}\0 {caps_line}", old.unwrap_or(zero));
            let mut w = conn.transport_mut().request(WriteMode::Binary, MessageKind::Flush, false).map_err(fail)?;
            w.write_all(command.as_bytes()).map_err(fail)?;
            w.write_message(MessageKind::Flush).map_err(fail)?;
            let (mut raw, mut reader) = w.into_parts();
            write_pack(&r, &ids, &mut raw, stop)?;
            raw.flush().map_err(fail)?;
            drop(raw);
            say(format!("Writing objects: 100% ({n}/{n}), done.", n = ids.len()));
            // 보낸 뒤에는 취소해도 서버의 답을 끝까지 읽고 로컬 상태를 맞춘다
            let tx = events.clone();
            if sideband {
                // 줄 하나가 pkt 하나로 오고 gix가 끝 개행을 뗀다. git이 `remote: <줄>` 뒤에 공백 8칸(`DUMB_SUFFIX`)을 붙이는 것까지 같게 한다.
                reader.set_progress_handler(Some(Box::new(move |_is_err, data| {
                    for l in String::from_utf8_lossy(data).split(['\n', '\r']).filter(|l| !l.is_empty()) {
                        let _ = tx.send(JobEvent::Progress { line: format!("remote: {l}        ") });
                    }
                    ControlFlow::Continue(())
                })));
            }
            let mut body = Vec::new();
            reader.read_to_end(&mut body).map_err(fail)?;
            drop(reader);
            let (unpack, status) = parse_report(&body, sideband)?;
            say(format!("To {shown}"));
            match (unpack.as_str(), status.get(&dst)) {
                ("ok", Some(None)) => {
                    ok = true;
                    let tail = match plan {
                        Plan::New => line('*', "[new branch]", ""),
                        _ => line(' ', &format!("{}..{}", abbrev(old.unwrap_or(zero)), abbrev(new)), ""),
                    };
                    say(tail);
                }
                (u, st) => {
                    let reason = match (u, st) {
                        ("ok", Some(Some(why))) => why.clone(),
                        ("ok", _) => "no status".to_owned(),
                        (u, _) => {
                            say(format!("error: remote unpack failed: {u}"));
                            "n/a (unpacker error)".to_owned()
                        }
                    };
                    say(line('!', "[remote rejected]", &format!(" ({reason})")));
                    say(format!("error: failed to push some refs to '{shown}'"));
                }
            }
        }
    }
    drop(conn);
    if !ok {
        return Err(exit1(log.join("\n")));
    }
    // 원격 추적 ref(이미 최신이어도 값이 다르거나 없으면 맞춘다)와 `-u`
    if let Some(local) = who_tracks {
        let current = r.try_find_reference(local.as_str()).map_err(fail)?.and_then(|mut f| f.peel_to_id().ok().map(gix::Id::detach));
        if current != Some(new) {
            let who = committer(&r)?;
            let edit = RefEdit::update(local.as_str().try_into().map_err(fail)?, gix::refs::Target::Object(new), PreviousValue::Any, "update by push");
            let done = r.edit_references_as(Some(edit), Some(who.to_ref(&mut Default::default()))).map_err(fail)?;
            super::durable::refs(&r, &done)?;
        }
        if args.upstream {
            let short = local.trim_start_matches("refs/remotes/").to_owned();
            let t = super::branch::Track { remote: remote_name.clone(), merge: dst.clone(), short };
            let (lock, msg) = super::branch::stage_tracking(&r, &branch, &t)?;
            lock.commit()?;
            let _ = events.send(JobEvent::Stdout { line: String::from_utf8_lossy(&msg).trim_end().to_owned() });
        }
    }
    Ok(())
}

/// 연결·인증 단계 오류를 git이 내는 종류로 바꾼다: 인증 실패는 128 `Authentication failed`.
fn connect_error(e: impl std::fmt::Display + std::fmt::Debug, shown: &str) -> Error {
    let text = format!("{e:?} {e}").to_ascii_lowercase();
    if ["credentials", "authenticat", "unauthorized", "terminal prompts", "prompt"].iter().any(|k| text.contains(k)) {
        return Error::Exit { code: Some(128), stderr: format!("fatal: Authentication failed for '{shown}'") };
    }
    fail(e)
}

fn reject_hint(reason: &str, head_is_dst: bool) -> Vec<&'static str> {
    match (reason, head_is_dst) {
        ("fetch first", _) => vec![
            "Updates were rejected because the remote contains work that you do not",
            "have locally. This is usually caused by another repository pushing to",
            "the same ref. If you want to integrate the remote changes, use",
            "'git pull' before pushing again.",
            "See the 'Note about fast-forwards' in 'git push --help' for details.",
        ],
        (_, true) => vec![
            "Updates were rejected because the tip of your current branch is behind",
            "its remote counterpart. If you want to integrate the remote changes,",
            "use 'git pull' before pushing again.",
            "See the 'Note about fast-forwards' in 'git push --help' for details.",
        ],
        (_, false) => vec![
            "Updates were rejected because a pushed branch tip is behind its remote",
            "counterpart. If you want to integrate the remote changes, use 'git pull'",
            "before pushing again.",
            "See the 'Note about fast-forwards' in 'git push --help' for details.",
        ],
    }
}

/// 서버에 없는 객체: `new`에서 닿는 커밋(서버가 가진 `hidden` 팁에서 닿는 것은 제외)과, 각 커밋의 트리가 부모 트리들과 달라진 트리·blob.
/// 부모와 같은 항목은 그 부모(보내거나 서버에 이미 있음)가 덮는다. 서브모듈(gitlink)은 보내지 않는다. 부모 객체가 없으면(얕은 저장소) 그 부모는 없는 것으로 보고 다 보낸다.
fn objects_to_send(r: &gix::Repository, new: ObjectId, hidden: &[ObjectId], stop: &AtomicBool) -> Result<Vec<ObjectId>> {
    let mut out: Vec<ObjectId> = Vec::new();
    let mut seen: HashSet<ObjectId> = HashSet::new();
    let hide: Vec<ObjectId> = hidden.iter().filter_map(|id| r.find_object(*id).ok()?.peel_to_commit().ok().map(|c| c.id)).collect();
    let walk = r.rev_walk([new]).with_hidden(hide).all().map_err(fail)?;
    for info in walk {
        if stop.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        let info = info.map_err(fail)?;
        let commit = r.find_commit(info.id).map_err(fail)?;
        if seen.insert(info.id) {
            out.push(info.id);
        }
        let tree = commit.tree_id().map_err(fail)?.detach();
        let parents: Vec<ObjectId> = commit.parent_ids().filter_map(|p| r.find_commit(p).ok()?.tree_id().ok().map(gix::Id::detach)).collect();
        if !parents.contains(&tree) {
            add_tree(r, tree, &parents, &mut seen, &mut out)?;
        }
    }
    Ok(out)
}

fn entries(r: &gix::Repository, tree: ObjectId) -> Result<Vec<(Vec<u8>, gix::objs::tree::EntryMode, ObjectId)>> {
    let t = r.find_tree(tree).map_err(fail)?;
    let decoded = t.decode().map_err(fail)?;
    Ok(decoded.entries.iter().map(|e| (e.filename.to_vec(), e.mode, e.oid.to_owned())).collect())
}

fn add_tree(r: &gix::Repository, tree: ObjectId, parents: &[ObjectId], seen: &mut HashSet<ObjectId>, out: &mut Vec<ObjectId>) -> Result<()> {
    if !seen.insert(tree) {
        return Ok(());
    }
    out.push(tree);
    let parent_entries: Vec<_> = parents.iter().filter_map(|p| entries(r, *p).ok()).collect();
    for (name, mode, oid) in entries(r, tree)? {
        if mode.is_commit() {
            continue;
        }
        let same: Vec<&(Vec<u8>, gix::objs::tree::EntryMode, ObjectId)> = parent_entries.iter().flat_map(|pe| pe.iter().filter(|(n, _, _)| *n == name)).collect();
        if same.iter().any(|(_, _, o)| *o == oid) {
            continue;
        }
        if mode.is_tree() {
            let subs: Vec<ObjectId> = same.iter().filter(|(_, m, _)| m.is_tree()).map(|(_, _, o)| *o).collect();
            add_tree(r, oid, &subs, seen, out)?;
        } else if seen.insert(oid) {
            out.push(oid);
        }
    }
    Ok(())
}

/// pack v2를 델타 없이 쓴다: `PACK` 헤더 + 객체마다 (종류·크기 헤더 + zlib) + SHA-1.
fn write_pack(r: &gix::Repository, ids: &[ObjectId], out: &mut dyn Write, stop: &AtomicBool) -> Result<()> {
    use gix::object::Kind;
    let mut w = gix::hash::io::Write::new(out, r.object_hash());
    let io = fail;
    w.write_all(b"PACK").map_err(io)?;
    w.write_all(&2u32.to_be_bytes()).map_err(io)?;
    w.write_all(&u32::try_from(ids.len()).map_err(|_| unsupported("too many objects"))?.to_be_bytes()).map_err(io)?;
    for id in ids {
        if stop.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        let obj = r.find_object(*id).map_err(fail)?;
        let code: u8 = match obj.kind {
            Kind::Commit => 1,
            Kind::Tree => 2,
            Kind::Blob => 3,
            Kind::Tag => 4,
        };
        let mut size = obj.data.len() as u64;
        let mut first = (code << 4) | (size & 0x0f) as u8;
        size >>= 4;
        let mut header = Vec::new();
        while size > 0 {
            header.push(first | 0x80);
            first = (size & 0x7f) as u8;
            size >>= 7;
        }
        header.push(first);
        w.write_all(&header).map_err(io)?;
        let mut z = gix::zlib::stream::deflate::Write::new(Vec::new(), gix::zlib::Compression::DEFAULT);
        z.write_all(&obj.data).map_err(fail)?;
        z.flush().map_err(fail)?;
        w.write_all(&z.into_inner()).map_err(io)?;
    }
    let digest = w.hash.clone().try_finalize().map_err(fail)?;
    w.inner.write_all(digest.as_slice()).map_err(io)?;
    Ok(())
}

/// report-status: `unpack <ok|오류>`와 ref마다 `ok <ref>`(= `None`) 또는 `ng <ref> <이유>`(= `Some(이유)`).
/// side-band이면 바깥 pkt-line을 벗긴 데이터가 다시 pkt-line 묶음이고, 아니면 줄(개행 포함)이 이어진 바이트다.
fn parse_report(body: &[u8], sideband: bool) -> Result<(String, HashMap<String, Option<String>>)> {
    let lines: Vec<String> = if sideband {
        let (mut v, mut i) = (Vec::new(), 0);
        while i + 4 <= body.len() {
            let n = usize::from_str_radix(std::str::from_utf8(&body[i..i + 4]).map_err(fail)?, 16).map_err(fail)?;
            if n == 0 {
                break;
            }
            if n < 4 || i + n > body.len() {
                return Err(Error::Exit { code: Some(128), stderr: "fatal: bad report-status from the remote".into() });
            }
            v.push(String::from_utf8_lossy(&body[i + 4..i + n]).trim_end_matches('\n').to_owned());
            i += n;
        }
        v
    } else {
        String::from_utf8_lossy(body).lines().map(str::to_owned).collect()
    };
    let mut it = lines.into_iter();
    let unpack = it.next().and_then(|l| l.strip_prefix("unpack ").map(str::to_owned)).ok_or_else(|| Error::Exit { code: Some(128), stderr: "fatal: the remote end hung up unexpectedly".into() })?;
    let mut status = HashMap::new();
    for l in it {
        if let Some(name) = l.strip_prefix("ok ") {
            status.insert(name.to_owned(), None);
        } else if let Some(rest) = l.strip_prefix("ng ") {
            let (name, why) = rest.split_once(' ').unwrap_or((rest, ""));
            status.insert(name.to_owned(), Some(why.to_owned()));
        }
    }
    Ok((unpack, status))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 받는_모양만_해석한다() {
        let a = |v: &[&str]| parse(v);
        assert!(matches!(a(&["fetch"]), Ok(None)));
        assert!(matches!(a(&["push", "--progress"]), Ok(Some(Args { target: None, upstream: false }))));
        assert!(matches!(a(&["push", "--progress", "-u", "origin", "main"]), Ok(Some(Args { upstream: true, .. }))));
        assert!(matches!(a(&["-c", "credential.https://github.com.helper=", "push", "origin", "feat/x"]), Ok(Some(Args { upstream: false, .. }))));
        for bad in [
            &["push", "--progress", "-u"][..],
            &["push", "--force", "origin", "main"],
            &["push", "--progress", "--force-with-lease", "--force-if-includes", "origin", "main"],
            &["push", "--progress", "--tags", "origin", "main"],
            &["push", "--progress", "origin", "--delete", "refs/heads/x"],
            &["push", "origin", "main:other"],
            &["push", "origin", "+main"],
            &["push", "origin"],
            &["push", "origin", "main", "dev"],
            &["push", "--progress", "origin", "refs/tags/v1"],
        ] {
            assert!(matches!(a(bad), Err(Error::Unsupported(_))), "{bad:?}");
        }
    }

    #[test]
    fn report를_읽는다() {
        let pkt = |l: &str| format!("{:04x}{l}\n", l.len() + 5);
        let body = format!("{}{}{}0000", pkt("unpack ok"), pkt("ok refs/heads/main"), pkt("ng refs/heads/x pre-receive hook"));
        let (u, s) = parse_report(body.as_bytes(), true).unwrap();
        assert_eq!(u, "ok");
        assert_eq!(s["refs/heads/main"], None);
        assert_eq!(s["refs/heads/x"], Some("pre-receive hook".into()));
        let (u, s) = parse_report(b"unpack index-pack abnormal exit\nng refs/heads/main n/a (unpacker error)\n", false).unwrap();
        assert_eq!(u, "index-pack abnormal exit");
        assert_eq!(s["refs/heads/main"], Some("n/a (unpacker error)".into()));
    }
}
