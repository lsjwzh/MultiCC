//! Read-only host routes retired from `src/routes/host-read.js`:
//!
//! * `GET/HEAD /api/push/vapid-key`
//! * `GET/HEAD /api/push/health`
//! * `GET/HEAD /api/settings/notify`
//! * `GET/HEAD /api/settings/tunnel`
//! * `GET/HEAD /api/tunnel/funnel`
//! * `GET/HEAD /api/tunnel/ipv6`
//! * `GET/HEAD /api/tunnel/sakurafrp`
//! * `GET/HEAD /api/settings/access-token`
//! * `GET/HEAD /api/settings/power`
//! * `GET/HEAD /api/host/battery`
//!
//! Routing, response assembly and error mapping are here, including the parts
//! that used to be pure formatting in Node: push endpoint fingerprints
//! (sha256, first 16 hex), the health DTOs and their failure-reason
//! classification, notification URL masking (origin only), access-token
//! masking, and the `canEdit` locality decision (the same
//! `http_gate::is_local_request` the auth gate uses).
//!
//! The host port ([`crate::host_port`], served by
//! `src/routes/host-read-host.js`) carries only what Rust cannot see: the push
//! runtime Maps and configured URLs, the tunnel clients (they shell out or
//! probe the network), the macOS power services and the battery probe cache.

use std::sync::OnceLock;

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::http_gate::{self};
use multicc_core::js::regex::SPACE;
use multicc_core::js::serde::truthy_opt;
use multicc_core::js::string::js_trim;
use regex::Regex;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use url::Url;

use crate::app::express::{self, RequestCtx};
use crate::host_port;

/// The host port the Node child serves (`src/routes/host-read-host.js`).
const HOST_PATH: &str = "/api/__host/host-read";

const SAFE_PUSH_TYPES: [&str; 4] = ["succeeded", "completed", "waiting", "error"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    VapidKey,
    PushHealth,
    Notify,
    Tunnel,
    Funnel,
    Ipv6,
    Sakurafrp,
    AccessToken,
    Power,
    Battery,
}

impl Route {
    /// The literal segment pair after `/api/`, case-insensitive like Express.
    fn segments(self) -> &'static str {
        match self {
            Route::VapidKey => "push/vapid-key",
            Route::PushHealth => "push/health",
            Route::Notify => "settings/notify",
            Route::Tunnel => "settings/tunnel",
            Route::Funnel => "tunnel/funnel",
            Route::Ipv6 => "tunnel/ipv6",
            Route::Sakurafrp => "tunnel/sakurafrp",
            Route::AccessToken => "settings/access-token",
            Route::Power => "settings/power",
            Route::Battery => "host/battery",
        }
    }

    /// Express's automatic OPTIONS collects every method registered on the
    /// path: the retired `app.get` plus the `app.post` that still lives in
    /// `src/routes/host-write.js` / `host-power.js`.
    pub fn allow(self) -> &'static str {
        match self {
            Route::Notify | Route::Tunnel | Route::Funnel | Route::AccessToken | Route::Power => {
                "GET,HEAD,POST"
            }
            _ => "GET,HEAD",
        }
    }

    fn op(self) -> &'static str {
        match self {
            Route::VapidKey => "vapid-key",
            Route::PushHealth => "push-health",
            Route::Notify => "notify",
            Route::Tunnel => "tunnel",
            Route::Funnel => "funnel",
            Route::Ipv6 => "ipv6",
            Route::Sakurafrp => "sakurafrp",
            Route::AccessToken => "access-token",
            Route::Power => "power",
            Route::Battery => "battery",
        }
    }
}

pub enum Claim {
    Get(Route),
    Options(Route),
}

