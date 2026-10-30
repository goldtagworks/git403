//! `GixBackend`와 `CliBackend`를 같은 임시 저장소에서 비교한다 (`cargo test -p gc-core --features gix`).
//! 정규화는 없다: 결과는 필드 하나, 글자 하나까지 같아야 한다. (쓰기 테스트는 시각·해시가 달라지는 항목만 빼고 비교한다.)
#![cfg(feature = "gix")]

use std::fmt::Debug;
use std::fs;
use std::path::Path;
use std::process::Command;

use gc_core::gix_backend::GixBackend;
use gc_core::{CliBackend, GitBackend, GitRunner};

/// 날짜를 고정해 해시가 재현되게 한다 (`n`번째 커밋 = 2020-01-01 + n시간).
fn git_env(dir: &Path, args: &[&str], n: u32) -> String {
    let date = format!("{} +0900", 1_577_836_800 + n as u64 * 3600);
    let o = Command::new("git")
        .current_dir(dir)
        .args(["-c", "init.defaultBranch=main", "-c", "core.quotepath=false", "-c", "protocol.file.allow=always"])
        .args(args)
        .env("GIT_AUTHOR_DATE", &date)
        .env("GIT_COMMITTER_DATE", &date)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn git(dir: &Path, args: &[&str]) -> String {
    git_env(dir, args, 0)
}

fn write(dir: &Path, rel: &str, content: &[u8]) {
    let p = dir.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, content).unwrap();
}

fn numbered(n: usize, tag: &str) -> String {
    (1..=n).map(|i| format!("line {i}{tag}\n")).collect()
}

/// 여러 종류의 변경이 든 저장소: 커밋 여러 개·브랜치·태그(가벼운/주석)·머지·한글·공백 경로·바이너리·이름 변경·삭제·모드·심볼릭 링크·스태시·업스트림.
fn fixture() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path();
    git(d, &["init", "-q"]);
    git(d, &["config", "user.name", "Kim 한글"]);
    git(d, &["config", "user.email", "kim@example.com"]);
    git(d, &["config", "core.autocrlf", "false"]);
    let n = std::cell::Cell::new(1u32);
    let commit = |msg: &str| {
        git_env(d, &["add", "-A"], n.get());
        git_env(d, &["commit", "-q", "-m", msg], n.get());
        n.set(n.get() + 1);
    };
    write(d, "a.txt", numbered(40, "").as_bytes());
    write(d, "한글 경로/파일.txt", "안녕\n".as_bytes());
    write(d, "src/lib.rs", b"fn alpha() {\n    1\n}\n\nfn beta() {\n    2\n}\n\nfn gamma() {\n    3\n}\n");
    write(d, "space name.txt", b"x\n");
    write(d, "bin.dat", &[0, 1, 2, 3, 255, 0]);
    write(d, "run.sh", b"#!/bin/sh\necho hi\n");
    commit("첫 커밋");
    // 둘째: 떨어진 두 곳 수정(두 hunk) + 가까운 두 곳(한 hunk) + 함수 문맥
    let mut a = numbered(40, "");
    a = a.replace("line 3\n", "line 3 changed\n").replace("line 30\n", "line 30 changed\n").replace("line 33\n", "line 33 changed\n");
    write(d, "a.txt", a.as_bytes());
    write(d, "src/lib.rs", b"fn alpha() {\n    1\n}\n\nfn beta() {\n    2\n    22\n}\n\nfn gamma() {\n    3\n}\n");
    write(d, "bin.dat", &[0, 9, 2, 3, 255, 0]);
    commit("둘째\n\n본문 첫 줄\n\n본문   둘째 줄");
    git(d, &["tag", "v1"]);
    // 브랜치와 머지 (머지 커밋은 --no-ff)
    git(d, &["switch", "-q", "-c", "feature"]);
    write(d, "feature.txt", b"f1\nf2\n");
    commit("feature 추가");
    write(d, "feature.txt", b"f1\nf2\nf3\n");
    commit("feature 수정");
    git(d, &["switch", "-q", "main"]);
    write(d, "main-only.txt", b"m\n");
    commit("main 쪽");
    git_env(d, &["merge", "--no-ff", "-q", "-m", "머지 feature", "feature"], n.get());
    n.set(n.get() + 1);
    git(d, &["tag", "-a", "v2", "-m", "주석 태그"]);
    // 이름 변경(약간 수정) / 삭제 / 모드 변경 / 링크 / 빈 파일 / 개행 없는 끝
    git(d, &["mv", "a.txt", "renamed.txt"]);
    let mut r = numbered(40, "");
    r = r.replace("line 3\n", "line 3 changed\n").replace("line 30\n", "line 30 changed\n").replace("line 33\n", "line 33 changed\n").replace("line 20\n", "line 20 renamed\n");
    write(d, "renamed.txt", r.as_bytes());
    git(d, &["rm", "-q", "space name.txt"]);
    commit("이름 변경과 삭제");
    git(d, &["update-index", "--chmod=+x", "feature.txt"]);
    #[cfg(unix)]
    std::os::unix::fs::symlink("run.sh", d.join("link")).unwrap();
    write(d, "empty.txt", b"");
    write(d, "noeol.txt", b"a\nb");
    commit("모드·링크·빈 파일·개행 없음");
    write(d, "noeol.txt", b"a\nb\nc\n");
    write(d, "feature.txt", b"f1\nf2\nf3 mode\n");
    commit("개행 추가");
    // 파일 → 디렉터리 정렬 순서(`a-x` < `a/` < `a0`)
    write(d, "ord/a-x", b"1\n");
    write(d, "ord/a/b", b"2\n");
    write(d, "ord/a0", b"3\n");
    write(d, "ord/a.txt", b"4\n");
    commit("정렬 순서");
    // 업스트림: origin에 push 후 로컬 1커밋 앞서고, 다른 클론이 1커밋 밀어 뒤처지게 한다
    let bare = d.parent().unwrap().join(format!("{}-origin.git", d.file_name().unwrap().to_string_lossy()));
    git(d.parent().unwrap(), &["init", "-q", "--bare", bare.to_str().unwrap()]);
    git(d, &["remote", "add", "origin", bare.to_str().unwrap()]);
    git(d, &["push", "-q", "-u", "origin", "main", "feature"]);
    let other = d.parent().unwrap().join(format!("{}-other", d.file_name().unwrap().to_string_lossy()));
    git(d.parent().unwrap(), &["clone", "-q", bare.to_str().unwrap(), other.to_str().unwrap()]);
    git(&other, &["config", "user.name", "o"]);
    git(&other, &["config", "user.email", "o@o"]);
    write(&other, "other.txt", b"o\n");
    git_env(&other, &["add", "-A"], 50);
    git_env(&other, &["commit", "-q", "-m", "다른 사람"], 50);
    git(&other, &["push", "-q", "origin", "main"]);
    git(d, &["fetch", "-q"]);
    write(d, "ahead.txt", b"a\n");
    commit("로컬 앞섬");
    // 스태시
    write(d, "feature.txt", b"stash me\n");
    git_env(d, &["stash", "push", "-q", "-m", "내 스태시"], 60);
    tmp
}

#[track_caller]
fn same<T: Debug>(what: &str, cli: T, gix: T) {
    let (c, g) = (format!("{cli:#?}"), format!("{gix:#?}"));
    assert_eq!(c, g, "{what}: CliBackend와 GixBackend 결과가 다르다\n--- cli\n{c}\n--- gix\n{g}");
}

