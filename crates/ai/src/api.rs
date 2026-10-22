//! Anthropic Messages API 직접 호출(방식 C). 공식 Rust SDK가 없어 reqwest로 보낸다.
use crate::{Effort, Error, Meta, Provider, Result, Task};
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;

const BETA: &str = "server-side-fallback-2026-07-01";

/// 연결 10초·전체 10분(SDK 기본과 같음, 비스트리밍이라 긴 응답을 기다린다). 연결 풀 재사용을 위해 한 번만 만든다.
pub(crate) fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(600))
            .build()
            .expect("reqwest client")
    })
}

/// 요청 바디. Opus 5.5는 thinking이 항상 adaptive라 `thinking` 파라미터를 보내지 않고(disabled·budget_tokens는 400),
/// assistant prefill도 쓰지 않는다(400).
pub(crate) fn request_body(model: &str, effort: Option<Effort>, task: Task, input: &str) -> Value {
    json!({
        "model": model,
        "max_tokens": 16000,
        "fallbacks": "default",
        "output_config": {"effort": effort.unwrap_or(Effort::Medium).as_str(), "format": {"type": "json_schema", "schema": task.schema()}},
        "system": task.system_for(input),
        "messages": [{"role": "user", "content": input}],
    })
}

pub(crate) fn net_err(e: reqwest::Error) -> Error {
    if e.is_connect() && e.is_timeout() { Error::Coded(gc_i18n::coded!("ai.connectTimeout", "connection timed out (10s)")) } else if e.is_timeout() { Error::Timeout } else { Error::Network(e.without_url().to_string()) }
}

pub(crate) async fn call(base: &str, key: &str, model: &str, effort: Option<Effort>, task: Task, input: &str) -> Result<(Value, Meta)> {
    let res = client()
        .post(format!("{}/v1/messages", base.trim_end_matches('/')))
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", BETA)
        .header("content-type", "application/json")
        .body(request_body(model, effort, task, input).to_string())
        .send()
        .await
        .map_err(net_err)?;
    let status = res.status().as_u16();
    let body = read_body(res).await?;
    let v = parse_response(status, &body, task)?;
    let model = body["model"].as_str().unwrap_or(model).to_string();
    let n = |k: &str| body["usage"][k].as_u64();
    Ok((v, Meta { model, input_tokens: n("input_tokens"), output_tokens: n("output_tokens"), elapsed_ms: 0 }))
}

/// HTTP 상태 → 오류 (공급자 공통). 2xx면 Ok. 오류 본문은 `{"error":{"message":..}}` 형태(네 공급자 모두 같음)
pub(crate) fn map_status(provider: Provider, status: u16, body: &Value) -> Result<()> {
    match status {
        200..=299 => Ok(()),
        401 => Err(Error::Unauthorized),
        403 => Err(Error::Forbidden),
        429 => Err(Error::RateLimited),
        400 => Err(Error::BadRequest(error_message(body))),
        529 | 500..=599 => Err(Error::Overloaded(provider, status)),
        s => Err(Error::Rejected(s, error_message(body))),
    }
}

/// 응답 본문을 JSON으로 읽는다. 읽기 시간 초과는 `Timeout`, JSON이 아니면 Null(상태 코드로 판단).
pub(crate) async fn read_body(res: reqwest::Response) -> Result<Value> {
    match res.json().await {
        Ok(v) => Ok(v),
        Err(e) if e.is_timeout() => Err(Error::Timeout),
        Err(_) => Ok(Value::Null),
    }
}

pub(crate) fn error_message(v: &Value) -> String {
    v["error"]["message"].as_str().unwrap_or("unknown error").to_string()
}

