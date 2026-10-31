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
    // 쓰기는 `config_쓰기…`와 gix_config_env.rs가 시험한다(여기서 --global 쓰기를 부르면 사용자의 실제 전역 설정이 바뀐다)
    assert!(matches!(g.run(d, &["config", "--system", "a.b", "c"], &[]).await, Err(gc_core::Error::Unsupported(_))));
}

#[tokio::test]
async fn config_get_regexp가_같다() {
    let tmp = plain_repo();
    let d = tmp.path();
    let (c, g) = backends();
    let re = r"^remote\..*\.url$";
    let argvs: Vec<Vec<&str>> = vec![
        vec!["config", "--get-regexp", re],
        vec!["config", "--local", "--get-regexp", re],
        vec!["config", "--local", "--null", "--get-regexp", r"^(git403\..*|(diff|merge)\.tool)$"],
        vec!["config", "--global", "--null", "--get-regexp", r"^(git403\..*|(diff|merge)\.tool)$"],
    ];
    // 원격 0개: 종료 코드 1
    for a in &argvs[..3] {
        assert!(g.run(d, a, &[]).await.is_err(), "{a:?}");
        same(&format!("run {a:?}"), c.run(d, a, &[1]).await.unwrap(), g.run(d, a, &[1]).await.unwrap());
    }
    // 여러 원격 + url 여러 개 + pushurl + 대소문자 섞인 이름·서브섹션 + 사이에 낀 다른 키
    git(d, &["remote", "add", "origin", "https://example.com/a/b.git"]);
    git(d, &["remote", "add", "Up.Stream", "git@example.com:a/b.git"]);
    git(d, &["config", "--add", "remote.origin.url", "https://mirror.example.com/a/b.git"]);
    git(d, &["config", "remote.origin.pushurl", "ssh://example.com/a/b.git"]);
    git(d, &["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    git(d, &["config", "--add", "remote.origin.url", "/tmp/with space/한글 path"]);
    git(d, &["config", "git403.Alpha", "1"]);
    git(d, &["config", "diff.tool", "vimdiff"]);
    git(d, &["config", "--add", "git403.alpha", "two words"]);
    for a in &argvs[..3] {
        let (x, y) = (c.run(d, a, &[]).await.unwrap(), g.run(d, a, &[]).await.unwrap());
        assert!(!x.is_empty(), "{a:?}");
        same(&format!("run {a:?}"), x, y);
    }
    same("regexp other", c.run(d, &["config", "--get-regexp", r"^remote\.origin\..*"], &[]).await.unwrap(), g.run(d, &["config", "--get-regexp", r"^remote\.origin\..*"], &[]).await.unwrap());
    // 전역 범위: 테스트 환경의 전역 설정을 그대로 비교(없으면 둘 다 1)
    same("regexp global", c.run(d, &argvs[3], &[1]).await.unwrap(), g.run(d, &argvs[3], &[1]).await.unwrap());
    // 지원하지 않는 형태
    assert!(matches!(g.run(d, &["config", "--get-regexp", re, "value"], &[]).await, Err(gc_core::Error::Unsupported(_))));
    assert!(matches!(g.run(d, &["config", "--list"], &[]).await, Err(gc_core::Error::Unsupported(_))));
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
    for op in ["read_log", "read_status", "commit", "clone"] {
        assert!(g.supports(&gc_core::Op(op)));
    }
    for op in ["merge", "blame", "discard", "file_log", "rebase_interactive"] {
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
    for argv in [&["fetch", "--all", "--prune"][..], &["pull"], &["push", "--force"], &["fetch", "--tags"]] {
        assert!(matches!(g.spawn_job(d, argv, None, tx.clone()), Err(gc_core::Error::Unsupported(_))), "{argv:?}");
    }
    // 없는 원격은 오류
    let (_, r) = run_job(&g, b2.path(), &["fetch", "nope-remote"]).await;
    assert!(r.is_err());
}

/// 복제 결과의 비교 대상: refs·HEAD·remote/branch 설정·인덱스(모드·해시)·HEAD 트리.
fn clone_state(p: &Path) -> String {
    let cfg = |pat: &str| git(p, &["config", "--local", "--get-regexp", pat]);
    format!(
        "{}\nHEAD={}\n{}\n{}\n{}\n{}\n{}",
        git(p, &["for-each-ref", "--format=%(refname) %(objectname)"]),
        git(p, &["symbolic-ref", "HEAD"]).trim(),
        cfg("^remote\\."),
        cfg("^branch\\."),
        git(p, &["ls-files", "-s"]),
        git(p, &["ls-tree", "-r", "HEAD"]),
        // 순서와 파일 시스템을 시험해 정하는 core.precomposeunicode는 빼고 비교한다
        {
            let mut l: Vec<String> = git(p, &["config", "--local", "--list"]).lines().filter(|l| !l.starts_with("core.precomposeunicode")).map(String::from).collect();
            l.sort();
            l.join("\n")
        },
    )
}

#[tokio::test]
async fn clone이_같다() {
    let tmp = fixture();
    let bare = git(tmp.path(), &["remote", "get-url", "origin"]).trim().to_owned();
    let (c, g) = backends();
    let out = tempfile::tempdir().unwrap();
    let (po, pg) = (out.path().join("c"), out.path().join("g"));
    for (b, name, dir) in [(&c as &dyn GitBackend, "cli", "c"), (&g as &dyn GitBackend, "gix", "g")] {
        let (ev, r) = run_job(b, out.path(), &["clone", "--progress", "--", &bare, dir]).await;
        r.unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(matches!(ev.last(), Some(gc_core::JobEvent::Finished { code: Some(0) })), "{name}: {ev:?}");
    }
    let (sc, sg) = (clone_state(&po), clone_state(&pg));
    assert_eq!(sc, sg, "복제 결과가 다르다");
    assert!(sg.contains("branch.main.remote origin") && sg.contains("remote.origin.url"), "{sg}");
    for p in [&po, &pg] {
        assert_eq!(git(p, &["status", "--porcelain"]), "", "{p:?}");
        git(p, &["fsck", "--strict", "--no-dangling"]);
    }
    // 작업 트리: 파일 목록·내용·심볼릭 링크 여부
    let tree = |p: &Path| {
        git(p, &["ls-files", "-z"]).split('\0').filter(|s| !s.is_empty()).map(|f| (f.to_owned(), fs::read(p.join(f)).ok(), fs::symlink_metadata(p.join(f)).map(|m| m.file_type().is_symlink()).ok())).collect::<Vec<_>>()
    };
    assert_eq!(tree(&po), tree(&pg));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let x = |p: &Path| fs::metadata(p.join("run.sh")).unwrap().permissions().mode() & 0o111;
        assert_eq!(x(&po), x(&pg));
    }
    same("복제 뒤 refs", c.read_refs(&po).await.unwrap(), g.read_refs(&pg).await.unwrap());
    same("복제 뒤 status", c.read_status(&po).await.unwrap(), g.read_status(&pg).await.unwrap());
    same("복제 뒤 log", c.read_log(&po, 100, &[]).await.unwrap(), g.read_log(&pg, 100, &[]).await.unwrap());
    // file:// URL, 비어 있는 기존 대상, 앞에 붙는 -c credential.*
    fs::create_dir(out.path().join("e")).unwrap();
    let (_, r) = run_job(&g, out.path(), &["-c", "credential.helper=", "clone", "--", &format!("file://{bare}"), "e"]).await;
    r.unwrap();
    assert!(git(&out.path().join("e"), &["config", "remote.origin.url"]).trim() == format!("file://{bare}"));
    // 비어 있지 않은 대상은 git처럼 128로 실패하고 내용을 건드리지 않는다
    let (_, r) = run_job(&g, out.path(), &["clone", "--progress", "--", &bare, "g"]).await;
    assert!(matches!(r, Err(gc_core::Error::Exit { code: Some(128), .. })), "{r:?}");
    assert_eq!(clone_state(&pg), sg);
    // 해석하지 않는 모양과 ssh·git:// URL은 Unsupported
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    for argv in [
        &["clone", "--", &bare[..]][..],
        &["clone", &bare, "x"],
        &["clone", "--bare", "--", &bare, "x"],
        &["clone", "--depth", "1", "--", &bare, "x"],
        &["clone", "--progress", "--", "git@github.com:o/r.git", "x"],
        &["clone", "--", "ssh://git@github.com/o/r.git", "x"],
        &["clone", "--", "git://example.com/o/r.git", "x"],
        // 상대 경로(gix는 cwd 기준으로 풀어 git과 다름)·scp 형식·호스트가 있는 file URL
        &["clone", "--", "rel/path.git", "x"],
        &["clone", "--", "../origin.git", "x"],
        &["clone", "--", "host:path", "x"],
        &["clone", "--", "user@host:path/r.git", "x"],
        &["clone", "--", "file://host/path", "x"],
        #[cfg(not(windows))]
        &["clone", "--", "C:\\x", "x"],
    ] {
        assert!(matches!(g.spawn_job(out.path(), argv, None, tx.clone()), Err(gc_core::Error::Unsupported(_))), "{argv:?}");
    }
    // 없는 원격은 실패하고 디렉터리를 남기지 않는다
    let (_, r) = run_job(&g, out.path(), &["clone", "--", &format!("{bare}-nope"), "n"]).await;
    assert!(r.is_err());
    assert!(!out.path().join("n").exists());
    // 원래 있던 빈 폴더는 실패해도 남고 비어 있다
    fs::create_dir(out.path().join("keep")).unwrap();
    let (_, r) = run_job(&g, out.path(), &["clone", "--", &format!("{bare}-nope"), "keep"]).await;
    assert!(r.is_err());
    assert!(out.path().join("keep").is_dir() && fs::read_dir(out.path().join("keep")).unwrap().next().is_none());
    // 대상이 파일이면 git처럼 128
    fs::write(out.path().join("afile"), "x").unwrap();
    let (_, r) = run_job(&g, out.path(), &["clone", "--", &bare, "afile"]).await;
    assert!(matches!(r, Err(gc_core::Error::Exit { code: Some(128), .. })), "{r:?}");
}

#[tokio::test]
async fn clone을_취소하면_정리하거나_끝까지_끝낸다() {
    let tmp = fixture();
    let bare = git(tmp.path(), &["remote", "get-url", "origin"]).trim().to_owned();
    let g = GixBackend::new();
    let out = tempfile::tempdir().unwrap();
    fs::create_dir(out.path().join("pre")).unwrap();
    for dir in ["new", "pre"] {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let (handle, task) = g.spawn_job(out.path(), &["clone", "--", &bare, dir], None, tx).unwrap();
        handle.cancel();
        let d = out.path().join(dir);
        match task.await.unwrap() {
            // 취소가 먼저 닿으면: 새 폴더는 없고, 원래 있던 빈 폴더는 비어서 남는다
            Err(gc_core::Error::Cancelled) => {
                assert_eq!(d.exists(), dir == "pre", "{dir}");
                assert!(!d.exists() || fs::read_dir(&d).unwrap().next().is_none(), "{dir}");
            }
            // 취소가 늦으면 체크아웃은 끝까지 가서 성공이다(일부만 쓴 채 성공하지 않는다)
            Ok(()) => {
                assert_eq!(git(&d, &["status", "--porcelain"]), "");
                assert!(d.join("a.txt").exists());
            }
            r => panic!("{dir}: {r:?}"),
        }
    }
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

// ---- 27g(1): fetch(원격 선택)·branch·switch·pull --ff-only ----

fn out(d: &Path, args: &[&str]) -> String {
    let o = Command::new("git").current_dir(d).args(args).env("GIT_CONFIG_NOSYSTEM", "1").output().unwrap();
    String::from_utf8_lossy(&o.stdout).into_owned()
}

/// 작업 트리의 모든 파일(`.git` 제외): 경로 → (내용 또는 링크 대상, 실행 비트).
fn tree_files(d: &Path) -> std::collections::BTreeMap<String, (Vec<u8>, bool)> {
    fn walk(root: &Path, dir: &Path, out: &mut std::collections::BTreeMap<String, (Vec<u8>, bool)>) {
        for e in fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.file_name().unwrap() == ".git" {
                continue;
            }
            let m = fs::symlink_metadata(&p).unwrap();
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().into_owned();
            if m.is_dir() {
                out.insert(format!("{rel}/"), (Vec::new(), false));
                walk(root, &p, out);
            } else if m.file_type().is_symlink() {
                out.insert(rel, (fs::read_link(&p).unwrap().to_string_lossy().into_owned().into_bytes(), false));
            } else {
                #[cfg(unix)]
                let exec = std::os::unix::fs::PermissionsExt::mode(&m.permissions()) & 0o111 != 0;
                #[cfg(not(unix))]
                let exec = false;
                out.insert(rel, (fs::read(&p).unwrap(), exec));
            }
        }
    }
    let mut o = Default::default();
    walk(d, d, &mut o);
    o
}

/// 저장소 상태 전체: HEAD·refs·인덱스·status·분기 설정·reflog(HEAD와 모든 ref, 시각 제외)·작업 트리 파일.
fn snapshot(d: &Path) -> String {
    let refs = out(d, &["for-each-ref", "--format=%(refname)"]);
    let mut logs = String::new();
    // 원격 추적 ref·태그의 reflog 메시지는 fetch 구현이 다르다(문서의 한계)
    for name in std::iter::once("HEAD").chain(refs.lines().filter(|n| !n.starts_with("refs/remotes/") && !n.starts_with("refs/tags/"))) {
        logs += &format!("{name}:\n{}", out(d, &["reflog", "show", "--format=%H %gs", name, "--"]));
    }
    let cfg: String = out(d, &["config", "--local", "-l"]).lines().filter(|l| l.starts_with("branch.")).map(|l| format!("{l}\n")).collect();
    format!(
        "HEAD={}|{}\n{}\n{}\n{}\n{}\n{}\n{}",
        out(d, &["rev-parse", "HEAD"]).trim(),
        out(d, &["symbolic-ref", "-q", "HEAD"]).trim(),
        out(d, &["for-each-ref", "--format=%(refname) %(objectname)"]),
        out(d, &["ls-files", "-s", "-z"]),
        out(d, &["status", "--porcelain=v2", "-z", "--branch", "-uall"]),
        cfg,
        logs,
        tree_files(d).iter().map(|(k, (v, x))| format!("{k} {x} {:?}", String::from_utf8_lossy(&v[..v.len().min(60)]))).collect::<Vec<_>>().join("\n")
    )
}

/// 첫 번째로 다른 줄만 보여 준다.
#[track_caller]
fn assert_text(left: &str, right: &str, what: &str) {
    if left != right {
        let (l, r): (Vec<_>, Vec<_>) = (left.lines().collect(), right.lines().collect());
        let i = (0..l.len().max(r.len())).find(|&i| l.get(i) != r.get(i)).unwrap_or(0);
        panic!("{what}\n줄 {i}: cli = {:?}\n      gix = {:?}", l.get(i), r.get(i));
    }
}

/// `run` 결과 한 줄 요약: 성공 = stdout, 실패 = 종료 코드와 stderr 첫 줄(경고 줄 제외), Unsupported = 별도 표시.
/// `switch`가 끝에 붙이는 안내(`Your branch is up to date with …`)와 옮겨 가는 변경 목록(`M\tfile`)은 사람용 stdout이라 만들지 않는다(문서의 한계). 비교에서는 뺀다.
fn strip_tracking_info(argv: &[&str], r: gc_core::Result<Vec<u8>>) -> gc_core::Result<Vec<u8>> {
    if argv.first() != Some(&"switch") {
        return r;
    }
    r.map(|o| String::from_utf8_lossy(&o).lines().filter(|l| !["Your branch ", "  (use ", "  (fast-forward", "and have ", "and can be "].iter().any(|p| l.starts_with(p)) && !(l.len() > 2 && l.as_bytes()[1] == b'\t' && b"AMDRTU".contains(&l.as_bytes()[0]))).map(|l| format!("{l}\n")).collect::<String>().into_bytes())
}

fn run_outcome(r: gc_core::Result<Vec<u8>>, repo: &Path) -> String {
    let canon = repo.canonicalize().unwrap().display().to_string();
    let hide = |s: String| s.replace(&canon, "<repo>").replace(&repo.display().to_string(), "<repo>");
    hide(match r {
        Ok(o) => format!("ok {:?}", String::from_utf8_lossy(&o)),
        Err(gc_core::Error::Exit { code, stderr }) => format!("exit {code:?} {}", stderr.lines().find(|l| !l.starts_with("warning:") && !l.is_empty()).unwrap_or("")),
        Err(gc_core::Error::Unsupported(_)) => "UNSUPPORTED".to_owned(),
        Err(e) => format!("err {e:?}"),
    })
}

/// 같은 저장소 복사본 둘에 argv를 각 백엔드로 돌려 결과와 상태가 같은지 본다. 반환 = (결과 요약, gix 쪽 복사본).
async fn run_both(base: &Path, argv: &[&str]) -> (String, tempfile::TempDir) {
    let (c, g) = backends();
    let (a, b) = (copy_repo(base), copy_repo(base));
    let (rc, rg) = (run_outcome(strip_tracking_info(argv, c.run(a.path(), argv, &[]).await), a.path()), run_outcome(g.run(b.path(), argv, &[]).await, b.path()));
    assert_eq!(rc, rg, "git {argv:?}: 결과가 다르다 (왼쪽 = CliBackend)");
    let (sa, sb) = (snapshot(a.path()), snapshot(b.path()));
    assert_text(&sa, &sb, &format!("git {argv:?}: 상태가 다르다"));
    if rc.starts_with("ok") {
        git(b.path(), &["fsck", "--strict", "--no-dangling"]);
    }
    (rc, b)
}

#[tokio::test]
async fn fetch는_브랜치의_원격만_받고_원격이_없으면_같이_실패한다() {
    let tmp = fixture();
    let d = tmp.path();
    let (c, g) = backends();
    // 두 번째 원격에도 새 브랜치
    let up = d.parent().unwrap().join(format!("{}-up.git", d.file_name().unwrap().to_string_lossy()));
    git(d.parent().unwrap(), &["init", "-q", "--bare", up.to_str().unwrap()]);
    git(d, &["push", "-q", up.to_str().unwrap(), "main:upmain"]);
    git(d, &["remote", "add", "up", up.to_str().unwrap()]);
    let bare = git(d, &["remote", "get-url", "origin"]).trim().to_owned();
    let other = tempfile::tempdir().unwrap();
    git(other.path(), &["clone", "-q", &bare, "."]);
    git(other.path(), &["config", "user.name", "o"]);
    git(other.path(), &["config", "user.email", "o@o"]);
    write(other.path(), "x.txt", b"x\n");
    git_env(other.path(), &["add", "-A"], 80);
    git_env(other.path(), &["commit", "-q", "-m", "원격 새 커밋"], 80);
    git(other.path(), &["push", "-q", "origin", "main"]);
    git(d, &["switch", "-q", "-c", "onup"]);
    git(d, &["branch", "-q", "--set-upstream-to=origin/main"]); // 원격 둘, 분기의 원격은 origin
    let refs = |p: &Path| git(p, &["for-each-ref", "--format=%(refname) %(objectname)"]);
    let cases: Vec<(&str, Box<dyn Fn(&Path)>)> = vec![
        ("분기 원격(origin)", Box::new(|_| {})),
        ("detached → origin", Box::new(|p| { git(p, &["switch", "-q", "--detach", "HEAD"]); })),
        ("분기 원격이 up", Box::new(|p| { git(p, &["config", "branch.onup.remote", "up"]); git(p, &["config", "branch.onup.merge", "refs/heads/upmain"]); })),
        ("origin이 없고 up만", Box::new(|p| { git(p, &["switch", "-q", "--detach", "HEAD"]); git(p, &["remote", "remove", "origin"]); })),
    ];
    for (what, prep) in cases {
        let (a, b) = (copy_repo(d), copy_repo(d));
        prep(a.path());
        prep(b.path());
        let (_, rc) = run_job(&c, a.path(), &["fetch"]).await;
        let (_, rg) = run_job(&g, b.path(), &["fetch"]).await;
        assert_eq!(rc.is_ok(), rg.is_ok(), "{what}: {rc:?} vs {rg:?}");
        assert_eq!(refs(a.path()), refs(b.path()), "{what}");
    }
    // origin이 없고 원격이 둘 이상이면 git이 고르는 원격을 알 수 없어 거절
    let b = copy_repo(d);
    git(b.path(), &["switch", "-q", "--detach", "HEAD"]);
    git(b.path(), &["remote", "rename", "origin", "elsewhere"]);
    let (_, r) = run_job(&g, b.path(), &["fetch"]).await;
    assert!(matches!(r, Err(gc_core::Error::Unsupported(_))), "{r:?}");
    // fetch.all은 모든 원격을 받으므로 거절
    let b = copy_repo(d);
    git(b.path(), &["config", "fetch.all", "true"]);
    let (_, r) = run_job(&g, b.path(), &["fetch"]).await;
    assert!(matches!(r, Err(gc_core::Error::Unsupported(_))), "{r:?}");
}

#[tokio::test]
async fn branch_만들기가_같다() {
    let tmp = fixture();
    let d = tmp.path();
    git(d, &["fetch", "-q"]);
    for argv in [
        &["branch", "nb"][..],
        &["branch", "nb", "HEAD~1"],
        &["branch", "nb", "v1"],
        &["branch", "nb", "v2"], // 주석 태그
        &["branch", "nb", "feature"],
        &["branch", "nb", "origin/feature"], // 원격 브랜치 → 추적 설정
        &["branch", "nb", "origin/main"],
        &["branch", "한글/브랜치", "main~2"],
        &["branch", "main"], // 이미 있음
        &["branch", "bad..name"],
        &["branch", "nb", "nosuch"],
        &["branch", "nb", "HEAD:a.txt"], // 커밋이 아님
        &["branch", "HEAD"],
    ] {
        run_both(d, argv).await;
    }
    // 해석하지 않는 모양은 거절
    for argv in [&["branch", "-x"][..], &["branch"], &["branch", "-d"], &["branch", "-d", "a", "b"], &["branch", "--list"], &["branch", "-m", "a"], &["branch", "-f", "a", "b"], &["branch", "--set-upstream-to=origin/main"]] {
        assert!(unsupported(GixBackend::new().run(d, argv, &[]).await), "{argv:?}");
    }
    // 시작점 인자는 준 문자열 그대로 reflog에 남는다
    let (_, b) = run_both(d, &["branch", "nb", "main~1"]).await;
    assert!(out(b.path(), &["reflog", "show", "nb"]).contains("branch: Created from main~1"));
    // autoSetupMerge 설정: false면 추적 안 함, always는 거절
    let (a, b) = (copy_repo(d), copy_repo(d));
    for p in [a.path(), b.path()] {
        git(p, &["config", "branch.autoSetupMerge", "false"]);
    }
    let (c, g) = backends();
    c.run(a.path(), &["branch", "nb", "origin/main"], &[]).await.unwrap();
    g.run(b.path(), &["branch", "nb", "origin/main"], &[]).await.unwrap();
    assert_text(&snapshot(a.path()), &snapshot(b.path()), "autoSetupMerge=false");
    git(b.path(), &["config", "branch.autoSetupMerge", "always"]);
    assert!(unsupported(g.run(b.path(), &["branch", "nb2", "origin/main"], &[]).await));
    // 커밋 없는 저장소
    let e = plain_repo();
    run_both(e.path(), &["branch", "nb"]).await;
    // 훅
    let h = copy_repo(d);
    write(h.path(), ".git/hooks/reference-transaction", b"#!/bin/sh\nexit 0\n");
    #[cfg(unix)]
    fs::set_permissions(h.path().join(".git/hooks/reference-transaction"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    #[cfg(unix)]
    assert!(unsupported(g.run(h.path(), &["branch", "nb"], &[]).await));
}

#[tokio::test]
async fn branch_지우기가_같다() {
    let tmp = fixture();
    let d = tmp.path();
    git(d, &["branch", "merged", "HEAD~1"]);
    git(d, &["branch", "unmerged", "feature"]);
    git(d, &["switch", "-q", "unmerged"]);
    write(d, "um.txt", b"u\n");
    git_env(d, &["add", "-A"], 70);
    git_env(d, &["commit", "-q", "-m", "unmerged 커밋"], 70);
    git(d, &["switch", "-q", "main"]);
    git(d, &["branch", "--set-upstream-to=origin/feature", "feature"]);
    for argv in [
        &["branch", "-d", "merged"][..],
        &["branch", "-D", "merged"],
        &["branch", "-d", "unmerged"],
        &["branch", "-D", "unmerged"],
        &["branch", "-d", "feature"], // 업스트림에 합쳐짐
        &["branch", "-d", "main"],    // 현재 브랜치
        &["branch", "-D", "main"],
        &["branch", "-d", "nosuch"],
        &["branch", "-D", "bad..name"],
    ] {
        run_both(d, argv).await;
    }
    // 추적 설정이 있는 브랜치를 지우면 설정 절도 사라진다
    let (_, b) = run_both(d, &["branch", "-D", "feature"]).await;
    assert!(!out(b.path(), &["config", "--local", "-l"]).contains("branch.feature."));
    // detached HEAD에서는 HEAD에 합쳐졌는지로 판단
    let det = copy_repo(d);
    git(det.path(), &["switch", "-q", "--detach", "v2"]);
    run_both(det.path(), &["branch", "-d", "merged"]).await;
    run_both(det.path(), &["branch", "-d", "unmerged"]).await;
    // 다른 worktree가 있으면 거절
    let w = copy_repo(d);
    let wt = tempfile::tempdir().unwrap();
    git(w.path(), &["worktree", "add", "-q", wt.path().join("w").to_str().unwrap(), "merged"]);
    assert!(unsupported(GixBackend::new().run(w.path(), &["branch", "-d", "merged"], &[]).await));
}

#[tokio::test]
async fn branch_이름_바꾸기가_같다() {
    let tmp = fixture();
    let d = tmp.path();
    git(d, &["branch", "side", "HEAD~1"]);
    git(d, &["branch", "--set-upstream-to=origin/feature", "side"]);
    for argv in [
        &["branch", "-m", "side", "side2"][..],
        &["branch", "-m", "side", "x/y"],
        &["branch", "-m", "main", "trunk"], // 현재 브랜치 (HEAD·추적 설정·reflog)
        &["branch", "-m", "feature", "main"], // 이미 있음
        &["branch", "-m", "nosuch", "z"],
        &["branch", "-m", "side", "bad..name"],
        &["branch", "-m", "side", "한글"],
    ] {
        run_both(d, argv).await;
    }
    let (_, b) = run_both(d, &["branch", "-m", "main", "trunk"]).await;
    let log = out(b.path(), &["reflog", "show", "HEAD", "-1"]);
    assert!(log.contains("Branch: renamed refs/heads/main to refs/heads/trunk"), "{log}");
    assert!(unsupported(GixBackend::new().run(d, &["branch", "-m", "side", "side"], &[]).await));
    // 이름을 바꾼 뒤 지우기·만들기도 이어서 같다
    let (_, b) = run_both(d, &["branch", "-m", "side", "side2"]).await;
    run_both(b.path(), &["branch", "-d", "side2"]).await;
    run_both(b.path(), &["branch", "side", "side2"]).await;
}

/// 스위치 시험용: 파일↔폴더·실행 비트·링크·삭제·개행이 서로 다른 브랜치 둘을 더한 저장소.
fn switch_fixture() -> tempfile::TempDir {
    let tmp = fixture();
    let d = tmp.path();
    git(d, &["fetch", "-q"]);
    git(d, &["switch", "-q", "-c", "shape", "v1"]);
    // v1에는 없던 구조: 파일 `x`가 폴더로, 폴더 `ord`가 파일로
    write(d, "x", b"file x\n");
    write(d, "ord", b"ord is a file\n");
    write(d, "deep/er/est/f.txt", b"deep\n");
    git_env(d, &["add", "-A"], 71);
    git_env(d, &["commit", "-q", "-m", "shape 1"], 71);
    git(d, &["switch", "-q", "-c", "shape2", "main"]);
    fs::remove_file(d.join("x")).ok();
    write(d, "x/y/z.txt", b"x is a dir\n");
    git(d, &["rm", "-q", "-r", "--cached", "ord"]);
    fs::remove_dir_all(d.join("deep")).ok();
    git(d, &["add", "-A"], );
    git_env(d, &["commit", "-q", "-m", "shape 2"], 72);
    git(d, &["switch", "-q", "main"]);
    tmp
}

#[tokio::test]
async fn switch가_같다() {
    let tmp = switch_fixture();
    let d = tmp.path();
    for argv in [
        &["switch", "feature"][..],
        &["switch", "shape"],
        &["switch", "shape2"],
        &["switch", "-c", "n1"],
        &["switch", "-c", "n2", "v1"],
        &["switch", "-c", "n3", "origin/feature"], // 추적
        &["switch", "-c", "n4", "--track", "origin/main"],
        &["switch", "-c", "n5", "HEAD~3"],
        &["switch", "-c", "n6", "feature"],
        &["switch", "-c", "n7", "shape"],
        &["switch", "-c", "n8", "v2"],
        &["switch", "--detach", "v1"],
        &["switch", "--detach", "HEAD~2"],
        &["switch", "--detach", "origin/feature"],
        &["switch", "--detach", "shape2"],
        &["switch", "--detach", "HEAD"],
        // 오류
        &["switch", "nosuch"],
        &["switch", "origin/main"],
        &["switch", "-c", "main"],
        &["switch", "-c", "x", "nosuch"],
        &["switch", "-c", "bad..name"],
        &["switch", "--detach", "nosuch"],
    ] {
        let (r, _) = run_both(d, argv).await;
        assert_ne!(r, "UNSUPPORTED", "{argv:?}");
    }
    // 이어서 옮기기: 구조가 서로 바뀌는 브랜치를 오가며 같다
    let mut cur = copy_repo(d);
    let (c, g) = backends();
    let mut cli = copy_repo(d);
    for name in ["shape", "shape2", "feature", "shape", "main", "shape2", "shape"] {
        let (rc, rg) = (c.run(cli.path(), &["switch", name], &[]).await, g.run(cur.path(), &["switch", name], &[]).await);
        assert_eq!(run_outcome(strip_tracking_info(&["switch"], rc), cli.path()), run_outcome(rg, cur.path()), "switch {name}");
        assert_text(&snapshot(cli.path()), &snapshot(cur.path()), &format!("switch {name} 뒤"));
        git(cur.path(), &["fsck", "--strict", "--no-dangling"]);
        let _ = (&mut cli, &mut cur);
    }
    // 이어서 git 자신이 쓰는 후속 명령도 정상: 커밋
    git_env(cur.path(), &["commit", "--allow-empty", "-q", "-m", "후속"], 99);
    assert_eq!(out(cur.path(), &["status", "--porcelain"]), "");
}

#[tokio::test]
async fn switch_변경이_있으면_거절하고_같은_트리면_허용한다() {
    let tmp = switch_fixture();
    let d = tmp.path();
    let g = GixBackend::new();
    // 추적 파일 변경(작업 트리·스테이지)이 있고 트리가 다르면 거절
    for prep in [
        |p: &Path| write(p, "renamed.txt", b"changed\n"),
        |p: &Path| {
            write(p, "renamed.txt", b"changed\n");
            git(p, &["add", "renamed.txt"]);
        },
        |p: &Path| fs::remove_file(p.join("renamed.txt")).unwrap(),
    ] {
        let b = copy_repo(d);
        prep(b.path());
        for argv in [&["switch", "feature"][..], &["switch", "-c", "nn", "v1"], &["switch", "--detach", "v1"]] {
            assert!(unsupported(g.run(b.path(), argv, &[]).await), "{argv:?}");
        }
    }
    // 새 브랜치를 같은 커밋(같은 트리)에서 만드는 것은 변경이 있어도 git과 같다
    let dirty_repo = copy_repo(d);
    write(dirty_repo.path(), "renamed.txt", b"changed\n");
    write(dirty_repo.path(), "new.txt", b"n\n");
    git(dirty_repo.path(), &["add", "new.txt"]);
    for argv in [&["switch", "-c", "same"][..], &["switch", "-c", "same", "HEAD"], &["switch", "-c", "same", "main"], &["switch", "--detach", "HEAD"]] {
        run_both(dirty_repo.path(), argv).await;
    }
    // 추적 안 하는 파일: 안 겹치면 그대로 두고, 겹치면 거절(git도 막는다)
    let u = copy_repo(d);
    write(u.path(), "untracked-ok.txt", b"u\n");
    run_both(u.path(), &["switch", "feature"]).await;
    let (c, g2) = backends();
    for (path, content) in [("feature.txt", &b"mine\n"[..]), ("deep/er/est/f.txt", b"mine\n")] {
        let (a, b) = (copy_repo(d), copy_repo(d));
        git(a.path(), &["switch", "-q", "main"]);
        for p in [a.path(), b.path()] {
            write(p, path, content);
        }
        let target = if path == "feature.txt" { "feature" } else { "shape" };
        assert!(c.run(a.path(), &["switch", target], &[]).await.is_err(), "git도 막는다: {path}");
        assert!(unsupported(g2.run(b.path(), &["switch", target], &[]).await), "{path}");
        assert_eq!(fs::read(b.path().join(path)).unwrap(), content); // 아무것도 안 건드림
    }
    // 폴더 안의 추적 안 하는 파일은 폴더째 지워지지 않고 거절된다 (shape → main에서 deep/ 아래)
    let s = copy_repo(d);
    git(s.path(), &["switch", "-q", "shape"]);
    write(s.path(), "deep/untracked.txt", b"u\n");
    run_both(s.path(), &["switch", "main"]).await;
    // 훅·진행 중인 작업
    let h = copy_repo(d);
    write(h.path(), ".git/hooks/post-checkout", b"#!/bin/sh\nexit 0\n");
    #[cfg(unix)]
    {
        fs::set_permissions(h.path().join(".git/hooks/post-checkout"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        assert!(unsupported(g.run(h.path(), &["switch", "feature"], &[]).await));
    }
    let m = copy_repo(d);
    let _ = Command::new("git").current_dir(m.path()).args(["merge", "--no-commit", "--no-ff", "shape"]).output();
    assert!(unsupported(g.run(m.path(), &["switch", "-c", "zz"], &[]).await));
    // 이미 그 브랜치에 있음·커밋 없는 저장소·다른 worktree
    assert!(unsupported(g.run(d, &["switch", "main"], &[]).await));
    let e = plain_repo();
    assert!(unsupported(g.run(e.path(), &["switch", "-c", "x"], &[]).await));
    let w = copy_repo(d);
    let wt = tempfile::tempdir().unwrap();
    git(w.path(), &["worktree", "add", "-q", wt.path().join("w").to_str().unwrap(), "feature"]);
    assert!(unsupported(g.run(w.path(), &["switch", "shape"], &[]).await));
    // skip-worktree·sparse·filter 속성
    let sk = copy_repo(d);
    git(sk.path(), &["update-index", "--skip-worktree", "renamed.txt"]);
    assert!(unsupported(g.run(sk.path(), &["switch", "feature"], &[]).await));
    let f = copy_repo(d);
    git(f.path(), &["switch", "-q", "-c", "filt"]);
    write(f.path(), ".gitattributes", b"*.dat filter=lfs\n");
    git_env(f.path(), &["add", ".gitattributes"], 98);
    git_env(f.path(), &["commit", "-q", "-m", "attrs"], 98);
    git(f.path(), &["switch", "-q", "main"]);
    assert!(unsupported(g.run(f.path(), &["switch", "filt"], &[]).await));
}

#[tokio::test]
async fn switch가_개행_변환과_링크_모드를_git처럼_쓴다() {
    for (autocrlf, attrs) in [("true", ""), ("input", ""), ("false", "* text=auto eol=crlf\n*.sh text eol=lf\n*.bin -text\n")] {
        let tmp = plain_repo();
        let d = tmp.path();
        git(d, &["config", "core.autocrlf", autocrlf]);
        if !attrs.is_empty() {
            write(d, ".gitattributes", attrs.as_bytes());
        }
        write(d, "t.txt", b"one\r\ntwo\r\n");
        write(d, "s.sh", b"#!/bin/sh\necho\n");
        write(d, "p.bin", &[1, 13, 10, 2]);
        git(d, &["add", "-A"]);
        git_env(d, &["commit", "-q", "-m", "c1"], 1);
        git(d, &["switch", "-q", "-c", "other"]);
        write(d, "t.txt", b"one\ntwo\nthree\n");
        write(d, "s.sh", b"#!/bin/sh\necho 2\n");
        write(d, "p.bin", &[1, 13, 10, 3]);
        git(d, &["add", "-A"]);
        git_env(d, &["commit", "-q", "-m", "c2"], 2);
        git(d, &["switch", "-q", "main"]);
        for argv in [&["switch", "other"][..], &["switch", "-c", "n", "other"], &["switch", "--detach", "other"]] {
            run_both(d, argv).await;
        }
    }
}

#[tokio::test]
async fn switch가_core_filemode_false에서도_같다() {
    let tmp = switch_fixture();
    let d = tmp.path();
    git(d, &["config", "core.filemode", "false"]);
    for argv in [&["switch", "feature"][..], &["switch", "shape"]] {
        run_both(d, argv).await;
    }
}

/// pull 시험용: 로컬(`work`)과 원격에 새 커밋·파일·삭제·태그·다른 브랜치를 올리는 다른 클론.
fn pull_fixture() -> (tempfile::TempDir, std::path::PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("r");
    fs::create_dir(&root).unwrap();
    let bare = root.join("o.git");
    git(&root, &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()]);
    let work = root.join("work");
    git(&root, &["clone", "-q", bare.to_str().unwrap(), "work"]);
    for (k, v) in [("user.name", "w"), ("user.email", "w@w"), ("core.autocrlf", "false")] {
        git(&work, &["config", k, v]);
    }
    write(&work, "a.txt", numbered(10, "").as_bytes());
    write(&work, "gone.txt", b"gone\n");
    write(&work, "run.sh", b"#!/bin/sh\n");
    write(&work, "dir/sub.txt", b"sub\n");
    git(&work, &["add", "-A"]);
    git_env(&work, &["commit", "-q", "-m", "c1"], 1);
    git(&work, &["branch", "-M", "main"]);
    git(&work, &["push", "-q", "-u", "origin", "main"]);
    git(&work, &["switch", "-q", "-c", "topic"]);
    git(&work, &["push", "-q", "-u", "origin", "topic"]);
    git(&work, &["switch", "-q", "main"]);
    let other = root.join("other");
    git(&root, &["clone", "-q", bare.to_str().unwrap(), "other"]);
    for (k, v) in [("user.name", "o"), ("user.email", "o@o")] {
        git(&other, &[ "config", k, v]);
    }
    write(&other, "a.txt", numbered(10, " 바뀜").as_bytes());
    fs::remove_file(other.join("gone.txt")).unwrap();
    write(&other, "new/deeper/n.txt", b"n\n");
    fs::remove_dir_all(other.join("dir")).unwrap();
    write(&other, "dir", b"dir became a file\n");
    git(&other, &["add", "-A"]);
    git_env(&other, &["commit", "-q", "-m", "원격 c2"], 2);
    git(&other, &["tag", "-a", "rt", "-m", "t"]);
    git(&other, &["switch", "-q", "-c", "topic2"]);
    write(&other, "t2.txt", b"t2\n");
    git(&other, &["add", "-A"]);
    git_env(&other, &["commit", "-q", "-m", "topic2"], 3);
    git(&other, &["push", "-q", "origin", "main", "topic2", "rt"]);
    (tmp, work)
}

async fn pull_both(work: &Path, argv: &[&str]) -> (String, tempfile::TempDir) {
    let (c, g) = backends();
    let (a, b) = (copy_repo(work), copy_repo(work));
    let (ev_c, rc) = run_job(&c, a.path(), argv).await;
    let (ev_g, rg) = run_job(&g, b.path(), argv).await;
    let _ = (ev_c, ev_g);
    let kind = |r: &gc_core::Result<()>| match r {
        Ok(()) => "ok".to_owned(),
        Err(gc_core::Error::Exit { code, stderr }) => format!("exit {code:?} {}", if stderr.contains("Not possible to fast-forward") { "no-ff" } else { stderr.lines().last().unwrap_or("") }),
        Err(gc_core::Error::Unsupported(_)) => "UNSUPPORTED".to_owned(),
        Err(e) => format!("{e:?}"),
    };
    let rg_kind = kind(&rg);
    // git은 스크립트가 아니라 사람에게 보이는 메시지라 종류(성공·ff 불가·그 밖의 실패)만 맞춘다
    let rc_kind = kind(&rc);
    if rg_kind == "UNSUPPORTED" {
        return (rg_kind, b);
    }
    assert_eq!(rc.is_ok(), rg.is_ok(), "git {argv:?}: {rc_kind} vs {rg_kind}");
    if rc.is_err() {
        assert_eq!(rc_kind.starts_with("exit") && rc_kind.contains("no-ff"), rg_kind.contains("no-ff"), "git {argv:?}: {rc_kind} vs {rg_kind}");
    }
    let (sa, sb) = (snapshot(a.path()), snapshot(b.path()));
    // FETCH_HEAD·reflog의 fetch 줄은 구현이 다르다(문서의 한계): 나머지 상태는 같아야 한다
    let strip = |s: &str| s.lines().filter(|l| !l.contains("fetch ") && !l.contains("fetch:") && !l.contains("storing head")).collect::<Vec<_>>().join("\n");
    assert_text(&strip(&sa), &strip(&sb), &format!("git {argv:?}: 상태가 다르다"));
    if rg.is_ok() {
        git(b.path(), &["fsck", "--strict", "--no-dangling"]);
    }
    (rg_kind, b)
}

#[tokio::test]
async fn pull_ff_only가_같다() {
    let (_keep, work) = pull_fixture();
    // 뒤처진 상태에서 fast-forward (인자 있음/없음, --progress)
    for argv in [
        &["pull", "--progress", "--ff-only", "origin", "main"][..],
        &["pull", "--ff-only", "origin", "main"],
        &["pull", "--ff-only"],
        &["pull", "--progress", "--ff-only"],
        &["pull", "--ff-only", "origin", "topic2"], // 현재 브랜치와 갈라진 다른 브랜치 → 갈라짐 또는 합쳐짐
    ] {
        let (k, _) = pull_both(&work, argv).await;
        assert_ne!(k, "UNSUPPORTED", "{argv:?}");
    }
    // 반영된 결과 확인
    let (k, b) = pull_both(&work, &["pull", "--progress", "--ff-only", "origin", "main"]).await;
    assert_eq!(k, "ok");
    assert!(fs::read_to_string(b.path().join("dir")).unwrap().contains("became a file"));
    assert!(!b.path().join("gone.txt").exists());
    assert_eq!(git(b.path(), &["status", "--porcelain"]), "");
    assert!(out(b.path(), &["reflog", "show", "main", "-1"]).contains("pull --progress --ff-only origin main: Fast-forward"));
    // 이미 최신
    let (_, b) = pull_both(&work, &["pull", "--ff-only"]).await;
    let (k, _) = pull_both(b.path(), &["pull", "--ff-only"]).await;
    assert_eq!(k, "ok");
    // 로컬이 앞서 있으면 이미 최신 (갈라지지 않음)
    let ahead = copy_repo(&work);
    write(ahead.path(), "ahead.txt", b"a\n");
    git(ahead.path(), &["add", "-A"]);
    git_env(ahead.path(), &["commit", "-q", "-m", "ahead"], 5);
    let _ = pull_both(ahead.path(), &["pull", "--ff-only", "origin", "topic"]).await;
    // 갈라짐: 같은 종류의 실패, 받은 ref는 갱신됨
    let div = copy_repo(&work);
    git(div.path(), &["commit", "--allow-empty", "-q", "-m", "로컬만"]);
    for argv in [&["pull", "--ff-only"][..], &["pull", "--progress", "--ff-only", "origin", "main"]] {
        let (k, b) = pull_both(div.path(), argv).await;
        assert!(k.contains("no-ff"), "{k}");
        assert!(out(b.path(), &["for-each-ref", "refs/remotes/origin/main", "--format=%(objectname)"]) != out(div.path(), &["for-each-ref", "refs/remotes/origin/main", "--format=%(objectname)"]));
    }
    // 원격 태그: 인자 없는 pull은 태그를 따라온다
    let (_, b) = pull_both(&work, &["pull", "--ff-only"]).await;
    assert!(out(b.path(), &["tag"]).contains("rt"));
}

#[tokio::test]
async fn pull은_맞지_않는_모양과_조건을_거절한다() {
    let (_keep, work) = pull_fixture();
    let g = GixBackend::new();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    for argv in [
        &["pull"][..],
        &["pull", "--progress"],
        &["pull", "--rebase", "--ff-only"],
        &["pull", "--ff-only", "--autostash"],
        &["pull", "--progress", "--no-rebase", "origin", "main"],
        &["pull", "--ff-only", "origin"],
        &["pull", "--ff-only", "origin", "main", "extra"],
        &["pull", "--progress", "--autostash", "--ff-only"],
    ] {
        assert!(matches!(g.spawn_job(&work, argv, None, tx.clone()), Err(gc_core::Error::Unsupported(_))), "{argv:?}");
    }
    let sets: Vec<(&str, Box<dyn Fn(&Path)>)> = vec![
        ("로컬 변경", Box::new(|p| write(p, "a.txt", b"local\n"))),
        ("pull.rebase", Box::new(|p| { git(p, &["config", "pull.rebase", "true"]); })),
        ("branch.rebase", Box::new(|p| { git(p, &["config", "branch.main.rebase", "merges"]); })),
        ("merge ref를 안 덮는 fetch refspec", Box::new(|p| { git(p, &["config", "remote.origin.fetch", "+refs/heads/topic:refs/remotes/origin/topic"]); })),
        ("서브모듈 설정", Box::new(|p| { git(p, &["config", "submodule.recurse", "true"]); })),
        (".gitmodules", Box::new(|p| write(p, ".gitmodules", b"[submodule \"s\"]\n\tpath = s\n\turl = ../s\n"))),
        ("추적 정보 없음", Box::new(|p| { git(p, &["branch", "--unset-upstream"]); })),
        ("detached", Box::new(|p| { git(p, &["switch", "-q", "--detach"]); })),
        ("훅", Box::new(|p| { write(p, ".git/hooks/post-merge", b"#!/bin/sh\n"); #[cfg(unix)] fs::set_permissions(p.join(".git/hooks/post-merge"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap(); })),
    ];
    for (what, prep) in sets {
        let b = copy_repo(&work);
        prep(b.path());
        let before = out(b.path(), &["for-each-ref", "--format=%(refname) %(objectname)"]);
        let (_, r) = run_job(&g, b.path(), &["pull", "--ff-only"]).await;
        #[cfg(not(unix))]
        let _ = what;
        if what == "훅" && !cfg!(unix) {
            continue;
        }
        assert!(matches!(r, Err(gc_core::Error::Unsupported(_))), "{what}: {r:?}");
        // 거절하면 받지도 않는다
        assert_eq!(before, out(b.path(), &["for-each-ref", "--format=%(refname) %(objectname)"]), "{what}");
    }
}

#[tokio::test]
async fn capabilities가_27g1_작업을_나열한다() {
    let g = GixBackend::new();
    for op in ["fetch", "branch", "switch", "pull", "push"] {
        assert!(g.supports(&gc_core::Op(op)), "{op}");
    }
    for op in ["merge", "stash", "checkout"] {
        assert!(!g.supports(&gc_core::Op(op)), "{op}");
    }
}

#[tokio::test]
async fn fetch가_빈_원격과_HEAD가_없는_브랜치를_가리키는_원격에서도_같다() {
    let (c, g) = backends();
    for unborn in [false, true] {
        let tmp = tempfile::tempdir().unwrap();
        let bare = tmp.path().join("o.git");
        git(tmp.path(), &["init", "-q", "--bare", "-b", "trunk", bare.to_str().unwrap()]);
        let seed = tmp.path().join("seed");
        fs::create_dir(&seed).unwrap();
        git(&seed, &["init", "-q", "-b", "main"]);
        git(&seed, &["config", "user.name", "s"]);
        git(&seed, &["config", "user.email", "s@s"]);
        if unborn {
            write(&seed, "f", b"1\n");
            git(&seed, &["add", "-A"]);
            git_env(&seed, &["commit", "-q", "-m", "c"], 1);
            git(&seed, &["push", "-q", bare.to_str().unwrap(), "main"]); // 원격 HEAD는 trunk(없음)
        }
        let local = tmp.path().join("local");
        fs::create_dir(&local).unwrap();
        git(&local, &["init", "-q", "-b", "main"]);
        git(&local, &["remote", "add", "origin", bare.to_str().unwrap()]);
        let (a, b) = (copy_repo(&local), copy_repo(&local));
        let (_, rc) = run_job(&c, a.path(), &["fetch"]).await;
        let (_, rg) = run_job(&g, b.path(), &["fetch"]).await;
        assert_eq!(rc.is_ok(), rg.is_ok(), "unborn={unborn}: {rc:?} vs {rg:?}");
        assert_eq!(out(a.path(), &["for-each-ref"]), out(b.path(), &["for-each-ref"]), "unborn={unborn}");
    }
}

// ---- 27g(1) 리뷰 반영: 잠금·롤백·git과의 차이 ----

fn no_lock_files(d: &Path) {
    for f in ["config.lock", "HEAD.lock", "index.lock"] {
        assert!(!d.join(".git").join(f).exists(), "{f}가 남았다");
    }
}

fn config_of(d: &Path) -> Vec<u8> {
    fs::read(d.join(".git/config")).unwrap()
}

#[tokio::test]
async fn ref_잠금이_잡혀_있으면_설정과_reflog를_안_건드리고_잠금을_남기지_않는다() {
    let tmp = switch_fixture();
    let d = tmp.path();
    git(d, &["fetch", "-q"]);
    let g = GixBackend::new();
    // 이미 설정 잠금이 있으면 오류, 아무것도 안 바뀜
    let b = copy_repo(d);
    write(b.path(), ".git/config.lock", b"");
    let before = snapshot(b.path());
    assert!(g.run(b.path(), &["branch", "nb", "origin/main"], &[]).await.is_err());
    assert!(g.run(b.path(), &["branch", "-d", "feature"], &[]).await.is_err());
    assert_eq!(before, snapshot(b.path()));
    // ref 잠금 때문에 ref 트랜잭션이 실패하면 설정은 그대로이고 config.lock은 사라진다
    for (argv, lock) in [
        (&["branch", "nb", "origin/main"][..], "refs/heads/nb.lock"), // 생성 + 추적 설정
        (&["branch", "-D", "feature"], "refs/heads/feature.lock"),    // 삭제 + 설정 절 제거
        (&["branch", "-m", "feature", "feat2"], "refs/heads/feat2.lock"), // 이름 바꾸기
        (&["branch", "-m", "main", "trunk"], "HEAD.lock"),
    ] {
        let b = copy_repo(d);
        write(b.path(), &format!(".git/{lock}"), b"");
        let (cfg, snap) = (config_of(b.path()), snapshot(b.path()));
        let r = g.run(b.path(), argv, &[]).await;
        assert!(r.is_err() && !unsupported(r), "{argv:?}");
        assert_eq!(cfg, config_of(b.path()), "{argv:?}: 설정이 바뀌었다");
        assert_eq!(snap, snapshot(b.path()), "{argv:?}");
        assert!(!b.path().join(".git/config.lock").exists(), "{argv:?}: config.lock이 남았다");
    }
}

#[tokio::test]
async fn switch와_pull은_ref_잠금이_안_잡히면_작업_트리를_안_건드린다() {
    let tmp = switch_fixture();
    let d = tmp.path();
    let g = GixBackend::new();
    for (argv, lock) in [
        (&["switch", "shape"][..], "HEAD.lock"),
        (&["switch", "-c", "n", "shape"], "refs/heads/n.lock"),
        (&["switch", "--detach", "shape"], "HEAD.lock"),
    ] {
        let b = copy_repo(d);
        write(b.path(), &format!(".git/{lock}"), b"");
        let snap = snapshot(b.path());
        let r = g.run(b.path(), argv, &[]).await;
        assert!(r.is_err() && !unsupported(r), "{argv:?}");
        assert_eq!(snap, snapshot(b.path()), "{argv:?}: 작업 트리나 인덱스가 바뀌었다");
        assert!(!b.path().join(".git/index.lock").exists());
    }
    // 추적 설정이 있는 -c: ref 잠금이 실패하면 설정도 그대로
    let b = copy_repo(d);
    git(b.path(), &["fetch", "-q"]);
    write(b.path(), ".git/refs/heads/t.lock", b"");
    let (cfg, snap) = (config_of(b.path()), snapshot(b.path()));
    assert!(g.run(b.path(), &["switch", "-c", "t", "--track", "origin/feature"], &[]).await.is_err());
    assert_eq!((cfg, snap), (config_of(b.path()), snapshot(b.path())));
    assert!(!b.path().join(".git/config.lock").exists());
    // pull: 받은 뒤 ref 잠금이 안 잡히면 작업 트리와 브랜치는 그대로(받은 추적 ref는 갱신됨)
    let (_keep, work) = pull_fixture();
    let b = copy_repo(&work);
    write(b.path(), ".git/HEAD.lock", b"");
    let (files, head) = (tree_files(b.path()), out(b.path(), &["rev-parse", "refs/heads/main"]));
    let (_, r) = run_job(&g, b.path(), &["pull", "--ff-only"]).await;
    assert!(r.is_err() && !matches!(r, Err(gc_core::Error::Unsupported(_))), "{r:?}");
    assert_eq!((files, head), (tree_files(b.path()), out(b.path(), &["rev-parse", "refs/heads/main"])));
}

#[cfg(unix)]
#[tokio::test]
async fn switch가_중간에_실패하면_작업_트리를_되돌린다() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = switch_fixture();
    let d = tmp.path();
    git(d, &["switch", "-q", "-c", "ro1"]);
    write(d, "ro/keep", b"keep
");
    git_env(d, &["add", "-A"], 60);
    git_env(d, &["commit", "-q", "-m", "ro1"], 60);
    git(d, &["switch", "-q", "-c", "ro2"]);
    write(d, "renamed.txt", b"modified in ro2
");
    write(d, "gone-in-ro2-added.txt", b"x
");
    write(d, "ro/new.txt", b"new
");
    git_env(d, &["add", "-A"], 61);
    git_env(d, &["commit", "-q", "-m", "ro2"], 61);
    git(d, &["switch", "-q", "ro1"]);
    fs::set_permissions(d.join("ro"), fs::Permissions::from_mode(0o555)).unwrap();
    // root처럼 권한과 무관하게 쓸 수 있으면 이 시험은 의미가 없다
    if fs::write(d.join("ro/probe"), b"").is_ok() {
        fs::remove_file(d.join("ro/probe")).unwrap();
        fs::set_permissions(d.join("ro"), fs::Permissions::from_mode(0o755)).unwrap();
        return;
    }
    let (files, snap) = (tree_files(d), snapshot(d));
    let r = GixBackend::new().run(d, &["switch", "ro2"], &[]).await;
    fs::set_permissions(d.join("ro"), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(r.is_err() && !unsupported(r));
    assert_eq!(files, tree_files(d), "파일이 원래대로 돌아와야 한다");
    assert_eq!(snap, snapshot(d));
    assert_eq!(out(d, &["status", "--porcelain"]), "");
    no_lock_files(d);
}

#[cfg(unix)]
#[tokio::test]
async fn switch는_안_바뀐_파일을_건드리지_않는다() {
    use std::os::unix::fs::MetadataExt;
    let tmp = switch_fixture();
    let d = tmp.path();
    let keys = |d: &Path| -> Vec<(String, u64, i64, i64)> {
        tree_files(d).keys().filter(|k| !k.ends_with('/')).map(|k| { let m = fs::symlink_metadata(d.join(k)).unwrap(); (k.clone(), m.ino(), m.mtime(), m.mtime_nsec()) }).collect()
    };
    let before = keys(d);
    std::thread::sleep(std::time::Duration::from_millis(20));
    GixBackend::new().run(d, &["switch", "shape2"], &[]).await.unwrap();
    let after = keys(d);
    let changed: Vec<_> = git(d, &["diff", "--name-only", "--no-renames", "main", "shape2"]).lines().map(str::to_owned).collect();
    let mut checked = 0;
    for (name, ino, sec, nsec) in &before {
        if changed.iter().any(|c| c == name) {
            continue;
        }
        let a = after.iter().find(|x| &x.0 == name).unwrap_or_else(|| panic!("{name} 사라짐"));
        assert_eq!((*ino, *sec, *nsec), (a.1, a.2, a.3), "{name}: 안 바뀐 파일을 다시 썼다");
        checked += 1;
    }
    assert!(checked > 5);
    assert_eq!(out(d, &["status", "--porcelain"]), "");
}

#[tokio::test]
async fn head_reflog에_중복_줄이_안_생긴다() {
    let tmp = switch_fixture();
    let d = tmp.path();
    let lines = |p: &Path| fs::read_to_string(p.join(".git/logs/HEAD")).unwrap().lines().count();
    for argv in [&["switch", "shape"][..], &["switch", "-c", "n"], &["switch", "--detach", "shape"], &["switch", "--detach", "HEAD"], &["branch", "-m", "main", "trunk"]] {
        let b = copy_repo(d);
        let n = lines(b.path());
        GixBackend::new().run(b.path(), argv, &[]).await.unwrap();
        assert_eq!(lines(b.path()) - n, 1, "{argv:?}");
        no_lock_files(b.path());
        assert!(!b.path().join(".git/logs/HEAD.lock").exists());
    }
    let (_keep, work) = pull_fixture();
    let b = copy_repo(&work);
    let n = lines(b.path());
    let (_, r) = run_job(&GixBackend::new(), b.path(), &["pull", "--ff-only"]).await;
    r.unwrap();
    assert_eq!(lines(b.path()) - n, 1);
}

#[tokio::test]
async fn 기본_원격_선택이_원격_하나뿐일_때도_같다() {
    let tmp = fixture();
    let d = tmp.path();
    let (c, g) = backends();
    let up = d.parent().unwrap().join(format!("{}-only.git", d.file_name().unwrap().to_string_lossy()));
    git(d.parent().unwrap(), &["init", "-q", "--bare", up.to_str().unwrap()]);
    git(d, &["push", "-q", up.to_str().unwrap(), "main:upmain"]);
    for branch_cfg in [false, true] {
        let (a, b) = (copy_repo(d), copy_repo(d));
        for p in [a.path(), b.path()] {
            git(p, &["remote", "rename", "origin", "only"]);
            git(p, &["remote", "set-url", "only", up.to_str().unwrap()]);
            if !branch_cfg {
                git(p, &["config", "--unset", "branch.main.remote"]);
                git(p, &["config", "--unset", "branch.main.merge"]);
            }
        }
        let (_, rc) = run_job(&c, a.path(), &["fetch"]).await;
        let (_, rg) = run_job(&g, b.path(), &["fetch"]).await;
        assert_eq!(rc.is_ok(), rg.is_ok(), "branch_cfg={branch_cfg}: {rc:?} vs {rg:?}");
        let refs = |p: &Path| git(p, &["for-each-ref", "--format=%(refname) %(objectname)"]);
        assert_eq!(refs(a.path()), refs(b.path()));
    }
}

#[tokio::test]
async fn branch_이름_바꾸기의_설정_절_경계가_git과_같거나_거절된다() {
    let tmp = fixture();
    let d = tmp.path();
    git(d, &["branch", "side", "HEAD~1"]);
    let g = GixBackend::new();
    // 새 이름의 설정 절이 이미 있으면 거절
    let b = copy_repo(d);
    git(b.path(), &["config", "branch.zz.remote", "origin"]);
    assert!(unsupported(g.run(b.path(), &["branch", "-m", "side", "zz"], &[]).await));
    // 옛 이름의 절이 둘이어도 git과 같다(모두 새 이름으로)
    let b = copy_repo(d);
    for p in [b.path()] {
        let mut c = fs::read_to_string(p.join(".git/config")).unwrap();
        c.push_str("[branch \"side\"]\n\tremote = origin\n\tmerge = refs/heads/feature\n[core]\n\tbare = false\n[branch \"side\"]\n\trebase = false\n");
        fs::write(p.join(".git/config"), c).unwrap();
    }
    run_both(b.path(), &["branch", "-m", "side", "side3"]).await;
    // 커밋 없는 현재 브랜치의 -m은 거절 (git은 이름만 바꾼다)
    let e = plain_repo();
    assert!(unsupported(g.run(e.path(), &["branch", "-m", "main", "trunk"], &[]).await));
    // HEAD가 커밋 없는 브랜치를 가리킬 때 -d는 git과 같다 (HEAD에 합쳐진 것으로 안 침)
    let o = copy_repo(d);
    git(o.path(), &["checkout", "-q", "--orphan", "fresh"]);
    git(o.path(), &["rm", "-rfq", "--cached", "."]);
    for argv in [&["branch", "-d", "side"][..], &["branch", "-d", "feature"], &["branch", "-D", "side"]] {
        run_both(o.path(), argv).await;
    }
}

#[tokio::test]
async fn 서브모듈_설정이_있으면_fetch를_거절하고_끄면_받는다() {
    let tmp = fixture();
    let d = tmp.path();
    let (c, g) = backends();
    let b = copy_repo(d);
    write(b.path(), ".gitmodules", b"[submodule \"s\"]\n\tpath = s\n\turl = ../s\n");
    let (_, r) = run_job(&g, b.path(), &["fetch"]).await;
    assert!(matches!(r, Err(gc_core::Error::Unsupported(_))), "{r:?}");
    git(b.path(), &["config", "submodule.recurse", "true"]);
    let (_, r) = run_job(&g, b.path(), &["fetch"]).await;
    assert!(matches!(r, Err(gc_core::Error::Unsupported(_))), "{r:?}");
    // fetch.recurseSubmodules=false면 git도 서브모듈을 안 받으니 같은 결과
    let (a, b2) = (copy_repo(b.path()), copy_repo(b.path()));
    for p in [a.path(), b2.path()] {
        git(p, &["config", "--unset", "submodule.recurse"]);
        git(p, &["config", "fetch.recurseSubmodules", "false"]);
    }
    let (_, rc) = run_job(&c, a.path(), &["fetch"]).await;
    let (_, rg) = run_job(&g, b2.path(), &["fetch"]).await;
    assert_eq!((rc.is_ok(), rg.is_ok()), (true, true), "{rc:?} {rg:?}");
}

#[tokio::test]
async fn pull은_false인_rebase_설정과_없는_원격_브랜치를_git처럼_다룬다() {
    let (_keep, work) = pull_fixture();
    for prep in [
        (|p: &Path| { git(p, &["config", "pull.rebase", "false"]); }) as fn(&Path),
        |p| { git(p, &["config", "branch.main.rebase", "false"]); },
    ] {
        let b = copy_repo(&work);
        prep(b.path());
        let (k, _) = pull_both(b.path(), &["pull", "--ff-only"]).await;
        assert_eq!(k, "ok");
    }
    // 원격에 없는 브랜치: 둘 다 128 오류, 상태는 같음
    let (k, _) = pull_both(&work, &["pull", "--ff-only", "origin", "nosuch"]).await;
    assert!(k.starts_with("exit Some(128)"), "{k}");
}

// ---- config 쓰기 ----

/// 두 백엔드로 config 쓰기를 하고 결과(종료 코드)와 `.git/config` 바이트가 같은지 본다.
async fn cfg_both(base: &Path, argv: &[&str], ok: &[i32]) -> (String, tempfile::TempDir) {
    let (c, g) = backends();
    let (a, b) = (copy_repo(base), copy_repo(base));
    let (rc, rg) = (run_outcome(c.run(a.path(), argv, ok).await, a.path()), run_outcome(g.run(b.path(), argv, ok).await, b.path()));
    assert_eq!(rc, rg, "git {argv:?}: 결과가 다르다 (왼쪽 = CliBackend)");
    assert_text(&String::from_utf8_lossy(&config_of(a.path())), &String::from_utf8_lossy(&config_of(b.path())), &format!("git {argv:?}: 설정 파일이 다르다"));
    no_lock_files(b.path());
    (rg, b)
}

#[tokio::test]
async fn config_쓰기가_git과_같은_파일을_만든다() {
    let tmp = fixture();
    let d = tmp.path();
    git(d, &["config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*"]); // 여러 값
    git(d, &["config", "branch.main.description", "desc"]);
    git(d, &["config", "alpha.beta", "1"]);
    git(d, &["config", "url.https://x/.insteadOf", "y:"]);
    let values = ["Kim 한글", "a@b.c", "true", "", "a b", " lead", "trail ", "has#hash", "has;semi", "quo\"te", "back\\slash", "한글", "a=b", "x  y", "end\\", "\"", "[sec]", "a\\nb"];
    for v in values {
        cfg_both(d, &["config", "--local", "user.name", v], &[]).await;
        cfg_both(d, &["config", "--local", "alpha.beta", v], &[]).await; // 기존 값 교체
        cfg_both(d, &["config", "--local", "url.https://x/.insteadOf", v], &[]).await; // 서브섹션 키(교체)
        cfg_both(d, &["config", "--local", "new-sec.Sub Name.var-1", v], &[]).await; // 새 섹션
    }
    for key in [
        "user.email", "core.autocrlf", "Core.FooBar", "CORE.AutoCRLF", "branch.main.remote", "branch.main.description", "branch.feature.merge", "branch.Main.remote",
        "remote.origin.fetch", // 값이 여럿 → 5
        "remote.origin.url", "x.y.z.w", "sec.Sub.Key", "a-b.c-d", "9a.b",
        "nodot", "a.", ".b", "a..b", "a.1b", "a_b.c", "sec.sub.", "sec .x", "sec.x y",
    ] {
        if key == "CORE.AutoCRLF" {
            // 기존 `autocrlf`를 준 대소문자로 바꿔 쓰는 건 못 해서 거절
            assert!(unsupported(GixBackend::new().run(d, &["config", "--local", key, "v"], &[]).await));
        } else {
            cfg_both(d, &["config", "--local", key, "v"], &[]).await;
        }
        cfg_both(d, &["config", "--local", "--unset", key], &[]).await;
        cfg_both(d, &["config", "--local", "--unset", key], &[5]).await;
    }
    // 마지막 항목을 지우면 빈 섹션도 지운다 / 다른 항목이 있으면 남긴다
    let (_, b) = cfg_both(d, &["config", "--local", "new.only", "1"], &[]).await;
    let (_, b2) = cfg_both(b.path(), &["config", "--local", "--unset", "new.only"], &[]).await;
    assert!(!String::from_utf8_lossy(&config_of(b2.path())).contains("[new]"));
    cfg_both(d, &["config", "--local", "--unset", "alpha.beta"], &[]).await;
    cfg_both(d, &["config", "--local", "--unset", "url.https://x/.insteadOf"], &[]).await;
    cfg_both(d, &["config", "--local", "--unset", "branch.main.description"], &[]).await;
    // 같은 이름의 섹션이 여럿이고 빈 섹션이 있는 파일
    let m = copy_repo(d);
    let mut c = fs::read_to_string(m.path().join(".git/config")).unwrap();
    c.push_str("[alpha]\n\tgamma = 3\n[Alpha]\n\tdelta = 4\n[empty]\n");
    fs::write(m.path().join(".git/config"), c).unwrap();
    for argv in [&["config", "--local", "alpha.gamma", "9"][..], &["config", "--local", "alpha.delta", "9"], &["config", "--local", "alpha.new", "9"], &["config", "--local", "empty.k", "v"]] {
        cfg_both(m.path(), argv, &[]).await;
    }
    assert!(unsupported(GixBackend::new().run(m.path(), &["config", "--local", "--unset", "alpha.gamma"], &[]).await));
    // 주석·들여쓰기 공백·값 뒤 주석이 있으면 거절
    for extra in ["\n[x]\n\tk = 1\n", "# 주석\n[x]\n\tk = 1\n", "[x]\n  k = 1\n", "[x]\n\tk = 1 ; c\n", "[x] k = 1\n", "[x]\n\t# c\n\tk = 1\n"] {
        let o = copy_repo(d);
        let mut c = fs::read_to_string(o.path().join(".git/config")).unwrap();
        c.push_str(extra);
        fs::write(o.path().join(".git/config"), c).unwrap();
        assert!(unsupported(GixBackend::new().run(o.path(), &["config", "--local", "x.k", "2"], &[]).await), "{extra:?}");
    }
    // 거절하는 값
    let g = GixBackend::new();
    for v in ["-x", "a\nb", "a\tb"] {
        assert!(unsupported(g.run(d, &["config", "--local", "u.k", v], &[]).await), "{v:?}");
    }
    // 잠금이 있으면 128, 안 바뀜
    let b = copy_repo(d);
    write(b.path(), ".git/config.lock", b"");
    assert!(g.run(b.path(), &["config", "--local", "u.k", "v"], &[]).await.is_err());
    assert_eq!(config_of(d), config_of(b.path()));
}

#[cfg(unix)]
#[tokio::test]
async fn config_쓰기는_링크를_따라가고_권한을_유지하고_crlf를_거절한다() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let tmp = fixture();
    let d = tmp.path();
    let (c, g) = backends();
    // 권한 0600 유지
    git(d, &["config", "alpha.x", "1"]);
    fs::set_permissions(d.join(".git/config"), fs::Permissions::from_mode(0o600)).unwrap();
    // 심볼릭 링크
    let (a, b, p, q) = (copy_repo(d), copy_repo(d), copy_repo(d), copy_repo(d));
    let _ = (&p, &q);
    for r in [a.path(), b.path()] {
        let real = r.join("real-config");
        fs::rename(r.join(".git/config"), &real).unwrap();
        std::os::unix::fs::symlink(&real, r.join(".git/config")).unwrap();
    }
    for argv in [&["config", "--local", "alpha.x", "2"][..], &["config", "--local", "new.k", "v"], &["config", "--local", "--unset", "alpha.x"]] {
        c.run(a.path(), argv, &[]).await.unwrap();
        g.run(b.path(), argv, &[]).await.unwrap();
        for r in [a.path(), b.path()] {
            assert!(fs::symlink_metadata(r.join(".git/config")).unwrap().file_type().is_symlink(), "{argv:?}: 링크가 사라졌다");
        }
        assert_eq!(fs::read(a.path().join("real-config")).unwrap(), fs::read(b.path().join("real-config")).unwrap(), "{argv:?}");
        assert_eq!(fs::metadata(a.path().join("real-config")).unwrap().mode() & 0o7777, fs::metadata(b.path().join("real-config")).unwrap().mode() & 0o7777);
        no_lock_files(b.path());
    }
    // 일반 파일: 0600이 유지된다
    let (a, b) = (copy_repo(d), copy_repo(d));
    c.run(a.path(), &["config", "--local", "alpha.x", "2"], &[]).await.unwrap();
    g.run(b.path(), &["config", "--local", "alpha.x", "2"], &[]).await.unwrap();
    for r in [a.path(), b.path()] {
        assert_eq!(fs::metadata(r.join(".git/config")).unwrap().mode() & 0o7777, 0o600);
    }
    // CRLF 설정 파일은 거절
    let m = copy_repo(d);
    let t = fs::read_to_string(m.path().join(".git/config")).unwrap().replace('\n', "\r\n");
    fs::write(m.path().join(".git/config"), t).unwrap();
    assert!(unsupported(g.run(m.path(), &["config", "--local", "alpha.x", "2"], &[]).await));
    assert!(unsupported(g.run(m.path(), &["config", "--local", "--unset", "alpha.x"], &[]).await));
}

#[tokio::test]
async fn 빈_loose_ref를_만나면_git과_같은_종류로_실패하거나_무시한다() {
    let tmp = fixture();
    let d = tmp.path();
    let (c, g) = backends();
    // 거절(Unsupported)은 항상 안전하다. 그 밖에는 성공/실패가 git과 같아야 한다.
    let unsupported_or_same = |rc: &gc_core::Result<Vec<u8>>, rg: &gc_core::Result<Vec<u8>>| matches!(rg, Err(gc_core::Error::Unsupported(_))) || rc.is_ok() == rg.is_ok();
    // (1) 다른 브랜치의 ref가 0바이트
    let a = copy_repo(d);
    write(a.path(), ".git/refs/heads/broken", b"");
    for argv in [&["branch", "x"][..], &["branch", "-d", "broken"], &["branch", "-D", "broken"], &["branch", "broken2", "broken"], &["switch", "broken"], &["switch", "-c", "n"]] {
        let (b1, b2) = (copy_repo(a.path()), copy_repo(a.path()));
        let (rc, rg) = (c.run(b1.path(), argv, &[]).await, g.run(b2.path(), argv, &[]).await);
        assert!(unsupported_or_same(&rc, &rg), "broken: {argv:?}: {rc:?} vs {rg:?}");
    }
    // (2) HEAD가 가리키는 ref가 0바이트 (사고 상황)
    let h = copy_repo(d);
    git(h.path(), &["switch", "-q", "-c", "phone2"]);
    write(h.path(), ".git/refs/heads/phone2", b"");
    for argv in [&["branch", "x"][..], &["switch", "main"], &["switch", "-c", "n"], &["branch", "-m", "phone2", "p3"], &["branch", "-d", "main"]] {
        let (b1, b2) = (copy_repo(h.path()), copy_repo(h.path()));
        let (rc, rg) = (c.run(b1.path(), argv, &[]).await, g.run(b2.path(), argv, &[]).await);
        assert!(unsupported_or_same(&rc, &rg), "head broken: {argv:?}: {rc:?} vs {rg:?}");
        // 실패하면 저장소가 더 나빠지지 않는다(빈 ref가 그대로)
        if rg.is_err() {
            assert_eq!(fs::read(b2.path().join(".git/refs/heads/phone2")).unwrap(), b"");
        }
    }
    let (b1, b2) = (copy_repo(h.path()), copy_repo(h.path()));
    let (_, rc) = run_job(&c, b1.path(), &["fetch"]).await;
    let (_, rg) = run_job(&g, b2.path(), &["fetch"]).await;
    println!("fetch with broken HEAD ref: cli={:?} gix={:?}", rc.is_ok(), rg);
    // 상태: git은 안 태어난 브랜치처럼 보여 주지만 gix는 128로 실패한다(문서의 한계). 실패하되 저장소는 그대로.
    assert!(c.read_status(h.path()).await.is_ok());
    assert!(matches!(g.read_status(h.path()).await, Err(gc_core::Error::Exit { code: Some(128), .. })));
    assert_eq!(fs::read(h.path().join(".git/refs/heads/phone2")).unwrap(), b"");
    for (name, f) in [("read_refs", 0), ("read_log", 1), ("read_status", 2)] {
        let (rc, rg) = match f {
            0 => (c.read_refs(h.path()).await.is_ok(), g.read_refs(h.path()).await.is_ok()),
            1 => (c.read_log(h.path(), 10, &[]).await.is_ok(), g.read_log(h.path(), 10, &[]).await.is_ok()),
            _ => (c.read_status(h.path()).await.is_ok(), g.read_status(h.path()).await.is_ok()),
        };
        println!("{name}: cli={rc} gix={rg}");
    }
}
