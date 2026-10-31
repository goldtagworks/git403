//! 긴 작업 `spawn_job`: argv 허용 목록만 해석한다. 지금은 `fetch [<remote>]`뿐(진행·종료는 `JobEvent`, 취소는 `JobHandle`).
//!
//! 앞에 붙는 `-c <키=값>`은 `fetch.writeCommitGraph`(commit-graph는 안 씀)와 `credential.*`(백엔드가 붙이는 gh 도우미 — gix가 설정에서
//! 직접 읽는 것과 별개로 이 값들은 적용하지 않고 무시)만 허용하고 다른 키는 `Unsupported`다. `--all`·`--prune`·`--tags`·`--progress` 같은
//! 플래그도 `Unsupported`(UI 툴바의 Fetch가 쓴다). `fetch.prune`·`remote.<이름>.prune`(·`pruneTags`)이 켜져 있으면 prune을 못 하므로 거절한다.
//! `reference-transaction` 훅이 있으면 거절한다. 비대화형(`ssh_batch`가 `Some`)이면 터미널 프롬프트를 끄고, `Some(true)`면 `core.sshCommand`를
//! `ssh -o BatchMode=yes`로 바꾼다(ssh 쪽 동작은 시험하지 못함). 한계: `FETCH_HEAD`를 쓰지 않는다. ssh 주소는 외부 `ssh`를 띄우므로 Android에서는 못 쓴다.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use gix::remote::Direction;
use tokio::sync::mpsc;

use super::common::{fail, open};
use crate::{Error, JobEvent, JobHandle, Result, Spawned};

/// 앞에 붙는 `-c <키=값>`을 건너뛴다(허용 키가 아니면 `Unsupported`). fetch·clone이 같이 쓴다.
pub(super) fn strip_config<'a, 'b>(argv: &'b [&'a str]) -> Result<&'b [&'a str]> {
    let mut a = argv;
    while let ["-c", kv, rest @ ..] = a {
        let key = kv.split('=').next().unwrap_or("").to_ascii_lowercase();
        if key != "fetch.writecommitgraph" && !key.starts_with("credential.") {
            return Err(Error::Unsupported(format!("spawn_job: -c {key}")));
        }
        a = rest;
    }
    Ok(a)
}

/// `["-c", kv]… "fetch" [remote]` → 원격 이름(없으면 기본 원격).
fn parse(argv: &[&str]) -> Result<Option<String>> {
    match strip_config(argv)? {
        ["fetch"] => Ok(None),
        ["fetch", remote] if !remote.starts_with('-') => Ok(Some((*remote).to_owned())),
        _ => Err(Error::Unsupported(format!("spawn_job: {}", argv.join(" ")))),
    }
}

/// reqwest(rustls-no-provider)는 암호 제공자를 프로세스에 한 번 설치해야 한다.
pub(super) fn init_tls() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// 원격을 안 줬을 때 gix가 고르는 기본 원격(분기의 원격, 없으면 `origin`·하나뿐인 원격)이 git과 같은 곳이 아닐 수 있는 설정은 거절한다:
/// `fetch.all`(모든 원격을 받음)과 분기 원격이 `.`.
fn guard_default_remote(r: &gix::Repository) -> Result<()> {
    if r.config_snapshot().boolean("fetch.all").unwrap_or(false) {
        return Err(Error::Unsupported("fetch(fetch.all)".into()));
    }
    let branch = r.head_name().ok().flatten().map(|n| n.shorten().to_string());
    match branch.and_then(|b| r.config_snapshot().string(&format!("branch.{b}.remote")).map(|v| v.to_string())) {
        Some(n) if n == "." => Err(Error::Unsupported("fetch(branch.remote = .)".into())),
        Some(_) => Ok(()),
        // 분기의 원격이 없을 때: origin이 있거나 원격이 하나뿐이면 gix와 git이 같은 곳을 고른다
        None => {
            let names = r.remote_names();
            if names.len() > 1 && !names.iter().any(|n| n.as_ref() as &gix::bstr::BStr == "origin") {
                return Err(Error::Unsupported("fetch(no origin among several remotes)".into()));
            }
            Ok(())
        }
    }
}

/// git은 서브모듈이 있으면 fetch/pull에서 서브모듈도 받는다(`fetch.recurseSubmodules` 기본 on-demand, `submodule.recurse`). 여기선 못 하므로
/// 작업 트리에 `.gitmodules`가 있거나 `submodule.recurse`가 true이거나 `fetch.recurseSubmodules`가 false가 아니면서 설정돼 있으면 거절한다.
fn guard_submodules(r: &gix::Repository) -> Result<()> {
    let cfg = r.config_snapshot();
    let recurse_off = cfg.string("fetch.recurseSubmodules").is_some() && cfg.boolean("fetch.recurseSubmodules") == Some(false);
    let has_modules = r.workdir().is_some_and(|w| w.join(".gitmodules").exists());
    let recurse_on = cfg.boolean("submodule.recurse").unwrap_or(false) || (cfg.string("fetch.recurseSubmodules").is_some() && !recurse_off);
    if recurse_on || (has_modules && !recurse_off) {
        return Err(Error::Unsupported("fetch(submodules)".into()));
    }
    Ok(())
}

