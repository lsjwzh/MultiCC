//! HTTP 路由与内部鉴权（移植 src/remote-screen.js 的 mount + 各路由）。
//!
//! Node 在全站鉴权之后把 `/api/remote-screen/` 开头的请求原样转过来，方法的
//! 语义、状态码、响应头和中文文案都必须与迁移前逐字一致 —— 前端不认识别的形状。
//!
//! 安全边界沿用 JS：输入固定挂在 'remote-screen' 会话租约下，Agent 的锁屏拒绝 /
//! Esc 急停 / 受保护 App 护栏全部照旧生效；普通输入不开放 unlock，唤起屏幕走独立的
//! 开关校验接口（wake.rs）。
//!
//! 所有请求（含 WS 升级）都必须带 `x-multicc-remote-secret`，否则 403，不给任何细节：
//! 这个端口只监听 127.0.0.1，它的唯一合法调用方就是同机的 Node 进程。

use crate::agent::agent_failed;
use crate::agent::AgentClient;
use crate::annotation::handle_annotation;
use crate::capture::{Frame, Screen, SESSION};
use crate::describe::describe;
use crate::error::{describe_source, error_field, AppError, AppResult};
use crate::host::Host;
use crate::region::{js_num, js_num_str, js_number, parse_region};
use crate::stats::Registry;
use crate::wake::WakeState;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{DefaultBodyLimit, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub const SECRET_HEADER: &str = "x-multicc-remote-secret";

/// op 白名单：前端能触发的动作全集。`unlock` 故意不在这里 —— 它只属于唤屏接口。
pub const INPUT_OPS: [&str; 10] = [
    "click", "move", "scroll", "drag", "pointer", "type", "press", "release", "resume", "status",
];

#[derive(Clone)]
pub struct AppState {
    pub screen: Arc<Screen>,
    pub host: Arc<Host>,
    pub agent: Arc<dyn AgentClient>,
    pub wake: Arc<WakeState>,
    pub stats: Arc<Registry>,
    /// 直连实现；None = 只走中继（p2p.rs 未接入时的占位）。
    pub p2p: Option<crate::p2p_api::P2pFactory>,
    pub secret: Arc<String>,
}

impl AppState {
    pub fn new(
        dir: PathBuf,
        host: Arc<Host>,
        agent: Arc<dyn AgentClient>,
        secret: impl Into<String>,
    ) -> Self {
        let screen = Arc::new(Screen::new(dir, host.clone(), agent.clone()));
        Self {
            screen,
            host,
            agent,
            wake: Arc::new(WakeState::default()),
            stats: Arc::new(Registry::new()),
            p2p: crate::p2p::factory(),
            secret: Arc::new(secret.into()),
        }
    }

    pub fn with_p2p(mut self, p2p: Option<crate::p2p_api::P2pFactory>) -> Self {
        self.p2p = p2p;
        self
    }
}

/// `res.status(...).json(...)`：Express 的 content-type 带 charset，照抄。
pub fn json_response(status: u16, body: Value) -> Response {
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut response = (status, Json(body)).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}

/// 错误回复：Agent 的 reason/error 优先，文案走 describe 的 11 条中文表。
pub fn send_error(st: &AppState, error: &AppError) -> Response {
    let mut map = Map::new();
    map.insert("ok".into(), json!(false));
    map.insert("error".into(), error_field(error));
    map.insert(
        "message".into(),
        json!(describe(
            &describe_source(error),
            st.host.profile.install_hint.as_deref()
        )),
    );
    json_response(error.status, Value::Object(map))
}

/// JS `String(v || '')`：假值一律空串，其余按 String() 显示。
fn string_or_empty(value: Option<&Value>) -> String {
    if !crate::jsval::truthy(value) {
        return String::new();
    }
    crate::jsval::display(value)
}

/// JS `Math.round`：负数也是向 +∞ 取半（(-1.5).round() == -1，Rust 的 round 是 -2）。
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

fn num_field(map: &Map<String, Value>, key: &str) -> Option<f64> {
    map.get(key).and_then(js_number)
}

/// JS `num(v) || fallback`：不是「缺键才回退」，0、-0、NaN（num 已滤掉）都算假。
/// drag 的 ms、click 的 count、scroll 的 amount 全靠这个语义。
fn num_or(map: &Map<String, Value>, key: &str, fallback: f64) -> f64 {
    num_field(map, key)
        .filter(|value| *value != 0.0)
        .unwrap_or(fallback)
}

fn valid_viewer(text: &str) -> bool {
    let len = text.chars().count();
    (1..=64).contains(&len) && text.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// 前端字段 → Agent 请求。只拼白名单 op 认识的字段，并强制转型。
pub fn build_input(body: &Value) -> AppResult<Value> {
    let empty = Map::new();
    let map = body.as_object().unwrap_or(&empty);
    let op = string_or_empty(map.get("op"));
    if !INPUT_OPS.contains(&op.as_str()) {
        let shown = if op.is_empty() {
            "(empty)".to_string()
        } else {
            op.clone()
        };
        return Err(AppError::new(400, format!("op not allowed: {shown}")));
    }
    let mut req = Map::new();
    req.insert("op".into(), json!(op));
    req.insert("session".into(), json!(SESSION));
    if ["click", "move", "scroll", "drag", "pointer"].contains(&op.as_str()) {
        let (Some(x), Some(y)) = (num_field(map, "x"), num_field(map, "y")) else {
            return Err(AppError::new(400, "x and y are required"));
        };
        req.insert("x".into(), js_num(x));
        req.insert("y".into(), js_num(y));
        req.insert("allowSystem".into(), json!(true));
    }
    // 兼容通道：保留 Agent 现有的 RFB 拖动策略（pointer 只认 0/1 两种 mask）。
    if op == "pointer" {
        let viewer = match map.get("viewer") {
            Some(Value::String(text)) if valid_viewer(text) => text.clone(),
            _ => return Err(AppError::new(400, "viewer is required")),
        };
        let mask = match map.get("mask") {
            Some(Value::Number(number)) if number.as_f64() == Some(0.0) => 0,
            Some(Value::Number(number)) if number.as_f64() == Some(1.0) => 1,
            _ => return Err(AppError::new(400, "mask must be 0 or 1")),
        };
        req.insert("viewer".into(), json!(viewer));
        req.insert("mask".into(), json!(mask));
    }
    if op == "click" {
        if map.get("button").and_then(|v| v.as_str()) == Some("right") {
            req.insert("button".into(), json!("right"));
        }
        let count = num_or(map, "count", 1.0);
        req.insert("count".into(), js_num(count.clamp(1.0, 3.0)));
    }
    if op == "scroll" {
        let amount = num_or(map, "amount", 0.0);
        req.insert("amount".into(), js_num(js_round(amount).clamp(-50.0, 50.0)));
    }
    if op == "drag" {
        let (Some(x2), Some(y2)) = (num_field(map, "x2"), num_field(map, "y2")) else {
            return Err(AppError::new(400, "x2 and y2 are required"));
        };
        // JS `num(body.ms) || 300`：ms = 0 / -0 / null / false / NaN 都回退到 300。
        let ms = num_or(map, "ms", 300.0);
        req.insert("x2".into(), js_num(x2));
        req.insert("y2".into(), js_num(y2));
        req.insert("ms".into(), js_num(ms.clamp(80.0, 3000.0)));
    }
    if op == "type" {
        let text = match map.get("text") {
            Some(Value::String(text)) => text.clone(),
            _ => String::new(),
        };
        // JS 的 .length 是 UTF-16 码元数，不是字符数。
        if text.is_empty() || text.encode_utf16().count() > 4000 {
            return Err(AppError::new(400, "text is required (max 4000 chars)"));
        }
        req.insert("text".into(), json!(text));
        req.insert("allowTerminal".into(), json!(true));
        req.insert("allowSystem".into(), json!(true));
    }
    if op == "press" {
        let keys = match map.get("keys") {
            Some(Value::String(text)) => trim_js(text).to_string(),
            _ => String::new(),
        };
        if keys.is_empty() || keys.encode_utf16().count() > 40 {
            return Err(AppError::new(400, "keys is required, e.g. cmd+c"));
        }
        req.insert("keys".into(), json!(keys));
        req.insert("allowTerminal".into(), json!(true));
        req.insert("allowSystem".into(), json!(true));
    }
    Ok(Value::Object(req))
}

/// `String.prototype.trim` 的字符集：比 Rust 的 trim 多一个 BOM（\u{feff}）。
fn trim_js(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// type 的耗时跟字数成正比（Linux agent 逐字注入，中文每个新字还要改一次键映射，
/// 最坏约 30ms/字），固定 8s 会在长文本打到一半时超时。超时不只是报错：agent 看到
/// 请求方断开会立刻停手，所以超时必须盖得住整段输入。其余 op 都是毫秒级，沿用默认。
pub fn input_timeout(req: &Value) -> Option<Duration> {
    if req.get("op").and_then(|v| v.as_str()) != Some("type") {
        return None;
    }
    let length = req
        .get("text")
        .and_then(|v| v.as_str())
        .map(|t| t.encode_utf16().count())
        .unwrap_or(0);
    Some(Duration::from_millis(
        (8000 + 30 * length).min(130000) as u64
    ))
}

/// 查询串/JSON 体里的 region 键。值保持原来的字符串形态，交给 parse_region 校验。
fn region_object(map: &HashMap<String, String>) -> Map<String, Value> {
    let mut out = Map::new();
    for key in ["x", "y", "width", "height"] {
        if let Some(value) = map.get(key) {
            out.insert(key.to_string(), Value::String(value.clone()));
        }
    }
    out
}

fn socket_path(socket: &Option<String>) -> Option<PathBuf> {
    socket.as_ref().map(PathBuf::from)
}

/// 新版 Agent 才有 h264.sock；前端据此决定先试 H.264 还是直接用 noVNC。
fn streams(st: &AppState) -> Value {
    let exists = |path: &Option<String>| {
        path.as_ref()
            .map(|p| Path::new(p).exists())
            .unwrap_or(false)
    };
    json!({ "h264": exists(&st.host.profile.h264_sock), "rfb": exists(&st.host.profile.rfb_sock) })
}

pub async fn capabilities(State(st): State<AppState>) -> Response {
    let mut body = match st.host.info() {
        Value::Object(map) => map,
        other => return json_response(200, other),
    };
    body.insert("streams".into(), streams(&st));
    let mut response = json_response(200, Value::Object(body));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub async fn frame(
    State(st): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let region = match parse_region(&region_object(&query)) {
        Ok(region) => region,
        Err(error) => return send_error(&st, &error),
    };
    match st.screen.frame(region).await {
        Ok(frame) => frame_response(&frame),
        Err(error) => send_error(&st, &error),
    }
}

fn frame_response(frame: &Frame) -> Response {
    let mut response = Response::new(axum::body::Body::from(frame.data.clone()));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/jpeg"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    let mut set = |name: &'static str, value: String| {
        if let Ok(parsed) = HeaderValue::from_str(&value) {
            headers.insert(header::HeaderName::from_static(name), parsed);
        }
    };
    set("x-screen-width", js_num_str(frame.size.width));
    set("x-screen-height", js_num_str(frame.size.height));
    if let Some(region) = frame.size.region_logical() {
        set("x-region-x", js_num_str(region.x));
        set("x-region-y", js_num_str(region.y));
        set("x-region-width", js_num_str(region.width));
        set("x-region-height", js_num_str(region.height));
    }
    response
}

pub async fn input(State(st): State<AppState>, body: Option<Json<Value>>) -> Response {
    let body = body.map(|Json(value)| value).unwrap_or_else(|| json!({}));
    let req = match build_input(&body) {
        Ok(req) => req,
        Err(error) => {
            // 校验失败只回 error 一段（前端直接显示），没有 message。
            return json_response(400, json!({ "ok": false, "error": error.message }));
        }
    };
    if !st.host.profile.supported {
        return send_error(&st, &st.host.unsupported());
    }
    let timeout = input_timeout(&req);
    let reply = st.agent.call(req, timeout).await;
    if agent_failed(&reply) {
        let mut map = Map::new();
        map.insert("ok".into(), json!(false));
        // `{error: undefined}` 在 JSON.stringify 里整键消失，这里同样不写；
        // JS 是 `r?.reason || r?.error`：空串/false 也要继续找下一个。
        let picked = reply
            .get("reason")
            .filter(|value| crate::jsval::truthy(Some(value)))
            .or_else(|| {
                reply
                    .get("error")
                    .filter(|value| crate::jsval::truthy(Some(value)))
            });
        if let Some(error) = picked {
            map.insert("error".into(), error.clone());
        }
        map.insert(
            "message".into(),
            json!(describe(&reply, st.host.profile.install_hint.as_deref())),
        );
        return json_response(200, Value::Object(map));
    }
    st.screen.invalidate();
    json_response(200, reply)
}

pub async fn snapshot(State(st): State<AppState>, body: Option<Json<Value>>) -> Response {
    let body = body.map(|Json(value)| value).unwrap_or_else(|| json!({}));
    let map = body.as_object().cloned().unwrap_or_default();
    let region = match parse_region(&map) {
        Ok(region) => region,
        Err(error) => return send_error(&st, &error),
    };
    match st.screen.snapshot(region).await {
        Ok(result) => json_response(200, result),
        Err(error) => send_error(&st, &error),
    }
}

pub async fn wake_get(State(st): State<AppState>, headers: HeaderMap) -> Response {
    crate::wake::get(&st, &headers).await
}

pub async fn wake_post(State(st): State<AppState>, headers: HeaderMap) -> Response {
    crate::wake::post(&st, &headers).await
}

pub async fn annotation(State(st): State<AppState>, body: Option<Json<Value>>) -> Response {
    let payload = body.map(|Json(value)| value).unwrap_or_else(|| json!({}));
    json_response(200, handle_annotation(&st, &payload).await)
}

pub async fn ws(
    ws: WebSocketUpgrade,
    State(st): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let h264 = query
        .get("mode")
        .map(|mode| mode == "h264")
        .unwrap_or(false);
    ws.on_upgrade(move |socket| async move {
        let (out, input) = crate::wsout::spawn(socket);
        if h264 {
            let opts = crate::h264::H264Options {
                socket_path: socket_path(&st.host.profile.h264_sock),
                p2p: st.p2p.clone(),
                ..Default::default()
            };
            crate::h264::run(out, input, opts, st.stats.clone()).await;
        } else {
            let opts = crate::rfb::RfbOptions {
                socket_path: socket_path(&st.host.profile.rfb_sock),
                ..Default::default()
            };
            crate::rfb::run(out, input, opts).await;
        }
    })
    .into_response()
}

/// 常量时间比较：不与 secret 共享前缀时也不能提前返回，免得时序泄露前缀。
/// 长度不同直接判否（长度本来就不是秘密）。
fn secret_matches(presented: &str, secret: &str) -> bool {
    let (a, b) = (presented.as_bytes(), secret.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 内部鉴权：没有正确 secret 一律 403，不解释。
async fn require_secret(State(st): State<AppState>, request: Request, next: Next) -> Response {
    let presented = request
        .headers()
        .get(SECRET_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !secret_matches(presented, st.secret.as_str()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(request).await
}

/// 请求体上限：迁移前 Express 是 50 MB，axum 默认只有 2 MB。
pub const MAX_BODY_BYTES: usize = 50 * 1024 * 1024;

/// axum 的 413 是纯文本；前端只认 JSON，超限也要保持同一个错误形状。
async fn json_payload_too_large(request: Request, next: Next) -> Response {
    let response = next.run(request).await;
    if response.status() == StatusCode::PAYLOAD_TOO_LARGE {
        return json_response(413, json!({ "ok": false, "error": "payload-too-large" }));
    }
    response
}

pub fn router(state: AppState) -> Router {
    router_with_limit(state, MAX_BODY_BYTES)
}

/// 请求体上限单独暴露，测试用很小的上限去验证 413 的 JSON 形状。
pub fn router_with_limit(state: AppState, body_limit: usize) -> Router {
    let limit = move || DefaultBodyLimit::max(body_limit);
    Router::new()
        .route("/api/remote-screen/capabilities", get(capabilities))
        .route("/api/remote-screen/frame", get(frame))
        .route("/api/remote-screen/input", post(input).layer(limit()))
        .route("/api/remote-screen/snapshot", post(snapshot).layer(limit()))
        .route("/api/remote-screen/wake", get(wake_get).post(wake_post))
        .route("/internal/annotation", post(annotation).layer(limit()))
        .route("/ws/remote-screen", get(ws))
        .layer(middleware::from_fn(json_payload_too_large))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            require_secret,
        ))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_comparison_rejects_length_mismatch_and_any_difference() {
        assert!(secret_matches("abc", "abc"));
        assert!(!secret_matches("abc", "abd"));
        assert!(!secret_matches("abc", "ab"));
        assert!(!secret_matches("", "ab"));
        assert!(!secret_matches("ab", ""));
        // 统一大小的输入都必须走完整串：比较长度相等时前缀相同也不能提前返回。
        assert!(!secret_matches("abcdef", "abcdeg"));
    }

    #[tokio::test]
    async fn oversized_bodies_become_json_413_not_axums_plain_text() {
        use crate::agent::AgentClient;
        use crate::host::{profile_for, Host};
        use futures_util::future::BoxFuture;
        use std::collections::HashMap;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        struct NoAgent;
        impl AgentClient for NoAgent {
            fn call(&self, _req: Value, _timeout: Option<Duration>) -> BoxFuture<'static, Value> {
                Box::pin(async { json!({ "ok": true }) })
            }
        }
        let exec: crate::host::Exec = Arc::new(|_cmd, _args, _timeout| {
            Box::pin(async { Err("不该 shell out".to_string()) })
        });
        let profile = profile_for("win32", "C:\\Users\\x", &HashMap::new());
        let host = Arc::new(Host::new(profile, exec, None));
        let dir = std::env::temp_dir().join(format!("multicc-remote-limit-{}", std::process::id()));
        let state = AppState::new(dir, host, Arc::new(NoAgent), "secret");

        let router = router_with_limit(state, 16);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let body = r#"{"op":"click","x":1,"y":2,"pad":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}"#;
        let request = format!(
            "POST /api/remote-screen/input HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\
             {SECRET_HEADER}: secret\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).await.unwrap();
        server.abort();
        assert!(raw.starts_with("HTTP/1.1 413"), "{raw}");
        assert!(
            raw.to_ascii_lowercase().contains("application/json"),
            "{raw}"
        );
        let payload = raw.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(payload).unwrap(),
            serde_json::json!({ "ok": false, "error": "payload-too-large" })
        );
    }
}