/// Express matched these paths case-insensitively with one optional trailing
/// slash; a different method on a claimed path went to Node (404 there).
pub fn claim(method: &Method, path: &str) -> Option<Claim> {
    let rest = path.strip_prefix("/api/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest).to_ascii_lowercase();
    const ROUTES: [Route; 10] = [
        Route::VapidKey,
        Route::PushHealth,
        Route::Notify,
        Route::Tunnel,
        Route::Funnel,
        Route::Ipv6,
        Route::Sakurafrp,
        Route::AccessToken,
        Route::Power,
        Route::Battery,
    ];
    let route = ROUTES
        .into_iter()
        .find(|route| route.segments() == rest.as_str())?;
    match method.as_str() {
        "GET" | "HEAD" => Some(Claim::Get(route)),
        "OPTIONS" => Some(Claim::Options(route)),
        _ => None,
    }
}

// ── health DTOs (verbatim port of host-read.js) ─────────────────────────────

fn re_http_status() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&format!(
            "(?:http|status(?:[{SPACE}]*code)?)[{SPACE}]*[:=]?[{SPACE}]*([1-5][0-9]{{2}})"
        ))
        .expect("http status classifier")
    })
}

fn re_class(kind: usize) -> &'static Regex {
    static RES: OnceLock<Vec<Regex>> = OnceLock::new();
    let built = RES.get_or_init(|| {
        [
            format!("timed?[{SPACE}]*out|etimedout|timeout|aborted"),
            "enotfound|eai_again|dns|name resolution".to_string(),
            "certificate|self\\.signed|tls|ssl".to_string(),
            "unauthori[sz]ed|forbidden|credential|token|auth".to_string(),
            "econnrefused|connection refused".to_string(),
            "econnreset|socket|network|fetch failed|connection closed".to_string(),
        ]
        .iter()
        .map(|pattern| Regex::new(pattern).expect("push failure classifier"))
        .collect()
    });
    &built[kind]
}

fn classify_failure_reason(value: Option<&Value>) -> String {
    let text = match value {
        Some(Value::String(text)) => text.as_str(),
        _ => "",
    };
    let reason = js_trim(text).to_lowercase();
    if reason.is_empty() {
        return String::new();
    }
    if let Some(captures) = re_http_status().captures(&reason) {
        let status = &captures[1];
        return format!("http_{}xx", &status[..1]);
    }
    const CLASSES: [(&str, usize); 6] = [
        ("timeout", 0),
        ("dns_error", 1),
        ("tls_error", 2),
        ("authentication_error", 3),
        ("connection_refused", 4),
        ("network_error", 5),
    ];
    for (name, index) in CLASSES {
        if re_class(index).is_match(&reason) {
            return name.to_string();
        }
    }
    "delivery_error".to_string()
}

/// `Number.isFinite(value) && value >= 0 ? value : 0`.
fn finite_non_negative(value: Option<&Value>) -> Value {
    match value {
        Some(value) if value.as_f64().is_some_and(|number| number >= 0.0) => value.clone(),
        _ => json!(0),
    }
}

fn safe_label(value: Option<&Value>) -> String {
    let text = match value {
        Some(Value::String(text)) => js_trim(text),
        _ => "",
    };
    if SAFE_PUSH_TYPES.contains(&text) {
        text.to_string()
    } else if text.is_empty() {
        String::new()
    } else {
        "other".to_string()
    }
}

fn health_fields(raw: Option<&Value>, out: &mut Map<String, Value>) {
    let source = raw.and_then(Value::as_object);
    let field = |key: &str| source.and_then(|source| source.get(key));
    out.insert(
        "successCount".into(),
        finite_non_negative(field("successCount")),
    );
    out.insert("failCount".into(), finite_non_negative(field("failCount")));
    out.insert(
        "lastSuccessTime".into(),
        finite_non_negative(field("lastSuccessTime")),
    );
    out.insert(
        "lastFailTime".into(),
        finite_non_negative(field("lastFailTime")),
    );
    out.insert(
        "lastFailReason".into(),
        Value::String(classify_failure_reason(field("lastFailReason"))),
    );
    out.insert(
        "consecutiveFails".into(),
        finite_non_negative(field("consecutiveFails")),
    );
}

