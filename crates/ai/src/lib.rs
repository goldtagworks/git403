//! git 작업용 AI(커밋 메시지·코드 리뷰·충돌 도우미·PR 설명). git과 무관하다 — 입력 텍스트는 호출 측이 모아 준다.
//! 공급자(Anthropic·OpenAI·Google·xAI)마다 방식 A: 설치된 CLI에 위임(`cli`·`cli_other`, OAuth는 CLI가 보관),
//! 방식 C: API + API 키(`api`·`api_openai`·`api_google`, 키는 OS 키체인).
mod api;
mod api_google;
mod api_openai;
mod cli;
mod cli_other;
mod pr_review;
mod provider;
mod task;

pub use cli::detect as detect_cli;
pub use provider::Provider;
pub use task::{build_prompt, build_prompt_for, finish, Part, Task, CONVENTIONS_LABEL};

use gc_hosting::SecretStore;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFAULT_MODEL: &str = "claude-opus-5-5";
/// 모델에 보내는 입력 상한(바이트). 넘으면 자르지 않고 `Error::TooLarge`.
pub const MAX_INPUT_BYTES: usize = 200_000;
/// Anthropic 키체인 항목 이름 (서비스 `git403`). 다른 공급자는 `Provider::key_name`
pub const KEY_NAME: &str = "ai:anthropic";

#[derive(Debug)]
pub enum Error {
    NoBackend,
    TooLarge { size: usize, limit: usize },
    Unauthorized,
    Forbidden,
    RateLimited,
    Overloaded(Provider, u16),
    BadRequest(String),
    Rejected(u16, String),
    Refused(Provider, Option<String>),
    Truncated,
    Network(String),
    Timeout,
    /// 응답을 해석하지 못함(코드 있는 사유)
    BadResponse(gc_i18n::Coded),
    Cli(Provider, String),
    Store(String),
    File(String),
    /// 그 밖의 코드 있는 오류(입력 검사 등)
    Coded(gc_i18n::Coded),
}

impl Error {
    /// 코드 있는 오류(UI가 번역). 모든 변형이 코드가 있다.
    pub fn coded(&self) -> gc_i18n::Coded {
        use gc_i18n::coded;
        match self {
            Error::NoBackend => coded!("ai.noBackend", "No AI backend is available. Install the provider's CLI and log in, or enter an API key in Settings > AI"),
            Error::TooLarge { size, limit } => {
                let (size_kb, limit_kb) = (size / 1000, limit / 1000);
                coded!("ai.tooLarge", "The selection is too large ({size_kb}KB, limit {limit_kb}KB). Aborted without truncating. Pick fewer files (stage or narrow the range) and try again", size_kb = size_kb, limit_kb = limit_kb)
            }
            Error::Unauthorized => coded!("ai.unauthorized", "The API key is invalid (401). Check the key in Settings > AI"),
            Error::Forbidden => coded!("ai.forbidden", "API access was denied (403). Check the key's permissions and organization settings"),
            Error::RateLimited => coded!("ai.rateLimited", "Too many requests (429). Try again shortly"),
            Error::Overloaded(p, c) => coded!("ai.overloaded", "The {provider} server is busy or failing ({status}). Try again shortly", provider = p.label(), status = c),
            Error::BadRequest(m) => coded!("ai.badRequest", "Bad request (400): {detail}", detail = m),
            Error::Rejected(c, m) => coded!("ai.rejected", "Request rejected ({status}): {detail}", status = c, detail = m),
            Error::Refused(p, None) => coded!("ai.refused", "{provider} declined this request. Check the input", provider = p.label()),
            Error::Refused(p, Some(c)) => coded!("ai.refusedCategory", "{provider} declined this request (category: {category}). Check the input", provider = p.label(), category = c),
            Error::Truncated => coded!("ai.truncated", "The response was cut off by the length limit. Narrow the input and try again"),
            Error::Network(m) => coded!("ai.network", "Could not connect to the server: {detail}", detail = m),
            Error::Timeout => coded!("ai.timeout", "The response is taking too long (over 10 minutes). Narrow the input or try again later"),
            Error::BadResponse(c) | Error::Coded(c) => c.clone(),
            Error::Cli(p, m) => coded!("ai.cli", "{cli} error: {detail}", cli = p.cli_name(), detail = m),
            Error::Store(m) => coded!("ai.store", "Key store error: {detail}", detail = m),
            Error::File(m) => coded!("ai.file", "Settings file error: {detail}", detail = m),
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

/// 방식 선택. auto = CLI가 있으면 CLI, 없으면 API 키
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    #[default]
    Auto,
    Cli,
    Key,
}

/// 공급자 하나의 설정. 모델이 비면 공급자 기본 모델(`Settings::model`)
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ProviderSettings {
    pub model: String,
    pub method: Method,
    /// "선택한 변경 내용이 <공급자>로 전송됩니다" 동의 여부 (전송 대상이 다르므로 공급자별)
    pub consent: bool,
}

/// 비밀 아님(키는 키체인). 앱 설정 폴더의 `ai.json`.
/// 기존 파일 호환: Anthropic 설정은 예전처럼 최상위 `model`·`method`·`consent`에 둔다(`flatten`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// 지금 쓰는 공급자
    pub provider: Provider,
    #[serde(flatten)]
    pub anthropic: ProviderSettings,
    pub openai: ProviderSettings,
    pub google: ProviderSettings,
    pub xai: ProviderSettings,
    /// 커밋·PR 작업에 저장소 규칙(CLAUDE.md·스킬 등)을 붙인다. 기본 켬(저장소별은 `git config git403.aiConventions false`)
    pub conventions: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { provider: Provider::default(), anthropic: Default::default(), openai: Default::default(), google: Default::default(), xai: Default::default(), conventions: true }
    }
}

