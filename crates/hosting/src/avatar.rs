//! 커밋 작성자 프로필 사진 URL (GitHub). 이메일 → URL(없음=None 포함)을 프로세스 메모리에 캐시한다.
//! 네트워크 오류·403(한도)·서버 오류는 캐시하지 않고 다음 요청에서 다시 시도한다.
use crate::{api, Account, Provider, RemoteRepo};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use parking_lot::Mutex;
use tokio::sync::{OnceCell, Semaphore};
use tokio::task::JoinSet;

/// 동시에 보내는 GitHub 요청 수 (캐시 하나 = 앱 전체에서 공유)
const CONCURRENCY: usize = 4;

#[derive(Debug, Clone, Deserialize)]
pub struct AvatarQuery {
    pub sha: String,
    pub email: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AvatarResult {
    pub email: String,
    pub url: Option<String>,
    /// 가져오기에 실패해 캐시하지 않았다(한도·네트워크·푸시 전) → UI가 나중에 다시 묻는다
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub retry: bool,
}

/// 소문자 이메일 → URL. "계정 없음"(None)도 저장해 다시 요청하지 않는다. 같은 이메일의 동시 요청은 하나로 합친다.
pub struct AvatarCache {
    done: Mutex<HashMap<String, Option<String>>>,
    inflight: Mutex<HashMap<String, Arc<OnceCell<Option<String>>>>>,
    sem: Semaphore,
}

impl Default for AvatarCache {
    fn default() -> Self {
        Self { done: Mutex::default(), inflight: Mutex::default(), sem: Semaphore::new(CONCURRENCY) }
    }
}

impl AvatarCache {
    fn get(&self, email: &str) -> Option<Option<String>> {
        self.done.lock().get(email).cloned()
    }
    fn put(&self, email: String, url: Option<String>) {
        self.done.lock().insert(email, url);
    }

