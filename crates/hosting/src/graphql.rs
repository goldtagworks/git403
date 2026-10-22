//! GitHub GraphQL v4: PR 받은 편지함(`pr_inbox`)과 PR 상세(`pr_detail`). GitHub 외에는 `Error::UnsupportedProvider`.
use crate::api::{client, net_err, s};
use crate::{origin, Account, Error, Provider, RemoteRepo, Result};
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxPr {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub head: String,
    pub base: String,
    pub author: String,
    pub author_avatar: String,
    pub draft: bool,
    pub created_at: String,
    pub updated_at: String,
    pub additions: u64,
    pub deletions: u64,
    pub labels: Vec<String>,
    /// 리뷰 요청된 사람(팀은 팀 이름)
    pub reviewers: Vec<String>,
    pub approvals: u64,
    /// none | approved | commented | changes_requested
    pub my_review: String,
    /// 내가 리뷰한 뒤 head 커밋이 바뀜
    pub re_requested: bool,
    pub head_sha: String,
    pub is_mine: bool,
    pub review_requested: bool,
    /// OPEN | CLOSED | MERGED
    pub state: String,
    pub closed_at: Option<String>,
    pub merged_at: Option<String>,
    /// 최근 활동 최대 8개, 최신순(연속된 같은 사람의 커밋은 `pushed` 하나로 합침)
    pub activity: Vec<Activity>,
    /// 합치기 전 활동 전체 개수(`timelineItems.totalCount`)
    pub activity_total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Activity {
    /// approved | changes_requested | commented | review_requested | pushed | merged | closed | reopened
    pub kind: String,
    pub actor: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineItem {
    /// commit | review | comment
    pub kind: String,
    pub author: String,
    /// 작성자 사진 URL(없으면 빈 문자열)
    pub avatar: String,
    pub at: String,
    pub sha: Option<String>,
    pub state: Option<String>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThreadComment {
    pub author: String,
    pub avatar: String,
    pub body: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReviewThread {
    pub path: String,
    pub line: Option<u64>,
    pub resolved: bool,
    pub comments: Vec<ThreadComment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDetail {
    pub body: String,
    /// MERGEABLE | CONFLICTING | UNKNOWN
    pub mergeable: String,
    /// SUCCESS | FAILURE | PENDING | null
    pub ci: Option<String>,
    pub approvals: u64,
    pub required_approvals: Option<u64>,
    pub unresolved_threads: u64,
    pub files: u64,
    pub additions: u64,
    pub deletions: u64,
    pub base_sha: String,
    pub head_sha: String,
    pub timeline: Vec<TimelineItem>,
    pub review_threads: Vec<ReviewThread>,
}

fn endpoint(a: &Account) -> Result<String> {
    if a.provider != Provider::GitHub {
        return Err(Error::UnsupportedProvider);
    }
    Ok(if a.host == "github.com" { "https://api.github.com/graphql".into() } else { format!("{}/api/graphql", origin(&a.host)) })
}

async fn query(a: &Account, token: &str, q: &str, vars: Value) -> Result<Value> {
    let b = client().post(endpoint(a)?).header("User-Agent", "git403").bearer_auth(token).json(&json!({"query": q, "variables": vars}));
    let res = b.send().await.map_err(net_err)?;
    let status = res.status().as_u16();
    // 본문이 JSON이 아니면(프록시 HTML 등) Null, 읽다 시간 초과면 Timeout
    let v: Value = match res.json().await {
        Ok(v) => v,
        Err(e) if e.is_timeout() => return Err(Error::Timeout),
        Err(_) => Value::Null,
    };
    match status {
        200..=299 => {}
        401 => return Err(Error::Unauthorized),
        403 | 429 => return Err(Error::Forbidden),
        404 => return Err(Error::NotFound),
        c if c < 500 => return Err(Error::Rejected(v["message"].as_str().map_or_else(|| format!("HTTP {c}"), String::from))),
        c => return Err(Error::Server(c)),
    }
    // 200이어도 errors가 있고 data(또는 부분 응답의 repository)가 비면 실패(저장소 없음·권한 없음 등)
    if v["data"].is_null() || (v["errors"].is_array() && v["data"]["repository"].is_null()) {
        let m = v["errors"][0]["message"].as_str().unwrap_or_default();
        return Err(if m.contains("Could not resolve") { Error::NotFound } else { Error::Rejected(m.to_string()) });
    }
    Ok(v["data"].clone())
}

fn nodes<'a>(v: &'a Value) -> impl Iterator<Item = &'a Value> {
    v["nodes"].as_array().into_iter().flatten().filter(|n| n.is_object()) // 삭제·권한 없는 항목은 null로 온다
}

fn login(v: &Value) -> String {
    let l = s(&v["login"]);
    if l.is_empty() { "ghost".into() } else { l }
}

// 활동은 last:20으로 받아 합친 뒤 8개로 자른다. 노드 ≈ 100×(10+20+50+20)=1만(한도 50만), 연결 요청 ≈ 100×5 → rate limit 약 5점.
const INBOX: &str = "query($owner:String!,$name:String!,$first:Int!,$states:[PullRequestState!],$activity:Boolean!){viewer{login} repository(owner:$owner,name:$name){pullRequests(states:$states,first:$first,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url headRefName baseRefName isDraft state closedAt mergedAt createdAt updatedAt additions deletions headRefOid author{login avatarUrl} labels(first:10){nodes{name}} reviewRequests(first:20){nodes{requestedReviewer{__typename ... on User{login} ... on Team{name}}}} latestReviews(first:50){nodes{state author{login} commit{oid}}} timelineItems(last:20,itemTypes:[PULL_REQUEST_REVIEW,ISSUE_COMMENT,REVIEW_REQUESTED_EVENT,PULL_REQUEST_COMMIT,HEAD_REF_FORCE_PUSHED_EVENT,MERGED_EVENT,CLOSED_EVENT,REOPENED_EVENT]) @include(if:$activity){totalCount nodes{__typename ... on PullRequestReview{author{login} submittedAt state} ... on IssueComment{author{login} createdAt} ... on ReviewRequestedEvent{actor{login} createdAt} ... on PullRequestCommit{commit{committedDate author{user{login} name}}} ... on HeadRefForcePushedEvent{actor{login} createdAt} ... on MergedEvent{actor{login} createdAt} ... on ClosedEvent{actor{login} createdAt} ... on ReopenedEvent{actor{login} createdAt}}}}}}}";

/// PR 목록(최근 갱신순) + 내 리뷰 상태 + 최근 활동. `closed`가 거짓이면 열린 PR 최대 100개, 참이면 CLOSED·MERGED 50개.
/// `me`가 없으면 GraphQL `viewer.login`. `activity`가 거짓이면 타임라인을 받지 않는다(응답이 훨씬 빠르다, activity는 빈 값).
pub async fn pr_inbox(a: &Account, token: &str, repo: &RemoteRepo, me: Option<&str>, closed: bool, activity: bool) -> Result<Vec<InboxPr>> {
    let (states, first) = if closed { (json!(["CLOSED", "MERGED"]), 50) } else { (json!(["OPEN"]), 100) };
    let d = query(a, token, INBOX, json!({"owner": repo.owner, "name": repo.name, "first": first, "states": states, "activity": activity})).await?;
    parse_inbox(&d, me)
}

/// 타임라인(오래된 순)을 활동 목록(최신순, 최대 8)으로. 연속된 같은 사람의 커밋·강제 푸시는 `pushed` 하나로 합친다.
fn parse_activity(tl: &Value) -> Vec<Activity> {
    let mut v: Vec<Activity> = Vec::new();
    for n in nodes(tl) {
        let who = |x: &Value| login(x);
        let (kind, actor, at) = match n["__typename"].as_str().unwrap_or_default() {
            "PullRequestReview" => {
                let k = match n["state"].as_str() {
                    Some("APPROVED") => "approved",
                    Some("CHANGES_REQUESTED") => "changes_requested",
                    Some("COMMENTED") => "commented",
                    _ => continue, // 임시 저장·기각된 리뷰
                };
                (k, who(&n["author"]), s(&n["submittedAt"]))
            }
            "IssueComment" => ("commented", who(&n["author"]), s(&n["createdAt"])),
            "ReviewRequestedEvent" => ("review_requested", who(&n["actor"]), s(&n["createdAt"])),
            "PullRequestCommit" => {
                let c = &n["commit"];
                let a = c["author"]["user"]["login"].as_str().or(c["author"]["name"].as_str()).unwrap_or("ghost").to_string();
                ("pushed", a, s(&c["committedDate"]))
            }
            "HeadRefForcePushedEvent" => ("pushed", who(&n["actor"]), s(&n["createdAt"])),
            "MergedEvent" => ("merged", who(&n["actor"]), s(&n["createdAt"])),
            "ClosedEvent" => ("closed", who(&n["actor"]), s(&n["createdAt"])),
            "ReopenedEvent" => ("reopened", who(&n["actor"]), s(&n["createdAt"])),
            _ => continue,
        };
        if at.is_empty() {
            continue;
        }
        match v.last_mut() {
            Some(l) if kind == "pushed" && l.kind == "pushed" && l.actor == actor => l.at = at,
            _ => v.push(Activity { kind: kind.into(), actor, at }),
        }
    }
    v.reverse();
    v.truncate(8);
    v
}

fn parse_inbox(d: &Value, me: Option<&str>) -> Result<Vec<InboxPr>> {
    let me = me.filter(|m| !m.is_empty()).map(String::from).unwrap_or_else(|| s(&d["viewer"]["login"]));
    let list = d["repository"]["pullRequests"].get("nodes").ok_or(Error::BadResponse)?;
    Ok(list
        .as_array()
        .ok_or(Error::BadResponse)?
        .iter()
        .filter(|p| p.is_object())
        .map(|p| {
            let head_sha = s(&p["headRefOid"]);
            let reviews: Vec<&Value> = nodes(&p["latestReviews"]).collect();
            let mine = reviews.iter().find(|r| !me.is_empty() && s(&r["author"]["login"]) == me);
            let my_review = match mine.map(|r| s(&r["state"])).as_deref() {
                Some("APPROVED") => "approved",
                Some("COMMENTED") => "commented",
                Some("CHANGES_REQUESTED") => "changes_requested",
                _ => "none",
            };
            let reviewers: Vec<String> = nodes(&p["reviewRequests"])
                .map(|r| {
                    let t = &r["requestedReviewer"];
                    if t["login"].is_string() { s(&t["login"]) } else { s(&t["name"]) }
                })
                .filter(|n| !n.is_empty())
                .collect();
            let author = login(&p["author"]);
            InboxPr {
                number: p["number"].as_u64().unwrap_or(0),
                title: s(&p["title"]),
                url: s(&p["url"]),
                head: s(&p["headRefName"]),
                base: s(&p["baseRefName"]),
                author_avatar: s(&p["author"]["avatarUrl"]),
                draft: p["isDraft"].as_bool().unwrap_or(false),
                created_at: s(&p["createdAt"]),
                updated_at: s(&p["updatedAt"]),
                additions: p["additions"].as_u64().unwrap_or(0),
                deletions: p["deletions"].as_u64().unwrap_or(0),
                labels: nodes(&p["labels"]).map(|l| s(&l["name"])).collect(),
                approvals: reviews.iter().filter(|r| r["state"] == "APPROVED").count() as u64,
                my_review: my_review.into(),
                re_requested: mine.is_some_and(|r| {
                    let oid = s(&r["commit"]["oid"]);
                    !oid.is_empty() && oid != head_sha
                }),
                state: p["state"].as_str().unwrap_or("OPEN").into(),
                closed_at: p["closedAt"].as_str().map(String::from),
                merged_at: p["mergedAt"].as_str().map(String::from),
                activity: parse_activity(&p["timelineItems"]),
                activity_total: p["timelineItems"]["totalCount"].as_u64().unwrap_or(0),
                is_mine: !me.is_empty() && author == me,
                review_requested: !me.is_empty() && reviewers.contains(&me),
                reviewers,
                author,
                head_sha,
            }
        })
        .collect())
}

const DETAIL: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){body mergeable changedFiles additions deletions baseRefOid headRefOid baseRef{branchProtectionRule{requiredApprovingReviewCount}} commits(last:1){nodes{commit{statusCheckRollup{state}}}} latestReviews(first:50){nodes{state}} reviewThreads(first:100){nodes{isResolved path line comments(first:50){nodes{author{login avatarUrl} body createdAt}}}} timelineItems(first:100,itemTypes:[PULL_REQUEST_COMMIT,PULL_REQUEST_REVIEW,ISSUE_COMMENT]){nodes{__typename ... on PullRequestCommit{commit{oid committedDate messageHeadline author{user{login avatarUrl} name}}} ... on PullRequestReview{author{login avatarUrl} submittedAt state body} ... on IssueComment{author{login avatarUrl} createdAt body}}}}}}";

