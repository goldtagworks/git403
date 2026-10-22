//! interactive rebase를 편집기 없이 실행한다.
//! 우리가 만든 todo 목록을 GIT_SEQUENCE_EDITOR로 그대로 넣고, reword는 `exec git commit --amend`로 처리한다.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::runner::reject_option;
use crate::{GitRunner, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStep {
    /// pick | reword | squash | fixup | drop
    pub action: String,
    pub sha: String,
    /// reword일 때 새 메시지
    pub message: Option<String>,
}

/// 임시 todo·메시지 파일 폴더 이름 접두사 (`.git/gc-rebase-*`).
const DIR_PREFIX: &str = "gc-rebase-";

/// `base` 다음 커밋부터 HEAD까지를 `steps` 순서(오래된 것 먼저)대로 다시 쌓는다.
///
/// reword의 `exec` 줄은 메시지 파일을 읽으므로, 충돌로 멈췄다 `--continue`할 때도 남아 있어야 한다.
/// 그래서 파일은 `.git/gc-rebase-*`에 두고, rebase가 끝났거나 시작도 못 했으면 바로 지운다.
/// 충돌로 멈춘 채 남은 폴더는 rebase가 끝난 뒤 다음 interactive rebase를 시작할 때 지운다.
pub async fn rebase_interactive(git: &GitRunner, repo: &Path, base: &str, steps: &[RebaseStep]) -> Result<()> {
    let base = reject_option(base)?;
    let gitdir = PathBuf::from(String::from_utf8_lossy(&git.output(repo, &["rev-parse", "--absolute-git-dir"]).await?).trim());
    if !in_progress(&gitdir) {
        remove_stale(&gitdir);
    }
    let dir = gitdir.join(format!("{DIR_PREFIX}{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()));
    std::fs::create_dir_all(&dir)?;
    let result = run(git, repo, base, steps, &dir).await;
    if result.is_ok() || !in_progress(&gitdir) {
        let _ = std::fs::remove_dir_all(&dir);
    }
    result
}

async fn run(git: &GitRunner, repo: &Path, base: &str, steps: &[RebaseStep], dir: &Path) -> Result<()> {
    let amend = format!("{} commit --amend --only --allow-empty -F", shell_quote(&git.git_path().to_string_lossy()));
    let mut todo = String::new();
    for (i, s) in steps.iter().enumerate() {
        let sha = reject_option(&s.sha)?;
        match s.action.as_str() {
            "pick" | "squash" | "fixup" | "drop" => todo += &format!("{} {sha}\n", s.action),
            "reword" => {
                let msg = dir.join(format!("msg{i}"));
                std::fs::write(&msg, s.message.as_deref().unwrap_or_default())?;
                todo += &format!("pick {sha}\nexec {amend} {}\n", shell_quote(&msg.to_string_lossy()));
            }
            other => return Err(gc_i18n::coded!("rebase.unknownAction", "unknown rebase action: {action}", action = other).into()),
        }
    }
    let todo_path = dir.join("todo");
    std::fs::write(&todo_path, todo)?;
    let editor = format!("cp {}", shell_quote(&todo_path.to_string_lossy()));
    // squash 메시지 편집기는 기본 합친 메시지를 그대로 쓴다 (러너가 GIT_EDITOR=true).
    git.output_env(repo, &["rebase", "-i", "--autostash", base], &[("GIT_SEQUENCE_EDITOR", &editor)]).await.map(drop)
}

fn in_progress(gitdir: &Path) -> bool {
    gitdir.join("rebase-merge").exists() || gitdir.join("rebase-apply").exists()
}

fn remove_stale(gitdir: &Path) {
    let Ok(entries) = std::fs::read_dir(gitdir) else { return };
    for e in entries.flatten() {
        if e.file_name().to_string_lossy().starts_with(DIR_PREFIX) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}
