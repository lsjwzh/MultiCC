//! 反重力（`agy`）借道分享码的 Host 侧服务端：
//!
//! - `GET /agy-proxy/<16hex>/ping`：连通性与 Host 账号状态探测（供 Client「测试连通」）；
//! - `WS  /agy-proxy/<16hex>/turn`：单条双向 WebSocket 承载一次完整 `agy` 回合：
//!   1. 升级前强制通过 `provider_relay::admission` 校验 `Authorization: Bearer mcr1.<id>.<secret>`
//!      （scrypt 常量时间校验、未撤销、作用域精确匹配 `appType=="agy" && providerId==accountId`、
//!      自动累加 `accessCount` 与 `lastUsedAt`）；
//!   2. 严格读取 Host 本地 `<accountId>` 的独立 `.home` 与 `egressBinding`（fail-closed）；
//!   3. 若 Host 账号绑定了 `chrome-proxy-launcher` 出口，在 Host 本地实时解析并注入
//!      `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY=127.0.0.1,localhost,::1`（零绕路）；
//!   4. Host 侧以严格零落盘策略（deny `command(*)`、`read_file(*)`、`write_file(*)`）在空临时目录启动
//!      `agy`，所有终端命令与文件操作经 Host 临时环回代理通过同一条 WebSocket 发回 Client 真机执行
//!      —— 借用方拿不到 VPS SSH 权限、看不到 Host 文件、也接触不到 Host 的 Google OAuth 凭据。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, Request, Response, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::{
    tungstenite::{
        protocol::{Role, WebSocketConfig},
        Message,
    },
    WebSocketStream,
};

use multicc_core::account_subscription::valid_account;
use multicc_core::agy_accounts::{self as agy_store, ResolvedAgyAccount};
use multicc_core::agy_remote::{
    build_remote_permissions_settings, wrap_remote_prompt, DEFAULT_REMOTE_AGY_BIN,
    FILE_MODE_REMOTE_MCP,
};
use multicc_core::egress_plugin::LOOPBACK_NO_PROXY;
use multicc_core::host_exec::verify_bearer_token;
use multicc_core::state_file;

use crate::app::express::{self, RequestCtx};
use crate::app::provider_relay;
use crate::host_exec::generate_token;
use crate::ws_handshake;

const MAX_WS_PAYLOAD: usize = 32 * 1024 * 1024;
const START_FRAME_TIMEOUT: Duration = Duration::from_secs(15);
const HOST_EXEC_RPC_TIMEOUT: Duration = Duration::from_secs(10 * 60);

fn ws_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_frame_size(Some(MAX_WS_PAYLOAD))
        .max_message_size(Some(MAX_WS_PAYLOAD))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("MULTICC_AGY_ACCOUNTS_HOME")
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var_os("HOME").filter(|v| !v.is_empty()))
        .or_else(|| std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()))
        .map(PathBuf::from)
}

fn host_agy_bin() -> String {
    std::env::var("MULTICC_AGY_BIN")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_REMOTE_AGY_BIN.to_string())
}

/// 解析 `/agy-proxy/<16hex>/turn` 中的 `account_id`。
pub fn parse_turn_account_id(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    let parts: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() == 3
        && parts[0].eq_ignore_ascii_case("agy-proxy")
        && parts[2].eq_ignore_ascii_case("turn")
        && valid_account(parts[1])
    {
        Some(parts[1].to_string())
    } else {
        None
    }
}

/// 解析 `/agy-proxy/<16hex>/ping` 中的 `account_id`。
pub fn parse_ping_account_id(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    let parts: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() == 3
        && parts[0].eq_ignore_ascii_case("agy-proxy")
        && parts[2].eq_ignore_ascii_case("ping")
        && valid_account(parts[1])
    {
        Some(parts[1].to_string())
    } else {
        None
    }
}

pub fn claims_ws(path: &str) -> bool {
    parse_turn_account_id(path).is_some()
}

pub fn claims_ping(path: &str) -> bool {
    parse_ping_account_id(path).is_some()
}

