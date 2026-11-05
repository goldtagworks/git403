//! AI 채팅용 MCP stdio 서버 (docs/security.md "AI 채팅"). claude가 이 실행 파일을 `--git403-mcp <저장소>`로 띄우고(askpass helper와 같은 방식),
//! AI에게는 도구 세 개만 보인다: `git`(인자 배열, 셸 없음)·`read_file`·`edit_file`. 저장소는 시작 인자로 고정되고 도구는 경로를 받지 않는다.
//! 모든 호출은 `gc_core::ai_tool` 검증기를 거치고, git 출력은 모델에 넘기기 전에 `settings_io::redact`로 가린다.
//! 프로토콜: 줄 단위 JSON-RPC 2.0 (initialize·ping·tools/list·tools/call). stderr에는 로그만.

use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use gc_core::ai_tool;
use serde_json::{json, Value};

use crate::settings_io::redact;

/// 명령줄 첫 인자
pub const FLAG: &str = "--git403-mcp";
/// git 자식에 줄 환경(askpass 등)을 JSON 객체로 담은 환경 변수. 서버 자신의 환경에는 넣지 않는다(서버가 askpass로 오인되지 않게)
pub const GIT_ENV: &str = "GIT403_GIT_ENV";
/// 쓸 git 실행 파일(없으면 `git`)
pub const GIT_BIN: &str = "GIT403_GIT";
/// 차례 시작 때 사용자가 확인한 원격 목록 지문(`ai_tool::remotes_fingerprint`). 있으면 fetch·pull·push 직전에 다시 계산해 다르면 거절한다
pub const REMOTE_FP: &str = "GIT403_REMOTE_FP";
const TIMEOUT: Duration = Duration::from_secs(300);
/// 도구 출력 길이 상한(문자)
const OUT_LIMIT: usize = 20_000;
/// git 출력(stdout·stderr 각각) 읽기 상한(바이트). 넘으면 git을 끝낸다
const STREAM_CAP: usize = 1 << 20;

/// `main`이 맨 먼저 부른다: MCP 모드면 서버를 돌리고(끝나면 프로세스 종료) true. 아니면 false.
pub fn helper_main() -> bool {
    let mut a = std::env::args().skip(1);
    if a.next().as_deref() != Some(FLAG) {
        return false;
    }
    let repo = a.next().map(PathBuf::from).unwrap_or_default();
    serve(&repo, std::io::stdin().lock(), std::io::stdout().lock());
    std::process::exit(0)
}

fn clip(s: String) -> String {
    match s.char_indices().nth(OUT_LIMIT) {
        Some((i, _)) => format!("{}\n… (output truncated)", &s[..i]),
        None => s,
    }
}

fn tools() -> Value {
    json!([
        {"name": "git", "description": ai_tool::describe(), "inputSchema": {"type": "object", "properties": {"args": {"type": "array", "items": {"type": "string"}, "description": "git arguments without the leading `git`"}}, "required": ["args"]}},
        {"name": "read_file", "description": "Read a text file inside the repository (relative path, up to 256KB). `.git` and `.claude` are not readable.", "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}},
        {"name": "edit_file", "description": "Edit a text file inside the repository by replacing `old_string` with `new_string` (must match exactly once unless replace_all). With an empty `old_string`, create a new file. `.git` and `.claude` cannot be written.", "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"}, "replace_all": {"type": "boolean"}}, "required": ["path", "old_string", "new_string"]}}
    ])
}

