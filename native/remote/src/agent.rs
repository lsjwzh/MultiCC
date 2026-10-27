//! 桌面 Agent 客户端：一行 JSON 进、一行 JSON 出（docs/desktop-agent-protocol.md §3）。
//!
//! 没有握手、没有版本协商。失败永远用 `{ok:false, reason}` 表达 —— 断连等于
//! 「agent 没了」，前端会退化成 `agent-unreachable`。

use crate::error::AppResult;
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;
#[cfg(unix)]
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 其余 op 都是毫秒级，沿用默认超时；`type` 由调用方按字数放大。
pub const DEFAULT_TIMEOUT: Duration = Duration::from_millis(8000);

pub trait AgentClient: Send + Sync {
    fn call(&self, req: Value, timeout: Option<Duration>) -> BoxFuture<'static, Value>;
}

/// 真实现：连 unix socket，写一行，读到第一个换行为止。
#[derive(Clone, Debug)]
pub struct UnixAgentClient {
    /// 画像里的 agent.sock；None = 这台机器没有 agent（win32 之类）。
    pub socket: Option<PathBuf>,
}

impl UnixAgentClient {
    pub fn new(socket: Option<PathBuf>) -> Self {
        Self { socket }
    }
}

impl AgentClient for UnixAgentClient {
    fn call(&self, req: Value, timeout: Option<Duration>) -> BoxFuture<'static, Value> {
        let socket = self.socket.clone();
        Box::pin(call_over_unix(
            socket,
            req,
            timeout.unwrap_or(DEFAULT_TIMEOUT),
        ))
    }
}

/// 请求的 JSON 里 `ok === false`（严格布尔）或整个回复是 null 才算失败 ——
/// 与 JS 的 `if (!r || r.ok === false)` 一致，`{foo:1}` 这类仍按成功透传。
pub fn agent_failed(reply: &Value) -> bool {
    reply.is_null() || reply.get("ok") == Some(&Value::Bool(false))
}

#[cfg(unix)]
async fn call_over_unix(socket: Option<PathBuf>, req: Value, timeout: Duration) -> Value {
    let Some(path) = socket else {
        // 画像里没有 socket：JS 会 createConnection(undefined) 抛 ENOENT，
        // 对外同样是「连不上 agent」。
        return json!({ "ok": false, "error": "agent-unreachable" });
    };
    let exchange = async move {
        let mut stream = tokio::net::UnixStream::connect(&path).await?;
        let mut line = serde_json::to_string(&req).unwrap_or_else(|_| "{}".into());
        line.push('\n');
        stream.write_all(line.as_bytes()).await?;
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            let n = stream.read(&mut chunk).await?;
            if n == 0 {
                return Ok::<Result<Value, &'static str>, std::io::Error>(Err("agent-closed"));
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(nl) = buf.iter().position(|b| *b == b'\n') {
                return Ok(
                    serde_json::from_slice::<Value>(&buf[..nl]).map_err(|_| "agent-bad-response")
                );
            }
        }
    };
    match tokio::time::timeout(timeout, exchange).await {
        Err(_) => json!({ "ok": false, "error": "agent-timeout" }),
        Ok(Err(error)) => {
            json!({ "ok": false, "error": "agent-unreachable", "detail": error_code(&error) })
        }
        Ok(Ok(Err(code))) => json!({ "ok": false, "error": code }),
        Ok(Ok(Ok(value))) => value,
    }
}

/// Windows 上还没有 unix socket 传输：永远按「连不上 Agent」回复。
#[cfg(not(unix))]
async fn call_over_unix(_socket: Option<PathBuf>, _req: Value, _timeout: Duration) -> Value {
    json!({ "ok": false, "error": "agent-unreachable" })
}

/// JS 的 `error.code`：Node 给的是 ENOENT/ECONNREFUSED 这类短码。
fn error_code(error: &std::io::Error) -> String {
    match error.raw_os_error() {
        Some(2) => "ENOENT".into(),
        Some(13) => "EACCES".into(),
        Some(61) | Some(111) => "ECONNREFUSED".into(),
        Some(32) | Some(104) => "ECONNRESET".into(),
        Some(57) | Some(107) => "ENOTCONN".into(),
        Some(code) => format!("errno-{code}"),
        None => error.kind().to_string(),
    }
}

/// 把 `Arc<dyn AgentClient>` 适配成 host 需要的可注入 call。
pub type HostCall =
    std::sync::Arc<dyn Fn(Value, Option<Duration>) -> BoxFuture<'static, Value> + Send + Sync>;

pub fn host_call(agent: std::sync::Arc<dyn AgentClient>) -> HostCall {
    std::sync::Arc::new(move |req, timeout| agent.call(req, timeout))
}

/// 测试与调用方共用的便捷入口。
pub async fn call(agent: &dyn AgentClient, req: Value, timeout: Option<Duration>) -> Value {
    agent.call(req, timeout).await
}

pub type AgentCallResult = AppResult<Value>;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn unreachable_socket_reports_agent_unreachable() {
        let client = UnixAgentClient::new(Some(PathBuf::from("/nonexistent/agent.sock")));
        let reply = client.call(json!({"op":"status"}), None).await;
        assert_eq!(reply["error"], "agent-unreachable");
    }
}
