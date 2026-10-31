//! `GixBackend`의 push를 `CliBackend`(진짜 `git push`)와 비교한다 (`cargo test -p gc-core --features gix`).
//! 원격은 로컬 bare 저장소를 `file` 경로로, 그리고 이 파일 안의 작은 smart HTTP 서버(`git http-backend` CGI)로 쓴다.
//! 비교 대상: 종료 결과, stdout·stderr 줄(진행률 줄만 뺌, 경로·포트는 자리표시자로), 원격 ref·`fsck`, 로컬 ref·설정·원격 추적 ref reflog(시각만 뺌).
#![cfg(feature = "gix")]

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Once};
use std::time::Duration;

use gc_core::gix_backend::{set_token_source, GixBackend, TokenSource};
use gc_core::{CliBackend, Error, GitBackend, GitRunner, JobEvent};

/// 사용자의 전역 설정(키체인 도우미 등)이 시험에 끼지 않게 한다. 환경은 프로세스 공유라 모든 시험이 맨 먼저 부른다.
fn init() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
        std::env::set_var("GIT_TERMINAL_PROMPT", "0");
        std::env::set_var("GIT_ASKPASS", "true");
        std::env::remove_var("SSH_ASKPASS");
    });
}

fn git_env(dir: &Path, args: &[&str], n: u32) -> String {
    let date = format!("{} +0900", 1_577_836_800 + n as u64 * 3600);
    let o = Command::new("git")
        .current_dir(dir)
        .args(["-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always"])
        .args(args)
        .env("GIT_AUTHOR_DATE", &date)
        .env("GIT_COMMITTER_DATE", &date)
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

fn commit(dir: &Path, msg: &str, n: u32) {
    git_env(dir, &["add", "-A"], n);
    git_env(dir, &["commit", "-q", "-m", msg], n);
}

fn numbered(n: usize, tag: &str) -> String {
    (1..=n).map(|i| format!("line {i}{tag}\n")).collect()
}

/// 재현 가능한 의사 난수 바이트(압축이 잘 안 되는 큰 blob용).
fn noise(len: usize, seed: u32) -> Vec<u8> {
    let mut x = seed.wrapping_mul(2654435761).wrapping_add(1);
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            (x >> 8) as u8
        })
        .collect()
}

// ---------- smart HTTP 서버 ----------

struct Server {
    port: u16,
    stop: Arc<AtomicBool>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

fn b64(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// `root` 아래 저장소를 `git http-backend`로 서빙한다. `auth`가 있으면 Basic 인증을 요구한다.
fn serve(root: PathBuf, auth: Option<(String, String)>) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    std::thread::spawn(move || loop {
        match listener.accept() {
            Ok((s, _)) => {
                s.set_nonblocking(false).unwrap();
                let (root, auth) = (root.clone(), auth.clone());
                std::thread::spawn(move || {
                    let _ = handle(s, &root, auth.as_ref());
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if flag.load(Ordering::SeqCst) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(_) => break,
        }
    });
    Server { port, stop }
}

fn handle(mut s: TcpStream, root: &Path, auth: Option<&(String, String)>) -> std::io::Result<()> {
    let mut r = BufReader::new(s.try_clone()?);
    let mut line = String::new();
    r.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or("").to_owned(), parts.next().unwrap_or("").to_owned());
    let mut h: HashMap<String, String> = HashMap::new();
    loop {
        let mut l = String::new();
        r.read_line(&mut l)?;
        let l = l.trim_end();
        if l.is_empty() {
            break;
        }
        if let Some((k, v)) = l.split_once(':') {
            h.insert(k.to_ascii_lowercase(), v.trim().to_owned());
        }
    }
    if h.get("expect").is_some_and(|v| v.eq_ignore_ascii_case("100-continue")) {
        s.write_all(b"HTTP/1.1 100 Continue\r\n\r\n")?;
    }
    let mut body = Vec::new();
    if h.get("transfer-encoding").is_some_and(|v| v.contains("chunked")) {
        loop {
            let mut l = String::new();
            r.read_line(&mut l)?;
            let n = usize::from_str_radix(l.trim().split(';').next().unwrap_or("0"), 16).unwrap_or(0);
            if n == 0 {
                loop {
                    let mut t = String::new();
                    r.read_line(&mut t)?;
                    if t.trim().is_empty() {
                        break;
                    }
                }
                break;
            }
            let mut chunk = vec![0; n];
            r.read_exact(&mut chunk)?;
            body.extend(chunk);
            let mut crlf = [0; 2];
            r.read_exact(&mut crlf)?;
        }
    } else if let Some(n) = h.get("content-length").and_then(|v| v.parse::<usize>().ok()) {
        body = vec![0; n];
        r.read_exact(&mut body)?;
    }
    let mut user = "anon".to_owned();
    if let Some((u, p)) = auth {
        let want = format!("Basic {}", b64(format!("{u}:{p}").as_bytes()));
        if h.get("authorization") != Some(&want) {
            let msg = b"Unauthorized";
            write!(s, "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"git\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", msg.len())?;
            return s.write_all(msg);
        }
        user = u.clone();
    }
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    let mut cmd = Command::new("git");
    cmd.args(["http-backend"])
        .env("GIT_PROJECT_ROOT", root)
        .env("GIT_HTTP_EXPORT_ALL", "1")
        .env("REQUEST_METHOD", &method)
        .env("PATH_INFO", path)
        .env("QUERY_STRING", query)
        .env("REMOTE_USER", &user)
        .env("CONTENT_TYPE", h.get("content-type").cloned().unwrap_or_default())
        .env("CONTENT_LENGTH", body.len().to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(v) = h.get("git-protocol") {
        cmd.env("GIT_PROTOCOL", v);
    }
    if let Some(v) = h.get("content-encoding") {
        cmd.env("HTTP_CONTENT_ENCODING", v);
    }
    let mut child = cmd.spawn()?;
    let mut stdin = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&body);
    });
    let mut out = Vec::new();
    child.stdout.take().unwrap().read_to_end(&mut out)?;
    let _ = writer.join();
    let _ = child.wait();
    let split = out.windows(4).position(|w| w == b"\r\n\r\n").map(|i| (i, 4)).or_else(|| out.windows(2).position(|w| w == b"\n\n").map(|i| (i, 2)));
    let (head, rest) = match split {
        Some((i, n)) => (String::from_utf8_lossy(&out[..i]).into_owned(), out[i + n..].to_vec()),
        None => (String::new(), out),
    };
    let mut status = "200 OK".to_owned();
    let mut headers = String::new();
    for l in head.lines() {
        match l.split_once(':') {
            Some((k, v)) if k.eq_ignore_ascii_case("status") => status = v.trim().to_owned(),
            _ => {
                headers.push_str(l);
                headers.push_str("\r\n");
            }
        }
    }
    write!(s, "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n", rest.len())?;
    s.write_all(&rest)
}

// ---------- 시험 환경 ----------

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    File,
    Http,
}

struct Env {
    root: tempfile::TempDir,
    _server: Option<Server>,
}

impl Env {
    fn work(&self) -> PathBuf {
        self.root.path().join("work")
    }
    fn remote(&self) -> PathBuf {
        self.root.path().join("o.git")
    }
    /// 출력에서 환경마다 다른 부분(임시 경로·포트)을 자리표시자로 바꾼다.
    fn norm(&self, s: &str) -> String {
        let root = self.root.path().to_string_lossy().into_owned();
        let real = fs::canonicalize(self.root.path()).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| root.clone());
        let mut s = s.replace(&real, "<ROOT>").replace(&root, "<ROOT>");
        if let Some(p) = self._server.as_ref().map(|s| s.port) {
            s = s.replace(&format!(":{p}"), ":<PORT>");
        }
        s
    }
}

