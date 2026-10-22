//! 실제 앱 E2E 다리 (디버그 빌드 + `GIT403_E2E_PORT`일 때만).
//!
//! 테스트(`ui/e2e/app/run.mjs`)가 `127.0.0.1:<port>`로 JS 본문을 POST하면 메인 웹뷰에서 실행하고,
//! 결과를 `e2e_result` 명령으로 받아 HTTP 응답으로 돌려준다. 진짜 IPC·진짜 git으로 화면을 검증한다.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;
use parking_lot::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

static WAIT: OnceLock<Mutex<HashMap<u64, Sender<String>>>> = OnceLock::new();

fn waiters() -> &'static Mutex<HashMap<u64, Sender<String>>> {
    WAIT.get_or_init(Default::default)
}

/// 웹뷰가 실행 결과(JSON 문자열 `{ok, value}`)를 돌려준다
#[tauri::command]
pub fn e2e_result(id: u64, result: String) {
    if let Some(tx) = waiters().lock().remove(&id) {
        let _ = tx.send(result);
    }
}

/// 디버그 빌드 + `GIT403_E2E_UPDATER="<manifest URL> <pubkey>"`이면 업데이트 확인을 테스트 서버·테스트 키로 돌린다.
pub fn context(mut ctx: tauri::Context) -> tauri::Context {
    if !cfg!(debug_assertions) {
        return ctx;
    }
    let Some((url, key)) = std::env::var("GIT403_E2E_UPDATER").ok().and_then(|v| v.split_once(' ').map(|(u, k)| (u.to_owned(), k.to_owned()))) else { return ctx };
    if let Some(u) = ctx.config_mut().plugins.0.get_mut("updater").and_then(|v| v.as_object_mut()) {
        u.insert("endpoints".into(), serde_json::json!([url]));
        u.insert("pubkey".into(), key.into());
        u.insert("dangerousInsecureTransportProtocol".into(), true.into());
    }
    ctx
}

pub fn serve(app: &AppHandle) {
    if !cfg!(debug_assertions) {
        return;
    }
    let Some(port) = std::env::var("GIT403_E2E_PORT").ok().and_then(|p| p.parse::<u16>().ok()) else { return };
    let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        for (id, stream) in (1u64..).zip(listener.incoming()) {
            let Ok(mut stream) = stream else { continue };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut len = 0;
            let mut line = String::new();
            while reader.read_line(&mut line).is_ok_and(|n| n > 0) && line != "\r\n" {
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
                line.clear();
            }
            let mut body = vec![0; len];
            let _ = reader.read_exact(&mut body);
            let js = String::from_utf8_lossy(&body);
            // 웹뷰 밖 동작: `@move x y w h`(창 옮기기·크기), `@frame`(위치·크기 조회), `@quit`(정상 종료 = 창 상태 저장 경로)
            if let Some(cmd) = js.strip_prefix('@') {
                let out = native(&app, cmd);
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}", out.len());
                if cmd == "quit" {
                    app.exit(0);
                }
                continue;
            }
            let (tx, rx) = channel();
            waiters().lock().insert(id, tx);
            let script = format!(
                "(async()=>{{let r;try{{r={{ok:true,value:await (async()=>{{{js}}})()}}}}catch(e){{r={{ok:false,value:String(e)+(e&&e.stack?' '+e.stack:'')}}}}\
                 window.__TAURI_INTERNALS__.invoke('e2e_result',{{id:{id},result:JSON.stringify(r)??'null'}})}})()"
            );
            let out = match app.get_webview_window("main").map(|w| w.eval(&script)) {
                Some(Ok(())) => rx.recv_timeout(Duration::from_secs(30)).unwrap_or_else(|_| r#"{"ok":false,"value":"timeout"}"#.into()),
                _ => r#"{"ok":false,"value":"no window"}"#.into(),
            };
            waiters().lock().remove(&id);
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}", out.len());
        }
    });
}

fn native(app: &AppHandle, cmd: &str) -> String {
    use tauri::{LogicalPosition, LogicalSize};
    let Some(w) = app.get_webview_window("main") else { return r#"{"ok":false,"value":"no window"}"#.into() };
    let n: Vec<f64> = cmd.split_whitespace().skip(1).filter_map(|v| v.parse().ok()).collect();
    match (cmd.split_whitespace().next(), n.as_slice()) {
        (Some("move"), [x, y, wd, h]) => {
            let _ = w.set_size(LogicalSize::new(*wd, *h));
            let _ = w.set_position(LogicalPosition::new(*x, *y));
            r#"{"ok":true,"value":null}"#.into()
        }
        (Some("frame"), []) => {
            let f = w.scale_factor().unwrap_or(1.0);
            let (p, s) = (w.outer_position().unwrap_or_default(), w.inner_size().unwrap_or_default());
            format!(r#"{{"ok":true,"value":[{},{},{},{}]}}"#, (p.x as f64 / f).round(), (p.y as f64 / f).round(), (s.width as f64 / f).round(), (s.height as f64 / f).round())
        }
        (Some("quit"), []) => r#"{"ok":true,"value":null}"#.into(),
        _ => r#"{"ok":false,"value":"unknown native command"}"#.into(),
    }
}
