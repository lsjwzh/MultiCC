//! Codex CLI 级借道（远端大脑 + 本地手脚）的 Host 侧服务端：
//!
//! - `GET /codex-proxy/<providerId>/cli-ping`：探测分享码有效性、Host provider 存在性与 `codex` CLI 可用性；
//! - `WS  /codex-proxy/<providerId>/cli-turn`：单条双向 WebSocket 承载一次受控 `codex app-server` 回合：
//!   1. 升级前强制经 `provider_relay::admission` 校验 `mcr1.` 凭据、撤销状态与单 provider 作用域；
//!   2. 实测证实 `codex exec` 即使关闭 `shell_tool`/`unified_exec` 仍暴露内置 `functions.exec` 与 `tools.apply_patch`，
//!      因此 Host 侧通过 `codex app-server --listen stdio://` 以 `approvalPolicy: "untrusted"` +
//!      `sandbox: "read-only"` 运行，并在协议层对所有 `requestApproval`（`commandExecution` / `fileChange`）
//!      硬性回复 `{"decision": "decline"}`，彻底阻断任何 Host 本地命令与改盘；
//!   3. 通过 `-c mcp_servers.multicc_host_exec.env_vars=[...]` 与 `default_tools_approval_mode="approve"`
//!      注入 `multicc_host_exec`（+ 可选 `multicc_router`），凭据走环境变量不暴露于 argv；
//!   4. 隔离 `HOME` 与 `CODEX_HOME`（不加载 Host `~/.agents/skills/`），并将 `CODEX_HOME/config.toml`
//!      指向 Host 本机 `/codex-proxy/<providerId>`，复用 Host 官方账号、专用出口与用量统计。

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, Response, StatusCode};
use futures_util::{SinkExt, StreamExt};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::{
    tungstenite::{protocol::Role, Message},
    WebSocketStream,
};

use multicc_core::agy_remote::FILE_MODE_REMOTE_MCP;
use multicc_core::egress_plugin::LOOPBACK_NO_PROXY;
use multicc_core::http_gate::encode_uri_component;

use crate::app::download::decode_uri_component;
use crate::app::express::{self, RequestCtx};
use crate::app::provider_relay;
use crate::cli_relay_bridge::{
    build_cli_remote_guidance, resolve_host_exec_mcp_bin, stable_session_scratch_dir, upgrade_ws,
    ws_config, HostRelayBridge, RouterContext, RouterMcpSpec, ROUTER_ENV_KEYS, START_FRAME_TIMEOUT,
};
use crate::host_port;

const HOST_EXEC_ENV_VARS: &[&str] = &[
    "MULTICC_HOST_EXEC_URL",
    "MULTICC_HOST_EXEC_TOKEN",
    "MULTICC_HOST_EXEC_LOCAL_ROOT",
    "MULTICC_HOST_EXEC_REMOTE_ROOT",
    "MULTICC_HOST_EXEC_OS",
    "MULTICC_HOST_EXEC_FILE_MODE",
];

fn host_codex_bin() -> String {
    std::env::var("MULTICC_CODEX_BIN")
        .ok()
        .or_else(|| std::env::var("CODEX_CMD").ok())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "codex".to_string())
}

fn valid_provider_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && !id.contains('/')
        && !id.contains('\\')
        && !id.chars().any(char::is_control)
}

/// 解析 `/codex-proxy/<providerId>/cli-turn`。
pub fn parse_cli_turn_provider_id(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    let parts: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() == 3
        && parts[0].eq_ignore_ascii_case("codex-proxy")
        && parts[2].eq_ignore_ascii_case("cli-turn")
    {
        let decoded = decode_uri_component(parts[1])?;
        valid_provider_id(&decoded).then_some(decoded)
    } else {
        None
    }
}

/// 解析 `/codex-proxy/<providerId>/cli-ping`。
pub fn parse_cli_ping_provider_id(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    let parts: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() == 3
        && parts[0].eq_ignore_ascii_case("codex-proxy")
        && parts[2].eq_ignore_ascii_case("cli-ping")
    {
        let decoded = decode_uri_component(parts[1])?;
        valid_provider_id(&decoded).then_some(decoded)
    } else {
        None
    }
}

pub fn claims_ws(path: &str) -> bool {
    parse_cli_turn_provider_id(path).is_some()
}

pub fn claims_ping(path: &str) -> bool {
    parse_cli_ping_provider_id(path).is_some()
}

