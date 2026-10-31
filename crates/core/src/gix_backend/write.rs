//! 쓰기: `stage`·`unstage`(인덱스 갱신)와 `commit`(인덱스 → 트리 → 커밋 → HEAD 갱신).
//!
//! 원칙: **git과 같게 못 하면 거절한다(`Unsupported`)**. 거절하는 경우:
//! - 훅이 실제로 실행될 상황(실행 비트가 있는 훅): commit = `pre-commit`·`prepare-commit-msg`·`commit-msg`·`post-commit`·`reference-transaction`(amend는 `post-rewrite`도),
//!   stage/unstage = `post-index-change`. `core.hooksPath` 상대 경로는 작업 트리 최상위 기준.
//! - 서명 커밋(`commit.gpgsign`), `commit.cleanup`이 `whitespace`가 아닐 때, `i18n.commitEncoding`이 UTF-8이 아닐 때, 머지·리베이스·cherry-pick 진행 중.
//! - 인덱스: sparse index(`sdir` 확장·디렉터리 항목), 보존하지 못하는 확장(resolve-undo·split index)과 버전 4,
//!   실제로 다시 쓰는 항목이 skip-worktree·assume-unchanged인 경우. tree-cache·untracked-cache·fsmonitor는 git이 다시 만드는 캐시라 쓸 때 버린다.
//!
//! 인덱스는 git처럼 `index.lock`을 먼저 잡고 읽은 뒤 쓴다. intent-to-add 항목은 커밋 트리에서 뺀다.

use std::path::Path;

use gix::bstr::{BString, ByteSlice};
use gix::index::entry::{Flags, Mode, Stat};
use gix::objs::tree::{Entry as TreeEntry, EntryKind, EntryMode};

use super::common::{fail, open, under};
use super::diff::read_worktree_file;
use crate::{Error, Result};

pub(super) fn exit(code: i32, msg: impl Into<String>) -> Error {
    Error::Exit { code: Some(code), stderr: msg.into() }
}

pub(super) fn unsupported(what: &str) -> Error {
    Error::Unsupported(what.to_owned())
}

/// 실행될 훅의 이름 (gix는 훅을 돌리지 않으므로 있으면 거절하는 근거). 실행 비트가 없는 훅은 git도 무시한다(Windows는 존재만 본다).
pub(super) fn active_hook(r: &gix::Repository, names: &[&str]) -> Option<String> {
    let base = r.workdir().unwrap_or_else(|| r.git_dir());
    let dir = match r.config_snapshot().trusted_path("core.hooksPath") {
        Ok(Some(p)) if p.is_absolute() => p,
        Ok(Some(p)) => base.join(p),
        _ => r.common_dir().join("hooks"),
    };
    names.iter().find(|n| is_hook(&dir.join(n))).map(|n| (*n).to_owned())
}

fn is_hook(p: &Path) -> bool {
    let Ok(m) = std::fs::metadata(p) else { return false };
    #[cfg(unix)]
    return m.is_file() && std::os::unix::fs::PermissionsExt::mode(&m.permissions()) & 0o111 != 0;
    #[cfg(not(unix))]
    return m.is_file();
}

fn load_index(r: &gix::Repository) -> Result<gix::index::File> {
    if r.index_path().exists() {
        r.open_index().map_err(fail)
    } else {
        Ok(gix::index::File::from_state(gix::index::State::new(r.object_hash()), r.index_path()))
    }
}

/// sparse index·보존 못 하는 확장이 있으면 거절 (읽기만 하는 commit에는 sparse 검사만).
fn guard_index(index: &gix::index::File, writing: bool) -> Result<()> {
    if index.is_sparse() || index.entries().iter().any(|e| e.mode == Mode::DIR) {
        return Err(unsupported("sparse index"));
    }
    if writing {
        let ext = if index.version() == gix::index::Version::V4 {
            Some("index v4")
        } else if index.link().is_some() {
            Some("split index")
        } else if index.resolve_undo().is_some() {
            Some("resolve-undo")
        } else {
            None
        };
        if let Some(e) = ext {
            return Err(unsupported(&format!("index with {e}")));
        }
    }
    Ok(())
}

/// 실제로 다시 쓰는 항목이 skip-worktree·assume-unchanged이면 거절 (건드리지 않는 항목은 플래그가 그대로 남는다).
fn guard_entry(index: &gix::index::File, path: &gix::bstr::BStr) -> Result<()> {
    let bad = index.entries().iter().any(|e| e.flags.intersects(Flags::SKIP_WORKTREE | Flags::ASSUME_VALID) && e.path(index) == path);
    if bad { Err(unsupported("skip-worktree or assume-unchanged entry")) } else { Ok(()) }
}

