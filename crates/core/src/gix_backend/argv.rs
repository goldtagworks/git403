//! `run(argv)` 허용 목록: backend가 실제로 부르는 짧은 읽기 명령만 해석한다. 나머지는 `Unsupported`.
//!
//! - `config [--local|--global] [--get] <key>`: 마지막 값(git과 같음). 없으면 종료 코드 1.
//! - `config [--local|--global] [--null] --get-regexp <키 정규식>`: 모든 항목을 `키 값\n`(--null이면 `키\n값\0`)으로. 없으면 종료 코드 1.
//! - `symbolic-ref --short -q HEAD`: 현재 브랜치 이름, detached면 종료 코드 1.
//! - `rev-parse [--verify] [-q] <rev>`: 커밋 id.

use std::path::Path;

use gix::config::Source;

use super::common::{fail, hex, open};
use crate::{Error, Result};

fn exit(code: i32, ok: &[i32]) -> Result<Vec<u8>> {
    if ok.contains(&code) { Ok(Vec::new()) } else { Err(Error::Exit { code: Some(code), stderr: String::new() }) }
}

pub(super) fn run(repo: &Path, argv: &[String], ok: &[i32]) -> Result<Vec<u8>> {
    let a: Vec<&str> = argv.iter().map(String::as_str).collect();
    match a.as_slice() {
        ["config", rest @ ..] => config(repo, rest, ok),
        ["symbolic-ref", "--short", "-q", "HEAD"] => match open(repo)?.head_name().map_err(fail)? {
            Some(n) => Ok(format!("{}\n", n.shorten()).into_bytes()),
            None => exit(1, ok),
        },
        ["rev-parse", rest @ ..] => {
            let rev: Vec<&&str> = rest.iter().filter(|x| !matches!(**x, "--verify" | "-q")).collect();
            let [rev] = rev.as_slice() else { return Err(Error::Unsupported(format!("run: {}", a.join(" ")))) };
            let r = open(repo)?;
            match r.rev_parse_single(**rev) {
                Ok(id) => Ok(format!("{}\n", hex(id)).into_bytes()),
                Err(_) if rest.contains(&"-q") => exit(1, ok),
                Err(e) => Err(fail(e)),
            }
        }
        _ => Err(Error::Unsupported(format!("run: {}", a.first().copied().unwrap_or("")))),
    }
}

fn config(repo: &Path, rest: &[&str], ok: &[i32]) -> Result<Vec<u8>> {
    if rest.contains(&"--get-regexp") {
        return get_regexp(repo, rest, ok);
    }
    let (scope, key) = match rest {
        ["--get", k] | [k] if !k.starts_with('-') => (None, *k),
        ["--local", "--get", k] => (Some(Source::Local), *k),
        ["--global", "--get", k] => (Some(Source::User), *k),
        _ => return Err(Error::Unsupported(format!("run: config {}", rest.join(" ")))),
    };
    // `git config <key>`(--get 생략)는 읽기지만 값이 붙으면 쓰기다. 키 하나만 있는 형태만 읽기로 본다.
    let value = match scope {
        Some(Source::User) => {
            let f = gix::config::File::from_globals().map_err(fail)?;
            f.string_filter(key, &mut |m: &gix::config::file::Metadata| m.source == Source::User).map(|v| v.to_vec())
        }
        Some(s) => open(repo)?.config_snapshot().plumbing().string_filter(key, &mut |m: &gix::config::file::Metadata| m.source == s).map(|v| v.to_vec()),
        None => open(repo)?.config_snapshot().string(key).map(|v| v.to_vec()),
    };
    match value {
        Some(v) => Ok([v, b"\n".to_vec()].concat()),
        None => exit(1, ok),
    }
}

/// git은 정규식 안에서 첫 `.` 앞과 마지막 `.` 뒤(섹션·변수 이름)를 소문자로 바꿔 비교한다.
fn lower_key_pattern(p: &str) -> String {
    let (first, last) = (p.find('.'), p.rfind('.'));
    p.char_indices().map(|(i, c)| if first.is_none_or(|f| i < f) || last.is_some_and(|l| i > l) { c.to_ascii_lowercase() } else { c }).collect()
}

fn get_regexp(repo: &Path, rest: &[&str], ok: &[i32]) -> Result<Vec<u8>> {
    let unsupported = || Error::Unsupported(format!("run: config {}", rest.join(" ")));
    let (mut scope, mut null, mut pat) = (None, false, None);
    for x in rest {
        match *x {
            "--get-regexp" => {}
            "--null" => null = true,
            "--local" => scope = Some(&[Source::Local][..]),
            "--global" => scope = Some(&[Source::Git, Source::User][..]),
            p if !p.starts_with('-') && pat.is_none() => pat = Some(p),
            _ => return Err(unsupported()),
        }
    }
    let re = regex::Regex::new(&lower_key_pattern(pat.ok_or_else(unsupported)?)).map_err(|_| unsupported())?;
    let file = match scope {
        Some(s) if s.contains(&Source::User) => gix::config::File::from_globals().map_err(fail)?,
        _ => open(repo)?.config_snapshot().plumbing().clone(),
    };
    let mut out = Vec::new();
    for sec in file.sections() {
        if scope.is_some_and(|s| !s.contains(&sec.meta().source)) {
            continue;
        }
        let h = sec.header();
        let prefix = match h.subsection_name() {
            Some(sub) => format!("{}.{sub}.", h.name().to_string().to_ascii_lowercase()),
            None => format!("{}.", h.name().to_string().to_ascii_lowercase()),
        };
        // 같은 이름이 여러 번 나오면 등장 순서대로 값을 맞춘다. 값 없는 항목(`[a] b`)이 섞이면 순서를 못 맞추니 거절한다.
        let names: Vec<String> = sec.value_names().collect();
        let mut all: std::collections::HashMap<String, std::vec::IntoIter<gix::bstr::BString>> = std::collections::HashMap::new();
        for n in &names {
            let key = n.to_ascii_lowercase();
            if !all.contains_key(&key) {
                let vals = sec.values(n);
                if vals.len() != names.iter().filter(|m| m.eq_ignore_ascii_case(n)).count() {
                    return Err(unsupported());
                }
                all.insert(key, vals.into_iter());
            }
        }
        for n in &names {
            let key = format!("{prefix}{}", n.to_ascii_lowercase());
            let v = all.get_mut(&n.to_ascii_lowercase()).and_then(Iterator::next).unwrap_or_default();
            if re.is_match(&key) {
                out.extend_from_slice(key.as_bytes());
                out.push(if null { b'\n' } else { b' ' });
                out.extend_from_slice(&v);
                out.push(if null { 0 } else { b'\n' });
            }
        }
    }
    if out.is_empty() { exit(1, ok) } else { Ok(out) }
}
