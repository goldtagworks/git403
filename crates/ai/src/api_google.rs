//! Gemini API `POST /v1beta/models/{model}:generateContent`. 인증은 `x-goog-api-key`,
//! 구조화 출력은 `generationConfig.responseMimeType: application/json` + `responseJsonSchema`.
use crate::api::{client, map_status, net_err, read_body};
use crate::{Error, Meta, Provider, Result, Task};
use serde_json::{json, Value};

pub(crate) fn request_body(task: Task, input: &str) -> Value {
    json!({
        "systemInstruction": {"parts": [{"text": task.system_for(input)}]},
        "contents": [{"role": "user", "parts": [{"text": input}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseJsonSchema": task.schema()},
    })
}

pub(crate) async fn call(base: &str, key: &str, model: &str, task: Task, input: &str) -> Result<(Value, Meta)> {
    // 모델 이름은 URL 경로에 들어간다
    if model.is_empty() || !model.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')) {
        return Err(Error::Coded(gc_i18n::coded!("ai.badModel", "invalid model name")));
    }
    let res = client()
        .post(format!("{}/v1beta/models/{model}:generateContent", base.trim_end_matches('/')))
        .header("x-goog-api-key", key)
        .header("content-type", "application/json")
        .body(request_body(task, input).to_string())
        .send()
        .await
        .map_err(net_err)?;
    let status = res.status().as_u16();
    let body = read_body(res).await?;
    let v = parse_response(status, &body, task)?;
    let n = |k: &str| body["usageMetadata"][k].as_u64();
    Ok((v, Meta { model: body["modelVersion"].as_str().unwrap_or(model).to_string(), input_tokens: n("promptTokenCount"), output_tokens: n("candidatesTokenCount"), elapsed_ms: 0 }))
}

/// 잘못된 API 키는 Google이 401이 아니라 400(`API_KEY_INVALID`)으로 돌려주므로 먼저 `Unauthorized`로 바꾼다.
/// 성공이면 차단(`promptFeedback.blockReason`·`finishReason`)과 `MAX_TOKENS`를 먼저 보고, 생각(`thought`) 조각을 뺀 text를 파싱·검사한다.
pub(crate) fn parse_response(status: u16, body: &Value, task: Task) -> Result<Value> {
    let p = Provider::Google;
    if status == 400 && (body["error"]["status"] == "UNAUTHENTICATED" || body["error"]["details"].to_string().contains("API_KEY_INVALID")) {
        return Err(Error::Unauthorized);
    }
    map_status(p, status, body)?;
    if let Some(r) = body["promptFeedback"]["blockReason"].as_str() {
        return Err(Error::Refused(p, Some(r.into())));
    }
    let cand = &body["candidates"][0];
    match cand["finishReason"].as_str() {
        Some("MAX_TOKENS") => return Err(Error::Truncated),
        Some(r @ ("SAFETY" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII" | "RECITATION" | "IMAGE_SAFETY")) => return Err(Error::Refused(p, Some(r.into()))),
        _ => {}
    }
    let text: String = cand["content"]["parts"].as_array().into_iter().flatten().filter(|x| x["thought"] != true).filter_map(|x| x["text"].as_str()).collect();
    if text.is_empty() {
        return Err(Error::BadResponse(gc_i18n::coded!("ai.noTextPart", "no text part")));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| Error::BadResponse(gc_i18n::coded!("ai.notJson", "not JSON ({error})", error = e)))?;
    task.check(&v)?;
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::tests::mock;

    fn reply(text: &str, finish: &str) -> String {
        json!({"modelVersion":"gemini-real","usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":3},
            "candidates":[{"finishReason":finish,"content":{"parts":[{"thought":true,"text":"생각"},{"text":text}]}}]})
        .to_string()
    }

    #[test]
    fn body_has_json_mime_and_schema() {
        for t in [Task::Commit, Task::Review, Task::Conflict, Task::Pr, Task::Guide, Task::PrReview] {
            let b = request_body(t, "입력");
            assert_eq!(b["generationConfig"]["responseMimeType"], "application/json");
            assert_eq!(b["generationConfig"]["responseJsonSchema"], t.schema());
            assert_eq!(b["systemInstruction"]["parts"][0]["text"], t.system());
            assert_eq!(b["contents"][0]["parts"][0]["text"], "입력");
        }
    }

    #[tokio::test]
    async fn sends_key_header_and_skips_thought_parts() {
        let (host, h) = mock(200, &reply(r#"{"title":"t","body":"b"}"#, "STOP")).await;
        let (v, m) = call(&host, "g-key", "gemini-x", Task::Pr, "diff").await.unwrap();
        assert_eq!(v["body"], "b");
        assert_eq!((m.model.as_str(), m.input_tokens, m.output_tokens), ("gemini-real", Some(8), Some(3)));
        let raw = h.await.unwrap();
        assert!(raw.starts_with("POST /v1beta/models/gemini-x:generateContent "), "{raw}");
        assert!(raw.to_lowercase().contains("x-goog-api-key: g-key"));
        assert!(matches!(call("http://127.0.0.1:1", "k", "a/b", Task::Pr, "x").await, Err(Error::Coded(_))), "경로를 바꾸는 모델명 거부");
    }

    #[test]
    fn blocks_truncation_and_bad_key_are_mapped() {
        let r = |v: Value, s| parse_response(s, &v, Task::Pr);
        let e = r(json!({"promptFeedback":{"blockReason":"SAFETY"},"candidates":[]}), 200).unwrap_err();
        assert!(matches!(&e, Error::Refused(Provider::Google, Some(c)) if c == "SAFETY") && e.to_string().contains("Google"), "{e}");
        assert!(matches!(serde_json::from_str::<Value>(&reply("{}", "MAX_TOKENS")).map(|v| r(v, 200)), Ok(Err(Error::Truncated))));
        assert!(matches!(serde_json::from_str::<Value>(&reply("{}", "SAFETY")).map(|v| r(v, 200)), Ok(Err(Error::Refused(..)))));
        let bad = json!({"error":{"code":400,"status":"INVALID_ARGUMENT","message":"API key not valid.","details":[{"reason":"API_KEY_INVALID"}]}});
        assert!(matches!(r(bad, 400), Err(Error::Unauthorized)));
        assert!(matches!(r(json!({"error":{"message":"bad schema"}}), 400), Err(Error::BadRequest(m)) if m == "bad schema"));
        assert!(matches!(r(Value::Null, 503), Err(Error::Overloaded(Provider::Google, 503))));
        assert!(matches!(r(serde_json::from_str(&reply("not json", "STOP")).unwrap(), 200), Err(Error::BadResponse(_))));
        assert!(matches!(r(json!({"candidates":[{"content":{"parts":[]}}]}), 200), Err(Error::BadResponse(_))));
    }

    #[tokio::test]
    async fn http_errors_over_the_wire() {
        let (host, _h) = mock(429, r#"{"error":{"message":"quota"}}"#).await;
        assert!(matches!(call(&host, "k", "m", Task::Pr, "x").await, Err(Error::RateLimited)));
    }
}