fn backends() -> (CliBackend, GixBackend) {
    (CliBackend::new(GitRunner::default()), GixBackend::new())
}

#[tokio::test]
async fn 로그와_헤드와_refs가_같다() {
    let tmp = fixture();
    let d = tmp.path();
    let (c, g) = backends();
    same("head_commit", c.head_commit(d).await, g.head_commit(d).await);
    same("read_log", c.read_log(d, 1000, &[]).await.unwrap(), g.read_log(d, 1000, &[]).await.unwrap());
    same("read_log limit", c.read_log(d, 4, &[]).await.unwrap(), g.read_log(d, 4, &[]).await.unwrap());
    let hidden = vec!["refs/heads/feature".to_owned(), "refs/remotes/origin/*".to_owned(), "!refs/remotes/origin/main".to_owned(), "!--all".to_owned()];
    same("read_log hidden", c.read_log(d, 1000, &hidden).await.unwrap(), g.read_log(d, 1000, &hidden).await.unwrap());
    let hidden = vec!["refs/heads/main".to_owned(), "refs/tags/*".to_owned()];
    same("read_log hidden2", c.read_log(d, 1000, &hidden).await.unwrap(), g.read_log(d, 1000, &hidden).await.unwrap());
    same("read_refs", c.read_refs(d).await.unwrap(), g.read_refs(d).await.unwrap());
    let log = c.read_log(d, 1000, &[]).await.unwrap();
    for cm in &log {
        same(&format!("commit_message {}", cm.id), c.commit_message(d, &cm.id).await.unwrap(), g.commit_message(d, &cm.id).await.unwrap());
        same(&format!("committer {}", cm.id), c.committer(d, &cm.id).await.unwrap(), g.committer(d, &cm.id).await.unwrap());
    }
}

#[tokio::test]
async fn 커밋별_변경_목록과_diff가_같다() {
    let tmp = fixture();
    let d = tmp.path();
    let (c, g) = backends();
    let log = c.read_log(d, 1000, &[]).await.unwrap();
    for cm in &log {
        let files = c.changed_files(d, &cm.id).await.unwrap();
        same(&format!("changed_files {}", cm.subject), &files, &g.changed_files(d, &cm.id).await.unwrap());
        for f in &files {
            for (eol, ws) in [(false, false), (true, false), (false, true)] {
                same(&format!("file_diff {} {} eol={eol} ws={ws}", cm.subject, f.path), c.file_diff(d, &cm.id, &f.path, eol, ws).await.unwrap(), g.file_diff(d, &cm.id, &f.path, eol, ws).await.unwrap());
            }
            if let Some(old) = &f.old_path {
                same(&format!("file_diff old {} {old}", cm.subject), c.file_diff(d, &cm.id, old, false, false).await.unwrap(), g.file_diff(d, &cm.id, old, false, false).await.unwrap());
            }
        }
        // 디렉터리 경로 스펙
        same(&format!("file_diff dir {}", cm.subject), c.file_diff(d, &cm.id, "ord", false, false).await.unwrap(), g.file_diff(d, &cm.id, "ord", false, false).await.unwrap());
    }
    // HEAD·HEAD~2 같은 이름도 받는다
    // (주석 태그 이름은 CLI가 `show`의 태그 머리글을 파싱해 엉뚱한 값을 내므로 제외한다 — UI는 커밋 sha만 보낸다)
    for rev in ["HEAD", "HEAD~2", "v1"] {
        same(&format!("changed_files {rev}"), c.changed_files(d, rev).await.unwrap(), g.changed_files(d, rev).await.unwrap());
    }
    assert!(g.changed_files(d, "--output=x").await.is_err());
}

#[tokio::test]
async fn file_blob이_같다() {
    let tmp = fixture();
    let d = tmp.path();
    let (c, g) = backends();
    let head = c.head_commit(d).await.unwrap();
    for (rev, path) in [
        (Some(head.as_str()), "src/lib.rs"),
        (Some("HEAD"), "한글 경로/파일.txt"),
        (Some("HEAD"), "bin.dat"),
        (Some("HEAD"), "없는.txt"),
        (Some("HEAD"), "src"),
        (Some("HEAD^"), "noeol.txt"),
        (Some(":"), "run.sh"),
        (Some(":"), "없는.txt"),
        (None, "run.sh"),
        (Some("WORKTREE"), "없는.txt"),
    ] {
        // 디렉터리(`HEAD:src`)처럼 git이 거절하는 경우는 둘 다 오류여야 한다 (메시지는 비교하지 않는다)
        let (cr, gr) = (c.file_blob(d, rev, path).await, g.file_blob(d, rev, path).await);
        same(&format!("file_blob {rev:?} {path}"), cr.as_ref().map_err(|_| ()), gr.as_ref().map_err(|_| ()));
    }
    assert!(g.file_blob(d, Some("main"), "a.txt").await.is_err());
}

/// 작업 트리를 여러 상태로 만든다 (스테이지·언스테이지·이름 변경·삭제·untracked 섞기).
fn dirty(d: &Path) {
    write(d, "src/lib.rs", b"fn alpha() {\n    1\n}\n\nfn beta() {\n    2\n    22\n    23\n}\n\nfn gamma() {\n    3\n}\n"); // 수정 (unstaged)
    write(d, "한글 경로/파일.txt", "안녕 바뀜\n".as_bytes());
    git(d, &["add", "한글 경로/파일.txt"]); // staged
    write(d, "한글 경로/파일.txt", "안녕 바뀜 둘\n".as_bytes()); // + unstaged
    write(d, "new staged.txt", b"n\n");
    git(d, &["add", "new staged.txt"]);
    git(d, &["rm", "-q", "empty.txt"]); // staged 삭제
    fs::remove_file(d.join("noeol.txt")).unwrap(); // unstaged 삭제
    git(d, &["mv", "renamed.txt", "moved.txt"]); // staged 이름 변경
    write(d, "untracked/새 파일.txt", b"u\nv\n");
    write(d, "untracked/bin.bin", &[0, 1, 2]);
    write(d, "untracked/empty", b"");
    write(d, "bin.dat", &[1, 1, 1]); // 바이너리 수정
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(d.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap(); // 모드만 변경
    }
}

#[tokio::test]
async fn 상태와_작업_트리_diff가_같다() {
    let tmp = fixture();
    let d = tmp.path();
    let (c, g) = backends();
    same("status 깨끗", c.read_status(d).await.unwrap(), g.read_status(d).await.unwrap());
    dirty(d);
    let st = c.read_status(d).await.unwrap();
    same("status", &st, &g.read_status(d).await.unwrap());
    assert!(st.files.len() >= 9);
    for f in &st.files {
        if f.untracked {
            same(&format!("worktree_diff untracked {}", f.path), c.worktree_diff(d, &f.path, false, true, false, false).await.unwrap(), g.worktree_diff(d, &f.path, false, true, false, false).await.unwrap());
            continue;
        }
        for staged in [false, true] {
            same(&format!("worktree_diff {} staged={staged}", f.path), c.worktree_diff(d, &f.path, staged, false, false, false).await.unwrap(), g.worktree_diff(d, &f.path, staged, false, false, false).await.unwrap());
        }
    }
    // 공백만 바뀐 변경 + 옵션
    write(d, "src/lib.rs", b"fn alpha() {\n  1  \n}\r\n\nfn beta() {\n    2\n    22\n}\n\nfn gamma() {\n    3\n}\n");
    for (eol, ws) in [(false, false), (true, false), (false, true)] {
        same(&format!("worktree_diff ws eol={eol} ws={ws}"), c.worktree_diff(d, "src/lib.rs", false, false, eol, ws).await.unwrap(), g.worktree_diff(d, "src/lib.rs", false, false, eol, ws).await.unwrap());
    }
    // 브랜치 이름·진행 중 작업
    git(d, &["stash", "-q", "-u"]);
    git(d, &["switch", "-q", "--detach", "HEAD~1"]);
    same("status detached", c.read_status(d).await.unwrap(), g.read_status(d).await.unwrap());
}

