use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use crate::{GitRunner, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub sha: String,
    pub author: String,
    pub time: i64,
    pub summary: String,
    pub text: String,
}

/// 줄마다 마지막으로 바꾼 커밋. `rev`가 있으면 그 커밋 시점 기준.
pub async fn blame(git: &GitRunner, repo: &Path, path: &str, rev: Option<&str>) -> Result<Vec<BlameLine>> {
    let mut args = vec!["blame", "--porcelain"];
    if let Some(r) = rev {
        args.push(crate::runner::reject_option(r)?);
    }
    args.extend(["--", path]);
    let out = git.output(repo, &args).await?;
    Ok(parse(&String::from_utf8_lossy(&out)))
}

/// porcelain 형식: 커밋 정보는 그 커밋이 처음 나올 때만 온다. 줄 내용은 탭으로 시작한다.
fn parse(text: &str) -> Vec<BlameLine> {
    #[derive(Default, Clone)]
    struct Info {
        author: String,
        time: i64,
        summary: String,
    }
    let mut infos: HashMap<String, Info> = HashMap::new();
    let mut lines = Vec::new();
    let mut current = String::new();
    for l in text.lines() {
        if let Some(content) = l.strip_prefix('\t') {
            let i = infos.get(&current).cloned().unwrap_or_default();
            lines.push(BlameLine { sha: current.clone(), author: i.author, time: i.time, summary: i.summary, text: content.to_owned() });
        } else if let Some(v) = l.strip_prefix("author ") {
            infos.entry(current.clone()).or_default().author = v.to_owned();
        } else if let Some(v) = l.strip_prefix("author-time ") {
            infos.entry(current.clone()).or_default().time = v.parse().unwrap_or(0);
        } else if let Some(v) = l.strip_prefix("summary ") {
            infos.entry(current.clone()).or_default().summary = v.to_owned();
        } else if l.len() >= 40 && l.as_bytes()[..40].iter().all(u8::is_ascii_hexdigit) {
            current = l[..40].to_owned();
        }
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeats_info_for_later_lines() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let text = format!(
            "{a} 1 1 2\nauthor Kim\nauthor-time 100\nsummary first\nfilename f\n\tline1\n\
             {b} 2 2 1\nauthor Lee\nauthor-time 200\nsummary second\nfilename f\n\tline2\n\
             {a} 3 3\n\tline3\n"
        );
        let lines = parse(&text);
        assert_eq!(lines.len(), 3);
        assert_eq!((lines[1].author.as_str(), lines[1].text.as_str()), ("Lee", "line2"));
        assert_eq!((lines[2].author.as_str(), lines[2].summary.as_str()), ("Kim", "first"));
    }
}
