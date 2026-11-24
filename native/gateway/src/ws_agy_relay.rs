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

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, Response, StatusCode};
use futures_util::{SinkExt, StreamExt};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::{
    tungstenite::{protocol::Role, Message},
    WebSocketStream,
};

use multicc_core::account_subscription::valid_account;
use multicc_core::agy_accounts::{self as agy_store, ResolvedAgyAccount};
use multicc_core::agy_remote::{
    build_remote_permissions_settings, wrap_remote_prompt, DEFAULT_REMOTE_AGY_BIN,
    FILE_MODE_REMOTE_MCP,
};
use multicc_core::egress_plugin::LOOPBACK_NO_PROXY;
use multicc_core::state_file;

use crate::app::express::{self, RequestCtx};
use crate::app::provider_relay;
use crate::cli_relay_bridge::{
    resolve_host_exec_mcp_bin, stable_session_scratch_dir, upgrade_ws, ws_config, HostRelayBridge,
    RouterContext, RouterMcpSpec, START_FRAME_TIMEOUT,
};

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

/// 解析 `/agy-proxy/<16hex>/quota` 中的 `account_id`。
pub fn parse_quota_account_id(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    let parts: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() == 3
        && parts[0].eq_ignore_ascii_case("agy-proxy")
        && parts[2].eq_ignore_ascii_case("quota")
        && valid_account(parts[1])
    {
        Some(parts[1].to_string())
    } else {
        None
    }
}

