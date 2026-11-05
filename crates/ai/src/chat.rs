//! AI 채팅(git 작업 대화): `claude -p … --output-format stream-json`의 인자와 출력 줄 해석. git·프로세스를 모른다 —
//! 실행·취소·저장은 호출 측(`gc-backend`)이 한다. AI 도구는 앱이 제공하는 MCP 도구(`git`·`read_file`·`edit_file`)뿐이고 검증은 `gc_core::ai_tool`이 한다.
use serde::Serialize;
use serde_json::Value;

/// AI에게 보이는 도구는 앱이 제공하는 MCP 서버(`gc-backend::mcp`, 같은 실행 파일의 `--git403-mcp` 모드)의 세 개뿐이다 —
/// `Bash`·내장 파일 도구는 없다(`--tools ""`). 인자 검증은 `gc_core::ai_tool`이 한다(docs/security.md).
pub const SERVER: &str = "git403";
const ALLOWED: [&str; 3] = ["mcp__git403__git", "mcp__git403__read_file", "mcp__git403__edit_file"];

/// `--mcp-config`에 줄 JSON: 이 실행 파일(`exe`)을 `--git403-mcp <repo>`로 띄운다. `env`는 서버 환경(PATH·git 경로·askpass 등 git 자식 환경)
pub fn mcp_config(exe: &str, repo: &str, env: &serde_json::Map<String, Value>) -> String {
    serde_json::json!({"mcpServers": {SERVER: {"command": exe, "args": ["--git403-mcp", repo], "env": env}}}).to_string()
}

/// 실행 인자. 입력이 `-`로 시작해도 옵션으로 읽히지 않게 앞에 공백을 둔다. `resume`은 이어 갈 대화의 session_id.
/// `--restricted`: 사용자·프로젝트·로컬 설정 파일(저장소의 `.claude/settings*.json`·훅·사용자 전역 허용 규칙)을 읽지 않는다.
/// `--tools ""`: 내장 도구 전부 없음. `--strict-mcp-config`: 위 MCP 서버만. `--disable-slash-commands`: 스킬·명령 없음. 로그인(OAuth)은 유지된다.
/// (`--safe-mode`는 MCP 서버까지 꺼서 쓰지 않는다 — 플러그인 훅은 사용자가 설치한 것이다.)
pub fn args(input: &str, resume: Option<&str>, mcp_config: &str) -> Vec<String> {
    let prompt = if input.starts_with('-') { format!(" {input}") } else { input.to_owned() };
    let mut a: Vec<String> = ["-p", &prompt, "--output-format", "stream-json", "--verbose", "--restricted", "--tools", "", "--strict-mcp-config", "--mcp-config", mcp_config, "--disable-slash-commands", "--allowedTools"].map(String::from).to_vec();
    a.extend(ALLOWED.map(String::from));
    if let Some(s) = resume {
        a.extend(["--resume".into(), s.into()]);
    }
    a
}

/// UI로 가는 채팅 이벤트(Tauri 이벤트 `ai-chat`의 `event`). 도구 실행은 `tool`(명령) → `toolResult`(출력)이 `id`로 이어진다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatEvent {
    Text { text: String },
    Tool { id: String, name: String, command: String },
    #[serde(rename_all = "camelCase")]
    ToolResult { id: String, output: String, is_error: bool },
    #[serde(rename_all = "camelCase")]
    Done { session_id: Option<String>, result: String, is_error: bool },
    Error { code: Option<String>, message: String },
    /// 대화는 계속되지만 알릴 일(이력 저장 실패 등). 마지막 이벤트 전에 나갈 수 있다
    Note { code: String, message: String },
    Cancelled,
}

/// 도구 출력 길이 상한(문자). 넘으면 잘라 `…`을 붙인다.
pub const OUTPUT_LIMIT: usize = 20_000;

fn clip(s: &str) -> String {
    match s.char_indices().nth(OUTPUT_LIMIT) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_owned(),
    }
}

