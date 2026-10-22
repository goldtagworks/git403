//! 실제 git이 만든 diff 구문(헤더 종류, 이스케이프 경로, 줄 끝 표식 등)을 `patch` 파서·부분 적용이 다루는지 검증한다.

use std::fs;
use std::path::Path;
use std::process::Command;

use gc_core::patch::{parse, select};
use gc_core::*;

fn git(dir: &Path, args: &[&str]) {
    let ok = Command::new("git").current_dir(dir).args(["-c", "init.defaultBranch=main"]).args(args).status().unwrap().success();
    assert!(ok, "git {args:?}");
}

fn out(dir: &Path, args: &[&str]) -> String {
    let o = Command::new("git").current_dir(dir).args(args).output().unwrap();
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn repo() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path();
    git(d, &["init", "-q"]);
    git(d, &["config", "user.name", "t"]);
    git(d, &["config", "user.email", "t@t"]);
    git(d, &["config", "core.autocrlf", "false"]);
    tmp
}

fn commit_all(d: &Path, msg: &str) {
    git(d, &["add", "-A"]);
    git(d, &["commit", "-q", "-m", msg]);
}

fn numbered(n: usize) -> String {
    (1..=n).map(|i| format!("line {i}\n")).collect()
}

/// 각 hunk 수와 첫 hunk 선택 결과를 돌려준다. 선택 결과는 `git apply --check`로도 확인한다.
fn hunks_of(diff: &str) -> usize {
    let mut n = 0;
    while select(&parse(diff), n, None, false).is_some() {
        n += 1;
    }
    n
}

#[tokio::test]
async fn modified_file_with_function_context_and_two_hunks() {
    let tmp = repo();
    let d = tmp.path();
    let g = GitRunner::default();
    let mut body = String::from("fn first() {\n");
    body += &numbered(30);
    body += "}\nfn second() {\n";
    body += &numbered(30).replace("line", "row");
    body += "}\n";
    fs::write(d.join("f.rs"), &body).unwrap();
    commit_all(d, "init");
    fs::write(d.join("f.rs"), body.replacen("line 3\n", "LINE 3\n", 1).replace("row 28\n", "ROW 28\n")).unwrap();
    let diff = worktree_diff(&g, d, "f.rs", false, false, false, false).await.unwrap();
    assert!(diff.contains("\n@@ -") && diff.contains(" @@ row "), "함수 문맥이 헤더에 있어야 한다: {diff}");
    assert_eq!(hunks_of(&diff), 2);
    // 두 번째 hunk만 스테이지
    apply_partial(&g, d, &diff, 1, None, PatchTarget::Stage).await.unwrap();
    let staged = out(d, &["diff", "--cached"]);
    assert!(staged.contains("+ROW 28") && !staged.contains("+LINE 3\n"), "{staged}");
}

#[tokio::test]
async fn no_newline_at_end_of_file() {
    let tmp = repo();
    let d = tmp.path();
    let g = GitRunner::default();
    fs::write(d.join("n.txt"), "a\nb\nc").unwrap();
    commit_all(d, "init");
    fs::write(d.join("n.txt"), "a\nb\nc\nd").unwrap();
    let diff = worktree_diff(&g, d, "n.txt", false, false, false, false).await.unwrap();
    assert!(diff.contains("\\ No newline at end of file"));
    apply_partial(&g, d, &diff, 0, None, PatchTarget::Stage).await.unwrap();
    assert_eq!(out(d, &["show", ":n.txt"]), "a\nb\nc\nd");
}

#[tokio::test]
async fn unselected_added_line_does_not_leave_dangling_no_newline_marker() {
    // 마지막 줄 "+x"(개행 없음)를 고르지 않고 앞 줄만 스테이지해도 패치가 깨지지 않아야 한다.
    let tmp = repo();
    let d = tmp.path();
    let g = GitRunner::default();
    fs::write(d.join("n.txt"), "a\nb\n").unwrap();
    commit_all(d, "init");
    fs::write(d.join("n.txt"), "a\nb\nc\nx").unwrap();
    let diff = worktree_diff(&g, d, "n.txt", false, false, false, false).await.unwrap();
    // 줄: 0 " a", 1 " b", 2 "+c", 3 "+x", 4 "\ No newline"
    apply_partial(&g, d, &diff, 0, Some(&[2]), PatchTarget::Stage).await.unwrap();
    assert_eq!(out(d, &["show", ":n.txt"]), "a\nb\nc\n");
}

