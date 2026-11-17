//! 긴 git 작업: 작업 번호 매기기, 진행 이벤트 중계, 취소, 분리 실행(difftool·mergetool), commit-graph 보강.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use gc_core::{JobEvent, JobHandle, Spawned};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::util::{err, Res};
use crate::Backend;

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
    /// 실행 중(또는 시작 중)인 사용자 작업의 기록과 대기열. **프로세스를 띄우기 전에** 등록하고 끝나면 뺀다(`JobReg`) — AI 차례를 시작하기 전에 같은 저장소에서 도는 작업이 있는지 볼 때 쓴다.
    /// 둘을 한 잠금 안에 둬서 "확인하고 등록"과 "대기열에서 꺼내 등록"이 틈 없이 하나로 일어난다
    state: Mutex<State>,
    /// 대기열에서 기다리는 `start_job`의 취소 신호 (작업 번호 → 취소 송신). 대기 중에도 `cancel_job`이 먹는다
    waiting: Mutex<HashMap<u64, oneshot::Sender<()>>>,
    reg_next: AtomicU64,
    next: AtomicU64,
}

#[derive(Default)]
struct State {
    active: HashMap<u64, JobRec>,
    /// 같은 저장소(키가 겹치는)의 앞선 작업이 끝나길 기다리는 `Job`들. **FIFO**: 겹치는 앞선 대기자가 있으면 뒤 대기자는 먼저 시작하지 못한다
    queue: VecDeque<Waiter>,
}

struct Waiter {
    id: u64,
    rec: JobRec,
    /// 차례가 오면(= `active`에 등록되면) 깨운다. 받는 쪽이 이미 없으면(취소) 등록을 거둔다
    tx: oneshot::Sender<()>,
}

impl State {
    /// 이 기록이 지금 시작하지 못하게 막혀 있는가: 돌고 있는 직렬화 대상과 겹치거나, 대기열의 앞선 `ahead`개 중 겹치는 것이 있다
    fn blocked(&self, rec: &JobRec, ahead: usize) -> bool {
        self.active.values().any(|r| r.kind.serializes() && r.overlaps(rec)) || self.queue.iter().take(ahead).any(|w| w.rec.overlaps(rec))
    }

    /// 직렬화 대상이 아니거나 막히지 않았으면 등록한다(true). 확인과 삽입이 한 잠금 안이다
    fn try_admit(&mut self, id: u64, rec: &JobRec) -> bool {
        if rec.kind.serializes() && self.blocked(rec, self.queue.len()) {
            return false;
        }
        self.active.insert(id, rec.clone());
        true
    }

    /// 작업이 끝나거나 대기자가 사라졌을 때: 차례가 온 대기자를 앞에서부터 꺼내 등록하고 깨운다
    fn wake(&mut self) {
        loop {
            let Some(i) = (0..self.queue.len()).find(|&i| !self.blocked(&self.queue[i].rec, i)) else { return };
            let w = self.queue.remove(i).expect("index in range");
            self.active.insert(w.id, w.rec.clone());
            if w.tx.send(()).is_err() {
                self.active.remove(&w.id); // 받는 쪽이 이미 없다(취소)
            }
        }
    }
}

/// 작업의 종류: 같은 저장소 안에서의 직렬화·AI 시작과의 겹침 처리가 다르다
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(feature = "cli"), allow(dead_code))] // AI 채팅(cli) 전용
pub(crate) enum Kind {
    /// 사용자 입력 없이 도는 자동 fetch·백그라운드 commit-graph. 같은 저장소에서 다른 `Quiet`·`Job`이 돌면 시작하지 않고 건너뛴다(`job.skipped`). AI 시작은 이것이 끝나길 잠깐 기다린다
    Quiet,
    /// 사용자가 시작한 긴 작업(start_job·start_shell). 같은 저장소의 `Quiet`·`Job`이 끝나길 기다렸다가 시작한다. AI 시작은 기다리지 않고 거절한다
    Job,
    /// 오래 열려 있는 GUI 도구(run_detached: difftool·mergetool). 직렬화하지 않는다(열어 둔 동안 fetch를 막지 않게). AI 시작은 거절한다
    Detached,
    /// 짧은 쓰기 IPC(commit·stage·discard·rebase_interactive·jj_*·git 쓰기). 직렬화하지 않는다. AI 시작은 끝나길 잠깐 기다린다
    Short,
}

