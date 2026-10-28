//! Per-provider quota history samples.
//!
//! `provider-limit-cache` keeps only the last known window/balance reading per
//! provider, which is enough for a bar but cannot show a trend. This module owns
//! a dedicated SQLite file that appends one sample per series whenever a
//! successful reading is recorded, and answers compact downsampled series for
//! the provider cards (`public/air-provider-trend.js`).
//!
//! Contract:
//!   - One row per (app_type, provider_id, series, sampled_at); `series` is a
//!     normalized cycle token (`5h` / `1wk` / `1m`) or `balance`.
//!   - Window readings store REMAINING percent (0..100), matching what the bar
//!     shows. Balance readings store the available amount plus its unit.
//!   - At most one sample per series per `MIN_INTERVAL_MS`, unless the reset
//!     time changed (a new window deserves a fresh point even right after the
//!     previous one). Out-of-order readings are ignored.
//!   - Readings older than the retention window are pruned at most once an hour.
//!   - Every input is untrusted: lengths are bounded, numbers must be finite,
//!     and unknown shapes are dropped rather than stored.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_SERIES: usize = 8;
const MAX_KEY: usize = 40;
const MAX_LABEL: usize = 24;
const MAX_UNIT: usize = 12;
const MAX_PROVIDERS: usize = 64;
const MAX_POINTS: usize = 240;
const DEFAULT_RETENTION_MS: i64 = 14 * 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS: i64 = 5 * 60 * 1000;
const PRUNE_INTERVAL_MS: i64 = 60 * 60 * 1000;

pub struct History {
    connection: Connection,
    retention_ms: i64,
    last_prune_ms: i64,
}

struct Sample {
    key: String,
    label: String,
    unit: String,
    value: f64,
    reset_at: Option<i64>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn create_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS provider_quota_samples (
            app_type TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            series TEXT NOT NULL,
            sampled_at INTEGER NOT NULL,
            remaining REAL NOT NULL,
            label TEXT,
            unit TEXT NOT NULL,
            reset_at INTEGER,
            PRIMARY KEY (app_type, provider_id, series, sampled_at)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_provider_quota_samples_time
            ON provider_quota_samples(sampled_at);",
    )
}

impl History {
    pub fn open(file: &str, retention_ms: Option<i64>) -> rusqlite::Result<Self> {
        let connection = Connection::open(file)?;
        connection.busy_timeout(Duration::from_millis(5000))?;
        // Readers run in the server process while probes may open the same file:
        // WAL keeps a long read from blocking the append.
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        create_schema(&connection)?;
        Ok(Self {
            connection,
            retention_ms: retention_ms
                .unwrap_or(DEFAULT_RETENTION_MS)
                .max(MIN_INTERVAL_MS),
            last_prune_ms: 0,
        })
    }

    #[cfg(test)]
    fn memory() -> Self {
        let connection = Connection::open_in_memory().expect("in-memory database");
        create_schema(&connection).expect("schema");
        Self {
            connection,
            retention_ms: DEFAULT_RETENTION_MS,
            last_prune_ms: 0,
        }
    }

    /// Append the series carried by one cache entry. Returns the number of
    /// rows actually written (dedupe and invalid rows are skipped).
    pub fn record(&mut self, input: &str) -> Result<String, String> {
        let value: Value = serde_json::from_str(input).map_err(|e| e.to_string())?;
        let app_type = clean_text(field(&value, "appType"), MAX_KEY)
            .ok_or_else(|| "missing appType".to_string())?;
        let provider_id = clean_text(field(&value, "providerId"), MAX_KEY)
            .ok_or_else(|| "missing providerId".to_string())?;
        let summary = value
            .get("summary")
            .filter(|summary| summary.is_object())
            .cloned()
            .ok_or_else(|| "missing summary".to_string())?;
        let sampled_at = number(&value, "sampledAt")
            .map(|n| n as i64)
            .unwrap_or_else(now_ms);
        if sampled_at <= 0 {
            return Ok(json!({ "recorded": 0 }).to_string());
        }
        let samples = samples_from_summary(&summary);
        let mut recorded = 0usize;
        for sample in samples.iter().take(MAX_SERIES) {
            if self.insert_sample(&app_type, &provider_id, sampled_at, sample)? {
                recorded += 1;
            }
        }
        self.prune(sampled_at)?;
        Ok(json!({ "recorded": recorded }).to_string())
    }

