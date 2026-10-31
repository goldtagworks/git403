//! `run` config 쓰기: `config --local|--global <key> <value>`, `config --local|--global --unset <key>`(UI `ops.cfgWrite`).
//!
//! `ConfigLock`(config.lock을 먼저 잡고 읽고 rename)으로 git처럼 고친다. 키는 git처럼 검증한다(대소문자는 준 그대로 쓰고 찾을 때만 구분 안 함;
//! 점 없는 키·변수 이름 없는 키는 종료 2, 섹션/변수 이름에 허용 안 되는 글자는 종료 1). 값이 이미 하나면 교체, 여러 개면 종료 5, 없으면 새로 만든다(섹션이 없으면 끝에 추가).
//! `--unset`은 없으면 종료 5(`ok`에 5가 있으면 성공), 여럿이면 5. 값이 줄바꿈·제어 문자를 갖거나 `-`로 시작하면, 설정 파일에 CRLF·빈 줄·주석 줄·탭이 아닌 들여쓰기·값 뒤 주석이 있으면(git이 항목 줄을 다시 쓰는 방식과 gix가 다름) `Unsupported`.
//! `--global`은 git과 같은 파일: `GIT_CONFIG_GLOBAL`, 아니면 `~/.gitconfig`(이미 있거나 XDG 파일이 없을 때), 아니면 `$XDG_CONFIG_HOME/git/config`(`~/.config/git/config`).
//! `--global`은 저장소를 열지 않는다(`repo`가 저장소가 아니어도 됨).

use std::path::{Path, PathBuf};

use gix::config::Source;

use super::common::{fail, open, ConfigLock};
use super::write::{exit, unsupported};
use crate::Result;

/// (경로, 폴더를 만들어도 되는지): `GIT_CONFIG_GLOBAL`은 git도 폴더를 안 만든다(없으면 잠금 실패).
fn global_path() -> Result<(PathBuf, bool)> {
    if let Some(p) = std::env::var_os("GIT_CONFIG_GLOBAL") {
        return Ok((PathBuf::from(p), false));
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    let xdg = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()).map(|v| PathBuf::from(v).join("git/config")).or_else(|| home.as_ref().map(|h| h.join(".config/git/config")));
    let dot = home.map(|h| h.join(".gitconfig"));
    match (dot, xdg) {
        (Some(d), Some(x)) => Ok((if d.exists() || !x.exists() { d } else { x }, true)),
        (Some(d), None) => Ok((d, true)),
        (None, Some(x)) => Ok((x, true)),
        (None, None) => Err(exit(128, "fatal: $HOME not set")),
    }
}

/// (섹션, 서브섹션, 변수). git의 `git_config_parse_key`.
fn parse_key(key: &str) -> Result<(String, Option<String>, String)> {
    let bad = || exit(1, format!("error: invalid key: {key}"));
    let Some(first) = key.find('.').filter(|i| *i > 0) else { return Err(exit(2, format!("error: key does not contain a section: {key}"))) };
    let last = key.rfind('.').expect("has a dot");
    if key.len() == last + 1 {
        return Err(exit(2, format!("error: key does not contain variable name: {key}")));
    }
    let (section, var) = (&key[..first], &key[last + 1..]);
    let sub = (first != last).then(|| &key[first + 1..last]);
    let ok_name = |s: &str, var: bool| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') && (!var || s.starts_with(|c: char| c.is_ascii_alphabetic()));
    if !ok_name(section, false) || !ok_name(var, true) || sub.is_some_and(|s| s.contains(['\n', '\0'])) {
        return Err(bad());
    }
    Ok((section.to_owned(), sub.map(str::to_owned), var.to_owned()))
}

fn lock_for(scope: &str, repo: &Path) -> Result<ConfigLock> {
    match scope {
        "--local" => ConfigLock::acquire(&open(repo)?),
        _ => {
            let (p, mk) = global_path()?;
            ConfigLock::acquire_path(p, Source::User, mk)
        }
    }
}

pub(super) fn set(repo: &Path, scope: &str, key: &str, value: &str, ok: &[i32]) -> Result<Vec<u8>> {
    let (section, sub, var) = parse_key(key)?;
    if value.starts_with('-') || value.chars().any(|c| c.is_control()) {
        return Err(unsupported("config: value with a leading '-' or control characters"));
    }
    let mut lock = lock_for(scope, repo)?;
    if !canonical(&lock.cfg().to_bstring()) {
        return Err(unsupported("config: file layout (comments, indentation, trailing comments)"));
    }
    let sub_b = sub.as_deref().map(gix::bstr::BStr::new);
    let n = lock.cfg().raw_values_by(section.as_str(), sub_b, var.as_str()).map_or(0, |v| v.len());
    if n > 1 {
        return exit_or_ok(5, "error: cannot overwrite multiple values with a single value", ok);
    }
    // git은 교체할 때 변수 이름을 준 대소문자로 다시 쓰지만 gix는 기존 이름을 둔다 → 대소문자가 다르면 거절
    if n == 1 {
        let differs = lock.cfg().sections_by_name(section.as_str()).into_iter().flatten().filter(|s| s.header().subsection_name().map(|x| x.to_string()) == sub).any(|s| s.body().value_names().any(|k| k.eq_ignore_ascii_case(&var) && *k != var));
        if differs {
            return Err(unsupported("config: existing key differs in letter case"));
        }
    }
    if n == 1 {
        lock.cfg().raw_value_mut_by(section.as_str(), sub_b, var.as_str()).map_err(fail)?.set_string(value).map_err(fail)?;
    } else {
        lock.cfg().set_raw_value_by(section.as_str(), sub_b, var.as_str(), value).map_err(fail)?;
    }
    lock.commit()?;
    Ok(Vec::new())
}