impl Kind {
    /// 같은 저장소에서 서로 직렬화되는 작업인가
    fn serializes(self) -> bool {
        matches!(self, Kind::Quiet | Kind::Job)
    }
    /// AI 시작이 끝나길 잠깐 기다려 주는 종류인가(아니면 즉시 거절)
    #[cfg_attr(not(feature = "cli"), allow(dead_code))] // AI 채팅(cli) 전용
    pub(crate) fn brief(self) -> bool {
        matches!(self, Kind::Quiet | Kind::Short)
    }
}

/// 실행 중인 작업 하나의 기록
#[derive(Clone, Debug)]
pub(crate) struct JobRec {
    /// 등록 때 푼 잠금 키들(작업이 건드릴 수 있는 모든 경로 — 요청의 `repo`와 argv의 `-C`·`--git-dir`·`--work-tree` 등, `repo_gate::job_targets` — 의 common dir·`core.worktree` 작업 트리 키)과, 어느 저장소인지 알 수 없는지
    pub keys: Vec<String>,
    pub unknown: bool,
    pub kind: Kind,
}

impl JobRec {
    /// 두 작업이 같은 저장소를 건드릴 수 있는가(알 수 없는 쪽은 모두와 겹친다)
    pub(crate) fn overlaps_keys(&self, keys: &[String], unknown: bool) -> bool {
        self.unknown || unknown || self.keys.iter().any(|k| keys.contains(k))
    }

    fn overlaps(&self, other: &JobRec) -> bool {
        self.overlaps_keys(&other.keys, other.unknown)
    }
}

/// 등록 시도 결과
enum Reg {
    Now(JobReg),
    /// 막혀서 대기열에 들어갔다: `rx`는 차례가 오면 깨어난다(그때는 이미 `active`에 `qid`로 등록돼 있다)
    Queued { qid: u64, rx: oneshot::Receiver<()>, keys: Vec<String>, unknown: bool },
}

/// 작업 등록 표지: 놓이면(drop) 등록이 빠진다. 시작 실패·취소·끝남 모두 같은 길로 정리된다
pub(crate) struct JobReg {
    me: Backend,
    id: u64,
}

impl Drop for JobReg {
    fn drop(&mut self) {
        let mut st = self.me.jobs.state.lock();
        st.active.remove(&self.id);
        st.wake(); // 이 작업을 기다리던 다음 작업을 시작시킨다
    }
}

impl JobReg {
    /// 이 등록의 번호(`Jobs::active_ids`의 키)
    pub(crate) fn id(&self) -> u64 {
        self.id
    }
}

impl std::fmt::Debug for JobReg {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "JobReg({})", self.id)
    }
}

impl Jobs {
    /// 지금 실행 중인 사용자 작업(start_job·start_shell·run_detached)의 기록들
    #[cfg_attr(not(feature = "cli"), allow(dead_code))] // AI 채팅(cli) 전용
    pub(crate) fn active(&self) -> Vec<JobRec> {
        self.state.lock().active.values().cloned().collect()
    }

    /// `active`에 등록 번호를 붙인 것(자기 등록만 빼고 세려는 곳이 쓴다)
    #[cfg_attr(not(feature = "cli"), allow(dead_code))]
    pub(crate) fn active_ids(&self) -> Vec<(u64, JobRec)> {
        self.state.lock().active.iter().map(|(i, r)| (*i, r.clone())).collect()
    }

    /// 대기자를 대기열에서 뺀다. 이미 차례가 와서 등록됐으면(대기열에 없으면) false — 호출 측이 그 등록을 책임진다
    fn dequeue(&self, qid: u64) -> bool {
        let mut st = self.state.lock();
        let before = st.queue.len();
        st.queue.retain(|w| w.id != qid);
        let removed = st.queue.len() != before;
        if removed {
            st.wake(); // 이 대기자 뒤에서 막혀 있던 것이 있으면 풀어 준다
        }
        removed
    }

    pub fn cancel(&self, job: u64) {
        // 대기열에서 기다리는 중이면 대기를 취소한다(프로세스가 아직 없다)
        if let Some(tx) = self.waiting.lock().remove(&job) {
            let _ = tx.send(());
            return;
        }
        if let Some(h) = self.running.lock().remove(&job) {
            h.cancel();
        }
    }

    pub fn cancel_detached(&self, token: &str) {
        if let Some(h) = self.detached.lock().remove(token) {
            h.cancel();
        }
    }

