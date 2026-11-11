//! The one outbound call the front door makes to its own Node child: a host
//! port for facts and side effects that only live in Node (in-process session
//! tables, provider-store objects, session patch staging).
//!
//! The internal listener speaks PROXY v1 first (src/gateway-child.js), so this
//! client writes a truthful `127.0.0.1` line before the HTTP request. The Node
//! handler authorizes on the same rule as every other request: the forwarded
//! peer must be loopback (`isLocalRequest`), which is why public clients cannot
//! reach it through the front door — their PROXY line carries the real remote
//! address.
//!
//! Failure is always "no answer": the caller maps it to the route's existing
//! 503 shape. Nothing is retried, because these operations are not idempotent
//! (a persisted default or a patched session must not happen twice).

use std::io;
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// How long a host operation may take. Session patches stage configuration and
/// broadcast frames, so this is deliberately generous.
const TIMEOUT: Duration = Duration::from_secs(60);

/// One JSON request/response exchange with the Node child on `port`.
pub async fn call(port: u16, path: &str, payload: &Value) -> io::Result<Value> {
    call_with(port, path, payload, TIMEOUT).await
}

/// The same exchange with a route-specific budget. Only a route whose Node
/// handler used to block without a timeout (the legacy Codex catalog wait) needs
/// more than [`TIMEOUT`].
pub async fn call_with(
    port: u16,
    path: &str,
    payload: &Value,
    timeout: Duration,
) -> io::Result<Value> {
    tokio::time::timeout(timeout, exchange(port, path, payload))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "host port timed out"))?
}

async fn exchange(port: u16, path: &str, payload: &Value) -> io::Result<Value> {
    let body = serde_json::to_vec(payload).map_err(io::Error::other)?;
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
    stream.set_nodelay(true).ok();
    let source = stream.local_addr()?.port();
    // The listener rejects anything that is not a strict PROXY v1 line. The
    // addresses are the ones this connection really has.
    let proxied = format!("PROXY TCP4 127.0.0.1 127.0.0.1 {source} {port}\r\n");
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(proxied.as_bytes()).await?;
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(&body).await?;
    stream.flush().await?;

    let mut raw = Vec::new();
    // `Connection: close` makes end-of-stream the frame boundary; the child
    // answers a bounded JSON body, never a stream.
    stream.read_to_end(&mut raw).await?;
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "host port: no headers"))?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "host port: no status"))?;
    if status != 200 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("host port: status {status}"),
        ));
    }
    if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "host port: chunked reply",
        ));
    }
    serde_json::from_slice(&raw[split + 4..]).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("host port: invalid JSON: {error}"),
        )
    })
}