#[tokio::test]
async fn 충돌_상태와_머지_진행중이_같다() {
    let tmp = fixture();
    let d = tmp.path();
    let (c, g) = backends();
    git(d, &["stash", "-q", "-u"]);
    git(d, &["switch", "-q", "-c", "c1", "HEAD"]);
    write(d, "a2.txt", b"base\n");
    write(d, "b2.txt", b"base\n");
    write(d, "c2.txt", b"base\n");
    git_env(d, &["add", "-A"], 70);
    git_env(d, &["commit", "-q", "-m", "base"], 70);
    git(d, &["switch", "-q", "-c", "c2"]);
    write(d, "a2.txt", b"theirs\n");
    fs::remove_file(d.join("b2.txt")).unwrap();
    write(d, "new.txt", b"theirs new\n");
    git_env(d, &["add", "-A"], 71);
    git_env(d, &["commit", "-q", "-m", "theirs"], 71);
    git(d, &["switch", "-q", "c1"]);
    write(d, "a2.txt", b"ours\n");
    write(d, "b2.txt", b"ours\n");
    write(d, "new.txt", b"ours new\n");
    git_env(d, &["add", "-A"], 72);
    git_env(d, &["commit", "-q", "-m", "ours"], 72);
    let _ = Command::new("git").current_dir(d).args(["merge", "c2"]).output().unwrap();
    let st = c.read_status(d).await.unwrap();
    assert_eq!(st.operation.as_deref(), Some("merge"));
    assert!(st.files.iter().any(|f| f.conflict));
    same("status conflict", st, g.read_status(d).await.unwrap());
    assert!(matches!(g.commit(d, "x", false).await, Err(gc_core::Error::Unsupported(_))));
}

#[tokio::test]
async fn run_허용_목록() {
    let tmp = fixture();
    let d = tmp.path();
    let (c, g) = backends();
    for argv in [
        vec!["config", "--get", "user.name"],
        vec!["config", "--local", "--get", "user.email"],
        vec!["config", "--get", "branch.main.remote"],
        vec!["config", "--get", "core.autocrlf"],
        vec!["symbolic-ref", "--short", "-q", "HEAD"],
        vec!["rev-parse", "--verify", "-q", "HEAD"],
    ] {
        same(&format!("run {argv:?}"), c.run(d, &argv, &[]).await.unwrap(), g.run(d, &argv, &[]).await.unwrap());
    }
    // 없는 키: 종료 코드 1, ok에 1이 있으면 빈 출력
    assert!(g.run(d, &["config", "--get", "no.such"], &[]).await.is_err());
    assert_eq!(g.run(d, &["config", "--get", "no.such"], &[1]).await.unwrap(), c.run(d, &["config", "--get", "no.such"], &[1]).await.unwrap());
    assert!(matches!(g.run(d, &["push"], &[]).await, Err(gc_core::Error::Unsupported(_))));
    assert!(matches!(g.run(d, &["config", "--global", "a.b", "c"], &[]).await, Err(gc_core::Error::Unsupported(_))));
}

// ---- 추가 경우들 ----

fn plain_repo() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path();
    git(d, &["init", "-q"]);
    git(d, &["config", "user.name", "T"]);
    git(d, &["config", "user.email", "t@t.dev"]);
    git(d, &["config", "core.autocrlf", "false"]);
    tmp
}

#[tokio::test]
async fn 첫_커밋_전_저장소() {
    let tmp = plain_repo();
    let d = tmp.path();
    let (c, g) = backends();
    same("unborn head", c.head_commit(d).await, g.head_commit(d).await);
    same("unborn log", c.read_log(d, 10, &[]).await.map_err(|_| ()), g.read_log(d, 10, &[]).await.map_err(|_| ()));
    same("unborn refs", c.read_refs(d).await.unwrap(), g.read_refs(d).await.unwrap());
    write(d, "a.txt", b"a\n");
    write(d, "dir/b.txt", b"b\n");
    git(d, &["add", "a.txt"]);
    same("unborn status", c.read_status(d).await.unwrap(), g.read_status(d).await.unwrap());
    for staged in [true, false] {
        same(&format!("unborn worktree_diff staged={staged}"), c.worktree_diff(d, "a.txt", staged, false, false, false).await.unwrap(), g.worktree_diff(d, "a.txt", staged, false, false, false).await.unwrap());
    }
}

#[tokio::test]
async fn 시계가_어긋난_히스토리의_날짜순() {
    let tmp = plain_repo();
    let d = tmp.path();
    let (c, g) = backends();
    let n = std::cell::Cell::new(0u32);
    let commit = |msg: &str, at: u32| {
        write(d, &format!("{msg}.txt"), format!("{msg}\n").as_bytes());
        git_env(d, &["add", "-A"], at);
        git_env(d, &["commit", "-q", "-m", msg], at);
        n.set(n.get() + 1);
    };
    commit("root", 10);
    commit("main-1", 20);
    git(d, &["switch", "-q", "-c", "side", "HEAD~1"]);
    commit("side-1", 15);
    commit("side-2", 30); // 부모보다 늦은 시각
    git(d, &["switch", "-q", "main"]);
    commit("main-2", 25);
    commit("same-time-a", 40);
    commit("same-time-b", 40); // 같은 시각
    git(d, &["switch", "-q", "-c", "skew", "HEAD~3"]);
    commit("skew-old", 5); // 부모보다 이른 시각 (시계 어긋남)
    git_env(d, &["merge", "--no-ff", "-q", "-m", "merge-all", "side", "main"], 50);
    git(d, &["switch", "-q", "--detach", "side"]);
    same("skew log", c.read_log(d, 100, &[]).await.unwrap(), g.read_log(d, 100, &[]).await.unwrap());
    same("skew log limit", c.read_log(d, 5, &[]).await.unwrap(), g.read_log(d, 5, &[]).await.unwrap());
    same("skew refs", c.read_refs(d).await.unwrap(), g.read_refs(d).await.unwrap());
    same("skew status detached", c.read_status(d).await.unwrap(), g.read_status(d).await.unwrap());
}

