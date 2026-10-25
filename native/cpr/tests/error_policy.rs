use multicc_cpr::error_policy::quota_wall;
use serde_json::{json, Value};

fn check(status: u16, headers: Value, body: &str) -> bool {
    let map = headers.as_object().cloned().unwrap_or_default();
    quota_wall(status, &map, body.as_bytes())
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
