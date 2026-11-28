//! Cross-machine `dispatch_master` / `route_task` / `dispatch_slave` protocol,
//! validation, SSE framing/parsing, outbound grant-authenticated transport,
//! and live receipt hub.
//!
//! Topology: a NAT'd master machine A initiates both control RPCs and a
//! long-lived SSE receipt stream (`GET /api/cross-machine/receipts/stream`) to
//! a paired peer B using A's stored `x-multicc-machine-grant` credential. Peer
//! B authenticates A's `grant.owner_id`, enforces single-hop and per-master
//! tenant isolation, persists receipts durably in B's orchestration SQLite, and
//! pushes receipts + sync progress over the live SSE stream (with catch-up
//! replay on connect/reconnect and explicit ack).

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, watch};

use crate::machines;
use crate::machines::network;

/// Maximum dispatched message length in bytes (matches `TARGET_SCHEMA` / `dispatch_master`).
pub const MAX_MESSAGE_BYTES: usize = 262_144;
/// Maximum `newTask.title` length in Unicode scalar values.
pub const MAX_TITLE_CHARS: usize = 120;
/// Maximum SSE frame payload size we buffer before rejecting a corrupt frame (2 MiB).
pub const MAX_SSE_BUFFER_BYTES: usize = 2 * 1024 * 1024;
/// Server heartbeat cadence on `GET /api/cross-machine/receipts/stream`.
pub const SSE_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
/// Client per-chunk read deadline (> 2x heartbeat) so stale/half-open NAT sockets reconnect promptly.
pub const SSE_CLIENT_READ_TIMEOUT: Duration = Duration::from_secs(45);
/// Outbound JSON control RPC timeout.
pub const CONTROL_RPC_TIMEOUT: Duration = Duration::from_secs(30);

const BACKOFF_MS: &[u64] = &[1_000, 2_000, 5_000, 15_000, 30_000];

/// Routes owned by the cross-machine dispatch cluster in `native/gateway`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    TargetsGet,
    DispatchesPost,
    DispatchGet,
    DispatchCancelPost,
    ReceiptsAckPost,
    ReceiptsStreamGet,
    InternalEventPost,
    Options,
}

#[derive(Clone, Copy)]
struct Layer {
    method: &'static str,
    segments: &'static [&'static str],
    route: Route,
}

const LAYERS: &[Layer] = &[
    Layer {
        method: "GET",
        segments: &["api", "cross-machine", "targets"],
        route: Route::TargetsGet,
    },
    Layer {
        method: "POST",
        segments: &["api", "cross-machine", "dispatches"],
        route: Route::DispatchesPost,
    },
    Layer {
        method: "GET",
        segments: &["api", "cross-machine", "dispatches", ":opId"],
        route: Route::DispatchGet,
    },
    Layer {
        method: "POST",
        segments: &["api", "cross-machine", "dispatches", ":opId", "cancel"],
        route: Route::DispatchCancelPost,
    },
    Layer {
        method: "POST",
        segments: &["api", "cross-machine", "receipts", "ack"],
        route: Route::ReceiptsAckPost,
    },
    Layer {
        method: "GET",
        segments: &["api", "cross-machine", "receipts", "stream"],
        route: Route::ReceiptsStreamGet,
    },
    Layer {
        method: "POST",
        segments: &["api", "__gateway", "cross-machine", "event"],
        route: Route::InternalEventPost,
    },
];

fn split_segments(path: &str) -> Vec<&str> {
    let clean = path.split('?').next().unwrap_or(path);
    clean
        .trim_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect()
}

fn layer_matches(layer: &Layer, parts: &[&str]) -> bool {
    if layer.segments.len() != parts.len() {
        return false;
    }
    layer
        .segments
        .iter()
        .zip(parts.iter())
        .all(|(pat, actual)| {
            if pat.starts_with(':') {
                !actual.is_empty()
            } else {
                pat.eq_ignore_ascii_case(actual)
            }
        })
}

