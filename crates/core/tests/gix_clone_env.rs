//! `GixBackend` clone 중 프로세스 환경(`GIT_CONFIG_GLOBAL`·`GIT_TEMPLATE_DIR`)을 바꿔야 하는 시험. 환경은 프로세스 전체가 공유하므로 이 파일은 시험 하나만 둔다.
#![cfg(feature = "gix")]

use std::fs;
use std::path::Path;
use std::process::Command;

use gc_core::gix_backend::GixBackend;
use gc_core::{CliBackend, GitBackend, GitRunner, JobEvent};

fn git(dir: &Path, args: &[&str]) -> String {
    let o = Command::new("git").current_dir(dir).args(["-c", "protocol.file.allow=always"]).args(args).output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).into_owned()
}

async fn run_job(b: &dyn GitBackend, d: &Path, argv: &[&str]) -> gc_core::Result<()> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let (handle, task) = b.spawn_job(d, argv, None, tx)?;
    let res = task.await.unwrap();
    drop(handle);
    while let Ok(e) = rx.try_recv() {
        if let JobEvent::Finished { .. } = e {}
    }
    res
}

/// 실패해도 (종료 코드, stdout)을 돌려준다.
fn git_any(dir: &Path, args: &[&str]) -> String {
    let o = Command::new("git").current_dir(dir).args(args).output().unwrap();
    format!("{}:{}", o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).trim())
}

/// 원격 하나(커밋 한 개)와 그 복제 상태 요약.
fn state(p: &Path) -> String {
    let mut cfg: Vec<String> = git(p, &["config", "--local", "--list"]).lines().filter(|l| !l.starts_with("core.precomposeunicode")).map(String::from).collect();
    cfg.sort();
    format!(
        "{}\nHEAD={} {}\n{}\n{}\nstatus=[{}]",
        git(p, &["for-each-ref", "--format=%(refname) %(objectname)"]),
        git_any(p, &["symbolic-ref", "-q", "HEAD"]),
        git_any(p, &["rev-parse", "-q", "--verify", "HEAD"]),
        cfg.join("\n"),
        git(p, &["ls-files", "-s"]),
        git(p, &["status", "--porcelain"]),
    )
}

fn files(p: &Path) -> Vec<(String, Vec<u8>)> {
    git(p, &["ls-files", "-z"]).split('\0').filter(|s| !s.is_empty()).map(|f| (f.to_owned(), fs::read(p.join(f)).unwrap())).collect()
}

