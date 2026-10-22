//! 설치된 CLI에 위임(방식 A). 인증(OAuth 로그인)은 CLI가 처리하므로 앱은 비밀을 다루지 않는다.
//! Claude Code: `claude -p --output-format json`에 프롬프트를 stdin으로 주고 응답 JSON의 `result` 텍스트를 읽는다.
//! 나머지 공급자(Codex·Gemini·Grok)의 인자·응답 해석은 `cli_other`, 실행·감지·타임아웃은 여기서 공통으로 한다.
use crate::{Error, Meta, Opts, Provider, Result, Task};
use serde_json::Value;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// 헤드리스 실행 인자. 도구를 모두 끄고(`--tools ""`), 사용자 MCP 서버(`--strict-mcp-config` + 빈 `--mcp-config`)·
/// 슬래시 명령/스킬·사용자·프로젝트 설정(훅 포함, 임시 폴더라 project·local은 비어 있다 — `--setting-sources local`)을 막고,
/// 권한 요청이 와도 승인하지 않으며(`--permission-mode dontAsk`) 세션을 남기지 않는다.
/// `--bare`는 쓰지 않는다(OAuth·키체인 로그인을 읽지 않아 로그인한 CLI가 인증에 실패한다). 관리자(managed) 설정은 CLI가 계속 적용한다.
/// 설정에 로그인 정보(env·apiKeyHelper)를 둔 사용자는 이 때문에 인증에 실패할 수 있다 — 그땐 방식을 API 키로 바꾼다.
pub(crate) const SAFE_ARGS: [&str; 14] = [
    "-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--mcp-config", r#"{"mcpServers":{}}"#, "--setting-sources", "local",
    "--disable-slash-commands", "--permission-mode", "dontAsk", "--no-session-persistence",
];

/// CLI는 응답이 길 수 있어 넉넉히 (사용자는 시트를 닫아 취소할 수 있다)
const TIMEOUT: Duration = Duration::from_secs(300);

/// 호출마다 새 빈 임시 폴더에서 실행한다(저장소의 CLAUDE.md·설정은 물론 공유 temp의 다른 파일도 읽지 못하게).
/// 돌려준 `TempDir`은 프로세스가 끝날 때까지 들고 있어야 하고, drop되면 폴더가 지워진다.
fn command(program: &str, path: Option<&str>) -> std::io::Result<(Command, tempfile::TempDir)> {
    let cwd = tempfile::tempdir()?;
    let mut c = Command::new(program);
    c.current_dir(cwd.path()).kill_on_drop(true).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(p) = path {
        c.env("PATH", p);
    }
    #[cfg(windows)]
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    Ok((c, cwd))
}

/// 공급자 CLI의 버전 명령(`--version`, Grok은 `version`)이 성공하면 버전 문자열. 못 찾거나 실패하면 None.
/// 실행은 됐는데 시간 안에 안 끝나면(설치 직후 첫 실행 등) 있는 것으로 본다 — "설치 안 됨"으로 굳히지 않는다.
pub async fn detect(provider: Provider, path: Option<&str>) -> Option<String> {
    detect_program(provider.program(), provider, path, Duration::from_secs(15)).await
}

/// 버전을 못 읽었지만 실행 파일은 있음
pub const VERSION_UNKNOWN: &str = "?";

async fn detect_program(program: &str, provider: Provider, path: Option<&str>, limit: Duration) -> Option<String> {
    let (mut c, _cwd) = command(program, path).ok()?;
    c.args(provider.version_args()).stdin(Stdio::null());
    let out = match tokio::time::timeout(limit, c.output()).await {
        Err(_) => return Some(VERSION_UNKNOWN.into()),
        Ok(r) => r.ok()?,
    };
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !v.is_empty()).then_some(v)
}

