//! jj 쓰기 작업(new·describe·edit·squash·split·abandon). jj CLI와 같은 순서로 한 트랜잭션에서 처리한다.
//!
//! 순서: 작업 사본 잠금 → git HEAD·ref 가져오기(colocate, 밖에서 git으로 바뀐 것 반영) → 작업 사본 snapshot
//! → 작업 적용 → 자손 rebase → git HEAD를 `@`의 첫 부모로(`reset_head`, 인덱스도 맞춤) → git 브랜치·태그 export
//! → 트랜잭션 커밋(operation 설명) → 작업 사본 체크아웃 갱신.
//! 인자(SHA·경로)는 저장소를 건드리기 전에 검증한다. 반환값은 경고(git ref export 실패 등, 보통 빈 목록).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use gc_i18n::{coded, Coded};
use jj_lib::commit::Commit;
use jj_lib::git::{self, GitImportOptions};
use jj_lib::gitignore::GitIgnoreFile;
use jj_lib::matchers::{EverythingMatcher, NothingMatcher, PrefixMatcher};
use jj_lib::merged_tree::MergedTree;
use jj_lib::object_id::ObjectId;
use jj_lib::ref_name::WorkspaceName;
use jj_lib::repo::{MutableRepo, ReadonlyRepo, Repo};
use jj_lib::repo_path::{RepoPath, RepoPathBuf};
use jj_lib::rewrite::{merge_commit_trees, restore_tree, squash_commits, CommitWithSelection};
use jj_lib::backend::CommitId;
use jj_lib::working_copy::{SnapshotOptions, WorkingCopyFreshness};
use jj_lib::workspace::Workspace;

use crate::{check_root, fail, is_enabled, load_workspace, settings_with_identity};

/// 새로 추적하는 파일 크기 상한(jj CLI 기본 1MiB). 더 큰 새 파일은 추적하지 않고 둔다.
const MAX_NEW_FILE_SIZE: u64 = 1 << 20;
/// 설명 길이 상한
const MAX_MESSAGE: usize = 1 << 20;
const MAX_PATHS: usize = 10_000;

enum Op {
    New(Vec<CommitId>),
    Describe(CommitId, String),
    Edit(CommitId),
    Squash(Option<CommitId>, Vec<RepoPathBuf>),
    Split(CommitId, Vec<RepoPathBuf>),
    Abandon(CommitId),
}

impl Op {
    /// 이 작업이 `id` 커밋을 직접 가리키는가
    fn references(&self, id: &CommitId) -> bool {
        match self {
            Op::New(ids) => ids.contains(id),
            Op::Describe(i, _) | Op::Edit(i) | Op::Split(i, _) | Op::Abandon(i) => i == id,
            Op::Squash(i, _) => i.as_ref() == Some(id),
        }
    }

    /// `from`을 가리키는 인자를 `to`로 바꾼다
    fn remap(&mut self, from: &CommitId, to: &CommitId) {
        let fix = |id: &mut CommitId| {
            if id == from {
                *id = to.clone();
            }
        };
        match self {
            Op::New(ids) => ids.iter_mut().for_each(fix),
            Op::Describe(id, _) | Op::Edit(id) | Op::Split(id, _) | Op::Abandon(id) => fix(id),
            Op::Squash(id, _) => id.iter_mut().for_each(fix),
        }
    }
}

/// 주어진 부모(1개 이상, 머지 가능) 위에 새 빈 커밋을 만들고 `@`로 삼는다.
/// (아래 모든 작업은 성공하면 경고 목록을 돌려준다)
pub fn new_commit(repo: &Path, parents: &[String]) -> Result<Vec<Coded>, Coded> {
    if parents.is_empty() {
        return Err(coded!("jj.badSha", "At least one commit is required"));
    }
    let ids = parents.iter().map(|s| parse_sha(s)).collect::<Result<Vec<_>, _>>()?;
    run(repo, Op::New(ids))
}

/// 커밋 설명을 바꾼다(비어 있지 않으면 끝에 줄바꿈 보장).
pub fn describe(repo: &Path, sha: &str, message: &str) -> Result<Vec<Coded>, Coded> {
    if message.len() > MAX_MESSAGE || message.contains('\0') {
        return Err(coded!("jj.badMessage", "The description is too long or contains a NUL byte"));
    }
    run(repo, Op::Describe(parse_sha(sha)?, message.to_string()))
}

