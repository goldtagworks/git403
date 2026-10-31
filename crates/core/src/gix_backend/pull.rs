//! 긴 작업 `pull [--progress] --ff-only [<remote> <branch>]`: 받은 뒤 **fast-forward일 때만** 브랜치를 옮긴다.
//!
//! `--ff-only` 없는 pull(머지·리베이스·`--autostash`·`--no-rebase`)과 원격만 준 형태는 `Unsupported`다. 그 밖의 거절 — 훅(`post-merge`·`post-checkout`·`reference-transaction`·`post-index-change`),
//! detached·커밋 없는 HEAD, `pull.rebase`·`branch.<b>.rebase`가 false가 아닐 때(false는 허용), 설정된 fetch refspec이 merge ref를 안 덮을 때(git은 따로 받지만 여기선 못 함), 서브모듈 설정(fetch.rs), 추적 정보 없음(`<remote> <branch>`를 안 줬는데 `branch.<b>.remote`/`merge`가 없거나 `merge`가 여러 개이거나 원격이 `.`),
//! 추적 파일에 로컬 변경(tree.rs; 받기 전에 검사하므로 거절해도 fetch는 하지 않는다), 새 트리의 `filter=` 속성 등 tree.rs의 조건.
//! 갈라졌으면 git처럼 `fatal: Not possible to fast-forward, aborting.`(128), 이미 최신이면 `Already up to date.`(0, ref 변경 없음).
//! `<remote> <branch>`는 그 브랜치만 받고 설정된 fetch refspec이 맞는 원격 추적 ref만 갱신한다(git과 같음). 받기는 fetch.rs를 쓰므로 한계도 같다(`FETCH_HEAD` 안 씀, prune 설정이면 거절).
//! reflog는 git처럼 `pull <인자들>: Fast-forward`(branch·HEAD 모두).

use std::path::Path;
use std::sync::atomic::AtomicBool;

use gix::refs::transaction::{PreviousValue, RefEdit};
use gix::refs::Target;
use gix::remote::Direction;
use tokio::sync::mpsc;

use super::common::{committer, fail, open};
use super::fetch::{fetch_remote, report, spawn_cancellable, strip_config};
use super::tree::{guard, guard_clean, move_to, move_trees};
use super::write::{exit, unsupported};
use crate::{Error, JobEvent, Result, Spawned};

struct Args {
    /// `pull` 뒤 인자 그대로(reflog 메시지용)
    raw: String,
    target: Option<(String, String)>,
}

/// pull argv면 `Some`, 아니면 `None`(→ 다른 해석기).
fn parse(argv: &[&str]) -> Result<Option<Args>> {
    let a = strip_config(argv)?;
    if a.first() != Some(&"pull") {
        return Ok(None);
    }
    let rest = &a[1..];
    let (mut ff_only, mut pos) = (false, Vec::new());
    for x in rest {
        match *x {
            "--ff-only" => ff_only = true,
            "--progress" => {}
            f if f.starts_with('-') => return Err(Error::Unsupported(format!("spawn_job: {}", argv.join(" ")))),
            p => pos.push(p),
        }
    }
    let target = match pos.as_slice() {
        [] => None,
        [remote, branch] if !branch.is_empty() => Some(((*remote).to_owned(), (*branch).to_owned())),
        _ => return Err(Error::Unsupported(format!("spawn_job: {}", argv.join(" ")))),
    };
    if !ff_only {
        return Err(Error::Unsupported("spawn_job: pull without --ff-only".into()));
    }
    Ok(Some(Args { raw: rest.join(" "), target }))
}

pub(super) fn spawn(repo: &Path, argv: &[&str], ssh_batch: Option<bool>, events: mpsc::UnboundedSender<JobEvent>) -> Option<Result<Spawned>> {
    let args = match parse(argv) {
        Ok(Some(a)) => a,
        Ok(None) => return None,
        Err(e) => return Some(Err(e)),
    };
    let repo = repo.to_path_buf();
    Some(Ok(spawn_cancellable(events, move |stop, tx| pull(&repo, &args, ssh_batch, stop, tx))))
}

/// 설정된 fetch refspec을 `merge`(원격 쪽 ref)에 적용한 `[+]src:dst` 목록. 맞는 게 없으면 ref만(오브젝트만 받는다).
fn restricted_specs(r: &gix::Repository, remote: &str, merge: &str) -> Result<Vec<String>> {
    let found = r.find_remote(remote).map_err(fail)?;
    let mut out = Vec::new();
    for spec in found.refspecs(Direction::Fetch) {
        let spec = spec.to_ref();
        let (Some(src), Some(dst)) = (spec.source(), spec.destination()) else { continue };
        let (src, dst) = (src.to_string(), dst.to_string());
        let mapped = match (src.strip_suffix('*'), dst.strip_suffix('*')) {
            (Some(sp), Some(dp)) => merge.strip_prefix(sp).map(|rest| format!("{dp}{rest}")),
            (None, None) if src == merge => Some(dst),
            _ => None,
        };
        if let Some(d) = mapped {
            out.push(format!("+{merge}:{d}"));
        }
    }
    if out.is_empty() {
        out.push(merge.to_owned());
    }
    Ok(out)
}

