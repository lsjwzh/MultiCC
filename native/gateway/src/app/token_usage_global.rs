//! `GET/HEAD/OPTIONS /api/token-usage/global` (was src/token-global.js plus
//! the route in src/routes/token-usage.js).
//!
//! The aggregation itself already lived in `multicc_core::usage`; Node owned
//! only the file walk (`~/.claude/projects/**/*.jsonl` in readdir order,
//! `~/.codex/sessions/**/*.jsonl` sorted), the local-time window boundaries
//! (today / Monday-week / month-1st), the `generatedAt` stamp and the 120s
//! cache with its in-flight dedupe. Those moved here with the route.
//!
//! libuv's `readdir` returns names sorted by `strcmp`, so the walk sorts each
//! directory by name bytes and recurses in that order; the codex list is then
//! sorted with JavaScript's default comparator (UTF-16 code units). The
//! kernel keeps the rest of the Node semantics.
//!
//! Known difference from Node, documented in docs/gateway.md §9: concurrent
//! requests are serialized on this module's mutex instead of sharing one
//! in-flight promise, so a `?refresh=1` that arrives during another scan runs
//! its own scan afterwards (Node returned the in-flight result).
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{Datelike, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use multicc_core::http_gate::{query_value, QueryValue};
use serde_json::{json, Map, Value};

/// What the retired Node route answered when the scan threw.
pub const PUBLIC_ERROR: &str = "Token usage is temporarily unavailable";
pub const CACHE_TTL_MS: i64 = 120 * 1000;

struct Entry {
    /// `Date.now()` after the scan finished, like the retired module.
    at_ms: i64,
    /// Serialized answer, `generatedAt` included, so a cache hit is byte
    /// identical to the scan that produced it.
    body: String,
}

/// One cache slot per gateway process: both the retired Node module and this
/// route keep the aggregate in memory for the process lifetime.
#[derive(Default)]
pub struct State {
    cache: Option<Entry>,
}

pub type Shared = Mutex<State>;

/// Answers one request: `(status, JSON text)`.
pub fn answer(
    home: &Path,
    original_url: &str,
    clock: fn() -> i64,
    state: &mut State,
) -> (u16, String) {
    // The route compared `req.query.refresh === '1'` strictly, so an array or
    // any other spelling never forces a rescan.
    let force = matches!(
        query_value(original_url, "refresh"),
        QueryValue::Text(ref text) if text == "1"
    );
    let now = clock();
    if !force {
        if let Some(entry) = state.cache.as_ref() {
            if now - entry.at_ms < CACHE_TTL_MS {
                return (200, entry.body.clone());
            }
        }
    }
    match scan(home, now, clock) {
        Ok(body) => {
            // Node stamped the cache after the scan, not at request start.
            let at_ms = clock();
            state.cache = Some(Entry {
                at_ms,
                body: body.clone(),
            });
            (200, body)
        }
        Err(error) => {
            crate::app::express::log_line(
                "warn",
                "token_usage_global_read_failed",
                &[("error", json!(error))],
            );
            (500, failure_body())
        }
    }
}

fn failure_body() -> String {
    multicc_core::js::serde::js_json_stringify(&json!({ "error": PUBLIC_ERROR }))
}

/// The scan itself: resolve the zone, walk both trees, run the kernel.
fn scan(home: &Path, start_ms: i64, clock: impl Fn() -> i64) -> Result<String, String> {
    let timezone = system_timezone().ok_or_else(|| "unsupported_usage_timezone".to_string())?;
    scan_in(home, timezone, start_ms, clock)
}

/// `scan` with the timezone resolved by the caller (deterministic tests).
fn scan_in(
    home: &Path,
    timezone: Tz,
    start_ms: i64,
    clock: impl Fn() -> i64,
) -> Result<String, String> {
    let windows = window_starts(timezone, start_ms)?;
    let projects = home.join(".claude").join("projects");
    let codex = home.join(".codex").join("sessions");

    let mut claude_files = Vec::new();
    collect_jsonl(&projects, &mut claude_files);
    let mut codex_files = Vec::new();
    collect_jsonl(&codex, &mut codex_files);
    codex_files.sort_by_key(|left| utf16(left));

    let input = json!({
        "claudeFiles": claude_files,
        "codexFiles": codex_files,
        "windows": windows,
        "timezone": timezone.name(),
    });
    let aggregated = multicc_core::usage::compute(&input.to_string())?;
    let data: Value =
        serde_json::from_str(&aggregated).map_err(|_| "invalid_usage_result".to_string())?;

    // `{ generatedAt, sources, ...data }` in that order: Node parsed the kernel
    // string, spread it after the two wrapper fields and re-stringified.
    let mut out = Map::new();
    out.insert("generatedAt".into(), json!(iso_utc(clock())?));
    out.insert(
        "sources".into(),
        json!({
            "claude": projects.to_string_lossy(),
            "codex": codex.to_string_lossy(),
        }),
    );
    if let Value::Object(map) = data {
        for (key, value) in map {
            out.insert(key, value);
        }
    }
    Ok(multicc_core::js::serde::js_json_stringify(&Value::Object(
        out,
    )))
}

/// The window keys the retired module built from `new Date()`: local today, the
/// Monday of the current local week, and the first of the current local month.
fn window_starts(timezone: Tz, now_ms: i64) -> Result<Value, String> {
    let now = Utc
        .timestamp_millis_opt(now_ms)
        .single()
        .ok_or_else(|| "invalid_usage_clock".to_string())?
        .with_timezone(&timezone);
    let today = now.date_naive();
    // JS `setDate(getDate() - ((getDay() + 6) % 7))`: `num_days_from_monday`
    // is that offset (Monday = 0).
    let week = today
        .checked_sub_days(chrono::Days::new(
            now.weekday().num_days_from_monday() as u64
        ))
        .ok_or_else(|| "invalid_usage_clock".to_string())?;
    let month =
        NaiveDate::from_ymd_opt(today.year(), today.month(), 1).expect("first of the month");
    Ok(json!({
        "today": local_date_key(today),
        "week": local_date_key(week),
        "month": local_date_key(month),
    }))
}

/// `localDateKey()`: the year is not zero-padded, month and day are.
fn local_date_key(date: NaiveDate) -> String {
    format!("{}-{:02}-{:02}", date.year(), date.month(), date.day())
}

/// `new Date(ms).toISOString()`.
fn iso_utc(ms: i64) -> Result<String, String> {
    let stamp = Utc
        .timestamp_millis_opt(ms)
        .single()
        .ok_or_else(|| "invalid_usage_clock".to_string())?;
    Ok(stamp.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

/// Depth-first walk in libuv's `strcmp` name order. A missing or unreadable
/// directory contributes nothing, like the retired `listJsonl` catch.
fn collect_jsonl(dir: &Path, out: &mut Vec<String>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<(String, PathBuf, bool, bool)> = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        entries.push((name, entry.path(), file_type.is_dir(), file_type.is_file()));
    }
    entries.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
    for (name, path, is_dir, is_file) in entries {
        if is_dir {
            collect_jsonl(&path, out);
        } else if is_file && name.ends_with(".jsonl") {
            out.push(path.to_string_lossy().into_owned());
        }
    }
}

/// JavaScript's default `Array#sort` compares UTF-16 code units.
fn utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// `Intl.DateTimeFormat().resolvedOptions().timeZone`: `TZ` when set, otherwise
/// the system zone. An explicitly set but unusable `TZ` makes Intl return
/// `undefined`, which the retired module serialized as a missing `timezone`
/// and the kernel rejected — so it is an error here too, not a UTC fallback.
fn system_timezone() -> Option<Tz> {
    let tz_env = std::env::var_os("TZ").map(|value| value.to_string_lossy().into_owned());
    let localtime = std::fs::read_link("/etc/localtime")
        .ok()
        .map(|target| target.to_string_lossy().into_owned());
    let timezone_file = std::fs::read_to_string("/etc/timezone").ok();
    resolve_timezone(
        tz_env.as_deref(),
        localtime.as_deref(),
        timezone_file.as_deref(),
    )
}

fn resolve_timezone(
    tz_env: Option<&str>,
    localtime: Option<&str>,
    timezone_file: Option<&str>,
) -> Option<Tz> {
    if let Some(raw) = tz_env {
        // ICU accepts a leading ':' (":Asia/Shanghai").
        let name = raw.strip_prefix(':').unwrap_or(raw);
        return name.parse::<Tz>().ok();
    }
    if let Some(target) = localtime {
        if let Some((_, zone)) = target.split_once("zoneinfo/") {
            if let Ok(timezone) = zone.parse::<Tz>() {
                return Some(timezone);
            }
        }
    }
    if let Some(text) = timezone_file {
        if let Ok(timezone) = text.trim().parse::<Tz>() {
            return Some(timezone);
        }
    }
    "UTC".parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "multicc-token-usage-global-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn claude_row(timestamp: &str, request: &str, model: &str, input: f64, output: f64) -> String {
        json!({
            "timestamp": timestamp,
            "requestId": request,
            "type": "assistant",
            "message": {
                "id": request,
                "model": model,
                "usage": {
                    "input_tokens": input,
                    "output_tokens": output,
                    "cache_creation_input_tokens": 2,
                    "cache_read_input_tokens": 3,
                }
            }
        })
        .to_string()
    }

    fn write_claude(home: &Path, relative: &str, rows: &[&str]) -> PathBuf {
        let file = home.join(".claude").join("projects").join(relative);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, rows.join("\n") + "\n").unwrap();
        file
    }

    fn shanghai_ms(month: u32, day: u32, hour: u32) -> i64 {
        Utc.with_ymd_and_hms(2026, month, day, hour, 0, 0)
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn readdir_walk_follows_libuv_name_order_and_recurses_in_place() {
        let root = scratch();
        let projects = root.join(".claude/projects");
        std::fs::create_dir_all(projects.join("b-project/nested")).unwrap();
        std::fs::create_dir_all(projects.join("a-project")).unwrap();
        std::fs::write(projects.join("b-project/nested/z.jsonl"), "").unwrap();
        std::fs::write(projects.join("b-project/a.jsonl"), "").unwrap();
        std::fs::write(projects.join("a-project/m.jsonl"), "").unwrap();
        std::fs::write(projects.join("a-project/ignored.txt"), "").unwrap();
        let mut files = Vec::new();
        collect_jsonl(&projects, &mut files);
        let paths: Vec<PathBuf> = files.iter().map(PathBuf::from).collect();
        // "a-project" sorts before "b-project"; inside b-project "a.jsonl"
        // sorts before the directory "nested" ('a' < 'n'), so the nested file
        // follows it — the Node loop recurses at the name's sorted position.
        assert_eq!(
            paths,
            vec![
                projects.join("a-project/m.jsonl"),
                projects.join("b-project/a.jsonl"),
                projects.join("b-project/nested/z.jsonl"),
            ]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn codex_files_are_sorted_by_utf16_code_units() {
        let mut files: Vec<String> = vec!["b.jsonl".into(), "B.jsonl".into(), "a.jsonl".into()];
        files.sort_by_key(|left| utf16(left));
        assert_eq!(files, vec!["B.jsonl", "a.jsonl", "b.jsonl"]);
    }

    #[test]
    fn windows_follow_the_local_calendar() {
        let timezone: Tz = "Asia/Shanghai".parse().unwrap();
        // 2026-11-11 is a Wednesday; 12:00Z is 20:00 in Shanghai.
        assert_eq!(
            window_starts(timezone, shanghai_ms(11, 11, 12)).unwrap(),
            json!({"today": "2026-11-11", "week": "2026-11-09", "month": "2026-11-01"})
        );
        // 2026-11-01T20:00Z is already Monday 2026-11-02 in Shanghai.
        let late = window_starts(timezone, shanghai_ms(11, 1, 20)).unwrap();
        assert_eq!(late["today"], "2026-11-02");
        assert_eq!(late["week"], "2026-11-02");
        assert_eq!(late["month"], "2026-11-01");
        // Sunday belongs to the Monday that started six days earlier.
        assert_eq!(
            window_starts(timezone, shanghai_ms(11, 8, 4)).unwrap()["week"],
            "2026-11-02"
        );
    }

    #[test]
    fn timezone_resolution_matches_the_intl_contract() {
        assert_eq!(
            resolve_timezone(None, Some("/var/db/timezone/zoneinfo/Asia/Tokyo"), None),
            "Asia/Tokyo".parse().ok()
        );
        assert_eq!(
            resolve_timezone(None, None, Some("Europe/Paris\n")),
            "Europe/Paris".parse().ok()
        );
        assert_eq!(resolve_timezone(None, None, None), "UTC".parse().ok());
        assert_eq!(
            resolve_timezone(Some(":Asia/Shanghai"), None, None),
            "Asia/Shanghai".parse().ok()
        );
        // Intl yields undefined for these, and the kernel then refuses the scan.
        assert_eq!(resolve_timezone(Some("Bogus/Zone"), None, None), None);
        assert_eq!(resolve_timezone(Some(""), None, None), None);
    }

    #[test]
    fn scan_aggregates_dedupes_and_stamps_the_windows() {
        let root = scratch();
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        // 2026-11-11T03:00Z is today in Shanghai.
        let row = claude_row("2026-11-11T03:00:00Z", "req-1", "claude-test", 10.0, 5.0);
        let duplicate = row.clone();
        let older = claude_row("2026-10-01T03:00:00Z", "req-old", "claude-old", 7.0, 1.0);
        write_claude(
            &home,
            "p1/session.jsonl",
            &[row.as_str(), duplicate.as_str(), older.as_str()],
        );
        let codex = home.join(".codex/sessions/2026/11/11/rollout.jsonl");
        std::fs::create_dir_all(codex.parent().unwrap()).unwrap();
        std::fs::write(
            &codex,
            concat!(
                "{\"type\":\"session_meta\",\"timestamp\":\"2026-11-11T02:00:00Z\",\"payload\":{\"id\":\"thread\"}}\n",
                "{\"type\":\"turn_context\",\"timestamp\":\"2026-11-11T02:00:01Z\",\"payload\":{\"model\":\"gpt-test\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-11-11T03:00:00Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":100,\"cached_input_tokens\":40,\"output_tokens\":10}}}}\n",
            ),
        )
        .unwrap();

        let now = shanghai_ms(11, 11, 4);
        let body = scan_in(&home, "Asia/Shanghai".parse().unwrap(), now, move || {
            now + 25
        })
        .unwrap();
        let value: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["scannedFiles"], 2);
        assert_eq!(value["responses"], 3.0);
        assert_eq!(
            value["sources"]["claude"],
            json!(home.join(".claude").join("projects").to_string_lossy())
        );
        assert_eq!(
            value["sources"]["codex"],
            json!(home.join(".codex").join("sessions").to_string_lossy())
        );
        assert_eq!(value["generatedAt"], "2026-11-11T04:00:00.025Z");
        let claude_all = &value["windows"]["all"]["claude-test"];
        assert_eq!(claude_all["inputTokens"], 10.0);
        assert_eq!(claude_all["outputTokens"], 5.0);
        assert_eq!(claude_all["cacheWrite"], 2.0);
        assert_eq!(claude_all["cacheRead"], 3.0);
        assert_eq!(claude_all["msgs"], 1);
        assert_eq!(value["windows"]["today"]["claude-test"], *claude_all);
        assert_eq!(value["windows"]["all"]["claude-old"]["inputTokens"], 7.0);
        assert!(value["windows"]["month"].get("claude-old").is_none());
        assert_eq!(value["windows"]["all"]["gpt-test"]["inputTokens"], 60.0);
        assert_eq!(value["windows"]["all"]["gpt-test"]["cacheRead"], 40.0);
        assert_eq!(value["windows"]["today"]["gpt-test"]["inputTokens"], 60.0);
        assert_eq!(value["byDay"]["2026-11-11"]["claude-test"], 20.0);
        assert_eq!(value["byDayFresh"]["2026-11-11"]["claude-test"], 15.0);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn cache_hits_reuse_the_exact_body_and_refresh_rescans() {
        let root = scratch();
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let first_row = claude_row("2026-11-11T03:00:00Z", "req-1", "claude-test", 10.0, 5.0);
        write_claude(&home, "p1/a.jsonl", &[first_row.as_str()]);
        let now = shanghai_ms(11, 11, 4);
        let mut state = State::default();
        let (status, first) = answer_at(&home, "/api/token-usage/global", &mut state, now);
        assert_eq!(status, 200);
        // A new file alone is invisible: the answer is cached.
        let second_row = claude_row("2026-11-11T03:30:00Z", "req-2", "claude-test", 1.0, 1.0);
        write_claude(&home, "p1/b.jsonl", &[second_row.as_str()]);
        let (status, second) = answer_at(&home, "/api/token-usage/global", &mut state, now + 1000);
        assert_eq!(status, 200);
        assert_eq!(second, first);
        // refresh=1 forces a rescan that sees the new file.
        let (status, third) = answer_at(
            &home,
            "/api/token-usage/global?refresh=1",
            &mut state,
            now + 2000,
        );
        assert_eq!(status, 200);
        assert_ne!(third, first);
        let value: Value = serde_json::from_str(&third).unwrap();
        assert_eq!(value["scannedFiles"], 2);
        assert_eq!(value["windows"]["all"]["claude-test"]["msgs"], 2);
        // A different spelling never forces.
        let (_, fourth) = answer_at(
            &home,
            "/api/token-usage/global?refresh=true",
            &mut state,
            now + 3000,
        );
        assert_eq!(fourth, third);
        // An expired TTL rescans (the entry was stamped at now + 2000).
        let (_, fifth) = answer_at(
            &home,
            "/api/token-usage/global",
            &mut state,
            now + 2000 + CACHE_TTL_MS,
        );
        assert_ne!(fifth, third);
        let _ = std::fs::remove_dir_all(root);
    }

    fn answer_at(home: &Path, original_url: &str, state: &mut State, now_ms: i64) -> (u16, String) {
        let force = matches!(
            query_value(original_url, "refresh"),
            QueryValue::Text(ref text) if text == "1"
        );
        if !force {
            if let Some(entry) = state.cache.as_ref() {
                if now_ms - entry.at_ms < CACHE_TTL_MS {
                    return (200, entry.body.clone());
                }
            }
        }
        match scan_in(home, "Asia/Shanghai".parse().unwrap(), now_ms, move || {
            now_ms
        }) {
            Ok(body) => {
                state.cache = Some(Entry {
                    at_ms: now_ms,
                    body: body.clone(),
                });
                (200, body)
            }
            Err(_) => (500, failure_body()),
        }
    }

    #[test]
    fn the_public_500_body_is_stable() {
        assert_eq!(
            failure_body(),
            "{\"error\":\"Token usage is temporarily unavailable\"}"
        );
    }
}
