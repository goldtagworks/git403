//! 긴 작업 하나의 수명: 이벤트(`JobEvent`)·취소 핸들(`JobHandle`)은 공용이고,
//! 프로세스 출력을 줄 단위로 펌프하고 프로세스 트리를 종료하는 부분은 feature `cli`에서만 컴파일된다.

#[cfg(feature = "cli")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(feature = "cli")]
use std::sync::Arc;

use serde::Serialize;
#[cfg(feature = "cli")]
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
#[cfg(feature = "cli")]
use tokio::process::Command;
#[cfg(feature = "cli")]
use tokio::sync::mpsc;
use tokio::sync::watch;

#[cfg(feature = "cli")]
use crate::{Error, Result};

/// 실행 중인 작업에서 나오는 이벤트. UI로 그대로 전달된다.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum JobEvent {
    Stdout { line: String },
    /// git은 진행률(`Receiving objects: 42%`)을 stderr에 `\r`로 갱신하며 쓴다.
    Progress { line: String },
    Finished { code: Option<i32> },
    /// 같은 저장소의 앞선 작업이 끝나길 기다리는 중(백엔드 대기열). 프로세스는 아직 없다
    Waiting,
    /// 대기가 끝나 프로세스를 시작했다
    Started,
}

/// 작업 취소용 핸들. **모든 복제본이 drop되면 작업은 취소된다**(= drop은 취소). 끝날 때까지 들고 있을 것.
#[derive(Clone)]
pub struct JobHandle {
    cancel: watch::Sender<bool>,
    #[cfg(feature = "cli")]
    pid: Option<u32>,
    /// 자식이 끝났으면 true (끝난 pid의 프로세스 그룹을 건드리지 않기 위해)
    #[cfg(feature = "cli")]
    done: Arc<AtomicBool>,
}

impl JobHandle {
    pub fn cancel(&self) {
        let _ = self.cancel.send(true);
    }

    /// 비동기 런타임 없이 지금 바로 **강제로** 프로세스 트리를 끝낸다(SIGKILL — git이 `.lock`을 못 지운다). 결과는 `Cancelled`로 보고된다. 앱 종료 정리는 `stop_all`을 쓴다.
    pub fn kill_now(&self) {
        let _ = self.cancel.send(true);
        #[cfg(feature = "cli")]
        if !self.done.load(Ordering::SeqCst) {
            kill_tree(self.pid);
        }
    }