/// `@`를 해당 커밋으로 옮긴다(작업 폴더가 그 커밋 내용으로 바뀐다).
pub fn edit(repo: &Path, sha: &str) -> Result<Vec<Coded>, Coded> {
    run(repo, Op::Edit(parse_sha(sha)?))
}

/// 커밋(`None` = `@`)의 변경(또는 `paths`의 파일만)을 부모로 합친다. 머지 커밋은 거절.
pub fn squash(repo: &Path, sha: Option<&str>, paths: &[String]) -> Result<Vec<Coded>, Coded> {
    let sha = sha.filter(|s| !s.is_empty()).map(parse_sha).transpose()?;
    run(repo, Op::Squash(sha, parse_paths(paths)?))
}

/// `paths`의 파일들을 첫 커밋(원래 change ID 유지)으로, 나머지를 그 위 둘째 커밋(새 change ID, 원래 커밋의 자손·`@`·북마크가 옮겨옴)으로.
pub fn split(repo: &Path, sha: &str, paths: &[String]) -> Result<Vec<Coded>, Coded> {
    let paths = parse_paths(paths)?;
    if paths.is_empty() {
        return Err(coded!("jj.nothingToSplit", "Select some, but not all, of the commit's changed files"));
    }
    run(repo, Op::Split(parse_sha(sha)?, paths))
}

/// 커밋을 버린다(자손은 부모 위로 rebase).
pub fn abandon(repo: &Path, sha: &str) -> Result<Vec<Coded>, Coded> {
    run(repo, Op::Abandon(parse_sha(sha)?))
}

/// 16진수 40자만 받는다(옵션·리비전 식 주입 불가).
fn parse_sha(s: &str) -> Result<CommitId, Coded> {
    let bad = || coded!("jj.badSha", "Invalid commit id: {sha}", sha = s.chars().take(64).collect::<String>());
    if s.len() != 40 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(bad());
    }
    CommitId::try_from_hex(s.to_ascii_lowercase()).ok_or_else(bad)
}

/// 저장소 상대 경로만: 빈 값·절대경로·`..`·`.`·빈 구성요소·`\`·`:`(드라이브·NTFS 스트림)·NUL 거절.
/// `.git`·`.jj`는 윈도가 같은 것으로 보는 변형(`.git.`·`.git `·8.3 `GIT~1`)까지 구성요소 단위로 거절한다.
fn parse_paths(paths: &[String]) -> Result<Vec<RepoPathBuf>, Coded> {
    if paths.len() > MAX_PATHS {
        return Err(coded!("jj.badPath", "Invalid path: {path}", path = "too many paths"));
    }
    paths
        .iter()
        .map(|p| {
            let bad = || coded!("jj.badPath", "Invalid path: {path}", path = p.chars().take(200).collect::<String>());
            if p.is_empty() || p.contains(['\0', '\\', ':']) || p.starts_with('/') || p.ends_with('/') {
                return Err(bad());
            }
            for c in p.split('/') {
                if c.is_empty() || c == "." || c == ".." || reserved_component(c) {
                    return Err(bad());
                }
            }
            RepoPathBuf::from_internal_string(p.as_str()).map_err(|_| bad())
        })
        .collect()
}

/// 끝의 공백·점을 떼고(윈도는 무시) 소문자로 `.git`·`.jj`·8.3 짧은 이름(`git~1`, `jj~2`)인지, 점·공백만인지
fn reserved_component(c: &str) -> bool {
    let t = c.trim_end_matches([' ', '.']).to_ascii_lowercase();
    if t.is_empty() || t == ".git" || t == ".jj" {
        return true;
    }
    ["git~", "jj~"].iter().any(|pre| t.strip_prefix(pre).is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())))
}

/// 저장소별 직렬화(프로세스 안). 다른 프로세스(jj CLI)는 작업 사본 파일 잠금이 막는다.
pub(crate) fn repo_lock(root: &Path) -> MutexGuard<'static, ()> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, &'static Mutex<()>>>> = OnceLock::new();
    let m: &'static Mutex<()> = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(root.to_path_buf())
        .or_insert_with(|| Box::leak(Box::new(Mutex::new(()))));
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn run(repo_path: &Path, op: Op) -> Result<Vec<Coded>, Coded> {
    let root = check_root(repo_path)?;
    if !is_enabled(&root) {
        return Err(coded!("jj.notEnabled", "jj is not enabled for this repository"));
    }
    let _gate = repo_lock(&root);
    let settings = settings_with_identity(&root)?;
    let mut ws = load_workspace(&root, &settings)?;
    pollster::block_on(execute(&mut ws, &root, op))
}