/// 기본 저장소: 원격은 c1(main), 로컬 main은 c2까지(추적 설정됨, 한 커밋 앞섬). 파일 종류(실행·심볼릭 링크·바이너리·한글·중첩)를 섞는다.
fn base() -> tempfile::TempDir {
    init();
    let t = tempfile::tempdir().unwrap();
    let root = t.path();
    git(root, &["init", "-q", "--bare", "-b", "main", "o.git"]);
    git(root, &["clone", "-q", "o.git", "work"]);
    let w = root.join("work");
    for (k, v) in [("user.name", "Kim 한글"), ("user.email", "kim@example.com"), ("core.autocrlf", "false")] {
        git(&w, &["config", k, v]);
    }
    write(&w, "a.txt", numbered(20, "").as_bytes());
    write(&w, "한글 경로/파일.txt", "안녕\n".as_bytes());
    write(&w, "dir/sub/deep.txt", b"deep\n");
    write(&w, "bin.dat", &noise(3000, 1));
    write(&w, "run.sh", b"#!/bin/sh\necho hi\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(w.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink("a.txt", w.join("link")).unwrap();
    }
    commit(&w, "c1", 1);
    git(&w, &["branch", "-M", "main"]);
    git(&w, &["push", "-q", "-u", "origin", "main"]);
    write(&w, "a.txt", numbered(20, " 바뀜").as_bytes());
    write(&w, "dir/new.txt", b"new\n");
    commit(&w, "c2", 2);
    t
}

fn copy_tree(from: &Path) -> tempfile::TempDir {
    let to = tempfile::tempdir().unwrap();
    assert!(Command::new("cp").arg("-a").arg(format!("{}/.", from.display())).arg(to.path()).status().unwrap().success());
    to
}

/// `base`를 복사하고 원격 주소를 `kind`에 맞게 바꾼다. `auth`는 HTTP에서 요구할 (사용자, 토큰), `creds`는 URL에 넣을 (사용자, 토큰).
fn env_of(base: &Path, kind: Kind, auth: Option<(&str, &str)>, creds: Option<(&str, &str)>) -> Env {
    let root = copy_tree(base);
    let (url, server) = match kind {
        Kind::File => (root.path().join("o.git").to_string_lossy().into_owned(), None),
        Kind::Http => {
            let s = serve(root.path().to_path_buf(), auth.map(|(u, p)| (u.to_owned(), p.to_owned())));
            let userinfo = creds.map(|(u, p)| format!("{u}:{p}@")).unwrap_or_default();
            (format!("http://{userinfo}127.0.0.1:{}/o.git", s.port), Some(s))
        }
    };
    git(&root.path().join("work"), &["config", "remote.origin.url", &url]);
    Env { root, _server: server }
}

