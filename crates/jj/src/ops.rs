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
use jj_lib::op_store::RefTarget;
use jj_lib::op_walk;
use jj_lib::operation::Operation;
use jj_lib::ref_name::{RefName, RefNameBuf, RemoteName, RemoteNameBuf, WorkspaceName};
use jj_lib::repo::{MutableRepo, ReadonlyRepo, Repo, RepoLoader};
use jj_lib::repo_path::{RepoPath, RepoPathBuf};
use jj_lib::revset::RevsetExpression;
use jj_lib::rewrite::{merge_commit_trees, restore_tree, squash_commits, CommitWithSelection, RebaseOptions, RewriteRefsOptions};
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
    /// 마지막 operation(연속 undo면 그 앞 것)의 효과를 되돌리는 새 operation
    Undo,
    /// 해당 operation 시점의 저장소 상태로(새 operation)
    Restore(String),
    BookmarkSet { name: RefNameBuf, id: CommitId, backwards: bool },
    BookmarkDelete(RefNameBuf),
    BookmarkTrack { name: RefNameBuf, remote: RemoteNameBuf },
}

impl Op {
    /// 이 작업이 `id` 커밋을 직접 가리키는가
    fn references(&self, id: &CommitId) -> bool {
        match self {
            Op::New(ids) => ids.contains(id),
            Op::Describe(i, _) | Op::Edit(i) | Op::Split(i, _) | Op::Abandon(i) => i == id,
            Op::Squash(i, _) => i.as_ref() == Some(id),
            Op::BookmarkSet { id: i, .. } => i == id,
            Op::Undo | Op::Restore(_) | Op::BookmarkDelete(_) | Op::BookmarkTrack { .. } => false,
        }
    }

    /// `from`을 가리키는 인자를 `to`로 바꾼다
    /// 저장소 상태를 통째로 되돌리는 작업(작업 사본 변경은 먼저 별도 operation으로 남긴다)
    fn rewinds(&self) -> bool {
        matches!(self, Op::Undo | Op::Restore(_))
    }

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
            Op::BookmarkSet { id, .. } => fix(id),
            Op::Undo | Op::Restore(_) | Op::BookmarkDelete(_) | Op::BookmarkTrack { .. } => {}
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

/// 마지막 operation을 되돌린다(`jj undo`: 그 operation의 효과를 되돌리는 새 operation). 연속 호출하면 한 단계씩 더 거슬러 간다.
pub fn undo(repo: &Path) -> Result<Vec<Coded>, Coded> {
    run(repo, Op::Undo)
}

/// 저장소를 해당 operation 시점의 상태로 되돌린다(`jj op restore`, 새 operation). `op_id`는 16진수(전체 또는 접두).
pub fn op_restore(repo: &Path, op_id: &str) -> Result<Vec<Coded>, Coded> {
    // 길이 하한은 jj CLI와 같게 1자(접두가 모호하면 `jj.ambiguousOpId`로 거절), 상한은 전체 ID(128자)
    if op_id.is_empty() || op_id.len() > 128 || !op_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(coded!("jj.badOpId", "Invalid operation id: {id}", id = op_id.chars().take(64).collect::<String>()));
    }
    run(repo, Op::Restore(op_id.to_ascii_lowercase()))
}

/// 북마크를 커밋에 만들거나 옮긴다. 뒤로·옆으로 옮기려면 `allow_backwards`(jj `--allow-backwards`).
pub fn bookmark_set(repo: &Path, name: &str, sha: &str, allow_backwards: bool) -> Result<Vec<Coded>, Coded> {
    let name = parse_bookmark_name(name)?;
    // 루트 커밋(SHA 전부 0)은 저장소를 열기 전에 거절
    if sha.len() == 40 && sha.bytes().all(|b| b == b'0') {
        return Err(coded!("jj.rootCommit", "A bookmark cannot point to the root commit"));
    }
    run(repo, Op::BookmarkSet { name, id: parse_sha(sha)?, backwards: allow_backwards })
}

/// 로컬 북마크를 지운다(git 브랜치도 export로 지워진다).
pub fn bookmark_delete(repo: &Path, name: &str) -> Result<Vec<Coded>, Coded> {
    run(repo, Op::BookmarkDelete(parse_bookmark_name(name)?))
}

