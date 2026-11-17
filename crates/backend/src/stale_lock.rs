//! 남아 있는 git `.lock` 파일 복구(feature `cli`): 앱이 예전에 git을 강제 종료(SIGKILL·`taskkill /F`)했거나 git이 죽어서 `index.lock`·`refs/….lock`이 남으면
//! 이후 fetch·pull이 `Unable to create '….lock': File exists`로 계속 실패한다. UI는 그 오류를 만나면 "잠금 파일 지우고 다시 시도"를 제안하고, 지우기는 여기서 **백엔드가 다시 검증**한 뒤에만 한다(UI를 믿지 않는다).
//!
//! 허용 조건(모두):
//! ① 그 저장소의 git 폴더(common dir·이 작업 트리의 git 폴더. 둘 다 `HEAD`와 `objects`가 있는 git 폴더 모양이어야 한다 — 불신 저장소의 `commondir`가 임의 폴더를 가리킬 수 없다) **안**(`gc_pathkey::real`로 푼 뒤 대소문자 구분 비교)
//! ② **git이 실제로 만드는 lock 이름만**(`is_git_lock`): 임의 `*.lock`(`Cargo.lock` 등)·훅·`objects/pack`의 다른 파일은 안 된다 ③ 링크가 아닌 일반 파일
//! ④ 수정 시각이 `MIN_AGE`(1분) 이상 지남 ⑤ 이 저장소에서 앱의 git 작업(`Quiet`·`Job`·`Detached`·자기 자신을 뺀 짧은 쓰기)이 돌고 있지 않고 AI 차례도 없음
//! ⑥ **그 파일을 연 프로세스가 없음**(Linux `/proc/*/fd`, macOS `proc_listpidspath`; Windows는 열린 파일을 지우면 공유 위반으로 실패하는 것에 기대 지우는 오류를 `lock.inUse`로 옮긴다 — 다른 터미널·편집기의 git이 쥔 lock을 지우지 않게).
//! 거절 사유는 코드(`lock.notRepo`·`lock.badName`·`lock.outsideGit`·`lock.notFile`·`lock.recent`·`lock.inUse`)로 UI가 번역한다.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};

use crate::util::Res;
use crate::Backend;

/// 이만큼 오래된 lock만 "남은 것"으로 본다(방금 만든 lock은 다른 git이 쥐고 있을 수 있다)
pub(crate) const MIN_AGE: Duration = Duration::from_secs(60);

fn refused(code: &str) -> String {
    match code {
        "lock.notRepo" => gc_i18n::coded!("lock.notRepo", "This is not a plain git repository").json(),
        "lock.badName" => gc_i18n::coded!("lock.badName", "This is not a lock file that Git creates").json(),
        "lock.outsideGit" => gc_i18n::coded!("lock.outsideGit", "The lock file is outside the repository's git directory").json(),
        "lock.notFile" => gc_i18n::coded!("lock.notFile", "The lock file does not exist or is not a regular file").json(),
        "lock.recent" => gc_i18n::coded!("lock.recent", "The lock file is recent; Git may still be using it").json(),
        _ => gc_i18n::coded!("lock.inUse", "Git may still be running: an operation is in progress or another program has the file open").json(),
    }
}

/// `root`(git 폴더) 기준 상대 경로가 git이 실제로 만드는 lock 이름인가.
/// 루트: `index.lock`·`packed-refs.lock`·`config.lock`·`config.worktree.lock`·`shallow.lock`, 대문자 의사 ref(`HEAD`·`ORIG_HEAD`·`FETCH_HEAD`·`MERGE_HEAD`·`CHERRY_PICK_HEAD` … `[A-Z_]+.lock`).
/// `refs/**/*.lock`. `objects/info/commit-graph.lock`·`objects/info/commit-graphs/*.lock`·`objects/pack/multi-pack-index.lock`. `worktrees/<이름>/(index|<의사 ref>).lock`(연결된 worktree)
fn is_git_lock(rel: &str) -> bool {
    let parts: Vec<&str> = rel.split('/').collect();
    let pseudo = |n: &str| n.strip_suffix(".lock").is_some_and(|b| !b.is_empty() && b.bytes().all(|c| c.is_ascii_uppercase() || c == b'_'));
    let fixed = |n: &str| matches!(n, "index.lock" | "packed-refs.lock" | "config.lock" | "config.worktree.lock" | "shallow.lock") || pseudo(n);
    match parts.as_slice() {
        [n] => fixed(n),
        ["refs", .., n] => n.ends_with(".lock") && n.len() > ".lock".len(),
        ["objects", "info", "commit-graph.lock"] | ["objects", "pack", "multi-pack-index.lock"] => true,
        ["objects", "info", "commit-graphs", n] => n.ends_with(".lock") && n.len() > ".lock".len(),
        ["worktrees", name, n] => !name.is_empty() && fixed(n),
        _ => false,
    }
}

