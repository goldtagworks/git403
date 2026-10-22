//! Codex(OpenAI)·Gemini(Google)·Grok(xAI) CLI의 헤드리스 인자와 응답 해석. 실행·감지·타임아웃은 `cli`가 공통으로 한다.
//! 인증은 각 CLI의 로그인(`codex login`·`gemini`·`grok login`)이 보관하고 앱은 토큰을 다루지 않는다.
use crate::cli::extract_json;
use crate::{Error, Meta, Opts, Provider, Result, Task};
use serde_json::Value;

/// Codex: `codex exec`(헤드리스), 프롬프트는 마지막 인자 `-`로 stdin에서 읽는다(`codex exec --help`: "If not provided as an argument (or if `-` is used), instructions are read from stdin").
/// `--json` JSONL 이벤트 스트림, 샌드박스 read-only(`--sandbox`), 승인 never(`-c approval_policy="never"`, exec는 승인 UI가 없다),
/// 웹 검색 끔(`-c web_search="disabled"`), 사용자 config·MCP·execpolicy 규칙 무시(`--ignore-user-config`·`--ignore-rules`, 인증은 CODEX_HOME을 그대로 쓴다),
/// 세션 파일 안 남김(`--ephemeral`), 임시 폴더라 git 저장소 검사 생략, 앱·플러그인·훅·메모리·브라우저·컴퓨터 사용·멀티 에이전트·셸 도구는 `--disable`(`codex features list`의 기능 이름).
/// `--output-schema`/`--output-last-message`는 임시 파일이 필요하고 JSONL로 충분해 쓰지 않는다(스키마는 프롬프트에 넣고 `check`로 검사).
pub(crate) const CODEX_ARGS: &[&str] = &[
    "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--sandbox", "read-only",
    "-c", r#"approval_policy="never""#, "-c", r#"web_search="disabled""#,
    "--disable", "apps", "--disable", "plugins", "--disable", "hooks", "--disable", "memories",
    "--disable", "browser_use", "--disable", "computer_use", "--disable", "multi_agent", "--disable", "shell_tool",
];

/// Gemini: 전체 프롬프트는 stdin, `-p`의 짧은 문장이 그 뒤에 덧붙는다(cli-reference: "-p … Appended to stdin input"). `--output-format json`(단일 객체 `{response, stats, error?}`),
/// 승인 모드 `default`(yolo 금지, 헤드리스에서는 확인이 필요한 도구가 실행되지 않는다), `--extensions none`(모든 확장 끔),
/// `--skip-trust`(임시 폴더의 폴더 신뢰 검사 생략).
/// 확인 못 한 것: 도구·MCP를 끄는 전용 플래그는 문서에 없다(`--allowed-mcp-server-names`는 허용 목록뿐, 설정 파일의 `tools.exclude`는 사용자 설정이라 건드리지 않음). 위 인자와 임시 폴더로 한정한다.
pub(crate) const GEMINI_ARGS: &[&str] = &[
    "-p", "Follow the instructions above. Output only the JSON object.", "--output-format", "json", "--approval-mode", "default", "--extensions", "none", "--skip-trust",
];

/// Grok Build: `-p, --single <PROMPT>`(프롬프트는 인자, stdin 입력은 문서에 없어 쓰지 않는다), `--output-format json`("one JSON object at the end"),
/// `--always-approve`(= yolo)는 주지 않으므로 도구 실행은 승인이 필요하다, `--no-plan --no-subagents --no-memory --disable-web-search`, `--max-turns 1`,
/// `--no-alt-screen`·`--no-auto-update`(스크립트용). 출처: docs.x.ai/build/cli/headless-scripting, docs.x.ai/build/cli/reference (2026-10).
/// 확인 못 한 것: `--output-format json`의 필드 이름, 도구·MCP 전체를 끄는 플래그(`--tools`에 빈 목록의 의미가 문서에 없어 쓰지 않음), 세션을 남기지 않는 플래그(세션은 ~/.grok/sessions에 쌓일 수 있음).
pub(crate) const GROK_ARGS: &[&str] = &[
    "--output-format", "json", "--no-alt-screen", "--no-auto-update", "--no-plan", "--no-subagents", "--no-memory", "--disable-web-search", "--max-turns", "1",
];