/// PR 한 건의 개요·CI·타임라인·리뷰 스레드.
pub async fn pr_detail(a: &Account, token: &str, repo: &RemoteRepo, number: u64) -> Result<PrDetail> {
    let d = query(a, token, DETAIL, json!({"owner": repo.owner, "name": repo.name, "number": number})).await?;
    parse_detail(&d)
}

fn parse_detail(d: &Value) -> Result<PrDetail> {
    let p = &d["repository"]["pullRequest"];
    if !p.is_object() {
        return Err(Error::NotFound);
    }
    let ci = p["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"].as_str().map(|st| {
        match st {
            "SUCCESS" => "SUCCESS",
            "FAILURE" | "ERROR" => "FAILURE",
            _ => "PENDING",
        }
        .to_string()
    });
    let review_threads: Vec<ReviewThread> = nodes(&p["reviewThreads"])
        .map(|t| ReviewThread {
            path: s(&t["path"]),
            line: t["line"].as_u64(),
            resolved: t["isResolved"].as_bool().unwrap_or(false),
            comments: nodes(&t["comments"])
                .map(|c| ThreadComment { author: login(&c["author"]), avatar: s(&c["author"]["avatarUrl"]), body: s(&c["body"]), at: s(&c["createdAt"]) })
                .collect(),
        })
        .collect();
    let mut timeline: Vec<TimelineItem> = nodes(&p["timelineItems"])
        .filter_map(|n| {
            let item = |kind: &str, author: String, avatar: &Value, at: &Value, sha, state, body: &Value| TimelineItem {
                kind: kind.into(),
                author,
                avatar: s(avatar),
                at: s(at),
                sha,
                state,
                body: Some(s(body)).filter(|b| !b.is_empty()),
            };
            match n["__typename"].as_str()? {
                "PullRequestCommit" => {
                    let c = &n["commit"];
                    let who = c["author"]["user"]["login"].as_str().or(c["author"]["name"].as_str()).unwrap_or("ghost").to_string();
                    Some(item("commit", who, &c["author"]["user"]["avatarUrl"], &c["committedDate"], Some(s(&c["oid"])), None, &c["messageHeadline"]))
                }
                "PullRequestReview" => Some(item("review", login(&n["author"]), &n["author"]["avatarUrl"], &n["submittedAt"], None, n["state"].as_str().map(String::from), &n["body"])),
                "IssueComment" => Some(item("comment", login(&n["author"]), &n["author"]["avatarUrl"], &n["createdAt"], None, None, &n["body"])),
                _ => None,
            }
        })
        .collect();
    // ISO 8601(UTC) 문자열은 사전순 = 시간순. 임시 저장(PENDING) 리뷰처럼 시각이 없는 항목은 맨 뒤.
    timeline.sort_by(|x, y| (x.at.is_empty(), &x.at).cmp(&(y.at.is_empty(), &y.at)));
    Ok(PrDetail {
        body: s(&p["body"]),
        mergeable: p["mergeable"].as_str().unwrap_or("UNKNOWN").into(),
        ci,
        approvals: nodes(&p["latestReviews"]).filter(|r| r["state"] == "APPROVED").count() as u64,
        required_approvals: p["baseRef"]["branchProtectionRule"]["requiredApprovingReviewCount"].as_u64(),
        unresolved_threads: review_threads.iter().filter(|t| !t.resolved).count() as u64,
        files: p["changedFiles"].as_u64().unwrap_or(0),
        additions: p["additions"].as_u64().unwrap_or(0),
        deletions: p["deletions"].as_u64().unwrap_or(0),
        base_sha: s(&p["baseRefOid"]),
        head_sha: s(&p["headRefOid"]),
        timeline,
        review_threads,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::tests::mock;

    fn acct(host: &str) -> Account {
        Account { provider: Provider::GitHub, host: host.into(), username: "me".into() }
    }
    fn repo() -> RemoteRepo {
        RemoteRepo { host: "x".into(), owner: "o".into(), name: "r".into() }
    }

    const INBOX_JSON: &str = r#"{"data":{"viewer":{"login":"viewer1"},"repository":{"pullRequests":{"nodes":[
      {"number":1,"title":"A","url":"u1","headRefName":"a","baseRefName":"main","isDraft":true,"createdAt":"c","updatedAt":"u","additions":3,"deletions":1,"headRefOid":"new",
       "author":{"login":"bob","avatarUrl":"av"},"labels":{"nodes":[{"name":"bug"}]},
       "reviewRequests":{"nodes":[{"requestedReviewer":{"login":"me"}},{"requestedReviewer":{"name":"team-x"}}]},
       "latestReviews":{"nodes":[{"state":"APPROVED","author":{"login":"me"},"commit":{"oid":"old"}},{"state":"APPROVED","author":{"login":"z"},"commit":{"oid":"new"}}]}},
      {"number":2,"title":"B","url":"u2","headRefName":"b","baseRefName":"main","isDraft":false,"createdAt":"c","updatedAt":"u","additions":0,"deletions":0,"headRefOid":"h2",
       "author":null,"labels":{"nodes":[]},"reviewRequests":{"nodes":[]},
       "latestReviews":{"nodes":[{"state":"CHANGES_REQUESTED","author":{"login":"me"},"commit":{"oid":"h2"}}]}},
      {"number":3,"title":"C","url":"u3","headRefName":"c","baseRefName":"main","isDraft":false,"createdAt":"c","updatedAt":"u","additions":0,"deletions":0,"headRefOid":"h3",
       "author":{"login":"me","avatarUrl":""},"labels":{"nodes":[]},"reviewRequests":{"nodes":[]},"latestReviews":{"nodes":[]}}]}}}}"#;

    #[test]
    fn inbox_review_state_and_rerequest() {
        let d: Value = serde_json::from_str(INBOX_JSON).unwrap();
        let v = parse_inbox(&d["data"], Some("me")).unwrap();
        assert_eq!((v[0].my_review.as_str(), v[0].re_requested, v[0].review_requested, v[0].approvals), ("approved", true, true, 2));
        assert_eq!(v[0].reviewers, vec!["me", "team-x"]);
        assert_eq!((v[0].labels.clone(), v[0].author_avatar.as_str(), v[0].draft), (vec!["bug".to_string()], "av", true));
        assert_eq!((v[1].my_review.as_str(), v[1].re_requested, v[1].author.as_str()), ("changes_requested", false, "ghost"));
        assert_eq!((v[2].my_review.as_str(), v[2].is_mine, v[2].re_requested), ("none", true, false));
        // me 미지정 → viewer.login
        let v = parse_inbox(&d["data"], None).unwrap();
        assert_eq!(v[0].my_review, "none");
        assert!(!v[2].is_mine);
    }

    #[tokio::test]
    async fn inbox_posts_graphql_and_rejects_other_providers() {
        let (host, h) = mock(200, INBOX_JSON).await;
        let v = pr_inbox(&acct(&host), "tok", &repo(), Some("me"), false, false).await.unwrap();
        assert_eq!(v.len(), 3);
        let raw = h.await.unwrap();
        assert!(raw.starts_with("POST /api/graphql "));
        assert!(raw.to_lowercase().contains("authorization: bearer tok"));
        assert!(raw.contains("\"owner\":\"o\""));
        let gl = Account { provider: Provider::GitLab, ..acct("gitlab.com") };
        assert!(matches!(pr_inbox(&gl, "t", &repo(), None, false, false).await, Err(Error::UnsupportedProvider)));
        assert_eq!(endpoint(&acct("github.com")).unwrap(), "https://api.github.com/graphql");
        let (host, _h) = mock(200, r#"{"data":null,"errors":[{"message":"Could not resolve to a Repository"}]}"#).await;
        assert!(matches!(pr_inbox(&acct(&host), "t", &repo(), None, false, false).await, Err(Error::NotFound)));
        // 부분 응답: viewer는 오고 repository만 null이어도 GitHub 메시지를 살린다
        let (host, _h) = mock(200, r#"{"data":{"viewer":{"login":"me"},"repository":null},"errors":[{"message":"Resource not accessible"}]}"#).await;
        assert!(matches!(pr_inbox(&acct(&host), "t", &repo(), None, false, false).await, Err(Error::Rejected(m)) if m == "Resource not accessible"));
        // null 노드(삭제·권한 없음)는 목록에서 빠진다
        let d: Value = serde_json::from_str(r#"{"viewer":{"login":"me"},"repository":{"pullRequests":{"nodes":[null,{"number":3,"title":"t"}]}}}"#).unwrap();
        assert_eq!(parse_inbox(&d, None).unwrap().iter().map(|p| p.number).collect::<Vec<_>>(), [3]);
    }

    const CLOSED_JSON: &str = r#"{"data":{"viewer":{"login":"v"},"repository":{"pullRequests":{"nodes":[
      {"number":7,"title":"M","state":"MERGED","closedAt":"2026-02-02T00:00:00Z","mergedAt":"2026-02-02T00:00:00Z","headRefOid":"h",
       "timelineItems":{"totalCount":12,"nodes":[
        {"__typename":"PullRequestCommit","commit":{"committedDate":"2026-02-01T01:00:00Z","author":{"user":{"login":"bob"},"name":"B"}}},
        {"__typename":"PullRequestCommit","commit":{"committedDate":"2026-02-01T02:00:00Z","author":{"user":null,"name":"bob"}}},
        {"__typename":"HeadRefForcePushedEvent","actor":{"login":"bob"},"createdAt":"2026-02-01T03:00:00Z"},
        {"__typename":"ReviewRequestedEvent","actor":{"login":"bob"},"createdAt":"2026-02-01T04:00:00Z"},
        {"__typename":"PullRequestCommit","commit":{"committedDate":"2026-02-01T05:00:00Z","author":{"user":{"login":"bob"}}}},
        {"__typename":"PullRequestReview","author":{"login":"r"},"submittedAt":"2026-02-01T06:00:00Z","state":"PENDING"},
        {"__typename":"PullRequestReview","author":{"login":"r"},"submittedAt":"2026-02-01T07:00:00Z","state":"CHANGES_REQUESTED"},
        {"__typename":"IssueComment","author":null,"createdAt":"2026-02-01T08:00:00Z"},
        {"__typename":"PullRequestReview","author":{"login":"r"},"submittedAt":"2026-02-01T09:00:00Z","state":"APPROVED"},
        {"__typename":"MergedEvent","actor":{"login":"bob"},"createdAt":"2026-02-02T00:00:00Z"}]}},
      {"number":8,"title":"X","state":"CLOSED","closedAt":"c","mergedAt":null,"timelineItems":{"totalCount":0,"nodes":[]}}]}}}}"#;

    #[test]
    fn inbox_closed_state_and_activity_merge() {
        let d: Value = serde_json::from_str(CLOSED_JSON).unwrap();
        let v = parse_inbox(&d["data"], None).unwrap();
        assert_eq!((v[0].state.as_str(), v[0].merged_at.as_deref(), v[0].activity_total), ("MERGED", Some("2026-02-02T00:00:00Z"), 12));
        let a: Vec<_> = v[0].activity.iter().map(|x| (x.kind.as_str(), x.actor.as_str(), x.at.as_str())).collect();
        // 최신순, PENDING 제외, 앞의 커밋+강제 푸시는 pushed 하나(마지막 시각), 사이에 낀 요청 뒤의 커밋은 별개
        assert_eq!(a.len(), 7);
        assert_eq!(a[0], ("merged", "bob", "2026-02-02T00:00:00Z"));
        assert_eq!(a[1].0, "approved");
        assert_eq!((a[2].0, a[2].1), ("commented", "ghost"));
        assert_eq!(a[3].0, "changes_requested");
        assert_eq!(a[4], ("pushed", "bob", "2026-02-01T05:00:00Z"));
        assert_eq!(a[5].0, "review_requested");
        assert_eq!(a[6], ("pushed", "bob", "2026-02-01T03:00:00Z"));
        assert_eq!((v[1].state.as_str(), v[1].closed_at.as_deref(), v[1].merged_at.clone()), ("CLOSED", Some("c"), None));
        // 필드가 없는 기존 응답은 OPEN·활동 없음
        let d: Value = serde_json::from_str(INBOX_JSON).unwrap();
        let v = parse_inbox(&d["data"], None).unwrap();
        assert_eq!((v[0].state.as_str(), v[0].activity.len(), v[0].activity_total), ("OPEN", 0, 0));
    }

    #[tokio::test]
    async fn inbox_closed_sends_states_and_limit() {
        let (host, h) = mock(200, CLOSED_JSON).await;
        assert_eq!(pr_inbox(&acct(&host), "t", &repo(), None, true, true).await.unwrap().len(), 2);
        let raw = h.await.unwrap();
        assert!(raw.contains("\"states\":[\"CLOSED\",\"MERGED\"]") && raw.contains("\"first\":50"));
        let (host, h) = mock(200, INBOX_JSON).await;
        pr_inbox(&acct(&host), "t", &repo(), None, false, false).await.unwrap();
        let raw = h.await.unwrap();
        assert!(raw.contains("\"states\":[\"OPEN\"]") && raw.contains("\"first\":100") && raw.contains("\"activity\":false"));
    }

    const DETAIL_JSON: &str = r#"{"data":{"repository":{"pullRequest":{"body":"본문","mergeable":"CONFLICTING","changedFiles":4,"additions":10,"deletions":2,
      "baseRefOid":"b0","headRefOid":"h0","baseRef":{"branchProtectionRule":{"requiredApprovingReviewCount":2}},
      "commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"ERROR"}}}]},
      "latestReviews":{"nodes":[{"state":"APPROVED"},{"state":"COMMENTED"}]},
      "reviewThreads":{"nodes":[
        {"isResolved":false,"path":"a.rs","line":7,"comments":{"nodes":[{"author":{"login":"x"},"body":"hm","createdAt":"2026-01-02T00:00:00Z"}]}},
        {"isResolved":true,"path":"b.rs","line":null,"comments":{"nodes":[]}},
        {"isResolved":false,"path":"c.rs","line":1,"comments":{"nodes":[]}}]},
      "timelineItems":{"nodes":[
        {"__typename":"IssueComment","author":{"login":"c1","avatarUrl":"av1"},"createdAt":"2026-01-03T00:00:00Z","body":"hi"},
        {"__typename":"PullRequestCommit","commit":{"oid":"abc","committedDate":"2026-01-01T00:00:00Z","messageHeadline":"feat","author":{"user":null,"name":"Gitless"}}},
        {"__typename":"PullRequestReview","author":{"login":"r1"},"submittedAt":"2026-01-02T00:00:00Z","state":"APPROVED","body":""},
        {"__typename":"Other"}]}}}}}"#;

    #[tokio::test]
    async fn detail_parses_threads_ci_and_sorts_timeline() {
        let (host, h) = mock(200, DETAIL_JSON).await;
        let d = pr_detail(&acct(&host), "tok", &repo(), 9).await.unwrap();
        assert!(h.await.unwrap().contains("\"number\":9"));
        assert_eq!((d.mergeable.as_str(), d.ci.as_deref(), d.approvals, d.required_approvals), ("CONFLICTING", Some("FAILURE"), 1, Some(2)));
        assert_eq!((d.unresolved_threads, d.files, d.base_sha.as_str(), d.head_sha.as_str()), (2, 4, "b0", "h0"));
        assert_eq!(d.review_threads[0].line, Some(7));
        assert_eq!(d.review_threads[1].line, None);
        assert!(d.timeline.iter().any(|t| t.author == "c1" && t.avatar == "av1"));
        let kinds: Vec<_> = d.timeline.iter().map(|t| (t.kind.as_str(), t.author.as_str())).collect();
        assert_eq!(kinds, vec![("commit", "Gitless"), ("review", "r1"), ("comment", "c1")]);
        assert_eq!(d.timeline[0].sha.as_deref(), Some("abc"));
        assert_eq!(d.timeline[1].state.as_deref(), Some("APPROVED"));
        assert_eq!(d.timeline[1].body, None);
    }

    #[test]
    fn detail_without_ci_or_protection_is_null() {
        let d: Value = serde_json::from_str(r#"{"repository":{"pullRequest":{"mergeable":"UNKNOWN","baseRef":null,"commits":{"nodes":[{"commit":{"statusCheckRollup":null}}]}}}}"#).unwrap();
        let d = parse_detail(&d).unwrap();
        assert_eq!((d.ci, d.required_approvals), (None, None));
        assert!(matches!(parse_detail(&json!({"repository":{"pullRequest":null}})), Err(Error::NotFound)));
    }
}
