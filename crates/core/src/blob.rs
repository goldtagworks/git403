//! 파일 한 개의 바이트를 rev별로 읽는다 (이미지 diff용). `git cat-file`·작업 트리 직접 읽기.
use crate::{canonical_in_repo, path_in_repo, Error, GitRunner, Result};
use std::path::Path;

/// 읽을 수 있는 파일 크기 상한 (20MB)
pub const BLOB_LIMIT: u64 = 20 * 1024 * 1024;

fn too_big(size: u64) -> Error {
    let mb = size / (1024 * 1024);
    let limit = BLOB_LIMIT / (1024 * 1024);
    gc_i18n::coded!("blob.tooLarge", "File is too large to preview ({mb} MB, limit {limit} MB)", mb = mb, limit = limit).into()
}

/// 허용하는 rev: `HEAD`, 16진 sha(4~64자), 그 뒤 선택적 `^` (`HEAD^`·`<sha>^`). 이름 있는 ref·`HEAD:경로` 같은 식은 거부한다.
pub(crate) fn valid_rev(r: &str) -> bool {
    let r = r.strip_suffix('^').unwrap_or(r);
    r == "HEAD" || ((4..=64).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// rev: 커밋 sha(또는 `<sha>^`), `":"`(인덱스), `None`·`"WORKTREE"`(작업 트리 파일).
/// 그쪽에 파일이 없으면(루트 커밋의 부모·새 파일·삭제 파일) `None`. 상한 초과·저장소 밖 경로는 오류.
pub async fn file_blob(git: &GitRunner, repo: &Path, rev: Option<&str>, path: &str) -> Result<Option<Vec<u8>>> {
    path_in_repo(repo, path)?;
    let spec = match rev {
        None | Some("WORKTREE") => return read_worktree(repo, path).await,
        Some(":") => format!(":0:{path}"),
        Some(r) if !valid_rev(r) => return Err(gc_i18n::coded!("blob.badRev", "invalid revision: {rev}", rev = r).into()),
        Some(r) => format!("{r}:{path}"),
    };
    let size = match git.query(repo, &["cat-file", "-s", &spec]).await {
        Ok(o) => String::from_utf8_lossy(&o).trim().parse::<u64>().map_err(|e| Error::Parse(e.to_string()))?,
        Err(Error::Exit { .. }) => return Ok(None),
        Err(e) => return Err(e),
    };
    if size > BLOB_LIMIT {
        return Err(too_big(size));
    }
    git.query(repo, &["cat-file", "blob", &spec]).await.map(Some)
}

async fn read_worktree(repo: &Path, path: &str) -> Result<Option<Vec<u8>>> {
    let (repo, path) = (repo.to_path_buf(), path.to_string());
    tokio::task::spawn_blocking(move || read_worktree_sync(&repo, &path)).await.map_err(|e| Error::Parse(e.to_string()))?
}

/// 작업 트리 파일 바이트(동기). 없으면 `None`. gix 백엔드도 쓴다.
pub(crate) fn read_worktree_sync(repo: &Path, path: &str) -> Result<Option<Vec<u8>>> {
    if std::fs::symlink_metadata(path_in_repo(repo, path)?).is_err() {
        return Ok(None);
    }
    let full = repo.join(canonical_in_repo(repo, path)?);
    let size = std::fs::metadata(&full)?.len();
    if size > BLOB_LIMIT {
        return Err(too_big(size));
    }
    Ok(Some(std::fs::read(full)?))
}

/// 표준 base64(패딩 포함)
pub fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() { s.push(T[(n >> (18 - 6 * i) & 63) as usize] as char) } else { s.push('=') }
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(d: &Path, a: &[&str]) -> String {
        let o = Command::new("git").current_dir(d).args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main"]).args(a).output().unwrap();
        assert!(o.status.success(), "{a:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    }

    #[test]
    fn base64_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(&[0, 255, 254, 1]), "AP/+AQ==");
    }

    #[tokio::test]
    async fn reads_each_side() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path();
        git(d, &["init", "-q"]);
        std::fs::write(d.join("a.png"), [1u8, 0, 2]).unwrap();
        git(d, &["add", "."]);
        git(d, &["commit", "-qm", "1"]);
        let first = git(d, &["rev-parse", "HEAD"]);
        std::fs::write(d.join("a.png"), [9u8, 9]).unwrap();
        std::fs::write(d.join("new.png"), [5u8]).unwrap();
        git(d, &["add", "."]);
        git(d, &["commit", "-qm", "2"]);
        let second = git(d, &["rev-parse", "HEAD"]);
        std::fs::write(d.join("a.png"), [7u8]).unwrap();
        git(d, &["add", "a.png"]);
        std::fs::write(d.join("a.png"), [8u8, 8, 8]).unwrap();
        let g = GitRunner::default();
        let get = |rev: Option<&str>, p: &str| {
            let (g, rev, p) = (g.clone(), rev.map(String::from), p.to_string());
            let d = d.to_path_buf();
            async move { file_blob(&g, &d, rev.as_deref(), &p).await }
        };
        assert_eq!(get(Some(&first), "a.png").await.unwrap(), Some(vec![1, 0, 2]));
        assert_eq!(get(Some(&second), "a.png").await.unwrap(), Some(vec![9, 9]));
        assert_eq!(get(Some(&format!("{second}^")), "a.png").await.unwrap(), Some(vec![1, 0, 2]));
        assert_eq!(get(Some(&format!("{second}^")), "new.png").await.unwrap(), None); // 새 파일
        assert_eq!(get(Some(&format!("{first}^")), "a.png").await.unwrap(), None); // 루트 커밋의 부모
        assert_eq!(get(Some(":"), "a.png").await.unwrap(), Some(vec![7]));
        assert_eq!(get(None, "a.png").await.unwrap(), Some(vec![8, 8, 8]));
        assert_eq!(get(Some("WORKTREE"), "a.png").await.unwrap(), Some(vec![8, 8, 8]));
        assert_eq!(get(None, "gone.png").await.unwrap(), None);
        assert_eq!(get(Some(&second), "gone.png").await.unwrap(), None);
        // 경로·rev 거부
        for rev in [None, Some(":"), Some(second.as_str())] {
            assert!(get(rev, "../x").await.is_err());
            assert!(get(rev, "/etc/passwd").await.is_err());
        }
        assert!(get(Some("--output=x"), "a.png").await.is_err());
        for bad in ["HEAD:sub/x", "a b", "main", "origin/main", "HEAD~1", "abc", "", "^", "HEAD^^", "zzzz"] {
            assert!(get(Some(bad), "a.png").await.is_err(), "{bad}");
        }
        assert!(get(Some("HEAD"), "a.png").await.is_ok());
        assert!(get(Some("HEAD^"), "a.png").await.is_ok());
    }

    #[tokio::test]
    async fn rejects_over_limit() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path();
        git(d, &["init", "-q"]);
        let f = std::fs::File::create(d.join("big.bin")).unwrap();
        f.set_len(BLOB_LIMIT + 1).unwrap();
        git(d, &["add", "."]);
        git(d, &["commit", "-qm", "big"]);
        let g = GitRunner::default();
        assert!(file_blob(&g, d, None, "big.bin").await.is_err());
        assert!(file_blob(&g, d, Some("HEAD"), "big.bin").await.is_err());
        assert!(file_blob(&g, d, Some(":"), "big.bin").await.is_err());
        f.set_len(BLOB_LIMIT).unwrap();
        assert_eq!(file_blob(&g, d, None, "big.bin").await.unwrap().unwrap().len() as u64, BLOB_LIMIT);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn worktree_symlink_escape_rejected() {
        let t = tempfile::tempdir().unwrap();
        let (repo, out) = (t.path().join("r"), t.path().join("o"));
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(&out, "secret").unwrap();
        std::os::unix::fs::symlink(&out, repo.join("l")).unwrap();
        assert!(file_blob(&GitRunner::default(), &repo, None, "l").await.is_err());
    }
}