    /// 종료 정리용: 실행 중인 작업의 핸들을 모두 꺼낸다(정리는 `Backend::shutdown`이 한꺼번에 `JobHandle::stop_all`로)
    pub fn take_all(&self) -> Vec<gc_core::JobHandle> {
        // 대기 중인 작업은 취소하고 대기열을 비운다(프로세스가 없어 정리할 것은 대기 취소뿐)
        for (_, tx) in self.waiting.lock().drain() {
            let _ = tx.send(());
        }
        self.state.lock().queue.clear();
        let mut all: Vec<_> = self.running.lock().drain().map(|(_, h)| h).collect();
        all.extend(self.detached.lock().drain().map(|(_, h)| h));
        all
    }
}

/// commit-graph 보장을 백그라운드로 돌린다. 실패는 로그(stderr)만 남기고 무시한다.
/// `Quiet` 작업으로 등록해서 같은 저장소의 fetch·pull과 서로 직렬화한다(둘 다 `objects/info/commit-graph.lock`을 쥔다 — 겹치면 fetch가 `File exists`로 실패한다).
/// 방금 끝난 fetch의 등록이 아직 남아 있을 수 있어 잠깐(최대 10초) 재시도하고, 다른 작업이 계속 돌면 조용히 포기한다(다음 기회에 보강).
pub(crate) fn spawn_commit_graph(me: Backend, repo: PathBuf) {
    tokio::spawn(async move {
        let mut reg = None;
        for _ in 0..50 {
            match me.register_job(job_targets(&repo, &[]), Kind::Quiet).await {
                Ok(r) => {
                    reg = Some(r);
                    break;
                }
                Err(e) if e.contains("aiChat.repoBusy") => return,
                Err(_) => tokio::time::sleep(std::time::Duration::from_millis(200)).await,
            }
        }
        let Some(_reg) = reg else { return };
        if let Err(e) = me.backend.ensure_commit_graph(&repo).await {
            eprintln!("commit-graph: {e}");
        }
    });
}

/// 작업이 건드릴 경로들: 요청의 `repo`와 argv의 `-C`·`--git-dir`·`--work-tree` 대상
#[cfg(feature = "cli")]
fn job_targets(repo: &std::path::Path, args: &[String]) -> Vec<PathBuf> {
    crate::repo_gate::job_targets(repo, args)
}
#[cfg(not(feature = "cli"))]
fn job_targets(repo: &std::path::Path, _args: &[String]) -> Vec<PathBuf> {
    vec![repo.to_path_buf()]
}

/// 등록 때 경로를 푼다: cli는 common dir·`core.worktree` 작업 트리 키까지(`repo_gate::resolve_keys`), 순수 Rust(gix)는 실제 경로 키. 파일 시스템을 읽으므로 블로킹 스레드에서 부른다
fn resolve_job_targets(targets: &[PathBuf]) -> (Vec<String>, bool) {
    let mut keys = Vec::new();
    let mut unknown = false;
    for t in targets {
        unknown |= gc_pathkey::is_drive_relative(&t.to_string_lossy());
        #[cfg(feature = "cli")]
        {
            let r = crate::repo_gate::resolve_keys(t);
            unknown |= r.unknown;
            keys.extend(r.keys);
        }
        #[cfg(not(feature = "cli"))]
        keys.push(gc_pathkey::real_key(t));
    }
    (keys, unknown)
}

/// 사용자 작업이 같은 저장소의 앞선 작업을 기다리는 최대 시간
fn job_wait() -> std::time::Duration {
    #[cfg(test)]
    return std::time::Duration::from_secs(3);
    #[cfg(not(test))]
    std::time::Duration::from_secs(120)
}

