//! 反重力（`agy`）借道分享码的 Client 侧桥接：
//!
//! - 通过单条带 `Authorization: Bearer mcr1.<id>.<secret>` 的 `ws://` 或 `wss://` 连接
//!   Host 的 `/agy-proxy/<accountId>/turn`；
//! - 无需 SSH、无需 Mutagen、无需本机安装 `agy`，也无需配置 Client 侧代理；
//! - 本地复用 `host_exec::start_host_exec_server`（含路径越狱防护与符号链接防逃逸），
//!   将 Host `agy` 发回的 `host_exec_req` 在本机真实工作区执行并返回 `host_exec_res`；
//! - 同时提供 `probe_relay_target`（`GET <relayBaseUrl>/ping`）供「测试连通」使用。

use std::path::Path;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::{
    tungstenite::{
        client::IntoClientRequest,
        http::header::{HeaderValue, AUTHORIZATION},
        protocol::WebSocketConfig,
        Error as WsError, Message,
    },
    WebSocketStream,
};

use multicc_core::agy_remote::{RemoteAgyTarget, FILE_MODE_REMOTE_MCP};

use crate::host_exec::{generate_token, start_host_exec_server, HostExecServerConfig};
use crate::ws_machines::Io;

const MAX_WS_PAYLOAD: usize = 32 * 1024 * 1024;
const DIAL_TIMEOUT: Duration = Duration::from_secs(15);

fn emit_relay_error(message: &str) {
    let evt = json!({
        "event": "result",
        "result": {
            "conversation_id": "",
            "status": "ERROR",
            "error": message,
            "finished_reason": "relay_bridge_error",
        }
    });
    println!("{evt}");
}

fn build_ws_turn_url(relay_base_url: &str) -> Result<url::Url, String> {
    let mut parsed = url::Url::parse(relay_base_url).map_err(|_| "借道地址格式无效".to_string())?;
    let ws_scheme = match parsed.scheme() {
        "https" => "wss",
        "http" => "ws",
        other => return Err(format!("不支持的借道协议: {other}")),
    };
    parsed
        .set_scheme(ws_scheme)
        .map_err(|_| "无法转换为 WebSocket 协议".to_string())?;
    let base_path = parsed.path().trim_end_matches('/').to_string();
    parsed.set_path(&format!("{base_path}/turn"));
    Ok(parsed)
}

async fn dial_relay_ws(
    url: &url::Url,
    token: &str,
) -> Result<WebSocketStream<Box<dyn Io>>, String> {
    let tls = url.scheme() == "wss";
    let host = url
        .host_str()
        .ok_or_else(|| "借道地址缺少主机名".to_string())?
        .to_string();
    let port = url
        .port_or_known_default()
        .unwrap_or(if tls { 443 } else { 80 });

    let tcp = tokio::time::timeout(DIAL_TIMEOUT, TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| format!("连接远端借道服务超时（{host}:{port}）"))?
        .map_err(|err| format!("无法连接到远端借道服务（{host}:{port}）: {err}"))?;
    let _ = tcp.set_nodelay(true);

    let io: Box<dyn Io> = if tls {
        let tls_stream = tokio::time::timeout(DIAL_TIMEOUT, crate::ws_tls::connect(tcp, &host))
            .await
            .map_err(|_| format!("TLS 握手超时（{host}）"))?
            .map_err(|reason| format!("TLS 握手失败（{host}）: {reason}"))?;
        Box::new(tls_stream)
    } else {
        Box::new(tcp)
    };

    let mut req = url
        .as_str()
        .into_client_request()
        .map_err(|err| format!("构造 WebSocket 握手请求失败: {err}"))?;
    let auth_val = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| "借道凭据包含非法字符".to_string())?;
    req.headers_mut().insert(AUTHORIZATION, auth_val);

    let cfg = WebSocketConfig::default()
        .max_frame_size(Some(MAX_WS_PAYLOAD))
        .max_message_size(Some(MAX_WS_PAYLOAD));

    match tokio::time::timeout(
        DIAL_TIMEOUT,
        tokio_tungstenite::client_async_with_config(req, io, Some(cfg)),
    )
    .await
    {
        Ok(Ok((ws, _resp))) => Ok(ws),
        Ok(Err(WsError::Http(resp))) => {
            let code = resp.status().as_u16();
            if code == 401 || code == 403 {
                Err("反重力借道分享码已被撤销或无效，请向出借方重新获取".to_string())
            } else if code == 404 {
                Err(
                    "远端 Host 上对应的反重力账号已不存在，或 Host 尚未升级支持反重力借道"
                        .to_string(),
                )
            } else {
                Err(format!("远端借道服务拒绝握手（HTTP {code}）"))
            }
        }
        Ok(Err(err)) => Err(format!("WebSocket 握手失败: {err}")),
        Err(_) => Err("WebSocket 握手超时".to_string()),
    }
}

