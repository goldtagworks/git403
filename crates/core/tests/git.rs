//! 실제 git으로 코어 동작을 검증한다: 원격 → clone → 다른 곳에서 push → pull.

use std::path::Path;
use std::time::{Duration, Instant};

use gc_core::{read_log, Error, GitRunner, JobEvent};
use tokio::sync::mpsc;

fn git(dir: &Path, args: &[&str]) {
    let ok = std::process::Command::new("git")
        .current_dir(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main"])
        .args(args)
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?}");
}

/// (작업 폴더, 원격에 새 커밋을 올린 다른 clone)
fn setup() -> (tempfile::TempDir, std::path::PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    git(root, &["init", "-q", "--bare", "remote.git"]);
    git(root, &["clone", "-q", "remote.git", "a"]);
    git(&root.join("a"), &["commit", "-q", "--allow-empty", "-m", "first"]);
    git(&root.join("a"), &["push", "-q", "origin", "HEAD:main"]);
    git(root, &["clone", "-q", "remote.git", "b"]);
    git(&root.join("b"), &["commit", "-q", "--allow-empty", "-m", "from b"]);
    git(&root.join("b"), &["push", "-q", "origin", "HEAD:main"]);
    let a = root.join("a");
    (tmp, a)
}

#[tokio::test]
async fn pull_streams_events_and_updates_log() {
    let (_tmp, repo) = setup();
    let runner = GitRunner::default();
    let (tx, mut rx) = mpsc::unbounded_channel();

    let (_handle, task) = runner.spawn(&repo, &["pull", "--ff-only", "origin", "main"], tx).unwrap();
    task.await.unwrap().unwrap();

    let mut events = Vec::new();
    while let Ok(e) = rx.try_recv() {
        events.push(e);
    }
    assert!(matches!(events.last(), Some(JobEvent::Finished { code: Some(0) })));

    let log = read_log(&runner, &repo, 10, &[]).await.unwrap();
    assert_eq!(log[0].subject, "from b");
    assert_eq!(log[0].parents, [log[1].id.clone()]);
}

#[tokio::test]
async fn spawn_returns_immediately_and_can_be_cancelled() {
    // 오래 걸리는 작업 대신 sleep으로 runner의 비동기·취소 동작만 본다.
    let runner = GitRunner::new("sleep");
    let (tx, _rx) = mpsc::unbounded_channel();
    let started = Instant::now();
    let (handle, task) = runner.spawn(Path::new("."), &["10"], tx).unwrap();
    assert!(started.elapsed() < Duration::from_millis(500), "spawn이 블로킹됨");

    handle.cancel();
    let result = tokio::time::timeout(Duration::from_secs(2), task).await.unwrap().unwrap();
    assert!(matches!(result, Err(Error::Cancelled)));
}

#[tokio::test]
async fn failed_command_reports_stderr() {
    let (_tmp, repo) = setup();
    let (tx, _rx) = mpsc::unbounded_channel();
    let (_h, task) = GitRunner::default().spawn(&repo, &["pull", "origin", "no-such-branch"], tx).unwrap();
    match task.await.unwrap() {
        Err(Error::Exit { stderr, .. }) => assert!(!stderr.is_empty(), "stderr가 비어 있음"),
        other => panic!("실패해야 함: {other:?}"),
    }
}

#[tokio::test]
async fn shell_job_streams_stdout_and_reports_exit_code() {
    let tmp = tempfile::tempdir().unwrap();
    let runner = GitRunner::default();
    let (tx, mut rx) = mpsc::unbounded_channel();
    // 작업 폴더가 저장소이고, 따옴표로 감싼 값이 그대로 한 인자로 전달되는지
    // Windows는 cmd /C로 실행하므로 같은 내용을 cmd 문법으로 쓴다(echo 뒤 `&` 앞에 공백을 두면 출력에 섞인다)
    #[cfg(windows)]
    let script = "echo a b& cd& echo oops>&2& exit /b 3";
    #[cfg(not(windows))]
    let script = "echo 'a b'; pwd; echo oops >&2; exit 3";
    let (_h, task) = runner.spawn_shell(tmp.path(), script, tx).unwrap();
    let res = task.await.unwrap();
    let mut out = Vec::new();
    let mut err = Vec::new();
    while let Some(ev) = rx.recv().await {
        match ev {
            JobEvent::Stdout { line } => out.push(line),
            JobEvent::Progress { line } => err.push(line),
            JobEvent::Finished { .. } => {}
        }
    }
    assert_eq!(out[0].trim_end(), "a b");
    assert!(out[1].ends_with(tmp.path().file_name().unwrap().to_str().unwrap()), "{out:?}");
    assert_eq!(err.iter().map(|l| l.trim_end()).collect::<Vec<_>>(), ["oops"]);
    assert!(matches!(res, Err(Error::Exit { code: Some(3), .. })));
}

