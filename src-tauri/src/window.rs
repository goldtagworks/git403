//! 메인 창 위치·크기: 종료 때 논리 좌표(macOS의 전역 포인트)로 저장하고 시작 때 되살린다.
//! 위치·크기는 창 상태 플러그인이 물리 픽셀로 저장해 배율이 다른 모니터가 섞이면 엉뚱한 곳에 되살아나므로 여기서 직접 맡는다.
//! 최대화 상태면 저장하지 않는다(이전 값 유지).

use tauri::{LogicalPosition, LogicalSize, Manager, Runtime, WebviewWindow, Window};

#[derive(serde::Serialize, serde::Deserialize)]
struct Geom { x: f64, y: f64, w: f64, h: f64 }

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
    let g = Geom { x: p.x, y: p.y, w: s.width, h: s.height };
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    let _ = std::fs::write(path, serde_json::to_vec(&g).unwrap_or_default());
}

pub fn restore<R: Runtime>(w: &WebviewWindow<R>) {
    let Some(g) = file(w).and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice::<Geom>(&b).ok()) else { return };
    let _ = w.set_size(LogicalSize::new(g.w, g.h));
    let _ = w.set_position(LogicalPosition::new(g.x, g.y));
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
