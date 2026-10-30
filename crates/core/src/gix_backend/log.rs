//! `read_log`·`head_commit`·`commit_message`·`committer`·`last_message`: 커밋 조회 (CLI의 `log.rs`·`stage.rs` 쪽과 같은 결과).

use std::path::Path;

use gix::bstr::ByteSlice;
use gix::traverse::commit::topo;

use super::common::{fail, glob, hex, open, subject_body};
use crate::{Commit, Result};

const BODY_MAX: usize = 200;

pub(super) fn head_commit(repo: &Path) -> Option<String> {
    let r = open(repo).ok()?;
    r.head_id().ok().map(hex)
}

/// 커밋 하나를 `Commit`으로 (CLI 파서와 같은 가공: 본문은 공백을 한 칸으로 합쳐 200자).
pub(super) fn to_commit(c: &gix::Commit<'_>) -> Result<Commit> {
    let d = c.decode().map_err(fail)?;
    let a = d.author().map_err(fail)?;
    let (subject, body) = subject_body(d.message);
    Ok(Commit {
        id: hex(c.id),
        parents: d.parents().map(hex).collect(),
        author: a.name.to_str_lossy().into_owned(),
        email: a.email.to_str_lossy().into_owned(),
        time: a.time().map(|t| t.seconds).unwrap_or(0),
        subject,
        body: body.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(BODY_MAX).collect(),
    })
}

/// `git log --all --date-order [--exclude=…] [--ignore-missing 포함 ref…]` 의 시작점들.
/// `hidden`: `refs/…`(글롭 가능)는 `--all`에서 제외, `!refs/…`는 예외로 다시 포함(끝이 `/*`면 글롭). HEAD는 늘 포함.
fn tips(r: &gix::Repository, hidden: &[String]) -> Result<Vec<gix::ObjectId>> {
    let excl: Vec<&str> = hidden.iter().map(String::as_str).filter(|p| p.starts_with("refs/")).collect();
    let incl: Vec<&str> = hidden.iter().filter_map(|p| p.strip_prefix('!')).filter(|p| p.starts_with("refs/") && !p.starts_with("refs/-")).collect();
    let mut out: Vec<gix::ObjectId> = Vec::new();
    let mut push = |r: &gix::Repository, id: gix::ObjectId| {
        // 커밋을 가리키는 ref만 (태그→트리/블롭은 log가 무시한다)
        if let Ok(obj) = r.find_object(id) {
            if let Ok(c) = obj.peel_to_commit() {
                out.push(c.id);
            }
        }
    };
    if let Ok(id) = r.head_id() {
        push(r, id.detach());
    }
    let platform = r.references().map_err(fail)?;
    for reference in platform.all().map_err(fail)?.flatten() {
        let name = reference.name().as_bstr().to_owned();
        if !name.starts_with(b"refs/") {
            continue;
        }
        let incl_hit = incl.iter().any(|p| if p.ends_with("/*") { glob(p.as_bytes(), &name) } else { p.as_bytes() == name.as_slice() });
        if !incl_hit && excl.iter().any(|p| glob(p.as_bytes(), &name)) {
            continue;
        }
        let mut reference = reference;
        if let Ok(id) = reference.peel_to_id() {
            push(r, id.detach());
        }
    }
    Ok(out)
}

pub(super) fn read_log(repo: &Path, limit: usize, hidden: &[String]) -> Result<Vec<Commit>> {
    let r = open(repo)?;
    let tips = tips(&r, hidden)?;
    if tips.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let walk = topo::Builder::from_iters(&r.objects, tips, None::<Vec<gix::ObjectId>>).sorting(topo::Sorting::DateOrder).build().map_err(fail)?;
    let mut out = Vec::new();
    for info in walk.take(limit) {
        let info = info.map_err(fail)?;
        out.push(to_commit(&r.find_commit(info.id).map_err(fail)?)?);
    }
    Ok(out)
}

/// 커밋 전체 메시지 (`%B`에서 끝 공백 제거)
pub(super) fn commit_message(repo: &Path, sha: &str) -> Result<String> {
    let r = open(repo)?;
    let id = r.rev_parse_single(sha).map_err(fail)?;
    let c = id.object().map_err(fail)?.peel_to_commit().map_err(fail)?;
    Ok(String::from_utf8_lossy(c.message_raw().map_err(fail)?).trim_end().to_owned())
}

/// 커밋한 사람 (이름, 이메일, 시각)
pub(super) fn committer(repo: &Path, sha: &str) -> Result<(String, String, i64)> {
    let r = open(repo)?;
    let id = r.rev_parse_single(sha).map_err(fail)?;
    let c = id.object().map_err(fail)?.peel_to_commit().map_err(fail)?;
    let d = c.decode().map_err(fail)?;
    let s = d.committer().map_err(fail)?;
    Ok((s.name.to_str_lossy().into_owned(), s.email.to_str_lossy().into_owned(), s.time().map(|t| t.seconds).unwrap_or(0)))
}
