//! 작업 트리·인덱스를 HEAD 트리에서 다른 트리로 옮긴다 (`switch`·`pull --ff-only`가 같이 쓴다).
//!
//! 원칙은 write.rs와 같다: **git과 같게 못 하면 거절(`Unsupported`)**. 거절하는 경우 — 진행 중인 머지·리베이스 등, 추적 파일에 변경이 하나라도 있을 때(스테이지·작업 트리·충돌;
//! git은 겹치지 않으면 옮겨 주지만 여기선 안 한다. 두 트리가 같으면 파일을 안 건드리므로 변경이 있어도 된다), 추적 안 하는 파일이 새로 쓸 경로를 막을 때,
//! 바뀌는 서브모듈 항목, 새 트리의 `.gitattributes`에 `filter=`, sparse checkout·skip-worktree·assume-unchanged 항목, 훅(`post-checkout`·`post-merge`·`reference-transaction`·`post-index-change`).
//! 새 트리에서 못 쓰는 경우(대소문자만 다른 경로 충돌: `core.ignorecase`)도 거절한다. 바뀐 경로만 gix 체크아웃으로 쓰고(개행 변환·실행 비트 등 설정은 gix가 처리), 안 바뀐 항목의 stat은 이전 인덱스 것을 그대로 둔다(체크아웃이 SKIP_WORKTREE 항목을 건너뛴다는 데 기대므로 테스트가 mtime·inode 불변을 확인한다).
//! 중간에 실패하면(권한·디스크 등) 지운 파일과 이미 쓴 파일을 원래 트리 기준으로 되돌린 뒤 오류를 낸다(인덱스는 그때까지 안 썼다). 호출자는 ref 잠금을 먼저 잡고(`prepare`) 부르며,
//! ref 커밋이 실패하면 `move_trees(to → from)`으로 되돌린다.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::AtomicBool;

use gix::bstr::{BString, ByteSlice};
use gix::index::entry::{Flags, Mode, Stat};

use super::common::{fail, fs_path};
use super::write::{active_hook, modify_index, unsupported};
use crate::{Error, Result};

/// 공통 사전 검사: 훅·진행 중인 작업·sparse checkout·베어 저장소.
pub(super) fn guard(r: &gix::Repository, hooks: &[&str]) -> Result<()> {
    if let Some(h) = active_hook(r, hooks) {
        return Err(unsupported(&format!("checkout(hook {h})")));
    }
    if r.workdir().is_none() {
        return Err(unsupported("checkout(bare repository)"));
    }
    if crate::status::operation_in(r.git_dir()).is_some() {
        return Err(unsupported("checkout(operation in progress)"));
    }
    if r.config_snapshot().boolean("core.sparseCheckout").unwrap_or(false) {
        return Err(unsupported("checkout(sparse checkout)"));
    }
    Ok(())
}

/// 추적 파일에 변경(스테이지·작업 트리·충돌)이 있으면 거절한다. 추적 안 하는 파일은 무시.
pub(super) fn guard_clean(r: &gix::Repository) -> Result<()> {
    let st = super::status::read_status(r.workdir().unwrap_or_else(|| r.git_dir()))?;
    if st.files.iter().any(|f| !f.untracked) {
        return Err(unsupported("checkout(local changes)"));
    }
    Ok(())
}

type Entries = HashMap<BString, (Mode, gix::ObjectId, Stat)>;

fn entries(index: &gix::index::File) -> Entries {
    index.entries().iter().map(|e| (e.path(index).to_owned(), (e.mode, e.id, e.stat))).collect()
}

/// `dir` 아래의 모든 항목이 `gone`(사라질 추적 경로)이면 true.
fn only_gone(dir: &Path, rel: &BString, gone: &HashSet<&BString>) -> bool {
    let Ok(rd) = std::fs::read_dir(dir) else { return false };
    for e in rd.flatten() {
        let mut p = rel.clone();
        p.push(b'/');
        p.extend_from_slice(e.file_name().to_string_lossy().as_bytes());
        let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
        let ok = if is_dir { only_gone(&e.path(), &p, gone) } else { gone.contains(&p) };
        if !ok {
            return false;
        }
    }
    true
}

fn rel_path(workdir: &Path, p: &[u8]) -> Result<std::path::PathBuf> {
    Ok(workdir.join(fs_path(p.as_bstr())?))
}

/// `remove` 경로의 파일을 지우고(빈 폴더 정리) `tree`의 `write` 경로만 체크아웃한다. 쓰고 나서 안 쓴 항목의 flag는 원래대로, stat은 `stats`(있으면)에서 가져온다.
fn sync_paths(r: &gix::Repository, workdir: &Path, tree: gix::ObjectId, remove: &[&BString], write: &HashSet<&BString>, stats: Option<&Entries>) -> Result<gix::index::File> {
    for p in remove {
        let abs = rel_path(workdir, p)?;
        match std::fs::remove_file(&abs) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(fail(e)),
        }
        let mut dir = abs.parent().map(Path::to_path_buf);
        while let Some(d) = dir {
            if d == workdir || std::fs::remove_dir(&d).is_err() {
                break;
            }
            dir = d.parent().map(Path::to_path_buf);
        }
    }
    let mut new = r.index_from_tree(&tree).map_err(fail)?;
    // 안 바뀐 항목은 체크아웃이 건너뛰게 skip-worktree로 표시했다가 되돌린다
    let mut skipped: HashSet<BString> = HashSet::new();
    for (e, p) in new.entries_mut_with_paths() {
        if !write.contains(&p.to_owned()) {
            e.flags.insert(Flags::SKIP_WORKTREE);
            skipped.insert(p.to_owned());
        }
    }
    let mut opts = r.checkout_options(gix::worktree::stack::state::attributes::Source::IdMapping).map_err(fail)?;
    opts.destination_is_initially_empty = false;
    opts.overwrite_existing = false;
    let objects = r.objects.clone().into_arc().map_err(fail)?;
    let outcome = gix::worktree::state::checkout(&mut new, workdir.to_path_buf(), objects, &gix::progress::Discard, &gix::progress::Discard, &AtomicBool::new(false), opts).map_err(fail)?;
    if !outcome.collisions.is_empty() || !outcome.errors.is_empty() {
        return Err(Error::Exit { code: Some(128), stderr: format!("fatal: checkout failed ({} collisions, {} errors)", outcome.collisions.len(), outcome.errors.len()) });
    }
    for (e, p) in new.entries_mut_with_paths() {
        if skipped.contains(&p.to_owned()) {
            e.flags.remove(Flags::SKIP_WORKTREE);
            if let Some((_, _, stat)) = stats.and_then(|m| m.get(p.as_bstr())) {
                e.stat = *stat;
            }
        }
    }
    Ok(new)
}

