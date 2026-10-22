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

/// 로그인 셸을 못 물었을 때라도 붙이는 흔한 설치 위치 (Homebrew·MacPorts·사용자 bin)
const WELL_KNOWN: &[&str] = &["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/opt/local/bin"];

/// `$SHELL -ilc 'printf …$PATH…'`. rc가 무거운 셸(nvm·conda 등)도 기다리도록 10초, 실패하면 한 번 더.
/// 끝내 못 얻으면 현재 PATH에 흔한 설치 위치를 붙인 값을 쓰고, 원인은 `Err`로 돌려준다(로그용).
pub async fn login_shell_path(shell: &str) -> Result<String, (String, String)> {
    let current = std::env::var("PATH").unwrap_or_default();
    let mut why = String::new();
    for _ in 0..2 {
        match ask(shell, Duration::from_secs(10)).await {
            Ok(login) => return Ok(merge_path(&login, &current)),
            Err(e) => why = e,
        }
    }
    let home = std::env::var("HOME").map(|h| format!("{h}/.local/bin")).unwrap_or_default();
    let extra: Vec<&str> = WELL_KNOWN.iter().copied().chain([home.as_str()]).collect();
    Err((merge_path(&current, &extra.join(":")), why))
}

async fn ask(shell: &str, limit: Duration) -> Result<String, String> {
    let run = tokio::process::Command::new(shell)
        .args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .output();
    let out = match tokio::time::timeout(limit, run).await {
        Err(_) => return Err(format!("{shell}: {}초 안에 끝나지 않음", limit.as_secs())),
        Ok(Err(e)) => return Err(format!("{shell}: {e}")),
        Ok(Ok(o)) => o,
    };
    parse_path_output(&String::from_utf8_lossy(&out.stdout)).ok_or_else(|| {
        let err = String::from_utf8_lossy(&out.stderr);
        format!("{shell}: PATH를 못 읽음 (종료 {:?}) {}", out.status.code(), err.lines().last().unwrap_or("").trim())
    })
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
        // 셸이 없어도 흔한 설치 위치는 붙이고 원인을 알려 준다
        let (fallback, why) = login_shell_path("/no/such/shell").await.unwrap_err();
        assert!(fallback.contains("/opt/homebrew/bin") && fallback.contains("/usr/local/bin"), "{fallback}");
        assert!(why.contains("/no/such/shell"), "{why}");
    }
}
