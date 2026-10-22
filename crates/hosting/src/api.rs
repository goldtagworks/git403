use crate::{origin, Account, Error, Provider, RemoteRepo, Result};
use reqwest::{Method, RequestBuilder};
use std::sync::OnceLock;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Pr {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub head: String,
    pub base: String,
    pub author: String,
}

/// GitHub Enterprise `/api/v3`, GitLab `/api/v4`, Gitea `/api/v1`. 공식 클라우드는 전용 API 호스트.
fn api_base(a: &Account) -> String {
    let o = origin(&a.host);
    match (a.provider, a.host.as_str()) {
        (Provider::GitHub, "github.com") => "https://api.github.com".into(),
        (Provider::Bitbucket, "bitbucket.org") => "https://api.bitbucket.org/2.0".into(),
        (Provider::Bitbucket, _) => format!("{o}/2.0"),
        (Provider::GitHub, _) => format!("{o}/api/v3"),
        (Provider::GitLab, _) => format!("{o}/api/v4"),
        (Provider::Gitea, _) => format!("{o}/api/v1"),
    }
}

/// Bitbucket 토큰은 `사용자명:앱 비밀번호` 형식.
fn bitbucket_creds(token: &str) -> (&str, &str) {
    token.split_once(':').unwrap_or(("", token))
}

/// 연결 10초·전체 30초 제한, 연결 풀 재사용을 위해 한 번만 만든다.
pub(crate) fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .expect("reqwest client")
    })
}

pub(crate) fn net_err(e: reqwest::Error) -> Error {
    if e.is_timeout() { Error::Timeout } else { Error::Network(e.without_url().to_string()) }
}

/// 셀프호스트 Bitbucket(Server/Data Center)은 API가 달라 지원하지 않는다. 테스트용 루프백 주소는 허용.
fn supported(a: &Account) -> Result<()> {
    let h = crate::bare_host(&a.host);
    let loopback = h.starts_with("127.0.0.1") || h.starts_with("localhost");
    if a.provider == Provider::Bitbucket && !h.eq_ignore_ascii_case("bitbucket.org") && !loopback {
        return Err(Error::Unsupported);
    }
    Ok(())
}

fn req(a: &Account, token: &str, method: Method, path: &str) -> RequestBuilder {
    let url = format!("{}{path}", api_base(a));
    let b = client().request(method, url).header("User-Agent", "git403");
    match a.provider {
        Provider::GitHub => b.bearer_auth(token).header("Accept", "application/vnd.github+json"),
        Provider::GitLab => b.header("PRIVATE-TOKEN", token),
        Provider::Bitbucket => {
            let (u, p) = bitbucket_creds(token);
            b.basic_auth(u, Some(p))
        }
        Provider::Gitea => b.header("Authorization", format!("token {token}")),
    }
}

async fn send(b: RequestBuilder) -> Result<Value> {
    let res = b.send().await.map_err(net_err)?;
    let status = res.status();
    let body: Value = match res.json().await {
        Ok(v) => v,
        Err(e) if e.is_timeout() => return Err(Error::Timeout),
        Err(_) => Value::Null,
    };
    match status.as_u16() {
        200..=299 => Ok(body),
        401 => Err(Error::Unauthorized),
        403 => Err(Error::Forbidden),
        404 => Err(Error::NotFound),
        s if s < 500 => Err(Error::Rejected(error_message(&body))),
        s => Err(Error::Server(s)),
    }
}

fn error_message(v: &Value) -> String {
    let msg = v["message"].as_str().or_else(|| v["error"]["message"].as_str()).unwrap_or("unknown error");
    // GitHub 422는 errors[].message에 이유(예: A pull request already exists)가 있다
    // (리뷰 게시 422는 errors가 문자열 배열: "Line could not be resolved")
    let detail: Vec<&str> = v["errors"].as_array().into_iter().flatten().filter_map(|e| e["message"].as_str().or_else(|| e.as_str())).collect();
    if detail.is_empty() { msg.into() } else { format!("{msg} ({})", detail.join(", ")) }
}

pub(crate) fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

