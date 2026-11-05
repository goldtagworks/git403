//! AI 채팅 작업 전 백업과 되돌리기: HEAD(`refs/git403/ai-backup/<id>`), 로컬 브랜치 전체(`refs/git403/ai-backup-heads/<id>/<브랜치>`),
//! 작업 트리가 더러우면 그 스냅숏 커밋(`refs/git403/ai-backup-wip/<id>`, 추적 파일 + untracked, .gitignore 제외). 파괴적 명령(`reset --hard`·`clean`)은 쓰지 않는다.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{status::read_status, GitRunner, Result};

const PREFIX: &str = "refs/git403/ai-backup/";
const HEADS: &str = "refs/git403/ai-backup-heads/";
const WIP: &str = "refs/git403/ai-backup-wip/";

/// 백업 하나. `branch`가 None이면 백업 때 HEAD가 분리(detached)돼 있었다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub id: String,
    #[serde(rename = "ref")]
    pub ref_name: String,
    pub sha: String,
    pub branch: Option<String>,
    /// 백업한 로컬 브랜치 수(이력의 예전 항목은 0)
    #[serde(default)]
    pub heads: usize,
    /// 작업 트리 스냅숏 커밋(작업 트리가 깨끗했으면 None)
    #[serde(default)]
    pub wip: Option<String>,
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
    // 로컬 브랜치 전체: AI가 다른 브랜치를 옮기거나 지워도 되돌릴 수 있게(실패해도 HEAD 백업은 유효)
    let heads = snapshot_heads(git, repo, id).await.unwrap_or(0);
    let wip = snapshot_wip(git, repo, id).await.ok().flatten();
    Ok(Some(Backup { id: id.to_owned(), ref_name, sha, branch, heads, wip }))
}

async fn snapshot_heads(git: &GitRunner, repo: &Path, id: &str) -> Result<usize> {
    let out = git.output(repo, &["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"]).await?;
    let mut cmds = String::new();
    let mut n = 0;
    for l in String::from_utf8_lossy(&out).lines() {
        if let Some((sha, name)) = l.split_once(' ').and_then(|(s, r)| Some((s, r.strip_prefix("refs/heads/")?))) {
            cmds += &format!("create {HEADS}{id}/{name} {sha}\n");
            n += 1;
        }
    }
    if n > 0 {
        git.output_stdin(repo, &["update-ref", "--stdin"], cmds.as_bytes()).await?;
    }
    Ok(n)
}

/// 작업 트리가 더러우면(추적 변경·untracked) 임시 인덱스로 `add -A` → `write-tree` → `commit-tree`해 `refs/git403/ai-backup-wip/<id>`에 보존한다.
/// 진짜 인덱스·작업 트리는 건드리지 않는다. 깨끗하면 None.
async fn snapshot_wip(git: &GitRunner, repo: &Path, id: &str) -> Result<Option<String>> {
    let dirty = git.query(repo, &["status", "--porcelain", "--untracked-files=all"]).await?;
    if dirty.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }
    let gitdir = String::from_utf8_lossy(&git.output(repo, &["rev-parse", "--absolute-git-dir"]).await?).trim().to_owned();
    let idx = format!("{gitdir}/git403-wip-{id}.idx");
    let env = [("GIT_INDEX_FILE", idx.as_str())];
    let res = async {
        git.output_env(repo, &["read-tree", "HEAD"], &env).await?;
        git.output_env(repo, &["add", "-A"], &env).await?;
        let tree = String::from_utf8_lossy(&git.output_env(repo, &["write-tree"], &env).await?).trim().to_owned();
        let commit = git.output(repo, &["-c", "user.name=git403", "-c", "user.email=git403@localhost", "commit-tree", &tree, "-p", "HEAD", "-m", "git403: working tree snapshot before AI chat"]).await?;
        let commit = String::from_utf8_lossy(&commit).trim().to_owned();
        git.output(repo, &["update-ref", &format!("{WIP}{id}"), &commit]).await?;
        Ok::<_, crate::Error>(commit)
    }
    .await;
    let _ = std::fs::remove_file(&idx);
    res.map(Some)
}

