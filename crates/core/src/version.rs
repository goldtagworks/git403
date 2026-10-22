//! `git --version` 조회: 앱이 git을 번들하지 않으므로 시작 시 설치 여부를 확인한다.

use crate::GitRunner;

/// 설치된 git의 버전 문자열(`2.45.1`). 실행할 수 없으면 None (에러가 아니라 "미설치" 신호).
pub async fn git_version(git: &GitRunner) -> Option<String> {
    let out = git.output(&std::env::temp_dir(), &["--version"]).await.ok()?;
    parse_version(&String::from_utf8_lossy(&out))
}

/// `git version 2.45.1`, `git version 2.39.3 (Apple Git-146)`, `git version 2.45.1.windows.1` → 첫 숫자 토큰 이후 첫 단어.
fn parse_version(s: &str) -> Option<String> {
    let rest = s.trim().strip_prefix("git version ")?;
    let v = rest.split_whitespace().next()?;
    v.chars().next()?.is_ascii_digit().then(|| v.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_variants() {
        assert_eq!(parse_version("git version 2.45.1\n").as_deref(), Some("2.45.1"));
        assert_eq!(parse_version("git version 2.39.3 (Apple Git-146)\n").as_deref(), Some("2.39.3"));
        assert_eq!(parse_version("git version 2.45.1.windows.1").as_deref(), Some("2.45.1.windows.1"));
        assert_eq!(parse_version("command not found"), None);
        assert_eq!(parse_version(""), None);
    }

    #[tokio::test]
    async fn missing_git_is_none() {
        assert_eq!(git_version(&GitRunner::new("/nonexistent/git-xyz")).await, None);
    }
}