/// GitHub 커밋 작성자의 `avatar_url`. 토큰은 있으면 사용(한도 완화). 작성자가 GitHub 계정이 아니면 None.
pub(crate) async fn github_commit_avatar(a: &Account, token: Option<&str>, repo: &RemoteRepo, sha: &str) -> Result<Option<String>> {
    let url = format!("{}/repos/{}/{}/commits/{sha}", api_base(a), repo.owner, repo.name);
    let mut b = client().get(url).header("User-Agent", "git403").header("Accept", "application/vnd.github+json");
    if let Some(t) = token {
        b = b.bearer_auth(t);
    }
    let v = send(b).await?;
    Ok(v["author"]["avatar_url"].as_str().map(String::from))
}

/// Gravatar 사진 URL(이메일은 소문자). `d=404`로 등록 여부만 확인하고 본문은 받지 않는다.
pub(crate) async fn gravatar(email: &str) -> Result<Option<String>> {
    use sha2::{Digest, Sha256};
    let hash: String = Sha256::digest(email.trim().as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    let url = format!("https://www.gravatar.com/avatar/{hash}?s=64&d=404");
    let res = client().head(&url).header("User-Agent", "git403").send().await.map_err(net_err)?;
    match res.status().as_u16() {
        200..=299 => Ok(Some(url)),
        404 => Ok(None),
        s => Err(Error::Server(s)),
    }
}

/// 토큰 확인 → 사용자명
pub async fn verify(a: &Account, token: &str) -> Result<String> {
    supported(a)?;
    if a.provider == Provider::Bitbucket {
        // 사용자명은 토큰 문자열 앞부분. 인증 확인만 API로.
        send(req(a, token, Method::GET, "/user")).await?;
        return Ok(bitbucket_creds(token).0.to_string());
    }
    let v = send(req(a, token, Method::GET, "/user")).await?;
    let name = if a.provider == Provider::GitHub { &v["login"] } else { &v["username"] };
    name.as_str().map(String::from).ok_or(Error::BadResponse)
}

fn gitlab_project(repo: &RemoteRepo) -> String {
    format!("/projects/{}", urlencoding::encode(&repo.path()))
}

/// PR(MR) 생성 → 웹 URL. draft는 GitHub·Bitbucket은 필드, GitLab·Gitea는 제목 접두어.
pub async fn create_pr(
    a: &Account,
    token: &str,
    repo: &RemoteRepo,
    head: &str,
    base: &str,
    title: &str,
    body: &str,
    draft: bool,
) -> Result<String> {
    supported(a)?;
    let (o, n) = (&repo.owner, &repo.name);
    let (b, url_key) = match a.provider {
        Provider::GitHub => (
            req(a, token, Method::POST, &format!("/repos/{o}/{n}/pulls"))
                .json(&json!({"title": title, "head": head, "base": base, "body": body, "draft": draft})),
            "/html_url",
        ),
        Provider::GitLab => {
            let t = if draft { format!("Draft: {title}") } else { title.to_string() };
            (
                req(a, token, Method::POST, &format!("{}/merge_requests", gitlab_project(repo)))
                    .json(&json!({"source_branch": head, "target_branch": base, "title": t, "description": body})),
                "/web_url",
            )
        }
        Provider::Bitbucket => (
            req(a, token, Method::POST, &format!("/repositories/{o}/{n}/pullrequests")).json(&json!({
                "title": title, "description": body, "draft": draft,
                "source": {"branch": {"name": head}}, "destination": {"branch": {"name": base}}
            })),
            "/links/html/href",
        ),
        Provider::Gitea => {
            let t = if draft { format!("WIP: {title}") } else { title.to_string() };
            (
                req(a, token, Method::POST, &format!("/repos/{o}/{n}/pulls"))
                    .json(&json!({"title": t, "head": head, "base": base, "body": body})),
                "/html_url",
            )
        }
    };
    let v = send(b).await?;
    v.pointer(url_key).and_then(Value::as_str).map(String::from).ok_or(Error::BadResponse)
}

/// PR 리뷰의 줄 코멘트. `line`은 새 파일 기준 줄(`side`는 늘 RIGHT), 여러 줄이면 `start_line`..`line`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewComment {
    pub path: String,
    pub line: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u64>,
    #[serde(default = "right")]
    pub side: String,
    pub body: String,
}