#[cfg(unix)]
#[tokio::test]
async fn cancel_kills_grandchildren_and_ends_readers() {
    let tmp = tempfile::tempdir().unwrap();
    let runner = GitRunner::default();
    let (tx, mut rx) = mpsc::unbounded_channel();
    // 손자 프로세스(sleep)가 stdout을 쥐고 있어도 취소하면 모두 끝나야 한다
    let (h, task) = runner.spawn_shell(tmp.path(), "sleep 30 & echo $!; echo started; wait", tx).unwrap();
    let mut grandchild = String::new();
    loop {
        match rx.recv().await.unwrap() {
            JobEvent::Stdout { line } if line == "started" => break,
            JobEvent::Stdout { line } => grandchild = line,
            _ => {}
        }
    }
    let alive = |pid: &str| std::process::Command::new("kill").args(["-0", pid]).stderr(std::process::Stdio::null()).status().unwrap().success();
    assert!(alive(&grandchild));
    let t = Instant::now();
    h.cancel();
    assert!(matches!(task.await.unwrap(), Err(Error::Cancelled)));
    // 읽기 태스크가 끝나면 채널의 모든 송신자가 사라져 recv가 None을 돌려준다
    let closed = tokio::time::timeout(Duration::from_secs(5), async { while rx.recv().await.is_some() {} }).await;
    assert!(closed.is_ok(), "취소 뒤 출력 읽기가 끝나지 않음");
    assert!(t.elapsed() < Duration::from_secs(10));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!alive(&grandchild), "손자 프로세스가 살아 있음");
}

/// 백그라운드 작업(자동 fetch)은 askpass 환경을 받지 않고, ssh는 BatchMode (git 대신 sh로 환경만 확인)
#[cfg(unix)]
#[tokio::test]
async fn spawn_batch_drops_askpass_and_sets_batch_ssh() {
    use gc_core::{GitRunner, JobEvent};
    let sh = GitRunner::new("sh").with_env("GIT_ASKPASS", "/app").with_env("SSH_ASKPASS", "/app").with_env("SSH_ASKPASS_REQUIRE", "force");
    let run = |batch: bool| {
        let sh = &sh;
        async move {
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let script = "echo \"[$GIT_ASKPASS|$SSH_ASKPASS|$SSH_ASKPASS_REQUIRE|$GIT_SSH_COMMAND|$GIT_TERMINAL_PROMPT]\"";
            let (_h, task) = sh.spawn_batch(std::path::Path::new("."), &["-c", script], batch, tx).unwrap();
            task.await.unwrap().unwrap();
            let mut out = String::new();
            while let Ok(e) = rx.try_recv() {
                if let JobEvent::Stdout { line: l } = e {
                    out.push_str(&l);
                }
            }
            out
        }
    };
    assert_eq!(run(true).await.trim(), "[|||ssh -o BatchMode=yes|0]");
    assert_eq!(run(false).await.trim(), "[||||0]"); // 사용자 ssh 설정 존중: 건드리지 않음
}