/// 원격 북마크를 추적한다(로컬 북마크를 만들고 합친다).
pub fn bookmark_track(repo: &Path, name: &str, remote: &str) -> Result<Vec<Coded>, Coded> {
    let name = parse_bookmark_name(name)?;
    let bad = || coded!("jj.badRemote", "Invalid remote name: {remote}", remote = remote.chars().take(64).collect::<String>());
    if remote.is_empty() || remote == "git" || remote.starts_with('-') || remote.contains(['/', '@', '\\', ':', '\0']) || remote.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(bad());
    }
    run(repo, Op::BookmarkTrack { name, remote: RemoteNameBuf::from(remote) })
}

/// git ref 이름 규칙(`git check-ref-format`)에 더해 jj·인자 주입 방어: `-`로 시작·`@`·`..`·공백·제어문자·`~^:?*[\\`·`//`·
/// 앞뒤 `/`·`.`으로 시작하는 구성요소·`.lock`/`.`로 끝나는 구성요소·`HEAD` 거절. 길이 255 이하.
pub(crate) fn parse_bookmark_name(s: &str) -> Result<RefNameBuf, Coded> {
    let bad = || coded!("jj.badBookmark", "Invalid bookmark name: {name}", name = s.chars().take(100).collect::<String>());
    if s.is_empty() || s.len() > 255 || s == "HEAD" || s.starts_with('-') || s.contains("..") || s.contains("@{") {
        return Err(bad());
    }
    if s.chars().any(|c| c.is_control() || c.is_whitespace() || is_format_char(c) || "@~^:?*[\\".contains(c)) {
        return Err(bad());
    }
    for c in s.split('/') {
        if c.is_empty() || c.starts_with('.') || c.ends_with('.') || c.ends_with(".lock") || reserved_component(c) {
            return Err(bad());
        }
    }
    Ok(RefNameBuf::from(s))
}

