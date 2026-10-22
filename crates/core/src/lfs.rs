//! Git LFS 상태: 설치 여부, 추적 패턴(`git lfs track`), 파일(`git lfs ls-files -l`).

use std::path::Path;

use serde::Serialize;

use crate::{GitRunner, Result};

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

/// `git lfs`가 없으면 `installed: false`로 정상 반환한다.
pub async fn lfs_status(git: &GitRunner, repo: &Path) -> Result<Lfs> {
    if git.output(repo, &["lfs", "version"]).await.is_err() {
        return Ok(Lfs::default());
    }
    let tracked = git.output(repo, &["lfs", "track"]).await.unwrap_or_default();
    // 커밋이 없는 저장소에서는 실패하므로 빈 목록으로 본다.
    let files = git.query(repo, &["lfs", "ls-files", "-l"]).await.unwrap_or_default();
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
