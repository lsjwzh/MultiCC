//! Passive Claude subscription windows. No usage endpoint or credentials are needed.
use serde_json::{json, Map, Value};

fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse().ok())
        .filter(|n| n.is_finite())
}

fn reset(value: &Value) -> Option<f64> {
    number(value)
        .filter(|n| *n > 0.0)
        .map(|n| if n < 10_000_000_000.0 { n * 1000.0 } else { n })
}

fn status(raw: &str, used: f64) -> &'static str {
    let raw = raw.to_ascii_lowercase();
    if raw == "rejected" || used >= 100.0 {
        "rejected"
    } else if ["warn", "close", "limit"].iter().any(|s| raw.contains(s)) {
        "allowed_warning"
    } else {
        "allowed"
    }
}

pub fn extract(headers: &Map<String, Value>) -> Option<Value> {
    let get = |key: &str| {
        headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v)
            .unwrap_or(&Value::Null)
    };
    let mut rows = Vec::new();
    for (token, window, label) in [("5h", "5h", "Current session"), ("7d", "1wk", "All models")] {
        let Some(util) = number(get(&format!(
            "anthropic-ratelimit-unified-{token}-utilization"
        )))
        .filter(|n| *n >= 0.0) else {
            continue;
        };
        let used = (util * 100.0).clamp(0.0, 100.0);
        let raw = get(&format!("anthropic-ratelimit-unified-{token}-status"))
            .as_str()
            .unwrap_or("");
        rows.push(json!({"window":window,"label":label,"usedPercent":used,
            "resetMs":reset(get(&format!("anthropic-ratelimit-unified-{token}-reset"))),"status":status(raw,used)}));
    }
    let main = rows.first()?;
    let mut result = json!({"kind":"window","provider":"claude","source":"response_headers",
        "rateLimitType":if main["window"] == "5h" { "five_hour" } else { "weekly" },
        "status":main["status"],"utilization":number(&main["usedPercent"])? / 100.0});
    if let Some(ms) = number(&main["resetMs"]) {
        result["resetsAt"] = json!(ms / 1000.0);
    }
    result["windows"] = json!(rows);
    Some(result)
}

fn row(value: &Value, observed: f64) -> Option<Value> {
    let window = match value["window"].as_str()? {
        "5h" => "5h",
        "1wk" | "7d" => "1wk",
        "1m" => "1m",
        _ => return None,
    };
    let used = number(&value["usedPercent"])?.clamp(0.0, 100.0);
    Some(
        json!({"window":window,"label":value["label"].as_str().unwrap_or(""),"usedPercent":used,
        "resetMs":reset(&value["resetMs"]),"observedAtMs":number(&value["observedAtMs"]).unwrap_or(observed)}),
    )
}

fn rows(value: &Value, observed: f64) -> Vec<Value> {
    value["windows"]
        .as_array()
        .map(|list| list.iter().filter_map(|w| row(w, observed)).collect())
        .unwrap_or_default()
}

pub fn normalize(info: &Value, now: f64) -> Option<Value> {
    let kind = match info["rateLimitType"].as_str()? {
        "five_hour" => "five_hour",
        "weekly" | "seven_day" => "weekly",
        _ => return None,
    };
    let state = info["status"].as_str()?;
    if !["allowed", "allowed_warning", "rejected"].contains(&state) {
        return None;
    }
    let used = number(&info["utilization"])
        .map(|n| ((n * 100.0).clamp(0.0, 100.0) * 1000.0).round() / 1000.0);
    let mut result = json!({"schemaVersion":1,"kind":kind,"status":state,"usedPercentage":used,
        "resetsAtMs":reset(&info["resetsAt"]),"observedAtMs":now,"source":"claude_code","provider":"claude"});
    let mut windows = rows(info, now);
    if windows.is_empty() && kind == "weekly" {
        if let Some(used) = used {
            windows.push(json!({"window":"1wk","label":"All models","usedPercent":used,"resetMs":reset(&info["resetsAt"]),"observedAtMs":now}));
        }
    }
    if !windows.is_empty() {
        result["windows"] = json!(windows);
    }
    Some(result)
}

fn live_rows(value: &Value) -> Vec<Value> {
    let observed = number(&value["observedAtMs"]).unwrap_or(0.0);
    let mut result = rows(value, observed);
    if result.is_empty() {
        if let Some(used) = number(&value["usedPercentage"]) {
            result.push(json!({"window":if value["kind"] == "weekly" {"1wk"} else {"5h"},"label":"",
                "usedPercent":if value["status"] == "rejected" {100.0} else {used},"resetMs":value["resetsAtMs"],"observedAtMs":observed}));
        }
    }
    result
}