fn global_health_dto(raw: Option<&Value>) -> Value {
    let source = raw.and_then(Value::as_object);
    let field = |key: &str| source.and_then(|source| source.get(key));
    let mut out = Map::new();
    out.insert("totalSent".into(), finite_non_negative(field("totalSent")));
    out.insert(
        "totalSuccess".into(),
        finite_non_negative(field("totalSuccess")),
    );
    out.insert("totalFail".into(), finite_non_negative(field("totalFail")));
    out.insert(
        "lastPushTime".into(),
        finite_non_negative(field("lastPushTime")),
    );
    out.insert(
        "lastPushType".into(),
        Value::String(safe_label(field("lastPushType"))),
    );
    Value::Object(out)
}

fn channel_health_dto(configured: Option<&Value>, raw: Option<&Value>) -> Value {
    let source = raw.and_then(Value::as_object);
    let field = |key: &str| source.and_then(|source| source.get(key));
    let mut out = Map::new();
    out.insert("configured".into(), Value::Bool(truthy_opt(configured)));
    out.insert(
        "lastSendTime".into(),
        finite_non_negative(field("lastSendTime")),
    );
    out.insert(
        "lastSuccess".into(),
        Value::Bool(matches!(field("lastSuccess"), Some(Value::Bool(true)))),
    );
    out.insert(
        "lastError".into(),
        Value::String(classify_failure_reason(field("lastError"))),
    );
    Value::Object(out)
}