#[tokio::test]
async fn 특수한_경로와_타입_변경과_업스트림_소실() {
    let tmp = fixture();
    let d = tmp.path();
    let (c, g) = backends();
    #[cfg(unix)]
    {
        write(d, "tab\there.txt", b"t\n");
        write(d, "quo\"te.txt", b"q\n");
        write(d, "back\\slash.txt", b"b\n");
        // 파일 → 링크 타입 변경
        fs::remove_file(d.join("run.sh")).unwrap();
        std::os::unix::fs::symlink("src/lib.rs", d.join("run.sh")).unwrap();
        git(d, &["add", "-A"]);
        git_env(d, &["commit", "-q", "-m", "특수 경로·타입 변경"], 80);
        let head = c.head_commit(d).await.unwrap();
        let files = c.changed_files(d, &head).await.unwrap();
        same("특수 경로 changed_files", &files, &g.changed_files(d, &head).await.unwrap());
        assert!(files.iter().any(|f| f.status == 'T'));
        for f in &files {
            same(&format!("특수 경로 file_diff {}", f.path), c.file_diff(d, &head, &f.path, false, false).await.unwrap(), g.file_diff(d, &head, &f.path, false, false).await.unwrap());
        }
        write(d, "tab\there.txt", b"t2\n");
        write(d, "untracked\ttab.txt", b"u\n");
        same("특수 경로 status", c.read_status(d).await.unwrap(), g.read_status(d).await.unwrap());
        same("특수 경로 worktree_diff", c.worktree_diff(d, "tab\there.txt", false, false, false, false).await.unwrap(), g.worktree_diff(d, "tab\there.txt", false, false, false, false).await.unwrap());
        same("특수 경로 untracked diff", c.worktree_diff(d, "untracked\ttab.txt", false, true, false, false).await.unwrap(), g.worktree_diff(d, "untracked\ttab.txt", false, true, false, false).await.unwrap());
    }
    // 원격 브랜치가 사라진 업스트림(gone)
    git(d, &["update-ref", "-d", "refs/remotes/origin/main"]);
    same("gone refs", c.read_refs(d).await.unwrap(), g.read_refs(d).await.unwrap());
    same("gone status", c.read_status(d).await.unwrap(), g.read_status(d).await.unwrap());
}

#[tokio::test]
async fn autocrlf와_개행_변환() {
    let tmp = plain_repo();
    let d = tmp.path();
    let (c, g) = backends();
    git(d, &["config", "core.autocrlf", "true"]);
    write(d, "crlf.txt", b"a\r\nb\r\n");
    git(d, &["add", "-A"]);
    git_env(d, &["commit", "-q", "-m", "crlf"], 1);
    write(d, "crlf.txt", b"a\r\nb changed\r\n");
    same("autocrlf status", c.read_status(d).await.unwrap(), g.read_status(d).await.unwrap());
    same("autocrlf worktree_diff", c.worktree_diff(d, "crlf.txt", false, false, false, false).await.unwrap(), g.worktree_diff(d, "crlf.txt", false, false, false, false).await.unwrap());
    write(d, "new.txt", b"x\r\ny\r\n");
    same("autocrlf untracked", c.worktree_diff(d, "new.txt", false, true, false, false).await.unwrap(), g.worktree_diff(d, "new.txt", false, true, false, false).await.unwrap());
}

// ---- 쓰기: 같은 상태의 복사본 둘에 CLI·gix로 각각 적용하고 결과를 비교한다 ----

fn copy_repo(from: &Path) -> tempfile::TempDir {
    let to = tempfile::tempdir().unwrap();
    let ok = Command::new("cp").arg("-a").arg(format!("{}/.", from.display())).arg(to.path()).status().unwrap().success();
    assert!(ok);
    to
}

/// 상태(`status v2`)·인덱스(`ls-files -s`)·스테이지된 diff가 같고 `git fsck`가 통과하는지.
fn assert_same_repo_state(a: &Path, b: &Path, what: &str) {
    for args in [&["status", "--porcelain=v2", "-z", "--branch", "-uall"][..], &["ls-files", "-s", "-z"], &["diff", "--cached", "--no-color"], &["diff", "--no-color"]] {
        let (x, y) = (git(a, args), git(b, args));
        assert_eq!(x, y, "{what}: `git {args:?}` 결과가 다르다 (왼쪽 = CliBackend)");
    }
    git(b, &["fsck", "--strict", "--no-dangling"]);
}

#[tokio::test]
async fn stage와_unstage가_같다() {
    let tmp = fixture();
    dirty(tmp.path());
    let (c, g) = backends();
    let cases: Vec<Vec<String>> = vec![
        vec!["src/lib.rs".into()],
        vec!["untracked".into()], // 디렉터리 (untracked 여러 개)
        vec!["noeol.txt".into(), "한글 경로/파일.txt".into()], // 삭제 + 수정
        vec!["bin.dat".into(), "run.sh".into()], // 바이너리·모드
        vec![".".into()],
    ];
    for paths in cases {
        let (a, b) = (copy_repo(tmp.path()), copy_repo(tmp.path()));
        c.stage(a.path(), &paths).await.unwrap();
        g.stage(b.path(), &paths).await.unwrap();
        assert_same_repo_state(a.path(), b.path(), &format!("stage {paths:?}"));
        // 이어서 일부를 unstage
        for un in [vec!["src/lib.rs".to_owned()], vec!["untracked".to_owned()], vec![".".to_owned()], vec!["new staged.txt".to_owned(), "moved.txt".to_owned(), "renamed.txt".to_owned()]] {
            let (a2, b2) = (copy_repo(a.path()), copy_repo(b.path()));
            let (rc, rg) = (c.unstage(a2.path(), &un).await, g.unstage(b2.path(), &un).await);
            assert_eq!(rc.is_ok(), rg.is_ok(), "unstage {un:?}: {rc:?} vs {rg:?}");
            if rc.is_ok() {
                assert_same_repo_state(a2.path(), b2.path(), &format!("stage {paths:?} → unstage {un:?}"));
            }
        }
    }
    // 존재하지 않는 경로는 둘 다 오류
    let (a, b) = (copy_repo(tmp.path()), copy_repo(tmp.path()));
    assert!(c.stage(a.path(), &["nope.txt".into()]).await.is_err());
    assert!(g.stage(b.path(), &["nope.txt".into()]).await.is_err());
    assert!(c.unstage(a.path(), &["nope.txt".into()]).await.is_err());
    assert!(g.unstage(b.path(), &["nope.txt".into()]).await.is_err());
}

fn commit_info(d: &Path) -> String {
    let log = git(d, &["log", "-1", "--format=tree=%T%nparents=%P%nauthor=%an <%ae>%ncommitter=%cn <%ce>%nmsg=%B%n--"]);
    format!("{log}{}", git(d, &["reflog", "-1", "--format=%gs"]))
}

