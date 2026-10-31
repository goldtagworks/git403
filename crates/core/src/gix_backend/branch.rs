//! `branch` (run 허용 목록): 만들기 `branch <name> [<start>]`, 지우기 `branch -d|-D <name>`, 이름 바꾸기 `branch -m <old> <new>`.
//! 만들기와 추적 설정은 `switch -c`도 쓴다.
//!
//! 원칙은 write.rs와 같다: git과 같게 못 하면 거절(`Unsupported`). 거절 — `reference-transaction` 훅이 있을 때, 진행 중인 머지·리베이스 등, 다른 worktree가 있을 때(지우기·이름 바꾸기),
//! `branch.autoSetupMerge`가 `true`·`false`가 아닐 때, 시작점이 원격 추적 브랜치인데 그걸 받는 원격을 못 찾을 때, `-m`으로 같은 이름·커밋 없는 HEAD의 브랜치.
//! 오류 메시지 첫 줄은 git과 같다(뒤의 `hint:` 줄은 안 붙인다). 지울 때 stdout `Deleted branch x (was abc1234).`, 추적을 걸면 `branch 'x' set up to track 'origin/x'.`.
//! 이름 바꾸기는 reflog(`Branch: renamed …`)·`[branch "x"]` 설정 절·HEAD를 같이 옮긴다. 추가 거절: 커밋 없는 현재 브랜치의 `-m`(git은 이름만 바꿈), 새 이름의 `[branch]` 절이 이미 있을 때.
//!
//! ref와 설정은 반쪽만 바뀌지 않게 한다: `config.lock`을 먼저 잡고 고친 내용을 잠금 파일에 미리 써 둔 뒤(여기서 실패하면 아무것도 안 바뀜) ref 트랜잭션을 하고 마지막에 설정을 rename한다.
//! 이름 바꾸기의 reflog 이동은 ref 트랜잭션이 성공한 뒤에 한다(옛 로그 내용을 앞에 붙임).

use std::path::Path;

use gix::bstr::ByteSlice;
use gix::refs::transaction::{PreviousValue, RefEdit};
use gix::refs::{FullName, Target};
use gix::remote::Direction;

use super::common::{append_head_log, committer, fail, fs_path, open, ConfigLock};
use super::write::{active_hook, exit, unsupported};
use crate::{Error, Result};

pub(super) struct Track {
    pub remote: String,
    pub merge: String,
    pub short: String,
}

pub(super) fn check_name(name: &str) -> Result<()> {
    full(name).map(|_| ())
}

fn full(name: &str) -> Result<FullName> {
    let bad = || exit(128, format!("fatal: '{name}' is not a valid branch name"));
    if name == "HEAD" || name.starts_with('-') {
        return Err(bad());
    }
    FullName::try_from(format!("refs/heads/{name}")).map_err(|_| bad())
}

fn guard(r: &gix::Repository) -> Result<()> {
    if let Some(h) = active_hook(r, &["reference-transaction"]) {
        return Err(unsupported(&format!("branch(hook {h})")));
    }
    Ok(())
}

pub(super) fn exists(r: &gix::Repository, name: &str) -> Result<bool> {
    Ok(r.try_find_reference(full(name)?.as_ref()).map_err(fail)?.is_some())
}

/// 리비전 문자열 → 커밋 id (없거나 커밋이 아니면 None).
pub(super) fn resolve_commit(r: &gix::Repository, spec: &str) -> Option<gix::ObjectId> {
    let id = r.rev_parse_single(spec).ok()?;
    id.object().ok()?.peel_to_commit().ok().map(|c| c.id)
}

