//! CLI-agnostic Host 侧借道 WebSocket 公共底座。
//!
//! 供 `agy`、Claude Code、Codex 等所有「远端大脑 + 本地手脚」借道共享：
//! - WebSocket HTTP 101 握手与大帧配置（`upgrade_ws` / `ws_config`）；
//! - 单回合环回 RPC 桥（`HostRelayBridge`）：
//!   1. `POST /exec` / `/fs/read` / `/fs/write` / `/fs/list`（Bearer `turn_token` 鉴权）
//!      → 复用同一条 WSS 发回 Client 真机执行；
//!   2. `POST /api/internal/router-tools/{tool}`（`x-multicc-router-capability: <turn_token>` 鉴权）
//!      → 复用同一条 WSS 透传至 Client 本地 MultiCC 编排层（支持普通 JSON 与
//!      `application/x-ndjson` 流式进度推送 + 中断取消），Client 真实
//!      `MULTICC_ROUTER_CAPABILITY` 永不离开 Client 机器；
//! - 隔离空工作目录管理（支持按 `(cli, account, session_key)` 固定稳定空目录以兼容
//!   Claude/Codex `--resume` 对 `cwd` 的路径编码）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path as AxumPath, State};
use axum::http::{HeaderMap, HeaderValue, Request, Response, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::{Json, Router};
use futures_util::Stream;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use multicc_core::host_exec::{verify_bearer_token, verify_raw_token};

use crate::host_exec::generate_token;
use crate::ws_handshake;

pub const MAX_WS_PAYLOAD: usize = 32 * 1024 * 1024;
/// 环回 RPC 桥的 HTTP 请求体上限。axum 默认 2 MB，会把 base64 图片附件和
/// 大参数 MCP `tools/call` 拦成 413；这里放宽到仍小于 WSS 单帧上限的 24 MiB。
pub const MAX_RELAY_HTTP_BODY: usize = 24 * 1024 * 1024;
pub const START_FRAME_TIMEOUT: Duration = Duration::from_secs(15);
pub const HOST_EXEC_RPC_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// `dispatch_master(mode="sync")` 最长可等待 6 小时（21600s），留 60s 余量。
pub const ROUTER_TOOL_RPC_TIMEOUT: Duration = Duration::from_secs(21_660);

pub const ROUTER_ENV_KEYS: &[&str] = &[
    "MULTICC_SESSION_ID",
    "MULTICC_BASE_URL",
    "MULTICC_TURN_ID",
    "MULTICC_ORIGIN_DISPATCH_ID",
    "MULTICC_ROUTER_CAPABILITY",
    "MULTICC_IMAGE_BRIDGE",
];

pub fn ws_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_frame_size(Some(MAX_WS_PAYLOAD))
        .max_message_size(Some(MAX_WS_PAYLOAD))
}

/// 为 Claude Code / Codex 等远端大脑生成零落盘系统指导语。
pub fn build_cli_remote_guidance(
    cli_name: &str,
    local_root: &str,
    remote_root: &str,
    local_os: &str,
    router_enabled: bool,
) -> String {
    let router_note = if router_enabled {
        "\n- MultiCC orchestration tools (`multicc_router`: wait_for_user_answer, dispatch_master, route_task, list_secrets, run_with_secrets, etc.) are bridged to the user's real MultiCC instance and work normally."
    } else {
        ""
    };
    format!(
        "[MultiCC Remote CLI Relay Execution Environment]\n\
- This {cli_name} brain runs on a remote relay Host inside an empty isolated scratch directory (`{remote_root}`).\n\
- ALL built-in local shell, file read/write, and patch tools are DISABLED on this Host — do NOT attempt to use them.\n\
- To inspect files, edit files, view images, or run commands on the user's REAL local development machine (`{local_os}`, workspace `{local_root}`), ALWAYS use the `multicc_host_exec` MCP tools:\n\
  * `host_list_dir` — list directory entries (pass `path` relative to workspace root, e.g. \".\" or \"src\")\n\
  * `host_read_file` — read a file directly from the real machine (pass `path`, optional `max_bytes`)\n\
  * `host_edit_file` — exact search-and-replace edit on a file in the real machine (pass `path`, `old_text`, `new_text`, optional `replace_all`)\n\
  * `host_write_file` — write a file directly on the real machine (pass `path`, `content`)\n\
  * `host_view_image` — view an image file (png/jpeg/gif/webp) on the real machine as a native multimodal image\n\
  * `host_run_command` — run shell commands (git, build, tests, grep, etc.) on the real machine (pass `command`, optional `cwd`, optional `timeout_seconds`)\n\
  * `host_info` — inspect real machine OS and workspace root mapping{router_note}\n\
- If you spawn subagents, explicitly instruct them to use `multicc_host_exec` tools as well.\n\
- Always pass relative paths (e.g. `src/main.rs`) or paths under `{local_root}`."
    )
}

