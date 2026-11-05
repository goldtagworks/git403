//! AI 채팅 작업 전 HEAD 백업(`refs/git403/ai-backup/<id>`)과 되돌리기. 파괴적 명령(`reset --hard`·`clean`)은 쓰지 않는다.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{status::read_status, GitRunner, Result};

const PREFIX: &str = "refs/git403/ai-backup/";

/// 백업 하나. `branch`가 None이면 백업 때 HEAD가 분리(detached)돼 있었다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub id: String,
    #[serde(rename = "ref")]
    pub ref_name: String,
    pub sha: String,
    pub branch: Option<String>,
}

fn check_id(id: &str) -> Result<()> {
    let ok = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then_some(()).ok_or_else(|| gc_i18n::coded!("aiBackup.badId", "invalid backup id").into())
}

/// HEAD를 `refs/git403/ai-backup/<id>`에 저장한다. 커밋이 아직 없는 저장소(unborn HEAD)는 `None`.
pub async fn create(git: &GitRunner, repo: &Path, id: &str) -> Result<Option<Backup>> {
    check_id(id)?;
    let out = git.output_allow(repo, &["rev-parse", "--verify", "-q", "HEAD"], &[1]).await?;
    let sha = String::from_utf8_lossy(&out).trim().to_owned();
    if sha.is_empty() {
        return Ok(None);
    }
    let branch = git.output_allow(repo, &["symbolic-ref", "-q", "--short", "HEAD"], &[1]).await?;
    let branch = Some(String::from_utf8_lossy(&branch).trim().to_owned()).filter(|b| !b.is_empty());
    let ref_name = format!("{PREFIX}{id}");
    git.output(repo, &["update-ref", &ref_name, &sha]).await?;
    Ok(Some(Backup { id: id.to_owned(), ref_name, sha, branch }))
}

/// 백업 ref를 지운다 (없으면 무시).
pub async fn delete(git: &GitRunner, repo: &Path, id: &str) -> Result<()> {
    check_id(id)?;
    git.output(repo, &["update-ref", "-d", &format!("{PREFIX}{id}")]).await.map(drop)
}

