use std::path::Path;

use serde::Serialize;

use crate::{GitRunner, Result};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    Local,
    Remote,
    Tag,
    Stash,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ref {
    pub kind: RefKind,
    /// 표시 이름: `main`, `origin/main`, `v1.0`, `stash@{0}`
    pub name: String,
    pub target: String,
    pub head: bool,
    /// 스태시 메시지 등 추가 설명
    pub message: Option<String>,
    /// 로컬 브랜치의 upstream 대비 앞선(push할) 커밋 수
    pub ahead: u32,
    /// 로컬 브랜치의 upstream 대비 뒤처진(pull할) 커밋 수
    pub behind: u32,
}

/// 사이드바와 그래프 배지에 쓰는 참조 전체.
pub async fn read_refs(git: &GitRunner, repo: &Path) -> Result<Vec<Ref>> {
    let refs = git
        // 태그는 주석 태그일 때 가리키는 커밋(`*objectname`)을 쓴다.
        .output(repo, &["for-each-ref", "--format=%(refname)%1f%(objectname)%1f%(*objectname)%1f%(HEAD)%1f%(upstream:track,nobracket)", "refs/heads", "refs/remotes", "refs/tags"])
        .await?;
    let stashes = git.output(repo, &["stash", "list", "--format=%gd%x1f%H%x1f%s"]).await?;
    Ok(parse_refs(&String::from_utf8_lossy(&refs))
        .chain(parse_stashes(&String::from_utf8_lossy(&stashes)))
        .collect())
}

fn parse_refs(text: &str) -> impl Iterator<Item = Ref> + '_ {
    text.lines().filter_map(|line| {
        let f: Vec<&str> = line.split('\u{1f}').collect();
        let [full, obj, peeled, head, track] = f[..] else { return None };
        let (kind, name) = if let Some(n) = full.strip_prefix("refs/heads/") {
            (RefKind::Local, n)
        } else if let Some(n) = full.strip_prefix("refs/remotes/") {
            if n.ends_with("/HEAD") {
                return None;
            }
            (RefKind::Remote, n)
        } else {
            (RefKind::Tag, full.strip_prefix("refs/tags/")?)
        };
        let target = if peeled.is_empty() { obj } else { peeled };
        let (ahead, behind) = parse_track(track);
        Some(Ref { kind, name: name.to_owned(), target: target.to_owned(), head: head == "*", message: None, ahead, behind })
    })
}

/// `ahead 2, behind 6` / `behind 6` / `gone` / `` → (앞섬, 뒤처짐)
fn parse_track(t: &str) -> (u32, u32) {
    let n = |k: &str| t.split(", ").find_map(|p| p.strip_prefix(k)?.trim().parse().ok()).unwrap_or(0);
    (n("ahead "), n("behind "))
}

fn parse_stashes(text: &str) -> impl Iterator<Item = Ref> + '_ {
    text.lines().filter_map(|line| {
        let mut f = line.splitn(3, '\u{1f}');
        Some(Ref {
            kind: RefKind::Stash,
            name: f.next()?.to_owned(),
            target: f.next()?.to_owned(),
            head: false,
            message: f.next().map(str::to_owned),
            ahead: 0,
            behind: 0,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_kinds_and_skips_remote_head() {
        let text = "refs/heads/main\u{1f}a\u{1f}\u{1f}*\u{1f}ahead 2, behind 6\n\
                    refs/remotes/origin/HEAD\u{1f}a\u{1f}\u{1f} \u{1f}\n\
                    refs/remotes/origin/main\u{1f}a\u{1f}\u{1f} \u{1f}\n\
                    refs/tags/v1\u{1f}t\u{1f}c\u{1f} \u{1f}\n";
        let refs: Vec<_> = parse_refs(text).collect();
        assert_eq!(refs.len(), 3);
        assert!(refs[0].head && refs[0].kind == RefKind::Local);
        assert_eq!((refs[0].ahead, refs[0].behind), (2, 6));
        assert_eq!(parse_track("behind 3"), (0, 3));
        assert_eq!(parse_track("gone"), (0, 0));
        assert_eq!(refs[1].name, "origin/main");
        assert_eq!(refs[2].target, "c"); // 주석 태그는 커밋을 가리킨다
    }
}