/// 生成供 Claude / Codex 使用的 `multicc_host_exec` (+ 可选 `multicc_router`) 内联 MCP JSON 对象。
pub fn build_inline_mcp_servers_json(router_mcp: Option<&RouterMcpSpec>) -> Result<Value, String> {
    build_inline_mcp_servers_json_with_external(router_mcp, &[])
}

/// 生成供 Claude 使用的内联 MCP JSON，包含 `multicc_host_exec`、可选 `multicc_router` 以及透传的第三方 MCP。
pub fn build_inline_mcp_servers_json_with_external(
    router_mcp: Option<&RouterMcpSpec>,
    bridged_mcp_servers: &[String],
) -> Result<Value, String> {
    let exec_bin = resolve_host_exec_mcp_bin()?;
    let mut servers = serde_json::Map::new();
    servers.insert(
        "multicc_host_exec".to_string(),
        json!({
            "command": exec_bin,
            "args": ["host-exec-mcp"],
        }),
    );
    if let Some(spec) = router_mcp {
        servers.insert(
            "multicc_router".to_string(),
            json!({
                "command": spec.node_bin,
                "args": [spec.script_path.to_string_lossy().into_owned()],
            }),
        );
    }
    for name in bridged_mcp_servers {
        if crate::cli_relay_mcp_tunnel::is_valid_external_mcp_name(name)
            && !servers.contains_key(name)
        {
            servers.insert(
                name.clone(),
                json!({
                    "command": exec_bin,
                    "args": ["mcp-relay-proxy", "--server", name],
                }),
            );
        }
    }
    Ok(json!({ "mcpServers": Value::Object(servers) }))
}

/// 校验 router tool 名称，防止路径穿越或查询串注入。
pub fn is_valid_router_tool_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// Host 侧定位 `multicc-gateway` 自身路径，供 `host-exec-mcp` 子进程启动。
pub fn resolve_host_exec_mcp_bin() -> Result<String, String> {
    std::env::var("MULTICC_HOST_EXEC_MCP_BIN")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        })
        .ok_or_else(|| "无法定位 Host multicc-gateway 路径".to_string())
}

/// Host 侧用于启动 `scripts/multicc-router-mcp.js` 的命令配置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouterMcpSpec {
    pub node_bin: String,
    pub script_path: PathBuf,
}

impl RouterMcpSpec {
    /// 从 `App` 的 `package_root` / `node_bin`（及测试环境变量）解析 `multicc-router-mcp.js`。
    pub fn resolve(package_root: &Path, app_node_bin: Option<&str>) -> Option<Self> {
        let script_path = std::env::var_os("MULTICC_ROUTER_MCP_SCRIPT")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| package_root.join("scripts").join("multicc-router-mcp.js"));
        if !script_path.is_file() {
            return None;
        }
        let node_bin = std::env::var("MULTICC_NODE_BIN")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                app_node_bin
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "node".to_string());
        Some(Self {
            node_bin,
            script_path,
        })
    }
}

