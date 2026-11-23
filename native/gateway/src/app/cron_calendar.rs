//! Month projection for the cron panel, including disabled subscription hints.
use super::cron_list::next_before;
use chrono::{Datelike, Days, Duration, Local, NaiveDate, SecondsFormat, TimeZone};
use multicc_core::{js::serde::truthy, session_records};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const POINTS_PER_RULE: usize = 200;

fn month_start(date: NaiveDate) -> Option<i64> {
    let midnight = date.and_hms_opt(0, 0, 0)?;
    // JavaScript Date picks the earlier offset for an overlap and advances
    // past a gap. A local calendar date can itself be skipped at the dateline.
    (0..=1440).find_map(|minute| {
        Local
            .from_local_datetime(&(midnight + Duration::minutes(minute)))
            .earliest()
            .map(|time| time.timestamp_millis())
    })
}

pub(super) fn render(tasks: &[Value], month: &str, now: i64) -> (u16, Value) {
    let bytes = month.as_bytes();
    if bytes.len() != 7
        || bytes[4] != b'-'
        || !bytes[..4].iter().chain(&bytes[5..]).all(u8::is_ascii_digit)
    {
        return (400, json!({"error": "month 应为 YYYY-MM"}));
    }
    let year: i32 = month[..4].parse().unwrap();
    let number: u32 = month[5..].parse().unwrap();
    let Some(first) =
        NaiveDate::from_ymd_opt(year, number, 1).filter(|_| (2000..=3000).contains(&year))
    else {
        return (400, json!({"error": "month 范围无效"}));
    };
    let following = (first + Days::new(31)).with_day(1).unwrap();
    let (Some(start), Some(end)) = (month_start(first), month_start(following)) else {
        return (500, json!({"error": "invalid local time"}));
    };
    let mut days: BTreeMap<u32, Vec<Value>> = BTreeMap::new();
    let mut dense = Vec::new();
    for task in tasks {
        let expr = task["cron"].as_str().unwrap_or_default();
        let mut cursor = if truthy(&task["enabled"]) {
            start.max(now)
        } else if task["createdBy"] == "subscriptions" && expr != "0 0 31 2 *" {
            start
        } else {
            continue;
        };
        let mut count = 0;
        while cursor < end && count < POINTS_PER_RULE {
            let Some(at) = next_before(expr, cursor, Some(end)) else {
                break;
            };
            let time = Local.timestamp_millis_opt(at).unwrap();
            let mut point = json!({});
            for key in ["id", "name"] {
                if let Some(v) = task.get(key) {
                    point[key] = v.clone();
                }
            }
            point["kind"] = super::cron_list::fallback(&task["kind"], json!("agent"));
            point["at"] = json!(time.to_utc().to_rfc3339_opts(SecondsFormat::Millis, true));
            point["dense"] = json!(false);
            days.entry(time.day()).or_default().push(point);
            count += 1;
            cursor = at;
        }
        if count == POINTS_PER_RULE {
            dense.push(task["id"].clone());
        }
    }
    for points in days.values_mut() {
        points.sort_by(|a, b| a["at"].as_str().cmp(&b["at"].as_str()));
        for p in points {
            p["dense"] = json!(dense.contains(&p["id"]));
        }
    }
    (
        200,
        json!({"month": month, "days": days, "dense": dense, "generatedAt": session_records::iso_timestamp_now()}),
    )
}
