//! Rust front door for cross-machine `dispatch_master` / `route_task` /
//! `dispatch_slave` control endpoints and real-time SSE receipt pushing.
//!
//! Public endpoints (authenticated strictly by `x-multicc-machine-grant`):
//! - `GET  /api/cross-machine/targets`
//! - `POST /api/cross-machine/dispatches`
//! - `GET  /api/cross-machine/dispatches/:opId`
//! - `POST /api/cross-machine/dispatches/:opId/cancel`
//! - `POST /api/cross-machine/receipts/ack`
//! - `GET  /api/cross-machine/receipts/stream` (native Rust SSE with catch-up replay)
//!
//! Internal loopback push (local-only + active `auth_control` capability):
//! - `POST /api/__gateway/cross-machine/event`

use std::convert::Infallible;
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{Method, Response, StatusCode};
use futures_util::stream;
use multicc_core::auth_runtime::Snapshot;
pub use multicc_core::cross_machine_dispatch::Route;
use multicc_core::cross_machine_dispatch::{
    self as core, format_sse, operation_id_in, validate_ack_body, validate_admit_body,
    CrossMachineEvent, SSE_HEARTBEAT_INTERVAL,
};
use multicc_core::http_gate;
use multicc_core::machines::{self, AuthorizedGrant};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};

use crate::app::express::{self, RequestCtx};
use crate::app::{options, App};
use crate::host_port;

/// Reuses the existing orchestration host port (zero new Node Express routes).
const HOST_PATH: &str = "/api/__host/orchestration";
const MAX_BODY_BYTES: usize = 512 * 1024;

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    core::claim(method.as_str(), path)
}

pub fn options_share(path: &str) -> Option<String> {
    core::options_share(path)
}

fn host_unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        503,
        &json!({
            "ok": false,
            "code": "rust_backend_unavailable",
            "error": "跨机编排接口尚未就绪，请检查目标电脑 MultiCC 主服务是否运行中",
        }),
        &[],
    )
}

fn require_grant(app: &App, ctx: &RequestCtx) -> Result<AuthorizedGrant, Box<Response<Body>>> {
    let credential = ctx.headers.get("x-multicc-machine-grant").unwrap_or("");
    let root = app.data_root.to_string_lossy().into_owned();
    machines::authorize_grant(&root, credential, ctx.method.as_str(), &ctx.original_url).ok_or_else(
        || {
            Box::new(express::json(
                ctx,
                403,
                &json!({
                    "ok": false,
                    "code": "machine_grant_required",
                    "error": "跨机派发接口仅允许已配对电脑凭有效的 x-multicc-machine-grant 访问",
                }),
                &[],
            ))
        },
    )
}

async fn read_json_body(ctx: &RequestCtx, body: Body) -> Result<Value, Box<Response<Body>>> {
    let bytes = to_bytes(body, MAX_BODY_BYTES).await.map_err(|_| {
        Box::new(express::json(
            ctx,
            413,
            &json!({
                "ok": false,
                "code": "payload_too_large",
                "error": "请求体超过大小限制",
            }),
            &[],
        ))
    })?;
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        Box::new(express::json(
            ctx,
            400,
            &json!({
                "ok": false,
                "code": "invalid_json",
                "error": "请求体不是合法 JSON",
            }),
            &[],
        ))
    })
}

async fn call_host(ctx: &RequestCtx, host: u16, payload: Value) -> Response<Body> {
    match host_port::call(host, HOST_PATH, &payload).await {
        Ok(reply) => {
            let inner = reply.get("value").unwrap_or(&reply);
            let status = inner
                .get("status")
                .and_then(Value::as_u64)
                .and_then(|s| u16::try_from(s).ok())
                .unwrap_or(200);
            let body = inner.get("body").cloned().unwrap_or_else(|| json!({}));
            express::json(ctx, status, &body, &[("Cache-Control", "no-store")])
        }
        Err(_) => host_unavailable(ctx),
    }
}

