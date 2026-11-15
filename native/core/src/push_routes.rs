//! Rules kernel for the push route cluster retired from `src/push/runtime.js`,
//! `src/push/channel-subscriptions.js`, `src/push/fcm-devices.js` and
//! `src/push/bark-devices.js`:
//!
//! * `POST   /api/push/subscribe`
//! * `DELETE /api/push/subscribe`
//! * `POST   /api/push/validate`
//! * `POST   /api/push/test`
//! * `POST   /api/push/notify`
//! * `POST   /api/push/test-bark`
//! * `POST   /api/push/test-webhook`
//! * `GET    /api/push/channel-subscriptions`
//! * `PUT    /api/push/channel-subscriptions`
//! * `POST   /api/push/channel-subscriptions`
//! * `DELETE /api/push/channel-subscriptions/:id`
//! * `POST   /api/push/test-channel`
//! * `GET    /api/push/fcm`
//! * `POST   /api/push/fcm`
//! * `DELETE /api/push/fcm`
//! * `POST   /api/push/fcm/test`
//! * `GET    /api/push/bark-devices`
//! * `POST   /api/push/bark-devices`
//!
//! Every in-process fact — the `subscriptions`/`healthStats` Maps, the FCM and
//! Bark device stores, the plugin channel subscriptions, the outbound web-push
//! / FCM / Bark / webhook senders and the delivery accounting — stays behind
//! one host port (`src/routes/push-host.js`). What lives here are the rules
//! that can be decided from values alone: the request-body gates, the FCM id
//! and token shapes, the plugin channel catalog, and the exact response bodies
//! (and their key order) the retired handlers rendered.

use serde_json::{json, Value};

use crate::js::serde::{truthy, truthy_opt};

/// `registry.CATEGORIES` (`src/plugins/channel-registry.js`).
pub const CATEGORIES: [&str; 4] = ["done", "question", "background", "error"];
/// `registry.DEFAULT_CATEGORIES`.
pub const DEFAULT_CATEGORIES: [&str; 2] = ["error", "question"];

/// `fcm-devices.js` `MAX_SUBSCRIPTIONS`-style device id: `^[a-zA-Z0-9_-]{16,128}$`.
pub fn valid_fcm_id(value: &Value) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    let length = text.len();
    (16..=128).contains(&length)
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// `^[a-zA-Z0-9_:\-]{20,4096}$`.
pub fn valid_fcm_token(value: &Value) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    let length = text.len();
    (20..=4096).contains(&length)
        && text.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'_' || byte == b':' || byte == b'-'
        })
}

fn field<'a>(body: &'a Value, key: &str) -> Option<&'a Value> {
    body.get(key)
}

/// `!subscription || !subscription.endpoint` — the first gate of
/// `POST /api/push/subscribe`.
pub fn invalid_subscription(body: &Value) -> bool {
    !truthy(body) || !truthy_opt(field(body, "endpoint"))
}

/// `!endpoint` after `const { endpoint } = req.body || {}`.
pub fn missing_endpoint(body: &Value) -> bool {
    !truthy_opt(field(body, "endpoint"))
}

/// `!validId(id) || !validId(binding) || !validToken(token)` from
/// `fcmDevices.register`.
pub fn invalid_fcm_register(body: &Value) -> bool {
    !valid_fcm_id(field(body, "id").unwrap_or(&Value::Null))
        || !valid_fcm_id(field(body, "binding").unwrap_or(&Value::Null))
        || !valid_fcm_token(field(body, "token").unwrap_or(&Value::Null))
}

/// `!validId(req.body?.id)` from `remove` and the FCM test route.
pub fn invalid_fcm_id(body: &Value) -> bool {
    !valid_fcm_id(field(body, "id").unwrap_or(&Value::Null))
}

/// `input.action` is one of the four Bark actions; anything else (missing,
/// non-string or unknown) falls through to `invalid_action`.
pub fn invalid_bark_action(body: &Value) -> bool {
    !matches!(
        field(body, "action").and_then(Value::as_str),
        Some("add" | "update" | "remove" | "test")
    )
}

// ── response bodies (verbatim from the retired handlers) ────────────────────

/// `res.json({ ok: true })`.
pub fn ok_body() -> Value {
    json!({ "ok": true })
}

/// `res.json({ known: push.subscriptions.has(endpoint) })`.
pub fn known_body(known: bool) -> Value {
    json!({ "known": known })
}

/// `res.json({ ok: true, subscribers: push.subscriptions.size })`.
pub fn test_ok_body(subscribers: i64) -> Value {
    json!({ "ok": true, "subscribers": subscribers })
}

/// `res.status(415).json({...})` from `POST /api/push/notify`.
pub fn unsupported_media_body() -> Value {
    json!({
        "ok": false,
        "delivered": false,
        "deduped": false,
        "error": "UNSUPPORTED_MEDIA_TYPE",
    })
}

