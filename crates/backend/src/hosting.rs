//! 호스팅 계정(키체인 토큰)과 저장소 원격의 연결: 원격 정보, 작성자 아바타, 계정 토큰 조회.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use gc_core::GitRunner;
use gc_hosting::{Account, Accounts, AvatarCache, AvatarQuery, AvatarResult, Keychain, Provider, RemoteRepo};
use serde::Serialize;

use crate::util::{err, off, Res};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteInfo {
    remote: String,
    url: String,
    /// 호스트로 추정한 서비스. 모르면 None
    provider: Option<Provider>,
    repo: RemoteRepo,
    web_url: String,
    /// provider·host가 같은 연결된 계정
    account: Option<Account>,
}

pub(crate) struct Hosting {
    /// 계정 목록 파일 (`accounts.json`)
    path: PathBuf,
    /// 커밋 작성자 아바타 URL 캐시 (이메일 → URL, 실패 포함)
    avatars: Arc<AvatarCache>,
}

impl Hosting {
    pub fn new(config_dir: &Path) -> Self {
        Self { path: config_dir.join("accounts.json"), avatars: Default::default() }
    }

    pub fn accounts(&self) -> Accounts<Keychain> {
        Accounts { path: self.path.clone(), store: Keychain }
    }

    pub async fn token(&self, account: &Account) -> Res<String> {
        let (accts, account) = (self.accounts(), account.clone());
        off(move || {
            accts.token(&account).map_err(|e| e.ipc())?.ok_or_else(|| {
                gc_i18n::coded!("hosting.noSavedToken", "No saved token. Reconnect the account").json()
            })
        })
        .await
    }

    /// PR 조회용 토큰: 연결된 계정(키체인) → 없으면 `gh auth token --hostname <host>`(저장하지 않음).
    /// 계정이 없으면(None) 원격 host로 GitHub 계정을 대신 만든다.
    async fn pr_auth(&self, account: Option<Account>, repo: &RemoteRepo, path: Option<&str>, bound: Option<String>) -> Res<(Account, String)> {
        let acct = account.clone().unwrap_or_else(|| Account { provider: Provider::GitHub, host: repo.host.clone(), username: String::new() });
        // 저장소에 연결된 gh 계정 토큰이 있으면 그것이 먼저(사용자가 이 저장소에 쓰기로 고른 계정)
        let stored = match (&account, bound) {
            (_, Some(b)) => Some(b),
            (Some(a), None) => self.token(a).await.ok(),
            (None, None) => None,
        };
        let host = acct.host.clone();
        let token = pick_token(stored, || async { gh_token(&host, path).await }).await;
        token.map(|t| (acct, t)).ok_or_else(|| gc_hosting::Error::NoToken.ipc())
    }

    /// PR 목록(열림, `closed`면 닫힘·머지됨) + 내 리뷰 상태 + 최근 활동(GitHub GraphQL). `me` 없으면 계정 사용자명(그것도 없으면 viewer).
    pub async fn pr_inbox(&self, account: Option<Account>, repo: &RemoteRepo, me: Option<String>, closed: bool, activity: bool, path: Option<&str>, bound: Option<String>) -> Res<Vec<gc_hosting::InboxPr>> {
        let me = me.filter(|m| !m.is_empty()).or_else(|| account.as_ref().map(|a| a.username.clone()));
        let (a, token) = self.pr_auth(account, repo, path, bound).await?;
        gc_hosting::pr_inbox(&a, &token, repo, me.as_deref(), closed, activity).await.map_err(|e| e.ipc())
    }

    pub async fn pr_detail(&self, account: Option<Account>, repo: &RemoteRepo, number: u64, path: Option<&str>, bound: Option<String>) -> Res<gc_hosting::PrDetail> {
        let (a, token) = self.pr_auth(account, repo, path, bound).await?;
        gc_hosting::pr_detail(&a, &token, repo, number).await.map_err(|e| e.ipc())
    }

    /// PR 리뷰 게시(GitHub REST). 토큰 경로는 `pr_inbox`와 같다. 리뷰 웹 URL을 돌려준다.
    pub async fn pr_review_submit(
        &self,
        account: Option<Account>,
        repo: &RemoteRepo,
        number: u64,
        commit_id: &str,
        event: &str,
        body: &str,
        comments: &[gc_hosting::ReviewComment],
        path: Option<&str>,
        bound: Option<String>,
    ) -> Res<String> {
        let (a, token) = self.pr_auth(account, repo, path, bound).await?;
        gc_hosting::pr_review_submit(&a, &token, repo, number, commit_id, event, body, comments).await.map_err(|e| e.ipc())
    }

