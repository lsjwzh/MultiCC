use multicc_cpr::error_policy::{classify, classify_at, quota_wall};
use serde_json::{json, Value};

fn check(status: u16, headers: Value, body: &str) -> bool {
    let map = headers.as_object().cloned().unwrap_or_default();
    quota_wall(status, &map, body.as_bytes())
}

fn classify_one(status: u16, headers: Value, body: &str, model: Option<&str>) -> Value {
    let map = headers.as_object().cloned().unwrap_or_default();
    classify(status, &map, body.as_bytes(), model).expect("429 必须给出结构化归因")
}

#[test]
fn unified_rejected_window_is_a_quota_wall() {
    assert!(check(429, json!({"anthropic-ratelimit-unified-status":"rejected"}), ""));
    assert!(check(429, json!({"Anthropic-Ratelimit-Unified-5h-Status":"REJECTED"}), ""));
    assert!(check(429, json!({"anthropic-ratelimit-unified-7d-status":"rejected"}), "{}"));
}

#[test]
fn quota_exhaustion_wording_is_a_quota_wall() {
    for body in [
        "You have exceeded the 5-hour usage quota.",
        "usage limit reached",
        r#"{"error":{"code":"1308","message":"已达到 5 小时的使用上限…"}}"#,
        "This request would exceed your account's rate limit. Please try again later.",
        "This request would exceed your account’s rate limit. Please try again later.",
        r#"{"error":{"message":"余额不足，请充值"}}"#,
        r#"{"error":{"code":"insufficient_quota","message":"no balance"}}"#,
        r#"{"type":"error","error":{"type":"quota_exceeded"}}"#,
    ] {
        assert!(check(429, json!({}), body), "should be a quota wall: {body}");
    }
}

#[test]
fn transient_rate_limits_stay_retryable() {
    for body in [
        "Too many requests",
        "rate limit exceeded, please retry after 2s",
        r#"{"error":{"code":"1302","message":"并发数过高"}}"#,
        r#"{"error":{"code":"1303","message":"频率过高"}}"#,
        r#"{"error":{"code":1305,"message":"请求过多"}}"#,
        "{}",
    ] {
        assert!(!check(429, json!({}), body), "must stay retryable: {body}");
    }
    for status in ["allowed", "allowed_warning"] {
        assert!(!check(
            429,
            json!({"anthropic-ratelimit-unified-5h-status": status}),
            "{}"
        ));
    }
}

#[test]
fn only_429_can_be_a_quota_wall() {
    let body = "You have exceeded the 5-hour usage quota.";
    for status in [0, 400, 402, 403, 500, 503] {
        assert!(!check(
            status,
            json!({"anthropic-ratelimit-unified-status":"rejected"}),
            body
        ));
    }
    assert!(check(429, json!({}), body));
}

#[test]
fn credits_required_is_a_model_entitlement() {
    let body = r#"{"type":"error","error":{"type":"rate_limit_error","message":"Usage credits are required for this model.","details":{"error_code":"credits_required"}}}"#;
    let result = classify_one(429, json!({}), body, Some("claude-fable-5"));
    assert_eq!(result["kind"], "entitlement");
    assert_eq!(result["scope"], "model");
    assert_eq!(result["window"], Value::Null);
    assert_eq!(result["resetMs"], Value::Null);
    assert_eq!(result["code"], "credits_required");
    assert_eq!(result["source"], "code");
    assert_eq!(result["model"], "claude-fable-5");

    // 同样的措辞没有业务码时也要认出来，只是 code 为空、来源变成正文。
    let result = classify_one(429, json!({}), "Usage credits are required for this model.", None);
    assert_eq!(result["kind"], "entitlement");
    assert_eq!(result["scope"], "model");
    assert_eq!(result["code"], Value::Null);
    assert_eq!(result["source"], "text");
    assert_eq!(result["model"], Value::Null);
}