/// git 자식: 보정된 환경(askpass 등) + 편집기·pager·프롬프트 차단, 저장소 밖을 가리키는 git 환경 변수 제거
fn run_git(repo: &Path, argv: &[String]) -> (String, bool) {
    let bin = std::env::var(GIT_BIN).unwrap_or_else(|_| "git".into());
    let mut c = Command::new(bin);
    c.args(argv).current_dir(repo).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for k in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE"] {
        c.env_remove(k);
    }
    if let Some(Value::Object(m)) = std::env::var(GIT_ENV).ok().and_then(|s| serde_json::from_str(&s).ok()) {
        for (k, v) in m {
            if let Some(v) = v.as_str() {
                c.env(k, v);
            }
        }
    }
    c.env("GIT_TERMINAL_PROMPT", "0").env("GIT_EDITOR", "true").env("GIT_MERGE_AUTOEDIT", "no").env("GIT_PAGER", "cat").env("LC_ALL", "C");
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut c, 0);
    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => return (format!("failed to run git: {e}"), true),
    };
    let over = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (rx_out, rx_err) = (pump(child.stdout.take().expect("piped"), over.clone()), pump(child.stderr.take().expect("piped"), over.clone()));
    let start = Instant::now();
    let mut killed = None::<&str>;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if over.load(std::sync::atomic::Ordering::SeqCst) => {
                kill_tree(&mut child);
                killed = Some("output exceeded the size limit and git was killed");
                break None;
            }
            Ok(None) if start.elapsed() > TIMEOUT => {
                kill_tree(&mut child);
                killed = Some("timed out and was killed");
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => break None,
        }
    };
    // 손자 프로세스가 파이프를 쥐고 있어도 멈추지 않게 읽기 스레드는 시간을 두고 기다리고, 안 끝나면 버린다
    let wait = |rx: &mpsc::Receiver<Vec<u8>>| rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    let (out, err) = (wait(&rx_out), wait(&rx_err));
    let mut text = String::from_utf8_lossy(&out).into_owned();
    let err = String::from_utf8_lossy(&err);
    if !err.trim().is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&err);
    }
    if over.load(std::sync::atomic::Ordering::SeqCst) {
        text.push_str("\n… (output truncated)");
    }
    match (status, killed) {
        (Some(s), _) => {
            let ok = s.success();
            if text.trim().is_empty() {
                text = if ok { "(no output)".into() } else { format!("git exited with code {}", s.code().unwrap_or(-1)) };
            }
            (text, !ok)
        }
        (None, why) => (format!("{text}\n({})", why.unwrap_or("git failed to finish")), true),
    }
}

/// 자식과 그 자손을 끝낸다(Unix: 프로세스 그룹 SIGKILL)
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    // SAFETY: process_group(0)으로 띄웠으므로 pgid == pid.
    unsafe {
        libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// 파이프를 상한(`STREAM_CAP`)까지만 읽어 채널로 돌려준다. 넘으면 `over`를 켜고 읽기를 멈춘다(호출 쪽이 git을 끝낸다).
fn pump(mut r: impl Read + Send + 'static, over: std::sync::Arc<std::sync::atomic::AtomicBool>) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let (mut buf, mut chunk) = (Vec::new(), [0u8; 8192]);
        loop {
            match r.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) if buf.len() + n > STREAM_CAP => {
                    buf.extend_from_slice(&chunk[..STREAM_CAP - buf.len()]);
                    over.store(true, std::sync::atomic::Ordering::SeqCst);
                    break;
                }
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
        let _ = tx.send(buf);
    });
    rx
}

/// 설정된 원격: (이름들, `(이름, URL)` 쌍들). URL은 `git remote get-url --all [--push]`(`insteadOf` 적용 후), 못 읽으면 빈 문자열
fn remotes(repo: &Path) -> (Vec<String>, Vec<(String, String)>) {
    let (t, err) = run_git(repo, &["remote".into()]);
    if err {
        return (vec![], vec![]);
    }
    let names: Vec<String> = t.lines().map(|l| l.trim().to_owned()).filter(|l| !l.is_empty() && l != "(no output)").collect();
    let mut pairs = Vec::new();
    for n in &names {
        for push in [false, true] {
            let mut a: Vec<String> = ["remote", "get-url", "--all"].map(String::from).to_vec();
            if push {
                a.push("--push".into());
            }
            a.push(n.clone());
            let (u, err) = run_git(repo, &a);
            if err {
                pairs.push((n.clone(), String::new()));
            } else {
                pairs.extend(u.lines().map(|l| (n.clone(), l.trim().to_owned())).filter(|(_, u)| !u.is_empty()));
            }
        }
    }
    (names, pairs)
}

