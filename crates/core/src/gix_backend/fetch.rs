//! 긴 작업 `spawn_job`: argv 허용 목록만 해석한다. 지금은 `fetch [<remote>]`뿐(진행·종료는 `JobEvent`, 취소는 `JobHandle`).
//!
//! 앞에 붙는 `-c <키=값>`은 `fetch.writeCommitGraph`(commit-graph는 안 씀)와 `credential.*`(백엔드가 붙이는 gh 도우미 — gix가 설정에서
//! 직접 읽는 것과 별개로 이 값들은 적용하지 않고 무시)만 허용하고 다른 키는 `Unsupported`다. `--all`·`--prune`·`--tags`·`--progress` 같은
//! 플래그도 `Unsupported`(UI 툴바의 Fetch가 쓴다). `fetch.prune`·`remote.<이름>.prune`(·`pruneTags`)이 켜져 있으면 prune을 못 하므로 거절한다.
//! `reference-transaction` 훅이 있으면 거절한다. 비대화형(`ssh_batch`가 `Some`)이면 터미널 프롬프트를 끄고, `Some(true)`면 `core.sshCommand`를
//! `ssh -o BatchMode=yes`로 바꾼다(ssh 쪽 동작은 시험하지 못함). 한계: `FETCH_HEAD`를 쓰지 않는다. ssh 주소는 외부 `ssh`를 띄우므로 Android에서는 못 쓴다.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use gix::remote::Direction;
use tokio::sync::mpsc;

use super::common::{fail, open};
use crate::{Error, JobEvent, JobHandle, Result, Spawned};

/// 앞에 붙는 `-c <키=값>`을 건너뛴다(허용 키가 아니면 `Unsupported`). fetch·clone이 같이 쓴다.
pub(super) fn strip_config<'a, 'b>(argv: &'b [&'a str]) -> Result<&'b [&'a str]> {
    let mut a = argv;
    while let ["-c", kv, rest @ ..] = a {
        let key = kv.split('=').next().unwrap_or("").to_ascii_lowercase();
        if key != "fetch.writecommitgraph" && !key.starts_with("credential.") {
            return Err(Error::Unsupported(format!("spawn_job: -c {key}")));
        }
        a = rest;
    }
    Ok(a)
}

/// `["-c", kv]… "fetch" [remote]` → 원격 이름(없으면 기본 원격).
fn parse(argv: &[&str]) -> Result<Option<String>> {
    match strip_config(argv)? {
        ["fetch"] => Ok(None),
        ["fetch", remote] if !remote.starts_with('-') => Ok(Some((*remote).to_owned())),
        _ => Err(Error::Unsupported(format!("spawn_job: {}", argv.join(" ")))),
    }
}

/// reqwest(rustls-no-provider)는 암호 제공자를 프로세스에 한 번 설치해야 한다.
pub(super) fn init_tls() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn fetch(repo: &Path, remote: Option<&str>, ssh_batch: Option<bool>, stop: &AtomicBool, events: &mpsc::UnboundedSender<JobEvent>) -> Result<()> {
    init_tls();
    let mut r = open(repo)?;
    if let Some(h) = super::write::active_hook(&r, &["reference-transaction"]) {
        return Err(Error::Unsupported(format!("fetch(hook {h})")));
    }
    let name = remote.map(gix::bstr::BStr::new);
    let remote = r.find_fetch_remote(name).map_err(fail)?;
    let label = remote.name().map_or_else(|| "remote".to_owned(), |n| n.as_bstr().to_string());
    let cfg = r.config_snapshot();
    let on = |k: String| cfg.boolean(k.as_str()).unwrap_or(false);
    if on("fetch.prune".into()) || on("fetch.pruneTags".into()) || on(format!("remote.{label}.prune")) || on(format!("remote.{label}.pruneTags")) {
        return Err(Error::Unsupported("fetch(prune configured)".into()));
    }
    if let Some(batch) = ssh_batch {
        // 인증 입력 창이 없는 백그라운드 실행: 터미널 프롬프트를 끈다
        let mut c = r.config_snapshot_mut();
        c.set_value(&gix::config::tree::gitoxide::Credentials::TERMINAL_PROMPT, "false").map_err(fail)?;
        if batch {
            c.set_value(&gix::config::tree::Core::SSH_COMMAND, "ssh -o BatchMode=yes").map_err(fail)?;
        }
    }
    let remote = r.find_fetch_remote(name).map_err(fail)?;
    let _ = events.send(JobEvent::Progress { line: format!("Fetching {label}") });
    let prepare = remote
        .connect(Direction::Fetch)
        .map_err(fail)?
        .prepare_fetch(gix::progress::Discard, Default::default())
        .map_err(fail)?;
    let outcome = prepare.receive(gix::progress::Discard, stop).map_err(fail)?;
    if stop.load(Ordering::SeqCst) {
        return Err(Error::Cancelled);
    }
    use gix::remote::fetch::refs::update::Mode;
    let (updates, edits) = match &outcome.status {
        gix::remote::fetch::Status::NoPackReceived { update_refs, .. } | gix::remote::fetch::Status::Change { update_refs, .. } => (&update_refs.updates, &update_refs.edits),
    };
    for (u, m) in updates.iter().zip(&outcome.ref_map.mappings) {
        let (tag, dst) = match (&u.mode, u.edit_index.and_then(|i| edits.get(i))) {
            (Mode::New, Some(e)) => ("[new ref]", e.name.shorten().to_string()),
            (Mode::FastForward | Mode::Forced, Some(e)) => ("updated", e.name.shorten().to_string()),
            _ => continue,
        };
        let src = m.remote.as_name().map(|n| n.to_string()).unwrap_or_default();
        let _ = events.send(JobEvent::Progress { line: format!(" * {tag} {src} -> {dst}") });
    }
    Ok(())
}

pub(super) fn spawn(repo: &Path, argv: &[&str], ssh_batch: Option<bool>, events: mpsc::UnboundedSender<JobEvent>) -> Result<Spawned> {
    let remote = parse(argv)?;
    let repo = repo.to_path_buf();
    Ok(spawn_cancellable(events, move |stop, tx| fetch(&repo, remote.as_deref(), ssh_batch, stop, tx)))
}

/// 블로킹 작업 `job`을 돌리고 종료 `JobEvent`를 보낸다. 취소 신호(또는 핸들 전부 drop)는 `job`이 받는 중단 플래그로 옮긴다.
pub(super) fn spawn_cancellable(events: mpsc::UnboundedSender<JobEvent>, job: impl FnOnce(&AtomicBool, &mpsc::UnboundedSender<JobEvent>) -> Result<()> + Send + 'static) -> Spawned {
    let (handle, mut cancel) = JobHandle::detached();
    let stop = Arc::new(AtomicBool::new(false));
    let task = tokio::spawn(async move {
        let flag = stop.clone();
        let watcher = tokio::spawn(async move {
            let _ = cancel.wait_for(|c| *c).await;
            flag.store(true, Ordering::SeqCst);
        });
        let (stop2, tx) = (stop.clone(), events.clone());
        let res = tokio::task::spawn_blocking(move || job(&stop2, &tx)).await.map_err(fail)?;
        watcher.abort();
        let res = if stop.load(Ordering::SeqCst) && res.is_err() { Err(Error::Cancelled) } else { res };
        let _ = events.send(JobEvent::Finished { code: Some(if res.is_ok() { 0 } else { 1 }) });
        res
    });
    (handle, task)
}