/// 작업 트리·인덱스를 현재 HEAD 트리에서 `to`로 옮긴다. 두 트리가 같으면 아무것도 안 한다.
/// 호출자가 `guard`로 훅·진행 중인 작업을 먼저 검사했어야 한다. (ref 갱신은 호출자 몫)
pub(super) fn move_to(r: &gix::Repository, to: gix::ObjectId) -> Result<()> {
    let from = r.head_commit().map_err(fail)?.tree_id().map_err(fail)?.detach();
    if from == to {
        return Ok(());
    }
    guard_clean(r)?;
    super::clone::check_tree_filters(r, to)?;
    move_trees(r, from, to)
}

/// `from` 트리 상태(인덱스·작업 트리)를 `to`로 옮긴다. 되돌릴 때도 `move_trees(r, to, from)`으로 쓴다(깨끗함 검사는 호출자가 이미 함).
pub(super) fn move_trees(r: &gix::Repository, from: gix::ObjectId, to: gix::ObjectId) -> Result<()> {
    if from == to {
        return Ok(());
    }
    let workdir = r.workdir().ok_or_else(|| unsupported("checkout(bare repository)"))?.to_owned();
    modify_index(r, |index| {
        for e in index.entries() {
            if e.flags.intersects(Flags::SKIP_WORKTREE | Flags::ASSUME_VALID | Flags::INTENT_TO_ADD) || e.flags.stage() != gix::index::entry::Stage::Unconflicted {
                return Err(unsupported("checkout(skip-worktree, assume-unchanged or unmerged entry)"));
            }
        }
        let target_index = r.index_from_tree(&to).map_err(fail)?;
        let old = entries(index);
        let target = entries(&target_index);
        // 대소문자만 다른 경로가 새 트리에 둘 있으면 대소문자 구분 없는 파일 시스템에서 충돌한다
        if r.config_snapshot().boolean("core.ignorecase").unwrap_or(false) {
            let mut seen = HashSet::new();
            if !target.keys().all(|p| seen.insert(p.to_string().to_lowercase())) {
                return Err(unsupported("checkout(paths differing only in case)"));
            }
        }
        let removed: Vec<&BString> = old.keys().filter(|p| !target.contains_key(*p)).collect();
        let write: HashSet<&BString> = target.iter().filter(|(p, (m, id, _))| old.get(*p).is_none_or(|(om, oid, _)| om != m || oid != id)).map(|(p, _)| p).collect();
        // 서브모듈 항목이 바뀌면(들어오거나 나가거나) git은 폴더를 다루므로 거절
        let gitlink = |p: &&BString| old.get(*p).is_some_and(|(m, ..)| *m == Mode::COMMIT) || target.get(*p).is_some_and(|(m, ..)| *m == Mode::COMMIT);
        if removed.iter().any(gitlink) || write.iter().any(gitlink) {
            return Err(unsupported("checkout(submodule)"));
        }
        // 추적 안 하는 파일·폴더가 새로 쓸 경로를 막으면 거절 (아무것도 바꾸기 전에)
        let gone: HashSet<&BString> = removed.iter().copied().chain(write.iter().copied().filter(|p| old.contains_key(*p))).collect();
        for p in &write {
            let abs = rel_path(&workdir, p)?;
            match abs.symlink_metadata() {
                Ok(_) if old.contains_key(*p) => {}
                Ok(m) if m.is_dir() => {
                    if !only_gone(&abs, p, &gone) {
                        return Err(unsupported("checkout(untracked files would be overwritten)"));
                    }
                }
                Ok(_) => return Err(unsupported("checkout(untracked files would be overwritten)")),
                Err(_) => {}
            }
            let mut anc = p.as_bytes();
            while let Some(i) = anc.rfind_byte(b'/') {
                anc = &anc[..i];
                if let Ok(m) = rel_path(&workdir, anc)?.symlink_metadata() {
                    if !m.is_dir() && !gone.contains(&BString::from(anc)) {
                        return Err(unsupported("checkout(untracked files would be overwritten)"));
                    }
                }
            }
        }
        let gone_list: Vec<&BString> = gone.iter().copied().collect();
        match sync_paths(r, &workdir, to, &gone_list, &write, Some(&old)) {
            Ok(new) => {
                *index = new;
                Ok(())
            }
            Err(e) => {
                // 되돌리기: 새로 쓴(또는 쓰다 만) 경로를 지우고 원래 트리의 지운·바뀐 경로를 다시 쓴다(best effort; 인덱스는 아직 안 썼다)
                let written: Vec<&BString> = write.iter().copied().collect();
                let _ = sync_paths(r, &workdir, from, &written, &gone, None);
                Err(e)
            }
        }
    })
}
