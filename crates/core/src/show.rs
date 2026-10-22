use std::path::Path;

use serde::Serialize;

use crate::runner::reject_option;
use crate::{GitRunner, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// `A` 추가, `M` 수정, `D` 삭제, `R` 이름 변경 …
    pub status: char,
    pub path: String,
    pub old_path: Option<String>,
}

// 머지 커밋은 첫 부모 기준으로 보여준다 (일반적인 git 클라이언트와 같은 동작).
const MERGE: &str = "--diff-merges=first-parent";

/// 화면에 보이는 diff는 색·외부 diff 도구·사용자 접두사 설정(`diff.noprefix` 등)과 무관하게 같은 모양이어야 한다.
pub const DIFF_ARGS: [&str; 4] = ["--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];

/// 커밋에서 바뀐 파일 목록 (`-z`: 경로를 인용·이스케이프 없이 NUL로 받는다).
pub async fn changed_files(git: &GitRunner, repo: &Path, commit: &str) -> Result<Vec<ChangedFile>> {
    let commit = reject_option(commit)?;
    let out = git.output(repo, &["show", "--format=", "--name-status", "-z", MERGE, commit]).await?;
    Ok(parse_status_z(&String::from_utf8_lossy(&out)))
}

/// 커밋의 파일 하나에 대한 unified diff.
/// `ignore_eol`이면 줄 끝 CR 차이(`--ignore-cr-at-eol`), `ignore_ws`면 모든 공백 차이(`-w`)를 무시한다.
pub async fn file_diff(git: &GitRunner, repo: &Path, commit: &str, path: &str, ignore_eol: bool, ignore_ws: bool) -> Result<String> {
    let commit = reject_option(commit)?;
    let mut a = vec!["show", "--format=", MERGE];
    a.extend(DIFF_ARGS);
    if ignore_eol {
        a.push("--ignore-cr-at-eol");
    }
    if ignore_ws {
        a.push("-w");
    }
    a.extend([commit, "--", path]);
    let out = git.output(repo, &a).await?;
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// `-z` 출력: `상태\0경로\0` (이름 변경·복사는 `R087\0옛 경로\0새 경로\0`).
fn parse_status_z(text: &str) -> Vec<ChangedFile> {
    let mut t = text.split('\0').filter(|s| !s.is_empty());
    let mut out = Vec::new();
    while let Some(code) = t.next() {
        let Some(status) = code.chars().next() else { continue };
        let Some(first) = t.next() else { break };
        if matches!(status, 'R' | 'C') {
            let Some(new) = t.next() else { break };
            out.push(ChangedFile { status, path: new.to_owned(), old_path: Some(first.to_owned()) });
        } else {
            out.push(ChangedFile { status, path: first.to_owned(), old_path: None });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_z_output_with_rename_and_korean_path() {
        let f = parse_status_z("R087\0old.rs\0new.rs\0M\0한글 경로/파일.rs\0A\0a\tb.txt\0");
        assert_eq!(f.len(), 3);
        assert_eq!((f[0].status, f[0].path.as_str(), f[0].old_path.as_deref()), ('R', "new.rs", Some("old.rs")));
        assert_eq!((f[1].status, f[1].path.as_str(), f[1].old_path.as_deref()), ('M', "한글 경로/파일.rs", None));
        assert_eq!(f[2].path, "a\tb.txt");
    }

    #[tokio::test]
    async fn 실제_저장소의_한글_경로와_옵션_모양_rev() {
        let d = std::env::temp_dir().join(format!("gc-show-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let git = GitRunner::default();
        git.output(&d, &["init", "-q"]).await.unwrap();
        std::fs::write(d.join("한글.txt"), "x\n").unwrap();
        git.output(&d, &["add", "-A"]).await.unwrap();
        git.output(&d, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c"]).await.unwrap();
        let files = changed_files(&git, &d, "HEAD").await.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "한글.txt");
        assert!(file_diff(&git, &d, "HEAD", "한글.txt", false, false).await.unwrap().contains("diff --git a/한글.txt b/한글.txt"));
        assert!(changed_files(&git, &d, "--output=x").await.is_err());
        assert!(file_diff(&git, &d, "-p", "a", false, false).await.is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
