//! `changed_files`·`file_diff`·`worktree_diff`·`file_blob`: 커밋·인덱스·작업 트리 사이의 변경 (`git show`·`git diff`·`cat-file`과 같은 결과).

use std::io::Read;
use std::path::Path;

use gix::bstr::{BStr, BString, ByteSlice};
use gix::prelude::ObjectIdExt;
use gix::diff::tree_with_rewrites::Change;
use gix::objs::tree::{EntryKind, EntryMode};

use super::common::{fail, hex, open, under};
use super::textdiff::{render, Opts, Side};
use crate::runner::reject_option;
use crate::{ChangedFile, Error, Result, BLOB_LIMIT};

/// 파일 종류 묶음: 실행 비트만 다른 것은 같은 종류(모드 변경), 링크·서브모듈로 바뀌면 타입 변경(`T`).
fn class(m: EntryMode) -> u8 {
    match m.kind() {
        EntryKind::Blob | EntryKind::BlobExecutable => 0,
        EntryKind::Link => 1,
        EntryKind::Commit => 2,
        EntryKind::Tree => 3,
    }
}

/// 커밋과 비교 대상 트리(첫 부모, 루트 커밋은 빈 트리). 머지 커밋은 첫 부모 기준이다.
fn trees<'r>(r: &'r gix::Repository, commit: &str) -> Result<(gix::Tree<'r>, gix::Tree<'r>)> {
    let commit = reject_option(commit)?;
    let c = r.rev_parse_single(commit).map_err(fail)?.object().map_err(fail)?.peel_to_commit().map_err(fail)?;
    let new = c.tree().map_err(fail)?;
    let old = match c.parent_ids().next() {
        Some(p) => r.find_commit(p).map_err(fail)?.tree().map_err(fail)?,
        None => r.empty_tree(),
    };
    Ok((old, new))
}

fn location(c: &Change) -> &BStr {
    match c {
        Change::Addition { location, .. } | Change::Deletion { location, .. } | Change::Modification { location, .. } | Change::Rewrite { location, .. } => location.as_ref(),
    }
}

fn is_tree(c: &Change) -> bool {
    match c {
        Change::Addition { entry_mode, .. } | Change::Deletion { entry_mode, .. } | Change::Modification { entry_mode, .. } | Change::Rewrite { entry_mode, .. } => entry_mode.is_tree(),
    }
}

pub(super) fn changed_files(repo: &Path, commit: &str) -> Result<Vec<ChangedFile>> {
    let r = open(repo)?;
    let (old, new) = trees(&r, commit)?;
    // 옵션 없음 = 저장소 설정(`diff.renames`)대로 이름 변경 추적 (git 기본: 켜짐, 유사도 50%)
    let mut changes: Vec<Change> = r.diff_tree_to_tree(&old, &new, None).map_err(fail)?.into_iter().filter(|c| !is_tree(c)).collect();
    changes.sort_by(|a, b| location(a).cmp(location(b)));
    Ok(changes
        .iter()
        .map(|c| {
            let path = location(c).to_str_lossy().into_owned();
            match c {
                Change::Addition { .. } => ChangedFile { status: 'A', path, old_path: None },
                Change::Deletion { .. } => ChangedFile { status: 'D', path, old_path: None },
                Change::Modification { previous_entry_mode, entry_mode, .. } => ChangedFile { status: if class(*previous_entry_mode) != class(*entry_mode) { 'T' } else { 'M' }, path, old_path: None },
                Change::Rewrite { source_location, copy, .. } => ChangedFile { status: if *copy { 'C' } else { 'R' }, path, old_path: Some(source_location.to_str_lossy().into_owned()) },
            }
        })
        .collect())
}

/// `core.abbrev`(없으면 객체 수에 맞춘 자동 길이, 최소 7)에 맞춘 약식 id. 저장소에 없는 객체(작업 트리 파일)는 같은 길이로 자른다.
fn abbrev_fn(r: &gix::Repository) -> impl Fn(&gix::ObjectId) -> String + '_ {
    let len = r.head_id().ok().and_then(|i| i.shorten().ok()).map_or(7, |p| p.hex_len());
    move |id| match id.attach(r).shorten() {
        Ok(p) => p.to_string(),
        Err(_) => hex(id)[..len.min(40)].to_owned(),
    }
}

fn side_of(r: &gix::Repository, mode: EntryMode, id: gix::ObjectId) -> Result<Side> {
    let data = if mode.kind() == EntryKind::Commit { format!("Subproject commit {}\n", hex(id)).into_bytes() } else { r.find_object(id).map_err(fail)?.detach().data };
    Ok(Side { mode: mode.value() as u32, id, data })
}

