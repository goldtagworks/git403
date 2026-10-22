//! stdio 서버(`git403-server`) 통합 테스트: 실제 프로세스를 띄워 임시 git 저장소로 프로토콜을 검증한다.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};

struct Server {
    child: Child,
    stdin: Option<ChildStdin>,
    out: BufReader<ChildStdout>,
}

impl Server {
    fn start(config: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_git403-server"))
            .arg("--config-dir")
            .arg(config)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let out = BufReader::new(child.stdout.take().unwrap());
        Self { stdin: child.stdin.take(), child, out }
    }

    fn send(&mut self, req: Value) {
        let w = self.stdin.as_mut().unwrap();
        writeln!(w, "{req}").unwrap();
        w.flush().unwrap();
    }

    fn line(&mut self) -> Value {
        let mut s = String::new();
        assert!(self.out.read_line(&mut s).unwrap() > 0, "서버가 먼저 끝남");
        serde_json::from_str(&s).unwrap_or_else(|e| panic!("JSON이 아님 {s:?}: {e}"))
    }

    /// `id` 응답이 올 때까지 읽는다. 사이에 온 이벤트는 모아서 돌려준다.
    fn response(&mut self, id: u64) -> (Value, Vec<Value>) {
        let mut events = vec![];
        loop {
            let v = self.line();
            if v.get("event").is_some() {
                events.push(v);
            } else if v["id"] == id {
                return (v, events);
            }
        }
    }

    fn call(&mut self, id: u64, cmd: &str, args: Value) -> Value {
        self.send(json!({"id": id, "cmd": cmd, "args": args}));
        self.response(id).0
    }
}

fn git(dir: &Path, args: &[&str]) {
    let st = Command::new("git")
        .current_dir(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
        .args(args)
        .status()
        .unwrap();
    assert!(st.success(), "git {args:?}");
}

fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    git(d.path(), &["init", "-q", "-b", "main"]);
    std::fs::write(d.path().join("a.txt"), "a\n").unwrap();
    git(d.path(), &["add", "."]);
    git(d.path(), &["commit", "-q", "-m", "first"]);
    git(d.path(), &["tag", "v1"]);
    std::fs::write(d.path().join("a.txt"), "b\n").unwrap();
    git(d.path(), &["commit", "-q", "-am", "second"]);
    d
}

