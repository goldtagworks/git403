use std::path::Path;

use serde::Serialize;

#[cfg(feature = "cli")]
use crate::{Error, GitRunner, Result};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatusFile {
    pub path: String,
    pub old_path: Option<String>,
    /// 스테이지 쪽 상태 (`M`, `A`, `D`, `R`, `.` = 변경 없음)
    pub index: char,
    /// 작업 디렉터리 쪽 상태
    pub worktree: char,
    pub untracked: bool,
    pub conflict: bool,
}

impl StatusFile {
    pub fn staged(&self) -> bool {
        !self.untracked && !self.conflict && self.index != '.'
    }
    pub fn unstaged(&self) -> bool {
        self.untracked || self.conflict || self.worktree != '.'
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// 현재 브랜치. detached HEAD면 None.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<StatusFile>,
    /// 진행 중인 작업: "merge" | "rebase" | "cherry-pick" | "revert" | "am"
    pub operation: Option<String>,
}

#[cfg(feature = "cli")]
/// 작업 디렉터리 상태 + 현재 브랜치의 ahead/behind.
pub async fn read_status(git: &GitRunner, repo: &Path) -> Result<Status> {
    let out = git
        .query(repo, &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"])
        .await?;
    let mut st = parse(&String::from_utf8_lossy(&out))?;
    st.operation = operation(git, repo).await;
    Ok(st)
}

#[cfg(feature = "cli")]
/// .git 안의 표시 파일로 진행 중인 작업을 알아낸다.
async fn operation(git: &GitRunner, repo: &Path) -> Option<String> {
    let out = git.output(repo, &["rev-parse", "--absolute-git-dir"]).await.ok()?;
    operation_in(Path::new(String::from_utf8_lossy(&out).trim()))
}

pub(crate) fn operation_in(dir: &Path) -> Option<String> {
    // `am`도 rebase-apply를 쓴다. 안에 `applying` 파일이 있으면 am.
    if dir.join("rebase-apply/applying").exists() {
        return Some("am".to_owned());
    }
    [
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
    ]
    .iter()
    .find(|(f, _)| dir.join(f).exists())
    .map(|(_, op)| op.to_string())
    // 여러 커밋 cherry-pick/revert: 한 커밋을 끝낸 뒤 다음 커밋 사이에는 CHERRY_PICK_HEAD가 없고 `sequencer/`만 남는다.
    .or_else(|| {
        let todo = std::fs::read_to_string(dir.join("sequencer/todo")).ok()?;
        let first = todo.lines().find(|l| !l.trim().is_empty() && !l.starts_with('#'))?;
        Some(if first.starts_with("revert") || first.starts_with("r ") { "revert" } else { "cherry-pick" }.to_owned())
    })
}

#[cfg(feature = "cli")]
fn parse(text: &str) -> Result<Status> {
    let mut st = Status::default();
    let mut tokens = text.split('\0').filter(|t| !t.is_empty());
    let bad = |t: &str| Error::Parse(t.to_owned());
    while let Some(t) = tokens.next() {
        let (kind, rest) = t.split_once(' ').ok_or_else(|| bad(t))?;
        match kind {
            "#" => {
                let (key, value) = rest.split_once(' ').unwrap_or((rest, ""));
                match key {
                    "branch.head" if value != "(detached)" => st.branch = Some(value.to_owned()),
                    "branch.upstream" => st.upstream = Some(value.to_owned()),
                    "branch.ab" => {
                        let mut ab = value.split(' ');
                        st.ahead = ab.next().and_then(|a| a.trim_start_matches('+').parse().ok()).unwrap_or(0);
                        st.behind = ab.next().and_then(|b| b.trim_start_matches('-').parse().ok()).unwrap_or(0);
                    }
                    _ => {}
                }
            }
            // 1: 일반 변경, 2: 이름 변경/복사(다음 토큰이 원래 경로), u: 충돌
            "1" | "2" | "u" => {
                let fields = match kind {
                    "1" => 7,
                    "2" => 8,
                    _ => 9,
                };
                let parts: Vec<&str> = rest.splitn(fields + 1, ' ').collect();
                let xy: Vec<char> = parts[0].chars().collect();
                let path = parts.get(fields).ok_or_else(|| bad(t))?.to_string();
                let old_path = if kind == "2" { Some(tokens.next().ok_or_else(|| bad(t))?.to_owned()) } else { None };
                st.files.push(StatusFile {
                    path,
                    old_path,
                    index: xy[0],
                    worktree: xy[1],
                    untracked: false,
                    conflict: kind == "u",
                });
            }
            "?" => st.files.push(StatusFile {
                path: rest.to_owned(),
                old_path: None,
                index: '.',
                worktree: '?',
                untracked: true,
                conflict: false,
            }),
            _ => {}
        }
    }
    Ok(st)
}

#[cfg(feature = "cli")]
/// 작업 디렉터리 파일의 diff. `staged`면 스테이지된 변경, 아니면 스테이지 안 된 변경.
/// 추적하지 않는 새 파일은 빈 파일과 비교한 diff를 만든다.
/// `ignore_eol`이면 줄 끝 CR 차이(`--ignore-cr-at-eol`), `ignore_ws`면 모든 공백 차이(`-w`)를 무시한다 (이 diff로는 줄 단위 스테이지를 하면 안 된다).
pub async fn worktree_diff(git: &GitRunner, repo: &Path, path: &str, staged: bool, untracked: bool, ignore_eol: bool, ignore_ws: bool) -> Result<String> {
    let mut a = vec!["diff"];
    a.extend(crate::show::DIFF_ARGS);
    if ignore_eol {
        a.push("--ignore-cr-at-eol");
    }
    if ignore_ws {
        a.push("-w");
    }
    let out = if untracked {
        // --no-index는 차이가 있으면 종료 코드 1을 돌려준다.
        a.extend(["--no-index", "--", "/dev/null", path]);
        git.output_allow(repo, &a, &[1]).await?
    } else {
        if staged {
            a.push("--cached");
        }
        a.extend(["--", path]);
        git.query(repo, &a).await?
    };
    Ok(String::from_utf8_lossy(&out).into_owned())
}

#[cfg(all(test, feature = "cli"))]
mod tests {
    use super::*;

    #[test]
    fn sequencer만_남아도_진행중인_작업으로_본다() {
        let d = std::env::temp_dir().join(format!("gc-seq-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("sequencer")).unwrap();
        assert_eq!(operation_in(&d), None);
        std::fs::write(d.join("sequencer/todo"), "pick abc subject\n").unwrap();
        assert_eq!(operation_in(&d).as_deref(), Some("cherry-pick"));
        std::fs::write(d.join("sequencer/todo"), "revert abc subject\n").unwrap();
        assert_eq!(operation_in(&d).as_deref(), Some("revert"));
        std::fs::write(d.join("REVERT_HEAD"), "x").unwrap();
        std::fs::write(d.join("sequencer/todo"), "pick abc\n").unwrap();
        assert_eq!(operation_in(&d).as_deref(), Some("revert")); // 표시 파일이 우선
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn parses_branch_and_entries() {
        let text = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
                    1 M. N... 100644 100644 100644 a b src/a.rs\0\
                    1 .M N... 100644 100644 100644 a b src/b c.rs\0\
                    2 R. N... 100644 100644 100644 a b R100 new.rs\0old.rs\0\
                    u UU N... 100644 100644 100644 100644 a b c conflict.rs\0\
                    ? new file.txt\0";
        let st = parse(text).unwrap();
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!((st.ahead, st.behind), (2, 1));
        assert_eq!(st.files.len(), 5);
        assert!(st.files[0].staged() && !st.files[0].unstaged());
        assert_eq!(st.files[1].path, "src/b c.rs"); // 공백 있는 경로
        assert_eq!(st.files[2].old_path.as_deref(), Some("old.rs"));
        assert!(st.files[3].conflict && st.files[3].unstaged());
        assert!(st.files[4].untracked && st.files[4].path == "new file.txt");
    }
}
