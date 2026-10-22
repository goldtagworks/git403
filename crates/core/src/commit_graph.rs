//! `git commit-graph write` — 그래프 로딩이 빨라지도록 commit-graph 파일을 보장한다.
//! 저장소 설정(config)은 건드리지 않고, worktree·서브모듈은 `rev-parse --git-path`가 주는 공통 git dir 기준이다.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use crate::{GitRunner, Result};

/// 이 시간보다 오래된 commit-graph는 다시 쓴다 (`--split`이라 증분이라 가볍다).
const FRESH: Duration = Duration::from_secs(24 * 3600);

/// 같은 저장소에서 쓰기가 겹치지 않게 하는 진행 중 목록.
fn running() -> &'static Mutex<HashSet<PathBuf>> {
    static R: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// commit-graph(단일 파일 또는 split 체인)의 마지막 수정 시각. 없으면 None.
fn graph_mtime(info: &Path) -> Option<SystemTime> {
    ["commit-graph", "commit-graphs/commit-graph-chain"]
        .iter()
        .filter_map(|f| std::fs::metadata(info.join(f)).ok()?.modified().ok())
        .max()
}

fn is_stale(mtime: Option<SystemTime>, now: SystemTime) -> bool {
    mtime.is_none_or(|t| now.duration_since(t).is_ok_and(|age| age > FRESH))
}

/// commit-graph가 없거나 오래됐으면 `commit-graph write --reachable --split --size-multiple=2`로 쓴다.
/// 썼으면 true. 이미 쓰는 중이거나 최신이면 false. `index.lock`을 잡지 않아 다른 작업과 겹쳐도 된다.
/// 호출 측은 실패를 무시하고 로그만 남긴다.
pub async fn ensure_commit_graph(git: &GitRunner, repo: &Path) -> Result<bool> {
    let out = git.query(repo, &["rev-parse", "--git-path", "objects/info"]).await?;
    let info = PathBuf::from(String::from_utf8_lossy(&out).trim());
    let info = if info.is_absolute() { info } else { repo.join(info) };
    if !is_stale(graph_mtime(&info), SystemTime::now()) {
        return Ok(false);
    }
    if !running().lock().unwrap().insert(info.clone()) {
        return Ok(false);
    }
    let res = git.query(repo, &["commit-graph", "write", "--reachable", "--split", "--size-multiple=2"]).await;
    running().lock().unwrap().remove(&info);
    res.map(|_| true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_when_missing_or_old() {
        let now = SystemTime::now();
        assert!(is_stale(None, now));
        assert!(is_stale(Some(now - FRESH - Duration::from_secs(1)), now));
        assert!(!is_stale(Some(now - Duration::from_secs(60)), now));
    }
}