impl Settings {
    pub fn of(&self, p: Provider) -> &ProviderSettings {
        match p {
            Provider::Anthropic => &self.anthropic,
            Provider::Openai => &self.openai,
            Provider::Google => &self.google,
            Provider::Xai => &self.xai,
        }
    }
    pub fn of_mut(&mut self, p: Provider) -> &mut ProviderSettings {
        match p {
            Provider::Anthropic => &mut self.anthropic,
            Provider::Openai => &mut self.openai,
            Provider::Google => &mut self.google,
            Provider::Xai => &mut self.xai,
        }
    }
    /// 실제로 쓸 모델 (비면 공급자 기본)
    pub fn model(&self, p: Provider) -> &str {
        match self.of(p).model.as_str() {
            "" => p.default_model(),
            m => m,
        }
    }
    pub fn load(path: &std::path::Path) -> Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(t) => serde_json::from_str(&t).map_err(|e| Error::File(e.to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(Error::File(e.to_string())),
        }
    }
    pub fn save(&self, path: &std::path::Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| Error::File(e.to_string()))?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self).map_err(|e| Error::File(e.to_string()))?).map_err(|e| Error::File(e.to_string()))
    }
}

/// 실제로 쓸 방식
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Active {
    Cli,
    Key,
}

pub fn resolve(method: Method, cli: bool, key: bool) -> Option<Active> {
    match method {
        Method::Auto if cli => Some(Active::Cli),
        Method::Auto | Method::Key => key.then_some(Active::Key),
        Method::Cli => cli.then_some(Active::Cli),
    }
}

/// 공급자 카드 하나의 상태. 키 값은 절대 담지 않는다("있음"만).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: Provider,
    pub cli: bool,
    pub cli_version: Option<String>,
    pub key: bool,
    pub method: Method,
    /// 지금 쓰게 될 방식 (없으면 이 공급자는 쓸 수 없다)
    pub active: Option<Active>,
    pub model: String,
    pub consent: bool,
}

/// UI에 보내는 상태. 최상위는 **선택된 공급자**의 `ProviderStatus`(이전 필드 그대로), `providers`는 전체 목록.
/// 선택된 공급자의 `active`가 null이면 UI는 AI 메뉴를 숨긴다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    #[serde(flatten)]
    pub current: ProviderStatus,
    pub providers: Vec<ProviderStatus>,
    /// 설정의 "저장소 규칙 따르기"
    pub conventions: bool,
}