impl Backend {
    /// 프로세스를 띄우기(또는 쓰기를 시작하기) **전에** 작업을 등록하고 AI 차례 잠금을 다시 확인한다(잠겨 있으면 등록을 거두고 `aiChat.repoBusy`).
    /// 왜 이 순서인가: 게이트를 통과한 뒤 작업이 등록되기 전에 AI 차례가 시작하면 둘이 겹친다. `ai_chat_start`는 **잠금을 먼저 잡고 그 뒤에** 등록된 작업을 확인하고,
    /// 여기서는 **등록을 먼저 하고 그 뒤에** 잠금을 확인한다. 두 쪽 모두 "내 표시를 먼저 남기고 상대의 표시를 본다"이므로 어느 순서로 오든 적어도 한쪽은 상대를 본다
    /// (작업이 먼저 등록 → AI 시작이 작업을 보고 거절·대기 / AI 잠금이 먼저 → 작업이 잠금을 보고 거절) — 둘이 동시에 통과할 수 없다.
    ///
    /// **같은 저장소 직렬화**(여러 창·VS Code가 같은 저장소에 동시에 fetch를 날리면 `FETCH_HEAD`·ref lock이 부딪친다): `Quiet`·`Job`은 같은 저장소(common dir·작업 트리 키가 겹침)에서 돌고 있는
    /// `Quiet`·`Job`이 있으면 — `Quiet`은 시작하지 않고 `job.skipped`로 건너뛰고, `Job`은 FIFO 대기열에서 차례를 기다린다(`job_wait` 안에 못 시작하면 `job.busy`). 확인과 삽입은 한 잠금 안에서 해서 틈이 없다.
    /// (`start_job`은 번호를 먼저 돌려주고 기다려야 해서 `register_nowait`를 쓴다)
    pub(crate) async fn register_job(&self, targets: Vec<PathBuf>, kind: Kind) -> Res<JobReg> {
        match self.register_nowait(targets, kind).await? {
            Reg::Now(reg) => Ok(reg),
            Reg::Queued { qid, rx, keys, unknown } => {
                let granted = matches!(tokio::time::timeout(job_wait(), rx).await, Ok(Ok(())));
                // 시간이 지나도록 차례가 안 왔으면 대기열에서 빼고 거절한다. 빼려는 순간 이미 차례가 와서 등록됐다면(대기열에 없음) 그 등록을 인정한다
                if !granted && self.jobs.dequeue(qid) {
                    return Err(gc_i18n::coded!("job.busy", "Another operation is still running in this repository. Try again when it finishes.").json());
                }
                self.after_admit(JobReg { me: self.clone(), id: qid }, &keys, unknown)
            }
        }
    }

    /// 기다리지 않고 등록을 시도한다: 바로 등록되면 `Now`, 막혔으면 `Quiet`은 건너뜀(`job.skipped`)·`Job`은 대기열에 넣어 `Queued`
    async fn register_nowait(&self, targets: Vec<PathBuf>, kind: Kind) -> Res<Reg> {
        let t = targets.clone();
        let (keys, unknown) = tokio::task::spawn_blocking(move || resolve_job_targets(&t)).await.map_err(|e| e.to_string())?;
        let id = self.jobs.reg_next.fetch_add(1, Ordering::Relaxed);
        let rec = JobRec { keys: keys.clone(), unknown, kind };
        let mut st = self.jobs.state.lock();
        if st.try_admit(id, &rec) {
            drop(st);
            return self.after_admit(JobReg { me: self.clone(), id }, &keys, unknown).map(Reg::Now);
        }
        if kind == Kind::Quiet {
            return Err(gc_i18n::coded!("job.skipped", "Another operation is already running in this repository, so the automatic task was skipped").json());
        }
        let (tx, rx) = oneshot::channel();
        st.queue.push_back(Waiter { id, rec, tx });
        Ok(Reg::Queued { qid: id, rx, keys, unknown })
    }

    /// 등록된 뒤 AI 차례 잠금을 다시 확인한다(잠겨 있으면 등록을 거둔다)
    fn after_admit(&self, reg: JobReg, keys: &[String], unknown: bool) -> Res<JobReg> {
        #[cfg(feature = "cli")]
        if self.keys_locked_by_ai(keys, unknown) {
            return Err(crate::repo_gate::busy_error()); // `reg`가 놓이며 등록이 빠진다
        }
        let _ = (keys, unknown);
        Ok(reg)
    }

    fn emit_job(&self, job: u64, event: JobEvent) {
        self.emit.emit("job", serde_json::to_value(JobMessage { job, event }).unwrap_or(Value::Null));
    }

