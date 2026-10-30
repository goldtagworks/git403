//! gh(GitHub CLI) 계정: 표시·전환, 저장소별 연결(`git403.ghAccount`), 원격 작업 동안의 임시 전환·복원, 접근 확인.
//!
//! 토큰은 `gh auth token`으로 읽어 요청에만 쓰고 반환·로그에 남기지 않는다.
//! 전역 활성 계정을 바꾸는 작업(`Gate::acquire`)은 호스트별로 직렬화한다: 같은 계정 작업은 겹쳐도 되고, 다른 계정 작업은 기다린다.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use gc_core::{GitBackend, JobEvent};
use gc_hosting::RemoteRepo;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Mutex, Notify};

use crate::hosting::parsed_remotes;
use crate::util::{err, Res};
use crate::Backend;

/// 저장소 설정 키: 이 저장소의 원격 작업에 쓸 gh 계정
const BIND_KEY: &str = "git403.ghAccount";
const TIMEOUT: Duration = Duration::from_secs(10);

/// git이 원격 인증에 gh 활성 계정 토큰을 쓰게 하는 인자(앞에 붙인다). 첫 빈 값은 기존 도우미(osxkeychain 등)를 비운다.
/// `!`로 시작하는 값은 git이 셸로 실행하고 뒤에 `get`을 붙인다. gh는 git 프로세스의 PATH(보정 PATH)에서 찾는다.
/// host 한정 키(`credential.https://<host>.helper`)라 다른 host(서브모듈·다른 원격)의 인증은 건드리지 않는다.
pub(crate) fn helper_args(host: &str) -> [String; 4] {
    let key = format!("credential.https://{host}.helper");
    ["-c".into(), format!("{key}="), "-c".into(), format!("{key}=!gh auth git-credential")]
}

// ---------- gh 실행 ----------

/// gh 실행기. `path`는 보정된 로그인 셸 PATH(`GitRunner::path_override`).
#[derive(Clone)]
pub(crate) struct Gh {
    path: Option<String>,
}

#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
pub(crate) struct GhUser {
    pub user: String,
    pub active: bool,
}

#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
pub(crate) struct GhHost {
    pub host: String,
    pub accounts: Vec<GhUser>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub(crate) struct GhAccounts {
    pub installed: bool,
    pub hosts: Vec<GhHost>,
}

impl Gh {
    pub fn new(path: Option<&str>) -> Self {
        Self { path: path.map(String::from) }
    }

    /// gh 실행. 실행 파일이 없으면 `Ok(None)`, 시간 초과·기타 실행 오류는 Err.
    async fn run(&self, args: &[&str], envs: &[(&str, &str)]) -> Res<Option<std::process::Output>> {
        let mut cmd = tokio::process::Command::new("gh");
        cmd.args(args).stdin(Stdio::null()).env("GH_PROMPT_DISABLED", "1").env("NO_COLOR", "1").kill_on_drop(true);
        cmd.envs(envs.iter().copied());
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        if let Some(p) = &self.path {
            cmd.env("PATH", p);
        }
        match tokio::time::timeout(TIMEOUT, cmd.output()).await {
            Err(_) => Err(gc_i18n::coded!("gh.timeout", "gh timed out").json()),
            Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Ok(Err(e)) => Err(e.to_string()),
            Ok(Ok(o)) => Ok(Some(o)),
        }
    }

