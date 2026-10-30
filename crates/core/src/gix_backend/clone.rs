//! 긴 작업 `clone [--progress] -- <url> <dir>`(UI의 복제 argv, `repo` = 부모 디렉터리, 대상 = `repo/<dir>`). 앞의 `-c`는 fetch와 같은 규칙.
//!
//! git과 같게 못 하면 거절한다(`Unsupported`): 다른 모양(`--bare`·`--depth`·`-b`·`--recurse-submodules`·`--` 없음·`<dir>` 없음 등), ssh(`ssh://`·`host:path`·`user@host:path`)·`git://` URL,
//! 상대 로컬 경로(gix는 프로세스 cwd 기준으로 풀지만 git은 `repo` 기준), 호스트가 있는 `file://`, `init.templateDir`·`GIT_TEMPLATE_DIR` 설정(템플릿 복사 못 함), 받은 트리의 `.gitattributes`에 `filter=`가 있을 때(LFS 등 외부 필터를 못 돌림),
//! 빈 원격·HEAD가 브랜치가 아닌 원격(git과 다르게 동작; 아래 시험으로 확인한 경우만 허용). URL은 https·http·file·절대 로컬 경로. file·로컬 경로는 gix가 외부 `git upload-pack`을 띄우므로 git이 없는 환경(Android)에선 실패한다.
//! 대상이 있고 비어 있지 않으면 git처럼 128 오류. 실패·취소하면 **새로 만든 폴더는 통째로, 원래 있던 빈 폴더는 남기고 내용만** 지운다(gix는 빈 폴더도 지우므로 직접 되돌림). 체크아웃은 도중에 멈추지 않는다(끝까지 하거나 실패).
//! `remote.origin.url`은 git이 저장하는 값(준 문자열 그대로)으로 체크아웃 전에 고친다(gix는 실제 경로로 바꿔 저장). 한계: 템플릿(`info/exclude`·`description`·샘플 훅)을 안 만든다. 진행은 `Cloning into '<dir>'...` 한 줄과 끝 줄만 보낸다.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use gix::url::Scheme;
use tokio::sync::mpsc;

use super::common::{fail, open};
use super::fetch::{init_tls, spawn_cancellable, strip_config};
use crate::{Error, JobEvent, Result, Spawned};

/// 복제 argv면 `Some((url, dir))`, 아니면 `None`(→ fetch 쪽이 해석).
fn parse(argv: &[&str]) -> Result<Option<(String, String)>> {
    let a = strip_config(argv)?;
    if a.first() != Some(&"clone") {
        return Ok(None);
    }
    match &a[1..] {
        ["--progress", "--", url, dir] | ["--", url, dir] if !dir.is_empty() => Ok(Some(((*url).to_owned(), (*dir).to_owned()))),
        _ => Err(Error::Unsupported(format!("spawn_job: {}", argv.join(" ")))),
    }
}

pub(super) fn spawn(repo: &Path, argv: &[&str], events: mpsc::UnboundedSender<JobEvent>) -> Option<Result<Spawned>> {
    let (url, dir) = match parse(argv) {
        Ok(Some(p)) => p,
        Ok(None) => return None,
        Err(e) => return Some(Err(e)),
    };
    let dest = repo.join(&dir);
    Some(check_url(&url).and_then(|u| check_template().map(|()| u)).map(|u| spawn_cancellable(events, move |stop, tx| clone(u, &url, &dest, &dir, stop, tx))))
}

/// URL 검사: https·http·`file://`(호스트 없음)·절대 로컬 경로만. 나머지(ssh·`git://`·`host:path`·상대 경로)는 `Unsupported`.
fn check_url(url: &str) -> Result<gix::url::Url> {
    let u = gix::url::parse(url).map_err(fail)?;
    match u.scheme {
        Scheme::Https | Scheme::Http => Ok(u),
        Scheme::File if url.starts_with("file://") && u.host().is_none() => Ok(u),
        Scheme::File if !url.starts_with("file://") && Path::new(url).is_absolute() => Ok(u),
        Scheme::File => Err(Error::Unsupported("clone: relative or remote file URL".into())),
        s => Err(Error::Unsupported(format!("clone: {} URL", s.as_str()))),
    }
}

/// 템플릿 폴더 설정이 있으면 거절한다(git은 그 내용을 `.git`에 복사하지만 여기선 못 한다).
fn check_template() -> Result<()> {
    let set = std::env::var_os("GIT_TEMPLATE_DIR").is_some() || gix::config::File::from_globals().ok().is_some_and(|c| c.string("init.templateDir").is_some());
    if set { Err(Error::Unsupported("clone: init.templateDir".into())) } else { Ok(()) }
}

