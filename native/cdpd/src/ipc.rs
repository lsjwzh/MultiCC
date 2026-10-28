//! 本地行协议入口：unix socket（macOS/Linux）/ 命名管道（Windows），以及客户端
//! 一侧（CLI、自动拉起）用的连接函数。协议见 docs/desktop-agent-protocol.md §4.4。

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};

use crate::daemon::{self, Attached, Daemon};
use crate::pool::{resolve_url, Refusal};
use crate::upstream::{Cmd, ConnMsg};
use crate::wire::{write_line, FrameError, LineReader};
use crate::PROTOCOL_VERSION;

/// 调用方单帧上限（setFileInputFiles、大段 evaluate 脚本都远小于它）。
pub const MAX_FRAME_BYTES: usize = 64 << 20;
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

pub trait Duplex: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Duplex for T {}

pub enum BindError {
    InUse,
    Other(String),
}

#[cfg(unix)]
pub struct Listener(tokio::net::UnixListener);

#[cfg(unix)]
impl Listener {
    pub async fn bind(path: &Path) -> Result<Self, BindError> {
        crate::paths::check_socket_len(path).map_err(BindError::Other)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| BindError::Other(format!("create {}: {e}", parent.display())))?;
        }
        // 锁已拿到，这里的 socket 文件通常是死进程留下的；但 MULTICC_CDP_SOCK 可能指向
        // 另一个锁目录下的活实例，所以 unlink 之前仍探一次。
        if tokio::net::UnixStream::connect(path).await.is_ok() {
            return Err(BindError::InUse);
        }
        let _ = std::fs::remove_file(path);
        let listener = tokio::net::UnixListener::bind(path)
            .map_err(|e| BindError::Other(format!("bind {}: {e}", path.display())))?;
        daemon::restrict_file(path);
        Ok(Self(listener))
    }

    pub async fn accept(&mut self) -> std::io::Result<Box<dyn Duplex>> {
        let (stream, _) = self.0.accept().await?;
        Ok(Box::new(stream))
    }
}

#[cfg(windows)]
pub struct Listener {
    name: String,
    next: tokio::net::windows::named_pipe::NamedPipeServer,
}

#[cfg(windows)]
impl Listener {
    pub async fn bind(path: &Path) -> Result<Self, BindError> {
        use tokio::net::windows::named_pipe::ServerOptions;
        let name = path.to_string_lossy().to_string();
        match ServerOptions::new()
            .first_pipe_instance(true)
            .reject_remote_clients(true)
            .create(&name)
        {
            Ok(next) => Ok(Self { name, next }),
            // ERROR_ACCESS_DENIED：同名管道已存在 —— 另一个实例在跑。
            Err(error) if error.raw_os_error() == Some(5) => Err(BindError::InUse),
            Err(error) => Err(BindError::Other(format!("create pipe {name}: {error}"))),
        }
    }

    pub async fn accept(&mut self) -> std::io::Result<Box<dyn Duplex>> {
        use tokio::net::windows::named_pipe::ServerOptions;
        self.next.connect().await?;
        let fresh = ServerOptions::new()
            .reject_remote_clients(true)
            .create(&self.name)?;
        Ok(Box::new(std::mem::replace(&mut self.next, fresh)))
    }
}

#[cfg(unix)]
pub async fn connect(path: &Path) -> std::io::Result<Box<dyn Duplex>> {
    Ok(Box::new(tokio::net::UnixStream::connect(path).await?))
}

#[cfg(windows)]
pub async fn connect(path: &Path) -> std::io::Result<Box<dyn Duplex>> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let name = path.to_string_lossy().to_string();
    for _ in 0..50 {
        match ClientOptions::new().open(&name) {
            Ok(client) => return Ok(Box::new(client)),
            // ERROR_PIPE_BUSY：所有实例都在握手，稍等再试。
            Err(error) if error.raw_os_error() == Some(231) => {
                tokio::time::sleep(Duration::from_millis(20)).await
            }
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        "named pipe stayed busy",
    ))
}

/// 一问一答的控制请求（ping / status / endpoint / release / shutdown）。
pub async fn request(path: &Path, body: &Value, timeout: Duration) -> Result<Value, String> {
    let connection = connect(path)
        .await
        .map_err(|e| format!("cannot reach {}: {e}", path.display()))?;
    let (reader, mut writer) = tokio::io::split(connection);
    write_line(&mut writer, &body.to_string())
        .await
        .map_err(|e| e.to_string())?;
    let mut lines = LineReader::new(reader, MAX_FRAME_BYTES);
    let line = tokio::time::timeout(timeout, lines.next_line())
        .await
        .map_err(|_| "the daemon did not answer".to_string())?
        .map_err(|e| e.to_string())?
        .ok_or("the daemon closed the connection")?;
    serde_json::from_str(&line).map_err(|e| format!("unreadable reply: {e}"))
}

pub fn target_url(request: &Value) -> Result<String, Refusal> {
    resolve_url(request["wsUrl"].as_str(), request["activePort"].as_str())
}

