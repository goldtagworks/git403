//! 커밋 그래프 화면 데이터: 로그 읽기 + 레인 레이아웃.

use std::path::Path;

use gc_core::GitRunner;
use serde::Serialize;

use crate::util::{err, Res};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphView {
    commits: Vec<gc_core::Commit>,
    layout: gc_graph::Layout,
}

pub(crate) async fn load_graph(git: &GitRunner, repo: &Path, limit: usize, hidden: &[String]) -> Res<GraphView> {
    let (commits, head) = tokio::join!(gc_core::read_log(git, repo, limit, hidden), gc_core::head_commit(git, repo));
    let commits = commits.map_err(err)?;
    // 현재 브랜치(HEAD)를 맨 왼쪽 레인에
    let layout = gc_graph::layout_with_head(commits.iter().map(|c| gc_graph::Node { id: &c.id, parents: &c.parents }), head.as_deref());
    Ok(GraphView { commits, layout })
}