fn right() -> String {
    "RIGHT".into()
}

/// PR 리뷰 한 번에 게시(GitHub만): `POST /repos/{o}/{r}/pulls/{n}/reviews` → 리뷰 웹 URL.
/// `event`는 COMMENT|APPROVE|REQUEST_CHANGES. `commit_id`는 리뷰한 시점의 head SHA(그 뒤 푸시가 있어도 줄 위치가 맞는다).
/// 줄이 diff 밖이면 GitHub 422 → `Rejected`(GitHub 메시지 포함).
pub async fn pr_review_submit(a: &Account, token: &str, repo: &RemoteRepo, number: u64, commit_id: &str, event: &str, body: &str, comments: &[ReviewComment]) -> Result<String> {
    if a.provider != Provider::GitHub {
        return Err(Error::UnsupportedProvider);
    }
    if !["COMMENT", "APPROVE", "REQUEST_CHANGES"].contains(&event) {
        return Err(Error::Rejected(format!("event: {event}")));
    }
    let comments: Vec<Value> = comments
        .iter()
        .map(|c| {
            let mut v = json!({"path": c.path, "line": c.line, "side": c.side, "body": c.body});
            if let Some(sl) = c.start_line.filter(|sl| *sl < c.line) {
                v["start_line"] = json!(sl);
                v["start_side"] = json!(c.side);
            }
            v
        })
        .collect();
    let b = req(a, token, Method::POST, &format!("/repos/{}/{}/pulls/{number}/reviews", repo.owner, repo.name))
        .json(&json!({"commit_id": commit_id, "event": event, "body": body, "comments": comments}));
    let v = send(b).await?;
    v["html_url"].as_str().map(String::from).ok_or(Error::BadResponse)
}

/// 목록 한 번에 가져오는 개수(서비스별 상한). 다음 페이지는 따라가지 않는다.
pub fn page_limit(p: Provider) -> usize {
    match p {
        Provider::GitHub | Provider::GitLab => 100,
        Provider::Gitea | Provider::Bitbucket => 50,
    }
}

