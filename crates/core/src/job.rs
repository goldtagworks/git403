//! 긴 작업 하나의 프로세스 수명: 출력을 줄 단위 이벤트로 펌프, 취소, 프로세스 트리 종료.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, watch};

use crate::{Error, Result};

/// 실행 중인 작업에서 나오는 이벤트. UI로 그대로 전달된다.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum JobEvent {
    Stdout { line: String },
    /// git은 진행률(`Receiving objects: 42%`)을 stderr에 `\r`로 갱신하며 쓴다.
    Progress { line: String },
    Finished { code: Option<i32> },
}

/// 작업 취소용 핸들. **모든 복제본이 drop되면 작업은 취소된다**(= drop은 취소). 끝날 때까지 들고 있을 것.
#[derive(Clone)]
pub struct JobHandle {
    cancel: watch::Sender<bool>,
    pid: Option<u32>,
    /// 자식이 끝났으면 true (끝난 pid의 프로세스 그룹을 건드리지 않기 위해)
    done: Arc<AtomicBool>,
}

impl JobHandle {
    pub fn cancel(&self) {
        let _ = self.cancel.send(true);
    }

    /// 비동기 런타임 없이 지금 바로 프로세스 트리를 끝낸다 (앱 종료 정리용). 결과는 `Cancelled`로 보고된다.
    pub fn kill_now(&self) {
        let _ = self.cancel.send(true);
        if !self.done.load(Ordering::SeqCst) {
            kill_tree(self.pid);
        }
    }
}

#[cfg(feature = "gix")]
impl JobHandle {
    /// 프로세스가 없는 작업(순수 Rust 백엔드)용 핸들. 돌려주는 수신기가 `true`가 되거나(취소) 모든 복제본이 drop되면 취소다.
    pub(crate) fn detached() -> (JobHandle, watch::Receiver<bool>) {
        let (tx, rx) = watch::channel(false);
        (JobHandle { cancel: tx, pid: None, done: Arc::new(AtomicBool::new(false)) }, rx)
    }
}

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
                kill_tree(pid);
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

#[cfg(all(test, unix))]
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

#[cfg(test)]
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