/// `res.status(400).json({ error: 'Invalid subscription' })`.
pub fn invalid_subscription_body() -> Value {
    json!({ "error": "Invalid subscription" })
}

/// `res.status(400).json({ error: 'Missing endpoint' })`.
pub fn missing_endpoint_body() -> Value {
    json!({ "error": "Missing endpoint" })
}

/// `res.status(400).json({ error: 'Bark URL not configured' })`.
pub fn bark_not_configured_body() -> Value {
    json!({ "error": "Bark URL not configured" })
}

/// `res.status(400).json({ error: 'Webhook URL not configured' })`.
pub fn webhook_not_configured_body() -> Value {
    json!({ "error": "Webhook URL not configured" })
}

/// `res.status(502).json({ error: 'bark_test_failed' })`.
pub fn bark_test_failed_body() -> Value {
    json!({ "error": "bark_test_failed" })
}

/// `{ devices: devices.list() }`.
pub fn bark_devices_body(devices: &Value) -> Value {
    json!({ "devices": devices })
}

/// `res.status(400).json({ error: 'invalid_action' })`.
pub fn invalid_action_body() -> Value {
    json!({ "error": "invalid_action" })
}

/// `res.status(400).json({ error: 'INVALID_FCM_DEVICE' })` from the FCM test
/// route (a bare body, no `status` key).
pub fn invalid_fcm_test_body() -> Value {
    json!({ "error": "INVALID_FCM_DEVICE" })
}

/// The `register`/`remove` refusal: the whole `{ status, error }` object is the
/// body, because the route did `res.status(r.status).json(r)`.
pub fn invalid_fcm_device_reply() -> Value {
    json!({ "status": 400, "error": "INVALID_FCM_DEVICE" })
}

/// `res.json(status())` — `{ configured, devices, storageAvailable }`.
pub fn fcm_status_body(configured: bool, devices: i64, storage_available: bool) -> Value {
    json!({
        "configured": configured,
        "devices": devices,
        "storageAvailable": storage_available,
    })
}

/// The HTTP status of a `register`/`remove` reply object (`r.status`).
pub fn fcm_reply_status(reply: &Value) -> u16 {
    reply
        .get("status")
        .and_then(Value::as_u64)
        .filter(|status| (100..=599).contains(status))
        .map(|status| status as u16)
        .unwrap_or(200)
}

/// The HTTP status for an FCM test result: `result.ok ? 200 : 502`.
pub fn fcm_test_status(result: &Value) -> u16 {
    if result.get("ok") == Some(&Value::Bool(true)) {
        200
    } else {
        502
    }
}

/// `res.json({ subscriptions, categories, defaults, otherChannels })` from the
/// plugin channel handlers — key order is the retired object literal's.
pub fn channel_payload(subscriptions: &Value, other_channels: &Value) -> Value {
    json!({
        "subscriptions": subscriptions,
        "categories": CATEGORIES,
        "defaults": DEFAULT_CATEGORIES,
        "otherChannels": other_channels,
    })
}

