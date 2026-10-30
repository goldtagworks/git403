//! `read_refs`: 브랜치·원격·태그·스태시 (`git for-each-ref` + `stash list`와 같은 결과).

use std::path::Path;

use gix::bstr::ByteSlice;
use gix::object::Kind;

use super::common::{fail, hex, open, subject_body};
use crate::{Ref, RefKind, Result};

/// 태그가 주석 태그면 한 단계 벗긴 대상 (`%(*objectname)`과 같다), 아니면 자기 자신.
fn target_of(r: &gix::Repository, id: gix::ObjectId) -> gix::ObjectId {
    match r.find_object(id) {
        Ok(o) if o.kind == Kind::Tag => o.try_to_tag_ref().ok().map(|t| t.target()).unwrap_or(id),
        _ => id,
    }
}

/// `upstream:track`: (ahead, behind). 업스트림이 없거나 사라졌으면 (0, 0).
fn ahead_behind(r: &gix::Repository, full: &gix::refs::FullNameRef, local: gix::ObjectId) -> (u32, u32) {
    let Some(Ok(up)) = r.branch_remote_tracking_ref_name(full, gix::remote::Direction::Fetch) else { return (0, 0) };
    let Ok(Some(mut upref)) = r.try_find_reference(up.as_ref()) else { return (0, 0) };
    let Ok(up_id) = upref.peel_to_id().map(|i| i.detach()) else { return (0, 0) };
    let count = |tip: gix::ObjectId, hide: gix::ObjectId| r.rev_walk([tip]).with_hidden([hide]).all().map(|w| w.filter_map(|i| i.ok()).count() as u32).unwrap_or(0);
    (count(local, up_id), count(up_id, local))
}

pub(super) fn read_refs(repo: &Path) -> Result<Vec<Ref>> {
    let r = open(repo)?;
    let head = r.head_name().ok().flatten();
    let mut found: Vec<(Vec<u8>, Ref)> = Vec::new();
    for reference in r.references().map_err(fail)?.all().map_err(fail)?.flatten() {
        let full = reference.name().as_bstr().to_owned();
        let (kind, name) = if let Some(n) = full.strip_prefix(b"refs/heads/") {
            (RefKind::Local, n)
        } else if let Some(n) = full.strip_prefix(b"refs/remotes/") {
            if n.ends_with(b"/HEAD") {
                continue;
            }
            (RefKind::Remote, n)
        } else if let Some(n) = full.strip_prefix(b"refs/tags/") {
            (RefKind::Tag, n)
        } else {
            continue;
        };
        let mut reference = reference;
        let Ok(id) = reference.peel_to_id().map(|i| i.detach()) else { continue };
        // peel_to_id는 태그를 끝까지 벗긴다. git은 한 단계만이라 원래 가리키는 객체에서 다시 계산한다.
        let direct = match reference.target() {
            gix::refs::TargetRef::Object(o) => o.to_owned(),
            gix::refs::TargetRef::Symbolic(_) => id,
        };
        let target = if kind == RefKind::Tag { target_of(&r, direct) } else { direct };
        let is_head = kind == RefKind::Local && head.as_ref().is_some_and(|h| h.as_bstr() == full);
        let (ahead, behind) = if kind == RefKind::Local { ahead_behind(&r, reference.name(), direct) } else { (0, 0) };
        found.push((full.to_vec(), Ref { kind, name: name.to_str_lossy().into_owned(), target: hex(target), head: is_head, message: None, ahead, behind }));
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out: Vec<Ref> = found.into_iter().map(|(_, r)| r).collect();
    out.extend(stashes(&r)?);
    Ok(out)
}

/// `git stash list`: refs/stash의 reflog (최신이 `stash@{0}`), 메시지는 스태시 커밋의 제목.
fn stashes(r: &gix::Repository) -> Result<Vec<Ref>> {
    let Ok(Some(stash)) = r.try_find_reference("refs/stash") else { return Ok(Vec::new()) };
    let mut platform = stash.log_iter();
    let Some(rev) = platform.rev().map_err(fail)? else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for (i, line) in rev.enumerate() {
        let line = line.map_err(fail)?;
        let id = line.new_oid;
        let subject = r.find_commit(id).ok().and_then(|c| c.message_raw().ok().map(|m| subject_body(m).0));
        out.push(Ref { kind: RefKind::Stash, name: format!("stash@{{{i}}}"), target: hex(id), head: false, message: subject, ahead: 0, behind: 0 });
    }
    Ok(out)
}