fn fingerprint_endpoint(endpoint: Option<&Value>) -> String {
    let text = multicc_core::js::serde::value_or_empty(endpoint);
    let digest = Sha256::digest(text.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("sha256:{}", &hex[..16])
}

// ── notification URL masking ────────────────────────────────────────────────

struct SecretUrl {
    configured: bool,
    origin: String,
    masked: String,
}

/// Only the origin of a notification destination is safe to display: the path,
/// query and userinfo can carry a device key or webhook token.
fn summarize_secret_url(value: Option<&Value>) -> SecretUrl {
    let raw = match value {
        Some(Value::String(text)) if !text.is_empty() => text,
        _ => {
            return SecretUrl {
                configured: false,
                origin: String::new(),
                masked: String::new(),
            }
        }
    };
    let origin = Url::parse(raw)
        .ok()
        .filter(|url| url.scheme() == "http" || url.scheme() == "https")
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_default();
    SecretUrl {
        masked: if origin.is_empty() {
            "\u{2022}\u{2022}\u{2022}\u{2022}".to_string()
        } else {
            format!("{origin}/\u{2022}\u{2022}\u{2022}\u{2022}")
        },
        configured: true,
        origin,
    }
}

// ── access token ────────────────────────────────────────────────────────────

/// `token.length > 4 ? '****' + token.slice(-4) : '****'` with `length` and
/// `slice` in UTF-16 code units, like JavaScript. Access tokens are ASCII, so
/// a lone surrogate left by the slice is unreachable in practice.
fn mask_token(token: &str) -> String {
    let units: Vec<u16> = token.encode_utf16().collect();
    if units.len() > 4 {
        let tail = String::from_utf16_lossy(&units[units.len() - 4..]);
        format!("****{tail}")
    } else {
        "****".to_string()
    }
}

// ── responses ───────────────────────────────────────────────────────────────

/// `res.status(500).json(...)` through `safeErrorHandler`: the client sees
/// `internal_error` and the error's own `code` when it had one.
fn internal(ctx: &RequestCtx, code: Option<&str>, detail: &str) -> Response<Body> {
    let code = code
        .filter(|code| !code.is_empty())
        .unwrap_or("internal_error");
    let body = http_gate::error_dto(code, "internal_error", &[], &ctx.ids);
    express::log_http_error(ctx, 500, detail);
    express::json(ctx, 500, &body, &[])
}

/// `safeErrorHandler` for a host-side throw: its status (when the error carried
/// a 4xx/5xx), the client-safe message rule, and the error's `code` fallback.
fn internal_from_answer(ctx: &RequestCtx, answer: &Value) -> Response<Body> {
    let status = answer
        .get("status")
        .and_then(Value::as_u64)
        .filter(|status| (400..600).contains(status))
        .map(|status| status as u16)
        .unwrap_or(500);
    let code = answer.get("code").and_then(Value::as_str);
    let safe_message = answer.get("safeMessage").and_then(Value::as_str);
    let detail = answer
        .get("detail")
        .and_then(Value::as_str)
        .unwrap_or("host read operation failed");
    let (message, fallback_code) = if status >= 500 {
        ("internal_error", "internal_error")
    } else {
        (safe_message.unwrap_or("request_error"), "request_error")
    };
    // createErrorDto only echoes codes that look like identifiers.
    let code = code
        .filter(|code| {
            !code.is_empty()
                && multicc_core::js::string::utf16_len(code) <= 96
                && code
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        })
        .unwrap_or(fallback_code);
    let body = http_gate::error_dto(code, message, &[], &ctx.ids);
    express::log_http_error(ctx, status, detail);
    express::json(ctx, status, &body, &[])
}

/// `res.json(undefined)`: Express sends an empty JSON body with no ETag.
fn json_undefined(ctx: &RequestCtx) -> Response<Body> {
    let mut builder = express::with_base_headers(Response::builder().status(200), ctx);
    builder = express::header(builder, "Content-Type", "application/json; charset=utf-8");
    builder = express::header(builder, "Content-Length", "0");
    builder
        .body(Body::from(Vec::new()))
        .expect("static response parts")
}

/// `res.json(value)` for a host payload; a missing payload was `undefined`.
fn echo_json(ctx: &RequestCtx, payload: Option<&Value>) -> Response<Body> {
    match payload {
        Some(value) => express::json(ctx, 200, value, &[]),
        None => json_undefined(ctx),
    }
}

fn echo_status_wrapper(ctx: &RequestCtx, payload: Option<&Value>) -> Response<Body> {
    // `res.json({ status: value })`: an undefined value drops the key.
    match payload {
        Some(value) => express::json(ctx, 200, &json!({ "status": value }), &[]),
        None => express::json(ctx, 200, &json!({}), &[]),
    }
}

pub async fn handle(ctx: &RequestCtx, route: Route, host: u16, peer: &str) -> Response<Body> {
    let mut payload = json!({ "op": route.op() });
    if route == Route::Power {
        // `deps.isLocalRequest(req)` in the retired handler. The Node child sees
        // every host-port call as loopback, so the decision is made here on the
        // real client address.
        payload["canEdit"] = Value::Bool(http_gate::is_local_request(peer, &ctx.headers));
    }
    let answer = match host_port::call(host, HOST_PATH, &payload).await {
        Ok(answer) => answer,
        Err(_) => return internal(ctx, None, "host read host port unavailable"),
    };
    if answer.get("ok") != Some(&Value::Bool(true)) {
        return internal_from_answer(ctx, &answer);
    }
    let payload = answer.get("payload");
    match route {
        Route::VapidKey => match payload {
            // `{ publicKey: undefined }` serializes without the key.
            None => express::json(ctx, 200, &json!({}), &[]),
            Some(value) => express::json(ctx, 200, &json!({ "publicKey": value }), &[]),
        },
        Route::PushHealth => push_health(ctx, payload),
        Route::Notify => notify(ctx, payload),
        Route::Funnel => echo_status_wrapper(ctx, payload),
        Route::AccessToken => access_token(ctx, payload, peer),
        Route::Tunnel | Route::Ipv6 | Route::Sakurafrp | Route::Power | Route::Battery => {
            echo_json(ctx, payload)
        }
    }
}

fn object_field<'a>(object: Option<&'a Map<String, Value>>, key: &str) -> Option<&'a Value> {
    object.and_then(|object| object.get(key))
}

