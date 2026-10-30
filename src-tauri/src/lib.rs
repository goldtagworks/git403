use gc_backend::{askpass, Backend, Emit};
use tauri::{AppHandle, Emitter, Manager};

mod e2e;
#[cfg(target_os = "android")]
mod android;
#[cfg(desktop)]
mod window;

pub fn askpass_helper() -> bool {
    askpass::helper_main()
}

/// 백엔드 이벤트를 웹뷰로 보낸다.
struct TauriEmit(AppHandle);

impl Emit for TauriEmit {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let _ = self.0.emit(event, payload);
    }
}

/// 모든 IPC 명령은 `gc_backend::Backend::dispatch`로 간다 (명령 이름·인자는 `docs/reuse.md`의 IPC 목록).
/// Tauri 전용인 `e2e_result`만 여기서 처리한다.
fn dispatch(invoke: tauri::ipc::Invoke) -> bool {
    use tauri::ipc::InvokeBody;
    let tauri::ipc::Invoke { message, resolver, .. } = invoke;
    let cmd = message.command().to_owned();
    let args = match message.payload() {
        InvokeBody::Json(v) => v.clone(),
        InvokeBody::Raw(_) => serde_json::json!({}),
    };
    let Some(backend) = message.webview().try_state::<Backend>().map(|s| s.inner().clone()) else {
        resolver.reject("backend not ready");
        return true;
    };
    resolver.respond_async(async move { backend.dispatch(&cmd, args).await.map_err(tauri::ipc::InvokeError::from) });
    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    gc_i18n::init_from_os(); // UI의 set_locale 전까지 OS 언어로

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    // 데스크탑 전용 플러그인: 창 상태 · 업데이트 · 재시작
    #[cfg(desktop)]
    let builder = {
        // 창 위치·크기·최대화를 종료 때 저장하고 다음 실행 때 되살린다 (화면 밖이면 플러그인이 보정).
        // 디버그 빌드는 설치한 앱과 다른 파일에 저장해 서로의 창 위치를 덮어쓰지 않는다.
        // 처음 되살리기는 setup에서 직접 한다(되살린 뒤 화면 밖인지 확인하려고).
        // 위치·크기는 플러그인이 물리 픽셀로 저장해 배율이 다른 모니터가 섞이면 엉뚱한 곳에 되살아난다.
        // 그래서 그 둘은 빼고 논리 좌표로 직접 저장한다(window). 플러그인은 최대화·전체 화면만 맡는다.
        use tauri_plugin_window_state::StateFlags;
        let window_state = tauri_plugin_window_state::Builder::default()
            .skip_initial_state("main")
            .with_state_flags(StateFlags::all() - StateFlags::POSITION - StateFlags::SIZE);
        #[cfg(debug_assertions)]
        let window_state = window_state.with_filename(".window-state-dev.json");
        builder
            .plugin(window_state.build())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
    };
    builder
        .setup(move |app| {
            let handle = app.handle().clone();
            #[cfg(target_os = "android")]
            android::init_tls_verifier();
            // 인증 입력: git·ssh가 이 실행 파일을 askpass로 부르게 한다 (gc_backend::askpass).
            let config_dir = app.path().app_config_dir().unwrap_or_else(|_| gc_backend::default_config_dir());
            let backend = Backend::new(std::sync::Arc::new(TauriEmit(handle.clone())), config_dir, std::env::args().nth(1));
            app.manage(backend.clone());
            tauri::async_runtime::spawn(async move { backend.start() });
            e2e::serve(&handle);
            #[cfg(target_os = "macos")]
            close_key_menu(app)?;
            #[cfg(desktop)]
            if let Some(w) = app.get_webview_window("main") {
                use tauri_plugin_window_state::{StateFlags, WindowExt};
                window::restore(&w);
                window::keep_on_screen(&w);
                let _ = w.restore_state(StateFlags::all() - StateFlags::POSITION - StateFlags::SIZE);
                // 창은 숨긴 채(conf visible: false) UI 첫 로드가 끝나면 UI가 보여 주고 스플래시 창을 닫는다(ui/src/shared/lib/splash.ts)
            }
            Ok(())
        })
        .on_window_event(|w, e| {
            #[cfg(desktop)]
            if w.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                    window::save(w);
                    // macOS 관례: 창을 닫아도(⌘W·빨간 버튼) 앱은 Dock에 남는다. 종료는 ⌘Q. Dock 아이콘을 누르면 다시 보인다(Reopen)
                    #[cfg(target_os = "macos")]
                    {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                    #[cfg(not(target_os = "macos"))]
                    let _ = api;
                }
            }
            #[cfg(not(desktop))]
            let _ = (w, e);
        })
        .invoke_handler({
            let own: Box<dyn Fn(tauri::ipc::Invoke) -> bool + Send + Sync> = Box::new(tauri::generate_handler![e2e::e2e_result]);
            move |invoke| if invoke.message.command() == "e2e_result" { own(invoke) } else { dispatch(invoke) }
        })
        .build(e2e::context(tauri::generate_context!()))
        .expect("tauri 빌드 실패")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows: false, .. } = event {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            // 종료는 process::exit라 tokio 정리가 안 돈다 → 실행 중인 자식 프로세스 그룹을 여기서 직접 죽인다
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                // Cmd+Q·app.exit는 창 CloseRequested 없이 끝나므로 여기서도 창 위치·크기를 저장한다 (창이 이미 없으면 건너뜀)
                #[cfg(desktop)]
                if let Some(w) = app.get_webview_window("main") {
                    window::save(&w.as_ref().window());
                }
                if let Some(b) = app.try_state::<Backend>() {
                    b.shutdown();
                }
            }
        });
}

/// macOS 기본 메뉴의 "Close Window"(⌘W)를 "Close"로 바꾼다. 창을 숨기지 않고 UI에 `close-key`를 보내
/// 팝업 → 저장소 탭 → 창 숨기기 순으로 하나만 닫게 한다 (ui/src/app/main.tsx). 빨간 버튼은 그대로 창 숨기기.
/// 이 메뉴는 UI가 뜨기 전(와 UI 없이 뜨는 e2e)의 기본 메뉴다. UI가 시작하면 `ui/src/shared/model/appMenu.ts`가 문구(번역)·저장소 유무에 맞춘
/// 메뉴 막대(App/File/Edit/Repository/View/Window/Help)를 JS 메뉴 API로 만들어 `setAsAppMenu`로 바꿔 끼운다 (Rust에는 번역 문구가 없다).
#[cfg(target_os = "macos")]
fn close_key_menu(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(app.handle())?;
    let mut placed = false;
    for item in menu.items()? {
        let MenuItemKind::Submenu(sub) = item else { continue };
        for (i, it) in sub.items()?.into_iter().enumerate() {
            let MenuItemKind::Predefined(p) = &it else { continue };
            if p.text()?.replace('&', "") != "Close Window" {
                continue;
            }
            sub.remove(&it)?;
            if !placed {
                sub.insert(&MenuItem::with_id(app, "close-key", "Close", true, Some("CmdOrCtrl+W"))?, i)?;
                placed = true;
            }
        }
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, e| {
        if e.id() != "close-key" {
            return;
        }
        // 숨긴 창에서는 아무것도 닫지 않는다 (보이지 않는 탭이 닫히지 않게)
        if let Some(w) = app.get_webview_window("main").filter(|w| w.is_visible().unwrap_or(false)) {
            let _ = w.emit("close-key", ());
        }
    });
    Ok(())
}