    /// pull/fetch/push 같은 긴 작업. 바로 작업 번호를 돌려주고 진행은 `job` 이벤트로 보낸다.
    ///
    /// `interactive: false`면 백그라운드 작업(자동 fetch): 인증 입력 창(askpass)을 쓰지 않고 ssh는 BatchMode.
    /// 사용자가 `core.sshCommand`·`GIT_SSH_COMMAND`를 설정해 뒀으면 그대로 둔다.
    ///
    /// 같은 저장소(common dir)에서 앞선 `Quiet`·`Job`이 돌고 있으면: 자동 작업(`interactive: false`)은 시작하지 않고 `job.skipped`, 사용자 작업은 **작업 번호를 먼저 돌려주고**(대기 전에)
    /// FIFO 대기열에서 차례를 기다린다. 기다리는 동안 이벤트 `job {kind: "waiting"}`, 시작하면 `{kind: "started"}`가 나가고 `cancel_job`으로 대기를 취소할 수 있다
    /// (취소하면 `job-done`에 `git.cancelled`). 앞선 작업은 건드리지 않는다.
    pub(crate) async fn start_job(&self, repo: PathBuf, args: Vec<String>, interactive: Option<bool>, gh_user: Option<String>, gh_restore: bool) -> Res<u64> {
        #[cfg(target_os = "android")]
        self.check_clone_dest(&repo, &args)?;
        let kind = if interactive == Some(false) { Kind::Quiet } else { Kind::Job };
        match self.register_nowait(job_targets(&repo, &args), kind).await? {
            Reg::Now(reg) => self.run_job(reg, None, repo, args, interactive, gh_user, gh_restore).await,
            Reg::Queued { qid, rx, keys, unknown } => {
                let job = self.jobs.next.fetch_add(1, Ordering::Relaxed);
                let (cancel_tx, cancel_rx) = oneshot::channel();
                self.jobs.waiting.lock().insert(job, cancel_tx);
                let me = self.clone();
                tokio::spawn(async move {
                    me.emit_job(job, JobEvent::Waiting);
                    let granted = tokio::select! { r = rx => r.is_ok(), _ = cancel_rx => false };
                    me.jobs.waiting.lock().remove(&job);
                    let done = |err: String| me.emit.emit("job-done", serde_json::json!([job, err]));
                    if !granted {
                        // 취소(또는 종료 정리): 대기열에서 뺀다. 그 순간 이미 차례가 와서 등록됐다면 그 등록을 거둔다
                        if !me.jobs.dequeue(qid) {
                            drop(JobReg { me: me.clone(), id: qid });
                        }
                        return done(gc_core::Error::Cancelled.ipc());
                    }
                    // 차례가 왔다(이미 등록됨): AI 차례 잠금을 다시 확인하고 시작한다
                    let reg = match me.after_admit(JobReg { me: me.clone(), id: qid }, &keys, unknown) {
                        Ok(r) => r,
                        Err(e) => return done(e),
                    };
                    me.emit_job(job, JobEvent::Started);
                    if let Err(e) = me.run_job(reg, Some(job), repo, args, interactive, gh_user, gh_restore).await {
                        done(e);
                    }
                });
                Ok(job)
            }
        }
    }

