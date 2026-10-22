//! git403 stdio 서버: VS Code 확장 등이 자식 프로세스로 띄워 쓴다 (프로토콜은 docs/reuse.md).
//!
//! stdin 한 줄 = 요청 `{"id":n,"cmd":"...","args":{...}}`, stdout 한 줄 = 응답 `{"id":n,"ok":v}` | `{"id":n,"err":"..."}`
//! 또는 이벤트 `{"event":"name","payload":v}`. 요청은 동시에 처리한다. stdin이 닫히면 자식 프로세스를 정리하고 끝낸다.
//! 로그는 stderr로만 쓴다. 설정 폴더: `--config-dir <path>` > `GIT403_CONFIG_DIR` > 앱과 같은 기본 위치.

use std::path::PathBuf;
use std::sync::Arc;

use gc_backend::{askpass, default_config_dir, Backend, Emit};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// 이벤트를 stdout 쓰기 채널로 보낸다 (응답과 같은 채널이라 순서가 유지된다).
struct StdoutEmit(mpsc::UnboundedSender<Value>);

impl Emit for StdoutEmit {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.0.send(json!({ "event": event, "payload": payload }));
    }
}

fn config_dir() -> PathBuf {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--config-dir" {
            if let Some(p) = args.next() {
                return p.into();
            }
        }
    }
    std::env::var_os("GIT403_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(default_config_dir)
}

#[tokio::main]
async fn main() {
    // git·ssh가 인증 입력을 위해 이 실행 파일을 askpass로 부른 경우
    if askpass::helper_main() {
        return;
    }
    gc_i18n::init_from_os();
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let backend = Backend::new(Arc::new(StdoutEmit(tx.clone())), config_dir(), None);
    backend.start();

    let writer = tokio::spawn(async move {
        let mut out = tokio::io::stdout();
        while let Some(v) = rx.recv().await {
            let mut line = v.to_string();
            line.push('\n');
            if out.write_all(line.as_bytes()).await.is_err() || out.flush().await.is_err() {
                break;
            }
        }
    });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(l)) => l,
            Ok(None) => break,
            Err(e) => {
                eprintln!("stdin: {e}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("invalid request: {e}");
                let _ = tx.send(json!({ "id": null, "err": format!("invalid request: {e}") }));
                continue;
            }
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let Some(cmd) = req.get("cmd").and_then(Value::as_str).map(str::to_owned) else {
            let _ = tx.send(json!({ "id": id, "err": "invalid request: missing cmd" }));
            continue;
        };
        let args = match req.get("args") {
            Some(a) if !a.is_null() => a.clone(),
            _ => json!({}),
        };
        let (backend, tx) = (backend.clone(), tx.clone());
        tokio::spawn(async move {
            let msg = match backend.dispatch(&cmd, args).await {
                Ok(v) => json!({ "id": id, "ok": v }),
                Err(e) => json!({ "id": id, "err": e }),
            };
            let _ = tx.send(msg);
        });
    }

    // stdin EOF: 이미 쌓인 출력만 내보내고 자식 프로세스를 정리한 뒤 끝낸다
    backend.shutdown();
    drop(tx);
    drop(backend);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), writer).await;
    std::process::exit(0);
}
