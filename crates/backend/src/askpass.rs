//! git·ssh 인증 입력(askpass).
//!
//! git이 비밀번호·토큰·SSH 암호가 필요하면 GIT_ASKPASS/SSH_ASKPASS로 지정한 **이 앱 실행 파일**을 실행한다.
//! 그 프로세스(`helper_main`)는 백엔드의 로컬 포트로 질문을 보내고, 앱은 UI에 `askpass` 이벤트를 띄워 답을 받아 돌려준다.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use parking_lot::Mutex;
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;

pub const PORT_ENV: &str = "GC_ASKPASS_PORT";

/// askpass 도우미로 실행된 경우 질문을 앱에 보내고 답을 출력한다. 도우미가 아니면 false.
pub fn helper_main() -> bool {
    let Ok(port) = std::env::var(PORT_ENV) else { return false };
    let prompt: String = std::env::args().skip(1).collect::<Vec<_>>().join(" ");
    let answer = (|| -> std::io::Result<Option<String>> {
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port.parse().unwrap_or(0)))?;
        writeln!(s, "{}", prompt.replace('\n', " "))?;
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line)?;
        Ok(line.strip_prefix("OK ").map(|a| a.trim_end_matches('\n').to_owned()))
    })();
    match answer {
        Ok(Some(a)) => {
            println!("{a}");
            std::process::exit(0)
        }
        _ => std::process::exit(1),
    }
}

#[derive(Clone, Serialize)]
pub struct AskpassRequest {
    pub id: u64,
    pub prompt: String,
}

#[derive(Default, Clone)]
pub struct Askpass {
    waiting: Arc<Mutex<HashMap<u64, oneshot::Sender<Option<String>>>>>,
    next: Arc<AtomicU64>,
    listener: Arc<Mutex<Option<std::net::TcpListener>>>,
}

impl Askpass {
    /// 로컬 포트를 연다(앱 상태를 만들기 전에 git 환경 변수를 정해야 해서 먼저 연다).
    pub fn bind() -> std::io::Result<(Self, u16)> {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0))?;
        l.set_nonblocking(true)?;
        let port = l.local_addr()?.port();
        Ok((Self { listener: Arc::new(Mutex::new(Some(l))), ..Default::default() }, port))
    }

    /// 질문을 받기 시작한다. 질문이 오면 `on_request`를 부른다 (tokio 런타임 안에서 호출).
    pub fn serve(&self, on_request: impl Fn(AskpassRequest) + Send + Sync + 'static) {
        let Some(std_listener) = self.listener.lock().take() else { return };
        let me = self.clone();
        let on_request = Arc::new(on_request);
        tokio::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(std_listener).expect("askpass listener");
            while let Ok((stream, _)) = listener.accept().await {
                let (me, on_request) = (me.clone(), on_request.clone());
                tokio::spawn(async move {
                    let (r, mut w) = stream.into_split();
                    let mut r = tokio::io::BufReader::new(r);
                    let mut prompt = String::new();
                    if r.read_line(&mut prompt).await.is_err() {
                        return;
                    }
                    let id = me.next.fetch_add(1, Ordering::Relaxed);
                    let (tx, rx) = oneshot::channel();
                    me.waiting.lock().insert(id, tx);
                    on_request(AskpassRequest { id, prompt: prompt.trim().to_owned() });
                    // 도우미 프로세스가 죽거나 git이 취소해 소켓이 닫히면(EOF) 기다리지 않는다.
                    let closed = async {
                        let mut b = [0u8; 64];
                        while matches!(r.read(&mut b).await, Ok(n) if n > 0) {}
                    };
                    // 사용자가 5분 안에 답하지 않으면 취소로 본다.
                    let answer = tokio::select! {
                        a = tokio::time::timeout(Duration::from_secs(300), rx) => a.ok().and_then(|r| r.ok()).flatten(),
                        _ = closed => None,
                    };
                    me.waiting.lock().remove(&id);
                    let reply = answer.map(|a| format!("OK {a}\n")).unwrap_or_else(|| "CANCEL\n".into());
                    let _ = w.write_all(reply.as_bytes()).await;
                });
            }
        });
    }

    pub fn reply(&self, id: u64, answer: Option<String>) {
        if let Some(tx) = self.waiting.lock().remove(&id) {
            let _ = tx.send(answer);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn relays_prompt_and_answer() {
        let (ask, port) = Askpass::bind().unwrap();
        let replier = ask.clone();
        ask.serve(move |req| {
            assert_eq!(req.prompt, "Password for 'https://x@example.com':");
            replier.reply(req.id, Some("s3cret".into()));
        });
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        writeln!(s, "Password for 'https://x@example.com':").unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        assert_eq!(line, "OK s3cret\n");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn closed_socket_drops_waiting_entry() {
        let (ask, port) = Askpass::bind().unwrap();
        ask.serve(|_| {}); // 답하지 않는다
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        writeln!(s, "Password:").unwrap();
        for _ in 0..100 {
            if !ask.waiting.lock().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(ask.waiting.lock().len(), 1);
        drop(s); // 도우미 종료
        for _ in 0..100 {
            if ask.waiting.lock().is_empty() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("waiting 항목이 남음");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_is_reported() {
        let (ask, port) = Askpass::bind().unwrap();
        let replier = ask.clone();
        ask.serve(move |req| replier.reply(req.id, None));
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        writeln!(s, "Username:").unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        assert_eq!(line, "CANCEL\n");
    }
}