/// 경로·파일 판정(파일 시스템을 읽는다). 통과하면 (정규화한 lock 경로, 나이). `min_age`는 시험이 줄인다
fn validate_file(repo: &Path, path: &str, min_age: Duration) -> Result<(PathBuf, Duration), String> {
    let given = Path::new(path);
    let full = if given.is_absolute() { given.to_path_buf() } else { repo.join(given) }; // git은 cwd 기준 상대 경로로 알리기도 한다
    let Some(name) = full.file_name().map(|n| n.to_string_lossy().into_owned()) else { return Err(refused("lock.badName")) };
    if !name.ends_with(".lock") || name == ".lock" {
        return Err(refused("lock.badName"));
    }
    let (_, dirs, unknown) = crate::repo_gate::dirs_of(repo);
    if unknown || dirs.is_empty() {
        return Err(refused("lock.notRepo"));
    }
    // 부모만 풀고 파일 자체는 링크가 아니어야 한다(링크를 따라 밖을 지우지 않는다)
    let real = gc_pathkey::real(full.parent().unwrap_or(&full)).join(&name);
    let Some(rel) = dirs.iter().find_map(|d| gc_pathkey::rel_strict(d, &real).filter(|_| gc_pathkey::contains_strict(d, &real))) else { return Err(refused("lock.outsideGit")) };
    // rel_strict는 구분자를 `/`로 통일한 상대 경로를 준다
    if !is_git_lock(&rel) {
        return Err(refused("lock.badName"));
    }
    let md = std::fs::symlink_metadata(&real).map_err(|_| refused("lock.notFile"))?;
    if !md.is_file() {
        return Err(refused("lock.notFile"));
    }
    let age = md.modified().ok().and_then(|m| SystemTime::now().duration_since(m).ok()).unwrap_or_default();
    if age < min_age {
        return Err(refused("lock.recent"));
    }
    Ok((real, age))
}

/// 이 파일을 연 프로세스가 있는가. `None` = 이 OS에서는 알 수 없음(Windows는 지우기 자체가 공유 위반으로 거절되는 것에 기댄다)
#[cfg(target_os = "linux")]
fn opened_by_a_process(p: &Path) -> Option<bool> {
    let target = p.to_path_buf();
    for e in std::fs::read_dir("/proc").ok()?.flatten() {
        if !e.file_name().to_string_lossy().bytes().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Ok(fds) = std::fs::read_dir(e.path().join("fd")) else { continue }; // 권한 없는 프로세스는 건너뛴다(같은 사용자의 git은 읽힌다)
        if fds.flatten().any(|fd| std::fs::read_link(fd.path()).is_ok_and(|l| l == target)) {
            return Some(true);
        }
    }
    Some(false)
}