    /// Answer compact series for a bounded provider list. Each series is
    /// downsampled to at most `points` (bucket-last) points, which keeps a long
    /// window cheap to draw without inventing values.
    pub fn query(&mut self, input: &str) -> Result<String, String> {
        let value: Value = serde_json::from_str(input).map_err(|e| e.to_string())?;
        let now = now_ms();
        let since = number(&value, "sinceMs")
            .map(|n| n as i64)
            .unwrap_or(now - 24 * 60 * 60 * 1000);
        let since = since.max(0);
        let points = number(&value, "points")
            .map(|n| n as i64)
            .unwrap_or(48)
            .clamp(2, MAX_POINTS as i64) as usize;
        let mut providers = Map::new();
        let list = value
            .get("providers")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for provider in list.iter().take(MAX_PROVIDERS) {
            let Some(app_type) = clean_text(field(provider, "appType"), MAX_KEY) else {
                continue;
            };
            let Some(provider_id) = clean_text(field(provider, "providerId"), MAX_KEY) else {
                continue;
            };
            let Some(entry) = self.query_one(&app_type, &provider_id, since, points)? else {
                continue;
            };
            providers.insert(format!("{app_type}:{provider_id}"), entry);
        }
        Ok(json!({
            "sinceMs": since,
            "generatedAt": now,
            "providers": Value::Object(providers),
        })
        .to_string())
    }

