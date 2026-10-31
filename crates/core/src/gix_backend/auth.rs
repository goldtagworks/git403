//! 원격 인증: git의 credential 규칙 + 앱 계정 토큰. clone·fetch·pull·push가 같은 `authenticator`를 쓴다.
//!
//! 우선순위(데스크탑 git의 `-c credential.<host>.helper=!gh …`가 설정 helper보다 뒤에 오는 것과 같은 방향): ① URL의 `user:token@`·저장소/전역 설정의 `credential.helper`
//! (gix가 직접 처리, 이때는 터미널 프롬프트를 끈다) → ② 앱 계정(`set_token_source`로 등록한 `TokenSource`, 원격 URL 호스트 기준) → ③ 둘 다 없으면 원래 설정대로 프롬프트(askpass).
//! 계정 토큰은 gix 메모리에서 HTTP 인증 헤더로만 가고, 설정·URL·reflog·로그·오류 메시지에 쓰지 않는다. 계정에서 온 자격 증명에 대한 `store`/`erase` 후속 동작은 helper로 넘기지 않는다
//! (`~/.git-credentials` 같은 곳에 토큰이 새지 않게). 인증 실패는 `auth_error`(기존 오류 코드 `hosting.unauthorized`)로 낸다.

use std::sync::{Arc, RwLock};

use gix::credentials::helper::{Action, NextAction};
use gix::bstr::ByteSlice;
use gix::credentials::protocol::Outcome;

use crate::Error;

/// 호스트(`github.com`, 포트가 있으면 `host:port`)에 연결된 앱 계정의 (사용자 이름, 토큰).
pub trait TokenSource: Send + Sync {
    fn token(&self, host: &str) -> Option<(String, String)>;
}

static SOURCE: RwLock<Option<Arc<dyn TokenSource>>> = RwLock::new(None);

/// 앱 계정 토큰 공급자를 등록한다(프로세스 전체, 없애려면 `None`).
pub fn set_token_source(source: Option<Arc<dyn TokenSource>>) {
    *SOURCE.write().unwrap_or_else(|e| e.into_inner()) = source;
}

fn account_for(url: &gix::url::Url) -> Option<(String, String)> {
    let source = SOURCE.read().unwrap_or_else(|e| e.into_inner()).clone()?;
    let host = url.host()?.to_owned();
    match url.port {
        Some(p) => source.token(&format!("{host}:{p}")).or_else(|| source.token(&host)),
        None => source.token(&host),
    }
}

/// 이 저장소의 설정 + 앱 계정으로 자격 증명을 구하는 함수(`Connection::set_credentials`·`with_credentials`에 넘긴다).
pub(super) fn authenticator(repo: gix::Repository) -> gix::remote::AuthenticateFn<'static> {
    let mut cascade: Option<(gix::credentials::helper::Cascade, gix::prompt::Options)> = None;
    let mut from_account = false;
    Box::new(move |action: Action| {
        match &action {
            Action::Get(ctx) => {
                let Some(url) = ctx.url.clone().or_else(|| ctx.to_url()) else { return Ok(None) };
                let parsed = gix::url::parse(url.as_bstr())?;
                let (mut c, _, prompt) = repo.config_snapshot().credential_helpers(parsed.clone())?;
                let mut quiet = prompt.clone();
                quiet.mode = gix::prompt::Mode::Disable;
                from_account = false;
                if let Ok(Some(found)) = c.invoke(action.clone(), quiet) {
                    cascade = Some((c, prompt));
                    return Ok(Some(found));
                }
                if let Some((username, password)) = account_for(&parsed) {
                    from_account = true;
                    cascade = Some((c, prompt));
                    let identity = gix::sec::identity::Account { username, password, oauth_refresh_token: None };
                    return Ok(Some(Outcome { identity, next: NextAction::from(ctx.clone()) }));
                }
                let out = c.invoke(action, prompt.clone());
                cascade = Some((c, prompt));
                out
            }
            _ if from_account => Ok(None),
            _ => match cascade.as_mut() {
                Some((c, prompt)) => c.invoke(action, prompt.clone()),
                None => Ok(None),
            },
        }
    })
}

/// 연결·인증 단계 오류를 사용자에게 보일 형태로 바꾼다. 인증 실패는 UI가 계정 연결을 안내하는 기존 코드 `hosting.unauthorized`,
/// 그 밖은 git의 `fatal:` 형식(128).
pub(super) fn map_error(e: impl std::fmt::Display + std::fmt::Debug) -> Error {
    let text = format!("{e:?} {e}").to_ascii_lowercase();
    if ["credentials", "authenticat", "unauthorized", "terminal prompts", "prompt", " 401"].iter().any(|k| text.contains(k)) {
        return auth_error();
    }
    super::common::fail(e)
}

pub(super) fn auth_error() -> Error {
    Error::Coded(gc_i18n::coded!("hosting.unauthorized", "Authentication failed. Check that the token is correct and has not expired"))
}
