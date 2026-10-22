use crate::{origin, Account, Provider};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteRepo {
    pub host: String,
    /// GitLab 하위 그룹은 `group/sub`처럼 슬래시 포함
    pub owner: String,
    pub name: String,
}

impl RemoteRepo {
    pub fn path(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }
    pub fn web_url(&self) -> String {
        format!("{}/{}", origin(&self.host), self.path())
    }
}

/// https / ssh:// / scp형(`git@host:owner/name`) 원격 URL 해석. 로컬 경로는 None.
pub fn parse_remote(url: &str) -> Option<RemoteRepo> {
    let url = url.trim();
    let (host, path) = if let Some((_, rest)) = url.split_once("://") {
        let (auth_host, path) = rest.split_once('/')?;
        let host = auth_host.rsplit('@').next()?;
        let is_ssh = url.starts_with("ssh") || url.starts_with("git+ssh");
        // ssh 포트는 API 호스트가 아니다. http(s) 포트는 유지.
        let host = if is_ssh { host.split(':').next()? } else { host };
        (host, path)
    } else {
        let (auth_host, path) = url.split_once(':')?;
        if auth_host.contains('/') || auth_host.len() == 1 {
            return None; // 로컬 경로, 윈도 드라이브
        }
        (auth_host.rsplit('@').next()?, path)
    };
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, name) = path.rsplit_once('/')?;
    if host.is_empty() || owner.is_empty() || name.is_empty() {
        return None;
    }
    Some(RemoteRepo { host: host.to_lowercase(), owner: owner.into(), name: name.into() })
}

/// 잘 알려진 호스트 → provider, 아니면 등록된 계정의 host로 매칭.
pub fn detect_provider(host: &str, accounts: &[Account]) -> Option<Provider> {
    match host {
        "github.com" => Some(Provider::GitHub),
        "gitlab.com" => Some(Provider::GitLab),
        "bitbucket.org" => Some(Provider::Bitbucket),
        _ => accounts.iter().find(|a| a.on_host(host)).map(|a| a.provider),
    }
}

fn enc_branch(b: &str) -> String {
    urlencoding::encode(b).replace("%2F", "/")
}

/// 브라우저로 PR(MR)을 만드는 페이지. 토큰이 없을 때의 대안.
pub fn pr_web_url(p: Provider, repo: &RemoteRepo, head: &str, base: &str) -> String {
    let o = origin(&repo.host);
    let path = repo.path();
    match p {
        Provider::GitHub => format!("{o}/{path}/compare/{}...{}?expand=1", enc_branch(base), enc_branch(head)),
        Provider::GitLab => format!(
            "{o}/{path}/-/merge_requests/new?merge_request[source_branch]={}&merge_request[target_branch]={}",
            urlencoding::encode(head),
            urlencoding::encode(base)
        ),
        Provider::Bitbucket => format!(
            "{o}/{path}/pull-requests/new?source={}&dest={}",
            urlencoding::encode(head),
            urlencoding::encode(base)
        ),
        Provider::Gitea => format!("{o}/{path}/compare/{}...{}", enc_branch(base), enc_branch(head)),
    }
}

pub fn commit_web_url(p: Provider, repo: &RemoteRepo, sha: &str) -> String {
    let o = origin(&repo.host);
    let path = repo.path();
    match p {
        Provider::GitHub | Provider::Gitea => format!("{o}/{path}/commit/{sha}"),
        Provider::GitLab => format!("{o}/{path}/-/commit/{sha}"),
        Provider::Bitbucket => format!("{o}/{path}/commits/{sha}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(h: &str, o: &str, n: &str) -> Option<RemoteRepo> {
        Some(RemoteRepo { host: h.into(), owner: o.into(), name: n.into() })
    }

    #[test]
    fn parses_url_forms() {
        assert_eq!(parse_remote("https://github.com/a/b.git"), r("github.com", "a", "b"));
        assert_eq!(parse_remote("https://user:pw@github.com/a/b"), r("github.com", "a", "b"));
        assert_eq!(parse_remote("git@github.com:a/b.git"), r("github.com", "a", "b"));
        assert_eq!(parse_remote("ssh://git@git.corp.com:2222/a/b.git"), r("git.corp.com", "a", "b"));
        assert_eq!(parse_remote("https://gitlab.com/g/sub/b.git/"), r("gitlab.com", "g/sub", "b"));
        assert_eq!(parse_remote("https://git.corp.com:8443/a/b"), r("git.corp.com:8443", "a", "b"));
        assert_eq!(parse_remote("git@GitLab.com:g/b"), r("gitlab.com", "g", "b"));
    }

    #[test]
    fn rejects_local_paths() {
        assert_eq!(parse_remote("/home/me/repo"), None);
        assert_eq!(parse_remote("../repo.git"), None);
        assert_eq!(parse_remote("C:/repos/x"), None);
        assert_eq!(parse_remote("https://github.com/onlyone"), None);
    }

    #[test]
    fn provider_by_host_or_account() {
        let accts = vec![Account { provider: Provider::Gitea, host: "git.corp.com".into(), username: "me".into() }];
        assert_eq!(detect_provider("github.com", &[]), Some(Provider::GitHub));
        assert_eq!(detect_provider("bitbucket.org", &[]), Some(Provider::Bitbucket));
        assert_eq!(detect_provider("git.corp.com", &accts), Some(Provider::Gitea));
        assert_eq!(detect_provider("other.com", &accts), None);
    }

    #[test]
    fn web_urls() {
        let g = r("github.com", "a", "b").unwrap();
        assert_eq!(
            pr_web_url(Provider::GitHub, &g, "feat/x", "main"),
            "https://github.com/a/b/compare/main...feat/x?expand=1"
        );
        let l = r("gitlab.com", "g/s", "b").unwrap();
        assert_eq!(
            pr_web_url(Provider::GitLab, &l, "feat/x", "main"),
            "https://gitlab.com/g/s/b/-/merge_requests/new?merge_request[source_branch]=feat%2Fx&merge_request[target_branch]=main"
        );
        let b = r("bitbucket.org", "a", "b").unwrap();
        assert_eq!(
            pr_web_url(Provider::Bitbucket, &b, "x", "main"),
            "https://bitbucket.org/a/b/pull-requests/new?source=x&dest=main"
        );
        let t = r("http://127.0.0.1:3000", "a", "b").unwrap();
        assert_eq!(pr_web_url(Provider::Gitea, &t, "x", "main"), "http://127.0.0.1:3000/a/b/compare/main...x");
        assert_eq!(commit_web_url(Provider::GitLab, &l, "abc"), "https://gitlab.com/g/s/b/-/commit/abc");
        assert_eq!(commit_web_url(Provider::Bitbucket, &b, "abc"), "https://bitbucket.org/a/b/commits/abc");
        assert_eq!(commit_web_url(Provider::GitHub, &g, "abc"), "https://github.com/a/b/commit/abc");
    }
}