/// git 전역 `core.excludesFile`(없으면 XDG 기본) + 저장소 `.git/info/exclude`. 전역 무시 파일(`.DS_Store` 등)이 커밋에 들어가지 않게.
/// 설정은 gix로 읽고(저장소 로컬 설정이 가리키는 파일은 신뢰하지 않는다 = `trusted_path`) git 실행 파일은 쓰지 않는다.
fn base_ignores(root: &Path) -> Arc<GitIgnoreFile> {
    let mut ig = GitIgnoreFile::empty();
    let configured = gix::open(root)
        .ok()
        .and_then(|r| r.config_snapshot().trusted_path("core.excludesFile").ok().flatten());
    let global = configured.or_else(|| {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
        Some(base.join("git").join("ignore"))
    });
    for f in global.into_iter().chain([root.join(".git").join("info").join("exclude")]) {
        if let Ok(next) = ig.chain_with_file(RepoPath::root(), f) {
            ig = next;
        }
    }
    ig
}

async fn get_commit(m: &MutableRepo, id: &CommitId) -> Result<Commit, Coded> {
    m.store().get_commit_async(id).await.map_err(|_| coded!("jj.noCommit", "Commit not found: {sha}", sha = id.hex()))
}

/// 존재하고 보이는(visible head의 조상) 커밋만 다룬다.
async fn resolve(m: &MutableRepo, id: &CommitId) -> Result<Commit, Coded> {
    let c = get_commit(m, id).await?;
    for h in m.view().heads() {
        if m.index().is_ancestor(id, h).await.map_err(|e| fail("index", e))? {
            return Ok(c);
        }
    }
    Err(coded!("jj.noCommit", "Commit not found: {sha}", sha = id.hex()))
}

/// jj CLI 기본 `immutable_heads()` = `present(trunk()) | tags() | untracked_remote_bookmarks()`의 조상(과 루트)은 고치지 않는다.
/// `trunk()` = `main`·`master`·`trunk`의 `@origin`·`@upstream` 원격 북마크(추적 여부 무관) 중 커미터 시각이 가장 늦은 하나.
/// (jj-cli 소스는 이 머신에 없어 jj 문서의 기본 별칭 정의로 맞췄다.)
async fn ensure_mutable(m: &MutableRepo, c: &Commit) -> Result<(), Coded> {
    let immutable = || coded!("jj.immutable", "Commit {sha} is immutable (root, tag, or pushed to a remote)", sha = c.id().hex().chars().take(12).collect::<String>());
    if c.id() == m.store().root_commit_id() {
        return Err(immutable());
    }
    let view = m.view();
    let mut heads: Vec<CommitId> = view.local_tags().flat_map(|(_, t)| t.present_adds().cloned()).collect();
    let mut trunk: Vec<Commit> = Vec::new();
    for (sym, rr) in view.all_remote_bookmarks() {
        let remote = sym.remote.as_str();
        if remote == "git" {
            continue;
        }
        if !rr.is_tracked() {
            heads.extend(rr.target.present_adds().cloned());
        }
        if matches!(remote, "origin" | "upstream") && matches!(sym.name.as_str(), "main" | "master" | "trunk") {
            for id in rr.target.present_adds() {
                trunk.push(get_commit(m, id).await?);
            }
        }
    }
    if let Some(t) = trunk.into_iter().max_by_key(|c| c.committer().timestamp.timestamp) {
        heads.push(t.id().clone());
    }
    for h in &heads {
        if m.index().is_ancestor(c.id(), h).await.map_err(|e| fail("index", e))? {
            return Err(immutable());
        }
    }
    Ok(())
}

fn short(id: &CommitId) -> String {
    id.hex().chars().take(12).collect()
}

fn complete_newline(s: &str) -> String {
    if s.is_empty() || s.ends_with('\n') {
        s.to_string()
    } else {
        format!("{s}\n")
    }
}

