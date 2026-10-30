//! git 실행 경로를 숨기는 백엔드 trait. 호출 측(`gc-backend`)은 `Arc<dyn GitBackend>`만 안다.
//!
//! - `CliBackend`(feature `cli`, 기본): `GitRunner`로 git 프로세스를 띄워 기존 함수를 그대로 부른다.
//! - 다른 백엔드(예: 순수 Rust gitoxide, feature `gix` 예약)는 지원하는 메서드만 재정의한다.
//!   재정의하지 않은 메서드는 `Error::Unsupported`(코드 `git.unsupported`)를 돌려주고, `supports`로 미리 물을 수 있다.
//!
//! 메서드 시그니처는 같은 이름의 기존 함수에서 `git: &GitRunner`만 뺀 것이다 (설명은 각 함수 문서).
//! askpass 환경·`path_override`·`spawn_shell`처럼 프로세스에 묶인 OS 연동은 trait에 넣지 않고 `GitRunner`를 직접 쓴다.

use std::path::Path;

use async_trait::async_trait;
use serde::Serialize;
use tokio::sync::mpsc;

use crate::{
    BlameLine, ChangedFile, Commit, ConflictBlobs, Error, JobEvent, JobHandle, Lfs, PatchTarget, Ref, RebaseStep, Result,
    StatsRange, Stats, Status, Submodule, Worktree,
};

/// 긴 작업 하나: 취소 핸들 + 끝을 기다리는 태스크.
pub type Spawned = (JobHandle, tokio::task::JoinHandle<Result<()>>);

/// 백엔드가 지원하는지 물을 작업 이름. 짧은·긴 argv 실행은 git 서브커맨드(`"push"`, `"rebase"`…),
/// 전용 메서드는 메서드 이름(`"read_log"`…)을 쓴다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Op<'a>(pub &'a str);

/// UI가 한 번에 받는 지원 목록. `all`이면 전부 지원, 아니면 `ops`(`Op`와 같은 이름)에 있는 것만 지원한다.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub all: bool,
    pub ops: Vec<String>,
}

fn no<T>(op: &str) -> Result<T> {
    Err(Error::Unsupported(op.to_owned()))
}

#[async_trait]
pub trait GitBackend: Send + Sync {
    /// 지원 목록. 기본은 아무것도 지원하지 않는다 (`CliBackend`는 `all: true`). IPC `capabilities`가 그대로 돌려준다.
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    /// 이 작업을 지원하는가 (`capabilities` 기반).
    fn supports(&self, op: &Op) -> bool {
        let c = self.capabilities();
        c.all || c.ops.iter().any(|o| o == op.0)
    }

    /// 짧은 argv 실행: 끝날 때까지 기다려 stdout을 돌려준다. `ok`는 성공으로 볼 종료 코드 (`GitRunner::output_allow`).
    async fn run(&self, _repo: &Path, _argv: &[&str], _ok: &[i32]) -> Result<Vec<u8>> {
        no("run")
    }

    /// 긴 argv 작업(pull·fetch·push…). `ssh_batch`가 `None`이면 평소대로, `Some(b)`면 인증 창 없는 백그라운드 실행
    /// (`GitRunner::spawn_batch`, `b`는 ssh BatchMode 여부). 진행은 `events`로 흐른다.
    fn spawn_job(&self, _repo: &Path, _argv: &[&str], _ssh_batch: Option<bool>, _events: mpsc::UnboundedSender<JobEvent>) -> Result<Spawned> {
        no("spawn_job")
    }

    async fn git_version(&self) -> Result<Option<String>> {
        no("git_version")
    }
    async fn ensure_commit_graph(&self, _repo: &Path) -> Result<bool> {
        no("ensure_commit_graph")
    }

