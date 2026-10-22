//! 설정 창이 쓰는 파일 읽기·쓰기: 저장소 `.gitignore`, 전역 excludesfile.
//! 경로 검사는 순수 함수(`ignore_path`, `home_ignore_path`)로 분리해 테스트한다.

use std::path::{Path, PathBuf};

use crate::open::{canonical_in_repo, path_in_repo};
use crate::{Error, Result};

/// 설정 파일 크기 상한 (이보다 크면 편집기로 열지 않는다)
const MAX_BYTES: u64 = 1_000_000;

fn bad(c: gc_i18n::Coded) -> Error {
    c.into()
}

/// 사용자 홈 폴더 (`HOME`, Windows는 `USERPROFILE`)
pub fn home_dir() -> Result<PathBuf> {
    let v = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    v.filter(|v| !v.is_empty()).map(PathBuf::from).ok_or_else(|| bad(gc_i18n::coded!("settings.noHome", "cannot find the home folder")))
}

/// 저장소 루트의 `.gitignore` 경로. 이미 있는 파일이 저장소 밖을 가리키는 링크면 거부한다.
pub fn ignore_path(repo: &Path) -> Result<PathBuf> {
    let p = path_in_repo(repo, ".gitignore")?;
    if p.exists() {
        canonical_in_repo(repo, ".gitignore")?;
    }
    Ok(p)
}

fn expand(home: &Path, path: &str) -> PathBuf {
    match path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        Some(rest) => home.join(rest),
        None => PathBuf::from(path),
    }
}

/// 전역 excludesfile 경로 검사. 허용 경로는 **현재 `core.excludesfile` 값(`configured`), `~/.gitignore_global`,
/// `~/.config/git/ignore`** 셋뿐이다(`~/`는 홈으로 푼다). 그 밖의 경로, `..`, 홈 밖은 거부한다.
/// 파일이 없으면 가장 가까운 기존 상위 폴더를 canonicalize해서 홈 안인지 본다(링크로 홈 밖에 쓰는 것 방지).
pub fn home_ignore_path(home: &Path, path: &str, configured: Option<&str>) -> Result<PathBuf> {
    let p = expand(home, path);
    let allowed = [Some(".gitignore_global"), Some(".config/git/ignore")]
        .into_iter()
        .flatten()
        .map(|r| home.join(r))
        .chain(configured.map(str::trim).filter(|c| !c.is_empty()).map(|c| expand(home, c)))
        .any(|a| a == p);
    if path.is_empty() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) || !allowed {
        return Err(bad(gc_i18n::coded!("settings.pathNotEditable", "path cannot be edited: {path} (only core.excludesfile, ~/.gitignore_global, ~/.config/git/ignore)", path = path)));
    }
    let base = home.canonicalize()?;
    let mut probe = p.as_path();
    let real = loop {
        match probe.canonicalize() {
            Ok(r) => break r,
            Err(_) => probe = probe.parent().ok_or_else(|| bad(gc_i18n::coded!("settings.pathUnresolvable", "cannot resolve path: {path}", path = path)))?,
        }
    };
    if !real.starts_with(&base) {
        return Err(bad(gc_i18n::coded!("settings.pathOutsideHome", "path points outside the home folder: {path}", path = path)));
    }
    Ok(p)
}

/// 텍스트 파일 읽기. 없으면 빈 문자열.
pub fn read_text(path: &Path) -> Result<String> {
    match std::fs::metadata(path) {
        Ok(m) if m.len() > MAX_BYTES => Err(bad(gc_i18n::coded!("settings.fileTooLarge", "file is too large (over 1MB)"))),
        Ok(_) => Ok(String::from_utf8_lossy(&std::fs::read(path)?).into_owned()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.into()),
    }
}

