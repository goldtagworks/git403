//! 충돌 파일의 단계별 내용(`git show :1:/:2:/:3:`)을 바이트로 읽어 검사한다 (AI 충돌 도우미 입력).
use crate::{Error, GitRunner, Result};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictBlobs {
    /// 공통 조상(:1). add/add 충돌이면 없다
    pub base: Option<String>,
    pub ours: String,
    pub theirs: String,
    /// 읽을 때 작업 폴더 파일의 지문. 적용 때 `write_in_repo`가 같은지 본다
    pub fingerprint: String,
}

fn text(path: &str, stage: &str, bytes: Vec<u8>) -> Result<String> {
    if bytes.contains(&0) {
        return Err(gc_i18n::coded!("conflict.binary", "{path}: {stage} contains NUL bytes and looks binary. The AI conflict helper only supports text files", path = path, stage = stage).into());
    }
    String::from_utf8(bytes).map_err(|_| gc_i18n::coded!("conflict.notUtf8", "{path}: {stage} is not valid UTF-8. Aborting instead of converting silently", path = path, stage = stage).into())
}

/// `:2:`·`:3:`가 없으면(한쪽 삭제 충돌) 오류. 비UTF-8·NUL이면 변환하지 않고 거부한다.
pub async fn conflict_blobs(git: &GitRunner, repo: &Path, path: &str) -> Result<ConflictBlobs> {
    let show = |n: u8| {
        let spec = format!(":{n}:{path}");
        async move { git.output(repo, &["show", &spec]).await }
    };
    let (b, o, t) = tokio::join!(show(1), show(2), show(3));
    let (Ok(o), Ok(t)) = (o, t) else {
        return Err(gc_i18n::coded!("conflict.notBothSides", "{path}: not a conflict with both sides present (e.g. deleted on one side). Resolve it with 'use ours' or 'use theirs'", path = path).into());
    };
    let base = b.ok().map(|b| text(path, "base", b)).transpose()?;
    let (ours, theirs) = (text(path, "ours", o)?, text(path, "theirs", t)?);
    let (r, p) = (repo.to_path_buf(), path.to_string());
    let fingerprint = tokio::task::spawn_blocking(move || crate::settings::fingerprint(&r, &p)).await.map_err(|e| Error::Parse(e.to_string()))??;
    Ok(ConflictBlobs { base, ours, theirs, fingerprint })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(d: &Path, a: &[&str]) {
        let s = Command::new("git").current_dir(d).args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main"]).args(a).output().unwrap();
        let _ = s; // merge는 충돌로 실패한다
    }
    fn repo(base: Option<&[u8]>, ours: &[u8], theirs: &[u8]) -> tempfile::TempDir {
        let t = tempfile::tempdir().unwrap();
        let d = t.path();
        git(d, &["init", "-q"]);
        if let Some(b) = base {
            std::fs::write(d.join("f"), b).unwrap();
            git(d, &["add", "f"]);
            git(d, &["commit", "-qm", "base"]);
        } else {
            git(d, &["commit", "-q", "--allow-empty", "-m", "base"]);
        }
        git(d, &["checkout", "-qb", "other"]);
        std::fs::write(d.join("f"), theirs).unwrap();
        git(d, &["add", "f"]);
        git(d, &["commit", "-qm", "theirs"]);
        git(d, &["checkout", "-q", "main"]);
        std::fs::write(d.join("f"), ours).unwrap();
        git(d, &["add", "f"]);
        git(d, &["commit", "-qm", "ours"]);
        git(d, &["merge", "other"]);
        t
    }

    #[tokio::test]
    async fn reads_three_stages_and_fingerprint() {
        let t = repo(Some(b"a\n"), b"ours\n", b"theirs\n");
        let c = conflict_blobs(&GitRunner::default(), t.path(), "f").await.unwrap();
        assert_eq!((c.base.as_deref(), c.ours.as_str(), c.theirs.as_str()), (Some("a\n"), "ours\n", "theirs\n"));
        assert_eq!(c.fingerprint, crate::settings::fingerprint(t.path(), "f").unwrap());
        // 작업 파일이 바뀌면 지문이 달라진다
        std::fs::write(t.path().join("f"), "edited\n").unwrap();
        assert_ne!(c.fingerprint, crate::settings::fingerprint(t.path(), "f").unwrap());
    }

    #[tokio::test]
    async fn add_add_has_no_base() {
        let t = repo(None, b"ours\n", b"theirs\n");
        assert_eq!(conflict_blobs(&GitRunner::default(), t.path(), "f").await.unwrap().base, None);
    }

    #[tokio::test]
    async fn rejects_non_utf8_and_nul_without_converting() {
        for bad in [&b"\xff\xfe bad\n"[..], &b"a\0b\n"[..]] {
            let t = repo(Some(b"a\n"), bad, b"theirs\n");
            let e = conflict_blobs(&GitRunner::default(), t.path(), "f").await.unwrap_err().to_string();
            assert!(e.contains("UTF-8") || e.contains("NUL"), "{e}");
        }
    }
}
