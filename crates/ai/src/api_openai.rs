//! OpenAI Responses API(`POST /v1/responses`)와 xAI(같은 형식의 `https://api.x.ai/v1/responses`, docs.x.ai structured-outputs).
//! 구조화 출력은 `text.format`의 json_schema strict, 인증은 `Authorization: Bearer`.
use crate::api::{client, map_status, net_err, read_body};
use crate::{Effort, Error, Meta, Provider, Result, Task};
use serde_json::{json, Value};

/// 요청 바디. `store:false`(서버에 저장하지 않음). `reasoning.effort`는 사용자가 명시했을 때 OpenAI에만 보낸다
/// (추론 모델이 아니거나 xAI Grok 4 계열은 그 파라미터를 거부할 수 있다). `max_output_tokens`는 두지 않는다(추론 토큰이 잘려 빈 응답이 되는 것을 피함).
pub(crate) fn request_body(provider: Provider, model: &str, effort: Option<Effort>, task: Task, input: &str) -> Value {
    let mut b = json!({
        "model": model,
        "store": false,
        "instructions": task.system_for(input),
        "input": input,
        "text": {"format": {"type": "json_schema", "name": "git403_result", "schema": task.schema(), "strict": true}},
    });
    if let (Provider::Openai, Some(e)) = (provider, effort) {
        b["reasoning"] = json!({"effort": e.as_str()});
    }
    b
}

pub(crate) async fn call(provider: Provider, base: &str, key: &str, model: &str, effort: Option<Effort>, task: Task, input: &str) -> Result<(Value, Meta)> {
    let res = client()
        .post(format!("{}/v1/responses", base.trim_end_matches('/')))
        .bearer_auth(key)
        .header("content-type", "application/json")
        .body(request_body(provider, model, effort, task, input).to_string())
        .send()
        .await
        .map_err(net_err)?;
    let status = res.status().as_u16();
    let body = read_body(res).await?;
    let v = parse_response(provider, status, &body, task)?;
    let n = |k: &str| body["usage"][k].as_u64();
    Ok((v, Meta { model: body["model"].as_str().unwrap_or(model).to_string(), input_tokens: n("input_tokens"), output_tokens: n("output_tokens"), elapsed_ms: 0 }))
}