fn push_health(ctx: &RequestCtx, payload: Option<&Value>) -> Response<Body> {
    let Some(source) = payload.and_then(Value::as_object) else {
        return internal(ctx, None, "push health host payload missing");
    };
    let endpoints = object_field(Some(source), "endpoints")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let health = object_field(Some(source), "health")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut subscriptions = Vec::with_capacity(endpoints.len());
    for (index, endpoint) in endpoints.iter().enumerate() {
        let mut entry = Map::new();
        entry.insert(
            "endpointFingerprint".into(),
            Value::String(fingerprint_endpoint(Some(endpoint))),
        );
        health_fields(health.get(index), &mut entry);
        subscriptions.push(Value::Object(entry));
    }
    let count = object_field(Some(source), "size")
        .filter(|value| value.as_f64().is_some())
        .cloned()
        .unwrap_or_else(|| json!(subscriptions.len()));
    express::json(
        ctx,
        200,
        &json!({
            "subscriptions": subscriptions,
            "subscriptionCount": count,
            "global": global_health_dto(object_field(Some(source), "globalStats")),
            "bark": channel_health_dto(
                object_field(Some(source), "barkConfigured"),
                object_field(Some(source), "barkHealth"),
            ),
            "webhook": channel_health_dto(
                object_field(Some(source), "webhookConfigured"),
                object_field(Some(source), "webhookHealth"),
            ),
        }),
        &[],
    )
}

fn notify(ctx: &RequestCtx, payload: Option<&Value>) -> Response<Body> {
    let source = payload.and_then(Value::as_object);
    let bark = summarize_secret_url(object_field(source, "barkUrl"));
    let webhook = summarize_secret_url(object_field(source, "webhookUrl"));
    let mut out = Map::new();
    out.insert("barkUrl".into(), Value::String(bark.masked));
    out.insert("barkOrigin".into(), Value::String(bark.origin));
    // `hasBark` is the raw `hasBarkDevices()` result (or `bark.configured`):
    // the retired handler emitted it without coercion, and an undefined value
    // dropped the key from the JSON object.
    match object_field(source, "hasBark") {
        Some(value) => {
            out.insert("hasBark".into(), value.clone());
        }
        None => {
            out.insert("hasBark".into(), Value::Bool(bark.configured));
        }
    }
    if let Some(devices) = object_field(source, "barkDevices") {
        out.insert("barkDevices".into(), devices.clone());
    }
    out.insert("webhookUrl".into(), Value::String(webhook.masked));
    out.insert("webhookOrigin".into(), Value::String(webhook.origin));
    out.insert("hasWebhook".into(), Value::Bool(webhook.configured));
    express::json(ctx, 200, &Value::Object(out), &[])
}