    /// 로그인된 계정 목록. `--json hosts`가 없는 옛 gh는 텍스트 출력을 파싱한다.
    pub async fn accounts(&self, host: Option<&str>) -> Res<GhAccounts> {
        let host_args: Vec<&str> = host.map(|h| vec!["--hostname", h]).unwrap_or_default();
        let json_args = [&["auth", "status"][..], &host_args, &["--json", "hosts"]].concat();
        let Some(out) = self.run(&json_args, &[]).await? else { return Ok(GhAccounts { installed: false, hosts: vec![] }) };
        let mut hosts = out.status.success().then(|| parse_status_json(&String::from_utf8_lossy(&out.stdout))).flatten();
        if hosts.is_none() {
            // 옛 gh: 텍스트는 stdout·stderr 어느 쪽으로든 나온다(문제가 있으면 stderr + 종료 코드 1)
            let text_args = [&["auth", "status"][..], &host_args].concat();
            if let Some(o) = self.run(&text_args, &[]).await? {
                let text = format!("{}\n{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
                let parsed = parse_status_text(&text);
                // 아무 계정도 못 읽었는데 실패로 끝났으면 "로그인 없음"이 아니라 오류다(원인은 stderr 마지막 줄)
                if parsed.is_empty() && !o.status.success() && !text.contains("not logged in") {
                    return Err(gh_err(&o));
                }
                hosts = Some(parsed);
            }
        }
        let mut hosts = hosts.unwrap_or_default();
        if let Some(h) = host {
            hosts.retain(|x| x.host == h);
        }
        Ok(GhAccounts { installed: true, hosts })
    }

    /// 표시용: 못 읽으면 None
    pub async fn active_user(&self, host: &str) -> Option<String> {
        self.active_user_checked(host).await.ok().flatten()
    }

    /// 활성 계정. gh 실행 실패·시간 초과는 Err (전환 전 원래 계정을 꼭 알아야 할 때)
    pub async fn active_user_checked(&self, host: &str) -> Res<Option<String>> {
        let all = self.accounts(Some(host)).await?;
        Ok(all.hosts.into_iter().find(|h| h.host == host).and_then(|h| h.accounts.into_iter().find(|a| a.active)).map(|a| a.user))
    }

    pub async fn switch(&self, host: &str, user: &str) -> Res<()> {
        let out = self.run(&["auth", "switch", "--hostname", host, "--user", user], &[]).await?.ok_or_else(not_installed)?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }

    /// `gh auth token --hostname H --user U` (활성 계정을 바꾸지 않는다). 없거나 실패하면 None.
    pub async fn token(&self, host: &str, user: &str) -> Option<String> {
        self.token_checked(host, user).await.ok().flatten()
    }

    /// 위와 같되 gh 미설치만 None, 실행 실패·시간 초과·토큰 없음은 원인을 담은 Err
    pub async fn token_checked(&self, host: &str, user: &str) -> Res<Option<String>> {
        let Some(out) = self.run(&["auth", "token", "--hostname", host, "--user", user], &[]).await? else { return Ok(None) };
        let tok = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && !tok.is_empty() { Ok(Some(tok)) } else { Err(gh_err(&out)) }
    }

    /// 그 계정 토큰으로 `repos/{owner}/{name}`에 접근되는지(전역 전환 없이 환경 변수로 토큰 전달).
    pub async fn can_access(&self, host: &str, user: &str, repo: &RemoteRepo) -> bool {
        let Some(token) = self.token(host, user).await else { return false };
        let var = if host == "github.com" { "GH_TOKEN" } else { "GH_ENTERPRISE_TOKEN" };
        let endpoint = format!("repos/{}/{}", repo.owner, repo.name);
        let args = ["api", "--hostname", host, "--silent", endpoint.as_str()];
        matches!(self.run(&args, &[(var, token.as_str())]).await, Ok(Some(o)) if o.status.success())
    }
}

fn not_installed() -> String {
    gc_i18n::coded!("gh.notInstalled", "GitHub CLI (gh) is not installed").json()
}

// ---------- 파서 ----------

#[derive(Deserialize)]
struct StatusJson {
    hosts: BTreeMap<String, Vec<StatusAccount>>,
}

#[derive(Deserialize)]
struct StatusAccount {
    login: String,
    #[serde(default)]
    active: bool,
}

/// `gh auth status --json hosts` (토큰 필드는 타입에 없어 읽지 않는다)
pub(crate) fn parse_status_json(s: &str) -> Option<Vec<GhHost>> {
    let v: StatusJson = serde_json::from_str(s).ok()?;
    Some(v.hosts.into_iter().map(|(host, a)| GhHost { host, accounts: a.into_iter().map(|a| GhUser { user: a.login, active: a.active }).collect() }).collect())
}

/// `gh auth status` 텍스트: `✓ Logged in to H account U (keyring)` 뒤의 `- Active account: true`
pub(crate) fn parse_status_text(s: &str) -> Vec<GhHost> {
    let mut hosts: Vec<GhHost> = Vec::new();
    for line in s.lines() {
        let line = line.trim().trim_start_matches(|c: char| !c.is_alphanumeric()).trim();
        let l = line.to_ascii_lowercase();
        // 앞의 표식(✓·X·-)은 건너뛴다. 대소문자 보존을 위해 원문에서 같은 위치를 잘라 쓴다(ASCII 소문자화는 길이가 같다).
        let found = ["logged in to ", "failed to log in to "].iter().find_map(|k| l.find(k).map(|i| i + k.len()));
        if let Some(at) = found.filter(|&at| l[..at].split_whitespace().count() <= 6) {
            let rest = &line[at..];
            let mut it = rest.split_whitespace();
            let (Some(host), Some("account"), Some(user)) = (it.next(), it.next(), it.next()) else { continue };
            match hosts.iter_mut().find(|h| h.host == host) {
                Some(h) => h.accounts.push(GhUser { user: user.into(), active: false }),
                None => hosts.push(GhHost { host: host.into(), accounts: vec![GhUser { user: user.into(), active: false }] }),
            }
        } else if let Some(v) = l.strip_prefix("active account:") {
            if let Some(a) = hosts.last_mut().and_then(|h| h.accounts.last_mut()) {
                a.active = v.trim() == "true";
            }
        }
    }
    hosts.sort_by(|a, b| a.host.cmp(&b.host));
    hosts
}

// ---------- 전환 구간 직렬화 ----------

#[derive(Default)]
struct Slot {
    user: Option<String>,
    count: usize,
    /// 첫 작업이 시작될 때의 활성 계정 (복원 대상)
    original: Option<String>,
}

/// 전환 구간에 있는 host → 복원 대상(원래 활성) 계정. 전역 활성 계정이 임시로 바뀐 동안 `gh auth token`이
/// 엉뚱한 계정 토큰을 주지 않게, 연결 없는 조회(hosting)가 이 계정을 `--user`로 명시한다.
static SWITCHED_FROM: parking_lot::Mutex<std::collections::BTreeMap<String, String>> = parking_lot::Mutex::new(std::collections::BTreeMap::new());

/// 그 host가 전환 구간이면 원래(복원 대상) 계정
pub(crate) fn switched_from(host: &str) -> Option<String> {
    SWITCHED_FROM.lock().get(host).cloned()
}

/// 호스트 하나의 상태. `op`는 전환·복원처럼 gh를 기다리는 구간을 직렬화한다(다른 호스트는 막지 않는다).
#[derive(Default)]
struct Host {
    op: Mutex<()>,
    slot: parking_lot::Mutex<Slot>,
    freed: Notify,
}

/// 전역 활성 계정을 임시로 바꾸는 작업의 관문. 호스트마다 한 계정만 동시에 쓴다.
#[derive(Clone, Default)]
pub(crate) struct Gate {
    hosts: Arc<parking_lot::Mutex<HashMap<String, Arc<Host>>>>,
}

/// 얻은 자리. `release`로 놓는 게 정상 경로이고, 놓지 않고 버려지면(패닉·abort·future drop) Drop이
/// 같은 정리(자리 감소·복원)를 tokio 작업으로 돌린다. 런타임이 없으면 자리만 정리하고 로그(stderr)를 남긴다.
pub(crate) struct Lease {
    gate: Gate,
    gh: Gh,
    host: String,
    user: String,
    done: bool,
}

impl Lease {
    pub fn host(&self) -> &str {
        &self.host
    }