#[test]
fn unified_rejection_headers_classify_window_and_billing() {
    let result = classify_one(
        429,
        json!({
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-representative-claim": "five_hour",
            "anthropic-ratelimit-unified-5h-reset": "1790000000",
        }),
        "{}",
        None,
    );
    assert_eq!(result["kind"], "window");
    assert_eq!(result["scope"], "account");
    assert_eq!(result["window"], "5h");
    assert_eq!(result["code"], "five_hour");
    assert_eq!(result["source"], "headers");
    assert_eq!(result["resetMs"].as_i64(), Some(1_790_000_000_000));

    let result = classify_one(
        429,
        json!({
            "anthropic-ratelimit-unified-7d-status": "REJECTED",
            "anthropic-ratelimit-unified-representative-claim": "seven_day_opus",
            "anthropic-ratelimit-unified-7d-reset": "1790500000",
        }),
        "",
        None,
    );
    assert_eq!(result["kind"], "window");
    assert_eq!(result["scope"], "model");
    assert_eq!(result["window"], "1wk");
    assert_eq!(result["code"], "seven_day_opus");
    assert_eq!(result["resetMs"].as_i64(), Some(1_790_500_000_000));

    let result = classify_one(
        429,
        json!({
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-representative-claim": "overage",
            "anthropic-ratelimit-unified-overage-reset": "1791000000",
        }),
        "",
        None,
    );
    assert_eq!(result["kind"], "billing");
    assert_eq!(result["scope"], "account");
    assert_eq!(result["window"], Value::Null);
    assert_eq!(result["code"], "overage");
    assert_eq!(result["resetMs"].as_i64(), Some(1_791_000_000_000));
}

#[test]
fn structured_vendor_codes_classify_kind_and_window() {
    let result = classify_one(
        429,
        json!({}),
        r#"{"error":{"code":"1308","message":"已达到 5 小时的使用上限"}}"#,
        None,
    );
    assert_eq!(result["kind"], "window");
    assert_eq!(result["scope"], "account");
    assert_eq!(result["window"], "5h");
    assert_eq!(result["code"], "1308");
    assert_eq!(result["source"], "code");

    let result = classify_one(429, json!({}), r#"{"error":{"code":1310}}"#, None);
    assert_eq!(result["kind"], "window");
    assert_eq!(result["window"], "1wk");
    assert_eq!(result["code"], "1310");

    let result = classify_one(429, json!({}), r#"{"error":{"code":1304}}"#, None);
    assert_eq!(result["kind"], "window");
    assert_eq!(result["window"], "1d");

    let result = classify_one(429, json!({}), r#"{"error":{"code":"1113"}}"#, None);
    assert_eq!(result["kind"], "billing");
    assert_eq!(result["scope"], "account");
    assert_eq!(result["code"], "1113");

    // 智谱的并发/频率限流必须留在瞬时限流一侧。
    let result = classify_one(429, json!({}), r#"{"error":{"code":"1302","message":"并发数过高"}}"#, None);
    assert_eq!(result["kind"], "transient");
    assert_eq!(result["scope"], "request");
    assert_eq!(result["code"], "1302");
    assert_eq!(result["source"], "status");
}

#[test]
fn codex_usage_limit_reached_carries_relative_reset() {
    let body = r#"{"error":{"type":"usage_limit_reached","resets_in_seconds":60}}"#;
    let headers = json!({}).as_object().cloned().unwrap_or_default();
    let now = 1_700_000_000_000.0;
    let result = classify_at(429, &headers, body.as_bytes(), Some("gpt-fixture"), now).unwrap();
    assert_eq!(result["kind"], "window");
    assert_eq!(result["scope"], "account");
    assert_eq!(result["window"], Value::Null);
    assert_eq!(result["code"], "usage_limit_reached");
    assert_eq!(result["resetMs"].as_i64(), Some(1_700_000_060_000));
    assert_eq!(result["model"], "gpt-fixture");
}

#[test]
fn retry_after_header_fills_transient_reset() {
    let body = b"Too many requests";
    let now = 1_700_000_000_000.0;
    let headers = json!({"retry-after": "7"}).as_object().cloned().unwrap();
    let result = classify_at(429, &headers, body, None, now).unwrap();
    assert_eq!(result["kind"], "transient");
    assert_eq!(result["scope"], "request");
    assert_eq!(result["window"], Value::Null);
    assert_eq!(result["resetMs"].as_i64(), Some(1_700_000_007_000));

    let headers = json!({"Retry-After": "Sun, 06 Nov 1994 08:49:37 GMT"})
        .as_object()
        .cloned()
        .unwrap();
    let result = classify_at(429, &headers, body, None, now).unwrap();
    assert_eq!(result["resetMs"].as_i64(), Some(784_111_777_000));
}

#[test]
fn only_429_is_classified_at_all() {
    for status in [0, 400, 402, 403, 500, 503] {
        let headers = json!({"anthropic-ratelimit-unified-status": "rejected"});
        let map = headers.as_object().cloned().unwrap();
        assert!(classify(status, &map, b"You have exceeded the 5-hour usage quota.", None).is_none());
    }
    assert!(classify(429, &Default::default(), b"Too many requests", None).is_some());
}
