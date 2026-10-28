//! loopback WebSocket 入口：让 Puppeteer（`browserWSEndpoint`）、Playwright
//! （`connectOverCDP`）、chrome-devtools-mcp（`--wsEndpoint`）和随手写的 Python
//! websocket 脚本不改代码就走网关 —— 它们本来就说原生 CDP over WebSocket。最初
//! 把用户点到崩溃的，正是一个「每个动作新开一条 WS」的 Python 脚本。
//!
//! 地址：`ws://127.0.0.1:<port>/cdp/<token>?ws=<上游 wsUrl>` 或 `?activePort=default`，
//! 可加 `&lane=<名字>&ttl=<秒>`。用 `multicc-cdpd endpoint` 取（它会顺便拉起网关）。
//!
//! 安全：只绑 127.0.0.1；路径带随机 token，只写在 0600 的 endpoint.json 里、经 0600
//! 的本地 socket 才拿得到（挡住同机其他用户）；带 Origin 头的握手一律拒绝 —— 网页能
//! 连 ws://127.0.0.1，Origin 是区分它们与本地程序的可靠信号，Chrome 自己的调试端口
//! 也是这么防的。

use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

use crate::daemon::{self, Attached, Daemon};
use crate::pool::{resolve_url, validate, Refusal};
use crate::router::JoinOptions;
use crate::upstream::{ws_config, Cmd, ConnMsg};

pub struct FrontInfo {
    pub port: u16,
    pub token: String,
}

impl FrontInfo {
    pub fn base(&self) -> String {
        format!("ws://127.0.0.1:{}/cdp/{}", self.port, self.token)
    }
}

pub async fn bind() -> std::io::Result<(TcpListener, FrontInfo)> {
    let port = std::env::var("MULTICC_CDP_WS_PORT")
        .ok()
        .and_then(|v| v.trim().parse::<u16>().ok())
        .unwrap_or(0);
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    let port = listener.local_addr()?.port();
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
    let token = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok((listener, FrontInfo { port, token }))
}

pub async fn serve(listener: TcpListener, daemon: Arc<Daemon>) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                tokio::spawn(handle(stream, daemon.clone()));
            }
            Err(error) => {
                crate::log!("websocket accept failed: {error}");
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
        }
    }
}

struct Target {
    url: String,
    force: bool,
    options: JoinOptions,
}

// ErrorResponse 的大小由 tungstenite 的回调签名决定，不是我们能挑的。
#[allow(clippy::result_large_err)]
async fn handle(stream: TcpStream, daemon: Arc<Daemon>) {
    let Some(front) = daemon.front.get() else {
        return;
    };
    let expected = format!("/cdp/{}", front.token);
    let parsed: Arc<Mutex<Option<Target>>> = Arc::new(Mutex::new(None));
    let slot = parsed.clone();
    let allow_remote = daemon.pool.allow_remote();
    let callback = move |request: &Request,
                         response: Response|
          -> Result<Response, ErrorResponse> {
        if request.headers().contains_key(http::header::ORIGIN) {
            return Err(reject(403, "requests with an Origin header are refused: multicc-cdpd only serves local programs"));
        }
        if !constant_time_eq(request.uri().path().as_bytes(), expected.as_bytes()) {
            return Err(reject(404, "not found"));
        }
        let target = parse_query(request.uri().query().unwrap_or(""), allow_remote)
            .map_err(|refusal| reject(400, &refusal.detail))?;
        *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(target);
        Ok(response)
    };
    let Ok(socket) =
        tokio_tungstenite::accept_hdr_async_with_config(stream, callback, Some(ws_config())).await
    else {
        return;
    };
    let Some(target) = parsed.lock().unwrap_or_else(|e| e.into_inner()).take() else {
        return;
    };
    let (mut sink, mut stream) = socket.split();

    let Attached {
        actor,
        conn,
        mut rx,
        _guard,
    } = match daemon
        .attach(&target.url, target.force, target.options)
        .await
    {
        Ok(attached) => attached,
        Err(refusal) => {
            let _ = sink
                .send(Message::Close(Some(close_frame(Some(refusal.body())))))
                .await;
            return;
        }
    };

    let mut writer_task = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            match message {
                ConnMsg::Line(line) => {
                    if sink.send(Message::Text(line.into())).await.is_err() {
                        return;
                    }
                }
                ConnMsg::Close(reason) => {
                    let _ = sink.send(Message::Close(Some(close_frame(reason)))).await;
                    return;
                }
            }
        }
        let _ = sink.close().await;
    });
    loop {
        tokio::select! {
            message = stream.next() => {
                let text = match message {
                    Some(Ok(Message::Text(text))) => text.to_string(),
                    Some(Ok(Message::Binary(bytes))) => match String::from_utf8(bytes.to_vec()) {
                        Ok(text) => text,
                        Err(_) => continue,
                    },
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => continue,
                };
                if actor.send(Cmd::Frame { conn, text }).await.is_err() {
                    break;
                }
            }
            _ = &mut writer_task => break,
        }
    }
    let _ = actor.send(Cmd::Leave { conn }).await;
    writer_task.abort();
}