    // ---- 조회 ----
    async fn read_log(&self, _repo: &Path, _limit: usize, _hidden: &[String]) -> Result<Vec<Commit>> {
        no("read_log")
    }
    async fn head_commit(&self, _repo: &Path) -> Option<String> {
        None
    }
    async fn file_log(&self, _repo: &Path, _path: &str, _limit: usize) -> Result<Vec<Commit>> {
        no("file_log")
    }
    async fn search_content(&self, _repo: &Path, _text: &str, _hidden: &[String]) -> Result<Vec<String>> {
        no("search_content")
    }
    async fn read_refs(&self, _repo: &Path) -> Result<Vec<Ref>> {
        no("read_refs")
    }
    async fn read_status(&self, _repo: &Path) -> Result<Status> {
        no("read_status")
    }
    async fn worktree_diff(&self, _repo: &Path, _path: &str, _staged: bool, _untracked: bool, _ignore_eol: bool, _ignore_ws: bool) -> Result<String> {
        no("worktree_diff")
    }
    async fn changed_files(&self, _repo: &Path, _commit: &str) -> Result<Vec<ChangedFile>> {
        no("changed_files")
    }
    async fn file_diff(&self, _repo: &Path, _commit: &str, _path: &str, _ignore_eol: bool, _ignore_ws: bool) -> Result<String> {
        no("file_diff")
    }
    async fn blame(&self, _repo: &Path, _path: &str, _rev: Option<&str>) -> Result<Vec<BlameLine>> {
        no("blame")
    }
    async fn file_blob(&self, _repo: &Path, _rev: Option<&str>, _path: &str) -> Result<Option<Vec<u8>>> {
        no("file_blob")
    }
    async fn conflict_blobs(&self, _repo: &Path, _path: &str) -> Result<ConflictBlobs> {
        no("conflict_blobs")
    }
    /// `on_start`는 계산을 시작한 직후 취소 핸들과 함께 불린다 (`repo_stats`와 같다).
    async fn repo_stats<'a>(
        &self,
        _repo: &Path,
        _range: StatsRange,
        _branch: Option<&str>,
        _with_lines: bool,
        _on_start: Box<dyn FnOnce(JobHandle) + Send + 'a>,
    ) -> Result<Stats> {
        no("repo_stats")
    }
    async fn read_submodules(&self, _repo: &Path) -> Result<Vec<Submodule>> {
        no("read_submodules")
    }
    async fn read_worktrees(&self, _repo: &Path) -> Result<Vec<Worktree>> {
        no("read_worktrees")
    }
    async fn lfs_status(&self, _repo: &Path) -> Result<Lfs> {
        no("lfs_status")
    }
    async fn last_message(&self, _repo: &Path) -> Result<String> {
        no("last_message")
    }
    async fn commit_message(&self, _repo: &Path, _sha: &str) -> Result<String> {
        no("commit_message")
    }
    async fn co_authors(&self, _repo: &Path, _sha: &str) -> Result<Vec<String>> {
        no("co_authors")
    }
    async fn committer(&self, _repo: &Path, _sha: &str) -> Result<(String, String, i64)> {
        no("committer")
    }
    async fn staged_crlf(&self, _repo: &Path) -> Result<Vec<String>> {
        no("staged_crlf")
    }

    // ---- 스테이지·커밋 ----
    async fn stage(&self, _repo: &Path, _paths: &[String]) -> Result<()> {
        no("stage")
    }
    async fn unstage(&self, _repo: &Path, _paths: &[String]) -> Result<()> {
        no("unstage")
    }
    async fn discard(&self, _repo: &Path, _tracked: &[String], _untracked: &[String]) -> Result<()> {
        no("discard")
    }
    async fn restore_file(&self, _repo: &Path, _rev: &str, _paths: &[String]) -> Result<()> {
        no("restore_file")
    }
    async fn apply_partial(&self, _repo: &Path, _diff: &str, _hunk: usize, _lines: Option<&[usize]>, _target: PatchTarget) -> Result<()> {
        no("apply_partial")
    }
    async fn commit(&self, _repo: &Path, _message: &str, _amend: bool) -> Result<()> {
        no("commit")
    }
    async fn rebase_interactive(&self, _repo: &Path, _base: &str, _steps: &[RebaseStep]) -> Result<()> {
        no("rebase_interactive")
    }
    async fn fix_crlf(&self, _repo: &Path, _paths: &[String]) -> Result<()> {
        no("fix_crlf")
    }
}

/// git 실행 파일을 띄워 기존 함수를 그대로 부르는 백엔드. 파서·인자는 각 함수에 있다.
#[cfg(feature = "cli")]
pub struct CliBackend(crate::GitRunner);