/// Client 随 WSS `start` 帧下发的编排上下文元数据（绝不含 `MULTICC_ROUTER_CAPABILITY` 或 `MULTICC_BASE_URL`）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RouterContext {
    pub enabled: bool,
    pub session_id: String,
    pub turn_id: String,
    pub origin_dispatch_id: String,
    pub image_bridge: String,
}

impl RouterContext {
    pub fn from_start_frame(start_val: &Value) -> Option<Self> {
        let obj = start_val.get("routerContext")?.as_object()?;
        if obj.get("enabled").and_then(Value::as_bool) != Some(true) {
            return None;
        }
        let read_str = |key: &str| {
            obj.get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| s.len() <= 256 && !s.chars().any(char::is_control))
                .unwrap_or("")
                .to_string()
        };
        Some(Self {
            enabled: true,
            session_id: read_str("sessionId"),
            turn_id: read_str("turnId"),
            origin_dispatch_id: read_str("originDispatchId"),
            image_bridge: read_str("imageBridge"),
        })
    }
}

/// 为 CLI 回合准备空隔离工作目录：
/// - `session_key` 为 `Some` 时（如 Claude/Codex 需 `--resume`），按 `(cli, account_key, session_key)`
///   生成确定性稳定空目录路径，保证跨轮恢复会话时 `cwd` 哈希一致；
/// - `session_key` 为 `None` 时（如 `agy`），按 `fallback_token` 创建一次性临时目录。
pub fn stable_session_scratch_dir(
    cli: &str,
    account_key: &str,
    session_key: Option<&str>,
    fallback_token: &str,
) -> (PathBuf, bool) {
    let safe_cli: String = cli
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let safe_cli = if safe_cli.is_empty() {
        "cli".to_string()
    } else {
        safe_cli
    };
    if let Some(key) = session_key.map(str::trim).filter(|s| !s.is_empty()) {
        let mut hasher = Sha256::new();
        hasher.update(safe_cli.as_bytes());
        hasher.update(b":");
        hasher.update(account_key.as_bytes());
        hasher.update(b":");
        hasher.update(key.as_bytes());
        let digest = hasher.finalize();
        let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
        let dir = std::env::temp_dir()
            .join(format!("multicc-{safe_cli}-relay-sessions"))
            .join(hex);
        (dir, true)
    } else {
        let prefix: String = fallback_token.chars().take(16).collect();
        let dir = std::env::temp_dir().join(format!("multicc-{safe_cli}-relay-scratch-{prefix}"));
        (dir, false)
    }
}

/// 执行 HTTP → WebSocket 101 握手规划，返回响应与 `OnUpgrade`（或拒绝响应）。
#[allow(clippy::result_large_err)]
pub fn upgrade_ws(
    request: &mut Request<Body>,
) -> Result<(Response<Body>, hyper::upgrade::OnUpgrade), Response<Body>> {
    let header = |name| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    };
    let plan = ws_handshake::plan(&ws_handshake::Request {
        method: request.method().as_str(),
        upgrade: header("upgrade"),
        key: header("sec-websocket-key"),
        version: header("sec-websocket-version"),
        protocol: header("sec-websocket-protocol"),
    });
    let raw = String::from_utf8(plan.response).expect("handshake is ASCII");
    let (head, resp_body) = raw.split_once("\r\n\r\n").expect("complete handshake");
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .expect("handshake status");
    let mut builder = Response::builder().status(status);
    for line in lines {
        let (name, value) = line.split_once(": ").expect("handshake header");
        builder = builder.header(name, value);
    }
    if !plan.accepted {
        return Err(builder
            .body(Body::from(resp_body.to_owned()))
            .expect("handshake response"));
    }
    let upgrade = hyper::upgrade::on(request);
    let response = builder
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .body(Body::empty())
        .expect("handshake response");
    Ok((response, upgrade))
}

