//! 소스 검사: **샌드박스 밖에서 git을 만드는 길을 하나로 모은 규칙**이 깨지지 않게 지킨다(docs/security.md 9차).
//! 앱·MCP 서버의 읽기용 git은 `ai_tool::git_command`(동기)나 `GitRunner::hardened`(비동기)만 쓴다 — 맨 `Command::new(git)`·무방비 `GitRunner` 호출 금지.

use std::path::Path;

fn src(rel: &str) -> String {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    let t = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    // 시험 모듈 앞까지만(시험은 보통 git을 마음대로 쓴다)
    let end = ["#[cfg(all(test", "#[cfg(test)]"].iter().filter_map(|m| t.find(m)).min().unwrap_or(t.len());
    t[..end].to_string()
}

fn count(text: &str, needle: &str) -> usize {
    text.lines().filter(|l| !l.trim_start().starts_with("//")).map(|l| l.matches(needle).count()).sum()
}

#[test]
fn no_bare_git_process_outside_the_sandbox_in_ai_code() {
    for f in ["src/mcp.rs", "src/ai_risk.rs", "src/ai_chat.rs", "src/ai_history.rs", "../core/src/ai_config.rs", "../core/src/ai_backup.rs"] {
        let t = src(f);
        assert_eq!(count(&t, "Command::new("), 0, "{f}: 맨 Command::new 금지 — ai_tool::git_command를 쓴다");
    }
    // 유일한 생성 지점
    let tool = src("../core/src/ai_tool.rs");
    assert_eq!(count(&tool, "Command::new("), 1, "ai_tool.rs는 git_command 하나만 프로세스를 만든다");
    assert!(tool.contains("pub fn git_command(") && tool.contains("c.args(hardened_args())"));
}

#[test]
fn async_git_in_ai_code_goes_through_hardened_runners() {
    // 판정(ai_risk)은 hardened 실행기만: 무방비 `self.backend.run`·`self.git.output*`·`query` 금지
    let risk = src("src/ai_risk.rs");
    for bad in ["self.backend.run(", "self.git.output", "self.git.query", "self.backend.git"] {
        assert_eq!(count(&risk, bad), 0, "ai_risk.rs: {bad}");
    }
    assert_eq!(count(&risk, ".hardened(gc_core::ai_tool::hardened_args())"), 1);
    // 채팅 IPC는 git을 직접 부르지 않는다: 백업 함수(그 안에서 hardened)와 claude 실행(spawn_program)만
    let chat = src("src/ai_chat.rs");
    for bad in ["self.git.output", "self.git.query", "me.git.output", "me.git.query", "self.backend.run(", "self.git.spawn(", "self.git.spawn_shell"] {
        assert_eq!(count(&chat, bad), 0, "ai_chat.rs: {bad}");
    }
    // 백업의 모든 공개 함수는 첫 줄에서 hardened 실행기로 바꾼다
    let backup = src("../core/src/ai_backup.rs");
    assert_eq!(count(&backup, "pub async fn "), count(&backup, "let git = &hardened(git, repo).await;"), "ai_backup.rs: 공개 함수마다 hardened 실행기를 써야 한다");
}
