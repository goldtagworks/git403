//! 명령 본문이 함께 쓰는 작은 도구: 오류 문자열 변환, JSON 변환, 블로킹 작업 오프로드, 요청 인자 파싱.

use std::path::PathBuf;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

pub type Res<T> = Result<T, String>;

pub(crate) fn err(e: gc_core::Error) -> String {
    e.ipc()
}

pub(crate) fn json<T: Serialize>(v: T) -> Res<Value> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

/// 블로킹될 수 있는 gc_core 동기 작업을 블로킹 스레드에서 돌린다.
pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> gc_core::Result<T> + Send + 'static) -> Res<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| e.to_string())?.map_err(err)
}

/// 파일·키체인처럼 블로킹될 수 있는 동기 작업을 블로킹 스레드에서 돌린다 (오류 형식이 `String`인 경우).
pub(crate) async fn off<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// 요청 인자 (JSON 객체, 키는 camelCase). 없거나 null이면 `Option`은 None, 그 밖은 오류.
pub(crate) struct Args(pub Value);

impl Args {
    pub fn get<T: DeserializeOwned>(&mut self, key: &str) -> Res<T> {
        let v = self.0.get_mut(key).map(Value::take).unwrap_or(Value::Null);
        serde_json::from_value(v).map_err(|e| format!("invalid argument `{key}`: {e}"))
    }
    pub fn repo(&mut self) -> Res<PathBuf> {
        self.get("repo")
    }
}