/// Internal loopback push from the slave Node/addon process into the gateway
/// SSE broadcast hub. Does not require an auth snapshot round-trip.
pub async fn handle_internal_event(
    app: &Arc<App>,
    ctx: &RequestCtx,
    body: Body,
    peer: &str,
) -> Response<Body> {
    if !http_gate::is_local_request(peer, &ctx.headers) {
        return express::json(
            ctx,
            403,
            &json!({ "ok": false, "code": "local_only", "error": "loopback only" }),
            &[],
        );
    }
    let cap = ctx
        .headers
        .get("x-multicc-gateway-capability")
        .unwrap_or("");
    if !app.auth.verify_capability(cap) {
        return express::json(
            ctx,
            403,
            &json!({ "ok": false, "code": "invalid_capability", "error": "forbidden" }),
            &[],
        );
    }
    let bytes = match to_bytes(body, MAX_BODY_BYTES).await {
        Ok(b) => b,
        Err(_) => {
            return express::json(
                ctx,
                413,
                &json!({ "ok": false, "code": "payload_too_large", "error": "event too large" }),
                &[],
            );
        }
    };
    let Ok(event) = serde_json::from_slice::<CrossMachineEvent>(&bytes) else {
        return express::json(
            ctx,
            400,
            &json!({ "ok": false, "code": "invalid_event", "error": "invalid cross-machine event" }),
            &[],
        );
    };
    if event.master_machine_id.trim().is_empty() || event.event.trim().is_empty() {
        return express::json(
            ctx,
            400,
            &json!({ "ok": false, "code": "invalid_event", "error": "masterMachineId and event are required" }),
            &[],
        );
    }
    let receivers = app.cross_machine_hub.publish(event);
    express::json(
        ctx,
        200,
        &json!({ "ok": true, "receivers": receivers }),
        &[],
    )
}

pub async fn handle(
    app: &Arc<App>,
    route: Route,
    ctx: &RequestCtx,
    body: Body,
    peer: &str,
    snapshot: &Snapshot,
    host: u16,
) -> Response<Body> {
    if route == Route::Options {
        let allow = options_share(&ctx.path).unwrap_or_else(|| "GET,HEAD,POST".to_string());
        return options(ctx, &allow);
    }
    if let Some(rejected) = app.gate(ctx, peer, snapshot).await {
        return rejected;
    }
    let grant = match require_grant(app, ctx) {
        Ok(g) => g,
        Err(resp) => return *resp,
    };
    let grant_json = json!({
        "id": grant.id,
        "ownerId": grant.owner_id,
        "name": grant.name,
    });
    match route {
        Route::TargetsGet => {
            call_host(
                ctx,
                host,
                json!({
                    "op": "cross-machine-targets",
                    "grant": grant_json,
                }),
            )
            .await
        }
        Route::DispatchesPost => {
            let parsed = match read_json_body(ctx, body).await {
                Ok(v) => v,
                Err(resp) => return *resp,
            };
            if let Err((status, code, msg)) = validate_admit_body(&parsed) {
                return express::json(
                    ctx,
                    status,
                    &json!({ "ok": false, "code": code, "error": msg }),
                    &[],
                );
            }
            call_host(
                ctx,
                host,
                json!({
                    "op": "cross-machine-admit",
                    "grant": grant_json,
                    "body": parsed,
                }),
            )
            .await
        }
        Route::DispatchGet => {
            let Some(op_id) = operation_id_in(&ctx.path) else {
                return express::json(
                    ctx,
                    400,
                    &json!({ "ok": false, "code": "invalid_operation_id", "error": "非法的 operationId" }),
                    &[],
                );
            };
            call_host(
                ctx,
                host,
                json!({
                    "op": "cross-machine-status",
                    "grant": grant_json,
                    "operationId": op_id,
                }),
            )
            .await
        }
        Route::DispatchCancelPost => {
            let Some(op_id) = operation_id_in(&ctx.path) else {
                return express::json(
                    ctx,
                    400,
                    &json!({ "ok": false, "code": "invalid_operation_id", "error": "非法的 operationId" }),
                    &[],
                );
            };
            let parsed = match read_json_body(ctx, body).await {
                Ok(v) => v,
                Err(resp) => return *resp,
            };
            call_host(
                ctx,
                host,
                json!({
                    "op": "cross-machine-cancel",
                    "grant": grant_json,
                    "operationId": op_id,
                    "body": parsed,
                }),
            )
            .await
        }
        Route::ReceiptsAckPost => {
            let parsed = match read_json_body(ctx, body).await {
                Ok(v) => v,
                Err(resp) => return *resp,
            };
            let (op_id, settle) = match validate_ack_body(&parsed) {
                Ok(pair) => pair,
                Err((status, code, msg)) => {
                    return express::json(
                        ctx,
                        status,
                        &json!({ "ok": false, "code": code, "error": msg }),
                        &[],
                    );
                }
            };
            call_host(
                ctx,
                host,
                json!({
                    "op": "cross-machine-ack",
                    "grant": grant_json,
                    "operationId": op_id,
                    "settle": settle,
                }),
            )
            .await
        }
        Route::ReceiptsStreamGet => handle_receipts_stream(app, grant, host).await,
        Route::InternalEventPost | Route::Options => unreachable!(),
    }
}

