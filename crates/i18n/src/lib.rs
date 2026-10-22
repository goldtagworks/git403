//! locale 상태(AI 응답 언어용)와 코드 있는 오류(`Coded`). 사용자에게 보이는 문구의 번역은 UI 사전이 한다.

use std::sync::atomic::{AtomicU8, Ordering};

static LOCALE: AtomicU8 = AtomicU8::new(0); // SUPPORTED_LOCALES 인덱스 (0 = en)

/// UI의 `LOCALES`(ui/src/shared/lib/settings.ts)와 같은 목록
pub const SUPPORTED_LOCALES: &[&str] = &[
    "en", "ko", "zh-CN", "zh-TW", "vi", "ja", "tl", "km", "uz", "lo", "ru", "th", "mn", "ne",
    "de", "fr", "es", "pt-BR", "it", "pl", "tr", "uk", "nl",
];

/// `ko-KR`·`ko_KR.UTF-8`처럼 지역이 붙어도 언어로 맞춘다. 목록에 없으면 en.
pub fn set(locale: &str) {
    let v = locale.trim().to_ascii_lowercase().replace('_', "-");
    let normalized = if v.starts_with("zh-tw") || v.starts_with("zh-hk") || v.starts_with("zh-mo") || v.starts_with("zh-hant") { "zh-TW" }
        else if v.starts_with("zh") { "zh-CN" }
        else if v.starts_with("pt") { "pt-BR" }
        else if v.starts_with("fil") { "tl" }
        else { SUPPORTED_LOCALES.iter().find(|x| v.split('-').next() == Some(&x.to_ascii_lowercase())).copied().unwrap_or("en") };
    let index = SUPPORTED_LOCALES.iter().position(|x| *x == normalized).unwrap_or(0) as u8;
    LOCALE.store(index, Ordering::Relaxed);
}

/// 현재 locale 코드
pub fn locale() -> &'static str {
    SUPPORTED_LOCALES.get(LOCALE.load(Ordering::Relaxed) as usize).copied().unwrap_or("en")
}

pub fn language_name() -> &'static str {
    match locale() {
        "ko" => "Korean", "zh-CN" => "Simplified Chinese", "zh-TW" => "Traditional Chinese",
        "vi" => "Vietnamese", "ja" => "Japanese", "tl" => "Filipino", "km" => "Khmer",
        "uz" => "Uzbek", "lo" => "Lao", "ru" => "Russian", "th" => "Thai",
        "mn" => "Mongolian", "ne" => "Nepali", "de" => "German", "fr" => "French", "es" => "Spanish",
        "pt-BR" => "Brazilian Portuguese", "it" => "Italian", "pl" => "Polish", "tr" => "Turkish",
        "uk" => "Ukrainian", "nl" => "Dutch", _ => "English",
    }
}

/// 사용자에게 보이는 오류·경고: 코드 + 인자 + 영어 원문. 번역은 UI 사전이 `code`로 찾고 `vars`로 채운다.
/// IPC에는 `json()`(`{"code","vars","message"}` 문자열)으로 보낸다. `Display`는 영어 원문.
#[derive(Debug, Clone, PartialEq)]
pub struct Coded {
    pub code: &'static str,
    pub vars: Vec<(&'static str, String)>,
    pub message: String,
}

impl Coded {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, vars: vec![], message: message.into() }
    }

    pub fn var(mut self, name: &'static str, value: impl ToString) -> Self {
        self.vars.push((name, value.to_string()));
        self
    }

    pub fn value(&self) -> serde_json::Value {
        let vars: serde_json::Map<_, _> = self.vars.iter().map(|(k, v)| (k.to_string(), serde_json::Value::String(v.clone()))).collect();
        serde_json::json!({"code": self.code, "vars": vars, "message": self.message})
    }

    /// IPC `Err(String)`으로 보낼 JSON 문자열
    pub fn json(&self) -> String {
        self.value().to_string()
    }
}

impl std::fmt::Display for Coded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// `coded!("blob.tooLarge", "too large ({mb} MB)", mb = mb)` — 영어 문구의 `{이름}`을 채우고 같은 값을 vars에 넣는다.
#[macro_export]
macro_rules! coded {
    ($code:expr, $msg:literal $(, $k:ident = $v:expr)* $(,)?) => {
        $crate::Coded::new($code, format!($msg $(, $k = $v)*))$(.var(stringify!($k), &$v))*
    };
}

/// OS 설정으로 초기 locale을 정한다(앱 시작 직후, UI가 `set_locale`을 부르기 전).
/// 환경변수 `LC_ALL`·`LC_MESSAGES`·`LANG` → macOS는 `defaults read -g AppleLanguages` 첫 항목.
pub fn init_from_os() {
    for k in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(v) = std::env::var(k) {
            if !v.is_empty() {
                return set(&v);
            }
        }
    }
    #[cfg(target_os = "macos")]
    if let Ok(o) = std::process::Command::new("defaults").args(["read", "-g", "AppleLanguages"]).output() {
        // 출력: `(\n    "ko-KR",\n    "en-KR"\n)` — 첫 따옴표 항목
        let s = String::from_utf8_lossy(&o.stdout);
        if let Some(first) = s.split('"').nth(1) {
            set(first);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_전환() {
        set("ko-KR");
        assert_eq!((locale(), language_name()), ("ko", "Korean"));
        set("ko_KR.UTF-8");
        assert_eq!(locale(), "ko");
        set("zh_HK");
        assert_eq!(locale(), "zh-TW");
        set("fr_FR.UTF-8");
        assert_eq!((locale(), language_name()), ("fr", "French"));
        set("pt-PT");
        assert_eq!(locale(), "pt-BR");
        set("fil-PH");
        assert_eq!(locale(), "tl");
        set("ar");
        assert_eq!((locale(), language_name()), ("en", "English"));
        set("");
        assert_eq!(locale(), "en");
    }

    #[test]
    fn coded_직렬화() {
        let n = 5;
        let c = coded!("a.b", "has {n} \"x\" and {name}", n = n, name = "k");
        assert_eq!(c.message, "has 5 \"x\" and k");
        let v: serde_json::Value = serde_json::from_str(&c.json()).unwrap();
        assert_eq!((v["code"].as_str(), v["vars"]["n"].as_str(), v["vars"]["name"].as_str()), (Some("a.b"), Some("5"), Some("k")));
    }
}
