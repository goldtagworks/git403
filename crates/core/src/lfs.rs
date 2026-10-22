//! Git LFS 상태: 설치 여부, 추적 패턴(`git lfs track`), 파일(`git lfs ls-files -l`).

use std::path::Path;

use serde::Serialize;

use crate::{Error, GitRunner, Result};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LfsFile {
    pub path: String,
    pub oid: String,
    /// `*` 내용 있음, `-` 포인터만
    pub downloaded: bool,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Lfs {
    pub installed: bool,
    pub tracked: Vec<String>,
    pub files: Vec<LfsFile>,
}

/// `git lfs`가 없으면(`'lfs' is not a git command`) `installed: false`로 정상 반환한다.
/// 그 밖의 실패(설치돼 있는데 실행 오류, 추적·파일 목록 실패)는 "LFS 없음·파일 0개"로 숨기지 않고 Err.
pub async fn lfs_status(git: &GitRunner, repo: &Path) -> Result<Lfs> {
    match git.output(repo, &["lfs", "version"]).await {
        Ok(_) => {}
        Err(Error::Exit { stderr, .. }) if stderr.contains("not a git command") => return Ok(Lfs::default()),
        Err(e) => return Err(e),
    }
    let tracked = git.output(repo, &["lfs", "track"]).await?;
    // 커밋이 없는 저장소는 (옛 git-lfs에서) ls-files가 실패하므로 HEAD가 있을 때만 묻는다.
    let has_head = !git.output_allow(repo, &["rev-parse", "--verify", "-q", "HEAD"], &[1]).await?.is_empty();
    let files = if has_head { git.query(repo, &["lfs", "ls-files", "-l"]).await? } else { Vec::new() };
    Ok(Lfs {
        installed: true,
        tracked: parse_track(&String::from_utf8_lossy(&tracked)),
        files: parse_files(&String::from_utf8_lossy(&files)),
    })
}

/// `Listing tracked patterns` 아래의 `    *.bin (.gitattributes)` 줄. `Listing excluded patterns`부터는 무시.
fn parse_track(text: &str) -> Vec<String> {
    text.lines()
        .take_while(|l| !l.starts_with("Listing excluded"))
        .filter(|l| l.starts_with(char::is_whitespace))
        .filter_map(|l| {
            let l = l.trim();
            Some(l.rsplit_once(" (").map_or(l, |(p, _)| p).to_owned()).filter(|p| !p.is_empty())
        })
        .collect()
}

/// `<oid> <*|-> <path>`
fn parse_files(text: &str) -> Vec<LfsFile> {
    text.lines()
        .filter_map(|l| {
            let (oid, rest) = l.split_once(' ')?;
            let (mark, path) = rest.split_once(' ')?;
            Some(LfsFile { path: path.to_owned(), oid: oid.to_owned(), downloaded: mark == "*" })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_track() {
        let t = "Listing tracked patterns\n    *.bin (.gitattributes)\n    a dir/*.psd (sub/.gitattributes)\nListing excluded patterns\n    x (.gitattributes)\n";
        assert_eq!(parse_track(t), vec!["*.bin", "a dir/*.psd"]);
        assert!(parse_track("Listing tracked patterns\nListing excluded patterns\n").is_empty());
    }

    #[test]
    fn parses_files() {
        let f = parse_files("aaaa * big file.bin\nbbbb - x.psd\n");
        assert_eq!(f[0], LfsFile { path: "big file.bin".into(), oid: "aaaa".into(), downloaded: true });
        assert!(!f[1].downloaded);
    }
}
