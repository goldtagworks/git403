//! `git worktree list --porcelain`.

use std::path::Path;

use serde::Serialize;

use crate::{GitRunner, Result};

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub head: String,
    /// `refs/heads/` 뗀 이름. detached·bare면 None
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    pub locked: bool,
    pub prunable: bool,
    /// 첫 항목 = 메인 작업 폴더
    pub main: bool,
}

pub async fn read_worktrees(git: &GitRunner, repo: &Path) -> Result<Vec<Worktree>> {
    let out = git.output(repo, &["worktree", "list", "--porcelain"]).await?;
    Ok(parse(&String::from_utf8_lossy(&out)))
}

/// 항목은 빈 줄로 구분, 줄은 `키 [값]`.
fn parse(text: &str) -> Vec<Worktree> {
    let mut list: Vec<Worktree> = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        if key == "worktree" {
            list.push(Worktree { path: value.to_owned(), main: list.is_empty(), ..Default::default() });
            continue;
        }
        let Some(w) = list.last_mut() else { continue };
        match key {
            "HEAD" => w.head = value.to_owned(),
            "branch" => w.branch = Some(value.strip_prefix("refs/heads/").unwrap_or(value).to_owned()),
            "bare" => w.bare = true,
            "detached" => w.detached = true,
            "locked" => w.locked = true,
            "prunable" => w.prunable = true,
            _ => {}
        }
    }
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_entries() {
        let text = "worktree /r\nHEAD aaa\nbranch refs/heads/main\n\n\
                    worktree /r wt\nHEAD bbb\ndetached\nlocked reason here\n\n\
                    worktree /gone\nHEAD ccc\nbranch refs/heads/feat/x\nprunable gitdir file points to non-existent location\n";
        let w = parse(text);
        assert_eq!(w.len(), 3);
        assert!(w[0].main && w[0].branch.as_deref() == Some("main"));
        assert_eq!(w[1].path, "/r wt");
        assert!(w[1].detached && w[1].locked && w[1].branch.is_none() && !w[1].main);
        assert!(w[2].prunable);
        assert_eq!(w[2].branch.as_deref(), Some("feat/x"));
    }

    #[test]
    fn parses_bare() {
        let w = parse("worktree /r.git\nbare\n");
        assert!(w[0].bare && w[0].main);
    }
}
