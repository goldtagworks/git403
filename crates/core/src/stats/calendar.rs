//! 날짜 계산 (외부 크레이트 없이): 1970-01-01 기준 일 수 ↔ 연·월·일, git `%ai` 날짜 해석.

/// 1970-01-01부터의 일 수 (proleptic Gregorian)
pub(super) fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

pub(super) fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// `2024-05-06 14:00:00 +0900` → (로컬 날짜의 일 수, 시)
pub(super) fn local_day_hour(ai: &str) -> Option<(i64, usize)> {
    let mut parts = ai.split(' ');
    let mut date = parts.next()?.split('-');
    let (y, m, d) = (date.next()?.parse().ok()?, date.next()?.parse().ok()?, date.next()?.parse().ok()?);
    let hour = parts.next()?.split(':').next()?.parse().ok()?;
    (hour < 24).then(|| (days_from_civil(y, m, d), hour))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_roundtrip() {
        for d in [-1000, 0, 19849, 20000] {
            let (y, m, dd) = civil_from_days(d);
            assert_eq!(days_from_civil(y, m, dd), d);
        }
        // 2024-05-06 = 월요일
        assert_eq!((days_from_civil(2024, 5, 6) + 3).rem_euclid(7), 0);
    }
}
