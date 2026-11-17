#[cfg(feature = "cli")]
use std::path::Path;

#[cfg(feature = "cli")]
use crate::{patch, GitRunner, Result};

#[cfg(feature = "cli")]
pub async fn stage(git: &GitRunner, repo: &Path, paths: &[String]) -> Result<()> {
    with_paths(git, repo, &["add", "-A"], paths).await
}

#[cfg(feature = "cli")]
pub async fn unstage(git: &GitRunner, repo: &Path, paths: &[String]) -> Result<()> {
    // 첫 커밋 전에는 HEAD가 없어서 restore --staged가 실패한다.
    let has_head = git.output(repo, &["rev-parse", "--verify", "-q", "HEAD"]).await.is_ok();
    let base: &[&str] = if has_head { &["restore", "--staged"] } else { &["rm", "--cached", "-q"] };
    with_paths(git, repo, base, paths).await
}

#[cfg(feature = "cli")]
/// 작업 디렉터리 변경을 버린다. 추적 안 하는 파일은 지운다. 되돌릴 수 없다 — UI가 먼저 확인받는다.
pub async fn discard(git: &GitRunner, repo: &Path, tracked: &[String], untracked: &[String]) -> Result<()> {
    if !tracked.is_empty() {
        with_paths(git, repo, &["restore", "--worktree"], tracked).await?;
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
/// `clean`은 pathspec-from-file이 없어 argv로 넘긴다.
fn args<'a>(base: &[&'a str], paths: &'a [String]) -> Vec<&'a str> {
    base.iter().copied().chain(paths.iter().map(String::as_str)).collect()
}

#[cfg(feature = "cli")]
/// 경로 목록을 argv가 아닌 stdin(NUL 구분)으로 넘긴다 — 파일이 많아도 인자 길이 한도(Windows 32K 등)에 안 걸린다.
/// `--pathspec-from-file`은 git 2.25+ (add·restore·rm). 경로 해석(pathspec 규칙)은 argv와 같다.
async fn with_paths(git: &GitRunner, repo: &Path, base: &[&str], paths: &[String]) -> Result<()> {
    let mut a = base.to_vec();
    a.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
    let input: Vec<u8> = paths.iter().flat_map(|p| p.bytes().chain([0])).collect();
    git.output_stdin(repo, &a, &input).await.map(drop)
}

#[cfg(all(test, feature = "cli"))]
mod tests {
    use super::*;

    fn git(d: &Path, args: &[&str]) -> String {
        let o = std::process::Command::new("git").current_dir(d).args(args).output().unwrap();
        assert!(o.status.success(), "git {args:?}");
        String::from_utf8_lossy(&o.stdout).into_owned()
    }

    #[tokio::test]
    async fn stage_unstage_discard_via_stdin_with_odd_names_and_many_files() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        git(d, &["init", "-q", "-b", "main"]);
        let g = GitRunner::default();
        // 공백·한글·따옴표 이름 + argv 한도(수십 KB)를 넘는 개수
        let mut names: Vec<String> = ["a b.txt", "한글.txt", "q\"uote.txt"].map(String::from).to_vec();
        names.extend((0..1500).map(|i| format!("{}_{i}.txt", "n".repeat(40))));
        for n in &names {
            std::fs::write(d.join(n), "x").unwrap();
        }
        let staged = |d: &Path| git(d, &["-c", "core.quotepath=false", "diff", "--cached", "--name-only"]).lines().count();
        // 첫 커밋 전(rm --cached 경로)
        stage(&g, d, &names).await.unwrap();
        assert_eq!(git(d, &["ls-files"]).lines().count(), names.len());
        unstage(&g, d, &names).await.unwrap();
        assert_eq!(git(d, &["ls-files"]).lines().count(), 0);
        // 커밋 뒤(restore --staged, restore --worktree)
        git(d, &["add", "-A"]);
        git(d, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "i"]);
        for n in &names {
            std::fs::write(d.join(n), "y").unwrap();
        }
        stage(&g, d, &names).await.unwrap();
        assert_eq!(staged(d), names.len());
        unstage(&g, d, &names).await.unwrap();
        assert_eq!(staged(d), 0);
        discard(&g, d, &names, &[]).await.unwrap();
        assert_eq!(std::fs::read_to_string(d.join("a b.txt")).unwrap(), "x");
        assert_eq!(git(d, &["status", "--porcelain"]), "");
    }
}