#[tokio::test]
async fn commit이_같다() {
    let tmp = fixture();
    dirty(tmp.path());
    let (c, g) = backends();
    git(tmp.path(), &["add", "-A"]);
    let msg = "제목입니다  \n\n\n본문 첫 줄   \n\n둘째 문단\n\n\n";
    let (a, b) = (copy_repo(tmp.path()), copy_repo(tmp.path()));
    c.commit(a.path(), msg, false).await.unwrap();
    g.commit(b.path(), msg, false).await.unwrap();
    assert_eq!(commit_info(a.path()), commit_info(b.path()));
    assert_same_repo_state(a.path(), b.path(), "commit");
    git(b.path(), &["fsck", "--strict"]);
    // amend: 작성자 유지, 부모 유지, 새 트리
    for p in [a.path(), b.path()] {
        write(p, "amend.txt", b"am\n");
        git(p, &["add", "amend.txt"]);
    }
    c.commit(a.path(), "고친 메시지", true).await.unwrap();
    g.commit(b.path(), "고친 메시지", true).await.unwrap();
    assert_eq!(commit_info(a.path()), commit_info(b.path()));
    assert_same_repo_state(a.path(), b.path(), "amend");
    // 바꿀 게 없으면 둘 다 오류, 빈 메시지도 오류
    assert!(c.commit(a.path(), "또", false).await.is_err());
    assert!(g.commit(b.path(), "또", false).await.is_err());
    write(b.path(), "x.txt", b"x\n");
    git(b.path(), &["add", "x.txt"]);
    assert!(g.commit(b.path(), " \n\n", false).await.is_err());
    // 첫 커밋 (빈 저장소)
    let (e1, e2) = (plain_repo(), plain_repo());
    for p in [e1.path(), e2.path()] {
        write(p, "dir/a.txt", b"a\n");
        write(p, "dir-x", b"x\n");
        write(p, "dir.y", b"y\n");
        git(p, &["add", "-A"]);
    }
    c.commit(e1.path(), "init", false).await.unwrap();
    g.commit(e2.path(), "init", false).await.unwrap();
    assert_eq!(commit_info(e1.path()), commit_info(e2.path()));
    git(e2.path(), &["fsck", "--strict"]);
}

#[tokio::test]
async fn 활성_훅이나_서명이_있으면_커밋을_거절한다() {
    let tmp = plain_repo();
    let d = tmp.path();
    let g = GixBackend::new();
    write(d, "a.txt", b"a\n");
    git(d, &["add", "-A"]);
    write(d, ".git/hooks/pre-commit", b"#!/bin/sh\nexit 1\n");
    #[cfg(unix)]
    fs::set_permissions(d.join(".git/hooks/pre-commit"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    assert!(matches!(g.commit(d, "m", false).await, Err(gc_core::Error::Unsupported(_))));
    fs::remove_file(d.join(".git/hooks/pre-commit")).unwrap();
    git(d, &["config", "commit.gpgsign", "true"]);
    assert!(matches!(g.commit(d, "m", false).await, Err(gc_core::Error::Unsupported(_))));
}

#[tokio::test]
async fn capabilities가_구현한_작업만_나열한다() {
    let caps = GixBackend::new().capabilities();
    assert!(!caps.all);
    let g = GixBackend::new();
    for op in ["read_log", "read_status", "commit"] {
        assert!(g.supports(&gc_core::Op(op)));
    }
    for op in ["push", "blame", "discard", "file_log", "rebase_interactive"] {
        assert!(!g.supports(&gc_core::Op(op)), "{op}");
    }
    let d = tempfile::tempdir().unwrap();
    assert!(matches!(g.blame(d.path(), "a", None).await, Err(gc_core::Error::Unsupported(_))));
    assert!(matches!(g.file_log(d.path(), "a", 1).await, Err(gc_core::Error::Unsupported(_))));
}

/// 시험이 비어 있는 비교로 통과하지 않도록, 고정 저장소에서 기대하는 특징을 확인한다.
#[tokio::test]
async fn 고정_저장소가_시험하려는_경우를_실제로_담고_있다() {
    let tmp = fixture();
    let d = tmp.path();
    let g = GixBackend::new();
    let log = g.read_log(d, 1000, &[]).await.unwrap();
    let second = log.iter().find(|c| c.subject == "둘째").unwrap();
    assert_eq!(second.body, "본문 첫 줄 본문 둘째 줄");
    let diff = g.file_diff(d, &second.id, "a.txt", false, false).await.unwrap();
    assert_eq!(diff.matches("\n@@ ").count(), 2, "{diff}");
    let lib = g.file_diff(d, &second.id, "src/lib.rs", false, false).await.unwrap();
    assert!(lib.contains("@@ -3,6 +3,7 @@ fn alpha() {") || lib.contains("fn beta() {\n"), "{lib}");
    assert!(g.file_diff(d, &second.id, "bin.dat", false, false).await.unwrap().contains("Binary files a/bin.dat and b/bin.dat differ"));
    let rename = log.iter().find(|c| c.subject == "이름 변경과 삭제").unwrap();
    let files = g.changed_files(d, &rename.id).await.unwrap();
    assert!(files.iter().any(|f| f.status == 'R' && f.old_path.as_deref() == Some("a.txt")), "{files:?}");
    assert!(files.iter().any(|f| f.status == 'D'));
    let merge = log.iter().find(|c| c.subject == "머지 feature").unwrap();
    assert_eq!(merge.parents.len(), 2);
    assert!(!g.changed_files(d, &merge.id).await.unwrap().is_empty());
    let refs = g.read_refs(d).await.unwrap();
    let main = refs.iter().find(|r| r.name == "main").unwrap();
    assert!(main.head && main.ahead == 1 && main.behind == 1, "{main:?}");
    assert!(refs.iter().any(|r| r.name == "v2" && r.target != r.name), "주석 태그는 커밋을 가리킨다");
    assert!(refs.iter().any(|r| r.name == "stash@{0}" && r.message.as_deref().is_some_and(|m| m.contains("내 스태시"))));
    let st = g.read_status(d).await.unwrap();
    assert_eq!((st.upstream.as_deref(), st.ahead, st.behind), (Some("origin/main"), 1, 1));
}

/// 무작위(고정 시드) 파일 쌍의 diff: imara-diff와 git xdiff가 같은 hunk를 내는지.
#[tokio::test]
async fn 무작위_수정의_diff가_같다() {
    let tmp = plain_repo();
    let d = tmp.path();
    let (c, g) = backends();
    let mut seed: u64 = 0x2545F4914F6CDD1D;
    let mut next = move |m: u64| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed % m
    };
    // 줄 내용을 작은 어휘에서 뽑아 반복 줄이 많게 한다 (Myers의 모호한 경우를 건드린다)
    let vocab = ["", "}", "{", "    return x;", "fn f() {", "    let a = 1;", "    let b = 2;", "// 주석", "end", "x", "  indent", "\tTAB"];
    let mut text: Vec<String> = (0..60).map(|_| vocab[next(vocab.len() as u64) as usize].to_owned()).collect();
    write(d, "r.txt", (text.join("\n") + "\n").as_bytes());
    git_env(d, &["add", "-A"], 1);
    git_env(d, &["commit", "-q", "-m", "v0"], 1);
    for v in 1..=40u32 {
        for _ in 0..1 + next(6) {
            let pos = next(text.len() as u64 + 1) as usize;
            match next(4) {
                0 if !text.is_empty() => {
                    let pos = pos.min(text.len() - 1);
                    text.remove(pos);
                }
                1 => text.insert(pos, vocab[next(vocab.len() as u64) as usize].to_owned()),
                2 if !text.is_empty() => {
                    let pos = pos.min(text.len() - 1);
                    text[pos] = vocab[next(vocab.len() as u64) as usize].to_owned();
                }
                _ => {
                    // 블록 복제
                    let (s, l) = (next(text.len() as u64) as usize, 1 + next(4) as usize);
                    let block: Vec<String> = text.iter().skip(s).take(l).cloned().collect();
                    let at = next(text.len() as u64 + 1) as usize;
                    for (i, b) in block.into_iter().enumerate() {
                        text.insert((at + i).min(text.len()), b);
                    }
                }
            }
        }
        write(d, "r.txt", (text.join("\n") + "\n").as_bytes());
        git_env(d, &["add", "-A"], 1 + v);
        git_env(d, &["commit", "-q", "-m", &format!("v{v}")], 1 + v);
        let head = c.head_commit(d).await.unwrap();
        same(&format!("random file_diff v{v}"), c.file_diff(d, &head, "r.txt", false, false).await.unwrap(), g.file_diff(d, &head, "r.txt", false, false).await.unwrap());
    }
}

async fn run_job(b: &dyn GitBackend, d: &Path, argv: &[&str]) -> (Vec<gc_core::JobEvent>, gc_core::Result<()>) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let (handle, task) = match b.spawn_job(d, argv, None, tx) {
        Ok(s) => s,
        Err(e) => return (Vec::new(), Err(e)),
    };
    let res = task.await.unwrap();
    drop(handle);
    let mut ev = Vec::new();
    while let Ok(e) = rx.try_recv() {
        ev.push(e);
    }
    (ev, res)
}