    /// 등록을 마친 작업을 실제로 시작한다(`job`이 있으면 대기 중에 이미 돌려준 작업 번호를 그대로 쓴다)
    #[allow(clippy::too_many_arguments)]
    async fn run_job(&self, reg: JobReg, job: Option<u64>, repo: PathBuf, mut args: Vec<String>, interactive: Option<bool>, gh_user: Option<String>, gh_restore: bool) -> Res<u64> {
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
        let ssh_batch = if interactive == Some(false) {
            let own_ssh = std::env::var_os("GIT_SSH_COMMAND").is_some()
                || self.backend.run(&repo, &["config", "--get", "core.sshCommand"], &[]).await.is_ok_and(|o| !o.is_empty());
            Some(!own_ssh)
        } else {
            None
        };
        let spawned = self.backend.spawn_job(&repo, &argv, ssh_batch, tx);
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
            let me = self.clone();
            tokio::spawn(async move {
                let res = task.await;
                // 성공·실패·취소 모두 복원한다(복원 로그는 채널이 닫히기 전에 보낸다)
                if let Some(l) = lease {
                    me.gh_release(l, gh_restore, &log_tx).await;
                }
                if network && matches!(res, Ok(Ok(()))) {
                    spawn_commit_graph(me.clone(), repo);
                }
                res.unwrap_or_else(|e| Err(gc_core::Error::Spawn(std::io::Error::other(e))))
            })
        } else {
            task
        };
        Ok(self.track_job((handle, task), rx, reg, job))
    }

    /// 셸 명령 한 줄을 start_job과 같은 규칙(작업 번호·이벤트)으로 실행한다.
    #[cfg(feature = "cli")]
    pub(crate) async fn start_shell(&self, repo: PathBuf, command: String) -> Res<u64> {
        let reg = self.register_job(vec![repo.clone()], Kind::Job).await?;
        let (tx, rx) = mpsc::unbounded_channel();
        let spawned = self.git.spawn_shell(&repo, &command, tx).map_err(|e| e.ipc())?;
        Ok(self.track_job(spawned, rx, reg, None))
    }

    /// 셸 명령은 프로세스를 띄우므로 순수 Rust 백엔드(`cli` 없음)에서는 지원하지 않는다.
    #[cfg(not(feature = "cli"))]
    pub(crate) async fn start_shell(&self, _repo: PathBuf, _command: String) -> Res<u64> {
        Err(gc_core::Error::Unsupported("shell".into()).ipc())
    }

    /// 앱 전용 저장소 폴더 `<config_dir>/repos`(만들어 둔다). Android에서만 값이 있고 데스크탑은 `None`.
    /// Android의 `config_dir`는 Tauri `app_config_dir()`(앱 전용 내부 저장소; `src-tauri`가 실패 시 대체 경로 없이 시작을 중단)다.
    #[cfg(target_os = "android")]
    pub(crate) async fn repos_root(&self) -> Res<Option<String>> {
        let dir = self.config_dir.join("repos");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(Some(dir.to_string_lossy().into_owned()))
    }

    #[cfg(not(target_os = "android"))]
    pub(crate) async fn repos_root(&self) -> Res<Option<String>> {
        Ok(None)
    }

    /// Android에서는 복제 대상(`repo/<dir>`)이 앱 전용 저장소 폴더 안이어야 한다(`..`·절대 경로 `<dir>` 거절). 다른 `start_job` 작업과 데스크탑은 그대로.
    #[cfg(target_os = "android")]
    fn check_clone_dest(&self, repo: &std::path::Path, args: &[String]) -> Res<()> {
        use std::path::Component;
        if args.first().map(String::as_str) != Some("clone") {
            return Ok(());
        }
        let dest = repo.join(args.last().map(String::as_str).unwrap_or(""));
        let root = self.config_dir.join("repos");
        if dest.components().any(|c| c == Component::ParentDir) || !dest.starts_with(&root) {
            return Err(gc_core::Error::Unsupported("clone: outside app storage".into()).ipc());
        }
        Ok(())
    }

    /// 끝날 때까지 오래 걸리는 GUI 도구(difftool·mergetool)용. 바로 돌아오고, 끝나면 이벤트 `detached-done [token, err?]`
    /// (err에는 종료 코드와 마지막 stderr가 든다). start_job과 달리 작업 번호·진행률·전역 작업 잠금을 쓰지 않는다.
    /// `cancel_detached(token)`으로 끝낼 수 있고, 종료할 때 `shutdown`이 죽인다.
    pub(crate) async fn run_detached(&self, repo: PathBuf, args: Vec<String>, token: String) -> Res<()> {
        let reg = self.register_job(job_targets(&repo, &args), Kind::Detached).await?;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let (handle, task) = self.backend.spawn_job(&repo, &argv, None, tx).map_err(err)?;
        self.jobs.detached.lock().insert(token.clone(), handle);
        let me = self.clone();
        tokio::spawn(async move {
            // 출력 이벤트는 쓰지 않고 비운다 (채널이 쌓이지 않게)
            while rx.recv().await.is_some() {}
            let result = task.await.map_err(|e| e.to_string()).and_then(|r| r.map_err(|e| e.ipc()));
            me.jobs.detached.lock().remove(&token);
            drop(reg);
            me.emit.emit("detached-done", serde_json::json!([token, result.err()]));
        });
        Ok(())
    }

    /// 작업 번호를 매기고 이벤트(`job`)·완료(`job-done`)를 호스트로 중계한다.
    fn track_job(&self, (handle, task): Spawned, mut rx: mpsc::UnboundedReceiver<JobEvent>, reg: JobReg, job: Option<u64>) -> u64 {
        let job = job.unwrap_or_else(|| self.jobs.next.fetch_add(1, Ordering::Relaxed));
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
            drop(reg);
            me.emit.emit("job-done", serde_json::json!([job, result.err()]));
        });
        job
    }
}