    /// 자리를 놓는다. 마지막 작업이면 `restore`일 때 원래 계정으로 되돌린다.
    /// 정리는 별도 작업으로 돌려, 이 future가 중간에 버려져도 복원은 끝까지 간다.
    pub async fn release(mut self, restore: bool, log: impl Fn(String) + Send + 'static) {
        self.done = true;
        let (gate, gh, host, user) = (self.gate.clone(), self.gh.clone(), self.host.clone(), self.user.clone());
        let _ = tokio::spawn(async move { gate.finish(&gh, &host, &user, restore, log).await }).await;
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        self.done = true;
        let (gate, gh, host, user) = (self.gate.clone(), self.gh.clone(), self.host.clone(), self.user.clone());
        match tokio::runtime::Handle::try_current() {
            Ok(rt) => {
                rt.spawn(async move { gate.finish(&gh, &host, &user, true, |l| eprintln!("{l}")).await });
            }
            Err(_) => {
                Gate::dec(&gate.host(&host), &host, &user, false);
                eprintln!("gh lease dropped without a runtime: account not restored ({host})");
            }
        }
    }
}

impl Gate {
    fn host(&self, host: &str) -> Arc<Host> {
        self.hosts.lock().entry(host.to_string()).or_default().clone()
    }

    fn lease(&self, gh: &Gh, host: &str, user: &str) -> Lease {
        Lease { gate: self.clone(), gh: gh.clone(), host: host.into(), user: user.into(), done: false }
    }

    /// 자리 하나를 줄인다. 마지막이면 복원할 계정(`restore`이고 원래 계정이 다를 때)을 돌려준다.
    fn dec(h: &Host, host: &str, user: &str, restore: bool) -> Option<String> {
        let mut s = h.slot.lock();
        s.count = s.count.saturating_sub(1);
        if s.count > 0 {
            return None;
        }
        s.user = None;
        SWITCHED_FROM.lock().remove(host);
        s.original.take().filter(|o| restore && o != user)
    }

    async fn finish(&self, gh: &Gh, host: &str, user: &str, restore: bool, log: impl Fn(String)) {
        let h = self.host(host);
        let op = h.op.lock().await;
        if let Some(orig) = Self::dec(&h, host, user, restore) {
            match gh.switch(host, &orig).await {
                Ok(()) => log(format!("gh account restored: {user} → {orig}")),
                Err(e) => log(format!("gh account restore failed: {e}")),
            }
        }
        drop(op);
        h.freed.notify_waiters();
    }

