//! gix 백엔드 공통 도우미: 저장소 열기, 오류 변환, 경로·시각 도우미.

use std::path::Path;

use crate::Error;

/// gix 오류를 git이 낸 오류처럼 보이게 한다 (`Exit` = 코드 없는 원문). UI 사전에 새 코드를 만들지 않는다.
pub(crate) fn fail(e: impl std::fmt::Display) -> Error {
    Error::Exit { code: Some(128), stderr: format!("fatal: {e}") }
}

/// `git -C <repo>`처럼 위쪽 디렉터리를 찾아 연다.
pub(crate) fn open(repo: &Path) -> crate::Result<gix::Repository> {
    gix::discover(repo).map_err(fail)
}

pub(crate) fn hex(id: impl AsRef<gix::oid>) -> String {
    id.as_ref().to_hex().to_string()
}

/// 커밋 메시지에서 git의 `%s`(제목)와 `%b`(본문). 제목은 첫 문단의 줄을 공백 하나로 잇고(줄 끝 공백 제거),
/// 본문은 그 뒤 빈 줄들을 건너뛴 나머지다.
pub(crate) fn subject_body(msg: &[u8]) -> (String, String) {
    let text = String::from_utf8_lossy(msg);
    let mut lines = text.split('\n').peekable();
    while lines.peek().is_some_and(|l| l.trim().is_empty()) {
        lines.next();
    }
    let mut subject = String::new();
    for l in lines.by_ref() {
        let l = l.trim_end();
        if l.is_empty() {
            break;
        }
        if !subject.is_empty() {
            subject.push(' ');
        }
        subject.push_str(l);
    }
    while lines.peek().is_some_and(|l| l.trim().is_empty()) {
        lines.next();
    }
    (subject, lines.collect::<Vec<_>>().join("\n"))
}

/// `core.quotepath=false` 기준의 git 경로 인용: `"`·`\`·제어 문자가 있을 때만 C 방식으로 감싼다.
pub(crate) fn quote_path(p: &[u8]) -> String {
    let plain = !p.iter().any(|&b| b < 0x20 || b == b'"' || b == b'\\' || b == 0x7f);
    if plain {
        return String::from_utf8_lossy(p).into_owned();
    }
    let mut out: Vec<u8> = vec![b'"'];
    for &b in p {
        match b {
            b'"' => out.extend(b"\\\""),
            b'\\' => out.extend(b"\\\\"),
            b'\x07' => out.extend(b"\\a"),
            b'\x08' => out.extend(b"\\b"),
            b'\t' => out.extend(b"\\t"),
            b'\n' => out.extend(b"\\n"),
            0x0b => out.extend(b"\\v"),
            0x0c => out.extend(b"\\f"),
            b'\r' => out.extend(b"\\r"),
            b if b < 0x20 || b == 0x7f => out.extend(format!("\\{b:03o}").bytes()),
            b => out.push(b),
        }
    }
    out.push(b'"');
    String::from_utf8_lossy(&out).into_owned()
}

/// git 경로 스펙(접두 디렉터리 포함) 비교: 같거나 `spec/` 아래.
pub(crate) fn under(path: &[u8], spec: &str) -> bool {
    let spec = spec.strip_prefix("./").unwrap_or(spec);
    let spec = if spec == "." { "" } else { spec.trim_end_matches('/') }.as_bytes();
    spec.is_empty() || path == spec || (path.starts_with(spec) && path.get(spec.len()) == Some(&b'/'))
}

/// 글롭 `*`(`/` 포함 전부)·`?`만 지원하는 wildmatch(플래그 0) 근사. git `--exclude`·`--glob`의 refs 이름 비교용.
pub(crate) fn glob(pat: &[u8], s: &[u8]) -> bool {
    match pat.split_first() {
        None => s.is_empty(),
        Some((b'*', rest)) => (0..=s.len()).any(|i| glob(rest, &s[i..])),
        Some((b'?', rest)) => !s.is_empty() && glob(rest, &s[1..]),
        Some((c, rest)) => s.first() == Some(c) && glob(rest, &s[1..]),
    }
}