pub fn claim(method: &str, path: &str) -> Option<Route> {
    let parts = split_segments(path);
    if parts.is_empty() {
        return None;
    }
    if method.eq_ignore_ascii_case("OPTIONS") {
        let matched = LAYERS
            .iter()
            .any(|l| l.route != Route::InternalEventPost && layer_matches(l, &parts));
        return matched.then_some(Route::Options);
    }
    let wanted = if method.eq_ignore_ascii_case("HEAD") {
        "GET"
    } else {
        method
    };
    LAYERS
        .iter()
        .find(|l| l.method.eq_ignore_ascii_case(wanted) && layer_matches(l, &parts))
        .map(|l| l.route)
}

pub fn options_share(path: &str) -> Option<String> {
    let parts = split_segments(path);
    let mut methods: Vec<&'static str> = Vec::new();
    for layer in LAYERS {
        if layer.route == Route::InternalEventPost || !layer_matches(layer, &parts) {
            continue;
        }
        if !methods.contains(&layer.method) {
            methods.push(layer.method);
        }
        if layer.method == "GET" && !methods.contains(&"HEAD") {
            methods.push("HEAD");
        }
    }
    (!methods.is_empty()).then(|| methods.join(","))
}

pub fn operation_id_in(path: &str) -> Option<String> {
    let parts = split_segments(path);
    if parts.len() >= 4
        && parts[0].eq_ignore_ascii_case("api")
        && parts[1].eq_ignore_ascii_case("cross-machine")
        && parts[2].eq_ignore_ascii_case("dispatches")
    {
        let id = parts[3].trim();
        if is_valid_operation_id(id) {
            return Some(id.to_string());
        }
    }
    None
}

pub fn is_valid_operation_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':'))
}

/// Validates an incoming cross-machine dispatch admission payload on peer B.
pub fn validate_admit_body(body: &Value) -> Result<(), (u16, &'static str, &'static str)> {
    let Some(obj) = body.as_object() else {
        return Err((400, "invalid_payload", "请求体必须是 JSON 对象"));
    };
    // Single-hop guard: never permit chained machine_id forwarding.
    for key in ["machineId", "machine_id"] {
        if let Some(v) = obj.get(key) {
            let non_empty = match v {
                Value::Null => false,
                Value::String(s) => !s.trim().is_empty(),
                _ => true,
            };
            if non_empty {
                return Err((
                    400,
                    "cross_machine_multihop_denied",
                    "不支持多跳跨机派发，请直接从主控机连目标电脑",
                ));
            }
        }
    }
    let op_id = obj.get("operationId").and_then(Value::as_str).unwrap_or("");
    if !is_valid_operation_id(op_id) {
        return Err((400, "invalid_operation_id", "缺少或非法的 operationId"));
    }
    let idemp = obj
        .get("idempotencyKey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if idemp.is_empty() || idemp.len() > 256 {
        return Err((
            400,
            "invalid_idempotency_key",
            "缺少或非法的 idempotencyKey",
        ));
    }
    let mode = obj.get("mode").and_then(Value::as_str).unwrap_or("");
    if !matches!(mode, "none" | "sync" | "async") {
        return Err((400, "invalid_mode", "mode 必须为 none、sync 或 async"));
    }
    let message = obj.get("message").and_then(Value::as_str).unwrap_or("");
    if message.trim().is_empty() || message.len() > MAX_MESSAGE_BYTES {
        return Err((400, "invalid_message", "message 不能为空且不得超过 256KB"));
    }
    let target_id = obj
        .get("targetSessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let new_task = obj.get("newTask").filter(|v| !v.is_null());
    match (target_id, new_task) {
        (Some(_), Some(_)) | (None, None) => {
            return Err((
                400,
                "invalid_target",
                "targetSessionId 与 newTask 必须二选一",
            ));
        }
        (Some(tid), None) => {
            if tid.len() > 256 {
                return Err((400, "invalid_target", "targetSessionId 过长"));
            }
        }
        (None, Some(nt)) => {
            let Some(nt_obj) = nt.as_object() else {
                return Err((400, "invalid_new_task", "newTask 必须是对象"));
            };
            let title = nt_obj
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS {
                return Err((
                    400,
                    "invalid_new_task_title",
                    "newTask.title 必填且不超过 120 字",
                ));
            }
        }
    }
    Ok(())
}

/// Validates an incoming receipt acknowledgement payload.
pub fn validate_ack_body(body: &Value) -> Result<(String, u64), (u16, &'static str, &'static str)> {
    let Some(obj) = body.as_object() else {
        return Err((400, "invalid_payload", "请求体必须是 JSON 对象"));
    };
    let op_id = obj.get("operationId").and_then(Value::as_str).unwrap_or("");
    if !is_valid_operation_id(op_id) {
        return Err((400, "invalid_operation_id", "缺少或非法的 operationId"));
    }
    let settle = obj
        .get("settle")
        .and_then(Value::as_u64)
        .filter(|&n| n >= 1)
        .unwrap_or(1);
    Ok((op_id.to_string(), settle))
}

/// Strict owner isolation: a peer grant may only inspect, cancel, ack, or
/// receive SSE events for operations owned by that grant's `owner_id`.
pub fn owner_matches(op_master_machine_id: Option<&str>, grant_owner_id: &str) -> bool {
    !grant_owner_id.is_empty() && op_master_machine_id == Some(grant_owner_id)
}

pub fn backoff_delay(attempt: usize) -> Duration {
    let idx = attempt.min(BACKOFF_MS.len().saturating_sub(1));
    Duration::from_millis(BACKOFF_MS[idx])
}

/// Formats one SSE event frame (`event: <name>\ndata: <json>\n\n`).
pub fn format_sse(event: &str, payload: &Value) -> String {
    let safe_event: String = event
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        .collect();
    let name = if safe_event.is_empty() {
        "message"
    } else {
        safe_event.as_str()
    };
    let data = serde_json::to_string(payload).unwrap_or_else(|_| "{}".to_string());
    format!("event: {name}\ndata: {data}\n\n")
}

/// Parsed Server-Sent Event frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseFrame {
    pub event: String,
    pub data: String,
}