fn pull(repo: &Path, args: &Args, ssh_batch: Option<bool>, stop: &AtomicBool, events: &mpsc::UnboundedSender<JobEvent>) -> Result<()> {
    let r = open(repo)?;
    guard(&r, &["post-merge", "post-checkout", "reference-transaction", "post-index-change"])?;
    let Some(branch) = r.head_name().map_err(fail)? else { return Err(unsupported("pull(detached HEAD)")) };
    let Ok(head) = r.head_id() else { return Err(unsupported("pull(unborn HEAD)")) };
    let head = head.detach();
    let short = branch.shorten().to_string();
    let cfg = r.config_snapshot();
    // false는 머지 방식이므로 허용, 그 밖(true·merges·interactive 등)은 리베이스라 거절
    for key in ["pull.rebase".to_owned(), format!("branch.{short}.rebase")] {
        if cfg.string(&key).is_some() && cfg.boolean(&key) != Some(false) {
            return Err(unsupported("pull(pull.rebase)"));
        }
    }
    let (remote, merge, specs) = match &args.target {
        Some((remote, b)) => {
            let merge = if b.starts_with("refs/") { b.clone() } else { format!("refs/heads/{b}") };
            let specs = restricted_specs(&r, remote, &merge)?;
            (remote.clone(), merge, Some(specs))
        }
        None => {
            let plumb = cfg.plumbing();
            let remote = plumb.string_by("branch", Some(gix::bstr::BStr::new(&short)), "remote").map(|v| v.to_string());
            let merges = plumb.raw_values_by("branch", Some(gix::bstr::BStr::new(&short)), "merge").unwrap_or_default();
            match (remote, merges.as_slice()) {
                (Some(rm), [m]) if rm != "." => {
                    // 설정된 refspec이 merge ref를 안 덮으면 git은 따로 받아 오지만 여기선 못 한다
                    let m = m.to_string();
                    if restricted_specs(&r, &rm, &m)?.iter().all(|s| !s.contains(':')) {
                        return Err(unsupported("pull(merge ref is not covered by the remote's fetch refspecs)"));
                    }
                    (rm, m, None)
                }
                _ => return Err(unsupported("pull(no usable tracking information)")),
            }
        }
    };
    guard_clean(&r)?;
    let fetched = fetch_remote(repo, Some(&remote), specs.as_deref(), ssh_batch, stop, events);
    // 이름으로 준 브랜치가 원격에 없으면 git은 `couldn't find remote ref`(128)
    let (_, outcome) = match (fetched, &args.target) {
        (Err(Error::Exit { code: Some(128), stderr }), Some((_, b))) if stderr.contains("refspec") || stderr.contains("did not match") => {
            let _ = stderr;
            return Err(exit(128, format!("fatal: couldn't find remote ref {b}")));
        }
        (res, _) => res?,
    };
    report(&outcome, events);
    let tip = outcome.ref_map.mappings.iter().find(|m| m.remote.as_name().is_some_and(|n| n == merge.as_str())).and_then(|m| m.remote.as_id()).map(|id| id.to_owned());
    let Some(tip) = tip else {
        return Err(exit(1, format!("Your configuration specifies to merge with the ref '{merge}'\nfrom the remote, but no such ref was fetched.")));
    };
    let tip = r.find_object(tip).map_err(fail)?.peel_to_commit().map_err(fail)?;
    let base = r.merge_base(head, tip.id).ok().flatten().map(gix::Id::detach);
    if base == Some(tip.id) {
        let _ = events.send(JobEvent::Progress { line: "Already up to date.".to_owned() });
        return Ok(());
    }
    if base != Some(head) {
        return Err(exit(128, "fatal: Not possible to fast-forward, aborting."));
    }
    let _ = events.send(JobEvent::Progress { line: format!("Updating {}..{}", &head.to_hex_with_len(7), &tip.id.to_hex_with_len(7)) });
    let who = committer(&r)?;
    let tip_tree = tip.tree_id().map_err(fail)?.detach();
    let head_tree = r.find_commit(head).map_err(fail)?.tree_id().map_err(fail)?.detach();
    let edit = RefEdit::update("HEAD".try_into().expect("HEAD"), Target::Object(tip.id), PreviousValue::MustExistAndMatch(Target::Object(head)), format!("pull {}: Fast-forward", args.raw)).with_deref(true);
    // ref 잠금을 먼저 잡고(실패하면 작업 트리는 그대로) 작업 트리를 옮긴 뒤 커밋한다. 커밋이 실패하면 작업 트리를 되돌린다.
    let prepared = r.refs.transaction().prepare(Some(edit), gix::lock::acquire::Fail::Immediately, gix::lock::acquire::Fail::Immediately).map_err(fail)?;
    move_to(&r, tip_tree)?;
    if let Err(e) = prepared.commit(Some(who.to_ref(&mut Default::default()))) {
        let _ = move_trees(&r, tip_tree, head_tree);
        return Err(fail(e));
    }
    let _ = events.send(JobEvent::Progress { line: "Fast-forward".to_owned() });
    Ok(())
}
