//! 경로를 "같은 곳인가"로 비교하는 규칙 하나. 비교는 파일 시스템에 접근하지 않는 문자열 규칙이라 OS와 무관하게 같은 결과를 낸다
//! (Windows 경로 사례도 어느 OS에서든 단위 테스트로 검증된다). 파일 시스템에 접근하는 건 `real`·`canonical`뿐.
//!
//! 정규화: 윈도 canonicalize가 붙이는 `\\?\`·`\\?\UNC\`·`\\.\`·`\\.\UNC\` 접두를 떼고(UNC는 `//서버/공유`), `\`·`/` 혼용·연속 구분자·`.` 성분·끝 구분자를 정리한다.
//! `..`는 건드리지 않는다: 심볼릭 링크 때문에 문자열로 풀면 틀리므로 호출자가 먼저 `real`/`canonical`을 거친다.
//!
//! **두 가지 비교를 구분해서 쓴다.**
//! - `*_strict`: **허용 판정**("이 경로는 저장소 안이라 괜찮다")용. 대소문자를 구분한다. 양쪽을 먼저 `real`/`canonical`로 정규화해서 비교한다
//!   (윈도·맥의 canonicalize는 존재하는 경로를 **실제 대소문자**로 돌려주므로 같은 곳이면 철자도 같다). 대소문자를 접으면 서로 다른 폴더를 같은 곳으로 오판해 허용할 수 있다.
//! - `*_folded`: **막는 판정**("이미 AI 차례 중인 저장소다 → 막는다")·직렬화 잠금 키용. 드라이브 문자·UNC로 시작하는 윈도 경로만 대소문자를 무시한다(유닉스·맥 경로는 구분).
//!   오판해도 "더 막는" 쪽이라 안전하다(윈도 폴더별 대소문자 구분을 켠 곳의 `Repo`/`repo`는 같은 곳으로 본다).
//!
//! 드라이브 상대 경로(`C:foo`)는 어느 폴더인지 현재 드라이브 상태에 달려 있어 알 수 없다. 허용 판정(`*_strict`)은 **항상 거절**하고,
//! 막는 판정은 호출 측이 `is_drive_relative`로 알아보고 **막는다**(`repo_gate`). 키 문자열 자체는 `c:foo`로 남아 `c:/foo`와 같지 않다.

use std::path::{Component, Path, PathBuf};

/// `\\?\C:\…`·`\\?\UNC\…`(와 `\\.\`) 접두를 뗀다. 접두 없는 입력·너무 긴 경로(260자 이상은 접두가 있어야 열린다)는 그대로.
pub fn strip_verbatim(s: &str) -> String {
    let rest = [r"\\?\", r"\\.\"].iter().find_map(|p| s.strip_prefix(p));
    let Some(rest) = rest else { return s.to_owned() };
    let plain = if let Some(unc) = rest.strip_prefix(r"UNC\") { format!(r"\\{unc}") } else if rest.as_bytes().get(1) == Some(&b':') && rest.as_bytes()[0].is_ascii_alphabetic() { rest.to_owned() } else { return s.to_owned() };
    if plain.len() >= 260 { s.to_owned() } else { plain }
}

fn plain(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if s.starts_with(r"\\") { PathBuf::from(strip_verbatim(&s)) } else { p }
}

/// `canonicalize` + 윈도 접두 제거(git의 `current_dir`·화면 표시에 `\\?\`가 새지 않게). 없는 경로는 오류.
pub fn canonical(p: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    p.as_ref().canonicalize().map(plain)
}

/// 실제 경로: 심볼릭 링크를 풀고(윈도·맥은 실제 대소문자로 돌아온다), 아직 없는 뒷부분은 그대로 붙인다. 없는 성분은 링크일 수 없으므로 `..`로 되돌아올 때만
/// 문자열로 풀고, **되돌아온 뒤에는 남은 경로의 존재 여부를 다시 판정해 링크를 계속 푼다**(`repo/nope/../link/x`의 `link`가 저장소 밖을 가리키면 밖으로 풀린다).
/// 윈도 접두는 뗀다. 상대 경로는 현재 폴더 기준.
pub fn real(p: impl AsRef<Path>) -> PathBuf {
    let p = p.as_ref();
    let abs = if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(p) };
    // 대부분은 전부 존재한다: 한 번의 canonicalize가 성분별 판정과 같은 결과를 낸다(성분마다 stat·canonicalize하지 않는다). 실패하면(없는 성분·깨진 링크) 아래 성분별 규칙으로.
    if let Ok(full) = abs.canonicalize() {
        return plain(full);
    }
    let (mut cur, mut missing) = (PathBuf::new(), false);
    for c in abs.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                cur.pop();
                // 없는 성분을 지나 돌아왔으면 지금 위치는 존재하는 정규 경로일 수 있다: 다시 판정해서 이후 성분의 링크를 푼다
                missing = cur.symlink_metadata().is_err();
            }
            Component::Normal(n) => {
                cur.push(n);
                if !missing {
                    match cur.symlink_metadata() {
                        Ok(_) => cur = cur.canonicalize().unwrap_or(cur),
                        Err(_) => missing = true,
                    }
                }
            }
            other => cur.push(other.as_os_str()),
        }
    }
    plain(cur)
}

