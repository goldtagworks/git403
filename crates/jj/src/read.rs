//! jj 읽기 전용 조회: operation log·북마크 목록. 저장소를 바꾸지 않는다.

use std::collections::BTreeMap;
use std::path::Path;

use gc_i18n::{coded, Coded};
use jj_lib::object_id::ObjectId;
use jj_lib::op_walk;

use crate::{check_root, fail, is_enabled, load};

/// `op_log` 기본·최대 개수
pub const DEFAULT_OP_LIMIT: usize = 50;
pub const MAX_OP_LIMIT: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpLogEntry {
    /// 전체 operation ID(16진수) — `jj_op_restore`에 넘긴다
    pub id: String,
    /// 앞 12자
    pub short: String,
    /// 끝난 시각(Unix epoch 밀리초)
    pub time: i64,
    pub description: String,
    pub user: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkRemote {
    pub remote: String,
    /// 충돌이면 None
    pub sha: Option<String>,
    pub tracked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub name: String,
    /// 로컬 북마크가 가리키는 커밋. 로컬이 없거나 충돌이면 None
    pub target: Option<String>,
    /// 충돌이면 가리키는 커밋 전부(아니면 `target` 하나 또는 빈 목록)
    pub targets: Vec<String>,
    /// 로컬 북마크가 있는가(false = 원격에만 있어 추적 전)
    pub local: bool,
    pub remotes: Vec<BookmarkRemote>,
}

fn open(repo_path: &Path) -> Result<std::sync::Arc<jj_lib::repo::ReadonlyRepo>, Coded> {
    let root = check_root(repo_path)?;
    if !is_enabled(&root) {
        return Err(coded!("jj.notEnabled", "jj is not enabled for this repository"));
    }
    Ok(load(&root)?.1)
}

/// operation log, 최근순(`jj op log`처럼 병합된 operation의 다른 갈래도 시간순으로, 루트 operation은 뺀다). `limit` 기본 50·최대 1000.
pub fn op_log(repo_path: &Path, limit: Option<usize>) -> Result<Vec<OpLogEntry>, Coded> {
    use futures::StreamExt as _;
    let limit = limit.unwrap_or(DEFAULT_OP_LIMIT).clamp(1, MAX_OP_LIMIT);
    let repo = open(repo_path)?;
    pollster::block_on(async {
        let mut out = Vec::new();
        let mut ops = op_walk::walk_ancestors(std::slice::from_ref(repo.operation())).boxed_local();
        while out.len() < limit {
            let Some(op) = ops.next().await else { break };
            let op = op.map_err(|e| fail("op-walk", e))?;
            if op.parent_ids().is_empty() {
                continue;
            }
            let md = op.metadata();
            let id = op.id().hex();
            out.push(OpLogEntry {
                short: id.chars().take(12).collect(),
                id,
                time: md.time.end.timestamp.0,
                description: md.description.clone(),
                user: Some(md.username.clone()).filter(|u| !u.is_empty()),
            });
        }
        Ok(out)
    })
}

/// 로컬 북마크와 그 원격 북마크(`git` 내부 원격 제외). 원격에만 있는 북마크는 `local: false`로 포함(추적 전). 이름순.
pub fn bookmarks(repo_path: &Path) -> Result<Vec<Bookmark>, Coded> {
    let repo = open(repo_path)?;
    let view = repo.view();
    let mut map: BTreeMap<String, Bookmark> = BTreeMap::new();
    let entry = |map: &mut BTreeMap<String, Bookmark>, name: &str| {
        map.entry(name.to_string()).or_insert_with(|| Bookmark { name: name.to_string(), target: None, targets: Vec::new(), local: false, remotes: Vec::new() });
    };
    for (name, target) in view.local_bookmarks() {
        if target.is_absent() {
            continue;
        }
        entry(&mut map, name.as_str());
        let b = map.get_mut(name.as_str()).expect("just inserted");
        b.local = true;
        b.targets = target.present_adds().map(|i| i.hex()).collect();
        b.target = target.as_normal().map(|i| i.hex());
    }
    for (sym, rr) in view.all_remote_bookmarks() {
        if sym.remote.as_str() == "git" || rr.target.is_absent() {
            continue;
        }
        entry(&mut map, sym.name.as_str());
        map.get_mut(sym.name.as_str()).expect("just inserted").remotes.push(BookmarkRemote {
            remote: sym.remote.as_str().to_string(),
            sha: rr.target.as_normal().map(|i| i.hex()),
            tracked: rr.is_tracked(),
        });
    }
    Ok(map.into_values().collect())
}
