//! 저장소 파일 감시. 변경을 짧은 시간(250ms) 몰아서 한 번만 알린다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify_debouncer_mini::notify::{recommended_watcher, Event, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;

/// 어떤 종류의 변경인지. UI는 필요한 것만 다시 읽는다.
#[derive(Clone, Serialize)]
pub struct RepoChange {
    /// 작업 디렉터리 또는 index가 바뀜 → 상태 다시 읽기
    pub worktree: bool,
    /// HEAD·브랜치·태그·스태시가 바뀜 → 그래프·참조 다시 읽기
    pub refs: bool,
    /// 감시를 요청할 때 받은 저장소 경로(그대로). 여러 저장소를 구분하는 용도
    pub repo: String,
}

pub struct RepoWatcher {
    /// 떨어뜨리면 감시가 멈추고 몰아주는 스레드도 끝난다(채널이 닫힘)
    _watcher: RecommendedWatcher,
    /// 떨어뜨린 뒤에는 몰아 둔 변경도 알리지 않는다(`remove` 응답 이후 이벤트가 없어야 한다)
    stopped: Arc<AtomicBool>,
}

impl Drop for RepoWatcher {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
    }
}

const QUIET: Duration = Duration::from_millis(250);
/// 변경이 계속 이어져도 이 시간마다는 알린다
const MAX_WAIT: Duration = Duration::from_secs(1);

