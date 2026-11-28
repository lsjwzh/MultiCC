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
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use multicc_core::agy_remote::{RemoteAgyTarget, FILE_MODE_REMOTE_MCP};

use crate::cli_relay_client::{
    build_ws_relay_url, dial_relay_ws, is_auth_rejected_http, ClientRpcDispatcher,
    LocalRouterConfig,
};
use crate::host_exec::{generate_token, start_host_exec_server, HostExecServerConfig};

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
    let ws_url = match build_ws_relay_url(base_url, "turn") {
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

    let ws = match dial_relay_ws(&ws_url, token, "反重力").await {
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

    let router_cfg = LocalRouterConfig::from_env();
    let attachments =
        crate::cli_relay_attachments::collect_prompt_image_attachments(prompt, local_root);
    let skills = crate::cli_relay_skills::collect_client_skills(local_root);
    let mcp_specs = crate::cli_relay_mcp_tunnel::discover_client_mcp_servers(local_root);
    let mcp_manager = (!mcp_specs.is_empty()).then(|| {
        std::sync::Arc::new(crate::cli_relay_mcp_tunnel::ClientMcpManager::new(
            mcp_specs,
            local_root.to_path_buf(),
        ))
    });
    let mut start_obj = json!({
        "type": "start",
        "agyArgs": agy_args,
        "prompt": prompt,
        "localRoot": local_root_str,
        "localOs": std::env::consts::OS,
    });
    if !attachments.is_empty() {
        if let Some(map) = start_obj.as_object_mut() {
            map.insert("attachments".to_string(), json!(attachments));
        }
    }
    if !skills.is_empty() {
        if let Some(map) = start_obj.as_object_mut() {
            map.insert("skills".to_string(), json!(skills));
        }
    }
    if let Some(mgr) = mcp_manager.as_ref() {
        if let Some(map) = start_obj.as_object_mut() {
            map.insert("mcpServers".to_string(), json!(mgr.server_names()));
        }
    }
    if let Some(rc) = router_cfg.as_ref() {
        if let Some(map) = start_obj.as_object_mut() {
            map.insert("routerContext".to_string(), rc.to_start_frame_json());
        }
    }
    if tx.send(start_obj.to_string()).is_err() {
        server_handle.abort();
        emit_relay_error("发送借道启动帧失败");
        return 1;
    }

    let dispatcher =
        ClientRpcDispatcher::with_mcp(local_addr.port(), local_token, router_cfg, mcp_manager);
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
                emit_relay_error("与远端反重力借道服务的连接意外中断");
            }
            1
        }
    }
}

/// 借道用量查询（`GET <relayBaseUrl>/quota`）的分类错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayQuotaError {
    Revoked,
    NotFound,
    Unavailable(String),
}

/// 通过借道分享码向 Host 透传查询反重力账号额度（`GET <relayBaseUrl>/quota[?force=1]`）。
///
/// 禁用 HTTP 重定向跟随（防 `Authorization` 外泄），并把 `401/403` 与跳向 `/login`
/// 的 `3xx` 统一判定为分享码已撤销或无效。
pub async fn fetch_relay_quota(
    target: &RemoteAgyTarget,
    force: bool,
) -> Result<Value, RelayQuotaError> {
    let base_url = target
        .relay_base_url
        .as_deref()
        .ok_or_else(|| RelayQuotaError::Unavailable("缺少借道地址 relayBaseUrl".to_string()))?;
    let token = target
        .relay_auth_token
        .as_deref()
        .ok_or_else(|| RelayQuotaError::Unavailable("缺少借道安全凭据".to_string()))?;
    let mut quota_url = format!("{}/quota", base_url.trim_end_matches('/'));
    if force {
        quota_url.push_str("?force=1");
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(35))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|err| RelayQuotaError::Unavailable(format!("创建 HTTP 客户端失败: {err}")))?;

    let resp = client
        .get(&quota_url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|err| RelayQuotaError::Unavailable(format!("无法连接远端借道服务: {err}")))?;

    let status = resp.status().as_u16();
    let location = resp
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let bytes = resp.bytes().await.unwrap_or_default();
    let mut body = serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| json!({}));

    if is_auth_rejected_http(status, location.as_deref()) {
        return Err(RelayQuotaError::Revoked);
    }
    if status == 404 {
        return Err(RelayQuotaError::NotFound);
    }
    if status != 200 {
        let err_msg = body
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("远端借道服务返回 HTTP {status}"));
        return Err(RelayQuotaError::Unavailable(err_msg));
    }

    if body.get("status").and_then(Value::as_str) == Some("ok")
        && body.get("bar").is_some_and(Value::is_object)
    {
        if let Some(obj) = body.as_object_mut() {
            obj.insert("transport".to_string(), json!("relay"));
        }
        return Ok(body);
    }

    let detail = body
        .get("error")
        .and_then(Value::as_str)
        .or_else(|| body.pointer("/bar/title").and_then(Value::as_str))
        .unwrap_or("远端 Host 暂无法读取反重力账号额度")
        .to_string();
    Err(RelayQuotaError::Unavailable(detail))
}