/// Incremental SSE frame extractor that tolerates arbitrary TCP chunk splits,
/// CRLF/LF line endings, and comment heartbeats (`: heartbeat`).
#[derive(Debug, Default)]
pub struct SseBuffer {
    buf: String,
}

impl SseBuffer {
    pub fn push_bytes(&mut self, bytes: &[u8]) -> Result<Vec<SseFrame>, &'static str> {
        let text = String::from_utf8_lossy(bytes);
        if self.buf.len().saturating_add(text.len()) > MAX_SSE_BUFFER_BYTES {
            self.buf.clear();
            return Err("sse_buffer_overflow");
        }
        if text.contains('\r') {
            self.buf.push_str(&text.replace("\r\n", "\n"));
        } else {
            self.buf.push_str(&text);
        }
        let mut frames = Vec::new();
        while let Some(pos) = self.buf.find("\n\n") {
            let block: String = self.buf.drain(..pos + 2).collect();
            let trimmed = block.trim_end_matches('\n');
            if let Some(frame) = parse_sse_block(trimmed) {
                frames.push(frame);
            }
        }
        Ok(frames)
    }
}

fn parse_sse_block(block: &str) -> Option<SseFrame> {
    let mut event = String::new();
    let mut data_lines: Vec<&str> = Vec::new();
    for line in block.split('\n') {
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("event:") {
            event = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.strip_prefix(' ').unwrap_or(rest));
        }
    }
    if data_lines.is_empty() {
        return None;
    }
    if event.is_empty() {
        event = "message".to_string();
    }
    Some(SseFrame {
        event,
        data: data_lines.join("\n"),
    })
}

/// Event broadcast from the slave's orchestration runtime to its gateway SSE hub.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossMachineEvent {
    pub master_machine_id: String,
    pub event: String,
    pub payload: Value,
}

/// In-process Rust broadcast hub used by `native/gateway` to fan out receipt
/// and progress events to connected master SSE streams in real time.
pub struct CrossMachineHub {
    tx: broadcast::Sender<CrossMachineEvent>,
}