/// 백업 ref 전부(HEAD·브랜치들·스냅숏)를 지운다 (없으면 무시).
pub async fn delete(git: &GitRunner, repo: &Path, id: &str) -> Result<()> {
    check_id(id)?;
    let mut cmds = format!("delete {PREFIX}{id}\ndelete {WIP}{id}\n");
    let listed = git.output(repo, &["for-each-ref", "--format=%(refname)", &format!("{HEADS}{id}/")]).await.unwrap_or_default();
    for r in String::from_utf8_lossy(&listed).lines() {
        cmds += &format!("delete {r}\n");
    }
    git.output_stdin(repo, &["update-ref", "--stdin"], cmds.as_bytes()).await.map(drop)
}

/// 저장소를 백업한 HEAD로 되돌린다. 안전 규칙:
/// - 진행 중인 rebase·merge·cherry-pick·revert·am이 있으면 `abort_ongoing`이 아닌 한 거절한다(`aiBackup.operationInProgress`).
///   `abort_ongoing`이면 그 작업을 `--abort`한 뒤 진행한다.
/// - 백업 때 브랜치였으면 그 브랜치로 `switch`(없으면 백업 커밋에서 다시 만든다), 분리였으면 `switch --detach`. `switch`는 덮어쓸 변경이 있으면 git이 거절한다.
/// - 그다음 `reset --keep <sha>`: 커밋하지 않은 변경은 유지하고, 되돌릴 파일과 겹치면 git이 거절한다(작업 내용을 잃지 않는다).
///   untracked 파일은 건드리지 않는다.
pub async fn restore(git: &GitRunner, repo: &Path, id: &str, branch: Option<&str>, abort_ongoing: bool, branches: bool, wip: bool) -> Result<()> {
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
    git.output(repo, &["reset", "--keep", &sha]).await?;
    // 사용자가 더 되돌리기를 골랐을 때만:
    if branches {
        restore_heads(git, repo, id).await?;
    }
    if wip {
        let r = git.output_allow(repo, &["rev-parse", "--verify", "-q", &format!("{WIP}{id}^{{commit}}")], &[1]).await?;
        let snap = String::from_utf8_lossy(&r).trim().to_owned();
        if !snap.is_empty() {
            // 스냅숏의 파일 내용을 작업 트리에 되돌린다(그 사이 바뀐 파일은 스냅숏 내용으로 덮어쓴다. 스냅숏에 없는 새 파일은 지우지 않는다. 인덱스는 건드리지 않는다)
            git.output(repo, &["restore", &format!("--source={snap}"), "--worktree", "--", "."]).await?;
        }
    }
    Ok(())
}