#[tokio::test]
async fn fetch가_같다() {
    let tmp = fixture();
    let d = tmp.path();
    let (c, g) = backends();
    // 원격에 새 브랜치·새 커밋·새 태그를 만든다
    let bare = git(d, &["remote", "get-url", "origin"]).trim().to_owned();
    let other = tempfile::tempdir().unwrap();
    git(other.path(), &["clone", "-q", &bare, "."]);
    git(other.path(), &["config", "user.name", "o"]);
    git(other.path(), &["config", "user.email", "o@o"]);
    write(other.path(), "more.txt", b"more\n");
    git_env(other.path(), &["add", "-A"], 90);
    git_env(other.path(), &["commit", "-q", "-m", "원격 새 커밋"], 90);
    git(other.path(), &["switch", "-q", "-c", "newbranch"]);
    write(other.path(), "nb.txt", b"nb\n");
    git_env(other.path(), &["add", "-A"], 91);
    git_env(other.path(), &["commit", "-q", "-m", "새 브랜치"], 91);
    git(other.path(), &["tag", "remote-tag"]);
    git(other.path(), &["push", "-q", "origin", "main", "newbranch", "remote-tag"]);
    let (a, b, b2) = (copy_repo(d), copy_repo(d), copy_repo(d));
    let (ev_c, rc) = run_job(&c, a.path(), &["fetch"]).await;
    rc.unwrap();
    let (ev_g, rg) = run_job(&g, b.path(), &["-c", "fetch.writeCommitGraph=true", "fetch"]).await;
    rg.unwrap();
    assert!(matches!(ev_c.last(), Some(gc_core::JobEvent::Finished { code: Some(0) })));
    assert!(matches!(ev_g.last(), Some(gc_core::JobEvent::Finished { code: Some(0) })), "{ev_g:?}");
    let refs = |p: &Path| git(p, &["for-each-ref", "--format=%(refname) %(objectname)"]);
    assert_eq!(refs(a.path()), refs(b.path()));
    assert!(refs(b.path()).contains("refs/remotes/origin/newbranch"));
    same("fetch 뒤 refs", c.read_refs(a.path()).await.unwrap(), g.read_refs(b.path()).await.unwrap());
    git(b.path(), &["fsck", "--strict", "--no-dangling"]);
    // 이름을 준 원격
    let (_, r) = run_job(&g, b2.path(), &["fetch", "origin"]).await;
    r.unwrap();
    assert_eq!(refs(a.path()), refs(b2.path()));
    // 해석하지 않는 인자는 Unsupported
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    for argv in [&["fetch", "--all", "--prune"][..], &["pull"], &["push"], &["fetch", "--tags"]] {
        assert!(matches!(g.spawn_job(d, argv, None, tx.clone()), Err(gc_core::Error::Unsupported(_))), "{argv:?}");
    }
    // 없는 원격은 오류
    let (_, r) = run_job(&g, b2.path(), &["fetch", "nope-remote"]).await;
    assert!(r.is_err());
}

// ---- 거절해야 하는 쓰기 상황과 git과 같아야 하는 상황 (27c 리뷰) ----

fn unsupported<T>(r: gc_core::Result<T>) -> bool {
    matches!(r, Err(gc_core::Error::Unsupported(_)))
}

fn base_repo() -> tempfile::TempDir {
    let tmp = plain_repo();
    let d = tmp.path();
    write(d, "a.txt", b"a\n");
    write(d, "dir/b.txt", b"b\n");
    write(d, "other/c.txt", b"c\n");
    git(d, &["add", "-A"]);
    git_env(d, &["commit", "-q", "-m", "base"], 1);
    write(d, "a.txt", b"a2\n");
    tmp
}

#[tokio::test]
async fn intent_to_add는_커밋_트리에서_빠진다() {
    let tmp = base_repo();
    let d = tmp.path();
    write(d, "ita.txt", b"later\n");
    git(d, &["add", "-N", "ita.txt"]);
    git(d, &["add", "a.txt"]);
    let (c, g) = backends();
    let (a, b) = (copy_repo(d), copy_repo(d));
    c.commit(a.path(), "m", false).await.unwrap();
    g.commit(b.path(), "m", false).await.unwrap();
    assert_eq!(commit_info(a.path()), commit_info(b.path()));
    assert!(!git(b.path(), &["ls-tree", "-r", "--name-only", "HEAD"]).contains("ita.txt"));
    assert_same_repo_state(a.path(), b.path(), "i-t-a commit");
    // i-t-a 경로를 stage하면 실제 내용이 들어간다
    let (a, b) = (copy_repo(d), copy_repo(d));
    c.stage(a.path(), &["ita.txt".into()]).await.unwrap();
    g.stage(b.path(), &["ita.txt".into()]).await.unwrap();
    assert_same_repo_state(a.path(), b.path(), "i-t-a stage");
    let (a, b) = (copy_repo(d), copy_repo(d));
    c.unstage(a.path(), &["ita.txt".into()]).await.unwrap();
    g.unstage(b.path(), &["ita.txt".into()]).await.unwrap();
    assert_same_repo_state(a.path(), b.path(), "i-t-a unstage");
}

#[tokio::test]
async fn sparse_index는_거절한다() {
    let tmp = base_repo();
    let d = tmp.path();
    git(d, &["config", "index.sparse", "true"]);
    git(d, &["sparse-checkout", "init", "--cone", "--sparse-index"]);
    git(d, &["sparse-checkout", "set", "dir"]);
    assert!(fs::read(d.join(".git/index")).unwrap().windows(4).any(|w| w == b"sdir"), "sparse index가 만들어져야 한다");
    let before = fs::read(d.join(".git/index")).unwrap();
    let g = GixBackend::new();
    assert!(unsupported(g.stage(d, &["dir/b.txt".into()]).await));
    assert!(unsupported(g.unstage(d, &["dir/b.txt".into()]).await));
    assert!(unsupported(g.commit(d, "m", false).await));
    assert_eq!(before, fs::read(d.join(".git/index")).unwrap(), "거절하면 인덱스를 건드리지 않는다");
}

