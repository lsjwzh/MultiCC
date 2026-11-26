//! Picker usage is attributed by provider at event time in the daily ledger.
use chrono::{Datelike, Local, NaiveDate};

use serde_json::{json, Value};
use std::path::Path;
const COUNTS: [&str; 6] = [
    "inputTokens",
    "freshInputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "outputTokens",
    "turnCount",
];

fn count(v: &Value) -> u64 {
    let n = v
        .as_u64()
        .or_else(|| {
            let s = v.as_str()?.trim();
            s.bytes()
                .all(|c| c.is_ascii_digit())
                .then(|| s.parse().ok())
                .flatten()
        })
        .or_else(|| {
            v.as_f64()
                .filter(|n| *n >= 0.0 && n.fract() == 0.0)
                .map(|n| n as u64)
        });
    n.filter(|n| *n <= 9007199254740991).unwrap_or_default()
}
fn accumulate(bucket: &mut Value, row: &Value) {
    for key in COUNTS {
        let raw = if key == "inputTokens" && !row["consumedInputTokens"].is_null() {
            &row["consumedInputTokens"]
        } else {
            &row[key]
        };
        bucket[key] = number(value(bucket, key) + count(raw) as f64);
    }
    bucket["consumedInputTokens"] = bucket["inputTokens"].clone();
    bucket["unattributedInputTokens"] = number(
        (value(bucket, "inputTokens")
            - value(bucket, "freshInputTokens")
            - value(bucket, "cacheReadTokens")
            - value(bucket, "cacheWriteTokens"))
        .max(0.),
    );
    bucket["breakdownKnown"] = json!(
        bucket["breakdownKnown"] == true
            || row["breakdownKnown"].as_bool().unwrap_or_else(|| [
                "freshInputTokens",
                "cacheReadTokens",
                "cacheWriteTokens"
            ]
            .iter()
            .any(|k| row.get(k).is_some()))
    );
}
/// Index by provider first so each day is parsed only once.
pub fn windows(daily: &Value) -> Value {
    let today = Local::now().date_naive();
    let week = today - chrono::Duration::days(today.weekday().num_days_from_monday().into());
    let month = today.with_day(1).unwrap_or(today);
    let mut windows = json!({});
    for (day, buckets) in daily.as_object().into_iter().flatten() {
        let Ok(date) = NaiveDate::parse_from_str(day, "%Y-%m-%d") else {
            continue;
        };
        if date.format("%Y-%m-%d").to_string() != *day {
            continue;
        }
        for (id, row) in buckets.as_object().into_iter().flatten() {
            if id.is_empty()
                || id.encode_utf16().count() > 180
                || matches!(id.as_str(), "__proto__" | "prototype" | "constructor")
            {
                continue;
            }
            for (k, in_window) in [
                ("all", true),
                ("month", date >= month),
                ("week", date >= month && date >= week),
                ("today", date == today),
            ] {
                if in_window {
                    accumulate(&mut windows[id][k], row);
                }
            }
        }
    }
    windows
}

pub fn daily_windows(root: &Path) -> Value {
    let grouped = windows(&ledger(root, "token_daily.json"));
    let mut result = json!({"all":{}, "today":{}, "week":{}, "month":{}});
    for (id, buckets) in grouped.as_object().into_iter().flatten() {
        for (key, bucket) in buckets.as_object().into_iter().flatten() {
            result[key][id] = bucket.clone();
        }
    }
    result
}

fn ledger(root: &Path, name: &str) -> Value {
    std::fs::File::open(root.join(name))
        .ok()
        .and_then(|f| serde_json::from_reader(std::io::BufReader::new(f)).ok())
        .unwrap_or(Value::Null)
}

pub fn usage(root: &Path, providers: &[Value]) -> Value {
    let sessions = ledger(root, "sessions.json");
    let records = sessions.as_array().or_else(|| sessions["data"].as_array());
    let mut mapping = std::collections::HashMap::new();
    for s in records.into_iter().flatten() {
        if s.is_null() {
            break;
        }
        mapping.insert(
            s["id"].as_str(),
            s["provider"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("_default_"),
        );
    }
    let grouped = windows(&ledger(root, "token_daily.json"));
    let mut stats = Vec::new();
    let mut attributed = json!({});
    for (id, w) in grouped.as_object().into_iter().flatten() {
        let mut stat = w["all"].clone();
        let meta = providers.iter().rev().find(|p| p["id"] == *id);
        stat["providerId"] = json!(id);
        stat["providerName"] = if id == "_default_" {
            json!("默认登录")
        } else {
            meta.map(|v| v["name"].clone()).unwrap_or(json!(id))
        };
        stat["appType"] = if id == "_default_" {
            Value::Null
        } else {
            json!(meta.map(|p| &p["appType"]))
        };
        stat["sessionCount"] = json!(mapping.values().filter(|p| **p == id).count());
        for key in ["today", "week", "month"] {
            stat[key] = w[key].clone();
        }
        stat["totalTokens"] = number(value(&stat, "inputTokens") + value(&stat, "outputTokens"));
        for key in ["inputTokens", "outputTokens", "turnCount"] {
            attributed[key] = number(value(&attributed, key) + value(&stat, key));
        }
        stats.push(stat);
    }
    stats.sort_by(|a, b| value(b, "totalTokens").total_cmp(&value(a, "totalTokens")));
    let mut total = json!({});
    accumulate(&mut total, &Value::Null);
    for (_, row) in ledger(root, "token_usage.json")
        .as_object()
        .into_iter()
        .flatten()
    {
        accumulate(&mut total, row);
        if count(&row["turnCount"]) == 0 {
            total["turnCount"] = number(value(&total, "turnCount") + 1.);
        }
    }
    total["totalTokens"] = number(value(&total, "inputTokens") + value(&total, "outputTokens"));
    let mut unattributed = json!({});
    for key in ["inputTokens", "outputTokens", "turnCount"] {
        unattributed[key] = number((value(&total, key) - value(&attributed, key)).max(0.));
    }
    json!({"stats":stats,"total":total,"unattributed":unattributed})
}
pub fn value(bucket: &Value, key: &str) -> f64 {
    bucket[key].as_f64().unwrap_or(0.)
}
/// Preserve integer JSON on the common path, with JavaScript Number precision for large totals.
pub fn number(n: f64) -> Value {
    if n < u64::MAX as f64 {
        (n as u64).into()
    } else {
        json!(n)
    }
}
