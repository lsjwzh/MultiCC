//! Picker usage is attributed by provider at event time in the daily ledger.
use chrono::{Datelike, Local, NaiveDate};
use multicc_core::provider_store;
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
        bucket[key] = (bucket[key].as_u64().unwrap_or_default() + count(raw)).into();
    }
    bucket["consumedInputTokens"] = bucket["inputTokens"].clone();
    bucket["unattributedInputTokens"] = bucket["inputTokens"]
        .as_u64()
        .unwrap_or_default()
        .saturating_sub(
            ["freshInputTokens", "cacheReadTokens", "cacheWriteTokens"]
                .iter()
                .map(|key| bucket[key].as_u64().unwrap_or_default())
                .sum(),
        )
        .into();
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
pub(super) fn read(root: &Path, providers: &[Value]) -> Value {
    let Ok(Some(daily)) = provider_store::read(&root.join("token_daily.json")) else {
        return json!([]);
    };
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
    let sessions = super::directory_list::records(&root.join("sessions.json")).unwrap_or_default();
    let mut out = Vec::new();
    for (id, w) in windows.as_object().into_iter().flatten() {
        let mut stat = w["all"].clone();
        let p = providers
            .iter()
            .find(|p| p["id"] == *id && p["builtinOfficial"] != true);
        stat["providerId"] = json!(id);
        stat["providerName"] = json!(if id == "_default_" {
            "默认登录"
        } else {
            p.and_then(|p| p["name"].as_str()).unwrap_or(id)
        });
        stat["appType"] = json!(p.map(|p| &p["appType"]));
        stat["sessionCount"] = json!(sessions
            .iter()
            .filter(|s| s["provider"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("_default_")
                == id)
            .count());
        stat["totalTokens"] = json!(
            stat["inputTokens"].as_u64().unwrap_or_default()
                + stat["outputTokens"].as_u64().unwrap_or_default()
        );
        for k in ["today", "week", "month"] {
            stat[k] = w[k].clone();
        }
        out.push(stat);
    }
    out.sort_by_key(|s| std::cmp::Reverse(s["totalTokens"].as_u64().unwrap_or_default()));
    out.into()
}