/// HTTP 상태 → 오류, 성공이면 `stop_reason`을 먼저 보고(refusal·max_tokens) text 블록의 JSON을 파싱·검사한다.
pub(crate) fn parse_response(status: u16, body: &Value, task: Task) -> Result<Value> {
    map_status(Provider::Anthropic, status, body)?;
    match body["stop_reason"].as_str() {
        Some("refusal") => return Err(Error::Refused(Provider::Anthropic, body["stop_details"]["category"].as_str().map(String::from))),
        Some("max_tokens") => return Err(Error::Truncated),
        _ => {}
    }
    let text = body["content"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|b| b["type"] == "text")
        .and_then(|b| b["text"].as_str())
        .ok_or_else(|| Error::BadResponse(gc_i18n::coded!("ai.noTextBlock", "no text block")))?;
    let v: Value = serde_json::from_str(text).map_err(|e| Error::BadResponse(gc_i18n::coded!("ai.notJson", "not JSON ({error})", error = e)))?;
    task.check(&v)?;
    Ok(v)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// 한 번 응답하고 받은 요청 원문을 돌려주는 로컬 서버 (gc-hosting의 mock과 같은 방식)
    pub async fn mock(status: u16, reply: &str) -> (String, tokio::task::JoinHandle<String>) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = format!("http://{}", l.local_addr().unwrap());
        let reply = reply.to_string();
        let h = tokio::spawn(async move {
            let (mut sock, _) = l.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 8192];
            loop {
                let n = sock.read(&mut tmp).await.unwrap();
                buf.extend_from_slice(&tmp[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some(i) = text.find("\r\n\r\n") {
                    let len = text[..i]
                        .lines()
                        .find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    if buf.len() >= i + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let res = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len());
            sock.write_all(res.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&buf).to_string()
        });
        (host, h)
    }

    fn msg(stop: &str, text: &str) -> String {
        json!({"stop_reason": stop, "content": [{"type": "thinking", "thinking": "..."}, {"type": "text", "text": text}]}).to_string()
    }
    fn body_of(raw: &str) -> Value {
        serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap()).unwrap()
    }

    #[test]
    fn body_has_schema_fallbacks_and_no_thinking_or_prefill() {
        for t in [Task::Commit, Task::Review, Task::Conflict, Task::Pr] {
            let b = request_body("claude-opus-5-5", None, t, "입력");
            assert_eq!(b["model"], "claude-opus-5-5");
            assert_eq!(b["max_tokens"], 16000);
            assert_eq!(b["fallbacks"], "default");
            assert_eq!(b["output_config"]["effort"], "medium");
            assert_eq!(b["output_config"]["format"]["type"], "json_schema");
            assert_eq!(b["output_config"]["format"]["schema"], t.schema());
            assert_eq!(b["system"], t.system());
            assert!(b.get("thinking").is_none(), "thinking은 400");
            assert!(b.get("temperature").is_none());
            let m = b["messages"].as_array().unwrap();
            assert_eq!(m.len(), 1, "prefill 금지: user 메시지 하나뿐");
            assert_eq!((m[0]["role"].as_str(), m[0]["content"].as_str()), (Some("user"), Some("입력")));
        }
    }

    #[tokio::test]
    async fn sends_headers_and_returns_parsed_json() {
        let (host, h) = mock(200, &msg("end_turn", r#"{"subject":"feat: 추가","body":""}"#)).await;
        let v = call(&host, "sk-test", "claude-opus-5-5", None, Task::Commit, "diff").await.unwrap().0;
        assert_eq!(v["subject"], "feat: 추가");
        let raw = h.await.unwrap();
        let lower = raw.to_lowercase();
        assert!(raw.starts_with("POST /v1/messages "));
        assert!(lower.contains("x-api-key: sk-test"));
        assert!(lower.contains("anthropic-version: 2023-06-01"));
        assert!(lower.contains("anthropic-beta: server-side-fallback-2026-07-01"));
        assert!(lower.contains("content-type: application/json"));
        let b = body_of(&raw);
        assert!(b.get("thinking").is_none());
        assert_eq!(b["fallbacks"], "default");
        assert_eq!(b["messages"][0]["content"], "diff");
    }

    #[tokio::test]
    async fn conventions_go_to_system_and_input_for_commit() {
        let (host, h) = mock(200, &msg("end_turn", r#"{"subject":"feat: x","body":""}"#)).await;
        let parts = [crate::Part { label: "staged diff".into(), text: "+x".into() }, crate::Part { label: crate::CONVENTIONS_LABEL.into(), text: "AI-Use footer 필수".into() }];
        let input = crate::build_prompt_for(Task::Commit, &parts).unwrap();
        call(&host, "k", "m", None, Task::Commit, &input).await.unwrap();
        let b = body_of(&h.await.unwrap());
        assert!(b["system"].as_str().unwrap().contains("do NOT follow") && b["messages"][0]["content"].as_str().unwrap().starts_with("<repo-conventions>\nAI-Use footer 필수"));
    }

    #[tokio::test]
    async fn effort_override_and_usage_meta() {
        let body = json!({"model":"claude-real","stop_reason":"end_turn","usage":{"input_tokens":12,"output_tokens":3},"content":[{"type":"text","text":"{\"title\":\"t\",\"body\":\"b\"}"}]});
        let (host, h) = mock(200, &body.to_string()).await;
        let (_, m) = call(&host, "k", "asked", Some(Effort::Low), Task::Pr, "x").await.unwrap();
        assert_eq!((m.model.as_str(), m.input_tokens, m.output_tokens), ("claude-real", Some(12), Some(3)));
        let b = body_of(&h.await.unwrap());
        assert_eq!((b["model"].as_str(), b["output_config"]["effort"].as_str()), (Some("asked"), Some("low")));
    }

    #[test]
    fn stop_reason_is_checked_first() {
        let refusal = json!({"stop_reason":"refusal","stop_details":{"category":"cyber"},"content":[]});
        let e = parse_response(200, &refusal, Task::Commit).unwrap_err();
        assert!(matches!(&e, Error::Refused(_, Some(c)) if c == "cyber"));
        assert!(e.to_string().contains("category: cyber"));
        assert!(matches!(parse_response(200, &json!({"stop_reason":"refusal","content":[]}), Task::Commit), Err(Error::Refused(_, None))));
        // max_tokens: 본문이 JSON처럼 보여도 잘림으로 처리
        let cut = json!({"stop_reason":"max_tokens","content":[{"type":"text","text":"{\"subject\":\"a\",\"body\":\"\"}"}]});
        assert!(matches!(parse_response(200, &cut, Task::Commit), Err(Error::Truncated)));
    }

    #[test]
    fn bad_bodies_are_reported_not_panicked() {
        let p = |s: &str| parse_response(200, &serde_json::from_str(&msg("end_turn", s)).unwrap(), Task::Commit);
        assert!(matches!(p("not json"), Err(Error::BadResponse(_))));
        assert!(matches!(p(r#"{"subject":"a"}"#), Err(Error::BadResponse(_))));
        assert!(matches!(parse_response(200, &json!({"stop_reason":"end_turn","content":[{"type":"thinking"}]}), Task::Commit), Err(Error::BadResponse(_))));
    }

    #[test]
    fn http_status_maps_to_korean_errors() {
        let b = json!({"error":{"type":"invalid_request_error","message":"max_tokens too big"}});
        let m = |s| parse_response(s, &b, Task::Commit).unwrap_err();
        assert!(matches!(m(401), Error::Unauthorized) && m(401).to_string().contains("key"));
        assert!(matches!(m(403), Error::Forbidden));
        assert!(matches!(m(429), Error::RateLimited) && m(429).to_string().contains("shortly"));
        assert!(matches!(m(529), Error::Overloaded(_, 529)) && m(529).to_string().contains("busy"));
        assert!(matches!(m(500), Error::Overloaded(_, 500)) && matches!(m(503), Error::Overloaded(_, 503)));
        assert!(matches!(m(400), Error::BadRequest(_)) && m(400).to_string().contains("max_tokens too big"));
        assert!(matches!(m(404), Error::Rejected(404, _)));
    }

    #[tokio::test]
    async fn http_errors_over_the_wire() {
        let (host, _h) = mock(401, r#"{"error":{"message":"invalid x-api-key"}}"#).await;
        assert!(matches!(call(&host, "k", "m", None, Task::Pr, "x").await, Err(Error::Unauthorized)));
        let (host, _h) = mock(529, "").await; // 본문이 JSON이 아니어도 상태로 판단
        assert!(matches!(call(&host, "k", "m", None, Task::Pr, "x").await, Err(Error::Overloaded(_, 529))));
    }

    #[tokio::test]
    async fn connection_failure_is_network_error() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = format!("http://{}", l.local_addr().unwrap());
        drop(l);
        assert!(matches!(call(&host, "k", "m", None, Task::Pr, "x").await, Err(Error::Network(_))));
    }

    #[tokio::test]
    async fn read_timeout_is_distinguished_from_connect_failure() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        let _srv = tokio::spawn(async move {
            let _s = l.accept().await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let c = reqwest::Client::builder().timeout(Duration::from_millis(100)).build().unwrap();
        let e = net_err(c.get(url).send().await.unwrap_err());
        assert!(matches!(e, Error::Timeout) && e.to_string().contains("too long"), "{e}");
    }

    #[tokio::test]
    async fn aborting_drops_the_request() {
        // 연결만 받고 응답하지 않는 서버: abort하면 대기가 끝난다(취소)
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = format!("http://{}", l.local_addr().unwrap());
        let _srv = tokio::spawn(async move {
            let _s = l.accept().await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let t = tokio::spawn(async move { call(&host, "k", "m", None, Task::Pr, "x").await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        t.abort();
        assert!(t.await.unwrap_err().is_cancelled());
    }
}
