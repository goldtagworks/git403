//! 긴 git 작업: 작업 번호 매기기, 진행 이벤트 중계, 취소, 분리 실행(difftool·mergetool), commit-graph 보강.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use gc_core::{GitRunner, JobEvent, JobHandle};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::util::{err, Res};
use crate::Backend;

type Spawned = (JobHandle, tokio::task::JoinHandle<gc_core::Result<()>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobMessage {
    job: u64,
    event: JobEvent,
}

/// 실행 중인 작업 핸들 보관소.
#[derive(Default)]
pub(crate) struct Jobs {
    /// start_job·start_shell 작업 (번호 → 핸들)
    pub(crate) running: Mutex<HashMap<u64, JobHandle>>,
    /// run_detached 작업 (token → 핸들)
    pub(crate) detached: Mutex<HashMap<String, JobHandle>>,
    next: AtomicU64,
}

impl Jobs {
    pub fn cancel(&self, job: u64) {
        if let Some(h) = self.running.lock().remove(&job) {
            h.cancel();
        }
    }

    pub fn cancel_detached(&self, token: &str) {
        if let Some(h) = self.detached.lock().remove(token) {
            h.cancel();
        }
    }

    /// 종료 정리용: 모든 자식 프로세스 트리를 동기로 죽인다.
    pub fn kill_all(&self) {
        for (_, h) in self.running.lock().drain() {
            h.kill_now();
        }
        for (_, h) in self.detached.lock().drain() {
            h.kill_now();
        }
    }
}

/// commit-graph 보장을 백그라운드로 돌린다. 실패는 로그(stderr)만 남기고 무시한다.
pub(crate) fn spawn_commit_graph(git: &GitRunner, repo: PathBuf) {
    let git = git.clone();
    tokio::spawn(async move {
        if let Err(e) = gc_core::ensure_commit_graph(&git, &repo).await {
            eprintln!("commit-graph: {e}");
        }
    });
}

impl Backend {
    /// pull/fetch/push 같은 긴 작업. 바로 작업 번호를 돌려주고 진행은 `job` 이벤트로 보낸다.
    ///
    /// `interactive: false`면 백그라운드 작업(자동 fetch): 인증 입력 창(askpass)을 쓰지 않고 ssh는 BatchMode.
    /// 사용자가 `core.sshCommand`·`GIT_SSH_COMMAND`를 설정해 뒀으면 그대로 둔다.
    pub(crate) async fn start_job(&self, repo: PathBuf, mut args: Vec<String>, interactive: Option<bool>, gh_user: Option<String>, gh_restore: bool) -> Res<u64> {
        let (tx, rx) = mpsc::unbounded_channel();
        // 저장소에 연결된 gh 계정이 있으면(push/fetch/pull, clone은 고른 계정 ghUser) 필요할 때 전환하고 gh 자격 도우미를 쓴다. 끝나면 아래에서 복원.
        let lease = self.gh_lease_for_job(&repo, &args, gh_user.as_deref(), &tx).await?;
        // fetch·pull은 이번 실행에만 `-c fetch.writeCommitGraph=true`를 붙이고(저장소 설정은 안 바꾼다),
        // 성공하면 commit-graph가 없거나 오래됐을 때 백그라운드로 보강한다.
        let network = matches!(args.first().map(String::as_str), Some("fetch" | "pull"));
        if network {
            args.splice(0..0, ["-c".to_owned(), "fetch.writeCommitGraph=true".to_owned()]);
        }
        if let Some(l) = &lease {
            args.splice(0..0, crate::gh::helper_args(l.host()));
        }
        let log_tx = tx.clone();
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let spawned = if interactive == Some(false) {
            let own_ssh = std::env::var_os("GIT_SSH_COMMAND").is_some()
                || self.git.output(&repo, &["config", "--get", "core.sshCommand"]).await.is_ok_and(|o| !o.is_empty());
            self.git.spawn_batch(&repo, &argv, !own_ssh, tx)
        } else {
            self.git.spawn(&repo, &argv, tx)
        };
        let (handle, task) = match spawned {
            Ok(s) => s,
            Err(e) => {
                if let Some(l) = lease {
                    self.gh_release(l, gh_restore, &log_tx).await;
                }
                return Err(e.ipc());
            }
        };
        let task = if network || lease.is_some() {
            let (git, me) = (self.git.clone(), self.clone());
            tokio::spawn(async move {
                let res = task.await;
                // 성공·실패·취소 모두 복원한다(복원 로그는 채널이 닫히기 전에 보낸다)
                if let Some(l) = lease {
                    me.gh_release(l, gh_restore, &log_tx).await;
                }
                if network && matches!(res, Ok(Ok(()))) {
                    spawn_commit_graph(&git, repo);
                }
                res.unwrap_or_else(|e| Err(gc_core::Error::Spawn(std::io::Error::other(e))))
            })
        } else {
            task
        };
        Ok(self.track_job((handle, task), rx))
    }

    /// 셸 명령 한 줄을 start_job과 같은 규칙(작업 번호·이벤트)으로 실행한다.
    pub(crate) fn start_shell(&self, repo: PathBuf, command: String) -> Res<u64> {
        let (tx, rx) = mpsc::unbounded_channel();
        let spawned = self.git.spawn_shell(&repo, &command, tx).map_err(|e| e.ipc())?;
        Ok(self.track_job(spawned, rx))
    }

    /// 끝날 때까지 오래 걸리는 GUI 도구(difftool·mergetool)용. 바로 돌아오고, 끝나면 이벤트 `detached-done [token, err?]`
    /// (err에는 종료 코드와 마지막 stderr가 든다). start_job과 달리 작업 번호·진행률·전역 작업 잠금을 쓰지 않는다.
    /// `cancel_detached(token)`으로 끝낼 수 있고, 종료할 때 `shutdown`이 죽인다.
    pub(crate) fn run_detached(&self, repo: PathBuf, args: Vec<String>, token: String) -> Res<()> {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let (handle, task) = self.git.spawn(&repo, &argv, tx).map_err(err)?;
        self.jobs.detached.lock().insert(token.clone(), handle);
        let me = self.clone();
        tokio::spawn(async move {
            // 출력 이벤트는 쓰지 않고 비운다 (채널이 쌓이지 않게)
            while rx.recv().await.is_some() {}
            let result = task.await.map_err(|e| e.to_string()).and_then(|r| r.map_err(|e| e.ipc()));
            me.jobs.detached.lock().remove(&token);
            me.emit.emit("detached-done", serde_json::json!([token, result.err()]));
        });
        Ok(())
    }

    /// 작업 번호를 매기고 이벤트(`job`)·완료(`job-done`)를 호스트로 중계한다.
    fn track_job(&self, (handle, task): Spawned, mut rx: mpsc::UnboundedReceiver<JobEvent>) -> u64 {
        let job = self.jobs.next.fetch_add(1, Ordering::Relaxed);
        self.jobs.running.lock().insert(job, handle);
        let me = self.clone();
        // 한 태스크에서 이벤트를 모두 중계한 **뒤에** job-done을 보낸다 (done이 마지막 job 이벤트보다 먼저 가지 않게).
        // 보낸 쪽(`events`)은 작업이 끝나면 모두 drop되므로 rx가 닫히면 이벤트는 다 나간 것이다.
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                me.emit.emit("job", serde_json::to_value(JobMessage { job, event }).unwrap_or(Value::Null));
            }
            let result = task.await.map_err(|e| e.to_string()).and_then(|r| r.map_err(|e| e.ipc()));
            // 끝난 작업은 done 전에 맵에서 뺀다 (UI가 done을 받은 시점엔 이미 없다)
            me.jobs.running.lock().remove(&job);
            me.emit.emit("job-done", serde_json::json!([job, result.err()]));
        });
        job
    }
}