/// 호출 대상. 테스트는 `Key.base`·`Cli.program`을 로컬 mock으로 바꾼다.
#[derive(Clone)]
pub enum Backend {
    /// program은 보통 `Provider::program()`. path는 로그인 셸에서 얻은 PATH(없으면 상속)
    Cli { provider: Provider, program: String, path: Option<String> },
    Key { provider: Provider, key: String, model: String, base: String },
}

/// 키가 로그에 찍히지 않게 직접 구현
impl std::fmt::Debug for Backend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Backend::Cli { program, .. } => write!(f, "Backend::Cli({program})"),
            Backend::Key { provider, model, .. } => write!(f, "Backend::Key({}, {model}, ***)", provider.label()),
        }
    }
}

pub const API_BASE: &str = "https://api.anthropic.com";

/// 네 공급자의 CLI 설치(동시에 감지, 각 5초)·키 유무.
pub async fn status<S: SecretStore>(settings: &Settings, path: Option<&str>, store: &S) -> Result<Status> {
    let (a, o, g, x) = tokio::join!(
        cli::detect(Provider::Anthropic, path),
        cli::detect(Provider::Openai, path),
        cli::detect(Provider::Google, path),
        cli::detect(Provider::Xai, path)
    );
    let mut providers = Vec::new();
    for (p, version) in Provider::ALL.into_iter().zip([a, o, g, x]) {
        let (s, key) = (settings.of(p), key_get(store, p)?.is_some());
        providers.push(ProviderStatus {
            provider: p,
            cli: version.is_some(),
            key,
            active: resolve(s.method, version.is_some(), key),
            cli_version: version,
            method: s.method,
            model: settings.model(p).into(),
            consent: s.consent,
        });
    }
    let current = providers.iter().find(|s| s.provider == settings.provider).cloned().expect("모든 공급자가 목록에 있다");
    Ok(Status { current, providers, conventions: settings.conventions })
}

/// 선택된 공급자의 호출 대상. 쓸 방식이 없으면 `NoBackend`.
pub async fn backend<S: SecretStore>(settings: &Settings, path: Option<&str>, store: &S) -> Result<Backend> {
    let st = status(settings, path, store).await?;
    let p = settings.provider;
    match st.current.active {
        Some(Active::Cli) => Ok(Backend::Cli { provider: p, program: p.program().into(), path: path.map(String::from) }),
        Some(Active::Key) => Ok(Backend::Key { provider: p, key: key_get(store, p)?.ok_or(Error::NoBackend)?, model: settings.model(p).into(), base: p.api_base().into() }),
        None => Err(Error::NoBackend),
    }
}

/// 호출마다 설정의 모델·기본 노력을 덮어쓰는 선택. 둘 다 None이면 기존 동작.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct Opts {
    pub model: Option<String>,
    pub effort: Option<Effort>,
}

/// 추론 노력. API는 `output_config.effort`, CLI는 `--effort`로 전달한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
}

impl Effort {
    pub fn as_str(self) -> &'static str {
        match self {
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
        }
    }
}

/// 실행 결과 부가 정보. 토큰은 얻을 수 있을 때만(CLI는 캐시 읽기·쓰기 입력 포함 합계), model은 실제로 응답한 모델(모르면 빈 문자열).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub model: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub elapsed_ms: u64,
}

/// 입력 크기를 검사하고 호출한다. 결과는 `Task::schema()`를 만족하는 JSON.
/// 취소 = 이 future를 drop(또는 abort). CLI 자식 프로세스는 `kill_on_drop`, HTTP 요청은 연결이 닫힌다.
pub async fn run(backend: &Backend, task: Task, parts: &[Part]) -> Result<Value> {
    run_meta(backend, task, parts, &Opts::default()).await.map(|r| r.0)
}