/// 변경 경로를 QUIET 동안 조용해질 때까지(최대 MAX_WAIT) 모아 한 번에 `flush`에 넘긴다.
/// 파일을 열고 읽기만 해도 나는 접근 이벤트(Linux inotify의 OPEN·CLOSE_NOWRITE — git status가 index를, 감시 시작이 폴더를 열 때)는
/// 저장소 변경이 아니므로 보내지 않는다. 걸러 두지 않으면 감시를 시작하자마자·git이 읽을 때마다 가짜 변경이 온다.
fn debounce(rx: mpsc::Receiver<PathBuf>, mut flush: impl FnMut(Vec<PathBuf>)) {
    while let Ok(first) = rx.recv() {
        let (start, mut paths) = (Instant::now(), vec![first]);
        loop {
            let wait = QUIET.min(MAX_WAIT.saturating_sub(start.elapsed()));
            match rx.recv_timeout(wait) {
                Ok(p) => paths.push(p),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
            if start.elapsed() >= MAX_WAIT {
                break;
            }
        }
        paths.sort();
        paths.dedup();
        flush(paths);
    }
}

impl RepoWatcher {
    pub fn start(repo: &Path, on_change: impl Fn(RepoChange) + Send + 'static) -> notify_debouncer_mini::notify::Result<Self> {
        // macOS FSEvents는 심링크를 푼 경로(/var → /private/var)로 알린다. 두 형태 모두 .git으로 알아본다.
        let roots: Vec<PathBuf> = [Some(repo.to_path_buf()), gc_pathkey::canonical(repo).ok()].into_iter().flatten().collect();
        let mut git_dirs: Vec<PathBuf> = roots.iter().map(|r| r.join(".git")).collect();
        // linked worktree·서브모듈은 `.git`이 파일이라 실제 git 디렉터리(와 공통 디렉터리)가 작업 트리 밖에 있다
        let linked = linked_git_dirs(repo);
        for d in &linked {
            git_dirs.extend([Some(d.clone()), gc_pathkey::canonical(d).ok()].into_iter().flatten());
        }
        let root = repo.to_path_buf();
        let repo_str = repo.to_string_lossy().into_owned();
        let mut ignored = ignore_rules(&root);
        let (tx, rx) = mpsc::channel::<PathBuf>();
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let cb_git_dirs = git_dirs.clone();
        let mut watcher = recommended_watcher(move |res: notify_debouncer_mini::notify::Result<Event>| {
            let Ok(ev) = res else { return };
            if !ev.kind.is_access() {
                // .git 안에서 상태·참조와 무관한 경로(objects, lock 파일 등)는 채널에 쌓지 않는다(큰 fetch·gc 때 수만 건)
                let relevant = |p: &PathBuf| cb_git_dirs.iter().find_map(|d| p.strip_prefix(d).ok()).is_none_or(|inner| git_change(inner).is_some());
                ev.paths.into_iter().filter(relevant).for_each(|p| drop(tx.send(p)));
            }
        })?;
        watcher.watch(repo, RecursiveMode::Recursive)?;
        for d in &linked {
            watcher.watch(d, RecursiveMode::Recursive)?;
        }
        std::thread::spawn(move || debounce(rx, move |events| {
            let mut change = RepoChange { worktree: false, refs: false, repo: repo_str.clone() };
            for path in &events {
                match git_dirs.iter().find_map(|d| path.strip_prefix(d).ok()) {
                    Some(inner) => {
                        // 그 밖의 .git 내부(objects, lock 파일 등)는 무시
                        if let Some(refs) = git_change(inner) {
                            change.worktree = true;
                            change.refs |= refs;
                        }
                    }
                    None => {
                        // ignore된 경로(target/, node_modules/ 등 빌드 산출물)는 상태에 안 나오므로 무시
                        let Some(rel) = roots.iter().find_map(|r| path.strip_prefix(r).ok()) else { continue };
                        // 하위 저장소의 .git 내부(index·refs 갱신 등)는 상위 저장소 상태가 아니다
                        if rel.components().any(|c| c.as_os_str() == ".git") {
                            continue;
                        }
                        if rel.file_name().is_some_and(|n| n == ".gitignore") {
                            ignored = ignore_rules(&root);
                            change.worktree = true;
                        } else if !is_ignored(&ignored, rel, path) {
                            change.worktree = true;
                        }
                    }
                }
            }
            if (change.worktree || change.refs) && !stop.load(Ordering::SeqCst) {
                on_change(change);
            }
        }));
        Ok(Self { _watcher: watcher, stopped })
    }
}

/// git 디렉터리 안 경로가 알릴 만한 변경인가: `Some(refs)` = index 변경(false) 또는 HEAD·refs·스태시 변경(true), `None` = 무시.
fn git_change(inner: &Path) -> Option<bool> {
    let s = inner.to_string_lossy();
    if s == "index" {
        Some(false)
    } else if s == "HEAD" || s == "packed-refs" || s.starts_with("refs") || s.starts_with("logs/refs/stash") {
        Some(true)
    } else {
        None
    }
}

/// ignore 규칙에 걸리는 경로인가. 디렉터리 전용 규칙(`target/`)이 갈리는 경우에만 디스크를 확인한다(`is_dir` stat 생략).
fn is_ignored(rules: &Gitignore, rel: &Path, abs: &Path) -> bool {
    let (file, dir) = (rules.matched_path_or_any_parents(rel, false).is_ignore(), rules.matched_path_or_any_parents(rel, true).is_ignore());
    if file == dir { file } else if abs.is_dir() { dir } else { file }
}

/// `.git`이 파일(`gitdir: <경로>`)일 때 가리키는 git 디렉터리와, 그 안 `commondir`이 가리키는 공통 디렉터리(refs 등이 있는 곳).
/// 저장소 내용은 믿지 않으므로 `HEAD`가 있는 디렉터리만 감시한다(`.git` 파일이 `/`나 홈을 가리켜 전체를 감시하게 만들 수 없다).
fn linked_git_dirs(repo: &Path) -> Vec<PathBuf> {
    let Ok(text) = std::fs::read_to_string(repo.join(".git")) else { return vec![] };
    let Some(rel) = text.lines().find_map(|l| l.strip_prefix("gitdir:")).map(str::trim) else { return vec![] };
    let valid = |d: PathBuf| gc_pathkey::canonical(&d).ok().filter(|d| d.join("HEAD").is_file());
    let Some(gitdir) = valid(repo.join(rel)) else { return vec![] };
    let common = std::fs::read_to_string(gitdir.join("commondir")).ok().and_then(|c| valid(gitdir.join(c.trim())));
    let mut v = vec![gitdir];
    v.extend(common.filter(|c| *c != v[0]));
    v
}

/// 루트 .gitignore와 .git/info/exclude 규칙. (하위 폴더의 .gitignore는 보지 않는다 — 걸러지지 않은 변경은 상태를 한 번 더 읽을 뿐)
fn ignore_rules(repo: &Path) -> Gitignore {
    let mut b = GitignoreBuilder::new(repo);
    b.add(repo.join(".gitignore"));
    b.add(repo.join(".git/info/exclude"));
    b.build().unwrap_or_else(|_| Gitignore::empty())
}

/// 감시 중인 저장소. `watch`는 하나만(새 요청이 이전 감시를 바꿈), `watch_add`/`watch_remove`는 저장소별로 여러 개.
/// 두 방식이 같은 저장소를 보면 감시자가 각각 있어 `repo-changed`가 두 번 온다(중복 허용 — 호출자가 한 방식만 쓰면 없다).
#[derive(Default)]
pub(crate) struct ActiveWatch {
    current: Mutex<Option<RepoWatcher>>,
    /// 마지막 요청 번호. 늦게 끝난 이전 요청의 감시는 버린다.
    seq: AtomicU64,
    many: Mutex<Many>,
}

/// 저장소별 다중 감시. 원하는 상태(`wanted`)를 시작 전에 락 안에서 먼저 기록하고,
/// 시작이 끝났을 때 같은 세대일 때만 `active`에 넣는다(그 사이 remove·재add가 있었으면 버림).
#[derive(Default)]
struct Many {
    next_gen: u64,
    /// 키 = 정규화한 경로, 값 = 그 add 요청의 세대
    wanted: HashMap<PathBuf, u64>,
    active: HashMap<PathBuf, RepoWatcher>,
}

impl Many {
    /// 이미 원하는 중이면 None, 아니면 새 세대를 기록해 돌려준다.
    fn begin(&mut self, k: &Path) -> Option<u64> {
        if self.wanted.contains_key(k) {
            return None;
        }
        self.next_gen += 1;
        self.wanted.insert(k.to_path_buf(), self.next_gen);
        Some(self.next_gen)
    }

    /// 시작 완료. 아직 같은 세대로 원하면 넣고, 아니면 watcher를 버린다.
    fn finish(&mut self, k: &Path, gen: u64, w: Option<RepoWatcher>) {
        if self.wanted.get(k) != Some(&gen) {
            return;
        }
        match w {
            Some(w) => drop(self.active.insert(k.to_path_buf(), w)),
            None => drop(self.wanted.remove(k)), // 시작 실패 → 다시 add할 수 있게
        }
    }

    fn remove(&mut self, k: &Path) {
        self.wanted.remove(k);
        self.active.remove(k);
    }
}

fn key(repo: &Path) -> PathBuf {
    gc_pathkey::real(repo)
}

/// 감시할 수 있는 경로인지: 존재하는 디렉터리이고 작업 트리 최상위(`.git` 폴더 또는 파일)여야 한다.
/// 파일 시스템 루트와 홈 디렉터리 자체는 거부한다. 통과하면 정규화한 경로를 돌려준다.
fn check_repo(repo: &Path) -> Result<PathBuf, String> {
    let k = gc_pathkey::canonical(repo).map_err(|e| format!("{}: {e}", repo.display()))?;
    if !k.is_dir() {
        return Err(format!("not a directory: {}", repo.display()));
    }
    if k.parent().is_none() || gc_core::home_dir().ok().and_then(|h| gc_pathkey::canonical(h).ok()).is_some_and(|h| gc_pathkey::same_folded(h, &k)) {
        return Err(format!("refusing to watch: {}", repo.display()));
    }
    if !k.join(".git").exists() {
        return Err(format!("not a git repository: {}", repo.display()));
    }
    Ok(k)
}

async fn start(repo: PathBuf, on_change: impl Fn(RepoChange) + Send + 'static) -> Result<RepoWatcher, String> {
    // 큰 저장소에서는 시작이 느려서 블로킹 스레드에서 한다.
    tokio::task::spawn_blocking(move || RepoWatcher::start(&repo, on_change))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

impl ActiveWatch {
    /// 감시를 시작한다(이전 `watch` 저장소 감시는 멈춘다).
    pub async fn watch(&self, repo: PathBuf, on_change: impl Fn(RepoChange) + Send + 'static) -> Result<(), String> {
        check_repo(&repo)?;
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let w = start(repo, on_change).await?;
        let mut cur = self.current.lock();
        if self.seq.load(Ordering::SeqCst) == seq {
            *cur = Some(w);
        }
        Ok(())
    }

    /// 저장소 하나를 더 감시한다. 이미 감시 중(또는 시작 중)이면 아무것도 하지 않는다.
    /// 시작 중에 `remove`가 오면 시작이 끝나도 감시를 남기지 않는다.
    pub async fn add(&self, repo: PathBuf, on_change: impl Fn(RepoChange) + Send + 'static) -> Result<(), String> {
        let k = check_repo(&repo)?;
        let Some(gen) = self.many.lock().begin(&k) else { return Ok(()) };
        match start(repo, on_change).await {
            Ok(w) => self.many.lock().finish(&k, gen, Some(w)),
            Err(e) => {
                self.many.lock().finish(&k, gen, None);
                return Err(e);
            }
        }
        Ok(())
    }

    pub fn remove(&self, repo: &Path) {
        self.many.lock().remove(&key(repo));
    }

    pub fn stop(&self) {
        self.seq.fetch_add(1, Ordering::SeqCst);
        self.current.lock().take();
        let mut m = self.many.lock();
        m.wanted.clear();
        m.active.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join(".git")).unwrap();
        d
    }

    fn started(d: &Path) -> RepoWatcher {
        RepoWatcher::start(d, |_| {}).unwrap()
    }

    #[test]
    fn 시작_중_remove되면_늦게_끝난_add는_버려진다() {
        let d = repo();
        let k = key(d.path());
        let mut m = Many::default();
        let g = m.begin(&k).unwrap();
        assert!(m.begin(&k).is_none()); // 시작 중 중복 add는 무시
        m.remove(&k);
        m.finish(&k, g, Some(started(d.path())));
        assert!(m.active.is_empty() && m.wanted.is_empty());
    }

    #[test]
    fn add_remove_add는_마지막_의도대로() {
        let d = repo();
        let k = key(d.path());
        let mut m = Many::default();
        let g1 = m.begin(&k).unwrap();
        m.remove(&k);
        let g2 = m.begin(&k).unwrap();
        m.finish(&k, g1, Some(started(d.path()))); // 옛 세대는 버림
        assert!(m.active.is_empty());
        m.finish(&k, g2, Some(started(d.path())));
        assert!(m.active.contains_key(&k));
        m.remove(&k);
        assert!(m.active.is_empty());
    }

    #[test]
    fn 시작_실패는_다시_add할_수_있다() {
        let k = PathBuf::from("/x");
        let mut m = Many::default();
        let g = m.begin(&k).unwrap();
        m.finish(&k, g, None);
        assert!(m.begin(&k).is_some());
    }

    #[test]
    fn linked_worktree의_git_디렉터리를_푼다() {
        let run = |d: &Path, a: &[&str]| assert!(std::process::Command::new("git").current_dir(d).args(a).status().unwrap().success());
        let main = tempfile::tempdir().unwrap();
        let (m, wt) = (main.path(), main.path().join("wt"));
        run(m, &["init", "-q", "-b", "main"]);
        run(m, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i"]);
        run(m, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "b"]);
        assert!(wt.join(".git").is_file());
        let dirs = linked_git_dirs(&wt);
        assert_eq!(dirs.len(), 2);
        assert!(dirs[0].ends_with("worktrees/wt") && dirs[1].ends_with(".git"));
        assert!(linked_git_dirs(m).is_empty(), "일반 저장소는 .git 폴더라 추가 감시 없음");
        // 불신: HEAD 없는 디렉터리·엉뚱한 내용은 무시
        let evil = tempfile::tempdir().unwrap();
        std::fs::write(evil.path().join(".git"), "gitdir: /\n").unwrap();
        assert!(linked_git_dirs(evil.path()).is_empty());
        // 감시도 시작되고 커밋이 refs 변경으로 온다
        let (tx, rx) = std::sync::mpsc::channel();
        let _w = RepoWatcher::start(&wt, move |c| drop(tx.send(c))).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        while rx.try_recv().is_ok() {}
        run(&wt, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]);
        let c = rx.recv_timeout(Duration::from_secs(5)).expect("linked worktree 커밋이 감지돼야 함");
        assert!(c.refs);
    }

    #[test]
    fn 경로_검증() {
        let d = repo();
        assert!(check_repo(d.path()).is_ok());
        let plain = tempfile::tempdir().unwrap();
        assert!(check_repo(plain.path()).is_err());
        assert!(check_repo(&d.path().join("nope")).is_err());
        assert!(check_repo(&d.path().join(".git")).is_err());
        assert!(check_repo(Path::new("/")).is_err());
        if let Ok(h) = gc_core::home_dir() {
            assert!(check_repo(&h).is_err());
        }
        // .git이 파일인 작업 트리(worktree·submodule)도 허용
        let f = tempfile::tempdir().unwrap();
        std::fs::write(f.path().join(".git"), "gitdir: x").unwrap();
        assert!(check_repo(f.path()).is_ok());
    }
}
