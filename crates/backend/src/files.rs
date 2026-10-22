//! 저장소·홈 폴더 안 파일 조작. 허용 범위 밖 경로는 거부한다.

use std::path::{Path, PathBuf};

use gc_core::GitRunner;

use crate::util::{blocking, err, Res};

/// 저장소 안 텍스트 파일 끝에 한 줄 덧붙인다 (.gitignore 등). 저장소 밖 경로는 거부한다.
pub(crate) fn append_line(repo: &Path, file: &str, line: &str) -> Res<()> {
    use std::io::Write;
    let path = repo.join(file);
    if file.contains("..") || !path.starts_with(repo) {
        return Err(gc_i18n::coded!("files.outsideRepo", "Path is outside the repository").json());
    }
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
    let sep = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
    write!(f, "{sep}{line}\n").map_err(|e| e.to_string())
}

/// 서브모듈 제거 뒤 남는 `.git/modules/<이름>` 삭제. `.git/modules` 아래 경로가 아니면 거부한다.
pub(crate) fn remove_git_dir(repo: &Path, path: &Path) -> Res<()> {
    let full = repo.join(path);
    if !full.exists() {
        return Ok(());
    }
    let full = full.canonicalize().map_err(|e| e.to_string())?;
    let base = repo.join(".git/modules").canonicalize().map_err(|e| e.to_string())?;
    if !full.starts_with(&base) || full == base {
        return Err(gc_i18n::coded!("files.notSubmoduleDir", "Not a submodule metadata folder").json());
    }
    std::fs::remove_dir_all(full).map_err(|e| e.to_string())
}

/// 홈 폴더와 현재 `git config --global core.excludesfile` 값 (없으면 None)
async fn home_and_excludes(git: &GitRunner) -> Res<(PathBuf, Option<String>)> {
    let home = gc_core::home_dir().map_err(err)?;
    let out = git.output(&home, &["config", "--global", "--get", "core.excludesfile"]).await.ok();
    let configured = out.map(|o| String::from_utf8_lossy(&o).trim().to_string()).filter(|s| !s.is_empty());
    Ok((home, configured))
}

/// 전역 excludesfile 읽기. 허용 경로는 현재 core.excludesfile 값·`~/.gitignore_global`·`~/.config/git/ignore`뿐.
pub(crate) async fn global_ignore_read(git: &GitRunner, path: String) -> Res<String> {
    let (home, cfg) = home_and_excludes(git).await?;
    blocking(move || gc_core::read_text(&gc_core::home_ignore_path(&home, &path, cfg.as_deref())?)).await
}

pub(crate) async fn global_ignore_write(git: &GitRunner, path: String, text: String) -> Res<()> {
    let (home, cfg) = home_and_excludes(git).await?;
    blocking(move || gc_core::write_text(&gc_core::home_ignore_path(&home, &path, cfg.as_deref())?, &text)).await
}
