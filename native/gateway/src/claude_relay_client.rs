//! Claude Code CLI 级借道（`multicc-gateway claude-remote-bridge`）的 Client 侧客户端。
//!
//! - 通过单条带 `Authorization: Bearer mcr1.<id>.<secret>` 的 `ws://` / `wss://` 连接
//!   Host 的 `/claude-proxy/<providerId>/remote/cli-turn`；
//! - 本机无需安装 `claude` CLI，无需 SSH / Mutagen；
//! - 复用 `ClientRpcDispatcher` 将 Host 回传的 `host_exec_req` 在本机真实工作区执行，并将
//!   `router_tool_req` 原地注入 Client 真实 `MULTICC_ROUTER_CAPABILITY` 转发给 Client MultiCC；
//! - stdout 逐行输出标准 Claude `stream-json` JSONL，完全兼容现有聊天引擎与前端渲染。

use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use multicc_core::agy_remote::FILE_MODE_REMOTE_MCP;

use crate::cli_relay_client::{
    build_ws_relay_url, dial_relay_ws, is_auth_rejected_http, ClientRpcDispatcher,
    LocalRouterConfig,
};
use crate::host_exec::{generate_token, start_host_exec_server, HostExecServerConfig};

#[derive(Debug, Clone)]
pub struct ClaudeCliRelayTarget {
    pub relay_base_url: String,
    pub relay_auth_token: String,
}

#[derive(Debug, Clone, Default)]
pub struct ClaudeCliRelayTurnOptions {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub session_id: Option<String>,
    pub resume: bool,
    pub system_prompt_append: Option<String>,
    pub prompt: String,
}

fn emit_claude_relay_error(message: &str) {
    let evt = json!({
        "type": "result",
        "subtype": "error_during_execution",
        "is_error": true,
        "result": message,
        "session_id": "",
    });
    println!("{evt}");
}