fn isolated_codex_home(provider_id: &str) -> (PathBuf, PathBuf) {
    let digest = Sha256::digest(provider_id.as_bytes());
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    let home = std::env::temp_dir()
        .join("multicc-codex-relay-home")
        .join(hex);
    let codex_home = home.join(".codex");
    (home, codex_home)
}

fn ensure_codex_relay_config(
    codex_home: &PathBuf,
    provider_id: &str,
    public_port: u16,
) -> Result<(), String> {
    std::fs::create_dir_all(codex_home)
        .map_err(|err| format!("创建 Host CODEX_HOME 失败: {err}"))?;
    let encoded_provider = encode_uri_component(provider_id);
    let base_url = format!("http://127.0.0.1:{public_port}/codex-proxy/{encoded_provider}");
    let config_toml = format!(
        "model_provider = \"multicc_relay\"\n\n\
[model_providers.multicc_relay]\n\
name = \"MultiCC Relay\"\n\
base_url = \"{base_url}\"\n\
wire_api = \"responses\"\n\
env_key = \"MULTICC_CODEX_RELAY_KEY\"\n"
    );
    let cfg_path = codex_home.join("config.toml");
    let existing = std::fs::read_to_string(&cfg_path).unwrap_or_default();
    if existing != config_toml {
        std::fs::write(&cfg_path, config_toml)
            .map_err(|err| format!("写入 Host CODEX_HOME/config.toml 失败: {err}"))?;
    }
    Ok(())
}

fn build_codex_mcp_config_args(exec_bin: &str, router_mcp: Option<&RouterMcpSpec>) -> Vec<String> {
    let mut cfg = vec![
        format!("mcp_servers.multicc_host_exec.command={}", json!(exec_bin)),
        format!(
            "mcp_servers.multicc_host_exec.args={}",
            json!(["host-exec-mcp"])
        ),
        format!(
            "mcp_servers.multicc_host_exec.env_vars={}",
            json!(HOST_EXEC_ENV_VARS)
        ),
        "mcp_servers.multicc_host_exec.enabled=true".to_string(),
        "mcp_servers.multicc_host_exec.required=true".to_string(),
        "mcp_servers.multicc_host_exec.startup_timeout_sec=60".to_string(),
        "mcp_servers.multicc_host_exec.tool_timeout_sec=610".to_string(),
        "mcp_servers.multicc_host_exec.default_tools_approval_mode=\"approve\"".to_string(),
    ];
    if let Some(spec) = router_mcp {
        cfg.extend([
            format!(
                "mcp_servers.multicc_router.command={}",
                json!(spec.node_bin)
            ),
            format!(
                "mcp_servers.multicc_router.args={}",
                json!([spec.script_path.to_string_lossy().into_owned()])
            ),
            format!(
                "mcp_servers.multicc_router.env_vars={}",
                json!(ROUTER_ENV_KEYS)
            ),
            "mcp_servers.multicc_router.enabled=true".to_string(),
            "mcp_servers.multicc_router.required=true".to_string(),
            "mcp_servers.multicc_router.startup_timeout_sec=60".to_string(),
            "mcp_servers.multicc_router.tool_timeout_sec=21630".to_string(),
            "mcp_servers.multicc_router.default_tools_approval_mode=\"approve\"".to_string(),
        ]);
    }
    cfg
}

async fn lookup_host_codex_provider(
    host_port_num: u16,
    provider_id: &str,
) -> Result<Option<String>, String> {
    let answer = host_port::call(
        host_port_num,
        "/api/__host/providers",
        &json!({ "op": "relayShareFacts", "appType": "codex", "id": provider_id }),
    )
    .await
    .map_err(|_| "Host provider 运行时不可用".to_string())?;
    let Some(provider) = answer.get("provider").filter(|v| v.is_object()) else {
        return Ok(None);
    };
    let name = provider
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(provider_id)
        .to_string();
    Ok(Some(name))
}

