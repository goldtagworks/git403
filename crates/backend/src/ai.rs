//! AI 요청 (gc-ai, docs/ai-auth.md): 설정 파일 읽기·쓰기, 실행, 취소.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde_json::Value;

use crate::util::{json, off, Res};

/// 등록 전 취소 기억 상한 (넘으면 비운다: 오래된 token의 취소는 의미가 없다)
const CANCELLED_MAX: usize = 64;

/// 실행 중 목록과 "먼저 도착한 취소"를 한 락으로 묶어 run·cancel 경쟁을 없앤다.
#[derive(Default)]
struct Tasks {
    /// 진행 중인 AI 요청 (token → 취소 핸들)
    running: HashMap<String, tokio::task::AbortHandle>,
    /// 등록 전에 도착한 취소 요청 (run이 시작할 때 바로 거부)
    cancelled: HashSet<String>,
}

pub(crate) struct Ai {
    /// 설정 파일 (`ai.json`)
    path: PathBuf,
    tasks: Mutex<Tasks>,
}

fn cancelled() -> String {
    gc_i18n::coded!("ai.cancelled", "Cancelled").json()
}

impl Ai {
    pub fn new(config_dir: &Path) -> Self {
        Self { path: config_dir.join("ai.json"), tasks: Default::default() }
    }

    pub async fn settings(&self) -> Res<gc_ai::Settings> {
        let path = self.path.clone();
        off(move || gc_ai::Settings::load(&path).map_err(|e| e.ipc())).await
    }

    /// `provider`(생략 = 선택된 공급자)의 모델·방식·동의 중 준 것만 바꾼다. 모델이 비면 공급자 기본값. `select`가 true면 그 공급자를 선택한다.
    /// `conventions`는 공급자와 무관한 "저장소 규칙 따르기".
    pub async fn set_settings(&self, provider: Option<gc_ai::Provider>, model: Option<String>, method: Option<gc_ai::Method>, consent: Option<bool>, select: bool, conventions: Option<bool>) -> Res<()> {
        let path = self.path.clone();
        off(move || set_settings_sync(&path, provider, model, method, consent, select, conventions)).await
    }

    /// 키를 다룰 공급자 (생략 = 선택된 공급자)
    pub async fn key_provider(&self, provider: Option<gc_ai::Provider>) -> Res<gc_ai::Provider> {
        Ok(match provider {
            Some(p) => p,
            None => self.settings().await?.provider,
        })
    }

    /// 공급자별 CLI 감지·키 유무(값은 절대 보내지 않음)·모델·동의 여부. 최상위는 선택된 공급자.
    pub async fn status(&self, path_env: Option<&str>) -> Res<gc_ai::Status> {
        let settings = self.settings().await?;
        gc_ai::status(&settings, path_env, &gc_hosting::Keychain).await.map_err(|e| e.ipc())
    }