async fn fetch_pending_receipts(host: u16, grant: &AuthorizedGrant) -> Vec<Value> {
    if host == 0 {
        return Vec::new();
    }
    let payload = json!({
        "op": "cross-machine-pending-receipts",
        "grant": {
            "id": grant.id,
            "ownerId": grant.owner_id,
            "name": grant.name,
        },
    });
    match host_port::call(host, HOST_PATH, &payload).await {
        Ok(reply) => reply
            .get("value")
            .unwrap_or(&reply)
            .get("body")
            .and_then(|b| b.get("receipts"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

async fn handle_receipts_stream(
    app: &Arc<App>,
    grant: AuthorizedGrant,
    host: u16,
) -> Response<Body> {
    // Subscribe BEFORE fetching catch-up receipts so no settlement occurring
    // during catch-up can be missed between SQLite read and live subscription.
    let mut rx = app.cross_machine_hub.subscribe();
    let initial_receipts = fetch_pending_receipts(host, &grant).await;
    let data_root = app.data_root.to_string_lossy().into_owned();

    let (tx, stream_rx) = mpsc::channel::<String>(64);
    tokio::spawn(async move {
        if tx.send(": connected\n\n".to_string()).await.is_err() {
            return;
        }
        for receipt in initial_receipts {
            if tx.send(format_sse("receipt", &receipt)).await.is_err() {
                return;
            }
        }
        let mut ticker = tokio::time::interval(SSE_HEARTBEAT_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await;
        loop {
            tokio::select! {
                msg = rx.recv() => {
                    match msg {
                        Ok(ev) => {
                            if ev.master_machine_id != grant.owner_id {
                                continue;
                            }
                            if tx.send(format_sse(&ev.event, &ev.payload)).await.is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            let missed = fetch_pending_receipts(host, &grant).await;
                            for receipt in missed {
                                if tx.send(format_sse("receipt", &receipt)).await.is_err() {
                                    return;
                                }
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
                _ = ticker.tick() => {
                    if !machines::grant_active(&data_root, &grant.id) {
                        let _ = tx.send(format_sse("revoked", &json!({ "code": "machine_grant_revoked" }))).await;
                        break;
                    }
                    if tx.send(": heartbeat\n\n".to_string()).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    let body_stream = stream::unfold(stream_rx, |mut rx| async move {
        rx.recv()
            .await
            .map(|chunk| (Ok::<String, Infallible>(chunk), rx))
    });
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "text/event-stream; charset=utf-8")
        .header("Cache-Control", "no-cache, no-store")
        .header("Connection", "keep-alive")
        .header("X-Accel-Buffering", "no")
        .body(Body::from_stream(body_stream))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}