/// 경로를 직접 지목했는데 그 항목이 skip-worktree·assume-unchanged이면 거절 (디렉터리·`.`처럼 넓은 지정은 변경 없는 항목을 그냥 둔다).
fn guard_explicit(index: &gix::index::File, spec: &str) -> Result<()> {
    guard_entry(index, spec.trim_start_matches("./").trim_end_matches('/').into())
}

/// git처럼 `index.lock`을 먼저 잡고 인덱스를 읽어 고친 뒤 쓴다. 실패하면 잠금은 되돌려진다.
pub(super) fn modify_index(r: &gix::Repository, f: impl FnOnce(&mut gix::index::File) -> Result<()>) -> Result<()> {
    if let Some(h) = active_hook(r, &["post-index-change"]) {
        return Err(unsupported(&format!("index update (hook {h})")));
    }
    // split index: gix는 `link` 확장을 열 때 합쳐 버려 쓰면 분할이 풀리므로, 공유 인덱스 파일(`sharedindex.*`)이나 설정이 있으면 거절한다
    let shared = std::fs::read_dir(r.git_dir()).into_iter().flatten().flatten().any(|e| e.file_name().to_string_lossy().starts_with("sharedindex."));
    if shared || r.config_snapshot().boolean("core.splitIndex").unwrap_or(false) {
        return Err(unsupported("index with split index"));
    }
    let path = r.index_path();
    let lock = gix::lock::File::acquire_to_update_resource(&path, gix::lock::acquire::Fail::Immediately, None, 0)
        .map_err(|e| exit(128, format!("fatal: Unable to create '{}.lock': {e}", path.display())))?;
    let mut index = load_index(r)?;
    guard_index(&index, true)?;
    f(&mut index)?;
    index.sort_entries();
    index.remove_tree();
    let mut w = std::io::BufWriter::with_capacity(64 * 1024, lock);
    index.write_to(&mut w, gix::index::write::Options { extensions: gix::index::write::Extensions::None, skip_hash: false }).map_err(fail)?;
    w.into_inner().map_err(fail)?.commit().map_err(fail)?;
    Ok(())
}

fn no_match(spec: &str) -> Error {
    exit(128, format!("fatal: pathspec '{spec}' did not match any files"))
}

// ---- stage ----

pub(super) fn stage(repo: &Path, paths: &[String]) -> Result<()> {
    let r = open(repo)?;
    let cfg = r.config_snapshot();
    let (filemode, symlinks) = (cfg.boolean("core.filemode").unwrap_or(true), cfg.boolean("core.symlinks").unwrap_or(true));
    modify_index(&r, |index| {
        let status = super::status::read_status(repo)?;
        for spec in paths {
            guard_explicit(index, spec)?;
            let in_index = index.entries().iter().any(|e| under(e.path(index), spec));
            let on_disk = r.workdir().is_some_and(|w| std::fs::symlink_metadata(w.join(spec.trim_end_matches('/'))).is_ok());
            if !in_index && !on_disk {
                return Err(no_match(spec));
            }
            for f in status.files.iter().filter(|f| (f.worktree != '.' || f.conflict) && under(f.path.as_bytes(), spec)) {
                let path: BString = f.path.as_str().into();
                guard_entry(index, path.as_ref())?;
                // 같은 경로의 모든 단계(충돌 포함)를 지우고 작업 트리 상태로 다시 넣는다
                let old_mode = index.entry_by_path_and_stage(path.as_ref(), gix::index::entry::Stage::Unconflicted).map(|e| e.mode);
                index.remove_entries(|_, p, _| p == path.as_bstr());
                let Some((mode, data)) = read_worktree_file(&r, path.as_ref(), true)? else { continue }; // 삭제
                let id = r.write_blob(&data).map_err(fail)?.detach();
                let mode = match (mode, old_mode) {
                    (0o120000, _) => Mode::SYMLINK,
                    // core.symlinks=false: 링크가 일반 파일로 체크아웃되므로 기존 링크 모드를 유지한다
                    (_, Some(Mode::SYMLINK)) if !symlinks => Mode::SYMLINK,
                    (0o100755, _) if filemode => Mode::FILE_EXECUTABLE,
                    (_, Some(m)) if !filemode && matches!(m, Mode::FILE | Mode::FILE_EXECUTABLE) => m,
                    _ => Mode::FILE,
                };
                let full = r.workdir().expect("status needs a worktree").join(gix::path::from_bstr(path.as_bstr()).map_err(fail)?);
                let stat = gix::index::fs::Metadata::from_path_no_follow(&full).ok().and_then(|m| Stat::from_fs(&m).ok()).unwrap_or_default();
                index.dangerously_push_entry(stat, id, Flags::empty(), mode, path.as_ref());
            }
        }
        Ok(())
    })
}