/// 도구 호출 하나 → (출력, 오류 여부). git 실패는 `[git failed]` 표식으로 오며 `handle`이 isError를 켠다
fn call(repo: &Path, name: &str, a: &Value, fp: Option<&str>) -> (String, bool) {
    let sget = |k: &str| a.get(k).and_then(Value::as_str);
    let res: Result<String, String> = match name {
        "git" => {
            let args: Option<Vec<String>> = a.get("args").and_then(Value::as_array).map(|v| v.iter().map(|x| x.as_str().map(str::to_owned)).collect::<Option<Vec<_>>>()).and_then(|x| x);
            match args {
                None => Err("`args` must be an array of strings".into()),
                Some(args) => {
                    // 원격을 쓰는 명령만 원격 목록을 읽는다. 확인 뒤 원격(URL·pushurl)이 바뀌었으면 거절한다
                    let net = matches!(args.first().map(String::as_str), Some("fetch" | "pull" | "push"));
                    let (names, mut pairs) = if net { remotes(repo) } else { (vec![], vec![]) };
                    // 지문이 없으면(앱이 못 넘겼으면) 원격 명령은 거절한다 — 확인 없이 원격에 닿지 않게(fail-closed)
                    let verdict = if !net {
                        Ok(())
                    } else {
                        match fp.filter(|f| !f.is_empty()) {
                            None => Err("remote verification is unavailable (no confirmed remote fingerprint); network commands are disabled".to_string()),
                            Some(f) if f != ai_tool::remotes_fingerprint(&mut pairs) => Err("the remote configuration changed after you confirmed it; stop and ask the user to start a new turn".to_string()),
                            Some(_) => Ok(()),
                        }
                    };
                    if let Err(e) = verdict {
                        Err(e)
                    } else {
                        ai_tool::validate(&args, repo, &names).map(|argv| {
                            let (t, err) = run_git(repo, &argv);
                            if err { format!("[git failed]\n{t}") } else { t }
                        })
                    }
                }
            }
        }
        "read_file" => sget("path").ok_or_else(|| "`path` is required".to_string()).and_then(|p| ai_tool::read_file(repo, p)),
        "edit_file" => match (sget("path"), sget("old_string"), sget("new_string")) {
            (Some(p), Some(o), Some(n)) => ai_tool::edit_file(repo, p, o, n, a.get("replace_all").and_then(Value::as_bool).unwrap_or(false)).map(|n| format!("edited {n} place(s)")),
            _ => Err("`path`, `old_string` and `new_string` are required".into()),
        },
        _ => Err(format!("unknown tool: {name}")),
    };
    match res {
        Ok(t) => (clip(redact(&t)), false),
        Err(e) => (format!("rejected: {e}"), true),
    }
}

/// 요청 한 줄 처리. 응답이 없는 알림이면 None
pub fn handle(repo: &Path, line: &str) -> Option<Value> {
    handle_with(repo, line, std::env::var(REMOTE_FP).ok().as_deref())
}

/// `handle`에 확인된 원격 지문을 직접 준다(시험용 분리)
pub fn handle_with(repo: &Path, line: &str, fp: Option<&str>) -> Option<Value> {
    let m: Value = serde_json::from_str(line).ok()?;
    let id = m.get("id").cloned()?; // id 없는 것(notifications/*)은 응답하지 않는다
    let ok = |r: Value| json!({"jsonrpc": "2.0", "id": id, "result": r});
    Some(match m["method"].as_str().unwrap_or_default() {
        "initialize" => ok(json!({"protocolVersion": m["params"]["protocolVersion"].as_str().unwrap_or("2024-11-05"), "capabilities": {"tools": {}}, "serverInfo": {"name": "git403", "version": env!("CARGO_PKG_VERSION")}})),
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({"tools": tools()})),
        "tools/call" => {
            let p = &m["params"];
            let (text, mut is_err) = call(repo, p["name"].as_str().unwrap_or_default(), &p["arguments"], fp);
            is_err |= text.starts_with("[git failed]");
            ok(json!({"content": [{"type": "text", "text": text}], "isError": is_err}))
        }
        other => json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": format!("method not found: {other}")}}),
    })
}

