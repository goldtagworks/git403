use std::path::Path;

use crate::{canonical_in_repo, Error, Result};

/// 작업 트리 파일을 OS 휴지통으로 옮긴다(디스크 접근 — 호출 측에서 블로킹 스레드로).
/// 경로마다 `canonical_in_repo`로 저장소 밖·링크 탈출·없는 파일을 거부하고, 디렉터리와 `.git` 아래는 거부한다.
/// 전부 검사한 뒤에 옮기므로 검사에 걸리면 아무것도 옮기지 않는다. 심볼릭 링크는 링크 자체를 옮긴다.
pub fn trash_files(repo: &Path, paths: &[String]) -> Result<()> {
    let mut targets = Vec::with_capacity(paths.len());
    for rel in paths {
        let real = canonical_in_repo(repo, rel)?;
        if Path::new(&real).components().next().is_some_and(|c| c.as_os_str() == ".git") {
            return Err(gc_i18n::coded!("trash.insideGit", "cannot trash files inside .git: {path}", path = rel).into());
        }
        let full = repo.join(rel);
        if std::fs::symlink_metadata(&full)?.is_dir() {
            return Err(gc_i18n::coded!("trash.isDirectory", "cannot trash a folder: {path}", path = rel).into());
        }
        targets.push(full);
    }
    for t in targets {
        // Android에는 `trash` 크레이트가 지원하는 휴지통이 없다 (UI는 op `trash_files`가 capabilities에 없어 메뉴를 숨긴다)
        #[cfg(target_os = "android")]
        return Err(Error::Unsupported("trash".into()));
        #[cfg(not(target_os = "android"))]
        trash::delete(&t).map_err(|e| Error::from(gc_i18n::coded!("trash.failed", "could not move to trash: {path} ({reason})", path = t.display(), reason = e)))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(e: Error) -> &'static str {
        e.coded().map(|c| c.code).unwrap_or_default()
    }

    #[test]
    fn rejects_outside_dir_git_and_missing_without_touching_files() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(repo.join("d")).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::write(repo.join("a.txt"), "x").unwrap();
        std::fs::write(repo.join(".git/config"), "x").unwrap();
        std::fs::write(tmp.path().join("out.txt"), "x").unwrap();
        let t = |p: &str| trash_files(&repo, &["a.txt".into(), p.into()]);
        assert_eq!(code(t("d").unwrap_err()), "trash.isDirectory");
        assert_eq!(code(t(".git/config").unwrap_err()), "trash.insideGit");
        assert!(t("../out.txt").is_err());
        assert!(t("nope").is_err());
        assert!(repo.join("a.txt").exists() && tmp.path().join("out.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(tmp.path().join("out.txt"), "x").unwrap();
        std::os::unix::fs::symlink(tmp.path().join("out.txt"), repo.join("l")).unwrap();
        assert!(trash_files(&repo, &["l".into()]).is_err());
        assert!(tmp.path().join("out.txt").exists());
    }

    // 실제 휴지통을 쓴다(macOS·Windows만 — CI Linux는 휴지통이 없을 수 있다)
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn moves_file_to_trash() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("gc403-trash-test.txt"), "x").unwrap();
        trash_files(tmp.path(), &["gc403-trash-test.txt".into()]).unwrap();
        assert!(!tmp.path().join("gc403-trash-test.txt").exists());
    }
}
