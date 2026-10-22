//! 패치 저장·적용: format-patch 파일 판별, am 충돌 상태(`operation == "am"`)를 실제 git으로 검증한다.

use std::fs;
use std::path::Path;
use std::process::Command;

use gc_core::*;

fn git(dir: &Path, args: &[&str]) -> bool {
    Command::new("git").current_dir(dir).args(["-c", "init.defaultBranch=main"]).args(args).status().unwrap().success()
}

fn commit(d: &Path, content: &str, msg: &str) {
    fs::write(d.join("a.txt"), content).unwrap();
    assert!(git(d, &["commit", "-q", "-am", msg]));
}

#[tokio::test]
async fn am_conflict_is_reported_as_am() {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path();
    assert!(git(d, &["init", "-q"]));
    git(d, &["config", "user.name", "t"]);
    git(d, &["config", "user.email", "t@t"]);
    fs::write(d.join("a.txt"), "one\n").unwrap();
    assert!(git(d, &["add", "."]));
    assert!(git(d, &["commit", "-q", "-m", "init"]));
    assert!(git(d, &["switch", "-q", "-c", "topic"]));
    commit(d, "topic\n", "topic change");
    assert!(git(d, &["format-patch", "-q", "-1", "-o", "out"]));
    let patch = fs::read_dir(d.join("out")).unwrap().next().unwrap().unwrap().path();
    assert!(is_mailbox_patch(&patch).unwrap());

    let diff = d.join("plain.patch");
    assert!(git(d, &["diff", "--binary", &format!("--output={}", diff.display()), "HEAD~1", "HEAD"]));
    assert!(!is_mailbox_patch(&diff).unwrap());

    // main이 같은 줄을 다르게 고쳐 두면 am이 충돌한다.
    assert!(git(d, &["switch", "-q", "main"]));
    commit(d, "main\n", "main change");
    let g = GitRunner::default();
    assert!(read_status(&g, d).await.unwrap().operation.is_none());
    assert!(!git(d, &["am", "--3way", patch.to_str().unwrap()]));
    assert_eq!(read_status(&g, d).await.unwrap().operation.as_deref(), Some("am"));
    assert!(git(d, &["am", "--abort"]));
    assert!(read_status(&g, d).await.unwrap().operation.is_none());
}