/// `GET /agy-proxy/<16hex>/ping`：供借用方点击「测试连通」时探测分享码有效性与 Host 账号状态。
pub async fn handle_ping(ctx: &RequestCtx, peer: &str, host_port: u16) -> Response<Body> {
    let Some(account_id) = parse_ping_account_id(&ctx.path) else {
        return express::error(ctx, 404, "not found");
    };
    let headers = match provider_relay::admission(ctx, peer, host_port).await {
        Ok(h) => h,
        Err(refusal) => return *refusal,
    };
    let Some(home) = home_dir() else {
        return express::json(
            ctx,
            500,
            &json!({ "ok": false, "error": "Host 无法定位 HOME 目录" }),
            &[],
        );
    };
    let Some(label) = agy_store::get_local_account_label(&home, &account_id) else {
        return express::json(
            ctx,
            404,
            &json!({ "ok": false, "error": "Host 上对应的反重力账号已不存在" }),
            &[],
        );
    };
    let login = agy_store::login_status(&home, &account_id);
    let egress = agy_store::get_account_egress(&home, &account_id);
    let mut resp = express::json(
        ctx,
        200,
        &json!({
            "ok": true,
            "transport": "relay",
            "accountId": account_id,
            "label": label,
            "loggedIn": login["loggedIn"],
            "egressProfile": egress.map(|b| b.profile_id),
        }),
        &[("Cache-Control", "no-store")],
    );
    provider_relay::append_headers(&mut resp, &headers);
    resp
}

/// `WS /agy-proxy/<16hex>/turn`：认证通过后升级为 WebSocket 并执行一轮受控 `agy` 对话。
pub async fn handle_ws(
    peer: SocketAddr,
    host_port: u16,
    mut request: Request<Body>,
) -> Response<Body> {
    let path = request.uri().path().to_string();
    let Some(account_id) = parse_turn_account_id(&path) else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("not found"))
            .expect("response");
    };

    // 先做认证与作用域校验（拒绝时直接返回 HTTP 401/403，不升级 101）。
    let (parts, body) = request.into_parts();
    let ctx = RequestCtx::new(&parts);
    if let Err(refusal) = provider_relay::admission(&ctx, &peer.ip().to_string(), host_port).await {
        return *refusal;
    }
    let Some(home) = home_dir() else {
        return express::json(
            &ctx,
            500,
            &json!({ "error": "Host 无法定位 HOME 目录" }),
            &[],
        );
    };
    if agy_store::get_local_account_label(&home, &account_id).is_none() {
        return express::json(
            &ctx,
            404,
            &json!({ "error": "Host 上对应的反重力账号已不存在" }),
            &[],
        );
    }

    request = Request::from_parts(parts, body);
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
        return builder
            .body(Body::from(resp_body.to_owned()))
            .expect("handshake response");
    }

    let upgrade = hyper::upgrade::on(&mut request);
    tokio::spawn(async move {
        let Ok(upgraded) = upgrade.await else { return };
        let socket = WebSocketStream::from_raw_socket(
            TokioIo::new(upgraded),
            Role::Server,
            Some(ws_config()),
        )
        .await;
        serve_relay_session(socket, home, account_id).await;
    });
    builder
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .body(Body::empty())
        .expect("handshake response")
}

struct RelayRpcBridgeState {
    token: String,
    ws_tx: mpsc::UnboundedSender<String>,
    pending: Mutex<HashMap<String, oneshot::Sender<(u16, Value)>>>,
    next_id: AtomicU64,
}

async fn forward_rpc_to_client(
    state: Arc<RelayRpcBridgeState>,
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
    state.pending.lock().await.insert(req_id.clone(), tx);

    let frame = json!({
        "type": "host_exec_req",
        "reqId": req_id,
        "path": path,
        "body": body,
    })
    .to_string();
    if state.ws_tx.send(frame).is_err() {
        state.pending.lock().await.remove(&req_id);
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
            state.pending.lock().await.remove(&req_id);
            (
                StatusCode::GATEWAY_TIMEOUT,
                Json(json!({ "ok": false, "error": "等待借用方本机执行超时" })),
            )
                .into_response()
        }
    }
}