pub async fn handle(io: Box<dyn Duplex>, daemon: Arc<Daemon>) {
    let (reader, mut writer) = tokio::io::split(io);
    let mut lines = LineReader::new(reader, MAX_FRAME_BYTES);
    let hello = match tokio::time::timeout(HELLO_TIMEOUT, lines.next_line()).await {
        Ok(Ok(Some(line))) => line,
        _ => return,
    };
    let request = match serde_json::from_str::<Value>(&hello) {
        Ok(value @ Value::Object(_)) => value,
        _ => {
            let _ = write_line(
                &mut writer,
                &Refusal::bad_request("the first line must be a JSON request").body(),
            )
            .await;
            return;
        }
    };
    let reply = match request["op"].as_str().unwrap_or("") {
        "ping" => daemon.ping_body(),
        "status" => daemon.status().await,
        "endpoint" => match daemon.front.get() {
            Some(front) => json!({ "ok": true, "url": front.base() }),
            None => {
                json!({ "ok": false, "error": "endpoint-disabled", "detail": "the WebSocket endpoint is off (MULTICC_CDP_WS=0)" })
            }
        },
        "release" => match (target_url(&request), request["lane"].as_str()) {
            (Ok(url), Some(lane)) => {
                json!({ "ok": true, "released": daemon.release(&url, lane).await })
            }
            (Err(refusal), _) => refusal_value(&refusal),
            (_, None) => refusal_value(&Refusal::bad_request("lane is required")),
        },
        "shutdown" => {
            if daemon.busy() && request["force"] != true {
                json!({ "ok": false, "error": "busy",
                    "detail": "approved upstream connections are open; stopping now makes the user approve them again (pass force to stop anyway)" })
            } else {
                let _ = write_line(&mut writer, &json!({ "ok": true }).to_string()).await;
                daemon.shutdown.notify_one();
                return;
            }
        }
        "cdp" => {
            cdp(request, lines, writer, daemon).await;
            return;
        }
        other => refusal_value(&Refusal::bad_request(format!("unknown op: {other:?}"))),
    };
    let _ = write_line(&mut writer, &reply.to_string()).await;
}

fn refusal_value(refusal: &Refusal) -> Value {
    serde_json::from_str(&refusal.body()).unwrap_or(Value::Null)
}

/// `op:"cdp"`：两段式握手。`accepted` 表示网关接手了 —— 从这一刻起调用方**不得**
/// 再回退直连（那会再开一条 WebSocket、再弹一次授权）；`ready`（由 router 发出）
/// 表示上游已授权、lane 的浏览器会话已建好。之后这条连接就是逐行 CDP 帧管道。
async fn cdp<R, W>(request: Value, mut lines: LineReader<R>, mut writer: W, daemon: Arc<Daemon>)
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let attached = async {
        let url = target_url(&request)?;
        let options = daemon::join_options(
            request["lane"].as_str(),
            request["laneTtlMs"].as_u64(),
            request["allowBrowserClose"] == true,
            true,
        )?;
        let attached = daemon
            .attach(&url, request["force"] == true, options)
            .await?;
        Ok::<_, Refusal>((url, attached))
    }
    .await;
    let (
        url,
        Attached {
            actor,
            conn,
            mut rx,
            _guard,
        },
    ) = match attached {
        Ok(value) => value,
        Err(refusal) => {
            let _ = write_line(&mut writer, &refusal.body()).await;
            return;
        }
    };
    let accepted = json!({
        "ok": true, "phase": "accepted", "protocol": PROTOCOL_VERSION,
        "version": env!("CARGO_PKG_VERSION"), "wsUrl": url,
    });
    if write_line(&mut writer, &accepted.to_string())
        .await
        .is_err()
    {
        let _ = actor.send(Cmd::Leave { conn }).await;
        return;
    }

    // 上游的事件与响应随时会到，写方向独立成任务；它结束（上游断开、被踢、lane 被
    // 释放）时读方向也跟着收尾，调用方立刻看到连接关闭，而不是挂到命令超时。
    let mut writer_task = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            match message {
                ConnMsg::Line(line) => {
                    if write_line(&mut writer, &line).await.is_err() {
                        break;
                    }
                }
                ConnMsg::Close(reason) => {
                    if let Some(reason) = reason {
                        let _ = write_line(&mut writer, &reason).await;
                    }
                    break;
                }
            }
        }
        let _ = writer.shutdown().await;
    });
    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(frame)) => {
                    if frame.trim().is_empty() {
                        continue;
                    }
                    if actor.send(Cmd::Frame { conn, text: frame }).await.is_err() {
                        break;
                    }
                }
                Ok(None) | Err(FrameError::Io(_)) => break,
                Err(FrameError::TooLong) => {
                    crate::log!("client {conn} sent a frame over {MAX_FRAME_BYTES} bytes; disconnected");
                    break;
                }
            },
            _ = &mut writer_task => break,
        }
    }
    let _ = actor.send(Cmd::Leave { conn }).await;
    writer_task.abort();
}
