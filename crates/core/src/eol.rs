//! 줄바꿈(CRLF/LF) 처리: `.gitattributes` 규칙 유무, 스테이지된 CRLF 파일 검사, LF로 바꿔 다시 스테이지.

use std::path::Path;

#[cfg(feature = "cli")]
use crate::{path_in_repo, GitRunner, Result};

/// `.gitattributes` 내용에 줄바꿈 규칙(`text`·`-text`·`text=…`·`eol=…`)이 하나라도 있는지.
pub fn has_eol_rule(text: &str) -> bool {
    text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).any(|l| {
        l.split_whitespace().skip(1).any(|t| matches!(t, "text" | "-text" | "!text") || t.starts_with("text=") || t.starts_with("eol="))
    })
}

/// 저장소 루트 `.gitattributes`에 줄바꿈 규칙이 있는지 (파일이 없으면 false).
pub fn root_has_eol_rule(repo: &Path) -> bool {
    std::fs::read(repo.join(".gitattributes")).is_ok_and(|b| has_eol_rule(&String::from_utf8_lossy(&b)))
}

#[cfg(feature = "cli")]
/// `git ls-files --eol -z` 출력에서 **인덱스에 CRLF가 든 텍스트 파일**만 고른다(`i/crlf`·`i/mixed`).
/// 저장소가 `eol=crlf`를 명시한 파일은 제외한다. 바이너리(`i/-text`)는 애초에 해당 없음.
pub fn parse_crlf(out: &str) -> Vec<String> {
    out.split('\0')
        .filter_map(|e| e.split_once('\t'))
        .filter(|(info, _)| {
            let t: Vec<&str> = info.split_whitespace().collect();
            t.iter().any(|x| matches!(*x, "i/crlf" | "i/mixed")) && !t.contains(&"eol=crlf")
        })
        .map(|(_, p)| p.to_owned())
        .collect()
}

#[cfg(feature = "cli")]
/// 스테이지된(추가·수정) 파일 중 인덱스 내용에 CRLF가 든 것. `core.autocrlf`가 이미 LF로 정규화해 넣었으면 나오지 않는다.
pub async fn staged_crlf(git: &GitRunner, repo: &Path) -> Result<Vec<String>> {
    let names = git.query(repo, &["diff", "--cached", "--name-only", "-z", "--diff-filter=AM"]).await?;
    let names = String::from_utf8_lossy(&names);
    let paths: Vec<&str> = names.split('\0').filter(|p| !p.is_empty()).collect();
    if paths.is_empty() {
        return Ok(vec![]);
    }
    let mut a = vec!["--literal-pathspecs", "ls-files", "--eol", "-z", "--"];
    a.extend(paths);
    Ok(parse_crlf(&String::from_utf8_lossy(&git.query(repo, &a).await?)))
}

#[cfg(feature = "cli")]
/// 스테이지된 내용을 LF로 바꿔 인덱스에 다시 넣는다. 작업 파일은 **인덱스 내용과 같을 때만**(= 부분 스테이지가 아닐 때) LF로 바꾼다
/// (그래야 변경 목록에 CR 차이만 남지 않고, 스테이지 안 한 수정은 건드리지 않는다).
pub async fn fix_crlf(git: &GitRunner, repo: &Path, paths: &[String]) -> Result<()> {
    let mut a = vec!["--literal-pathspecs", "ls-files", "-s", "-z", "--"];
    a.extend(paths.iter().map(String::as_str));
    let listing = git.query(repo, &a).await?;
    let mut info = Vec::new();
    for e in String::from_utf8_lossy(&listing).split('\0') {
        let Some((meta, path)) = e.split_once('\t') else { continue };
        let mode = meta.split(' ').next().unwrap_or("");
        if !matches!(mode, "100644" | "100755") {
            continue;
        }
        let old = git.output(repo, &["cat-file", "blob", &format!(":{path}")]).await?;
        let new = lf(&old);
        if new == old {
            continue;
        }
        let sha = String::from_utf8_lossy(&git.output_stdin(repo, &["hash-object", "-w", "--stdin"], &new).await?).trim().to_owned();
        info.extend(format!("{mode} {sha} 0\t{path}\0").bytes());
        let wt = path_in_repo(repo, path)?;
        if std::fs::read(&wt).is_ok_and(|w| w == old) {
            std::fs::write(&wt, &new)?;
        }
    }
    if !info.is_empty() {
        git.output_stdin(repo, &["update-index", "-z", "--index-info"], &info).await?;
    }
    Ok(())
}

#[cfg(feature = "cli")]
fn lf(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(b.len());
    for (i, &c) in b.iter().enumerate() {
        if !(c == b'\r' && b.get(i + 1) == Some(&b'\n')) {
            out.push(c);
        }
    }
    out
}

#[cfg(all(test, feature = "cli"))]
mod tests {
    use super::*;

    #[test]
    fn detects_eol_rules() {
        assert!(!has_eol_rule(""));
        assert!(!has_eol_rule("# * text=auto\n*.png binary\n*.rs diff=rust\n"));
        assert!(has_eol_rule("* text=auto eol=lf\n"));
        assert!(has_eol_rule("*.sh eol=lf\n"));
        assert!(has_eol_rule("*.bat text\n"));
        assert!(has_eol_rule("*.bin -text\n"));
    }

    #[test]
    fn parses_crlf_entries() {
        let out = "i/crlf  w/crlf  attr/                \ta.txt\0i/lf    w/lf    attr/text eol=lf     \tb.txt\0\
                   i/mixed w/mixed attr/                \tc d.txt\0i/crlf  w/crlf  attr/text eol=crlf   \twin.bat\0i/-text w/-text attr/                \tbin\0";
        assert_eq!(parse_crlf(out), ["a.txt", "c d.txt"]);
    }

    #[test]
    fn converts_only_crlf() {
        assert_eq!(lf(b"a\r\nb\rc\n\r\n"), b"a\nb\rc\n\n");
    }
}