/// 열린 PR(MR) 목록. 첫 페이지(`page_limit`개)만.
pub async fn list_prs(a: &Account, token: &str, repo: &RemoteRepo) -> Result<Vec<Pr>> {
    supported(a)?;
    let (o, n) = (&repo.owner, &repo.name);
    let path = match a.provider {
        Provider::GitHub => format!("/repos/{o}/{n}/pulls?state=open&per_page=100"),
        Provider::Gitea => format!("/repos/{o}/{n}/pulls?state=open&limit=50"),
        Provider::GitLab => format!("{}/merge_requests?state=opened&per_page=100", gitlab_project(repo)),
        Provider::Bitbucket => format!("/repositories/{o}/{n}/pullrequests?state=OPEN&pagelen=50"),
    };
    let v = send(req(a, token, Method::GET, &path)).await?;
    let items = if a.provider == Provider::Bitbucket { &v["values"] } else { &v };
    let list = items.as_array().ok_or(Error::BadResponse)?;
    Ok(list
        .iter()
        .map(|i| match a.provider {
            Provider::GitHub | Provider::Gitea => Pr {
                number: i["number"].as_u64().unwrap_or(0),
                title: s(&i["title"]),
                url: s(&i["html_url"]),
                head: s(&i["head"]["ref"]),
                base: s(&i["base"]["ref"]),
                author: s(&i["user"]["login"]),
            },
            Provider::GitLab => Pr {
                number: i["iid"].as_u64().unwrap_or(0),
                title: s(&i["title"]),
                url: s(&i["web_url"]),
                head: s(&i["source_branch"]),
                base: s(&i["target_branch"]),
                author: s(&i["author"]["username"]),
            },
            Provider::Bitbucket => Pr {
                number: i["id"].as_u64().unwrap_or(0),
                title: s(&i["title"]),
                url: s(&i["links"]["html"]["href"]),
                head: s(&i["source"]["branch"]["name"]),
                base: s(&i["destination"]["branch"]["name"]),
                author: s(&i["author"]["nickname"]),
            },
        })
        .collect())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// 요청 한 개를 받아 `reply`(상태, JSON)를 돌려주는 미니 서버. 받은 원문 요청을 반환한다.
    pub async fn mock(status: u16, reply: &str) -> (String, tokio::task::JoinHandle<String>) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = format!("http://{}", l.local_addr().unwrap());
        let reply = reply.to_string();
        let h = tokio::spawn(async move {
            let (mut sock, _) = l.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 4096];
            loop {
                let n = sock.read(&mut tmp).await.unwrap();
                buf.extend_from_slice(&tmp[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some(i) = text.find("\r\n\r\n") {
                    let len = text[..i]
                        .lines()
                        .find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    if buf.len() >= i + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let res = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            sock.write_all(res.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&buf).to_string()
        });
        (host, h)
    }

    fn acct(p: Provider, host: &str) -> Account {
        Account { provider: p, host: host.into(), username: "me".into() }
    }
    fn repo(owner: &str) -> RemoteRepo {
        RemoteRepo { host: "x".into(), owner: owner.into(), name: "r".into() }
    }
    fn body_of(raw: &str) -> Value {
        serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap()).unwrap()
    }
    fn lower(raw: &str) -> String {
        raw.to_lowercase()
    }

    #[test]
    fn base_urls() {
        assert_eq!(api_base(&acct(Provider::GitHub, "github.com")), "https://api.github.com");
        assert_eq!(api_base(&acct(Provider::GitHub, "ghe.corp.com")), "https://ghe.corp.com/api/v3");
        assert_eq!(api_base(&acct(Provider::GitLab, "gitlab.com")), "https://gitlab.com/api/v4");
        assert_eq!(api_base(&acct(Provider::Gitea, "git.corp.com")), "https://git.corp.com/api/v1");
        assert_eq!(api_base(&acct(Provider::Bitbucket, "bitbucket.org")), "https://api.bitbucket.org/2.0");
    }

    #[tokio::test]
    async fn github_create_and_verify() {
        let (host, h) = mock(200, r#"{"login":"octo"}"#).await;
        assert_eq!(verify(&acct(Provider::GitHub, &host), "tok").await.unwrap(), "octo");
        let raw = lower(&h.await.unwrap());
        assert!(raw.starts_with("get /api/v3/user "));
        assert!(raw.contains("authorization: bearer tok"));

        let (host, h) = mock(201, r#"{"html_url":"https://gh/pr/1"}"#).await;
        let url = create_pr(&acct(Provider::GitHub, &host), "tok", &repo("o"), "feat", "main", "T", "B", true).await.unwrap();
        assert_eq!(url, "https://gh/pr/1");
        let raw = h.await.unwrap();
        assert!(raw.starts_with("POST /api/v3/repos/o/r/pulls "));
        assert_eq!(body_of(&raw), json!({"title":"T","head":"feat","base":"main","body":"B","draft":true}));
    }

    #[tokio::test]
    async fn gitlab_encodes_project_path_and_prefixes_draft() {
        let (host, h) = mock(201, r#"{"web_url":"https://gl/mr/2"}"#).await;
        let url = create_pr(&acct(Provider::GitLab, &host), "tok", &repo("g/sub"), "feat", "main", "T", "B", true).await.unwrap();
        assert_eq!(url, "https://gl/mr/2");
        let raw = h.await.unwrap();
        assert!(raw.starts_with("POST /api/v4/projects/g%2Fsub%2Fr/merge_requests "));
        assert!(lower(&raw).contains("private-token: tok"));
        let b = body_of(&raw);
        assert_eq!(b["title"], "Draft: T");
        assert_eq!(b["source_branch"], "feat");
        assert_eq!(b["target_branch"], "main");

        let (host, h) = mock(200, r#"[{"iid":3,"title":"t","web_url":"u","source_branch":"a","target_branch":"b","author":{"username":"me"}}]"#).await;
        let prs = list_prs(&acct(Provider::GitLab, &host), "tok", &repo("g")).await.unwrap();
        assert_eq!(prs, vec![Pr { number: 3, title: "t".into(), url: "u".into(), head: "a".into(), base: "b".into(), author: "me".into() }]);
        assert!(h.await.unwrap().starts_with("GET /api/v4/projects/g%2Fr/merge_requests?state=opened&per_page=100 "));
    }

    #[tokio::test]
    async fn bitbucket_basic_auth_and_shape() {
        let (host, h) = mock(201, r#"{"links":{"html":{"href":"https://bb/pr/4"}}}"#).await;
        let url = create_pr(&acct(Provider::Bitbucket, &host), "alice:secret", &repo("w"), "feat", "main", "T", "B", false).await.unwrap();
        assert_eq!(url, "https://bb/pr/4");
        let raw = h.await.unwrap();
        assert!(raw.starts_with("POST /2.0/repositories/w/r/pullrequests "));
        // base64("alice:secret")
        assert!(lower(&raw).contains("authorization: basic ywxpy2u6c2vjcmv0"));
        let b = body_of(&raw);
        assert_eq!(b["source"]["branch"]["name"], "feat");
        assert_eq!(b["destination"]["branch"]["name"], "main");

        let (host, h) = mock(200, r#"{"values":[{"id":5,"title":"t","links":{"html":{"href":"u"}},"source":{"branch":{"name":"a"}},"destination":{"branch":{"name":"b"}},"author":{"nickname":"al"}}]}"#).await;
        let prs = list_prs(&acct(Provider::Bitbucket, &host), "alice:secret", &repo("w")).await.unwrap();
        assert_eq!(prs[0].number, 5);
        assert_eq!(prs[0].author, "al");
        assert!(h.await.unwrap().starts_with("GET /2.0/repositories/w/r/pullrequests?state=OPEN&pagelen=50 "));
    }

    #[tokio::test]
    async fn bitbucket_verify_returns_token_user() {
        let (host, _h) = mock(200, r#"{"nickname":"x"}"#).await;
        assert_eq!(verify(&acct(Provider::Bitbucket, &host), "alice:secret").await.unwrap(), "alice");
    }

    #[tokio::test]
    async fn gitea_token_header_and_wip() {
        let (host, h) = mock(201, r#"{"html_url":"https://gt/pr/6"}"#).await;
        let url = create_pr(&acct(Provider::Gitea, &host), "tok", &repo("o"), "feat", "main", "T", "B", true).await.unwrap();
        assert_eq!(url, "https://gt/pr/6");
        let raw = h.await.unwrap();
        assert!(raw.starts_with("POST /api/v1/repos/o/r/pulls "));
        assert!(lower(&raw).contains("authorization: token tok"));
        assert_eq!(body_of(&raw)["title"], "WIP: T");

        let (host, _h) = mock(200, r#"[{"number":7,"title":"t","html_url":"u","head":{"ref":"a"},"base":{"ref":"b"},"user":{"login":"me"}}]"#).await;
        let prs = list_prs(&acct(Provider::Gitea, &host), "tok", &repo("o")).await.unwrap();
        assert_eq!((prs[0].number, prs[0].head.as_str(), prs[0].author.as_str()), (7, "a", "me"));
    }

    #[tokio::test]
    async fn list_queries_use_page_limits() {
        for (p, q) in [(Provider::GitHub, "per_page=100"), (Provider::Gitea, "limit=50")] {
            let (host, h) = mock(200, "[]").await;
            list_prs(&acct(p, &host), "t", &repo("o")).await.unwrap();
            let raw = h.await.unwrap();
            assert!(raw.lines().next().unwrap().contains(&format!("?state=open&{q} ")), "{raw}");
        }
        assert_eq!((page_limit(Provider::GitLab), page_limit(Provider::Bitbucket)), (100, 50));
    }

    #[tokio::test]
    async fn self_hosted_bitbucket_is_unsupported() {
        let a = acct(Provider::Bitbucket, "bitbucket.corp.com");
        assert!(matches!(verify(&a, "u:p").await, Err(Error::Unsupported)));
        assert!(matches!(list_prs(&a, "u:p", &repo("o")).await, Err(Error::Unsupported)));
        assert!(Error::Unsupported.to_string().contains("Bitbucket"));
    }

    #[tokio::test]
    async fn timeout_maps_to_korean_error() {
        // 연결은 받지만 응답하지 않는 서버. 실제 제한(30초) 대신 짧은 제한의 클라이언트로 변환만 확인한다.
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        let _h = tokio::spawn(async move {
            let _s = l.accept().await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let c = reqwest::Client::builder().timeout(Duration::from_millis(100)).build().unwrap();
        let e = net_err(c.get(url).send().await.unwrap_err());
        assert!(matches!(e, Error::Timeout));
        assert!(e.to_string().contains("response"));
    }

    #[tokio::test]
    async fn status_codes_map_to_korean_errors() {
        let a = |h: &str| acct(Provider::GitHub, h);
        let (host, _h) = mock(401, r#"{"message":"Bad credentials"}"#).await;
        assert!(matches!(verify(&a(&host), "t").await, Err(Error::Unauthorized)));
        let (host, _h) = mock(404, "{}").await;
        assert!(matches!(list_prs(&a(&host), "t", &repo("o")).await, Err(Error::NotFound)));
        let (host, _h) = mock(422, r#"{"message":"Validation Failed","errors":[{"message":"A pull request already exists"}]}"#).await;
        let e = create_pr(&a(&host), "t", &repo("o"), "h", "b", "T", "", false).await.unwrap_err();
        assert!(e.to_string().contains("A pull request already exists"));
    }

    #[tokio::test]
    async fn review_submit_posts_body_path_and_bearer() {
        let (host, h) = mock(200, r#"{"html_url":"https://github.com/o/r/pull/7#pullrequestreview-1"}"#).await;
        let cs = [
            ReviewComment { path: "a.rs".into(), line: 5, start_line: None, side: "RIGHT".into(), body: "b1".into() },
            ReviewComment { path: "b.rs".into(), line: 9, start_line: Some(7), side: "RIGHT".into(), body: "b2".into() },
        ];
        let r = RemoteRepo { host: "x".into(), owner: "o".into(), name: "r".into() };
        let url = pr_review_submit(&acct(Provider::GitHub, &host), "tok", &r, 7, "abc123", "REQUEST_CHANGES", "총평", &cs).await.unwrap();
        assert!(url.ends_with("pullrequestreview-1"));
        let raw = h.await.unwrap();
        assert!(raw.starts_with("POST /api/v3/repos/o/r/pulls/7/reviews "), "{raw}");
        assert!(raw.to_lowercase().contains("authorization: bearer tok"));
        let b: Value = serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!((b["commit_id"].as_str(), b["event"].as_str(), b["body"].as_str()), (Some("abc123"), Some("REQUEST_CHANGES"), Some("총평")));
        assert_eq!(b["comments"][0], json!({"path":"a.rs","line":5,"side":"RIGHT","body":"b1"}));
        assert_eq!(b["comments"][1], json!({"path":"b.rs","line":9,"start_line":7,"start_side":"RIGHT","side":"RIGHT","body":"b2"}));
    }

    #[tokio::test]
    async fn review_submit_keeps_github_422_message_and_validates() {
        let (host, _h) = mock(422, r#"{"message":"Unprocessable Entity","errors":["Line could not be resolved"]}"#).await;
        let r = RemoteRepo { host: "x".into(), owner: "o".into(), name: "r".into() };
        let a = acct(Provider::GitHub, &host);
        let e = pr_review_submit(&a, "t", &r, 1, "c", "COMMENT", "", &[]).await.unwrap_err();
        assert!(matches!(&e, Error::Rejected(m) if m.contains("Line could not be resolved")), "{e}");
        assert!(matches!(pr_review_submit(&a, "t", &r, 1, "c", "MERGE", "", &[]).await, Err(Error::Rejected(_))));
        assert!(matches!(pr_review_submit(&acct(Provider::GitLab, &host), "t", &r, 1, "c", "COMMENT", "", &[]).await, Err(Error::UnsupportedProvider)));
    }
}