/// 눈에 안 보이는 서식 문자(Unicode `Cf` 범주): 이름을 다른 것처럼 보이게 하는 데 쓰인다(양방향 제어·폭 없는 공백·BOM 등)
fn is_format_char(c: char) -> bool {
    matches!(c as u32,
        0x00AD | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x0890..=0x0891 | 0x08E2 | 0x180E
        | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F | 0xFEFF | 0xFFF9..=0xFFFB
        | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3 | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F)
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
    static LOCKS: OnceLock<Mutex<HashMap<String, &'static Mutex<()>>>> = OnceLock::new();
    let m: &'static Mutex<()> = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(gc_pathkey::real_key(root))
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
    let mut m = tx.repo_mut();

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

    // undo·restore: 대상 검증을 snapshot operation을 만들기 **전에** 한다(거절된 요청이 op log를 바꾸지 않게).
    // snapshot이 만들어지면 그 operation은 지금 head의 자식이 되고 대상(head의 조상)은 그대로라 검증이 유효하다(아래에서 부모 관계 확인).
    let snapshotted = op.rewinds() && !refused && wc_commit.id() != &pre_import_wc;
    let rewind = match &op {
        Op::Undo => Some(plan_undo(&repo, root, snapshotted, name_ref).await?),
        Op::Restore(id) => Some(plan_restore(&repo, root, id, name_ref).await?),
        _ => None,
    };
    // 작업 사본에 변경이 있으면 jj CLI처럼 먼저 별도의 `snapshot working copy` operation(snapshot 표시)으로 남긴다.
    // 그 operation이 새 head가 되므로, `jj undo`는 CLI와 마찬가지로 그 snapshot을 되돌린다(변경은 operation log로 복구 가능).
    if snapshotted {
        let head_before = repo.operation().id().clone();
        m.rebase_descendants().await.map_err(|e| fail("rebase", e))?;
        tx.set_is_snapshot(true);
        let saved = tx.commit("snapshot working copy").await.map_err(|e| fail("commit", e))?;
        if saved.operation().parent_ids() != [head_before] {
            return Err(fail("snapshot-op", "unexpected operation parent"));
        }
        locked.finish(saved.op_id().clone()).await.map_err(|e| fail("wc-finish", e))?;
        locked = ws.start_working_copy_mutation().await.map_err(|e| fail("wc-lock", e))?;
        repo = saved;
        wc_commit = wc_commit_of(&repo, name_ref).await?;
        tx = repo.start_transaction();
        m = tx.repo_mut();
    }

    // 3. 작업
    let delete_abandoned = matches!(op, Op::Abandon(_));
    let description = if refused { "import git head".to_string() } else { apply(m, &loader, rewind, &name, &wc_commit, op).await? };

    // 4~6. 자손 rebase, git HEAD·인덱스, git ref export.
    // 순서 이유: 둘 다 커밋 전에 한다. 커밋(op 기록)이 끝난 뒤에 git을 건드리다 실패하면 jj의 view와 git이 어긋난 채 남기 때문이다.
    // 먼저 하면 실패 시 op가 남지 않아 다음 호출의 import가 git 쪽 변경을 다시 맞춘다. ref export 실패(`failed_*`)는
    // 개별 ref 단위이고 view의 git_refs에 반영되지 않아 다음 import가 되돌려 맞추므로 경고로 돌려준다.
    // jj CLI의 abandon처럼: 버려진 커밋을 가리키던 북마크는 부모로 옮기지 않고 지운다
    let rebase_options = RebaseOptions {
        rewrite_refs: RewriteRefsOptions { delete_abandoned_bookmarks: delete_abandoned },
        ..Default::default()
    };
    m.rebase_descendants_with_options(&RevsetExpression::none(), &rebase_options, |_, _| {})
        .await
        .map_err(|e| fail("rebase", e))?;
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
async fn apply(m: &mut MutableRepo, loader: &RepoLoader, rewind: Option<Rewind>, name: &jj_lib::ref_name::WorkspaceNameBuf, wc: &Commit, op: Op) -> Result<String, Coded> {
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
        Op::Undo | Op::Restore(_) => {
            // 대상·설명은 snapshot 전에 `plan_undo`·`plan_restore`가 검증해 둔 것(거절된 요청이 op log를 바꾸지 않게)
            let r = rewind.ok_or_else(|| fail("rewind", "no plan"))?;
            let base = m.base_repo().clone();
            let target_repo = loader.load_at(&r.target).await.map_err(|e| fail("load-op", e))?;
            rewind_view(m, name, &base, &target_repo).await?;
            Ok(r.desc)
        }
        Op::BookmarkSet { name, id, backwards } => {
            let c = resolve(m, &id).await?;
            if c.id() == m.store().root_commit_id() {
                return Err(coded!("jj.rootCommit", "A bookmark cannot point to the root commit"));
            }
            let old = m.view().get_local_bookmark(&name).clone();
            if !backwards {
                // 이미 있고 충돌이 아니면 새 대상이 옛 대상의 자손이어야 한다(jj: Refusing to move bookmark backwards or sideways)
                if let Some(old_id) = old.as_normal() {
                    if !m.index().is_ancestor(old_id, c.id()).await.map_err(|e| fail("index", e))? {
                        return Err(coded!("jj.bookmarkBackwards", "Moving bookmark {name} backwards or sideways needs confirmation", name = name.as_str().to_string()));
                    }
                }
            }
            let desc = if old.is_absent() {
                format!("create bookmark {} pointing to commit {}", name.as_str(), c.id().hex())
            } else {
                format!("point bookmark {} to commit {}", name.as_str(), c.id().hex())
            };
            m.set_local_bookmark_target(&name, RefTarget::normal(c.id().clone()));
            Ok(desc)
        }
        Op::BookmarkDelete(name) => {
            if m.view().get_local_bookmark(&name).is_absent() {
                return Err(coded!("jj.noBookmark", "No such bookmark: {name}", name = name.as_str().to_string()));
            }
            m.set_local_bookmark_target(&name, RefTarget::absent());
            Ok(format!("delete bookmark {}", name.as_str()))
        }
        Op::BookmarkTrack { name, remote } => {
            let symbol = RefName::new(name.as_str()).to_remote_symbol(RemoteName::new(remote.as_str()));
            let rr = m.get_remote_bookmark(symbol).clone();
            if rr.target.is_absent() {
                return Err(coded!("jj.noBookmark", "No such remote bookmark: {name}", name = format!("{}@{}", name.as_str(), remote.as_str())));
            }
            if !rr.is_tracked() {
                m.track_remote_bookmark(symbol).await.map_err(|e| fail("track", e))?;
            }
            Ok(format!("track remote bookmark {}@{}", name.as_str(), remote.as_str()))
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

/// undo·restore가 view를 되돌릴 대상 operation과 새 operation의 설명
struct Rewind {
    target: Operation,
    desc: String,
}

const UNDO_PREFIX: &str = "undo: restore to operation ";

/// jj CLI는 undo operation을 설명(`undo: restore to operation <전체 ID>`)으로 알아본다. 그 ID(되돌려 간 대상).
fn undo_target_id(desc: &str) -> Option<&str> {
    desc.strip_prefix(UNDO_PREFIX).map(str::trim).filter(|h| !h.is_empty() && h.len() <= 128 && h.bytes().all(|b| b.is_ascii_hexdigit()))
}

async fn resolve_op(repo: &ReadonlyRepo, id: &str) -> Result<Operation, Coded> {
    use op_walk::{OpsetEvaluationError, OpsetResolutionError};
    match op_walk::resolve_op_at(repo.op_store(), std::slice::from_ref(repo.operation()), id).await {
        Ok(o) => Ok(o),
        Err(OpsetEvaluationError::OpsetResolution(OpsetResolutionError::AmbiguousIdPrefix(_))) => {
            Err(coded!("jj.ambiguousOpId", "Operation id prefix is ambiguous: {id}", id = id.to_string()))
        }
        Err(OpsetEvaluationError::OpsetResolution(_)) => Err(coded!("jj.noOperation", "Operation not found: {id}", id = id.to_string())),
        Err(e) => Err(fail("op", e)),
    }
}

/// 현재 git 저장소에 사용자 커밋이 있는가: HEAD(jj가 만든 커밋이면 제외)와 `refs/jj/` 밖의 모든 ref(브랜치·태그[annotated는 벗겨서]·원격 등)가 가리키는 커밋은
/// 모양(부모·트리)과 무관하게 센다(`git commit --allow-empty`로 만든 빈 최초 커밋도 사용자 커밋). `refs/jj/keep/*`는 jj가 모든 커밋에 거는 ref라서
/// **jj가 만든 커밋만 제외**한다: jj가 쓰는 커밋은 `change-id` 헤더가 있고(jj CLI로 확인: 빈 `@`·rewrite한 커밋 모두), git으로 만든 커밋엔 없다.
/// `refs/jj/` 아래 그 밖의 ref(`refs/jj/root` 등)는 세지 않는다. 읽지 못하면 보수적으로 true.
fn git_has_commits(root: &Path) -> bool {
    let Ok(r) = gix::open(root) else { return true };
    let is_commit = |id: gix::Id<'_>| id.object().and_then(|o| o.peel_to_commit()).is_ok();
    let jj_made = |id: gix::Id<'_>| match id.object().and_then(|o| o.peel_to_commit()) {
        Ok(c) => c.decode().map(|d| d.extra_headers().find("change-id").is_some()).unwrap_or(false),
        Err(_) => true,
    };
    if r.head_id().is_ok_and(|id| is_commit(id) && !jj_made(id)) {
        return true;
    }
    let Ok(refs) = r.references() else { return true };
    let Ok(all) = refs.all() else { return true };
    for reference in all {
        let Ok(mut reference) = reference else { return true };
        let name = reference.name().as_bstr().to_string();
        let Ok(id) = reference.peel_to_id() else { continue };
        let counted = if name.starts_with("refs/jj/keep/") {
            !jj_made(id)
        } else if name.starts_with("refs/jj/") {
            false
        } else {
            is_commit(id)
        };
        if counted {
            return true;
        }
    }
    false
}

/// 되돌릴 대상 operation의 **view**로 판정한다(op 위치·설명·개수는 켠 방법·jj 버전마다 달라 쓰지 않는다):
/// - 그 시점에 이 작업 공간의 `@`가 없으면 거절.
/// - jj가 git에서 가져온 ref 기록(`git_refs`)과 git HEAD 기록이 둘 다 비어 있는데(= 아직 git을 가져오기 전: `add workspace` 시점) 현재 git에는
///   커밋이 있으면 거절한다(그 상태로 가면 git HEAD가 `refs/jj/root`로 가고 추적 파일이 사라진다). 원래 커밋이 없던 저장소는 허용한다.
///
/// `import git refs`(jj CLI 켜기의 두 번째 op)부터는 `jj new 'root()'` 뒤와 view 모양이 같아서(`@` 부모=루트·git_head 없음·git_refs 있음) 구분할 수 없고,
/// jj CLI도 그 시점을 허용한다. 고아 브랜치·detached HEAD 저장소도 git_refs나 git_head가 채워져 허용된다.
/// 거절 코드는 모두 `jj.cannotUndo`(막혀서 못 감). 되돌릴 대상 자체가 없으면 `jj.nothingToUndo`(plan_undo).
async fn check_restorable(root: &Path, target: &Operation, name: &WorkspaceName) -> Result<(), Coded> {
    let view = target.view().await.map_err(|e| fail("op-view", e))?;
    if view.get_wc_commit_id(name).is_none() {
        return Err(coded!("jj.cannotUndo", "Cannot go back to before this workspace was created"));
    }
    if view.git_refs().is_empty() && view.git_head(name).is_absent() && git_has_commits(root) {
        return Err(coded!("jj.cannotUndo", "Cannot go back to before jj was enabled"));
    }
    Ok(())
}

/// `jj undo`(0.47.1)와 같게: 되돌릴 operation X = head(head가 `undo: restore to operation H`면 H), 새 operation은 X의 부모 시점으로 view를 되돌린다
/// (`undo: restore to operation <부모 ID>`; 부모가 undo operation이면 그것이 되돌려 간 대상 ID). 작업 사본에 변경이 있어 먼저
/// snapshot operation이 만들어질 때(`snapshotted`)는 그 snapshot operation이 X다 — CLI도 같다(미저장 변경이 있는 채 undo하면 snapshot만 취소된다).
async fn plan_undo(repo: &ReadonlyRepo, root: &Path, snapshotted: bool, name: &WorkspaceName) -> Result<Rewind, Coded> {
    let mut p = if snapshotted {
        repo.operation().clone()
    } else {
        let mut x = repo.operation().clone();
        if let Some(h) = undo_target_id(&x.metadata().description) {
            if let Ok(o) = resolve_op(repo, h).await {
                x = o;
            }
        }
        let mut ps = x.parents().await.map_err(|e| fail("op-parent", e))?;
        match ps.len() {
            0 => return Err(coded!("jj.nothingToUndo", "There is no operation to undo")),
            1 => ps.remove(0),
            _ => return Err(coded!("jj.cannotUndo", "Cannot undo a merge operation")),
        }
    };
    if let Some(h) = undo_target_id(&p.metadata().description) {
        if let Ok(o) = resolve_op(repo, h).await {
            p = o;
        }
    }
    check_restorable(root, &p, name).await?;
    Ok(Rewind { desc: format!("{UNDO_PREFIX}{}", p.id().hex()), target: p })
}

async fn plan_restore(repo: &ReadonlyRepo, root: &Path, id: &str, name: &WorkspaceName) -> Result<Rewind, Coded> {
    let t = resolve_op(repo, id).await?;
    check_restorable(root, &t, name).await?;
    Ok(Rewind { desc: format!("restore to operation {}", t.id().hex()), target: t })
}

/// 3-way 병합(`현재 += 목표 - 현재 기준`)으로 view를 목표 operation 시점으로 되돌린다(현재가 기준과 같으면 목표와 같아진다).
/// git ref·HEAD 기록(view의 git_refs·git_heads)은 병합 전 값을 유지한다: 그래야 뒤따르는 export가 되돌려진 북마크·태그를 실제 git ref에 반영한다
/// (jj CLI의 op restore도 현재 view의 git_refs를 유지).
async fn rewind_view(m: &mut MutableRepo, name: &WorkspaceName, base: &ReadonlyRepo, other: &ReadonlyRepo) -> Result<(), Coded> {
    let saved = m.view().store_view().clone();
    m.merge(base, other).await.map_err(|e| fail("merge-op", e))?;
    let mut data = m.view().store_view().clone();
    data.git_refs = saved.git_refs;
    data.git_heads = saved.git_heads;
    m.set_view(data);
    if m.view().get_wc_commit_id(name).is_none() {
        return Err(coded!("jj.cannotUndo", "Cannot go back to before this workspace was created"));
    }
    Ok(())
}