/// 텍스트 파일 쓰기 (상위 폴더가 없으면 만든다)
pub fn write_text(path: &Path, text: &str) -> Result<()> {
    if text.len() as u64 > MAX_BYTES {
        return Err(bad(gc_i18n::coded!("settings.contentTooLarge", "content is too large (over 1MB)")));
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    Ok(std::fs::write(path, text)?)
}

/// 저장소 안의 **이미 있는** 파일을 덮어쓴다(충돌 도우미의 병합안 적용). `canonical_in_repo`로 링크를 풀어
/// 저장소 밖을 가리키거나 없는 파일이면 거부한다. 쓰는 대상은 풀어 낸 실제 경로다.
/// `expected`(= `fingerprint`로 미리 읽은 값)를 주면 현재 파일 지문이 같을 때만 쓴다(그사이 사용자가 고쳤으면 거부).
pub fn write_in_repo(repo: &Path, rel: &str, text: &str, expected: Option<&str>) -> Result<()> {
    let real = canonical_in_repo(repo, rel)?;
    if let Some(e) = expected {
        if fingerprint(repo, rel)? != e {
            return Err(bad(gc_i18n::coded!("settings.fileChanged", "{path}: the file changed after the AI request. Not overwritten. Please request again", path = rel)));
        }
    }
    write_text(&repo.canonicalize()?.join(real), text)
}

/// 작업 폴더 파일 내용의 지문(같은 프로세스 안에서 변경 감지용 해시). 저장소 안 파일만(`canonical_in_repo`).
pub fn fingerprint(repo: &Path, rel: &str) -> Result<String> {
    use std::hash::{Hash, Hasher};
    let real = canonical_in_repo(repo, rel)?;
    let bytes = std::fs::read(repo.canonicalize()?.join(real))?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    Ok(format!("{:016x}-{}", h.finish(), bytes.len()))
}

/// `~/.gitignore_global`을 (없으면 빈 파일로) 만들고 경로를 돌려준다. 기존 파일은 건드리지 않는다.
pub fn ensure_global_ignore(home: &Path) -> Result<PathBuf> {
    let p = home.join(".gitignore_global");
    if !p.exists() {
        std::fs::write(&p, "")?;
    }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gc-settings-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn write_in_repo_overwrites_only_existing_files_inside() {
        let d = tmp("wir");
        let (repo, out) = (d.join("repo"), d.join("out"));
        std::fs::create_dir_all(repo.join("sub")).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(repo.join("sub/a.txt"), "old").unwrap();
        std::fs::write(out.join("secret"), "keep").unwrap();
        write_in_repo(&repo, "sub/a.txt", "merged", None).unwrap();
        assert_eq!(std::fs::read_to_string(repo.join("sub/a.txt")).unwrap(), "merged");
        // expected 지문: 같으면 쓰고, 그사이 바뀌었으면 거부
        let fp = fingerprint(&repo, "sub/a.txt").unwrap();
        std::fs::write(repo.join("sub/a.txt"), "user edit").unwrap();
        assert!(write_in_repo(&repo, "sub/a.txt", "AI", Some(&fp)).is_err());
        assert_eq!(std::fs::read_to_string(repo.join("sub/a.txt")).unwrap(), "user edit");
        let fp = fingerprint(&repo, "sub/a.txt").unwrap();
        write_in_repo(&repo, "sub/a.txt", "merged", Some(&fp)).unwrap();
        assert!(write_in_repo(&repo, "../out/secret", "x", None).is_err());
        assert!(write_in_repo(&repo, "/etc/passwd", "x", None).is_err());
        assert!(write_in_repo(&repo, "sub/new.txt", "x", None).is_err(), "없는 파일은 만들지 않는다");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(out.join("secret"), repo.join("link")).unwrap();
            assert!(write_in_repo(&repo, "link", "pwn", None).is_err());
        }
        assert_eq!(std::fs::read_to_string(out.join("secret")).unwrap(), "keep");
    }

    #[test]
    fn repo_ignore_inside_repo() {
        let repo = tmp("repo");
        assert_eq!(ignore_path(&repo).unwrap(), repo.join(".gitignore"));
    }

    #[cfg(unix)]
    #[test]
    fn repo_ignore_rejects_link_outside() {
        let repo = tmp("link");
        let outside = tmp("outside").join("secret");
        std::fs::write(&outside, "x").unwrap();
        std::os::unix::fs::symlink(&outside, repo.join(".gitignore")).unwrap();
        assert!(ignore_path(&repo).is_err());
    }

    #[test]
    fn home_path_allowlist() {
        let home = tmp("home");
        assert_eq!(home_ignore_path(&home, "~/.gitignore_global", None).unwrap(), home.join(".gitignore_global"));
        let xdg = home.join(".config/git/ignore");
        assert_eq!(home_ignore_path(&home, xdg.to_str().unwrap(), None).unwrap(), xdg);
        // 설정된 값은 허용 (~ 확장), 다른 값이 설정돼 있으면 그 경로는 거부
        assert!(home_ignore_path(&home, "~/dots/my_ignore", Some("~/dots/my_ignore")).is_ok());
        assert!(home_ignore_path(&home, "~/dots/other_ignore", Some("~/dots/my_ignore")).is_err());
        for bad in ["", "~/../etc/passwd", "~/a/../.gitignore_global", "/etc/gitignore", "~/.bashrc", "~/Library/LaunchAgents/ignore.plist", "~/.ssh/authorized_keys_ignore"] {
            assert!(home_ignore_path(&home, bad, None).is_err(), "{bad}");
        }
        // 설정 값이 홈 밖이면 설정돼 있어도 거부
        assert!(home_ignore_path(&home, "/etc/my_ignore", Some("/etc/my_ignore")).is_err());
        // ignore라는 이름만으로는 허용되지 않는다
        assert!(home_ignore_path(&home, "~/Library/LaunchAgents/ignore.plist", Some("~/.gitignore_global")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn home_path_rejects_link_escape() {
        let home = tmp("home2");
        let outside = tmp("out2");
        std::fs::write(outside.join("secret"), "x").unwrap();
        // 파일 링크
        std::os::unix::fs::symlink(outside.join("secret"), home.join(".gitignore_global")).unwrap();
        assert!(home_ignore_path(&home, "~/.gitignore_global", None).is_err());
        // 없는 파일이지만 상위 폴더가 홈 밖을 가리키는 링크
        std::fs::create_dir_all(home.join(".config")).unwrap();
        std::os::unix::fs::symlink(&outside, home.join(".config/git")).unwrap();
        assert!(home_ignore_path(&home, "~/.config/git/ignore", None).is_err());
        // 홈 안의 링크는 허용
        let home3 = tmp("home3");
        std::fs::create_dir_all(home3.join("real")).unwrap();
        std::os::unix::fs::symlink(home3.join("real"), home3.join(".config")).unwrap();
        assert!(home_ignore_path(&home3, "~/.config/git/ignore", None).is_ok());
    }

    #[test]
    fn read_write_and_ensure() {
        let home = tmp("rw");
        let p = ensure_global_ignore(&home).unwrap();
        assert_eq!(read_text(&p).unwrap(), "");
        write_text(&p, "*.log\n").unwrap();
        // 기존 내용은 ensure가 지우지 않는다
        assert_eq!(ensure_global_ignore(&home).unwrap(), p);
        assert_eq!(read_text(&p).unwrap(), "*.log\n");
        assert_eq!(read_text(&home.join("none")).unwrap(), "");
    }
}