fn access_token(ctx: &RequestCtx, payload: Option<&Value>, peer: &str) -> Response<Body> {
    let source = payload.and_then(Value::as_object);
    // `deps.getAccessToken() || ''`.
    let token = multicc_core::js::serde::value_or_empty(object_field(source, "token"));
    let masked = if token.is_empty() {
        String::new()
    } else {
        mask_token(&token)
    };
    express::json(
        ctx,
        200,
        &json!({
            "hasToken": !token.is_empty(),
            "masked": masked,
            "canEdit": http_gate::is_local_request(peer, &ctx.headers),
        }),
        &[],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_are_the_first_sixteen_sha256_hex_digits() {
        assert_eq!(
            fingerprint_endpoint(Some(&json!("https://example.com/push"))),
            "sha256:c7a56136310c13ea"
        );
        assert_eq!(fingerprint_endpoint(None), "sha256:e3b0c44298fc1c14");
    }

    #[test]
    fn failure_reasons_keep_the_legacy_classification() {
        assert_eq!(
            classify_failure_reason(Some(&json!("HTTP status: 404"))),
            "http_4xx"
        );
        assert_eq!(
            classify_failure_reason(Some(&json!("Status code=503"))),
            "http_5xx"
        );
        assert_eq!(
            classify_failure_reason(Some(&json!("request timed out"))),
            "timeout"
        );
        assert_eq!(
            classify_failure_reason(Some(&json!("ENOTFOUND push.example"))),
            "dns_error"
        );
        assert_eq!(
            classify_failure_reason(Some(&json!("self-signed certificate"))),
            "tls_error"
        );
        assert_eq!(
            classify_failure_reason(Some(&json!("401 unauthorized"))),
            "authentication_error"
        );
        assert_eq!(
            classify_failure_reason(Some(&json!("connect ECONNREFUSED"))),
            "connection_refused"
        );
        assert_eq!(
            classify_failure_reason(Some(&json!("fetch failed"))),
            "network_error"
        );
        assert_eq!(
            classify_failure_reason(Some(&json!("weird"))),
            "delivery_error"
        );
        assert_eq!(classify_failure_reason(Some(&json!("  "))), "");
        assert_eq!(classify_failure_reason(None), "");
    }

    #[test]
    fn health_dtos_zero_non_numbers_and_keep_order() {
        let raw = json!({
            "successCount": 3,
            "failCount": -1,
            "lastSuccessTime": "9",
            "lastFailTime": 7.5,
            "lastFailReason": "HTTP 429",
            "consecutiveFails": 2,
        });
        let mut entry = Map::new();
        health_fields(Some(&raw), &mut entry);
        let text = js_json(&Value::Object(entry));
        assert_eq!(
            text,
            r#"{"successCount":3,"failCount":0,"lastSuccessTime":0,"lastFailTime":7.5,"lastFailReason":"http_4xx","consecutiveFails":2}"#
        );
        let global = js_json(&global_health_dto(Some(&json!({
            "totalSent": 4, "totalSuccess": 2, "lastPushType": " waiting ",
        }))));
        assert_eq!(
            global,
            r#"{"totalSent":4,"totalSuccess":2,"totalFail":0,"lastPushTime":0,"lastPushType":"waiting"}"#
        );
        let channel = js_json(&channel_health_dto(
            Some(&json!("x")),
            Some(&json!({
                "lastSendTime": 5, "lastSuccess": true, "lastError": "timeout",
            })),
        ));
        assert_eq!(
            channel,
            r#"{"configured":true,"lastSendTime":5,"lastSuccess":true,"lastError":"timeout"}"#
        );
    }

    #[test]
    fn secret_urls_keep_only_the_origin() {
        let full = summarize_secret_url(Some(&json!("https://h.example:8443/a/b?token=1")));
        assert!(full.configured);
        assert_eq!(full.origin, "https://h.example:8443");
        assert_eq!(
            full.masked,
            "https://h.example:8443/\u{2022}\u{2022}\u{2022}\u{2022}"
        );
        let default_port = summarize_secret_url(Some(&json!("http://H.Example:80/x")));
        assert_eq!(default_port.origin, "http://h.example");
        let userinfo = summarize_secret_url(Some(&json!("https://user:secret@h.example/x")));
        assert_eq!(userinfo.origin, "https://h.example");
        let relative = summarize_secret_url(Some(&json!("/not-a-url")));
        assert!(relative.configured);
        assert_eq!(relative.origin, "");
        assert_eq!(relative.masked, "\u{2022}\u{2022}\u{2022}\u{2022}");
        let empty = summarize_secret_url(Some(&json!("")));
        assert!(!empty.configured);
        assert_eq!(empty.masked, "");
        assert!(!summarize_secret_url(None).configured);
    }

    #[test]
    fn token_masking_matches_javascript_length_and_slice() {
        assert_eq!(mask_token(""), "****");
        assert_eq!(mask_token("abcd"), "****");
        assert_eq!(mask_token("abcde"), "****bcde");
        assert_eq!(mask_token("0123456789"), "****6789");
    }

    #[test]
    fn claims_are_case_insensitive_with_one_trailing_slash() {
        let get = Method::GET;
        assert!(matches!(
            claim(&get, "/api/push/vapid-key"),
            Some(Claim::Get(Route::VapidKey))
        ));
        assert!(matches!(
            claim(&get, "/api/Push/Vapid-Key/"),
            Some(Claim::Get(Route::VapidKey))
        ));
        assert!(claim(&get, "/API/push/vapid-key").is_none());
        assert!(claim(&get, "/api/push/vapid-key/x").is_none());
        assert!(claim(&get, "/api/token-usage/by-role").is_none());
        assert!(matches!(
            claim(&Method::OPTIONS, "/api/host/battery"),
            Some(Claim::Options(Route::Battery))
        ));
        assert!(claim(&Method::POST, "/api/settings/power").is_none());
    }

    fn js_json(value: &Value) -> String {
        multicc_core::js::serde::js_json_stringify(value)
    }
}
