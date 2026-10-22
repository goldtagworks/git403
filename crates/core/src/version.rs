//! `git --version` 조회: 앱이 git을 번들하지 않으므로 시작 시 설치 여부를 확인한다.

use crate::{Error, GitRunner, Result};

/// 설치된 git의 버전 문자열(`2.45.1`). 실행 파일이 없으면 Ok(None) ("미설치" 신호).
/// 설치돼 있는데 실패하면(macOS Xcode 라이선스 미동의 등) "미설치"로 뭉개지 않고 원인을 담은 Err.
pub async fn git_version(git: &GitRunner) -> Result<Option<String>> {
    match git.output(&std::env::temp_dir(), &["--version"]).await {
        Ok(out) => Ok(parse_version(&String::from_utf8_lossy(&out))),
        Err(Error::Spawn(e)) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
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
        assert_eq!(git_version(&GitRunner::new("/nonexistent/git-xyz")).await.unwrap(), None);
    }
}
