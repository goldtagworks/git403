//! AI 채팅(git 작업 대화): `claude -p … --output-format stream-json`의 인자와 출력 줄 해석. git·프로세스를 모른다 —
//! 실행·취소·저장은 호출 측(`gc-backend`)이 한다. 도구는 `git`(Bash)·Read·Edit만 허용하고 파괴적 git 명령은 금지 목록으로 막는다.
use serde::Serialize;
use serde_json::Value;

/// 허용 도구: git 명령(Bash), 파일 읽기·수정. 그 밖의 도구는 `-p`에서 승인 요청 없이 거부된다.
const ALLOWED: [&str; 3] = ["Bash(git *)", "Read", "Edit"];

/// 막을 파괴적 git 명령(하위 명령, 인자 패턴). 확인창 연동이 없어 금지 목록으로만 막는다(deny가 allow보다 우선).
/// 각 항목은 `git <sub> <pat>`과 전역 옵션이 앞에 붙은 `git * <sub> <pat>`(예: `git -C x push -f`) 두 형태로 펼친다.
const BLOCKED: [(&str, &str); 28] = [
    ("push", "--force*"), ("push", "-f*"), ("push", "* --force*"), ("push", "* -f*"), ("push", "* +*"),
    ("push", "--mirror*"), ("push", "* --mirror*"), ("push", "--delete*"), ("push", "* --delete*"), ("push", "* :*"),
    ("reset", "--hard*"), ("reset", "* --hard*"),
    ("branch", "-D*"), ("branch", "* -D*"), ("branch", "-f*"), ("branch", "--force*"),
    ("clean", "*"),
    ("checkout", "-- *"), ("checkout", "* -- *"), ("checkout", "."), ("checkout", "-f*"), ("checkout", "--force*"),
    ("restore", "*"),
    ("stash", "drop*"), ("stash", "clear*"),
    ("reflog", "expire*"), ("reflog", "delete*"), ("filter-branch", "*"),
];

/// 별칭으로 위 규칙을 우회하지 못하게 별칭 설정과 그 밖의 되돌리기 어려운 명령도 막는다.
const BLOCKED_EXTRA: [&str; 8] = [
    "Bash(git config *alias*)", "Bash(git prune*)", "Bash(git gc *--prune*)", "Bash(git update-ref -d*)",
    "Bash(git update-ref --delete*)", "Bash(git * update-ref -d*)", "Bash(git rm * -f*)", "Bash(git rm -f*)",
];

/// `--disallowedTools`에 줄 규칙 목록
pub fn disallowed() -> Vec<String> {
    let mut v: Vec<String> = BLOCKED.iter().flat_map(|(sub, pat)| [format!("Bash(git {sub} {pat})"), format!("Bash(git * {sub} {pat})")]).collect();
    v.extend(BLOCKED_EXTRA.iter().map(|s| s.to_string()));
    v
}

/// 실행 인자. 입력이 `-`로 시작해도 옵션으로 읽히지 않게 앞에 공백을 둔다. `resume`은 이어 갈 대화의 session_id.
pub fn args(input: &str, resume: Option<&str>) -> Vec<String> {
    let prompt = if input.starts_with('-') { format!(" {input}") } else { input.to_owned() };
    let mut a: Vec<String> = vec!["-p".into(), prompt, "--output-format".into(), "stream-json".into(), "--verbose".into(), "--allowedTools".into()];
    a.extend(ALLOWED.iter().map(|s| s.to_string()));
    a.push("--disallowedTools".into());
    a.extend(disallowed());
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
                // Bash는 명령, 파일 도구는 경로, 그 밖은 입력 JSON 그대로
                let command = ["command", "file_path", "path"].iter().find_map(|k| input[k].as_str().map(str::to_owned)).unwrap_or_else(|| input.to_string());
                Some(ChatEvent::Tool { id: s(&b["id"]), name: s(&b["name"]), command })
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
    fn args_have_stream_json_allowed_and_blocked_tools_and_resume_last() {
        let a = args("상태 보여줘", None);
        assert_eq!(&a[..6], ["-p", "상태 보여줘", "--output-format", "stream-json", "--verbose", "--allowedTools"]);
        assert_eq!(&a[6..9], ["Bash(git *)", "Read", "Edit"]);
        assert_eq!(a[9], "--disallowedTools");
        assert!(a.contains(&"Bash(git push --force*)".to_string()) && a.contains(&"Bash(git * reset --hard*)".to_string()) && a.contains(&"Bash(git clean *)".to_string()));
        assert!(!a.contains(&"--resume".to_string()));
        let r = args("-rf 지워", Some("sid-1"));
        assert_eq!(r[1], " -rf 지워", "옵션으로 읽히지 않게");
        assert_eq!(&r[r.len() - 2..], ["--resume", "sid-1"]);
    }

    #[test]
    fn blocked_rules_cover_destructive_git_forms() {
        let d = disallowed();
        for must in ["Bash(git push -f*)", "Bash(git push * --force*)", "Bash(git reset --hard*)", "Bash(git branch -D*)", "Bash(git clean *)", "Bash(git checkout -- *)", "Bash(git restore *)", "Bash(git * push -f*)", "Bash(git config *alias*)"] {
            assert!(d.iter().any(|x| x == must), "{must}");
        }
        assert!(d.iter().all(|x| x.starts_with("Bash(git ") && x.ends_with(')')));
    }

    #[test]
    fn parses_text_tool_result_and_done_and_ignores_the_rest() {
        let text = r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""},{"type":"text","text":"확인합니다"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"git status"}}]},"parent_tool_use_id":null}"#;
        assert_eq!(parse_line(text), vec![ChatEvent::Text { text: "확인합니다".into() }, ChatEvent::Tool { id: "t1".into(), name: "Bash".into(), command: "git status".into() }]);
        let res = r#"{"type":"user","message":{"content":[{"tool_use_id":"t1","type":"tool_result","content":"clean","is_error":false},{"tool_use_id":"t2","type":"tool_result","content":[{"type":"text","text":"a"},{"type":"text","text":"b"}],"is_error":true}]},"parent_tool_use_id":null}"#;
        assert_eq!(parse_line(res), vec![ChatEvent::ToolResult { id: "t1".into(), output: "clean".into(), is_error: false }, ChatEvent::ToolResult { id: "t2".into(), output: "a\nb".into(), is_error: true }]);
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