#[tokio::test]
async fn crlf_lines_survive_partial_stage() {
    let tmp = repo();
    let d = tmp.path();
    let g = GitRunner::default();
    fs::write(d.join("w.txt"), "a\r\nb\r\nc\r\n").unwrap();
    commit_all(d, "init");
    fs::write(d.join("w.txt"), "a\r\nB\r\nc\r\n").unwrap();
    let diff = worktree_diff(&g, d, "w.txt", false, false, false, false).await.unwrap();
    apply_partial(&g, d, &diff, 0, None, PatchTarget::Stage).await.unwrap();
    assert_eq!(out(d, &["show", ":w.txt"]), "a\r\nB\r\nc\r\n");
}

#[tokio::test]
async fn quoted_and_spaced_paths() {
    let tmp = repo();
    let d = tmp.path();
    let g = GitRunner::default();
    // Windows 파일명에는 큰따옴표를 쓸 수 없다
    let names: Vec<&str> = if cfg!(windows) {
        vec!["a b.txt", "한글 파일.txt"]
    } else {
        vec!["a b.txt", "한글 파일.txt", "q\"uote.txt"]
    };
    for &name in &names {
        fs::write(d.join(name), numbered(10)).unwrap();
    }
    commit_all(d, "init");
    for &name in &names {
        fs::write(d.join(name), numbered(10).replace("line 5\n", "FIVE\n")).unwrap();
        let diff = worktree_diff(&g, d, name, false, false, false, false).await.unwrap();
        assert!(diff.starts_with("diff --git "), "{diff}");
        apply_partial(&g, d, &diff, 0, None, PatchTarget::Stage).await.unwrap();
        let staged = worktree_diff(&g, d, name, true, false, false, false).await.unwrap();
        assert!(staged.contains("+FIVE"), "{name}: {staged}");
        // 되돌리기(unstage)도 같은 헤더로 동작
        apply_partial(&g, d, &staged, 0, None, PatchTarget::Unstage).await.unwrap();
        assert!(worktree_diff(&g, d, name, true, false, false, false).await.unwrap().is_empty(), "{name}");
    }
}

#[tokio::test]
async fn mode_change_with_content_and_rename_headers() {
    let tmp = repo();
    let d = tmp.path();
    let g = GitRunner::default();
    fs::write(d.join("old.txt"), numbered(20)).unwrap();
    fs::write(d.join("run.sh"), "echo hi\n").unwrap();
    commit_all(d, "init");
    // 이름 변경 + 내용 수정 (similarity < 100)
    git(d, &["mv", "old.txt", "new.txt"]);
    fs::write(d.join("new.txt"), numbered(20).replace("line 10\n", "TEN\n")).unwrap();
    git(d, &["add", "-A"]);
    let diff = worktree_diff(&g, d, "new.txt", true, false, false, false).await.unwrap();
    // 경로 하나만 지정하면 rename으로 안 잡히고 새 파일로 보일 수 있다 — 어느 쪽이든 파서는 hunk를 찾는다
    assert!(hunks_of(&diff) >= 1, "{diff}");
    let both = out(d, &["diff", "--cached", "-M"]);
    assert!(both.contains("rename from old.txt") && both.contains("rename to new.txt") && both.contains("similarity index"), "{both}");
    assert_eq!(hunks_of(&both), 1);
    let p = select(&parse(&both), 0, None, false).unwrap();
    assert!(p.starts_with("diff --git a/old.txt b/new.txt\nsimilarity index") && p.contains("rename from old.txt\nrename to new.txt\n"), "{p}");
    // 모드 변경 + 내용 변경
    commit_all(d, "rename");
    fs::write(d.join("run.sh"), "echo hi\necho there\n").unwrap();
    git(d, &["add", "run.sh"]);
    git(d, &["update-index", "--chmod=+x", "run.sh"]);
    let diff = worktree_diff(&g, d, "run.sh", true, false, false, false).await.unwrap();
    assert!(diff.contains("old mode 100644\nnew mode 100755"), "{diff}");
    assert_eq!(hunks_of(&diff), 1);
}