#[tokio::test]
async fn 보존_못_하는_인덱스_확장이_있으면_stage와_unstage를_거절한다() {
    let g = GixBackend::new();
    type Setup = fn(&Path);
    let cases: Vec<(&str, Setup)> = vec![
        ("split-index", |d| {
            git(d, &["update-index", "--split-index"]);
            write(d, "a.txt", b"a3\n");
            git(d, &["add", "a.txt"]);
        }),
        ("index v4", |d| {
            git(d, &["update-index", "--index-version", "4"]);
        }),
        ("resolve-undo", |d| {
            git(d, &["switch", "-q", "-c", "side"]);
            git(d, &["checkout", "-q", "--", "a.txt"]);
            write(d, "o.txt", b"side\n");
            git_env(d, &["add", "-A"], 5);
            git_env(d, &["commit", "-q", "-m", "side"], 5);
            git(d, &["switch", "-q", "main"]);
            write(d, "o.txt", b"main\n");
            git_env(d, &["add", "-A"], 6);
            git_env(d, &["commit", "-q", "-m", "main"], 6);
            let _ = Command::new("git").current_dir(d).args(["merge", "side"]).output().unwrap();
            write(d, "o.txt", b"resolved\n");
            git(d, &["add", "o.txt"]);
            git(d, &["rm", "-q", "--cached", "--ignore-unmatch", "nothing"]);
        }),
    ];
    for (name, setup) in cases {
        let tmp = base_repo();
        let d = tmp.path();
        setup(d);
        // 확장이 실제로 들어 있는지 시그니처로 확인
        let idx = fs::read(d.join(".git/index")).unwrap();
        let sig = match name {
            "split-index" => &b"link"[..],
            "resolve-undo" => b"REUC",
            _ => b"DIRC",
        };
        assert!(idx.windows(4).any(|w| w == sig), "{name}: 확장 준비 실패");
        if name == "index v4" {
            assert_eq!(&idx[4..8], &[0, 0, 0, 4]);
        }
        let before = fs::read(d.join(".git/index")).unwrap();
        assert!(unsupported(g.stage(d, &["a.txt".into()]).await), "{name} stage");
        assert!(unsupported(g.unstage(d, &["a.txt".into()]).await), "{name} unstage");
        assert_eq!(before, fs::read(d.join(".git/index")).unwrap(), "{name}: 인덱스 불변");
    }
}

#[tokio::test]
async fn tree_cache만_있는_일반_인덱스는_쓴_뒤에도_정상이다() {
    let tmp = base_repo();
    let d = tmp.path();
    git(d, &["write-tree"]); // 일부러 TREE 확장을 만든다
    assert!(fs::read(d.join(".git/index")).unwrap().windows(4).any(|w| w == b"TREE"));
    let (c, g) = backends();
    let (a, b) = (copy_repo(d), copy_repo(d));
    c.stage(a.path(), &["a.txt".into()]).await.unwrap();
    g.stage(b.path(), &["a.txt".into()]).await.unwrap();
    assert_same_repo_state(a.path(), b.path(), "tree-cache 인덱스 stage");
    // 다시 git으로 커밋해도 트리가 맞아야 한다 (낡은 tree-cache가 남지 않음)
    git_env(a.path(), &["commit", "-q", "-m", "x"], 9);
    git_env(b.path(), &["commit", "-q", "-m", "x"], 9);
    assert_eq!(git(a.path(), &["rev-parse", "HEAD^{tree}"]), git(b.path(), &["rev-parse", "HEAD^{tree}"]));
    git(b.path(), &["fsck", "--strict"]);
}

#[tokio::test]
async fn index_lock이_잡혀_있으면_쓰지_않는다() {
    let tmp = base_repo();
    let d = tmp.path();
    write(d, ".git/index.lock", b"");
    let before = fs::read(d.join(".git/index")).unwrap();
    let g = GixBackend::new();
    assert!(g.stage(d, &["a.txt".into()]).await.is_err());
    assert!(g.unstage(d, &["a.txt".into()]).await.is_err());
    assert_eq!(before, fs::read(d.join(".git/index")).unwrap());
    assert!(d.join(".git/index.lock").exists(), "남의 잠금을 지우지 않는다");
}

#[cfg(unix)]
#[tokio::test]
async fn 훅은_위치와_실행_비트와_종류를_따진다() {
    use std::os::unix::fs::PermissionsExt;
    let hook = |p: &Path, rel: &str, exec: bool| {
        write(p, rel, b"#!/bin/sh\nexit 0\n");
        fs::set_permissions(p.join(rel), fs::Permissions::from_mode(if exec { 0o755 } else { 0o644 })).unwrap();
    };
    let g = GixBackend::new();
    // 작업 트리 최상위 기준의 상대 hooksPath + 하위 디렉터리에서 연 저장소
    let tmp = base_repo();
    let d = tmp.path();
    git(d, &["config", "core.hooksPath", "myhooks"]);
    hook(d, "myhooks/pre-commit", true);
    git(d, &["add", "a.txt"]);
    assert!(unsupported(g.commit(&d.join("dir"), "m", false).await), "하위 디렉터리에서도 최상위 기준 hooksPath");
    // 실행 비트가 없으면 git도 무시하므로 커밋된다
    hook(d, "myhooks/pre-commit", false);
    g.commit(&d.join("dir"), "m", false).await.unwrap();
    // reference-transaction (commit)
    let tmp = base_repo();
    let d = tmp.path();
    git(d, &["add", "a.txt"]);
    hook(d, ".git/hooks/reference-transaction", true);
    assert!(unsupported(g.commit(d, "m", false).await));
    // post-index-change (stage·unstage)
    let tmp = base_repo();
    let d = tmp.path();
    hook(d, ".git/hooks/post-index-change", true);
    assert!(unsupported(g.stage(d, &["a.txt".into()]).await));
    assert!(unsupported(g.unstage(d, &["a.txt".into()]).await));
    // 다른 종류의 훅은 stage에 영향 없음
    let tmp = base_repo();
    let d = tmp.path();
    hook(d, ".git/hooks/pre-commit", true);
    g.stage(d, &["a.txt".into()]).await.unwrap();
}

#[tokio::test]
async fn skip_worktree와_assume_unchanged_경로는_거절한다() {
    for flag in ["--skip-worktree", "--assume-unchanged"] {
        let tmp = base_repo();
        let d = tmp.path();
        git(d, &["update-index", flag, "a.txt"]);
        let g = GixBackend::new();
        let before = fs::read(d.join(".git/index")).unwrap();
        assert!(unsupported(g.stage(d, &["a.txt".into()]).await), "{flag} stage");
        assert!(unsupported(g.unstage(d, &["a.txt".into()]).await), "{flag} unstage");
        assert_eq!(before, fs::read(d.join(".git/index")).unwrap());
        // 다른 경로는 정상
        write(d, "dir/b.txt", b"b2\n");
        g.stage(d, &["dir/b.txt".into()]).await.unwrap();
    }
}

#[cfg(unix)]
#[tokio::test]
async fn symlinks_false에서_링크_모드를_유지한다() {
    let tmp = base_repo();
    let d = tmp.path();
    std::os::unix::fs::symlink("a.txt", d.join("lnk")).unwrap();
    git(d, &["add", "lnk"]);
    git_env(d, &["commit", "-q", "-m", "link"], 2);
    git(d, &["config", "core.symlinks", "false"]);
    fs::remove_file(d.join("lnk")).unwrap();
    write(d, "lnk", b"b.txt");
    let (c, g) = backends();
    let (a, b) = (copy_repo(d), copy_repo(d));
    c.stage(a.path(), &["lnk".into()]).await.unwrap();
    g.stage(b.path(), &["lnk".into()]).await.unwrap();
    assert!(git(b.path(), &["ls-files", "-s", "lnk"]).starts_with("120000"));
    assert_same_repo_state(a.path(), b.path(), "core.symlinks=false");
}