/// `GET /codex-proxy/<providerId>/cli-ping`
pub async fn handle_ping(ctx: &RequestCtx, peer: &str, host_port_num: u16) -> Response<Body> {
    let Some(provider_id) = parse_cli_ping_provider_id(&ctx.path) else {
        return express::error(ctx, 404, "not found");
    };
    let headers = match provider_relay::admission(ctx, peer, host_port_num).await {
        Ok(h) => h,
        Err(refusal) => return *refusal,
    };
    let provider_name = match lookup_host_codex_provider(host_port_num, &provider_id).await {
        Ok(Some(name)) => name,
        Ok(None) => {
            let mut resp = express::json(
                ctx,
                404,
                &json!({ "ok": false, "error": "Host 上对应的 Codex 线路已不存在" }),
                &[("Cache-Control", "no-store")],
            );
            provider_relay::append_headers(&mut resp, &headers);
            return resp;
        }
        Err(err) => {
            let mut resp = express::json(
                ctx,
                503,
                &json!({ "ok": false, "error": err }),
                &[("Cache-Control", "no-store")],
            );
            provider_relay::append_headers(&mut resp, &headers);
            return resp;
        }
    };
    let codex_bin = host_codex_bin();
    let codex_ok = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new(&codex_bin)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .status(),
    )
    .await
    .is_ok_and(|res| res.is_ok_and(|s| s.success()));

    let mut resp = express::json(
        ctx,
        200,
        &json!({
            "ok": true,
            "transport": "cli-relay",
            "cli": "codex-exp",
            "providerId": provider_id,
            "providerName": provider_name,
            "cliAvailable": codex_ok,
        }),
        &[("Cache-Control", "no-store")],
    );
    provider_relay::append_headers(&mut resp, &headers);
    resp
}

/// `WS /codex-proxy/<providerId>/cli-turn`
pub async fn handle_ws(
    peer: SocketAddr,
    host_port_num: u16,
    public_port: u16,
    router_mcp: Option<RouterMcpSpec>,
    mut request: Request<Body>,
) -> Response<Body> {
    let path = request.uri().path().to_string();
    let Some(provider_id) = parse_cli_turn_provider_id(&path) else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("not found"))
            .expect("response");
    };

    let (parts, body) = request.into_parts();
    let ctx = RequestCtx::new(&parts);
    if let Err(refusal) =
        provider_relay::admission(&ctx, &peer.ip().to_string(), host_port_num).await
    {
        return *refusal;
    }
    match lookup_host_codex_provider(host_port_num, &provider_id).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            return express::json(
                &ctx,
                404,
                &json!({ "error": "Host 上对应的 Codex 线路已不存在" }),
                &[],
            );
        }
        Err(err) => {
            return express::json(&ctx, 503, &json!({ "error": err }), &[]);
        }
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
        serve_codex_relay_session(socket, provider_id, public_port, router_mcp).await;
    });
    response
}

fn send_codex_error_and_exit(tx: &mpsc::UnboundedSender<String>, message: &str) {
    let evt = json!({
        "method": "turn/completed",
        "params": {
            "turn": {
                "status": "failed",
                "error": { "message": message }
            }
        }
    })
    .to_string();
    let _ = tx.send(json!({ "type": "cli_event", "line": evt }).to_string());
    let _ = tx.send(json!({ "type": "exit", "code": 1, "stderr": message }).to_string());
}

async fn write_jsonrpc(stdin: &mut tokio::process::ChildStdin, val: &Value) -> Result<(), String> {
    let mut line = val.to_string();
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("写入 codex app-server 失败: {e}"))?;
    let _ = stdin.flush().await;
    Ok(())
}

