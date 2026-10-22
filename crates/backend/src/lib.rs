//! Tauri 비의존 백엔드: 모든 IPC 명령의 본문과 앱 상태(작업·감시·askpass·AI).
//!
//! 호스트(Tauri 앱, stdio 서버)는 `Backend::new`로 만들고 `dispatch(cmd, args)`로 명령을 부른다.
//! 이벤트(`repo-changed`·`job`·`job-done`·`detached-done`·`askpass`)는 호스트가 준 `Emit`으로 나간다.
//!
//! 모듈: `dispatch`(명령 라우팅) · `jobs`(긴 작업) · `stats`(통계 취소) · `ai` · `hosting`(계정·원격) ·
//! `files`(파일 조작) · `open`(외부 앱) · `graph`(그래프 조립) · `watch`(파일 감시) · `askpass`(인증 입력).
//! 이 파일은 상태 조립과 시작·종료만 맡는다.

use std::path::PathBuf;
use std::sync::Arc;

use gc_core::GitRunner;
use serde_json::Value;

mod ai;
pub mod askpass;
mod config;
mod conventions;
mod dispatch;
mod files;
mod gh;
mod graph;
mod hosting;
mod jobs;
mod open;
mod settings_io;
mod stats;
mod util;
pub mod watch;

pub use config::{default_config_dir, APP_ID};
pub use util::Res;

/// 호스트가 구현하는 이벤트 송신자.
pub trait Emit: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
}

/// 이벤트를 버린다 (테스트용).
pub struct NullEmit;
impl Emit for NullEmit {
    fn emit(&self, _: &str, _: Value) {}
}

pub struct Inner {
    git: GitRunner,
    emit: Arc<dyn Emit>,
    askpass: askpass::Askpass,
    initial_repo: Option<String>,
    watch: watch::ActiveWatch,
    jobs: jobs::Jobs,
    stats: stats::StatsTasks,
    ai: ai::Ai,
    /// 설정 폴더 (설정 내보내기·가져오기의 백업 위치)
    config_dir: PathBuf,
    hosting: hosting::Hosting,
    /// gh 계정 임시 전환 구간의 직렬화 (docs/reuse.md gh 절)
    gh_gate: gh::Gate,
}

/// 백엔드 핸들. 복제는 같은 상태를 가리킨다.
#[derive(Clone)]
pub struct Backend(Arc<Inner>);

impl std::ops::Deref for Backend {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl Backend {
    /// askpass 포트를 열어 git·ssh가 **현재 실행 파일**을 인증 도우미로 부르게 한다
    /// (호스트 `main`은 시작할 때 `askpass::helper_main()`을 먼저 불러야 한다).
    pub fn new(emit: Arc<dyn Emit>, config_dir: PathBuf, initial_repo: Option<String>) -> Self {
        let mut runner = GitRunner::default();
        let mut ask = askpass::Askpass::default();
        if let (Ok((a, port)), Ok(exe)) = (askpass::Askpass::bind(), std::env::current_exe()) {
            let exe = exe.to_string_lossy().into_owned();
            runner = runner
                .with_env("GIT_ASKPASS", exe.clone())
                .with_env("SSH_ASKPASS", exe)
                .with_env("SSH_ASKPASS_REQUIRE", "force")
                .with_env(askpass::PORT_ENV, port.to_string());
            ask = a;
        }
        Self::with_parts(runner, ask, emit, config_dir, initial_repo)
    }

    pub fn with_parts(git: GitRunner, askpass: askpass::Askpass, emit: Arc<dyn Emit>, config_dir: PathBuf, initial_repo: Option<String>) -> Self {
        Self(Arc::new(Inner {
            git,
            emit,
            askpass,
            initial_repo,
            watch: Default::default(),
            jobs: Default::default(),
            stats: Default::default(),
            ai: ai::Ai::new(&config_dir),
            config_dir: config_dir.clone(),
            hosting: hosting::Hosting::new(&config_dir),
            gh_gate: Default::default(),
        }))
    }

    /// 백그라운드 일을 시작한다: askpass 질문 받기, 로그인 셸 PATH 채우기. **tokio 런타임 안에서** 부른다.
    pub fn start(&self) {
        let emit = self.emit.clone();
        self.askpass.serve(move |req| emit.emit("askpass", serde_json::to_value(req).unwrap_or(Value::Null)));
        // GUI로 실행하면 로그인 셸의 PATH(homebrew·nvm 등)가 없다. 시작을 막지 않게 백그라운드에서 물어 GitRunner에 채운다.
        #[cfg(unix)]
        {
            let cell = self.git.path_cell();
            tokio::spawn(async move {
                let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
                if let Some(p) = gc_core::shellenv::login_shell_path(&shell).await {
                    let _ = cell.set(p);
                }
            });
        }
    }
}

impl Inner {
    /// 종료 때 자식 프로세스를 전부 정리한다. 종료가 `process::exit`로 끝나면 tokio 태스크 drop·`kill_on_drop`이
    /// 돌지 않고, 자식은 별도 프로세스 그룹이라 터미널 신호도 못 받는다. 그래서 동기로 직접 죽인다. 여러 번 불려도 안전하다.
    pub fn shutdown(&self) {
        self.jobs.kill_all();
        self.stats.kill_all();
        self.ai.abort_all();
        self.watch.stop();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tokio::sync::mpsc;
    use std::time::Duration;

    fn alive(pid: i32) -> bool {
        // SAFETY: 신호 0은 존재 확인만 한다.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// 종료 정리: jobs·detached·stats의 자식(손자 포함)을 동기로 모두 죽인다.
    #[tokio::test]
    async fn shutdown은_모든_자식_프로세스를_죽인다() {
        let dir = std::env::temp_dir().join(format!("git403-shutdown-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = Backend::with_parts(GitRunner::default(), Default::default(), Arc::new(NullEmit), dir.clone(), None);
        let mut pids = Vec::new();
        for (i, kind) in ["jobs", "detached", "stats"].into_iter().enumerate() {
            let (tx, _rx) = mpsc::unbounded_channel();
            let script = format!("sleep 60 & echo $! > pid{i}; wait");
            let (h, _task) = state.git.spawn_shell(&dir, &script, tx).unwrap();
            match kind {
                "jobs" => drop(state.jobs.running.lock().insert(1, h)),
                "detached" => drop(state.jobs.detached.lock().insert("t".into(), h)),
                _ => drop(state.stats.0.lock().insert("r".into(), ("t".into(), h))),
            }
            let f = dir.join(format!("pid{i}"));
            for _ in 0..100 {
                if f.exists() && !std::fs::read_to_string(&f).unwrap().trim().is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
            pids.push(std::fs::read_to_string(&f).unwrap().trim().parse::<i32>().unwrap());
        }
        assert!(pids.iter().all(|p| alive(*p)));
        state.shutdown();
        for p in pids {
            let mut gone = false;
            for _ in 0..100 {
                if !alive(p) {
                    gone = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
            assert!(gone, "자식 {p}가 남음");
        }
        assert!(state.jobs.running.lock().is_empty() && state.jobs.detached.lock().is_empty() && state.stats.0.lock().is_empty());
    }
}