#[cfg(target_os = "macos")]
fn opened_by_a_process(p: &Path) -> Option<bool> {
    use std::os::unix::ffi::OsStrExt;
    extern "C" {
        // libproc: 그 경로의 파일을 연 프로세스 목록의 바이트 수. 없으면 0
        fn proc_listpidspath(kind: u32, typeinfo: u32, path: *const std::os::raw::c_char, pathflags: u32, buffer: *mut std::os::raw::c_void, buffersize: i32) -> i32;
    }
    const PROC_ALL_PIDS: u32 = 1;
    let c = std::ffi::CString::new(p.as_os_str().as_bytes()).ok()?;
    // 버퍼를 줘야 실제로 연 프로세스만 센다(NULL 버퍼는 "필요한 최대 크기"를 돌려줘 항상 양수다 — 실측). pid 하나는 4바이트
    let mut pids = vec![0i32; 4096];
    // SAFETY: 읽기 전용 libproc 호출. 경로는 NUL로 끝나는 C 문자열이고 버퍼 크기(바이트)를 정확히 넘긴다.
    let n = unsafe { proc_listpidspath(PROC_ALL_PIDS, 0, c.as_ptr(), 0, pids.as_mut_ptr().cast(), (pids.len() * 4) as i32) };
    if n < 0 { None } else { Some(n > 0) }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn opened_by_a_process(_p: &Path) -> Option<bool> {
    None
}

impl Backend {
    /// 앱의 git 작업이나 AI 차례가 이 저장소에서 도는 중인가(`own`: 이 요청 자신의 등록 번호만 뺀다 — 다른 짧은 쓰기는 사용 중으로 센다)
    async fn repo_in_use(&self, repo: &Path, own: Option<u64>) -> bool {
        let me = repo.to_path_buf();
        let Ok(mine) = tokio::task::spawn_blocking(move || crate::repo_gate::resolve_keys(&me)).await else { return true };
        self.keys_locked_by_ai(&mine.keys, mine.unknown) || self.jobs.active_ids().iter().any(|(id, r)| Some(*id) != own && r.overlaps_keys(&mine.keys, mine.unknown))
    }

    async fn stale_lock(&self, repo: PathBuf, path: String, remove: bool, min_age: Duration, own: Option<u64>) -> Res<Value> {
        if self.repo_in_use(&repo, own).await {
            return Err(refused("lock.inUse"));
        }
        let (r, p) = (repo.clone(), path.clone());
        let (real, age) = tokio::task::spawn_blocking(move || validate_file(&r, &p, min_age)).await.map_err(|e| e.to_string())??;
        let r2 = real.clone();
        if tokio::task::spawn_blocking(move || opened_by_a_process(&r2)).await.map_err(|e| e.to_string())? == Some(true) {
            return Err(refused("lock.inUse"));
        }
        if remove {
            // 지우기 직전에 다시 확인한다(검사와 삭제 사이에 그 사이 작업이 시작되지 않았는지·파일이 바뀌지 않았는지·누가 열지 않았는지)
            if self.repo_in_use(&repo, own).await {
                return Err(refused("lock.inUse"));
            }
            let real2 = real.clone();
            tokio::task::spawn_blocking(move || {
                if opened_by_a_process(&real2) == Some(true) {
                    return Err(refused("lock.inUse"));
                }
                match std::fs::symlink_metadata(&real2) {
                    // Windows: 다른 프로세스가 열어 둔 파일은 지워지지 않는다(공유 위반) — 그 오류를 "사용 중"으로 옮긴다
                    Ok(m) if m.is_file() => std::fs::remove_file(&real2).map_err(|e| if cfg!(windows) && e.kind() == std::io::ErrorKind::PermissionDenied { refused("lock.inUse") } else { e.to_string() }),
                    _ => Err(refused("lock.notFile")),
                }
            })
            .await
            .map_err(|e| e.to_string())??;
        }
        Ok(json!({"path": real.to_string_lossy(), "ageSecs": age.as_secs()}))
    }

    /// 지워도 되는 남은 lock인지 확인만 한다(읽기). 돌려주는 `path`는 확인창에 보일 정규화한 경로
    pub(crate) async fn stale_lock_check(&self, repo: PathBuf, path: String) -> Res<Value> {
        self.stale_lock(repo, path, false, MIN_AGE, None).await
    }

    /// 남은 lock을 지운다(같은 검증을 다시 거친다). `own`은 이 요청이 `dispatch`에서 쥔 짧은 쓰기 등록의 번호
    pub(crate) async fn stale_lock_remove(&self, repo: PathBuf, path: String, own: Option<u64>) -> Res<Value> {
        self.stale_lock(repo, path, true, MIN_AGE, own).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::Kind;
    use std::sync::Arc;

    fn git(dir: &Path, args: &[&str]) {
        assert!(std::process::Command::new("git").current_dir(dir).args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).status().unwrap().success(), "git {args:?} in {dir:?}");
    }

    fn backend(cfg: &Path) -> Backend {
        Backend::with_parts(gc_core::GitRunner::default(), Default::default(), Arc::new(crate::NullEmit), cfg.to_path_buf(), None)
    }

    /// 오래된(수정 시각을 과거로 돌린) 파일을 만든다
    fn old_file(p: &Path) {
        std::fs::write(p, "").unwrap_or_else(|e| panic!("{p:?}: {e}"));
        let f = std::fs::File::options().write(true).open(p).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(3600)).unwrap();
    }

    #[tokio::test]
    async fn only_old_regular_lock_files_inside_the_git_dir_can_be_removed_when_nothing_runs() {
        let (cfg, repo, outside) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (repo, outside) = (gc_pathkey::real(repo.path()), gc_pathkey::real(outside.path()));
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "i"]);
        let b = backend(cfg.path());
        let s = |p: &Path| p.to_string_lossy().into_owned();
        let code = |r: Res<Value>| -> String { serde_json::from_str::<Value>(&r.err().unwrap_or_default()).ok().and_then(|v| v["code"].as_str().map(String::from)).unwrap_or_default() };
        let refused = |r: Res<Value>| code(r).starts_with("lock.");
        // 정상: 오래된 ref lock·index lock(절대·상대 경로)
        std::fs::create_dir_all(repo.join(".git/refs/remotes/origin")).unwrap();
        let ref_lock = repo.join(".git/refs/remotes/origin/main.lock");
        old_file(&ref_lock);
        let ok = b.stale_lock_check(repo.clone(), s(&ref_lock)).await.unwrap();
        assert!(ok["ageSecs"].as_u64().unwrap() >= 3000 && ok["path"] == s(&ref_lock).as_str(), "{ok}");
        assert!(ref_lock.exists(), "확인만 한다");
        b.stale_lock_remove(repo.clone(), s(&ref_lock), None).await.unwrap();
        assert!(!ref_lock.exists());
        old_file(&repo.join(".git/index.lock"));
        b.stale_lock_remove(repo.clone(), ".git/index.lock".into(), None).await.unwrap();
        assert!(!repo.join(".git/index.lock").exists());
        // 거절 1: 이름이 .lock으로 안 끝남 / 이름이 .lock뿐
        for n in ["description", "notes.txt", "x.lock.bak", ".lock"] {
            old_file(&repo.join(".git").join(n));
            assert!(refused(b.stale_lock_remove(repo.clone(), s(&repo.join(".git").join(n)), None).await), "{n}");
        }
        assert!(repo.join(".git/description").exists());
        // 거절 1b: git이 만들지 않는 이름(`.git` 안이라도 임의 `*.lock`·훅·팩 디렉터리)
        for n in ["foo.lock", "hooks/pre-commit.lock", "objects/pack/tmp.lock", "objects/info/other.lock", "info/exclude.lock", "refs.lock", "lower_case.lock"] {
            std::fs::create_dir_all(repo.join(".git").join(n).parent().unwrap()).unwrap();
            old_file(&repo.join(".git").join(n));
            assert_eq!(code(b.stale_lock_remove(repo.clone(), s(&repo.join(".git").join(n)), None).await), "lock.badName", "{n}");
            assert!(repo.join(".git").join(n).exists(), "{n}");
        }
        // git이 실제로 만드는 이름은 허용
        for n in ["ORIG_HEAD.lock", "FETCH_HEAD.lock", "HEAD.lock", "packed-refs.lock", "config.lock", "shallow.lock", "objects/info/commit-graph.lock", "objects/info/commit-graphs/commit-graph-chain.lock", "refs/heads/a/b.lock", "objects/pack/multi-pack-index.lock"] {
            std::fs::create_dir_all(repo.join(".git").join(n).parent().unwrap()).unwrap();
            old_file(&repo.join(".git").join(n));
            b.stale_lock_remove(repo.clone(), s(&repo.join(".git").join(n)), None).await.unwrap_or_else(|e| panic!("{n}: {e}"));
            assert!(!repo.join(".git").join(n).exists(), "{n}");
        }
        // 거절 2: git 폴더 밖(작업 트리·밖의 폴더·`..`)
        for p in [repo.join("work.lock"), outside.join("x.lock"), repo.join(".git/../x.lock"), repo.join(".git/refs/../../y.lock")] {
            old_file(&p);
            assert!(refused(b.stale_lock_remove(repo.clone(), s(&p), None).await), "{p:?}");
            assert!(p.exists() || !s(&p).contains(".."), "{p:?}");
        }
        // 거절 3: 링크(파일이 링크면 따라가지 않고 거절, 링크 폴더로 밖을 가리켜도 거절)
        #[cfg(unix)]
        {
            let target = outside.join("victim.lock");
            old_file(&target);
            std::os::unix::fs::symlink(&target, repo.join(".git/link.lock")).unwrap();
            assert!(refused(b.stale_lock_remove(repo.clone(), s(&repo.join(".git/link.lock")), None).await));
            std::os::unix::fs::symlink(&outside, repo.join(".git/dirlink")).unwrap();
            assert!(refused(b.stale_lock_remove(repo.clone(), s(&repo.join(".git/dirlink/victim.lock")), None).await));
            assert!(target.exists(), "밖의 파일은 지워지지 않았다");
        }
        // 거절 4: 폴더·없는 파일·방금 만든 lock
        std::fs::create_dir(repo.join(".git/dir.lock")).unwrap();
        assert!(refused(b.stale_lock_remove(repo.clone(), s(&repo.join(".git/dir.lock")), None).await));
        assert!(refused(b.stale_lock_remove(repo.clone(), s(&repo.join(".git/none.lock")), None).await));
        std::fs::write(repo.join(".git/fresh.lock"), "").unwrap();
        assert!(refused(b.stale_lock_remove(repo.clone(), s(&repo.join(".git/fresh.lock")), None).await), "방금 만든 lock은 다른 git이 쥐고 있을 수 있다");
        assert!(repo.join(".git/fresh.lock").exists());
        // 거절 5: 이 저장소에서 앱의 git 작업이 돌고 있으면 / AI 차례가 있으면
        let stale = repo.join(".git/refs/old.lock");
        old_file(&stale);
        let reg = b.register_job(vec![repo.clone()], Kind::Job).await.unwrap();
        assert!(refused(b.stale_lock_remove(repo.clone(), s(&stale), None).await), "작업 중");
        drop(reg);
        let key = crate::repo_gate::lock_key(&repo);
        b.ai.repos.lock().insert(key.clone());
        assert!(refused(b.stale_lock_remove(repo.clone(), s(&stale), None).await), "AI 차례 중");
        b.ai.repos.lock().remove(&key);
        // 짧은 쓰기 등록(이 요청 자신)은 세지 않는다
        let own = b.register_job(vec![repo.clone()], Kind::Short).await.unwrap(); // 이 요청 자신의 등록
        let other_short = b.register_job(vec![repo.clone()], Kind::Short).await.unwrap(); // 다른 쓰기
        assert_eq!(code(b.stale_lock_remove(repo.clone(), s(&stale), Some(own.id())).await), "lock.inUse", "자기 것만 빼고 다른 짧은 쓰기는 사용 중으로 센다");
        drop(other_short);
        b.stale_lock_remove(repo.clone(), s(&stale), Some(own.id())).await.unwrap();
        drop(own);
        assert!(!stale.exists());
        // 우회 시도 1: 작업 트리의 `Cargo.lock`·임의 파일(git 폴더 밖)
        old_file(&repo.join("Cargo.lock"));
        assert_eq!(code(b.stale_lock_remove(repo.clone(), s(&repo.join("Cargo.lock")), None).await), "lock.outsideGit");
        assert!(repo.join("Cargo.lock").exists());
        // 우회 시도 2: 불신 저장소의 `commondir`를 홈 같은 임의 폴더로 바꾼다 → 저장소로 인정되지 않고 그 안의 파일은 지워지지 않는다
        let home = tempfile::tempdir().unwrap();
        let home = gc_pathkey::real(home.path());
        for (name, setup) in [("plain", false), ("head-only", true)] {
            let evil = repo.with_file_name(format!("{}-evil-{name}", repo.file_name().unwrap().to_string_lossy()));
            git(&repo, &["init", "-q", "-b", "main", evil.to_str().unwrap()]);
            let ev = gc_pathkey::real(&evil);
            std::fs::write(ev.join(".git/commondir"), format!("{}\n", home.display())).unwrap();
            if setup {
                std::fs::write(home.join("HEAD"), "x").unwrap(); // HEAD만 있고 objects가 없는 폴더도 git 폴더가 아니다
            }
            for victim in ["x.lock", "index.lock", "refs/y.lock"] {
                std::fs::create_dir_all(home.join(victim).parent().unwrap()).unwrap();
                old_file(&home.join(victim));
                assert_eq!(code(b.stale_lock_remove(ev.clone(), s(&home.join(victim)), None).await), "lock.notRepo", "{name} {victim}");
                assert!(home.join(victim).exists(), "{name} {victim}: 홈의 파일이 지워졌다");
            }
        }
        // 저장소가 아닌 곳
        assert!(refused(b.stale_lock_remove(outside.clone(), s(&outside.join("x.lock")), None).await));
        // 연결된 worktree: 그 worktree의 git 폴더 안 lock(index.lock)도 허용
        let wt = repo.with_file_name(format!("{}-lw", repo.file_name().unwrap().to_string_lossy()));
        git(&repo, &["worktree", "add", "-q", "-b", "lw", wt.to_str().unwrap()]);
        let wt = gc_pathkey::real(&wt);
        let admin = std::fs::read_dir(repo.join(".git/worktrees")).unwrap().next().unwrap().unwrap().path(); // git이 이름을 정한다
        let wlock = admin.join("index.lock");
        old_file(&wlock);
        b.stale_lock_remove(wt.clone(), s(&wlock), None).await.unwrap();
        assert!(!wlock.exists());
    }

    /// 다른 프로세스가 그 lock을 열어 둔 동안은 지우지 않는다(다른 터미널·편집기의 git이 쥔 lock). 닫으면 지울 수 있다
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn a_lock_file_opened_by_another_process_is_not_removed() {
        let (cfg, repo) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let repo = gc_pathkey::real(repo.path());
        git(&repo, &["init", "-q", "-b", "main"]);
        let b = backend(cfg.path());
        let lock = repo.join(".git/index.lock");
        old_file(&lock);
        let mut holder = std::process::Command::new("sh").args(["-c", "exec 3<\"$1\"; exec sleep 30", "sh"]).arg(&lock).spawn().unwrap();
        // 프로세스가 파일을 열 때까지 기다린다
        let mut opened = false;
        for _ in 0..100 {
            if opened_by_a_process(&lock) == Some(true) {
                opened = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(opened, "열린 파일 탐지가 동작하지 않음");
        let r = b.stale_lock_remove(repo.clone(), lock.to_string_lossy().into_owned(), None).await;
        assert!(r.err().unwrap_or_default().contains("lock.inUse"));
        assert!(b.stale_lock_check(repo.clone(), lock.to_string_lossy().into_owned()).await.err().unwrap_or_default().contains("lock.inUse"));
        assert!(lock.exists(), "열려 있는 lock은 지워지지 않았다");
        holder.kill().unwrap();
        holder.wait().unwrap();
        b.stale_lock_remove(repo.clone(), lock.to_string_lossy().into_owned(), None).await.unwrap();
        assert!(!lock.exists());
    }

    #[test]
    fn git_lock_names_are_an_allow_list() {
        for ok in ["index.lock", "HEAD.lock", "ORIG_HEAD.lock", "FETCH_HEAD.lock", "MERGE_HEAD.lock", "packed-refs.lock", "config.lock", "config.worktree.lock", "shallow.lock", "refs/heads/main.lock", "refs/remotes/origin/a/b.lock", "refs/git403/ai-backup/x.lock",
            "objects/info/commit-graph.lock", "objects/info/commit-graphs/commit-graph-chain.lock", "objects/pack/multi-pack-index.lock", "worktrees/w/index.lock", "worktrees/w/HEAD.lock"] {
            assert!(is_git_lock(ok), "{ok}");
        }
        for bad in ["Cargo.lock", "foo.lock", "hooks/x.lock", "objects/pack/x.lock", "objects/x.lock", "info/exclude.lock", "refs/.lock", "refs", "worktrees/index.lock", "worktrees/w/foo.lock", "worktrees/w/x/index.lock", ".lock", "lower.lock", "objects/info/commit-graphs/sub/x.lock", "a/index.lock", ""] {
            assert!(!is_git_lock(bad), "{bad:?}");
        }
    }
}