    /// 앱 종료 정리용(비동기 런타임 없이 동기로): 모든 작업에 먼저 정중한 종료 요청(Unix SIGTERM, Windows CTRL_C)을 보내고 `grace`까지 기다린 뒤, 안 끝난 것만 강제로 끝낸다.
    /// git은 SIGTERM에서 `.lock` 임시 파일을 지우므로 앱을 끌 때도 lock이 남지 않는다. 한꺼번에 요청하고 한꺼번에 기다려 작업이 많아도 총 `grace`를 넘지 않는다.
    pub fn stop_all(handles: &[JobHandle], grace: std::time::Duration) {
        #[cfg(feature = "cli")]
        {
            let live = |h: &&JobHandle| !h.done.load(Ordering::SeqCst);
            for h in handles.iter().filter(live) {
                terminate_tree(h.pid);
            }
            let t = std::time::Instant::now();
            while t.elapsed() < grace && handles.iter().filter(live).any(|h| process_alive(h.pid)) {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            for h in handles {
                let _ = h.cancel.send(true);
                if live(&h) {
                    kill_tree(h.pid); // 남은 자손·안 끝난 프로세스는 강제로
                }
            }
        }
        #[cfg(not(feature = "cli"))]
        for h in handles {
            let _ = h.cancel.send(true);
        }
    }
}

#[cfg(feature = "gix")]
impl JobHandle {
    /// 프로세스가 없는 작업(순수 Rust 백엔드)용 핸들. 돌려주는 수신기가 `true`가 되거나(취소) 모든 복제본이 drop되면 취소다.
    pub(crate) fn detached() -> (JobHandle, watch::Receiver<bool>) {
        let (tx, rx) = watch::channel(false);
        (JobHandle { cancel: tx, #[cfg(feature = "cli")] pid: None, #[cfg(feature = "cli")] done: Arc::new(AtomicBool::new(false)) }, rx)
    }
}

#[cfg(feature = "cli")]
pub(crate) fn run_job(
    mut cmd: Command,
    events: mpsc::UnboundedSender<JobEvent>,
) -> Result<(JobHandle, tokio::task::JoinHandle<Result<()>>)> {
    let mut child = cmd.spawn()?;
    let pid = child.id();
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    let done = Arc::new(AtomicBool::new(false));
    let done_task = done.clone();

    let out_task = tokio::spawn(pump(stdout, events.clone(), false));
    let err_task = tokio::spawn(pump(stderr, events.clone(), true));

    let task = tokio::spawn(async move {
        let status = tokio::select! {
            status = child.wait() => {
                done_task.store(true, Ordering::SeqCst);
                status?
            }
            // `watch::Ref`는 Send가 아니므로 블록 안에서 바로 버린다. Sender가 전부 drop돼도(Err) 취소로 본다.
            _ = async { let _ = cancel_rx.wait_for(|c| *c).await; } => {
                // 먼저 정중히(Unix SIGTERM, Windows `taskkill` /F 없이) 끝내 달라고 하고 유예한다: git은 SIGTERM에서 `.lock` 임시 파일을 지운다.
                // SIGKILL로 바로 죽이면 `index.lock`·`refs/….lock`이 남아 이후 fetch·pull이 `File exists`로 계속 실패한다. 유예 안에 안 끝나면 그때 강제로 끝낸다
                // (Windows의 `taskkill`·콘솔 조작은 블로킹이라 블로킹 스레드에서 돌린다)
                let _ = tokio::task::spawn_blocking(move || terminate_tree(pid)).await;
                let _ = tokio::time::timeout(CANCEL_GRACE, child.wait()).await;
                let _ = tokio::task::spawn_blocking(move || kill_tree(pid)).await; // 남은 자손(훅·필터 프로세스)까지 정리하고, 아직 살아 있으면 강제 종료
                let _ = child.kill().await;
                done_task.store(true, Ordering::SeqCst);
                // 그룹 종료가 안 먹은 손자가 파이프를 쥐고 있어도 읽기 태스크가 남지 않게 한다
                out_task.abort();
                err_task.abort();
                return Err(Error::Cancelled);
            }
        };
        let stderr_tail = err_task.await.unwrap_or_default();
        let _ = out_task.await;
        let _ = events.send(JobEvent::Finished { code: status.code() });
        if status.success() {
            Ok(())
        } else {
            Err(Error::Exit { code: status.code(), stderr: stderr_tail })
        }
    });

    Ok((JobHandle { cancel: cancel_tx, pid, done }, task))
}

/// 취소 때 자식이 스스로 정리(잠금 파일 삭제)하도록 기다려 주는 시간
#[cfg(feature = "cli")]
const CANCEL_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

/// 프로세스 트리에 정중한 종료 요청: Unix는 프로세스 그룹에 SIGTERM.
/// **Windows**: git은 `CREATE_NO_WINDOW`로 띄워 자기만의 숨은 콘솔을 가진다(`runner.rs`). 그 콘솔에 붙어(`AttachConsole`) **`CTRL_C_EVENT`**를 보내면 git(MSYS/CRT)의 SIGINT 처리(`sigchain`의 임시 파일·`.lock` 정리)가 돈다.
/// `CTRL_BREAK`+`CREATE_NEW_PROCESS_GROUP`을 쓰지 않는 이유: CRT는 CTRL_BREAK를 SIGBREAK로 올리는데 git의 `sigchain`은 SIGINT·SIGHUP·SIGTERM·SIGQUIT·SIGPIPE만 걸어 정리가 돌지 않고,
/// 새 프로세스 그룹은 CTRL_C를 꺼 둔다(문서: `CREATE_NEW_PROCESS_GROUP`은 그 프로세스의 CTRL+C 처리를 끈다). 숨은 콘솔은 자식 트리만 쓰므로 `GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)`는 그 트리에만 닿는다.
/// 이어서 유예 뒤 `kill_tree`의 `taskkill /F`가 정리한다. 콘솔에 붙지 못하면(이미 끝난 프로세스 등) `taskkill /T`(강제 아님)로 대신한다. Windows 실기 검증은 하지 못했다(정적 분석·cfg 정합).
#[cfg(feature = "cli")]
fn terminate_tree(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    #[cfg(unix)]
    // SAFETY: 자식을 process_group(0)으로 띄웠으므로 pgid == pid. 다른 그룹을 건드리지 않는다.
    unsafe {
        libc::killpg(pid as libc::pid_t, libc::SIGTERM);
    }
    #[cfg(windows)]
    if !win::send_ctrl_c(pid) {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill").args(["/T", "/PID", &pid.to_string()]).creation_flags(0x0800_0000).output();
    }
}

/// 프로세스 그룹(Unix)이 아직 살아 있는가. Windows·모르면 true(= 유예를 끝까지 기다린다)
#[cfg(feature = "cli")]
fn process_alive(pid: Option<u32>) -> bool {
    let Some(pid) = pid else { return false };
    #[cfg(unix)]
    // SAFETY: 신호 0은 존재 확인만 한다.
    unsafe {
        libc::killpg(pid as libc::pid_t, 0) == 0
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

/// Windows 콘솔 제어(`terminate_tree`의 근거는 그쪽 주석). 프로세스 전역 콘솔 상태를 바꾸므로 한 번에 하나만 돈다
#[cfg(all(feature = "cli", windows))]
mod win {
    use std::sync::Mutex;

    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(pid: u32) -> i32;
        fn FreeConsole() -> i32;
        fn GenerateConsoleCtrlEvent(event: u32, group: u32) -> i32;
        fn SetConsoleCtrlHandler(handler: *const core::ffi::c_void, add: i32) -> i32;
    }
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    const CTRL_C_EVENT: u32 = 0;
    static CONSOLE: Mutex<()> = Mutex::new(());

    /// 자식(`pid`)의 숨은 콘솔에 붙어 CTRL_C를 보낸다. 앱(GUI)에는 콘솔이 없어도 된다: 있으면 먼저 떼고, 끝나면 부모 콘솔로 되돌린다.
    /// 우리 프로세스는 CTRL_C를 무시하도록 잠깐 핸들러를 건다(같은 콘솔에 붙어 있는 동안 우리에게도 도달하므로). 성공하면 true
    pub fn send_ctrl_c(pid: u32) -> bool {
        let _g = CONSOLE.lock().unwrap_or_else(|e| e.into_inner());
        // SAFETY: kernel32 콘솔 API. 위 잠금으로 이 프로세스 안에서 동시에 콘솔을 바꾸지 않고, 끝나면 항상 떼고(FreeConsole) 부모 콘솔로 되돌린다(있을 때만 성공).
        unsafe {
            FreeConsole();
            let ok = AttachConsole(pid) != 0 && {
                SetConsoleCtrlHandler(core::ptr::null(), 1); // NULL 핸들러 + TRUE = 이 프로세스는 CTRL_C를 무시
                let sent = GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) != 0;
                FreeConsole();
                SetConsoleCtrlHandler(core::ptr::null(), 0);
                sent
            };
            AttachConsole(ATTACH_PARENT_PROCESS);
            ok
        }
    }
}

#[cfg(feature = "cli")]
/// 프로세스와 그 자손을 모두 끝낸다 (Unix: 프로세스 그룹에 SIGKILL, Windows: `taskkill /T /F`).
fn kill_tree(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    #[cfg(unix)]
    // SAFETY: 자식을 process_group(0)으로 띄웠으므로 pgid == pid. 다른 그룹을 건드리지 않는다.
    unsafe {
        libc::killpg(pid as libc::pid_t, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).creation_flags(0x0800_0000).output(); // CREATE_NO_WINDOW
    }
}

#[cfg(feature = "cli")]
/// 스트림을 `\n`과 `\r` 기준으로 잘라 이벤트로 보낸다. 오류 요약(`summarize`)을 돌려준다.
async fn pump(
    stream: impl AsyncRead + Unpin,
    events: mpsc::UnboundedSender<JobEvent>,
    is_stderr: bool,
) -> String {
    let mut reader = BufReader::new(stream);
    let mut buf = Vec::new();
    let mut recent: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    loop {
        buf.clear();
        // `\r`로 덮어쓰는 진행률 표시도 줄 단위로 받기 위해 바이트 단위로 읽는다.
        let n = match read_until_any(&mut reader, &mut buf).await {
            Ok(n) => n,
            Err(_) => break,
        };
        if n == 0 {
            break;
        }
        let line = String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_owned();
        if line.is_empty() {
            continue;
        }
        let ev = if is_stderr {
            JobEvent::Progress { line: line.clone() }
        } else {
            JobEvent::Stdout { line: line.clone() }
        };
        let _ = events.send(ev);
        if recent.len() == 40 {
            recent.pop_front();
        }
        recent.push_back(line);
    }
    summarize(recent.make_contiguous())
}

#[cfg(feature = "cli")]
/// 실패 메시지용 stderr 요약: 원인 줄(`error:`·`fatal:`·` ! [rejected]` 등, 최대 4개). 없으면 마지막 줄.
/// 마지막 줄만 쓰면 push 거부가 `hint: …` 한 줄로 끝나 원인이 빠진다.
fn summarize(lines: &[String]) -> String {
    let key = |l: &str| {
        let t = l.trim_start();
        ["error:", "fatal:", "! ", "remote: error", "ERROR", "Error"].iter().any(|p| t.starts_with(p))
    };
    let picked: Vec<&str> = lines.iter().map(String::as_str).filter(|l| key(l)).collect();
    if picked.is_empty() {
        return lines.last().cloned().unwrap_or_default();
    }
    picked[picked.len().saturating_sub(4)..].join("\n")
}

#[cfg(feature = "cli")]
async fn read_until_any<R: AsyncBufReadExt + Unpin>(r: &mut R, buf: &mut Vec<u8>) -> std::io::Result<usize> {
    let mut total = 0;
    loop {
        let available = r.fill_buf().await?;
        if available.is_empty() {
            return Ok(total);
        }
        if let Some(i) = available.iter().position(|&b| b == b'\n' || b == b'\r') {
            buf.extend_from_slice(&available[..=i]);
            r.consume(i + 1);
            return Ok(total + i + 1);
        }
        let len = available.len();
        buf.extend_from_slice(available);
        r.consume(len);
        total += len;
    }
}

#[cfg(all(test, unix, feature = "cli"))]
mod tests {
    use super::*;
    use crate::GitRunner;
    use std::path::Path;
    use std::time::{Duration, Instant};

    fn pid_alive(pid: i32) -> bool {
        // SAFETY: 신호 0은 존재 확인만 한다.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    async fn pid_from(path: &Path) -> i32 {
        for _ in 0..100 {
            if let Some(p) = std::fs::read_to_string(path).ok().and_then(|t| t.trim().parse().ok()) {
                return p;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("pid 파일 없음");
    }

    async fn gone(pid: i32) -> bool {
        for _ in 0..100 {
            // 좀비는 부모(init)가 회수할 때까지 남을 수 있어 잠깐 기다린다
            if !pid_alive(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }

    #[tokio::test]
    async fn 핸들을_drop하면_취소된다() {
        let dir = tempfile_dir("drop");
        let (tx, _rx) = mpsc::unbounded_channel();
        let (handle, task) = GitRunner::default().spawn_shell(&dir, "sleep 30 & echo $! > child; wait", tx).unwrap();
        let child = pid_from(&dir.join("child")).await;
        let t = Instant::now();
        drop(handle);
        assert!(matches!(task.await.unwrap(), Err(Error::Cancelled)));
        assert!(t.elapsed() < Duration::from_secs(10));
        assert!(gone(child).await, "손자 프로세스가 남음");
    }

    #[tokio::test]
    async fn kill_now는_동기로_그룹을_끝낸다() {
        let dir = tempfile_dir("killnow");
        let (tx, _rx) = mpsc::unbounded_channel();
        let (handle, task) = GitRunner::default().spawn_shell(&dir, "sleep 30 & echo $! > child; wait", tx).unwrap();
        let child = pid_from(&dir.join("child")).await;
        handle.kill_now();
        assert!(gone(child).await, "kill_now 뒤에도 손자가 살아 있음");
        let _ = task.await;
    }

    #[tokio::test]
    async fn 끝난_작업의_kill_now는_아무것도_안한다() {
        let dir = tempfile_dir("done");
        let (tx, _rx) = mpsc::unbounded_channel();
        let (handle, task) = GitRunner::default().spawn_shell(&dir, "true", tx).unwrap();
        task.await.unwrap().unwrap();
        assert!(handle.done.load(Ordering::SeqCst));
        handle.kill_now(); // 패닉·오작동 없이 통과
    }

    fn tempfile_dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("gc-job-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}

#[cfg(all(test, feature = "cli"))]
mod summary_tests {
    use super::summarize;

    #[test]
    fn push_rejection_keeps_the_cause_not_the_hint() {
        let lines: Vec<String> = [
            "To github.com:o/r.git",
            " ! [rejected]        main -> main (fetch first)",
            "error: failed to push some refs to 'github.com:o/r.git'",
            "hint: Updates were rejected because the remote contains work that you do not",
            "hint: See the 'Note about fast-forwards' in 'git push --help' for details.",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(summarize(&lines), " ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'github.com:o/r.git'");
        assert_eq!(summarize(&["Receiving objects: 100%".into(), "done".into()]), "done");
        assert_eq!(summarize(&[]), "");
    }
}
