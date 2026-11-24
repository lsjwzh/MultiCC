//! Claude Code CLI 级借道（远端大脑 + 本地手脚）的 Host 侧服务端：
//!
//! - `GET /claude-proxy/<providerId>/remote/cli-ping`：探测分享码有效性、Host provider 存在性与 `claude` CLI 可用性；
//! - `WS  /claude-proxy/<providerId>/remote/cli-turn`：单条双向 WebSocket 承载一次受控 `claude -p` 回合：
//!   1. 升级前强制经 `provider_relay::admission` 校验 `mcr1.` 凭据、撤销状态与单 provider 作用域；
//!   2. `--tools ""` 彻底禁用 Claude 全部内置本地工具（Bash/Read/Edit/Write/Glob/Grep 等）；
//!   3. `--strict-mcp-config --mcp-config <inline-json>` 零落盘注入 `multicc_host_exec`（+ 可选 `multicc_router`），
//!      禁止加载 Host 上任何其他 MCP；`--setting-sources ""` 跳过 Host 的 `CLAUDE.md` / hooks / plugins；
//!   4. 按 `(providerId, sessionId)` 使用确定性稳定空目录作为 `cwd`，使 `--resume <sessionId>` 跨轮正常恢复；
//!   5. `ANTHROPIC_BASE_URL` 指向 Host 本机 `/claude-proxy/<providerId>/cli-relay`，透明复用 Host 的
//!      官方 OAuth 账号、自动刷新、专用 `egressBinding` 出口（fail-closed）与用量统计，子进程绝不接触真实凭据。

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Stdio;

use axum::body::Body;
use axum::http::{Request, Response, StatusCode};
use futures_util::{SinkExt, StreamExt};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, BufReader};
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
    build_cli_remote_guidance, build_inline_mcp_servers_json, stable_session_scratch_dir,
    upgrade_ws, ws_config, HostRelayBridge, RouterContext, RouterMcpSpec, START_FRAME_TIMEOUT,
};
use crate::host_port;

const CLAUDE_ALT_TRANSPORT_KEYS: &[&str] = &[
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
];

fn host_claude_bin() -> String {
    std::env::var("MULTICC_CLAUDE_BIN")
        .ok()
        .or_else(|| std::env::var("CLAUDE_CMD").ok())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "claude".to_string())
}

fn valid_provider_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && !id.contains('/')
        && !id.contains('\\')
        && !id.chars().any(char::is_control)
}

/// 解析 `/claude-proxy/<providerId>/remote/cli-turn`。
pub fn parse_cli_turn_provider_id(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    let parts: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() == 4
        && parts[0].eq_ignore_ascii_case("claude-proxy")
        && parts[2].eq_ignore_ascii_case("remote")
        && parts[3].eq_ignore_ascii_case("cli-turn")
    {
        let decoded = decode_uri_component(parts[1])?;
        valid_provider_id(&decoded).then_some(decoded)
    } else {
        None
    }
}

