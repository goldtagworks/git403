#[cfg(feature = "cli")]
use std::path::Path;

#[cfg(feature = "cli")]
use crate::{patch, GitRunner, Result};

#[cfg(feature = "cli")]
pub async fn stage(git: &GitRunner, repo: &Path, paths: &[String]) -> Result<()> {
    git.output(repo, &args(&["add", "-A", "--"], paths)).await.map(drop)
}

#[cfg(feature = "cli")]
pub async fn unstage(git: &GitRunner, repo: &Path, paths: &[String]) -> Result<()> {
    // 첫 커밋 전에는 HEAD가 없어서 restore --staged가 실패한다.
    let has_head = git.output(repo, &["rev-parse", "--verify", "-q", "HEAD"]).await.is_ok();
    let base: &[&str] = if has_head { &["restore", "--staged", "--"] } else { &["rm", "--cached", "-q", "--"] };
    git.output(repo, &args(base, paths)).await.map(drop)
}

#[cfg(feature = "cli")]
/// 작업 디렉터리 변경을 버린다. 추적 안 하는 파일은 지운다. 되돌릴 수 없다 — UI가 먼저 확인받는다.
pub async fn discard(git: &GitRunner, repo: &Path, tracked: &[String], untracked: &[String]) -> Result<()> {
    if !tracked.is_empty() {
        git.output(repo, &args(&["restore", "--worktree", "--"], tracked)).await?;
    }
    if !untracked.is_empty() {
        git.output(repo, &args(&["clean", "-f", "-q", "--"], untracked)).await?;
    }
    Ok(())
}

/// diff의 hunk(또는 그 안의 일부 줄)만 스테이지/언스테이지/버리기.
pub enum PatchTarget {
    Stage,
    Unstage,
    Discard,
}

#[cfg(feature = "cli")]
pub async fn apply_partial(
    git: &GitRunner,
    repo: &Path,
    diff: &str,
    hunk: usize,
    lines: Option<&[usize]>,
    target: PatchTarget,
) -> Result<()> {
    let Some(p) = patch::select(&patch::parse(diff), hunk, lines, matches!(target, PatchTarget::Unstage)) else {
        return Ok(());
    };
    let mut a = vec!["apply", "--unidiff-zero", "--whitespace=nowarn"];
    match target {
        PatchTarget::Stage => a.push("--cached"),
        PatchTarget::Unstage => a.extend(["--cached", "--reverse"]),
        PatchTarget::Discard => a.push("--reverse"),
    }
    a.push("-");
    git.output_stdin(repo, &a, p.as_bytes()).await.map(drop)
}

#[cfg(feature = "cli")]
/// 커밋. `message`는 제목+빈 줄+본문.
pub async fn commit(git: &GitRunner, repo: &Path, message: &str, amend: bool) -> Result<()> {
    let mut a = vec!["commit", "-F", "-"];
    if amend {
        a.push("--amend");
    }
    git.output_stdin(repo, &a, message.as_bytes()).await.map(drop)
}

#[cfg(feature = "cli")]
/// 직전 커밋 메시지 (amend할 때 불러온다).
pub async fn last_message(git: &GitRunner, repo: &Path) -> Result<String> {
    let out = git.output(repo, &["log", "--no-show-signature", "-1", "--format=%B"]).await?;
    Ok(String::from_utf8_lossy(&out).trim_end().to_owned())
}

#[cfg(feature = "cli")]
/// 커밋 전체 메시지 (제목+본문, 줄바꿈 그대로). 상세 창용 — 그래프 body는 앞부분만이다.
pub async fn commit_message(git: &GitRunner, repo: &Path, sha: &str) -> Result<String> {
    let out = git.query(repo, &["log", "--no-show-signature", "-1", "--format=%B", sha, "--"]).await?;
    Ok(String::from_utf8_lossy(&out).trim_end().to_owned())
}

#[cfg(feature = "cli")]
/// 커밋의 `Co-authored-by` 트레일러 값 (`이름 <이메일>` 한 줄씩)
pub async fn co_authors(git: &GitRunner, repo: &Path, sha: &str) -> Result<Vec<String>> {
    let out = git.query(repo, &["log", "--no-show-signature", "-1", "--format=%(trailers:key=Co-authored-by,valueonly,unfold)", sha, "--"]).await?;
    Ok(String::from_utf8_lossy(&out).lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect())
}

#[cfg(feature = "cli")]
/// 커밋한 사람 (이름, 이메일, 시각). 상세 창에서 작성자와 다를 때만 보여 준다
pub async fn committer(git: &GitRunner, repo: &Path, sha: &str) -> Result<(String, String, i64)> {
    let out = git.query(repo, &["log", "--no-show-signature", "-1", "--format=%cn%x1f%ce%x1f%ct", sha, "--"]).await?;
    let s = String::from_utf8_lossy(&out);
    let mut f = s.trim_end().split('\x1f');
    let (n, e, t) = (f.next().unwrap_or(""), f.next().unwrap_or(""), f.next().unwrap_or(""));
    Ok((n.to_owned(), e.to_owned(), t.parse().unwrap_or(0)))
}

#[cfg(feature = "cli")]
fn args<'a>(base: &[&'a str], paths: &'a [String]) -> Vec<&'a str> {
    base.iter().copied().chain(paths.iter().map(String::as_str)).collect()
}
