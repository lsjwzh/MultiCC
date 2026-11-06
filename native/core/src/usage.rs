//! 只读 Token 统计。目录顺序、窗口边界由 Node 传入；逐行解析不展开无关正文。
use chrono::{DateTime, Datelike, FixedOffset, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    io::{BufRead, BufReader},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    claude_files: Vec<String>,
    codex_files: Vec<String>,
    windows: Bounds,
    timezone: String,
}
#[derive(Deserialize)]
struct Bounds {
    today: String,
    week: String,
    month: String,
}
#[derive(Deserialize, Default)]
struct Row {
    // Option distinguishes a missing timestamp (new Date(undefined) is NaN)
    // from an explicit null (new Date(null) is the epoch).
    #[serde(default)]
    timestamp: Option<Value>,
    #[serde(default, rename = "requestId")]
    request_id: Value,
    #[serde(default)]
    uuid: Value,
    #[serde(default, rename = "type")]
    kind: Value,
    // Node reads `.message` / `.payload` without checking their shape; keeping
    // them as Value lets malformed rows be tolerated instead of failing a scan.
    #[serde(default)]
    message: Value,
    #[serde(default)]
    payload: Value,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Bucket {
    input_tokens: f64,
    output_tokens: f64,
    cache_write: f64,
    cache_read: f64,
    msgs: usize,
}
type Models = BTreeMap<String, Bucket>;
type Days = BTreeMap<String, BTreeMap<String, f64>>;
#[derive(Default, Serialize)]
struct Windows {
    today: Models,
    week: Models,
    month: Models,
    all: Models,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    scanned_files: usize,
    responses: usize,
    windows: Windows,
    by_day: Days,
    by_day_fresh: Days,
}
#[derive(Clone, Copy)]
struct Usage {
    fresh: f64,
    cached: f64,
    output: f64,
}
struct Event {
    ms: i64,
    day: String,
    model: String,
    current: Usage,
    last: Option<Usage>,
}
struct Fragment {
    derived: bool,
    meta_ms: Option<i64>,
    events: Vec<Event>,
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
// JS property keys and string concatenations coerce any truthy value. Records
// with a numeric/object requestId or model are rare but must not fail a scan.
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
fn js_or_default(v: &Value, fallback: &str) -> String {
    if truthy(v) {
        js_string(v)
    } else {
        fallback.into()
    }
}
// Node's `value || 0` followed by numeric accumulation. Non-numeric truthy
// values used to make Rust reject the whole scan; treating them as 0 keeps the
// scan alive like Node did without inventing token counts.
fn amount(v: &Value) -> f64 {
    if !truthy(v) {
        return 0.0;
    }
    v.as_f64().filter(|x| x.is_finite()).unwrap_or(0.0)
}
// JSON.parse failures in Node just skip the row; so should serde failures here.
fn parse_row(line: &str) -> Option<Row> {
    crate::json_lenient::from_str::<Row>(line).ok()
}
fn payload_of(row: &Row) -> &Value {
    if truthy(&row.payload) {
        &row.payload
    } else {
        &Value::Null
    }
}
fn exclusive(v: &Value) -> Option<Usage> {
    let input = v.get("input_tokens")?.as_f64()?;
    let cached = v.get("cached_input_tokens")?.as_f64()?;
    let output = v.get("output_tokens")?.as_f64()?;
    if ![input, cached, output]
        .iter()
        .all(|x| x.is_finite() && *x >= 0.0)
        || cached > input
    {
        return None;
    }
    Some(Usage {
        fresh: input - cached,
        cached,
        output,
    })
}
fn derived(meta: &Value) -> bool {
    let source = &meta["source"];
    truthy(&meta["forked_from_id"])
        || truthy(&meta["parent_thread_id"])
        || meta["thread_source"] == "subagent"
        || source == "subagent"
        || source
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == "subagent"))
        || truthy(&source["subagent"])
}
fn local_day(d: &DateTime<Tz>) -> String {
    // JS localDateKey() uses getFullYear() without zero padding.
    format!("{}-{:02}-{:02}", d.year(), d.month(), d.day())
}
// ECMAScript TimeClip keeps |ms| <= 8.64e15 and treats leap seconds as invalid.
fn from_instant(ms: i64, timezone: Tz) -> Option<(i64, String)> {
    if ms.unsigned_abs() > 8_640_000_000_000_000 {
        return None;
    }
    let d = Utc
        .timestamp_millis_opt(ms)
        .single()?
        .with_timezone(&timezone);
    if d.nanosecond() >= 1_000_000_000 {
        return None;
    }
    Some((d.timestamp_millis(), local_day(&d)))
}
fn utc_midnight(d: NaiveDate, timezone: Tz) -> Option<(i64, String)> {
    from_instant(
        d.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis(),
        timezone,
    )
}
fn localize(d: NaiveDateTime, offset: Option<i64>, timezone: Tz) -> Option<(i64, String)> {
    let ms = match offset {
        Some(minutes) => FixedOffset::east_opt((minutes * 60) as i32)?
            .from_local_datetime(&d)
            .single()?
            .timestamp_millis(),
        // JS picks the earlier side of an ambiguous local time (DST fall-back).
        None => timezone
            .from_local_datetime(&d)
            .earliest()?
            .timestamp_millis(),
    };
    from_instant(ms, timezone)
}
const LOCAL_FORMATS: [&str; 12] = [
    "%Y-%m-%dT%H:%M:%S%.f",
    "%Y-%m-%dT%H:%M",
    "%Y-%m-%d %H:%M:%S%.f",
    "%Y-%m-%d %H:%M",
    "%Y/%m/%d %H:%M:%S%.f",
    "%Y/%m/%d %H:%M",
    "%m/%d/%Y %H:%M:%S%.f",
    "%m/%d/%Y %H:%M",
    "%B %d, %Y %H:%M:%S%.f",
    "%B %d, %Y %H:%M",
    "%d %B %Y %H:%M:%S%.f",
    "%d %B %Y %H:%M",
];
const LOCAL_DATE_FORMATS: [&str; 6] = [
    "%Y/%m/%d",
    "%m/%d/%Y",
    "%B %d, %Y",
    "%b %d, %Y",
    "%d %B %Y",
    "%d %b %Y",
];
// Separate a trailing zone designator from a non-ISO local timestamp. Returns
// the wall-clock text and the offset in minutes east of UTC, when present.
fn split_offset(text: &str) -> (String, Option<i64>) {
    let t = text.trim();
    for (suffix, minutes) in [("UTC", 0), ("GMT", 0), ("Z", 0), ("z", 0)] {
        if let Some(head) = t.strip_suffix(suffix) {
            return (head.trim_end().to_string(), Some(minutes));
        }
    }
    if !t.contains(':') {
        return (t.to_string(), None);
    }
    let bytes = t.as_bytes();
    let at = if bytes.len() >= 6
        && matches!(bytes[bytes.len() - 6], b'+' | b'-')
        && bytes[bytes.len() - 3] == b':'
    {
        Some(bytes.len() - 6)
    } else if bytes.len() >= 5 && matches!(bytes[bytes.len() - 5], b'+' | b'-') {
        Some(bytes.len() - 5)
    } else {
        None
    };
    let Some(at) = at else {
        return (t.to_string(), None);
    };
    let sign = if bytes[at] == b'-' { -1 } else { 1 };
    let digits = &t[at + 1..];
    let parts: Vec<&str> = digits.split(':').collect();
    let (hours, minutes) = match parts.as_slice() {
        [h] if h.len() == 4 => (Some(&h[..2]), Some(&h[2..])),
        [h, m] => (Some(*h), Some(*m)),
        _ => (None, None),
    };
    match (hours.map(str::parse::<i64>), minutes.map(str::parse::<i64>)) {
        (Some(Ok(h)), Some(Ok(m))) if h <= 23 && m <= 59 => {
            (t[..at].trim_end().to_string(), Some(sign * (h * 60 + m)))
        }
        _ => (t.to_string(), None),
    }
}
fn timestamp(value: &Value, timezone: Tz) -> Option<(i64, String)> {
    // new Date(null) is the epoch; a missing (undefined) timestamp is invalid.
    let text = match value {
        Value::Null => return from_instant(0, timezone),
        Value::Bool(b) => return from_instant(i64::from(*b), timezone),
        Value::Number(n) => {
            let ms = n.as_f64().filter(|x| x.is_finite())?;
            return from_instant(ms.trunc() as i64, timezone);
        }
        Value::String(s) => s.trim().to_string(),
        _ => return None,
    };
    if text.is_empty() {
        return None;
    }
    // JS Date rejects leap seconds; chrono would otherwise normalize :60.
    if text.contains(":60") {
        return None;
    }
    if let Ok(d) = DateTime::parse_from_rfc3339(&text) {
        return from_instant(d.timestamp_millis(), timezone);
    }
    if let Ok(d) = DateTime::parse_from_rfc2822(&text) {
        return from_instant(d.timestamp_millis(), timezone);
    }
    // ISO date-only strings are UTC midnights, unlike the other date formats.
    if let Ok(d) = NaiveDate::parse_from_str(&text, "%Y-%m-%d") {
        return utc_midnight(d, timezone);
    }
    let (wall, offset) = split_offset(&text);
    for format in LOCAL_FORMATS {
        if let Ok(d) = NaiveDateTime::parse_from_str(&wall, format) {
            return localize(d, offset, timezone);
        }
    }
    // Non-ISO local dates ("2026/11/05", "July 19, 2026") are local midnights.
    for format in LOCAL_DATE_FORMATS {
        if let Ok(d) = NaiveDate::parse_from_str(&wall, format) {
            return localize(d.and_hms_opt(0, 0, 0)?, offset, timezone);
        }
    }
    None
}
fn add(target: &mut Models, model: &str, i: f64, o: f64, cw: f64, cr: f64) {
    let b = target.entry(model.into()).or_default();
    b.input_tokens += i;
    b.output_tokens += o;
    b.cache_write += cw;
    b.cache_read += cr;
    b.msgs += 1;
}
fn record(out: &mut Output, w: &Bounds, day: &str, model: &str, values: [f64; 4]) {
    let [i, o, cw, cr] = values;
    add(&mut out.windows.all, model, i, o, cw, cr);
    if day >= w.month.as_str() && day <= w.today.as_str() {
        add(&mut out.windows.month, model, i, o, cw, cr);
    }
    if day >= w.week.as_str() && day <= w.today.as_str() {
        add(&mut out.windows.week, model, i, o, cw, cr);
    }
    if day == w.today {
        add(&mut out.windows.today, model, i, o, cw, cr);
    }
    *out.by_day
        .entry(day.into())
        .or_default()
        .entry(model.into())
        .or_default() += i + o + cw + cr;
    *out.by_day_fresh
        .entry(day.into())
        .or_default()
        .entry(model.into())
        .or_default() += i + o;
}
fn lines(file: &str, mut visit: impl FnMut(&str) -> Result<(), String>) -> Result<(), String> {
    let Ok(file) = File::open(file) else {
        return Ok(());
    };
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut line = Vec::new();
    loop {
        line.clear();
        let Ok(n) = reader.read_until(b'\n', &mut line) else {
            // Node's readFile() failed file reads whole-scan; a partial read is
            // closer to the old behavior than rejecting every prior count.
            break;
        };
        if n == 0 {
            break;
        }
        visit(&String::from_utf8_lossy(&line))?;
    }
    Ok(())
}
fn parse_fragment(file: &str, timezone: Tz) -> Result<(Value, Fragment), String> {
    let mut meta = Value::Null;
    let mut has_meta = false;
    let mut meta_ms = None;
    let mut model = "codex".to_owned();
    let mut events = Vec::new();
    lines(file, |line| {
        if !line.contains("\"session_meta\"")
            && !line.contains("\"token_count\"")
            && !line.contains("\"model\"")
        {
            return Ok(());
        }
        // Node skips lines JSON.parse cannot read (including overflowing
        // numbers); truncation must never fail the whole scan.
        let Some(row) = parse_row(line) else {
            return Ok(());
        };
        let p = payload_of(&row);
        if row.kind == "session_meta" {
            if !has_meta {
                // `p && typeof p === 'object' ? p : {}` — arrays count.
                meta = if p.is_object() || p.is_array() {
                    p.clone()
                } else {
                    Value::Null
                };
                meta_ms = row
                    .timestamp
                    .as_ref()
                    .and_then(|ts| timestamp(ts, timezone))
                    .map(|x| x.0);
                has_meta = true;
            }
            return Ok(());
        }
        if truthy(&p["model"]) {
            model = js_or_default(&p["model"], "codex");
        }
        if row.kind != "event_msg" || p["type"] != "token_count" {
            return Ok(());
        }
        let info = &p["info"];
        let Some(current) = exclusive(&info["total_token_usage"]) else {
            return Ok(());
        };
        // Codex skips events whose timestamp JS Date cannot parse (unlike
        // Claude rows, which fall into the "NaN-NaN-NaN" diagnostic bucket).
        let Some(ts) = row.timestamp.as_ref() else {
            return Ok(());
        };
        let Some((ms, day)) = timestamp(ts, timezone) else {
            return Ok(());
        };
        let last = exclusive(&info["last_token_usage"]).filter(|last| {
            last.fresh <= current.fresh
                && last.cached <= current.cached
                && last.output <= current.output
        });
        events.push(Event {
            ms,
            day,
            model: model.clone(),
            current,
            last,
        });
        Ok(())
    })?;
    let fragment = Fragment {
        derived: derived(&meta),
        meta_ms,
        events,
    };
    Ok((meta, fragment))
}
fn replay_prefix(f: &Fragment) -> usize {
    if !f.derived || f.events.len() < 2 {
        return 0;
    }
    let Some(meta) = f.meta_ms else {
        return 0;
    };
    if f.events[0].ms < meta || f.events[0].ms - meta > 100 {
        return 0;
    }
    let mut n = 1;
    while n < f.events.len() {
        let delta = f.events[n].ms - f.events[n - 1].ms;
        if !(0..=100).contains(&delta) {
            break;
        }
        n += 1;
    }
    if n >= 2 {
        n
    } else {
        0
    }
}
pub fn compute(json: &str) -> Result<String, String> {
    let input: Input = crate::json_lenient::from_str(json).map_err(|_| "invalid_usage_input")?;
    let timezone: Tz = input
        .timezone
        .parse()
        .map_err(|_| "unsupported_usage_timezone")?;
    let mut out = Output {
        scanned_files: input.claude_files.len() + input.codex_files.len(),
        ..Default::default()
    };
    let mut seen = HashSet::new();
    for file in &input.claude_files {
        lines(file, |line| {
            if !line.contains("\"usage\"") {
                return Ok(());
            }
            // Node skips unreadable lines instead of failing the scan.
            let Some(row) = parse_row(line) else {
                return Ok(());
            };
            let Some(ts) = row.timestamp.as_ref() else {
                return Ok(());
            };
            let m = &row.message;
            // `if (!ts || !m || !m.usage) continue;`
            if !truthy(ts) || !truthy(&m["usage"]) {
                return Ok(());
            }
            let u = &m["usage"];
            let values = [
                amount(&u["input_tokens"]),
                amount(&u["output_tokens"]),
                amount(&u["cache_creation_input_tokens"]),
                amount(&u["cache_read_input_tokens"]),
            ];
            if values.iter().sum::<f64>() == 0.0 {
                return Ok(());
            }
            let rid = js_or_default(&row.request_id, "");
            let mid = js_or_default(
                if truthy(&m["id"]) {
                    &m["id"]
                } else {
                    &row.uuid
                },
                "",
            );
            if !seen.insert(format!("{rid}:{mid}")) {
                return Ok(());
            }
            // JS keeps unparseable Claude timestamps as "NaN-NaN-NaN"; they
            // stay in all/byDay for diagnostics but never enter today/week/month.
            let day = timestamp(ts, timezone)
                .map(|x| x.1)
                .unwrap_or_else(|| "NaN-NaN-NaN".into());
            record(
                &mut out,
                &input.windows,
                &day,
                &js_or_default(&m["model"], "unknown"),
                values,
            );
            out.responses += 1;
            Ok(())
        })?;
    }
    // 保留 Node 给定的排序和首次出现顺序，线程续接共享同一累计基线。
    let mut groups: Vec<Vec<Fragment>> = Vec::new();
    let mut group_ids = HashMap::new();
    for file in &input.codex_files {
        let (meta, fragment) = parse_fragment(file, timezone)?;
        let identity = [&meta["id"], &meta["session_id"], &meta["thread_id"]]
            .into_iter()
            .find(|v| truthy(v));
        let key = if let Some(id) = identity {
            format!("thread:{}", js_or_default(id, ""))
        } else {
            format!("file:{file}")
        };
        let index = *group_ids.entry(key).or_insert_with(|| {
            groups.push(Vec::new());
            groups.len() - 1
        });
        groups[index].push(fragment);
    }
    for fragments in groups {
        let is_derived = fragments.iter().any(|f| f.derived);
        let mut high: Option<Usage> = None;
        for fragment in fragments {
            let prefix = replay_prefix(&fragment);
            for (index, event) in fragment.events.into_iter().enumerate() {
                let cur = event.current;
                let usage = if let Some(previous) = high {
                    if cur.fresh < previous.fresh
                        || cur.cached < previous.cached
                        || cur.output < previous.output
                    {
                        continue;
                    }
                    Some(Usage {
                        fresh: cur.fresh - previous.fresh,
                        cached: cur.cached - previous.cached,
                        output: cur.output - previous.output,
                    })
                } else if is_derived {
                    event.last
                } else {
                    Some(cur)
                };
                high = Some(cur);
                if index < prefix {
                    continue;
                }
                if let Some(u) = usage {
                    if u.fresh + u.output + u.cached <= 0.0 {
                        continue;
                    }
                    record(
                        &mut out,
                        &input.windows,
                        &event.day,
                        &event.model,
                        [u.fresh, u.output, 0.0, u.cached],
                    );
                    if u.output > 0.0 {
                        out.responses += 1;
                    }
                }
            }
        }
    }
    serde_json::to_string(&out).map_err(|_| "usage_result_encode".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "multicc-usage-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn tz(name: &str) -> Tz {
        name.parse().unwrap()
    }
    fn input(claude: &Path, codex: &Path) -> String {
        json!({
            "claudeFiles": [claude.to_string_lossy()],
            "codexFiles": [codex.to_string_lossy()],
            "windows": { "today": "2026-07-19", "week": "2026-07-13", "month": "2026-07-01" },
            "timezone": "UTC",
        })
        .to_string()
    }
    fn compute_value(json: &str) -> Value {
        serde_json::from_str(&compute(json).unwrap()).unwrap()
    }

    #[test]
    fn timestamp_accepts_non_iso_local_times() {
        let utc = tz("UTC");
        for text in [
            "July 19, 2026 12:00:00",
            "Jul 19, 2026 12:00:00",
            "2026-07-19 12:00:00",
            "2026-07-19T12:00:00",
            "2026/07/19 12:00:00",
            "07/19/2026 12:00:00",
        ] {
            let (_, day) = timestamp(&json!(text), utc).unwrap_or_else(|| panic!("{text}"));
            assert_eq!(day, "2026-07-19", "{text}");
        }
        assert_eq!(
            timestamp(&json!("July 19, 2026"), utc).unwrap().1,
            "2026-07-19"
        );
    }

    #[test]
    fn timestamp_rejects_leap_seconds_like_js_date() {
        let utc = tz("UTC");
        assert!(timestamp(&json!("2016-12-31T23:59:60Z"), utc).is_none());
        assert!(timestamp(&json!("2016-12-31 23:59:60"), utc).is_none());
    }

    #[test]
    fn timestamp_keeps_small_years_unpadded() {
        let utc = tz("UTC");
        assert_eq!(
            timestamp(&json!("0026-01-01T00:00:00Z"), utc).unwrap().1,
            "26-01-01"
        );
    }

    #[test]
    fn timestamp_date_only_is_utc_midnight() {
        // JS parses "YYYY-MM-DD" as UTC, so New York sees the previous day.
        assert_eq!(
            timestamp(&json!("2026-11-01"), tz("America/New_York"))
                .unwrap()
                .1,
            "2026-10-31"
        );
        assert_eq!(
            timestamp(&json!("2026-11-01"), tz("Asia/Shanghai"))
                .unwrap()
                .1,
            "2026-11-01"
        );
    }

    #[test]
    fn claude_rows_tolerate_lone_surrogates_and_bucket_invalid_dates() {
        let dir = temp_dir();
        let claude = dir.join("claude.jsonl");
        // The first requestId carries a lone surrogate escape, which JS
        // JSON.parse accepted but strict serde used to reject.
        std::fs::write(
            &claude,
            concat!(
                "{\"timestamp\":\"2026-07-19T01:00:00Z\",\"requestId\":\"\\ud800\",\"message\":{\"id\":\"a\",\"model\":\"m\",\"usage\":{\"input_tokens\":9}}}\n",
                "{\"timestamp\":\"2016-12-31T23:59:60Z\",\"requestId\":\"b\",\"message\":{\"id\":\"b\",\"model\":\"m\",\"usage\":{\"input_tokens\":3}}}\n",
                "{\"timestamp\":\"2026-07-19T01:00:00Z\",\"requestId\":\"c\",\"message\":\"not-an-object\"}\n",
            ),
        )
        .unwrap();
        let value = compute_value(&input(&claude, &dir.join("absent.jsonl")));
        assert_eq!(value["responses"], 2);
        assert_eq!(value["windows"]["all"]["m"]["inputTokens"], 12.0);
        assert_eq!(value["windows"]["today"]["m"]["inputTokens"], 9.0);
        assert_eq!(value["byDay"]["2026-07-19"]["m"], 9.0);
        assert_eq!(value["byDay"]["NaN-NaN-NaN"]["m"], 3.0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn codex_events_with_invalid_timestamps_are_skipped() {
        let dir = temp_dir();
        let codex = dir.join("codex.jsonl");
        let line = |timestamp: &str, input: i64| {
            format!(
                "{{\"type\":\"event_msg\",\"timestamp\":\"{timestamp}\",\"payload\":{{\"type\":\"token_count\",\"info\":{{\"total_token_usage\":{{\"input_tokens\":{input},\"cached_input_tokens\":40,\"output_tokens\":10}}}}}}}}\n"
            )
        };
        let mut text = String::from(
            "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-19T00:00:00Z\",\"payload\":{\"id\":\"thread\"}}\n",
        );
        text.push_str(&line("2026-07-19T01:00:00Z", 100));
        text.push_str(&line("not a date", 200));
        std::fs::write(&codex, text).unwrap();
        let value = compute_value(&input(&dir.join("absent.jsonl"), &codex));
        assert_eq!(value["responses"], 1);
        assert_eq!(value["byDay"]["2026-07-19"]["codex"], 110.0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn codex_payloads_that_are_not_objects_are_ignored() {
        let dir = temp_dir();
        let codex = dir.join("codex.jsonl");
        std::fs::write(
            &codex,
            concat!(
                "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-19T00:00:00Z\",\"payload\":\"nope\"}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-19T01:00:00Z\",\"payload\":\"nope\"}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-19T01:00:01Z\",\"payload\":null}\n",
            ),
        )
        .unwrap();
        let value = compute_value(&input(&dir.join("absent.jsonl"), &codex));
        assert_eq!(value["responses"], 0);
        assert_eq!(value["byDay"], json!({}));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