    /// AI 실행. 입력 크기 검사(자르지 않음)·방식 감지·선택·호출은 전부 spawn한 작업 안에서 하고, **token은 그 전에 등록**한다
    /// (감지 중 취소도 먹는다). 등록보다 먼저 온 취소는 `Tasks::cancelled`가 기억한다. 동의 전에는 거부한다.
    /// 커밋·PR 작업이고 `repo`가 있으면(설정·저장소에서 끄지 않았다면) 저장소 규칙을 모아 입력에 붙인다(`conventions.rs`) — 결과에 `sources`가 붙는다.
    pub async fn run(&self, git: &gc_core::GitRunner, repo: Option<PathBuf>, task: gc_ai::Task, parts: Vec<gc_ai::Part>, token: String, opts: gc_ai::Opts) -> Res<Value> {
        let (git, path_env) = (git.clone(), git.path_override().map(String::from));
        let settings = self.settings().await?;
        if !settings.of(settings.provider).consent {
            return Err(gc_i18n::coded!("ai.consentRequired", "Consent to use AI is required").json());
        }
        let job = {
            let mut t = self.tasks.lock();
            if t.cancelled.remove(&token) {
                return Err(cancelled());
            }
            let job = tokio::spawn(async move {
                let mut parts: Vec<gc_ai::Part> = parts.into_iter().filter(|p| p.label != gc_ai::CONVENTIONS_LABEL).collect();
                let mut sources = Vec::new();
                if let Some(repo) = repo.filter(|_| settings.conventions) {
                    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
                    if let Some(c) = crate::conventions::collect(&git, &repo, task, home).await {
                        parts.push(gc_ai::Part { label: gc_ai::CONVENTIONS_LABEL.into(), text: c.text });
                        sources = c.sources;
                    }
                }
                let backend = gc_ai::backend(&settings, path_env.as_deref(), &gc_hosting::Keychain).await?;
                gc_ai::run_meta(&backend, task, &parts, &opts).await.map(|(v, meta)| (v, meta, sources))
            });
            t.running.insert(token.clone(), job.abort_handle());
            job
        };
        let result = job.await;
        self.tasks.lock().running.remove(&token);
        match result {
            Ok(r) => r.map_err(|e| e.ipc()).and_then(|(v, meta, sources)| json(with_meta(task, v, meta, sources))),
            Err(e) if e.is_cancelled() => Err(cancelled()),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn cancel(&self, token: String) {
        let mut t = self.tasks.lock();
        match t.running.remove(&token) {
            Some(h) => h.abort(),
            None => {
                if t.cancelled.len() >= CANCELLED_MAX {
                    t.cancelled.clear();
                }
                t.cancelled.insert(token);
            }
        }
    }

    pub fn abort_all(&self) {
        let mut t = self.tasks.lock();
        for (_, h) in t.running.drain() {
            h.abort();
        }
        t.cancelled.clear();
    }
}

/// PR 리뷰만 결과 객체에 `meta{model, inputTokens, outputTokens, elapsedMs}`를 더하고, 커밋·PR 설명은 사용한 규칙 출처
/// `sources[{kind, path, truncated}]`를 더한다(끄거나 모은 게 없으면 빈 배열). 다른 작업은 반환 형태 그대로.
fn with_meta(task: gc_ai::Task, mut v: Value, meta: gc_ai::Meta, sources: Vec<crate::conventions::Source>) -> Value {
    if task == gc_ai::Task::PrReview {
        v["meta"] = serde_json::to_value(meta).unwrap_or(Value::Null);
    }
    if task.uses_conventions() {
        v["sources"] = serde_json::to_value(sources).unwrap_or(Value::Null);
    }
    v
}

fn set_settings_sync(path: &Path, provider: Option<gc_ai::Provider>, model: Option<String>, method: Option<gc_ai::Method>, consent: Option<bool>, select: bool, conventions: Option<bool>) -> Res<()> {
    let mut s = gc_ai::Settings::load(path).map_err(|e| e.ipc())?;
    s.conventions = conventions.unwrap_or(s.conventions);
    let p = provider.unwrap_or(s.provider);
    let cur = s.of_mut(p);
    if let Some(m) = model {
        let m = m.trim();
        if m.chars().any(char::is_whitespace) {
            return Err(gc_i18n::coded!("ai.modelWhitespace", "The model name contains whitespace").json());
        }
        // 빈 값 = 공급자 기본 모델
        cur.model = m.into();
    }
    cur.method = method.unwrap_or(cur.method);
    cur.consent = consent.unwrap_or(cur.consent);
    if select {
        s.provider = p;
    }
    s.save(path).map_err(|e| e.ipc())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conventions::Source;
    use serde_json::json;

    #[test]
    fn sources_are_added_to_commit_and_pr_results_only() {
        let src = || vec![Source { kind: "skill", path: ".claude/skills/commit-message/SKILL.md".into(), truncated: false, via: Some("referenced"), from: Some("CLAUDE.md:168".into()), missing: false, skipped: false }, Source { kind: "claude", path: "CLAUDE.md".into(), truncated: true, via: None, from: None, missing: false, skipped: false }];
        let v = with_meta(gc_ai::Task::Commit, json!({"subject": "s", "body": ""}), Default::default(), src());
        assert_eq!((v["subject"].as_str(), v["sources"][0]["kind"].as_str(), v["sources"][1]["truncated"].as_bool()), (Some("s"), Some("skill"), Some(true)));
        assert_eq!(v["sources"][0]["path"], ".claude/skills/commit-message/SKILL.md");
        assert_eq!((v["sources"][0]["via"].as_str(), v["sources"][0]["from"].as_str()), (Some("referenced"), Some("CLAUDE.md:168")));
        assert!(v["sources"][1].get("via").is_none() && v["sources"][1].get("missing").is_none(), "없는 값은 필드를 생략");
        assert_eq!(with_meta(gc_ai::Task::Pr, json!({"title": "t", "body": ""}), Default::default(), vec![])["sources"], json!([]), "끄거나 없으면 빈 배열");
        let r = with_meta(gc_ai::Task::Review, json!({"findings": []}), Default::default(), src());
        assert!(r.get("sources").is_none() && r.get("meta").is_none(), "다른 작업은 그대로");
        assert!(with_meta(gc_ai::Task::PrReview, json!({}), Default::default(), vec![]).get("sources").is_none());
    }

    #[test]
    fn conventions_setting_is_saved_independently_of_provider() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("ai.json");
        assert!(gc_ai::Settings::load(&p).unwrap().conventions, "기본 켬");
        set_settings_sync(&p, None, None, None, None, false, Some(false)).unwrap();
        assert!(!gc_ai::Settings::load(&p).unwrap().conventions);
        set_settings_sync(&p, Some(gc_ai::Provider::Google), None, None, Some(true), true, None).unwrap();
        let s = gc_ai::Settings::load(&p).unwrap();
        assert!(!s.conventions && s.provider == gc_ai::Provider::Google && s.google.consent, "다른 값을 바꿔도 유지");
    }
}