#[test]
fn 그래프와_참조_응답_형식() {
    let (cfg, r) = (tempfile::tempdir().unwrap(), repo());
    let repo = r.path().to_string_lossy().into_owned();
    let mut s = Server::start(cfg.path());

    let g = s.call(1, "load_graph", json!({"repo": repo, "limit": 100}));
    assert_eq!(g["id"], 1);
    let commits = g["ok"]["commits"].as_array().expect("commits");
    assert_eq!(commits.len(), 2);
    assert_eq!(commits[0]["subject"], "second");
    assert!(g["ok"]["layout"].is_object());
    assert!(g.get("err").is_none());

    let refs = s.call(2, "load_refs", json!({"repo": repo}));
    let names: Vec<&str> = refs["ok"].as_array().unwrap().iter().map(|r| r["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"main") && names.contains(&"v1"), "{names:?}");

    // 인자 없는 명령·null 반환
    assert!(s.call(3, "git_version", json!({}))["ok"].is_string());
    assert_eq!(s.call(4, "set_locale", json!({"locale": "en"}))["ok"], Value::Null);
}

#[test]
fn 오류는_err_로_돌려준다() {
    let (cfg, r) = (tempfile::tempdir().unwrap(), repo());
    let mut s = Server::start(cfg.path());

    let v = s.call(10, "no_such_command", json!({}));
    assert_eq!(v["id"], 10);
    assert!(v["err"].as_str().unwrap().contains("unknown command"), "{v}");
    assert!(v.get("ok").is_none());

    // 필수 인자 누락
    let v = s.call(11, "load_refs", json!({}));
    assert!(v["err"].as_str().unwrap().contains("repo"), "{v}");

    // git 실패 (저장소 아님)
    let not_repo = tempfile::tempdir().unwrap();
    let v = s.call(12, "load_refs", json!({"repo": not_repo.path()}));
    assert!(v["err"].is_string(), "{v}");

    // 깨진 줄은 id null 오류, 서버는 계속 산다
    writeln!(s.stdin.as_mut().unwrap(), "not json").unwrap();
    let v = s.line();
    assert!(v["id"].is_null() && v["err"].is_string(), "{v}");
    assert!(s.call(13, "load_refs", json!({"repo": r.path()}))["ok"].is_array());
}

#[test]
fn 요청은_동시에_처리된다() {
    let (cfg, r) = (tempfile::tempdir().unwrap(), repo());
    let mut s = Server::start(cfg.path());
    for id in 20..30 {
        s.send(json!({"id": id, "cmd": "load_refs", "args": {"repo": r.path()}}));
    }
    let mut seen = std::collections::BTreeSet::new();
    while seen.len() < 10 {
        let v = s.line();
        assert!(v["ok"].is_array());
        seen.insert(v["id"].as_u64().unwrap());
    }
    assert_eq!(seen, (20..30).collect());
}

#[test]
fn 작업_이벤트_형식과_순서() {
    let (cfg, r) = (tempfile::tempdir().unwrap(), repo());
    let mut s = Server::start(cfg.path());
    s.send(json!({"id": 1, "cmd": "start_job", "args": {"repo": r.path(), "args": ["status"]}}));
    let (resp, mut events) = s.response(1);
    let job = resp["ok"].as_u64().expect("작업 번호");
    // job-done이 올 때까지 (응답보다 먼저 온 이벤트 포함)
    while !events.iter().any(|e| e["event"] == "job-done") {
        events.push(s.line());
    }
    let done = events.last().unwrap();
    assert_eq!(done["event"], "job-done");
    assert_eq!(done["payload"], json!([job, null]));
    let jobs: Vec<_> = events.iter().filter(|e| e["event"] == "job").collect();
    assert!(!jobs.is_empty());
    assert!(jobs.iter().all(|e| e["payload"]["job"] == job && e["payload"]["event"].is_object()));
}

#[test]
fn 감시_이벤트와_stdin_종료() {
    let (cfg, r) = (tempfile::tempdir().unwrap(), repo());
    let mut s = Server::start(cfg.path());
    assert_eq!(s.call(1, "watch_repo", json!({"repo": r.path()}))["ok"], Value::Null);
    std::fs::write(r.path().join("new.txt"), "x").unwrap();
    let ev = loop {
        let v = s.line();
        if v["event"] == "repo-changed" {
            break v;
        }
    };
    assert_eq!(ev["payload"]["worktree"], true);
    assert!(ev["payload"]["refs"].is_boolean());
    assert_eq!(ev["payload"]["repo"], json!(r.path()));

    // 오래 걸리는 작업을 띄운 채 stdin을 닫으면 서버가 끝난다
    s.send(json!({"id": 2, "cmd": "start_shell", "args": {"repo": r.path(), "command": "sleep 30"}}));
    s.response(2);
    drop(s.stdin.take());
    let start = std::time::Instant::now();
    let status = s.child.wait().unwrap();
    assert!(status.success());
    assert!(start.elapsed().as_secs() < 10);
}

#[test]
fn 여러_저장소_감시_추가_제거() {
    let (cfg, a, b) = (tempfile::tempdir().unwrap(), repo(), repo());
    let mut s = Server::start(cfg.path());
    assert_eq!(s.call(1, "watch_add", json!({"repo": a.path()}))["ok"], Value::Null);
    assert_eq!(s.call(2, "watch_add", json!({"repo": b.path()}))["ok"], Value::Null);
    let next = |s: &mut Server| loop {
        let v = s.line();
        if v["event"] == "repo-changed" {
            break v;
        }
    };
    for (r, n) in [(&a, 1), (&b, 2)] {
        std::fs::write(r.path().join(format!("n{n}.txt")), "x").unwrap();
        let ev = next(&mut s);
        assert_eq!(ev["payload"]["repo"], json!(r.path()));
        assert_eq!(ev["payload"]["worktree"], true);
    }
    // a를 빼면 a의 변경은 오지 않고 b의 변경만 온다
    assert_eq!(s.call(3, "watch_remove", json!({"repo": a.path()}))["ok"], Value::Null);
    std::fs::write(a.path().join("after.txt"), "x").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(600));
    std::fs::write(b.path().join("after.txt"), "x").unwrap();
    let ev = next(&mut s);
    assert_eq!(ev["payload"]["repo"], json!(b.path()));
}

#[test]
fn 감시_추가_직후_제거하면_이벤트가_없다() {
    let (cfg, a, b) = (tempfile::tempdir().unwrap(), repo(), repo());
    let mut s = Server::start(cfg.path());
    // 요청은 동시에 처리돼 연달아 보내면 remove가 add보다 먼저 처리될 수 있다(그러면 add가 정상적으로 감시를 건다).
    // 순서를 확정하려고 add 응답 뒤에 remove하고, remove 응답 이후에 만든 변경만 검사한다.
    // (응답 전에 온 이벤트는 add 시작 전의 저장소 준비 변경일 수 있어 무시한다)
    assert_eq!(s.call(1, "watch_add", json!({"repo": a.path()}))["ok"], Value::Null);
    assert_eq!(s.call(2, "watch_remove", json!({"repo": a.path()}))["ok"], Value::Null);
    assert_eq!(s.call(3, "watch_add", json!({"repo": b.path()}))["ok"], Value::Null);
    std::fs::write(a.path().join("x.txt"), "x").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(600));
    std::fs::write(b.path().join("y.txt"), "y").unwrap();
    loop {
        let v = s.line();
        if v["event"] == "repo-changed" {
            assert_eq!(v["payload"]["repo"], json!(b.path()), "제거한 저장소의 이벤트가 옴");
            break;
        }
    }
}

