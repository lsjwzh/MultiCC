//! CLI-agnostic Client 侧借道 WebSocket 公共引擎。
//!
//! 复用于 `agy`、Claude Code、Codex 借道客户端：
//! - 统一 `ws://` / `wss://` 拨号与认证拒绝识别（含 `302 /login` 判撤回）；
//! - 统一处理 Host 回传的 `host_exec_req`（转发至本机 `127.0.0.1:<port>` host-exec 守护）
//!   与 `router_tool_req` / `router_tool_abort`（仅转发至 Client 本地环回 MultiCC
//!   `/api/internal/router-tools/<tool>`，并原地注入 Client 真实 `MULTICC_ROUTER_CAPABILITY`，
//!   绝不把 capability 发往 Host，绝不跟随重定向）。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};
use tokio::task::AbortHandle;
use tokio_tungstenite::{
    tungstenite::{
        client::IntoClientRequest,
        http::header::{HeaderValue, AUTHORIZATION},
        protocol::WebSocketConfig,
        Error as WsError,
    },
    WebSocketStream,
};

use crate::cli_relay_bridge::{is_valid_router_tool_name, MAX_WS_PAYLOAD};
use crate::ws_machines::Io;

const DIAL_TIMEOUT: Duration = Duration::from_secs(15);

pub fn is_auth_rejected_http(status: u16, location: Option<&str>) -> bool {
    if status == 401 || status == 403 {
        return true;
    }
    matches!(status, 301 | 302 | 303 | 307 | 308)
        && location.is_some_and(|loc| loc.starts_with("/login") || loc.contains("/login?"))
}

/// 严格校验 URL 仅指向本机环回 `http://(127.0.0.1|localhost|[::1])`。
pub fn is_loopback_http_url(raw: &str) -> bool {
    let Ok(parsed) = url::Url::parse(raw) else {
        return false;
    };
    if parsed.scheme() != "http" {
        return false;
    }
    matches!(
        parsed.host_str().unwrap_or(""),
        "127.0.0.1" | "localhost" | "::1" | "[::1]"
    )
}

/// Client 本地 MultiCC 编排层配置（从本机子进程环境读取，`capability` 永不离开 Client）。
#[derive(Debug, Clone)]
pub struct LocalRouterConfig {
    pub base_url: String,
    pub capability: String,
    pub session_id: String,
    pub turn_id: String,
    pub origin_dispatch_id: String,
    pub image_bridge: String,
}

impl LocalRouterConfig {
    pub fn from_env() -> Option<Self> {
        let base_url = std::env::var("MULTICC_BASE_URL")
            .ok()
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| is_loopback_http_url(s))?;
        let capability = std::env::var("MULTICC_ROUTER_CAPABILITY")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())?;
        Some(Self {
            base_url,
            capability,
            session_id: std::env::var("MULTICC_SESSION_ID").unwrap_or_default(),
            turn_id: std::env::var("MULTICC_TURN_ID").unwrap_or_default(),
            origin_dispatch_id: std::env::var("MULTICC_ORIGIN_DISPATCH_ID").unwrap_or_default(),
            image_bridge: std::env::var("MULTICC_IMAGE_BRIDGE").unwrap_or_default(),
        })
    }

    /// 构造发往 Host `start` 帧的脱敏元数据：绝不携带 `capability` 或 `baseUrl`。
    pub fn to_start_frame_json(&self) -> Value {
        json!({
            "enabled": true,
            "sessionId": self.session_id,
            "turnId": self.turn_id,
            "originDispatchId": self.origin_dispatch_id,
            "imageBridge": self.image_bridge,
        })
    }
}

/// 统一构造借道 WebSocket URL（将 `http(s)` 转换为 `ws(s)` 并追加子路径，如 `/turn` 或 `/cli-turn`）。
pub fn build_ws_relay_url(relay_base_url: &str, suffix: &str) -> Result<url::Url, String> {
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
    let clean_suffix = suffix.trim_start_matches('/');
    parsed.set_path(&format!("{base_path}/{clean_suffix}"));
    Ok(parsed)
}