enum RouterHead {
    Full {
        status: u16,
        content_type: String,
        body: String,
    },
    Stream {
        status: u16,
        content_type: String,
        chunks: mpsc::UnboundedReceiver<Option<String>>,
    },
}

struct PendingRouterEntry {
    head: Option<oneshot::Sender<RouterHead>>,
    stream_tx: Option<mpsc::UnboundedSender<Option<String>>>,
}

struct BridgeState {
    token: String,
    ws_tx: mpsc::UnboundedSender<String>,
    pending_exec: Mutex<HashMap<String, oneshot::Sender<(u16, Value)>>>,
    pending_router: Mutex<HashMap<String, PendingRouterEntry>>,
    pending_mcp: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
}

/// 流式 NDJSON 响应包装器：当 Host CLI 取消工具调用并断开环回连接时，自动向 Client 发送
/// `router_tool_abort` 以中止 Client 本地 `router-tool-host` 请求。
struct RouterChunkStream {
    req_id: String,
    rx: mpsc::UnboundedReceiver<Option<String>>,
    ws_tx: mpsc::UnboundedSender<String>,
    ended: bool,
}

impl Stream for RouterChunkStream {
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.rx.poll_recv(cx) {
            Poll::Ready(Some(Some(chunk))) => Poll::Ready(Some(Ok(Bytes::from(chunk)))),
            Poll::Ready(Some(None)) | Poll::Ready(None) => {
                self.ended = true;
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for RouterChunkStream {
    fn drop(&mut self) {
        if !self.ended {
            let _ = self.ws_tx.send(
                json!({
                    "type": "router_tool_abort",
                    "reqId": self.req_id,
                })
                .to_string(),
            );
        }
    }
}

/// 单回合 Host 环回桥：同时承载 `multicc_host_exec` 与 `multicc_router` 回传。
pub struct HostRelayBridge {
    state: Arc<BridgeState>,
    port: u16,
    task: JoinHandle<()>,
}

impl HostRelayBridge {
    pub async fn start(ws_tx: mpsc::UnboundedSender<String>) -> Result<Self, String> {
        let turn_token = generate_token()?;
        let state = Arc::new(BridgeState {
            token: turn_token,
            ws_tx,
            pending_exec: Mutex::new(HashMap::new()),
            pending_router: Mutex::new(HashMap::new()),
            pending_mcp: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
        });

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|err| format!("无法启动 Host 环回执行桥: {err}"))?;
        let port = listener
            .local_addr()
            .map_err(|err| format!("读取环回执行桥端口失败: {err}"))?
            .port();

        let router = Router::new()
            .route("/exec", post(rpc_exec))
            .route("/fs/read", post(rpc_read_file))
            .route("/fs/write", post(rpc_write_file))
            .route("/fs/edit", post(rpc_edit_file))
            .route("/fs/list", post(rpc_list_dir))
            .route("/fs/view_image", post(rpc_view_image))
            .route("/mcp/{server}", post(rpc_mcp_tunnel))
            .route("/api/internal/router-tools/{tool}", post(rpc_router_tool))
            .layer(DefaultBodyLimit::max(MAX_RELAY_HTTP_BODY))
            .with_state(state.clone());

        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });

        Ok(Self { state, port, task })
    }

    pub fn token(&self) -> &str {
        &self.state.token
    }

    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn handle(&self) -> Arc<HostRelayBridgeHandle> {
        Arc::new(HostRelayBridgeHandle {
            state: self.state.clone(),
        })
    }

