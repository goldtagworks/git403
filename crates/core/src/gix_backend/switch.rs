//! `switch` (run 허용 목록): `switch <branch>`, `switch -c <name> [<start>]`, `switch -c <name> --track <remote/branch>`, `switch --detach <rev>`.
//!
//! 작업 트리·인덱스를 새 커밋의 트리로 옮기는 규칙과 거절 조건은 tree.rs, 브랜치 만들기·추적 설정은 branch.rs. 추가로 거절하는 경우:
//! 커밋 없는 HEAD, 이미 그 브랜치에 있을 때(`Already on`), 로컬 브랜치가 아닌 이름(원격 브랜치 DWIM으로 새로 만드는 `switch <name>`은 못 함; 원격 이름이면 git처럼
//! `a branch is expected` 오류, 아무것도 없으면 `invalid reference`), 다른 worktree가 있을 때, `-c`의 시작점이 가리키는 트리와 현재 HEAD 트리가 다르면서 변경이 있을 때(tree.rs).
//! 순서: 설정 잠금·내용 미리 쓰기 → ref 잠금(`prepare`) → 작업 트리·인덱스 이동 → ref 커밋 → 설정 rename. 이동이나 ref 커밋이 실패하면 작업 트리·인덱스를 원래 트리로 되돌린다.
//! reflog는 git처럼 HEAD에 `checkout: moving from <현재 브랜치 또는 전체 sha> to <대상>`(대상 = 브랜치 이름·`--detach`에 준 문자열), 새 브랜치에는 `branch: Created from <시작점>`.
//! 추적을 걸면 stdout에 `branch 'x' set up to track 'origin/x'.`. 새 브랜치 이름이 이미 있으면 128 오류.

use std::path::Path;

use gix::refs::transaction::{PreviousValue, RefEdit};
use gix::refs::{FullName, Target};

use super::branch::{create_edit, exists, resolve_commit, stage_tracking, tracking_for};
use super::common::{append_head_log, committer, fail, open, ConfigLock};
use super::tree::{guard, move_to, move_trees};
use super::write::{exit, unsupported};
use crate::{Error, Result};

enum Mode<'a> {
    Existing(&'a str),
    Create { name: &'a str, start: Option<&'a str>, track: bool },
    Detach(&'a str),
}

fn parse<'a>(args: &[&'a str]) -> Result<Mode<'a>> {
    Ok(match args {
        [name] if !name.starts_with('-') => Mode::Existing(name),
        ["-c", name] if !name.starts_with('-') => Mode::Create { name, start: None, track: false },
        ["-c", name, start] if !name.starts_with('-') && !start.starts_with('-') => Mode::Create { name, start: Some(start), track: false },
        ["-c", name, "--track", start] if !name.starts_with('-') && !start.starts_with('-') => Mode::Create { name, start: Some(start), track: true },
        ["--detach", rev] if !rev.starts_with('-') => Mode::Detach(rev),
        _ => return Err(Error::Unsupported(format!("run: switch {}", args.join(" ")))),
    })
}

fn invalid(name: &str) -> Error {
    exit(128, format!("fatal: invalid reference: {name}"))
}

