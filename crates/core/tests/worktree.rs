//! 작업 디렉터리 상태 · 스테이지 · 부분 스테이지 · 커밋을 실제 git으로 검증한다.

use std::fs;
use std::path::Path;

use gc_core::*;

fn git(dir: &Path, args: &[&str]) {
    let ok = std::process::Command::new("git")
        .current_dir(dir)
        .args(["-c", "init.defaultBranch=main"])
        .args(args)
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?}");
}

fn repo() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path();
    git(d, &["init", "-q"]);
    git(d, &["config", "user.name", "t"]);
    git(d, &["config", "user.email", "t@t"]);
    fs::write(d.join("a.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n").unwrap();
    fs::write(d.join("gone.txt"), "x\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-q", "-m", "init"]);
    tmp
}

#[tokio::test]
async fn status_reports_each_kind() {
    let tmp = repo();
    let d = tmp.path();
    fs::write(d.join("a.txt"), "1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10\n").unwrap();
    fs::remove_file(d.join("gone.txt")).unwrap();
    fs::write(d.join("new file.txt"), "n\n").unwrap();

    let st = read_status(&GitRunner::default(), d).await.unwrap();
    assert_eq!(st.branch.as_deref(), Some("main"));
    let find = |p: &str| st.files.iter().find(|f| f.path == p).unwrap().clone();
    assert_eq!(find("a.txt").worktree, 'M');
    assert_eq!(find("gone.txt").worktree, 'D');
    assert!(find("new file.txt").untracked);
}

#[tokio::test]
async fn stage_unstage_and_commit() {
    let tmp = repo();
    let d = tmp.path();
    let g = GitRunner::default();
    fs::write(d.join("b.txt"), "b\n").unwrap();

    stage(&g, d, &["b.txt".into()]).await.unwrap();
    assert!(read_status(&g, d).await.unwrap().files[0].staged());
    unstage(&g, d, &["b.txt".into()]).await.unwrap();
    assert!(read_status(&g, d).await.unwrap().files[0].untracked);

    stage(&g, d, &["b.txt".into()]).await.unwrap();
    commit(&g, d, "B 추가\n\n본문", false).await.unwrap();
    assert!(read_status(&g, d).await.unwrap().files.is_empty());
    assert_eq!(last_message(&g, d).await.unwrap(), "B 추가\n\n본문");

    commit(&g, d, "B 추가(수정)", true).await.unwrap();
    let log = read_log(&g, d, 10, &[]).await.unwrap();
    assert_eq!(log.len(), 2, "amend는 커밋을 늘리지 않는다");
    assert_eq!(log[0].subject, "B 추가(수정)");
}

#[tokio::test]
async fn partial_stage_of_one_line() {
    partial_stage_cycle(None).await;
}

/// Windows 기본값(core.autocrlf=true)과 꺼진 경우 모두 같은 결과여야 한다.
#[tokio::test]
async fn partial_stage_with_autocrlf_true() {
    partial_stage_cycle(Some("true")).await;
}

#[tokio::test]
async fn partial_stage_with_autocrlf_false() {
    partial_stage_cycle(Some("false")).await;
}

