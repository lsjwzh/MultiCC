//! `GET/HEAD /api/token-usage/by-role`, retired from the `mountRoutes` of
//! `src/routes/token-usage.js`.
//!
//! The retired handler was three decisions and one JSON body: with a truthy
//! `req.query.session` it answered `roleTokenTracker.snapshot(session)` (or the
//! fixed empty snapshot when the tracker had no row), without one it answered
//! the persisted ledger. Both values live in Node — the runtime map of a live
//! process and a 0600 JSON file — so they still come from the host port, but the
//! query semantics, the fallback shape, the status code and the error body are
//! decided here.
//!
//! `req.query.session` is qs output, so a repeated or bracketed key arrives as an
//! array or object. Those are truthy in JS, yet `Map#get(object)` can never match
//! a string key, so the snapshot is always `null` and the answer is the empty
//! snapshot. That branch needs no host call at all.
//!
//! Node answered this route synchronously on one thread, so a read never saw a
//! half-written store; `snapshot` and `readLedger` are plain synchronous reads on
//! the host side as well, so no mutex is needed across the round trip.

use axum::body::Body;
use axum::http::Response;
use multicc_core::http_gate::{query_value, QueryValue};
use serde_json::{json, Value};

use crate::app::express::{self, RequestCtx};
use crate::host_port;

/// What the retired Node handler answered when the tracker threw
/// (`PUBLIC_USAGE_ERROR` in src/routes/token-usage.js).
pub const PUBLIC_ERROR: &str = "Token usage is temporarily unavailable";

/// The host port the Node child serves (`src/routes/token-usage-host.js`).
const HOST_PATH: &str = "/api/__host/token-usage";

/// `EMPTY_ROLE_SNAPSHOT` in src/routes/token-usage.js, in `JSON.stringify`
/// key order. The retired handler used it both for a missing row and for the
/// `main`/`sub` half of the snapshot.
fn empty_snapshot() -> Value {
    json!({ "main": Value::Null, "sub": Value::Null, "subByProvider": [] })
}

fn failure(ctx: &RequestCtx) -> Response<Body> {
    express::json(ctx, 500, &json!({ "error": PUBLIC_ERROR }), &[])
}

/// `GET|HEAD /api/token-usage/by-role`.
pub async fn get(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let payload = match query_value(&ctx.original_url, "session") {
        // `req.query.session` was a non-empty string: the tracker was asked
        // for that session.
        QueryValue::Text(session) if !session.is_empty() => {
            json!({ "op": "snapshot", "session": session })
        }
        // No `session`, or an empty one: the persisted ledger.
        QueryValue::Missing | QueryValue::Text(_) => json!({ "op": "ledger" }),
        // Arrays and objects are truthy but are never a Map key.
        QueryValue::List(_) | QueryValue::Object => {
            return express::json(ctx, 200, &empty_snapshot(), &[])
        }
    };
    let answer = match host_port::call(host, HOST_PATH, &payload).await {
        Ok(value) => value,
        Err(_) => return failure(ctx),
    };
    if answer.get("ok") != Some(&Value::Bool(true)) {
        return failure(ctx);
    }
    match answer.get("payload") {
        Some(payload) => express::json(ctx, 200, payload, &[]),
        // `ok:true` without the payload is not an answer this endpoint produces.
        None => failure(ctx),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_snapshot_keeps_the_node_shape() {
        assert_eq!(
            multicc_core::js::serde::js_json_stringify(&empty_snapshot()),
            "{\"main\":null,\"sub\":null,\"subByProvider\":[]}"
        );
    }
}
