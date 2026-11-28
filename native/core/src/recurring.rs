//! Recurring schedules share one parser and local-clock model across the addon
//! and the standalone gateway. The accepted grammar is the historical five-field
//! protocol, including parseInt prefixes, rather than a new cron dialect.
use crate::js::{self, JsString};
pub mod timezone;
use chrono::{
    DateTime, Datelike, Local, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Timelike,
};

pub const BOUNDS: [(u32, u32); 5] = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)];
fn integer(s: &str) -> Option<i64> {
    let s = s.trim_start_matches(js::is_js_whitespace_char);
    let (sign, s) = if let Some(s) = s.strip_prefix('-') {
        (-1i64, s)
    } else {
        (1, s.strip_prefix('+').unwrap_or(s))
    };
    let digits = s.bytes().take_while(u8::is_ascii_digit).collect::<Vec<_>>();
    if digits.is_empty() {
        return None;
    }
    let mut n = 0i64;
    for b in digits {
        n = n.saturating_mul(10).saturating_add((b - b'0') as i64);
    }
    Some(n.saturating_mul(sign))
}
pub fn field(source: &str, min: u32, max: u32) -> Option<u64> {
    let mut mask = 0;
    for part in source.split(',') {
        let part = part.trim_matches(js::is_js_whitespace_char);
        if part.is_empty() {
            return None;
        }
        let slash = part.split('/').collect::<Vec<_>>();
        let (range, step) = if slash.len() == 2 {
            (slash[0], integer(slash[1]).filter(|n| *n > 0)?)
        } else {
            (part, 1)
        };
        let (lo, hi) = if range == "*" {
            (min as i64, max as i64)
        } else if range.contains('-') {
            let mut a = range.split('-');
            (integer(a.next()?)?, integer(a.next()?)?)
        } else {
            let n = integer(range)?;
            (n, n)
        };
        if lo < min as i64 || hi > max as i64 || lo > hi {
            return None;
        }
        let mut n = lo;
        while n <= hi {
            mask |= 1u64 << n;
            let Some(next) = n.checked_add(step) else {
                break;
            };
            n = next;
        }
    }
    Some(mask)
}
#[derive(Clone, Debug)]
pub struct Expression([u64; 5]);
impl Expression {
    pub fn parse(source: &str) -> Option<Self> {
        let parts = source
            .split(js::is_js_whitespace_char)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        if parts.len() != 5 {
            return None;
        }
        let mut masks = [0; 5];
        for i in 0..5 {
            masks[i] = field(parts[i], BOUNDS[i].0, BOUNDS[i].1)?;
        }
        Some(Self(masks))
    }
    pub fn matches(&self, values: [u32; 5]) -> bool {
        let hit = |i: usize| self.0[i] & (1u64 << values[i]) != 0;
        hit(0)
            && hit(1)
            && hit(3)
            && if self.0[2].count_ones() != 31 && self.0[4].count_ones() != 7 {
                hit(2) || hit(4)
            } else {
                hit(2) && hit(4)
            }
    }
    pub fn at<Z: TimeZone>(&self, at: &DateTime<Z>) -> bool {
        self.matches([
            at.minute(),
            at.hour(),
            at.day(),
            at.month(),
            at.weekday().num_days_from_sunday(),
        ])
    }
    pub fn next(&self, from: i64, end: Option<i64>) -> Option<i64> {
        self.next_in(from, end, &Local)
    }
    pub fn next_in<Z: TimeZone>(&self, from: i64, end: Option<i64>, zone: &Z) -> Option<i64> {
        let minute = zone
            .timestamp_millis_opt(from)
            .single()?
            .naive_local()
            .with_second(0)?
            .with_nanosecond(0)?;
        let mut local = resolve(minute, zone)?.naive_local();
        for _ in 0..366 * 1440 {
            local = local.checked_add_signed(chrono::Duration::minutes(1))?;
            let resolved = resolve(local, zone)?;
            // Date.setMinutes advances through gaps and chooses the earlier
            // offset in overlaps; carry that normalized local clock forward.
            local = resolved.naive_local();
            let ms = resolved.timestamp_millis();
            if end.is_some_and(|end| ms >= end) {
                return None;
            }
            if self.at(&resolved) {
                return Some(ms);
            }
        }
        None
    }
}
fn exact_local<Z: TimeZone>(value: NaiveDateTime, zone: &Z) -> Option<DateTime<Z>> {
    // At a transition endpoint the system zone can supply an offset from the
    // other side. Only accept instants that round-trip to this wall clock.
    let valid = |candidate: DateTime<Z>| {
        let at = zone.from_utc_datetime(&candidate.naive_utc());
        (at.naive_local() == value).then_some(at)
    };
    match zone.from_local_datetime(&value) {
        LocalResult::None => None,
        LocalResult::Single(at) => valid(at),
        LocalResult::Ambiguous(a, b) => {
            let (first, last) = if a <= b { (a, b) } else { (b, a) };
            valid(first).or_else(|| valid(last))
        }
    }
}