/// 解析 `/claude-proxy/<providerId>/remote/cli-ping`。
pub fn parse_cli_ping_provider_id(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    let parts: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() == 4
        && parts[0].eq_ignore_ascii_case("claude-proxy")
        && parts[2].eq_ignore_ascii_case("remote")
        && parts[3].eq_ignore_ascii_case("cli-ping")
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

fn isolated_claude_config_dir(provider_id: &str) -> PathBuf {
    let digest = Sha256::digest(provider_id.as_bytes());
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    std::env::temp_dir()
        .join("multicc-claude-relay-config")
        .join(hex)
}

async fn lookup_host_claude_provider(
    host_port_num: u16,
    provider_id: &str,
) -> Result<Option<String>, String> {
    let answer = host_port::call(
        host_port_num,
        "/api/__host/providers",
        &json!({ "op": "relayShareFacts", "appType": "claude", "id": provider_id }),
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

/// `GET /claude-proxy/<providerId>/remote/cli-ping`
pub async fn handle_ping(ctx: &RequestCtx, peer: &str, host_port_num: u16) -> Response<Body> {
    let Some(provider_id) = parse_cli_ping_provider_id(&ctx.path) else {
        return express::error(ctx, 404, "not found");
    };
    let headers = match provider_relay::admission(ctx, peer, host_port_num).await {
        Ok(h) => h,
        Err(refusal) => return *refusal,
    };
    let provider_name = match lookup_host_claude_provider(host_port_num, &provider_id).await {
        Ok(Some(name)) => name,
        Ok(None) => {
            let mut resp = express::json(
                ctx,
                404,
                &json!({ "ok": false, "error": "Host 上对应的 Claude 线路已不存在" }),
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
    let claude_bin = host_claude_bin();
    let claude_ok = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        Command::new(&claude_bin)
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
            "cli": "claude",
            "providerId": provider_id,
            "providerName": provider_name,
            "cliAvailable": claude_ok,
        }),
        &[("Cache-Control", "no-store")],
    );
    provider_relay::append_headers(&mut resp, &headers);
    resp
}

/// `WS /claude-proxy/<providerId>/remote/cli-turn`
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
    match lookup_host_claude_provider(host_port_num, &provider_id).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            return express::json(
                &ctx,
                404,
                &json!({ "error": "Host 上对应的 Claude 线路已不存在" }),
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
        serve_claude_relay_session(socket, provider_id, public_port, router_mcp).await;
    });
    response
}

fn send_claude_error_and_exit(tx: &mpsc::UnboundedSender<String>, message: &str) {
    let evt = json!({
        "type": "result",
        "subtype": "error_during_execution",
        "is_error": true,
        "result": message,
        "session_id": "",
    })
    .to_string();
    let _ = tx.send(json!({ "type": "cli_event", "line": evt }).to_string());
    let _ = tx.send(json!({ "type": "exit", "code": 1, "stderr": message }).to_string());
}

/// 在已认证的 WebSocket 上执行一轮受控 Host `claude -p` 回合（单元测试可直接调用）。
pub async fn serve_claude_relay_session<S>(
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
            send_claude_error_and_exit(&ws_tx, "Claude CLI 借道连接未收到有效的启动帧");
            drop(ws_tx);
            let _ = writer_task.await;
            return;
        }
    };

    let start_val: Value = match serde_json::from_str::<Value>(&start_msg) {
        Ok(v) if v.get("type").and_then(Value::as_str) == Some("start") => v,
        _ => {
            send_claude_error_and_exit(&ws_tx, "Claude CLI 借道启动帧格式无效");
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
    let session_id = clean_opt("sessionId");
    let resume = start_val
        .get("resume")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let system_prompt_append = start_val
        .get("systemPromptAppend")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
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
            send_claude_error_and_exit(&ws_tx, &err);
            drop(ws_tx);
            let _ = writer_task.await;
            return;
        }
    };

    let active_router_mcp = router_ctx.as_ref().and_then(|_| router_mcp.as_ref());
    let mcp_config_json = match build_inline_mcp_servers_json(active_router_mcp) {
        Ok(v) => v.to_string(),
        Err(err) => {
            bridge.shutdown().await;
            send_claude_error_and_exit(&ws_tx, &err);
            drop(ws_tx);
            let _ = writer_task.await;
            return;
        }
    };

    // 按 (provider_id, session_id) 分配确定性空目录，确保 Claude `--resume` 跨轮 cwd 哈希一致。
    let (scratch_dir, keep_scratch) = stable_session_scratch_dir(
        "claude",
        &provider_id,
        session_id.as_deref(),
        bridge.token(),
    );
    let _ = std::fs::create_dir_all(&scratch_dir);
    let claude_config_dir = isolated_claude_config_dir(&provider_id);
    let _ = std::fs::create_dir_all(&claude_config_dir);

    let guidance = build_cli_remote_guidance(
        "Claude Code",
        &local_root,
        &scratch_dir.to_string_lossy(),
        &local_os,
        active_router_mcp.is_some(),
    );
    let full_append = if system_prompt_append.trim().is_empty() {
        guidance
    } else {
        format!("{guidance}\n\n{system_prompt_append}")
    };

    let mut args: Vec<String> = vec![
        "-p".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
        "--tools".to_string(),
        String::new(),
        "--strict-mcp-config".to_string(),
        "--mcp-config".to_string(),
        mcp_config_json,
        "--setting-sources".to_string(),
        String::new(),
        "--dangerously-skip-permissions".to_string(),
        "--append-system-prompt".to_string(),
        full_append,
    ];
    if let Some(m) = model.as_deref() {
        args.push("--model".to_string());
        args.push(m.to_string());
    }
    if let Some(e) = effort.as_deref() {
        args.push("--effort".to_string());
        args.push(e.to_string());
    }
    if let Some(sid) = session_id.as_deref() {
        if resume {
            args.push("--resume".to_string());
        } else {
            args.push("--session-id".to_string());
        }
        args.push(sid.to_string());
    }
    args.push(prompt);

    let encoded_provider = encode_uri_component(&provider_id);
    let proxy_base_url =
        format!("http://127.0.0.1:{public_port}/claude-proxy/{encoded_provider}/cli-relay");

    let claude_bin = host_claude_bin();
    let mut cmd = Command::new(&claude_bin);
    cmd.args(&args)
        .current_dir(&scratch_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("CLAUDE_CONFIG_DIR", &claude_config_dir)
        .env("ANTHROPIC_BASE_URL", &proxy_base_url)
        .env("ANTHROPIC_API_KEY", "multicc-cli-relay")
        .env("ANTHROPIC_AUTH_TOKEN", "")
        .env("CLAUDE_CODE_OAUTH_TOKEN", "")
        .env("NO_PROXY", LOOPBACK_NO_PROXY)
        .env("no_proxy", LOOPBACK_NO_PROXY)
        .env_remove("MULTICC_CLAUDE_CLI_RELAY_JSON");
    for key in CLAUDE_ALT_TRANSPORT_KEYS {
        cmd.env(key, "");
    }
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
            send_claude_error_and_exit(
                &ws_tx,
                &format!("Host 启动 Claude CLI 失败（{claude_bin}）: {err}"),
            );
            drop(ws_tx);
            let _ = writer_task.await;
            return;
        }
    };

    let child_stdout = child.stdout.take();
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

    let ws_tx_out = ws_tx.clone();
    let stdout_task = tokio::spawn(async move {
        let mut saw_result = false;
        if let Some(out) = child_stdout {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.contains("\"type\":\"result\"") || line.contains("\"type\": \"result\"") {
                    saw_result = true;
                }
                if ws_tx_out
                    .send(json!({ "type": "cli_event", "line": line }).to_string())
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
    if !keep_scratch {
        let _ = std::fs::remove_dir_all(&scratch_dir);
    }

    if !client_cancelled {
        if exit_code != 0 && !saw_result {
            let msg = if stderr_text.trim().is_empty() {
                format!("Host 借道 Claude CLI 异常退出（exit {exit_code}）")
            } else {
                format!(
                    "Host 借道 Claude CLI 执行异常（exit {exit_code}）：{}",
                    stderr_text.trim()
                )
            };
            send_claude_error_and_exit(&ws_tx, &msg);
        } else {
            let _ = ws_tx.send(
                json!({ "type": "exit", "code": exit_code, "stderr": stderr_text }).to_string(),
            );
        }
    }

    drop(ws_tx);
    let _ = writer_task.await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_cli_relay_paths() {
        assert_eq!(
            parse_cli_turn_provider_id("/claude-proxy/claude-official/remote/cli-turn"),
            Some("claude-official".to_string())
        );
        assert_eq!(
            parse_cli_ping_provider_id("/claude-proxy/acct_1/remote/cli-ping/"),
            Some("acct_1".to_string())
        );
        assert_eq!(
            parse_cli_turn_provider_id("/claude-proxy/claude-official/cli-turn"),
            None
        );
        assert_eq!(
            parse_cli_turn_provider_id("/claude-proxy/claude-official/remote/v1/messages"),
            None
        );
    }
}