/// `res.status(error.status).json({ error: error.message, code: error.code })`.
pub fn channel_error_body(message: &str, code: &str) -> Value {
    json!({ "error": message, "code": code })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscription_gate_mirrors_the_falsy_endpoint_check() {
        assert!(invalid_subscription(&Value::Null));
        assert!(invalid_subscription(&json!(false)));
        assert!(invalid_subscription(&json!(0)));
        assert!(invalid_subscription(&json!("")));
        // No endpoint (or a falsy one) is refused.
        assert!(invalid_subscription(&json!({})));
        assert!(invalid_subscription(&json!({ "endpoint": "" })));
        assert!(invalid_subscription(&json!({ "endpoint": 0 })));
        assert!(invalid_subscription(&json!({ "endpoint": null })));
        assert!(invalid_subscription(&json!(["endpoint"])));
        // A truthy endpoint of any shape passes; the store keys it like JS.
        assert!(!invalid_subscription(
            &json!({ "endpoint": "https://p.example/1" })
        ));
        assert!(!invalid_subscription(&json!({ "endpoint": 5 })));
        assert!(!invalid_subscription(&json!({ "endpoint": {} })));
    }

    #[test]
    fn validate_gate_requires_a_truthy_endpoint() {
        assert!(missing_endpoint(&Value::Null));
        assert!(missing_endpoint(&json!({})));
        assert!(missing_endpoint(&json!({ "endpoint": "" })));
        assert!(missing_endpoint(&json!({ "endpoint": false })));
        assert!(!missing_endpoint(&json!({ "endpoint": "ep" })));
        assert!(!missing_endpoint(&json!({ "endpoint": 1 })));
    }

    #[test]
    fn fcm_id_and_token_shapes_match_the_device_store() {
        assert!(valid_fcm_id(&json!("abcdefghijklmnop")));
        assert!(valid_fcm_id(&json!("ABCD_-abcdefghijklmnop")));
        assert!(!valid_fcm_id(&json!("short")));
        assert!(valid_fcm_id(&json!("abcdefghijklmnopq"))); // 17 is within range
        assert!(!valid_fcm_id(&json!("abcdefghijklmno"))); // 15 chars
        assert!(!valid_fcm_id(&json!("abcdefghijklmnop!")));
        assert!(!valid_fcm_id(&json!(12345)));
        assert!(!valid_fcm_id(&Value::Null));
        assert!(valid_fcm_token(&json!("aaaaaaaaaaaaaaaaaaaa"))); // exactly 20
        assert!(!valid_fcm_token(&json!("aaaaaaaaaaaaaaaaaaa"))); // 19
        assert!(valid_fcm_token(&json!("abc:def-ghi_jklmnopqrs")));
        assert!(!valid_fcm_token(&json!("abc def ghi jklmnopqrs")));
        assert!(!valid_fcm_token(&json!(42)));
    }

    #[test]
    fn fcm_gates_use_the_id_and_token_shapes() {
        let ok = json!({
            "id": "abcdefghijklmnop",
            "binding": "ABCDEFGHIJKLMNOP",
            "token": "aaaaaaaaaaaaaaaaaaaa",
        });
        assert!(!invalid_fcm_register(&ok));
        assert!(invalid_fcm_register(&json!({ "id": "abcdefghijklmnop" })));
        assert!(invalid_fcm_register(
            &json!({ "binding": "ABCDEFGHIJKLMNOP" })
        ));
        assert!(invalid_fcm_register(&Value::Null));
        assert!(!invalid_fcm_id(&ok));
        assert!(invalid_fcm_id(&json!({ "id": "short" })));
        assert!(invalid_fcm_id(&Value::Null));
    }

    #[test]
    fn bark_actions_are_the_four_known_verbs() {
        for action in ["add", "update", "remove", "test"] {
            assert!(
                !invalid_bark_action(&json!({ "action": action })),
                "{action}"
            );
        }
        assert!(invalid_bark_action(&json!({})));
        assert!(invalid_bark_action(&json!({ "action": "ADD" })));
        assert!(invalid_bark_action(&json!({ "action": 1 })));
        assert!(invalid_bark_action(&Value::Null));
    }

    #[test]
    fn response_bodies_keep_the_retired_shapes_and_key_order() {
        let keys = |value: &Value| -> Vec<String> {
            value
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>()
        };
        assert_eq!(ok_body(), json!({ "ok": true }));
        assert_eq!(known_body(true), json!({ "known": true }));
        assert_eq!(
            keys(&test_ok_body(3)),
            vec!["ok".to_string(), "subscribers".to_string()]
        );
        assert_eq!(
            keys(&unsupported_media_body()),
            vec!["ok", "delivered", "deduped", "error"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            unsupported_media_body()["error"],
            json!("UNSUPPORTED_MEDIA_TYPE")
        );
        assert_eq!(
            invalid_subscription_body(),
            json!({ "error": "Invalid subscription" })
        );
        assert_eq!(
            invalid_fcm_test_body(),
            json!({ "error": "INVALID_FCM_DEVICE" })
        );
        assert_eq!(
            keys(&invalid_fcm_device_reply()),
            vec!["status".to_string(), "error".to_string()]
        );
        assert_eq!(invalid_fcm_device_reply()["status"], json!(400));
    }

    #[test]
    fn fcm_status_and_reply_helpers() {
        let status = fcm_status_body(true, 2, false);
        assert_eq!(
            status,
            json!({ "configured": true, "devices": 2, "storageAvailable": false })
        );
        let keys: Vec<&str> = status
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, vec!["configured", "devices", "storageAvailable"]);

        assert_eq!(fcm_reply_status(&json!({ "status": 200, "ok": true })), 200);
        assert_eq!(
            fcm_reply_status(&json!({ "status": 409, "error": "x" })),
            409
        );
        assert_eq!(fcm_reply_status(&json!({})), 200);
        assert_eq!(fcm_test_status(&json!({ "ok": true })), 200);
        assert_eq!(fcm_test_status(&json!({ "ok": false })), 502);
        assert_eq!(fcm_test_status(&json!({})), 502);
    }

    #[test]
    fn channel_payload_is_the_catalog_plus_the_host_counts() {
        let body = channel_payload(&json!([{ "id": "s1" }]), &json!({ "webPush": 1 }));
        let keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec!["subscriptions", "categories", "defaults", "otherChannels"]
        );
        assert_eq!(
            body["categories"],
            json!(["done", "question", "background", "error"])
        );
        assert_eq!(body["defaults"], json!(["error", "question"]));
        assert_eq!(
            channel_error_body("没有这条订阅", "notFound"),
            json!({ "error": "没有这条订阅", "code": "notFound" })
        );
    }

    #[test]
    fn bark_devices_body_wraps_the_list() {
        let body = bark_devices_body(&json!([{ "id": "legacy" }]));
        let keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, vec!["devices"]);
    }
}
