//! The push route cluster retired from `src/push/runtime.js`,
//! `src/push/channel-subscriptions.js`, `src/push/fcm-devices.js` and
//! `src/push/bark-devices.js`.
//!
//! Path matching, the Express OPTIONS answer, the `:id` decode, the request
//! body gates ([`multicc_core::push_routes`]), the FCM id/token shapes, the
//! plugin channel catalog and every response envelope (with its key order) are
//! decided here. Node keeps every runtime fact and every real side effect
//! behind one host port, `POST /api/__host/push`
//! (`src/routes/push-host.js`): the in-process subscription/health Maps, the
//! FCM and Bark device stores, the plugin channel subscriptions, the web-push
//! / FCM / Bark / webhook senders and the delivery accounting. The same Maps
//! back the read-only `GET /api/push/health` projection that already moved to
//! the front door (`native/gateway/src/app/host_read.rs`), so there is exactly
//! one subscription store, not two.
//!
//! A host answer is `{ ok: true, value }`; a refusal the retired handler
//! rendered travels inside `value` (a `{ status, body }` reply or a
//! `channelError`), and a handler that threw is a host failure. A host port
//! that cannot be reached at all is the documented 503 (docs/gateway.md §9);
//! any other host failure is the retired `route()` guard's
//! `500 { error: 'push request failed' }`.

#![allow(clippy::result_large_err)]

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::js::serde::truthy;
use multicc_core::push_routes::{
    bark_devices_body, bark_not_configured_body, bark_test_failed_body, channel_error_body,
    channel_payload, fcm_reply_status, fcm_status_body, fcm_test_status, invalid_action_body,
    invalid_bark_action, invalid_fcm_device_reply, invalid_fcm_id, invalid_fcm_register,
    invalid_fcm_test_body, invalid_subscription, invalid_subscription_body, known_body,
    missing_endpoint, missing_endpoint_body, ok_body, test_ok_body, unsupported_media_body,
    webhook_not_configured_body,
};
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::App;
use crate::host_port;

/// The host port the Node child serves (`src/routes/push-host.js`).
const HOST_PATH: &str = "/api/__host/push";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    /// `GET|HEAD /api/push/fcm`
    FcmGet,
    /// `POST /api/push/fcm`
    FcmRegister,
    /// `DELETE /api/push/fcm`
    FcmRemove,
    /// `POST /api/push/fcm/test`
    FcmTest,
    /// `GET|HEAD /api/push/bark-devices`
    BarkList,
    /// `POST /api/push/bark-devices`
    BarkAction,
    /// `GET|HEAD /api/push/channel-subscriptions`
    ChannelGet,
    /// `PUT /api/push/channel-subscriptions`
    ChannelReplace,
    /// `POST /api/push/channel-subscriptions`
    ChannelUpsert,
    /// `DELETE /api/push/channel-subscriptions/:id`
    ChannelRemove,
    /// `POST /api/push/test-channel`
    TestChannel,
    /// `POST /api/push/subscribe`
    SubscribePost,
    /// `DELETE /api/push/subscribe`
    SubscribeDelete,
    /// `POST /api/push/validate`
    ValidatePost,
    /// `POST /api/push/test`
    TestPost,
    /// `POST /api/push/notify`
    NotifyPost,
    /// `POST /api/push/test-bark`
    TestBarkPost,
    /// `POST /api/push/test-webhook`
    TestWebhookPost,
    /// Express's automatic OPTIONS union for the exact path.
    Options,
}