fn parse_target(raw: &str) -> Result<ClaudeCliRelayTarget, String> {
    let val: Value =
        serde_json::from_str(raw).map_err(|err| format!("Claude CLI 借道配置 JSON 无效: {err}"))?;
    let base = val
        .get("relayBaseUrl")
        .or_else(|| val.get("baseUrl"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Claude CLI 借道配置缺少 relayBaseUrl".to_string())?
        .to_string();
    let token = val
        .get("relayAuthToken")
        .or_else(|| val.get("authToken"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Claude CLI 借道配置缺少 relayAuthToken".to_string())?
        .to_string();
    Ok(ClaudeCliRelayTarget {
        relay_base_url: base,
        relay_auth_token: token,
    })
}

/// 入口：`multicc-gateway claude-remote-bridge --local-cwd <dir> [--session-id <id>] [--resume] [--model <m>] [--effort <e>] [--system-prompt-append <text>] [--target-json <json>] -- <prompt>`
pub async fn serve(args: &[String]) -> i32 {
    let mut local_cwd: Option<String> = None;
    let mut target_json_arg: Option<String> = None;
    let mut opts = ClaudeCliRelayTurnOptions::default();

    let mut idx = 0usize;
    while idx < args.len() {
        match args[idx].as_str() {
            "--local-cwd" => {
                idx += 1;
                if idx < args.len() {
                    local_cwd = Some(args[idx].clone());
                }
            }
            "--target-json" => {
                idx += 1;
                if idx < args.len() {
                    target_json_arg = Some(args[idx].clone());
                }
            }
            "--model" => {
                idx += 1;
                if idx < args.len() {
                    opts.model = Some(args[idx].clone());
                }
            }
            "--effort" => {
                idx += 1;
                if idx < args.len() {
                    opts.effort = Some(args[idx].clone());
                }
            }
            "--session-id" => {
                idx += 1;
                if idx < args.len() {
                    opts.session_id = Some(args[idx].clone());
                }
            }
            "--resume" => {
                opts.resume = true;
            }
            "--system-prompt-append" => {
                idx += 1;
                if idx < args.len() {
                    opts.system_prompt_append = Some(args[idx].clone());
                }
            }
            "--" => {
                opts.prompt = args[idx + 1..].join(" ");
                break;
            }
            other => {
                if !opts.prompt.is_empty() {
                    opts.prompt.push(' ');
                }
                opts.prompt.push_str(other);
            }
        }
        idx += 1;
    }

    let raw = target_json_arg
        .or_else(|| std::env::var("MULTICC_CLAUDE_CLI_RELAY_JSON").ok())
        .unwrap_or_default();
    if raw.trim().is_empty() {
        emit_claude_relay_error("缺少 Claude CLI 借道配置（MULTICC_CLAUDE_CLI_RELAY_JSON）");
        return 1;
    }
    let target = match parse_target(&raw) {
        Ok(t) => t,
        Err(err) => {
            emit_claude_relay_error(&err);
            return 1;
        }
    };
    let local_root = match local_cwd
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
    {
        Some(dir) => dir,
        None => {
            emit_claude_relay_error("无法解析本地工作区目录");
            return 1;
        }
    };
    serve_claude_relay_turn(&target, &local_root, &opts).await
}

pub async fn serve_claude_relay_turn(
    target: &ClaudeCliRelayTarget,
    local_root: &Path,
    opts: &ClaudeCliRelayTurnOptions,
) -> i32 {
    let ws_url = match build_ws_relay_url(&target.relay_base_url, "cli-turn") {
        Ok(u) => u,
        Err(err) => {
            emit_claude_relay_error(&err);
            return 1;
        }
    };
    let local_token = match generate_token() {
        Ok(t) => t,
        Err(err) => {
            emit_claude_relay_error(&err);
            return 1;
        }
    };
    let local_root_str = local_root.to_string_lossy().into_owned();
    let (local_addr, server_handle) = match start_host_exec_server(HostExecServerConfig {
        local_root: local_root.to_path_buf(),
        remote_root: local_root_str.clone(),
        file_mode: FILE_MODE_REMOTE_MCP.to_string(),
        token: local_token.clone(),
        before_exec: None,
        after_exec: None,
    })
    .await
    {
        Ok(pair) => pair,
        Err(err) => {
            emit_claude_relay_error(&err);
            return 1;
        }
    };

    let ws = match dial_relay_ws(&ws_url, &target.relay_auth_token, "Claude").await {
        Ok(s) => s,
        Err(err) => {
            server_handle.abort();
            emit_claude_relay_error(&err);
            return 1;
        }
    };

    let (mut ws_sink, mut ws_stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer_task = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if ws_sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
        let _ = ws_sink.send(Message::Close(None)).await;
    });

    let router_cfg = LocalRouterConfig::from_env();
    let mut start_obj = json!({
        "type": "start",
        "model": opts.model,
        "effort": opts.effort,
        "sessionId": opts.session_id,
        "resume": opts.resume,
        "systemPromptAppend": opts.system_prompt_append,
        "prompt": opts.prompt,
        "localRoot": local_root_str,
        "localOs": std::env::consts::OS,
    });
    if let Some(rc) = router_cfg.as_ref() {
        if let Some(map) = start_obj.as_object_mut() {
            map.insert("routerContext".to_string(), rc.to_start_frame_json());
        }
    }
    if tx.send(start_obj.to_string()).is_err() {
        server_handle.abort();
        emit_claude_relay_error("发送 Claude CLI 借道启动帧失败");
        return 1;
    }

    let dispatcher = ClientRpcDispatcher::new(local_addr.port(), local_token, router_cfg);
    let mut exit_code: Option<i32> = None;
    let mut saw_result = false;

    while let Some(msg_res) = ws_stream.next().await {
        let Ok(msg) = msg_res else { break };
        match msg {
            Message::Text(text) => {
                let Ok(val) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                if dispatcher.handle_frame(&val, &tx).await {
                    continue;
                }
                match val.get("type").and_then(Value::as_str) {
                    Some("cli_event") => {
                        if let Some(line) = val.get("line").and_then(Value::as_str) {
                            if line.contains("\"type\":\"result\"")
                                || line.contains("\"type\": \"result\"")
                            {
                                saw_result = true;
                            }
                            println!("{line}");
                        }
                    }
                    Some("exit") => {
                        exit_code = Some(
                            val.get("code")
                                .and_then(Value::as_i64)
                                .and_then(|n| i32::try_from(n).ok())
                                .unwrap_or(0),
                        );
                        break;
                    }
                    _ => {}
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    dispatcher.abort_all().await;
    drop(tx);
    let _ = writer_task.await;
    server_handle.abort();

    match exit_code {
        Some(code) => code,
        None => {
            if !saw_result {
                emit_claude_relay_error("与远端 Claude CLI 借道服务的连接意外中断");
            }
            1
        }
    }
}

/// 探测远端 Host 是否支持 Claude CLI 借道（`GET <relayBaseUrl>/cli-ping`）。
pub async fn probe_claude_cli_relay(target: &ClaudeCliRelayTarget) -> Value {
    let ping_url = format!("{}/cli-ping", target.relay_base_url.trim_end_matches('/'));
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(c) => c,
        Err(err) => return json!({ "ok": false, "error": format!("创建 HTTP 客户端失败: {err}") }),
    };
    match client
        .get(&ping_url)
        .header(
            "Authorization",
            format!("Bearer {}", target.relay_auth_token),
        )
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let loc = resp
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            let bytes = resp.bytes().await.unwrap_or_default();
            let body = serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| json!({}));
            if status == 200 && body.get("ok") == Some(&Value::Bool(true)) {
                body
            } else if is_auth_rejected_http(status, loc.as_deref()) {
                json!({ "ok": false, "error": "分享码已被撤销或无效，请向出借方重新获取" })
            } else {
                let err = body
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("远端 Host 暂不支持 Claude CLI 借道");
                json!({ "ok": false, "error": err })
            }
        }
        Err(err) => json!({ "ok": false, "error": format!("无法连接远端借道服务: {err}") }),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn claude_cli_relay_enforces_zero_builtin_tools_stable_cwd_host_exec_and_router_bridge() {
        use axum::extract::Path as AxumPath;
        use axum::http::{HeaderMap, StatusCode};
        use axum::response::IntoResponse;
        use axum::routing::post;
        use axum::{Json, Router};

        let _guard = crate::egress_runtime::TEST_ENV_LOCK.lock().await;
        let root = std::env::temp_dir().join(format!(
            "multicc-claude-cli-relay-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let client_ws = root.join("client-ws");
        let bin_dir = root.join("bin");
        let cwd_log = root.join("cwds.log");
        std::fs::create_dir_all(&client_ws).unwrap();
        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::write(client_ws.join("note.txt"), "claude-from-client-disk").unwrap();
        let fake_router_script = bin_dir.join("multicc-router-mcp.js");
        std::fs::write(&fake_router_script, "// mock router mcp\n").unwrap();

        let client_secret_cap = "claude_client_cap_secret_xyz";
        let expected_cap = client_secret_cap.to_string();
        let mock_router_app = Router::new().route(
            "/api/internal/router-tools/{tool}",
            post(
                move |AxumPath(tool): AxumPath<String>,
                      headers: HeaderMap,
                      Json(body): Json<Value>| {
                    let expected = expected_cap.clone();
                    async move {
                        let actual = headers
                            .get("x-multicc-router-capability")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("");
                        if actual != expected {
                            return (StatusCode::UNAUTHORIZED, Json(json!({ "ok": false })))
                                .into_response();
                        }
                        (
                            StatusCode::OK,
                            Json(json!({ "ok": true, "result": { "tool": tool, "args": body["arguments"] } })),
                        )
                            .into_response()
                    }
                },
            ),
        );
        let router_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let router_port = router_listener.local_addr().unwrap().port();
        let router_srv = tokio::spawn(async move {
            let _ = axum::serve(router_listener, mock_router_app).await;
        });

        let fake_claude = bin_dir.join("fake-claude");
        std::fs::write(
            &fake_claude,
            format!(
                r#"#!/bin/sh
set -e
pwd >> "{cwd_log}"
if [ "$ANTHROPIC_BASE_URL" != "http://127.0.0.1:43210/claude-proxy/claude-official/cli-relay" ]; then
  echo "bad ANTHROPIC_BASE_URL: $ANTHROPIC_BASE_URL" >&2
  exit 51
fi
if [ "$MULTICC_ROUTER_CAPABILITY" = "{client_secret_cap}" ]; then
  echo "LEAKED client capability!" >&2
  exit 52
fi
SAW_TOOLS_EMPTY=0
SAW_STRICT_MCP=0
SAW_SETTING_EMPTY=0
PREV=""
for arg in "$@"; do
  if [ "$PREV" = "--tools" ] && [ -z "$arg" ]; then SAW_TOOLS_EMPTY=1; fi
  if [ "$PREV" = "--setting-sources" ] && [ -z "$arg" ]; then SAW_SETTING_EMPTY=1; fi
  if [ "$arg" = "--strict-mcp-config" ]; then SAW_STRICT_MCP=1; fi
  PREV="$arg"
done
if [ "$SAW_TOOLS_EMPTY" != "1" ] || [ "$SAW_STRICT_MCP" != "1" ] || [ "$SAW_SETTING_EMPTY" != "1" ]; then
  echo "missing safety flags: tools=$SAW_TOOLS_EMPTY strict=$SAW_STRICT_MCP settings=$SAW_SETTING_EMPTY" >&2
  exit 53
fi
RES="$(curl -sS -X POST -H "Authorization: Bearer $MULTICC_HOST_EXEC_TOKEN" -H "Content-Type: application/json" -d '{{"path":"note.txt"}}' "$MULTICC_HOST_EXEC_URL/fs/read")"
case "$RES" in
  *claude-from-client-disk*) ;;
  *) echo "unexpected fs/read: $RES" >&2; exit 54 ;;
esac
RT="$(curl -sS -X POST -H "x-multicc-router-capability: $MULTICC_ROUTER_CAPABILITY" -H "Content-Type: application/json" -d '{{"arguments":{{"k":"v"}}}}' "$MULTICC_BASE_URL/api/internal/router-tools/wait_for_user_answer")"
case "$RT" in
  *wait_for_user_answer*) ;;
  *) echo "unexpected router tool: $RT" >&2; exit 55 ;;
esac
echo '{{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"sess-uuid-1"}}'
exit 0
"#,
                cwd_log = cwd_log.display(),
            ),
        )
        .unwrap();
        std::fs::set_permissions(&fake_claude, std::fs::Permissions::from_mode(0o755)).unwrap();

        std::env::set_var("MULTICC_CLAUDE_BIN", &fake_claude);
        std::env::set_var(
            "MULTICC_BASE_URL",
            format!("http://127.0.0.1:{router_port}"),
        );
        std::env::set_var("MULTICC_ROUTER_CAPABILITY", client_secret_cap);
        std::env::set_var("MULTICC_SESSION_ID", "s-claude-1");

        // Run 2 turns (turn 1: --session-id, turn 2: --resume) and verify IDENTICAL stable scratch cwd!
        for resume in [false, true] {
            let ws_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let ws_port = ws_listener.local_addr().unwrap().port();
            let spec = crate::cli_relay_bridge::RouterMcpSpec {
                node_bin: "/usr/bin/node".to_string(),
                script_path: fake_router_script.clone(),
            };
            let srv = tokio::spawn(async move {
                let (tcp, _) = ws_listener.accept().await.unwrap();
                let ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
                crate::ws_claude_relay::serve_claude_relay_session(
                    ws,
                    "claude-official".to_string(),
                    43210,
                    Some(spec),
                )
                .await;
            });

            let target = ClaudeCliRelayTarget {
                relay_base_url: format!(
                    "http://127.0.0.1:{ws_port}/claude-proxy/claude-official/remote"
                ),
                relay_auth_token: "mcr1.0123456789abcdef.claudesecret".to_string(),
            };
            let code = serve_claude_relay_turn(
                &target,
                &client_ws,
                &ClaudeCliRelayTurnOptions {
                    model: Some("claude-sonnet-4-6".into()),
                    effort: Some("high".into()),
                    session_id: Some("sess-uuid-1".into()),
                    resume,
                    system_prompt_append: None,
                    prompt: "check note.txt".into(),
                },
            )
            .await;
            let _ = srv.await;
            assert_eq!(code, 0);
        }

        let cwds: Vec<String> = std::fs::read_to_string(&cwd_log)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        assert_eq!(cwds.len(), 2);
        assert_eq!(
            cwds[0], cwds[1],
            "Claude --resume requires deterministic stable cwd"
        );

        router_srv.abort();
        std::env::remove_var("MULTICC_CLAUDE_BIN");
        std::env::remove_var("MULTICC_BASE_URL");
        std::env::remove_var("MULTICC_ROUTER_CAPABILITY");
        std::env::remove_var("MULTICC_SESSION_ID");
        let _ = std::fs::remove_dir_all(&root);
    }
}
