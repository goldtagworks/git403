//! git 형식 unified diff 만들기 (`git diff`/`git show` 패치 텍스트와 같은 모양).
//!
//! 줄 비교는 imara-diff(Myers + 슬라이더 휴리스틱)를 쓴다. 헤더(`diff --git`·모드·`index`)·hunk 묶기(문맥 3줄, 사이가 6줄 이하면 합침)·
//! hunk 제목(기본 함수 패턴: 영문·`_`·`$`로 시작하는 위쪽 가장 가까운 줄, 80바이트)·`\ No newline at end of file`·`Binary files … differ`는 직접 만든다.
//! `.gitattributes`의 diff 드라이버(함수 패턴·textconv)는 읽지 않는다.

use gix::diff::blob::{Algorithm, Diff, InternedInput};

use super::common::quote_path;

/// diff 한쪽: 파일 모드(`0o100644` 등), 객체 id, 내용.
pub(crate) struct Side {
    pub mode: u32,
    pub id: gix::ObjectId,
    pub data: Vec<u8>,
}

/// 렌더링에 필요한 환경: 해시 약식 길이를 정하는 함수와 공백 무시 옵션.
pub(crate) struct Opts<'a> {
    pub abbrev: &'a dyn Fn(&gix::ObjectId) -> String,
    pub ignore_eol: bool,
    pub ignore_ws: bool,
}

const CONTEXT: usize = 3;

fn is_binary(data: &[u8]) -> bool {
    data[..data.len().min(8000)].contains(&0)
}

fn lines(data: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, b) in data.iter().enumerate() {
        if *b == b'\n' {
            out.push(&data[start..=i]);
            start = i + 1;
        }
    }
    if start < data.len() {
        out.push(&data[start..]);
    }
    out
}

/// 줄 비교용 키: 공백 무시 옵션에 맞춰 줄을 정규화한다 (출력은 원본 줄).
fn key(line: &[u8], o: &Opts) -> Vec<u8> {
    if o.ignore_ws {
        line.iter().copied().filter(|b| !matches!(b, b' ' | b'\t' | b'\n' | b'\r')).collect()
    } else if o.ignore_eol {
        // 줄 끝의 `\n`·`\r`을 무시한다 (git은 마지막 줄의 개행 유무 차이도 같은 줄로 본다)
        let l = line.strip_suffix(b"\n").unwrap_or(line);
        l.strip_suffix(b"\r").unwrap_or(l).to_vec()
    } else {
        line.to_vec()
    }
}

/// 기본 함수 패턴(`def_ff`): 영문(ASCII)·`_`·`$`로 시작하는 줄을 80바이트까지, 끝 공백 제거.
fn funcname(line: &[u8]) -> Option<&[u8]> {
    let first = *line.first()?;
    if !(first.is_ascii_alphabetic() || first == b'_' || first == b'$') {
        return None;
    }
    let mut l = &line[..line.len().min(80)];
    while let Some((last, rest)) = l.split_last() {
        if matches!(last, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c) { l = rest } else { break }
    }
    Some(l)
}

fn range(start: usize, len: usize) -> String {
    // git: 길이 0이면 시작은 한 줄 앞, 길이 1이면 길이 생략
    match len {
        0 => format!("{},0", start),
        1 => format!("{}", start + 1),
        _ => format!("{},{}", start + 1, len),
    }
}

/// 본문(hunk들). 바뀐 줄이 없으면 빈 문자열.
fn hunks(old: &[u8], new: &[u8], o: &Opts) -> Vec<u8> {
    let (a, b) = (lines(old), lines(new));
    let mut input: InternedInput<Vec<u8>> = InternedInput::default();
    input.update_before(a.iter().map(|l| key(l, o)));
    input.update_after(b.iter().map(|l| key(l, o)));
    let mut diff = Diff::compute(Algorithm::Myers, &input);
    diff.postprocess_lines(&input);
    let changes: Vec<_> = diff.hunks().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < changes.len() {
        // 사이 공통 줄이 2*문맥 이하면 같은 hunk
        let mut j = i;
        while j + 1 < changes.len() && (changes[j + 1].before.start - changes[j].before.end) as usize <= 2 * CONTEXT {
            j += 1;
        }
        let (first, last) = (&changes[i], &changes[j]);
        let s1 = (first.before.start as usize).saturating_sub(CONTEXT);
        let s2 = (first.after.start as usize).saturating_sub(CONTEXT);
        let e1 = (last.before.end as usize + CONTEXT).min(a.len());
        let e2 = (last.after.end as usize + CONTEXT).min(b.len());
        out.extend(format!("@@ -{} +{} @@", range(s1, e1 - s1), range(s2, e2 - s2)).bytes());
        if let Some(f) = a[..s1].iter().rev().find_map(|l| funcname(l)) {
            out.push(b' ');
            out.extend(f);
        }
        out.push(b'\n');
        let emit = |out: &mut Vec<u8>, sign: u8, line: &[u8]| {
            out.push(sign);
            out.extend(line);
            if !line.ends_with(b"\n") {
                out.extend(b"\n\\ No newline at end of file\n");
            }
        };
        // 문맥 줄은 새 파일 쪽 글자를 쓴다 (공백 무시 옵션에서 두 쪽이 다를 수 있고, git은 새 파일 것을 낸다)
        let (mut pos, mut pos2) = (s1, s2);
        for c in &changes[i..=j] {
            for l in &b[pos2..c.after.start as usize] {
                emit(&mut out, b' ', l);
            }
            for l in &a[c.before.start as usize..c.before.end as usize] {
                emit(&mut out, b'-', l);
            }
            for l in &b[c.after.start as usize..c.after.end as usize] {
                emit(&mut out, b'+', l);
            }
            (pos, pos2) = (c.before.end as usize, c.after.end as usize);
        }
        let _ = pos;
        for l in &b[pos2..e2] {
            emit(&mut out, b' ', l);
        }
        i = j + 1;
    }
    out
}