/// `run` + 모델·노력 덮어쓰기 + 결과 메타(걸린 시간 포함). 모델 이름에 공백·앞쪽 `-`가 있으면 `BadRequest`.
pub async fn run_meta(backend: &Backend, task: Task, parts: &[Part], opts: &Opts) -> Result<(Value, Meta)> {
    if let Some(m) = &opts.model {
        if m.is_empty() || m.starts_with('-') || m.chars().any(char::is_whitespace) {
            return Err(Error::Coded(gc_i18n::coded!("ai.badModel", "invalid model name")));
        }
    }
    let input = build_prompt_for(task, parts)?;
    let start = std::time::Instant::now();
    let (v, mut meta) = match backend {
        Backend::Cli { provider, program, path } => cli::run(*provider, program, path.as_deref(), task, &input, opts).await?,
        Backend::Key { provider, key, model, base } => {
            let model = opts.model.as_deref().unwrap_or(model);
            match provider {
                Provider::Anthropic => api::call(base, key, model, opts.effort, task, &input).await?,
                Provider::Openai | Provider::Xai => api_openai::call(*provider, base, key, model, opts.effort, task, &input).await?,
                Provider::Google => api_google::call(base, key, model, task, &input).await?,
            }
        }
    };
    meta.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok((finish(task, v, parts)?, meta))
}