#[derive(Clone, Copy)]
enum Seg {
    Lit(&'static str),
    Param,
}
use Seg::{Lit, Param};

struct Layer {
    segs: &'static [Seg],
    method: &'static str,
    kind: Route,
}

/// Registration order of the retired handlers, as `mountRoutes` ran them in
/// `server.js`: FCM, then Bark, then plugin channels, then the runtime routes.
/// The order fixes the automatic OPTIONS `Allow` union.
static LAYERS: &[Layer] = &[
    // push.fcmDevices.mountRoutes(app, route)
    Layer {
        segs: &[Lit("push"), Lit("fcm")],
        method: "GET",
        kind: Route::FcmGet,
    },
    Layer {
        segs: &[Lit("push"), Lit("fcm")],
        method: "POST",
        kind: Route::FcmRegister,
    },
    Layer {
        segs: &[Lit("push"), Lit("fcm")],
        method: "DELETE",
        kind: Route::FcmRemove,
    },
    Layer {
        segs: &[Lit("push"), Lit("fcm"), Lit("test")],
        method: "POST",
        kind: Route::FcmTest,
    },
    // mountBarkDeviceRoutes(app, push.barkDevices, route)
    Layer {
        segs: &[Lit("push"), Lit("bark-devices")],
        method: "GET",
        kind: Route::BarkList,
    },
    Layer {
        segs: &[Lit("push"), Lit("bark-devices")],
        method: "POST",
        kind: Route::BarkAction,
    },
    // mountChannelSubscriptionRoutes(app, push.channelSubscriptions, route, …)
    Layer {
        segs: &[Lit("push"), Lit("channel-subscriptions")],
        method: "GET",
        kind: Route::ChannelGet,
    },
    Layer {
        segs: &[Lit("push"), Lit("channel-subscriptions")],
        method: "PUT",
        kind: Route::ChannelReplace,
    },
    Layer {
        segs: &[Lit("push"), Lit("channel-subscriptions")],
        method: "POST",
        kind: Route::ChannelUpsert,
    },
    Layer {
        segs: &[Lit("push"), Lit("channel-subscriptions"), Param],
        method: "DELETE",
        kind: Route::ChannelRemove,
    },
    Layer {
        segs: &[Lit("push"), Lit("test-channel")],
        method: "POST",
        kind: Route::TestChannel,
    },
    // the runtime routes
    Layer {
        segs: &[Lit("push"), Lit("subscribe")],
        method: "POST",
        kind: Route::SubscribePost,
    },
    Layer {
        segs: &[Lit("push"), Lit("subscribe")],
        method: "DELETE",
        kind: Route::SubscribeDelete,
    },
    Layer {
        segs: &[Lit("push"), Lit("validate")],
        method: "POST",
        kind: Route::ValidatePost,
    },
    Layer {
        segs: &[Lit("push"), Lit("test")],
        method: "POST",
        kind: Route::TestPost,
    },
    Layer {
        segs: &[Lit("push"), Lit("notify")],
        method: "POST",
        kind: Route::NotifyPost,
    },
    Layer {
        segs: &[Lit("push"), Lit("test-bark")],
        method: "POST",
        kind: Route::TestBarkPost,
    },
    Layer {
        segs: &[Lit("push"), Lit("test-webhook")],
        method: "POST",
        kind: Route::TestWebhookPost,
    },
];

fn segments(path: &str) -> Option<Vec<&str>> {
    let rest = path.strip_prefix("/api/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.is_empty() {
        return None;
    }
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    Some(parts)
}

fn layer_matches(segs: &[Seg], parts: &[&str]) -> bool {
    segs.len() == parts.len()
        && segs.iter().zip(parts).all(|(seg, part)| match seg {
            Seg::Lit(name) => part.eq_ignore_ascii_case(name),
            Seg::Param => !part.is_empty(),
        })
}

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    let parts = segments(path)?;
    if method.as_str() == "OPTIONS" {
        return LAYERS
            .iter()
            .any(|layer| layer_matches(layer.segs, &parts))
            .then_some(Route::Options);
    }
    let wanted = if method.as_str() == "HEAD" {
        "GET"
    } else {
        method.as_str()
    };
    LAYERS
        .iter()
        .find(|layer| layer.method == wanted && layer_matches(layer.segs, &parts))
        .map(|layer| layer.kind)
}

/// Express's automatic OPTIONS body and `Allow` header: the union of the
/// methods registered on this exact path, each `GET` followed by `HEAD`, in
/// registration order.
pub fn allow_for(path: &str) -> Option<String> {
    let parts = segments(path)?;
    let mut methods: Vec<&'static str> = Vec::new();
    let mut matched = false;
    for layer in LAYERS {
        if !layer_matches(layer.segs, &parts) {
            continue;
        }
        matched = true;
        if !methods.contains(&layer.method) {
            methods.push(layer.method);
        }
        if layer.method == "GET" && !methods.contains(&"HEAD") {
            methods.push("HEAD");
        }
    }
    matched.then(|| methods.join(","))
}

/// This cluster's own share of Express's automatic `OPTIONS` `Allow`, for the
/// front-door union across clusters (`super::OPTIONS_SOURCES`).
pub fn options_share(path: &str) -> Option<String> {
    allow_for(path)
}

fn part<'a>(parts: &[&'a str], index: usize) -> &'a str {
    parts.get(index).copied().unwrap_or("")
}

fn decoded(ctx: &RequestCtx, raw: &str) -> Result<String, Response<Body>> {
    super::download::decode_uri_component(raw)
        .ok_or_else(|| express::error(ctx, 400, "Failed to decode param"))
}

fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        503,
        &json!({
            "error": "推送接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

fn failed(ctx: &RequestCtx) -> Response<Body> {
    express::json(ctx, 500, &json!({ "error": "push request failed" }), &[])
}

/// The host answered an HTTP status other than 200: the operation ran and
/// failed, which the retired `route()` guard rendered as a 500. Anything else
/// (no status line, no headers, a connect refusal, a reset, a timeout) means we
/// never got a complete answer, which is the documented 503.
fn answered_but_failed(error: &std::io::Error) -> bool {
    if error.kind() != std::io::ErrorKind::InvalidData {
        return false;
    }
    let text = error.to_string();
    text.starts_with("host port: status ") || text == "host port: chunked reply"
}

async fn call(ctx: &RequestCtx, host: u16, payload: &Value) -> Result<Value, Response<Body>> {
    match host_port::call(host, HOST_PATH, payload).await {
        Ok(answer) if answer.get("ok") == Some(&Value::Bool(true)) => {
            Ok(answer.get("value").cloned().unwrap_or(Value::Null))
        }
        Ok(_) => Err(failed(ctx)),
        Err(error) => {
            if answered_but_failed(&error) {
                Err(failed(ctx))
            } else {
                Err(unavailable(ctx))
            }
        }
    }
}

fn render_reply(ctx: &RequestCtx, reply: &Value) -> Response<Body> {
    let status = reply
        .get("status")
        .and_then(Value::as_u64)
        .filter(|status| (100..=599).contains(status))
        .unwrap_or(200) as u16;
    express::json(ctx, status, reply.get("body").unwrap_or(&Value::Null), &[])
}

fn payload(op: &str, fields: Vec<(&str, Value)>) -> Value {
    let mut object = Map::new();
    object.insert("op".into(), Value::String(op.to_string()));
    for (key, value) in fields {
        object.insert(key.to_string(), value);
    }
    Value::Object(object)
}

/// The plugin channel routes render either the catalog payload or the
/// `{ error, code }` envelope the store's `ChannelSubscriptionError` produced.
fn channel_result(ctx: &RequestCtx, value: &Value) -> Response<Body> {
    if let Some(error) = value.get("channelError").and_then(Value::as_object) {
        let status = error
            .get("status")
            .and_then(Value::as_u64)
            .filter(|status| (100..=599).contains(status))
            .unwrap_or(400) as u16;
        let message = error.get("message").and_then(Value::as_str).unwrap_or("");
        let code = error.get("code").and_then(Value::as_str).unwrap_or("");
        return express::json(ctx, status, &channel_error_body(message, code), &[]);
    }
    let subscriptions = value
        .get("subscriptions")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let other = value.get("otherChannels").cloned().unwrap_or(Value::Null);
    express::json(ctx, 200, &channel_payload(&subscriptions, &other), &[])
}

pub async fn handle(
    app: &std::sync::Arc<App>,
    route: Route,
    ctx: &RequestCtx,
    body: &Value,
    host: u16,
) -> Response<Body> {
    if !app.node_enabled && route == Route::BarkList {
        return super::notification_reads::bark_list(app, ctx).await;
    }
    let write =
        ctx.method == Method::POST || ctx.method == Method::PUT || ctx.method == Method::DELETE;
    let _serialized = if write {
        Some(app.push_write.lock().await)
    } else {
        None
    };
    if !app.node_enabled
        && matches!(
            route,
            Route::SubscribePost | Route::SubscribeDelete | Route::ValidatePost
        )
    {
        return super::web_push::subscription(&app.data_root, ctx, route, body).await;
    }
    answer(ctx, route, body, host).await
}

async fn answer(ctx: &RequestCtx, route: Route, body: &Value, host: u16) -> Response<Body> {
    let parts = segments(&ctx.path).unwrap_or_default();
    match route {
        Route::Options => {
            let allow = allow_for(&ctx.path).unwrap_or_default();
            express::send(
                ctx,
                200,
                "text/html; charset=utf-8",
                allow.clone().into_bytes(),
                &[("Allow", allow.as_str())],
            )
        }
        // ── web push subscriptions ──────────────────────────────────────────
        Route::SubscribePost => {
            if invalid_subscription(body) {
                return express::json(ctx, 400, &invalid_subscription_body(), &[]);
            }
            match call(
                ctx,
                host,
                &payload("subscribe", vec![("body", body.clone())]),
            )
            .await
            {
                Ok(_) => express::json(ctx, 200, &ok_body(), &[]),
                Err(response) => response,
            }
        }
        Route::SubscribeDelete => {
            match call(
                ctx,
                host,
                &payload("unsubscribe", vec![("body", body.clone())]),
            )
            .await
            {
                Ok(_) => express::json(ctx, 200, &ok_body(), &[]),
                Err(response) => response,
            }
        }
        Route::ValidatePost => {
            if missing_endpoint(body) {
                return express::json(ctx, 400, &missing_endpoint_body(), &[]);
            }
            let endpoint = body.get("endpoint").cloned().unwrap_or(Value::Null);
            match call(
                ctx,
                host,
                &payload("validate", vec![("endpoint", endpoint)]),
            )
            .await
            {
                Ok(value) => {
                    let known = truthy(value.get("known").unwrap_or(&Value::Null));
                    express::json(ctx, 200, &known_body(known), &[])
                }
                Err(response) => response,
            }
        }
        Route::TestPost => match call(ctx, host, &payload("test", vec![])).await {
            Ok(value) => {
                let subscribers = value
                    .get("subscribers")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                express::json(ctx, 200, &test_ok_body(subscribers), &[])
            }
            Err(response) => response,
        },
        Route::NotifyPost => {
            // `req.is('application/json')`: body-parser already left `{}` for a
            // non-JSON body, so the media type is the first gate.
            let essence = express::media_type(ctx.headers.get("content-type").unwrap_or("")).0;
            if essence != "application/json" {
                return express::json(ctx, 415, &unsupported_media_body(), &[]);
            }
            match call(ctx, host, &payload("notify", vec![("body", body.clone())])).await {
                Ok(value) => render_reply(ctx, &value),
                Err(response) => response,
            }
        }
        Route::TestBarkPost => match call(ctx, host, &payload("test-bark", vec![])).await {
            Ok(value) => {
                if !truthy(value.get("configured").unwrap_or(&Value::Null)) {
                    return express::json(ctx, 400, &bark_not_configured_body(), &[]);
                }
                if value.get("ok") == Some(&Value::Bool(false)) {
                    return express::json(ctx, 502, &bark_test_failed_body(), &[]);
                }
                express::json(ctx, 200, &ok_body(), &[])
            }
            Err(response) => response,
        },
        Route::TestWebhookPost => match call(ctx, host, &payload("test-webhook", vec![])).await {
            Ok(value) => {
                if !truthy(value.get("configured").unwrap_or(&Value::Null)) {
                    return express::json(ctx, 400, &webhook_not_configured_body(), &[]);
                }
                express::json(ctx, 200, &ok_body(), &[])
            }
            Err(response) => response,
        },
        // ── plugin channels ─────────────────────────────────────────────────
        Route::ChannelGet => match call(ctx, host, &payload("channel-get", vec![])).await {
            Ok(value) => channel_result(ctx, &value),
            Err(response) => response,
        },
        Route::ChannelReplace => {
            let subscriptions = body.get("subscriptions").cloned().unwrap_or(Value::Null);
            match call(
                ctx,
                host,
                &payload("channel-replace", vec![("subscriptions", subscriptions)]),
            )
            .await
            {
                Ok(value) => channel_result(ctx, &value),
                Err(response) => response,
            }
        }
        Route::ChannelUpsert => {
            match call(
                ctx,
                host,
                &payload("channel-upsert", vec![("body", body.clone())]),
            )
            .await
            {
                Ok(value) => channel_result(ctx, &value),
                Err(response) => response,
            }
        }
        Route::ChannelRemove => {
            let id = match decoded(ctx, part(&parts, 2)) {
                Ok(value) => value,
                Err(response) => return response,
            };
            match call(
                ctx,
                host,
                &payload("channel-remove", vec![("id", json!(id))]),
            )
            .await
            {
                Ok(value) => channel_result(ctx, &value),
                Err(response) => response,
            }
        }
        Route::TestChannel => {
            match call(
                ctx,
                host,
                &payload("test-channel", vec![("body", body.clone())]),
            )
            .await
            {
                Ok(value) => {
                    if let Some(error) = value.get("channelError").and_then(Value::as_object) {
                        let status = error
                            .get("status")
                            .and_then(Value::as_u64)
                            .filter(|status| (100..=599).contains(status))
                            .unwrap_or(400) as u16;
                        let message = error.get("message").and_then(Value::as_str).unwrap_or("");
                        let code = error.get("code").and_then(Value::as_str).unwrap_or("");
                        return express::json(ctx, status, &channel_error_body(message, code), &[]);
                    }
                    express::json(ctx, 200, &value, &[])
                }
                Err(response) => response,
            }
        }
        // ── FCM devices ─────────────────────────────────────────────────────
        Route::FcmGet => match call(ctx, host, &payload("fcm-status", vec![])).await {
            Ok(value) => {
                let configured = truthy(value.get("configured").unwrap_or(&Value::Null));
                let devices = value.get("devices").and_then(Value::as_i64).unwrap_or(0);
                let storage = truthy(value.get("storageAvailable").unwrap_or(&Value::Null));
                express::json(
                    ctx,
                    200,
                    &fcm_status_body(configured, devices, storage),
                    &[],
                )
            }
            Err(response) => response,
        },
        Route::FcmRegister => {
            if invalid_fcm_register(body) {
                return express::json(ctx, 400, &invalid_fcm_device_reply(), &[]);
            }
            match call(
                ctx,
                host,
                &payload("fcm-register", vec![("body", body.clone())]),
            )
            .await
            {
                Ok(reply) => {
                    let status = fcm_reply_status(&reply);
                    express::json(ctx, status, &reply, &[])
                }
                Err(response) => response,
            }
        }
        Route::FcmRemove => {
            if invalid_fcm_id(body) {
                return express::json(ctx, 400, &invalid_fcm_device_reply(), &[]);
            }
            match call(
                ctx,
                host,
                &payload("fcm-remove", vec![("body", body.clone())]),
            )
            .await
            {
                Ok(reply) => {
                    let status = fcm_reply_status(&reply);
                    express::json(ctx, status, &reply, &[])
                }
                Err(response) => response,
            }
        }
        Route::FcmTest => {
            if invalid_fcm_id(body) {
                return express::json(ctx, 400, &invalid_fcm_test_body(), &[]);
            }
            let id = body.get("id").cloned().unwrap_or(Value::Null);
            match call(ctx, host, &payload("fcm-test", vec![("id", id)])).await {
                Ok(result) => {
                    let status = fcm_test_status(&result);
                    express::json(ctx, status, &result, &[])
                }
                Err(response) => response,
            }
        }
        // ── Bark devices ────────────────────────────────────────────────────
        Route::BarkList => match call(ctx, host, &payload("bark-list", vec![])).await {
            // Success is `{ devices: [...] }`; a storage failure is the
            // retired `{ status, body }` reply.
            Ok(value) => match value.get("devices") {
                Some(devices) => express::json(ctx, 200, &bark_devices_body(devices), &[]),
                None => render_reply(ctx, &value),
            },
            Err(response) => response,
        },
        Route::BarkAction => {
            if invalid_bark_action(body) {
                return express::json(ctx, 400, &invalid_action_body(), &[]);
            }
            match call(
                ctx,
                host,
                &payload("bark-action", vec![("body", body.clone())]),
            )
            .await
            {
                Ok(value) => render_reply(ctx, &value),
                Err(response) => response,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allow(path: &str) -> String {
        allow_for(path).unwrap_or_else(|| panic!("no layer matches {path}"))
    }

    #[test]
    fn claims_the_eighteen_paths() {
        assert_eq!(claim(&Method::GET, "/api/push/fcm"), Some(Route::FcmGet));
        assert_eq!(claim(&Method::HEAD, "/api/push/fcm"), Some(Route::FcmGet));
        assert_eq!(
            claim(&Method::POST, "/api/push/fcm"),
            Some(Route::FcmRegister)
        );
        assert_eq!(
            claim(&Method::DELETE, "/api/push/fcm"),
            Some(Route::FcmRemove)
        );
        assert_eq!(
            claim(&Method::POST, "/api/push/fcm/test"),
            Some(Route::FcmTest)
        );
        assert_eq!(
            claim(&Method::GET, "/api/push/bark-devices"),
            Some(Route::BarkList)
        );
        assert_eq!(
            claim(&Method::POST, "/api/push/bark-devices"),
            Some(Route::BarkAction)
        );
        assert_eq!(
            claim(&Method::GET, "/api/push/channel-subscriptions"),
            Some(Route::ChannelGet)
        );
        assert_eq!(
            claim(&Method::PUT, "/api/push/channel-subscriptions"),
            Some(Route::ChannelReplace)
        );
        assert_eq!(
            claim(&Method::POST, "/api/push/channel-subscriptions"),
            Some(Route::ChannelUpsert)
        );
        assert_eq!(
            claim(&Method::DELETE, "/api/push/channel-subscriptions/chs_1"),
            Some(Route::ChannelRemove)
        );
        assert_eq!(
            claim(&Method::POST, "/api/push/test-channel"),
            Some(Route::TestChannel)
        );
        assert_eq!(
            claim(&Method::POST, "/api/push/subscribe"),
            Some(Route::SubscribePost)
        );
        assert_eq!(
            claim(&Method::DELETE, "/api/push/subscribe"),
            Some(Route::SubscribeDelete)
        );
        assert_eq!(
            claim(&Method::POST, "/api/push/validate"),
            Some(Route::ValidatePost)
        );
        assert_eq!(
            claim(&Method::POST, "/api/push/test"),
            Some(Route::TestPost)
        );
        assert_eq!(
            claim(&Method::POST, "/api/push/notify"),
            Some(Route::NotifyPost)
        );
        assert_eq!(
            claim(&Method::POST, "/api/push/test-bark"),
            Some(Route::TestBarkPost)
        );
        assert_eq!(
            claim(&Method::POST, "/api/push/test-webhook"),
            Some(Route::TestWebhookPost)
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/push/notify"),
            Some(Route::Options)
        );
    }

    #[test]
    fn options_allow_is_the_registration_order_union() {
        assert_eq!(allow("/api/push/fcm"), "GET,HEAD,POST,DELETE");
        assert_eq!(allow("/api/push/fcm/test"), "POST");
        assert_eq!(allow("/api/push/bark-devices"), "GET,HEAD,POST");
        assert_eq!(
            allow("/api/push/channel-subscriptions"),
            "GET,HEAD,PUT,POST"
        );
        assert_eq!(allow("/api/push/channel-subscriptions/chs_1"), "DELETE");
        assert_eq!(allow("/api/push/subscribe"), "POST,DELETE");
        for path in [
            "/api/push/validate",
            "/api/push/test",
            "/api/push/notify",
            "/api/push/test-bark",
            "/api/push/test-webhook",
            "/api/push/test-channel",
        ] {
            assert_eq!(allow(path), "POST", "{path}");
        }
        assert_eq!(allow_for("/api/push/health"), None);
        assert_eq!(allow_for("/api/push/vapid-key"), None);
    }

    #[test]
    fn channel_id_route_never_swallows_the_bare_path() {
        // The bare collection has no DELETE and the item path has no PUT/POST.
        assert_eq!(
            claim(&Method::DELETE, "/api/push/channel-subscriptions"),
            None
        );
        assert_eq!(
            claim(&Method::PUT, "/api/push/channel-subscriptions/chs_1"),
            None
        );
        assert_eq!(
            claim(&Method::POST, "/api/push/channel-subscriptions/chs_1"),
            None
        );
        assert_eq!(
            claim(&Method::GET, "/api/push/channel-subscriptions/chs_1"),
            None
        );
        // The literal tails do not swallow each other.
        assert_eq!(claim(&Method::POST, "/api/push/test-bark/x"), None);
        assert_eq!(claim(&Method::POST, "/api/push/test-channel/x"), None);
        assert_eq!(claim(&Method::GET, "/api/push/fcm/test"), None);
    }

    #[test]
    fn the_claims_do_not_shadow_host_read_or_other_families() {
        for (method, path) in [
            ("GET", "/api/push/vapid-key"),
            ("GET", "/api/push/health"),
            ("GET", "/api/push"),
            ("POST", "/api/push/health"),
            ("GET", "/api/settings/notify"),
        ] {
            let method = Method::from_bytes(method.as_bytes()).unwrap();
            assert_eq!(claim(&method, path), None, "{method} {path}");
        }
    }

    #[test]
    fn trailing_slash_and_case_follow_express() {
        assert_eq!(
            claim(&Method::POST, "/api/push/notify/"),
            Some(Route::NotifyPost)
        );
        assert_eq!(
            claim(&Method::POST, "/api/Push/Notify"),
            Some(Route::NotifyPost)
        );
        assert_eq!(claim(&Method::POST, "/API/push/notify"), None);
        assert_eq!(claim(&Method::POST, "/api/push//notify"), None);
        assert_eq!(
            claim(&Method::DELETE, "/api/push/channel-subscriptions/%20"),
            Some(Route::ChannelRemove)
        );
        assert_eq!(
            claim(&Method::DELETE, "/api/push/channel-subscriptions/"),
            None,
            "the trailing slash belongs to the bare collection"
        );
    }
}