#[tokio::test]
async fn 환경_설정이_영향을_주는_clone() {
    let (c, g) = (CliBackend::new(GitRunner::default()), GixBackend::new());
    let tmp = tempfile::tempdir().unwrap();
    let t = tmp.path();
    let empty_global = t.join("gitconfig-empty");
    fs::write(&empty_global, "").unwrap();
    std::env::set_var("GIT_CONFIG_GLOBAL", &empty_global);
    std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");

    // 원격: eol 규칙이 있는 .gitattributes와 CRLF/LF 파일
    let work = t.join("work");
    fs::create_dir(&work).unwrap();
    git(&work, &["init", "-q", "-b", "main"]);
    git(&work, &["config", "user.name", "a"]);
    git(&work, &["config", "user.email", "a@a"]);
    git(&work, &["config", "core.autocrlf", "false"]);
    fs::write(work.join(".gitattributes"), "*.crlf text eol=crlf\n*.lf text eol=lf\n*.bin binary\n").unwrap();
    fs::write(work.join("a.crlf"), "x\ny\n").unwrap();
    fs::write(work.join("b.lf"), "x\r\ny\r\n").unwrap();
    fs::write(work.join("c.txt"), "p\nq\n").unwrap();
    fs::write(work.join("d.bin"), [0, 13, 10, 1]).unwrap();
    git(&work, &["add", "-A"]);
    git(&work, &["commit", "-q", "-m", "i"]);
    let origin = t.join("origin.git");
    git(t, &["clone", "-q", "--bare", work.to_str().unwrap(), origin.to_str().unwrap()]);
    let url = origin.to_str().unwrap().to_owned();

    // 전역 core.autocrlf 설정별로 CLI와 gix의 작업 트리·상태가 같아야 한다 (다르면 거절 조건으로 바꾼다)
    for (i, autocrlf) in ["true", "input", "false"].into_iter().enumerate() {
        let gl = t.join(format!("gl{i}"));
        fs::write(&gl, format!("[core]\n\tautocrlf = {autocrlf}\n")).unwrap();
        std::env::set_var("GIT_CONFIG_GLOBAL", &gl);
        let (dc, dg) = (format!("c{i}"), format!("g{i}"));
        run_job(&c, t, &["clone", "--", &url, &dc]).await.unwrap();
        run_job(&g, t, &["clone", "--", &url, &dg]).await.unwrap();
        let (pc, pg) = (t.join(&dc), t.join(&dg));
        assert_eq!(state(&pc), state(&pg), "autocrlf={autocrlf}");
        assert_eq!(files(&pc), files(&pg), "autocrlf={autocrlf} 작업 트리");
    }
    std::env::set_var("GIT_CONFIG_GLOBAL", &empty_global);

    // 빈 원격
    let empty = t.join("empty.git");
    git(t, &["init", "-q", "--bare", "-b", "main", empty.to_str().unwrap()]);
    let (rc, rg) = (run_job(&c, t, &["clone", "--", empty.to_str().unwrap(), "ec"]).await, run_job(&g, t, &["clone", "--", empty.to_str().unwrap(), "eg"]).await);
    assert!(rc.is_ok() && rg.is_ok(), "빈 원격: cli={rc:?} gix={rg:?}");
    assert_eq!(state(&t.join("ec")), state(&t.join("eg")), "빈 원격");

    // HEAD가 브랜치가 아닌(detached) 원격
    let det = t.join("det.git");
    git(t, &["clone", "-q", "--bare", work.to_str().unwrap(), det.to_str().unwrap()]);
    let sha = git(&det, &["rev-parse", "main"]).trim().to_owned();
    fs::write(det.join("HEAD"), format!("{sha}\n")).unwrap();
    let (rc, rg) = (run_job(&c, t, &["clone", "--", det.to_str().unwrap(), "dc"]).await, run_job(&g, t, &["clone", "--", det.to_str().unwrap(), "dg"]).await);
    assert!(rc.is_ok() && rg.is_ok(), "detached 원격: cli={rc:?} gix={rg:?}");
    assert_eq!(state(&t.join("dc")), state(&t.join("dg")), "detached 원격");
    // HEAD가 없는 브랜치를 가리키는 원격 (다른 브랜치만 있음)
    let odd = t.join("odd.git");
    git(t, &["clone", "-q", "--bare", work.to_str().unwrap(), odd.to_str().unwrap()]);
    git(&odd, &["symbolic-ref", "HEAD", "refs/heads/nope"]);
    let (rc, rg) = (run_job(&c, t, &["clone", "--", odd.to_str().unwrap(), "oc"]).await, run_job(&g, t, &["clone", "--", odd.to_str().unwrap(), "og"]).await);
    assert!(rc.is_ok() && rg.is_ok(), "HEAD 없는 브랜치 원격: cli={rc:?} gix={rg:?}");
    assert_eq!(state(&t.join("oc")), state(&t.join("og")), "HEAD 없는 브랜치");

    // 하위 폴더의 .gitattributes에 filter=가 있으면 거절하고, 원래 있던 빈 대상 폴더는 남기되 비운다
    let fw = t.join("fwork");
    git(t, &["clone", "-q", work.to_str().unwrap(), fw.to_str().unwrap()]);
    git(&fw, &["config", "user.name", "a"]);
    git(&fw, &["config", "user.email", "a@a"]);
    fs::create_dir(fw.join("sub")).unwrap();
    fs::write(fw.join("sub/.gitattributes"), "*.big filter=lfs diff=lfs merge=lfs -text\n").unwrap();
    git(&fw, &["add", "-A"]);
    git(&fw, &["commit", "-q", "-m", "f"]);
    let forigin = t.join("filter.git");
    git(t, &["clone", "-q", "--bare", fw.to_str().unwrap(), forigin.to_str().unwrap()]);
    fs::create_dir(t.join("fd")).unwrap();
    let r = run_job(&g, t, &["clone", "--", forigin.to_str().unwrap(), "fd"]).await;
    assert!(matches!(r, Err(gc_core::Error::Unsupported(_))), "{r:?}");
    assert!(t.join("fd").is_dir() && fs::read_dir(t.join("fd")).unwrap().next().is_none(), "빈 폴더로 남아야 한다");
    let r = run_job(&g, t, &["clone", "--", forigin.to_str().unwrap(), "fnew"]).await;
    assert!(matches!(r, Err(gc_core::Error::Unsupported(_))), "{r:?}");
    assert!(!t.join("fnew").exists(), "새로 만든 폴더는 지워야 한다");

    // 템플릿 폴더 설정은 거절
    let tpl = t.join("tpl");
    fs::create_dir(&tpl).unwrap();
    std::env::set_var("GIT_TEMPLATE_DIR", &tpl);
    assert!(matches!(g.spawn_job(t, &["clone", "--", &url, "tg"], None, tokio::sync::mpsc::unbounded_channel().0), Err(gc_core::Error::Unsupported(_))));
    std::env::remove_var("GIT_TEMPLATE_DIR");
    let gl = t.join("gl-tpl");
    fs::write(&gl, format!("[init]\n\ttemplateDir = {}\n", tpl.display())).unwrap();
    std::env::set_var("GIT_CONFIG_GLOBAL", &gl);
    assert!(matches!(g.spawn_job(t, &["clone", "--", &url, "tg"], None, tokio::sync::mpsc::unbounded_channel().0), Err(gc_core::Error::Unsupported(_))));
    std::env::set_var("GIT_CONFIG_GLOBAL", &empty_global);
    assert!(g.spawn_job(t, &["clone", "--", &url, "tg2"], None, tokio::sync::mpsc::unbounded_channel().0).is_ok());
}
