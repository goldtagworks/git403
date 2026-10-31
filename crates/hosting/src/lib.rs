//! 호스팅 서비스(GitHub·GitLab·Bitbucket·Gitea) 연동. git과 무관하다.
mod accounts;
mod api;
mod avatar;
mod graphql;
mod remote;

#[cfg(target_os = "android")]
pub use accounts::{init_secret_dir, set_secret_cipher};
pub use accounts::{Accounts, FileSecrets, Keychain, SecretCipher, SecretStore};
pub use avatar::{author_avatars, AvatarCache, AvatarQuery, AvatarResult};
pub use graphql::{pr_detail, pr_inbox, Activity, InboxPr, PrDetail, ReviewThread, ThreadComment, TimelineItem};
pub use api::{create_pr, list_prs, page_limit, pr_review_submit, verify, Pr, ReviewComment};
pub use remote::{commit_web_url, detect_provider, parse_remote, pr_web_url, RemoteRepo};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    GitHub,
    GitLab,
    Bitbucket,
    Gitea,
}

impl Provider {
    pub fn id(self) -> &'static str {
        match self {
            Provider::GitHub => "github",
            Provider::GitLab => "gitlab",
            Provider::Bitbucket => "bitbucket",
            Provider::Gitea => "gitea",
        }
    }
    pub fn default_host(self) -> Option<&'static str> {
        match self {
            Provider::GitHub => Some("github.com"),
            Provider::GitLab => Some("gitlab.com"),
            Provider::Bitbucket => Some("bitbucket.org"),
            Provider::Gitea => None,
        }
    }
}

/// 비밀 아님. 토큰은 `SecretStore`(OS 키체인)에만 둔다.
/// `host`는 `github.com`처럼 호스트만, 또는 `http://127.0.0.1:3000`처럼 스킴 포함(셀프호스트·테스트).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub provider: Provider,
    pub host: String,
    pub username: String,
}

impl Account {
    pub fn on_host(&self, host: &str) -> bool {
        bare_host(&self.host).eq_ignore_ascii_case(host)
    }
    pub fn key(&self) -> String {
        format!("{}:{}:{}", self.provider.id(), self.host, self.username)
    }
}

/// `host`에 스킴이 없으면 https를 붙인 origin.
pub(crate) fn origin(host: &str) -> String {
    if host.starts_with("http://") || host.starts_with("https://") {
        host.trim_end_matches('/').to_string()
    } else {
        format!("https://{host}")
    }
}

pub(crate) fn bare_host(host: &str) -> &str {
    host.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/')
}

#[derive(Debug)]
pub enum Error {
    Unauthorized,
    NotFound,
    Forbidden,
    Rejected(String),
    Server(u16),
    Network(String),
    Timeout,
    Unsupported,
    /// PR 받은 편지함·상세는 GitHub만
    UnsupportedProvider,
    /// 연결된 계정 토큰도 `gh auth token`도 없음
    NoToken,
    BadResponse,
    Store(String),
    File(String),
}

impl Error {
    /// 코드 있는 오류(UI가 번역). 모든 변형이 코드가 있다.
    pub fn coded(&self) -> gc_i18n::Coded {
        use gc_i18n::coded;
        match self {
            Error::Unauthorized => coded!("hosting.unauthorized", "Authentication failed. Check that the token is correct and has not expired"),
            Error::NotFound => coded!("hosting.notFound", "Repository not found or no access. Check the token scope (repo) and the repository address"),
            Error::Forbidden => coded!("hosting.forbidden", "Insufficient permission or rate limit exceeded"),
            Error::Rejected(m) => coded!("hosting.rejected", "Request rejected: {detail}", detail = m),
            Error::Server(c) => coded!("hosting.server", "Server error ({status})", status = c),
            Error::Network(m) => coded!("hosting.network", "Could not connect to the server: {detail}", detail = m),
            Error::Timeout => coded!("hosting.timeout", "No response from the server (over 10s to connect, 30s total). Check the network and server address"),
            Error::Unsupported => coded!("hosting.bitbucketServer", "Self-hosted Bitbucket (Server/Data Center) is not supported yet. Only bitbucket.org can be connected"),
            Error::UnsupportedProvider => coded!("hosting.prReviewGithubOnly", "PR review is only available for GitHub for now"),
            Error::NoToken => coded!("hosting.noToken", "No token. Connect a GitHub account in Settings, or sign in with `gh auth login`"),
            Error::BadResponse => coded!("hosting.badResponse", "Could not parse the server response"),
            Error::Store(m) => coded!("hosting.store", "Token store error: {detail}", detail = m),
            Error::File(m) => coded!("hosting.file", "Account file error: {detail}", detail = m),
        }
    }

    /// IPC `Err(String)`로 보낼 JSON
    pub fn ipc(&self) -> String {
        self.coded().json()
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.coded().message)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;