/// git이 항목 줄 하나를 통째로 다시 쓰는 방식과 gix가 다른 배치(빈 줄·주석 줄·들여쓰기 공백·값 뒤 주석·한 줄 섹션)가 있으면 거절한다.
/// 허용: `[섹션]`/`[섹션 "서브"]` 머리줄, 탭으로 시작하는 `이름 = 값`(값 뒤 따옴표 밖 주석 없음)·값 없는 `이름`.
fn canonical(text: &[u8]) -> bool {
    if text.contains(&b'\r') {
        return false; // CRLF 설정 파일
    }
    let text = String::from_utf8_lossy(text);
    let mut cont = false; // 줄 끝 `\`로 이어지는 값
    text.lines().all(|l| {
        if cont {
            cont = l.ends_with('\\');
            return false;
        }
        if l.starts_with('[') {
            return l.ends_with(']') && !l[1..l.len() - 1].contains(']') || (l.matches('"').count() >= 2 && l.ends_with(']'));
        }
        let Some(body) = l.strip_prefix('\t') else { return false };
        if body.starts_with(['#', ';', ' ', '\t']) {
            return false;
        }
        // 따옴표 밖의 `#`·`;`(값 뒤 주석)
        let mut quoted = false;
        let mut esc = false;
        for c in body.chars() {
            match c {
                _ if esc => esc = false,
                '\\' => esc = true,
                '"' => quoted = !quoted,
                '#' | ';' if !quoted => return false,
                _ => {}
            }
        }
        cont = l.ends_with('\\');
        !cont
    })
}

fn exit_or_ok(code: i32, msg: &str, ok: &[i32]) -> Result<Vec<u8>> {
    if ok.contains(&code) { Ok(Vec::new()) } else { Err(exit(code, msg)) }
}

pub(super) fn unset(repo: &Path, scope: &str, key: &str, ok: &[i32]) -> Result<Vec<u8>> {
    let (section, sub, var) = parse_key(key)?;
    let mut lock = lock_for(scope, repo)?;
    if !canonical(&lock.cfg().to_bstring()) {
        return Err(unsupported("config: file layout (comments, indentation, trailing comments)"));
    }
    let sub_b = sub.as_deref().map(gix::bstr::BStr::new);
    let n = lock.cfg().raw_values_by(section.as_str(), sub_b, var.as_str()).map_or(0, |v| v.len());
    match n {
        0 => return exit_or_ok(5, "", ok),
        1 => {}
        _ => return exit_or_ok(5, &format!("warning: {key} has multiple values"), ok),
    }
    // 같은 이름의 섹션이 여럿이면 git이 빈 섹션을 지우는 규칙을 같게 못 맞춘다
    let same = lock.cfg().sections_by_name(section.as_str()).into_iter().flatten().filter(|s| s.header().subsection_name().map(|x| x.to_string()) == sub).count();
    if same > 1 {
        return Err(unsupported("config: --unset with several sections of the same name"));
    }
    let before = lock.cfg().to_bstring();
    lock.cfg().raw_value_mut_by(section.as_str(), sub_b, var.as_str()).map_err(fail)?.delete();
    // gix는 지운 항목의 들여쓰기를 빈 줄로 남기므로 그 한 줄을 치운다(줄 수가 같고 지운 자리만 공백이 된 경우)
    let after = lock.cfg().to_bstring();
    let (b, a): (Vec<&[u8]>, Vec<&[u8]>) = (before.split_inclusive(|c| *c == b'\n').collect(), after.split_inclusive(|c| *c == b'\n').collect());
    if b.len() == a.len() {
        if let Some(i) = (0..a.len()).find(|&i| a[i] != b[i]) {
            if a[i].iter().all(u8::is_ascii_whitespace) && !b[i].iter().all(u8::is_ascii_whitespace) {
                let text: Vec<u8> = a.iter().enumerate().filter(|(j, _)| *j != i).flat_map(|(_, l)| l.iter().copied()).collect();
                lock.replace_text(&text)?;
            }
        }
    }
    // git은 마지막 항목을 지워 비게 된 섹션 머리도 지운다
    let empty: Vec<_> = lock
        .cfg()
        .sections_and_ids()
        .filter(|(s, _)| s.header().name().eq_ignore_ascii_case(section.as_bytes()) && s.header().subsection_name().map(|x| x.to_string()) == sub)
        .filter(|(s, _)| {
            let mut t = Vec::new();
            let _ = s.write_to(&mut t);
            t.splitn(2, |c| *c == b'\n').nth(1).unwrap_or_default().iter().all(u8::is_ascii_whitespace)
        })
        .map(|(_, id)| id)
        .collect();
    for id in empty {
        lock.cfg().remove_section_by_id(id);
    }
    lock.commit()?;
    Ok(Vec::new())
}