fn resolve<Z: TimeZone>(value: NaiveDateTime, zone: &Z) -> Option<DateTime<Z>> {
    if let Some(at) = exact_local(value, zone) {
        return Some(at);
    }
    // Date setters interpret a missing wall time with the pre-gap offset.
    // The gap can be half an hour or even a whole skipped calendar day.
    let mut before = value;
    for _ in 0..1440 {
        before = before.checked_sub_signed(chrono::Duration::minutes(1))?;
        if let Some(prior) = exact_local(before, zone) {
            let shifted = prior
                .fixed_offset()
                .offset()
                .from_local_datetime(&value)
                .single()?;
            return Some(shifted.with_timezone(zone));
        }
    }
    None
}

pub fn month_start<Z: TimeZone>(date: NaiveDate, zone: &Z) -> Option<i64> {
    Some(resolve(date.and_hms_opt(0, 0, 0)?, zone)?.timestamp_millis())
}
pub fn client_id(parts: &[JsString]) -> JsString {
    let mut out = Vec::new();
    for (i, p) in parts.iter().enumerate() {
        if i > 0 {
            out.push(b':' as u16)
        }
        out.extend_from_slice(p.as_units());
    }
    JsString::from_units(
        out.into_iter()
            .take(160)
            .map(|u| {
                if u <= 127 && (u as u8).is_ascii_alphanumeric()
                    || b"_.:-".iter().any(|b| *b as u16 == u)
                {
                    u
                } else {
                    b'_' as u16
                }
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_grammar_and_day_union() {
        for source in [
            "1junk * * * *",
            "1/2/3 * * * *",
            "1-3-8 * * * *",
            "*/5 * * * *",
        ] {
            assert!(Expression::parse(source).is_some(), "{source}");
        }
        for source in [
            "* * * * 7",
            "*/0 * * * *",
            "1,,2 * * * *",
            "60 * * * *",
            "* * * *",
        ] {
            assert!(Expression::parse(source).is_none(), "{source}");
        }
        let e = Expression::parse("0 9 2 * 1").unwrap();
        assert!(e.matches([0, 9, 3, 1, 1]));
        assert!(e.matches([0, 9, 2, 1, 2]));
        assert!(!e.matches([0, 9, 3, 1, 2]));
    }
    #[test]
    fn identity_is_utf16_ascii_bounded() {
        let s = client_id(&[JsString::from("cron-run"), JsString::from("😀/甲")]);
        assert_eq!(s.to_string_lossy(), "cron-run:____");
    }
}

pub fn calendar_month(month: &str) -> Result<(NaiveDate, NaiveDate), &'static str> {
    let b = month.as_bytes();
    if b.len() != 7 || b[4] != b'-' || !b[..4].iter().chain(&b[5..]).all(u8::is_ascii_digit) {
        return Err("month 应为 YYYY-MM");
    }
    let year = month[..4].parse::<i32>().unwrap();
    let number = month[5..].parse::<u32>().unwrap();
    if !(2000..=3000).contains(&year) || !(1..=12).contains(&number) {
        return Err("month 范围无效");
    }
    let first = NaiveDate::from_ymd_opt(year, number, 1).unwrap();
    let following = if number == 12 {
        chrono::NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        chrono::NaiveDate::from_ymd_opt(year, number + 1, 1)
    }
    .unwrap();
    Ok((first, following))
}

/// Calendar projection is run on a worker by the host. Missing legacy fields
/// remain undefined until JSON serialization, rather than receiving new defaults.
pub fn calendar<Z: TimeZone>(
    tasks: &crate::js::JsValue,
    month: &str,
    now: i64,
    zone: &Z,
) -> Result<(u16, crate::js::JsValue), String> {
    use crate::{
        cron_fanout::prop,
        js::{date_to_iso_string, js_to_string, truthy, JsValue as V},
    };
    use std::collections::BTreeMap;
    let (first, following) = match calendar_month(month) {
        Ok(bounds) => bounds,
        Err(message) => return Ok((400, V::object(vec![("error", V::from(message))]))),
    };
    let start = month_start(first, zone).ok_or("invalid local time")?;
    let end = month_start(following, zone).ok_or("invalid local time")?;
    let V::Array(tasks) = tasks else {
        return Err("invalid schedule store".into());
    };
    let mut days = BTreeMap::<u32, Vec<V>>::new();
    let mut dense = Vec::new();
    for t in tasks {
        if matches!(t, V::Null | V::Undefined) {
            return Err("invalid schedule".into());
        }
        let expr = js_to_string(prop(t, "cron")).to_string_lossy();
        let hint = !truthy(prop(t, "enabled")) && prop(t, "createdBy") == &V::from("subscriptions");
        if !truthy(prop(t, "enabled")) && !hint {
            continue;
        }
        if hint && expr == "0 0 31 2 *" {
            continue;
        }
        let Some(expr) = Expression::parse(&expr) else {
            continue;
        };
        let mut cursor = if hint { start } else { start.max(now) };
        let mut points = 0;
        while points < 200 {
            let Some(at) = expr.next_in(cursor, Some(end), zone) else {
                break;
            };
            let day = zone
                .timestamp_millis_opt(at)
                .single()
                .ok_or("invalid local time")?
                .day();
            days.entry(day).or_default().push(V::object(vec![
                ("id", prop(t, "id").clone()),
                ("name", prop(t, "name").clone()),
                (
                    "kind",
                    if truthy(prop(t, "kind")) {
                        prop(t, "kind").clone()
                    } else {
                        V::from("agent")
                    },
                ),
                (
                    "at",
                    V::from(date_to_iso_string(at as f64).ok_or("invalid local time")?),
                ),
                ("dense", V::Bool(false)),
            ]));
            cursor = at;
            points += 1;
        }
        if points >= 200 {
            dense.push(prop(t, "id").clone());
        }
    }
    let days = days
        .into_iter()
        .map(|(day, mut points)| {
            points.sort_by(|a, b| {
                js_to_string(prop(a, "at"))
                    .as_units()
                    .cmp(js_to_string(prop(b, "at")).as_units())
            });
            for point in &mut points {
                if dense.contains(prop(point, "id")) {
                    if let V::Object(fields) = point {
                        if let Some((_, v)) = fields.iter_mut().find(|(k, _)| k == "dense") {
                            *v = V::Bool(true);
                        }
                    }
                }
            }
            (day.to_string(), V::Array(points))
        })
        .collect::<Vec<_>>();
    Ok((
        200,
        V::object(vec![
            ("month", V::from(month)),
            ("days", V::object(days)),
            ("dense", V::Array(dense)),
            (
                "generatedAt",
                V::from(date_to_iso_string(now as f64).ok_or("invalid time")?),
            ),
        ]),
    ))
}