impl Default for CrossMachineHub {
    fn default() -> Self {
        Self::new()
    }
}

impl CrossMachineHub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self { tx }
    }

    pub fn publish(&self, event: CrossMachineEvent) -> usize {
        self.tx.send(event).unwrap_or(0)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CrossMachineEvent> {
        self.tx.subscribe()
    }
}

/// Executes a grant-authenticated JSON control RPC against a paired peer.
/// The peer's `mcg_...` grant secret never leaves Rust.
pub async fn request_peer_json(
    root: &str,
    machine_id: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Value {
    let result = async {
        let peer = machines::peer_handle(root, machine_id)?;
        let (self_id, self_name) = machines::self_identity(root)?;
        if !network::api_path(path) {
            return Ok(json!({
                "status": 403,
                "data": { "ok": false, "code": "machine_path_denied", "error": "不允许访问该跨机路径" }
            }));
        }
        let origin = network::origin(&peer.origin)?;
        let url = origin.join(path).map_err(|_| {
            machines::error_reply_err(400, "machine_path_invalid", "跨机请求地址无效")
        })?;
        let client = network::stream_client(&origin).await?;
        let req_method = match method {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            "DELETE" => reqwest::Method::DELETE,
            _ => {
                return Ok(json!({
                    "status": 405,
                    "data": { "ok": false, "code": "method_not_allowed", "error": "不支持的跨机请求方法" }
                }));
            }
        };
        let mut req = client
            .request(req_method, url)
            .timeout(CONTROL_RPC_TIMEOUT)
            .header("x-multicc-machine-grant", &peer.grant)
            .header("accept", "application/json");
        if let Some(payload) = body {
            req = req
                .header("content-type", "application/json")
                .body(serde_json::to_vec(payload).unwrap_or_else(|_| b"{}".to_vec()));
        }
        let response = req
            .send()
            .await
            .map_err(|e| network::transport_error(&e, "暂时连接不上目标电脑"))?;
        if response.status().is_redirection() {
            return Ok(json!({
                "status": 502,
                "data": { "ok": false, "code": "machine_redirect_rejected", "error": "目标电脑返回了重定向，请检查访问地址" }
            }));
        }
        let status = response.status().as_u16();
        let bytes = response
            .bytes()
            .await
            .map_err(|e| network::transport_error(&e, "读取目标电脑响应失败"))?;
        let data: Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| {
            let text = String::from_utf8_lossy(&bytes);
            json!({ "ok": status < 400, "error": text.chars().take(500).collect::<String>() })
        });
        Ok::<Value, machines::Error>(json!({
            "status": status,
            "peer": { "id": peer.id, "name": peer.name, "origin": peer.origin },
            "selfMachine": { "id": self_id, "name": self_name },
            "data": data,
        }))
    }
    .await;
    match result {
        Ok(value) => value,
        Err(err) => machines::error_reply(err),
    }
}

/// Persistent grant-authenticated SSE client run on the master machine.
/// Reconnects automatically with exponential backoff until `stop_rx` signals
/// `true`, the grant is rejected (`401`/`403`), or `on_event` returns `false`.
pub async fn stream_peer_receipts<F, Fut>(
    root: String,
    machine_id: String,
    mut stop_rx: watch::Receiver<bool>,
    on_event: F,
) where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let mut attempt: usize = 0;
    loop {
        if *stop_rx.borrow() {
            break;
        }
        let outcome = run_one_sse_session(&root, &machine_id, &mut stop_rx, &on_event).await;
        match outcome {
            StreamSessionEnd::Stopped | StreamSessionEnd::Unauthorized => break,
            StreamSessionEnd::ConnectedThenDropped => {
                attempt = 0;
            }
            StreamSessionEnd::Failed => {
                attempt = attempt.saturating_add(1);
            }
        }
        if *stop_rx.borrow() {
            break;
        }
        let delay = backoff_delay(attempt);
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = stop_rx.changed() => {
                if *stop_rx.borrow() {
                    break;
                }
            }
        }
    }
}