    /// 활성 계정이 `user`가 아니면 전환하고 자리를 얻는다. 다른 계정이 쓰는 중이면 끝날 때까지 기다린다.
    /// 전환하면 `log`로 한 줄 남긴다. 전환 실패는 Err(자리는 얻지 않음).
    /// 자리는 전환 **전에** 등록하고 `Lease`를 먼저 만든다: 전환 도중 취소돼도 Drop이 복원한다.
    pub async fn acquire(&self, gh: &Gh, host: &str, user: &str, log: impl Fn(String)) -> Res<Lease> {
        let h = self.host(host);
        loop {
            let op = h.op.lock().await;
            let busy = {
                let mut s = h.slot.lock();
                match s.user.as_deref() {
                    Some(u) if u == user => {
                        s.count += 1;
                        return Ok(self.lease(gh, host, user));
                    }
                    other => other.is_some(),
                }
            };
            if busy {
                // 다른 계정이 사용 중: op를 쥔 채 등록해 두면(해제는 op가 필요) 깨울 신호를 놓치지 않는다
                let n = h.freed.notified();
                tokio::pin!(n);
                n.as_mut().enable();
                drop(op);
                n.await;
                continue;
            }
            // 원래 계정을 모르면 전환하지 않는다: 끝나고 되돌릴 수 없어 전역 gh 계정이 바뀐 채 남는다
            let original = match gh.active_user_checked(host).await {
                Ok(o) => o,
                Err(e) => {
                    drop(op);
                    return Err(e);
                }
            };
            let switch = original.as_deref() != Some(user);
            *h.slot.lock() = Slot { user: Some(user.into()), count: 1, original: original.clone() };
            if switch {
                if let Some(o) = &original {
                    SWITCHED_FROM.lock().insert(host.to_string(), o.clone());
                }
            }
            let mut lease = self.lease(gh, host, user);
            if switch {
                if let Err(e) = gh.switch(host, user).await {
                    lease.done = true;
                    Self::dec(&h, host, user, false);
                    return Err(e);
                }
                let from = original.unwrap_or_else(|| "?".into());
                log(format!("gh account switched: {from} → {user}"));
            }
            return Ok(lease);
        }
    }
}

// ---------- 원격·연결 ----------

/// 사용할 원격 고르기: 인자로 지정한 원격 → 추적 원격 → origin → 첫 원격
fn pick_remote(remotes: &[(String, String, RemoteRepo)], hint: Option<&str>, tracking: Option<&str>) -> Option<usize> {
    let find = |n: &str| remotes.iter().position(|(name, _, _)| name == n);
    hint.and_then(find).or_else(|| tracking.and_then(find)).or_else(|| find("origin")).or(if remotes.is_empty() { None } else { Some(0) })
}

/// push/fetch/pull 인자에서 원격 이름 후보(옵션이 아닌 첫 인자가 원격 이름과 같을 때)
fn remote_hint<'a>(args: &'a [String], remotes: &[(String, String, RemoteRepo)]) -> Option<&'a str> {
    args.iter().skip(1).find(|a| !a.starts_with('-')).map(String::as_str).filter(|a| remotes.iter().any(|(n, _, _)| n == a))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoAccount {
    host: String,
    bound: Option<String>,
    active: Option<String>,
    remote: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct Probe {
    user: String,
    ok: bool,
}

/// 원격 작업에 쓸 연결: (host, 연결된 계정)
pub(crate) struct Bound {
    pub host: String,
    pub user: String,
}

/// 없는 키(종료 1)만 None, 그 밖의 git 실패는 Err
async fn config_get(git: &dyn GitBackend, repo: &Path, key: &str) -> Res<Option<String>> {
    let out = git.run(repo, &["config", "--local", "--get", key], &[1]).await.map_err(|e| e.to_string())?;
    Ok(Some(String::from_utf8_lossy(&out).trim().to_string()).filter(|s| !s.is_empty()))
}

/// gh 실패 출력 → 오류 문구(stderr 마지막 줄, 없으면 종료 코드)
fn gh_err(out: &std::process::Output) -> String {
    let err = String::from_utf8_lossy(&out.stderr);
    match err.lines().rev().find(|l| !l.trim().is_empty()) {
        Some(l) => format!("gh: {}", l.trim()),
        None => format!("gh exited with {:?}", out.status.code()),
    }
}

impl Backend {
    fn gh(&self) -> Gh {
        Gh::new(self.path_env())
    }

    /// 저장소의 (원격 이름, 원격). 추적 원격 → origin.
    async fn gh_remote(&self, repo: &Path, hint: Option<&str>) -> Res<Option<(String, RemoteRepo)>> {
        let mut remotes = parsed_remotes(&*self.backend, repo).await?;
        let tracking = match self.backend.run(repo, &["symbolic-ref", "--short", "-q", "HEAD"], &[1]).await {
            Ok(b) => {
                let br = String::from_utf8_lossy(&b).trim().to_string();
                if br.is_empty() { None } else { config_get(&*self.backend, repo, &format!("branch.{br}.remote")).await? }
            }
            Err(_) => None,
        };
        let i = pick_remote(&remotes, hint, tracking.as_deref());
        Ok(i.map(|i| {
            let (n, _, r) = remotes.swap_remove(i);
            (n, r)
        }))
    }

    pub(crate) async fn gh_accounts(&self, host: Option<String>) -> Res<GhAccounts> {
        self.gh().accounts(host.as_deref()).await
    }

    pub(crate) async fn gh_switch(&self, host: &str, user: &str) -> Res<()> {
        self.gh().switch(host, user).await
    }

    pub(crate) async fn gh_repo_account(&self, repo: &Path) -> Res<RepoAccount> {
        let remote = self.gh_remote(repo, None).await?.map(|(_, r)| r);
        let host = remote.as_ref().map(|r| r.host.clone()).unwrap_or_else(|| "github.com".into());
        let bound = config_get(&*self.backend, repo, BIND_KEY).await?;
        let active = self.gh().active_user(&host).await;
        Ok(RepoAccount { host, bound, active, remote: remote.map(|r| r.path()) })
    }

    /// 저장소에 계정 연결(`None`이면 연결 해제)
    pub(crate) async fn gh_bind(&self, repo: &Path, user: Option<String>) -> Res<()> {
        match user.filter(|u| !u.is_empty()) {
            Some(u) => self.backend.run(repo, &["config", "--local", BIND_KEY, &u], &[]).await.map(drop).map_err(err),
            None => self.backend.run(repo, &["config", "--local", "--unset", BIND_KEY], &[5]).await.map(drop).map_err(err),
        }
    }

    pub(crate) async fn gh_probe(&self, repo: &Path) -> Res<Vec<Probe>> {
        let Some((_, remote)) = self.gh_remote(repo, None).await? else { return Ok(vec![]) };
        let gh = self.gh();
        let all = gh.accounts(Some(&remote.host)).await?;
        let mut out = Vec::new();
        for a in all.hosts.into_iter().flat_map(|h| h.accounts) {
            let ok = gh.can_access(&remote.host, &a.user, &remote).await;
            out.push(Probe { user: a.user, ok });
        }
        Ok(out)
    }

    /// 이 저장소·원격에 연결된 계정(그 계정이 원격 host의 gh에 로그인돼 있을 때만).
    /// 연결이 없거나 그 계정이 로그아웃됐으면 Ok(None). 읽기 실패(gh 시간 초과 등)는 Err —
    /// "연결 없음"으로 넘기면 다른 계정으로 push·PR이 진행된다.
    async fn bound_for(&self, repo: &Path, remote: &RemoteRepo) -> Res<Option<Bound>> {
        let Some(user) = config_get(&*self.backend, repo, BIND_KEY).await? else { return Ok(None) };
        let all = self.gh().accounts(Some(&remote.host)).await?;
        if !all.installed {
            return Ok(None);
        }
        let has = all.hosts.iter().any(|h| h.host == remote.host && h.accounts.iter().any(|a| a.user == user));
        Ok(has.then(|| Bound { host: remote.host.clone(), user }))
    }

    /// PR API용 토큰: 저장소에 연결된 계정의 토큰(전역 전환 없음). 연결이 없거나 `local`이 없으면 None.
    /// 연결은 있는데 토큰을 못 얻으면 Err(다른 계정으로 대신하지 않는다).
    pub(crate) async fn gh_bound_token(&self, local: Option<&Path>, remote: &RemoteRepo) -> Res<Option<String>> {
        let Some(local) = local else { return Ok(None) };
        let Some(b) = self.bound_for(local, remote).await? else { return Ok(None) };
        self.gh().token_checked(&b.host, &b.user).await
    }

    /// push/fetch/pull이고 연결된 계정이 있으면 자리를 얻는다(필요하면 전환). 로그 줄은 `tx`로 보낸다.
    /// clone은 저장소가 아직 없으니 `clone_as`(고른 계정)로만: URL(`--` 다음 인자)이 https여야 한다.
    pub(crate) async fn gh_lease_for_job(&self, repo: &Path, args: &[String], clone_as: Option<&str>, tx: &mpsc::UnboundedSender<JobEvent>) -> Res<Option<Lease>> {
        if let Some(user) = clone_as.filter(|u| !u.is_empty()) {
            let url = clone_url(args).ok_or("ghUser: clone URL을 찾을 수 없습니다")?;
            let host = url.strip_prefix("https://").and(gc_hosting::parse_remote(url)).map(|r| r.host).ok_or("ghUser: https URL만 계정을 고를 수 있습니다")?;
            let log = progress_logger(tx);
            return self.gh_gate.acquire(&self.gh(), &host, user, log).await.map(Some);
        }
        if !matches!(args.first().map(String::as_str), Some("push" | "fetch" | "pull")) {
            return Ok(None);
        }
        let remotes = parsed_remotes(&*self.backend, repo).await?;
        let hint = remote_hint(args, &remotes).map(String::from);
        let Some((_, remote)) = self.gh_remote(repo, hint.as_deref()).await? else { return Ok(None) };
        let Some(b) = self.bound_for(repo, &remote).await? else { return Ok(None) };
        let log = progress_logger(tx);
        self.gh_gate.acquire(&self.gh(), &b.host, &b.user, log).await.map(Some)
    }

    pub(crate) async fn gh_release(&self, lease: Lease, restore: bool, tx: &mpsc::UnboundedSender<JobEvent>) {
        lease.release(restore, progress_logger(tx)).await;
    }
}

/// `clone ... -- <url> [dir]`의 URL
fn clone_url(args: &[String]) -> Option<&str> {
    if args.first().map(String::as_str) != Some("clone") {
        return None;
    }
    args.iter().skip_while(|a| *a != "--").nth(1).map(String::as_str)
}

fn progress_logger(tx: &mpsc::UnboundedSender<JobEvent>) -> impl Fn(String) + Send + 'static {
    let tx = tx.clone();
    move |line| {
        let _ = tx.send(JobEvent::Progress { line });
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;

    const JSON: &str = r#"{"hosts":{"github.com":[
        {"state":"success","active":true,"host":"github.com","login":"alice","tokenSource":"keyring","scopes":"repo","gitProtocol":"https"},
        {"state":"success","active":false,"host":"github.com","login":"gold","scopes":"repo","gitProtocol":"https"}]}}"#;

    #[test]
    fn json_파싱() {
        let h = parse_status_json(JSON).unwrap();
        assert_eq!(h, vec![GhHost { host: "github.com".into(), accounts: vec![GhUser { user: "alice".into(), active: true }, GhUser { user: "gold".into(), active: false }] }]);
        assert!(parse_status_json("unknown flag: --json").is_none());
        assert_eq!(parse_status_json(r#"{"hosts":{}}"#).unwrap(), vec![]);
    }

    #[test]
    fn 텍스트_파싱() {
        let t = "github.com\n  ✓ Logged in to github.com account Alice (keyring)\n  - Active account: true\n  - Git operations protocol: https\n  - Token: gho_****\n\n  ✓ Logged in to github.com account gold (keyring)\n  - Active account: false\n  X Failed to log in to ghe.corp.com account bob (keyring)\n  - Active account: true\n";
        let h = parse_status_text(t);
        assert_eq!(h.len(), 2);
        assert_eq!(h[0], GhHost { host: "ghe.corp.com".into(), accounts: vec![GhUser { user: "bob".into(), active: true }] });
        assert_eq!(h[1].accounts, vec![GhUser { user: "Alice".into(), active: true }, GhUser { user: "gold".into(), active: false }]);
        assert!(parse_status_text("You are not logged into any GitHub hosts.").is_empty());
    }

    #[test]
    fn credential_인자() {
        let a = helper_args("github.com");
        assert_eq!(
            a.join(" "),
            "-c credential.https://github.com.helper= -c credential.https://github.com.helper=!gh auth git-credential"
        );
    }

    /// 실제 git으로: 대상 host만 gh 도우미(가짜)로 인증하고 다른 host는 건드리지 않는다. 기존 전역 도우미는 대상 host에서만 비워진다.
    #[test]
    fn credential_host_한정_실제_git() {
        let (d, _gh) = setup();
        let home = tempfile::tempdir().unwrap();
        let fill = |host: &str| {
            use std::io::Write;
            let mut cmd = std::process::Command::new("git");
            cmd.args(helper_args("github.com")).args(["credential", "fill"]);
            cmd.env("PATH", format!("{}:{}", d.path().display(), std::env::var("PATH").unwrap_or_default()))
                .env("HOME", home.path())
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_TERMINAL_PROMPT", "0")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            let mut child = cmd.spawn().unwrap();
            child.stdin.take().unwrap().write_all(format!("protocol=https\nhost={host}\n\n").as_bytes()).unwrap();
            let out = child.wait_with_output().unwrap();
            out.status.success().then(|| String::from_utf8_lossy(&out.stdout).to_string())
        };
        let ok = fill("github.com").expect("gh 도우미가 응답해야 한다");
        assert!(ok.contains("username=gh-user") && ok.contains("password=tok-alice"), "{ok}");
        assert!(fill("other.example.com").is_none(), "다른 host는 gh 도우미를 쓰지 않는다(프롬프트 금지라 실패)");
    }

    fn remotes() -> Vec<(String, String, RemoteRepo)> {
        let r = |n: &str| (n.to_string(), String::new(), RemoteRepo { host: "github.com".into(), owner: "o".into(), name: n.into() });
        vec![r("upstream"), r("origin")]
    }

    #[test]
    fn 원격_고르기() {
        let r = remotes();
        assert_eq!(pick_remote(&r, None, None), Some(1));
        assert_eq!(pick_remote(&r, None, Some("upstream")), Some(0));
        assert_eq!(pick_remote(&r, None, Some(".")), Some(1));
        assert_eq!(pick_remote(&r, Some("upstream"), Some("origin")), Some(0));
        assert_eq!(pick_remote(&r[..1], None, None), Some(0));
        assert_eq!(pick_remote(&[], None, None), None);
        let args: Vec<String> = ["push", "-u", "upstream", "main"].map(String::from).to_vec();
        assert_eq!(remote_hint(&args, &r), Some("upstream"));
        let args: Vec<String> = ["fetch", "--all"].map(String::from).to_vec();
        assert_eq!(remote_hint(&args, &r), None);
    }

    /// 가짜 gh: 활성 계정은 `active` 파일, 호출은 `log` 파일에 남긴다. 실제 gh 상태는 건드리지 않는다.
    fn fake_gh(dir: &Path) {
        let script = format!(
            r#"#!/bin/sh
D="{d}"
[ -f "$D/fail_status" ] && case "$*" in "auth status"*|"auth token"*) echo "error connecting to api.github.com" >&2; exit 1;; esac
case "$*" in
"auth status"*"--json hosts")
  a=$(cat "$D/active")
  s='{{"hosts":{{"github.com":['
  sep=''
  for u in alice gold vk; do
    act=false; [ "$u" = "$a" ] && act=true
    s="$s$sep{{\"active\":$act,\"host\":\"github.com\",\"login\":\"$u\",\"state\":\"success\"}}"; sep=','
  done
  echo "$s]}}}}" ;;
"auth switch"*)
  while [ $# -gt 0 ]; do [ "$1" = "--user" ] && u="$2"; shift; done
  [ -f "$D/fail_switch" ] && {{ echo "switch failed" >&2; exit 1; }}
  [ -f "$D/slow" ] && sleep 2
  echo "$u" > "$D/active"; echo "switch $u" >> "$D/log" ;;
"auth token"*)
  while [ $# -gt 0 ]; do [ "$1" = "--user" ] && u="$2"; shift; done
  echo "tok-$u" ;;
"auth git-credential"*)
  cat >/dev/null
  echo "username=gh-user"; echo "password=tok-$(cat "$D/active")" ;;
"api "*)
  case "$GH_TOKEN" in tok-gold) exit 0;; *) echo "Not Found" >&2; exit 1;; esac ;;
