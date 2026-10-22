//! commit-graph 보장: 없을 때 쓰고, 최신이면 건너뛰고, worktree에서도 공통 git dir에 쓰는지 실제 git으로 검증한다.

use std::fs;
use std::path::Path;
use std::process::Command;

use gc_core::*;

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git").current_dir(dir).args(["-c", "init.defaultBranch=main"]).args(args).status().unwrap().success();
    assert!(ok, "git {args:?}");
}

fn repo() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path();
    git(d, &["init", "-q"]);
    git(d, &["config", "user.name", "t"]);
    git(d, &["config", "user.email", "t@t"]);
    git(d, &["config", "gc.writeCommitGraph", "false"]);
    for i in 0..3 {
        fs::write(d.join("a.txt"), format!("{i}\n")).unwrap();
        git(d, &["add", "."]);
        git(d, &["commit", "-q", "-m", &format!("c{i}")]);
    }
    tmp
}

fn has_graph(git_dir: &Path) -> bool {
    let info = git_dir.join("objects/info");
    info.join("commit-graph").exists() || info.join("commit-graphs/commit-graph-chain").exists()
}

#[tokio::test]
async fn writes_once_then_skips_and_keeps_config() {
    let tmp = repo();
    let d = tmp.path();
    let g = GitRunner::default();
    let cfg_before = fs::read_to_string(d.join(".git/config")).unwrap();
    assert!(!has_graph(&d.join(".git")));
    assert!(ensure_commit_graph(&g, d).await.unwrap());
    assert!(has_graph(&d.join(".git")));
    assert!(!ensure_commit_graph(&g, d).await.unwrap()); // 최신이면 건너뜀
    assert_eq!(fs::read_to_string(d.join(".git/config")).unwrap(), cfg_before);
    // 만들어진 파일이 정상인지
    git(d, &["commit-graph", "verify"]);
}

#[tokio::test]
async fn worktree_writes_into_common_git_dir() {
    let tmp = repo();
    let d = tmp.path();
    let wt = tempfile::tempdir().unwrap();
    let wpath = wt.path().join("w");
    git(d, &["worktree", "add", "-q", "-b", "side", wpath.to_str().unwrap()]);
    assert!(ensure_commit_graph(&GitRunner::default(), &wpath).await.unwrap());
    assert!(has_graph(&d.join(".git")));
}

#[tokio::test]
async fn does_not_block_index_lock_users() {
    // 쓰는 동안 index.lock이 이미 있어도(다른 git 작업 중) 실패하지 않는다.
    let tmp = repo();
    let d = tmp.path();
    fs::write(d.join(".git/index.lock"), "").unwrap();
    assert!(ensure_commit_graph(&GitRunner::default(), d).await.unwrap());
}