/// 在已认证的 WebSocket 上运行一次受控 Host `codex app-server` 回合（单元测试可直接调用）。
pub async fn serve_codex_relay_session<S>(
    socket: WebSocketStream<S>,
    provider_id: String,
    public_port: u16,
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
            send_codex_error_and_exit(&ws_tx, "Codex CLI 借道连接未收到有效的启动帧");
            drop(ws_tx);
            let _ = writer_task.await;
            return;
        }
    };

    let start_val: Value = match serde_json::from_str::<Value>(&start_msg) {
        Ok(v) if v.get("type").and_then(Value::as_str) == Some("start") => v,
        _ => {
            send_codex_error_and_exit(&ws_tx, "Codex CLI 借道启动帧格式无效");
            drop(ws_tx);
            let _ = writer_task.await;
            return;
        }
    };

    let clean_opt = |key: &str| {
        start_val
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let model = clean_opt("model");
    let effort = clean_opt("effort");
    let thread_id_req = clean_opt("threadId");
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

    let bridge = match HostRelayBridge::start(ws_tx.clone()).await {
        Ok(b) => b,
        Err(err) => {
            send_codex_error_and_exit(&ws_tx, &err);
            drop(ws_tx);
            let _ = writer_task.await;
            return;
        }
    };

    let exec_bin = match resolve_host_exec_mcp_bin() {
        Ok(b) => b,
        Err(err) => {
            bridge.shutdown().await;
            send_codex_error_and_exit(&ws_tx, &err);
            drop(ws_tx);
            let _ = writer_task.await;
            return;
        }
    };

    let (isolated_home, codex_home) = isolated_codex_home(&provider_id);
    let _ = std::fs::create_dir_all(&isolated_home);
    if let Err(err) = ensure_codex_relay_config(&codex_home, &provider_id, public_port) {
        bridge.shutdown().await;
        send_codex_error_and_exit(&ws_tx, &err);
        drop(ws_tx);
        let _ = writer_task.await;
        return;
    }

    let (scratch_dir, keep_scratch) = stable_session_scratch_dir(
        "codex",
        &provider_id,
        thread_id_req.as_deref(),
        bridge.token(),
    );
    let _ = std::fs::create_dir_all(&scratch_dir);

    let active_router_mcp = router_ctx.as_ref().and_then(|_| router_mcp.as_ref());
    let mcp_cfg_args = build_codex_mcp_config_args(&exec_bin, active_router_mcp);

    let codex_bin = host_codex_bin();
    let mut cmd = Command::new(&codex_bin);
    cmd.args(["app-server", "--listen", "stdio://"]);
    for cfg in &mcp_cfg_args {
        cmd.args(["-c", cfg]);
    }
    cmd.current_dir(&scratch_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("HOME", &isolated_home)
        .env("CODEX_HOME", &codex_home)
        .env("MULTICC_CODEX_RELAY_KEY", "multicc-cli-relay")
        .env("NO_PROXY", LOOPBACK_NO_PROXY)
        .env("no_proxy", LOOPBACK_NO_PROXY)
        .env_remove("OPENAI_API_KEY")
        .env_remove("MULTICC_CODEX_CLI_RELAY_JSON");
    bridge.apply_child_env(
        &mut cmd,
        &local_root,
        &scratch_dir.to_string_lossy(),
        &local_os,
        FILE_MODE_REMOTE_MCP,
        router_ctx.as_ref(),
    );

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(err) => {
            bridge.shutdown().await;
            if !keep_scratch {
                let _ = std::fs::remove_dir_all(&scratch_dir);
            }
            send_codex_error_and_exit(
                &ws_tx,
                &format!("Host 启动 Codex app-server 失败（{codex_bin}）: {err}"),
            );
            drop(ws_tx);
            let _ = writer_task.await;
            return;
        }
    };

    let mut child_stdin = child.stdin.take().expect("codex stdin");
    let child_stdout = child.stdout.take().expect("codex stdout");
    let child_stderr = child.stderr.take();

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

    let guidance = build_cli_remote_guidance(
        "Codex",
        &local_root,
        &scratch_dir.to_string_lossy(),
        &local_os,
        active_router_mcp.is_some(),
    );
    let wrapped_prompt = format!("{guidance}\n\n{prompt}");
    let scratch_str = scratch_dir.to_string_lossy().into_owned();

    // 驱动 codex app-server 单回合协议：
    // 1. initialize -> initialized
    // 2. thread/resume (若失败回退 thread/start)，强制 approvalPolicy="untrusted", sandbox="read-only"
    // 3. turn/start
    // 4. 拦截并硬拒绝一切 built-in requestApproval，透传全部事件通知直至 turn/completed
    let mut lines = BufReader::new(child_stdout).lines();
    let mut next_rpc_id: u64 = 1;
    let mut rpc_failed: Option<String> = None;
    let mut client_cancelled = false;

    let init_id = next_rpc_id;
    next_rpc_id += 1;
    if let Err(err) = write_jsonrpc(
        &mut child_stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": init_id,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "multicc-codex-relay",
                    "title": "MultiCC Codex Relay",
                    "version": "0.1.0"
                }
            }
        }),
    )
    .await
    {
        rpc_failed = Some(err);
    }

    #[derive(PartialEq, Eq)]
    enum Phase {
        WaitInit(u64),
        WaitThread { req_id: u64, tried_resume: bool },
        WaitTurnStart(u64),
        Streaming { thread_id: String },
        Done,
    }

    let mut phase = Phase::WaitInit(init_id);
    let mut active_thread_id: Option<String> = None;

    while rpc_failed.is_none() && phase != Phase::Done {
        let next_line = tokio::select! {
            line = lines.next_line() => line,
            _ = &mut cancel_rx => {
                client_cancelled = true;
                break;
            }
        };
        let Ok(Some(line)) = next_line else {
            rpc_failed = Some("Host Codex app-server 提前退出".to_string());
            break;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        // 1) Server-initiated JSON-RPC request（id + method）：对所有本地执行/改盘审批一律硬拒绝！
        if msg.get("id").is_some_and(|v| !v.is_null())
            && msg.get("method").and_then(Value::as_str).is_some()
        {
            let req_id = msg.get("id").cloned().unwrap_or(Value::Null);
            let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
            let reply = if method.contains("requestApproval") || method.ends_with("Approval") {
                json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": { "decision": "decline" }
                })
            } else {
                json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {
                        "code": -32601,
                        "message": "Remote Codex relay declines host interactive requests; use multicc_host_exec MCP tools"
                    }
                })
            };
            if let Err(err) = write_jsonrpc(&mut child_stdin, &reply).await {
                rpc_failed = Some(err);
                break;
            }
            continue;
        }

        // 2) JSON-RPC response to our own initialize / thread/* / turn/start request
        if let Some(resp_id) = msg.get("id").and_then(Value::as_u64) {
            let is_err = msg.get("error").is_some_and(|v| !v.is_null());
            let err_msg = msg
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("codex app-server RPC error")
                .to_string();
            match &phase {
                Phase::WaitInit(expected) if *expected == resp_id => {
                    if is_err {
                        rpc_failed = Some(format!("Codex initialize 失败: {err_msg}"));
                        break;
                    }
                    let _ = write_jsonrpc(
                        &mut child_stdin,
                        &json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }),
                    )
                    .await;
                    let req_id = next_rpc_id;
                    next_rpc_id += 1;
                    let (method, mut params, tried_resume) = if let Some(tid) = &thread_id_req {
                        (
                            "thread/resume",
                            json!({
                                "threadId": tid,
                                "excludeTurns": true,
                                "cwd": scratch_str,
                                "approvalPolicy": "untrusted",
                                "sandbox": "read-only",
                            }),
                            true,
                        )
                    } else {
                        (
                            "thread/start",
                            json!({
                                "cwd": scratch_str,
                                "approvalPolicy": "untrusted",
                                "sandbox": "read-only",
                                "threadSource": "multicc-codex-relay",
                                "sessionStartSource": "startup",
                            }),
                            false,
                        )
                    };
                    if let Some(m) = &model {
                        if let Some(map) = params.as_object_mut() {
                            map.insert("model".to_string(), json!(m));
                        }
                    }
                    if let Err(err) = write_jsonrpc(
                        &mut child_stdin,
                        &json!({ "jsonrpc": "2.0", "id": req_id, "method": method, "params": params }),
                    )
                    .await
                    {
                        rpc_failed = Some(err);
                        break;
                    }
                    phase = Phase::WaitThread {
                        req_id,
                        tried_resume,
                    };
                }
                Phase::WaitThread {
                    req_id: expected,
                    tried_resume,
                } if *expected == resp_id => {
                    if is_err && *tried_resume {
                        // thread/resume 失败则自动降级新建 thread
                        let new_req_id = next_rpc_id;
                        next_rpc_id += 1;
                        let mut params = json!({
                            "cwd": scratch_str,
                            "approvalPolicy": "untrusted",
                            "sandbox": "read-only",
                            "threadSource": "multicc-codex-relay",
                            "sessionStartSource": "startup",
                        });
                        if let Some(m) = &model {
                            if let Some(map) = params.as_object_mut() {
                                map.insert("model".to_string(), json!(m));
                            }
                        }
                        if let Err(err) = write_jsonrpc(
                            &mut child_stdin,
                            &json!({ "jsonrpc": "2.0", "id": new_req_id, "method": "thread/start", "params": params }),
                        )
                        .await
                        {
                            rpc_failed = Some(err);
                            break;
                        }
                        phase = Phase::WaitThread {
                            req_id: new_req_id,
                            tried_resume: false,
                        };
                    } else if is_err {
                        rpc_failed = Some(format!("Codex thread/start 失败: {err_msg}"));
                        break;
                    } else {
                        let tid = msg
                            .pointer("/result/thread/id")
                            .or_else(|| msg.pointer("/result/threadId"))
                            .or_else(|| msg.pointer("/result/id"))
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .or_else(|| thread_id_req.clone())
                            .unwrap_or_default();
                        if tid.is_empty() {
                            rpc_failed = Some("Codex 未返回有效 threadId".to_string());
                            break;
                        }
                        active_thread_id = Some(tid.clone());
                        // 若是 resume，显式补发 thread/started 便于客户端记录 threadId
                        let _ = ws_tx.send(
                            json!({
                                "type": "cli_event",
                                "line": json!({
                                    "method": "thread/started",
                                    "params": { "thread": { "id": tid } }
                                }).to_string()
                            })
                            .to_string(),
                        );
                        let turn_req_id = next_rpc_id;
                        next_rpc_id += 1;
                        let mut turn_params = json!({
                            "threadId": tid,
                            "input": [{ "type": "text", "text": wrapped_prompt }],
                        });
                        if let Some(e) = &effort {
                            if let Some(map) = turn_params.as_object_mut() {
                                map.insert("effort".to_string(), json!(e));
                            }
                        }
                        if let Err(err) = write_jsonrpc(
                            &mut child_stdin,
                            &json!({
                                "jsonrpc": "2.0",
                                "id": turn_req_id,
                                "method": "turn/start",
                                "params": turn_params
                            }),
                        )
                        .await
                        {
                            rpc_failed = Some(err);
                            break;
                        }
                        phase = Phase::WaitTurnStart(turn_req_id);
                    }
                }
                Phase::WaitTurnStart(expected) if *expected == resp_id => {
                    if is_err {
                        rpc_failed = Some(format!("Codex turn/start 失败: {err_msg}"));
                        break;
                    }
                    phase = Phase::Streaming {
                        thread_id: active_thread_id.clone().unwrap_or_default(),
                    };
                }
                _ => {}
            }
            continue;
        }

        // 3) Notification from codex app-server → 透传给 Client
        if let Some(method) = msg.get("method").and_then(Value::as_str) {
            if ws_tx
                .send(json!({ "type": "cli_event", "line": trimmed }).to_string())
                .is_err()
            {
                client_cancelled = true;
                break;
            }
            if method == "turn/completed" {
                let evt_tid = msg
                    .pointer("/params/threadId")
                    .or_else(|| msg.pointer("/params/thread/id"))
                    .and_then(Value::as_str);
                let is_main = match (&phase, evt_tid) {
                    (Phase::Streaming { thread_id }, Some(et)) if !thread_id.is_empty() => {
                        et == thread_id
                    }
                    _ => true,
                };
                if is_main {
                    phase = Phase::Done;
                }
            }
        }
    }

    drop(child_stdin);
    let _ = child.kill().await;
    let _ = child.wait().await;
    let stderr_text = stderr_task.await.unwrap_or_default();
    reader_task.abort();
    let _ = reader_task.await;
    bridge.shutdown().await;
    if !keep_scratch {
        let _ = std::fs::remove_dir_all(&scratch_dir);
    }

    if !client_cancelled {
        if let Some(err) = rpc_failed {
            let full = if stderr_text.trim().is_empty() {
                err
            } else {
                format!("{err}（{}）", stderr_text.trim())
            };
            send_codex_error_and_exit(&ws_tx, &full);
        } else {
            let _ =
                ws_tx.send(json!({ "type": "exit", "code": 0, "stderr": stderr_text }).to_string());
        }
    }

    drop(ws_tx);
    let _ = writer_task.await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_codex_cli_relay_paths() {
        assert_eq!(
            parse_cli_turn_provider_id("/codex-proxy/codex-official/cli-turn"),
            Some("codex-official".to_string())
        );
        assert_eq!(
            parse_cli_ping_provider_id("/codex-proxy/p_123/cli-ping/"),
            Some("p_123".to_string())
        );
        assert_eq!(parse_cli_turn_provider_id("/codex-proxy/p/responses"), None);
    }

    #[test]
    fn codex_mcp_config_uses_env_vars_and_never_embeds_secrets() {
        let args = build_codex_mcp_config_args("/usr/local/bin/multicc-gateway", None);
        let joined = args.join("\n");
        assert!(joined.contains("mcp_servers.multicc_host_exec.env_vars="));
        assert!(joined.contains("default_tools_approval_mode=\"approve\""));
        assert!(!joined.contains("Bearer "));
    }
}
