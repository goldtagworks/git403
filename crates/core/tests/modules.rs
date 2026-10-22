//! 서브모듈 · worktree · LFS를 실제 git으로 검증한다.

use std::fs;
use std::path::Path;

use gc_core::*;

fn git(dir: &Path, args: &[&str]) {
    let ok = std::process::Command::new("git")
        .current_dir(dir)
        .args(["-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always"])
        .args(["-c", "user.name=t", "-c", "user.email=t@t"])
        .args(args)
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?}");
}

fn repo(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-q"]);
    fs::write(dir.join("f.txt"), "x\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", "init"]);
}

#[tokio::test]
async fn submodules_empty_without_gitmodules() {
    let tmp = tempfile::tempdir().unwrap();
    repo(tmp.path());
    assert!(read_submodules(&GitRunner::default(), tmp.path()).await.unwrap().is_empty());
}

#[tokio::test]
async fn submodules_status_and_url() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    repo(&root.join("lib"));
    repo(&root.join("main"));
    let main = root.join("main");
    git(&main, &["submodule", "add", "-q", root.join("lib").to_str().unwrap(), "vendor/lib"]);
    git(&main, &["commit", "-q", "-m", "sub"]);

    let g = GitRunner::default();
    let subs = read_submodules(&g, &main).await.unwrap();
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0].path, "vendor/lib");
    assert_eq!(subs[0].status, SubmoduleStatus::Ok);
    assert!(subs[0].url.as_deref().unwrap().replace('\\', "/").ends_with("/lib"));

    // 서브모듈에 새 커밋 → '+'
    git(&main.join("vendor/lib"), &["commit", "-q", "--allow-empty", "-m", "more"]);
    assert_eq!(read_submodules(&g, &main).await.unwrap()[0].status, SubmoduleStatus::Modified);

    // 클론하면 미초기화 '-'
    git(root, &["clone", "-q", main.to_str().unwrap(), "copy"]);
    assert_eq!(read_submodules(&g, &root.join("copy")).await.unwrap()[0].status, SubmoduleStatus::Uninitialized);
}

#[tokio::test]
async fn worktrees_list() {
    let tmp = tempfile::tempdir().unwrap();
    let main = tmp.path().join("main");
    repo(&main);
    let wt = tmp.path().join("wt");
    git(&main, &["worktree", "add", "-q", "-b", "feat", wt.to_str().unwrap()]);
    git(&main, &["worktree", "lock", wt.to_str().unwrap()]);

    let list = read_worktrees(&GitRunner::default(), &main).await.unwrap();
    assert_eq!(list.len(), 2);
    assert!(list[0].main && list[0].branch.as_deref() == Some("main"));
    assert_eq!(list[1].branch.as_deref(), Some("feat"));
    assert!(list[1].locked && !list[1].main && !list[1].detached);
    assert_eq!(list[1].head.len(), 40);
}

#[tokio::test]
async fn lfs_status_tracks_and_lists() {
    let g = GitRunner::default();
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path();
    repo(d);
    let st = lfs_status(&g, d).await.unwrap();
    let installed = std::process::Command::new("git").args(["lfs", "version"]).output().is_ok_and(|o| o.status.success());
    assert_eq!(st.installed, installed);
    if !installed {
        assert!(st.tracked.is_empty() && st.files.is_empty());
        return; // LFS 미설치 환경에서는 여기까지만
    }
    assert!(st.tracked.is_empty());

    // 훅·전역 설정을 건드리지 않도록 `--local`로만 설치
    git(d, &["lfs", "install", "--local", "--skip-repo"]);
    git(d, &["lfs", "track", "*.bin"]);
    fs::write(d.join("a.bin"), "payload\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-q", "-m", "lfs"]);
    let st = lfs_status(&g, d).await.unwrap();
    assert_eq!(st.tracked, vec!["*.bin"]);
    assert_eq!(st.files.len(), 1);
    assert_eq!(st.files[0].path, "a.bin");
    assert!(st.files[0].downloaded);
    assert_eq!(st.files[0].oid.len(), 64);
}