async fn execute(ws: &mut Workspace, root: &Path, mut op: Op) -> Result<Vec<Coded>, Coded> {
    let name = ws.workspace_name().to_owned();
    let name_ref: &WorkspaceName = &name;
    let loader = ws.repo_loader().clone();
    // 작업 사본을 먼저 잠그고 그 다음에 저장소 head를 읽는다(읽은 뒤 다른 작업이 끼어들어 op가 갈라지는 것을 막는다)
    let mut locked = ws.start_working_copy_mutation().await.map_err(|e| fail("wc-lock", e))?;
    let mut repo = loader.load_at_head(Some(name_ref)).await.map_err(|e| fail("head", e))?;
    let mut wc_commit = wc_commit_of(&repo, name_ref).await?;

    // 작업 사본이 최신인지(jj CLI와 같은 판정). 아니면 jj workspace update-stale처럼 맞춘다
    match WorkingCopyFreshness::check_stale(locked.locked_wc(), &wc_commit, &repo).await {
        Ok(WorkingCopyFreshness::Fresh) => {}
        Ok(WorkingCopyFreshness::Updated(wc_op)) => {
            // 작업 사본이 우리가 읽은 것보다 앞선다: 그 operation 기준으로 다시 읽는다
            repo = loader.load_at(&wc_op).await.map_err(|e| fail("load-op", e))?;
            wc_commit = wc_commit_of(&repo, name_ref).await?;
        }
        Ok(WorkingCopyFreshness::WorkingCopyStale) => {
            // 이전 작업이 커밋은 했지만 작업 사본 갱신 전에 끊겼다. 사용자 변경(옛 상태 대비)이 있으면 덮어쓰지 않고 거절,
            // 없으면 update-stale처럼 현재 `@` 내용으로 체크아웃한다.
            let (tree, _) = locked.locked_wc().snapshot(&snapshot_options(root)).await.map_err(|e| fail("snapshot", e))?;
            if tree.tree_ids() != locked.locked_wc().old_tree().tree_ids() {
                return Err(coded!("jj.stale", "The repository changed or the working copy is out of date; refresh and retry"));
            }
            locked.locked_wc().check_out(&wc_commit).await.map_err(|e| fail("update-stale", e))?;
        }
        Ok(WorkingCopyFreshness::SiblingOperation) => {
            return Err(coded!("jj.diverged", "The working copy is out of sync with the jj operation history; fix it with the jj CLI"));
        }
        Err(_) => {
            // 작업 사본이 기록한 operation을 찾을 수 없을 때만: 파일은 그대로 두고 상태만 `@`에 맞춘다
            locked.locked_wc().recover(&wc_commit).await.map_err(|e| fail("wc-recover", e))?;
        }
    }
    let mut tx = repo.start_transaction();
    let m = tx.repo_mut();

    // 1. colocate: 밖(git)에서 바뀐 HEAD·브랜치·태그를 jj로
    let old_head = m.view().git_head(name_ref).clone();
    let pre_import_wc = wc_commit.id().clone();
    git::import_head(m, name_ref, root).await.map_err(|e| fail("import-head", e))?;
    let options = GitImportOptions {
        abandon_unreachable_commits: true,
        record_synthetic_predecessors: false,
        remote_auto_track_bookmarks: HashMap::new(),
    };
    git::import_refs(m, &options).await.map_err(|e| fail("import-refs", e))?;
    let new_head = m.view().git_head(name_ref).clone();
    let moved = if new_head != old_head { new_head.as_normal().cloned() } else { None };
    // 화면이 보던 `@`가 사라진다: 옛 `@` SHA로 온 요청은 엉뚱한 커밋에 적용하지 않고 거절한다.
    // 가져온 HEAD 동기화는 커밋해 둔다(그래야 UI가 새로고침할 때 `jj_status`가 새 `@`를 본다).
    let refused = moved.is_some() && op.references(&pre_import_wc);
    if let Some(head_id) = moved {
        // git HEAD가 밖에서 옮겨졌다: `@`를 새 HEAD 위 빈 커밋으로(작업 파일은 그대로, 아래 snapshot이 차이를 담는다)
        let head = get_commit(m, &head_id).await?;
        let new_wc = m.check_out(name.clone(), &head).await.map_err(|e| fail("check-out", e))?;
        locked.locked_wc().reset(&new_wc).await.map_err(|e| fail("wc-reset", e))?;
        wc_commit = new_wc;
    }

    // 2. 작업 사본 snapshot
    let (tree, _stats) = locked.locked_wc().snapshot(&snapshot_options(root)).await.map_err(|e| fail("snapshot", e))?;
    if tree.tree_ids() != wc_commit.tree_ids() {
        let stale = wc_commit.id().clone();
        wc_commit = m.rewrite_commit(&wc_commit).set_tree(tree).write().await.map_err(|e| fail("snapshot-commit", e))?;
        m.set_wc_commit(name.clone(), wc_commit.id().clone()).map_err(|e| fail("snapshot-wc", e))?;
        // 호출자가 snapshot 전의 `@` SHA를 들고 있으면 snapshot된 새 `@`를 가리킨다(UI는 snapshot 없이 status로 SHA를 얻는다)
        op.remap(&stale, wc_commit.id());
    }

    // 3. 작업
    let description = if refused { "import git head".to_string() } else { apply(m, &name, &wc_commit, op).await? };

    // 4~6. 자손 rebase, git HEAD·인덱스, git ref export.
    // 순서 이유: 둘 다 커밋 전에 한다. 커밋(op 기록)이 끝난 뒤에 git을 건드리다 실패하면 jj의 view와 git이 어긋난 채 남기 때문이다.
    // 먼저 하면 실패 시 op가 남지 않아 다음 호출의 import가 git 쪽 변경을 다시 맞춘다. ref export 실패(`failed_*`)는
    // 개별 ref 단위이고 view의 git_refs에 반영되지 않아 다음 import가 되돌려 맞추므로 경고로 돌려준다.
    m.rebase_descendants().await.map_err(|e| fail("rebase", e))?;
    let new_wc_id = m.view().get_wc_commit_id(name_ref).cloned().ok_or_else(|| fail("wc", "no working-copy commit"))?;
    let new_wc = get_commit(m, &new_wc_id).await?;
    git::reset_head(m, name_ref, root, (Some(&wc_commit), &new_wc)).await.map_err(|e| fail("reset-head", e))?;
    let stats = git::export_refs(m).map_err(|e| fail("export-refs", e))?;
    let warnings: Vec<Coded> = stats
        .failed_bookmarks
        .iter()
        .chain(stats.failed_tags.iter())
        .map(|(sym, reason)| {
            coded!("jj.exportFailed", "Could not update git ref {name}: {reason}", name = sym.name.as_str().to_string(), reason = format!("{reason:?}"))
        })
        .collect();

    // 7. 커밋, 8. 작업 사본 체크아웃
    let repo = tx.commit(description).await.map_err(|e| fail("commit", e))?;
    locked.locked_wc().check_out(&new_wc).await.map_err(|e| fail("check-out", e))?;
    locked.finish(repo.op_id().clone()).await.map_err(|e| fail("wc-finish", e))?;
    if refused {
        return Err(coded!("jj.stale", "The repository changed or the working copy is out of date; refresh and retry"));
    }
    Ok(warnings)
}

