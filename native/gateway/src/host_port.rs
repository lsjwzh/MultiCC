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
use std::net::SocketAddr;
use std::time::Duration;

use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::client::conn::http1::Builder as ClientBuilder;
use hyper_util::rt::TokioIo;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::proxy_header::format_proxy_header;

/// How long a host operation may take. Session patches stage configuration and
/// broadcast frames, so this is deliberately generous.
const TIMEOUT: Duration = Duration::from_secs(60);

/// One non-host-port exchange with the Node child (the streamed speed probe):
/// an arbitrary method/path/headers/body, answered as status plus a bounded
/// body. Node's proxy routes are ordinary HTTP; only the PROXY v1 preamble and
/// the internal port differ from a request that reached the public port.
pub struct UpstreamReply {
    pub status: u16,
    pub body: Vec<u8>,
}

pub enum UpstreamFailure {
    Network(String),
    Timeout,
    TooLarge(u16),
}

/// POST `path` to the Node child on `port`, collecting at most `limit` body
/// bytes. The whole exchange shares one deadline (Node's speed test used a
/// 15s socket timeout plus a 15s deadline timer).
pub async fn request(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Vec<u8>,
    timeout: Duration,
    limit: usize,
) -> Result<UpstreamReply, UpstreamFailure> {
    match tokio::time::timeout(
        timeout,
        request_inner(port, method, path, headers, body, limit),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(UpstreamFailure::Timeout),
    }
}

async fn request_inner(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Vec<u8>,
    limit: usize,
) -> Result<UpstreamReply, UpstreamFailure> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .map_err(|error| UpstreamFailure::Network(error.to_string()))?;
    let _ = stream.set_nodelay(true);
    let local = stream
        .local_addr()
        .map_err(|error| UpstreamFailure::Network(error.to_string()))?;
    let proxy = format_proxy_header(local, SocketAddr::from(([127, 0, 0, 1], port)));
    stream
        .write_all(proxy.as_bytes())
        .await
        .map_err(|error| UpstreamFailure::Network(error.to_string()))?;
    let (mut sender, connection) = ClientBuilder::new()
        .preserve_header_case(true)
        .handshake::<_, Full<Bytes>>(TokioIo::new(stream))
        .await
        .map_err(|error| UpstreamFailure::Network(error.to_string()))?;
    tokio::spawn(async move {
        let _ = connection.await;
    });

    let mut builder = hyper::http::Request::builder()
        .method(method)
        .uri(path)
        .header("Host", format!("127.0.0.1:{port}"));
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let request = builder
        .body(Full::new(Bytes::from(body)))
        .map_err(|error| UpstreamFailure::Network(error.to_string()))?;
    let response = sender
        .send_request(request)
        .await
        .map_err(|error| UpstreamFailure::Network(error.to_string()))?;
    let status = response.status().as_u16();
    let mut incoming = response.into_body();
    let mut collected = Vec::new();
    while let Some(frame) = incoming.frame().await {
        let frame = frame.map_err(|error| UpstreamFailure::Network(error.to_string()))?;
        if let Ok(data) = frame.into_data() {
            if collected.len() + data.len() > limit {
                return Err(UpstreamFailure::TooLarge(status));
            }
            collected.extend_from_slice(&data);
        }
    }
    Ok(UpstreamReply {
        status,
        body: collected,
    })
}

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
