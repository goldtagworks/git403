//! AI 공급자. 공급자마다 CLI 로그인 위임(OAuth는 CLI가 보관, 앱은 토큰을 다루지 않음)과 API 키 두 방식을 가진다.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[default]
    Anthropic,
    Openai,
    Google,
    Xai,
}

impl Provider {
    pub const ALL: [Provider; 4] = [Provider::Anthropic, Provider::Openai, Provider::Google, Provider::Xai];

    /// 키체인 항목 이름 (서비스 `git403`). Anthropic은 기존 이름 유지
    pub fn key_name(self) -> &'static str {
        match self {
            Provider::Anthropic => "ai:anthropic",
            Provider::Openai => "ai:openai",
            Provider::Google => "ai:google",
            Provider::Xai => "ai:xai",
        }
    }

    /// 오류 문구에 쓰는 회사 이름
    pub fn label(self) -> &'static str {
        match self {
            Provider::Anthropic => "Anthropic",
            Provider::Openai => "OpenAI",
            Provider::Google => "Google",
            Provider::Xai => "xAI",
        }
    }

    pub fn cli_name(self) -> &'static str {
        match self {
            Provider::Anthropic => "Claude Code CLI",
            Provider::Openai => "Codex CLI",
            Provider::Google => "Gemini CLI",
            Provider::Xai => "Grok CLI",
        }
    }

    /// PATH에서 찾는 실행 파일 이름
    pub fn program(self) -> &'static str {
        match self {
            Provider::Anthropic => "claude",
            Provider::Openai => "codex",
            Provider::Google => "gemini",
            Provider::Xai => "grok",
        }
    }

    /// 로그인 안내용 명령 (사용자가 터미널에서 실행)
    pub fn login_cmd(self) -> &'static str {
        match self {
            Provider::Anthropic => "claude",
            Provider::Openai => "codex login",
            Provider::Google => "gemini",
            Provider::Xai => "grok login",
        }
    }

    /// 설치 감지 인자. Grok은 `--version` 플래그가 문서에 없고 `grok version` 하위 명령이 있다(docs.x.ai/build/cli/reference).
    pub fn version_args(self) -> &'static [&'static str] {
        match self {
            Provider::Xai => &["version"],
            _ => &["--version"],
        }
    }

    /// 설정에 모델이 비어 있을 때 쓰는 API 키 방식 기본 모델 (CLI 방식은 CLI 설정을 따른다)
    pub fn default_model(self) -> &'static str {
        match self {
            Provider::Anthropic => crate::DEFAULT_MODEL,
            // 아래 셋은 2026-10 각사 모델 문서(developers.openai.com/api/docs/models, ai.google.dev/gemini-api/docs/models, docs.x.ai/docs/models) 기준
            Provider::Openai => "gpt-6-astra",
            Provider::Google => "gemini-4-argon",
            Provider::Xai => "grok-4.7",
        }
    }

    pub fn api_base(self) -> &'static str {
        match self {
            Provider::Anthropic => "https://api.anthropic.com",
            Provider::Openai => "https://api.openai.com",
            Provider::Google => "https://generativelanguage.googleapis.com",
            Provider::Xai => "https://api.x.ai",
        }
    }
}