async fn wc_commit_of(repo: &ReadonlyRepo, name: &WorkspaceName) -> Result<Commit, Coded> {
    let id = repo.view().get_wc_commit_id(name).cloned().ok_or_else(|| fail("wc", "no working-copy commit"))?;
    repo.store().get_commit_async(&id).await.map_err(|e| fail("wc-commit", e))
}

fn snapshot_options(root: &Path) -> SnapshotOptions<'static> {
    SnapshotOptions {
        base_ignores: base_ignores(root),
        progress: None,
        start_tracking_matcher: &EverythingMatcher,
        force_tracking_matcher: &NothingMatcher,
        max_new_file_size: MAX_NEW_FILE_SIZE,
    }
}

/// 작업 본체. operation 설명 문자열을 돌려준다.
async fn apply(m: &mut MutableRepo, name: &jj_lib::ref_name::WorkspaceNameBuf, wc: &Commit, op: Op) -> Result<String, Coded> {
    match op {
        Op::New(ids) => {
            let mut seen = Vec::new();
            let mut parents = Vec::new();
            for id in ids {
                if seen.contains(&id) {
                    continue;
                }
                parents.push(resolve(m, &id).await?);
                seen.push(id);
            }
            let tree = merge_commit_trees(m, &parents).await.map_err(|e| fail("merge-trees", e))?;
            let new = m
                .new_commit(parents.iter().map(|c| c.id().clone()).collect(), tree)
                .write()
                .await
                .map_err(|e| fail("new-commit", e))?;
            m.edit(name.clone(), &new).await.map_err(|e| fail("edit", e))?;
            Ok("new empty commit".to_string())
        }
        Op::Describe(id, message) => {
            let c = resolve(m, &id).await?;
            ensure_mutable(m, &c).await?;
            let msg = complete_newline(&message);
            if msg != c.description() {
                m.rewrite_commit(&c).set_description(msg).write().await.map_err(|e| fail("describe", e))?;
            }
            Ok(format!("describe commit {}", c.id().hex()))
        }
        Op::Edit(id) => {
            let c = resolve(m, &id).await?;
            ensure_mutable(m, &c).await?;
            m.edit(name.clone(), &c).await.map_err(|e| fail("edit", e))?;
            Ok(format!("edit commit {}", c.id().hex()))
        }
        Op::Abandon(id) => {
            let c = resolve(m, &id).await?;
            ensure_mutable(m, &c).await?;
            m.record_abandoned_commit(&c);
            Ok(format!("abandon commit {}", c.id().hex()))
        }
        Op::Squash(id, paths) => {
            let c = match id {
                Some(id) => resolve(m, &id).await?,
                None => wc.clone(),
            };
            ensure_mutable(m, &c).await?;
            if c.parent_ids().len() != 1 {
                return Err(coded!("jj.mergeCommit", "Cannot squash a merge commit ({sha})", sha = short(c.id())));
            }
            let parent = get_commit(m, &c.parent_ids()[0]).await?;
            ensure_mutable(m, &parent).await?;
            let parent_tree = c.parent_tree(m.index()).await.map_err(|e| fail("parent-tree", e))?;
            let selected_tree = selection(&c, &parent_tree, &paths).await?;
            if !paths.is_empty() && selected_tree.tree_ids() == parent_tree.tree_ids() {
                return Err(coded!("jj.nothingToSquash", "The given paths have no changes in this commit"));
            }
            let src = CommitWithSelection { commit: c.clone(), selected_tree, parent_tree };
            let full = src.is_full_selection();
            let desc = if full { combine(parent.description(), c.description()) } else { parent.description().to_string() };
            if let Some(sq) = squash_commits(m, &[src], &parent, false).await.map_err(|e| fail("squash", e))? {
                sq.commit_builder.set_description(desc).write().await.map_err(|e| fail("squash-write", e))?;
            }
            Ok(format!("squash commit {}", c.id().hex()))
        }
        Op::Split(id, paths) => {
            let c = resolve(m, &id).await?;
            ensure_mutable(m, &c).await?;
            let parent_tree = c.parent_tree(m.index()).await.map_err(|e| fail("parent-tree", e))?;
            let selected = selection(&c, &parent_tree, &paths).await?;
            if selected.tree_ids() == parent_tree.tree_ids() || selected.tree_ids() == c.tree_ids() {
                return Err(coded!("jj.nothingToSplit", "Select some, but not all, of the commit's changed files"));
            }
            // 첫 커밋 = 선택한 파일(원래 change ID 유지), 둘째 = 나머지(원래 트리 그대로, 새 change ID)가 그 위에. 자손·@·북마크는 둘째로.
            let first = m
                .rewrite_commit(&c)
                .clear_rewrite_source()
                .set_tree(selected)
                .write()
                .await
                .map_err(|e| fail("split-first", e))?;
            m.rewrite_commit(&c)
                .set_parents(vec![first.id().clone()])
                .generate_new_change_id()
                .write()
                .await
                .map_err(|e| fail("split-second", e))?;
            Ok(format!("split commit {}", c.id().hex()))
        }
    }
}

/// `paths`가 비면 커밋 전체, 아니면 부모 트리에 지정 경로(파일 또는 디렉터리 접두, jj CLI의 fileset처럼)만 커밋 내용으로 바꾼 트리
async fn selection(c: &Commit, parent_tree: &MergedTree, paths: &[RepoPathBuf]) -> Result<MergedTree, Coded> {
    if paths.is_empty() {
        return Ok(c.tree());
    }
    restore_tree(&c.tree(), parent_tree, c.conflict_label(), "parents".to_string(), &PrefixMatcher::new(paths))
        .await
        .map_err(|e| fail("select", e))
}

fn combine(dest: &str, src: &str) -> String {
    match (dest.trim().is_empty(), src.trim().is_empty()) {
        (true, _) => src.to_string(),
        (_, true) => dest.to_string(),
        _ => format!("{}\n\n{}", dest.trim_end(), src.trim_start()),
    }
}
