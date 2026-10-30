//! 저장소 통계: `git log --no-merges` 한 번을 줄 단위로 파싱해 작성자·주별·요일×시간을 집계한다.
//! 추적 파일 수·확장자는 `ls-files`, 저장소 크기는 `count-objects -v`.
//! 줄 수(`--numstat`)는 큰 저장소에서 느려서 `with_lines`일 때만 계산한다.

#[cfg(feature = "cli")]
use std::collections::HashMap;
#[cfg(feature = "cli")]
use std::path::Path;

use serde::{Deserialize, Serialize};

#[cfg(feature = "cli")]
use tokio::sync::mpsc;

#[cfg(feature = "cli")]
use crate::{Error, GitRunner, JobEvent, JobHandle, Result};

#[cfg(feature = "cli")]
mod calendar;
#[cfg(feature = "cli")]
mod log_parser;

#[cfg(feature = "cli")]
use log_parser::LogParser;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
pub enum StatsRange {
    #[serde(rename = "all")]
    All,
    #[serde(rename = "year")]
    Year,
    #[serde(rename = "90d")]
    Days90,
    #[serde(rename = "30d")]
    Days30,
}

impl StatsRange {
    #[cfg(feature = "cli")]
    fn days(self) -> Option<i64> {
        match self {
            Self::All => None,
            Self::Year => Some(365),
            Self::Days90 => Some(90),
            Self::Days30 => Some(30),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub commits: u64,
    pub authors: u64,
    /// 기간 안 첫·마지막 커밋 시각(unix 초)
    pub first: Option<i64>,
    pub last: Option<i64>,
    /// 로컬 / 원격 브랜치, 태그 (기간과 무관)
    pub branches: u64,
    pub remote_branches: u64,
    pub tags: u64,
    /// 추적 파일 수 (`ls-files`)
    pub files: u64,
    /// `count-objects -v`의 size + size-pack (KiB)
    pub size_kb: u64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthorStat {
    pub name: String,
    pub email: String,
    pub commits: u64,
    /// `with_lines`가 아니면 0
    pub added: u64,
    pub deleted: u64,
    pub first: i64,
    pub last: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WeekCount {
    /// 그 주 월요일 (작성자 로컬 날짜, `YYYY-MM-DD`)
    pub start: String,
    pub commits: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ExtCount {
    /// 소문자 확장자(점 제외). 없으면 빈 문자열
    pub ext: String,
    pub count: u64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub with_lines: bool,
    pub summary: Summary,
    /// 커밋 수 내림차순
    pub authors: Vec<AuthorStat>,
    /// 오래된 주부터, 빈 주는 0으로 채움. 최근 `MAX_WEEKS`주까지만
    pub weeks: Vec<WeekCount>,
    /// `[요일 월=0..일=6][시 0..23]`
    pub heatmap: Vec<Vec<u64>>,
    /// 파일 수 내림차순 (상위 `MAX_EXT`)
    pub extensions: Vec<ExtCount>,
}

#[cfg(feature = "cli")]
pub const MAX_WEEKS: usize = 104;
#[cfg(feature = "cli")]
const MAX_EXT: usize = 30;

#[cfg(feature = "cli")]
/// `on_start`는 로그 프로세스를 띄운 직후 취소 핸들과 함께 불린다 (호출 측이 보관했다가 `cancel()`).
/// 취소되면 `Error::Cancelled`. 빈 저장소(ref 없음)는 빈 통계, 그 밖의 git 오류는 그대로 돌려준다.
///
/// 기간은 **작성자 날짜** 기준이다. `--since`는 커미터 날짜로 걸러서 대략의 컷으로만 쓰고, 집계 때 작성자 날짜로 다시 거른다.
pub async fn repo_stats(
    git: &GitRunner,
    repo: &Path,
    range: StatsRange,
    branch: Option<&str>,
    with_lines: bool,
    on_start: impl FnOnce(JobHandle),
) -> Result<Stats> {
    if branch.is_some_and(|b| b.starts_with('-')) {
        return Err(gc_i18n::coded!("stats.badBranch", "invalid branch name").into());
    }
    let cutoff = range.days().map(|d| now() - d * 86400);
    let since = cutoff.map(|c| format!("--since=@{}", c - 86400)); // 커미터/작성자 날짜 차이 여유 1일
    let mut args = vec!["log", "--no-show-signature", "--no-merges", "--date=iso", "--format=%x1e%aN%x1f%aE%x1f%at%x1f%ai"];
    if with_lines {
        args.push("--numstat");
    }
    if let Some(s) = &since {
        args.push(s);
    }
    match branch {
        // stash(refs/stash)는 --all에만 들어가므로 빼고 브랜치·원격·태그만 본다
        None => args.extend(["--branches", "--remotes", "--tags"]),
        Some(b) => args.extend(["--end-of-options", b]),
    }
    let (tx, mut rx) = mpsc::unbounded_channel();
    let (handle, task) = git.spawn(repo, &args, tx)?;
    on_start(handle);
    let stream = async {
        let mut parser = LogParser::new(with_lines, cutoff);
        while let Some(ev) = rx.recv().await {
            if let JobEvent::Stdout { line } = ev {
                parser.feed(&line);
            }
        }
        task.await.map_err(|e| Error::Spawn(std::io::Error::other(e)))??;
        Ok(parser.finish())
    };
    // 하나라도 실패(취소 포함)하면 나머지는 drop되어 프로세스가 정리된다.
    let (mut stats, files, refs, size) = tokio::try_join!(
        stream,
        git.output(repo, &["ls-files", "-z"]),
        git.output(repo, &["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"]),
        git.output(repo, &["count-objects", "-v"]),
    )?;
    let (paths, extensions) = parse_files(&String::from_utf8_lossy(&files));
    stats.summary.files = paths;
    stats.extensions = extensions;
    for r in String::from_utf8_lossy(&refs).lines() {
        if r.starts_with("refs/heads/") {
            stats.summary.branches += 1;
        } else if r.starts_with("refs/tags/") {
            stats.summary.tags += 1;
        } else if r.starts_with("refs/remotes/") && !r.ends_with("/HEAD") {
            stats.summary.remote_branches += 1;
        }
    }
    let size = String::from_utf8_lossy(&size);
    stats.summary.size_kb = parse_size(&size);
    // Windows git는 느슨한 객체 size를 0으로 센다 — 개수는 있는데 size가 0이면 파일 크기를 직접 합산한다.
    if loose_size_missing(&size) {
        let dir = git.output(repo, &["rev-parse", "--path-format=absolute", "--git-path", "objects"]).await?;
        let dir = std::path::PathBuf::from(String::from_utf8_lossy(&dir).trim());
        let kb = tokio::task::spawn_blocking(move || loose_objects_kb(&dir))
            .await
            .map_err(|e| Error::Spawn(std::io::Error::other(e)))?;
        stats.summary.size_kb += kb;
    }
    Ok(stats)
}

#[cfg(feature = "cli")]
fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

#[cfg(feature = "cli")]
/// `size`(느슨한 객체) + `size-pack` (KiB)
fn parse_size(text: &str) -> u64 {
    text.lines()
        .filter_map(|l| l.split_once(": "))
        .filter(|(k, _)| *k == "size" || *k == "size-pack")
        .filter_map(|(_, v)| v.trim().parse::<u64>().ok())
        .sum()
}

#[cfg(feature = "cli")]
fn count_field(text: &str, key: &str) -> u64 {
    text.lines()
        .filter_map(|l| l.split_once(": "))
        .find(|(k, _)| *k == key)
        .and_then(|(_, v)| v.trim().parse().ok())
        .unwrap_or(0)
}

#[cfg(feature = "cli")]
/// 느슨한 객체가 있는데(`count`) 크기(`size`)가 0
fn loose_size_missing(text: &str) -> bool {
    count_field(text, "count") > 0 && count_field(text, "size") == 0
}

#[cfg(feature = "cli")]
/// `objects/??/*` 파일 크기 합 (KiB, 올림). 공통 git dir의 objects 경로를 받는다.
fn loose_objects_kb(objects: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(objects) else { return 0 };
    let mut bytes = 0u64;
    for d in rd.flatten() {
        let n = d.file_name();
        let n = n.to_string_lossy();
        if n.len() != 2 || !n.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let Ok(files) = std::fs::read_dir(d.path()) else { continue };
        bytes += files.flatten().filter_map(|f| f.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum::<u64>();
    }
    bytes.div_ceil(1024)
}

#[cfg(feature = "cli")]
fn parse_files(text: &str) -> (u64, Vec<ExtCount>) {
    let mut total = 0;
    let mut map: HashMap<String, u64> = HashMap::new();
    for p in text.split('\0').filter(|p| !p.is_empty()) {
        total += 1;
        let base = p.rsplit('/').next().unwrap_or(p);
        // 점으로 시작하는 파일(.gitignore)은 확장자 없음으로 본다.
        let ext = match base.rfind('.') {
            Some(i) if i > 0 => base[i + 1..].to_lowercase(),
            _ => String::new(),
        };
        *map.entry(ext).or_default() += 1;
    }
    let mut v: Vec<ExtCount> = map.into_iter().map(|(ext, count)| ExtCount { ext, count }).collect();
    v.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.ext.cmp(&b.ext)));
    v.truncate(MAX_EXT);
    (total, v)
}

#[cfg(all(test, feature = "cli"))]
mod tests {
    use super::*;

    #[test]
    fn extensions_and_size() {
        let (n, ext) = parse_files("a.RS\0src/b.rs\0c.rs\0.gitignore\0Makefile\0x/y.md\0");
        assert_eq!(n, 6);
        assert_eq!(ext[0], ExtCount { ext: "rs".into(), count: 3 });
        assert_eq!(ext.iter().find(|e| e.ext.is_empty()).unwrap().count, 2);
        assert!(loose_size_missing("count: 3\nsize: 0\nsize-pack: 0\n"));
        assert!(!loose_size_missing("count: 3\nsize: 12\n") && !loose_size_missing("count: 0\nsize: 0\n"));
        assert_eq!(parse_size("count: 1\nsize: 4\nsize-pack: 10\nprune-packable: 0\n"), 14);
    }

    /// 핸들을 drop하면 취소로 처리되므로(watch 송신단 닫힘) 테스트에서는 그냥 둔다
    fn keep(h: JobHandle) {
        std::mem::forget(h);
    }

    fn git(dir: &Path, args: &[&str], name: &str, date: &str) {
        let ok = std::process::Command::new("git")
            .current_dir(dir)
            .args(["-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"])
            .args(args)
            .env("GIT_AUTHOR_NAME", name)
            .env("GIT_AUTHOR_EMAIL", format!("{name}@t"))
            .env("GIT_COMMITTER_NAME", name)
            .env("GIT_COMMITTER_EMAIL", format!("{name}@t"))
            .env("GIT_AUTHOR_DATE", date)
            .env("GIT_COMMITTER_DATE", date)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }

    fn commit(dir: &Path, file: &str, body: &str, name: &str, date: &str) {
        std::fs::write(dir.join(file), body).unwrap();
        git(dir, &["add", file], name, date);
        git(dir, &["commit", "-q", "-m", file], name, date);
    }

    #[tokio::test]
    async fn aggregates_temp_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        git(d, &["init", "-q"], "x", "2024-01-01T00:00:00+0000");
        commit(d, "a.rs", "1\n2\n3\n", "alice", "2024-05-06T14:00:00+0900"); // 월 14시
        commit(d, "b.md", "x\n", "bob", "2024-05-12T23:30:00-0500"); // 일 23시 (같은 주, 로컬 기준)
        commit(d, "c.rs", "y\n", "alice", "2024-05-27T09:00:00+0900"); // 3주 뒤 월 9시
        git(d, &["tag", "v1"], "x", "2024-05-27T09:00:00+0900");
        git(d, &["branch", "dev"], "x", "2024-05-27T09:00:00+0900");

        let git_runner = GitRunner::default();
        let s = repo_stats(&git_runner, d, StatsRange::All, None, true, keep).await.unwrap();
        assert_eq!((s.summary.commits, s.summary.authors), (3, 2));
        assert_eq!((s.summary.branches, s.summary.tags, s.summary.files), (2, 1, 3));
        assert!(s.summary.size_kb > 0);
        assert_eq!((s.authors[0].name.as_str(), s.authors[0].commits, s.authors[0].added), ("alice", 2, 4));
        assert_eq!(s.authors[1].name, "bob");
        assert_eq!(s.heatmap[0][14], 1);
        assert_eq!(s.heatmap[6][23], 1);
        assert_eq!(s.heatmap[0][9], 1);
        let weeks: Vec<_> = s.weeks.iter().map(|w| (w.start.as_str(), w.commits)).collect();
        assert_eq!(weeks, [("2024-05-06", 2), ("2024-05-13", 0), ("2024-05-20", 0), ("2024-05-27", 1)]);
        assert_eq!(s.extensions[0], ExtCount { ext: "rs".into(), count: 2 });

        // 기간 제한: 2024년 커밋은 모두 밖
        let s = repo_stats(&git_runner, d, StatsRange::Days30, None, false, keep).await.unwrap();
        assert_eq!(s.summary.commits, 0);
        assert!(!s.with_lines && s.summary.first.is_none());
        // 브랜치 지정, 줄 수 제외
        let s = repo_stats(&git_runner, d, StatsRange::All, Some("dev"), false, keep).await.unwrap();
        assert_eq!((s.summary.commits, s.authors[0].added), (3, 0));
        assert!(repo_stats(&git_runner, d, StatsRange::All, Some("--x"), false, keep).await.is_err());
        // 존재하지 않는 브랜치는 빈 통계가 아니라 오류
        assert!(repo_stats(&git_runner, d, StatsRange::All, Some("nope"), false, keep).await.is_err());

        // stash는 통계에 들어가지 않는다
        std::fs::write(d.join("a.rs"), "changed\n").unwrap();
        git(d, &["stash", "-q"], "carol", "2024-06-01T10:00:00+0000");
        let s = repo_stats(&git_runner, d, StatsRange::All, None, false, keep).await.unwrap();
        assert_eq!(s.summary.commits, 3);
        assert!(s.authors.iter().all(|a| a.name != "carol"));

        // 기간은 작성자 날짜 기준: 작성자 날짜는 오래됐지만 커미터 날짜가 지금인 커밋은 제외
        std::fs::write(d.join("d.txt"), "d\n").unwrap();
        git(d, &["add", "d.txt"], "dave", "2024-01-01T00:00:00+0000");
        let ok = std::process::Command::new("git")
            .current_dir(d)
            .args(["commit", "-q", "-m", "d"])
            .env("GIT_AUTHOR_NAME", "dave")
            .env("GIT_AUTHOR_EMAIL", "dave@t")
            .env("GIT_AUTHOR_DATE", "2024-01-01T00:00:00+0000")
            .env("GIT_COMMITTER_NAME", "dave")
            .env("GIT_COMMITTER_EMAIL", "dave@t")
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let s = repo_stats(&git_runner, d, StatsRange::Days30, None, false, keep).await.unwrap();
        assert_eq!(s.summary.commits, 0);
        let s = repo_stats(&git_runner, d, StatsRange::All, None, false, keep).await.unwrap();
        assert_eq!(s.summary.commits, 4);
    }

    #[tokio::test]
    async fn empty_repo_is_empty_stats_and_non_repo_is_error() {
        let tmp = tempfile::tempdir().unwrap();
        let git_runner = GitRunner::default();
        git(tmp.path(), &["init", "-q"], "x", "2024-01-01T00:00:00+0000");
        let s = repo_stats(&git_runner, tmp.path(), StatsRange::All, None, true, keep).await.unwrap();
        assert_eq!((s.summary.commits, s.summary.files), (0, 0));
        // 저장소가 아니면 오류 (빈 통계로 가리지 않는다)
        let other = tempfile::tempdir().unwrap();
        let r = repo_stats(&git_runner, other.path(), StatsRange::All, None, false, keep).await;
        assert!(matches!(r, Err(Error::Exit { .. })), "{r:?}");
    }

    /// 취소하면 로그 프로세스(와 손자)를 죽이고 바로 Cancelled로 끝난다.
    #[cfg(unix)]
    #[tokio::test]
    async fn cancel_kills_the_log_process() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("slowgit");
        std::fs::write(&script, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let runner = GitRunner::new(&script);
        let slot: std::sync::Arc<std::sync::Mutex<Option<JobHandle>>> = Default::default();
        let s2 = slot.clone();
        let repo = tmp.path().to_path_buf();
        let task = tokio::spawn(async move {
            repo_stats(&runner, &repo, StatsRange::All, None, false, move |h| *s2.lock().unwrap() = Some(h)).await
        });
        let started = std::time::Instant::now();
        while slot.lock().unwrap().is_none() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        slot.lock().unwrap().take().unwrap().cancel();
        let r = tokio::time::timeout(std::time::Duration::from_secs(5), task).await.expect("취소 후 바로 끝나야 한다").unwrap();
        assert!(matches!(r, Err(Error::Cancelled)), "{r:?}");
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }
}