/// HTTP 상태 → 오류, 성공이면 `status: incomplete`(길이 제한)와 `refusal` 항목을 먼저 보고 `output_text` JSON을 파싱·검사한다.
pub(crate) fn parse_response(provider: Provider, status: u16, body: &Value, task: Task) -> Result<Value> {
    map_status(provider, status, body)?;
    if body["status"] == "incomplete" {
        return Err(if body["incomplete_details"]["reason"] == "content_filter" { Error::Refused(provider, Some("content_filter".into())) } else { Error::Truncated });
    }
    let parts: Vec<&Value> = body["output"].as_array().into_iter().flatten().filter(|o| o["type"] == "message").flat_map(|o| o["content"].as_array().into_iter().flatten()).collect();
    if parts.iter().any(|c| c["type"] == "refusal") {
        return Err(Error::Refused(provider, None));
    }
    let text = parts
        .iter()
        .find(|c| c["type"] == "output_text")
        .and_then(|c| c["text"].as_str())
        .ok_or_else(|| Error::BadResponse(gc_i18n::coded!("ai.noOutputText", "no output_text")))?;
    let v: Value = serde_json::from_str(text).map_err(|e| Error::BadResponse(gc_i18n::coded!("ai.notJson", "not JSON ({error})", error = e)))?;
    task.check(&v)?;
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::tests::mock;

    fn msg(text: &str) -> String {
        json!({"model":"gpt-real","status":"completed","usage":{"input_tokens":9,"output_tokens":4},
            "output":[{"type":"reasoning","summary":[]},{"type":"message","content":[{"type":"output_text","text":text}]}]})
        .to_string()
    }

    #[test]
    fn body_has_strict_schema_and_effort_only_for_openai() {
        for t in [Task::Commit, Task::Review, Task::Conflict, Task::Pr, Task::Guide, Task::PrReview] {
            let b = request_body(Provider::Openai, "m", None, t, "입력");
            assert_eq!((b["text"]["format"]["type"].as_str(), b["text"]["format"]["strict"].as_bool()), (Some("json_schema"), Some(true)));
            assert_eq!(b["text"]["format"]["schema"], t.schema());
            assert_eq!((b["instructions"].as_str(), b["input"].as_str(), b["store"].as_bool()), (Some(t.system().as_str()), Some("입력"), Some(false)));
            assert!(b.get("reasoning").is_none() && b.get("max_output_tokens").is_none());
        }
        assert_eq!(request_body(Provider::Openai, "m", Some(Effort::Low), Task::Pr, "x")["reasoning"]["effort"], "low");
        assert!(request_body(Provider::Xai, "m", Some(Effort::Low), Task::Pr, "x").get("reasoning").is_none());
    }

    #[tokio::test]
    async fn sends_bearer_and_parses_for_openai_and_xai() {
        for p in [Provider::Openai, Provider::Xai] {
            let (host, h) = mock(200, &msg(r#"{"title":"t","body":"b"}"#)).await;
            let (v, m) = call(p, &host, "sk-test", "asked", None, Task::Pr, "diff").await.unwrap();
            assert_eq!(v["title"], "t");
            assert_eq!((m.model.as_str(), m.input_tokens, m.output_tokens), ("gpt-real", Some(9), Some(4)));
            let raw = h.await.unwrap();
            assert!(raw.starts_with("POST /v1/responses "), "{raw}");
            assert!(raw.to_lowercase().contains("authorization: bearer sk-test"));
            let b: Value = serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap()).unwrap();
            assert_eq!((b["model"].as_str(), b["input"].as_str()), (Some("asked"), Some("diff")));
        }
    }

    #[test]
    fn errors_are_neutral_and_named_by_provider() {
        let ok = |s: &str| serde_json::from_str::<Value>(&msg(s)).unwrap();
        let p = |v: &Value| parse_response(Provider::Xai, 200, v, Task::Pr);
        assert!(matches!(p(&ok("not json")), Err(Error::BadResponse(_))));
        assert!(matches!(p(&ok(r#"{"title":"t"}"#)), Err(Error::BadResponse(_))));
        let refusal = json!({"output":[{"type":"message","content":[{"type":"refusal","refusal":"no"}]}]});
        let e = p(&refusal).unwrap_err();
        assert!(matches!(e, Error::Refused(Provider::Xai, None)) && e.to_string().contains("xAI") && !e.to_string().contains("Claude"), "{e}");
        let cut = json!({"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]});
        assert!(matches!(p(&cut), Err(Error::Truncated)));
        let e = parse_response(Provider::Openai, 503, &Value::Null, Task::Pr).unwrap_err();
        assert!(matches!(e, Error::Overloaded(Provider::Openai, 503)) && e.to_string().contains("OpenAI") && !e.to_string().contains("Anthropic"), "{e}");
        assert!(matches!(parse_response(Provider::Openai, 400, &json!({"error":{"message":"bad schema"}}), Task::Pr), Err(Error::BadRequest(m)) if m == "bad schema"));
    }

    #[tokio::test]
    async fn http_errors_over_the_wire() {
        let (host, _h) = mock(401, r#"{"error":{"message":"Incorrect API key"}}"#).await;
        assert!(matches!(call(Provider::Openai, &host, "k", "m", None, Task::Pr, "x").await, Err(Error::Unauthorized)));
        let (host, _h) = mock(429, "").await;
        assert!(matches!(call(Provider::Xai, &host, "k", "m", None, Task::Pr, "x").await, Err(Error::RateLimited)));
    }
}