/// 시작점이 원격 추적 브랜치면 추적 설정(`branch.<n>.remote`·`merge`)을 돌려준다. git의 `branch.autoSetupMerge`(기본 true: 원격 브랜치에서 만들 때만 추적)를 따른다.
/// `force`(`--track`)면 설정이 `false`여도 건다. 원격 브랜치가 아니면 None(force인데 아니면 `Unsupported`).
pub(super) fn tracking_for(r: &gix::Repository, start: &str, force: bool) -> Result<Option<Track>> {
    let setup = r.config_snapshot().string("branch.autoSetupMerge").map(|v| v.to_string().to_ascii_lowercase());
    let off = match setup.as_deref() {
        None | Some("true" | "yes" | "on" | "1") => false,
        Some("false" | "no" | "off" | "0") => true,
        Some(_) => return Err(unsupported("branch(branch.autoSetupMerge)")),
    };
    // git의 ref 이름 찾는 순서(`start`, `refs/start`, `refs/tags/`, `refs/heads/`, `refs/remotes/`, `refs/remotes/<start>/HEAD`)는 gix의 `try_find_reference`와 같다
    let plain = !start.is_empty() && !start.contains(['~', '^', '@', ':', '{', '}', ' ']) && !start.contains("..");
    let found = if plain { r.try_find_reference(start).ok().flatten().map(|f| f.name().as_bstr().to_string()) } else { None };
    let Some(refname) = found.filter(|n| n.starts_with("refs/remotes/")) else {
        return if force { Err(unsupported("branch(--track on a non remote-tracking start)")) } else { Ok(None) };
    };
    if off && !force {
        return Ok(None);
    }
    if refname.ends_with("/HEAD") {
        return Err(unsupported("branch(tracking a remote HEAD)"));
    }
    for name in r.remote_names() {
        let remote = r.find_remote(name.as_bstr()).map_err(fail)?;
        for spec in remote.refspecs(Direction::Fetch) {
            let spec = spec.to_ref();
            let (Some(src), Some(dst)) = (spec.source(), spec.destination()) else { continue };
            let (src, dst) = (src.to_string(), dst.to_string());
            let merge = match (dst.strip_suffix('*'), src.strip_suffix('*')) {
                (Some(dp), Some(sp)) => refname.strip_prefix(dp).map(|rest| format!("{sp}{rest}")),
                (None, None) if dst == refname => Some(src),
                _ => None,
            };
            if let Some(merge) = merge {
                return Ok(Some(Track { remote: name.to_string(), merge, short: refname.trim_start_matches("refs/remotes/").to_owned() }));
            }
        }
    }
    if force { Err(unsupported("branch(no remote tracks this ref)")) } else { Ok(None) }
}

/// 브랜치를 만드는 ref 편집(reflog `branch: Created from <start>`). 이미 있으면 git과 같은 128 오류.
pub(super) fn create_edit(r: &gix::Repository, name: &str, start_label: &str, id: gix::ObjectId) -> Result<RefEdit> {
    let full = full(name)?;
    if exists(r, name)? {
        return Err(exit(128, format!("fatal: a branch named '{name}' already exists")));
    }
    Ok(RefEdit::update(full, id, PreviousValue::MustNotExist, format!("branch: Created from {start_label}")))
}

/// 추적 설정을 잠근 설정에 써서 잠금 파일에 미리 쓴다. 반환 = (잠금, 안내 줄).
pub(super) fn stage_tracking(r: &gix::Repository, name: &str, t: &Track) -> Result<(ConfigLock, Vec<u8>)> {
    let mut lock = ConfigLock::acquire(r)?;
    let sub = Some(gix::bstr::BStr::new(name));
    lock.cfg().set_raw_value_by("branch", sub, "remote", t.remote.as_str()).map_err(fail)?;
    lock.cfg().set_raw_value_by("branch", sub, "merge", t.merge.as_str()).map_err(fail)?;
    lock.stage()?;
    Ok((lock, format!("branch '{name}' set up to track '{}'.\n", t.short).into_bytes()))
}

/// 브랜치 ref를 만들고 추적 설정을 쓴다. 반환 = 추적 안내 줄(stdout).
fn create(r: &gix::Repository, name: &str, start_label: &str, id: gix::ObjectId, track: Option<&Track>) -> Result<Vec<u8>> {
    let edit = create_edit(r, name, start_label, id)?;
    let who = committer(r)?;
    let staged = track.map(|t| stage_tracking(r, name, t)).transpose()?;
    r.edit_references_as(Some(edit), Some(who.to_ref(&mut Default::default()))).map_err(fail)?;
    match staged {
        Some((lock, msg)) => lock.commit().map(|()| msg),
        None => Ok(Vec::new()),
    }
}

