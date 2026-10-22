//! 저장소 통계 계산과 취소. 같은 저장소의 새 요청은 이전 계산을 취소한다.

use std::collections::HashMap;
use std::path::PathBuf;

use gc_core::{GitRunner, JobHandle};
use parking_lot::Mutex;

use crate::util::{err, Res};

/// 진행 중인 통계 계산 (저장소 → (token, 핸들))
#[derive(Default)]
pub(crate) struct StatsTasks(pub(crate) Mutex<HashMap<String, (String, JobHandle)>>);

impl StatsTasks {
    /// `token`은 취소용 요청 번호(UI가 만든다): `cancel(token)`이나 같은 저장소의 새 요청이 이전 계산을 kill한다.
    pub async fn run(&self, git: &GitRunner, repo: PathBuf, range: gc_core::StatsRange, branch: Option<String>, with_lines: bool, token: String) -> Res<gc_core::Stats> {
        let key = repo.to_string_lossy().into_owned();
        let (t, k) = (token.clone(), key.clone());
        let result = gc_core::repo_stats(git, &repo, range, branch.as_deref(), with_lines, |h| {
            if let Some((_, old)) = self.0.lock().insert(k, (t, h)) {
                old.cancel();
            }
        })
        .await;
        // 내 항목만 지운다 (새 요청이 이미 덮어썼으면 그대로 둔다)
        let mut map = self.0.lock();
        if map.get(&key).is_some_and(|(t, _)| *t == token) {
            map.remove(&key);
        }
        result.map_err(err)
    }

    pub fn cancel(&self, token: &str) {
        self.0.lock().retain(|_, (t, h)| {
            let hit = t == token;
            if hit {
                h.cancel();
            }
            !hit
        });
    }

    pub fn kill_all(&self) {
        for (_, (_, h)) in self.0.lock().drain() {
            h.kill_now();
        }
    }
}