/// 저장소를 백업한 HEAD로 되돌린다. 안전 규칙:
/// - 진행 중인 rebase·merge·cherry-pick·revert·am이 있으면 `abort_ongoing`이 아닌 한 거절한다(`aiBackup.operationInProgress`).
///   `abort_ongoing`이면 그 작업을 `--abort`한 뒤 진행한다.
/// - 백업 때 브랜치였으면 그 브랜치로 `switch`(없으면 백업 커밋에서 다시 만든다), 분리였으면 `switch --detach`. `switch`는 덮어쓸 변경이 있으면 git이 거절한다.
/// - 그다음 `reset --keep <sha>`: 커밋하지 않은 변경은 유지하고, 되돌릴 파일과 겹치면 git이 거절한다(작업 내용을 잃지 않는다).
///   untracked 파일은 건드리지 않는다.
pub async fn restore(git: &GitRunner, repo: &Path, id: &str, branch: Option<&str>, abort_ongoing: bool) -> Result<()> {
    check_id(id)?;
    let ref_name = format!("{PREFIX}{id}");
    let out = git.output_allow(repo, &["rev-parse", "--verify", "-q", &format!("{ref_name}^{{commit}}")], &[1]).await?;
    let sha = String::from_utf8_lossy(&out).trim().to_owned();
    if sha.is_empty() {
        return Err(gc_i18n::coded!("aiBackup.missing", "the backup no longer exists").into());
    }
    if let Some(op) = read_status(git, repo).await?.operation {
        if !abort_ongoing {
            return Err(gc_i18n::coded!("aiBackup.operationInProgress", "a {op} is in progress; abort it first", op = op).into());
        }
        git.output(repo, &[op.as_str(), "--abort"]).await?;
    }
    match branch {
        Some(b) => {
            let full = format!("refs/heads/{b}");
            let exists = !git.output_allow(repo, &["rev-parse", "--verify", "-q", &full], &[1]).await?.is_empty();
            if exists {
                git.output(repo, &["switch", b]).await?;
            } else {
                git.output(repo, &["switch", "-c", b, &sha]).await?;
            }
        }
        None => {
            git.output(repo, &["switch", "--detach", &sha]).await?;
        }
    }
    git.output(repo, &["reset", "--keep", &sha]).await.map(drop)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn sh(repo: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git").current_dir(repo).args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    /// main에 커밋 a(a.txt=1)·b(b.txt=1) 두 개
    fn repo() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().canonicalize().unwrap();
        sh(&p, &["init", "-q", "-b", "main"]);
        std::fs::write(p.join("a.txt"), "1\n").unwrap();
        sh(&p, &["add", "."]);
        sh(&p, &["commit", "-qm", "a"]);
        std::fs::write(p.join("b.txt"), "1\n").unwrap();
        sh(&p, &["add", "."]);
        sh(&p, &["commit", "-qm", "b"]);
        (d, p)
    }

    #[tokio::test]
    async fn create_saves_head_in_ref_and_skips_unborn_and_bad_ids() {
        let git = GitRunner::default();
        let (_d, p) = repo();
        let b = create(&git, &p, "x1").await.unwrap().unwrap();
        assert_eq!((b.ref_name.as_str(), b.branch.as_deref()), ("refs/git403/ai-backup/x1", Some("main")));
        assert_eq!(sh(&p, &["rev-parse", "refs/git403/ai-backup/x1"]), sh(&p, &["rev-parse", "HEAD"]));
        assert_eq!(b.sha, sh(&p, &["rev-parse", "HEAD"]));
        sh(&p, &["checkout", "-q", "--detach"]);
        assert_eq!(create(&git, &p, "x2").await.unwrap().unwrap().branch, None);
        delete(&git, &p, "x1").await.unwrap();
        assert!(sh(&p, &["for-each-ref", "refs/git403/ai-backup/x1"]).is_empty());
        for bad in ["", "a/b", "../x", "a b"] {
            assert!(check_id(bad).is_err(), "{bad}");
        }
        let empty = tempfile::tempdir().unwrap();
        sh(empty.path(), &["init", "-q"]);
        assert!(create(&git, empty.path(), "x").await.unwrap().is_none(), "커밋 없는 저장소는 백업 없음");
    }

    #[tokio::test]
    async fn restore_moves_branch_back_and_keeps_uncommitted_and_untracked_work() {
        let git = GitRunner::default();
        let (_d, p) = repo();
        let b = create(&git, &p, "r1").await.unwrap().unwrap();
        // AI가 커밋 두 개를 더 만들고, 그 사이 사용자는 다른 파일을 고치고 새 파일을 둠
        std::fs::write(p.join("a.txt"), "2\n").unwrap();
        sh(&p, &["commit", "-qam", "ai1"]);
        std::fs::write(p.join("c.txt"), "new\n").unwrap();
        sh(&p, &["add", "."]);
        sh(&p, &["commit", "-qm", "ai2"]);
        std::fs::write(p.join("b.txt"), "local edit\n").unwrap();
        std::fs::write(p.join("untracked.txt"), "u\n").unwrap();
        restore(&git, &p, "r1", b.branch.as_deref(), false).await.unwrap();
        assert_eq!(sh(&p, &["rev-parse", "HEAD"]), b.sha);
        assert_eq!(sh(&p, &["symbolic-ref", "--short", "HEAD"]), "main");
        assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "1\n", "AI가 바꾼 파일은 되돌아간다");
        assert!(!p.join("c.txt").exists());
        assert_eq!(std::fs::read_to_string(p.join("b.txt")).unwrap(), "local edit\n", "커밋 안 한 변경 유지");
        assert!(p.join("untracked.txt").exists(), "untracked 유지");
    }

    #[tokio::test]
    async fn restore_refuses_when_local_edit_overlaps_and_changes_nothing() {
        let git = GitRunner::default();
        let (_d, p) = repo();
        let b = create(&git, &p, "r2").await.unwrap().unwrap();
        std::fs::write(p.join("a.txt"), "2\n").unwrap();
        sh(&p, &["commit", "-qam", "ai"]);
        std::fs::write(p.join("a.txt"), "mine\n").unwrap();
        let head = sh(&p, &["rev-parse", "HEAD"]);
        assert!(restore(&git, &p, "r2", b.branch.as_deref(), false).await.is_err());
        assert_eq!((sh(&p, &["rev-parse", "HEAD"]), std::fs::read_to_string(p.join("a.txt")).unwrap()), (head, "mine\n".into()), "거절되면 HEAD·파일 그대로");
    }

    #[tokio::test]
    async fn restore_switches_back_to_original_branch_or_recreates_it() {
        let git = GitRunner::default();
        let (_d, p) = repo();
        let b = create(&git, &p, "r3").await.unwrap().unwrap();
        sh(&p, &["switch", "-q", "-c", "ai-work"]);
        std::fs::write(p.join("x.txt"), "x\n").unwrap();
        sh(&p, &["add", "."]);
        sh(&p, &["commit", "-qm", "on ai-work"]);
        restore(&git, &p, "r3", b.branch.as_deref(), false).await.unwrap();
        assert_eq!((sh(&p, &["symbolic-ref", "--short", "HEAD"]), sh(&p, &["rev-parse", "HEAD"])), ("main".into(), b.sha.clone()));
        assert_eq!(sh(&p, &["rev-parse", "--verify", "ai-work"]).len(), 40, "다른 브랜치는 지우지 않는다");
        // 원래 브랜치가 지워졌으면 백업 커밋에서 다시 만든다
        sh(&p, &["switch", "-q", "ai-work"]);
        sh(&p, &["branch", "-D", "main"]);
        restore(&git, &p, "r3", Some("main"), false).await.unwrap();
        assert_eq!((sh(&p, &["symbolic-ref", "--short", "HEAD"]), sh(&p, &["rev-parse", "main"])), ("main".into(), b.sha));
    }

    #[tokio::test]
    async fn restore_detached_backup_detaches() {
        let git = GitRunner::default();
        let (_d, p) = repo();
        sh(&p, &["checkout", "-q", "--detach", "HEAD~1"]);
        let b = create(&git, &p, "r4").await.unwrap().unwrap();
        sh(&p, &["switch", "-q", "main"]);
        restore(&git, &p, "r4", b.branch.as_deref(), false).await.unwrap();
        assert_eq!(sh(&p, &["rev-parse", "HEAD"]), b.sha);
        assert!(std::process::Command::new("git").current_dir(&p).args(["symbolic-ref", "-q", "HEAD"]).output().unwrap().stdout.is_empty(), "분리 상태");
        assert_eq!(sh(&p, &["rev-parse", "main"]).len(), 40, "main 브랜치는 그대로(이동 없음)");
        assert_ne!(sh(&p, &["rev-parse", "main"]), b.sha);
    }

    #[tokio::test]
    async fn restore_during_merge_requires_abort_flag_then_aborts_and_resets() {
        let git = GitRunner::default();
        let (_d, p) = repo();
        let b = create(&git, &p, "r5").await.unwrap().unwrap();
        sh(&p, &["switch", "-q", "-c", "other"]);
        std::fs::write(p.join("a.txt"), "other\n").unwrap();
        sh(&p, &["commit", "-qam", "other"]);
        sh(&p, &["switch", "-q", "main"]);
        std::fs::write(p.join("a.txt"), "main\n").unwrap();
        sh(&p, &["commit", "-qam", "main side"]);
        // 충돌로 멈춘 merge
        let m = std::process::Command::new("git").current_dir(&p).args(["merge", "other"]).output().unwrap();
        assert!(!m.status.success() && p.join(".git/MERGE_HEAD").exists());
        let err = restore(&git, &p, "r5", b.branch.as_deref(), false).await.unwrap_err();
        assert_eq!(err.coded().unwrap().code, "aiBackup.operationInProgress");
        assert!(p.join(".git/MERGE_HEAD").exists(), "거절되면 merge 상태 유지");
        restore(&git, &p, "r5", b.branch.as_deref(), true).await.unwrap();
        assert!(!p.join(".git/MERGE_HEAD").exists());
        assert_eq!(sh(&p, &["rev-parse", "HEAD"]), b.sha);
        assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "1\n");
        assert!(sh(&p, &["status", "--porcelain"]).is_empty());
        assert_eq!(restore(&git, &p, "nope", None, false).await.unwrap_err().coded().unwrap().code, "aiBackup.missing");
    }
}