pub(crate) async fn run(provider: Provider, program: &str, path: Option<&str>, task: Task, input: &str, opts: &Opts) -> Result<(Value, Meta)> {
    let prompt = format!(
        "{}\n\nOutput only one JSON object that satisfies the JSON schema below. No code blocks, explanations or surrounding text.\nSchema: {}\n\n{input}",
        task.system_for(input),
        task.schema()
    );
    // 프롬프트를 stdin으로 줄 수 있으면 Some. 못 주는 CLI(Grok)는 인자에 들어 있다.
    let (args, stdin_prompt) = match provider {
        Provider::Anthropic => (anthropic_args(opts), Some(prompt)),
        p => crate::cli_other::invocation(p, prompt, opts)?,
    };
    let (mut c, _cwd) = command(program, path).map_err(|e| Error::Cli(provider, e.to_string()))?;
    c.args(args);
    let mut child = c.spawn().map_err(|e| Error::Coded(gc_i18n::coded!("ai.cliSpawn", "failed to run {program}: {error}", program = provider.program(), error = e)))?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    // 입력이 커도 출력 읽기와 동시에 진행되도록 별도 태스크로 쓴다. 쓰기가 끝나면 닫아 EOF를 준다.
    let writer = tokio::spawn(async move {
        if let Some(p) = stdin_prompt {
            let _ = stdin.write_all(p.as_bytes()).await;
        }
    });
    let out = tokio::time::timeout(TIMEOUT, child.wait_with_output()).await;
    writer.abort();
    let out = out.map_err(|_| Error::Timeout)?.map_err(|e| Error::Cli(provider, e.to_string()))?;
    let (stderr, ok) = (String::from_utf8_lossy(&out.stderr), out.status.success());
    match provider {
        Provider::Anthropic => parse_output(&out.stdout, &stderr, ok, task),
        p => crate::cli_other::parse(p, &out.stdout, &stderr, ok, task),
    }
}

fn anthropic_args(opts: &Opts) -> Vec<String> {
    let mut a: Vec<String> = SAFE_ARGS.iter().map(|s| s.to_string()).collect();
    if let Some(m) = &opts.model {
        a.extend(["--model".into(), m.clone()]);
    }
    if let Some(e) = opts.effort {
        a.extend(["--effort".into(), e.as_str().into()]);
    }
    a
}

/// CLI가 사유 없이 실패했을 때: 로그인 상태 확인 안내
pub(crate) fn cli_unknown(p: Provider) -> Error {
    Error::Coded(gc_i18n::coded!("ai.cliUnknown", "{cli} error: unknown error (check your login: run `{login}` in a terminal)", cli = p.cli_name(), login = p.login_cmd()))
}

/// CLI JSON 출력(`result` 필드) → 스키마를 만족하는 JSON
pub(crate) fn parse_output(stdout: &[u8], stderr: &str, ok: bool, task: Task) -> Result<(Value, Meta)> {
    let tail = |s: &str| s.trim().lines().last().unwrap_or("").to_string();
    let Ok(v) = serde_json::from_slice::<Value>(stdout) else {
        return Err(if ok { Error::Coded(gc_i18n::coded!("ai.cliNotJson", "{cli} error: output is not JSON", cli = Provider::Anthropic.cli_name())) } else { Error::Cli(Provider::Anthropic, tail(stderr)) });
    };
    let text = v["result"].as_str().unwrap_or_default();
    if v["is_error"] == true || !ok {
        let msg = if text.is_empty() { tail(stderr) } else { text.trim().to_string() };
        return Err(if msg.is_empty() { cli_unknown(Provider::Anthropic) } else { Error::Cli(Provider::Anthropic, msg) });
    }
    let j = extract_json(text).ok_or_else(|| Error::BadResponse(gc_i18n::coded!("ai.noJson", "no JSON found in the response")))?;
    task.check(&j)?;
    Ok((j, meta_of(&v)))
}

/// CLI 결과 JSON의 `usage`(입력은 캐시 읽기·쓰기 포함 합계)와 `modelUsage`(실제 쓴 모델, 여럿이면 출력이 가장 많은 쪽)
fn meta_of(v: &Value) -> Meta {
    let u = &v["usage"];
    let n = |k: &str| u[k].as_u64();
    let input = n("input_tokens").map(|i| i + n("cache_creation_input_tokens").unwrap_or(0) + n("cache_read_input_tokens").unwrap_or(0));
    let model = v["modelUsage"].as_object().and_then(|m| m.iter().max_by_key(|(_, x)| x["outputTokens"].as_u64().unwrap_or(0)).map(|(k, _)| k.clone())).unwrap_or_default();
    Meta { model, input_tokens: input, output_tokens: n("output_tokens"), elapsed_ms: 0 }
}