/// 드라이브를 알 수 없는 윈도 경로인가: 드라이브 상대(`C:foo` — 구분자 없이 드라이브 문자 뒤에 바로 이름)와
/// 루트 상대(`\foo` — 현재 드라이브의 루트, 맨 앞에 `\`가 하나만 있고 그 뒤가 `\`·`?`·`.`가 아닌 것). `\\서버`(UNC)·`\\?\`(접두)는 아니다.
/// `/foo`는 유닉스에서 보통 절대 경로라 포함하지 않는다.
pub fn is_drive_relative(s: &str) -> bool {
    let s = strip_verbatim(s);
    let b = s.as_bytes();
    let drive_rel = b.len() > 2 && b[1] == b':' && b[0].is_ascii_alphabetic() && b[2] != b'/' && b[2] != b'\\';
    let root_rel = b.len() > 1 && b[0] == b'\\' && !matches!(b[1], b'\\' | b'?' | b'.');
    drive_rel || root_rel
}

fn key_with(p: &str, fold: bool) -> String {
    let (mut s, mut unc) = (p.to_owned(), false);
    for (unc_pre, pre) in [(r"\\?\UNC\", r"\\?\"), ("//?/UNC/", "//?/"), (r"\\.\UNC\", r"\\.\"), ("//./UNC/", "//./")] {
        if let Some(r) = s.strip_prefix(unc_pre) {
            s = r.to_owned();
            unc = true;
            break;
        }
        if let Some(r) = s.strip_prefix(pre) {
            s = r.to_owned();
            break;
        }
    }
    let s = s.replace('\\', "/");
    let unc = unc || s.starts_with("//");
    let drive = s.as_bytes().get(1) == Some(&b':') && s.as_bytes()[0].is_ascii_alphabetic();
    let mut parts: Vec<&str> = s.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    let head = if unc {
        "//"
    } else if !drive && s.starts_with('/') {
        "/"
    } else {
        ""
    };
    if drive && parts.first().is_some_and(|p| p.len() == 2) {
        parts[0] = &parts[0][..2];
    }
    let mut out = format!("{head}{}", parts.join("/"));
    if drive && parts.len() == 1 && s.len() > 2 {
        out.push('/'); // `C:\` → `c:/`
    }
    if fold && (drive || unc) {
        out = out.to_lowercase();
    }
    out
}

/// 막는 판정·잠금 키용 비교 키(윈도 경로는 대소문자 무시)
pub fn key(p: impl AsRef<Path>) -> String {
    key_with(&p.as_ref().to_string_lossy(), true)
}
pub fn key_str(s: &str) -> String {
    key_with(s, true)
}
/// 허용 판정용 비교 키(대소문자 구분)
pub fn key_strict(p: impl AsRef<Path>) -> String {
    key_with(&p.as_ref().to_string_lossy(), false)
}

fn rel_with(base: &Path, p: &Path, fold: bool) -> Option<String> {
    let (bs, ps) = (base.to_string_lossy(), p.to_string_lossy());
    if !fold && (is_drive_relative(&bs) || is_drive_relative(&ps)) {
        return None; // 허용 판정은 어느 폴더인지 알 수 없는 경로를 거절한다
    }
    let (kb, kp) = (key_with(&bs, fold), key_with(&ps, fold));
    if kp == kb {
        return Some(String::new());
    }
    let prefix = if kb.ends_with('/') { kb } else { format!("{kb}/") };
    kp.strip_prefix(&prefix).map(String::from)
}

/// `p`가 `base`와 같거나 그 아래면 `base` 기준 나머지(같으면 빈 문자열). 구분자 경계로만 판단한다(`/r2`는 `/r` 아래가 아니다). 대소문자 무시 — **막는 판정 전용**
pub fn rel_folded(base: impl AsRef<Path>, p: impl AsRef<Path>) -> Option<String> {
    rel_with(base.as_ref(), p.as_ref(), true)
}
/// `rel_folded`의 대소문자 구분판 — **허용 판정용**(양쪽을 먼저 `real`/`canonical`로 정규화해서 넘긴다). 드라이브 상대 경로는 `None`
pub fn rel_strict(base: impl AsRef<Path>, p: impl AsRef<Path>) -> Option<String> {
    rel_with(base.as_ref(), p.as_ref(), false)
}
pub fn contains_folded(base: impl AsRef<Path>, p: impl AsRef<Path>) -> bool {
    rel_folded(base, p).is_some()
}
pub fn contains_strict(base: impl AsRef<Path>, p: impl AsRef<Path>) -> bool {
    rel_strict(base, p).is_some()
}
pub fn same_folded(a: impl AsRef<Path>, b: impl AsRef<Path>) -> bool {
    rel_folded(a.as_ref(), b.as_ref()).is_some_and(|r| r.is_empty()) 
}
pub fn same_strict(a: impl AsRef<Path>, b: impl AsRef<Path>) -> bool {
    rel_strict(a.as_ref(), b.as_ref()).is_some_and(|r| r.is_empty())
}

/// `key(real(p))`
pub fn real_key(p: impl AsRef<Path>) -> String {
    key(real(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_and_unc_prefixes_are_stripped() {
        assert_eq!(key_str(r"\\?\C:\repo"), "c:/repo");
        assert_eq!(key_str(r"\\?\UNC\srv\share\r"), "//srv/share/r");
        assert_eq!(key_str(r"\\srv\share\r"), "//srv/share/r");
        assert_eq!(key_str("//srv/share/r"), "//srv/share/r");
        assert_eq!(key_str(r"\\.\C:\repo"), "c:/repo");
        assert!(same_folded(r"\\?\UNC\SRV\Share\R", r"\\srv\share\r"));
        assert!(same_folded(r"\\?\UNC\srv\share\r", "//srv/share/r/"));
    }

    #[test]
    fn separators_dots_and_trailing_are_normalised() {
        assert!(same_folded(r"C:\repo", "C:/repo"));
        assert!(same_folded(r"C:\repo\", r"C:\repo"));
        assert!(same_folded(r"C:\\repo\.\sub", r"c:/repo/sub"));
        assert!(same_folded(r"C:\repo/sub\", r"C:/repo/sub"));
        assert!(same_folded("/tmp/r/", "/tmp/r"));
        assert!(same_folded("/tmp//r/./", "/tmp/r"));
        assert_eq!(key_str(r"C:\"), "c:/");
        assert_eq!(key_str("C:"), "c:");
        assert_eq!(key_str("/"), "/");
    }

    #[test]
    fn drive_and_unc_paths_ignore_case_but_unix_paths_do_not() {
        assert!(same_folded(r"C:\Users\Me\Repo", r"c:\users\me\repo"));
        assert!(same_folded(r"\\?\c:\USERS\repo", r"C:\users\Repo"));
        assert!(!same_folded("/tmp/Repo", "/tmp/repo"));
        assert!(!same_folded("/Users/me/R", "/users/me/r"));
    }

    #[test]
    fn different_places_are_never_the_same() {
        assert!(!same_folded(r"C:\repo", r"D:\repo"));
        assert!(!same_folded(r"C:\repo", r"C:\repo2"));
        assert!(!same_folded(r"C:\repo", r"C:\repo\sub"));
        assert!(!same_folded(r"\\srv\share\r", r"\\srv\share2\r"));
        assert!(!same_folded(r"\\srv\share\r", r"C:\srv\share\r"));
        assert!(!same_folded("/tmp/r", "/tmp/r2"));
        // `..`는 문자열로 풀지 않는다 — 다른 곳으로 본다(호출자가 canonicalize)
        assert!(!same_folded("/tmp/a/../r", "/tmp/r"));
        assert!(!same_folded(r"C:\a\..\repo", r"C:\repo"));
    }

    #[test]
    fn real_resolves_links_dotdot_and_missing_tails() {
        let d = std::env::temp_dir().join(format!("gc-pathkey-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("a/b")).unwrap();
        let base = d.canonicalize().unwrap();
        assert_eq!(real(d.join("a/b/../b/")), base.join("a/b"));
        assert_eq!(real(d.join("a/nope/x/../y")), base.join("a/nope/y"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("a"), base.join("link")).unwrap();
            assert_eq!(real(d.join("link/b")), base.join("a/b"));
            // 링크를 지나 `..`로 올라가면 링크가 아니라 링크 대상의 부모
            assert_eq!(real(d.join("link/../a")), base.join("a"));
            assert!(same_folded(real(d.join("link/")), base.join("a")));
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn contains_and_rel_use_component_boundaries() {
        assert_eq!(rel_folded(r"\\?\C:\repo", r"c:\Repo\.jj").as_deref(), Some(".jj"));
        assert_eq!(rel_folded(r"C:\repo", r"\\?\C:\REPO").as_deref(), Some(""));
        assert_eq!(rel_folded("/tmp/r", "/tmp/r/sub/x").as_deref(), Some("sub/x"));
        assert_eq!(rel_folded("/tmp/r", "/tmp/r2/x"), None);
        assert_eq!(rel_folded("/tmp/r/sub", "/tmp/r"), None);
        assert_eq!(rel_folded(r"C:\", r"C:\x\y").as_deref(), Some("x/y"));
        assert_eq!(rel_folded("/", "/x").as_deref(), Some("x"));
        assert!(contains_folded(r"\\?\UNC\srv\share\r", r"\\SRV\share\R\sub"));
        assert!(!contains_folded(r"C:\repo", r"D:\repo\sub"));
    }

    #[test]
    fn strict_comparison_keeps_case_and_is_for_allow_decisions() {
        // 막는 판정은 접고, 허용 판정은 구분한다
        assert!(same_folded(r"C:\Repo", r"c:\repo"));
        assert!(!same_strict(r"C:\Repo", r"c:\repo"));
        assert!(same_strict(r"C:\Repo", r"\\?\C:\Repo\"));
        assert!(same_strict(r"\\?\UNC\srv\Share\r", r"//srv/Share/r/"));
        assert!(!same_strict(r"\\srv\Share\r", r"\\srv\share\r"));
        assert!(!contains_strict(r"C:\Repo", r"C:\repo\sub"));
        assert!(contains_strict(r"C:\Repo", r"\\?\C:\Repo\sub"));
        assert_eq!(rel_strict(r"\\?\C:\repo", r"C:\repo\.jj").as_deref(), Some(".jj"));
        assert_eq!(rel_strict(r"C:\repo", r"C:\repo\.JJ").as_deref(), Some(".JJ"));
        assert_ne!(key_strict(r"C:\A"), key_strict(r"C:\a"));
        assert_eq!(key(r"C:\A"), key(r"C:\a"));
        assert!(!contains_strict("/tmp/R", "/tmp/r/x"));
    }

    #[test]
    fn drive_relative_paths_are_unknown_places_strict_rejects_them() {
        for p in ["C:foo", r"c:foo\bar", r"\\?\C:foo"] {
            assert!(is_drive_relative(p), "{p}");
            assert!(!same_strict(p, p), "허용 판정은 거절: {p}");
            assert!(!contains_strict(p, p) && !contains_strict(r"C:\", p), "{p}");
        }
        for p in ["C:", r"C:\", "C:/foo", r"C:\foo", "/tmp/c:foo", "foo", r"\\srv\share"] {
            assert!(!is_drive_relative(p), "{p}");
        }
        // 막는 쪽 키는 `c:/foo`와 섞이지 않는다
        assert_ne!(key_str("C:foo"), key_str(r"C:\foo"));
    }

    #[test]
    fn device_prefixes_and_verbatim_stripping() {
        assert_eq!(key_str(r"\\.\UNC\srv\share\r"), "//srv/share/r");
        assert_eq!(key_str("//./UNC/srv/share/r"), "//srv/share/r");
        assert_eq!(key_str("//?/UNC/srv/share/r"), "//srv/share/r");
        assert_eq!(key_str("//./C:/repo"), "c:/repo");
        assert!(same_folded(r"\\.\UNC\srv\share\r", r"\\?\UNC\srv\share\r"));
        assert_eq!(strip_verbatim(r"\\?\C:\repo"), r"C:\repo");
        assert_eq!(strip_verbatim(r"\\?\UNC\srv\share\r"), r"\\srv\share\r");
        assert_eq!(strip_verbatim(r"\\.\C:\repo"), r"C:\repo");
        assert_eq!(strip_verbatim("/tmp/r"), "/tmp/r");
        assert_eq!(strip_verbatim(r"\\?\Volume{1234}\x"), r"\\?\Volume{1234}\x"); // 모르는 형태는 그대로
        let long = format!(r"\\?\C:\{}", "a".repeat(300));
        assert_eq!(strip_verbatim(&long), long); // 260자 넘으면 접두가 있어야 열린다
    }

    /// 한글·이모지·결합 문자·장치 접두가 섞인 경로: 바이트 슬라이스로 panic하지 않고 규칙대로 동작한다
    #[test]
    fn multibyte_and_hostile_strings_do_not_panic_and_still_normalise() {
        let cases = [
            "가나다", r"C:\가나\다", r"\\?\C:\한글\", "//./가나", r"\\.\UNC\서버\공유\저장소", "🎉/🎉", "e\u{301}/\u{301}", r"\\?\가", "가:", "é:foo", "\u{301}:\\x", r"\\?\UNC\", r"\\?\", "//?/U🎉", "C:🎉", "",
        ];
        for c in cases {
            let _ = (key_str(c), key_strict(c), strip_verbatim(c), is_drive_relative(c), real_key(c));
            for d in cases {
                let _ = (rel_folded(c, d), rel_strict(c, d), same_folded(c, d), contains_strict(c, d));
            }
        }
        assert!(same_folded(r"C:\한글\저장소", r"\\?\C:\한글\저장소\"));
        assert!(same_strict(r"C:\한글\저장소", "C:/한글/저장소/"));
        assert!(!same_folded("/tmp/가나", "/tmp/가다"));
        assert_eq!(rel_strict("/tmp/가", "/tmp/가/나/🎉").as_deref(), Some("나/🎉"));
        assert_eq!(rel_strict("/tmp/가", "/tmp/가나"), None, "접두가 같은 다른 이름");
        assert!(same_folded("e\u{301}", "e\u{301}") && !same_strict("é", "e\u{301}"), "결합 문자는 정규화하지 않는다(다른 이름)");
        assert!(is_drive_relative("C:가나") && !is_drive_relative("가:나"));
        assert_eq!(strip_verbatim(r"\\?\C:\한글"), r"C:\한글");
        assert_eq!(strip_verbatim(r"\\?\UNC\서버\공유"), r"\\서버\공유");
    }

    /// 무작위 불신 문자열(간단한 xorshift 반복 생성)로 panic이 없다(키가 멱등이라는 보장은 하지 않는다 — 비교는 항상 같은 함수로 만든 키끼리 한다)
    #[test]
    fn random_strings_never_panic() {
        const TOK: &[&str] = &["", "\\", "/", "//", ":", ".", "..", "?", "C", "c:", "UNC", "unc/", r"\\?\", r"\\.\", "//./", "//?/", "가", "🎉", "e\u{301}", "\u{301}", "é", "\0", "x", "UNC\\"];
        let mut seed = 0xD1B5_4A32_D192_ED03u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _ in 0..50_000 {
            let n = (next() % 10) as usize;
            let a: String = (0..n).map(|_| TOK[(next() % TOK.len() as u64) as usize]).collect();
            let b: String = (0..(next() % 6) as usize).map(|_| TOK[(next() % TOK.len() as u64) as usize]).collect();
            let _ = (key_str(&a), key_strict(&a), strip_verbatim(&a), is_drive_relative(&a));
            let _ = (rel_folded(&a, &b), rel_strict(&b, &a), same_strict(&a, &b), contains_folded(&b, &a));
        }
    }

    #[test]
    fn root_relative_paths_are_unknown_places_too() {
        for p in [r"\foo", r"\foo\bar", r"\가나"] {
            assert!(is_drive_relative(p), "{p}");
            assert!(!same_strict(p, p) && !contains_strict(p, p), "{p}");
        }
        for p in [r"\\srv\share", r"\\?\C:\x", r"\\.\pipe", "/foo", "\\", "", "foo"] {
            assert!(!is_drive_relative(p), "{p:?}");
        }
    }

    /// `repo/nope/../link/x`: 없는 성분 뒤에 `..`로 돌아와도 이후 성분의 링크를 푼다(밖을 가리키는 링크가 안으로 판정되지 않는다)
    #[test]
    fn real_keeps_resolving_links_after_dotdot_returns_from_a_missing_component() {
        let d = std::env::temp_dir().join(format!("gc-pathkey-dd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("repo")).unwrap();
        std::fs::create_dir_all(d.join("outside/x")).unwrap();
        let base = d.canonicalize().unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("outside"), base.join("repo/link")).unwrap();
            let r = real(d.join("repo/nope/../link/x"));
            assert_eq!(r, base.join("outside/x"));
            assert!(!contains_strict(base.join("repo"), &r), "저장소 밖으로 판정돼야 한다");
            assert_eq!(real(d.join("repo/a/b/../../link/x")), base.join("outside/x"));
            assert_eq!(real(d.join("repo/nope/../nope2/../link")), base.join("outside"));
            assert_eq!(real(d.join("repo/nope/x/../../plain")), base.join("repo/plain"));
        }
        assert_eq!(real(d.join("repo/nope/../../repo/y")), base.join("repo/y"));
        let _ = std::fs::remove_dir_all(&d);
    }
}