/// 한 경로의 diff. `old`/`new`가 `None`이면 없는 쪽(추가·삭제). 두 쪽이 같으면 아무것도 쓰지 않는다.
pub(crate) fn render(path: &[u8], old: Option<&Side>, new: Option<&Side>, o: &Opts, out: &mut Vec<u8>) {
    if let (Some(a), Some(b)) = (old, new) {
        if a.mode == b.mode && a.id == b.id {
            return;
        }
    }
    let p = quote_path(path);
    let (qa, qb) = (format!("a/{p}"), format!("b/{p}"));
    let (qa, qb) = (unquote_prefix(&qa, &p), unquote_prefix(&qb, &p));
    let mut head = format!("diff --git {qa} {qb}\n");
    match (old, new) {
        (None, Some(b)) => head += &format!("new file mode {:06o}\n", b.mode),
        (Some(a), None) => head += &format!("deleted file mode {:06o}\n", a.mode),
        (Some(a), Some(b)) if a.mode != b.mode => head += &format!("old mode {:06o}\nnew mode {:06o}\n", a.mode, b.mode),
        _ => {}
    }
    let header_only = head.lines().count() > 1; // 모드 줄이 있으면 hunk가 없어도 머리글은 나간다
    let zero = (o.abbrev)(&gix::ObjectId::null(gix::hash::Kind::Sha1));
    let (ia, ib) = (old.map_or(zero.clone(), |s| (o.abbrev)(&s.id)), new.map_or(zero, |s| (o.abbrev)(&s.id)));
    let same_blob = matches!((old, new), (Some(a), Some(b)) if a.id == b.id);
    if !same_blob {
        let mode = match (old, new) {
            (Some(a), Some(b)) if a.mode == b.mode => format!(" {:06o}", a.mode),
            _ => String::new(),
        };
        head += &format!("index {ia}..{ib}{mode}\n");
    }
    if same_blob {
        out.extend(head.bytes());
        return;
    }
    let (od, nd) = (old.map_or(&[][..], |s| &s.data[..]), new.map_or(&[][..], |s| &s.data[..]));
    let (na, nb) = (if old.is_some() { qa.clone() } else { "/dev/null".to_owned() }, if new.is_some() { qb.clone() } else { "/dev/null".to_owned() });
    if is_binary(od) || is_binary(nd) {
        out.extend(head.bytes());
        out.extend(format!("Binary files {na} and {nb} differ\n").bytes());
        return;
    }
    let body = hunks(od, nd, o);
    // 공백 무시 옵션으로 바뀐 줄이 없어지면 git은 머리글도 내지 않는다 (추가·삭제·모드 변경만 머리글을 낸다)
    if body.is_empty() && !header_only && old.is_some() && new.is_some() {
        return;
    }
    out.extend(head.bytes());
    if body.is_empty() {
        return;
    }
    // 경로에 공백이 있으면 git은 ---/+++ 줄 끝에 탭을 붙인다
    let tab = |n: &str| if n.contains(' ') { "\t" } else { "" };
    out.extend(format!("--- {na}{}\n+++ {nb}{}\n", tab(&na), tab(&nb)).bytes());
    out.extend(body);
}

/// `a/` 접두사 뒤 경로가 인용(`"`)된 형태면 git은 따옴표를 접두사 앞에 둔다: `"a/x\ty"`.
fn unquote_prefix(prefixed: &str, quoted: &str) -> String {
    match quoted.strip_prefix('"') {
        Some(rest) => format!("\"{}{}", &prefixed[..2], rest),
        None => prefixed.to_owned(),
    }
}