#[cfg(feature = "cli")]
impl CliBackend {
    pub fn new(git: crate::GitRunner) -> Self {
        Self(git)
    }
}

#[cfg(feature = "cli")]
#[async_trait]
impl GitBackend for CliBackend {
    fn capabilities(&self) -> Capabilities {
        Capabilities { all: true, ops: Vec::new() }
    }
    async fn run(&self, repo: &Path, argv: &[&str], ok: &[i32]) -> Result<Vec<u8>> {
        self.0.output_allow(repo, argv, ok).await
    }
    fn spawn_job(&self, repo: &Path, argv: &[&str], ssh_batch: Option<bool>, events: mpsc::UnboundedSender<JobEvent>) -> Result<Spawned> {
        match ssh_batch {
            None => self.0.spawn(repo, argv, events),
            Some(b) => self.0.spawn_batch(repo, argv, b, events),
        }
    }
    async fn git_version(&self) -> Result<Option<String>> {
        crate::git_version(&self.0).await
    }
    async fn ensure_commit_graph(&self, repo: &Path) -> Result<bool> {
        crate::ensure_commit_graph(&self.0, repo).await
    }
    async fn read_log(&self, repo: &Path, limit: usize, hidden: &[String]) -> Result<Vec<Commit>> {
        crate::read_log(&self.0, repo, limit, hidden).await
    }
    async fn head_commit(&self, repo: &Path) -> Option<String> {
        crate::head_commit(&self.0, repo).await
    }
    async fn file_log(&self, repo: &Path, path: &str, limit: usize) -> Result<Vec<Commit>> {
        crate::file_log(&self.0, repo, path, limit).await
    }
    async fn search_content(&self, repo: &Path, text: &str, hidden: &[String]) -> Result<Vec<String>> {
        crate::search_content(&self.0, repo, text, hidden).await
    }
    async fn read_refs(&self, repo: &Path) -> Result<Vec<Ref>> {
        crate::read_refs(&self.0, repo).await
    }
    async fn read_status(&self, repo: &Path) -> Result<Status> {
        crate::read_status(&self.0, repo).await
    }
    async fn worktree_diff(&self, repo: &Path, path: &str, staged: bool, untracked: bool, ignore_eol: bool, ignore_ws: bool) -> Result<String> {
        crate::worktree_diff(&self.0, repo, path, staged, untracked, ignore_eol, ignore_ws).await
    }
    async fn changed_files(&self, repo: &Path, commit: &str) -> Result<Vec<ChangedFile>> {
        crate::changed_files(&self.0, repo, commit).await
    }
    async fn file_diff(&self, repo: &Path, commit: &str, path: &str, ignore_eol: bool, ignore_ws: bool) -> Result<String> {
        crate::file_diff(&self.0, repo, commit, path, ignore_eol, ignore_ws).await
    }
    async fn blame(&self, repo: &Path, path: &str, rev: Option<&str>) -> Result<Vec<BlameLine>> {
        crate::blame(&self.0, repo, path, rev).await
    }
    async fn file_blob(&self, repo: &Path, rev: Option<&str>, path: &str) -> Result<Option<Vec<u8>>> {
        crate::file_blob(&self.0, repo, rev, path).await
    }
    async fn conflict_blobs(&self, repo: &Path, path: &str) -> Result<ConflictBlobs> {
        crate::conflict_blobs(&self.0, repo, path).await
    }
    async fn repo_stats<'a>(
        &self,
        repo: &Path,
        range: StatsRange,
        branch: Option<&str>,
        with_lines: bool,
        on_start: Box<dyn FnOnce(JobHandle) + Send + 'a>,
    ) -> Result<Stats> {
        crate::repo_stats(&self.0, repo, range, branch, with_lines, on_start).await
    }
    async fn read_submodules(&self, repo: &Path) -> Result<Vec<Submodule>> {
        crate::read_submodules(&self.0, repo).await
    }
    async fn read_worktrees(&self, repo: &Path) -> Result<Vec<Worktree>> {
        crate::read_worktrees(&self.0, repo).await
    }
    async fn lfs_status(&self, repo: &Path) -> Result<Lfs> {
        crate::lfs_status(&self.0, repo).await
    }
    async fn last_message(&self, repo: &Path) -> Result<String> {
        crate::last_message(&self.0, repo).await
    }
    async fn commit_message(&self, repo: &Path, sha: &str) -> Result<String> {
        crate::commit_message(&self.0, repo, sha).await
    }
    async fn co_authors(&self, repo: &Path, sha: &str) -> Result<Vec<String>> {
        crate::co_authors(&self.0, repo, sha).await
    }
    async fn committer(&self, repo: &Path, sha: &str) -> Result<(String, String, i64)> {
        crate::committer(&self.0, repo, sha).await
    }
    async fn staged_crlf(&self, repo: &Path) -> Result<Vec<String>> {
        crate::staged_crlf(&self.0, repo).await
    }
    async fn stage(&self, repo: &Path, paths: &[String]) -> Result<()> {
        crate::stage(&self.0, repo, paths).await
    }
    async fn unstage(&self, repo: &Path, paths: &[String]) -> Result<()> {
        crate::unstage(&self.0, repo, paths).await
    }
    async fn discard(&self, repo: &Path, tracked: &[String], untracked: &[String]) -> Result<()> {
        crate::discard(&self.0, repo, tracked, untracked).await
    }
    async fn restore_file(&self, repo: &Path, rev: &str, paths: &[String]) -> Result<()> {
        crate::restore_file(&self.0, repo, rev, paths).await
    }
    async fn apply_partial(&self, repo: &Path, diff: &str, hunk: usize, lines: Option<&[usize]>, target: PatchTarget) -> Result<()> {
        crate::apply_partial(&self.0, repo, diff, hunk, lines, target).await
    }
    async fn commit(&self, repo: &Path, message: &str, amend: bool) -> Result<()> {
        crate::commit(&self.0, repo, message, amend).await
    }
    async fn rebase_interactive(&self, repo: &Path, base: &str, steps: &[RebaseStep]) -> Result<()> {
        crate::rebase_interactive(&self.0, repo, base, steps).await
    }
    async fn fix_crlf(&self, repo: &Path, paths: &[String]) -> Result<()> {
        crate::fix_crlf(&self.0, repo, paths).await
    }
}

