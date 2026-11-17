//! (feature `cli` 전용 — 프로세스를 띄운다) AI 채팅으로 git 작업 (docs/reuse.md gc-ai 채팅 절): `claude -p … --output-format stream-json`을 저장소 폴더에서 실행해
//! 출력 줄을 `ai-chat` 이벤트로 중계하고, 실행 전 HEAD를 백업하며, 끝나면 이력에 한 줄 남긴다. 이력·백업 IPC 본문도 여기 있다.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use gc_ai::chat::{self, ChatEvent};
use serde_json::{json, Value};

use crate::ai_history::{self, Entry};
use crate::util::{json, off, Res};
use crate::Backend;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// 이력에 남길 도구 요약 (`Bash: git status`, 200자까지)
fn summary(name: &str, command: &str) -> String {
    format!("{name}: {}", command.lines().next().unwrap_or_default().chars().take(200).collect::<String>())
}

/// UI가 확인창에서 본 저장소 상태(`ai_chat_risk`가 준 `fingerprint`·`configFp`). 시작 때 다시 판정한 값과 같을 때만 확인으로 인정한다
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Seen {
    pub fingerprint: String,
    pub config_fp: String,
}

/// 저장소 단위 잠금(정규화한 경로). 놓으면(drop) 풀린다
struct RepoLock {
    set: std::sync::Arc<parking_lot::Mutex<std::collections::HashSet<String>>>,
    key: String,
}

impl Drop for RepoLock {
    fn drop(&mut self) {
        self.set.lock().remove(&self.key);
    }
}

/// 잠금 키(`repo_gate::lock_key`)는 파일 시스템을 읽으므로 async 실행기를 막지 않게 블로킹 스레드에서 구한다
async fn lock_key_blocking(repo: &std::path::Path) -> Res<String> {
    let r = repo.to_path_buf();
    tokio::task::spawn_blocking(move || crate::repo_gate::lock_key(&r)).await.map_err(|e| e.to_string())
}

fn job_running() -> String {
    gc_i18n::coded!("aiChat.repoJobRunning", "A fetch, pull or other operation is still running in this repository. Start the AI after it finishes.").json()
}

/// 자동 fetch가 끝나기를 기다리는 최대 시간(시험은 짧게)
fn quiet_wait() -> std::time::Duration {
    #[cfg(test)]
    return std::time::Duration::from_secs(2);
    #[cfg(not(test))]
    std::time::Duration::from_secs(10)
}

/// 이 저장소와 겹치는 실행 중 사용자 작업의 종류
#[derive(Debug, PartialEq, Eq)]
enum Overlap {
    None,
    /// 겹치는 작업이 모두 자동 fetch
    OnlyQuiet,
    /// 사용자가 직접 시작한 작업이 있다
    User,
}

impl Backend {
    async fn running_overlap(&self, repo: &std::path::Path) -> Overlap {
        let recs = self.jobs.active();
        if recs.is_empty() {
            return Overlap::None;
        }
        let me = repo.to_path_buf();
        let Ok(mine) = tokio::task::spawn_blocking(move || crate::repo_gate::resolve_keys(&me)).await else { return Overlap::User };
        let (mut any, mut user) = (false, false);
        for r in recs {
            // 등록 때 푼 키를 쓴다(작업의 모든 대상 경로 — `-C`·`--git-dir`·`--work-tree` 포함)
            if r.overlaps_keys(&mine.keys, mine.unknown) {
                any = true;
                user |= !r.kind.brief();
            }
        }
        match (any, user) {
            (false, _) => Overlap::None,
            (true, false) => Overlap::OnlyQuiet,
            (true, true) => Overlap::User,
        }
    }

    /// claude에 줄 `--mcp-config`: 이 실행 파일을 MCP 서버(`--git403-mcp <저장소>`)로. 서버 환경에는 PATH·git 경로·사용자 git 설정에 필요한 변수만 넣고,
    /// git 자식에게 줄 askpass 환경은 `GIT403_GIT_ENV`로 따로 싣는다(서버가 askpass로 오인되지 않게)
    fn mcp_config(&self, repo: &std::path::Path, fingerprint: &str, config_fp: &str, sandbox: &str) -> String {
        use crate::mcp::{CONFIG_FP, GIT_BIN, GIT_ENV, REMOTE_FP, SANDBOX_ENV};
        let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        let mut env = serde_json::Map::new();
        for k in ["HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_SSH", "GIT_SSH_COMMAND", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP", "LANG"] {
            if let Ok(v) = std::env::var(k) {
                env.insert(k.into(), v.into());
            }
        }
        if let Some(p) = self.path_env() {
            env.insert("PATH".into(), p.into());
        }
        env.insert(GIT_BIN.into(), self.git.git_path().to_string_lossy().into_owned().into());
        let git_env: serde_json::Map<String, Value> = self.git.env_pairs().iter().map(|(k, v)| (k.clone(), v.clone().into())).collect();
        env.insert(REMOTE_FP.into(), fingerprint.into());
        env.insert(CONFIG_FP.into(), config_fp.into());
        env.insert(SANDBOX_ENV.into(), sandbox.into());
        env.insert(GIT_ENV.into(), Value::Object(git_env).to_string().into());
        chat::mcp_config(&exe, &repo.to_string_lossy(), &env)
    }

    fn chat_root(&self) -> PathBuf {
        self.config_dir.join("ai-chat")
    }

    fn emit_chat(&self, conversation: &str, event: &ChatEvent) {
        self.emit.emit("ai-chat", json!({"conversation": conversation, "event": event}));
    }