fn store_err(e: gc_hosting::Error) -> Error {
    Error::Store(e.to_string())
}
pub fn key_get<S: SecretStore>(store: &S, p: Provider) -> Result<Option<String>> {
    store.get(p.key_name()).map_err(store_err)
}
pub fn key_set<S: SecretStore>(store: &S, p: Provider, key: &str) -> Result<()> {
    let key = key.trim();
    if key.is_empty() || key.chars().any(char::is_whitespace) {
        return Err(Error::Coded(gc_i18n::coded!("ai.badKey", "the API key is empty or contains whitespace")));
    }
    store.set(p.key_name(), key).map_err(store_err)
}
pub fn key_delete<S: SecretStore>(store: &S, p: Provider) -> Result<()> {
    store.delete(p.key_name()).map_err(store_err)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct Mem(pub Mutex<HashMap<String, String>>);
    impl SecretStore for Mem {
        fn set(&self, k: &str, s: &str) -> gc_hosting::Result<()> {
            self.0.lock().unwrap().insert(k.into(), s.into());
            Ok(())
        }
        fn get(&self, k: &str) -> gc_hosting::Result<Option<String>> {
            Ok(self.0.lock().unwrap().get(k).cloned())
        }
        fn delete(&self, k: &str) -> gc_hosting::Result<()> {
            self.0.lock().unwrap().remove(k);
            Ok(())
        }
    }

    #[test]
    fn method_resolution() {
        assert_eq!(resolve(Method::Auto, true, true), Some(Active::Cli));
        assert_eq!(resolve(Method::Auto, false, true), Some(Active::Key));
        assert_eq!(resolve(Method::Auto, false, false), None);
        assert_eq!(resolve(Method::Key, true, false), None);
        assert_eq!(resolve(Method::Key, true, true), Some(Active::Key));
        assert_eq!(resolve(Method::Cli, true, true), Some(Active::Cli));
        assert_eq!(resolve(Method::Cli, false, true), None);
    }

    #[test]
    fn settings_defaults_roundtrip_and_legacy_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("sub/ai.json");
        let s = Settings::load(&p).unwrap();
        assert_eq!((s.provider, s.model(Provider::Anthropic), s.anthropic.method, s.anthropic.consent), (Provider::Anthropic, "claude-opus-5-5", Method::Auto, false));
        assert_eq!(s.model(Provider::Openai), Provider::Openai.default_model());
        let mut s = Settings { provider: Provider::Google, ..Default::default() };
        s.anthropic = ProviderSettings { model: "m".into(), method: Method::Key, consent: true };
        s.of_mut(Provider::Google).consent = true;
        s.save(&p).unwrap();
        assert_eq!(Settings::load(&p).unwrap(), s);
        // Anthropic 설정은 예전처럼 최상위에 저장된다
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!((raw["model"].as_str(), raw["method"].as_str(), raw["consent"].as_bool(), raw["google"]["consent"].as_bool()), (Some("m"), Some("key"), Some(true), Some(true)));
        // 공급자가 생기기 전 파일(필드가 빠지거나 일부만 있음)도 Anthropic 것으로 읽는다
        std::fs::write(&p, r#"{"consent":true}"#).unwrap();
        let old = Settings::load(&p).unwrap();
        assert_eq!((old.provider, old.model(Provider::Anthropic), old.anthropic.consent, old.openai.consent), (Provider::Anthropic, DEFAULT_MODEL, true, false));
        std::fs::write(&p, r#"{"model":"claude-x","method":"cli","consent":true}"#).unwrap();
        let old = Settings::load(&p).unwrap();
        assert_eq!((old.model(Provider::Anthropic), old.anthropic.method, old.of(Provider::Xai).consent), ("claude-x", Method::Cli, false));
        // 저장소 규칙 따르기는 기본 켬(예전 파일 포함), 끄면 저장된다
        assert!(old.conventions && Settings::default().conventions);
        let off = Settings { conventions: false, ..Default::default() };
        off.save(&p).unwrap();
        assert!(!Settings::load(&p).unwrap().conventions);
    }

    #[test]
    fn key_names_are_per_provider() {
        let names: Vec<_> = Provider::ALL.iter().map(|p| p.key_name()).collect();
        assert_eq!(names, ["ai:anthropic", "ai:openai", "ai:google", "ai:xai"]);
        assert_eq!(KEY_NAME, "ai:anthropic");
        assert_eq!(serde_json::to_string(&Provider::Xai).unwrap(), "\"xai\"");
    }

    #[test]
    fn key_store_never_leaks_into_status() {
        let store = Mem::default();
        let a = Provider::Anthropic;
        assert!(key_set(&store, a, "  ").is_err());
        assert!(key_set(&store, a, "sk ant").is_err());
        key_set(&store, a, " sk-ant-secret ").unwrap();
        key_set(&store, Provider::Openai, "sk-openai-secret").unwrap();
        assert_eq!(key_get(&store, a).unwrap().as_deref(), Some("sk-ant-secret"));
        assert!(key_get(&store, Provider::Google).unwrap().is_none(), "공급자마다 따로 저장");
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        // PATH를 비워 어떤 CLI도 감지되지 않게 한다
        let st = rt.block_on(status(&Settings::default(), Some("/nonexistent"), &store)).unwrap();
        assert!(st.current.key && !st.current.cli && st.current.active == Some(Active::Key) && st.current.provider == a);
        let keys: Vec<_> = st.providers.iter().map(|p| (p.provider, p.key, p.active)).collect();
        assert_eq!(keys, [(a, true, Some(Active::Key)), (Provider::Openai, true, Some(Active::Key)), (Provider::Google, false, None), (Provider::Xai, false, None)]);
        let json = serde_json::to_string(&st).unwrap();
        assert!(!json.contains("secret"));
        // 선택된 공급자의 필드는 최상위에, 전체는 providers에
        let v: Value = serde_json::from_str(&json).unwrap();
        assert_eq!((v["provider"].as_str(), v["key"].as_bool(), v["providers"].as_array().map(Vec::len), v["providers"][1]["provider"].as_str()), (Some("anthropic"), Some(true), Some(4), Some("openai")));
        let sel = Settings { provider: Provider::Google, ..Default::default() };
        assert!(matches!(rt.block_on(backend(&sel, Some("/nonexistent"), &store)), Err(Error::NoBackend)));
        key_delete(&store, a).unwrap();
        assert!(key_get(&store, a).unwrap().is_none());
    }

    #[test]
    fn errors_are_korean_and_too_large_mentions_sizes() {
        let e = Error::TooLarge { size: 212_345, limit: MAX_INPUT_BYTES }.to_string();
        assert!(e.contains("212KB") && e.contains("200KB") && e.contains("Pick fewer files"), "{e}");
        assert!(Error::Refused(Provider::Anthropic, Some("cyber".into())).to_string().contains("category: cyber"));
        assert!(!Error::Refused(Provider::Anthropic, None).to_string().contains("category"));
        // 공급자 이름이 문구에 들어가고 다른 회사 이름은 없다
        let e = Error::Refused(Provider::Openai, None).to_string() + &Error::Overloaded(Provider::Google, 503).to_string() + &Error::Cli(Provider::Xai, "x".into()).to_string();
        assert!(e.contains("OpenAI") && e.contains("Google") && e.contains("Grok CLI") && !e.contains("Claude") && !e.contains("Anthropic"), "{e}");
    }
}