#[cfg(all(test, feature = "cli"))]
mod tests {
    use super::*;
    use crate::GitRunner;

    /// CliBackend는 기존 함수와 같은 결과를 낸다. 기본 구현은 Unsupported.
    #[tokio::test]
    async fn cli_backend는_기존_함수와_같은_결과() {
        let dir = tempfile::tempdir().unwrap();
        let git = GitRunner::default();
        for a in [&["init", "-q"][..], &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "첫 커밋"]] {
            git.output(dir.path(), a).await.unwrap();
        }
        let b = CliBackend::new(git.clone());
        assert!(b.supports(&Op("push")));
        let (via, direct) = (b.read_log(dir.path(), 10, &[]).await.unwrap(), crate::read_log(&git, dir.path(), 10, &[]).await.unwrap());
        assert_eq!(via.len(), 1);
        assert_eq!(via[0].id, direct[0].id);
        assert_eq!(b.head_commit(dir.path()).await, crate::head_commit(&git, dir.path()).await);
        assert_eq!(b.run(dir.path(), &["log", "-1", "--format=%s"], &[]).await.unwrap(), b"\xec\xb2\xab \xec\xbb\xa4\xeb\xb0\x8b\n");

        struct Empty;
        impl GitBackend for Empty {}
        assert!(!Empty.supports(&Op("push")));
        assert_eq!(b.capabilities(), Capabilities { all: true, ops: vec![] });
        assert_eq!(Empty.capabilities(), Capabilities { all: false, ops: vec![] });
        struct Some_;
        impl GitBackend for Some_ {
            fn capabilities(&self) -> Capabilities {
                Capabilities { all: false, ops: vec!["read_log".into()] }
            }
        }
        assert!(Some_.supports(&Op("read_log")) && !Some_.supports(&Op("push")));
        assert!(matches!(Empty.read_log(dir.path(), 1, &[]).await, Err(Error::Unsupported(_))));
    }
}
