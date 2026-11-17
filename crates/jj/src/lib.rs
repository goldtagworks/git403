//! jj(Jujutsu) 연동 코어: `jj-lib`로 기존 git 저장소에 jj를 붙이고(`enable`) 상태를 읽는다(`status`).
//!
//! 저장소는 신뢰하지 않는다. 사용자 jj 설정·저장소 jj 설정은 읽지 않고(기본 설정만),
//! `.git`·`.jj`가 실제 디렉터리(심볼릭 링크·gitfile 아님)일 때만 연다.
//! gix 버전은 `jj-lib`가 쓰는 것(0.90)과 `gc-core`가 같아야 한다.

mod disable;
mod ops;
mod read;
pub use disable::{disable, disable_check, DisableCheck, Orphan, KEEP_PREFIX};
pub use ops::{abandon, bookmark_delete, bookmark_set, bookmark_track, describe, edit, new_commit, op_restore, split, squash, undo};
pub use read::{bookmarks, op_log, Bookmark, BookmarkRemote, OpLogEntry};
pub(crate) use ops::repo_lock;

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use gc_i18n::{coded, Coded};
use jj_lib::config::{ConfigLayer, ConfigSource, StackedConfig};
use jj_lib::default_backend_factories::{
    default_backend_factories, default_working_copy_factories, default_workspace_loader_factory,
};
use jj_lib::git::{self, GitImportOptions};
use jj_lib::object_id::ObjectId;
use jj_lib::ref_name::WorkspaceName;
use jj_lib::repo::{ReadonlyRepo, Repo};
use jj_lib::settings::UserSettings;
use jj_lib::workspace::Workspace;