async fn run_job(b: &dyn GitBackend, d: &Path, argv: &[&str], batch: Option<bool>) -> (Vec<JobEvent>, gc_core::Result<()>) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let (handle, task) = match b.spawn_job(d, argv, batch, tx) {
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

/// 진행률 줄(개수·속도가 달라지는 것)은 비교에서 뺀다.
fn lines(env: &Env, ev: &[JobEvent]) -> (Vec<String>, Vec<String>) {
    let (mut out, mut err) = (Vec::new(), Vec::new());
    for e in ev {
        match e {
            JobEvent::Stdout { line } => out.push(env.norm(line)),
            JobEvent::Progress { line } => {
                let l = line.as_str();
                let noise = ["Enumerating objects", "Counting objects", "Compressing objects", "Writing objects", "Total ", "Delta compression", "remote: Resolving", "remote: Compressing", "remote: Counting", "remote: Enumerating", "remote: Total"];
                if !noise.iter().any(|p| l.starts_with(p)) {
                    err.push(env.norm(l));
                }
            }
            JobEvent::Finished { .. } => {}
        }
    }
    (out, err)
}

/// 시각을 뺀 reflog 전부.
fn reflogs(work: &Path) -> String {
    let mut files = Vec::new();
    fn walk(p: &Path, out: &mut Vec<PathBuf>) {
        if let Ok(rd) = fs::read_dir(p) {
            for e in rd.flatten() {
                if e.path().is_dir() {
                    walk(&e.path(), out);
                } else {
                    out.push(e.path());
                }
            }
        }
    }
    walk(&work.join(".git/logs"), &mut files);
    files.sort();
    let mut s = String::new();
    for f in files {
        s.push_str(&format!("== {}\n", f.strip_prefix(work).unwrap().display()));
        for l in fs::read_to_string(&f).unwrap().lines() {
            // `<old> <new> <이름> <메일> <시각> <tz>\t<메시지>`
            let (head, msg) = l.split_once('\t').unwrap_or((l, ""));
            let words: Vec<&str> = head.split(' ').collect();
            // 신원이 없는 저장소의 reflog는 구현마다 대체 신원이 달라 신원 칸을 가린다
            let anon = !Command::new("git").current_dir(work).args(["config", "user.name"]).output().unwrap().status.success();
            let who = if anon { "<WHO>".to_owned() } else { words[2..words.len() - 2].join(" ") };
            s.push_str(&format!("{} {} {who}\t{msg}\n", words[0], words[1]));
        }
    }
    s
}

fn state(env: &Env) -> String {
    let remote = env.remote();
    let work = env.work();
    let fsck = Command::new("git").current_dir(&remote).args(["fsck", "--strict", "--no-dangling"]).output().unwrap();
    assert!(fsck.status.success(), "원격 fsck: {}", String::from_utf8_lossy(&fsck.stderr));
    let fsck_work = Command::new("git").current_dir(&work).args(["fsck", "--strict", "--no-dangling"]).output().unwrap();
    assert!(fsck_work.status.success());
    let refs = |d: &Path| git(d, &["for-each-ref", "--format=%(refname) %(objectname) %(objecttype)"]);
    let cfg = git(&work, &["config", "--local", "--list"]).lines().filter(|l| !l.starts_with("remote.origin.url=")).collect::<Vec<_>>().join("\n");
    format!("-- remote refs\n{}-- local refs\n{}-- config\n{cfg}\n-- reflogs\n{}-- HEAD\n{}", refs(&remote), refs(&work), reflogs(&work), git(&work, &["rev-parse", "HEAD"]))
}

fn kind_of(r: &gc_core::Result<()>) -> String {
    match r {
        Ok(()) => "ok".into(),
        Err(Error::Exit { code, .. }) => format!("exit {code:?}"),
        Err(Error::Unsupported(w)) => format!("UNSUPPORTED {w}"),
        Err(e) => format!("{e:?}"),
    }
}

struct Outcome {
    kind: String,
    out: Vec<String>,
    err: Vec<String>,
    state: String,
}

async fn both(base: &Path, kind: Kind, prep: &dyn Fn(&Env), argv: &[&str]) -> (Outcome, Outcome, Env) {
    let a = env_of(base, kind, None, None);
    let b = env_of(base, kind, None, None);
    prep(&a);
    prep(&b);
    let cli = CliBackend::new(GitRunner::default());
    let gix = GixBackend::new();
    let (ev_c, rc) = run_job(&cli, &a.work(), argv, None).await;
    let (ev_g, rg) = run_job(&gix, &b.work(), argv, None).await;
    let (oc, ec) = lines(&a, &ev_c);
    let (og, eg) = lines(&b, &ev_g);
    let c = Outcome { kind: kind_of(&rc), out: oc, err: ec, state: state(&a) };
    let g = Outcome { kind: kind_of(&rg), out: og, err: eg, state: state(&b) };
    (c, g, b)
}

/// 두 백엔드 결과가 같아야 한다. 같은 결과를 못 내 `Unsupported`면 실패로 본다(허용 모양이므로).
async fn same(label: &str, base: &Path, kind: Kind, prep: &dyn Fn(&Env), argv: &[&str]) -> Env {
    let (c, g, env) = both(base, kind, prep, argv).await;
    let what = format!("[{kind:?}] {label}: git {argv:?}");
    assert_eq!(c.kind, g.kind, "{what}: 결과\n  cli: {:?}\n  gix: {:?}", c.err, g.err);
    assert_eq!(c.out, g.out, "{what}: stdout");
    assert_eq!(c.err, g.err, "{what}: stderr 줄");
    assert_eq!(c.state, g.state, "{what}: 상태\n--- cli\n{}\n--- gix\n{}", c.state, g.state);
    env
}

fn none(_: &Env) {}

fn kinds() -> [Kind; 2] {
    [Kind::File, Kind::Http]
}

// ---------- 시험 ----------

#[tokio::test(flavor = "multi_thread")]
async fn fast_forward와_이미_최신과_새_원격_추적_ref가_같다() {
    let base = base();
    for kind in kinds() {
        let env = same("ff", base.path(), kind, &none, &["push", "--progress", "origin", "main"]).await;
        assert!(git(&env.remote(), &["log", "--format=%s", "main"]).starts_with("c2"));
        same("ff(인자 없음)", base.path(), kind, &none, &["push", "--progress"]).await;
        same("ff(--progress 없음)", base.path(), kind, &none, &["push", "origin", "main"]).await;
        // 이미 최신: 원격에 먼저 올려 둔다(추적 ref는 오래된 채)
        let up = |e: &Env| {
            git(&e.remote(), &["fetch", "-q", e.work().to_str().unwrap(), "main:main"]);
        };
        let env = same("이미 최신", base.path(), kind, &up, &["push", "--progress", "origin", "main"]).await;
        assert_eq!(git(&env.work(), &["rev-parse", "origin/main"]), git(&env.work(), &["rev-parse", "main"]));
        // 추적 ref가 지워진 채 이미 최신이면 만들어진다
        let up_del = |e: &Env| {
            up(e);
            git(&e.work(), &["update-ref", "-d", "refs/remotes/origin/main"]);
        };
        same("이미 최신, 추적 ref 없음", base.path(), kind, &up_del, &["push", "--progress", "origin", "main"]).await;
        // 이미 최신이면 같은 값은 reflog를 안 늘린다
        let synced = |e: &Env| {
            up(e);
            git(&e.work(), &["update-ref", "refs/remotes/origin/main", "main"]);
        };
        same("이미 최신, 추적 ref 같음", base.path(), kind, &synced, &["push", "--progress", "origin", "main"]).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn 새_브랜치와_u와_여러_종류의_객체가_같다() {
    let base = base();
    let prep = |e: &Env| {
        let w = e.work();
        git(&w, &["switch", "-q", "-c", "feature/큰것"]);
        write(&w, "feature/a.txt", b"a\n");
        write(&w, "feature/deep/er/b.txt", b"b\n");
        write(&w, "big.bin", &noise(300_000, 7));
        write(&w, "empty.txt", b"");
        commit(&w, "f1", 3);
        fs::remove_file(w.join("dir/sub/deep.txt")).unwrap();
        git(&w, &["mv", "한글 경로/파일.txt", "한글 경로/이름 바뀜.txt"]);
        write(&w, "run.sh", b"#!/bin/sh\necho changed\n");
        commit(&w, "f2: 삭제·이름 변경·수정", 4);
        git(&w, &["switch", "-q", "-c", "side", "main"]);
        write(&w, "side.txt", b"side\n");
        commit(&w, "side", 5);
        git(&w, &["switch", "-q", "feature/큰것"]);
        git_env(&w, &["merge", "-q", "--no-ff", "-m", "merge side", "side"], 6);
    };
    for kind in kinds() {
        let env = same("새 브랜치 -u", base.path(), kind, &prep, &["push", "--progress", "-u", "origin", "feature/큰것"]).await;
        assert!(git(&env.remote(), &["ls-tree", "-r", "--name-only", "feature/큰것"]).contains("big.bin"));
        assert_eq!(git(&env.work(), &["config", "branch.feature/큰것.merge"]).trim(), "refs/heads/feature/큰것");
        same("새 브랜치(-u 없음)", base.path(), kind, &prep, &["push", "--progress", "origin", "feature/큰것"]).await;
        // 원격에 이미 있는 브랜치 위에 쌓은 브랜치: 공통 객체는 안 보내도 서버 연결성 검사를 통과해야 한다
        same("main에서 갈라진 새 브랜치", base.path(), kind, &|e: &Env| {
            git(&e.work(), &["switch", "-q", "-c", "topic"]);
            write(&e.work(), "topic.txt", b"t\n");
            commit(&e.work(), "t1", 3);
        }, &["push", "--progress", "-u", "origin", "topic"]).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn 거절은_git과_같은_줄과_종료_코드를_낸다() {
    let base = base();
    // 원격에만 있는 커밋(로컬에 객체가 없음) → fetch first
    let remote_only = |e: &Env| {
        let other = e.root.path().join("other");
        git(e.root.path(), &["clone", "-q", e.remote().to_str().unwrap(), "other"]);
        for (k, v) in [("user.name", "o"), ("user.email", "o@o")] {
            git(&other, &["config", k, v]);
        }
        write(&other, "remote.txt", b"r\n");
        commit(&other, "원격 커밋", 8);
        git(&other, &["push", "-q", "origin", "main"]);
    };
    // 받아 온 뒤 갈라짐 → non-fast-forward
    let diverged = |e: &Env| {
        remote_only(e);
        git(&e.work(), &["fetch", "-q", "origin"]);
    };
    for kind in kinds() {
        let env = same("fetch first", base.path(), kind, &remote_only, &["push", "--progress", "origin", "main"]).await;
        assert!(!git(&env.remote(), &["log", "--format=%s", "main"]).contains("c2"));
        same("non-ff(현재 브랜치)", base.path(), kind, &diverged, &["push", "--progress", "origin", "main"]).await;
        same("non-ff(인자 없음)", base.path(), kind, &diverged, &["push", "--progress"]).await;
        let (c, g, _) = both(base.path(), kind, &diverged, &["push", "--progress", "origin", "main"]).await;
        assert_eq!(c.kind, "exit Some(1)");
        assert_eq!(g.kind, "exit Some(1)");
        assert!(g.err[1].contains("[rejected]") && g.err[1].ends_with("(non-fast-forward)"), "{:?}", g.err);
        // 현재 브랜치가 아닐 때는 hint가 다르다
        same("non-ff(다른 브랜치 위에서)", base.path(), kind, &|e: &Env| {
            diverged(e);
            git(&e.work(), &["switch", "-q", "-c", "elsewhere", "origin/main"]);
        }, &["push", "--progress", "origin", "main"]).await;
        // 없는 브랜치
        same("없는 브랜치", base.path(), kind, &none, &["push", "--progress", "origin", "nope"]).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn 서버가_ng하면_remote_rejected로_같다() {
    let base = base();
    let hook = |e: &Env| {
        let p = e.remote().join("hooks/pre-receive");
        write(&e.remote(), "hooks/pre-receive", "#!/bin/sh\necho \"규칙 위반: 안 됩니다\" >&2\nexit 1\n".as_bytes());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(p, fs::Permissions::from_mode(0o755)).unwrap();
        }
    };
    for kind in kinds() {
        let env = same("pre-receive 거절", base.path(), kind, &hook, &["push", "--progress", "origin", "main"]).await;
        // 거절되면 로컬 추적 ref는 그대로
        assert_ne!(git(&env.work(), &["rev-parse", "origin/main"]), git(&env.work(), &["rev-parse", "main"]));
        let (c, g, _) = both(base.path(), kind, &hook, &["push", "--progress", "-u", "origin", "main"]).await;
        assert_eq!(c.kind, g.kind);
        assert!(g.err.iter().any(|l| l.contains("[remote rejected]") && l.contains("pre-receive hook declined")), "{:?}", g.err);
        assert!(g.err.iter().any(|l| l.starts_with("remote: ")), "{:?}", g.err);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn 빈_원격과_많은_객체도_같다() {
    let base = base();
    let empty = |e: &Env| {
        git(&e.remote(), &["update-ref", "-d", "refs/heads/main"]);
    };
    let many = |e: &Env| {
        let w = e.work();
        for i in 0..40 {
            write(&w, &format!("many/d{}/f{i}.txt", i % 7), numbered(30 + i, &format!(" {i}")).as_bytes());
        }
        commit(&w, "많은 파일", 3);
        write(&w, "many/d1/f1.txt", b"changed\n");
        commit(&w, "수정", 4);
    };
    for kind in kinds() {
        same("빈 원격", base.path(), kind, &empty, &["push", "--progress", "-u", "origin", "main"]).await;
        same("많은 객체", base.path(), kind, &many, &["push", "--progress", "origin", "main"]).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn 받을_수_없는_모양과_설정은_거절한다() {
    let base = base();
    let env = env_of(base.path(), Kind::File, None, None);
    let w = env.work();
    let g = GixBackend::new();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    for argv in [
        &["push", "--force", "origin", "main"][..],
        &["push", "--progress", "--force-with-lease", "--force-if-includes", "origin", "main"],
        &["push", "--progress", "--tags", "origin", "main"],
        &["push", "--progress", "origin", "--delete", "refs/heads/x"],
        &["push", "--progress", "origin", "refs/tags/v1"],
        &["push", "--progress", "origin", "main:other"],
        &["push", "--progress", "-u"],
    ] {
        assert!(matches!(g.spawn_job(&w, argv, None, tx.clone()), Err(Error::Unsupported(_))), "{argv:?}");
    }
    let job = |w: PathBuf, argv: Vec<&'static str>| async move {
        let g = GixBackend::new();
        run_job(&g, &w, &argv, None).await.1
    };
    let unsupported = |r: gc_core::Result<()>, what: &str| assert!(matches!(r, Err(Error::Unsupported(_))), "{what}: {r:?}");
    let go = vec!["push", "--progress", "origin", "main"];
    // 설정에 없는 원격
    unsupported(job(w.clone(), vec!["push", "--progress", "nowhere", "main"]).await, "원격 없음");
    // pre-push 훅
    let hooked = env_of(base.path(), Kind::File, None, None);
    write(&hooked.work(), ".git/hooks/pre-push", b"#!/bin/sh\nexit 0\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(hooked.work().join(".git/hooks/pre-push"), fs::Permissions::from_mode(0o755)).unwrap();
    }
    unsupported(job(hooked.work(), go.clone()).await, "pre-push");
    // 설정
    for (k, v) in [("push.followTags", "true"), ("push.gpgSign", "if-asked"), ("push.recurseSubmodules", "check"), ("remote.origin.mirror", "true"), ("advice.pushUpdateRejected", "false"), ("remote.origin.receivepack", "x")] {
        let e = env_of(base.path(), Kind::File, None, None);
        git(&e.work(), &["config", k, v]);
        unsupported(job(e.work(), go.clone()).await, k);
    }
    // 주소: ssh·git://·상대 경로·여러 개
    for url in ["ssh://git@example.com/x.git", "git@example.com:x/y.git", "git://example.com/x.git", "../o.git"] {
        let e = env_of(base.path(), Kind::File, None, None);
        git(&e.work(), &["config", "remote.origin.url", url]);
        unsupported(job(e.work(), go.clone()).await, url);
    }
    let e = env_of(base.path(), Kind::File, None, None);
    git(&e.work(), &["config", "--add", "remote.origin.url", "https://example.com/x.git"]);
    unsupported(job(e.work(), go.clone()).await, "주소 여럿");
    // 인자 없는 push: 추적 정보 없음·이름이 다른 추적·push.default
    let e = env_of(base.path(), Kind::File, None, None);
    git(&e.work(), &["switch", "-q", "-c", "lonely"]);
    unsupported(job(e.work(), vec!["push", "--progress"]).await, "추적 없음");
    let e = env_of(base.path(), Kind::File, None, None);
    git(&e.work(), &["config", "branch.main.merge", "refs/heads/other"]);
    unsupported(job(e.work(), vec!["push", "--progress"]).await, "다른 이름 추적");
    let e = env_of(base.path(), Kind::File, None, None);
    git(&e.work(), &["config", "push.default", "upstream"]);
    unsupported(job(e.work(), vec!["push", "--progress"]).await, "push.default=upstream");
    // 태그와 이름이 겹치는 브랜치
    let e = env_of(base.path(), Kind::File, None, None);
    git(&e.work(), &["tag", "main"]);
    unsupported(job(e.work(), go.clone()).await, "모호한 이름");
}

#[tokio::test(flavor = "multi_thread")]
async fn 인증은_url의_자격_증명을_쓰고_실패하면_hosting_unauthorized다() {
    let base = base();
    let auth = Some(("user", "secret"));
    // 맞는 토큰: 성공하고 결과가 CLI와 같다
    let run = |creds: Option<(&'static str, &'static str)>| {
        let base = base.path().to_path_buf();
        async move {
            let a = env_of(&base, Kind::Http, auth, creds);
            let b = env_of(&base, Kind::Http, auth, creds);
            let out = Command::new("git").current_dir(a.work()).args(["push", "--progress", "origin", "main"]).output().unwrap();
            let cli_code = out.status.code();
            let cli_err = String::from_utf8_lossy(&out.stderr).into_owned();
            let (ev, res) = run_job(&GixBackend::new(), &b.work(), &["push", "--progress", "origin", "main"], Some(false)).await;
            (cli_code, cli_err, res, lines(&b, &ev).1, a, b)
        }
    };
    let (code, _, res, err, a, b) = run(Some(("user", "secret"))).await;
    assert_eq!(code, Some(0));
    assert!(res.is_ok(), "{res:?} {err:?}");
    assert_eq!(state(&a), state(&b), "성공한 인증의 결과");
    assert!(err.iter().any(|l| l.starts_with("To http://127.0.0.1:")), "자격 증명은 To 줄에 보이지 않는다: {err:?}");
    assert!(err.iter().all(|l| !l.contains("secret")), "{err:?}");
    // 틀린 토큰 / 자격 증명 없음: 실패하고 원격은 그대로
    for creds in [Some(("user", "wrong")), None] {
        let (code, cli_err, res, err, _, b) = run(creds).await;
        assert_eq!(code, Some(128), "{cli_err}");
        match res {
            Err(Error::Coded(c)) => assert_eq!(c.code, "hosting.unauthorized", "{c:?}"),
            other => panic!("{creds:?}: {other:?} {err:?}"),
        }
        assert!(!git(&b.remote(), &["log", "--format=%s", "main"]).contains("c2"));
        assert_ne!(git(&b.work(), &["rev-parse", "origin/main"]), git(&b.work(), &["rev-parse", "main"]));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn 취소하면_원격은_바뀌지_않거나_끝까지_올라간다() {
    let base = base();
    for kind in kinds() {
        let env = env_of(base.path(), kind, None, None);
        write(&env.work(), "huge.bin", &noise(3_000_000, 3));
        commit(&env.work(), "큰 파일", 3);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let (handle, task) = GixBackend::new().spawn_job(&env.work(), &["push", "--progress", "origin", "main"], None, tx).unwrap();
        drop(handle); // 모든 핸들이 drop되면 취소
        let res = task.await.unwrap();
        while rx.try_recv().is_ok() {}
        let remote_main = git(&env.remote(), &["rev-parse", "main"]);
        let local = git(&env.work(), &["rev-parse", "main"]);
        match res {
            Err(Error::Cancelled) => assert_ne!(remote_main, local, "취소했는데 올라갔다"),
            Ok(()) => assert_eq!(remote_main, local),
            other => panic!("{other:?}"),
        }
        git(&env.remote(), &["fsck", "--strict", "--no-dangling"]);
    }
}

// ---------- 앱 계정 토큰 ----------

/// 시험용 `TokenSource`: `host:port` → (사용자, 토큰). 포트가 시험마다 달라 서로 겹치지 않는다.
struct Tokens(std::sync::Mutex<HashMap<String, (String, String)>>);

impl TokenSource for Tokens {
    fn token(&self, host: &str) -> Option<(String, String)> {
        self.0.lock().unwrap().get(host).cloned()
    }
}

fn tokens() -> &'static Tokens {
    static T: std::sync::OnceLock<&'static Tokens> = std::sync::OnceLock::new();
    T.get_or_init(|| {
        let t: &'static Tokens = Box::leak(Box::new(Tokens(Default::default())));
        struct Forward(&'static Tokens);
        impl TokenSource for Forward {
            fn token(&self, host: &str) -> Option<(String, String)> {
                self.0.token(host)
            }
        }
        set_token_source(Some(Arc::new(Forward(t))));
        t
    })
}

/// `dir` 아래 모든 파일(.git 포함)의 바이트에 `needle`이 없어야 한다.
fn assert_absent(dir: &Path, needle: &str) {
    fn walk(p: &Path, needle: &[u8], hits: &mut Vec<PathBuf>) {
        for e in fs::read_dir(p).unwrap().flatten() {
            let path = e.path();
            if path.is_dir() {
                walk(&path, needle, hits);
            } else if let Ok(b) = fs::read(&path) {
                if b.windows(needle.len()).any(|w| w == needle) {
                    hits.push(path);
                }
            }
        }
    }
    let mut hits = Vec::new();
    walk(dir, needle.as_bytes(), &mut hits);
    assert!(hits.is_empty(), "토큰이 파일에 남았다: {hits:?}");
}

fn port_of(e: &Env) -> u16 {
    e._server.as_ref().unwrap().port
}

#[tokio::test(flavor = "multi_thread")]
async fn 계정_토큰으로_clone_fetch_pull_push가_되고_토큰은_어디에도_남지_않는다() {
    let base = base();
    let t = tokens();
    let env = env_of(base.path(), Kind::Http, Some(("kim", "s3cr3t-tok")), None);
    t.0.lock().unwrap().insert(format!("127.0.0.1:{}", port_of(&env)), ("kim".into(), "s3cr3t-tok".into()));
    let url = format!("http://127.0.0.1:{}/o.git", port_of(&env));
    let g = GixBackend::new();
    let mut all_lines: Vec<String> = Vec::new();
    let mut keep = |ev: &[JobEvent]| {
        for e in ev {
            match e {
                JobEvent::Stdout { line } | JobEvent::Progress { line } => all_lines.push(line.clone()),
                JobEvent::Finished { .. } => {}
            }
        }
    };
    // clone
    let parent = tempfile::tempdir().unwrap();
    let (ev, res) = run_job(&g, parent.path(), &["clone", "--progress", "--", &url, "cl"], None).await;
    keep(&ev);
    res.unwrap_or_else(|e| panic!("clone: {e:?}"));
    let cl = parent.path().join("cl");
    assert_eq!(git(&cl, &["config", "remote.origin.url"]).trim(), url);
    // 전역 설정이 없는 시험 환경이라 reflog용 신원을 넣어 준다(gix fetch는 reflog를 쓰려면 committer가 필요하다)
    git(&cl, &["config", "user.name", "k"]);
    git(&cl, &["config", "user.email", "k@k"]);
    // push (work → 원격), 그 다음 clone 쪽에서 fetch·pull
    let work = env.work();
    let (ev, res) = run_job(&g, &work, &["push", "--progress", "origin", "main"], None).await;
    keep(&ev);
    res.unwrap_or_else(|e| panic!("push: {e:?}"));
    assert!(git(&env.remote(), &["log", "--format=%s", "main"]).starts_with("c2"));
    let (ev, res) = run_job(&g, &cl, &["fetch"], None).await;
    keep(&ev);
    res.unwrap_or_else(|e| panic!("fetch: {e:?}"));
    assert_eq!(git(&cl, &["rev-parse", "origin/main"]), git(&work, &["rev-parse", "main"]));
    let (ev, res) = run_job(&g, &cl, &["pull", "--progress", "--ff-only"], None).await;
    keep(&ev);
    res.unwrap_or_else(|e| panic!("pull: {e:?}"));
    assert_eq!(git(&cl, &["rev-parse", "HEAD"]), git(&work, &["rev-parse", "main"]));
    // 토큰 비노출: 작업 저장소·복제본의 모든 파일(설정·reflog·객체), 이벤트 줄
    for d in [&cl, &work] {
        assert_absent(d, "s3cr3t-tok");
    }
    assert!(all_lines.iter().all(|l| !l.contains("s3cr3t-tok")), "{all_lines:?}");

    // 틀린 토큰: 인증 오류, 원격은 그대로, 오류 문구에 토큰이 없다
    let bad = env_of(base.path(), Kind::Http, Some(("kim", "right")), None);
    t.0.lock().unwrap().insert(format!("127.0.0.1:{}", port_of(&bad)), ("kim".into(), "wr0ng-tok".into()));
    let (ev, res) = run_job(&g, &bad.work(), &["push", "--progress", "origin", "main"], None).await;
    match &res {
        Err(Error::Coded(c)) => assert_eq!(c.code, "hosting.unauthorized"),
        other => panic!("{other:?}"),
    }
    assert!(!format!("{res:?} {ev:?}").contains("wr0ng-tok"));
    assert!(!git(&bad.remote(), &["log", "--format=%s", "main"]).contains("c2"));
    let (_, res) = run_job(&g, &bad.work(), &["fetch"], None).await;
    assert!(matches!(&res, Err(Error::Coded(c)) if c.code == "hosting.unauthorized"), "{res:?}");
    let parent2 = tempfile::tempdir().unwrap();
    let burl = format!("http://127.0.0.1:{}/o.git", port_of(&bad));
    let (_, res) = run_job(&g, parent2.path(), &["clone", "--", &burl, "x"], None).await;
    assert!(matches!(&res, Err(Error::Coded(c)) if c.code == "hosting.unauthorized"), "{res:?}");
    assert!(!parent2.path().join("x").exists(), "실패한 복제의 폴더가 남았다");
    assert_absent(&bad.work(), "wr0ng-tok");

    // 우선순위: URL의 자격 증명이 앱 계정보다 먼저(계정 토큰이 틀려도 URL 쪽이 맞으면 성공)
    let both = env_of(base.path(), Kind::Http, Some(("kim", "right")), Some(("kim", "right")));
    t.0.lock().unwrap().insert(format!("127.0.0.1:{}", port_of(&both)), ("kim".into(), "wr0ng-tok".into()));
    let (_, res) = run_job(&g, &both.work(), &["push", "--progress", "origin", "main"], None).await;
    res.unwrap_or_else(|e| panic!("URL 자격 증명 우선: {e:?}"));
}

// ---------- reflog 신원 ----------

/// 신원(`user.name|email`)이 없는 저장소에서도 fetch·pull·branch·switch는 성공한다(git은 reflog에 대체 신원을 씀). 커밋만 거절한다.
#[tokio::test(flavor = "multi_thread")]
async fn 신원이_없어도_reflog를_쓰는_작업은_성공하고_커밋만_거절한다() {
    let base = base();
    let prep = |e: &Env| {
        let other = e.root.path().join("other");
        git(e.root.path(), &["clone", "-q", e.remote().to_str().unwrap(), "other"]);
        for (k, v) in [("user.name", "o"), ("user.email", "o@o")] {
            git(&other, &[ "config", k, v]);
        }
        write(&other, "r.txt", b"r\n");
        commit(&other, "원격 커밋", 8);
        git(&other, &["push", "-q", "origin", "main"]);
        // 로컬: 한 커밋 뒤처지게 되돌리고 신원 설정을 지운다
        git(&e.work(), &["reset", "-q", "--hard", "HEAD~1"]);
        git(&e.work(), &["config", "--unset", "user.name"]);
        git(&e.work(), &["config", "--unset", "user.email"]);
    };
    let refs = |d: &Path| git(d, &["for-each-ref", "--format=%(refname) %(objectname)"]);
    // fetch·pull은 spawn_job, branch·switch는 run
    for argv in [&["fetch"][..], &["pull", "--progress", "--ff-only", "origin", "main"]] {
        let (a, b) = (env_of(base.path(), Kind::File, None, None), env_of(base.path(), Kind::File, None, None));
        prep(&a);
        prep(&b);
        let (_, rc) = run_job(&CliBackend::new(GitRunner::default()), &a.work(), argv, None).await;
        let (_, rg) = run_job(&GixBackend::new(), &b.work(), argv, None).await;
        assert!(rc.is_ok() && rg.is_ok(), "{argv:?}: cli {rc:?} gix {rg:?}");
        assert_eq!(refs(&a.work()), refs(&b.work()), "{argv:?}");
        assert_eq!(git(&a.work(), &["rev-parse", "HEAD"]), git(&b.work(), &["rev-parse", "HEAD"]));
        git(&b.work(), &["fsck", "--strict", "--no-dangling"]);
    }
    let (a, b) = (env_of(base.path(), Kind::File, None, None), env_of(base.path(), Kind::File, None, None));
    prep(&a);
    prep(&b);
    for argv in [&["branch", "newb"][..], &["switch", "-c", "x", "origin/main"], &["switch", "newb"], &["branch", "-m", "newb", "renamed"]] {
        let rc = CliBackend::new(GitRunner::default()).run(&a.work(), argv, &[]).await;
        let rg = GixBackend::new().run(&b.work(), argv, &[]).await;
        assert!(rc.is_ok() && rg.is_ok(), "{argv:?}: cli {rc:?} gix {rg:?}");
        assert_eq!(refs(&a.work()), refs(&b.work()), "{argv:?}");
    }
    assert_eq!(reflogs(&a.work()).replace("\n", "|").contains("<WHO>"), true);
    // 신원이 없는 reflog는 대체 신원 하나로 일관돼야 한다(빈 이름·메일이 아님)
    let log = fs::read_to_string(b.work().join(".git/logs/refs/heads/x")).unwrap();
    assert!(!log.contains("<>") && !log.contains("  <"), "{log}");
    // 커밋은 거절
    write(&b.work(), "n.txt", b"n\n");
    git(&b.work(), &["add", "-A"]);
    let r = GixBackend::new().commit(&b.work(), "msg", false).await;
    assert!(matches!(r, Err(Error::Unsupported(_)) | Err(Error::Exit { .. })), "{r:?}");
}
