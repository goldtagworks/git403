//! 외부 앱으로 열기: 터미널·폴더 열기, 파일을 탐색기에서 보기·기본 앱으로 열기.

use std::path::PathBuf;

use crate::util::{err, Res};

/// what: "terminal" | "folder" | "reveal" | "open". app: 터미널 앱 이름(설정값), path: reveal·open 대상(저장소 기준 상대 경로).
/// 명령 구성은 gc_core::open_command. reveal·open은 심볼릭 링크를 푼 실제 경로가 저장소 안일 때만 연다.
pub(crate) async fn open_in(path_env: Option<&str>, repo: PathBuf, what: String, app: Option<String>, path: Option<String>) -> Res<()> {
    let path = match (what.as_str(), path) {
        ("reveal" | "open", p) => {
            let (r, p) = (repo.clone(), p.unwrap_or_default());
            let rel = tokio::task::spawn_blocking(move || gc_core::canonical_in_repo(&r, &p)).await.map_err(|e| e.to_string())?.map_err(err)?;
            Some(rel)
        }
        (_, p) => p,
    };
    let c = gc_core::open_command(std::env::consts::OS, &what, &repo, path.as_deref(), app.as_deref()).map_err(err)?;
    let mut cmd = std::process::Command::new(&c.program);
    cmd.args(&c.args);
    if let Some(p) = path_env {
        cmd.env("PATH", p);
    }
    if let Some(dir) = &c.cwd {
        cmd.current_dir(dir);
    }
    let mut child = cmd.spawn().map_err(|e| gc_i18n::coded!("open.spawnFailed", "failed to run {program}: {error}", program = c.program, error = e).json())?;
    // 끝난 자식을 회수하지 않으면 좀비로 남는다. 기다리는 일은 전용 스레드에서.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}