pub(super) fn run(repo: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let mode = parse(args)?;
    let r = open(repo)?;
    guard(&r, &["post-checkout", "reference-transaction", "post-index-change"])?;
    if !r.worktrees().map_err(fail)?.is_empty() {
        return Err(unsupported("switch(linked worktrees)"));
    }
    let Ok(head) = r.head_id() else { return Err(unsupported("switch(unborn HEAD)")) };
    let head = head.detach();
    let cur = r.head_name().map_err(fail)?;
    let from = cur.as_ref().map_or_else(|| head.to_string(), |n| n.shorten().to_string());
    let who = committer(&r)?;
    let commit_tree = |id: gix::ObjectId| -> Result<gix::ObjectId> { Ok(r.find_commit(id).map_err(fail)?.tree_id().map_err(fail)?.detach()) };
    let head_edit = |new: Target, to: &str| RefEdit::update("HEAD".try_into().expect("HEAD"), new, PreviousValue::Any, format!("checkout: moving from {from} to {to}"));
    // (대상 커밋, 추가 ref 편집(새 브랜치), HEAD 편집, HEAD 로그에 쓸 대상 이름, 설정(추적), stdout)
    let (id, mut edits, to_name, tracked): (gix::ObjectId, Vec<RefEdit>, String, Option<(ConfigLock, Vec<u8>)>);
    let symbolic;
    match mode {
        Mode::Existing(name) => {
            let full = FullName::try_from(format!("refs/heads/{name}")).map_err(|_| invalid(name))?;
            let Some(mut reference) = r.try_find_reference(full.as_ref()).map_err(fail)? else {
                if r.try_find_reference(format!("refs/remotes/{name}").as_str()).ok().flatten().is_some() {
                    return Err(exit(128, format!("fatal: a branch is expected, got remote branch '{name}'")));
                }
                if r.rev_parse_single(name).is_ok() {
                    return Err(unsupported("switch(not a local branch)"));
                }
                // 원격 브랜치 DWIM(`origin/x`가 하나뿐일 때 x를 만들어 추적)은 못 한다
                let dwim = r.remote_names().iter().any(|n| r.try_find_reference(format!("refs/remotes/{n}/{name}").as_str()).ok().flatten().is_some());
                return Err(if dwim { unsupported("switch(remote branch DWIM)") } else { invalid(name) });
            };
            if cur.as_ref() == Some(&full) {
                return Err(unsupported("switch(already on the branch)"));
            }
            id = reference.peel_to_id().map_err(fail)?.detach();
            edits = vec![head_edit(Target::Symbolic(full), name)];
            to_name = name.to_owned();
            tracked = None;
            symbolic = true;
        }
        Mode::Create { name, start, track } => {
            super::branch::check_name(name)?;
            if exists(&r, name)? {
                return Err(exit(128, format!("fatal: a branch named '{name}' already exists")));
            }
            let label = start.unwrap_or("HEAD");
            id = resolve_commit(&r, label).ok_or_else(|| invalid(label))?;
            let t = match start {
                Some(s) => tracking_for(&r, s, track)?,
                None => None,
            };
            tracked = t.as_ref().map(|t| stage_tracking(&r, name, t)).transpose()?;
            let full = FullName::try_from(format!("refs/heads/{name}")).map_err(fail)?;
            edits = vec![create_edit(&r, name, label, id)?, head_edit(Target::Symbolic(full), name)];
            to_name = name.to_owned();
            symbolic = true;
        }
        Mode::Detach(rev) => {
            id = resolve_commit(&r, rev).ok_or_else(|| invalid(rev))?;
            edits = vec![head_edit(Target::Object(id), rev)];
            to_name = rev.to_owned();
            tracked = None;
            symbolic = false;
        }
    }
    let to_tree = commit_tree(id)?;
    let from_tree = commit_tree(head)?;
    // ref 잠금을 먼저 모두 잡는다(실패하면 작업 트리는 아직 그대로)
    let prepared = r.refs.transaction().prepare(std::mem::take(&mut edits), gix::lock::acquire::Fail::Immediately, gix::lock::acquire::Fail::Immediately).map_err(fail)?;
    move_to(&r, to_tree)?;
    match prepared.commit(Some(who.to_ref(&mut Default::default()))) {
        Ok(done) => super::durable::refs(&r, &done)?,
        Err(e) => {
            let _ = move_trees(&r, to_tree, from_tree);
            return Err(fail(e));
        }
    }
    if symbolic {
        append_head_log(&r, head, id, &who, &format!("checkout: moving from {from} to {to_name}"))?;
    }
    match tracked {
        Some((lock, msg)) => lock.commit().map(|()| msg),
        None => Ok(Vec::new()),
    }
}
