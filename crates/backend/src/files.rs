//! 저장소·홈 폴더 안 파일 조작. 허용 범위 밖 경로는 거부한다.

use std::path::{Path, PathBuf};

use gc_core::GitBackend;

use crate::util::{blocking, err, Res};

/// 저장소 안 텍스트 파일 끝에 한 줄 덧붙인다 (.gitignore 등). 저장소 밖 경로는 거부한다.
pub(crate) fn append_line(repo: &Path, file: &str, line: &str) -> Res<()> {
    use std::io::{Read, Seek, SeekFrom, Write};
    let path = repo.join(file);
    if file.contains("..") || !path.starts_with(repo) {
        return Err(gc_i18n::coded!("files.outsideRepo", "Path is outside the repository").json());
    }
    // 파일 전체가 아니라 마지막 바이트만 본다(끝이 개행이 아니면 먼저 개행을 붙인다)
    let mut f = std::fs::OpenOptions::new().create(true).read(true).append(true).open(&path).map_err(|e| e.to_string())?;
    let mut last = [b'\n'];
    let has_content = f.seek(SeekFrom::End(-1)).is_ok() && f.read_exact(&mut last).is_ok();
    let sep = if !has_content || last[0] == b'\n' { "" } else { "\n" };
    write!(f, "{sep}{line}\n").map_err(|e| e.to_string())
}

/// 서브모듈 제거 뒤 남는 `.git/modules/<이름>` 삭제. `.git/modules` 아래 경로가 아니면 거부한다.
pub(crate) fn remove_git_dir(repo: &Path, path: &Path) -> Res<()> {
    let full = repo.join(path);
    if !full.exists() {
        return Ok(());
    }
    let full = gc_pathkey::canonical(&full).map_err(|e| e.to_string())?;
    let base = gc_pathkey::canonical(repo.join(".git/modules")).map_err(|e| e.to_string())?;
    if !gc_pathkey::contains_strict(&base, &full) || gc_pathkey::same_strict(&full, &base) {
        return Err(gc_i18n::coded!("files.notSubmoduleDir", "Not a submodule metadata folder").json());
    }
    std::fs::remove_dir_all(full).map_err(|e| e.to_string())
}

/// 홈 폴더와 현재 `git config --global core.excludesfile` 값 (없으면 None)
async fn home_and_excludes(git: &dyn GitBackend) -> Res<(PathBuf, Option<String>)> {
    let home = gc_core::home_dir().map_err(err)?;
    let out = git.run(&home, &["config", "--global", "--get", "core.excludesfile"], &[]).await.ok();
    let configured = out.map(|o| String::from_utf8_lossy(&o).trim().to_string()).filter(|s| !s.is_empty());
    Ok((home, configured))
}

/// 전역 excludesfile 읽기. 허용 경로는 현재 core.excludesfile 값·`~/.gitignore_global`·`~/.config/git/ignore`뿐.
pub(crate) async fn global_ignore_read(git: &dyn GitBackend, path: String) -> Res<String> {
    let (home, cfg) = home_and_excludes(git).await?;
    blocking(move || gc_core::read_text(&gc_core::home_ignore_path(&home, &path, cfg.as_deref())?)).await
}

pub(crate) async fn global_ignore_write(git: &dyn GitBackend, path: String, text: String) -> Res<()> {
    let (home, cfg) = home_and_excludes(git).await?;
    blocking(move || gc_core::write_text(&gc_core::home_ignore_path(&home, &path, cfg.as_deref())?, &text)).await
}

#[cfg(test)]
mod append_tests {
    use super::append_line;

    #[test]
    fn 끝이_개행이_아니면_개행을_먼저_붙인다() {
        let d = std::env::temp_dir().join(format!("gc-append-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join(".gitignore");
        let _ = std::fs::remove_file(&f);
        append_line(&d, ".gitignore", "a").unwrap(); // 새 파일
        append_line(&d, ".gitignore", "b").unwrap(); // 끝이 개행
        std::fs::write(&f, "x\ny").unwrap();
        append_line(&d, ".gitignore", "z").unwrap(); // 끝이 개행 아님
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "x\ny\nz\n");
        std::fs::write(&f, "").unwrap();
        append_line(&d, ".gitignore", "e").unwrap(); // 빈 파일
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "e\n");
        assert!(append_line(&d, "../x", "no").is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