#[test]
fn 감시는_저장소가_아닌_경로를_거부한다() {
    let (cfg, plain) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let mut s = Server::start(cfg.path());
    for cmd in ["watch_add", "watch_repo"] {
        for p in [plain.path().to_path_buf(), plain.path().join("없음"), "/".into()] {
            let r = s.call(1, cmd, json!({"repo": p}));
            assert!(r["err"].is_string(), "{cmd} {p:?}: {r}");
        }
    }
}

#[test]
fn askpass_이벤트와_응답() {
    let (cfg, r) = (tempfile::tempdir().unwrap(), repo());
    let mut s = Server::start(cfg.path());
    // 서버 실행 파일이 GIT_ASKPASS 도우미다: 인증이 필요한 원격에 fetch하면 askpass 이벤트가 온다 (로컬 http 서버가 401을 돌려줌)
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for st in listener.incoming().flatten() {
            let mut st = st;
            let mut b = BufReader::new(st.try_clone().unwrap());
            let mut l = String::new();
            let mut authed = false;
            while b.read_line(&mut l).is_ok_and(|n| n > 0) && l != "\r\n" {
                authed |= l.to_ascii_lowercase().starts_with("authorization:");
                l.clear();
            }
            let _ = write!(st, "HTTP/1.1 {} X\r\nWWW-Authenticate: Basic realm=\"t\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", if authed { 403 } else { 401 });
        }
    });
    git(r.path(), &["remote", "add", "origin", &format!("http://127.0.0.1:{port}/x.git")]);
    s.send(json!({"id": 1, "cmd": "start_job", "args": {"repo": r.path(), "args": ["fetch", "origin"]}}));
    let mut ask = None;
    let mut done = false;
    while !done {
        let v = s.line();
        match v["event"].as_str() {
            Some("askpass") if ask.is_none() => {
                let (id, prompt) = (v["payload"]["id"].as_u64().unwrap(), v["payload"]["prompt"].as_str().unwrap().to_owned());
                assert!(prompt.contains("Username") || prompt.contains("Password"), "{prompt}");
                ask = Some(id);
                s.send(json!({"id": 2, "cmd": "askpass_reply", "args": {"id": id, "answer": null}}));
            }
            Some("askpass") => {
                let id = v["payload"]["id"].as_u64().unwrap();
                s.send(json!({"id": 3, "cmd": "askpass_reply", "args": {"id": id, "answer": null}}));
            }
            Some("job-done") => done = true,
            _ => {}
        }
    }
    assert!(ask.is_some(), "askpass 이벤트가 오지 않음");
}