pub async fn dial_relay_ws(
    url: &url::Url,
    token: &str,
    product_label: &str,
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
            let loc = resp.headers().get("location").and_then(|v| v.to_str().ok());
            if is_auth_rejected_http(code, loc) {
                Err(format!(
                    "{product_label}借道分享码已被撤销或无效，请向出借方重新获取"
                ))
            } else if code == 404 {
                Err(format!(
                    "远端 Host 上对应的{product_label}账号已不存在，或 Host 尚未升级支持{product_label} CLI 借道"
                ))
            } else {
                Err(format!("远端借道服务拒绝握手（HTTP {code}）"))
            }
        }
        Ok(Err(err)) => Err(format!("WebSocket 握手失败: {err}")),
        Err(_) => Err("WebSocket 握手超时".to_string()),
    }
}

/// Client 侧 RPC 分发器：处理来自 Host 的 `host_exec_req`、`router_tool_req` 与 `router_tool_abort`。
pub struct ClientRpcDispatcher {
    local_exec_port: u16,
    local_exec_token: String,
    router_cfg: Option<LocalRouterConfig>,
    http_exec: reqwest::Client,
    http_router: reqwest::Client,
    inflight_router: Arc<Mutex<HashMap<String, AbortHandle>>>,
}

impl ClientRpcDispatcher {
    pub fn new(
        local_exec_port: u16,
        local_exec_token: String,
        router_cfg: Option<LocalRouterConfig>,
    ) -> Self {
        let http_exec = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10 * 60))
            .build()
            .expect("reqwest loopback exec client");
        // router tools 支持长时间 sync dispatch_master（最长 6 小时），仅在断连或 abort 时取消。
        let http_router = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(21_660))
            .build()
            .expect("reqwest loopback router client");
        Self {
            local_exec_port,
            local_exec_token,
            router_cfg,
            http_exec,
            http_router,
            inflight_router: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 尝试消费一条来自 Host 的 RPC 控制帧；返回 `true` 表示已消费。
    pub async fn handle_frame(&self, val: &Value, ws_tx: &mpsc::UnboundedSender<String>) -> bool {
        match val.get("type").and_then(Value::as_str) {
            Some("host_exec_req") => {
                self.spawn_host_exec(val, ws_tx.clone());
                true
            }
            Some("router_tool_req") => {
                self.spawn_router_tool(val, ws_tx.clone()).await;
                true
            }
            Some("router_tool_abort") => {
                if let Some(req_id) = val.get("reqId").and_then(Value::as_str) {
                    if let Some(handle) = self.inflight_router.lock().await.remove(req_id) {
                        handle.abort();
                    }
                }
                true
            }
            _ => false,
        }
    }

    pub async fn abort_all(&self) {
        let handles: Vec<_> = self
            .inflight_router
            .lock()
            .await
            .drain()
            .map(|(_, h)| h)
            .collect();
        for h in handles {
            h.abort();
        }
    }

    fn spawn_host_exec(&self, val: &Value, tx_reply: mpsc::UnboundedSender<String>) {
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
        let http_c = self.http_exec.clone();
        let tok = self.local_exec_token.clone();
        let port = self.local_exec_port;

        tokio::spawn(async move {
            let allowed = matches!(
                path.as_str(),
                "/exec" | "/fs/read" | "/fs/write" | "/fs/edit" | "/fs/list"
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
                    let parsed = serde_json::from_slice::<Value>(&bytes).unwrap_or_else(
                        |_| json!({ "ok": false, "error": "invalid local host_exec json" }),
                    );
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

    async fn spawn_router_tool(&self, val: &Value, tx_reply: mpsc::UnboundedSender<String>) {
        let req_id = val
            .get("reqId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let tool = val
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let body = val.get("body").cloned().unwrap_or_else(|| json!({}));

        let Some(cfg) = self.router_cfg.clone() else {
            let _ = tx_reply.send(
                json!({
                    "type": "router_tool_res",
                    "reqId": req_id,
                    "status": 503,
                    "contentType": "application/json; charset=utf-8",
                    "bodyText": json!({ "ok": false, "code": "router_unavailable", "error": "本地 MultiCC 编排环境未启用" }).to_string(),
                })
                .to_string(),
            );
            return;
        };
        if !is_valid_router_tool_name(&tool) {
            let _ = tx_reply.send(
                json!({
                    "type": "router_tool_res",
                    "reqId": req_id,
                    "status": 400,
                    "contentType": "application/json; charset=utf-8",
                    "bodyText": json!({ "ok": false, "code": "invalid_tool", "error": "非法的 router 工具名称" }).to_string(),
                })
                .to_string(),
            );
            return;
        }

        let http_c = self.http_router.clone();
        let inflight = self.inflight_router.clone();
        let req_id_key = req_id.clone();

        let task = tokio::spawn(async move {
            let url = format!("{}/api/internal/router-tools/{tool}", cfg.base_url);
            let payload_bytes = serde_json::to_vec(&body).unwrap_or_default();
            let resp = http_c
                .post(&url)
                .header("content-type", "application/json")
                .header("x-multicc-router-capability", &cfg.capability)
                .body(payload_bytes)
                .send()
                .await;

            match resp {
                Ok(mut r) => {
                    let status = r.status().as_u16();
                    let content_type = r
                        .headers()
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("application/json; charset=utf-8")
                        .to_string();
                    let is_ndjson = content_type
                        .to_ascii_lowercase()
                        .contains("application/x-ndjson");
                    if is_ndjson {
                        let _ = tx_reply.send(
                            json!({
                                "type": "router_tool_stream_start",
                                "reqId": req_id,
                                "status": status,
                                "contentType": content_type,
                            })
                            .to_string(),
                        );
                        while let Ok(Some(chunk)) = r.chunk().await {
                            if chunk.is_empty() {
                                continue;
                            }
                            let text = String::from_utf8_lossy(&chunk).into_owned();
                            if tx_reply
                                .send(
                                    json!({
                                        "type": "router_tool_chunk",
                                        "reqId": req_id,
                                        "chunk": text,
                                    })
                                    .to_string(),
                                )
                                .is_err()
                            {
                                break;
                            }
                        }
                        let _ = tx_reply.send(
                            json!({
                                "type": "router_tool_end",
                                "reqId": req_id,
                            })
                            .to_string(),
                        );
                    } else {
                        let bytes = r.bytes().await.unwrap_or_default();
                        let body_text = String::from_utf8_lossy(&bytes).into_owned();
                        let _ = tx_reply.send(
                            json!({
                                "type": "router_tool_res",
                                "reqId": req_id,
                                "status": status,
                                "contentType": content_type,
                                "bodyText": body_text,
                            })
                            .to_string(),
                        );
                    }
                }
                Err(err) => {
                    let _ = tx_reply.send(
                        json!({
                            "type": "router_tool_res",
                            "reqId": req_id,
                            "status": 502,
                            "contentType": "application/json; charset=utf-8",
                            "bodyText": json!({
                                "ok": false,
                                "code": "router_local_forward_failed",
                                "error": format!("本机编排桥调用失败: {err}")
                            }).to_string(),
                        })
                        .to_string(),
                    );
                }
            }
            inflight.lock().await.remove(&req_id);
        });

        self.inflight_router
            .lock()
            .await
            .insert(req_id_key, task.abort_handle());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_url_validation_rejects_remote_and_https() {
        assert!(is_loopback_http_url("http://127.0.0.1:3000"));
        assert!(is_loopback_http_url("http://localhost:3000"));
        assert!(is_loopback_http_url("http://[::1]:3000"));
        assert!(!is_loopback_http_url("https://127.0.0.1:3000"));
        assert!(!is_loopback_http_url("http://10.0.0.1:3000"));
        assert!(!is_loopback_http_url("http://example.com"));
        assert!(!is_loopback_http_url("not-a-url"));
    }

    #[test]
    fn start_frame_json_redacts_capability_and_base_url() {
        let cfg = LocalRouterConfig {
            base_url: "http://127.0.0.1:3000".into(),
            capability: "super_secret_cap_token".into(),
            session_id: "sess-1".into(),
            turn_id: "turn-2".into(),
            origin_dispatch_id: "op_3".into(),
            image_bridge: "1".into(),
        };
        let payload = cfg.to_start_frame_json();
        let serialized = payload.to_string();
        assert!(!serialized.contains("super_secret_cap_token"));
        assert!(!serialized.contains("127.0.0.1"));
        assert_eq!(payload["enabled"], true);
        assert_eq!(payload["sessionId"], "sess-1");
        assert_eq!(payload["turnId"], "turn-2");
    }
}
