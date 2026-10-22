//! `git log` 출력 집계: 줄을 하나씩 먹여 작성자·주별·요일×시간을 센다 (출력 전체를 메모리에 모으지 않는다).

use std::collections::HashMap;

use super::calendar::{civil_from_days, local_day_hour};
use super::{AuthorStat, Stats, Summary, WeekCount, MAX_WEEKS};

/// 로그 줄을 하나씩 먹여 집계한다 (출력 전체를 메모리에 모으지 않는다).
pub(super) struct LogParser {
    with_lines: bool,
    /// 작성자 날짜가 이보다 이르면 건너뛴다
    cutoff: Option<i64>,
    authors: HashMap<String, AuthorStat>,
    heat: Vec<Vec<u64>>,
    week_map: HashMap<i64, u64>,
    commits: u64,
    first: i64,
    last: i64,
    cur: Option<String>,
}

impl LogParser {
    pub fn new(with_lines: bool, cutoff: Option<i64>) -> Self {
        Self { with_lines, cutoff, authors: HashMap::new(), heat: vec![vec![0; 24]; 7], week_map: HashMap::new(), commits: 0, first: i64::MAX, last: i64::MIN, cur: None }
    }

    pub fn feed(&mut self, line: &str) {
        if let Some(h) = line.strip_prefix('\x1e') {
            self.cur = None;
            let f: Vec<&str> = h.split('\x1f').collect();
            let (Some(at), Some((day, hour))) = (f.get(2).and_then(|t| t.parse::<i64>().ok()), f.get(3).and_then(|d| local_day_hour(d))) else { return };
            if self.cutoff.is_some_and(|c| at < c) {
                return;
            }
            let key = f[1].to_lowercase();
            let a = self.authors.entry(key.clone()).or_insert_with(|| AuthorStat { name: f[0].to_owned(), email: f[1].to_owned(), first: at, last: at, ..Default::default() });
            // 표시 이름은 가장 최근 커밋의 것
            if at > a.last {
                a.name = f[0].to_owned();
            }
            a.commits += 1;
            a.first = a.first.min(at);
            a.last = a.last.max(at);
            self.commits += 1;
            (self.first, self.last) = (self.first.min(at), self.last.max(at));
            let weekday = (day + 3).rem_euclid(7); // 1970-01-01은 목요일, 월=0
            self.heat[weekday as usize][hour] += 1;
            *self.week_map.entry(day - weekday).or_default() += 1;
            self.cur = Some(key);
        } else if self.with_lines {
            // numstat: `추가\t삭제\t경로` (바이너리는 `-`)
            let Some(key) = self.cur.as_ref() else { return };
            let mut it = line.split('\t');
            let (Some(ad), Some(de), Some(_)) = (it.next(), it.next(), it.next()) else { return };
            if let Some(a) = self.authors.get_mut(key) {
                a.added += ad.parse().unwrap_or(0);
                a.deleted += de.parse().unwrap_or(0);
            }
        }
    }

    pub fn finish(self) -> Stats {
        let mut weeks = Vec::new();
        if let (Some(&lo), Some(&hi)) = (self.week_map.keys().min(), self.week_map.keys().max()) {
            let lo = lo.max(hi - 7 * (MAX_WEEKS as i64 - 1));
            let mut d = lo;
            while d <= hi {
                let (y, m, dd) = civil_from_days(d);
                weeks.push(WeekCount { start: format!("{y:04}-{m:02}-{dd:02}"), commits: self.week_map.get(&d).copied().unwrap_or(0) });
                d += 7;
            }
        }
        let mut authors: Vec<AuthorStat> = self.authors.into_values().collect();
        authors.sort_by(|a, b| b.commits.cmp(&a.commits).then_with(|| a.name.cmp(&b.name)));
        Stats {
            with_lines: self.with_lines,
            summary: Summary {
                commits: self.commits,
                authors: authors.len() as u64,
                first: (self.commits > 0).then_some(self.first),
                last: (self.commits > 0).then_some(self.last),
                ..Default::default()
            },
            authors,
            weeks,
            heatmap: self.heat,
            extensions: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_log_with_lines() {
        let log = "\x1eA\x1fa@x\x1f1714971600\x1f2024-05-06 14:00:00 +0900\n\n1\t2\tf\n-\t-\tbin\n\
                   \x1eA2\x1fA@x\x1f1714975200\x1f2024-05-06 15:00:00 +0900\n\n4\t0\tg\n";
        let parse = |with_lines: bool, cutoff: Option<i64>| {
            let mut p = LogParser::new(with_lines, cutoff);
            log.lines().for_each(|l| p.feed(l));
            p.finish()
        };
        let s = parse(true, None);
        assert_eq!(s.authors.len(), 1, "이메일 대소문자는 같은 사람");
        assert_eq!((s.authors[0].commits, s.authors[0].added, s.authors[0].deleted), (2, 5, 2));
        assert_eq!(s.heatmap[0][14], 1);
        assert_eq!(s.heatmap[0][15], 1);
        assert_eq!(parse(false, None).authors[0].added, 0);
        // 작성자 날짜 컷: 첫 커밋(1714971600)만 제외
        assert_eq!(parse(true, Some(1714975000)).summary.commits, 1);
        // 표시 이름은 가장 최근 커밋 것
        assert_eq!(s.authors[0].name, "A2");
    }
}
