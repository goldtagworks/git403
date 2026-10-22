//! GUI로 실행한 앱은 로그인 셸의 PATH(homebrew, nvm 등)를 못 받는다.
//! 로그인 셸에게 PATH를 물어서 `GitRunner`가 쓰게 한다 (macOS·Linux만).

use std::time::Duration;

const MARK: &str = "__GC_PATH__";

/// 셸 출력(rc 파일이 찍은 잡음 포함)에서 마커 사이의 PATH만 꺼낸다.
pub fn parse_path_output(out: &str) -> Option<String> {
    let rest = out.split_once(MARK)?.1;
    let path = rest.split_once(MARK)?.0;
    (!path.is_empty()).then(|| path.to_owned())
}

/// 로그인 셸 PATH를 앞에, 현재 PATH에만 있는 항목을 뒤에 붙인다 (중복 제거).
pub fn merge_path(login: &str, current: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    login.split(':').chain(current.split(':')).filter(|p| !p.is_empty() && seen.insert(*p)).collect::<Vec<_>>().join(":")
}

/// `$SHELL -ilc 'printf …$PATH…'`. 2초 안에 못 끝나거나 실패하면 None (조용히 무시).
pub async fn login_shell_path(shell: &str) -> Option<String> {
    let run = tokio::process::Command::new(shell)
        .args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(2), run).await.ok()?.ok()?;
    let login = parse_path_output(&String::from_utf8_lossy(&out.stdout))?;
    Some(merge_path(&login, &std::env::var("PATH").unwrap_or_default()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_path_between_markers_ignoring_rc_noise() {
        assert_eq!(parse_path_output("Welcome!\n__GC_PATH__/a:/b__GC_PATH__").as_deref(), Some("/a:/b"));
        assert_eq!(parse_path_output("no marker"), None);
        assert_eq!(parse_path_output("__GC_PATH____GC_PATH__"), None);
    }

    #[test]
    fn merge_keeps_login_order_and_adds_missing_current_entries() {
        assert_eq!(merge_path("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin:"), "/opt/homebrew/bin:/usr/bin:/bin");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn asks_the_shell_and_gives_up_on_failure() {
        let p = login_shell_path("/bin/sh").await.expect("sh가 PATH를 돌려줌");
        assert!(p.contains("/bin"));
        assert_eq!(login_shell_path("/no/such/shell").await, None);
    }
}