enum StreamSessionEnd {
    Stopped,
    Unauthorized,
    ConnectedThenDropped,
    Failed,
}

async fn run_one_sse_session<F, Fut>(
    root: &str,
    machine_id: &str,
    stop_rx: &mut watch::Receiver<bool>,
    on_event: &F,
) -> StreamSessionEnd
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let peer = match machines::peer_handle(root, machine_id) {
        Ok(p) => p,
        Err(_) => return StreamSessionEnd::Unauthorized,
    };
    let origin = match network::origin(&peer.origin) {
        Ok(u) => u,
        Err(_) => return StreamSessionEnd::Failed,
    };
    let url = match origin.join("/api/cross-machine/receipts/stream") {
        Ok(u) => u,
        Err(_) => return StreamSessionEnd::Failed,
    };
    let client = match network::stream_client(&origin).await {
        Ok(c) => c,
        Err(_) => return StreamSessionEnd::Failed,
    };
    let response = tokio::select! {
        res = client
            .get(url)
            .header("x-multicc-machine-grant", &peer.grant)
            .header("accept", "text/event-stream")
            .send() => match res {
                Ok(r) => r,
                Err(_) => return StreamSessionEnd::Failed,
            },
        _ = stop_rx.changed() => return StreamSessionEnd::Stopped,
    };
    let status = response.status().as_u16();
    if status == 401 || status == 403 {
        let _ = on_event(
            json!({
                "event": "unauthorized",
                "machineId": machine_id,
                "status": status,
            })
            .to_string(),
        )
        .await;
        return StreamSessionEnd::Unauthorized;
    }
    if status != 200 {
        return StreamSessionEnd::Failed;
    }
    let mut response = response;
    let mut sse = SseBuffer::default();
    loop {
        let next_chunk = tokio::select! {
            chunk = tokio::time::timeout(SSE_CLIENT_READ_TIMEOUT, response.chunk()) => chunk,
            _ = stop_rx.changed() => {
                if *stop_rx.borrow() {
                    return StreamSessionEnd::Stopped;
                }
                continue;
            }
        };
        let chunk = match next_chunk {
            Ok(Ok(Some(bytes))) => bytes,
            Ok(Ok(None)) | Ok(Err(_)) | Err(_) => return StreamSessionEnd::ConnectedThenDropped,
        };
        let frames = match sse.push_bytes(&chunk) {
            Ok(f) => f,
            Err(_) => return StreamSessionEnd::ConnectedThenDropped,
        };
        for frame in frames {
            let parsed_data: Value =
                serde_json::from_str(&frame.data).unwrap_or_else(|_| Value::String(frame.data));
            let envelope = json!({
                "event": frame.event,
                "machineId": machine_id,
                "data": parsed_data,
            })
            .to_string();
            if !on_event(envelope).await {
                return StreamSessionEnd::Stopped;
            }
        }
    }
}