fn parse_query(query: &str, allow_remote: bool) -> Result<Target, Refusal> {
    let mut ws = None;
    let mut active_port = None;
    let mut lane = None;
    let mut ttl_ms = None;
    let mut force = false;
    let mut allow_close = false;
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value = percent_decode(value);
        match key {
            "ws" | "wsUrl" => ws = Some(value),
            "activePort" => active_port = Some(value),
            "lane" => lane = Some(value),
            "ttl" => ttl_ms = value.parse::<u64>().ok().map(|s| s.saturating_mul(1000)),
            "force" => force = value == "1" || value == "true",
            "allowBrowserClose" => allow_close = value == "1" || value == "true",
            _ => {}
        }
    }
    let url = resolve_url(ws.as_deref(), active_port.as_deref())?;
    // 握手阶段就拒掉，而不是先升级成 WebSocket 再关。
    validate(&url, allow_remote)?;
    let options = daemon::join_options(lane.as_deref(), ttl_ms, allow_close, false)?;
    Ok(Target {
        url,
        force,
        options,
    })
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        match (
            bytes[index],
            bytes.get(index + 1).copied().and_then(hex),
            bytes.get(index + 2).copied().and_then(hex),
        ) {
            (b'%', Some(high), Some(low)) => {
                out.push((high * 16 + low) as u8);
                index += 3;
            }
            (byte, _, _) => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

fn reject(status: u16, message: &str) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some(message.to_string()));
    *response.status_mut() =
        http::StatusCode::from_u16(status).unwrap_or(http::StatusCode::BAD_REQUEST);
    response
}

/// close reason 上限 123 字节：从控制消息里取 detail，按字符边界截断。
fn close_frame(reason: Option<String>) -> CloseFrame {
    let text = reason
        .as_deref()
        .and_then(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .map(|value| {
            let code = value["error"].as_str().unwrap_or("closed").to_string();
            match value["detail"].as_str() {
                Some(detail) => format!("{code}: {detail}"),
                None => code,
            }
        })
        .unwrap_or_else(|| "closed".into());
    let mut end = text.len().min(120);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    CloseFrame {
        code: CloseCode::Error,
        reason: text[..end].to_string().into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_carry_the_upstream_and_lane() {
        let target = parse_query(
            "ws=ws%3A%2F%2F127.0.0.1%3A9222%2Fdevtools%2Fbrowser%2Fab&lane=job-1&ttl=30",
            false,
        )
        .unwrap();
        assert_eq!(target.url, "ws://127.0.0.1:9222/devtools/browser/ab");
        assert_eq!(target.options.lane.as_deref(), Some("job-1"));
        assert_eq!(target.options.ttl_ms, 30_000);
        assert!(!target.options.control, "WebSocket clients speak plain CDP");
        assert!(
            parse_query("lane=x", false).is_err(),
            "an upstream is required"
        );
        assert!(
            parse_query("ws=ws://example.com:1/x", false).is_err(),
            "remote Chrome is refused"
        );
        assert!(parse_query("ws=ws://127.0.0.1:1/x&lane=bad%20name", false).is_err());
    }

    #[test]
    fn close_reasons_fit_the_websocket_limit() {
        let long = crate::wire::error_body("chrome_rejected", &"界".repeat(100));
        let frame = close_frame(Some(long));
        assert!(frame.reason.len() <= 123);
        assert!(frame.reason.starts_with("chrome_rejected: "));
    }
}
