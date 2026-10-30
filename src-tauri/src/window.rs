//! 메인 창 위치·크기: 종료 때 논리 좌표(macOS의 전역 포인트)로 저장하고 시작 때 되살린다.
//! 위치·크기는 창 상태 플러그인이 물리 픽셀로 저장해 배율이 다른 모니터가 섞이면 엉뚱한 곳에 되살아나므로 여기서 직접 맡는다.
//! 최대화 상태면 저장하지 않는다(이전 값 유지).
//! 저장 때의 모니터 배치(개수·위치·해상도)도 함께 적어 두고, 시작 때 배치가 바뀌었으면 위치는 버리고 가운데에 띄운다.

use tauri::{LogicalPosition, LogicalSize, Manager, Monitor, Runtime, WebviewWindow, Window};

#[derive(serde::Serialize, serde::Deserialize)]
struct Geom { x: f64, y: f64, w: f64, h: f64, #[serde(default)] screens: Vec<[i64; 4]> }

/// 모니터 배치: 각 모니터의 논리 좌표 사각형을 정렬한 목록. 모니터를 빼거나 해상도를 바꾸면 달라진다.
fn screens(monitors: &[Monitor]) -> Vec<[i64; 4]> {
    let mut v: Vec<[i64; 4]> = monitors.iter().map(|m| {
        let (p, s) = (m.position().to_logical::<f64>(m.scale_factor()), m.size().to_logical::<f64>(m.scale_factor()));
        [p.x, p.y, s.width, s.height].map(|n| n.round() as i64)
    }).collect();
    v.sort();
    v
}

fn file<R: Runtime>(app: &impl Manager<R>) -> Option<std::path::PathBuf> {
    let name = if cfg!(debug_assertions) { ".window-geom-dev.json" } else { ".window-geom.json" };
    Some(app.path().app_config_dir().ok()?.join(name))
}

pub fn save<R: Runtime>(w: &Window<R>) {
    if w.is_maximized().unwrap_or(false) || w.is_fullscreen().unwrap_or(false) {
        return;
    }
    let (Ok(pos), Ok(size), Ok(k), Some(path)) = (w.outer_position(), w.inner_size(), w.scale_factor(), file(w)) else { return };
    let (p, s) = (pos.to_logical::<f64>(k), size.to_logical::<f64>(k));
    let g = Geom { x: p.x, y: p.y, w: s.width, h: s.height, screens: screens(&w.available_monitors().unwrap_or_default()) };
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    let _ = std::fs::write(path, serde_json::to_vec(&g).unwrap_or_default());
}

/// 되살린 창 사각형(논리 좌표 x, y, 폭, 높이)을 돌려준다. 숨긴 창은 위치를 바꾼 직후 outer_position이 예전 값을 줄 수 있어서다.
pub fn restore<R: Runtime>(w: &WebviewWindow<R>) -> Option<[f64; 4]> {
    let g = file(w).and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice::<Geom>(&b).ok())?;
    let _ = w.set_size(LogicalSize::new(g.w, g.h));
    if g.screens != screens(&w.available_monitors().unwrap_or_default()) {
        // 모니터 배치가 바뀌었다: 예전 좌표는 믿을 수 없으니 주 모니터 크기 안으로 줄여 가운데에 둔다
        if let Ok(Some(m)) = w.primary_monitor() {
            let ms = m.size().to_logical::<f64>(m.scale_factor());
            let _ = w.set_size(LogicalSize::new(g.w.min(ms.width * 0.9), g.h.min(ms.height * 0.9)));
        }
        let _ = w.center();
        return None;
    }
    let _ = w.set_position(LogicalPosition::new(g.x, g.y));
    Some([g.x, g.y, g.w, g.h])
}

/// 되살린 창이 지금 연결된 어느 모니터에도 제대로 걸치지 않으면(모니터를 빼거나 바꿨을 때, 저장값이 깨졌을 때)
/// 주 모니터 크기 안으로 줄이고 가운데에 둔다. 창 상태 플러그인이 되살린 뒤에 확인한다.
pub fn keep_on_screen(w: &tauri::WebviewWindow) {
    // 배율이 다른 모니터가 섞이면 물리 픽셀끼리는 비교가 안 되므로 모두 논리 좌표로 바꿔 비교한다
    let (Ok(pos), Ok(size), Ok(monitors), Ok(k)) = (w.outer_position(), w.outer_size(), w.available_monitors(), w.scale_factor()) else { return };
    let (pos, size) = (pos.to_logical::<f64>(k), size.to_logical::<f64>(k));
    // 제목 표시줄 쪽 일부(가로 100px·세로 40px 이상)가 어떤 모니터 안에 있고, 창이 그 모니터보다 크지 않으면 그대로 둔다
    let ok = monitors.iter().any(|m| {
        let (mp, ms) = (m.position().to_logical::<f64>(m.scale_factor()), m.size().to_logical::<f64>(m.scale_factor()));
        let (mx1, my1) = (mp.x + ms.width, mp.y + ms.height);
        let vis_w = (pos.x + size.width).min(mx1) - pos.x.max(mp.x);
        let title_in = pos.y >= mp.y - 10.0 && pos.y + 40.0 <= my1;
        vis_w >= 100.0 && title_in && size.width <= ms.width && size.height <= ms.height
    });
    if ok {
        return;
    }
    if let Ok(Some(m)) = w.primary_monitor() {
        let ms = m.size().to_logical::<f64>(m.scale_factor());
        let _ = w.set_size(tauri::LogicalSize::new(size.width.min(ms.width * 0.9), size.height.min(ms.height * 0.9)));
    }
    let _ = w.center();
}

/// 시작 스플래시 창을 되살린 메인 창 한가운데에 만든다. conf에 두면 setup 전에 주 모니터 가운데에 먼저 보이므로
/// 메인 창 위치를 되살린 뒤 여기서 위치를 정해 만든다. 닫기는 UI가 한다(ui/src/shared/lib/splash.ts).
/// `rect`는 restore가 되살린 메인 창 사각형. 없으면(처음 실행·모니터 배치 바뀜) 메인 창처럼 주 모니터 가운데.
pub fn splash(app: &tauri::App, rect: Option<[f64; 4]>) {
    const W: f64 = 340.0;
    const H: f64 = 220.0;
    let b = tauri::WebviewWindowBuilder::new(app, "splash", tauri::WebviewUrl::App("splash.html".into()));
    let b = match rect {
        Some([x, y, w, h]) => b.position(x + (w - W) / 2.0, y + (h - H) / 2.0),
        None => b.center(),
    };
    let _ = b
        .inner_size(W, H)
        .resizable(false)
        .decorations(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .build();
}