/// 인자로 줄 수 있는 프롬프트 상한(바이트). 단일 인자 한도(Linux 128KB)·Windows 명령줄(32KB)보다 낮게 둔다.
#[cfg(windows)]
const GROK_MAX_PROMPT: usize = 28_000;
#[cfg(not(windows))]
const GROK_MAX_PROMPT: usize = 100_000;

/// (인자, stdin으로 줄 프롬프트). stdin으로 못 주는 CLI는 None.
pub(crate) fn invocation(p: Provider, prompt: String, opts: &Opts) -> Result<(Vec<String>, Option<String>)> {
    let strs = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<String>>();
    let model = |a: &mut Vec<String>| {
        if let Some(m) = &opts.model {
            a.extend(["-m".into(), m.clone()]);
        }
    };
    Ok(match p {
        Provider::Openai => {
            let mut a = strs(CODEX_ARGS);
            model(&mut a);
            if let Some(e) = opts.effort {
                a.extend(["-c".into(), format!("model_reasoning_effort=\"{}\"", e.as_str())]);
            }
            a.push("-".into());
            (a, Some(prompt))
        }
        Provider::Google => {
            let mut a = strs(GEMINI_ARGS);
            model(&mut a);
            (a, Some(prompt))
        }
        Provider::Xai => {
            if prompt.len() > GROK_MAX_PROMPT {
                return Err(Error::TooLarge { size: prompt.len(), limit: GROK_MAX_PROMPT });
            }
            let mut a = strs(GROK_ARGS);
            model(&mut a);
            a.extend(["-p".into(), prompt]);
            (a, None)
        }
        Provider::Anthropic => unreachable!("Claude는 cli::anthropic_args"),
    })
}

/// 공급자별 CLI 출력 → 스키마를 만족하는 JSON
pub(crate) fn parse(p: Provider, stdout: &[u8], stderr: &str, ok: bool, task: Task) -> Result<(Value, Meta)> {
    let out = String::from_utf8_lossy(stdout);
    let tail = |s: &str| s.trim().lines().last().unwrap_or("").to_string();
    let fail = |msg: String| {
        let msg = if msg.trim().is_empty() { tail(stderr) } else { msg.trim().to_string() };
        if msg.is_empty() { crate::cli::cli_unknown(p) } else { Error::Cli(p, msg) }
    };
    let no_json = || Error::BadResponse(gc_i18n::coded!("ai.noJson", "no JSON found in the response"));
    let (text, meta) = match p {
        Provider::Openai => codex_text(&out).map_err(|e| if ok && e.is_empty() { no_json() } else { fail(e) })?,
        Provider::Google => gemini_text(&out).map_err(|e| fail(e.unwrap_or_default()))?,
        _ => grok_text(&out).map_err(|e| fail(e))?,
    };
    if !ok {
        return Err(fail(String::new()));
    }
    // Grok은 필드 이름을 확인하지 못해 후보 텍스트마다 시도한다
    for t in text {
        if let Some(j) = extract_json(&t) {
            if task.check(&j).is_ok() {
                return Ok((j, meta));
            }
        }
    }
    Err(Error::BadResponse(gc_i18n::coded!("ai.noSchemaJson", "no JSON matching the schema in the response")))
}

type Parsed = (Vec<String>, Meta);

/// Codex `--json` JSONL: `item.completed`의 `agent_message.text`(마지막 것), `turn.completed.usage`, 실패는 `turn.failed.error.message`·`error.message`.
/// 성공 종료면 중간의 `error`(재연결 알림 등)는 무시한다.
fn codex_text(out: &str) -> std::result::Result<Parsed, String> {
    let (mut text, mut err, mut meta) = (None, String::new(), Meta::default());
    for ev in out.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
        match ev["type"].as_str() {
            Some("item.completed") if ev["item"]["type"] == "agent_message" => text = ev["item"]["text"].as_str().map(String::from),
            Some("turn.completed") => {
                let u = &ev["usage"];
                (meta.input_tokens, meta.output_tokens) = (u["input_tokens"].as_u64(), u["output_tokens"].as_u64());
            }
            Some("turn.failed") => err = ev["error"]["message"].as_str().unwrap_or_default().into(),
            Some("error") if err.is_empty() => err = ev["message"].as_str().unwrap_or_default().into(),
            _ => {}
        }
    }
    text.map(|t| (vec![t], meta)).ok_or(err)
}

