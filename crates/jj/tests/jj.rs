use std::path::Path;
use std::process::Command;

use gc_jj::{enable, is_enabled, status};

fn git(dir: &Path, args: &[&str]) -> String {
    let o = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8(o.stdout).unwrap()
}

fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    git(d.path(), &["init", "-q", "-b", "main"]);
    for i in 0..2 {
        std::fs::write(d.path().join("a.txt"), format!("v{i}\n")).unwrap();
        git(d.path(), &["add", "."]);
        git(d.path(), &["commit", "-q", "-m", &format!("c{i}")]);
    }
    d
}

#[test]
fn enable_is_idempotent_and_keeps_git_untouched() {
    let d = repo();
    let p = d.path();
    let refs = git(p, &["for-each-ref"]);
    let head = git(p, &["rev-parse", "HEAD"]);
    let log = git(p, &["log", "--format=%H %T %s"]);
    assert!(!is_enabled(p));
    enable(p).unwrap();
    assert!(is_enabled(p));
    assert_eq!(std::fs::read_to_string(p.join(".jj/.gitignore")).unwrap(), "/*\n");
    enable(p).unwrap();
    enable(p).unwrap();
    // 기존 ref는 그대로, jj가 더한 것은 refs/jj/ 아래뿐(커밋 보존용 keep ref)
    let after = git(p, &["for-each-ref"]);
    let outside: Vec<&str> = after.lines().filter(|l| !l.contains("\trefs/jj/")).collect();
    assert_eq!(outside.join("\n") + "\n", refs);
    assert_eq!(git(p, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(p, &["log", "--format=%H %T %s"]), log);
    assert_eq!(git(p, &["status", "--porcelain"]), "");
    git(p, &["fsck", "--strict"]);
}

#[test]
fn status_reports_working_copy_and_change_ids() {
    let d = repo();
    let p = d.path();
    assert!(status(p).is_err());
    enable(p).unwrap();
    let head = git(p, &["rev-parse", "HEAD"]).trim().to_string();
    let s = status(p).unwrap();
    let wc = s.working_copy.clone().expect("@");
    assert_ne!(wc, head, "@ is a new empty commit on top of HEAD");
    let c = &s.change_ids[&wc];
    assert_eq!(c.full.len(), 32);
    assert!(c.full.chars().all(|ch| ('k'..='z').contains(&ch)));
    assert!(c.full.starts_with(&c.short));
    // 기존 git 커밋도 change ID를 가진다(2개 + @)
    assert!(s.change_ids.contains_key(&head));
    assert_eq!(s.change_ids.len(), 3);
    assert!(s.conflicted.is_empty());
    assert!(!s.truncated);
    // 다시 읽어도 같다
    assert_eq!(status(p).unwrap(), s);
    assert_eq!(git(p, &["rev-parse", "HEAD"]).trim(), head);
}

#[test]
fn rejects_untrusted_layouts() {
    let d = tempfile::tempdir().unwrap();
    // git 저장소 아님
    assert!(enable(d.path()).is_err());
    // .git이 파일(gitfile)
    std::fs::write(d.path().join(".git"), "gitdir: /tmp/elsewhere\n").unwrap();
    assert!(enable(d.path()).is_err());
    assert!(!is_enabled(d.path()));
    // .git이 심볼릭 링크
    #[cfg(unix)]
    {
        let real = repo();
        let d2 = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(real.path().join(".git"), d2.path().join(".git")).unwrap();
        assert!(enable(d2.path()).is_err());
        assert!(!real.path().join(".jj").exists());
        // .jj가 링크
        let r = repo();
        let target = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(target.path(), r.path().join(".jj")).unwrap();
        assert!(!is_enabled(r.path()));
        assert!(enable(r.path()).is_err());
        assert!(status(r.path()).is_err());
    }
    // 반쯤 만든 .jj
    let r = repo();
    std::fs::create_dir(r.path().join(".jj")).unwrap();
    assert!(enable(r.path()).is_err());
}

#[test]
fn enable_keeps_dirty_worktree_and_branches() {
    let d = repo();
    let p = d.path();
    git(p, &["branch", "topic"]);
    std::fs::write(p.join("a.txt"), "dirty\n").unwrap();
    std::fs::write(p.join("new.txt"), "new\n").unwrap();
    let before = git(p, &["status", "--porcelain"]);
    let index = std::fs::read(p.join(".git/index")).unwrap();
    enable(p).unwrap();
    assert_eq!(git(p, &["status", "--porcelain"]), before);
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "dirty\n");
    assert_eq!(std::fs::read(p.join(".git/index")).unwrap(), index);
    assert_eq!(git(p, &["symbolic-ref", "HEAD"]).trim(), "refs/heads/main");
    // 빈 저장소(커밋 없음)도 켤 수 있다
    let e = tempfile::tempdir().unwrap();
    git(e.path(), &["init", "-q"]);
    enable(e.path()).unwrap();
    assert!(status(e.path()).unwrap().working_copy.is_some());
    assert_eq!(git(e.path(), &["status", "--porcelain"]), "");
}
