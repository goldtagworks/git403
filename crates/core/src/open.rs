//! 터미널·파일 탐색기·기본 앱 열기. 실행할 명령만 만들고(OS별 분기, 순수 함수), 실행은 호출 측이 한다.

use std::path::{Path, PathBuf};

use crate::{Error, Result};

/// 실행할 외부 프로그램.
#[derive(Debug, PartialEq, Eq)]
pub struct OpenCmd {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
}

fn cmd(program: &str, args: &[&str], cwd: Option<&Path>) -> OpenCmd {
    OpenCmd { program: program.into(), args: args.iter().map(|s| s.to_string()).collect(), cwd: cwd.map(Path::to_path_buf) }
}

/// 저장소 안의 상대 경로를 절대 경로로. 저장소 밖(`..`, 절대 경로)은 거부한다.
pub fn path_in_repo(repo: &Path, rel: &str) -> Result<PathBuf> {
    let p = Path::new(rel);
    // Windows의 `/etc/x`·`\x`는 is_absolute가 아니지만 join하면 드라이브 루트로 빠져나간다
    let outside = p.is_absolute()
        || p.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_)));
    if rel.is_empty() || outside {
        return Err(gc_i18n::coded!("open.outsideRepo", "path is outside the repository: {path}", path = rel).into());
    }
    Ok(repo.join(p))
}

/// 심볼릭 링크를 풀어 본 실제 경로가 저장소 안인지 확인하고, 저장소 기준 상대 경로를 돌려준다.
/// 파일이 없거나 링크가 저장소 밖을 가리키면 오류. (디스크 접근이라 호출 측에서 블로킹 스레드로)
pub fn canonical_in_repo(repo: &Path, rel: &str) -> Result<String> {
    let full = path_in_repo(repo, rel)?;
    let real = full.canonicalize().map_err(|_| Error::from(gc_i18n::coded!("open.notInWorktree", "file is not in the working folder")))?;
    let base = repo.canonicalize()?;
    let inner = real.strip_prefix(&base).map_err(|_| Error::from(gc_i18n::coded!("open.pointsOutside", "path points outside the repository: {path}", path = rel)))?;
    Ok(inner.to_string_lossy().into_owned())
}