    /// 캐시에 없으면 `fetch`로 가져온다(전역 동시 4개, 같은 키 진행 중이면 그 결과를 기다림).
    /// `Ok`만 캐시하고 `Err`는 캐시하지 않는다.
    async fn fetch<Fut>(&self, key: &str, fetch: Fut) -> crate::Result<Option<String>>
    where
        Fut: Future<Output = crate::Result<Option<String>>>,
    {
        if let Some(v) = self.get(key) {
            return Ok(v);
        }
        let cell = self.inflight.lock().entry(key.to_owned()).or_default().clone();
        let r = cell
            .get_or_try_init(|| async {
                let _permit = self.sem.acquire().await.expect("semaphore never closed");
                fetch.await
            })
            .await
            .cloned();
        if let Ok(v) = &r {
            self.put(key.to_owned(), v.clone());
        }
        let mut inflight = self.inflight.lock();
        if inflight.get(key).is_some_and(|c| Arc::ptr_eq(c, &cell)) {
            inflight.remove(key);
        }
        r
    }
}

/// `12345+login@users.noreply.github.com` / `login@users.noreply.github.com` → 아바타 URL
fn noreply_avatar(email: &str) -> Option<String> {
    let local = email.strip_suffix("@users.noreply.github.com")?;
    let login = local.rsplit('+').next()?;
    (!login.is_empty()).then(|| format!("https://avatars.githubusercontent.com/{login}"))
}

/// `account`는 GitHub 원격에 매칭된 계정(없으면 github.com). 토큰은 있으면 사용(없으면 익명).
/// `repo`가 None이거나 GitHub가 아니면 전부 None(캐시에도 넣지 않는다).
/// GitHub가 작성자 계정을 모르면 Gravatar로 한 번 더 찾는다.
pub async fn author_avatars(
    cache: &Arc<AvatarCache>,
    repo: Option<&RemoteRepo>,
    account: Option<&Account>,
    token: Option<&str>,
    items: &[AvatarQuery],
) -> Vec<AvatarResult> {
    let Some(repo) = repo else { return none_all(items) };
    let acct = match account {
        Some(a) if a.provider == Provider::GitHub => a.clone(),
        Some(_) => return none_all(items),
        None if repo.host == "github.com" => Account { provider: Provider::GitHub, host: "github.com".into(), username: String::new() },
        None => return none_all(items),
    };
    let token = token.map(String::from);
    let (repo, acct) = (repo.clone(), Arc::new(acct));
    let token = Arc::new(token);
    resolve(cache, items, move |sha, email| {
        let (repo, acct, token) = (repo.clone(), acct.clone(), token.clone());
        async move {
            match api::github_commit_avatar(&acct, token.as_deref(), &repo, &sha).await {
                Ok(Some(url)) => Ok(Some(url)),
                // 작성자 계정 없음 → Gravatar. 없으면 "사진 없음"으로 캐시한다.
                Ok(None) => api::gravatar(&email).await,
                // 커밋이 없다(404: 아직 푸시 안 함·권한 없음) → Gravatar. 없으면 캐시하지 않아 푸시 후 다시 찾는다.
                Err(crate::Error::NotFound) => match api::gravatar(&email).await {
                    Ok(Some(url)) => Ok(Some(url)),
                    _ => Err(crate::Error::NotFound),
                },
                // 403 한도·네트워크·5xx는 캐시하지 않는다.
                Err(e) => Err(e),
            }
        }
    })
    .await
}

fn none_all(items: &[AvatarQuery]) -> Vec<AvatarResult> {
    let mut seen = std::collections::HashSet::new();
    items
        .iter()
        .filter(|q| seen.insert(q.email.to_lowercase()))
        .map(|q| AvatarResult { email: q.email.clone(), url: None, retry: false })
        .collect()
}

/// 이메일별 한 건(첫 커밋 기준). noreply는 API 없이, 나머지는 `fetch(sha, 소문자 이메일)`를 캐시 전역 동시 4개까지.
/// 가져오기에 실패한 이메일은 `url: None`으로 돌려주되 캐시하지 않는다.
async fn resolve<F, Fut>(cache: &Arc<AvatarCache>, items: &[AvatarQuery], fetch: F) -> Vec<AvatarResult>
where
    F: Fn(String, String) -> Fut,
    Fut: Future<Output = crate::Result<Option<String>>> + Send + 'static,
{
    let mut order: Vec<(String, String)> = Vec::new(); // (원본 이메일, 키)
    let mut seen = std::collections::HashSet::new();
    let mut jobs = JoinSet::new();
    for q in items {
        let key = q.email.to_lowercase();
        if !seen.insert(key.clone()) {
            continue;
        }
        order.push((q.email.clone(), key.clone()));
        if cache.get(&key).is_some() {
            continue;
        }
        if let Some(url) = noreply_avatar(&key) {
            cache.put(key, Some(url));
            continue;
        }
        let (fut, cache) = (fetch(q.sha.clone(), key.clone()), cache.clone());
        jobs.spawn(async move {
            let _ = cache.fetch(&key, fut).await;
        });
    }
    while jobs.join_next().await.is_some() {}
    order
        .into_iter()
        .map(|(email, key)| {
            let hit = cache.get(&key);
            AvatarResult { retry: hit.is_none(), url: hit.flatten(), email }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn q(sha: &str, email: &str) -> AvatarQuery {
        AvatarQuery { sha: sha.into(), email: email.into() }
    }

    #[test]
    fn noreply_파싱() {
        assert_eq!(noreply_avatar("123+octo@users.noreply.github.com").unwrap(), "https://avatars.githubusercontent.com/octo");
        assert_eq!(noreply_avatar("octo@users.noreply.github.com").unwrap(), "https://avatars.githubusercontent.com/octo");
        assert_eq!(noreply_avatar("a@example.com"), None);
        assert_eq!(noreply_avatar("@users.noreply.github.com"), None);
    }

    #[tokio::test]
    async fn noreply는_요청없이_캐시는_재요청없음() {
        let cache = Arc::new(AvatarCache::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let items = [q("a1", "1+octo@users.noreply.github.com"), q("a2", "x@e.com"), q("a3", "X@E.com"), q("a4", "y@e.com")];
        let run = |cache: Arc<AvatarCache>, calls: Arc<AtomicUsize>, items: Vec<AvatarQuery>| async move {
            resolve(&cache, &items, |sha, _| {
                let c = calls.clone();
                async move {
                    c.fetch_add(1, Ordering::SeqCst);
                    Ok((sha == "a2").then(|| "https://x/avatar".to_string()))
                }
            })
            .await
        };
        let r = run(cache.clone(), calls.clone(), items.to_vec()).await;
        assert_eq!(r.len(), 3); // 대소문자 다른 같은 이메일은 하나
        assert_eq!(r[0].url.as_deref(), Some("https://avatars.githubusercontent.com/octo"));
        assert_eq!(r[1].url.as_deref(), Some("https://x/avatar"));
        assert_eq!((r[2].url.as_deref(), r[2].retry), (None, false)); // 사진 없음(캐시됨) → 다시 묻지 않는다
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        run(cache, calls.clone(), items.to_vec()).await; // 실패(None)까지 캐시 적중
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn 오류는_캐시하지_않고_성공만_캐시한다() {
        let cache = Arc::new(AvatarCache::default());
        let items = [q("a", "x@e.com")];
        let calls = Arc::new(AtomicUsize::new(0));
        let run = |ok: bool| {
            let (cache, calls, items) = (cache.clone(), calls.clone(), items.to_vec());
            async move {
                resolve(&cache, &items, move |_, _| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    async move { if ok { Ok(Some("https://x/a".to_string())) } else { Err(crate::Error::Forbidden) } }
                })
                .await
            }
        };
        let failed = run(false).await;
        assert_eq!((failed[0].url.as_deref(), failed[0].retry), (None, true));
        assert!(cache.get("x@e.com").is_none(), "오류가 캐시됨");
        assert_eq!(run(true).await[0].url.as_deref(), Some("https://x/a")); // 재시도됨
        run(true).await; // 이제 캐시 적중
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn 동시_요청은_합치고_전역_동시성은_4개() {
        let cache = Arc::new(AvatarCache::default());
        let (calls, now, peak) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let mut tasks = Vec::new();
        // 서로 다른 호출 두 번이 같은 이메일 10개를 동시에 요청한다
        for _ in 0..2 {
            let (cache, calls, now, peak) = (cache.clone(), calls.clone(), now.clone(), peak.clone());
            tasks.push(tokio::spawn(async move {
                let items: Vec<_> = (0..10).map(|i| q(&format!("s{i}"), &format!("u{i}@e.com"))).collect();
                resolve(&cache, &items, |_, _| {
                    let (calls, now, peak) = (calls.clone(), now.clone(), peak.clone());
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        let n = now.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(n, Ordering::SeqCst);
                        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                        now.fetch_sub(1, Ordering::SeqCst);
                        Ok(Some("https://x/a".to_string()))
                    }
                })
                .await
            }));
        }
        for t in tasks {
            assert!(t.await.unwrap().iter().all(|r| r.url.is_some()));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 10, "중복 요청");
        assert!(peak.load(Ordering::SeqCst) <= 4, "동시성 {}", peak.load(Ordering::SeqCst));
        assert!(cache.inflight.lock().is_empty());
    }

    #[tokio::test]
    async fn 비github_원격은_전부_none() {
        let cache = Arc::new(AvatarCache::default());
        let items = [q("a", "1+octo@users.noreply.github.com"), q("b", "x@e.com")];
        let gl = RemoteRepo { host: "gitlab.com".into(), owner: "o".into(), name: "n".into() };
        let r = author_avatars(&cache, Some(&gl), None, None, &items).await;
        assert!(r.iter().all(|x| x.url.is_none()) && r.len() == 2);
        let r = author_avatars(&cache, None, None, None, &items).await;
        assert!(r.iter().all(|x| x.url.is_none()));
        let acct = Account { provider: Provider::GitLab, host: "gitlab.com".into(), username: "u".into() };
        let r = author_avatars(&cache, Some(&gl), Some(&acct), Some("t"), &items).await;
        assert!(r.iter().all(|x| x.url.is_none()));
        assert!(cache.get("x@e.com").is_none()); // 비GitHub는 캐시하지 않음
    }
}