fn same(a: &Value, b: &Value) -> bool {
    if a["window"] != b["window"] {
        return false;
    }
    if a["window"] == "5h" {
        return true;
    }
    let label = |w: &Value| {
        let label = w["label"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if label.is_empty()
            || label.starts_with("all")
            || ["weekly", "weekly limit", "week", "1wk", "7d"].contains(&label.as_str())
        {
            String::new()
        } else {
            label
        }
    };
    label(a) == label(b)
}

fn current(row: &Value, now: f64) -> bool {
    if number(&row["resetMs"]).is_some_and(|reset| reset <= now) {
        return false;
    }
    let ttl = if row["window"] == "5h" {
        5.0 * 3600_000.0
    } else {
        7.0 * 86400_000.0
    };
    now - number(&row["observedAtMs"]).unwrap_or(0.0) <= ttl
}

fn merge_rows(next: Vec<Value>, previous: Vec<Value>, now: f64) -> Vec<Value> {
    let mut result: Vec<_> = previous.into_iter().filter(|w| current(w, now)).collect();
    for mut row in next.into_iter().filter(|w| current(w, now)) {
        if let Some(i) = result.iter().position(|old| same(old, &row)) {
            if number(&row["observedAtMs"]) >= number(&result[i]["observedAtMs"]) {
                if row["resetMs"].is_null() {
                    row["resetMs"] = result[i]["resetMs"].clone();
                }
                result[i] = row;
            }
        } else {
            result.push(row);
        }
    }
    result
}

fn merge_live(previous: &Value, next: &Value, now: f64) -> Value {
    let windows = merge_rows(live_rows(next), live_rows(previous), now);
    if windows.is_empty() {
        return Value::Null;
    }
    let mut result = if next.is_object() {
        next.clone()
    } else {
        previous.clone()
    };
    // Preserve the legacy single-window DTO when no multi-window producer was involved.
    if windows.len() > 1 || next["windows"].is_array() || previous["windows"].is_array() {
        result["windows"] = json!(windows);
    }
    result
}

fn compose(usage: &Value, live: &Value, now: f64) -> Value {
    let observed = number(&usage["fetchedAt"]).unwrap_or(0.0);
    let mut summary = usage["summary"].as_array().cloned().unwrap_or_default();
    let mut effective = usage.clone();
    let mut five = Value::Null;
    let mut updated = observed;
    for row in live_rows(live).into_iter().filter(|w| current(w, now)) {
        let at = number(&row["observedAtMs"]).unwrap_or(0.0);
        let existing = summary.iter().position(|old| same(old, &row));
        if usage["status"] == "ok" && existing.is_some() && at < observed {
            continue;
        }
        if row["window"] == "5h" {
            five = json!({"status":"allowed","usedPercentage":row["usedPercent"],"resetsAtMs":row["resetMs"]});
        } else {
            if let Some(i) = existing {
                summary[i] = row;
            } else {
                summary.push(row);
            }
            updated = updated.max(at);
            effective = json!({"status":"ok","fetchedAt":updated,"summary":summary});
        }
    }
    json!({"usage":effective,"live":five})
}

fn cache(dto: &Value, previous: &Value, now: f64) -> Value {
    let windows = merge_rows(
        rows(dto, now),
        rows(previous, number(&previous["observedAtMs"]).unwrap_or(now)),
        now,
    );
    let Some(main) = windows
        .iter()
        .find(|w| w["window"] == "5h")
        .or(windows.first())
    else {
        return Value::Null;
    };
    json!({"kind":"window","provider":"claude","source":"response_headers","status":dto["status"],"window":main["window"],
        "usedPercentage":main["usedPercent"],"resetsAtMs":main["resetMs"],"observedAtMs":now,"windows":windows})
}

pub fn run(input: &Value) -> Value {
    let now = number(&input["nowMs"]).unwrap_or(0.0);
    match input["op"].as_str().unwrap_or("") {
        "extract" => input["headers"]
            .as_object()
            .and_then(extract)
            .unwrap_or(Value::Null),
        "normalize" => normalize(&input["info"], now).unwrap_or(Value::Null),
        "merge" => merge_live(&input["previous"], &input["next"], now),
        "compose" => compose(&input["usage"], &input["live"], now),
        "cache" => cache(&input["dto"], &input["previous"], now),
        "failure" => {
            let headers = input["previous"]["source"] == "response_headers";
            let official = input["targetKind"] == "claude-oauth-usage" || headers;
            let limited = input["httpStatus"] == 429;
            let exhausted = rows(&input["previous"], now)
                .iter()
                .any(|w| current(w, now) && number(&w["usedPercent"]).is_some_and(|n| n >= 100.0));
            json!({"refresh": !official, "preserve": limited && headers && exhausted})
        }
        _ => Value::Null,
    }
}