    fn insert_sample(
        &self,
        app_type: &str,
        provider_id: &str,
        sampled_at: i64,
        sample: &Sample,
    ) -> Result<bool, String> {
        let previous: Option<(i64, f64, Option<i64>)> = self
            .connection
            .query_row(
                "SELECT sampled_at, remaining, reset_at FROM provider_quota_samples
                 WHERE app_type = ?1 AND provider_id = ?2 AND series = ?3
                 ORDER BY sampled_at DESC LIMIT 1",
                params![app_type, provider_id, sample.key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some((last_at, last_value, last_reset)) = previous {
            if sampled_at <= last_at {
                return Ok(false);
            }
            let same_window = last_reset == sample.reset_at;
            if same_window && sampled_at - last_at < MIN_INTERVAL_MS {
                return Ok(false);
            }
            let unchanged = (last_value - sample.value).abs() < 0.01;
            if same_window && unchanged && sampled_at - last_at < 3 * MIN_INTERVAL_MS {
                return Ok(false);
            }
        }
        self.connection
            .execute(
                "INSERT OR REPLACE INTO provider_quota_samples
                 (app_type, provider_id, series, sampled_at, remaining, label, unit, reset_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    app_type,
                    provider_id,
                    sample.key,
                    sampled_at,
                    sample.value,
                    sample.label,
                    sample.unit,
                    sample.reset_at
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(true)
    }

    fn prune(&mut self, now: i64) -> Result<(), String> {
        if now - self.last_prune_ms < PRUNE_INTERVAL_MS {
            return Ok(());
        }
        self.last_prune_ms = now;
        self.connection
            .execute(
                "DELETE FROM provider_quota_samples WHERE sampled_at < ?1",
                params![now - self.retention_ms],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn query_one(
        &self,
        app_type: &str,
        provider_id: &str,
        since: i64,
        points: usize,
    ) -> Result<Option<Value>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT series, label, unit, sampled_at, remaining, reset_at
                 FROM provider_quota_samples
                 WHERE app_type = ?1 AND provider_id = ?2 AND sampled_at >= ?3
                 ORDER BY sampled_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![app_type, provider_id, since], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, f64>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut groups: Vec<(String, SeriesGroup)> = Vec::new();
        for row in rows {
            let (series, label, unit, at, value, reset_at) = row.map_err(|e| e.to_string())?;
            let position = match groups.iter().position(|(name, _)| name == &series) {
                Some(position) => position,
                None => {
                    groups.push((series.clone(), SeriesGroup::default()));
                    groups.len() - 1
                }
            };
            let group = &mut groups[position].1;
            if group.label.is_none() {
                group.label = label;
            }
            group.unit = unit;
            group.points.push((at, value));
            group.reset_at = reset_at;
        }
        if groups.is_empty() {
            return Ok(None);
        }
        groups.sort_by_key(|(name, _)| series_rank(name));
        let mut series = Map::new();
        let mut sample_count = 0usize;
        let mut updated_at = 0i64;
        for (name, group) in groups {
            sample_count += group.points.len();
            let (points, last_at) = downsample(&group.points, points);
            if last_at > updated_at {
                updated_at = last_at;
            }
            series.insert(
                name.clone(),
                json!({
                    "label": group.label.unwrap_or_else(|| name.clone()),
                    "unit": group.unit,
                    "points": points,
                    "last": points.last().map(|p| p[1]).unwrap_or(0.0),
                    "lastAt": last_at,
                    "resetAt": group.reset_at,
                }),
            );
        }
        Ok(Some(json!({
            "series": series,
            "samples": sample_count,
            "updatedAt": updated_at,
        })))
    }
}

#[derive(Default)]
struct SeriesGroup {
    label: Option<String>,
    unit: String,
    points: Vec<(i64, f64)>,
    reset_at: Option<i64>,
}

fn series_rank(name: &str) -> usize {
    match name {
        "5h" => 0,
        "1wk" => 1,
        "1m" => 2,
        "balance" => 3,
        _ => 4,
    }
}

/// Keep the last point of each evenly sized bucket, preserving the first and
/// last reading so the curve still spans the requested range.
fn downsample(points: &[(i64, f64)], limit: usize) -> (Vec<[f64; 2]>, i64) {
    let last_at = points.last().map(|p| p.0).unwrap_or(0);
    if points.len() <= limit || limit == 0 {
        return (points.iter().map(|p| [p.0 as f64, p.1]).collect(), last_at);
    }
    let mut out: Vec<[f64; 2]> = Vec::with_capacity(limit + 1);
    let mut bucket = usize::MAX;
    for index in 0..points.len() {
        let next = index * limit / points.len();
        if next != bucket {
            if index > 0 {
                let (prev_at, prev_value) = points[index - 1];
                out.push([prev_at as f64, prev_value]);
            }
            bucket = next;
        }
    }
    let (last_time, last_value) = points[points.len() - 1];
    out.push([last_time as f64, last_value]);
    (out, last_at)
}

fn samples_from_summary(summary: &Value) -> Vec<Sample> {
    let kind = string_at(summary, "kind").unwrap_or_default();
    if kind == "balance" {
        // Production balance summaries carry `available` as a boolean and the
        // money left in `total` (src/quota/limit-cache-recorder.js). A numeric
        // `available` is accepted for older callers, and an explicitly
        // unavailable account is a truthful zero.
        let unavailable = summary.get("available").and_then(Value::as_bool) == Some(false);
        let Some(amount) = number(summary, "total")
            .or_else(|| number(summary, "available"))
            .or_else(|| unavailable.then_some(0.0))
        else {
            return Vec::new();
        };
        if !amount.is_finite() || amount < 0.0 {
            return Vec::new();
        }
        let unit = clean_text(string_at(summary, "currency").as_deref(), MAX_UNIT)
            .unwrap_or_else(|| "amount".to_string());
        return vec![Sample {
            key: "balance".to_string(),
            label: "balance".to_string(),
            unit,
            value: amount,
            reset_at: None,
        }];
    }
    if kind == "availability" {
        return Vec::new();
    }
    let mut samples = Vec::new();
    if let Some(windows) = summary.get("windows").and_then(Value::as_array) {
        for row in windows.iter().take(MAX_SERIES) {
            if let Some(sample) = window_sample(row) {
                samples.push(sample);
            }
        }
    }
    if samples.is_empty() {
        // Legacy single-window summaries store the main cycle's used percentage.
        if let Some(used) = number(summary, "usedPercentage") {
            let key = clean_text(string_at(summary, "window").as_deref(), MAX_LABEL)
                .map(|value| cycle_key(&value))
                .unwrap_or_else(|| "5h".to_string());
            samples.push(Sample {
                key: key.clone(),
                label: key,
                unit: "percent".to_string(),
                value: (100.0 - used).clamp(0.0, 100.0),
                reset_at: number(summary, "resetsAtMs").map(|n| n as i64),
            });
        }
    }
    samples
}

fn window_sample(row: &Value) -> Option<Sample> {
    let used = number(row, "usedPercent")?;
    if !used.is_finite() {
        return None;
    }
    let raw = string_at(row, "window")
        .or_else(|| string_at(row, "label"))
        .unwrap_or_else(|| "5h".to_string());
    let key = cycle_key(&raw);
    if key.is_empty() {
        return None;
    }
    let label = clean_text(string_at(row, "label").as_deref(), MAX_LABEL)
        .or_else(|| Some(key.clone()))
        .unwrap_or_else(|| key.clone());
    Some(Sample {
        key,
        label,
        unit: "percent".to_string(),
        value: (100.0 - used).clamp(0.0, 100.0),
        reset_at: number(row, "resetMs").map(|n| n as i64),
    })
}

/// One token per cycle so readings from different vendors match up.
fn cycle_key(value: &str) -> String {
    let token = value.trim().to_lowercase();
    match token.as_str() {
        "5h" | "five_hour" | "session" | "5小时" => "5h".to_string(),
        "7d" | "1wk" | "weekly" | "week" | "seven_day" | "7天" => "1wk".to_string(),
        "1m" | "30d" | "monthly" | "month" | "30天" => "1m".to_string(),
        _ => clean_text(Some(token.as_str()), MAX_LABEL).unwrap_or_default(),
    }
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn string_at(value: &Value, key: &str) -> Option<String> {
    field(value, key).map(String::from)
}

fn number(value: &Value, key: &str) -> Option<f64> {
    let number = value.get(key)?;
    if let Some(number) = number.as_f64() {
        return number.is_finite().then_some(number);
    }
    number
        .as_str()?
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite())
}

/// Trim, cap and reject empty/control-only text; never store arbitrary blobs.
fn clean_text(value: Option<&str>, max: usize) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    let capped: String = value.chars().take(max).collect();
    let cleaned: String = capped
        .chars()
        .filter(|c| !c.is_control() || *c == ' ')
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: &str, windows: &str) -> String {
        format!(
            r#"{{"appType":"claude","providerId":"glm","sampledAt":1000000,"summary":{{"kind":"{kind}","windows":{windows}}}}}"#
        )
    }

    fn rows(history: &History) -> i64 {
        history
            .connection
            .query_row("SELECT COUNT(*) FROM provider_quota_samples", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    #[test]
    fn stores_remaining_percent_per_cycle() {
        let mut history = History::memory();
        let written = history
            .record(&entry(
                "window",
                r#"[{"window":"5h","label":"5h","usedPercent":12.5,"resetMs":2000000},
                   {"window":"seven_day","label":"7d","usedPercent":0,"resetMs":3000000}]"#,
            ))
            .unwrap();
        assert!(written.contains("\"recorded\":2"));
        let series: Vec<(String, f64)> = history
            .connection
            .prepare("SELECT series, remaining FROM provider_quota_samples ORDER BY series")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            series,
            vec![("1wk".to_string(), 100.0), ("5h".to_string(), 87.5)]
        );
    }

    #[test]
    fn dedupes_within_five_minutes_unless_the_window_rolled() {
        let mut history = History::memory();
        history
            .record(&entry(
                "window",
                r#"[{"window":"5h","usedPercent":10,"resetMs":2000000}]"#,
            ))
            .unwrap();
        // Same window, +1 minute → skipped even though the value moved.
        history
            .record(r#"{"appType":"claude","providerId":"glm","sampledAt":1060000,"summary":{"kind":"window","windows":[{"window":"5h","usedPercent":20,"resetMs":2000000}]}}"#)
            .unwrap();
        assert_eq!(rows(&history), 1);
        // New reset time → a new window, recorded immediately.
        history
            .record(r#"{"appType":"claude","providerId":"glm","sampledAt":1060000,"summary":{"kind":"window","windows":[{"window":"5h","usedPercent":0,"resetMs":3000000}]}}"#)
            .unwrap();
        assert_eq!(rows(&history), 2);
        // Past the 5-minute interval → recorded.
        history
            .record(r#"{"appType":"claude","providerId":"glm","sampledAt":1360000,"summary":{"kind":"window","windows":[{"window":"5h","usedPercent":30,"resetMs":3000000}]}}"#)
            .unwrap();
        assert_eq!(rows(&history), 3);
    }

    #[test]
    fn balance_samples_keep_the_currency() {
        let mut history = History::memory();
        // Production shape: `available` is a boolean, `total` is the money left.
        history
            .record(r#"{"appType":"codex","providerId":"deepseek","sampledAt":1000000,"summary":{"kind":"balance","available":true,"total":12.5,"currency":"CNY"}}"#)
            .unwrap();
        let (series, unit, value): (String, String, f64) = history
            .connection
            .query_row(
                "SELECT series, unit, remaining FROM provider_quota_samples",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (series.as_str(), unit.as_str(), value),
            ("balance", "CNY", 12.5)
        );
        // No amount at all: nothing to draw.
        history
            .record(r#"{"appType":"codex","providerId":"empty","sampledAt":2000000,"summary":{"kind":"balance","available":true,"total":null,"currency":"CNY"}}"#)
            .unwrap();
        assert_eq!(rows(&history), 1);
        // Explicitly out of money is a truthful zero.
        history
            .record(r#"{"appType":"codex","providerId":"broke","sampledAt":2000000,"summary":{"kind":"balance","available":false,"total":null,"currency":"CNY"}}"#)
            .unwrap();
        assert_eq!(rows(&history), 2);
    }

    #[test]
    fn ignores_availability_and_out_of_order_readings() {
        let mut history = History::memory();
        history
            .record(r#"{"appType":"claude","providerId":"glm","sampledAt":1000000,"summary":{"kind":"availability","status":"rejected"}}"#)
            .unwrap();
        assert_eq!(rows(&history), 0);
        history
            .record(&entry(
                "window",
                r#"[{"window":"5h","usedPercent":10,"resetMs":2000000}]"#,
            ))
            .unwrap();
        history
            .record(r#"{"appType":"claude","providerId":"glm","sampledAt":900000,"summary":{"kind":"window","windows":[{"window":"5h","usedPercent":50,"resetMs":2000000}]}}"#)
            .unwrap();
        assert_eq!(rows(&history), 1);
    }

    #[test]
    fn query_downsamples_and_groups_by_provider() {
        let mut history = History::memory();
        for index in 0..100 {
            history
                .record(&format!(
                    r#"{{"appType":"claude","providerId":"glm","sampledAt":{},"summary":{{"kind":"window","windows":[{{"window":"5h","usedPercent":{},"resetMs":9000000}}]}}}}"#,
                    1_000_000 + index * MIN_INTERVAL_MS,
                    index
                ))
                .unwrap();
        }
        let output = history
            .query(r#"{"sinceMs":0,"points":20,"providers":[{"appType":"claude","providerId":"glm"},{"appType":"claude","providerId":"nobody"}]}"#)
            .unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();
        let series = &parsed["providers"]["claude:glm"]["series"]["5h"];
        let points = series["points"].as_array().unwrap();
        assert!(points.len() <= 21, "points = {}", points.len());
        assert_eq!(series["last"], 1.0); // last reading usedPercent = 99 → remaining 1
        assert!(parsed["providers"]["claude:nobody"].is_null());
        assert_eq!(parsed["sinceMs"], 0);
    }

    #[test]
    fn prunes_readings_older_than_retention() {
        let mut history = History::memory();
        history.retention_ms = 10 * 60 * 1000;
        history
            .record(&entry(
                "window",
                r#"[{"window":"5h","usedPercent":10,"resetMs":2000000}]"#,
            ))
            .unwrap();
        assert_eq!(rows(&history), 1);
        history
            .record(r#"{"appType":"claude","providerId":"glm","sampledAt":20000000,"summary":{"kind":"window","windows":[{"window":"5h","usedPercent":20,"resetMs":2000000}]}}"#)
            .unwrap();
        assert_eq!(rows(&history), 1, "the first reading is outside retention");
    }
}
