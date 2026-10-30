//! git 실행과 저장소 데이터 읽기를 담당하는 코어.
//!
//! 모든 git 작업은 별도 프로세스 + tokio 비동기로 돌아가므로
//! 호출 측(UI)은 절대 블로킹되지 않는다. 진행 상황은 이벤트 채널로 받는다.

pub mod backend;
pub mod blame;
pub mod blob;
#[cfg(feature = "cli")]
pub mod commit_graph;
pub mod conflict;
pub mod eol;
#[cfg(feature = "gix")]
pub mod gix_backend;
pub mod job;
pub mod log;
pub mod open;
pub mod patch;
pub mod patchfile;
pub mod rebase;
pub mod refs;
#[cfg(feature = "cli")]
pub mod runner;
pub mod scan;
#[cfg(feature = "cli")]
pub mod shellenv;
pub mod settings;
pub mod show;
#[cfg(feature = "cli")]
pub mod ssh;
#[cfg(feature = "cli")]
pub mod restore;
pub mod stage;
pub mod stats;
pub mod status;
pub mod submodules;
pub mod trash_files;
#[cfg(feature = "cli")]
pub mod version;
pub mod worktree;
pub mod lfs;

#[cfg(feature = "cli")]
pub use commit_graph::ensure_commit_graph;
pub use eol::root_has_eol_rule;
#[cfg(feature = "cli")]
pub use eol::{fix_crlf, staged_crlf};
pub use conflict::ConflictBlobs;
#[cfg(feature = "cli")]
pub use conflict::conflict_blobs;
pub use blame::BlameLine;
#[cfg(feature = "cli")]
pub use blame::blame;
pub use blob::{base64, BLOB_LIMIT};
#[cfg(feature = "cli")]
pub use blob::file_blob;
pub use log::Commit;
#[cfg(feature = "cli")]
pub use log::{file_log, head_commit, read_log, search_content};
pub use open::{canonical_in_repo, open_command, path_in_repo, OpenCmd};
pub use patchfile::is_mailbox_patch;
pub use rebase::RebaseStep;
#[cfg(feature = "cli")]
pub use rebase::rebase_interactive;
pub use refs::{Ref, RefKind};
#[cfg(feature = "cli")]
pub use refs::read_refs;
pub use settings::{ensure_global_ignore, home_dir, home_ignore_path, ignore_path, read_text, write_in_repo, write_text};
#[cfg(feature = "cli")]
pub use ssh::{generate_key, list_keys, SshKey};
pub use show::ChangedFile;
#[cfg(feature = "cli")]
pub use show::{changed_files, file_diff};
#[cfg(feature = "cli")]
pub use restore::restore_file;
pub use trash_files::trash_files;
pub use stage::PatchTarget;
#[cfg(feature = "cli")]
pub use stage::{apply_partial, co_authors, commit, committer, commit_message, discard, last_message, stage, unstage};
pub use stats::{AuthorStat, ExtCount, Stats, StatsRange, Summary, WeekCount};
#[cfg(feature = "cli")]
pub use stats::repo_stats;
pub use status::{Status, StatusFile};
#[cfg(feature = "cli")]
pub use status::{read_status, worktree_diff};
pub use scan::find_repos;
#[cfg(feature = "cli")]
pub use version::git_version;
pub use submodules::{Submodule, SubmoduleStatus};
#[cfg(feature = "cli")]
pub use submodules::read_submodules;
pub use worktree::Worktree;
#[cfg(feature = "cli")]
pub use worktree::read_worktrees;
pub use lfs::{Lfs, LfsFile};
#[cfg(feature = "cli")]
pub use lfs::lfs_status;
pub use job::{JobEvent, JobHandle};
#[cfg(feature = "cli")]
pub use runner::GitRunner;
pub use backend::{Capabilities, GitBackend, Op, Spawned};
#[cfg(feature = "cli")]
pub use backend::CliBackend;

#[cfg(not(any(feature = "cli", feature = "gix")))]
compile_error!("gc-core에는 feature `cli`(git 실행 파일) 또는 `gix`(순수 Rust) 중 하나가 필요하다");

/// 사용자가 준 이름·rev·URL이 `-`로 시작하면 git이 옵션으로 읽는다 (예: `--upload-pack=...`). 그런 값은 거부한다.
pub fn reject_option(arg: &str) -> Result<&str> {
    if arg.trim_start().starts_with('-') {
        return Err(gc_i18n::coded!("git.badArg", "invalid argument (must not start with '-'): {arg}", arg = arg).into());
    }
    Ok(arg)
}

#[derive(Debug)]
pub enum Error {
    Spawn(std::io::Error),
    Exit { code: Option<i32>, stderr: String },
    Cancelled,
    Parse(String),
    Coded(gc_i18n::Coded),
    /// 이 백엔드가 지원하지 않는 작업 (`GitBackend` 기본 구현)
    Unsupported(String),
}

impl Error {
    /// 코드 있는 오류(UI가 번역). git이 낸 stderr(`Exit`)는 코드 없이 원문 그대로.
    pub fn coded(&self) -> Option<gc_i18n::Coded> {
        use gc_i18n::coded;
        match self {
            Error::Spawn(e) => Some(coded!("git.spawn", "failed to run git: {error}", error = e)),
            Error::Exit { .. } => None,
            Error::Cancelled => Some(coded!("git.cancelled", "Cancelled")),
            Error::Parse(m) => Some(coded!("git.parse", "failed to parse git output: {detail}", detail = m)),
            Error::Coded(c) => Some(c.clone()),
            Error::Unsupported(op) => Some(coded!("git.unsupported", "not supported by this backend: {op}", op = op)),
        }
    }

    /// IPC `Err(String)`: 코드가 있으면 JSON, 없으면 `Display`
    pub fn ipc(&self) -> String {
        self.coded().map(|c| c.json()).unwrap_or_else(|| self.to_string())
    }
}

impl From<gc_i18n::Coded> for Error {
    fn from(c: gc_i18n::Coded) -> Self {
        Error::Coded(c)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Exit { code, stderr } => write!(f, "git exited with code {code:?}: {stderr}"),
            _ => f.write_str(&self.coded().map(|c| c.message).unwrap_or_default()),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        if let Error::Spawn(e) = self { Some(e) } else { None }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Spawn(e)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::reject_option;

    #[test]
    fn 옵션처럼_보이는_인자는_거부한다() {
        assert!(reject_option("--upload-pack=x").is_err());
        assert!(reject_option(" -x").is_err());
        assert_eq!(reject_option("main").unwrap(), "main");
    }
}