/// `status`가 훑는 커밋 수 상한(`@`·visible heads에서 부모로 거슬러 올라감).
pub const MAX_COMMITS: usize = 2000;
/// 짧은 change ID 길이(jj 역 hex 문자 수).
pub const SHORT_CHANGE_ID_LEN: usize = 12;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ChangeId {
    /// 앞 `SHORT_CHANGE_ID_LEN`자
    pub short: String,
    /// 전체(jj 역 hex, `k-z` 문자)
    pub full: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JjStatus {
    /// `@`(작업 중 커밋)의 git 커밋 SHA. 작업 공간에 `@`가 없으면 None
    pub working_copy: Option<String>,
    /// 커밋 SHA → change ID (`MAX_COMMITS`까지)
    pub change_ids: BTreeMap<String, ChangeId>,
    /// 충돌이 있는 커밋 SHA
    pub conflicted: Vec<String>,
    /// 상한에 걸려 change_ids가 잘렸는지
    pub truncated: bool,
}

pub(crate) fn fail(step: &str, e: impl std::fmt::Display) -> Coded {
    coded!("jj.failed", "jj operation failed ({step}): {detail}", step = step, detail = e.to_string())
}

fn real_dir(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

/// 저장소 루트 검증: 정규화되고 `.git`이 실제 디렉터리(링크·gitfile 아님)
pub(crate) fn check_root(repo: &Path) -> Result<PathBuf, Coded> {
    let root = fs::canonicalize(repo).map_err(|e| fail("path", e))?;
    if !real_dir(&root.join(".git")) {
        return Err(coded!("jj.notRepo", "Not a plain git repository (.git must be a real directory)"));
    }
    Ok(root)
}

fn settings() -> Result<UserSettings, Coded> {
    UserSettings::from_config_and_home_dir(StackedConfig::with_defaults(), None).map_err(|e| fail("settings", e))
}

/// 쓰기 작업용 설정: 기본 설정 + 저장소의 git 설정(`user.name`·`user.email`, 전역·저장소 git config 그대로 = git 커밋과 같은 작성자).
/// 사용자·저장소 jj 설정은 읽지 않는다. git 실행 파일은 쓰지 않는다(gix로 읽음 — PATH·Android 무관).
pub(crate) fn settings_with_identity(root: &Path) -> Result<UserSettings, Coded> {
    let mut config = StackedConfig::with_defaults();
    let mut layer = ConfigLayer::empty(ConfigSource::User);
    if let Ok(repo) = gix::open(root) {
        let snap = repo.config_snapshot();
        for key in ["user.name", "user.email"] {
            if let Some(v) = snap.string(key) {
                let v = v.to_string();
                if !v.trim().is_empty() {
                    layer.set_value(key, v).map_err(|e| fail("settings", e))?;
                }
            }
        }
    }
    config.add_layer(layer);
    UserSettings::from_config_and_home_dir(config, None).map_err(|e| fail("settings", e))
}

/// `.jj`·`.jj/repo`·`.jj/working_copy`가 모두 실제 디렉터리(링크 아님)
pub fn is_enabled(repo_path: &Path) -> bool {
    let Ok(root) = fs::canonicalize(repo_path) else { return false };
    let jj = root.join(".jj");
    real_dir(&root.join(".git")) && real_dir(&jj) && real_dir(&jj.join("repo")) && real_dir(&jj.join("working_copy"))
}

/// 기존 git 저장소에 jj를 붙인다(`.git` 그대로). 이미 켜져 있으면 통과(멱등).
/// jj CLI처럼 `.jj/.gitignore`(`/*`)를 만들어 `git status`에 `.jj/`가 안 보이게 한다.
pub fn enable(repo_path: &Path) -> Result<(), Coded> {
    let root = check_root(repo_path)?;
    let _gate = repo_lock(&root);
    let jj = root.join(".jj");
    if fs::symlink_metadata(&jj).is_ok() {
        if is_enabled(&root) {
            return ensure_gitignore(&jj);
        }
        return Err(coded!("jj.partial", "A .jj entry exists but is not a valid jj workspace"));
    }
    let settings = settings()?;
    let git_dir = root.join(".git");
    let (ws, repo) =
        pollster::block_on(Workspace::init_external_git(&settings, &root, WorkspaceName::DEFAULT, &git_dir))
            .map_err(|e| fail("init", e))?;
    // `.jj`가 생겼으니 곧바로 `git status`에서 숨긴다(이후 단계가 실패해도 `.jj/`가 보이지 않게)
    ensure_gitignore(&jj)?;
    pollster::block_on(import_git(ws, repo, &root))
}

/// jj CLI의 `git init`처럼: git 브랜치·태그·HEAD를 jj로 가져오고, `@`를 HEAD 위의 빈 커밋으로 둔다.
/// 작업 폴더 파일과 `.git`(ref·index·HEAD)은 건드리지 않는다(작업 사본은 `reset`으로 상태만 맞춘다).
async fn import_git(mut ws: Workspace, repo: Arc<ReadonlyRepo>, root: &Path) -> Result<(), Coded> {
    let name = WorkspaceName::DEFAULT;
    let mut tx = repo.start_transaction();
    let m = tx.repo_mut();
    git::import_head(m, name, root).await.map_err(|e| fail("import-head", e))?;
    let options = GitImportOptions {
        abandon_unreachable_commits: false,
        record_synthetic_predecessors: false,
        remote_auto_track_bookmarks: HashMap::new(),
    };
    git::import_refs(m, &options).await.map_err(|e| fail("import-refs", e))?;
    let head = m.view().git_head(name).as_normal().cloned();
    let mut new_wc = None;
    if let Some(id) = head {
        let head = m.store().get_commit_async(&id).await.map_err(|e| fail("head-commit", e))?;
        new_wc = Some(m.check_out(name.to_owned(), &head).await.map_err(|e| fail("check-out", e))?);
    }
    m.rebase_descendants().await.map_err(|e| fail("rebase", e))?;
    let repo = tx.commit("import git refs").await.map_err(|e| fail("commit", e))?;
    if let Some(wc) = new_wc {
        let mut locked = ws.start_working_copy_mutation().await.map_err(|e| fail("wc-lock", e))?;
        locked.locked_wc().reset(&wc).await.map_err(|e| fail("wc-reset", e))?;
        locked.finish(repo.op_id().clone()).await.map_err(|e| fail("wc-finish", e))?;
    }
    Ok(())
}

fn ensure_gitignore(jj: &Path) -> Result<(), Coded> {
    let f = jj.join(".gitignore");
    match fs::symlink_metadata(&f) {
        Ok(m) if m.is_file() => Ok(()),
        Ok(_) => Err(coded!("jj.partial", "A .jj entry exists but is not a valid jj workspace")),
        Err(_) => fs::write(&f, "/*\n").map_err(|e| fail("gitignore", e)),
    }
}

fn load(root: &Path) -> Result<(Workspace, Arc<ReadonlyRepo>), Coded> {
    load_with(root, &settings()?)
}

pub(crate) fn load_workspace(root: &Path, settings: &UserSettings) -> Result<Workspace, Coded> {
    default_workspace_loader_factory()
        .create(root)
        .map_err(|e| fail("loader", e))?
        .load(settings, &default_backend_factories(), &default_working_copy_factories())
        .map_err(|e| fail("load", e))
}

pub(crate) fn load_with(root: &Path, settings: &UserSettings) -> Result<(Workspace, Arc<ReadonlyRepo>), Coded> {
    let ws = load_workspace(root, settings)?;
    let repo = pollster::block_on(ws.load_at_head()).map_err(|e| fail("head", e))?;
    Ok((ws, repo))
}

/// `@`·change ID 맵·충돌 커밋. jj가 안 켜져 있으면 오류.
pub fn status(repo_path: &Path) -> Result<JjStatus, Coded> {
    let root = check_root(repo_path)?;
    if !is_enabled(&root) {
        return Err(coded!("jj.notEnabled", "jj is not enabled for this repository"));
    }
    let (ws, repo) = load(&root)?;
    pollster::block_on(async {
        let store = repo.store();
        let view = repo.view();
        let mut out = JjStatus::default();
        let wc = view.get_wc_commit_id(ws.workspace_name()).cloned();
        out.working_copy = wc.as_ref().map(|c| c.hex());
        let mut queue: VecDeque<_> = wc.into_iter().chain(view.heads().iter().cloned()).collect();
        let mut seen = HashSet::new();
        while let Some(id) = queue.pop_front() {
            if !seen.insert(id.clone()) || id == *store.root_commit_id() {
                continue;
            }
            if out.change_ids.len() >= MAX_COMMITS {
                out.truncated = true;
                break;
            }
            let c = store.get_commit_async(&id).await.map_err(|e| fail("commit", e))?;
            let full = c.change_id().reverse_hex();
            let short = full.chars().take(SHORT_CHANGE_ID_LEN).collect();
            let sha = id.hex();
            if c.has_conflict() {
                out.conflicted.push(sha.clone());
            }
            out.change_ids.insert(sha, ChangeId { short, full });
            queue.extend(c.parent_ids().iter().cloned());
        }
        Ok(out)
    })
}