#[tokio::test]
async fn hidden_refs_drop_commits_only_they_reach() {
    let tmp = tempfile::tempdir().unwrap();
    let d = tmp.path();
    git(d, &["init", "-q", "-b", "main"]);
    git(d, &["commit", "-q", "--allow-empty", "-m", "base"]);
    git(d, &["checkout", "-q", "-b", "feat/x"]);
    git(d, &["commit", "-q", "--allow-empty", "-m", "only-x"]);
    git(d, &["checkout", "-q", "-b", "feat/y", "main"]);
    git(d, &["commit", "-q", "--allow-empty", "-m", "only-y"]);
    git(d, &["checkout", "-q", "main"]);
    git(d, &["commit", "-q", "--allow-empty", "-m", "on-main"]);
    let g = GitRunner::default();
    let subjects = |hidden: &[&str]| {
        let hidden: Vec<String> = hidden.iter().map(|s| s.to_string()).collect();
        let g = &g;
        async move {
            let mut v: Vec<String> = read_log(g, d, 20, &hidden).await.unwrap().into_iter().map(|c| c.subject).collect();
            v.sort();
            v
        }
    };
    assert_eq!(subjects(&[]).await, ["base", "on-main", "only-x", "only-y"]);
    assert_eq!(subjects(&["refs/heads/feat/x"]).await, ["base", "on-main", "only-y"]);
    // 폴더 글롭은 그 아래 전부
    assert_eq!(subjects(&["refs/heads/feat/*"]).await, ["base", "on-main"]);
    // 현재 브랜치(HEAD)는 숨겨지지 않는다
    assert_eq!(subjects(&["refs/heads/main", "refs/heads/feat/*"]).await, ["base", "on-main"]);
    // 내용 검색도 같은 규칙
    git(d, &["checkout", "-q", "feat/x"]);
    std::fs::write(d.join("f.txt"), "needle\n").unwrap();
    git(d, &["add", "."]);
    git(d, &["commit", "-q", "-m", "add-needle"]);
    git(d, &["checkout", "-q", "main"]);
    assert_eq!(gc_core::search_content(&g, d, "needle", &[]).await.unwrap().len(), 1);
    assert!(gc_core::search_content(&g, d, "needle", &["refs/heads/feat/*".into()]).await.unwrap().is_empty());
}

#[tokio::test]
async fn co_authors_reads_trailers() {
    let tmp = tempfile::tempdir().unwrap();
    git(tmp.path(), &["init", "-q", "r"]);
    let repo = tmp.path().join("r");
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "제목\n\n본문\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nCo-authored-by: 옥토 <1+octo@users.noreply.github.com>"]);
    let list = gc_core::co_authors(&GitRunner::default(), &repo, "HEAD").await.unwrap();
    assert_eq!(list, ["Claude <noreply@anthropic.com>", "옥토 <1+octo@users.noreply.github.com>"]);
    let msg = gc_core::commit_message(&GitRunner::default(), &repo, "HEAD").await.unwrap();
    assert!(msg.starts_with("제목\n\n본문\n\nCo-Authored-By"), "{msg}");
}

#[tokio::test]
async fn committer_differs_from_author() {
    let tmp = tempfile::tempdir().unwrap();
    git(tmp.path(), &["init", "-q", "r"]);
    let repo = tmp.path().join("r");
    git(&repo, &["-c", "user.name=커미터", "-c", "user.email=c@x.dev", "commit", "-q", "--allow-empty", "--author=작성자 <a@x.dev>", "--date=@1700000000", "-m", "m"]);
    let (n, e, t) = gc_core::committer(&GitRunner::default(), &repo, "HEAD").await.unwrap();
    assert_eq!((n.as_str(), e.as_str()), ("커미터", "c@x.dev"));
    assert!(t > 1700000000);
}

#[tokio::test]
async fn restore_file_resets_worktree_and_index_from_rev() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    git(repo, &["init", "-q"]);
    std::fs::write(repo.join("a.txt"), "v1\n").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-q", "-m", "one"]);
    std::fs::write(repo.join("a.txt"), "v2\n").unwrap();
    std::fs::write(repo.join("b.txt"), "new\n").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-q", "-m", "two"]);
    std::fs::write(repo.join("a.txt"), "v3\n").unwrap();
    git(repo, &["add", "a.txt"]);
    let runner = GitRunner::default();
    let code = |e: Error| e.coded().map(|c| c.code).unwrap_or_default().to_string();

    gc_core::restore_file(&runner, repo, "HEAD~1", &["a.txt".into()]).await.unwrap();
    assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "v1\n");
    let staged = runner.output(repo, &["diff", "--cached", "--name-only"]).await.unwrap();
    assert_eq!(String::from_utf8_lossy(&staged).trim(), "a.txt"); // 인덱스도 v1 (HEAD의 v2와 다름)
    let wt = runner.output(repo, &["diff", "--name-only"]).await.unwrap();
    assert!(wt.is_empty());

    // 그 커밋에 없는 파일: 거부, 다른 경로도 안 바뀜
    let e = gc_core::restore_file(&runner, repo, "HEAD~1", &["a.txt".into(), "b.txt".into()]).await.unwrap_err();
    assert_eq!(code(e), "restore.notInRev");
    let e = gc_core::restore_file(&runner, repo, "--help", &["a.txt".into()]).await.unwrap_err();
    assert_eq!(code(e), "restore.badRev");
}