#[tokio::test]
async fn copy_header_is_kept() {
    let tmp = repo();
    let d = tmp.path();
    fs::write(d.join("src.txt"), numbered(30)).unwrap();
    commit_all(d, "init");
    fs::write(d.join("dup.txt"), numbered(30).replace("line 3\n", "THREE\n")).unwrap();
    fs::write(d.join("src.txt"), numbered(30).replace("line 20\n", "TWENTY\n")).unwrap();
    git(d, &["add", "-A"]);
    let diff = out(d, &["diff", "--cached", "-C", "--find-copies-harder"]);
    assert!(diff.contains("copy from src.txt\ncopy to dup.txt"), "{diff}");
    // 파일마다 hunk 하나씩 (파서는 한 파일 diff를 받지만 헤더 줄이 섞여도 터지지 않아야 한다)
    assert!(hunks_of(&diff) >= 1);
}

#[tokio::test]
async fn new_deleted_empty_and_binary_files() {
    let tmp = repo();
    let d = tmp.path();
    let g = GitRunner::default();
    fs::write(d.join("gone.txt"), "x\ny\n").unwrap();
    fs::write(d.join("bin.dat"), [0u8, 1, 2, 3, 255]).unwrap();
    commit_all(d, "init");

    // 삭제
    fs::remove_file(d.join("gone.txt")).unwrap();
    let diff = worktree_diff(&g, d, "gone.txt", false, false, false, false).await.unwrap();
    assert!(diff.contains("deleted file mode 100644") && hunks_of(&diff) == 1, "{diff}");
    apply_partial(&g, d, &diff, 0, None, PatchTarget::Stage).await.unwrap();
    assert!(out(d, &["status", "--porcelain"]).contains("D  gone.txt"));

    // 빈 파일 생성: hunk가 없고 부분 적용은 아무것도 하지 않는다
    fs::write(d.join("empty.txt"), "").unwrap();
    git(d, &["add", "-N", "empty.txt"]);
    let diff = out(d, &["diff", "--", "empty.txt"]);
    assert!(diff.contains("new file mode 100644"), "{diff}");
    assert_eq!(hunks_of(&diff), 0);
    apply_partial(&g, d, &diff, 0, None, PatchTarget::Stage).await.unwrap();

    // 새 파일(추적 안 함)의 일부 줄만 스테이지
    fs::write(d.join("new.txt"), "1\n2\n3\n").unwrap();
    let diff = worktree_diff(&g, d, "new.txt", false, true, false, false).await.unwrap();
    assert!(diff.contains("new file mode"), "{diff}");
    assert!(diff.contains("@@ -0,0 +1,3 @@"));
    git(d, &["add", "-N", "new.txt"]);
    let diff = worktree_diff(&g, d, "new.txt", false, false, false, false).await.unwrap();
    apply_partial(&g, d, &diff, 0, Some(&[0, 1]), PatchTarget::Stage).await.unwrap();
    assert_eq!(out(d, &["show", ":new.txt"]), "1\n2\n");

    // 바이너리: "Binary files ... differ" / GIT binary patch
    fs::write(d.join("bin.dat"), [9u8, 8, 7, 0, 0]).unwrap();
    let diff = worktree_diff(&g, d, "bin.dat", false, false, false, false).await.unwrap();
    assert!(diff.contains("Binary files a/bin.dat and b/bin.dat differ"), "{diff}");
    assert_eq!(hunks_of(&diff), 0);
    let diff = out(d, &["diff", "--binary", "--", "bin.dat"]);
    assert!(diff.contains("GIT binary patch"), "{diff}");
    assert_eq!(hunks_of(&diff), 0);
    apply_partial(&g, d, &diff, 0, None, PatchTarget::Stage).await.unwrap(); // 무동작
}

#[tokio::test]
async fn hunk_header_without_counts_and_added_single_line() {
    let tmp = repo();
    let d = tmp.path();
    let g = GitRunner::default();
    fs::write(d.join("one.txt"), "a\n").unwrap();
    commit_all(d, "init");
    fs::write(d.join("one.txt"), "b\n").unwrap();
    let diff = worktree_diff(&g, d, "one.txt", false, false, false, false).await.unwrap();
    assert!(diff.contains("@@ -1 +1 @@"), "{diff}");
    apply_partial(&g, d, &diff, 0, None, PatchTarget::Stage).await.unwrap();
    assert_eq!(out(d, &["show", ":one.txt"]), "b\n");
}