/// 한 변경을 `git diff` 패치로. 파일↔링크 타입 변경은 삭제 뒤 추가 두 개로 나눈다 (git도 그렇게 낸다).
fn emit(path: &[u8], old: Option<&Side>, new: Option<&Side>, o: &Opts, out: &mut Vec<u8>) {
    if let (Some(a), Some(b)) = (old, new) {
        if a.mode & 0o170000 != b.mode & 0o170000 {
            render(path, old, None, o, out);
            render(path, None, new, o, out);
            return;
        }
    }
    render(path, old, new, o, out);
}

pub(super) fn file_diff(repo: &Path, commit: &str, path: &str, ignore_eol: bool, ignore_ws: bool) -> Result<String> {
    let r = open(repo)?;
    let (old, new) = trees(&r, commit)?;
    // 경로 제한은 이름 변경 감지보다 먼저다: `git show <c> -- 새경로`는 이름 변경이 아니라 추가로 보인다.
    let opts = gix::diff::Options::default();
    let mut changes: Vec<Change> = r.diff_tree_to_tree(&old, &new, opts).map_err(fail)?.into_iter().filter(|c| !is_tree(c) && under(location(c), path)).collect();
    changes.sort_by(|a, b| location(a).cmp(location(b)));
    let abbrev = abbrev_fn(&r);
    let o = Opts { abbrev: &abbrev, ignore_eol, ignore_ws };
    let mut out = Vec::new();
    for c in &changes {
        let p = location(c).to_vec();
        match c {
            Change::Addition { entry_mode, id, .. } => emit(&p, None, Some(&side_of(&r, *entry_mode, *id)?), &o, &mut out),
            Change::Deletion { entry_mode, id, .. } => emit(&p, Some(&side_of(&r, *entry_mode, *id)?), None, &o, &mut out),
            Change::Modification { previous_entry_mode, previous_id, entry_mode, id, .. } => {
                emit(&p, Some(&side_of(&r, *previous_entry_mode, *previous_id)?), Some(&side_of(&r, *entry_mode, *id)?), &o, &mut out)
            }
            Change::Rewrite { .. } => unreachable!("rewrites are not tracked here"),
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

// ---- 작업 트리 ----

/// 작업 트리 파일을 git에 저장될 모양으로 (autocrlf·필터 적용). 심볼릭 링크는 대상 경로 바이트.
pub(super) fn read_worktree_file(r: &gix::Repository, rela: &BStr, filter: bool) -> Result<Option<(u32, Vec<u8>)>> {
    let Some(wd) = r.workdir() else { return Ok(None) };
    let rela_path = gix::path::from_bstr(rela).map_err(fail)?.into_owned();
    let full = wd.join(&rela_path);
    let Ok(meta) = std::fs::symlink_metadata(&full) else { return Ok(None) };
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(&full)?;
        return Ok(Some((0o120000, gix::path::into_bstr(target).map_err(fail)?.into_owned().into())));
    }
    if !meta.is_file() {
        return Ok(None);
    }
    #[cfg(unix)]
    let exec = std::os::unix::fs::PermissionsExt::mode(&meta.permissions()) & 0o111 != 0;
    #[cfg(not(unix))]
    let exec = false;
    let mode = if exec { 0o100755 } else { 0o100644 };
    let file = std::fs::File::open(&full)?;
    let mut data = Vec::new();
    if filter {
        let (mut pipe, index) = r.filter_pipeline(None).map_err(fail)?;
        let mut out = pipe.convert_to_git(file, &rela_path, &index).map_err(fail)?;
        out.read_to_end(&mut data)?;
    } else {
        let mut file = file;
        file.read_to_end(&mut data)?;
    }
    Ok(Some((mode, data)))
}

fn blob_hash(data: &[u8]) -> Result<gix::ObjectId> {
    gix::objs::compute_hash(gix::hash::Kind::Sha1, gix::objs::Kind::Blob, data).map_err(fail)
}

pub(super) fn worktree_diff(repo: &Path, path: &str, staged: bool, untracked: bool, ignore_eol: bool, ignore_ws: bool) -> Result<String> {
    let r = open(repo)?;
    let abbrev = abbrev_fn(&r);
    let o = Opts { abbrev: &abbrev, ignore_eol, ignore_ws };
    let rela: BString = path.into();
    let mut out = Vec::new();
    if untracked {
        // `git diff --no-index /dev/null <path>`도 autocrlf 같은 변환을 거친다 (실제 git으로 확인)
        if let Some((mode, data)) = read_worktree_file(&r, rela.as_ref(), true)? {
            let side = Side { mode, id: blob_hash(&data)?, data };
            render(path.as_bytes(), None, Some(&side), &o, &mut out);
        }
        return Ok(String::from_utf8_lossy(&out).into_owned());
    }
    let index = r.index_or_empty().map_err(fail)?;
    if index.entry_by_path_and_stage(rela.as_ref(), gix::index::entry::Stage::Unconflicted).is_none() && index.entry_by_path(rela.as_ref()).is_some() {
        // 충돌 중인 경로: git은 `diff --cc`(결합 diff)를 낸다
        return Err(Error::Unsupported("worktree_diff(conflict)".into()));
    }
    let entry = |m: gix::index::entry::Mode, id: gix::ObjectId| -> Result<Side> {
        side_of(&r, m.to_tree_entry_mode().unwrap_or(EntryMode::from(EntryKind::Blob)), id)
    };
    let in_index = index.entry_by_path_and_stage(rela.as_ref(), gix::index::entry::Stage::Unconflicted).map(|e| entry(e.mode, e.id)).transpose()?;
    if staged {
        let head = match r.head_commit() {
            Ok(c) => c.tree().map_err(fail)?.lookup_entry_by_path(Path::new(path)).map_err(fail)?,
            Err(_) => None, // 첫 커밋 전
        };
        let old = head.map(|e| side_of(&r, e.mode(), e.object_id())).transpose()?;
        emit(path.as_bytes(), old.as_ref(), in_index.as_ref(), &o, &mut out);
    } else if let Some(old) = in_index {
        let new = read_worktree_file(&r, rela.as_ref(), true)?;
        let new = match new {
            Some((mode, data)) => {
                // core.filemode=false면 실행 비트는 인덱스 값을 따른다
                let mode = if r.config_snapshot().boolean("core.filemode").unwrap_or(true) || mode == 0o120000 { mode } else { old.mode };
                Some(Side { mode, id: blob_hash(&data)?, data })
            }
            None => None,
        };
        emit(path.as_bytes(), Some(&old), new.as_ref(), &o, &mut out);
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

// ---- file_blob ----

fn too_big(size: u64) -> Error {
    let (mb, limit) = (size / (1024 * 1024), BLOB_LIMIT / (1024 * 1024));
    gc_i18n::coded!("blob.tooLarge", "File is too large to preview ({mb} MB, limit {limit} MB)", mb = mb, limit = limit).into()
}

/// `git cat-file`과 같은 규칙(`rev`: 커밋 sha·`<sha>^`·`HEAD`, `":"`는 인덱스, `None`/`"WORKTREE"`는 작업 트리). 없거나 블롭이 아니면 `None`.
pub(super) fn file_blob(repo: &Path, rev: Option<&str>, path: &str) -> Result<Option<Vec<u8>>> {
    crate::path_in_repo(repo, path)?;
    let r = open(repo)?;
    let id = match rev {
        None | Some("WORKTREE") => return crate::blob::read_worktree_sync(repo, path),
        Some(":") => r.index_or_empty().map_err(fail)?.entry_by_path_and_stage(path.into(), gix::index::entry::Stage::Unconflicted).map(|e| e.id),
        Some(v) if !crate::blob::valid_rev(v) => return Err(gc_i18n::coded!("blob.badRev", "invalid revision: {rev}", rev = v).into()),
        Some(v) => {
            let Ok(id) = r.rev_parse_single(v) else { return Ok(None) };
            let Ok(c) = id.object().map_err(fail).and_then(|o| o.peel_to_commit().map_err(fail)) else { return Ok(None) };
            match c.tree().map_err(fail)?.lookup_entry_by_path(Path::new(path)).map_err(fail)? {
                Some(e) if e.mode().is_tree() => return Err(fail(format!("git cat-file blob {v}:{path}: bad file"))),
                Some(e) if e.mode().is_commit() => None, // 서브모듈: 객체가 없어 `cat-file -s`가 실패 → 없음
                other => other.map(|e| e.object_id()),
            }
        }
    };
    let Some(id) = id else { return Ok(None) };
    let header = r.find_header(id).map_err(fail)?;
    if header.size() > BLOB_LIMIT {
        return Err(too_big(header.size()));
    }
    let data = r.find_object(id).map_err(fail)?.detach().data;
    Ok(Some(data))
}
