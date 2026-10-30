//! git 실행과 저장소 데이터 읽기를 담당하는 코어.
//!
//! 모든 git 작업은 별도 프로세스 + tokio 비동기로 돌아가므로
//! 호출 측(UI)은 절대 블로킹되지 않는다. 진행 상황은 이벤트 채널로 받는다.

pub mod backend;
pub mod blame;
pub mod blob;
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
pub mod runner;
pub mod scan;
pub mod shellenv;
pub mod settings;
pub mod show;
pub mod ssh;
pub mod restore;
pub mod stage;
pub mod stats;
pub mod status;
pub mod submodules;
pub mod trash_files;
pub mod version;
pub mod worktree;
pub mod lfs;

pub use commit_graph::ensure_commit_graph;
pub use eol::{fix_crlf, root_has_eol_rule, staged_crlf};
pub use conflict::{conflict_blobs, ConflictBlobs};
pub use blame::{blame, BlameLine};
pub use blob::{base64, file_blob, BLOB_LIMIT};
pub use log::{file_log, head_commit, read_log, search_content, Commit};
pub use open::{canonical_in_repo, open_command, path_in_repo, OpenCmd};
pub use patchfile::is_mailbox_patch;
pub use rebase::{rebase_interactive, RebaseStep};
pub use refs::{read_refs, Ref, RefKind};
pub use settings::{ensure_global_ignore, home_dir, home_ignore_path, ignore_path, read_text, write_in_repo, write_text};
pub use ssh::{generate_key, list_keys, SshKey};
pub use show::{changed_files, file_diff, ChangedFile};
pub use restore::restore_file;
pub use trash_files::trash_files;
pub use stage::{apply_partial, co_authors, commit, committer, commit_message, discard, last_message, stage, unstage, PatchTarget};
pub use stats::{repo_stats, AuthorStat, ExtCount, Stats, StatsRange, Summary, WeekCount};
pub use status::{read_status, worktree_diff, Status, StatusFile};
pub use scan::find_repos;
pub use version::git_version;
pub use submodules::{read_submodules, Submodule, SubmoduleStatus};
pub use worktree::{read_worktrees, Worktree};
pub use lfs::{lfs_status, Lfs, LfsFile};
pub use job::{JobEvent, JobHandle};
pub use runner::{reject_option, GitRunner};
pub use backend::{Capabilities, GitBackend, Op, Spawned};
#[cfg(feature = "cli")]
pub use backend::CliBackend;

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