    /// 统一为 Host 子进程注入 `MULTICC_HOST_EXEC_*` 与（当启用时）`MULTICC_*` router 环境变量；
    /// 未启用时显式清除全部 router 环境变量，避免泄露 Host 自身 MultiCC 上下文。
    pub fn apply_child_env(
        &self,
        cmd: &mut Command,
        local_root: &str,
        remote_root: &str,
        local_os: &str,
        file_mode: &str,
        router_ctx: Option<&RouterContext>,
    ) {
        let url = self.base_url();
        cmd.env("MULTICC_HOST_EXEC_URL", &url)
            .env("MULTICC_HOST_EXEC_TOKEN", &self.state.token)
            .env("MULTICC_HOST_EXEC_LOCAL_ROOT", local_root)
            .env("MULTICC_HOST_EXEC_REMOTE_ROOT", remote_root)
            .env("MULTICC_HOST_EXEC_OS", local_os)
            .env("MULTICC_HOST_EXEC_FILE_MODE", file_mode);

        if let Some(rc) = router_ctx.filter(|r| r.enabled) {
            cmd.env("MULTICC_BASE_URL", &url)
                .env("MULTICC_ROUTER_CAPABILITY", &self.state.token)
                .env("MULTICC_SESSION_ID", &rc.session_id)
                .env("MULTICC_TURN_ID", &rc.turn_id)
                .env("MULTICC_ORIGIN_DISPATCH_ID", &rc.origin_dispatch_id)
                .env("MULTICC_IMAGE_BRIDGE", &rc.image_bridge);
        } else {
            for key in ROUTER_ENV_KEYS {
                cmd.env_remove(key);
            }
        }
    }

    pub async fn shutdown(self) {
        self.task.abort();
        let _ = self.task.await;
    }
}

pub struct HostRelayBridgeHandle {
    state: Arc<BridgeState>,
}

impl HostRelayBridgeHandle {
    /// 处理 Client 发回的 `host_exec_res` / `router_tool_*` 响应帧。
    pub async fn handle_client_frame(&self, val: &Value) -> bool {
        let Some(kind) = val.get("type").and_then(Value::as_str) else {
            return false;
        };
        let Some(req_id) = val.get("reqId").and_then(Value::as_str) else {
            return false;
        };
        match kind {
            "host_exec_res" => {
                let status = val
                    .get("status")
                    .and_then(Value::as_u64)
                    .and_then(|n| u16::try_from(n).ok())
                    .unwrap_or(200);
                let body = val.get("body").cloned().unwrap_or_else(|| json!({}));
                if let Some(tx) = self.state.pending_exec.lock().await.remove(req_id) {
                    let _ = tx.send((status, body));
                }
                true
            }
            "router_tool_res" => {
                let status = val
                    .get("status")
                    .and_then(Value::as_u64)
                    .and_then(|n| u16::try_from(n).ok())
                    .unwrap_or(200);
                let content_type = val
                    .get("contentType")
                    .and_then(Value::as_str)
                    .unwrap_or("application/json; charset=utf-8")
                    .to_string();
                let body = if let Some(text) = val.get("bodyText").and_then(Value::as_str) {
                    text.to_string()
                } else {
                    val.get("body")
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "{}".to_string())
                };
                if let Some(entry) = self.state.pending_router.lock().await.remove(req_id) {
                    if let Some(head) = entry.head {
                        let _ = head.send(RouterHead::Full {
                            status,
                            content_type,
                            body,
                        });
                    }
                }
                true
            }
            "router_tool_stream_start" => {
                let status = val
                    .get("status")
                    .and_then(Value::as_u64)
                    .and_then(|n| u16::try_from(n).ok())
                    .unwrap_or(200);
                let content_type = val
                    .get("contentType")
                    .and_then(Value::as_str)
                    .unwrap_or("application/x-ndjson; charset=utf-8")
                    .to_string();
                let mut map = self.state.pending_router.lock().await;
                if let Some(entry) = map.get_mut(req_id) {
                    if let Some(head) = entry.head.take() {
                        let (chunk_tx, chunk_rx) = mpsc::unbounded_channel();
                        entry.stream_tx = Some(chunk_tx);
                        let _ = head.send(RouterHead::Stream {
                            status,
                            content_type,
                            chunks: chunk_rx,
                        });
                    }
                }
                true
            }
            "router_tool_chunk" => {
                if let Some(chunk) = val.get("chunk").and_then(Value::as_str) {
                    let map = self.state.pending_router.lock().await;
                    if let Some(tx) = map.get(req_id).and_then(|e| e.stream_tx.as_ref()) {
                        let _ = tx.send(Some(chunk.to_string()));
                    }
                }
                true
            }
            "router_tool_end" => {
                if let Some(entry) = self.state.pending_router.lock().await.remove(req_id) {
                    if let Some(tx) = entry.stream_tx {
                        let _ = tx.send(None);
                    }
                }
                true
            }
            "mcp_rpc_res" => {
                let resp = val.get("response").cloned().unwrap_or_else(|| json!({}));
                if let Some(tx) = self.state.pending_mcp.lock().await.remove(req_id) {
                    let _ = tx.send(resp);
                }
                true
            }
            _ => false,
        }
    }

    /// 连接断开时立即唤醒所有挂起中的 RPC，避免子进程死等超时。
    pub async fn fail_all_pending(&self) {
        self.state.pending_exec.lock().await.clear();
        self.state.pending_mcp.lock().await.clear();
        let entries: Vec<_> = self
            .state
            .pending_router
            .lock()
            .await
            .drain()
            .map(|(_, v)| v)
            .collect();
        for entry in entries {
            if let Some(tx) = entry.stream_tx {
                let _ = tx.send(None);
            }
        }
    }
}