fn out(dir: &Path, args: &[&str]) -> String {
    let o = std::process::Command::new("git").current_dir(dir).args(args).output().unwrap();
    String::from_utf8_lossy(&o.stdout).trim().to_owned()
}

fn commit_file(dir: &Path, name: &str, body: &str, msg: &str) -> String {
    std::fs::write(dir.join(name), body).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", msg]);
    out(dir, &["rev-parse", "HEAD"])
}

fn init_repo() -> (tempfile::TempDir, std::path::PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("r");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    (tmp, repo)
}

#[tokio::test]
async fn interactive_rebase_reword가_충돌로_멈춘_뒤_계속해도_메시지를_쓴다() {
    use gc_core::{rebase_interactive, RebaseStep};
    let (_tmp, repo) = init_repo();
    let base = commit_file(&repo, "f", "0\n", "base");
    let c1 = commit_file(&repo, "f", "1\n", "c1");
    let c2 = commit_file(&repo, "f", "2\n", "c2");
    let c3 = commit_file(&repo, "g", "g\n", "c3");
    let step = |action: &str, sha: &str, message: Option<&str>| RebaseStep { action: action.into(), sha: sha.into(), message: message.map(Into::into) };
    let runner = GitRunner::default();
    // c2를 c1보다 먼저 쌓으면 c1에서 충돌로 멈춘다. 그 뒤 reword(c3)는 `--continue` 때 실행된다.
    let steps = [step("pick", &c2, None), step("pick", &c1, None), step("reword", &c3, Some("새 메시지\n\n본문"))];
    assert!(rebase_interactive(&runner, &repo, &base, &steps).await.is_err());
    let gitdir = repo.join(".git");
    assert!(gitdir.join("rebase-merge").exists());
    let tmp_dirs = |g: &Path| std::fs::read_dir(g).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("gc-rebase-")).count();
    assert_eq!(tmp_dirs(&gitdir), 1, "멈춘 동안 메시지 파일이 남아 있어야 한다");
    for _ in 0..4 {
        if !gitdir.join("rebase-merge").exists() {
            break;
        }
        std::fs::write(repo.join("f"), "resolved\n").unwrap();
        git(&repo, &["add", "f"]);
        let _ = runner.output(&repo, &["rebase", "--continue"]).await;
    }
    assert_eq!(out(&repo, &["log", "-1", "--format=%B"]), "새 메시지\n\n본문");
    assert!(!gitdir.join("rebase-merge").exists());
    // 끝난 뒤 남은 폴더는 다음 interactive rebase 시작 때 정리된다.
    let head = out(&repo, &["rev-parse", "HEAD"]);
    rebase_interactive(&runner, &repo, &base, &[step("pick", &head, None)]).await.ok();
    assert_eq!(tmp_dirs(&gitdir), 0);
    assert!(rebase_interactive(&runner, &repo, "--x", &[]).await.is_err());
}

// ---- UI(ops.ts)가 만드는 인자 모양이 git에서 의도대로 동작하는지 ----

#[tokio::test]
async fn push_강제는_받아만_두고_합치지_않은_원격_커밋을_덮어쓰지_않는다() {
    let (_tmp, repo) = setup(); // 원격은 b가 앞섰고 a는 아직 못 받았다
    let runner = GitRunner::default();
    let force = ["push", "--force-with-lease", "--force-if-includes", "origin", "main"];
    git(&repo, &["commit", "-q", "--allow-empty", "--amend", "-m", "rewritten"]);
    // 자동 fetch가 남의 커밋을 받아 원격 추적 ref만 갱신한 상태: lease만으로는 통과하지만 거부돼야 한다
    git(&repo, &["fetch", "-q"]);
    assert!(matches!(runner.output(&repo, &force).await, Err(Error::Exit { .. })));
    // 합친 뒤에는 허용
    git(&repo, &["rebase", "-q", "origin/main"]);
    runner.output(&repo, &force).await.unwrap();
    assert_eq!(out(&repo, &["rev-parse", "origin/main"]), out(&repo, &["rev-parse", "HEAD"]));
}

#[tokio::test]
async fn 원격_브랜치_삭제는_같은_이름_태그를_건드리지_않는다() {
    let (_tmp, repo) = setup();
    let runner = GitRunner::default();
    git(&repo, &["push", "-q", "origin", "HEAD:refs/heads/x", "HEAD:refs/tags/x"]);
    runner.output(&repo, &["push", "origin", "--delete", "refs/heads/x"]).await.unwrap();
    let refs = out(&repo, &["ls-remote", "origin"]);
    assert!(refs.contains("refs/tags/x") && !refs.contains("refs/heads/x"), "{refs}");
}