/// Best-effort loopback notification from slave's `native/addon` into its
/// local `multicc-gateway` SSE hub. Even if missed (e.g. gateway restarting),
/// durable SQLite catch-up guarantees eventual delivery on SSE reconnect.
pub async fn notify_gateway_event(port: u16, capability: &str, event: &Value) -> bool {
    if port == 0 || capability.is_empty() {
        return false;
    }
    let url = format!("http://127.0.0.1:{port}/api/__gateway/cross-machine/event");
    let client = match reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let body = serde_json::to_vec(event).unwrap_or_else(|_| b"{}".to_vec());
    match client
        .post(url)
        .header("content-type", "application/json")
        .header("x-multicc-gateway-capability", capability)
        .body(body)
        .send()
        .await
    {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_claim_and_options_cover_all_endpoints() {
        assert_eq!(
            claim("GET", "/api/cross-machine/targets"),
            Some(Route::TargetsGet)
        );
        assert_eq!(
            claim("POST", "/api/cross-machine/dispatches"),
            Some(Route::DispatchesPost)
        );
        assert_eq!(
            claim("GET", "/api/cross-machine/dispatches/op_abc-123"),
            Some(Route::DispatchGet)
        );
        assert_eq!(
            claim("POST", "/api/cross-machine/dispatches/op_abc-123/cancel"),
            Some(Route::DispatchCancelPost)
        );
        assert_eq!(
            claim("POST", "/api/cross-machine/receipts/ack"),
            Some(Route::ReceiptsAckPost)
        );
        assert_eq!(
            claim("GET", "/api/cross-machine/receipts/stream"),
            Some(Route::ReceiptsStreamGet)
        );
        assert_eq!(
            claim("POST", "/api/__gateway/cross-machine/event"),
            Some(Route::InternalEventPost)
        );
        assert_eq!(claim("OPTIONS", "/api/__gateway/cross-machine/event"), None);
        assert_eq!(
            options_share("/api/cross-machine/dispatches/op_abc-123").as_deref(),
            Some("GET,HEAD")
        );
        assert_eq!(
            operation_id_in("/api/cross-machine/dispatches/op_abc-123/cancel").as_deref(),
            Some("op_abc-123")
        );
        assert_eq!(
            operation_id_in("/api/cross-machine/dispatches/bad%20id"),
            None
        );
    }

    #[test]
    fn validate_admit_rejects_multihop_and_ambiguous_target() {
        let ok = json!({
            "operationId": "op_12345",
            "idempotencyKey": "router:abc",
            "mode": "async",
            "targetSessionId": "task-1",
            "message": "run check"
        });
        assert!(validate_admit_body(&ok).is_ok());

        let multihop = json!({
            "machine_id": "machine_other",
            "operationId": "op_12345",
            "idempotencyKey": "router:abc",
            "mode": "async",
            "targetSessionId": "task-1",
            "message": "run check"
        });
        assert_eq!(
            validate_admit_body(&multihop).unwrap_err().1,
            "cross_machine_multihop_denied"
        );

        let both_targets = json!({
            "operationId": "op_12345",
            "idempotencyKey": "router:abc",
            "mode": "async",
            "targetSessionId": "task-1",
            "newTask": { "title": "x" },
            "message": "run check"
        });
        assert_eq!(
            validate_admit_body(&both_targets).unwrap_err().1,
            "invalid_target"
        );

        let new_task_ok = json!({
            "operationId": "op_12345",
            "idempotencyKey": "router:abc",
            "mode": "sync",
            "newTask": { "title": "Remote Build", "dirId": "dir_1" },
            "message": "build x64"
        });
        assert!(validate_admit_body(&new_task_ok).is_ok());
    }

    #[test]
    fn owner_isolation_requires_exact_match() {
        assert!(owner_matches(Some("machine_a"), "machine_a"));
        assert!(!owner_matches(Some("machine_a"), "machine_b"));
        assert!(!owner_matches(None, "machine_a"));
        assert!(!owner_matches(Some(""), ""));
    }

    #[test]
    fn sse_buffer_handles_split_chunks_comments_and_crlf() {
        let mut buf = SseBuffer::default();
        let frame = format_sse("receipt", &json!({ "operationId": "op_1", "settle": 1 }));
        let full = format!(": heartbeat\r\n\r\n{}", frame.replace('\n', "\r\n"));
        let mid = full.len() / 2;
        let first = buf.push_bytes(&full.as_bytes()[..mid]).unwrap();
        assert!(first.is_empty());
        let second = buf.push_bytes(&full.as_bytes()[mid..]).unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].event, "receipt");
        let val: Value = serde_json::from_str(&second[0].data).unwrap();
        assert_eq!(val["operationId"], "op_1");
        assert_eq!(val["settle"], 1);
    }

    #[test]
    fn backoff_is_monotonic_and_capped() {
        assert_eq!(backoff_delay(0), Duration::from_secs(1));
        assert_eq!(backoff_delay(1), Duration::from_secs(2));
        assert_eq!(backoff_delay(2), Duration::from_secs(5));
        assert_eq!(backoff_delay(99), Duration::from_secs(30));
    }
}
