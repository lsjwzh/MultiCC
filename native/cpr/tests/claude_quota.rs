use multicc_cpr::claude_quota::{extract, run};
use serde_json::{json, Value};

const NOW: f64 = 1_700_000_000_000.0;

fn headers(five: &str, week: &str) -> Value {
    json!({"anthropic-ratelimit-unified-5h-utilization":five,
        "anthropic-ratelimit-unified-5h-reset":"1700003600",
        "anthropic-ratelimit-unified-7d-utilization":week,
        "anthropic-ratelimit-unified-7d-reset":"1700604800","authorization":"must-not-leak"})
}

fn live(five: &str, week: &str, now: f64) -> Value {
    let dto = extract(headers(five, week).as_object().unwrap()).unwrap();
    run(&json!({"op":"normalize","info":dto,"nowMs":now}))
}

#[test]
fn independent_windows_and_invalid_headers() {
    let dto = extract(headers("0.2", "1").as_object().unwrap()).unwrap();
    assert_eq!(dto["utilization"], 0.2);
    assert_eq!(dto["status"], "allowed");
    assert_eq!(dto["windows"][1]["usedPercent"], 100.0);
    assert_eq!(dto["windows"][1]["resetMs"], NOW + 604_800_000.0);
    assert!(!dto.to_string().contains("must-not-leak"));
    for invalid in ["", "NaN", "Infinity", "not-a-number", "-1"] {
        let dto = extract(headers(invalid, "0.6").as_object().unwrap()).unwrap();
        assert_eq!(dto["rateLimitType"], "weekly");
        assert_eq!(dto["windows"].as_array().unwrap().len(), 1);
    }
    assert!(extract(headers("NaN", "").as_object().unwrap()).is_none());
    let dto = extract(json!({"Anthropic-Ratelimit-Unified-7d-Utilization":"0","anthropic-ratelimit-unified-7d-reset":"garbage"}).as_object().unwrap()).unwrap();
    assert_eq!(dto["utilization"], 0.0);
    assert!(dto.get("resetsAt").is_none());
}

#[test]
fn missing_windows_keep_their_own_reset_and_observation_time() {
    let previous = live("0.2", "0.8", NOW);
    let next = live("0.3", "", NOW + 1000.0);
    let merged = run(&json!({"op":"merge","previous":previous,"next":next,"nowMs":NOW+1000.0}));
    assert_eq!(merged["windows"].as_array().unwrap().len(), 2);
    assert_eq!(merged["windows"][1]["observedAtMs"], NOW);
    let expired = run(&json!({"op":"merge","previous":merged,"nowMs":NOW+3_600_001.0}));
    assert_eq!(expired["windows"].as_array().unwrap().len(), 1);
    assert_eq!(expired["windows"][0]["window"], "1wk");
    assert!(run(&json!({"op":"merge","previous":expired,"nowMs":NOW+604_800_001.0})).is_null());
}

#[test]
fn a_partial_window_keeps_a_known_reset_without_overwriting_a_newer_observation() {
    let previous = live("0.2", "0.8", NOW);
    let dto = extract(
        json!({"anthropic-ratelimit-unified-7d-utilization":"0.9"})
            .as_object()
            .unwrap(),
    )
    .unwrap();
    let next = run(&json!({"op":"normalize","info":dto,"nowMs":NOW+1000.0}));
    let merged = run(&json!({"op":"merge","previous":previous,"next":next,"nowMs":NOW+1000.0}));
    assert_eq!(merged["windows"][1]["resetMs"], NOW + 604_800_000.0);
    assert_eq!(merged["windows"][1]["usedPercent"], 90.0);
    let reordered =
        run(&json!({"op":"merge","previous":merged,"next":previous,"nowMs":NOW+2000.0}));
    assert_eq!(reordered["windows"][1]["usedPercent"], 90.0);
}

#[test]
fn header_week_overrides_only_the_all_model_row_and_respects_newer_manual_reads() {
    let usage = json!({"status":"ok","fetchedAt":NOW-1000.0,"summary":[
        {"window":"1wk","label":"All models","usedPercent":10},
        {"window":"1wk","label":"Sonnet","usedPercent":30}]});
    let result =
        run(&json!({"op":"compose","usage":usage,"live":live("0.2","0.8",NOW),"nowMs":NOW}));
    assert_eq!(result["usage"]["summary"].as_array().unwrap().len(), 2);
    assert_eq!(result["usage"]["summary"][0]["usedPercent"], 80.0);
    assert_eq!(result["usage"]["summary"][1]["usedPercent"], 30);
    assert_eq!(result["live"]["usedPercentage"], 20.0);
    let mut newer = usage.clone();
    newer["fetchedAt"] = json!(NOW + 1000.0);
    let result =
        run(&json!({"op":"compose","usage":newer,"live":live("0.2","0.8",NOW),"nowMs":NOW+1000.0}));
    assert_eq!(result["usage"]["summary"][0]["usedPercent"], 10);
}

#[test]
fn an_exhausted_week_survives_partial_headers_and_429_without_a_usage_query() {
    let dto = extract(headers("0.2", "1").as_object().unwrap()).unwrap();
    let previous = run(&json!({"op":"cache","dto":dto,"nowMs":NOW}));
    let dto = extract(headers("0.3", "").as_object().unwrap()).unwrap();
    let summary = run(&json!({"op":"cache","dto":dto,"previous":previous,"nowMs":NOW+1000.0}));
    assert_eq!(summary["windows"][1]["usedPercent"], 100.0);
    let policy =
        run(&json!({"op":"failure","previous":summary,"httpStatus":429,"nowMs":NOW+1000.0}));
    assert_eq!(policy, json!({"refresh":false,"preserve":true}));
    let policy =
        run(&json!({"op":"failure","previous":summary,"httpStatus":401,"nowMs":NOW+1000.0}));
    assert_eq!(policy["preserve"], false);
}