// ---- unstage ----

pub(super) fn unstage(repo: &Path, paths: &[String]) -> Result<()> {
    let r = open(repo)?;
    // HEAD 쪽 파일 목록 (첫 커밋 전이면 비어 있다)
    let head = match r.head_tree_id() {
        Ok(id) => Some(r.index_from_tree(&id).map_err(fail)?),
        Err(_) => None,
    };
    let head_entries: Vec<(BString, Mode, gix::ObjectId)> = head.iter().flat_map(|h| h.entries().iter().map(move |e| (e.path(h).to_owned(), e.mode, e.id))).collect();
    modify_index(&r, |index| {
        for spec in paths {
            guard_explicit(index, spec)?;
            let in_head = head_entries.iter().any(|(p, ..)| under(p, spec));
            let in_index = index.entries().iter().any(|e| under(e.path(index), spec));
            if !in_head && !in_index {
                return Err(no_match(spec));
            }
            // 인덱스 쪽: HEAD와 같은 0단계 항목은 그대로 두고, 나머지는 지운 뒤 HEAD 버전을 넣는다
            let same: std::collections::HashSet<BString> = index
                .entries()
                .iter()
                .filter(|e| e.stage() == gix::index::entry::Stage::Unconflicted && under(e.path(index), spec))
                .filter(|e| head_entries.iter().any(|(p, m, id)| p.as_bstr() == e.path(index) && *m == e.mode && *id == e.id))
                .map(|e| e.path(index).to_owned())
                .collect();
            let touched: Vec<BString> = index.entries().iter().map(|e| e.path(index).to_owned()).filter(|p| under(p, spec) && !same.contains(p)).collect();
            for p in &touched {
                guard_entry(index, p.as_ref())?;
            }
            index.remove_entries(|_, p, _| under(p, spec) && !same.contains(p));
            for (p, m, id) in head_entries.iter().filter(|(p, ..)| under(p, spec) && !same.contains(p)) {
                index.dangerously_push_entry(Stat::default(), *id, Flags::empty(), *m, p.as_ref());
            }
        }
        Ok(())
    })
}

// ---- commit ----

#[derive(Default)]
struct Dir(std::collections::BTreeMap<Vec<u8>, Node>);
enum Node {
    Leaf(EntryMode, gix::ObjectId),
    Dir(Dir),
}

fn write_dir(r: &gix::Repository, d: &Dir) -> Result<gix::ObjectId> {
    let mut entries = Vec::new();
    for (name, node) in &d.0 {
        let (mode, oid) = match node {
            Node::Leaf(m, id) => (*m, *id),
            Node::Dir(sub) => (EntryKind::Tree.into(), write_dir(r, sub)?),
        };
        entries.push(TreeEntry { mode, filename: BString::from(name.clone()), oid });
    }
    // git 트리 순서: 디렉터리는 이름 뒤에 `/`가 붙은 것으로 비교
    entries.sort_by(|a, b| {
        let key = |e: &TreeEntry| [e.filename.to_vec(), if e.mode.is_tree() { b"/".to_vec() } else { Vec::new() }].concat();
        key(a).cmp(&key(b))
    });
    Ok(r.write_object(&gix::objs::Tree { entries }).map_err(fail)?.detach())
}

/// 인덱스 → 트리. intent-to-add 항목은 git처럼 뺀다.
fn index_tree(r: &gix::Repository, index: &gix::index::File) -> Result<gix::ObjectId> {
    let mut root = Dir::default();
    for e in index.entries() {
        if e.stage() != gix::index::entry::Stage::Unconflicted {
            return Err(exit(1, "error: Committing is not possible because you have unmerged files."));
        }
        if e.flags.contains(Flags::INTENT_TO_ADD) {
            continue;
        }
        let mode = e.mode.to_tree_entry_mode().ok_or_else(|| fail("unknown index entry mode"))?;
        let path = e.path(index);
        let mut parts = path.split(|b| *b == b'/').peekable();
        let mut cur = &mut root;
        while let Some(part) = parts.next() {
            if parts.peek().is_none() {
                cur.0.insert(part.to_vec(), Node::Leaf(mode, e.id));
            } else {
                let Node::Dir(sub) = cur.0.entry(part.to_vec()).or_insert_with(|| Node::Dir(Dir::default())) else { return Err(fail("index path conflicts with a file")) };
                cur = sub;
            }
        }
    }
    write_dir(r, &root)
}

