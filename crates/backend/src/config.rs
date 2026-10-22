//! 설정 폴더 위치 (계정·AI 설정을 Tauri 앱과 stdio 서버가 공유한다).

use std::path::PathBuf;

/// 앱 식별자 (Tauri `identifier`와 같다). 서버의 기본 설정 폴더 이름.
pub const APP_ID: &str = "com.goldtagworks.git403";

/// Tauri `app_config_dir`와 같은 위치.
pub fn default_config_dir() -> PathBuf {
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let base = if cfg!(target_os = "macos") {
        env("HOME").map(|h| h.join("Library/Application Support"))
    } else if cfg!(windows) {
        env("APPDATA")
    } else {
        env("XDG_CONFIG_HOME").or_else(|| env("HOME").map(|h| h.join(".config")))
    };
    base.unwrap_or_else(std::env::temp_dir).join(APP_ID)
}