/// 借道模型目录查询（`GET <relayBaseUrl>/models`）的分类错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayCatalogError {
    Revoked,
    NotFound,
    Unavailable(String),
}

fn sanitize_relay_models(raw: Option<&Value>) -> Vec<Value> {
    let Some(items) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        let Some(id) = item
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty() && s.len() <= 100 && !s.chars().any(char::is_control))
        else {
            continue;
        };
        let label = item
            .get("label")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty() && s.len() <= 160 && !s.chars().any(char::is_control))
            .unwrap_or(id);
        if !out
            .iter()
            .any(|existing: &Value| existing.get("model").and_then(Value::as_str) == Some(id))
        {
            out.push(json!({ "model": id, "label": label }));
            if out.len() >= 100 {
                break;
            }
        }
    }
    out
}

/// The lender's "model in effect" marker, passed through for display only.
fn sanitize_relay_current(raw: Option<&Value>) -> Option<Value> {
    let item = raw?.as_object()?;
    let id = item
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 100 && !s.chars().any(char::is_control))?;
    let label = item
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 160 && !s.chars().any(char::is_control))
        .unwrap_or(id);
    Some(json!({ "model": id, "label": label }))
}

/// 通过借道分享码向 Host 透传查询反重力模型目录（`GET <relayBaseUrl>/models[?refresh=1]`）。
///
/// 禁用 HTTP 重定向跟随（防 `Authorization` 外泄），把 `401/403` 与跳向 `/login`
/// 的 `3xx` 统一判定为分享码已撤销或无效，并对模型项做白名单清洗。
pub async fn fetch_relay_models(
    target: &RemoteAgyTarget,
    refresh: bool,
) -> Result<
    (
        Vec<Value>,
        Option<Value>,
        Option<multicc_core::agy_models::Models>,
    ),
    RelayCatalogError,