/// 코드 펜스·앞뒤 설명이 붙어도 첫 `{`부터 마지막 `}`까지를 JSON으로 읽는다
pub(crate) fn extract_json(text: &str) -> Option<Value> {
    let t = text.trim();
    serde_json::from_str(t).ok().or_else(|| {
        let (a, b) = (t.find('{')?, t.rfind('}')?);
        serde_json::from_str(t.get(a..=b)?).ok()
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::{run as run_backend, run_meta, Backend, Part};
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    /// `claude` 이름의 가짜 스크립트. 받은 인자·stdin을 같은 폴더에 남긴다.
    fn fake(dir: &Path, body: &str) -> PathBuf {
        let p = dir.join("claude");
        let script = format!("#!/bin/sh\nD=\"$(dirname \"$0\")\"\nif [ \"$1\" = \"--version\" ]; then echo '2.1.0 (Claude Code)'; exit 0; fi\nprintf '%s\\n' \"$@\" > \"$D/args\"\ncat > \"$D/stdin\"\n{body}\n");
        std::fs::write(&p, script).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }
    fn reply(result: &str) -> String {
        format!("cat <<'EOF'\n{}\nEOF", json!({"type":"result","subtype":"success","is_error":false,"result":result}))
    }
    fn backend(p: &Path) -> Backend {
        Backend::Cli { provider: Provider::Anthropic, program: p.to_string_lossy().into(), path: None }
    }
    fn part(t: &str) -> Vec<Part> {
        vec![Part { label: "staged diff".into(), text: t.into() }]
    }

    #[tokio::test]
    async fn runs_print_json_with_stdin_prompt_and_parses_result() {
        let d = tempfile::tempdir().unwrap();
        // 모델이 코드 펜스를 붙여도 읽는다
        let p = fake(d.path(), &reply("```json\n{\"subject\":\"fix: 수정\",\"body\":\"본문\"}\n```"));
        let v = run_backend(&backend(&p), Task::Commit, &part("+added line")).await.unwrap();
        assert_eq!((v["subject"].as_str(), v["body"].as_str()), (Some("fix: 수정"), Some("본문")));
        let args = std::fs::read_to_string(d.path().join("args")).unwrap();
        assert_eq!(args.lines().collect::<Vec<_>>(), SAFE_ARGS, "인자 순서·값(빈 문자열 포함)이 그대로");
        assert!(!args.contains("added line"), "diff는 인자가 아니라 stdin으로");
        let stdin = std::fs::read_to_string(d.path().join("stdin")).unwrap();
        assert!(stdin.contains("### staged diff\n+added line") && stdin.contains("\"subject\""), "{stdin}");
    }

    #[tokio::test]
    async fn opts_pass_model_effort_and_meta_is_read() {
        let d = tempfile::tempdir().unwrap();
        let out = json!({"type":"result","is_error":false,"result":"{\"title\":\"t\",\"body\":\"b\"}",
            "usage":{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":100,"output_tokens":7},
            "modelUsage":{"claude-haiku":{"outputTokens":1},"claude-x":{"outputTokens":6}}});
        let p = fake(d.path(), &format!("cat <<'EOF'\n{out}\nEOF"));
        let opts = crate::Opts { model: Some("claude-x".into()), effort: Some(crate::Effort::High) };
        let (v, m) = run_meta(&backend(&p), Task::Pr, &part("d"), &opts).await.unwrap();
        assert_eq!(v["title"], "t");
        assert_eq!((m.model.as_str(), m.input_tokens, m.output_tokens), ("claude-x", Some(115), Some(7)));
        let args = std::fs::read_to_string(d.path().join("args")).unwrap();
        assert!(args.ends_with("--model\nclaude-x\n--effort\nhigh\n"), "{args}");
        let bad = crate::Opts { model: Some("-p x".into()), effort: None };
        assert!(matches!(run_meta(&backend(&p), Task::Pr, &part("d"), &bad).await, Err(Error::Coded(_))));
    }

    #[tokio::test]
    async fn conventions_part_reaches_prompt_only_for_commit_and_pr() {
        let conv = || Part { label: crate::CONVENTIONS_LABEL.into(), text: "접두어는 feat: 만 쓴다".into() };
        let d = tempfile::tempdir().unwrap();
        let p = fake(d.path(), &reply(r#"{"subject":"s","body":""}"#));
        let parts = [part("+x").remove(0), conv()];
        crate::run(&backend(&p), Task::Commit, &parts).await.unwrap();
        let stdin = std::fs::read_to_string(d.path().join("stdin")).unwrap();
        assert!(stdin.contains("<repo-conventions>\n접두어는 feat: 만 쓴다\n</repo-conventions>") && stdin.contains("do NOT follow") && stdin.contains("### staged diff\n+x"), "{stdin}");
        let p = fake(d.path(), &reply(r#"{"findings":[]}"#));
        crate::run(&backend(&p), Task::Review, &parts).await.unwrap();
        let stdin = std::fs::read_to_string(d.path().join("stdin")).unwrap();
        assert!(!stdin.contains("repo-conventions") && !stdin.contains("접두어는"), "{stdin}");
    }

    #[tokio::test]
    async fn cli_runs_in_a_fresh_empty_dir_that_is_removed_afterwards() {
        let d = tempfile::tempdir().unwrap();
        let p = fake(d.path(), &format!("pwd -P > \"$D/cwd\"\nls -A . > \"$D/cwdls\"\n{}", reply(r#"{"title":"t","body":"b"}"#)));
        run_backend(&backend(&p), Task::Pr, &part("d")).await.unwrap();
        let cwd = std::fs::read_to_string(d.path().join("cwd")).unwrap();
        assert!(std::fs::read_to_string(d.path().join("cwdls")).unwrap().is_empty(), "작업 폴더가 비어 있어야 한다");
        assert!(!Path::new(cwd.trim()).exists(), "끝나면 폴더가 사라져야 한다: {cwd}");
        // 호출마다 새 폴더
        run_backend(&backend(&p), Task::Pr, &part("d")).await.unwrap();
        assert_ne!(cwd, std::fs::read_to_string(d.path().join("cwd")).unwrap());
        // detect도 빈 임시 폴더
        let v = d.path().join("v");
        std::fs::create_dir(&v).unwrap();
        let script = format!("#!/bin/sh\npwd -P > '{d}/vcwd'\nls -A . > '{d}/vls'\necho 1.0\n", d = d.path().display());
        std::fs::write(v.join("claude"), script).unwrap();
        std::fs::set_permissions(v.join("claude"), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(detect_program(&v.join("claude").to_string_lossy(), Provider::Anthropic, None, Duration::from_secs(5)).await.as_deref(), Some("1.0"));
        assert!(std::fs::read_to_string(d.path().join("vls")).unwrap().is_empty());
        assert!(!Path::new(std::fs::read_to_string(d.path().join("vcwd")).unwrap().trim()).exists());
    }

    #[tokio::test]
    async fn large_stdin_does_not_deadlock() {
        let d = tempfile::tempdir().unwrap();
        let p = fake(d.path(), &reply(r#"{"title":"t","body":"b"}"#));
        let big = "x".repeat(190_000);
        let v = run_backend(&backend(&p), Task::Pr, &part(&big)).await.unwrap();
        assert_eq!(v["title"], "t");
        assert!(std::fs::metadata(d.path().join("stdin")).unwrap().len() > 190_000);
    }

    #[tokio::test]
    async fn cli_errors_are_reported() {
        let d = tempfile::tempdir().unwrap();
        // is_error: true (예: 로그인 안 됨)
        let p = fake(d.path(), "cat <<'EOF'\n{\"type\":\"result\",\"is_error\":true,\"result\":\"Not logged in · Please run /login\"}\nEOF\nexit 1");
        let e = run_backend(&backend(&p), Task::Commit, &part("d")).await.unwrap_err();
        assert!(matches!(&e, Error::Cli(_, m) if m.contains("Not logged in")), "{e}");
        // JSON 없이 실패
        let p = fake(d.path(), "echo 'boom: something' >&2\nexit 2");
        let e = run_backend(&backend(&p), Task::Commit, &part("d")).await.unwrap_err();
        assert!(matches!(&e, Error::Cli(_, m) if m == "boom: something"), "{e}");
        // 스키마에 안 맞는 결과
        let p = fake(d.path(), &reply(r#"{"subject":"only"}"#));
        assert!(matches!(run_backend(&backend(&p), Task::Commit, &part("d")).await, Err(Error::BadResponse(_))));
        // 실행 파일 없음
        let missing = Backend::Cli { provider: Provider::Anthropic, program: "/nonexistent/claude".into(), path: None };
        assert!(matches!(run_backend(&missing, Task::Commit, &part("d")).await, Err(Error::Coded(_))));
    }

    /// 설치된 실제 `claude --help`에 안전 인자가 모두 있는지 (없으면 skip). 프롬프트는 보내지 않는다.
    #[test]
    fn safe_args_exist_in_real_claude_help() {
        let Ok(out) = std::process::Command::new("claude").arg("--help").output() else {
            eprintln!("claude 미설치: skip");
            return;
        };
        let help = String::from_utf8_lossy(&out.stdout);
        for a in SAFE_ARGS.iter().filter(|a| a.starts_with('-') && a.len() > 2) {
            assert!(help.contains(a), "claude --help에 {a}가 없습니다 (CLI 버전이 바뀌었는지 확인)");
        }
        assert!(help.contains("-p, --print") || help.contains("--print"));
        assert!(help.contains("dontAsk"), "permission-mode dontAsk");
        assert!(help.contains("user, project, local"), "setting-sources 값");
    }

    #[test]
    fn extract_json_handles_noise() {
        assert_eq!(extract_json("앞 말 {\"a\":1} 뒷 말").unwrap()["a"], 1);
        assert_eq!(extract_json("  {\"a\":{\"b\":2}} ").unwrap()["a"]["b"], 2);
        assert!(extract_json("JSON 없음").is_none());
    }

    #[tokio::test]
    async fn detect_uses_version_and_overridden_path() {
        let d = tempfile::tempdir().unwrap();
        fake(d.path(), "exit 0");
        // 이름만 주고 PATH를 보정해 찾는다 (GUI 앱은 로그인 셸 PATH가 없다)
        let found = detect(Provider::Anthropic, Some(&format!("{}:/usr/bin:/bin", d.path().display()))).await;
        assert_eq!(found.as_deref(), Some("2.1.0 (Claude Code)"));
        assert!(detect(Provider::Anthropic, Some("/nonexistent")).await.is_none());
        // 종료 코드가 실패면 없는 것으로 본다
        let bad = d.path().join("bad");
        std::fs::create_dir(&bad).unwrap();
        std::fs::write(bad.join("claude"), "#!/bin/sh\nexit 3\n").unwrap();
        std::fs::set_permissions(bad.join("claude"), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(detect_program(&bad.join("claude").to_string_lossy(), Provider::Anthropic, None, Duration::from_secs(5)).await.is_none());
        // 느린 첫 실행: 시간 초과여도 실행 파일이 있으면 "있음"
        std::fs::write(bad.join("claude"), "#!/bin/sh\nsleep 5\n").unwrap();
        let slow = detect_program(&bad.join("claude").to_string_lossy(), Provider::Anthropic, None, Duration::from_millis(300)).await;
        assert_eq!(slow.as_deref(), Some(VERSION_UNKNOWN));
    }

    #[tokio::test]
    async fn aborting_kills_the_cli_process() {
        let d = tempfile::tempdir().unwrap();
        let pidfile = d.path().join("pid");
        let p = fake(d.path(), &format!("echo $$ > '{}'\nexec sleep 30", pidfile.display()));
        let b = backend(&p);
        let t = tokio::spawn(async move { run_backend(&b, Task::Commit, &part("d")).await });
        let pid = loop {
            if let Ok(s) = std::fs::read_to_string(&pidfile) {
                if let Ok(n) = s.trim().parse::<i32>() {
                    break n;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        t.abort();
        let _ = t.await;
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(40)).await;
            // 프로세스가 사라지면 kill(pid, 0)이 실패한다 (좀비는 kill_on_drop이 wait해서 회수)
            if !Path::new(&format!("/proc/{pid}")).exists() && std::process::Command::new("kill").args(["-0", &pid.to_string()]).stderr(Stdio::null()).status().map(|s| !s.success()).unwrap_or(true) {
                return;
            }
        }
        panic!("CLI 프로세스가 남아 있음");
    }
}