/// 한 원격에서 받는다. `specs`가 있으면 설정의 fetch refspec 대신 그것만 받는다(pull의 `<remote> <branch>`). 반환 = (원격 이름, 결과).
pub(super) fn fetch_remote(repo: &Path, remote: Option<&str>, specs: Option<&[String]>, ssh_batch: Option<bool>, stop: &AtomicBool, events: &mpsc::UnboundedSender<JobEvent>) -> Result<(String, gix::remote::fetch::Outcome)> {
    init_tls();
    let mut r = open(repo)?;
    if let Some(h) = super::write::active_hook(&r, &["reference-transaction"]) {
        return Err(Error::Unsupported(format!("fetch(hook {h})")));
    }
    if remote.is_none() {
        guard_default_remote(&r)?;
    }
    guard_submodules(&r)?;
    let name = remote.map(gix::bstr::BStr::new);
    let remote = r.find_fetch_remote(name).map_err(fail)?;
    let label = remote.name().map_or_else(|| "remote".to_owned(), |n| n.as_bstr().to_string());
    let cfg = r.config_snapshot();
    if specs.is_none() && cfg.string(&format!("remote.{label}.followRemoteHEAD")).is_some_and(|v| !matches!(v.to_string().to_ascii_lowercase().as_str(), "create" | "never")) {
        return Err(Error::Unsupported("fetch(remote.followRemoteHEAD)".into()));
    }
    let on = |k: String| cfg.boolean(k.as_str()).unwrap_or(false);
    if on("fetch.prune".into()) || on("fetch.pruneTags".into()) || on(format!("remote.{label}.prune")) || on(format!("remote.{label}.pruneTags")) {
        return Err(Error::Unsupported("fetch(prune configured)".into()));
    }
    if let Some(batch) = ssh_batch {
        // 인증 입력 창이 없는 백그라운드 실행: 터미널 프롬프트를 끈다
        let mut c = r.config_snapshot_mut();
        c.set_value(&gix::config::tree::gitoxide::Credentials::TERMINAL_PROMPT, "false").map_err(fail)?;
        if batch {
            c.set_value(&gix::config::tree::Core::SSH_COMMAND, "ssh -o BatchMode=yes").map_err(fail)?;
        }
    }
    let mut remote = r.find_fetch_remote(name).map_err(fail)?;
    if let Some(specs) = specs {
        // 명령줄에 refspec을 주면 git은 태그를 따라 받지 않는다
        remote = remote.with_fetch_tags(gix::remote::fetch::Tags::None);
        remote.replace_refspecs(specs.iter().map(|s| gix::bstr::BStr::new(s.as_bytes())), Direction::Fetch).map_err(fail)?;
    }
    let _ = events.send(JobEvent::Progress { line: format!("Fetching {label}") });
    // 원격 HEAD를 알려면 광고 목록에 HEAD가 들어와야 한다(refspec에 없으면 gix가 안 물어본다)
    let mut opts = gix::remote::ref_map::Options::default();
    if specs.is_none() {
        opts.extra_refspecs.push(gix::refspec::parse("HEAD".into(), gix::refspec::parse::Operation::Fetch).map_err(fail)?.to_owned());
    }
    let mut conn = remote.connect(Direction::Fetch).map_err(super::auth::map_error)?;
    conn.set_credentials(super::auth::authenticator(r.clone()));
    let prepare = conn.prepare_fetch(gix::progress::Discard, opts).map_err(super::auth::map_error)?;
    let outcome = prepare.receive(gix::progress::Discard, stop).map_err(fail)?;
    if stop.load(Ordering::SeqCst) {
        return Err(Error::Cancelled);
    }
    // gix는 fsync를 안 하므로 받은 pack(→ 그 다음 ref) 순으로 디스크에 내린다(durable.rs)
    {
        use gix::remote::fetch::Status;
        let (edits, bundle) = match &outcome.status {
            Status::Change { update_refs, write_pack_bundle, .. } => (&update_refs.edits, Some(write_pack_bundle)),
            Status::NoPackReceived { update_refs, .. } => (&update_refs.edits, None),
        };
        if let Some(b) = bundle {
            let paths: Vec<&Path> = [b.data_path.as_deref(), b.index_path.as_deref()].into_iter().flatten().collect();
            super::durable::pack_files(&r, &paths)?;
        }
        super::durable::refs(&r, edits)?;
    }
    if specs.is_none() {
        follow_remote_head(&r, &label, &outcome)?;
    }
    Ok((label, outcome))
}

