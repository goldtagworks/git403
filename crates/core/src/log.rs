#[cfg(feature = "cli")]
use std::path::Path;

use serde::Serialize;

#[cfg(feature = "cli")]
use crate::{Error, GitRunner, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub id: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub subject: String,
    /// 본문 앞부분(공백을 한 칸으로 합침, 최대 200자). 검색·설명 열 보조 표시용
    pub body: String,
}

#[cfg(feature = "cli")]
const FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b%x1e";
#[cfg(feature = "cli")]
const BODY_MAX: usize = 200;

#[cfg(feature = "cli")]
const SEP: char = '\u{1f}';

#[cfg(feature = "cli")]
/// 숨긴 ref(`refs/heads/x`, 폴더는 `refs/remotes/origin/foo/*`)를 `--all` 앞의 `--exclude`로 바꾼다.
/// `refs/`로 시작하지 않는 값은 무시한다. 빈 목록이면 아무것도 붙지 않는다.
fn exclude_args(hidden: &[String]) -> Vec<String> {
    hidden.iter().filter(|p| p.starts_with("refs/")).map(|p| format!("--exclude={p}")).collect()
}

#[cfg(feature = "cli")]
/// 숨긴 폴더 안에서 다시 보이게 한 예외(`!refs/remotes/origin/x`, 폴더는 `!…/foo/*`)를 `--all` 뒤에 붙인다.
/// `--exclude`는 다음 `--all`까지만 걸리므로 예외는 다시 포함된다. 폴더는 `--glob`, 단일 ref는 그대로(없는 ref는 `--ignore-missing`로 무시).
fn include_args(hidden: &[String]) -> Vec<String> {
    let inc: Vec<String> = hidden
        .iter()
        .filter_map(|p| p.strip_prefix('!'))
        .filter(|p| p.starts_with("refs/") && !p.starts_with("refs/-"))
        .map(|p| if p.ends_with("/*") { format!("--glob={p}") } else { p.to_owned() })
        .collect();
    if inc.is_empty() { inc } else { [vec!["--ignore-missing".to_owned()], inc].concat() }
}

#[cfg(feature = "cli")]
/// 현재 체크아웃한 커밋 (커밋이 없는 저장소면 None).
pub async fn head_commit(git: &GitRunner, repo: &Path) -> Option<String> {
    let out = git.query(repo, &["rev-parse", "--verify", "-q", "HEAD"]).await.ok()?;
    Some(String::from_utf8_lossy(&out).trim().to_owned()).filter(|s| !s.is_empty())
}

#[cfg(feature = "cli")]
/// 그래프용 커밋 목록. 부모가 항상 자식보다 뒤에 오면서 브랜치끼리는 날짜순으로 섞이도록 `--date-order`를 쓴다.
/// `hidden`에 든 ref로만 닿는 커밋은 빠진다 (HEAD는 `--all`에 늘 들어 있어 현재 브랜치는 숨겨지지 않는다).
pub async fn read_log(git: &GitRunner, repo: &Path, limit: usize, hidden: &[String]) -> Result<Vec<Commit>> {
    let max = format!("--max-count={limit}");
    let ex = exclude_args(hidden);
    let mut args: Vec<&str> = vec!["log", "--no-show-signature"];
    args.extend(ex.iter().map(String::as_str));
    args.push("--all");
    let inc = include_args(hidden);
    args.extend(inc.iter().map(String::as_str));
    args.extend(["--date-order", FORMAT, &max]);
    let out = git.output(repo, &args).await?;
    parse(&String::from_utf8_lossy(&out))
}

#[cfg(feature = "cli")]
/// 파일 하나의 히스토리 (이름 변경을 따라간다).
pub async fn file_log(git: &GitRunner, repo: &Path, path: &str, limit: usize) -> Result<Vec<Commit>> {
    let max = format!("--max-count={limit}");
    let out = git.output(repo, &["log", "--no-show-signature", "--follow", FORMAT, &max, "--", path]).await?;
    parse(&String::from_utf8_lossy(&out))
}

#[cfg(feature = "cli")]
/// 내용 검색: 문자열이 추가·삭제된 커밋의 SHA (`git log -S`). 숨긴 ref로만 닿는 커밋은 그래프에 없으니 뺀다.
pub async fn search_content(git: &GitRunner, repo: &Path, text: &str, hidden: &[String]) -> Result<Vec<String>> {
    let pick = format!("-S{text}");
    let ex = exclude_args(hidden);
    let mut args: Vec<&str> = vec!["log", "--no-show-signature"];
    args.extend(ex.iter().map(String::as_str));
    args.push("--all");
    let inc = include_args(hidden);
    args.extend(inc.iter().map(String::as_str));
    args.extend(["--format=%H", &pick]);
    let out = git.output(repo, &args).await?;
    Ok(String::from_utf8_lossy(&out).lines().map(str::to_owned).collect())
}

#[cfg(feature = "cli")]
fn parse(text: &str) -> Result<Vec<Commit>> {
    text.split('\x1e')
        .map(str::trim_start)
        .filter(|l| !l.is_empty())
        .map(|rec| {
            let mut f = rec.splitn(7, SEP);
            let mut next = || f.next().ok_or_else(|| Error::Parse(rec.to_owned()));
            let id = next()?.to_owned();
            let parents = next()?.split_whitespace().map(str::to_owned).collect();
            let author = next()?.to_owned();
            let email = next()?.to_owned();
            let time = next()?.parse().map_err(|_| Error::Parse(rec.to_owned()))?;
            let subject = next()?.to_owned();
            let body = f.next().unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ").chars().take(BODY_MAX).collect();
            Ok(Commit { id, parents, author, email, time, subject, body })
        })
        .collect()
}

#[cfg(all(test, feature = "cli"))]
mod tests {
    use super::*;

    #[test]
    fn parses_merge_and_root() {
        let text = "c\u{1f}b a\u{1f}Kim\u{1f}k@x.dev\u{1f}100\u{1f}Merge\u{1f}첫 줄\n\n둘째   줄\n\u{1e}\nb\u{1f}\u{1f}Lee\u{1f}l@x.dev\u{1f}90\u{1f}Init\u{1f}\u{1e}\n";
        let commits = parse(text).unwrap();
        assert_eq!(commits[0].parents, ["b", "a"]);
        assert!(commits[1].parents.is_empty());
        assert_eq!(commits[1].subject, "Init");
        assert_eq!(commits[0].email, "k@x.dev");
        assert_eq!(commits[0].body, "첫 줄 둘째 줄");
        assert_eq!(commits[1].body, "");
    }

    #[test]
    fn exclude_args_keeps_only_refs() {
        let h = ["refs/heads/x".to_owned(), "refs/remotes/origin/foo/*".to_owned(), "--all".to_owned()];
        assert_eq!(exclude_args(&h), ["--exclude=refs/heads/x", "--exclude=refs/remotes/origin/foo/*"]);
        assert!(exclude_args(&[]).is_empty());
    }

    #[test]
    fn include_args_takes_exceptions_only() {
        let h = ["refs/remotes/origin/*".to_owned(), "!refs/remotes/origin/main".to_owned(), "!refs/remotes/origin/feat/*".to_owned(), "!--all".to_owned()];
        assert_eq!(include_args(&h), ["--ignore-missing", "refs/remotes/origin/main", "--glob=refs/remotes/origin/feat/*"]);
        assert!(include_args(&["refs/heads/x".to_owned()]).is_empty());
    }
}