pub(super) fn run(repo: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let r = open(repo)?;
    guard(&r)?;
    match args {
        [name] if !name.starts_with('-') => make(&r, name, None),
        [name, start] if !name.starts_with('-') && !start.starts_with('-') => make(&r, name, Some(start)),
        [flag @ ("-d" | "-D"), name] if !name.starts_with('-') => delete(&r, name, *flag == "-D"),
        ["-m", old, new] if !old.starts_with('-') && !new.starts_with('-') => rename(&r, old, new),
        _ => Err(Error::Unsupported(format!("run: branch {}", args.join(" ")))),
    }
}

fn make(r: &gix::Repository, name: &str, start: Option<&str>) -> Result<Vec<u8>> {
    full(name)?;
    if exists(r, name)? {
        return Err(exit(128, format!("fatal: a branch named '{name}' already exists")));
    }
    // 시작점을 안 주면 git은 현재 브랜치 이름(detached면 HEAD)을 시작점 이름으로 쓴다(reflog·오류 메시지)
    let label = start.map(str::to_owned).unwrap_or_else(|| r.head_name().ok().flatten().map(|n| n.shorten().to_string()).unwrap_or_else(|| "HEAD".into()));
    let Some(id) = resolve_commit(r, start.unwrap_or("HEAD")) else {
        return Err(exit(128, format!("fatal: not a valid object name: '{label}'")));
    };
    let track = match start {
        Some(s) => tracking_for(r, s, false)?,
        None => None,
    };
    create(r, name, &label, id, track.as_ref())
}

fn guard_worktrees(r: &gix::Repository) -> Result<()> {
    if crate::status::operation_in(r.git_dir()).is_some() {
        return Err(unsupported("branch(operation in progress)"));
    }
    if !r.worktrees().map_err(fail)?.is_empty() {
        return Err(unsupported("branch(linked worktrees)"));
    }
    Ok(())
}

fn delete(r: &gix::Repository, name: &str, force: bool) -> Result<Vec<u8>> {
    guard_worktrees(r)?;
    let full = full(name).map_err(|_| exit(1, format!("error: branch '{name}' not found")))?;
    let Some(mut reference) = r.try_find_reference(full.as_ref()).map_err(fail)? else {
        return Err(exit(1, format!("error: branch '{name}' not found")));
    };
    let id = reference.peel_to_id().map_err(fail)?.detach();
    if r.head_name().ok().flatten().is_some_and(|h| h == full) {
        let path = r.workdir().map(|p| p.canonicalize().unwrap_or_else(|_| p.to_owned()).display().to_string()).unwrap_or_default();
        return Err(exit(1, format!("error: cannot delete branch '{name}' used by worktree at '{path}'")));
    }
    if !force {
        check_merged(r, &full, name, id)?;
    }
    let short = gix::prelude::ObjectIdExt::attach(id, r).shorten_or_id();
    let who = committer(r).ok();
    let mut lock = ConfigLock::acquire(r)?;
    while lock.cfg().remove_section("branch", Some(gix::bstr::BStr::new(name))).is_some() {}
    lock.stage()?;
    let edit = RefEdit::delete(full, PreviousValue::MustExistAndMatch(Target::Object(id)));
    let mut buf = Default::default();
    r.edit_references_as(Some(edit), who.as_ref().map(|w| w.to_ref(&mut buf))).map_err(fail)?;
    lock.commit()?;
    Ok(format!("Deleted branch {name} (was {short}).\n").into_bytes())
}