/// `commit -F -`의 기본 정리(`whitespace`): 줄 끝 공백 제거, 연속 빈 줄은 하나로, 앞뒤 빈 줄 제거, 끝에 줄바꿈 하나.
fn cleanup(msg: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for l in msg.lines().map(str::trim_end) {
        if l.is_empty() && out.last().is_none_or(|p| p.is_empty()) {
            continue;
        }
        out.push(l);
    }
    while out.last().is_some_and(|l| l.is_empty()) {
        out.pop();
    }
    if out.is_empty() { String::new() } else { format!("{}\n", out.join("\n")) }
}

pub(super) fn commit(repo: &Path, message: &str, amend: bool) -> Result<()> {
    let r = open(repo)?;
    let cfg = r.config_snapshot();
    if cfg.boolean("commit.gpgsign").unwrap_or(false) {
        return Err(unsupported("commit(gpgsign)"));
    }
    if cfg.string("commit.cleanup").is_some_and(|v| !v.eq_ignore_ascii_case(b"whitespace")) {
        return Err(unsupported("commit(commit.cleanup)"));
    }
    if cfg.string("i18n.commitEncoding").is_some_and(|v| !matches!(v.to_ascii_lowercase().as_slice(), b"utf-8" | b"utf8")) {
        return Err(unsupported("commit(i18n.commitEncoding)"));
    }
    let hooks: &[&str] = if amend { &["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-rewrite", "reference-transaction"] } else { &["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "reference-transaction"] };
    if let Some(h) = active_hook(&r, hooks) {
        return Err(unsupported(&format!("commit(hook {h})")));
    }
    if crate::status::operation_in(r.git_dir()).is_some() {
        return Err(unsupported("commit(operation in progress)"));
    }
    let message = cleanup(message);
    if message.is_empty() {
        return Err(exit(1, "Aborting commit due to empty commit message."));
    }
    let head = r.head_commit().ok();
    if amend && head.is_none() {
        return Err(exit(128, "fatal: You have nothing to amend."));
    }
    let index = load_index(&r)?;
    guard_index(&index, false)?;
    let tree = index_tree(&r, &index)?;
    let (parents, author): (Vec<gix::ObjectId>, gix::actor::Signature) = match (&head, amend) {
        (Some(h), true) => (h.parent_ids().map(|p| p.detach()).collect(), h.author().map_err(fail)?.to_owned().map_err(fail)?),
        (Some(h), false) => (vec![h.id], new_author(&r)?),
        (None, _) => (vec![], new_author(&r)?),
    };
    if !amend {
        let base = match &head {
            Some(h) => h.tree_id().map_err(fail)?.detach(),
            None => r.empty_tree().id,
        };
        if tree == base {
            let branch = r.head_name().ok().flatten().map(|n| n.shorten().to_string());
            return Err(exit(1, format!("{}nothing to commit", branch.map(|b| format!("On branch {b}\n")).unwrap_or_default())));
        }
    }
    let committer = match r.committer() {
        Some(c) => c.map_err(fail)?.to_owned().map_err(fail)?,
        None => return Err(exit(128, "fatal: unable to auto-detect email address / Author identity unknown (set user.name and user.email)")),
    };
    let commit = gix::objs::Commit { tree, parents: parents.iter().copied().collect(), author, committer: committer.clone(), encoding: None, message: message.as_str().into(), extra_headers: Vec::new() };
    let id = r.write_object(&commit).map_err(fail)?.detach();
    let subject = message.lines().next().unwrap_or("");
    let (label, expected) = match (&head, amend) {
        (None, _) => ("commit (initial)", gix::refs::transaction::PreviousValue::MustNotExist),
        (Some(h), true) => ("commit (amend)", gix::refs::transaction::PreviousValue::MustExistAndMatch(gix::refs::Target::Object(h.id))),
        (Some(h), false) => ("commit", gix::refs::transaction::PreviousValue::MustExistAndMatch(gix::refs::Target::Object(h.id))),
    };
    let edit = gix::refs::transaction::RefEdit::update("HEAD".try_into().map_err(fail)?, id, expected, format!("{label}: {subject}")).with_deref(true);
    r.edit_references_as(Some(edit), Some(committer.to_ref(&mut Default::default()))).map_err(fail)?;
    Ok(())
}

fn new_author(r: &gix::Repository) -> Result<gix::actor::Signature> {
    match r.author() {
        Some(a) => a.map_err(fail)?.to_owned().map_err(fail),
        None => Err(exit(128, "fatal: unable to auto-detect email address / Author identity unknown (set user.name and user.email)")),
    }
}