/// git 2.48+의 `remote.<name>.followRemoteHEAD`(기본 `create`): 설정된 fetch refspec 전체를 받았고 `refs/remotes/<name>/HEAD`가 없으면,
/// 원격 HEAD가 가리키는 브랜치의 원격 추적 ref를 가리키는 심볼릭 ref로 만든다. 있으면 건드리지 않는다(`never`면 아무것도 안 함).
fn follow_remote_head(r: &gix::Repository, label: &str, outcome: &gix::remote::fetch::Outcome) -> Result<()> {
    if r.config_snapshot().string(&format!("remote.{label}.followRemoteHEAD")).is_some_and(|v| v.to_string().eq_ignore_ascii_case("never")) {
        return Ok(());
    }
    let name = format!("refs/remotes/{label}/HEAD");
    if r.try_find_reference(name.as_str()).map_err(fail)?.is_some() {
        return Ok(());
    }
    let target = outcome.ref_map.remote_refs.iter().find_map(|x| match x {
        gix::protocol::handshake::Ref::Symbolic { full_ref_name, target, .. } if full_ref_name == "HEAD" => Some(target.to_string()),
        _ => None,
    });
    // 광고된 HEAD가 심볼릭이 아니거나(detached) 없으면 만들지 않는다
    let Some(target) = target else { return Ok(()) };
    let Some(local) = outcome.ref_map.mappings.iter().find(|m| m.remote.as_name().is_some_and(|n| n == target.as_str())).and_then(|m| match &m.local {
        Some(l) => Some(l.to_string()),
        None => None,
    }) else {
        return Ok(());
    };
    if !local.starts_with(&format!("refs/remotes/{label}/")) || r.try_find_reference(local.as_str()).map_err(fail)?.is_none() {
        return Ok(());
    }
    let who = r.committer().transpose().map_err(fail)?.map(|c| c.to_owned()).transpose().map_err(fail)?;
    let edit = gix::refs::transaction::RefEdit::update(name.as_str().try_into().map_err(fail)?, gix::refs::Target::Symbolic(local.as_str().try_into().map_err(fail)?), gix::refs::transaction::PreviousValue::MustNotExist, "remote: created from HEAD");
    let mut buf = Default::default();
    let done = r.edit_references_as(Some(edit), who.as_ref().map(|w| w.to_ref(&mut buf))).map_err(fail)?;
    super::durable::refs(r, &done)
}

/// 갱신된 ref를 진행 줄로 알린다.
pub(super) fn report(outcome: &gix::remote::fetch::Outcome, events: &mpsc::UnboundedSender<JobEvent>) {
    use gix::remote::fetch::refs::update::Mode;
    let (updates, edits) = match &outcome.status {
        gix::remote::fetch::Status::NoPackReceived { update_refs, .. } | gix::remote::fetch::Status::Change { update_refs, .. } => (&update_refs.updates, &update_refs.edits),
    };
    for (u, m) in updates.iter().zip(&outcome.ref_map.mappings) {
        let (tag, dst) = match (&u.mode, u.edit_index.and_then(|i| edits.get(i))) {
            (Mode::New, Some(e)) => ("[new ref]", e.name.shorten().to_string()),
            (Mode::FastForward | Mode::Forced, Some(e)) => ("updated", e.name.shorten().to_string()),
            _ => continue,
        };
        let src = m.remote.as_name().map(|n| n.to_string()).unwrap_or_default();
        let _ = events.send(JobEvent::Progress { line: format!(" * {tag} {src} -> {dst}") });
    }
}

fn fetch(repo: &Path, remote: Option<&str>, ssh_batch: Option<bool>, stop: &AtomicBool, events: &mpsc::UnboundedSender<JobEvent>) -> Result<()> {
    let (_, outcome) = fetch_remote(repo, remote, None, ssh_batch, stop, events)?;
    report(&outcome, events);
    Ok(())
}

pub(super) fn spawn(repo: &Path, argv: &[&str], ssh_batch: Option<bool>, events: mpsc::UnboundedSender<JobEvent>) -> Result<Spawned> {
    let remote = parse(argv)?;
    let repo = repo.to_path_buf();
    Ok(spawn_cancellable(events, move |stop, tx| fetch(&repo, remote.as_deref(), ssh_batch, stop, tx)))
}

/// 블로킹 작업 `job`을 돌리고 종료 `JobEvent`를 보낸다. 취소 신호(또는 핸들 전부 drop)는 `job`이 받는 중단 플래그로 옮긴다.
pub(super) fn spawn_cancellable(events: mpsc::UnboundedSender<JobEvent>, job: impl FnOnce(&AtomicBool, &mpsc::UnboundedSender<JobEvent>) -> Result<()> + Send + 'static) -> Spawned {
    let (handle, mut cancel) = JobHandle::detached();
    let stop = Arc::new(AtomicBool::new(false));
    let task = tokio::spawn(async move {
        let flag = stop.clone();
        let watcher = tokio::spawn(async move {
            let _ = cancel.wait_for(|c| *c).await;
            flag.store(true, Ordering::SeqCst);
        });
        let (stop2, tx) = (stop.clone(), events.clone());
        let res = tokio::task::spawn_blocking(move || job(&stop2, &tx)).await.map_err(fail)?;
        watcher.abort();
        let res = if stop.load(Ordering::SeqCst) && res.is_err() { Err(Error::Cancelled) } else { res };
        let _ = events.send(JobEvent::Finished { code: Some(if res.is_ok() { 0 } else { 1 }) });
        res
    });
    (handle, task)
}