/// `remote.origin.url`(원격이 하나뿐)을 `stored`로 바꿔 `config.lock`에 쓰고 rename한다(잠금 파일이 있으면 실패).
fn restore_url(repo: &gix::Repository, stored: &str) -> Result<()> {
    let names = repo.remote_names();
    if names.len() != 1 {
        return Err(Error::Unsupported("clone: remotes".into()));
    }
    let path = repo.git_dir().join("config");
    let lock = repo.git_dir().join("config.lock");
    let mut cfg = gix::config::File::from_path_no_includes(path.clone(), gix::config::Source::Local).map_err(fail)?;
    for name in names {
        cfg.set_raw_value_by("remote", Some(gix::bstr::BStr::new(&name)), "url", stored).map_err(fail)?;
    }
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&lock).map_err(fail)?;
        f.write_all(&cfg.to_bstring()).and_then(|()| f.sync_all()).map_err(fail)?;
    }
    std::fs::rename(&lock, &path).map_err(|e| {
        let _ = std::fs::remove_file(&lock);
        fail(e)
    })
}

/// 체크아웃할 트리(HEAD)의 어느 `.gitattributes`에든 `filter=`가 있으면 거절한다(외부 필터는 못 돌린다).
fn check_filters(repo: &gix::Repository) -> Result<()> {
    let Some(id) = repo.head().map_err(fail)?.try_peel_to_id().map_err(fail)? else { return Ok(()) };
    let tree = id.object().map_err(fail)?.peel_to_tree().map_err(fail)?;
    let mut rec = gix::traverse::tree::Recorder::default();
    tree.traverse().breadthfirst(&mut rec).map_err(fail)?;
    for e in rec.records.iter().filter(|e| e.mode.is_blob() && (e.filepath == ".gitattributes" || e.filepath.ends_with(b"/.gitattributes"))) {
        let blob = repo.find_object(e.oid).map_err(fail)?;
        if String::from_utf8_lossy(&blob.data).lines().any(|l| !l.trim_start().starts_with('#') && l.split_whitespace().skip(1).any(|t| t.starts_with("filter=") || t == "filter" || t == "-filter")) {
            return Err(Error::Unsupported("clone: .gitattributes filter".into()));
        }
    }
    Ok(())
}

/// 실패·취소 뒤 정리: 새로 만든 폴더는 통째로 지우고, 원래 있던 빈 폴더(`existed` = 그 권한)는 남기고 비운다.
fn cleanup(dest: &Path, existed: Option<std::fs::Permissions>) {
    let _ = std::fs::remove_dir_all(dest);
    if let Some(p) = existed {
        let _ = std::fs::create_dir(dest).and_then(|()| std::fs::set_permissions(dest, p));
    }
}

fn clone(url: gix::url::Url, stored: &str, dest: &Path, dir: &str, stop: &AtomicBool, events: &mpsc::UnboundedSender<JobEvent>) -> Result<()> {
    init_tls();
    let existed = match dest.metadata() {
        Ok(m) if m.is_dir() && dest.read_dir().is_ok_and(|mut d| d.next().is_none()) => Some(m.permissions()),
        Ok(_) => return Err(Error::Exit { code: Some(128), stderr: format!("fatal: destination path '{dir}' already exists and is not an empty directory.") }),
        Err(_) => None,
    };
    let _ = events.send(JobEvent::Progress { line: format!("Cloning into '{dir}'...") });
    let res = clone_into(url, stored, dest, stop);
    if res.is_err() {
        cleanup(dest, existed);
    }
    res
}

fn clone_into(url: gix::url::Url, stored: &str, dest: &Path, stop: &AtomicBool) -> Result<()> {
    let mut prep = gix::prepare_clone(url, dest).map_err(fail)?;
    let (mut checkout, _) = prep.fetch_then_checkout(gix::progress::Discard, stop).map_err(fail)?;
    if stop.load(Ordering::SeqCst) {
        return Err(Error::Cancelled);
    }
    restore_url(checkout.repo(), stored)?;
    check_filters(checkout.repo())?;
    // 체크아웃은 멈추지 않는다(gix는 중단하면 일부만 쓰고 Ok를 돌려준다)
    checkout.main_worktree(gix::progress::Discard, &AtomicBool::new(false)).map_err(fail)?;
    open(dest)?;
    Ok(())
}