#[tokio::test]
async fn clone은_url_자리의_옵션_모양_값을_옵션으로_읽지_않는다() {
    let tmp = tempfile::tempdir().unwrap();
    let r = GitRunner::default().output(tmp.path(), &["clone", "--progress", "--", "--upload-pack=touch pwned", "dst"]).await;
    assert!(r.is_err());
    assert!(!tmp.path().join("pwned").exists());
}

#[tokio::test]
async fn 머지_커밋_cherry_pick과_revert는_m1이_필요하다() {
    let (_tmp, repo) = init_repo();
    commit_file(&repo, "a", "a\n", "base");
    git(&repo, &["switch", "-q", "-c", "side"]);
    commit_file(&repo, "b", "b\n", "side");
    git(&repo, &["switch", "-q", "main"]);
    commit_file(&repo, "c", "c\n", "main");
    git(&repo, &["merge", "-q", "--no-ff", "-m", "merge", "side"]);
    let merge = out(&repo, &["rev-parse", "HEAD"]);
    let runner = GitRunner::default();
    assert!(runner.output(&repo, &["revert", "--no-edit", &merge]).await.is_err());
    runner.output(&repo, &["revert", "-m", "1", "--no-edit", &merge]).await.unwrap();
    assert!(!repo.join("b").exists());
    git(&repo, &["switch", "-q", "-c", "other", &format!("{merge}^1")]);
    assert!(runner.output(&repo, &["cherry-pick", &merge]).await.is_err());
    runner.output(&repo, &["cherry-pick", "-m", "1", &merge]).await.unwrap();
}

#[tokio::test]
async fn skip은_충돌난_cherry_pick을_건너뛰고_status가_작업_종류를_알려준다() {
    let (_tmp, repo) = init_repo();
    commit_file(&repo, "f", "0\n", "base");
    git(&repo, &["switch", "-q", "-c", "side"]);
    let s1 = commit_file(&repo, "f", "side\n", "s1");
    let s2 = commit_file(&repo, "g", "g\n", "s2");
    git(&repo, &["switch", "-q", "main"]);
    commit_file(&repo, "f", "main\n", "m1");
    let runner = GitRunner::default();
    // 두 커밋 cherry-pick: s1이 충돌로 멈추면 sequencer가 남는다
    assert!(runner.output(&repo, &["cherry-pick", &s1, &s2]).await.is_err());
    assert_eq!(gc_core::read_status(&runner, &repo).await.unwrap().operation.as_deref(), Some("cherry-pick"));
    runner.output(&repo, &["cherry-pick", "--skip"]).await.unwrap();
    assert!(repo.join("g").exists());
    assert_eq!(gc_core::read_status(&runner, &repo).await.unwrap().operation, None);
}

#[tokio::test]
async fn stash_이름_변경은_새로_저장한_뒤_밀린_옛_항목을_지운다() {
    let (_tmp, repo) = init_repo();
    commit_file(&repo, "f", "0\n", "base");
    let runner = GitRunner::default();
    std::fs::write(repo.join("f"), "1\n").unwrap();
    git(&repo, &["stash", "push", "-q", "-m", "old"]);
    std::fs::write(repo.join("f"), "2\n").unwrap();
    git(&repo, &["stash", "push", "-q", "-m", "keep"]);
    // stash@{1}("old")을 "new"로: store → 옛 항목은 stash@{2}로 밀린다
    let sha = out(&repo, &["rev-parse", "stash@{1}"]);
    runner.output(&repo, &["stash", "store", "-m", "new", &sha]).await.unwrap();
    runner.output(&repo, &["stash", "drop", "stash@{2}"]).await.unwrap();
    let list = out(&repo, &["stash", "list", "--format=%gs"]);
    assert_eq!(list.lines().count(), 3 - 1);
    assert!(list.contains("new") && list.contains("keep") && !list.contains("old"), "{list}");
}

#[tokio::test]
async fn 빠른_pull은_갈라졌을_때_ff_only로_멈춘다() {
    let (_tmp, repo) = setup(); // 원격은 앞섬
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "local"]); // 갈라짐
    let r = GitRunner::default().output(&repo, &["pull", "--progress", "--ff-only"]).await;
    assert!(matches!(r, Err(Error::Exit { .. })));
    assert_eq!(out(&repo, &["rev-list", "--merges", "--count", "HEAD"]), "0");
}