/// Gemini `--output-format json`: `{response, stats{models{<이름>{tokens{prompt,candidates}}}}, error{message}}`.
/// `stats`의 필드 이름은 문서에 자세히 없어 `prompt`/`input`·`candidates`/`output` 이름을 모두 읽는다(없으면 None).
fn gemini_text(out: &str) -> std::result::Result<Parsed, Option<String>> {
    let v = extract_json(out).ok_or(None)?;
    if !v["error"].is_null() {
        return Err(v["error"]["message"].as_str().map(String::from).or_else(|| v["error"].as_str().map(String::from)));
    }
    let text = v["response"].as_str().ok_or(None)?.to_string();
    let models = v["stats"]["models"].as_object();
    let top = models.and_then(|m| m.iter().max_by_key(|(_, x)| x["tokens"]["candidates"].as_u64().unwrap_or(0)));
    let t = |k: &[&str]| top.and_then(|(_, x)| k.iter().find_map(|k| x["tokens"][*k].as_u64()));
    Ok((vec![text], Meta { model: top.map(|(n, _)| n.clone()).unwrap_or_default(), input_tokens: t(&["prompt", "input"]), output_tokens: t(&["candidates", "output"]), elapsed_ms: 0 }))
}

/// Grok `--output-format json`("one JSON object at the end")의 필드 이름은 문서에 없다. 흔한 이름(`result`·`response`·`text`·`output`·`message`·`content`)의 문자열과
/// 원문 전체를 후보로 돌려주고, 호출 쪽이 스키마에 맞는 첫 후보를 쓴다. `error`가 있으면 실패.
fn grok_text(out: &str) -> std::result::Result<Parsed, String> {
    let mut c = Vec::new();
    if let Some(v) = extract_json(out) {
        if !v["error"].is_null() {
            return Err(v["error"]["message"].as_str().or_else(|| v["error"].as_str()).unwrap_or_default().into());
        }
        c.extend(["result", "response", "text", "output", "message", "content"].iter().filter_map(|k| v[*k].as_str().map(String::from)));
    }
    c.push(out.to_string());
    Ok((c, Meta::default()))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::{run as run_backend, run_meta, Backend, Part};
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    /// 공급자 CLI 이름의 가짜 스크립트. 버전 명령에는 응답하고, 받은 인자(줄마다 하나)·stdin을 같은 폴더에 남긴다.
    fn fake(dir: &Path, p: Provider, body: &str) -> PathBuf {
        let f = dir.join(p.program());
        let script = format!("#!/bin/sh\nD=\"$(dirname \"$0\")\"\ncase \"$1\" in --version|version) echo '1.2.3'; exit 0;; esac\nprintf '%s\\n' \"$@\" > \"$D/args\"\ncat > \"$D/stdin\" < /dev/stdin\n{body}\n");
        std::fs::write(&f, script).unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
        f
    }
    fn backend(p: Provider, f: &Path) -> Backend {
        Backend::Cli { provider: p, program: f.to_string_lossy().into(), path: None }
    }
    fn part(t: &str) -> Vec<Part> {
        vec![Part { label: "staged diff".into(), text: t.into() }]
    }
    fn cat(s: &str) -> String {
        format!("cat <<'EOF'\n{s}\nEOF")
    }

    #[tokio::test]
    async fn codex_reads_jsonl_with_safe_args_and_stdin() {
        let d = tempfile::tempdir().unwrap();
        let events = [
            json!({"type":"thread.started","thread_id":"t"}),
            json!({"type":"error","message":"Reconnecting... 1/5"}),
            json!({"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"생각"}}),
            json!({"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":format!("```json\n{}\n```", json!({"subject":"fix: 수정","body":"본문"}))}}),
            json!({"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":5}}),
        ]
        .map(|e| e.to_string())
        .join("\n");
        let f = fake(d.path(), Provider::Openai, &cat(&events));
        let opts = Opts { model: Some("gpt-x".into()), effort: Some(crate::Effort::Low) };
        let (v, m) = run_meta(&backend(Provider::Openai, &f), Task::Commit, &part("+added line"), &opts).await.unwrap();
        assert_eq!(v["subject"], "fix: 수정");
        assert_eq!((m.input_tokens, m.output_tokens), (Some(10), Some(5)));
        let args = std::fs::read_to_string(d.path().join("args")).unwrap();
        let got: Vec<&str> = args.lines().collect();
        assert_eq!(&got[..CODEX_ARGS.len()], CODEX_ARGS);
        assert_eq!(&got[CODEX_ARGS.len()..], ["-m", "gpt-x", "-c", "model_reasoning_effort=\"low\"", "-"]);
        assert!(!args.contains("danger") && !args.contains("added line"));
        let stdin = std::fs::read_to_string(d.path().join("stdin")).unwrap();
        assert!(stdin.contains("### staged diff\n+added line") && stdin.contains("\"subject\""), "{stdin}");
    }

    #[tokio::test]
    async fn codex_failures_use_event_messages() {
        let d = tempfile::tempdir().unwrap();
        let ev = json!({"type":"turn.failed","error":{"message":"Not logged in"}});
        let f = fake(d.path(), Provider::Openai, &format!("{}\nexit 1", cat(&ev.to_string())));
        let e = run_backend(&backend(Provider::Openai, &f), Task::Commit, &part("d")).await.unwrap_err();
        assert!(matches!(&e, Error::Cli(Provider::Openai, m) if m == "Not logged in") && e.to_string().contains("Codex CLI"), "{e}");
        let f = fake(d.path(), Provider::Openai, "echo 'boom' >&2\nexit 2");
        assert!(matches!(run_backend(&backend(Provider::Openai, &f), Task::Commit, &part("d")).await, Err(Error::Cli(_, m)) if m == "boom"));
        // 성공 종료인데 답이 없으면 응답 오류
        let f = fake(d.path(), Provider::Openai, &cat(r#"{"type":"turn.completed","usage":{}}"#));
        assert!(matches!(run_backend(&backend(Provider::Openai, &f), Task::Commit, &part("d")).await, Err(Error::BadResponse(_))));
    }

    #[tokio::test]
    async fn gemini_reads_json_envelope_with_safe_args() {
        let d = tempfile::tempdir().unwrap();
        let out = json!({"response": format!("앞말 {} 뒷말", json!({"subject":"s","body":"b"})), "stats":{"models":{"gemini-a":{"tokens":{"prompt":7,"candidates":2}},"gemini-b":{"tokens":{"prompt":1,"candidates":1}}}}});
        let f = fake(d.path(), Provider::Google, &cat(&out.to_string()));
        let (v, m) = run_meta(&backend(Provider::Google, &f), Task::Commit, &part("d"), &Opts { model: Some("gemini-x".into()), effort: None }).await.unwrap();
        assert_eq!(v["body"], "b");
        assert_eq!((m.model.as_str(), m.input_tokens, m.output_tokens), ("gemini-a", Some(7), Some(2)));
        let args = std::fs::read_to_string(d.path().join("args")).unwrap();
        let got: Vec<&str> = args.lines().collect();
        assert_eq!(&got[..GEMINI_ARGS.len()], GEMINI_ARGS);
        assert_eq!(&got[GEMINI_ARGS.len()..], ["-m", "gemini-x"]);
        assert!(!got.contains(&"yolo") && !got.contains(&"--yolo") && !got.contains(&"-y"));
        let stdin = std::fs::read_to_string(d.path().join("stdin")).unwrap();
        assert!(stdin.contains("### staged diff\nd"), "{stdin}");
        let err = json!({"error":{"type":"AuthError","message":"Please sign in","code":41}});
        let f = fake(d.path(), Provider::Google, &format!("{}\nexit 1", cat(&err.to_string())));
        let e = run_backend(&backend(Provider::Google, &f), Task::Commit, &part("d")).await.unwrap_err();
        assert!(matches!(&e, Error::Cli(Provider::Google, m) if m == "Please sign in"), "{e}");
    }

    #[tokio::test]
    async fn grok_passes_prompt_as_argument_and_reads_known_field_names() {
        let d = tempfile::tempdir().unwrap();
        let f = fake(d.path(), Provider::Xai, &cat(&json!({"result": json!({"subject":"s","body":"b"}).to_string(), "sessionId":"x"}).to_string()));
        let v = run_backend(&backend(Provider::Xai, &f), Task::Commit, &part("+added line")).await.unwrap();
        assert_eq!(v["subject"], "s");
        let args = std::fs::read_to_string(d.path().join("args")).unwrap();
        assert!(args.starts_with(&GROK_ARGS.join("\n")) && args.contains("\n-p\n") && args.contains("+added line"), "{args}");
        assert!(!args.contains("always-approve") && !args.contains("yolo"));
        // 필드 이름을 몰라도 본문 전체가 스키마에 맞는 JSON이면 읽는다
        let f = fake(d.path(), Provider::Xai, &cat(r#"{"subject":"s2","body":"b2"}"#));
        assert_eq!(run_backend(&backend(Provider::Xai, &f), Task::Commit, &part("d")).await.unwrap()["subject"], "s2");
        let f = fake(d.path(), Provider::Xai, &cat(r#"{"error":{"message":"not logged in"}}"#));
        assert!(matches!(run_backend(&backend(Provider::Xai, &f), Task::Commit, &part("d")).await, Err(Error::Cli(Provider::Xai, m)) if m == "not logged in"));
        let f = fake(d.path(), Provider::Xai, &cat(r#"{"result":"JSON 아님"}"#));
        assert!(matches!(run_backend(&backend(Provider::Xai, &f), Task::Commit, &part("d")).await, Err(Error::BadResponse(_))));
        // 인자로 줄 수 없는 크기
        let big = "x".repeat(GROK_MAX_PROMPT + 1);
        assert!(matches!(run_backend(&backend(Provider::Xai, &f), Task::Commit, &part(&big)).await, Err(Error::TooLarge { .. })));
    }

    #[tokio::test]
    async fn detect_uses_each_providers_version_command() {
        let d = tempfile::tempdir().unwrap();
        let path = format!("{}:/usr/bin:/bin", d.path().display());
        for p in [Provider::Openai, Provider::Google, Provider::Xai] {
            fake(d.path(), p, "exit 0");
            assert_eq!(crate::cli::detect(p, Some(&path)).await.as_deref(), Some("1.2.3"), "{p:?}");
        }
        assert!(crate::cli::detect(Provider::Google, Some("/nonexistent")).await.is_none());
    }

    /// 설치된 실제 CLI의 `--help`에 안전 인자가 모두 있는지 (없으면 skip). 프롬프트는 보내지 않는다.
    fn assert_flags_in_help(program: &str, help_args: &[&str], args: &[&str]) {
        let Ok(out) = std::process::Command::new(program).args(help_args).output() else {
            eprintln!("{program} 미설치: skip");
            return;
        };
        let help = String::from_utf8_lossy(&out.stdout);
        for a in args.iter().filter(|a| a.starts_with("--") && a.len() > 2) {
            assert!(help.contains(a), "{program} --help에 {a}가 없습니다 (CLI 버전이 바뀌었는지 확인)");
        }
    }

    #[test]
    fn safe_args_exist_in_real_cli_help() {
        assert_flags_in_help("codex", &["exec", "--help"], CODEX_ARGS);
        assert_flags_in_help("gemini", &["--help"], GEMINI_ARGS);
        assert_flags_in_help("grok", &["--help"], GROK_ARGS);
        // `--disable`에 준 기능 이름이 실제 `codex features list`에 있는지
        if let Ok(out) = std::process::Command::new("codex").args(["features", "list"]).output() {
            let list = String::from_utf8_lossy(&out.stdout);
            let names: Vec<&str> = list.lines().filter_map(|l| l.split_whitespace().next()).collect();
            for w in CODEX_ARGS.windows(2).filter(|w| w[0] == "--disable") {
                assert!(names.contains(&w[1]), "codex features에 {}가 없습니다", w[1]);
            }
        }
    }

    #[test]
    fn schemas_fit_strict_structured_output_rules() {
        // OpenAI strict·Gemini responseJsonSchema·xAI가 모두 받는 부분집합: 모든 객체 additionalProperties:false·required 전체, 지원 안 하는 키워드 없음
        fn walk(v: &Value) {
            match v {
                Value::Object(o) => {
                    for k in o.keys() {
                        assert!(!["format", "pattern", "minimum", "maximum", "minLength", "maxLength", "oneOf", "allOf", "$ref", "default"].contains(&k.as_str()), "{k}");
                    }
                    if v["type"] == "object" {
                        assert_eq!(v["additionalProperties"], false);
                        assert_eq!(v["properties"].as_object().unwrap().len(), v["required"].as_array().unwrap().len());
                    }
                    o.values().for_each(walk);
                }
                Value::Array(a) => a.iter().for_each(walk),
                _ => {}
            }
        }
        for t in [Task::Commit, Task::Review, Task::Conflict, Task::Pr, Task::Guide, Task::PrReview] {
            walk(&t.schema());
            assert_eq!(t.schema()["type"], "object", "최상위는 객체여야 한다(OpenAI strict)");
        }
    }
}