    /// 저장소의 원격 URL → 서비스·owner/name·웹 URL·매칭 계정. 해석 불가한 원격(로컬 경로 등)은 뺀다.
    pub async fn remote_info(&self, git: &GitRunner, repo: &Path) -> Res<Vec<RemoteInfo>> {
        let remotes = parsed_remotes(git, repo).await?;
        let accts = self.accounts();
        let accounts = off(move || Ok(accts.list().unwrap_or_default())).await?;
        Ok(remotes
            .into_iter()
            .map(|(remote, url, r)| {
                let provider = gc_hosting::detect_provider(&r.host, &accounts);
                let account = provider.and_then(|p| accounts.iter().find(|a| a.provider == p && a.on_host(&r.host)).cloned());
                RemoteInfo { remote, url, provider, web_url: r.web_url(), repo: r, account }
            })
            .collect())
    }

    /// 커밋 작성자 프로필 사진 URL (GitHub 원격만). origin 우선, 없으면 첫 원격. 이메일별 한 건.
    pub async fn author_avatars(&self, git: &GitRunner, repo: &Path, items: Vec<AvatarQuery>) -> Res<Vec<AvatarResult>> {
        let path = git.path_override();
        let mut remotes = parsed_remotes(git, repo).await?;
        remotes.sort_by_key(|(n, _, _)| n != "origin");
        let remote = remotes.into_iter().next().map(|(_, _, r)| r);
        let accts = self.accounts();
        let host = remote.as_ref().map(|r| r.host.clone());
        // 계정 파일·키체인 읽기는 블로킹이라 별도 스레드에서
        let h = host.clone();
        let (account, stored) = off(move || {
            let account = h.and_then(|h| accts.list().ok()?.into_iter().find(|a| a.provider == Provider::GitHub && a.on_host(&h)));
            let token = account.as_ref().and_then(|a| accts.token(a).ok().flatten());
            Ok((account, token))
        })
        .await?;
        // 저장된 토큰이 없으면 `gh` 토큰(PR 조회와 같은 규칙). 비공개 저장소도 사진을 찾는다.
        let token = match &host {
            Some(h) if account.is_some() || h == "github.com" => pick_token(stored, || async { gh_token(h, path).await }).await,
            _ => stored,
        };
        Ok(gc_hosting::author_avatars(&self.avatars, remote.as_ref(), account.as_ref(), token.as_deref(), &items).await)
    }
}

/// `remote.<name>.url` 설정 → (이름, URL, 해석 결과). 해석 불가한 원격은 뺀다.
pub(crate) async fn parsed_remotes(git: &GitRunner, repo: &Path) -> Res<Vec<(String, String, RemoteRepo)>> {
    let out = git.output_allow(repo, &["config", "--get-regexp", r"^remote\..*\.url$"], &[1]).await.map_err(err)?;
    Ok(String::from_utf8_lossy(&out)
        .lines()
        .filter_map(|l| {
            let (key, url) = l.split_once(' ')?;
            let name = key.strip_prefix("remote.")?.strip_suffix(".url")?;
            Some((name.to_string(), url.to_string(), gc_hosting::parse_remote(url)?))
        })
        .collect())
}

/// 저장된 토큰이 있으면 그것, 없으면 `gh`(주입). 빈 문자열은 없는 것으로 본다.
async fn pick_token<F: std::future::Future<Output = Option<String>>>(stored: Option<String>, gh: impl FnOnce() -> F) -> Option<String> {
    match stored.filter(|t| !t.is_empty()) {
        Some(t) => Some(t),
        None => gh().await.filter(|t| !t.is_empty()),
    }
}

/// `gh auth token --hostname <host>`. `path`는 보정된 로그인 셸 PATH. gh가 없거나 로그인 안 했으면 None.
async fn gh_token(host: &str, path: Option<&str>) -> Option<String> {
    let host = host.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/');
    let mut cmd = tokio::process::Command::new("gh");
    cmd.args(["auth", "token", "--hostname", host]);
    // 다른 계정 작업이 전역 활성 계정을 임시로 바꾸는 중이면, 복원될 원래 계정의 토큰을 명시한다
    if let Some(user) = crate::gh::switched_from(host) {
        cmd.args(["--user", &user]);
    }
    cmd.stdin(std::process::Stdio::null()).kill_on_drop(true);
    if let Some(p) = path {
        cmd.env("PATH", p);
    }
    let out = tokio::time::timeout(std::time::Duration::from_secs(5), cmd.output()).await.ok()?.ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|t| !t.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn token_prefers_stored_then_gh() {
        assert_eq!(pick_token(Some("a".into()), || async { Some("g".into()) }).await.as_deref(), Some("a"));
        assert_eq!(pick_token(None, || async { Some("g".into()) }).await.as_deref(), Some("g"));
        assert_eq!(pick_token(Some(String::new()), || async { Some("g".into()) }).await.as_deref(), Some("g"));
        assert_eq!(pick_token(None, || async { None }).await, None);
    }
}
