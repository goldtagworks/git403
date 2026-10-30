//! `run(argv)` 허용 목록: backend가 실제로 부르는 짧은 읽기 명령만 해석한다. 나머지는 `Unsupported`.
//!
//! - `config [--local|--global] [--get] <key>`: 마지막 값(git과 같음). 없으면 종료 코드 1.
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