async fn rpc_exec(
    State(state): State<Arc<RelayRpcBridgeState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    forward_rpc_to_client(state, headers, "/exec", body).await
}
async fn rpc_read_file(
    State(state): State<Arc<RelayRpcBridgeState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    forward_rpc_to_client(state, headers, "/fs/read", body).await
}
async fn rpc_write_file(
    State(state): State<Arc<RelayRpcBridgeState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    forward_rpc_to_client(state, headers, "/fs/write", body).await
}
async fn rpc_list_dir(
    State(state): State<Arc<RelayRpcBridgeState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    forward_rpc_to_client(state, headers, "/fs/list", body).await
}

fn ensure_host_relay_mcp_config(account_home: &Path) -> Result<(), String> {
    let mcp_bin = std::env::var("MULTICC_HOST_EXEC_MCP_BIN")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        })
        .ok_or_else(|| "无法定位 Host multicc-gateway 路径".to_string())?;
    let cfg_path = account_home
        .join(".gemini")
        .join("config")
        .join("mcp_config.json");
    let mut root = if cfg_path.is_file() {
        let raw = std::fs::read_to_string(&cfg_path)
            .map_err(|err| format!("读取 Host mcp_config.json 失败: {err}"))?;
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            json!({})
        } else {
            match serde_json::from_str::<Value>(trimmed) {
                Ok(Value::Object(map)) => Value::Object(map),
                _ => json!({}),
            }
        }
    } else {
        json!({})
    };
    let desired = json!({
        "command": mcp_bin,
        "args": ["host-exec-mcp"],
    });
    let servers = root
        .as_object_mut()
        .expect("object")
        .entry("mcpServers")
        .or_insert_with(|| json!({}));
    if !servers.is_object() {
        *servers = json!({});
    }
    let map = servers.as_object_mut().expect("mcpServers");
    if map.get("multicc_host_exec") != Some(&desired) {
        map.insert("multicc_host_exec".to_string(), desired);
        state_file::write_json_atomic(&cfg_path, &root)
            .map_err(|err| format!("写入 Host mcp_config.json 失败: {err}"))?;
    }
    Ok(())
}

fn send_agy_error_and_exit(tx: &mpsc::UnboundedSender<String>, message: &str) {
    let evt = json!({
        "event": "result",
        "result": {
            "conversation_id": "",
            "status": "ERROR",
            "error": message,
            "finished_reason": "relay_error",
        }
    })
    .to_string();
    let _ = tx.send(json!({ "type": "agy_event", "line": evt }).to_string());
    let _ = tx.send(json!({ "type": "exit", "code": 1, "stderr": message }).to_string());
}