    /// 채팅 한 차례를 시작한다. 바로 `{backup}`(`Backup | null`)을 돌려주고 진행은 `ai-chat` 이벤트
    /// `{conversation, event: ChatEvent}`로 보낸다(마지막 이벤트는 `done`·`error`·`cancelled` 중 하나이고 이력 저장 뒤에 나간다).
    /// `conversation`은 UI가 만든 id(이어 가기는 같은 id + 직전 `done`의 `sessionId`). `program`은 보통 `claude`(테스트는 가짜 스크립트).
    pub(crate) async fn ai_chat_start(&self, program: &str, repo: PathBuf, conversation: String, input: String, session_id: Option<String>, confirmed: Option<Seen>) -> Res<Value> {
        use gc_core::{ai_backup, Error as CoreError, JobEvent};
        ai_history::check_id(&conversation)?;
        if input.trim().is_empty() {
            return Err(gc_i18n::coded!("aiChat.emptyInput", "Enter a message").json());
        }
        let settings = self.ai.settings().await?;
        if !settings.anthropic.consent {
            return Err(gc_i18n::coded!("ai.consentRequired", "Consent to use AI is required").json());
        }
        // 위험 확인(공개·다수 협업자·판정 불가)은 대화 첫 실행에만. UI를 믿지 않고 여기서 다시 판정해 확인 없는 요청은 거절한다
        let r = self.ai_chat_risk(&repo).await?;
        // 확인 키에 원격 지문을 넣어, 확인한 뒤 원격(URL·pushurl)이 바뀌면 다시 묻는다
        if !r.refuse.is_empty() {
            // 확인으로도 허용할 수 없는 저장소 설정(밖을 가리키는 worktree·mirror·비기본 refspec…)
            return Err(gc_i18n::coded!("aiChat.configRefused", "AI cannot work in this repository because of its git configuration: {reasons}", reasons = r.refuse.join("; ")).json());
        }
        let key = format!("{conversation}\0{}\0{}\0{}\0{}", repo.display(), r.fingerprint, r.config_fp, r.sandbox);
        if !self.ai.confirmed.lock().contains(&key) {
            // UI가 "확인했다"고 하려면 확인창에서 본 지문이 지금 다시 판정한 값과 같아야 한다(저장소가 바뀌었으면 다시 묻는다)
            let seen_ok = confirmed.as_ref().is_some_and(|s| s.fingerprint == r.fingerprint && s.config_fp == r.config_fp);
            if (r.level != crate::ai_risk::Level::None || !r.config.is_empty() || r.sandbox == "none") && !seen_ok {
                return Err(gc_i18n::coded!("aiChat.confirmRequired", "Confirmation is required before AI can work on this repository ({level}, collaborators: {collaborators}, settings outside the safe list: {config})", level = serde_json::to_value(r.level).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default(), collaborators = r.collaborators.unwrap_or(0), config = r.config.len()).json());
            }
            self.ai.confirmed.lock().insert(key);
        }
        let busy = || gc_i18n::coded!("aiChat.busy", "This conversation is already running").json();
        if self.ai.chats.lock().contains_key(&conversation) {
            return Err(busy());
        }
        // 같은 저장소(정규화한 경로)에서는 한 번에 한 차례만: 대화가 달라도 백업·되돌림·전후 비교가 서로 엉키지 않게
        let lock = {
            let key = lock_key_blocking(&repo).await?;
            let mut set = self.ai.repos.lock();
            if !set.insert(key.clone()) {
                return Err(busy());
            }
            RepoLock { set: self.ai.repos.clone(), key }
        };
        // 차례를 시작하기 전에 이미 같은 저장소(common dir 기준, 작업의 `-C`·`--git-dir`·`--work-tree` 대상 포함)에서 도는 사용자 작업(start_job·start_shell·run_detached)이 있으면 겹치지 않게 한다.
        // 순서가 중요하다: **위에서 잠금을 먼저 잡았고 이 확인이 그 뒤**다. 작업 쪽(`jobs::register_job`)은 **등록을 먼저 하고 그 뒤에** 잠금을 확인한다. 둘 다 "내 표시를 먼저 남기고 상대 표시를 본다"
        // 이므로 어느 순서로 와도 적어도 한쪽은 상대를 보고 거절한다(동시에 통과할 수 없다). 거절하면 잠금은 놓인다(`lock` drop).
        // 자동 fetch(quiet)뿐이면 끝나기를 잠깐(최대 `quiet_wait`) 기다린다 — 그동안 새 쓰기는 게이트가 막는다. 사용자가 직접 시작한 작업은 기다리지 않고 거절한다.
        let started = std::time::Instant::now();
        let mut told = false;
        loop {
            match self.running_overlap(&repo).await {
                Overlap::None => break,
                Overlap::User => return Err(job_running()),
                Overlap::OnlyQuiet if started.elapsed() >= quiet_wait() => return Err(job_running()),
                Overlap::OnlyQuiet => {
                    // 짧은 쓰기(commit 등)는 보통 바로 끝나므로 0.3초가 지나도 안 끝났을 때만 알린다
                    if !told && started.elapsed() >= std::time::Duration::from_millis(300) {
                        told = true;
                        self.emit_chat(&conversation, &ChatEvent::Note { code: "aiChat.waitFetch".into(), message: "Waiting for the automatic fetch to finish…".into() });
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
        }
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let id = format!("b{:x}{}", now_ms(), SEQ.fetch_add(1, Ordering::Relaxed));
        let backup = ai_backup::create(&self.git, &repo, &id).await.map_err(|e| e.ipc())?;
        if let Some(b) = &backup {
            let key = lock_key_blocking(&repo).await?; // 잠금(guard)을 쥔 채 await하지 않게 키를 먼저 구한다
            self.ai.backups.lock().insert((key, id.clone()), b.clone());
        }
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let args = chat::args(&input, session_id.as_deref(), &self.mcp_config(&repo, &r.fingerprint, &r.config_fp, r.sandbox));
        let spawned = {
            let mut chats = self.ai.chats.lock();
            if chats.contains_key(&conversation) {
                Err(busy())
            } else {
                self.git.spawn_program(program, &repo, &args, tx).map_err(|e| match e {
                    CoreError::Spawn(io) if io.kind() == std::io::ErrorKind::NotFound => {
                        gc_i18n::coded!("aiChat.cliMissing", "Claude Code CLI (claude) was not found. Install it from https://claude.com/claude-code and log in by running `claude` once").json()
                    }
                    e => e.ipc(),
                })
                .inspect(|(h, _)| {
                    chats.insert(conversation.clone(), h.clone());
                })
            }
        };
        let (_handle, task) = match spawned {
            Ok(s) => s,
            Err(e) => {
                if backup.is_some() {
                    let _ = ai_backup::delete(&self.git, &repo, &id).await;
                }
                return Err(e);
            }
        };
        let me = self.clone();
        let reply = backup.clone();
        tokio::spawn(async move {
            let _lock = lock; // 차례가 끝나면(이력 저장·마지막 이벤트 뒤) 저장소 잠금을 푼다
            let (mut text, mut commands, mut done) = (String::new(), Vec::new(), None);
            while let Some(ev) = rx.recv().await {
                // stderr(Progress)는 오류 요약으로만 쓰이므로 중계하지 않는다
                let JobEvent::Stdout { line } = ev else { continue };
                for ev in chat::parse_line(&line) {
                    match &ev {
                        ChatEvent::Done { .. } => {
                            done = Some(ev);
                            continue;
                        }
                        ChatEvent::Text { text: t } => text.push_str(t),
                        ChatEvent::Tool { name, command, .. } => commands.push(summary(name, command)),
                        _ => {}
                    }
                    me.emit_chat(&conversation, &ev);
                }
            }
            let res = task.await;
            // 차례가 끝났을 때 백업 ref가 그대로인지 확인한다: 바뀌었으면(저장소 설정·다른 도구가 덮어씀) 알린다(되돌리기도 거절된다)
            if let Some(b) = &backup {
                if gc_core::ai_backup::verify(&me.git, &repo, b).await.is_err() {
                    me.emit_chat(&conversation, &ChatEvent::Note { code: "aiChat.backupTampered".into(), message: "backup refs changed during the task".into() });
                }
            }
            let last = match (res, done) {
                (Ok(Err(CoreError::Cancelled)), _) => ChatEvent::Cancelled,
                (_, Some(d)) => d,
                (Ok(Ok(())), None) => ChatEvent::Error { code: Some("aiChat.noResult".into()), message: "claude exited without a result".into() },
                (Ok(Err(e)), None) => ChatEvent::Error { code: e.coded().map(|c| c.code.to_owned()), message: e.to_string() },
                (Err(e), None) => ChatEvent::Error { code: None, message: e.to_string() },
            };
            let (status, answer, sid) = match &last {
                ChatEvent::Done { result, session_id, is_error } => (if *is_error { "error" } else { "done" }, if result.is_empty() { text } else { result.clone() }, session_id.clone()),
                ChatEvent::Cancelled => ("cancelled", text, None),
                _ => ("error", text, None),
            };
            if settings.chat_save {
                let entry = Entry { time: now_ms(), repo: repo.to_string_lossy().into_owned(), input, answer, commands, backup: backup.clone(), session_id: sid.or(session_id), status: status.into() };
                let (root, repo2, conv) = (me.chat_root(), repo.clone(), conversation.clone());
                if let Err(e) = off(move || ai_history::append(&root, &repo2, &conv, entry)).await {
                    // 사용자에게 알린다(마지막 이벤트 전에 `note`)
                    me.emit_chat(&conversation, &ChatEvent::Note { code: "aiChat.historySaveFailed".into(), message: e });
                }
            }
            me.ai.chats.lock().remove(&conversation);
            drop(_lock);
            me.emit_chat(&conversation, &last);
        });
        json(reply)
    }

    /// 이 저장소에서 AI 채팅을 시작하기 전 확인이 필요한가: `{level: none|public|shared|unknown, collaborators?}` (규칙은 `ai_risk.rs`)
    pub(crate) async fn ai_chat_risk_ipc(&self, repo: PathBuf) -> Res<Value> {
        json(self.ai_chat_risk(&repo).await?)
    }

    /// 진행 중인 채팅을 끝낸다(자식 프로세스 트리 kill). 마지막 이벤트는 `cancelled`. 없으면 무시.
    pub(crate) fn ai_chat_cancel(&self, conversation: &str) {
        if let Some(h) = self.ai.chats.lock().get(conversation) {
            h.cancel();
        }
    }

    /// 백업 HEAD로 되돌린다 (`gc_core::ai_backup::restore`: 안전 규칙은 그쪽 문서)
    /// 되돌릴 때의 백업 지문은 **UI가 준 값이 아니라** 이 프로세스가 만든 백업(없으면 이력)에 적힌 값으로 검사한다: UI가 `digest`를 빼먹어도·바꿔도 강제된다.
    /// 어느 쪽에도 없는 id는 거절(`aiBackup.missing`). 같은 저장소에서 AI 차례가 진행 중이면 `aiChat.busy`.
    pub(crate) async fn ai_backup_restore(&self, repo: PathBuf, id: String, branch: Option<String>, abort_ongoing: bool, branches: bool, wip: bool, _ui_digest: Option<String>) -> Res<Value> {
        let key = lock_key_blocking(&repo).await?;
        let known = self.ai.backups.lock().get(&(key.clone(), id.clone())).cloned();
        let known = match known {
            Some(b) => Some(b),
            None => {
                let (root, r, i) = (self.chat_root(), repo.clone(), id.clone());
                off(move || Ok(ai_history::find_backup(&root, &r, &i))).await?
            }
        };
        let Some(b) = known else { return Err(gc_i18n::coded!("aiBackup.missing", "Backup not found").json()) };
        let _lock = {
            let mut set = self.ai.repos.lock();
            if !set.insert(key.clone()) {
                return Err(gc_i18n::coded!("aiChat.busy", "This conversation is already running").json());
            }
            RepoLock { set: self.ai.repos.clone(), key }
        };
        gc_core::ai_backup::restore(&self.git, &repo, &id, branch.as_deref(), abort_ongoing, branches, wip, Some(&b.digest).filter(|d| !d.is_empty()).map(String::as_str)).await.map_err(|e| e.ipc())?;
        Ok(Value::Null)
    }

    pub(crate) async fn ai_history_list(&self, repo: PathBuf) -> Res<Value> {
        let root = self.chat_root();
        json(off(move || Ok(ai_history::list(&root, &repo))).await?)
    }

    pub(crate) async fn ai_history_read(&self, repo: PathBuf, conversation: String) -> Res<Value> {
        let root = self.chat_root();
        json(off(move || ai_history::read(&root, &repo, &conversation)).await?)
    }

    /// 저장소의 채팅 이력을 모두 지운다(그 이력의 백업 ref도 지운다)
    pub(crate) async fn ai_history_clear(&self, repo: PathBuf) -> Res<Value> {
        let root = self.chat_root();
        let gone = off(move || ai_history::clear(&root, &repo)).await?;
        self.drop_backups(gone).await;
        Ok(Value::Null)
    }

    /// 보관 기간(설정, 기본 90일)이 지난 대화를 지운다. 지운 대화 수가 아니라 `null`.
    pub(crate) async fn ai_history_prune(&self) -> Res<Value> {
        let days = self.ai.settings().await?.chat_retention_days;
        let root = self.chat_root();
        let gone = off(move || ai_history::prune(&root, days)).await?;
        self.drop_backups(gone).await;
        Ok(Value::Null)
    }

    /// 지운 이력의 백업 ref 정리 (저장소가 없어졌거나 ref가 이미 없으면 무시)
    async fn drop_backups(&self, gone: Vec<(String, gc_core::ai_backup::Backup)>) {
        for (repo, b) in gone {
            let _ = gc_core::ai_backup::delete(&self.git, std::path::Path::new(&repo), &b.id).await;
        }
    }

    pub(crate) async fn ai_chat_settings(&self) -> Res<Value> {
        let s = self.ai.settings().await?;
        Ok(json!({"save": s.chat_save, "retentionDays": s.chat_retention_days}))
    }

    pub(crate) async fn ai_chat_settings_set(&self, save: Option<bool>, retention_days: Option<u32>) -> Res<Value> {
        if retention_days == Some(0) {
            return Err(gc_i18n::coded!("aiChat.badRetention", "Retention must be at least 1 day").json());
        }
        self.ai.set_chat_settings(save, retention_days).await?;
        Ok(Value::Null)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::Emit;
    use gc_core::GitRunner;
    use parking_lot::Mutex;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;

    /// 지문(`fingerprint`·`configFp`)은 매번 달라 비교에서 뺀다
    fn no_fp(mut v: Value) -> Value {
        v.as_object_mut().unwrap().retain(|k, _| k != "fingerprint" && k != "configFp");
        v
    }

    impl Backend {
        /// 시험용: `confirmed`면 확인창에서 방금 판정을 본 것처럼 그 지문을 `seen`으로 넘긴다(실제 UI와 같은 흐름)
        async fn start_t(&self, program: &str, repo: PathBuf, conversation: String, input: String, session_id: Option<String>, confirmed: bool) -> Res<Value> {
            let seen = if confirmed {
                let r = self.ai_chat_risk(&repo).await?;
                Some(Seen { fingerprint: r.fingerprint, config_fp: r.config_fp })
            } else {
                None
            };
            self.ai_chat_start(program, repo, conversation, input, session_id, seen).await
        }
    }

    #[derive(Default)]
    struct Rec(Mutex<Vec<Value>>, Mutex<Vec<(String, Value)>>);
    impl Emit for Rec {
        fn emit(&self, event: &str, payload: Value) {
            if event == "ai-chat" {
                self.0.lock().push(payload);
            } else if event == "job" || event == "job-done" {
                self.1.lock().push((event.to_owned(), payload)); // 작업 이벤트(`job`·`job-done`)
            }
        }
    }
    impl Rec {
        /// 작업 번호의 `job` 이벤트 종류들(waiting·started·progress…)과 `job-done` 여부
        fn job_kinds(&self, job: u64) -> Vec<String> {
            self.1.lock().iter().filter_map(|(e, p)| match e.as_str() {
                "job" if p["job"] == job => p["event"]["kind"].as_str().map(String::from),
                "job-done" if p[0] == job => Some("done".to_owned()),
                _ => None,
            }).collect()
        }
        async fn job_done(&self, job: u64) -> Value {
            for _ in 0..300 {
                if let Some((_, p)) = self.1.lock().iter().find(|(e, p)| e == "job-done" && p[0] == job) {
                    return p[1].clone();
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            panic!("job-done이 오지 않음: {job}");
        }
        fn kinds(&self, conv: &str) -> Vec<String> {
            self.0.lock().iter().filter(|p| p["conversation"] == conv).map(|p| p["event"]["kind"].as_str().unwrap().to_owned()).collect()
        }
        async fn last(&self, conv: &str) -> Value {
            for _ in 0..300 {
                if let Some(p) = self.0.lock().iter().rev().find(|p| p["conversation"] == conv && ["done", "error", "cancelled"].contains(&p["event"]["kind"].as_str().unwrap())) {
                    return p["event"].clone();
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
            panic!("끝나지 않음: {:?}", self.0.lock());
        }
    }

    fn git(repo: &Path, args: &[&str]) -> String {
        let o = std::process::Command::new("git").current_dir(repo).args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).output().unwrap();
        String::from_utf8_lossy(&o.stdout).trim().to_owned()
    }

    /// (백엔드, 이벤트 기록, 저장소, 가짜 claude 폴더, 지우면 안 되는 임시 폴더들)
    async fn setup(script: &str) -> (Backend, Arc<Rec>, PathBuf, tempfile::TempDir, Vec<tempfile::TempDir>) {
        let cfg = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let rp = repo.path().canonicalize().unwrap();
        git(&rp, &["init", "-q", "-b", "main"]);
        git(&rp, &["commit", "-q", "--allow-empty", "-m", "init"]);
        let p = bin.path().join("claude");
        std::fs::write(&p, format!("#!/bin/sh\nD=\"{}\"\nprintf '%s\\n' \"$@\" > \"$D/args\"\npwd > \"$D/cwd\"\n{script}\n", bin.path().display())).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        let rec = Arc::new(Rec::default());
        let b = Backend::with_parts(GitRunner::default(), Default::default(), rec.clone(), cfg.path().to_path_buf(), None);
        b.ai.set_settings(None, None, None, Some(true), false, None).await.unwrap();
        (b, rec, rp, bin, vec![cfg, repo])
    }

    /// 이 컴퓨터가 쓰는 샌드박스 방식 이름
    fn sb() -> &'static str {
        crate::sandbox::Mode::detect().name()
    }
    /// 샌드박스가 없는 플랫폼은 로컬 전용 저장소도 매 대화 확인이 필요하다
    fn needs_sandbox_confirm() -> bool {
        sb() == "none"
    }

    const OK: &str = r#"cat <<'EOF'
{"type":"system","subtype":"init","session_id":"s1"}
not json noise
{"type":"assistant","message":{"content":[{"type":"text","text":"상태를 봅니다"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"git status"}}]},"parent_tool_use_id":null}
{"type":"user","message":{"content":[{"tool_use_id":"t1","type":"tool_result","content":"On branch main","is_error":false}]},"parent_tool_use_id":null}
{"type":"result","subtype":"success","is_error":false,"result":"깨끗합니다 ghp_abcdefghijklmnopqrstuvwxyz0123","session_id":"s1"}
EOF"#;

    fn prog(bin: &tempfile::TempDir) -> String {
        bin.path().join("claude").to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn run_streams_events_backs_up_head_and_saves_redacted_history() {
        let (b, rec, repo, bin, _keep) = setup(OK).await;
        let r = b.start_t(&prog(&bin), repo.clone(), "c1".into(), "상태 알려줘".into(), None, true).await.unwrap();
        let sha = git(&repo, &["rev-parse", "HEAD"]);
        assert_eq!((r["sha"].as_str(), r["branch"].as_str(), r["ref"].as_str().unwrap().starts_with("refs/git403/ai-backup/")), (Some(sha.as_str()), Some("main"), true));
        assert_eq!(git(&repo, &["rev-parse", r["ref"].as_str().unwrap()]), sha, "실행 전 HEAD가 ref에 저장됨");
        let last = rec.last("c1").await;
        assert_eq!((last["kind"].as_str(), last["sessionId"].as_str(), last["isError"].as_bool()), (Some("done"), Some("s1"), Some(false)));
        assert_eq!(rec.kinds("c1"), ["text", "tool", "toolResult", "done"]);
        let tool = rec.0.lock().iter().find(|p| p["event"]["kind"] == "tool").unwrap()["event"].clone();
        assert_eq!((tool["name"].as_str(), tool["command"].as_str()), (Some("Bash"), Some("git status")));
        // 인자·작업 폴더
        let args = std::fs::read_to_string(bin.path().join("args")).unwrap();
        assert!(args.starts_with("-p\n상태 알려줘\n--output-format\nstream-json\n--verbose\n--restricted\n--tools\n\n--strict-mcp-config\n--mcp-config\n{"), "{args}");
        assert!(args.contains("--allowedTools\nmcp__git403__git\nmcp__git403__read_file\nmcp__git403__edit_file"), "{args}");
        assert!(!args.contains("Bash") && !args.contains("--resume") && !args.contains("--disallowedTools") && args.contains("--git403-mcp"), "{args}");
        // MCP 설정: 이 실행 파일을 서버로, 저장소를 인자로, git 자식 환경은 별도 변수로
        let cfg: Value = serde_json::from_str(args.lines().skip_while(|l| *l != "--mcp-config").nth(1).unwrap()).unwrap();
        let srv = &cfg["mcpServers"]["git403"];
        assert_eq!((srv["args"][0].as_str(), srv["args"][1].as_str()), (Some("--git403-mcp"), Some(repo.to_str().unwrap())));
        assert!(srv["env"]["GIT403_GIT"].is_string() && srv["env"]["GIT403_GIT_ENV"].is_string(), "{srv}");
        assert_eq!(std::fs::read_to_string(bin.path().join("cwd")).unwrap().trim(), repo.to_string_lossy());
        // Done 이벤트가 나갈 때는 이력이 이미 저장돼 있다 + 가림
        let h = b.ai_history_read(repo.clone(), "c1".into()).await.unwrap();
        assert_eq!((h[0]["input"].as_str(), h[0]["status"].as_str(), h[0]["sessionId"].as_str(), h[0]["commands"][0].as_str()), (Some("상태 알려줘"), Some("done"), Some("s1"), Some("Bash: git status")));
        assert_eq!(h[0]["answer"], "깨끗합니다 ***");
        assert_eq!(h[0]["backup"]["ref"], r["ref"]);
        assert!(h[0]["time"].as_u64().unwrap() > 0);
        let l = b.ai_history_list(repo.clone()).await.unwrap();
        assert_eq!((l[0]["conversation"].as_str(), l[0]["title"].as_str(), l[0]["turns"].as_u64()), (Some("c1"), Some("상태 알려줘"), Some(1)));
    }

    #[tokio::test]
    async fn second_turn_resumes_session_and_busy_or_unconsented_is_rejected() {
        let (b, rec, repo, bin, _keep) = setup(OK).await;
        b.start_t(&prog(&bin), repo.clone(), "c".into(), "하나".into(), None, true).await.unwrap();
        rec.last("c").await;
        b.start_t(&prog(&bin), repo.clone(), "c".into(), "둘".into(), Some("s1".into()), true).await.unwrap();
        for _ in 0..300 {
            if rec.kinds("c").iter().filter(|k| *k == "done").count() == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        let args = std::fs::read_to_string(bin.path().join("args")).unwrap();
        assert!(args.ends_with("--resume\ns1\n") && args.starts_with("-p\n둘\n"), "{args}");
        let l = b.ai_history_list(repo.clone()).await.unwrap();
        assert_eq!((l.as_array().unwrap().len(), l[0]["turns"].as_u64(), l[0]["title"].as_str()), (1, Some(2), Some("하나")));
        // 동의 없음 / 잘못된 id / 빈 입력
        b.ai.set_settings(None, None, None, Some(false), false, None).await.unwrap();
        let e = b.start_t(&prog(&bin), repo.clone(), "x".into(), "a".into(), None, true).await.unwrap_err();
        assert!(e.contains("ai.consentRequired"), "{e}");
        b.ai.set_settings(None, None, None, Some(true), false, None).await.unwrap();
        assert!(b.start_t(&prog(&bin), repo.clone(), "../x".into(), "a".into(), None, true).await.unwrap_err().contains("aiChat.badId"));
        assert!(b.start_t(&prog(&bin), repo.clone(), "x".into(), "  ".into(), None, true).await.unwrap_err().contains("aiChat.emptyInput"));
    }

    #[tokio::test]
    async fn busy_conversation_is_rejected_and_cancel_kills_the_process_tree() {
        let (b, rec, repo, bin, _keep) = setup("echo '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"작업 중\"}]},\"parent_tool_use_id\":null}'\nsleep 60 &\necho $! > \"$D/pid\"\nwait").await;
        b.start_t(&prog(&bin), repo.clone(), "c".into(), "오래 걸리는 일".into(), None, true).await.unwrap();
        for _ in 0..300 {
            if rec.kinds("c").contains(&"text".to_string()) && bin.path().join("pid").exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        let pid: i32 = std::fs::read_to_string(bin.path().join("pid")).unwrap().trim().parse().unwrap();
        let e = b.start_t(&prog(&bin), repo.clone(), "c".into(), "또".into(), None, true).await.unwrap_err();
        assert!(e.contains("aiChat.busy"), "{e}");
        b.ai_chat_cancel("c");
        assert_eq!(rec.last("c").await["kind"], "cancelled");
        // SAFETY: 신호 0은 존재 확인만 한다.
        let mut gone = false;
        for _ in 0..100 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        assert!(gone, "손자 프로세스가 남음");
        let h = b.ai_history_read(repo.clone(), "c".into()).await.unwrap();
        assert_eq!((h[0]["status"].as_str(), h[0]["answer"].as_str()), (Some("cancelled"), Some("작업 중")));
        b.ai_chat_cancel("none"); // 없는 대화의 취소는 무시
    }

    #[tokio::test]
    async fn failures_become_error_events_and_missing_cli_is_coded_and_leaves_no_backup() {
        let (b, rec, repo, bin, _keep) = setup("echo boom >&2\nexit 3").await;
        b.start_t(&prog(&bin), repo.clone(), "e".into(), "x".into(), None, true).await.unwrap();
        let last = rec.last("e").await;
        assert_eq!(last["kind"], "error");
        assert!(last["message"].as_str().unwrap().contains("boom"), "{last}");
        assert_eq!(b.ai_history_read(repo.clone(), "e".into()).await.unwrap()[0]["status"], "error");
        // result가 is_error인 경우(로그인 안 됨 등)는 done{isError:true}
        std::fs::write(bin.path().join("claude"), "#!/bin/sh\necho '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true,\"result\":\"Not logged in\",\"session_id\":\"s\"}'\nexit 1\n").unwrap();
        b.start_t(&prog(&bin), repo.clone(), "e2".into(), "x".into(), None, true).await.unwrap();
        let last = rec.last("e2").await;
        assert_eq!((last["kind"].as_str(), last["isError"].as_bool(), last["result"].as_str()), (Some("done"), Some(true), Some("Not logged in")));
        assert_eq!(rec.kinds("e2"), ["done"], "오류가 두 번 나가지 않는다");
        // CLI 없음
        let before = git(&repo, &["for-each-ref", "refs/git403"]);
        let e = b.start_t("/nonexistent/claude", repo.clone(), "m".into(), "x".into(), None, true).await.unwrap_err();
        assert!(e.contains("aiChat.cliMissing"), "{e}");
        let after = git(&repo, &["for-each-ref", "refs/git403"]);
        assert_eq!(after.lines().count(), before.lines().count(), "실패한 시작의 백업 ref는 지운다");
    }

    #[tokio::test]
    async fn history_off_saves_nothing_and_clear_and_prune_drop_backup_refs() {
        let (b, rec, repo, bin, _keep) = setup(OK).await;
        assert_eq!(b.ai_chat_settings().await.unwrap(), json!({"save": true, "retentionDays": 90}));
        b.ai_chat_settings_set(Some(false), None).await.unwrap();
        b.start_t(&prog(&bin), repo.clone(), "off".into(), "저장 안 함".into(), None, true).await.unwrap();
        rec.last("off").await;
        assert!(b.ai_history_list(repo.clone()).await.unwrap().as_array().unwrap().is_empty());
        assert!(b.ai_chat_settings_set(None, Some(0)).await.unwrap_err().contains("aiChat.badRetention"));
        b.ai_chat_settings_set(Some(true), Some(7)).await.unwrap();
        assert_eq!(b.ai_chat_settings().await.unwrap(), json!({"save": true, "retentionDays": 7}));
        // clear: 이력과 그 백업 ref가 같이 사라진다
        let refs = || git(&repo, &["for-each-ref", "--format=%(refname)", "refs/git403/ai-backup"]);
        b.start_t(&prog(&bin), repo.clone(), "k".into(), "지울 대화".into(), None, true).await.unwrap();
        rec.last("k").await;
        assert_eq!(refs().lines().count(), 2, "저장 끈 실행의 백업(남음) + 이 실행");
        b.ai_history_clear(repo.clone()).await.unwrap();
        assert!(b.ai_history_list(repo.clone()).await.unwrap().as_array().unwrap().is_empty());
        assert_eq!(refs().lines().count(), 1, "이력이 있던 백업만 지워진다");
        // prune: 보관 기간(7일)이 지난 대화만
        b.start_t(&prog(&bin), repo.clone(), "old".into(), "옛 대화".into(), None, true).await.unwrap();
        rec.last("old").await;
        b.start_t(&prog(&bin), repo.clone(), "new".into(), "새 대화".into(), None, true).await.unwrap();
        rec.last("new").await;
        let dir = std::fs::read_dir(b.chat_root()).unwrap().flatten().next().unwrap().path();
        let f = std::fs::File::options().write(true).open(dir.join("old.jsonl")).unwrap();
        f.set_modified(std::time::SystemTime::now() - Duration::from_secs(8 * 86_400)).unwrap();
        let n = refs().lines().count();
        b.ai_history_prune().await.unwrap();
        let l = b.ai_history_list(repo.clone()).await.unwrap();
        assert_eq!(l.as_array().unwrap().iter().map(|s| s["conversation"].as_str().unwrap()).collect::<Vec<_>>(), ["new"]);
        assert_eq!(refs().lines().count(), n - 1);
    }

    #[tokio::test]
    async fn restore_ipc_returns_to_backup_head() {
        let (b, rec, repo, bin, _keep) = setup(&format!("cd \"$(pwd)\" && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m ai-commit\n{OK}")).await;
        let before = git(&repo, &["rev-parse", "HEAD"]);
        let r = b.start_t(&prog(&bin), repo.clone(), "r".into(), "커밋해".into(), None, true).await.unwrap();
        rec.last("r").await;
        assert_ne!(git(&repo, &["rev-parse", "HEAD"]), before, "가짜 claude가 커밋을 만들었다");
        b.ai_backup_restore(repo.clone(), r["id"].as_str().unwrap().into(), Some("main".into()), false, false, false, None).await.unwrap();
        assert_eq!(git(&repo, &["rev-parse", "HEAD"]), before);
    }

    #[tokio::test]
    async fn confirmation_is_enforced_by_the_backend_except_for_local_only_repos_and_follow_up_turns() {
        let (b, rec, repo, bin, _keep) = setup(OK).await;
        // 로컬 전용(원격 없음): 확인 없이 진행
        assert_eq!(b.ai_chat_risk(&repo).await.unwrap().level, crate::ai_risk::Level::None);
        b.start_t(&prog(&bin), repo.clone(), "local".into(), "a".into(), None, needs_sandbox_confirm()).await.unwrap(); // 샌드박스가 있으면 확인 없이 진행(없는 플랫폼은 확인 필요)
        rec.last("local").await;
        // 판정 불가(GitHub가 아닌 원격·해석 못 하는 원격) = 위험: confirmed 없이는 거절, 프로세스도 안 뜬다
        // 같은 컴퓨터의 경로·file:// 원격은 로컬 전용이 아니라 **거절**(대상 저장소 설정이 push·fetch 때 실행될 수 있다): 확인(`confirmed`)으로도 시작할 수 없다
        for url in ["/some/local/path.git", "file:///x.git", "../rel.git"] {
            git(&repo, &["remote", "remove", "origin"]);
            git(&repo, &["remote", "add", "origin", url]);
            let r = b.ai_chat_risk(&repo).await.unwrap();
            assert!(r.refuse.iter().any(|x| x.contains("local path")), "{url}: {r:?}");
            for confirmed in [false, true] {
                let e = b.start_t(&prog(&bin), repo.clone(), "loc".into(), "a".into(), None, confirmed).await.unwrap_err();
                assert!(e.contains("aiChat.configRefused") && e.contains("local path"), "{url}: {e}");
            }
            assert!(rec.kinds("loc").is_empty());
        }
        for url in ["https://gitlab.com/o/r.git", "https://example.com/x/y.git"] {
            git(&repo, &["remote", "remove", "origin"]);
            git(&repo, &["remote", "add", "origin", url]);
            assert_eq!(no_fp(b.ai_chat_risk_ipc(repo.clone()).await.unwrap()), json!({"level": "unknown", "sandbox": sb()}), "{url}");
        }
        let _ = std::fs::remove_file(bin.path().join("args"));
        let e = b.start_t(&prog(&bin), repo.clone(), "risky".into(), "a".into(), None, false).await.unwrap_err();
        assert!(e.contains("aiChat.confirmRequired") && e.contains("unknown"), "{e}");
        assert!(!bin.path().join("args").exists() && rec.kinds("risky").is_empty(), "거절되면 실행하지 않는다");
        assert!(git(&repo, &["for-each-ref", "refs/git403/ai-backup"]).lines().count() <= 1, "거절된 시작은 백업도 만들지 않는다");
        // 확인하면 진행, 같은 대화의 다음 차례는 다시 묻지 않는다. 다른 대화는 다시 묻는다
        b.start_t(&prog(&bin), repo.clone(), "risky".into(), "a".into(), None, true).await.unwrap();
        rec.last("risky").await;
        b.start_t(&prog(&bin), repo.clone(), "risky".into(), "b".into(), Some("s1".into()), false).await.unwrap();
        for _ in 0..300 {
            if rec.kinds("risky").iter().filter(|k| *k == "done").count() == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        assert_eq!(rec.kinds("risky").iter().filter(|k| *k == "done").count(), 2);
        let e = b.start_t(&prog(&bin), repo.clone(), "other".into(), "a".into(), None, false).await.unwrap_err();
        assert!(e.contains("aiChat.confirmRequired"), "{e}");
    }

    #[tokio::test]
    async fn risk_looks_at_pushurl_and_insteadof_and_asks_again_when_remotes_change() {
        let (b, rec, repo, bin, _keep) = setup(OK).await;
        use crate::ai_risk::Level;
        git(&repo, &["remote", "add", "origin", "https://gitlab.com/o/r.git"]);
        assert_eq!(b.ai_chat_risk(&repo).await.unwrap().level, Level::Unknown);
        // pushurl이 로컬 경로면 거기로 보내므로 거절
        git(&repo, &["remote", "set-url", "--push", "origin", "/srv/git/local.git"]);
        assert!(!b.ai_chat_risk(&repo).await.unwrap().refuse.is_empty());
        git(&repo, &["config", "--unset", "remote.origin.pushurl"]);
        assert!(b.ai_chat_risk(&repo).await.unwrap().refuse.is_empty());
        // insteadOf: 호스팅처럼 보이는 URL이 로컬 경로로 치환되면 치환 뒤 값으로 판정해 거절
        git(&repo, &["config", "url./srv/git/.insteadOf", "https://gitlab.com/"]);
        assert!(!b.ai_chat_risk(&repo).await.unwrap().refuse.is_empty());
        git(&repo, &["config", "--unset", "url./srv/git/.insteadOf"]);
        // 다른 호스팅 주소로 치환되면 그 주소로 판정
        git(&repo, &["config", "url.https://example.com/.insteadOf", "https://gitlab.com/"]);
        assert_eq!(b.ai_chat_risk(&repo).await.unwrap().level, Level::Unknown);
        git(&repo, &["config", "--unset", "url.https://example.com/.insteadOf"]);
        // 확인한 뒤 원격이 바뀌면 같은 대화도 다시 확인을 요구한다
        git(&repo, &["remote", "set-url", "origin", "https://gitlab.com/o/r.git"]);
        b.start_t(&prog(&bin), repo.clone(), "fp".into(), "a".into(), None, true).await.unwrap();
        rec.last("fp").await;
        b.start_t(&prog(&bin), repo.clone(), "fp".into(), "b".into(), Some("s1".into()), false).await.unwrap();
        for _ in 0..300 {
            if rec.kinds("fp").iter().filter(|k| *k == "done").count() == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        git(&repo, &["remote", "set-url", "origin", "https://gitlab.com/o/other.git"]);
        let e = b.start_t(&prog(&bin), repo.clone(), "fp".into(), "c".into(), Some("s1".into()), false).await.unwrap_err();
        assert!(e.contains("aiChat.confirmRequired"), "{e}");
    }

    #[tokio::test]
    async fn local_repo_with_executable_config_needs_confirmation() {
        let (b, rec, repo, bin, _keep) = setup(OK).await;
        // 깨끗한 로컬 전용 저장소: 확인 없음
        assert!(b.ai_chat_risk(&repo).await.unwrap().config.is_empty());
        // 표준 LFS 필터 정의는 실행형으로 보지 않는다
        git(&repo, &["config", "filter.lfs.clean", "git-lfs clean -- %f"]);
        git(&repo, &["config", "filter.lfs.smudge", "git-lfs smudge -- %f"]);
        git(&repo, &["config", "filter.lfs.process", "git-lfs filter-process"]);
        assert!(b.ai_chat_risk(&repo).await.unwrap().config.is_empty());
        // 저장소 로컬 textconv, include된 파일의 sshCommand
        git(&repo, &["config", "diff.evil.textconv", "sh -c id"]);
        std::fs::write(repo.join(".git/extra.cfg"), "[core]\n\tsshCommand = ssh -v\n").unwrap();
        git(&repo, &["config", "include.path", "extra.cfg"]);
        let r = b.ai_chat_risk(&repo).await.unwrap();
        assert_eq!((r.level, r.config.clone()), (crate::ai_risk::Level::None, vec!["core.sshcommand".to_string(), "diff.evil.textconv".to_string(), "include.path".to_string()]));
        let mut ipc = b.ai_chat_risk_ipc(repo.clone()).await.unwrap();
        assert!(ipc["fingerprint"].is_string() && ipc["configFp"].as_str().is_some_and(|f| f.len() == 16), "UI가 seen으로 돌려보낼 지문: {ipc}");
        ipc.as_object_mut().unwrap().retain(|k, _| k != "fingerprint" && k != "configFp");
        assert_eq!(ipc, json!({"level": "none", "config": ["core.sshcommand", "diff.evil.textconv", "include.path"], "sandbox": sb()}));
        let e = b.start_t(&prog(&bin), repo.clone(), "ex".into(), "a".into(), None, false).await.unwrap_err();
        assert!(e.contains("aiChat.confirmRequired") && e.contains("\"config\":\"3\""), "{e}");
        b.start_t(&prog(&bin), repo.clone(), "ex".into(), "a".into(), None, true).await.unwrap();
        rec.last("ex").await;
        // 확인 뒤 실행형 설정이 늘면 같은 대화도 다시 묻는다
        git(&repo, &["config", "filter.x.clean", "sh -c id"]);
        let e = b.start_t(&prog(&bin), repo.clone(), "ex".into(), "b".into(), Some("s1".into()), false).await.unwrap_err();
        assert!(e.contains("aiChat.confirmRequired"), "{e}");
    }

    #[tokio::test]
    async fn backup_restore_ipc_can_restore_other_branches_and_snapshot() {
        let (b, rec, repo, bin, _keep) = setup(OK).await;
        git(&repo, &["branch", "dev"]);
        std::fs::write(repo.join("w.txt"), "mine\n").unwrap();
        let dev0 = git(&repo, &["rev-parse", "dev"]);
        let r = b.start_t(&prog(&bin), repo.clone(), "bk".into(), "a".into(), None, true).await.unwrap();
        rec.last("bk").await;
        assert_eq!((r["heads"].as_u64(), r["wip"].is_string()), (Some(2), true));
        git(&repo, &["branch", "-D", "dev"]);
        std::fs::write(repo.join("w.txt"), "ai\n").unwrap();
        let id = r["id"].as_str().unwrap().to_string();
        b.ai_backup_restore(repo.clone(), id, Some("main".into()), false, true, true, None).await.unwrap();
        assert_eq!(git(&repo, &["rev-parse", "dev"]), dev0);
        assert_eq!(std::fs::read_to_string(repo.join("w.txt")).unwrap(), "mine\n");
    }

    /// 샌드박스가 없는 플랫폼(Windows·bubblewrap 없는 Linux)은 로컬 전용·깨끗한 저장소도 매 대화 확인이 필요하다 — 백엔드가 강제한다
    #[tokio::test]
    async fn without_a_sandbox_every_conversation_needs_confirmation() {
        let (b, rec, repo, bin, _keep) = setup(OK).await;
        crate::sandbox::tests_force_none::set(true);
        let r = b.ai_chat_risk(&repo).await.unwrap();
        assert_eq!((r.level, r.sandbox, r.config.is_empty(), r.refuse.is_empty()), (crate::ai_risk::Level::None, "none", true, true));
        assert_eq!(no_fp(b.ai_chat_risk_ipc(repo.clone()).await.unwrap()), json!({"level": "none", "sandbox": "none"}));
        let e = b.start_t(&prog(&bin), repo.clone(), "ns".into(), "a".into(), None, false).await.unwrap_err();
        assert!(e.contains("aiChat.confirmRequired"), "{e}");
        assert!(rec.kinds("ns").is_empty());
        b.start_t(&prog(&bin), repo.clone(), "ns".into(), "a".into(), None, true).await.unwrap();
        rec.last("ns").await;
        // 서버에는 none이 전달된다(앱이 확인을 받은 경우에만)
        let args = std::fs::read_to_string(bin.path().join("args")).unwrap();
        assert!(args.contains("\"GIT403_SANDBOX\":\"none\""), "{args}");
        // 같은 대화의 다음 차례는 다시 묻지 않는다
        b.start_t(&prog(&bin), repo.clone(), "ns".into(), "b".into(), Some("s1".into()), false).await.unwrap();
        crate::sandbox::tests_force_none::set(false);
    }

    #[tokio::test]
    async fn the_detected_sandbox_mode_is_passed_to_the_server() {
        let (b, rec, repo, bin, _keep) = setup(OK).await;
        b.start_t(&prog(&bin), repo.clone(), "sm".into(), "a".into(), None, true).await.unwrap();
        rec.last("sm").await;
        let args = std::fs::read_to_string(bin.path().join("args")).unwrap();
        assert!(args.contains(&format!("\"GIT403_SANDBOX\":\"{}\"", sb())), "{args}");
    }

    /// 9차 L1: UI가 "확인했다"고 해도 확인창에서 본 지문이 지금 판정과 같을 때만 인정한다(저장소가 바뀌었거나 지문이 없으면 거절)
    #[tokio::test]
    async fn confirmation_counts_only_when_the_seen_fingerprints_match() {
        let (b, rec, repo, bin, _keep) = setup(OK).await;
        git(&repo, &["remote", "add", "origin", "https://gitlab.com/o/r.git"]); // 판정 불가 = 확인 필요
        let r = b.ai_chat_risk(&repo).await.unwrap();
        let seen = |f: &str, c: &str| Some(Seen { fingerprint: f.into(), config_fp: c.into() });
        for (name, s) in [("none", None), ("stale-remote", seen("0000000000000000", &r.config_fp)), ("stale-config", seen(&r.fingerprint, "0000000000000000"))] {
            let e = b.ai_chat_start(&prog(&bin), repo.clone(), "l1".into(), "a".into(), None, s).await.unwrap_err();
            assert!(e.contains("aiChat.confirmRequired"), "{name}: {e}");
        }
        // 확인 뒤(UI가 들고 있는 confirmed=true) 저장소 설정이 바뀐 경우: 옛 지문으로는 통과하지 못한다
        b.ai_chat_start(&prog(&bin), repo.clone(), "l1".into(), "a".into(), None, seen(&r.fingerprint, &r.config_fp)).await.unwrap();
        rec.last("l1").await;
        git(&repo, &["config", "filter.x.clean", "sh -c id"]);
        let e = b.ai_chat_start(&prog(&bin), repo.clone(), "l1".into(), "b".into(), Some("s".into()), seen(&r.fingerprint, &r.config_fp)).await.unwrap_err();
        assert!(e.contains("aiChat.confirmRequired"), "{e}");
        let r2 = b.ai_chat_risk(&repo).await.unwrap();
        b.ai_chat_start(&prog(&bin), repo.clone(), "l1".into(), "b".into(), Some("s".into()), seen(&r2.fingerprint, &r2.config_fp)).await.unwrap();
    }

    /// 9차 L2: 같은 저장소(다른 철자의 경로 포함)에서는 대화가 달라도 AI 차례를 동시에 돌리지 않는다. 끝나면 풀린다
    #[tokio::test]
    async fn only_one_ai_turn_runs_per_repository() {
        let (b, rec, repo, bin, _keep) = setup("sleep 3\n").await;
        b.start_t(&prog(&bin), repo.clone(), "one".into(), "a".into(), None, true).await.unwrap();
        let alias = repo.join(".").join("..").join(repo.file_name().unwrap());
        for p in [repo.clone(), alias] {
            let e = b.start_t(&prog(&bin), p, "two".into(), "b".into(), None, true).await.unwrap_err();
            assert!(e.contains("aiChat.busy"), "{e}");
        }
        // 되돌리기도 차례가 도는 동안은 거절
        let id = b.ai.backups.lock().keys().next().unwrap().1.clone();
        let e = b.ai_backup_restore(repo.clone(), id, None, false, false, false, None).await.unwrap_err();
        assert!(e.contains("aiChat.busy"), "{e}");
        b.ai_chat_cancel("one");
        rec.last("one").await;
        b.start_t(&prog(&bin), repo.clone(), "two".into(), "b".into(), None, true).await.unwrap();
        b.ai_chat_cancel("two");
        rec.last("two").await;
    }

    /// 9차 L3: 되돌리기는 UI가 주는 digest가 아니라 백엔드가 가진 백업(메모리·이력)의 digest로 검사한다(UI가 빼먹거나 속여도 강제, 모르는 id는 거절)
    #[tokio::test]
    async fn restore_enforces_the_digest_from_the_backend_not_the_ui() {
        let (b, rec, repo, bin, _keep) = setup(OK).await;
        let r = b.start_t(&prog(&bin), repo.clone(), "d1".into(), "a".into(), None, true).await.unwrap();
        rec.last("d1").await;
        let id = r["id"].as_str().unwrap().to_string();
        // 백업 ref를 바꿔치기: UI가 digest를 안 줘도·거짓 digest를 줘도 거절된다
        let evil = git(&repo, &["commit-tree", "HEAD^{tree}", "-m", "evil"]);
        git(&repo, &["update-ref", &format!("refs/git403/ai-backup/{id}"), &evil]);
        for ui in [None, Some("0000000000000000".to_string()), Some(r["digest"].as_str().unwrap().to_string())] {
            let e = b.ai_backup_restore(repo.clone(), id.clone(), Some("main".into()), false, false, false, ui).await.unwrap_err();
            assert!(!e.is_empty() && git(&repo, &["rev-parse", "HEAD"]) != evil, "{e}");
        }
        // 모르는 id
        let e = b.ai_backup_restore(repo.clone(), "bnope".into(), None, false, false, false, None).await.unwrap_err();
        assert!(e.contains("aiBackup.missing"), "{e}");
    }
    /// 백엔드 강제(repo_gate.rs): AI 차례가 도는 저장소에는 쓰기 IPC가 모두 `aiChat.repoBusy`로 거절되고, 읽기·AI 자신의 명령·다른 저장소는 통과하며, 차례가 끝나면 다시 된다
    #[tokio::test]
    async fn writes_to_the_repository_are_refused_while_an_ai_turn_runs() {
        use serde_json::json;
        let (b, rec, repo, bin, keep) = setup("sleep 20\n").await;
        let other = tempfile::tempdir().unwrap();
        let op = other.path().canonicalize().unwrap();
        git(&op, &["init", "-q", "-b", "main"]);
        git(&op, &["commit", "-q", "--allow-empty", "-m", "o"]);
        let busy = |e: &str| e.contains("aiChat.repoBusy");
        // 차례 전에는 쓰기가 된다
        b.dispatch("git", json!({"repo": repo, "args": ["tag", "before"]})).await.unwrap();
        b.start_t(&prog(&bin), repo.clone(), "g1".into(), "a".into(), None, true).await.unwrap();
        let r = repo.to_string_lossy().into_owned();

        // 1. 쓰기 IPC 전체(목록 순회)와 git 쓰기 인자
        for cmd in crate::repo_gate::WRITES {
            if matches!(*cmd, "start_job" | "start_shell") {
                continue; // 자기 등록을 직접 하는 작업 명령: 인자를 갖춘 아래 시험이 본다
            }
            let e = b.dispatch(cmd, json!({"repo": r})).await.err().unwrap_or_default();
            // AI 차례와 무관한 전역 설정은 `repo`가 없어야 막히지 않는다: 이 목록은 repo를 줬으므로 모두 막혀야 한다
            assert!(busy(&e), "{cmd}: {e}");
        }
        for argv in [
            &["commit", "-m", "x"][..], &["fetch"], &["pull"], &["push"], &["checkout", "main"], &["tag", "t"], &["branch", "x"], &["stash"], &["reset", "--hard"], &["remote", "-v", "update"],
            &["remote", "add", "o", "u"], &["remote", "show", "origin"], &["symbolic-ref", "-d", "HEAD"], &["config", "user.name", "x"], &["log", "--output=x"], &["format-patch", "-o", "d", "-1"],
            &["--no-pager", "commit", "--allow-empty", "-m", "x"], &["-P", "-c", "a=b", "commit"], &["unknown-subcommand"],
        ] {
            for cmd in ["git", "run_detached"] {
                let e = b.dispatch(cmd, json!({"repo": r, "args": argv, "token": "t"})).await.err().unwrap_or_default();
                assert!(busy(&e), "{cmd} {argv:?}: {e}");
            }
        }
        // repo가 객체(PR)이거나 localRepo로 가리켜도, start_job·start_shell도
        for cmd in ["pr_create", "pr_review_submit"] {
            let e = b.dispatch(cmd, json!({"repo": {"owner": "o", "name": "n"}, "localRepo": r})).await.err().unwrap_or_default();
            assert!(busy(&e), "{cmd}: {e}");
        }
        for cmd in ["start_job", "start_shell"] {
            let e = b.dispatch(cmd, json!({"repo": r, "args": ["fetch"], "command": "true"})).await.err().unwrap_or_default();
            assert!(busy(&e), "{cmd}: {e}");
        }

        // 2. 경로 변형으로 우회할 수 없다: 끝 `/`, `.`·`..`, 심볼릭 링크, 하위 폴더, `-C`·`--git-dir`·`--work-tree`
        std::fs::create_dir(repo.join("sub")).unwrap();
        let link = op.join("alias");
        std::os::unix::fs::symlink(&repo, &link).unwrap();
        let name = repo.file_name().unwrap().to_string_lossy().into_owned();
        let variants = [
            format!("{r}/"), format!("{r}//"), format!("{r}/."), format!("{r}/sub/.."), format!("{r}/sub/../sub/.."), format!("{}/../{}", repo.display(), name), link.to_string_lossy().into_owned(),
            format!("{}/", link.display()), format!("{r}/sub"), format!("{}/sub/..", link.display()),
        ];
        for v in &variants {
            let e = b.dispatch("commit", json!({"repo": v, "message": "x", "amend": false})).await.unwrap_err();
            assert!(busy(&e), "repo={v}: {e}");
            let e = b.dispatch("git", json!({"repo": v, "args": ["tag", "t"]})).await.unwrap_err();
            assert!(busy(&e), "git repo={v}: {e}");
        }
        let o = op.to_string_lossy().into_owned();
        for argv in [
            vec!["-C".to_string(), r.clone(), "tag".into(), "t".into()],
            vec!["-C".into(), format!("{r}/"), "tag".into(), "t".into()],
            vec!["-C".into(), link.to_string_lossy().into_owned(), "tag".into(), "t".into()],
            vec!["-C".into(), "..".into(), "-C".into(), name.clone(), "tag".into(), "t".into()],
            vec![format!("--git-dir={r}/.git"), "tag".into(), "t".into()],
            vec!["--git-dir".into(), format!("{r}/.git"), "--work-tree".into(), r.clone(), "tag".into(), "t".into()],
            vec!["-c".into(), format!("core.worktree={r}"), "tag".into(), "t".into()],
        ] {
            // 다른(영향 없는) 저장소를 repo로 주고 AI 저장소를 -C 등으로 가리킨다
            let cwd = if argv.get(1).is_some_and(|a| a == "..") { repo.join("sub") } else { op.clone() };
            let e = b.dispatch("git", json!({"repo": cwd, "args": argv})).await.unwrap_err();
            assert!(busy(&e), "{argv:?}: {e}");
        }

        // 3. 읽기 IPC는 통과(목록 순회: 게이트가 통과시킨다)하고, 실제 읽기도 된다
        for cmd in ["load_status", "load_refs", "load_graph", "file_diff", "jj_status", "repo_stats", "watch_add", "ai_chat_risk", "ai_history_list", "pr_list", "remote_info"] {
            assert!(b.begin_write(cmd, &json!({"repo": r})).await.is_ok(), "{cmd}");
        }
        b.dispatch("load_status", json!({"repo": r})).await.unwrap();
        b.dispatch("load_refs", json!({"repo": r})).await.unwrap();
        for argv in [&["status", "--porcelain"][..], &["log", "-1", "--format=%H"], &["--no-pager", "diff"], &["describe", "--always", "--dirty"], &["config", "--get", "user.name"], &["remote", "-v"], &["remote", "show", "-n", "origin"]] {
            let _ = b.dispatch("git", json!({"repo": r, "args": argv, "ok": [1, 128]})).await.map_err(|e| assert!(!busy(&e), "{argv:?}: {e}"));
        }
        // AI 자신의 명령은 막지 않는다(같은 저장소에서 두 번째 차례는 `aiChat.busy`로 거절되지만 repoBusy는 아니다)
        let e = b.dispatch("ai_chat_start", json!({"repo": r, "conversation": "g2", "input": "x"})).await.unwrap_err();
        assert!(!busy(&e), "{e}");
        b.dispatch("ai_chat_cancel", json!({"conversation": "nope"})).await.unwrap();

        // 4. 다른 저장소는 영향이 없다 (쓰기 포함)
        b.dispatch("git", json!({"repo": o, "args": ["tag", "other-ok"]})).await.unwrap();
        assert_eq!(git(&op, &["tag", "-l", "other-ok"]), "other-ok");
        b.dispatch("git", json!({"repo": o, "args": ["-C", o, "tag", "other-ok2"]})).await.unwrap();
        // 이름이 앞부분만 같은 저장소(`<repo>2`)도 영향이 없다
        let sibling = repo.with_file_name(format!("{name}2"));
        std::fs::create_dir(&sibling).unwrap();
        git(&sibling, &["init", "-q", "-b", "main"]);
        git(&sibling, &["commit", "-q", "--allow-empty", "-m", "s"]);
        b.dispatch("git", json!({"repo": sibling, "args": ["tag", "sib-ok"]})).await.unwrap();
        assert_eq!(git(&sibling, &["tag", "-l", "sib-ok"]), "sib-ok");
        std::fs::remove_dir_all(&sibling).unwrap();
        // 막힌 쓰기는 저장소를 바꾸지 않았다
        assert_eq!(git(&repo, &["tag", "-l"]), "before");

        // 5. 차례가 끝나면 다시 된다
        b.ai_chat_cancel("g1");
        rec.last("g1").await;
        b.dispatch("git", json!({"repo": r, "args": ["tag", "after"]})).await.unwrap();
        assert_eq!(git(&repo, &["tag", "-l"]), "after\nbefore");
        drop(keep);
    }
    /// 같은 저장소의 연결된 worktree(`git worktree add`)는 본 저장소와 같은 잠금이다 — 양방향. (AI 차례는 worktree에서 시작할 수 없으므로(설정 판정) 반대 방향은 잠금 키를 직접 넣어 확인한다)
    #[tokio::test]
    async fn linked_worktrees_share_the_ai_turn_lock_in_both_directions() {
        use serde_json::json;
        let (b, rec, repo, bin, keep) = setup("sleep 20\n").await;
        let wt = repo.with_file_name(format!("{}-wt", repo.file_name().unwrap().to_string_lossy()));
        git(&repo, &["worktree", "add", "-q", "-b", "wt", wt.to_str().unwrap()]);
        let wt = wt.canonicalize().unwrap();
        std::fs::create_dir(wt.join("sub")).unwrap();
        let busy = |e: &str| e.contains("aiChat.repoBusy");
        // 본 저장소에서 AI가 일하는 동안 worktree의 쓰기는 막힌다(읽기는 된다)
        b.start_t(&prog(&bin), repo.clone(), "wt1".into(), "a".into(), None, true).await.unwrap();
        for (cmd, args) in [
            ("git", json!({"repo": wt, "args": ["tag", "t"]})),
            ("git", json!({"repo": wt.join("sub"), "args": ["commit", "--allow-empty", "-m", "x"]})),
            ("git", json!({"repo": repo.join("elsewhere-not-a-repo"), "args": ["-C", wt, "tag", "t"]})),
            ("git", json!({"repo": repo.join("elsewhere-not-a-repo"), "args": [format!("--git-dir={}/.git", wt.display()), "tag", "t"]})),
            ("run_detached", json!({"repo": wt, "args": ["fetch"], "token": "t"})),
            ("start_job", json!({"repo": wt, "args": ["fetch"]})),
            ("commit", json!({"repo": wt, "message": "x", "amend": false})),
            ("stage", json!({"repo": wt, "paths": ["a"]})),
        ] {
            let e = b.dispatch(cmd, args.clone()).await.unwrap_err();
            assert!(busy(&e), "{cmd} {args}: {e}");
        }
        b.dispatch("git", json!({"repo": wt, "args": ["status", "--porcelain"]})).await.unwrap();
        b.dispatch("load_status", json!({"repo": wt})).await.unwrap();
        b.ai_chat_cancel("wt1");
        rec.last("wt1").await;
        b.dispatch("git", json!({"repo": wt, "args": ["tag", "after-turn"]})).await.unwrap();
        // 반대 방향: worktree에서 AI가 일하는 중이면 본 저장소의 쓰기가 막힌다
        let key = crate::repo_gate::lock_key(&wt);
        b.ai.repos.lock().insert(key.clone());
        for (cmd, args) in [("git", json!({"repo": repo, "args": ["tag", "t2"]})), ("commit", json!({"repo": repo, "message": "x", "amend": false}))] {
            let e = b.dispatch(cmd, args.clone()).await.unwrap_err();
            assert!(busy(&e), "{cmd}: {e}");
        }
        b.dispatch("git", json!({"repo": repo, "args": ["status"]})).await.unwrap();
        b.ai.repos.lock().remove(&key);
        b.dispatch("git", json!({"repo": repo, "args": ["tag", "t2"]})).await.unwrap();
        // 환경 변수로 위치를 정하는 git 옵션과 드라이브 상대 경로는 AI 차례 중이면 막힌다(어느 저장소인지 알 수 없다)
        b.ai.repos.lock().insert(key.clone());
        let other = tempfile::tempdir().unwrap();
        let o = other.path().to_string_lossy().into_owned();
        for args in [json!({"repo": o, "args": ["--config-env", "core.worktree=X", "tag", "t3"]}), json!({"repo": o, "args": ["--config-env=core.bare=X", "tag", "t3"]}), json!({"repo": "C:foo", "args": ["tag", "t3"]})] {
            let e = b.dispatch("git", args.clone()).await.unwrap_err();
            assert!(busy(&e), "{args}: {e}");
        }
        b.ai.repos.lock().remove(&key);
        drop(keep);
    }
    /// AI 차례를 시작하기 전에 같은 저장소(worktree 포함)에서 사용자 작업이 이미 돌고 있으면 시작하지 않는다. 끝나면 시작된다. 이 거절 뒤 AI 잠금은 남지 않는다
    #[tokio::test]
    async fn ai_turn_refuses_to_start_while_a_user_job_runs_in_the_same_repository() {
        use serde_json::json;
        let (b, rec, repo, bin, keep) = setup(OK).await;
        let wt = repo.with_file_name(format!("{}-jw", repo.file_name().unwrap().to_string_lossy()));
        git(&repo, &["worktree", "add", "-q", "-b", "jw", wt.to_str().unwrap()]);
        let wt = wt.canonicalize().unwrap();
        let other = tempfile::tempdir().unwrap();
        let o = other.path().canonicalize().unwrap();
        git(&o, &["init", "-q", "-b", "main"]);
        git(&o, &["commit", "-q", "--allow-empty", "-m", "o"]);
        // 느린 git(별칭이 sleep)을 worktree 경로에서 돌린다
        b.dispatch("run_detached", json!({"repo": wt, "args": ["-c", "alias.slow=!sleep 20", "slow"], "token": "slow1"})).await.unwrap();
        let e = b.start_t(&prog(&bin), repo.clone(), "j1".into(), "a".into(), None, true).await.unwrap_err();
        assert!(e.contains("aiChat.repoJobRunning"), "{e}");
        assert!(b.ai.repos.lock().is_empty(), "거절된 시작은 잠금을 남기지 않는다");
        // 다른 저장소의 AI 차례는 영향이 없다
        b.start_t(&prog(&bin), o.clone(), "j-other".into(), "a".into(), None, true).await.unwrap();
        rec.last("j-other").await;
        // 작업이 끝나면 시작된다
        b.dispatch("cancel_detached", json!({"token": "slow1"})).await.unwrap();
        for _ in 0..100 {
            if b.jobs.active().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(b.jobs.active().is_empty(), "작업이 정리되지 않음");
        b.start_t(&prog(&bin), repo.clone(), "j1".into(), "a".into(), None, true).await.unwrap();
        rec.last("j1").await;
        drop(keep);
    }

    /// 불신 저장소의 설정이 다른 작업 트리를 가리켜도(`core.worktree`) 그 작업 트리의 AI 차례와 겹치면 막는다
    #[tokio::test]
    async fn a_repository_whose_config_points_its_worktree_at_the_busy_repository_is_blocked() {
        use std::io::Write;
        use serde_json::json;
        let (b, rec, repo, bin, keep) = setup("sleep 20\n").await;
        let evil = tempfile::tempdir().unwrap();
        let ev = evil.path().canonicalize().unwrap();
        git(&ev, &["init", "-q", "-b", "main"]);
        std::fs::OpenOptions::new().append(true).open(ev.join(".git/config")).unwrap().write_all(format!("[core]\n\tworktree = {}\n", repo.display()).as_bytes()).unwrap();
        b.start_t(&prog(&bin), repo.clone(), "ew".into(), "a".into(), None, true).await.unwrap();
        let e = b.dispatch("git", json!({"repo": ev, "args": ["tag", "x"]})).await.unwrap_err();
        assert!(e.contains("aiChat.repoBusy"), "{e}");
        // 값을 풀 수 없는 설정도 막는다
        std::fs::OpenOptions::new().append(true).open(ev.join(".git/config")).unwrap().write_all(b"[core]\n\tworktree = C:\\path\n").unwrap(); // git도 읽지 못하는 이스케이프
        let e = b.dispatch("git", json!({"repo": ev, "args": ["tag", "x"]})).await.unwrap_err();
        assert!(e.contains("aiChat.repoBusy"), "{e}");
        // include·위치 옵션은 대상과 무관하게 막는다
        let plain = tempfile::tempdir().unwrap();
        for argv in [json!(["-c", "include.path=/tmp/x", "tag", "t"]), json!(["--config-env", "include.path=V", "tag", "t"]), json!(["-c", "includeIf.gitdir:/x.path=/y", "tag", "t"])] {
            let e = b.dispatch("git", json!({"repo": plain.path(), "args": argv})).await.unwrap_err();
            assert!(e.contains("aiChat.repoBusy"), "{argv}: {e}");
        }
        // 루트 상대 경로는 어느 드라이브인지 알 수 없다
        let e = b.dispatch("git", json!({"repo": "\\foo", "args": ["tag", "t"]})).await.unwrap_err();
        assert!(e.contains("aiChat.repoBusy"), "{e}");
        b.ai_chat_cancel("ew");
        rec.last("ew").await;
        drop(keep);
    }
    /// 작업 기록은 `repo`뿐 아니라 argv의 `-C`·`--git-dir`·`--work-tree` 대상도 담는다: 다른 저장소를 `repo`로 주고 AI 저장소를 `-C`로 가리키는 작업도 겹침으로 본다
    #[tokio::test]
    async fn running_jobs_record_dash_c_and_git_dir_targets_for_the_overlap_check() {
        use serde_json::json;
        let (b, _rec, repo, bin, keep) = setup(OK).await;
        let o = tempfile::tempdir().unwrap();
        let o = o.path().canonicalize().unwrap();
        git(&o, &["init", "-q", "-b", "main"]);
        for (i, argv) in [
            json!(["-C", repo, "-c", "alias.slow=!sleep 20", "slow"]),
            json!([format!("--git-dir={}/.git", repo.display()), "-c", "alias.slow=!sleep 20", "slow"]),
            json!(["--work-tree", repo, "--git-dir", format!("{}/.git", repo.display()), "-c", "alias.slow=!sleep 20", "slow"]),
        ]
        .into_iter()
        .enumerate()
        {
            b.dispatch("run_detached", json!({"repo": o, "args": argv, "token": format!("t{i}")})).await.unwrap();
            let e = b.start_t(&prog(&bin), repo.clone(), format!("c{i}"), "a".into(), None, true).await.unwrap_err();
            assert!(e.contains("aiChat.repoJobRunning"), "{argv}: {e}");
            b.dispatch("cancel_detached", json!({"token": format!("t{i}")})).await.unwrap();
            for _ in 0..100 {
                if b.jobs.active().is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        // 다른 저장소만 가리키는 작업은 겹치지 않는다
        b.dispatch("run_detached", json!({"repo": o, "args": ["-c", "alias.slow=!sleep 20", "slow"], "token": "t-other"})).await.unwrap();
        b.start_t(&prog(&bin), repo.clone(), "c-ok".into(), "a".into(), None, true).await.unwrap();
        b.dispatch("cancel_detached", json!({"token": "t-other"})).await.unwrap();
        drop(keep);
    }

    /// 게이트 통과 뒤 AI 차례가 먼저 잠금을 잡았다면, 작업은 프로세스를 띄우기 전 등록 뒤의 재확인에서 거절되고 등록은 남지 않는다. 잠금이 없으면 등록되고 놓으면 빠진다
    #[tokio::test]
    async fn job_registration_rechecks_the_ai_lock_and_leaves_nothing_behind() {
        let (b, _rec, repo, _bin, keep) = setup(OK).await;
        let reg = b.register_job(vec![repo.clone()], crate::jobs::Kind::Short).await.unwrap();
        assert_eq!(b.jobs.active().len(), 1);
        drop(reg);
        assert!(b.jobs.active().is_empty());
        let key = crate::repo_gate::lock_key(&repo);
        b.ai.repos.lock().insert(key.clone());
        let e = b.register_job(vec![repo.clone()], crate::jobs::Kind::Quiet).await.err().unwrap();
        assert!(e.contains("aiChat.repoBusy"), "{e}");
        assert!(b.jobs.active().is_empty(), "거절된 등록은 남지 않는다");
        // 반대 순서: 작업이 먼저 등록돼 있으면 AI 시작이 그것을 본다(`ai_turn_refuses_to_start…`)
        b.ai.repos.lock().remove(&key);
        drop(keep);
    }

    /// 자동 fetch(quiet)만 도는 중이면 AI 시작은 끝나기를 잠깐 기다리고(패널에 안내 이벤트), 끝나면 시작한다. 안 끝나면 repoJobRunning. 사용자가 시작한 작업은 기다리지 않고 거절한다
    #[tokio::test]
    async fn ai_start_waits_briefly_for_an_automatic_fetch_but_never_for_a_user_job() {
        use serde_json::json;
        let (b, rec, repo, bin, keep) = setup(OK).await;
        // 1초 걸리는 자동 작업: 기다렸다가 시작
        b.dispatch("start_job", json!({"repo": repo, "args": ["-c", "alias.slow=!sleep 1", "slow"], "interactive": false})).await.unwrap();
        let t = std::time::Instant::now();
        b.start_t(&prog(&bin), repo.clone(), "w1".into(), "a".into(), None, true).await.unwrap();
        assert!(t.elapsed() >= Duration::from_millis(300), "기다리지 않음: {:?}", t.elapsed());
        rec.last("w1").await;
        assert!(rec.kinds("w1").iter().any(|k| k == "note"), "기다리는 동안 안내 이벤트가 나간다: {:?}", rec.kinds("w1"));
        let note = rec.0.lock().iter().find(|p| p["event"]["kind"] == "note").unwrap()["event"].clone();
        assert_eq!(note["code"], "aiChat.waitFetch");
        // 끝나지 않는 자동 작업: 제한 시간(시험 2초) 뒤 거절, 잠금은 남지 않는다
        let job = b.dispatch("start_job", json!({"repo": repo, "args": ["-c", "alias.slow=!sleep 30", "slow"], "interactive": false})).await.unwrap();
        let t = std::time::Instant::now();
        let e = b.start_t(&prog(&bin), repo.clone(), "w2".into(), "a".into(), None, true).await.unwrap_err();
        assert!(e.contains("aiChat.repoJobRunning") && t.elapsed() >= Duration::from_millis(1500), "{e} {:?}", t.elapsed());
        assert!(b.ai.repos.lock().is_empty());
        b.dispatch("cancel_job", json!({"job": job})).await.unwrap();
        for _ in 0..100 {
            if b.jobs.active().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        // 사용자가 직접 시작한 작업(interactive 생략)은 기다리지 않고 바로 거절
        let job = b.dispatch("start_job", json!({"repo": repo, "args": ["-c", "alias.slow=!sleep 30", "slow"]})).await.unwrap();
        let t = std::time::Instant::now();
        let e = b.start_t(&prog(&bin), repo.clone(), "w3".into(), "a".into(), None, true).await.unwrap_err();
        assert!(e.contains("aiChat.repoJobRunning") && t.elapsed() < Duration::from_millis(1000), "{e} {:?}", t.elapsed());
        b.dispatch("cancel_job", json!({"job": job})).await.unwrap();
        // 자동 작업과 사용자 작업이 같이 돌면 사용자 작업이 있으므로 바로 거절
        drop(keep);
    }
    /// 같은 저장소의 작업은 백엔드에서 직렬화된다: 자동(quiet) 작업은 이미 도는 작업이 있으면 건너뛰고(`job.skipped`), 사용자 작업은 **작업 번호를 먼저 돌려주고** FIFO 대기열에서 기다리며
    /// (이벤트 waiting → started, 대기 중에도 취소 가능), 다른 저장소·`run_detached`(GUI 도구)는 막지 않는다
    #[tokio::test]
    async fn jobs_in_the_same_repository_are_serialized_quiet_ones_skip_and_user_ones_queue_fifo() {
        use serde_json::json;
        let (b, rec, repo, _bin, keep) = setup(OK).await;
        let wt = repo.with_file_name(format!("{}-sw", repo.file_name().unwrap().to_string_lossy()));
        git(&repo, &["worktree", "add", "-q", "-b", "sw", wt.to_str().unwrap()]);
        let wt = wt.canonicalize().unwrap();
        let other = tempfile::tempdir().unwrap();
        let o = other.path().canonicalize().unwrap();
        git(&o, &["init", "-q", "-b", "main"]);
        git(&o, &["commit", "-q", "--allow-empty", "-m", "o"]);
        let slow = |s: u32| json!(["-c", format!("alias.slow=!sleep {s}"), "slow"]);
        let order_file = repo.join("order.txt");
        let mark = |name: &str| json!(["-c", format!("alias.mark=!echo {name} >> {}", order_file.display()), "mark"]);
        let id = |v: Value| v.as_u64().unwrap();
        // 1. 자동 작업이 돌고 있으면(worktree에서도) 다른 자동 작업은 조용히 건너뛴다
        let q = id(b.dispatch("start_job", json!({"repo": repo, "args": slow(1), "interactive": false})).await.unwrap());
        let e = b.dispatch("start_job", json!({"repo": wt, "args": mark("x"), "interactive": false})).await.unwrap_err();
        assert!(e.contains("job.skipped"), "{e}");
        // 2. 다른 저장소의 작업은 영향이 없다. run_detached는 직렬화하지 않는다
        b.dispatch("start_job", json!({"repo": o, "args": mark("other"), "interactive": false})).await.unwrap();
        b.dispatch("run_detached", json!({"repo": repo, "args": mark("detached"), "token": "d1"})).await.unwrap();
        // 3. 사용자 작업은 대기 전에 번호를 돌려주고(바로), 대기 중 이벤트가 나가며, 앞선 자동 작업은 건드리지 않고 끝나면 FIFO로 시작한다
        let t = std::time::Instant::now();
        let a = id(b.dispatch("start_job", json!({"repo": wt, "args": mark("A")})).await.unwrap());
        let c = id(b.dispatch("start_job", json!({"repo": repo, "args": mark("C")})).await.unwrap());
        assert!(t.elapsed() < Duration::from_millis(500), "번호를 먼저 돌려주지 않고 기다림 {:?}", t.elapsed());
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(rec.job_kinds(a)[0], "waiting");
        assert_eq!(rec.job_kinds(c)[0], "waiting");
        assert!(rec.job_kinds(q).iter().all(|k| k != "done"), "앞선 자동 작업은 그대로 돈다");
        // 순서 보장: A가 먼저 시작해 끝난 뒤 C가 시작한다
        rec.job_done(a).await;
        rec.job_done(c).await;
        assert!(rec.job_kinds(a).contains(&"started".to_string()) && rec.job_kinds(c).contains(&"started".to_string()));
        let pos = |name: &str| rec.1.lock().iter().position(|(e, p)| e == "job-done" && p[0] == if name == "A" { a } else { c }).unwrap();
        assert!(pos("A") < pos("C"), "FIFO: A가 먼저 끝나야 한다");
        let order = std::fs::read_to_string(&order_file).unwrap_or_default();
        let lines: Vec<&str> = order.lines().filter(|l| *l == "A" || *l == "C").collect();
        assert_eq!(lines, ["A", "C"], "실행 순서도 FIFO: {order:?}");
        drop(keep);
    }

    /// 대기 중인 사용자 작업은 취소할 수 있고(프로세스가 없다) 앞선 작업·뒤 대기자는 영향이 없다. 종료 정리(`take_all`)는 대기 중인 작업도 정리한다. 오래 못 시작하면(start_shell) `job.busy`
    #[tokio::test]
    async fn a_queued_job_can_be_cancelled_without_touching_the_running_one_and_shutdown_clears_the_queue() {
        use serde_json::json;
        let (b, rec, repo, _bin, keep) = setup(OK).await;
        let slow = json!(["-c", "alias.slow=!sleep 30", "slow"]);
        let fast = json!(["-c", "alias.fast=!true", "fast"]);
        let running = b.dispatch("start_job", json!({"repo": repo, "args": slow})).await.unwrap().as_u64().unwrap();
        let w1 = b.dispatch("start_job", json!({"repo": repo, "args": fast})).await.unwrap().as_u64().unwrap();
        let w2 = b.dispatch("start_job", json!({"repo": repo, "args": fast})).await.unwrap().as_u64().unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(rec.job_kinds(w1), ["waiting"]);
        // 대기 중 취소: git.cancelled로 끝나고 시작된 적 없으며, 앞선 작업은 그대로 돈다
        b.dispatch("cancel_job", json!({"job": w1})).await.unwrap();
        let err = rec.job_done(w1).await;
        assert!(err.as_str().unwrap().contains("git.cancelled"), "{err}");
        assert!(!rec.job_kinds(w1).contains(&"started".to_string()));
        assert!(rec.job_kinds(running).iter().all(|k| k != "done"));
        assert_eq!(rec.job_kinds(w2), ["waiting"], "뒤 대기자는 그대로 기다린다");
        // 오래 못 시작하는 start_shell(동기 대기)은 제한 시간 뒤 job.busy, 등록은 남지 않는다
        let t = std::time::Instant::now();
        let e = b.dispatch("start_shell", json!({"repo": repo, "command": "true"})).await.unwrap_err();
        assert!(e.contains("job.busy") && t.elapsed() >= Duration::from_millis(2500), "{e} {:?}", t.elapsed());
        // commit-graph 백그라운드 작업도 같은 규칙(Quiet): 도는 작업이 있으면 건너뛴다
        let e = b.register_job(vec![repo.clone()], crate::jobs::Kind::Quiet).await.unwrap_err();
        assert!(e.contains("job.skipped"), "{e}");
        assert_eq!(b.jobs.active().len(), 1, "대기자는 active에 없다(앞선 작업 하나만)");
        // 종료 정리: 대기 중인 작업이 취소되고 대기열이 빈다
        let handles = b.jobs.take_all();
        assert_eq!(handles.len(), 1);
        let err = rec.job_done(w2).await;
        assert!(err.as_str().unwrap().contains("git.cancelled"), "{err}");
        gc_core::JobHandle::stop_all(&handles, Duration::from_secs(1));
        rec.job_done(running).await;
        drop(keep);
    }

    /// 짧은 쓰기 IPC도 작업으로 등록돼 있는 동안 AI 시작이 그것을 본다: 끝나길 잠깐 기다렸다가 시작한다. 끝나면 등록이 빠진다
    #[tokio::test]
    async fn short_write_ipcs_are_registered_while_they_run_and_ai_start_waits_for_them() {
        use serde_json::json;
        let (b, rec, repo, bin, keep) = setup(OK).await;
        let (b2, r2) = (b.clone(), repo.clone());
        // 느린 git 쓰기(별칭이 sleep, 모르는 하위 명령 = 쓰기)
        let write = tokio::spawn(async move { b2.dispatch("git", json!({"repo": r2, "args": ["-c", "alias.slow=!sleep 1", "slow"]})).await });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(b.jobs.active().len(), 1, "실행 중인 쓰기가 등록돼 있다");
        assert_eq!(b.jobs.active()[0].kind, crate::jobs::Kind::Short);
        let t = std::time::Instant::now();
        b.start_t(&prog(&bin), repo.clone(), "sw1".into(), "a".into(), None, true).await.unwrap();
        assert!(t.elapsed() >= Duration::from_millis(300), "기다리지 않음 {:?}", t.elapsed());
        write.await.unwrap().ok();
        rec.last("sw1").await;
        assert!(b.jobs.active().is_empty(), "끝난 쓰기는 등록이 빠진다");
        // 읽기는 등록하지 않는다
        let (b3, r3) = (b.clone(), repo.clone());
        let read = tokio::spawn(async move { b3.dispatch("git", json!({"repo": r3, "args": ["status", "--porcelain"]})).await });
        read.await.unwrap().unwrap();
        // 모든 쓰기 IPC는 종료 뒤에도 등록이 남지 않는다
        b.dispatch("git", json!({"repo": repo, "args": ["tag", "z"]})).await.unwrap();
        assert!(b.jobs.active().is_empty());
        drop(keep);
    }
}