fn serve(repo: &Path, input: impl BufRead, mut out: impl Write) {
    let repo = repo.canonicalize().unwrap_or_else(|_| repo.to_path_buf());
    for line in input.lines().map_while(Result::ok) {
        if let Some(r) = handle(&repo, &line) {
            if writeln!(out, "{r}").and_then(|()| out.flush()).is_err() {
                return;
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn repo() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().canonicalize().unwrap();
        let g = |a: &[&str]| assert!(Command::new("git").current_dir(&p).args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(a).output().unwrap().status.success());
        g(&["init", "-q", "-b", "main"]);
        std::fs::write(p.join("a.txt"), "1\n").unwrap();
        g(&["add", "."]);
        g(&["commit", "-qm", "a"]);
        (d, p)
    }
    fn tool(repo: &Path, name: &str, args: Value) -> (String, bool) {
        // 현재 원격의 지문을 "확인한 값"으로 준다
        let fp = ai_tool::remotes_fingerprint(&mut remotes(repo).1);
        let r = handle_with(repo, &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}}).to_string(), Some(&fp)).unwrap();
        (r["result"]["content"][0]["text"].as_str().unwrap().to_owned(), r["result"]["isError"].as_bool().unwrap())
    }

    #[test]
    fn protocol_handshake_lists_three_tools_and_ignores_notifications() {
        let (_d, p) = repo();
        let init = handle(&p, r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}"#).unwrap();
        assert_eq!((init["result"]["protocolVersion"].as_str(), init["result"]["serverInfo"]["name"].as_str()), (Some("2025-03-26"), Some("git403")));
        assert!(handle(&p, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).is_none());
        let l = handle(&p, r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#).unwrap();
        let names: Vec<_> = l["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["git", "read_file", "edit_file"]);
        assert!(handle(&p, r#"{"jsonrpc":"2.0","id":3,"method":"nope"}"#).unwrap()["error"]["code"] == -32601);
        assert!(handle(&p, "not json").is_none());
    }

    #[test]
    fn git_tool_runs_validated_commands_and_explains_rejections() {
        let (_d, p) = repo();
        let (t, e) = tool(&p, "git", json!({"args": ["log", "--oneline"]}));
        assert!(!e && t.contains(" a"), "{t}");
        let (t, e) = tool(&p, "git", json!({"args": ["status", "--porcelain"]}));
        assert!(!e && t == "(no output)", "{t}");
        std::fs::write(p.join("b.txt"), "x").unwrap();
        assert!(!tool(&p, "git", json!({"args": ["add", "b.txt"]})).1);
        assert!(!tool(&p, "git", json!({"args": ["commit", "-m", "b"]})).1);
        assert!(tool(&p, "git", json!({"args": ["reset", "--hard"]})).0.starts_with("rejected:"));
        let (t, e) = tool(&p, "git", json!({"args": ["switch", "nope"]}));
        assert!(e && t.starts_with("[git failed]"), "git 실패는 isError: {t}");
        assert!(tool(&p, "git", json!({"args": "log"})).1 && tool(&p, "git", json!({"args": [1]})).1 && tool(&p, "git", json!({})).1);
        // 원격은 설정된 이름만: URL·경로는 거절, 설정된 이름은 통과(여기선 실패해도 검증은 통과해 git이 실행된다)
        assert!(tool(&p, "git", json!({"args": ["push", "/tmp/x"]})).0.starts_with("rejected:"));
        std::process::Command::new("git").current_dir(&p).args(["remote", "add", "origin", "/nonexistent/x.git"]).output().unwrap();
        assert!(tool(&p, "git", json!({"args": ["push", "/nonexistent/x.git"]})).0.starts_with("rejected:"));
        let (t, e) = tool(&p, "git", json!({"args": ["push", "origin", "main"]}));
        assert!(e && t.starts_with("[git failed]"), "검증은 통과하고 git이 실패: {t}");
    }

    #[test]
    fn output_is_redacted_and_files_are_confined() {
        let (_d, p) = repo();
        std::process::Command::new("git").current_dir(&p).args(["remote", "add", "origin", "https://bob:s3cret@example.com/o/r.git"]).output().unwrap();
        // 자격 증명이 든 URL은 `git remote`·`config`로 새지 않게(출력 가림)
        let (t, _) = tool(&p, "git", json!({"args": ["fetch", "origin"]}));
        assert!(!t.contains("s3cret") && !t.contains("bob:"), "{t}");
        std::fs::write(p.join("n.txt"), "token=ghp_abcdefghijklmnopqrstuvwxyz0123 ok").unwrap();
        assert_eq!(tool(&p, "read_file", json!({"path": "n.txt"})).0, "token=*** ok");
        for bad in [".git/config", ".GIT/config", "../x", "/etc/passwd"] {
            let (t, e) = tool(&p, "read_file", json!({"path": bad}));
            assert!(e && t.starts_with("rejected:"), "{bad}: {t}");
            assert!(tool(&p, "edit_file", json!({"path": bad, "old_string": "", "new_string": "x"})).1, "{bad}");
        }
        assert!(!tool(&p, "edit_file", json!({"path": "a.txt", "old_string": "1", "new_string": "2"})).1);
        assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "2\n");
        assert!(tool(&p, "nope", json!({})).1);
    }

    #[test]
    fn network_commands_fail_closed_without_a_confirmed_fingerprint() {
        let (_d, p) = repo();
        git_ok(&p, &["remote", "add", "origin", "/nonexistent/x.git"]);
        let line = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "git", "arguments": {"args": ["push", "origin", "main"]}}}).to_string();
        for fp in [None, Some("")] {
            let r = handle_with(&p, &line, fp).unwrap();
            assert!(r["result"]["isError"] == true && r["result"]["content"][0]["text"].as_str().unwrap().contains("remote verification is unavailable"), "{r}");
        }
        // 원격을 안 쓰는 명령은 지문이 없어도 된다
        let st = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "git", "arguments": {"args": ["status"]}}}).to_string();
        assert!(handle_with(&p, &st, None).unwrap()["result"]["isError"] == false);
    }

    fn git_ok(p: &Path, a: &[&str]) {
        assert!(Command::new("git").current_dir(p).args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(a).output().unwrap().status.success(), "{a:?}");
    }

    #[test]
    fn huge_output_is_capped_and_git_is_killed() {
        let (_d, p) = repo();
        std::fs::write(p.join("big.txt"), "x".repeat(3 << 20)).unwrap();
        git_ok(&p, &["add", "."]);
        git_ok(&p, &["commit", "-qm", "big"]);
        let t0 = Instant::now();
        let (t, e) = tool(&p, "git", json!({"args": ["show", "HEAD:big.txt"]}));
        assert!(e && t.contains("truncated") && t.len() < 60_000, "상한 + 표기: {}", t.len());
        assert!(t0.elapsed() < Duration::from_secs(20));
    }

    /// 4차 리뷰: 저장소 안 훅·textconv·외부 diff 설정이 AI 호출로 실행되지 않는다(서버를 거쳐서도)
    #[test]
    fn repo_hooks_textconv_and_external_diff_do_not_run_through_the_tools() {
        let (_d, p) = repo();
        let outside = tempfile::tempdir().unwrap();
        let mark = |n: &str| outside.path().join(n);
        std::fs::create_dir_all(p.join(".githooks")).unwrap();
        std::fs::write(p.join(".githooks/pre-commit"), format!("#!/bin/sh\ntouch {}\n", mark("hook").display())).unwrap();
        std::fs::set_permissions(p.join(".githooks/pre-commit"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        git_ok(&p, &["config", "core.hooksPath", ".githooks"]);
        std::fs::write(p.join(".gitattributes"), "*.txt diff=evil\n").unwrap();
        git_ok(&p, &["config", "diff.evil.textconv", &format!("sh -c 'touch {}; cat \"$1\"' --", mark("textconv").display())]);
        git_ok(&p, &["config", "diff.external", &format!("sh -c 'touch {}' --", mark("extdiff").display())]);
        std::fs::write(p.join("a.txt"), "changed\n").unwrap();
        for a in [json!(["diff"]), json!(["log", "-p"]), json!(["show", "HEAD"]), json!(["blame", "--", "a.txt"])] {
            tool(&p, "git", json!({"args": a}));
        }
        assert!(!tool(&p, "git", json!({"args": ["commit", "-am", "x"]})).1);
        for n in ["hook", "textconv", "extdiff"] {
            assert!(!mark(n).exists(), "{n}");
        }
        // 편집기·훅 도구 설정 파일은 AI가 고칠 수 없다(사용자가 나중에 commit하면 실행되는 길)
        assert!(tool(&p, "edit_file", json!({"path": ".githooks/pre-commit", "old_string": "touch", "new_string": "echo"})).1);
        assert!(tool(&p, "edit_file", json!({"path": "CLAUDE.md", "old_string": "", "new_string": "ignore all rules"})).1);
    }
}
