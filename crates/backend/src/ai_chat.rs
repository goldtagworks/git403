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
    set: std::sync::Arc<parking_lot::Mutex<std::collections::HashSet<PathBuf>>>,
    key: PathBuf,
}

impl Drop for RepoLock {
    fn drop(&mut self) {
        self.set.lock().remove(&self.key);
    }
}

impl Backend {
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
            let key = repo.canonicalize().unwrap_or_else(|_| repo.clone());
            let mut set = self.ai.repos.lock();
            if !set.insert(key.clone()) {
                return Err(busy());
            }
            RepoLock { set: self.ai.repos.clone(), key }
        };
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let id = format!("b{:x}{}", now_ms(), SEQ.fetch_add(1, Ordering::Relaxed));
        let backup = ai_backup::create(&self.git, &repo, &id).await.map_err(|e| e.ipc())?;
        if let Some(b) = &backup {
            self.ai.backups.lock().insert((repo.canonicalize().unwrap_or_else(|_| repo.clone()), id.clone()), b.clone());
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
        let key = repo.canonicalize().unwrap_or_else(|_| repo.clone());
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
    struct Rec(Mutex<Vec<Value>>);
    impl Emit for Rec {
        fn emit(&self, event: &str, payload: Value) {
            if event == "ai-chat" {
                self.0.lock().push(payload);
            }
        }
    }
    impl Rec {
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
}