/// 백업 때의 로컬 브랜치 위치로 되돌린다: 옮겨진 브랜치는 원래 커밋으로, 지워진 브랜치는 다시 만든다. AI가 새로 만든 브랜치는 지우지 않는다.
/// 지금 체크아웃된 브랜치(HEAD 복원이 처리)와 다른 worktree에서 체크아웃 중인 브랜치는 건드리지 않는다.
async fn restore_heads(git: &GitRunner, repo: &Path, id: &str) -> Result<()> {
    let cur = String::from_utf8_lossy(&git.output_allow(repo, &["symbolic-ref", "-q", "--short", "HEAD"], &[1]).await?).trim().to_owned();
    let wt = git.output(repo, &["worktree", "list", "--porcelain"]).await.unwrap_or_default();
    let busy: Vec<String> = String::from_utf8_lossy(&wt).lines().filter_map(|l| l.strip_prefix("branch refs/heads/").map(str::to_owned)).collect();
    let prefix = format!("{HEADS}{id}/");
    let listed = git.output(repo, &["for-each-ref", "--format=%(objectname) %(refname)", &prefix]).await?;
    for l in String::from_utf8_lossy(&listed).lines() {
        let Some((sha, name)) = l.split_once(' ').and_then(|(s, r)| Some((s, r.strip_prefix(prefix.as_str())?))) else { continue };
        if name == cur || busy.iter().any(|b| b == name) {
            continue;
        }
        git.output(repo, &["update-ref", &format!("refs/heads/{name}"), sha]).await?;
    }
    Ok(())
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
        restore(&git, &p, "r1", b.branch.as_deref(), false, false, false).await.unwrap();
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
        assert!(restore(&git, &p, "r2", b.branch.as_deref(), false, false, false).await.is_err());
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
        restore(&git, &p, "r3", b.branch.as_deref(), false, false, false).await.unwrap();
        assert_eq!((sh(&p, &["symbolic-ref", "--short", "HEAD"]), sh(&p, &["rev-parse", "HEAD"])), ("main".into(), b.sha.clone()));
        assert_eq!(sh(&p, &["rev-parse", "--verify", "ai-work"]).len(), 40, "다른 브랜치는 지우지 않는다");
        // 원래 브랜치가 지워졌으면 백업 커밋에서 다시 만든다
        sh(&p, &["switch", "-q", "ai-work"]);
        sh(&p, &["branch", "-D", "main"]);
        restore(&git, &p, "r3", Some("main"), false, false, false).await.unwrap();
        assert_eq!((sh(&p, &["symbolic-ref", "--short", "HEAD"]), sh(&p, &["rev-parse", "main"])), ("main".into(), b.sha));
    }

    #[tokio::test]
    async fn restore_detached_backup_detaches() {
        let git = GitRunner::default();
        let (_d, p) = repo();
        sh(&p, &["checkout", "-q", "--detach", "HEAD~1"]);
        let b = create(&git, &p, "r4").await.unwrap().unwrap();
        sh(&p, &["switch", "-q", "main"]);
        restore(&git, &p, "r4", b.branch.as_deref(), false, false, false).await.unwrap();
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
        let err = restore(&git, &p, "r5", b.branch.as_deref(), false, false, false).await.unwrap_err();
        assert_eq!(err.coded().unwrap().code, "aiBackup.operationInProgress");
        assert!(p.join(".git/MERGE_HEAD").exists(), "거절되면 merge 상태 유지");
        restore(&git, &p, "r5", b.branch.as_deref(), true, false, false).await.unwrap();
        assert!(!p.join(".git/MERGE_HEAD").exists());
        assert_eq!(sh(&p, &["rev-parse", "HEAD"]), b.sha);
        assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "1\n");
        assert!(sh(&p, &["status", "--porcelain"]).is_empty());
        assert_eq!(restore(&git, &p, "nope", None, false, false, false).await.unwrap_err().coded().unwrap().code, "aiBackup.missing");
    }

    #[tokio::test]
    async fn backup_snapshots_all_local_branches_and_restore_puts_them_back_only_when_asked() {
        let git = GitRunner::default();
        let (_d, p) = repo();
        sh(&p, &["branch", "dev"]);
        sh(&p, &["branch", "old"]);
        let (dev0, old0) = (sh(&p, &["rev-parse", "dev"]), sh(&p, &["rev-parse", "old"]));
        let b = create(&git, &p, "h1").await.unwrap().unwrap();
        assert_eq!((b.heads, b.wip.as_deref()), (3, None), "main·dev·old, 깨끗한 작업 트리는 스냅숏 없음");
        // AI가 dev를 옮기고 old를 지우고 새 브랜치를 만든다
        sh(&p, &["switch", "-q", "dev"]);
        std::fs::write(p.join("d.txt"), "d\n").unwrap();
        sh(&p, &["add", "."]);
        sh(&p, &["commit", "-qm", "on dev"]);
        sh(&p, &["switch", "-q", "main"]);
        sh(&p, &["branch", "-D", "old"]);
        sh(&p, &["branch", "ai-new"]);
        std::fs::write(p.join("a.txt"), "2\n").unwrap();
        sh(&p, &["commit", "-qam", "ai on main"]);
        // 브랜치 되돌리기를 고르지 않으면 HEAD만
        restore(&git, &p, "h1", b.branch.as_deref(), false, false, false).await.unwrap();
        assert_eq!(sh(&p, &["rev-parse", "HEAD"]), b.sha);
        assert_ne!(sh(&p, &["rev-parse", "dev"]), dev0);
        assert!(sh(&p, &["branch", "--list", "old"]).is_empty());
        // 고르면: dev는 원래 커밋으로, old는 다시 생기고, 새 브랜치는 그대로
        restore(&git, &p, "h1", b.branch.as_deref(), false, true, false).await.unwrap();
        assert_eq!((sh(&p, &["rev-parse", "dev"]), sh(&p, &["rev-parse", "old"])), (dev0.clone(), old0));
        assert!(!sh(&p, &["branch", "--list", "ai-new"]).is_empty(), "AI가 만든 브랜치는 지우지 않는다");
        // 다른 worktree에서 체크아웃 중인 브랜치는 건드리지 않는다
        sh(&p, &["switch", "-q", "dev"]);
        std::fs::write(p.join("d.txt"), "d2\n").unwrap();
        sh(&p, &["add", "."]);
        sh(&p, &["commit", "-qm", "again"]);
        sh(&p, &["switch", "-q", "main"]);
        let wt = tempfile::tempdir().unwrap();
        sh(&p, &["worktree", "add", "-q", &wt.path().join("w").to_string_lossy(), "dev"]);
        let dev1 = sh(&p, &["rev-parse", "dev"]);
        restore(&git, &p, "h1", b.branch.as_deref(), false, true, false).await.unwrap();
        assert_eq!(sh(&p, &["rev-parse", "dev"]), dev1, "worktree에서 쓰는 브랜치는 건너뜀");
        // delete는 세 이름공간을 모두 지운다
        delete(&git, &p, "h1").await.unwrap();
        assert!(sh(&p, &["for-each-ref", "refs/git403"]).is_empty());
    }

    #[tokio::test]
    async fn dirty_working_tree_is_snapshotted_without_touching_it_and_restored_on_request() {
        let git = GitRunner::default();
        let (_d, p) = repo();
        std::fs::write(p.join("a.txt"), "dirty tracked\n").unwrap();
        std::fs::write(p.join("new.txt"), "untracked\n").unwrap();
        std::fs::write(p.join(".gitignore"), "ignored.log\n").unwrap();
        std::fs::write(p.join("ignored.log"), "ignored\n").unwrap();
        sh(&p, &["add", ".gitignore"]);
        let before = (sh(&p, &["status", "--porcelain"]), sh(&p, &["diff", "--cached", "--name-only"]));
        let b = create(&git, &p, "w1").await.unwrap().unwrap();
        let snap = b.wip.clone().expect("더러우면 스냅숏");
        assert_eq!(sh(&p, &["rev-parse", "refs/git403/ai-backup-wip/w1"]), snap);
        assert_eq!((sh(&p, &["status", "--porcelain"]), sh(&p, &["diff", "--cached", "--name-only"])), before, "진짜 작업 트리·인덱스는 그대로");
        assert!(!p.join(".git/git403-wip-w1.idx").exists(), "임시 인덱스는 지운다");
        let files = sh(&p, &["ls-tree", "-r", "--name-only", &snap]);
        assert!(files.contains("new.txt") && files.contains("a.txt") && !files.contains("ignored.log"), "{files}");
        assert_eq!(sh(&p, &["show", &format!("{snap}:a.txt")]), "dirty tracked");
        // AI가 파일을 바꾸고 지운다 → HEAD만 되돌리면 그대로, wip을 고르면 내용 복원
        std::fs::write(p.join("a.txt"), "ai changed\n").unwrap();
        std::fs::remove_file(p.join("new.txt")).unwrap();
        sh(&p, &["stash", "-q"]);
        restore(&git, &p, "w1", b.branch.as_deref(), false, false, false).await.unwrap();
        assert!(!p.join("new.txt").exists());
        restore(&git, &p, "w1", b.branch.as_deref(), false, false, true).await.unwrap();
        assert_eq!((std::fs::read_to_string(p.join("a.txt")).unwrap(), std::fs::read_to_string(p.join("new.txt")).unwrap()), ("dirty tracked\n".into(), "untracked\n".into()));
        assert!(std::fs::read_to_string(p.join("ignored.log")).unwrap() == "ignored\n");
        delete(&git, &p, "w1").await.unwrap();
        assert!(sh(&p, &["for-each-ref", "refs/git403"]).is_empty());
    }
}