async fn forward_host_exec(
    state: Arc<BridgeState>,
    headers: HeaderMap,
    path: &'static str,
    body: Value,
) -> axum::response::Response {
    let auth = headers.get("authorization").and_then(|v| v.to_str().ok());
    if !verify_bearer_token(auth, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "ok": false, "error": "unauthorized" })),
        )
            .into_response();
    }
    let req_id = format!("r{}", state.next_id.fetch_add(1, Ordering::Relaxed) + 1);
    let (tx, rx) = oneshot::channel::<(u16, Value)>();
    state.pending_exec.lock().await.insert(req_id.clone(), tx);

    let frame = json!({
        "type": "host_exec_req",
        "reqId": req_id,
        "path": path,
        "body": body,
    })
    .to_string();
    if state.ws_tx.send(frame).is_err() {
        state.pending_exec.lock().await.remove(&req_id);
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": "借用方 WebSocket 连接已断开" })),
        )
            .into_response();
    }

    match tokio::time::timeout(HOST_EXEC_RPC_TIMEOUT, rx).await {
        Ok(Ok((status_code, payload))) => {
            let status = StatusCode::from_u16(status_code).unwrap_or(StatusCode::OK);
            (status, Json(payload)).into_response()
        }
        Ok(Err(_)) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": "借用方未返回执行结果" })),
        )
            .into_response(),
        Err(_) => {
            state.pending_exec.lock().await.remove(&req_id);
            (
                StatusCode::GATEWAY_TIMEOUT,
                Json(json!({ "ok": false, "error": "等待借用方本机执行超时" })),
            )
                .into_response()
        }
    }
}

async fn rpc_exec(
    State(state): State<Arc<BridgeState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    forward_host_exec(state, headers, "/exec", body).await
}
async fn rpc_read_file(
    State(state): State<Arc<BridgeState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    forward_host_exec(state, headers, "/fs/read", body).await
}
async fn rpc_write_file(
    State(state): State<Arc<BridgeState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    forward_host_exec(state, headers, "/fs/write", body).await
}
async fn rpc_edit_file(
    State(state): State<Arc<BridgeState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    forward_host_exec(state, headers, "/fs/edit", body).await
}
async fn rpc_list_dir(
    State(state): State<Arc<BridgeState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    forward_host_exec(state, headers, "/fs/list", body).await
}
async fn rpc_view_image(
    State(state): State<Arc<BridgeState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    forward_host_exec(state, headers, "/fs/view_image", body).await
}

