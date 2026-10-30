//! `read_status`: `git status --porcelain=v2 --branch --untracked-files=all` 과 같은 결과.
//!
//! 변경 파일은 경로순, 그 뒤에 추적 안 하는 파일 경로순 (git 출력 순서). 스테이지 쪽 이름 변경은 `R` + `old_path`,
//! 작업 트리 쪽 이름 변경은 찾지 않는다(git도 안 함). 서브모듈 상태·무시된 파일은 다루지 않는다.

use std::collections::BTreeMap;
use std::path::Path;

use gix::bstr::{BString, ByteSlice};
use gix::status::{index_worktree, Item, UntrackedFiles};
use gix::status::tree_index::TrackRenames;
use gix::status::plumbing::index_as_worktree::Conflict;

use super::common::{fail, open};
use crate::status::operation_in;
use crate::{Result, Status, StatusFile};

fn mode_class(m: gix::index::entry::Mode) -> u32 {
    m.bits() & 0o170000
}

fn file(path: &BString) -> StatusFile {
    StatusFile { path: path.to_str_lossy().into_owned(), old_path: None, index: '.', worktree: '.', untracked: false, conflict: false }
}

/// 브랜치 줄: (현재 브랜치, 업스트림 짧은 이름, ahead, behind)
fn branch(r: &gix::Repository) -> (Option<String>, Option<String>, u32, u32) {
    let Ok(Some(name)) = r.head_name() else { return (None, None, 0, 0) };
    let short = name.shorten().to_string();
    let Some(Ok(up)) = r.branch_remote_tracking_ref_name(name.as_ref(), gix::remote::Direction::Fetch) else { return (Some(short), None, 0, 0) };
    let upstream = up.shorten().to_string();
    let (mut ahead, mut behind) = (0, 0);
    if let (Ok(head), Ok(Some(mut upref))) = (r.head_id(), r.try_find_reference(up.as_ref())) {
        if let Ok(up_id) = upref.peel_to_id().map(|i| i.detach()) {
            let head = head.detach();
            let count = |tip: gix::ObjectId, hide: gix::ObjectId| r.rev_walk([tip]).with_hidden([hide]).all().map(|w| w.filter_map(|i| i.ok()).count() as u32).unwrap_or(0);
            (ahead, behind) = (count(head, up_id), count(up_id, head));
        }
    }
    (Some(short), Some(upstream), ahead, behind)
}

pub(super) fn read_status(repo: &Path) -> Result<Status> {
    let r = open(repo)?;
    let (branch, upstream, ahead, behind) = branch(&r);
    let mut changes: BTreeMap<BString, StatusFile> = BTreeMap::new();
    let mut untracked: BTreeMap<BString, StatusFile> = BTreeMap::new();
    if r.workdir().is_some() {
        let platform = r
            .status(gix::progress::Discard)
            .map_err(fail)?
            .untracked_files(UntrackedFiles::Files)
            .index_worktree_rewrites(None)
            .tree_index_track_renames(TrackRenames::AsConfigured);
        for item in platform.into_iter(None).map_err(fail)? {
            match item.map_err(fail)? {
                Item::TreeIndex(c) => {
                    use gix::diff::index::ChangeRef as C;
                    match c {
                        C::Addition { location, .. } => changes.entry(location.into_owned()).or_insert_with_key(file).index = 'A',
                        C::Deletion { location, .. } => changes.entry(location.into_owned()).or_insert_with_key(file).index = 'D',
                        C::Modification { location, previous_entry_mode, entry_mode, .. } => {
                            changes.entry(location.into_owned()).or_insert_with_key(file).index = if mode_class(previous_entry_mode) != mode_class(entry_mode) { 'T' } else { 'M' }
                        }
                        C::Rewrite { location, source_location, copy, .. } => {
                            let f = changes.entry(location.into_owned()).or_insert_with_key(file);
                            f.index = if copy { 'C' } else { 'R' };
                            f.old_path = Some(source_location.to_str_lossy().into_owned());
                        }
                    }
                }
                Item::IndexWorktree(index_worktree::Item::Modification { rela_path, status, .. }) => {
                    use gix::status::plumbing::index_as_worktree::{Change, EntryStatus};
                    match status {
                        EntryStatus::Conflict { summary, .. } => {
                            let (x, y) = match summary {
                                Conflict::BothDeleted => ('D', 'D'),
                                Conflict::AddedByUs => ('A', 'U'),
                                Conflict::DeletedByThem => ('U', 'D'),
                                Conflict::AddedByThem => ('U', 'A'),
                                Conflict::DeletedByUs => ('D', 'U'),
                                Conflict::BothAdded => ('A', 'A'),
                                Conflict::BothModified => ('U', 'U'),
                            };
                            let mut f = file(&rela_path);
                            (f.index, f.worktree, f.conflict) = (x, y, true);
                            changes.insert(rela_path, f);
                        }
                        EntryStatus::Change(c) => {
                            let y = match c {
                                Change::Removed => 'D',
                                Change::Type { .. } => 'T',
                                Change::Modification { .. } | Change::SubmoduleModification(_) => 'M',
                            };
                            changes.entry(rela_path).or_insert_with_key(file).worktree = y;
                        }
                        EntryStatus::IntentToAdd => changes.entry(rela_path).or_insert_with_key(file).worktree = 'A',
                        EntryStatus::NeedsUpdate(_) => {}
                    }
                }
                Item::IndexWorktree(index_worktree::Item::DirectoryContents { entry, .. }) => {
                    use gix::dir::entry::{Kind, Status as S};
                    if entry.status == S::Untracked && matches!(entry.disk_kind, Some(Kind::File | Kind::Symlink)) {
                        let mut f = file(&entry.rela_path);
                        (f.worktree, f.untracked) = ('?', true);
                        untracked.insert(entry.rela_path, f);
                    }
                }
                Item::IndexWorktree(index_worktree::Item::Rewrite { .. }) => {}
            }
        }
    }
    // 충돌 경로는 스테이지 쪽 변경과 겹치지 않게 충돌 항목만 남긴다 (위에서 insert로 덮어씀)
    let files = changes.into_values().chain(untracked.into_values()).collect();
    let operation = operation_in(r.git_dir());
    Ok(Status { branch, upstream, ahead, behind, files, operation })
}