/// 在已认证的 WebSocket 连接上运行一次 Host 侧 `agy` 回合（单元测试可直接调用）。
pub async fn serve_relay_session<S>(
    socket: WebSocketStream<S>,
    host_home: PathBuf,
    account_id: String,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut ws_sink, mut ws_stream) = socket.split();
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel::<String>();

    let writer_task = tokio::spawn(async move {
        while let Some(text) = ws_rx.recv().await {
            if ws_sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
        let _ = ws_sink.send(Message::Close(None)).await;
    });

    // 第 1 帧必须是 Client 的 `start` 帧。
    let start_msg = match tokio::time::timeout(START_FRAME_TIMEOUT, async {
        while let Some(Ok(msg)) = ws_stream.next().await {
            if let Message::Text(text) = msg {
                return Some(text.to_string());
            }
        }
        None
    })
    .await
    {
        Ok(Some(text)) => text,
        _ => {
            send_agy_error_and_exit(&ws_tx, "借道连接未收到有效的启动帧");
            drop(ws_tx);
            let _ = writer_task.await;
            return;
        }
    };

    let start_val: Value = match serde_json::from_str::<Value>(&start_msg) {
        Ok(v) if v.get("type").and_then(Value::as_str) == Some("start") => v,
        _ => {
            send_agy_error_and_exit(&ws_tx, "借道启动帧格式无效");
            drop(ws_tx);
            let _ = writer_task.await;
            return;
        }
    };

    let agy_args: Vec<String> = start_val
        .get("agyArgs")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let prompt = start_val
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let local_root = start_val
        .get("localRoot")
        .and_then(Value::as_str)
        .unwrap_or(".")
        .to_string();
    let local_os = start_val
        .get("localOs")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();

    // 校验 Host 本地账号存在 + 实时解析 Host 绑定的出口代理（fail-closed）。
    let (account_home, egress_binding) =
        match agy_store::resolve_account(&host_home, Some(&account_id)) {
            Ok(Some(ResolvedAgyAccount::Local {
                home,
                egress_binding,
            })) => (home, egress_binding),
            _ => {
                send_agy_error_and_exit(
                    &ws_tx,
                    &format!("Host 上未找到反重力账号（{account_id}），可能已被删除"),
                );
                drop(ws_tx);
                let _ = writer_task.await;
                return;
            }
        };

    let proxy_url = if let Some(binding) = egress_binding.as_ref() {
        match crate::egress_runtime::resolve_egress_proxy_url(binding).await {
            Ok(url) => Some(url),
            Err(err) => {
                send_agy_error_and_exit(&ws_tx, &format!("Host 账号专用出口不可用：{err}"));
                drop(ws_tx);
                let _ = writer_task.await;
                return;
            }
        }
    } else {
        None
    };

    if let Err(err) = ensure_host_relay_mcp_config(&account_home) {
        send_agy_error_and_exit(&ws_tx, &err);
        drop(ws_tx);
        let _ = writer_task.await;
        return;
    }

    let turn_token = match generate_token() {
        Ok(t) => t,
        Err(err) => {
            send_agy_error_and_exit(&ws_tx, &err);
            drop(ws_tx);
            let _ = writer_task.await;
            return;
        }
    };

    let rpc_state = Arc::new(RelayRpcBridgeState {
        token: turn_token.clone(),
        ws_tx: ws_tx.clone(),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(0),
    });

    let listener = match TcpListener::bind("127.0.0.1:0").await {
        Ok(l) => l,
        Err(err) => {
            send_agy_error_and_exit(&ws_tx, &format!("无法启动 Host 环回执行桥: {err}"));
            drop(ws_tx);
            let _ = writer_task.await;
            return;
        }
    };
    let bridge_addr = match listener.local_addr() {
        Ok(a) => a,
        Err(err) => {
            send_agy_error_and_exit(&ws_tx, &format!("读取环回执行桥端口失败: {err}"));
            drop(ws_tx);
            let _ = writer_task.await;
            return;
        }
    };
    let router = Router::new()
        .route("/exec", post(rpc_exec))
        .route("/fs/read", post(rpc_read_file))
        .route("/fs/write", post(rpc_write_file))
        .route("/fs/list", post(rpc_list_dir))
        .with_state(rpc_state.clone());
    let bridge_task = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    // 为本轮对话创建空隔离目录，禁止 agy 触碰 Host 的任何业务文件。
    let scratch_dir =
        std::env::temp_dir().join(format!("multicc-agy-relay-scratch-{}", &turn_token[..16]));
    let _ = std::fs::create_dir_all(&scratch_dir);

    let settings_json = build_remote_permissions_settings(FILE_MODE_REMOTE_MCP);
    let wrapped_prompt = wrap_remote_prompt(
        &prompt,
        &local_root,
        &scratch_dir.to_string_lossy(),
        &local_os,
        FILE_MODE_REMOTE_MCP,
    );

    let mut final_args: Vec<String> = Vec::with_capacity(agy_args.len() + 4);
    let mut inserted_settings = false;
    for arg in &agy_args {
        if !inserted_settings && arg == "-p" {
            final_args.push("--settings".to_string());
            final_args.push(settings_json.clone());
            inserted_settings = true;
        }
        final_args.push(arg.clone());
    }
    if !inserted_settings {
        final_args.push("--settings".to_string());
        final_args.push(settings_json);
        final_args.push("-p".to_string());
    }
    final_args.push(wrapped_prompt);

    let agy_bin = host_agy_bin();
    let mut cmd = Command::new(&agy_bin);
    cmd.args(&final_args)
        .current_dir(&scratch_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("HOME", &account_home)
        .env(
            "MULTICC_HOST_EXEC_URL",
            format!("http://127.0.0.1:{}", bridge_addr.port()),
        )
        .env("MULTICC_HOST_EXEC_TOKEN", &turn_token)
        .env("MULTICC_HOST_EXEC_LOCAL_ROOT", &local_root)
        .env(
            "MULTICC_HOST_EXEC_REMOTE_ROOT",
            scratch_dir.to_string_lossy().as_ref(),
        )
        .env("MULTICC_HOST_EXEC_OS", &local_os)
        .env("MULTICC_HOST_EXEC_FILE_MODE", FILE_MODE_REMOTE_MCP)
        .env_remove("MULTICC_AGY_REMOTE_ACCOUNT_JSON")
        .env_remove("MULTICC_AGY_EGRESS_JSON");

    if let Some(url) = proxy_url.as_deref() {
        cmd.env("HTTP_PROXY", url)
            .env("HTTPS_PROXY", url)
            .env("ALL_PROXY", url)
            .env("http_proxy", url)
            .env("https_proxy", url)
            .env("all_proxy", url)
            .env("NO_PROXY", LOOPBACK_NO_PROXY)
            .env("no_proxy", LOOPBACK_NO_PROXY);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(err) => {
            bridge_task.abort();
            let _ = std::fs::remove_dir_all(&scratch_dir);
            send_agy_error_and_exit(&ws_tx, &format!("Host 启动 agy 失败（{agy_bin}）: {err}"));
            drop(ws_tx);
            let _ = writer_task.await;
            return;
        }
    };

    let child_stdout = child.stdout.take();
    let child_stderr = child.stderr.take();

    // 读 Client 发回的 host_exec_res / 监听断连取消。
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    let rpc_reader_state = rpc_state.clone();
    let reader_task = tokio::spawn(async move {
        while let Some(msg_res) = ws_stream.next().await {
            let Ok(msg) = msg_res else { break };
            match msg {
                Message::Text(text) => {
                    if let Ok(val) = serde_json::from_str::<Value>(&text) {
                        if val.get("type").and_then(Value::as_str) == Some("host_exec_res") {
                            if let Some(req_id) = val.get("reqId").and_then(Value::as_str) {
                                let status = val
                                    .get("status")
                                    .and_then(Value::as_u64)
                                    .and_then(|n| u16::try_from(n).ok())
                                    .unwrap_or(200);
                                let body = val.get("body").cloned().unwrap_or_else(|| json!({}));
                                if let Some(tx) =
                                    rpc_reader_state.pending.lock().await.remove(req_id)
                                {
                                    let _ = tx.send((status, body));
                                }
                            }
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = cancel_tx.send(());
    });

    let ws_tx_out = ws_tx.clone();
    let stdout_task = tokio::spawn(async move {
        let mut saw_result = false;
        if let Some(out) = child_stdout {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.contains("\"event\":\"result\"") || line.contains("\"event\": \"result\"") {
                    saw_result = true;
                }
                if ws_tx_out
                    .send(json!({ "type": "agy_event", "line": line }).to_string())
                    .is_err()
                {
                    break;
                }
            }
        }
        saw_result
    });

    let stderr_task = tokio::spawn(async move {
        let mut collected = String::new();
        if let Some(err) = child_stderr {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if collected.len() < 4096 {
                    if !collected.is_empty() {
                        collected.push('\n');
                    }
                    collected.push_str(&line);
                }
            }
        }
        collected
    });

    let (exit_code, client_cancelled) = tokio::select! {
        status = child.wait() => {
            (status.ok().and_then(|s| s.code()).unwrap_or(1), false)
        }
        _ = &mut cancel_rx => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            (130, true)
        }
    };

    let saw_result = stdout_task.await.unwrap_or(false);
    let stderr_text = stderr_task.await.unwrap_or_default();
    reader_task.abort();
    let _ = reader_task.await;
    bridge_task.abort();
    let _ = bridge_task.await;
    drop(rpc_state);
    let _ = std::fs::remove_dir_all(&scratch_dir);

    if !client_cancelled {
        if exit_code != 0 && !saw_result {
            let msg = if stderr_text.trim().is_empty() {
                format!("Host 借道 agy 异常退出（exit {exit_code}）")
            } else {
                format!(
                    "Host 借道 agy 执行异常（exit {exit_code}）：{}",
                    stderr_text.trim()
                )
            };
            send_agy_error_and_exit(&ws_tx, &msg);
        } else {
            let _ = ws_tx.send(
                json!({ "type": "exit", "code": exit_code, "stderr": stderr_text }).to_string(),
            );
        }
    }

    drop(ws_tx);
    let _ = writer_task.await;
}