/// git의 `-d` 규칙: 추적 브랜치(있고 존재하면)에 합쳐졌는지, 없으면 HEAD에 합쳐졌는지. 아니면 `error: the branch '<name>' is not fully merged`(1).
/// 추적 브랜치엔 안 합쳐졌지만 HEAD엔 합쳐졌으면 그 앞에 git처럼 `warning: not deleting branch …` 두 줄이 붙는다.
fn check_merged(r: &gix::Repository, full: &FullName, name: &str, id: gix::ObjectId) -> Result<()> {
    let contains = |tip: gix::ObjectId| tip == id || r.merge_base(id, tip).ok().flatten().is_some_and(|b| b.detach() == id);
    let upstream = r
        .branch_remote_tracking_ref_name(full.as_ref(), Direction::Fetch)
        .and_then(|n| n.ok())
        .and_then(|n| r.try_find_reference(n.as_ref()).ok().flatten().map(|u| (n.to_string(), u)))
        .and_then(|(n, mut u)| u.peel_to_id().ok().map(|i| (n, i.detach())));
    let head = r.head_id().ok().map(|h| h.detach());
    let reference = upstream.as_ref().map(|(_, t)| *t).or(head);
    if reference.is_some_and(contains) {
        return Ok(());
    }
    let warn = match (&upstream, head) {
        (Some((up, _)), Some(h)) if contains(h) => format!("warning: not deleting branch '{name}' that is not yet merged to\n         '{up}', even though it is merged to HEAD\n"),
        _ => String::new(),
    };
    let advice = r.config_snapshot().boolean("advice.forceDeleteBranch").unwrap_or(true);
    let hint = if advice { format!("\nhint: If you are sure you want to delete it, run 'git branch -D {name}'") } else { String::new() };
    Err(exit(1, format!("{warn}error: the branch '{name}' is not fully merged{hint}")))
}

fn rename(r: &gix::Repository, old: &str, new: &str) -> Result<Vec<u8>> {
    guard_worktrees(r)?;
    if old == new {
        return Err(unsupported("branch -m (same name)"));
    }
    let old_full = full(old).map_err(|_| exit(128, format!("fatal: no branch named '{old}'")))?;
    let head = r.head().map_err(fail)?;
    let is_head = head.referent_name().is_some_and(|h| h == old_full.as_ref());
    if is_head && head.is_unborn() {
        return Err(unsupported("branch -m (current branch has no commits)"));
    }
    let Some(mut reference) = r.try_find_reference(old_full.as_ref()).map_err(fail)? else {
        return Err(exit(128, format!("fatal: no branch named '{old}'")));
    };
    let id = reference.peel_to_id().map_err(fail)?.detach();
    let new_full = full(new)?;
    if exists(r, new)? {
        return Err(exit(128, format!("fatal: a branch named '{new}' already exists")));
    }
    let who = committer(r)?;
    let msg = format!("Branch: renamed {old_full} to {new_full}");
    let mut lock = ConfigLock::acquire(r)?;
    // 새 이름의 설정 절이 이미 있으면 git이 어떻게 합치는지 같게 못 하므로 거절
    if lock.cfg().section("branch", Some(gix::bstr::BStr::new(new))).is_ok() {
        return Err(unsupported("branch -m (target [branch] section exists)"));
    }
    if lock.cfg().section("branch", Some(gix::bstr::BStr::new(old))).is_ok() {
        lock.cfg().rename_section("branch", Some(gix::bstr::BStr::new(old)), "branch", Some(gix::bstr::BString::from(new))).map_err(fail)?;
    }
    lock.stage()?;
    let (from, to) = (r.common_dir().join("logs").join(fs_path(old_full.as_bstr())?), r.common_dir().join("logs").join(fs_path(new_full.as_bstr())?));
    let old_log = std::fs::read(&from).ok();
    let mut edits = vec![
        RefEdit::update(new_full.clone(), id, PreviousValue::MustNotExist, msg.as_str()),
        RefEdit::delete(old_full.clone(), PreviousValue::MustExistAndMatch(Target::Object(id))),
    ];
    if is_head {
        edits.push(RefEdit::update("HEAD".try_into().map_err(fail)?, Target::Symbolic(new_full), PreviousValue::Any, msg.as_str()));
    }
    r.edit_references_as(edits, Some(who.to_ref(&mut Default::default()))).map_err(fail)?;
    // 트랜잭션이 성공한 뒤에 옛 reflog를 새 로그 앞에 붙인다(옛 로그는 ref 삭제와 함께 이미 지워졌다)
    if let Some(mut all) = old_log {
        use std::io::Write;
        all.extend(std::fs::read(&to).unwrap_or_default());
        let mut f = gix::lock::File::acquire_to_update_resource(&to, gix::lock::acquire::Fail::Immediately, None, 0).map_err(fail)?;
        f.write_all(&all).map_err(fail)?;
        f.commit().map_err(|e| fail(e.error))?;
    }
    if is_head {
        append_head_log(r, id, id, &who, &msg)?;
    }
    lock.commit()?;
    Ok(Vec::new())
}