async fn rpc_mcp_tunnel(
    State(state): State<Arc<BridgeState>>,
    AxumPath(server): AxumPath<String>,
    headers: HeaderMap,
    Json(message): Json<Value>,
) -> axum::response::Response {
    let auth = headers.get("authorization").and_then(|v| v.to_str().ok());
    if !verify_bearer_token(auth, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized" })),
        )
            .into_response();
    }
    if !crate::cli_relay_mcp_tunnel::is_valid_external_mcp_name(&server) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid mcp server name" })),
        )
            .into_response();
    }
    let expect_reply = message.get("id").is_some_and(|v| !v.is_null());
    let orig_id = message.get("id").cloned().unwrap_or(Value::Null);
    let req_id = format!("m{}", state.next_id.fetch_add(1, Ordering::Relaxed) + 1);

    if !expect_reply {
        let frame = json!({
            "type": "mcp_rpc_req",
            "reqId": req_id,
            "server": server,
            "message": message,
            "expectReply": false,
        })
        .to_string();
        let _ = state.ws_tx.send(frame);
        return StatusCode::NO_CONTENT.into_response();
    }

    let (tx, rx) = oneshot::channel::<Value>();
    state.pending_mcp.lock().await.insert(req_id.clone(), tx);
    let frame = json!({
        "type": "mcp_rpc_req",
        "reqId": req_id,
        "server": server,
        "message": message,
        "expectReply": true,
    })
    .to_string();
    if state.ws_tx.send(frame).is_err() {
        state.pending_mcp.lock().await.remove(&req_id);
        return (
            StatusCode::OK,
            Json(json!({
                "jsonrpc": "2.0",
                "id": orig_id,
                "error": { "code": -32000, "message": "Client WebSocket disconnected" }
            })),
        )
            .into_response();
    }

    match tokio::time::timeout(HOST_EXEC_RPC_TIMEOUT, rx).await {
        Ok(Ok(resp)) => (StatusCode::OK, Json(resp)).into_response(),
        Ok(Err(_)) => (
            StatusCode::OK,
            Json(json!({
                "jsonrpc": "2.0",
                "id": orig_id,
                "error": { "code": -32000, "message": "Client MCP channel closed" }
            })),
        )
            .into_response(),
        Err(_) => {
            state.pending_mcp.lock().await.remove(&req_id);
            (
                StatusCode::OK,
                Json(json!({
                    "jsonrpc": "2.0",
                    "id": orig_id,
                    "error": { "code": -32000, "message": "Client MCP call timed out" }
                })),
            )
                .into_response()
        }
    }
}