async fn partial_stage_cycle(autocrlf: Option<&str>) {
    let tmp = repo();
    let d = tmp.path();
    if let Some(v) = autocrlf {
        git(d, &["config", "core.autocrlf", v]);
    }
    let g = GitRunner::default();
    // 떨어진 두 곳을 고쳐서 hunk 두 개를 만든다.
    fs::write(d.join("a.txt"), "ONE\n2\n3\n4\n5\n6\n7\n8\n9\nTEN\n").unwrap();
    let diff = worktree_diff(&g, d, "a.txt", false, false, false, false).await.unwrap();

    // 첫 hunk의 "+ONE" 줄만 스테이지 (줄 0 "-1", 줄 1 "+ONE")
    apply_partial(&g, d, &diff, 0, Some(&[0, 1]), PatchTarget::Stage).await.unwrap();
    let staged = worktree_diff(&g, d, "a.txt", true, false, false, false).await.unwrap();
    assert!(staged.contains("+ONE") && !staged.contains("+TEN"), "{staged}");

    // 스테이지한 hunk를 다시 언스테이지
    apply_partial(&g, d, &staged, 0, None, PatchTarget::Unstage).await.unwrap();
    assert!(worktree_diff(&g, d, "a.txt", true, false, false, false).await.unwrap().is_empty());

    // 두 번째 hunk(TEN)를 버리면 작업 디렉터리에서 사라진다.
    let diff = worktree_diff(&g, d, "a.txt", false, false, false, false).await.unwrap();
    apply_partial(&g, d, &diff, 1, None, PatchTarget::Discard).await.unwrap();
    // autocrlf=true면 git이 작업 트리에 CRLF로 쓰므로 줄바꿈은 정규화해서 비교한다.
    let content = fs::read_to_string(d.join("a.txt")).unwrap().replace("\r\n", "\n");
    assert_eq!(content, "ONE\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", "{content:?}");
}

#[tokio::test]
async fn untracked_diff_and_discard() {
    let tmp = repo();
    let d = tmp.path();
    let g = GitRunner::default();
    fs::write(d.join("n.txt"), "new\n").unwrap();
    let diff = worktree_diff(&g, d, "n.txt", false, true, false, false).await.unwrap();
    assert!(diff.contains("+new"));
    discard(&g, d, &[], &["n.txt".into()]).await.unwrap();
    assert!(!d.join("n.txt").exists());
}

#[tokio::test]
async fn interactive_rebase_reorders_rewords_squashes_and_drops() {
    let tmp = repo();
    let d = tmp.path();
    let g = GitRunner::default();
    for n in ["A", "B", "C", "D"] {
        fs::write(d.join(format!("{n}.txt")), n).unwrap();
        git(d, &["add", "."]);
        git(d, &["commit", "-q", "-m", n]);
    }
    let log = read_log(&g, d, 10, &[]).await.unwrap(); // D C B A init
    let sha = |s: &str| log.iter().find(|c| c.subject == s).unwrap().id.clone();
    let base = sha("init");
    let steps = vec![
        RebaseStep { action: "pick".into(), sha: sha("B"), message: None },      // 순서 바꿈
        RebaseStep { action: "reword".into(), sha: sha("A"), message: Some("A 수정".into()) },
        RebaseStep { action: "fixup".into(), sha: sha("C"), message: None },     // A에 합침
        RebaseStep { action: "drop".into(), sha: sha("D"), message: None },
    ];
    rebase_interactive(&g, d, &base, &steps).await.unwrap();

    let subjects: Vec<String> = read_log(&g, d, 10, &[]).await.unwrap().into_iter().map(|c| c.subject).collect();
    assert_eq!(subjects, ["A 수정", "B", "init"]);
    assert!(d.join("C.txt").exists() && !d.join("D.txt").exists());
}

#[tokio::test]
async fn file_log_blame_and_content_search() {
    let tmp = repo();
    let d = tmp.path();
    let g = GitRunner::default();
    fs::write(d.join("a.txt"), "1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10\n").unwrap();
    git(d, &["commit", "-q", "-am", "two를 고침"]);
    git(d, &["mv", "a.txt", "b.txt"]);
    git(d, &["commit", "-q", "-m", "이름 변경"]);

    let hist = file_log(&g, d, "b.txt", 100).await.unwrap();
    assert_eq!(hist.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["이름 변경", "two를 고침", "init"]);

    let lines = blame(&g, d, "b.txt", None).await.unwrap();
    assert_eq!(lines.len(), 10);
    assert_eq!(lines[1].summary, "two를 고침");
    assert_eq!(lines[0].summary, "init");

    let found = search_content(&g, d, "TWO", &[]).await.unwrap();
    assert_eq!(found, [hist[1].id.clone()]);
}