/// 在 Client 侧通过 WebSocket 借道执行一次完整 `agy` 回合。
pub async fn serve_relay_turn(
    target: &RemoteAgyTarget,
    local_root: &Path,
    agy_args: &[String],
    prompt: &str,
) -> i32 {
    let Some(base_url) = target.relay_base_url.as_deref() else {
        emit_relay_error("反重力借道账号缺少 relayBaseUrl");
        return 1;
    };
    let Some(token) = target.relay_auth_token.as_deref() else {
        emit_relay_error("反重力借道账号缺少安全凭据");
        return 1;
    };
    let ws_url = match build_ws_turn_url(base_url) {
        Ok(u) => u,
        Err(err) => {
            emit_relay_error(&err);
            return 1;
        }
    };

    let local_token = match generate_token() {
        Ok(t) => t,
        Err(err) => {
            emit_relay_error(&err);
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
            emit_relay_error(&err);
            return 1;
        }
    };

    let ws = match dial_relay_ws(&ws_url, token).await {
        Ok(s) => s,
        Err(err) => {
            server_handle.abort();
            emit_relay_error(&err);
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

    let start_frame = json!({
        "type": "start",
        "agyArgs": agy_args,
        "prompt": prompt,
        "localRoot": local_root_str,
        "localOs": std::env::consts::OS,
    })
    .to_string();
    if tx.send(start_frame).is_err() {
        server_handle.abort();
        emit_relay_error("发送借道启动帧失败");
        return 1;
    }

    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10 * 60))
        .build()
        .expect("reqwest loopback client");

    let mut exit_code: Option<i32> = None;
    let mut saw_result = false;

    while let Some(msg_res) = ws_stream.next().await {
        let Ok(msg) = msg_res else { break };
        match msg {
            Message::Text(text) => {
                let Ok(val) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                match val.get("type").and_then(Value::as_str) {
                    Some("agy_event") => {
                        if let Some(line) = val.get("line").and_then(Value::as_str) {
                            if line.contains("\"event\":\"result\"")
                                || line.contains("\"event\": \"result\"")
                            {
                                saw_result = true;
                            }
                            println!("{line}");
                        }
                    }
                    Some("host_exec_req") => {
                        let req_id = val
                            .get("reqId")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let path = val
                            .get("path")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let body = val.get("body").cloned().unwrap_or_else(|| json!({}));
                        let tx_reply = tx.clone();
                        let http_c = http.clone();
                        let tok = local_token.clone();
                        let port = local_addr.port();
                        tokio::spawn(async move {
                            let allowed = matches!(
                                path.as_str(),
                                "/exec" | "/fs/read" | "/fs/write" | "/fs/list"
                            );
                            if !allowed {
                                let _ = tx_reply.send(
                                    json!({
                                        "type": "host_exec_res",
                                        "reqId": req_id,
                                        "status": 403,
                                        "body": { "ok": false, "error": "不允许的远程执行动作" }
                                    })
                                    .to_string(),
                                );
                                return;
                            }
                            let url = format!("http://127.0.0.1:{port}{path}");
                            let payload_bytes = serde_json::to_vec(&body).unwrap_or_default();
                            let resp = http_c
                                .post(&url)
                                .header("Authorization", format!("Bearer {tok}"))
                                .header("Content-Type", "application/json")
                                .body(payload_bytes)
                                .send()
                                .await;
                            let (status, res_body) = match resp {
                                Ok(r) => {
                                    let code = r.status().as_u16();
                                    let bytes = r.bytes().await.unwrap_or_default();
                                    let parsed = serde_json::from_slice::<Value>(&bytes)
                                        .unwrap_or_else(|_| json!({ "ok": false, "error": "invalid local host_exec json" }));
                                    (code, parsed)
                                }
                                Err(err) => (
                                    500,
                                    json!({ "ok": false, "error": format!("本机执行桥调用失败: {err}") }),
                                ),
                            };
                            let _ = tx_reply.send(
                                json!({
                                    "type": "host_exec_res",
                                    "reqId": req_id,
                                    "status": status,
                                    "body": res_body,
                                })
                                .to_string(),
                            );
                        });
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

    drop(tx);
    let _ = writer_task.await;
    server_handle.abort();

    match exit_code {
        Some(code) => code,
        None => {
            if !saw_result {
                emit_relay_error("与远端反重力借道服务的连接意外中断");
            }
            1
        }
    }
}

/// 探测借道分享码连通性（`GET <relayBaseUrl>/ping`）。
pub async fn probe_relay_target(target: &RemoteAgyTarget) -> Value {
    let Some(base_url) = target.relay_base_url.as_deref() else {
        return json!({ "ok": false, "error": "缺少借道地址 relayBaseUrl" });
    };
    let Some(token) = target.relay_auth_token.as_deref() else {
        return json!({ "ok": false, "error": "缺少借道安全凭据" });
    };
    let ping_url = format!("{}/ping", base_url.trim_end_matches('/'));
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(err) => return json!({ "ok": false, "error": format!("创建 HTTP 客户端失败: {err}") }),
    };
    match client
        .get(&ping_url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let bytes = resp.bytes().await.unwrap_or_default();
            let body = serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| json!({}));
            if status == 200 && body.get("ok") == Some(&Value::Bool(true)) {
                let label = body
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or("Host 账号");
                let egress = body.get("egressProfile").and_then(Value::as_str);
                let detail = match egress {
                    Some(p) if !p.is_empty() => {
                        format!("借道连通正常 · Host「{label}」· 出口 🌐 {p}")
                    }
                    _ => format!("借道连通正常 · Host「{label}」· 出口由 Host 管理"),
                };
                json!({
                    "ok": true,
                    "transport": "relay",
                    "detail": detail,
                    "hostAccount": label,
                    "egressProfile": egress,
                })
            } else if status == 401 || status == 403 {
                json!({ "ok": false, "error": "分享码已被撤销或无效，请向出借方重新获取" })
            } else {
                let err_msg = body
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("远端借道服务返回 HTTP {status}"));
                json!({ "ok": false, "error": err_msg })
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
    async fn agy_relay_ws_end_to_end_forwards_host_egress_and_client_host_exec() {
        let _guard = crate::egress_runtime::TEST_ENV_LOCK.lock().await;
        let root = std::env::temp_dir().join(format!(
            "multicc-agy-relay-ws-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let host_home = root.join("host-home");
        let client_ws = root.join("client-workspace");
        let bin_dir = root.join("bin");
        std::fs::create_dir_all(&host_home).unwrap();
        std::fs::create_dir_all(&client_ws).unwrap();
        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::write(client_ws.join("hello.txt"), "from-client-disk").unwrap();

        // Host creates a local agy account with bound chrome-proxy-launcher egress.
        let created = multicc_core::agy_accounts::create_account_with_egress(
            &host_home,
            "Host共享号",
            "created",
            Some(&json!({ "pluginId": "chrome-proxy-launcher", "profileId": "jp-1" })),
        )
        .unwrap();
        let account_id = created["id"].as_str().unwrap().to_string();

        // Fake Host agy binary: verifies Host HTTPS_PROXY + calls Host loopback /read-file -> routed over WS to Client!
        let fake_agy = bin_dir.join("fake-agy");
        std::fs::write(
            &fake_agy,
            r#"#!/bin/sh
if [ "$HTTPS_PROXY" != "http://127.0.0.1:29555" ]; then
  echo "missing Host HTTPS_PROXY: $HTTPS_PROXY" >&2
  exit 31
fi
RES="$(curl -sS -X POST -H "Authorization: Bearer $MULTICC_HOST_EXEC_TOKEN" -H "Content-Type: application/json" -d '{"path":"hello.txt"}' "$MULTICC_HOST_EXEC_URL/fs/read")"
case "$RES" in
  *from-client-disk*) ;;
  *) echo "unexpected fs/read response: $RES" >&2; exit 32 ;;
esac
echo "{\"event\":\"result\",\"result\":{\"conversation_id\":\"conv-relay\",\"status\":\"SUCCESS\",\"content\":$RES}}"
exit 0
"#,
        )
        .unwrap();
        std::fs::set_permissions(&fake_agy, std::fs::Permissions::from_mode(0o755)).unwrap();

        std::env::set_var("MULTICC_AGY_BIN", &fake_agy);
        std::env::set_var("MULTICC_EGRESS_PROXY_OVERRIDE", "http://127.0.0.1:29555");

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let host_home_srv = host_home.clone();
        let acct_srv = account_id.clone();
        let server_task = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            crate::ws_agy_relay::serve_relay_session(ws, host_home_srv, acct_srv).await;
        });

        let target = multicc_core::agy_remote::parse_remote_target(&json!({
            "transport": "relay",
            "relayBaseUrl": format!("http://127.0.0.1:{port}/agy-proxy/{account_id}"),
            "relayAuthToken": "mcr1.0123456789abcdef.testsecret123456",
        }))
        .unwrap();

        let code = serve_relay_turn(
            &target,
            &client_ws,
            &["--output-format".into(), "stream-json".into(), "-p".into()],
            "read hello.txt",
        )
        .await;
        let _ = server_task.await;
        assert_eq!(code, 0);

        std::env::remove_var("MULTICC_AGY_BIN");
        std::env::remove_var("MULTICC_EGRESS_PROXY_OVERRIDE");
        let _ = std::fs::remove_dir_all(&root);
    }
}