> {
    let base_url = target
        .relay_base_url
        .as_deref()
        .ok_or_else(|| RelayCatalogError::Unavailable("缺少借道地址 relayBaseUrl".to_string()))?;
    let token = target
        .relay_auth_token
        .as_deref()
        .ok_or_else(|| RelayCatalogError::Unavailable("缺少借道安全凭据".to_string()))?;
    let mut models_url = format!("{}/models", base_url.trim_end_matches('/'));
    if refresh {
        models_url.push_str("?refresh=1");
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|err| RelayCatalogError::Unavailable(format!("创建 HTTP 客户端失败: {err}")))?;

    let resp = client
        .get(&models_url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|err| RelayCatalogError::Unavailable(format!("无法连接远端借道服务: {err}")))?;

    let status = resp.status().as_u16();
    let location = resp
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let bytes = resp.bytes().await.unwrap_or_default();
    let body = serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| json!({}));

    if is_auth_rejected_http(status, location.as_deref()) {
        return Err(RelayCatalogError::Revoked);
    }
    if status == 404 {
        return Err(RelayCatalogError::NotFound);
    }
    if status != 200 {
        let err_msg = body
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("远端借道服务返回 HTTP {status}"));
        return Err(RelayCatalogError::Unavailable(err_msg));
    }

    let models = sanitize_relay_models(body.get("models"));
    if models.is_empty() {
        let detail = body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("远端 Host 未返回可用的反重力模型列表")
            .to_string();
        return Err(RelayCatalogError::Unavailable(detail));
    }
    Ok((
        models,
        sanitize_relay_current(body.get("current")),
        multicc_core::agy_models::concrete_models(&body["availableModels"], "model", "label"),
    ))
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
        .redirect(reqwest::redirect::Policy::none())
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
            let location = resp
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
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
            } else if is_auth_rejected_http(status, location.as_deref()) {
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

    #[tokio::test]
    async fn probe_relay_treats_login_redirect_as_revoked_without_following() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let srv = tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf).await;
                let resp = "HTTP/1.1 302 Found\r\nLocation: /login?redirect=%2Fagy-proxy%2F0123456789abcdef%2Fping\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });
        let target = multicc_core::agy_remote::parse_remote_target(&json!({
            "transport": "relay",
            "relayBaseUrl": format!("http://127.0.0.1:{port}/agy-proxy/0123456789abcdef"),
            "relayAuthToken": "mcr1.0123456789abcdef.revokedsecret99",
        }))
        .unwrap();
        let probed = probe_relay_target(&target).await;
        let _ = srv.await;
        assert_eq!(probed["ok"], false);
        assert!(probed["error"]
            .as_str()
            .unwrap()
            .contains("分享码已被撤销或无效"));
    }

    #[tokio::test]
    async fn fetch_relay_quota_forwards_force_and_maps_revoked_and_not_found() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // 1) 200 OK with force=1 passthrough & Authorization header check
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let srv = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 2048];
            let n = sock.read(&mut buf).await.unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            assert!(req.starts_with("GET /agy-proxy/0123456789abcdef/quota?force=1 "));
            assert!(
                req.contains("authorization: Bearer mcr1.0123456789abcdef.secret9999")
                    || req.contains("Authorization: Bearer mcr1.0123456789abcdef.secret9999")
            );
            let body = json!({
                "status": "ok",
                "fetchedAt": 1_795_425_813_000u64,
                "bar": {
                    "text": "反重力 · Gemini: 5h 94% ⟳",
                    "title": "反重力账号额度（agy /usage）",
                    "color": "#58a6ff",
                }
            })
            .to_string();
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            sock.write_all(resp.as_bytes()).await.unwrap();
        });
        let target = multicc_core::agy_remote::parse_remote_target(&json!({
            "transport": "relay",
            "relayBaseUrl": format!("http://127.0.0.1:{port}/agy-proxy/0123456789abcdef"),
            "relayAuthToken": "mcr1.0123456789abcdef.secret9999",
        }))
        .unwrap();
        let ok = fetch_relay_quota(&target, true).await.unwrap();
        let _ = srv.await;
        assert_eq!(ok["status"], "ok");
        assert_eq!(ok["transport"], "relay");
        assert_eq!(ok["bar"]["text"], "反重力 · Gemini: 5h 94% ⟳");

        // 2) 302 /login -> Revoked without following redirect
        let listener2 = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port2 = listener2.local_addr().unwrap().port();
        let srv2 = tokio::spawn(async move {
            let (mut sock, _) = listener2.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let resp = "HTTP/1.1 302 Found\r\nLocation: /login?redirect=%2Fagy-proxy%2F0123456789abcdef%2Fquota\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = sock.write_all(resp.as_bytes()).await;
        });
        let target2 = multicc_core::agy_remote::parse_remote_target(&json!({
            "transport": "relay",
            "relayBaseUrl": format!("http://127.0.0.1:{port2}/agy-proxy/0123456789abcdef"),
            "relayAuthToken": "mcr1.0123456789abcdef.revokedsecret",
        }))
        .unwrap();
        assert_eq!(
            fetch_relay_quota(&target2, false).await,
            Err(RelayQuotaError::Revoked)
        );
        let _ = srv2.await;

        // 3) 404 -> NotFound
        let listener3 = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port3 = listener3.local_addr().unwrap().port();
        let srv3 = tokio::spawn(async move {
            let (mut sock, _) = listener3.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let resp = "HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
            let _ = sock.write_all(resp.as_bytes()).await;
        });
        let target3 = multicc_core::agy_remote::parse_remote_target(&json!({
            "transport": "relay",
            "relayBaseUrl": format!("http://127.0.0.1:{port3}/agy-proxy/0123456789abcdef"),
            "relayAuthToken": "mcr1.0123456789abcdef.validtoken99",
        }))
        .unwrap();
        assert_eq!(
            fetch_relay_quota(&target3, false).await,
            Err(RelayQuotaError::NotFound)
        );
        let _ = srv3.await;
    }

    #[tokio::test]
    async fn fetch_relay_models_forwards_refresh_sanitizes_and_maps_errors() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let srv = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 2048];
            let n = sock.read(&mut buf).await.unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            assert!(req.starts_with("GET /agy-proxy/0123456789abcdef/models?refresh=1 "));
            assert!(
                req.contains("authorization: Bearer mcr1.0123456789abcdef.secret9999")
                    || req.contains("Authorization: Bearer mcr1.0123456789abcdef.secret9999")
            );
            let body = json!({
                "models": [
                    { "model": "gemini-4-neon", "label": "Gemini 4 Neon" },
                    { "model": "gemini-4-neon", "label": "Duplicate" },
                    { "model": "bad\nmodel", "label": "Control" },
                    { "model": "  ", "label": "Blank" },
                    { "model": "claude-sonnet-5-5" }
                ],
                "current": { "model": "gemini-4-neon-high", "label": "Gemini 4 Neon (High)" },
                "source": "cli",
                "cached": false
            })
            .to_string();
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            sock.write_all(resp.as_bytes()).await.unwrap();
        });
        let target = multicc_core::agy_remote::parse_remote_target(&json!({
            "transport": "relay",
            "relayBaseUrl": format!("http://127.0.0.1:{port}/agy-proxy/0123456789abcdef"),
            "relayAuthToken": "mcr1.0123456789abcdef.secret9999",
        }))
        .unwrap();
        let (models, current, _) = fetch_relay_models(&target, true).await.unwrap();
        let _ = srv.await;
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["model"], "gemini-4-neon");
        assert_eq!(models[0]["label"], "Gemini 4 Neon");
        assert_eq!(models[1]["model"], "claude-sonnet-5-5");
        assert_eq!(models[1]["label"], "claude-sonnet-5-5");
        assert_eq!(
            current,
            Some(json!({"model":"gemini-4-neon-high","label":"Gemini 4 Neon (High)"}))
        );

        // 302 /login -> Revoked
        let listener2 = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port2 = listener2.local_addr().unwrap().port();
        let srv2 = tokio::spawn(async move {
            let (mut sock, _) = listener2.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let resp = "HTTP/1.1 302 Found\r\nLocation: /login?redirect=%2Fagy-proxy%2F0123456789abcdef%2Fmodels\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = sock.write_all(resp.as_bytes()).await;
        });
        let target2 = multicc_core::agy_remote::parse_remote_target(&json!({
            "transport": "relay",
            "relayBaseUrl": format!("http://127.0.0.1:{port2}/agy-proxy/0123456789abcdef"),
            "relayAuthToken": "mcr1.0123456789abcdef.revokedsecret",
        }))
        .unwrap();
        assert_eq!(
            fetch_relay_models(&target2, false).await,
            Err(RelayCatalogError::Revoked)
        );
        let _ = srv2.await;

        // 404 -> NotFound
        let listener3 = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port3 = listener3.local_addr().unwrap().port();
        let srv3 = tokio::spawn(async move {
            let (mut sock, _) = listener3.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let resp = "HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
            let _ = sock.write_all(resp.as_bytes()).await;
        });
        let target3 = multicc_core::agy_remote::parse_remote_target(&json!({
            "transport": "relay",
            "relayBaseUrl": format!("http://127.0.0.1:{port3}/agy-proxy/0123456789abcdef"),
            "relayAuthToken": "mcr1.0123456789abcdef.validtoken99",
        }))
        .unwrap();
        assert_eq!(
            fetch_relay_models(&target3, false).await,
            Err(RelayCatalogError::NotFound)
        );
        let _ = srv3.await;
    }

    #[tokio::test]
    async fn agy_relay_bridges_multicc_router_json_and_ndjson_without_leaking_client_capability() {
        use axum::extract::Path as AxumPath;
        use axum::http::{HeaderMap, HeaderValue, StatusCode};
        use axum::response::IntoResponse;
        use axum::routing::post;
        use axum::{Json, Router};

        let _guard = crate::egress_runtime::TEST_ENV_LOCK.lock().await;
        let root = std::env::temp_dir().join(format!(
            "multicc-agy-router-bridge-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let host_home = root.join("host-home");
        let client_ws = root.join("client-ws");
        let bin_dir = root.join("bin");
        std::fs::create_dir_all(&host_home).unwrap();
        std::fs::create_dir_all(&client_ws).unwrap();
        std::fs::create_dir_all(&bin_dir).unwrap();
        let fake_router_script = bin_dir.join("multicc-router-mcp.js");
        std::fs::write(&fake_router_script, "// mock router mcp\n").unwrap();

        let created = multicc_core::agy_accounts::create_account_with_egress(
            &host_home,
            "HostRouter测试",
            "created",
            None,
        )
        .unwrap();
        let account_id = created["id"].as_str().unwrap().to_string();

        // Mock Client local MultiCC `/api/internal/router-tools/:tool` server
        let client_secret_cap = "client_real_secret_cap_9876543210";
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
                            return (
                                StatusCode::UNAUTHORIZED,
                                Json(json!({ "ok": false, "code": "bad_cap" })),
                            )
                                .into_response();
                        }
                        if tool == "dispatch_master" {
                            let ndjson = concat!(
                                "{\"type\":\"progress\",\"progress\":{\"kind\":\"running\",\"message\":\"step 1\"}}\n",
                                "{\"type\":\"result\",\"result\":{\"ok\":true,\"operationId\":\"op_stream_1\"}}\n"
                            );
                            let mut resp = axum::http::Response::builder()
                                .status(StatusCode::OK)
                                .body(axum::body::Body::from(ndjson))
                                .unwrap();
                            resp.headers_mut().insert(
                                "content-type",
                                HeaderValue::from_static("application/x-ndjson; charset=utf-8"),
                            );
                            return resp;
                        }
                        (
                            StatusCode::OK,
                            Json(json!({
                                "ok": true,
                                "result": { "tool": tool, "echo": body["arguments"] }
                            })),
                        )
                            .into_response()
                    }
                },
            ),
        );
        let client_router_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client_router_port = client_router_listener.local_addr().unwrap().port();
        let client_router_srv = tokio::spawn(async move {
            let _ = axum::serve(client_router_listener, mock_router_app).await;
        });

        // Fake Host agy binary:
        // 1) Verifies Host child NEVER sees Client's real capability token!
        // 2) Verifies forged capability header on Host loopback returns 401!
        // 3) Calls normal JSON router tool (`list_secrets`) over Host loopback -> WSS -> Client!
        // 4) Calls streaming NDJSON router tool (`dispatch_master`) over Host loopback -> WSS -> Client!
        let fake_agy = bin_dir.join("fake-agy-router");
        std::fs::write(
            &fake_agy,
            format!(
                r#"#!/bin/sh
set -e
if [ "$MULTICC_ROUTER_CAPABILITY" = "{client_secret_cap}" ]; then
  echo "LEAKED client capability onto Host!" >&2
  exit 41
fi
if [ "$MULTICC_SESSION_ID" != "sess-router-42" ]; then
  echo "missing session id: $MULTICC_SESSION_ID" >&2
  exit 42
fi
BAD_CODE="$(curl -sS -o /dev/null -w '%{{http_code}}' -X POST -H 'content-type: application/json' -H 'x-multicc-router-capability: forged' -d '{{"arguments":{{}}}}' "$MULTICC_BASE_URL/api/internal/router-tools/list_secrets")"
if [ "$BAD_CODE" != "401" ]; then
  echo "expected 401 for forged cap, got $BAD_CODE" >&2
  exit 43
fi
JSON_RES="$(curl -sS -X POST -H 'content-type: application/json' -H "x-multicc-router-capability: $MULTICC_ROUTER_CAPABILITY" -d '{{"arguments":{{"hello":"world"}}}}' "$MULTICC_BASE_URL/api/internal/router-tools/list_secrets")"
case "$JSON_RES" in
  *list_secrets*world*) ;;
  *) echo "unexpected json router response: $JSON_RES" >&2; exit 44 ;;
