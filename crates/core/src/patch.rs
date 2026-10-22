//! diff에서 일부 hunk·줄만 골라 `git apply`용 패치를 만든다 (부분 스테이지).

/// 파싱된 diff: 파일 헤더 + hunk들.
pub struct Diff<'a> {
    header: Vec<&'a str>,
    hunks: Vec<Vec<&'a str>>, // 각 hunk의 첫 줄은 `@@ ... @@`
}

pub fn parse(diff: &str) -> Diff<'_> {
    let mut d = Diff { header: Vec::new(), hunks: Vec::new() };
    // `str::lines`는 줄 끝 "\r"을 떼어 CRLF 파일의 패치가 어긋나므로 "\n"으로만 나눈다.
    let mut lines: Vec<&str> = diff.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    for line in lines {
        if line.starts_with("@@") {
            d.hunks.push(vec![line]);
        } else if let Some(h) = d.hunks.last_mut() {
            h.push(line);
        } else {
            d.header.push(line);
        }
    }
    d
}

/// `hunk`번째 hunk에서 `lines`(hunk 첫 줄 다음부터 0번)만 반영하는 패치.
/// `lines`가 None이면 hunk 전체. `reverse`는 스테이지 취소용(`git apply --cached --reverse`).
pub fn select(diff: &Diff, hunk: usize, lines: Option<&[usize]>, reverse: bool) -> Option<String> {
    let h = diff.hunks.get(hunk)?;
    let (old_start, new_start) = parse_header(h[0])?;
    let mut body = Vec::new();
    let (mut old_n, mut new_n) = (0, 0);
    let mut prev_kept = true; // 직전 본문 줄을 패치에 넣었는지 ("\ No newline" 표식은 그 줄에만 붙는다)
    for (i, line) in h[1..].iter().enumerate() {
        let picked = lines.is_none_or(|l| l.contains(&i));
        let (kind, rest) = line.split_at(line.len().min(1));
        // 고르지 않은 줄 처리: 적용 방향에서 "원래 있던" 쪽 줄은 문맥으로 남기고, 새로 생기는 쪽 줄은 뺀다.
        let kept_side = if reverse { "+" } else { "-" };
        let out = match (kind, picked) {
            (" ", _) | ("", _) => Some(format!(" {rest}")),
            ("\\", _) => prev_kept.then(|| line.to_string()), // "\ No newline at end of file"
            (k, true) => Some(format!("{k}{rest}")),
            (k, false) if k == kept_side => Some(format!(" {rest}")),
            _ => None,
        };
        if kind != "\\" {
            prev_kept = out.is_some();
        }
        if let Some(o) = out {
            match o.as_bytes().first() {
                Some(b' ') => {
                    old_n += 1;
                    new_n += 1;
                }
                Some(b'-') => old_n += 1,
                Some(b'+') => new_n += 1,
                _ => {}
            }
            body.push(o);
        }
    }
    if !body.iter().any(|l| l.starts_with('+') || l.starts_with('-')) {
        return None; // 고른 변경이 없음
    }
    let mut out: Vec<String> = diff.header.iter().map(|s| s.to_string()).collect();
    out.push(format!("@@ -{old_start},{old_n} +{new_start},{new_n} @@"));
    out.extend(body);
    Some(out.join("\n") + "\n")
}

fn parse_header(h: &str) -> Option<(u32, u32)> {
    // @@ -12,7 +12,9 @@ ...
    let mut parts = h.split(' ');
    parts.next()?;
    let start = |s: &str| s[1..].split(',').next()?.parse().ok();
    Some((start(parts.next()?)?, start(parts.next()?)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIFF: &str = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n-d\n+D\n";

    #[test]
    fn whole_hunk() {
        let p = select(&parse(DIFF), 0, None, false).unwrap();
        assert!(p.contains("@@ -1,5 +1,5 @@") || p.contains("@@ -1,"));
        assert!(p.contains("-b\n+B\n") && p.contains("-d\n+D\n"));
    }

    #[test]
    fn only_first_change_when_staging() {
        // 줄 번호: 0 " a", 1 "-b", 2 "+B", 3 " c", 4 "-d", 5 "+D"
        let p = select(&parse(DIFF), 0, Some(&[1, 2]), false).unwrap();
        assert!(p.contains("@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n d\n"), "{p}");
    }

    #[test]
    fn only_second_change_when_unstaging() {
        let p = select(&parse(DIFF), 0, Some(&[4, 5]), true).unwrap();
        assert!(p.contains("@@ -1,4 +1,4 @@\n a\n B\n c\n-d\n+D\n"), "{p}");
    }

    #[test]
    fn nothing_selected() {
        assert!(select(&parse(DIFF), 0, Some(&[0, 3]), false).is_none());
    }
}