#[tokio::test]
async fn 커밋_설정이_기본이_아니면_거절한다() {
    let g = GixBackend::new();
    for (k, v) in [("commit.cleanup", "strip"), ("i18n.commitEncoding", "euc-kr")] {
        let tmp = base_repo();
        let d = tmp.path();
        git(d, &["add", "a.txt"]);
        git(d, &["config", k, v]);
        assert!(unsupported(g.commit(d, "m", false).await), "{k}");
    }
    // 기본과 같은 값은 허용
    let tmp = base_repo();
    let d = tmp.path();
    git(d, &["add", "a.txt"]);
    git(d, &["config", "commit.cleanup", "whitespace"]);
    git(d, &["config", "i18n.commitEncoding", "UTF-8"]);
    g.commit(d, "m", false).await.unwrap();
}

#[tokio::test]
async fn fetch는_허용_키만_받고_prune_설정이면_거절한다() {
    let tmp = fixture();
    let d = tmp.path();
    let g = GixBackend::new();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    assert!(unsupported(g.spawn_job(d, &["-c", "core.sshCommand=evil", "fetch"], None, tx.clone())));
    assert!(unsupported(g.spawn_job(d, &["-c", "fetch.prune=true", "fetch"], None, tx.clone())));
    assert!(g.spawn_job(d, &["-c", "fetch.writeCommitGraph=true", "-c", "credential.https://github.com.helper=", "fetch"], None, tx.clone()).is_ok());
    // 설정으로 prune이 켜져 있으면 작업이 Unsupported로 끝난다
    for (k, v) in [("fetch.prune", "true"), ("remote.origin.prune", "true"), ("fetch.pruneTags", "true")] {
        let t = copy_repo(d);
        git(t.path(), &["config", k, v]);
        let (_, r) = run_job(&g, t.path(), &["fetch"]).await;
        assert!(unsupported(r), "{k}");
    }
    // 비대화형(ssh_batch)이어도 로컬 원격 fetch는 된다
    let t = copy_repo(d);
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let (h, task) = g.spawn_job(t.path(), &["fetch"], Some(true), tx).unwrap();
    task.await.unwrap().unwrap();
    drop(h);
    // reference-transaction 훅이 있으면 거절
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let t = copy_repo(d);
        write(t.path(), ".git/hooks/reference-transaction", b"#!/bin/sh\n");
        fs::set_permissions(t.path().join(".git/hooks/reference-transaction"), fs::Permissions::from_mode(0o755)).unwrap();
        let (_, r) = run_job(&g, t.path(), &["fetch"]).await;
        assert!(unsupported(r));
    }
}

/// 캐시 확장(untracked-cache·fsmonitor)은 버려도 git이 다시 만든다: 쓴 뒤에도 `status`가 CLI와 같다.
#[tokio::test]
async fn 캐시_확장은_버리고_status가_정상이다() {
    let (c, g) = backends();
    for name in ["untracked-cache", "fsmonitor"] {
        let tmp = base_repo();
        let d = tmp.path();
        write(d, "u/x.txt", b"x\n");
        let sig: &[u8] = if name == "untracked-cache" {
            git(d, &["config", "core.untrackedCache", "true"]);
            git(d, &["update-index", "--force-untracked-cache"]);
            git(d, &["status", "-uall"]);
            b"UNTR"
        } else {
            git(d, &["config", "core.fsmonitor", "true"]);
            if !Command::new("git").current_dir(d).args(["update-index", "--fsmonitor"]).status().unwrap().success() {
                continue; // 이 환경에서는 내장 fsmonitor를 쓸 수 없다
            }
            git(d, &["status", "-uall"]);
            b"FSMN"
        };
        assert!(fs::read(d.join(".git/index")).unwrap().windows(4).any(|w| w == sig), "{name}: 확장 준비 실패");
        let (a, b) = (copy_repo(d), copy_repo(d));
        c.stage(a.path(), &["a.txt".into()]).await.unwrap();
        g.stage(b.path(), &["a.txt".into()]).await.unwrap();
        c.unstage(a.path(), &["a.txt".into()]).await.unwrap();
        g.unstage(b.path(), &["a.txt".into()]).await.unwrap();
        write(a.path(), "u/y.txt", b"y\n");
        write(b.path(), "u/y.txt", b"y\n");
        assert_same_repo_state(a.path(), b.path(), name);
        assert!(git(b.path(), &["status", "--porcelain", "-uall"]).contains("u/y.txt"), "{name}: 새 파일을 놓치면 안 된다");
    }
}

#[tokio::test]
async fn skip_worktree는_변경_없는_항목이면_넓은_stage를_허용하고_플래그를_남긴다() {
    let tmp = base_repo();
    let d = tmp.path();
    git(d, &["update-index", "--skip-worktree", "other/c.txt"]);
    write(d, "dir/b.txt", b"b2\n");
    let g = GixBackend::new();
    g.stage(d, &[".".into()]).await.unwrap();
    assert!(git(d, &["ls-files", "-v", "other/c.txt"]).starts_with("S "), "skip-worktree 플래그 유지");
    assert!(git(d, &["diff", "--cached", "--name-only"]).contains("dir/b.txt"));
    g.unstage(d, &[".".into()]).await.unwrap();
    assert!(git(d, &["ls-files", "-v", "other/c.txt"]).starts_with("S "));
    git(d, &["fsck", "--strict", "--no-dangling"]);
}

#[tokio::test]
async fn resolve_undo가_있어도_commit은_된다() {
    let tmp = base_repo();
    let d = tmp.path();
    git(d, &["add", "-A"]);
    git_env(d, &["commit", "-q", "-m", "a2"], 3);
    git(d, &["switch", "-q", "-c", "side", "HEAD~1"]);
    write(d, "o.txt", b"side\n");
    git_env(d, &["add", "-A"], 5);
    git_env(d, &["commit", "-q", "-m", "side"], 5);
    git(d, &["switch", "-q", "main"]);
    write(d, "o.txt", b"main\n");
    git_env(d, &["add", "-A"], 6);
    git_env(d, &["commit", "-q", "-m", "main"], 6);
    let _ = Command::new("git").current_dir(d).args(["merge", "side"]).output().unwrap();
    write(d, "o.txt", b"resolved\n");
    git(d, &["add", "o.txt"]);
    fs::remove_file(d.join(".git/MERGE_HEAD")).unwrap(); // 진행 중 표시 없이 REUC만 남긴다
    assert!(fs::read(d.join(".git/index")).unwrap().windows(4).any(|w| w == b"REUC"));
    let (c, g) = backends();
    let (a, b) = (copy_repo(d), copy_repo(d));
    c.commit(a.path(), "m", false).await.unwrap();
    g.commit(b.path(), "m", false).await.unwrap();
    assert_eq!(commit_info(a.path()), commit_info(b.path()));
    git(b.path(), &["fsck", "--strict"]);
    // stage/unstage는 REUC를 보존하지 못하므로 거절
    assert!(unsupported(g.stage(d, &["o.txt".into()]).await));
}