/// 解析 `/agy-proxy/<16hex>/models` 中的 `account_id`。
pub fn parse_models_account_id(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    let parts: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() == 3
        && parts[0].eq_ignore_ascii_case("agy-proxy")
        && parts[2].eq_ignore_ascii_case("models")
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

pub fn claims_quota(path: &str) -> bool {
    parse_quota_account_id(path).is_some()
}

pub fn claims_models(path: &str) -> bool {
    parse_models_account_id(path).is_some()
}

/// `GET /agy-proxy/<16hex>/models[?refresh=1|true]`：供借用方透明拉取出借方对应反重力账号的实时模型目录。
///
/// 强制通过 `provider_relay::admission` 校验 `mcr1.` 凭据、撤销状态与单账号作用域；
/// 仅在 Host 本地按账号独立缓存并注入账号绑定的专用出口（fail-closed），绝不泄露凭据或原始会话信息。
pub async fn handle_models(ctx: &RequestCtx, peer: &str, host_port: u16) -> Response<Body> {
    let Some(account_id) = parse_models_account_id(&ctx.path) else {
        return express::error(ctx, 404, "not found");
    };
    let headers = match provider_relay::admission(ctx, peer, host_port).await {
        Ok(h) => h,
        Err(refusal) => return *refusal,
    };
    let Some(home) = home_dir() else {
        let mut resp = express::json(
            ctx,
            500,
            &json!({ "error": "Host 无法定位 HOME 目录", "models": [] }),
            &[("Cache-Control", "no-store")],
        );
        provider_relay::append_headers(&mut resp, &headers);
        return resp;
    };
    let (account_home, egress_binding) = match agy_store::resolve_account(&home, Some(&account_id))
    {
        Ok(Some(ResolvedAgyAccount::Local {
            home,
            egress_binding,
        })) => (home, egress_binding),
        _ => {
            let mut resp = express::json(
                ctx,
                404,
                &json!({ "error": "Host 上对应的反重力账号已不存在", "models": [] }),
                &[("Cache-Control", "no-store")],
            );
            provider_relay::append_headers(&mut resp, &headers);
            return resp;
        }
    };
    let refresh = ctx
        .original_url
        .split('?')
        .nth(1)
        .unwrap_or("")
        .split('&')
        .any(|part| {
            part.eq_ignore_ascii_case("refresh=1") || part.eq_ignore_ascii_case("refresh=true")
        });
    let result = tokio::time::timeout(
        Duration::from_secs(25),
        crate::app::agy_catalog::query_local_account(
            &account_id,
            &account_home,
            egress_binding.as_ref(),
            refresh,
        ),
    )
    .await;
    let mut resp = match result {
        Ok(Ok((models, cached))) => express::json(
            ctx,
            200,
            &json!({ "models": models, "source": "cli", "cached": cached }),
            &[("Cache-Control", "no-store")],
        ),
        Ok(Err(err)) => express::json(
            ctx,
            503,
            &json!({ "error": err, "models": [] }),
            &[("Cache-Control", "no-store")],
        ),
        Err(_) => express::json(
            ctx,
            503,
            &json!({ "error": "Host 查询反重力模型目录超时", "models": [] }),
            &[("Cache-Control", "no-store")],
        ),
    };
    provider_relay::append_headers(&mut resp, &headers);
    resp
}

/// `GET /agy-proxy/<16hex>/quota[?force=1]`：供借用方透明查询出借方对应反重力账号的实时额度。
///
/// 强制通过 `provider_relay::admission` 校验 `mcr1.` 凭据、撤销状态与单账号作用域；
/// 仅在 Host 本地按账号独立缓存并注入账号绑定的专用出口（fail-closed），绝不泄露凭据或原始 CLI 输出。
pub async fn handle_quota(ctx: &RequestCtx, peer: &str, host_port: u16) -> Response<Body> {
    let Some(account_id) = parse_quota_account_id(&ctx.path) else {
        return express::error(ctx, 404, "not found");
    };
    let headers = match provider_relay::admission(ctx, peer, host_port).await {
        Ok(h) => h,
        Err(refusal) => return *refusal,
    };
    let Some(home) = home_dir() else {
        let mut resp = express::json(
            ctx,
            500,
            &json!({ "status": "unavailable", "error": "Host 无法定位 HOME 目录" }),
            &[("Cache-Control", "no-store")],
        );
        provider_relay::append_headers(&mut resp, &headers);
        return resp;
    };
    let (account_home, egress_binding) = match agy_store::resolve_account(&home, Some(&account_id))
    {
        Ok(Some(ResolvedAgyAccount::Local {
            home,
            egress_binding,
        })) => (home, egress_binding),
        _ => {
            let mut resp = express::json(
                ctx,
                404,
                &json!({ "status": "unavailable", "error": "Host 上对应的反重力账号已不存在" }),
                &[("Cache-Control", "no-store")],
            );
            provider_relay::append_headers(&mut resp, &headers);
            return resp;
        }
    };
    let force = ctx
        .original_url
        .split('?')
        .nth(1)
        .unwrap_or("")
        .split('&')
        .any(|part| part == "force=1");
    let body = crate::app::agy_quota::query_local_account(
        &account_id,
        &account_home,
        egress_binding.as_ref(),
        force,
    )
    .await;
    let mut resp = express::json(ctx, 200, &body, &[("Cache-Control", "no-store")]);
    provider_relay::append_headers(&mut resp, &headers);
    resp
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
    router_mcp: Option<RouterMcpSpec>,
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
    let (response, upgrade) = match upgrade_ws(&mut request) {
        Ok(pair) => pair,
        Err(rejected) => return rejected,
    };

    tokio::spawn(async move {
        let Ok(upgraded) = upgrade.await else { return };
        let socket = WebSocketStream::from_raw_socket(
            TokioIo::new(upgraded),
            Role::Server,
            Some(ws_config()),
        )
        .await;
        serve_relay_session_with_router(socket, home, account_id, router_mcp).await;
    });
    response
}

fn ensure_host_relay_mcp_config(
    account_home: &Path,
    router_mcp: Option<&RouterMcpSpec>,
) -> Result<(), String> {
    let mcp_bin = resolve_host_exec_mcp_bin()?;
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
    let desired_exec = json!({
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
    let mut changed = false;
    if map.get("multicc_host_exec") != Some(&desired_exec) {
        map.insert("multicc_host_exec".to_string(), desired_exec);
        changed = true;
    }
    if let Some(spec) = router_mcp {
        let desired_router = json!({
            "command": spec.node_bin,
            "args": [spec.script_path.to_string_lossy().into_owned()],
        });
        if map.get("multicc_router") != Some(&desired_router) {
            map.insert("multicc_router".to_string(), desired_router);
            changed = true;
        }
    }
    if changed {
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
    serve_relay_session_with_router(socket, host_home, account_id, None).await;
}

/// 在已认证的 WebSocket 连接上运行一次 Host 侧 `agy` 回合，并可选桥接 `multicc_router` MCP。
pub async fn serve_relay_session_with_router<S>(
    socket: WebSocketStream<S>,
    host_home: PathBuf,
    account_id: String,
    router_mcp: Option<RouterMcpSpec>,
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
    let router_ctx = RouterContext::from_start_frame(&start_val);

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

    let active_router_mcp = router_ctx.as_ref().and_then(|_| router_mcp.as_ref());
    if let Err(err) = ensure_host_relay_mcp_config(&account_home, active_router_mcp) {
        send_agy_error_and_exit(&ws_tx, &err);
        drop(ws_tx);
        let _ = writer_task.await;
        return;
    }

    let bridge = match HostRelayBridge::start(ws_tx.clone()).await {
        Ok(b) => b,
        Err(err) => {
            send_agy_error_and_exit(&ws_tx, &err);
            drop(ws_tx);
            let _ = writer_task.await;
            return;
        }
    };

    // 为本轮对话创建空隔离目录，禁止 agy 触碰 Host 的任何业务文件。
    let (scratch_dir, _) = stable_session_scratch_dir("agy", &account_id, None, bridge.token());
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
        .env_remove("MULTICC_AGY_REMOTE_ACCOUNT_JSON")
        .env_remove("MULTICC_AGY_EGRESS_JSON");
    bridge.apply_child_env(
        &mut cmd,
        &local_root,
        &scratch_dir.to_string_lossy(),
        &local_os,
        FILE_MODE_REMOTE_MCP,
        router_ctx.as_ref(),
    );

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
            bridge.shutdown().await;
            let _ = std::fs::remove_dir_all(&scratch_dir);
            send_agy_error_and_exit(&ws_tx, &format!("Host 启动 agy 失败（{agy_bin}）: {err}"));
            drop(ws_tx);
            let _ = writer_task.await;
            return;
        }
    };

    let child_stdout = child.stdout.take();
    let child_stderr = child.stderr.take();

    // 读 Client 发回的 host_exec_res / router_tool_* / 监听断连取消。
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    let bridge_handle = bridge.handle();
    let reader_task = tokio::spawn(async move {
        while let Some(msg_res) = ws_stream.next().await {
            let Ok(msg) = msg_res else { break };
            match msg {
                Message::Text(text) => {
                    if let Ok(val) = serde_json::from_str::<Value>(&text) {
                        bridge_handle.handle_client_frame(&val).await;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        bridge_handle.fail_all_pending().await;
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
    bridge.shutdown().await;
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