esac
NDJSON_RES="$(curl -sS -X POST -H 'content-type: application/json' -H "x-multicc-router-capability: $MULTICC_ROUTER_CAPABILITY" -d '{{"arguments":{{"mode":"sync"}}}}' "$MULTICC_BASE_URL/api/internal/router-tools/dispatch_master")"
case "$NDJSON_RES" in
  *step\ 1*op_stream_1*) ;;
  *) echo "unexpected ndjson router response: $NDJSON_RES" >&2; exit 45 ;;
esac
echo '{{"event":"result","result":{{"conversation_id":"conv-rt","status":"SUCCESS","content":"ok"}}}}'
exit 0
"#
            ),
        )
        .unwrap();
        std::fs::set_permissions(&fake_agy, std::fs::Permissions::from_mode(0o755)).unwrap();

        std::env::set_var("MULTICC_AGY_BIN", &fake_agy);
        std::env::set_var(
            "MULTICC_BASE_URL",
            format!("http://127.0.0.1:{client_router_port}"),
        );
        std::env::set_var("MULTICC_ROUTER_CAPABILITY", client_secret_cap);
        std::env::set_var("MULTICC_SESSION_ID", "sess-router-42");
        std::env::set_var("MULTICC_TURN_ID", "turn-99");

        let ws_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_port = ws_listener.local_addr().unwrap().port();
        let host_home_srv = host_home.clone();
        let acct_srv = account_id.clone();
        let router_spec = crate::cli_relay_bridge::RouterMcpSpec {
            node_bin: "/usr/bin/node".to_string(),
            script_path: fake_router_script.clone(),
        };
        let server_task = tokio::spawn(async move {
            let (tcp, _) = ws_listener.accept().await.unwrap();
            let ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            crate::ws_agy_relay::serve_relay_session_with_router(
                ws,
                host_home_srv,
                acct_srv,
                Some(router_spec),
            )
            .await;
        });

        let target = multicc_core::agy_remote::parse_remote_target(&json!({
            "transport": "relay",
            "relayBaseUrl": format!("http://127.0.0.1:{ws_port}/agy-proxy/{account_id}"),
            "relayAuthToken": "mcr1.0123456789abcdef.testsecret123456",
        }))
        .unwrap();

        let code = serve_relay_turn(
            &target,
            &client_ws,
            &["--output-format".into(), "stream-json".into(), "-p".into()],
            "test router bridge",
        )
        .await;
        let _ = server_task.await;
        client_router_srv.abort();
        assert_eq!(code, 0);

        // Verify Host mcp_config.json has both multicc_host_exec and multicc_router registered.
        let resolved_home =
            match multicc_core::agy_accounts::resolve_account(&host_home, Some(&account_id))
                .unwrap()
                .unwrap()
            {
                multicc_core::agy_accounts::ResolvedAgyAccount::Local { home, .. } => home,
                _ => panic!("expected local agy account"),
            };
        let mcp_cfg_path = resolved_home
            .join(".gemini")
            .join("config")
            .join("mcp_config.json");
        let mcp_cfg: Value =
            serde_json::from_str(&std::fs::read_to_string(&mcp_cfg_path).unwrap()).unwrap();
        assert!(mcp_cfg["mcpServers"]["multicc_host_exec"].is_object());
        assert_eq!(
            mcp_cfg["mcpServers"]["multicc_router"]["command"],
            "/usr/bin/node"
        );
        assert_eq!(
            mcp_cfg["mcpServers"]["multicc_router"]["args"][0],
            fake_router_script.to_string_lossy().as_ref()
        );

        std::env::remove_var("MULTICC_AGY_BIN");
        std::env::remove_var("MULTICC_BASE_URL");
        std::env::remove_var("MULTICC_ROUTER_CAPABILITY");
        std::env::remove_var("MULTICC_SESSION_ID");
        std::env::remove_var("MULTICC_TURN_ID");
        let _ = std::fs::remove_dir_all(&root);
    }
}
