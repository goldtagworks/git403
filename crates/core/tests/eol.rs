//! 줄바꿈 처리를 실제 임시 저장소(CRLF 파일)로 검증한다.

use std::fs;
use std::path::Path;

use gc_core::*;

fn git(dir: &Path, args: &[&str]) {
    let ok = std::process::Command::new("git").current_dir(dir).args(args).status().unwrap().success();
    assert!(ok, "git {args:?}");
}

fn repo() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path();
    git(d, &["init", "-q", "-b", "main"]);
    git(d, &["config", "user.name", "t"]);
    git(d, &["config", "user.email", "t@t"]);
    git(d, &["config", "core.autocrlf", "false"]);
    tmp
}

fn index_blob(d: &Path, p: &str) -> Vec<u8> {
    std::process::Command::new("git").current_dir(d).args(["show", &format!(":{p}")]).output().unwrap().stdout
}

#[tokio::test]
async fn detects_and_fixes_staged_crlf() {
    let tmp = repo();
    let d = tmp.path();
    let g = GitRunner::default();
    fs::write(d.join("a.txt"), "one\r\ntwo\r\n").unwrap();
    fs::write(d.join("lf.txt"), "one\ntwo\n").unwrap();
    fs::write(d.join("bin.dat"), b"\0\r\n\0\r\n").unwrap();
    fs::write(d.join("win.bat"), "echo\r\n").unwrap();
    fs::write(d.join(".gitattributes"), "*.bat text eol=crlf\n").unwrap();
    git(d, &["add", "-A"]);

    assert_eq!(staged_crlf(&g, d).await.unwrap(), ["a.txt"]);
    fix_crlf(&g, d, &["a.txt".into()]).await.unwrap();
    assert_eq!(index_blob(d, "a.txt"), b"one\ntwo\n");
    assert_eq!(fs::read(d.join("a.txt")).unwrap(), b"one\ntwo\n", "인덱스와 같던 작업 파일도 LF");
    assert!(staged_crlf(&g, d).await.unwrap().is_empty());
    // 스테이지 후 작업 파일과 인덱스가 같아 변경 목록에 남지 않는다
    assert!(worktree_diff(&g, d, "a.txt", false, false, false, false).await.unwrap().is_empty());
}

#[tokio::test]
async fn partial_stage_keeps_worktree_edit() {
    let tmp = repo();
    let d = tmp.path();
    let g = GitRunner::default();
    fs::write(d.join("a.txt"), "one\r\n").unwrap();
    git(d, &["add", "a.txt"]);
    fs::write(d.join("a.txt"), "one\r\nmore\r\n").unwrap(); // 스테이지 안 한 수정
    fix_crlf(&g, d, &["a.txt".into()]).await.unwrap();
    assert_eq!(index_blob(d, "a.txt"), b"one\n");
    assert_eq!(fs::read(d.join("a.txt")).unwrap(), b"one\r\nmore\r\n");
}

#[tokio::test]
async fn autocrlf_normalizes_so_nothing_flagged() {
    let tmp = repo();
    let d = tmp.path();
    git(d, &["config", "core.autocrlf", "true"]);
    fs::write(d.join("a.txt"), "one\r\n").unwrap();
    git(d, &["add", "a.txt"]);
    assert!(staged_crlf(&GitRunner::default(), d).await.unwrap().is_empty());
}

#[tokio::test]
async fn ignore_eol_hides_cr_only_changes() {
    let tmp = repo();
    let d = tmp.path();
    let g = GitRunner::default();
    fs::write(d.join("a.txt"), "one\ntwo\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-q", "-m", "i"]);
    fs::write(d.join("a.txt"), "one\r\ntwo\r\n").unwrap();
    assert!(!worktree_diff(&g, d, "a.txt", false, false, false, false).await.unwrap().is_empty());
    assert!(worktree_diff(&g, d, "a.txt", false, false, true, false).await.unwrap().is_empty());
    git(d, &["commit", "-q", "-am", "crlf"]);
    assert!(!file_diff(&g, d, "HEAD", "a.txt", false, false).await.unwrap().is_empty());
    assert!(file_diff(&g, d, "HEAD", "a.txt", true, false).await.unwrap().is_empty());
}

#[tokio::test]
async fn ignore_ws_hides_whitespace_only_changes() {
    let tmp = repo();
    let d = tmp.path();
    let g = GitRunner::default();
    fs::write(d.join("a.txt"), "one\ntwo\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-q", "-m", "i"]);
    fs::write(d.join("a.txt"), "one  \n\ttwo\n").unwrap();
    assert!(!worktree_diff(&g, d, "a.txt", false, false, false, false).await.unwrap().is_empty());
    assert!(worktree_diff(&g, d, "a.txt", false, false, false, true).await.unwrap().is_empty());
    git(d, &["commit", "-q", "-am", "ws"]);
    assert!(!file_diff(&g, d, "HEAD", "a.txt", false, false).await.unwrap().is_empty());
    assert!(file_diff(&g, d, "HEAD", "a.txt", false, true).await.unwrap().is_empty());
}

#[test]
fn gitattributes_rule_on_disk() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(!root_has_eol_rule(tmp.path()));
    fs::write(tmp.path().join(".gitattributes"), "*.png binary\n").unwrap();
    assert!(!root_has_eol_rule(tmp.path()));
    fs::write(tmp.path().join(".gitattributes"), "* text=auto eol=lf\n").unwrap();
    assert!(root_has_eol_rule(tmp.path()));
}