*) exit 2 ;;
esac
"#,
            d = dir.display()
        );
        let p = dir.join("gh");
        std::fs::write(&p, script).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.join("active"), "alice\n").unwrap();
    }

    fn setup() -> (tempfile::TempDir, Gh) {
        let d = tempfile::tempdir().unwrap();
        fake_gh(d.path());
        let path = format!("{}:{}", d.path().display(), std::env::var("PATH").unwrap_or_default());
        (d, Gh::new(Some(&path)))
    }

    fn switches(d: &Path) -> Vec<String> {
        std::fs::read_to_string(d.join("log")).unwrap_or_default().lines().map(String::from).collect()
    }

    fn collector() -> (Arc<parking_lot::Mutex<Vec<String>>>, impl Fn(String) + Clone) {
        let v = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let v2 = v.clone();
        (v, move |l| v2.lock().push(l))
    }

    #[tokio::test]
    async fn 가짜_gh로_계정_조회_토큰_접근() {
        let (d, gh) = setup();
        let a = gh.accounts(None).await.unwrap();
        assert!(a.installed);
        assert_eq!(a.hosts[0].accounts.iter().filter(|x| x.active).map(|x| x.user.as_str()).collect::<Vec<_>>(), ["alice"]);
        assert_eq!(gh.accounts(Some("other.host")).await.unwrap().hosts, vec![]);
        assert_eq!(gh.token("github.com", "gold").await.as_deref(), Some("tok-gold"));
        let repo = RemoteRepo { host: "github.com".into(), owner: "o".into(), name: "r".into() };
        assert!(gh.can_access("github.com", "gold", &repo).await);
        assert!(!gh.can_access("github.com", "vk", &repo).await);
        assert!(switches(d.path()).is_empty(), "조회·접근 확인은 전역 전환을 하지 않는다");
    }

    #[tokio::test]
    async fn gh가_없으면_installed_false() {
        let d = tempfile::tempdir().unwrap();
        let a = Gh::new(Some(&d.path().to_string_lossy())).accounts(None).await.unwrap();
        assert!(!a.installed && a.hosts.is_empty());
    }

    #[tokio::test]
    async fn 전환_후_복원_순서와_로그() {
        let (d, gh) = setup();
        let gate = Gate::default();
        let (lines, log) = collector();
        let l = gate.acquire(&gh, "github.com", "gold", log.clone()).await.unwrap();
        assert_eq!(gh.active_user("github.com").await.as_deref(), Some("gold"));
        l.release(true, log.clone()).await;
        assert_eq!(gh.active_user("github.com").await.as_deref(), Some("alice"));
        assert_eq!(switches(d.path()), ["switch gold", "switch alice"]);
        let lines = lines.lock().clone();
        assert!(lines[0].contains("alice → gold") && lines[1].contains("gold → alice"), "{lines:?}");
    }

    #[tokio::test]
    async fn 이미_활성이면_전환도_복원도_없다_gh_restore_false면_복원_안_함() {
        let (d, gh) = setup();
        let gate = Gate::default();
        let (lines, log) = collector();
        let l = gate.acquire(&gh, "github.com", "alice", log.clone()).await.unwrap();
        l.release(true, log.clone()).await;
        assert!(switches(d.path()).is_empty() && lines.lock().is_empty());
        let l = gate.acquire(&gh, "github.com", "vk", log.clone()).await.unwrap();
        l.release(false, log).await;
        assert_eq!(switches(d.path()), ["switch vk"]);
        assert_eq!(gh.active_user("github.com").await.as_deref(), Some("vk"));
    }

    #[tokio::test]
    async fn 전환_실패는_자리를_안_남긴다() {
        let (d, gh) = setup();
        std::fs::write(d.path().join("fail_switch"), "").unwrap();
        let gate = Gate::default();
        let r = gate.acquire(&gh, "github.com", "gold", |_| {}).await;
        assert!(r.err().is_some_and(|e| e.contains("switch failed")));
        // 자리가 남지 않았으니 다른 계정도 바로 얻는다
        std::fs::remove_file(d.path().join("fail_switch")).unwrap();
        let l = tokio::time::timeout(Duration::from_secs(5), gate.acquire(&gh, "github.com", "vk", |_| {})).await.unwrap().unwrap();
        l.release(true, |_| {}).await;
        assert_eq!(gh.active_user("github.com").await.as_deref(), Some("alice"));
    }

    #[tokio::test]
    async fn 같은_계정은_겹치고_마지막이_복원_다른_계정은_대기() {
        let (d, gh) = setup();
        let gh = Arc::new(gh);
        let gate = Arc::new(Gate::default());
        let l1 = gate.acquire(&gh, "github.com", "gold", |_| {}).await.unwrap();
        let l2 = gate.acquire(&gh, "github.com", "gold", |_| {}).await.unwrap();
        assert_eq!(switches(d.path()), ["switch gold"], "같은 계정은 한 번만 전환");

        let (g2, gh2) = (gate.clone(), gh.clone());
        let waiter = tokio::spawn(async move { g2.acquire(&gh2, "github.com", "vk", |_| {}).await });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!waiter.is_finished(), "다른 계정은 대기");

        l1.release(true, |_| {}).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!waiter.is_finished(), "같은 계정 작업이 남아 있으면 계속 대기");
        assert_eq!(gh.active_user("github.com").await.as_deref(), Some("gold"));

        l2.release(true, |_| {}).await;
        let l3 = tokio::time::timeout(Duration::from_secs(5), waiter).await.unwrap().unwrap().unwrap();
        l3.release(true, |_| {}).await;
        // gold 전환 → (마지막 해제) alice 복원 → vk 전환 → alice 복원
        assert_eq!(switches(d.path()), ["switch gold", "switch alice", "switch vk", "switch alice"]);
    }

    /// 활성 계정이 `want`가 될 때까지 기다린다(Drop 정리는 백그라운드 작업이라).
    async fn wait_active(gh: &Gh, want: &str) {
        for _ in 0..100 {
            if gh.active_user("github.com").await.as_deref() == Some(want) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("활성 계정이 {want}로 돌아오지 않음");
    }

    /// 정리 뒤 다른 계정 작업이 막히지 않고 진행되는지
    async fn next_acquire_works(gate: &Gate, gh: &Gh) {
        let l = tokio::time::timeout(Duration::from_secs(5), gate.acquire(gh, "github.com", "vk", |_| {})).await.expect("대기하면 안 된다").unwrap();
        l.release(true, |_| {}).await;
        wait_active(gh, "alice").await;
    }

    #[tokio::test]
    async fn 패닉해도_자리와_계정을_복원한다() {
        let (_d, gh) = setup();
        let gate = Gate::default();
        let l = gate.acquire(&gh, "github.com", "gold", |_| {}).await.unwrap();
        let r = tokio::spawn(async move {
            let _l = l;
            panic!("작업 패닉");
        })
        .await;
        assert!(r.is_err());
        wait_active(&gh, "alice").await;
        next_acquire_works(&gate, &gh).await;
    }

    #[tokio::test]
    async fn abort돼도_자리와_계정을_복원한다() {
        let (_d, gh) = setup();
        let gate = Gate::default();
        let l = gate.acquire(&gh, "github.com", "gold", |_| {}).await.unwrap();
        let t = tokio::spawn(async move {
            let _l = l;
            tokio::time::sleep(Duration::from_secs(60)).await;
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        t.abort();
        let _ = t.await;
        wait_active(&gh, "alice").await;
        next_acquire_works(&gate, &gh).await;
    }

    #[tokio::test]
    async fn 전환_도중_future가_버려져도_정리된다() {
        let (d, gh) = setup();
        std::fs::write(d.path().join("slow"), "").unwrap();
        let gate = Gate::default();
        let r = tokio::time::timeout(Duration::from_millis(300), gate.acquire(&gh, "github.com", "gold", |_| {})).await;
        assert!(r.is_err(), "전환이 느려 시간 초과여야 한다");
        std::fs::remove_file(d.path().join("slow")).unwrap();
        wait_active(&gh, "alice").await;
        next_acquire_works(&gate, &gh).await;
    }

    struct Events(Arc<parking_lot::Mutex<Vec<(String, serde_json::Value)>>>);
    impl crate::Emit for Events {
        fn emit(&self, event: &str, payload: serde_json::Value) {
            self.0.lock().push((event.into(), payload));
        }
    }

    /// 저장소 + 가짜 gh. origin은 github.com URL이고 insteadOf로 `target`을 향한다(오프라인).
    async fn job_setup(target: &Path, bound: Option<&str>) -> (tempfile::TempDir, tempfile::TempDir, Backend, Arc<parking_lot::Mutex<Vec<(String, serde_json::Value)>>>) {
        let (d, gh) = setup();
        let repo = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            assert!(std::process::Command::new("git").args(args).current_dir(repo.path()).status().unwrap().success(), "{args:?}");
        };
        git(&["init", "-q"]);
        git(&["remote", "add", "origin", "https://github.com/o/r.git"]);
        git(&["config", &format!("url.{}.insteadOf", target.display()), "https://github.com/o/r.git"]);
        if let Some(u) = bound {
            git(&["config", "--local", BIND_KEY, u]);
        }
        let runner = gc_core::GitRunner::default();
        runner.path_cell().set(gh.path.clone().unwrap()).unwrap();
        let log = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let be = Backend::with_parts(runner, Default::default(), Arc::new(Events(log.clone())), repo.path().join("cfg"), None);
        (d, repo, be, log)
    }

    async fn run_job(be: &Backend, repo: &Path, log: &Arc<parking_lot::Mutex<Vec<(String, serde_json::Value)>>>, args: &[&str], restore: bool) -> (Vec<String>, Option<String>) {
        run_job_as(be, repo, log, args, None, restore).await
    }

    async fn run_job_as(be: &Backend, repo: &Path, log: &Arc<parking_lot::Mutex<Vec<(String, serde_json::Value)>>>, args: &[&str], gh_user: Option<&str>, restore: bool) -> (Vec<String>, Option<String>) {
        let job = be.start_job(repo.to_path_buf(), args.iter().map(|s| s.to_string()).collect(), None, gh_user.map(String::from), restore).await.unwrap();
        for _ in 0..200 {
            let events = log.lock().clone();
            if let Some(done) = events.iter().find(|(e, p)| e == "job-done" && p[0] == job) {
                let lines = events.iter().filter(|(e, _)| e == "job").map(|(_, p)| p.to_string()).collect();
                return (lines, done.1[1].as_str().map(String::from));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("작업이 끝나지 않음");
    }

    #[tokio::test]
    async fn 연결된_계정으로_fetch하면_전환하고_복원한다() {
        let bare = tempfile::tempdir().unwrap();
        assert!(std::process::Command::new("git").args(["init", "-q", "--bare"]).arg(bare.path()).status().unwrap().success());
        let (d, repo, be, log) = job_setup(bare.path(), Some("gold")).await;
        let (lines, e) = run_job(&be, repo.path(), &log, &["fetch"], true).await;
        assert!(e.is_none(), "{e:?}");
        assert_eq!(switches(d.path()), ["switch gold", "switch alice"]);
        assert!(lines.iter().any(|l| l.contains("alice → gold")) && lines.iter().any(|l| l.contains("gold → alice")), "{lines:?}");
    }

    #[tokio::test]
    async fn clone은_고른_계정으로_전환하고_복원한다() {
        let missing = std::env::temp_dir().join("git403-no-such-remote-dir");
        let (d, repo, be, log) = job_setup(&missing, None).await;
        // 연결 거부로 바로 실패하는 https URL (네트워크 없음)
        let (lines, e) = run_job_as(&be, repo.path(), &log, &["clone", "--progress", "--", "https://127.0.0.1:1/o/r.git", "r"], Some("gold"), true).await;
        assert!(e.is_some(), "clone은 실패해야 한다");
        // 가짜 gh는 github.com만 알아서 이 host의 원래 활성 계정이 없음(?) → 되돌릴 계정 없음
        assert_eq!(switches(d.path()), ["switch gold"]);
        assert!(lines.iter().any(|l| l.contains("→ gold")), "{lines:?}");
        // ssh URL은 자격 도우미가 쓰이지 않으니 전환하지 않고 거부
        let args = ["clone", "--", "git@github.com:o/r.git", "r"].map(String::from).to_vec();
        assert!(be.start_job(repo.path().to_path_buf(), args, None, Some("gold".into()), true).await.is_err());
        assert_eq!(switches(d.path()).len(), 1);
        let args: Vec<String> = ["clone", "--progress", "--", "https://h/o/r", "x"].map(String::from).to_vec();
        assert_eq!(clone_url(&args), Some("https://h/o/r"));
        assert_eq!(clone_url(&args[1..]), None);
    }

    #[tokio::test]
    async fn 실패한_작업도_복원하고_gh_restore_false면_복원_안_한다() {
        let missing = std::env::temp_dir().join("git403-no-such-remote-dir");
        let (d, repo, be, log) = job_setup(&missing, Some("gold")).await;
        let (_, e) = run_job(&be, repo.path(), &log, &["fetch"], true).await;
        assert!(e.is_some(), "fetch는 실패해야 한다");
        assert_eq!(switches(d.path()), ["switch gold", "switch alice"]);
        let (_, e) = run_job(&be, repo.path(), &log, &["fetch"], false).await;
        assert!(e.is_some());
        assert_eq!(switches(d.path()), ["switch gold", "switch alice", "switch gold"]);
    }

    #[tokio::test]
    async fn gh_조회가_실패하면_계정을_바꾸지_않고_원인을_담아_실패한다() {
        let missing = std::env::temp_dir().join("git403-no-such-remote-dir");
        let (d, repo, be, log) = job_setup(&missing, Some("gold")).await;
        std::fs::write(d.path().join("fail_status"), "").unwrap();
        // 연결 계정을 못 확인하면 현재 계정으로 진행하지 않는다
        let _ = &log;
        let e = be.start_job(repo.path().to_path_buf(), vec!["fetch".into()], None, None, true).await.unwrap_err();
        assert!(e.contains("error connecting"), "{e}");
        assert!(switches(d.path()).is_empty(), "전환하지 않는다");
        // PR 토큰도 다른 계정으로 대신하지 않는다
        let remote = RemoteRepo { host: "github.com".into(), owner: "o".into(), name: "r".into() };
        assert!(be.gh_bound_token(Some(repo.path()), &remote).await.is_err());
        // 원래 계정을 모르면 Gate도 전환하지 않는다
        let gh = Gh::new(Some(&format!("{}:{}", d.path().display(), std::env::var("PATH").unwrap_or_default())));
        let (_, l) = collector();
        assert!(Gate::default().acquire(&gh, "github.com", "gold", l).await.is_err());
        assert!(switches(d.path()).is_empty());
    }

    #[tokio::test]
    async fn 연결이_없거나_push_fetch_pull이_아니면_gh를_건드리지_않는다() {
        let missing = std::env::temp_dir().join("git403-no-such-remote-dir");
        let (d, repo, be, log) = job_setup(&missing, None).await;
        run_job(&be, repo.path(), &log, &["fetch"], true).await;
        assert!(switches(d.path()).is_empty());
        std::process::Command::new("git").args(["config", "--local", BIND_KEY, "gold"]).current_dir(repo.path()).status().unwrap();
        run_job(&be, repo.path(), &log, &["status"], true).await;
        assert!(switches(d.path()).is_empty());
        // 로그인돼 있지 않은 계정에 연결돼 있으면 무시
        std::process::Command::new("git").args(["config", "--local", BIND_KEY, "nobody"]).current_dir(repo.path()).status().unwrap();
        run_job(&be, repo.path(), &log, &["fetch"], true).await;
        assert!(switches(d.path()).is_empty());
    }

    #[tokio::test]
    async fn repo_account_bind_probe() {
        let missing = std::env::temp_dir().join("git403-no-such-remote-dir");
        let (_d, repo, be, _log) = job_setup(&missing, None).await;
        let r = be.gh_repo_account(repo.path()).await.unwrap();
        assert_eq!((r.host.as_str(), r.bound, r.active.as_deref(), r.remote.as_deref()), ("github.com", None, Some("alice"), Some("o/r")));
        be.gh_bind(repo.path(), Some("gold".into())).await.unwrap();
        assert_eq!(be.gh_repo_account(repo.path()).await.unwrap().bound.as_deref(), Some("gold"));
        let p = be.gh_probe(repo.path()).await.unwrap();
        assert_eq!(p.iter().map(|x| (x.user.as_str(), x.ok)).collect::<Vec<_>>(), [("alice", false), ("gold", true), ("vk", false)]);
        assert_eq!(be.gh_bound_token(Some(repo.path()), &RemoteRepo { host: "github.com".into(), owner: "o".into(), name: "r".into() }).await.unwrap().as_deref(), Some("tok-gold"));
        be.gh_bind(repo.path(), None).await.unwrap();
        be.gh_bind(repo.path(), None).await.unwrap(); // 이미 없어도 오류 아님
        assert_eq!(be.gh_repo_account(repo.path()).await.unwrap().bound, None);
    }
}