async fn rpc_router_tool(
    State(state): State<Arc<BridgeState>>,
    AxumPath(tool): AxumPath<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    let cap = headers
        .get("x-multicc-router-capability")
        .and_then(|v| v.to_str().ok());
    if !verify_raw_token(cap, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "ok": false, "code": "unauthorized", "error": "unauthorized" })),
        )
            .into_response();
    }
    if !is_valid_router_tool_name(&tool) {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                json!({ "ok": false, "code": "invalid_tool", "error": "invalid router tool name" }),
            ),
        )
            .into_response();
    }

    let req_id = format!("rt{}", state.next_id.fetch_add(1, Ordering::Relaxed) + 1);
    let (head_tx, head_rx) = oneshot::channel::<RouterHead>();
    state.pending_router.lock().await.insert(
        req_id.clone(),
        PendingRouterEntry {
            head: Some(head_tx),
            stream_tx: None,
        },
    );

    let frame = json!({
        "type": "router_tool_req",
        "reqId": req_id,
        "tool": tool,
        "body": body,
    })
    .to_string();
    if state.ws_tx.send(frame).is_err() {
        state.pending_router.lock().await.remove(&req_id);
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "ok": false,
                "code": "router_relay_disconnected",
                "error": "借用方 WebSocket 连接已断开"
            })),
        )
            .into_response();
    }

    match tokio::time::timeout(ROUTER_TOOL_RPC_TIMEOUT, head_rx).await {
        Ok(Ok(RouterHead::Full {
            status,
            content_type,
            body,
        })) => {
            let status_code = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
            let mut resp = Response::builder()
                .status(status_code)
                .body(Body::from(body))
                .expect("router full response");
            if let Ok(hv) = HeaderValue::from_str(&content_type) {
                resp.headers_mut().insert("content-type", hv);
            }
            resp
        }
        Ok(Ok(RouterHead::Stream {
            status,
            content_type,
            chunks,
        })) => {
            let status_code = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
            let stream = RouterChunkStream {
                req_id,
                rx: chunks,
                ws_tx: state.ws_tx.clone(),
                ended: false,
            };
            let mut resp = Response::builder()
                .status(status_code)
                .body(Body::from_stream(stream))
                .expect("router stream response");
            if let Ok(hv) = HeaderValue::from_str(&content_type) {
                resp.headers_mut().insert("content-type", hv);
            }
            resp.headers_mut()
                .insert("cache-control", HeaderValue::from_static("no-store"));
            resp
        }
        Ok(Err(_)) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "ok": false,
                "code": "router_relay_closed",
                "error": "借用方未返回编排工具响应"
            })),
        )
            .into_response(),
        Err(_) => {
            state.pending_router.lock().await.remove(&req_id);
            let _ = state.ws_tx.send(
                json!({
                    "type": "router_tool_abort",
                    "reqId": req_id,
                })
                .to_string(),
            );
            (
                StatusCode::GATEWAY_TIMEOUT,
                Json(json!({
                    "ok": false,
                    "code": "router_relay_timeout",
                    "error": "等待借用方编排工具响应超时"
                })),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_router_tool_names_reject_traversal_and_special_chars() {
        assert!(is_valid_router_tool_name("wait_for_user_answer"));
        assert!(is_valid_router_tool_name("dispatch_master"));
        assert!(is_valid_router_tool_name("run-with-secrets-2"));
        assert!(!is_valid_router_tool_name(""));
        assert!(!is_valid_router_tool_name("../secrets"));
        assert!(!is_valid_router_tool_name("a/b"));
        assert!(!is_valid_router_tool_name("UPPER"));
        assert!(!is_valid_router_tool_name("tool?x=1"));
    }

    #[test]
    fn stable_scratch_dir_is_deterministic_when_session_key_given() {
        let (a1, stable1) = stable_session_scratch_dir("claude", "acct1", Some("sess-42"), "tok1");
        let (a2, stable2) = stable_session_scratch_dir("claude", "acct1", Some("sess-42"), "tok2");
        let (b, _) = stable_session_scratch_dir("claude", "acct1", Some("sess-99"), "tok1");
        assert!(stable1 && stable2);
        assert_eq!(a1, a2);
        assert_ne!(a1, b);

        let (ephem, stable3) = stable_session_scratch_dir("agy", "acct1", None, "0123456789abcdef");
        assert!(!stable3);
        assert!(ephem.to_string_lossy().contains("0123456789abcdef"));
    }

    #[test]
    fn router_context_never_reads_capability_or_base_url() {
        let parsed = RouterContext::from_start_frame(&json!({
            "type": "start",
            "routerContext": {
                "enabled": true,
                "sessionId": "s-1",
                "turnId": "t-2",
                "originDispatchId": "op_3",
                "imageBridge": "1",
            }
        }))
        .unwrap();
        assert!(parsed.enabled);
        assert_eq!(parsed.session_id, "s-1");
        assert_eq!(parsed.turn_id, "t-2");
        assert_eq!(parsed.origin_dispatch_id, "op_3");
        assert_eq!(parsed.image_bridge, "1");

        assert!(RouterContext::from_start_frame(&json!({
            "type": "start",
            "routerContext": { "enabled": false }
        }))
        .is_none());
    }
}
