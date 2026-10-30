//! 순수 Rust(gitoxide) 백엔드 `GixBackend` (feature `gix`). git 실행 파일 없이 저장소를 읽고 쓴다.
//!
//! 구현한 작업만 `capabilities().ops`에 나열한다(`all: false`). `run`(`config --get`·`symbolic-ref`·`rev-parse`)과 `spawn_job`(`fetch [<remote>]`·`clone`)은
//! argv 허용 목록만 해석하는 부분 지원이라 서브커맨드 이름(`fetch`·`config`…)은 나열하지 않는다(UI의 `fetch --all --prune --tags` 같은 argv가 안 돌기 때문). 나머지는 trait 기본값 `Error::Unsupported`.
//! 반환 타입은 `CliBackend`와 같은 의미여야 하며, `tests/gix_cross.rs`가 같은 저장소에서 두 백엔드를 비교한다.
//! 모든 gix 호출은 블로킹이라 `spawn_blocking`에서 돈다(저장소는 호출마다 연다).

mod argv;
mod clone;
mod common;
mod diff;
mod fetch;
mod log;
mod refs;
mod status;
mod textdiff;
mod write;

use std::path::Path;

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::{Capabilities, ChangedFile, Commit, GitBackend, JobEvent, Ref, Result, Spawned, Status};

/// 구현한 작업 이름 (`GitBackend` 메서드 이름 또는 git 서브커맨드). `capabilities`와 문서가 같은 목록을 쓴다.
pub const OPS: &[&str] = &[
    "read_log", "head_commit", "read_refs", "read_status", "changed_files", "file_diff", "worktree_diff", "file_blob", "commit_message", "committer", "stage", "unstage", "commit", "clone",
];

#[derive(Default)]
pub struct GixBackend;

impl GixBackend {
    pub fn new() -> Self {
        Self
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(f).await.map_err(common::fail)?
}

#[async_trait]
impl GitBackend for GixBackend {
    fn capabilities(&self) -> Capabilities {
        Capabilities { all: false, ops: OPS.iter().map(|s| (*s).to_owned()).collect() }
    }

    async fn git_version(&self) -> Result<Option<String>> {
        // git 실행 파일이 없는 백엔드: "미설치"(None)가 아니라 gix 구현임을 알린다(UI는 숫자로 시작하지 않는 값은 버전 비교를 건너뛴다)
        Ok(Some("gitoxide".to_owned()))
    }

    async fn run(&self, repo: &Path, argv: &[&str], ok: &[i32]) -> Result<Vec<u8>> {
        let (repo, argv, ok) = (repo.to_path_buf(), argv.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>(), ok.to_vec());
        blocking(move || argv::run(&repo, &argv, &ok)).await
    }

    fn spawn_job(&self, repo: &Path, argv: &[&str], ssh_batch: Option<bool>, events: mpsc::UnboundedSender<JobEvent>) -> Result<Spawned> {
        clone::spawn(repo, argv, events.clone()).unwrap_or_else(|| fetch::spawn(repo, argv, ssh_batch, events))
    }

    async fn read_log(&self, repo: &Path, limit: usize, hidden: &[String]) -> Result<Vec<Commit>> {
        let (repo, hidden) = (repo.to_path_buf(), hidden.to_vec());
        blocking(move || log::read_log(&repo, limit, &hidden)).await
    }
    async fn head_commit(&self, repo: &Path) -> Option<String> {
        let repo = repo.to_path_buf();
        blocking(move || Ok(log::head_commit(&repo))).await.ok().flatten()
    }
    async fn read_refs(&self, repo: &Path) -> Result<Vec<Ref>> {
        let repo = repo.to_path_buf();
        blocking(move || refs::read_refs(&repo)).await
    }
    async fn read_status(&self, repo: &Path) -> Result<Status> {
        let repo = repo.to_path_buf();
        blocking(move || status::read_status(&repo)).await
    }
    async fn worktree_diff(&self, repo: &Path, path: &str, staged: bool, untracked: bool, ignore_eol: bool, ignore_ws: bool) -> Result<String> {
        let (repo, path) = (repo.to_path_buf(), path.to_owned());
        blocking(move || diff::worktree_diff(&repo, &path, staged, untracked, ignore_eol, ignore_ws)).await
    }
    async fn changed_files(&self, repo: &Path, commit: &str) -> Result<Vec<ChangedFile>> {
        let (repo, commit) = (repo.to_path_buf(), commit.to_owned());
        blocking(move || diff::changed_files(&repo, &commit)).await
    }
    async fn file_diff(&self, repo: &Path, commit: &str, path: &str, ignore_eol: bool, ignore_ws: bool) -> Result<String> {
        let (repo, commit, path) = (repo.to_path_buf(), commit.to_owned(), path.to_owned());
        blocking(move || diff::file_diff(&repo, &commit, &path, ignore_eol, ignore_ws)).await
    }
    async fn file_blob(&self, repo: &Path, rev: Option<&str>, path: &str) -> Result<Option<Vec<u8>>> {
        let (repo, rev, path) = (repo.to_path_buf(), rev.map(str::to_owned), path.to_owned());
        blocking(move || diff::file_blob(&repo, rev.as_deref(), &path)).await
    }
    async fn commit_message(&self, repo: &Path, sha: &str) -> Result<String> {
        let (repo, sha) = (repo.to_path_buf(), sha.to_owned());
        blocking(move || log::commit_message(&repo, &sha)).await
    }
    async fn committer(&self, repo: &Path, sha: &str) -> Result<(String, String, i64)> {
        let (repo, sha) = (repo.to_path_buf(), sha.to_owned());
        blocking(move || log::committer(&repo, &sha)).await
    }

    async fn stage(&self, repo: &Path, paths: &[String]) -> Result<()> {
        let (repo, paths) = (repo.to_path_buf(), paths.to_vec());
        blocking(move || write::stage(&repo, &paths)).await
    }
    async fn unstage(&self, repo: &Path, paths: &[String]) -> Result<()> {
        let (repo, paths) = (repo.to_path_buf(), paths.to_vec());
        blocking(move || write::unstage(&repo, &paths)).await
    }
    async fn commit(&self, repo: &Path, message: &str, amend: bool) -> Result<()> {
        let (repo, message) = (repo.to_path_buf(), message.to_owned());
        blocking(move || write::commit(&repo, &message, amend)).await
    }
}