/// stream-json 한 줄 → 이벤트들. 모르는 종류(system·rate_limit·thinking 등)와 JSON이 아닌 줄은 무시한다.
pub fn parse_line(line: &str) -> Vec<ChatEvent> {
    let Ok(v) = serde_json::from_str::<Value>(line) else { return vec![] };
    let s = |x: &Value| x.as_str().unwrap_or_default().to_owned();
    // 하위 에이전트의 메시지는 보이지 않는다(최상위 대화만)
    if !v["parent_tool_use_id"].is_null() {
        return vec![];
    }
    match v["type"].as_str() {
        Some("assistant") => v["message"]["content"].as_array().into_iter().flatten().filter_map(|b| match b["type"].as_str()? {
            "text" => Some(ChatEvent::Text { text: s(&b["text"]) }).filter(|_| !b["text"].as_str().unwrap_or_default().is_empty()),
            "tool_use" => {
                let input = &b["input"];
                // git 도구는 인자 배열을 한 줄로(공백이 든 인자는 따옴표), 파일 도구는 경로, 그 밖은 입력 JSON 그대로.
                // 도구 이름은 `mcp__git403__` 접두사를 뗀다(`git`·`read_file`·`edit_file`)
                let command = match input["args"].as_array() {
                    Some(a) => a.iter().filter_map(Value::as_str).map(|x| if x.is_empty() || x.contains([' ', '\t', '\n', '"', '\'']) { format!("{x:?}") } else { x.to_owned() }).collect::<Vec<_>>().join(" "),
                    None => ["command", "file_path", "path"].iter().find_map(|k| input[k].as_str().map(str::to_owned)).unwrap_or_else(|| input.to_string()),
                };
                let name = s(&b["name"]);
                Some(ChatEvent::Tool { id: s(&b["id"]), name: name.strip_prefix("mcp__git403__").map(str::to_owned).unwrap_or(name), command })
            }
            _ => None,
        }).collect(),
        Some("user") => v["message"]["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "tool_result").map(|b| {
            // content는 문자열이거나 `[{type:text,text}]`
            let output = match &b["content"] {
                Value::String(t) => t.clone(),
                Value::Array(a) => a.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n"),
                _ => String::new(),
            };
            ChatEvent::ToolResult { id: s(&b["tool_use_id"]), output: clip(&output), is_error: b["is_error"] == true }
        }).collect(),
        Some("result") => vec![ChatEvent::Done {
            session_id: v["session_id"].as_str().map(str::to_owned),
            result: s(&v["result"]),
            is_error: v["is_error"] == true || v["subtype"].as_str().is_some_and(|t| t != "success"),
        }],
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_are_restricted_mcp_only_with_stream_json_and_resume_last() {
        let cfg = mcp_config("/app/git403", "/work/repo", &serde_json::Map::new());
        let a = args("상태 보여줘", None, &cfg);
        assert_eq!(&a[..6], ["-p", "상태 보여줘", "--output-format", "stream-json", "--verbose", "--restricted"]);
        let at = |f: &str| a.iter().position(|x| x == f).unwrap();
        assert_eq!(a[at("--tools") + 1], "", "내장 도구(Bash 포함)는 없다");
        assert!(a.contains(&"--strict-mcp-config".to_string()) && a.contains(&"--disable-slash-commands".to_string()));
        assert!(!a.contains(&"--safe-mode".to_string()), "safe-mode는 MCP까지 끈다");
        assert_eq!(a[at("--mcp-config") + 1], cfg);
        let v: Value = serde_json::from_str(&cfg).unwrap();
        assert_eq!((v["mcpServers"]["git403"]["command"].as_str(), v["mcpServers"]["git403"]["args"][0].as_str(), v["mcpServers"]["git403"]["args"][1].as_str()), (Some("/app/git403"), Some("--git403-mcp"), Some("/work/repo")));
        assert_eq!(&a[at("--allowedTools") + 1..at("--allowedTools") + 4], ["mcp__git403__git", "mcp__git403__read_file", "mcp__git403__edit_file"]);
        assert!(a.iter().all(|x| !x.contains("Bash") && x != "Read" && x != "Edit") && !a.contains(&"--disallowedTools".to_string()));
        assert!(!a.contains(&"--resume".to_string()));
        let r = args("-rf 지워", Some("sid-1"), &cfg);
        assert_eq!(r[1], " -rf 지워", "옵션으로 읽히지 않게");
        assert_eq!(&r[r.len() - 2..], ["--resume", "sid-1"]);
    }

    #[test]
    fn parses_text_tool_result_and_done_and_ignores_the_rest() {
        let text = r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""},{"type":"text","text":"확인합니다"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"git status"}}]},"parent_tool_use_id":null}"#;
        assert_eq!(parse_line(text), vec![ChatEvent::Text { text: "확인합니다".into() }, ChatEvent::Tool { id: "t1".into(), name: "Bash".into(), command: "git status".into() }]);
        let res = r#"{"type":"user","message":{"content":[{"tool_use_id":"t1","type":"tool_result","content":"clean","is_error":false},{"tool_use_id":"t2","type":"tool_result","content":[{"type":"text","text":"a"},{"type":"text","text":"b"}],"is_error":true}]},"parent_tool_use_id":null}"#;
        assert_eq!(parse_line(res), vec![ChatEvent::ToolResult { id: "t1".into(), output: "clean".into(), is_error: false }, ChatEvent::ToolResult { id: "t2".into(), output: "a\nb".into(), is_error: true }]);
        let mcp = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t4","name":"mcp__git403__git","input":{"args":["commit","-m","fix: a b"]}},{"type":"tool_use","id":"t5","name":"mcp__git403__read_file","input":{"path":"src/a.rs"}}]},"parent_tool_use_id":null}"#;
        assert_eq!(parse_line(mcp), vec![ChatEvent::Tool { id: "t4".into(), name: "git".into(), command: "commit -m \"fix: a b\"".into() }, ChatEvent::Tool { id: "t5".into(), name: "read_file".into(), command: "src/a.rs".into() }]);
        let edit = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t3","name":"Edit","input":{"file_path":"a.txt","old_string":"x","new_string":"y"}}]},"parent_tool_use_id":null}"#;
        assert_eq!(parse_line(edit), vec![ChatEvent::Tool { id: "t3".into(), name: "Edit".into(), command: "a.txt".into() }]);
        let done = r#"{"type":"result","subtype":"success","is_error":false,"result":"끝","session_id":"s9"}"#;
        assert_eq!(parse_line(done), vec![ChatEvent::Done { session_id: Some("s9".into()), result: "끝".into(), is_error: false }]);
        let fail = r#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":"","session_id":"s9"}"#;
        assert!(matches!(&parse_line(fail)[..], [ChatEvent::Done { is_error: true, .. }]));
        for ignored in [r#"{"type":"system","subtype":"init","session_id":"s"}"#, "not json", "", r#"{"type":"assistant","message":{"content":[{"type":"text","text":"sub"}]},"parent_tool_use_id":"x"}"#] {
            assert!(parse_line(ignored).is_empty(), "{ignored}");
        }
    }

    #[test]
    fn long_output_is_clipped_on_char_boundary() {
        let big = "가".repeat(OUTPUT_LIMIT + 5);
        let line = serde_json::json!({"type":"user","message":{"content":[{"tool_use_id":"t","type":"tool_result","content":big}]},"parent_tool_use_id":null}).to_string();
        let [ChatEvent::ToolResult { output, .. }] = &parse_line(&line)[..] else { panic!() };
        assert_eq!(output.chars().count(), OUTPUT_LIMIT + 1);
        assert!(output.ends_with('…'));
    }
}
