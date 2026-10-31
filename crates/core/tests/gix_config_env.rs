//! `config --global` 쓰기: git과 같은 파일(`GIT_CONFIG_GLOBAL` > `~/.gitconfig` > XDG)에 같은 내용을 쓰는지. 환경 변수를 바꾸므로 시험은 이 하나뿐이다.
#![cfg(feature = "gix")]

use std::fs;
use std::path::Path;

use gc_core::gix_backend::GixBackend;
use gc_core::{CliBackend, GitBackend, GitRunner};

fn set_env(home: &Path, global: Option<&Path>, xdg: Option<&Path>) {
    // 시험 하나뿐이라 다른 스레드가 환경을 읽지 않는다
    unsafe {
        std::env::set_var("HOME", home);
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
        match global { Some(p) => std::env::set_var("GIT_CONFIG_GLOBAL", p), None => std::env::remove_var("GIT_CONFIG_GLOBAL") }
        match xdg { Some(p) => std::env::set_var("XDG_CONFIG_HOME", p), None => std::env::remove_var("XDG_CONFIG_HOME") }
    }
}

fn files(home: &Path) -> Vec<(String, String)> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(root, &p, out);
            } else {
                out.push((p.strip_prefix(root).unwrap().display().to_string(), fs::read_to_string(&p).unwrap()));
            }
        }
    }
    let mut o = Vec::new();
    walk(home, home, &mut o);
    o.sort();
    o
}

#[tokio::test]
async fn global_쓰기가_git과_같은_파일에_같은_내용을_쓴다() {
    let c = CliBackend::new(GitRunner::default());
    let g = GixBackend::new();
    let cwd = tempfile::tempdir().unwrap(); // 저장소가 아닌 작업 폴더
    // (이름, 미리 만들 파일들, GIT_CONFIG_GLOBAL을 쓸지)
    for (name, pre, over) in [
        ("빈 홈", vec![], false),
        ("~/.gitconfig 있음", vec![(".gitconfig", "[user]\n\tname = old\n")], false),
        ("XDG만 있음", vec![(".config/git/config", "[user]\n\tname = old\n")], false),
        ("둘 다 있음", vec![(".gitconfig", "[user]\n\tname = a\n"), (".config/git/config", "[user]\n\tname = x\n")], false),
        ("GIT_CONFIG_GLOBAL", vec![], true),
    ] {
        let homes = [tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap()];
        for h in &homes {
            if over {
                fs::create_dir_all(h.path().join("custom")).unwrap(); // git도 GIT_CONFIG_GLOBAL의 폴더는 안 만든다
            }
            for (f, body) in &pre {
                let p = h.path().join(f);
                fs::create_dir_all(p.parent().unwrap()).unwrap();
                fs::write(p, body).unwrap();
            }
        }
        let argvs: [&[&str]; 4] = [
            &["config", "--global", "user.name", "Kim 한글"],
            &["config", "--global", "user.email", "k@e.c"],
            &["config", "--global", "core.editor", "vi -w"],
            &["config", "--global", "--unset", "user.email"],
        ];
        for argv in argvs {
            let ov = |h: &Path| over.then(|| h.join("custom/gc"));
            set_env(homes[0].path(), ov(homes[0].path()).as_deref(), None);
            c.run(cwd.path(), argv, &[]).await.unwrap();
            set_env(homes[1].path(), ov(homes[1].path()).as_deref(), None);
            g.run(cwd.path(), argv, &[]).await.unwrap();
            assert_eq!(files(homes[0].path()), files(homes[1].path()), "{name}: {argv:?}");
        }
        // 없는 키 삭제는 5
        set_env(homes[1].path(), over.then(|| homes[1].path().join("custom/gc")).as_deref(), None);
        assert!(matches!(g.run(cwd.path(), &["config", "--global", "--unset", "nope.key"], &[]).await, Err(gc_core::Error::Exit { code: Some(5), .. })));
        assert!(g.run(cwd.path(), &["config", "--global", "--unset", "nope.key"], &[5]).await.is_ok());
        // 쓴 값을 읽기 경로가 본다
        let r = g.run(cwd.path(), &["config", "--global", "--get", "user.name"], &[]).await.unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_eq!(String::from_utf8_lossy(&r), "Kim 한글\n", "{name}");
    }
    // XDG_CONFIG_HOME 지정: 그 아래 git/config가 있으면 거기, 없으면 ~/.gitconfig
    let homes = [tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap()];
    let xdgs = [tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap()];
    for x in &xdgs {
        fs::create_dir_all(x.path().join("git")).unwrap();
        fs::write(x.path().join("git/config"), "[user]\n\tname = old\n").unwrap();
    }
    set_env(homes[0].path(), None, Some(xdgs[0].path()));
    c.run(cwd.path(), &["config", "--global", "user.email", "a@b"], &[]).await.unwrap();
    set_env(homes[1].path(), None, Some(xdgs[1].path()));
    g.run(cwd.path(), &["config", "--global", "user.email", "a@b"], &[]).await.unwrap();
    assert_eq!(files(xdgs[0].path()), files(xdgs[1].path()));
    assert_eq!(files(homes[0].path()), files(homes[1].path()));
    // 저장소 밖(UI 설정 화면이 홈 폴더에서 읽는 경우): 범위 없음·--global 읽기는 되고 --local은 둘 다 실패
    let home = tempfile::tempdir().unwrap();
    fs::write(home.path().join(".gitconfig"), "[user]\n\tname = Kim\n\temail = k@e.c\n[core]\n\teditor = vi\n").unwrap();
    set_env(home.path(), None, None);
    let outside = tempfile::tempdir().unwrap();
    for argv in [
        &["config", "--get-regexp", "^user\\."][..],
        &["config", "--global", "--get-regexp", "^(user\\.(name|email))$"],
        &["config", "--null", "--get-regexp", "^core\\.editor$"],
        &["config", "--get", "user.name"],
        &["config", "--global", "--get", "user.email"],
        &["config", "--get", "no.such"],
        &["config", "--global", "--get-regexp", "^no\\."],
    ] {
        let (rc, rg) = (c.run(outside.path(), argv, &[1]).await, g.run(outside.path(), argv, &[1]).await);
        assert_eq!(rc.as_ref().ok(), rg.as_ref().ok(), "{argv:?}: {rc:?} vs {rg:?}");
        assert!(rc.is_ok() && rg.is_ok(), "{argv:?}");
    }
    for argv in [&["config", "--local", "--get", "user.name"][..], &["config", "--local", "--get-regexp", "^user"]] {
        let (rc, rg) = (c.run(outside.path(), argv, &[1]).await, g.run(outside.path(), argv, &[1]).await);
        let code = |r: &gc_core::Result<Vec<u8>>| matches!(r, Err(gc_core::Error::Exit { code: Some(128), .. }));
        assert!(code(&rc) && code(&rg), "{argv:?}: {rc:?} vs {rg:?}");
    }
}
