//! `git submodule status --recursive` + `.gitmodules`의 url.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use crate::{GitRunner, Result};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SubmoduleStatus {
    /// 정상 (' ')
    Ok,
    /// 미초기화 ('-')
    Uninitialized,
    /// 체크아웃된 커밋이 다름 ('+')
    Modified,
    /// 머지 충돌 ('U')
    Conflict,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Submodule {
    pub path: String,
    /// 최상위 `.gitmodules`에 없는 중첩 서브모듈은 None
    pub url: Option<String>,
    pub commit: String,
    pub status: SubmoduleStatus,
}

/// `.gitmodules`가 없으면 빈 목록.
pub async fn read_submodules(git: &GitRunner, repo: &Path) -> Result<Vec<Submodule>> {
    if !repo.join(".gitmodules").is_file() {
        return Ok(vec![]);
    }
    let status = git.query(repo, &["submodule", "status", "--recursive"]).await?;
    // 키가 하나도 없으면 종료 코드 1
    let cfg = git
        .output_allow(repo, &["config", "-f", ".gitmodules", "--get-regexp", r"^submodule\..*\.(path|url)$"], &[1])
        .await?;
    let urls = parse_urls(&String::from_utf8_lossy(&cfg));
    Ok(parse_status(&String::from_utf8_lossy(&status), &urls))
}

/// `submodule.<name>.path <p>` / `.url <u>` 줄에서 path → url 표를 만든다.
fn parse_urls(text: &str) -> HashMap<String, String> {
    let mut paths: HashMap<&str, &str> = HashMap::new();
    let mut urls: HashMap<&str, &str> = HashMap::new();
    for line in text.lines() {
        let Some((key, value)) = line.split_once(' ') else { continue };
        let Some(rest) = key.strip_prefix("submodule.") else { continue };
        if let Some(name) = rest.strip_suffix(".path") {
            paths.insert(name, value);
        } else if let Some(name) = rest.strip_suffix(".url") {
            urls.insert(name, value);
        }
    }
    paths
        .into_iter()
        .filter_map(|(name, p)| Some((p.to_owned(), (*urls.get(name)?).to_owned())))
        .collect()
}

fn parse_status(text: &str, urls: &HashMap<String, String>) -> Vec<Submodule> {
    text.lines()
        .filter_map(|line| {
            let mut chars = line.chars();
            let status = match chars.next()? {
                ' ' => SubmoduleStatus::Ok,
                '-' => SubmoduleStatus::Uninitialized,
                '+' => SubmoduleStatus::Modified,
                'U' => SubmoduleStatus::Conflict,
                _ => return None,
            };
            let (commit, rest) = chars.as_str().split_once(' ')?;
            // 뒤의 ` (describe)`는 떼어낸다. 경로에 공백이 있어도 마지막 ` (`만 본다.
            let path = match rest.rfind(" (") {
                Some(i) if rest.ends_with(')') => &rest[..i],
                _ => rest,
            };
            Some(Submodule { path: path.to_owned(), url: urls.get(path).cloned(), commit: commit.to_owned(), status })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status_and_urls() {
        let cfg = "submodule.a.b.path libs/a b\nsubmodule.a.b.url https://x/a.git\nsubmodule.c.path c\n";
        let urls = parse_urls(cfg);
        assert_eq!(urls["libs/a b"], "https://x/a.git");
        assert!(!urls.contains_key("c"));

        let text = " 1111 libs/a b (v1-2-gabc)\n-2222 c\n+3333 d (heads/main)\nU0000 e\n 4444 libs/a b/nested (x)\n";
        let subs = parse_status(text, &urls);
        assert_eq!(subs.len(), 5);
        assert_eq!(subs[0].path, "libs/a b");
        assert_eq!(subs[0].url.as_deref(), Some("https://x/a.git"));
        assert_eq!(subs[1].status, SubmoduleStatus::Uninitialized);
        assert_eq!(subs[1].url, None);
        assert_eq!(subs[2].status, SubmoduleStatus::Modified);
        assert_eq!(subs[3].status, SubmoduleStatus::Conflict);
        assert_eq!(subs[4].path, "libs/a b/nested");
    }
}