/// what: `terminal` | `folder` | `reveal`(파일을 탐색기에서 선택) | `open`(기본 앱).
/// `app`은 터미널 앱 이름(macOS 앱 이름, Windows `cmd|powershell|wt`, Linux 실행 파일). 비우면 기본값.
/// reveal·open은 `path`(저장소 기준 상대 경로)가 필요하다. `os`는 `std::env::consts::OS` 값.
pub fn open_command(os: &str, what: &str, repo: &Path, path: Option<&str>, app: Option<&str>) -> Result<OpenCmd> {
    let app = app.map(str::trim).filter(|a| !a.is_empty());
    let target = || -> Result<PathBuf> {
        path_in_repo(repo, path.ok_or_else(|| Error::from(gc_i18n::coded!("open.pathRequired", "a file path is required")))?)
    };
    let s = |p: &Path| p.to_string_lossy().into_owned();
    Ok(match (what, os) {
        ("folder", "macos") => cmd("open", &[&s(repo)], None),
        ("folder", "windows") => cmd("explorer", &[&s(repo)], None),
        ("folder", _) => cmd("xdg-open", &[&s(repo)], None),
        ("reveal", "macos") => cmd("open", &["-R", &s(&target()?)], None),
        // explorer는 `/` 경로를 못 읽는다
        ("reveal", "windows") => cmd("explorer", &[&format!("/select,{}", s(&target()?).replace('/', "\\"))], None),
        ("reveal", _) => {
            let t = target()?;
            cmd("xdg-open", &[&s(t.parent().unwrap_or(repo))], None)
        }
        ("open", "macos") => cmd("open", &[&s(&target()?)], None),
        // cmd를 거치지 않는다 (파일 이름이 셸 해석을 받지 않게)
        ("open", "windows") => cmd("rundll32", &["url.dll,FileProtocolHandler", &s(&target()?).replace('/', "\\")], None),
        ("open", _) => cmd("xdg-open", &[&s(&target()?)], None),
        ("terminal", "macos") => cmd("open", &["-a", app.unwrap_or("Terminal"), &s(repo)], None),
        // 허용 목록만 (임의 프로그램 실행 방지). GUI 앱이 띄운 콘솔 프로그램은 새 콘솔 창을 얻는다.
        ("terminal", "windows") => match app.unwrap_or("cmd") {
            "wt" => cmd("wt", &["-d", &s(repo)], None),
            a @ ("cmd" | "powershell" | "pwsh") => cmd(a, &[], Some(repo)),
            other => return Err(gc_i18n::coded!("open.badTerminal", "unsupported terminal: {name}", name = other).into()),
        },
        ("terminal", _) => match app.unwrap_or("x-terminal-emulator") {
            "gnome-terminal" => cmd("gnome-terminal", &[&format!("--working-directory={}", s(repo))], None),
            other => cmd(other, &[], Some(repo)),
        },
        _ => return Err(gc_i18n::coded!("open.unknownTarget", "unknown target: {target}", target = what).into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> PathBuf {
        PathBuf::from("/r/p")
    }

    #[test]
    fn reveal_per_os() {
        let c = |os| open_command(os, "reveal", &repo(), Some("src/a.rs"), None).unwrap();
        let p = |rel: &str| repo().join(rel).to_string_lossy().into_owned(); // 호스트 구분자 기준
        assert_eq!(c("macos"), cmd("open", &["-R", &p("src/a.rs")], None));
        assert_eq!(c("windows").args, vec![r"/select,\r\p\src\a.rs"]);
        assert_eq!(c("linux"), cmd("xdg-open", &[&p("src")], None));
    }

    #[test]
    fn open_default_app() {
        assert_eq!(open_command("macos", "open", &repo(), Some("a b.txt"), None).unwrap(), cmd("open", &[&repo().join("a b.txt").to_string_lossy()], None));
        let w = open_command("windows", "open", &repo(), Some("a&b.txt"), None).unwrap();
        assert_eq!((w.program.as_str(), w.args), ("rundll32", vec!["url.dll,FileProtocolHandler".to_string(), r"\r\p\a&b.txt".to_string()]));
        assert_eq!(open_command("linux", "open", &repo(), Some("a.txt"), None).unwrap().program, "xdg-open");
    }

    #[test]
    fn terminal_app_choice() {
        let t = |os, app| open_command(os, "terminal", &repo(), None, app).unwrap();
        assert_eq!(t("macos", None), cmd("open", &["-a", "Terminal", "/r/p"], None));
        assert_eq!(t("macos", Some("iTerm")), cmd("open", &["-a", "iTerm", "/r/p"], None));
        assert_eq!(t("macos", Some("  ")), cmd("open", &["-a", "Terminal", "/r/p"], None));
        assert_eq!(t("windows", Some("wt")), cmd("wt", &["-d", "/r/p"], None));
        for ok in ["cmd", "powershell", "pwsh"] {
            assert_eq!(t("windows", Some(ok)), cmd(ok, &[], Some(&repo())));
        }
        for bad in ["calc", "cmd /c calc", "..\\evil", "bash"] {
            assert!(open_command("windows", "terminal", &repo(), None, Some(bad)).is_err(), "{bad}");
        }
        assert_eq!(t("linux", None).program, "x-terminal-emulator");
        assert_eq!(t("linux", Some("konsole")).cwd, Some(repo()));
        assert_eq!(t("linux", Some("gnome-terminal")).args, vec!["--working-directory=/r/p"]);
    }

    #[test]
    fn rejects_paths_outside_repo_and_unknown_targets() {
        for bad in ["../x", "a/../../x", "/etc/passwd", ""] {
            assert!(open_command("macos", "reveal", &repo(), Some(bad), None).is_err(), "{bad}");
        }
        assert!(open_command("macos", "open", &repo(), None, None).is_err());
        assert!(open_command("macos", "nope", &repo(), None, None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn canonical_in_repo_blocks_symlink_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let (repo, outside) = (tmp.path().join("repo"), tmp.path().join("outside"));
        std::fs::create_dir_all(repo.join("sub")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(repo.join("sub/a.txt"), "x").unwrap();
        std::fs::write(outside.join("secret"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, repo.join("link")).unwrap();
        std::os::unix::fs::symlink(repo.join("sub/a.txt"), repo.join("inner")).unwrap();
        assert_eq!(canonical_in_repo(&repo, "sub/a.txt").unwrap(), "sub/a.txt");
        assert_eq!(canonical_in_repo(&repo, "inner").unwrap(), "sub/a.txt"); // 저장소 안을 가리키는 링크는 허용
        assert!(canonical_in_repo(&repo, "link/secret").is_err());
        assert!(canonical_in_repo(&repo, "link").is_err());
        assert!(canonical_in_repo(&repo, "nope").is_err());
        assert!(canonical_in_repo(&repo, "../outside/secret").is_err());
    }
}
