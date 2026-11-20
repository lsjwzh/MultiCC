//! End-to-end tests for `app::remote_screen`: the handler is mounted in a
//! hyper server (the same server hyper uses inside the front door) and talks
//! to the fake `multicc-remote` from `examples/remote_child_fixture.rs`.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::http::Request;
use http_body_util::{BodyExt, Full};
use hyper::server::conn::http1;
use hyper_util::rt::TokioIo;
use tokio::net::{TcpListener, TcpStream};

use multicc_gateway::app::express::RequestCtx;
use multicc_gateway::app::remote_screen::RemoteScreen;
use multicc_gateway::remote_child::{Config, RemoteChild};

/// The fake `multicc-remote` (`examples/remote_child_fixture.rs`). It is an
/// example rather than a `[[bin]]` on purpose: `cargo build --release` builds
/// every bin of the package, and a test stand-in must never be compiled into
/// (or sit next to) the release artifacts.
///
/// `cargo test` builds examples, but `cargo test --test <name>` does not, so a
/// missing fixture is built here instead of failing: the tests must not depend
/// on which cargo invocation the caller happened to use.
fn fixture() -> std::path::PathBuf {
    use std::sync::OnceLock;
    static PATH: OnceLock<std::path::PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let exe = std::env::current_exe().expect("test executable path");
        let profile_dir = exe
            .parent()
            .and_then(|deps| deps.parent())
            .expect("target/<profile>/deps/<test>")
            .to_path_buf();
        let name = if cfg!(windows) {
            "remote_child_fixture.exe"
        } else {
            "remote_child_fixture"
        };
        let path = profile_dir.join("examples").join(name);
        if !path.exists() {
            let mut cargo = std::process::Command::new(
                std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()),
            );
            cargo
                .args([
                    "build",
                    "-p",
                    "multicc-gateway",
                    "--example",
                    "remote_child_fixture",
                ])
                .current_dir(env!("CARGO_MANIFEST_DIR"));
            // Build into the profile the tests themselves run under.
            if profile_dir.file_name().is_some_and(|n| n == "release") {
                cargo.arg("--release");
            }
            if let Some(target) = std::env::var_os("CARGO_TARGET_DIR") {
                cargo.env("CARGO_TARGET_DIR", target);
            }
            let status = cargo.status().expect("run cargo to build the fixture");
            assert!(status.success(), "building remote_child_fixture failed");
        }
        assert!(path.exists(), "{} was not produced", path.display());
        path
    })
    .clone()
}

const CAPABILITIES: &str = r#"{"ok":true,"supported":false,"reason":"remote-unavailable","features":{"view":false,"control":false,"snapshot":false,"annotate":false,"stream":false,"wake":false,"unlock":false,"elementTree":false},"streams":{"h264":false,"rfb":false}}"#;

fn temp_dir(tag: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_micros())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "multicc-remote-screen-{tag}-{}-{stamp}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

fn child(tag: &str, env: &[(&str, &str)]) -> Arc<RemoteChild> {
    let dir = temp_dir(tag);
    let mut config = Config::new(dir.join("remote-screen"));
    config.binary = Some(fixture());
    config.ready_timeout = Duration::from_millis(800);
    config.restart_base = Duration::from_millis(20);
    config.restart_max = Duration::from_millis(200);
    config.stable_reset = Duration::from_millis(200);
    config.shutdown_grace = Duration::from_millis(500);
    config.env = env
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    Arc::new(RemoteChild::new(config))
}

/// A child that cannot start: every route sees the unavailable path.
fn missing_child(tag: &str) -> Arc<RemoteChild> {
    let dir = temp_dir(tag);
    let mut config = Config::new(dir.join("remote-screen"));
    config.binary = Some(dir.join("no-such-binary"));
    config.restart_base = Duration::from_millis(20);
    config.restart_max = Duration::from_millis(200);
    Arc::new(RemoteChild::new(config))
}

async fn serve(screen: Arc<RemoteScreen>) -> SocketAddr {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let screen = Arc::clone(&screen);
            tokio::spawn(async move {
                let service =
                    hyper::service::service_fn(move |request: Request<hyper::body::Incoming>| {
                        let screen = Arc::clone(&screen);
                        async move {
                            let (parts, body) = request.into_parts();
                            let ctx = RequestCtx::new(&parts);
                            let response = screen.handle(&ctx, Body::new(body)).await;
                            Ok::<_, Infallible>(response)
                        }
                    });
                let _ = http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    addr
}

fn find<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

async fn call(
    addr: SocketAddr,
    method: &str,
    target: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> Result<(u16, Vec<(String, String)>, Vec<u8>), String> {
    let stream = TcpStream::connect(addr).await.map_err(|e| e.to_string())?;
    let (mut sender, connection) = hyper::client::conn::http1::Builder::new()
        .handshake::<_, Full<Bytes>>(TokioIo::new(stream))
        .await
        .map_err(|e| e.to_string())?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let mut builder = Request::builder().method(method).uri(target);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let request = builder
        .body(Full::new(Bytes::from(body.to_vec())))
        .map_err(|e| e.to_string())?;
    let response = sender
        .send_request(request)
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                String::from_utf8_lossy(value.as_bytes()).into_owned(),
            )
        })
        .collect();
    let body = response
        .into_body()
        .collect()
        .await
        .map_err(|e| e.to_string())?
        .to_bytes()
        .to_vec();
    Ok((status, headers, body))
}

async fn get(addr: SocketAddr, target: &str) -> (u16, Vec<(String, String)>, Vec<u8>) {
    call(addr, "GET", target, &[], &[]).await.expect("response")
}

fn text(body: &[u8]) -> String {
    String::from_utf8_lossy(body).into_owned()
}

async fn wait_file(path: &Path, limit: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < limit {
        if path.exists() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    path.exists()
}

fn requests(path: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

#[tokio::test]
async fn other_methods_are_405_before_the_child_starts() {
    let dir = temp_dir("method");
    let marker = dir.join("stdin.json");
    let inner = child(
        "method-child",
        &[("FIXTURE_STDIN_FILE", marker.to_str().expect("utf8"))],
    );
    let addr = serve(Arc::new(RemoteScreen::new(Arc::clone(&inner)))).await;
    for method in ["PUT", "DELETE", "OPTIONS", "PATCH"] {
        let (status, _, body) = call(addr, method, "/api/remote-screen/frame", &[], &[])
            .await
            .expect("response");
        assert_eq!(status, 405, "{method}");
        assert_eq!(text(&body), r#"{"ok":false,"error":"method-not-allowed"}"#);
    }
    // The child was never consulted, so nothing spawned it.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!marker.exists());
    assert_eq!(inner.snapshot().attempts, 0);
}

#[tokio::test]
async fn unavailable_answers_have_the_node_shapes() {
    let inner = missing_child("unavailable");
    let addr = serve(Arc::new(RemoteScreen::new(inner))).await;

    let (status, headers, body) = get(addr, "/api/remote-screen/capabilities").await;
    assert_eq!(status, 200);
    assert_eq!(text(&body), CAPABILITIES);
    assert_eq!(find(&headers, "cache-control"), Some("no-store"));
    assert_eq!(
        find(&headers, "content-type"),
        Some("application/json; charset=utf-8")
    );

    // The same shape with a query string still counts as capabilities.
    let (status, headers, body) = get(addr, "/api/remote-screen/capabilities?x=1").await;
    assert_eq!(status, 200);
    assert_eq!(text(&body), CAPABILITIES);
    assert_eq!(find(&headers, "cache-control"), Some("no-store"));

    let (status, headers, body) = get(addr, "/api/remote-screen/frame").await;
    assert_eq!(status, 503);
    assert_eq!(text(&body), r#"{"ok":false,"error":"remote-unavailable"}"#);
    assert!(find(&headers, "cache-control").is_none());
}

#[tokio::test]
async fn head_and_get_reach_the_child_with_the_original_target() {
    let dir = temp_dir("passthrough");
    let log = dir.join("requests.jsonl");
    let inner = child(
        "passthrough-child",
        &[("FIXTURE_REQUESTS_FILE", log.to_str().expect("utf8"))],
    );
    let addr = serve(Arc::new(RemoteScreen::new(Arc::clone(&inner)))).await;

    let (status, headers, body) = call(addr, "HEAD", "/api/remote-screen/frame?x=1&y=2", &[], &[])
        .await
        .expect("response");
    assert_eq!(status, 200);
    assert!(body.is_empty());
    assert_eq!(find(&headers, "x-screen-marker"), Some("fixture"));
    assert_eq!(find(&headers, "x-region-top"), Some("3"));
    assert!(find(&headers, "content-length").is_some());

    let (status, headers, body) = get(addr, "/api/remote-screen/frame?x=1&y=2").await;
    assert_eq!(status, 200);
    assert!(!body.is_empty());
    assert_eq!(find(&headers, "content-type"), Some("application/json"));

    // The whitelist drops everything else the child sent.
    assert!(find(&headers, "x-secret-leak").is_none());
    assert!(find(&headers, "set-cookie").is_none());
    let length = body.len().to_string();
    assert_eq!(find(&headers, "content-length"), Some(length.as_str()));
    // Front-door base headers still ride along.
    assert_eq!(find(&headers, "x-powered-by"), Some("Express"));

    let records = requests(&log);
    assert_eq!(records.len(), 2);
    assert_eq!(records[0]["method"], "HEAD");
    assert_eq!(records[0]["target"], "/api/remote-screen/frame?x=1&y=2");
    assert_eq!(records[0]["secretOk"], true);
    assert_eq!(records[1]["method"], "GET");
    assert_eq!(records[1]["target"], "/api/remote-screen/frame?x=1&y=2");
}

#[tokio::test]
async fn post_bodies_are_reserialized() {
    let dir = temp_dir("post");
    let log = dir.join("requests.jsonl");
    let inner = child(
        "post-child",
        &[("FIXTURE_REQUESTS_FILE", log.to_str().expect("utf8"))],
    );
    let addr = serve(Arc::new(RemoteScreen::new(Arc::clone(&inner)))).await;

    let (status, _, _) = call(
        addr,
        "POST",
        "/api/remote-screen/input",
        &[("content-type", "application/json")],
        br#"{"b":1,  "a":2}"#,
    )
    .await
    .expect("response");
    assert_eq!(status, 200);

    let (status, _, _) = call(
        addr,
        "POST",
        "/api/remote-screen/input",
        &[("content-type", "application/json")],
        b"",
    )
    .await
    .expect("response");
    assert_eq!(status, 200);

    let (status, _, _) = call(
        addr,
        "POST",
        "/api/remote-screen/input",
        &[("content-type", "text/plain")],
        b"hello",
    )
    .await
    .expect("response");
    assert_eq!(status, 200);

    let records = requests(&log);
    assert_eq!(records.len(), 3);
    // JSON.stringify(req.body ?? {}): whitespace gone, key order kept.
    assert_eq!(records[0]["body"], r#"{"b":1,"a":2}"#);
    assert_eq!(records[0]["headers"]["content-type"], "application/json");
    let length: usize = records[0]["headers"]["content-length"]
        .as_str()
        .expect("content-length")
        .parse()
        .expect("number");
    assert_eq!(length, r#"{"b":1,"a":2}"#.len());
    // No body → `{}`; non-JSON content type → the body was never parsed.
    assert_eq!(records[1]["body"], "{}");
    assert_eq!(records[2]["body"], "{}");
    // The client's content-type is forwarded verbatim.
    assert_eq!(records[2]["headers"]["content-type"], "text/plain");
}

// The "allow auto-unlock" consent is read by multicc-remote itself
// (native/remote/src/power.rs), so this layer must not compute or send one.
// The header was the last place Rust depended on Node to work; keep it gone.
#[tokio::test]
async fn wake_carries_no_power_consent_header() {
    let dir = temp_dir("wake");
    let log = dir.join("requests.jsonl");
    let inner = child(
        "wake-child",
        &[("FIXTURE_REQUESTS_FILE", log.to_str().expect("utf8"))],
    );
    let screen = RemoteScreen::new(Arc::clone(&inner));
    let addr = serve(Arc::new(screen)).await;
    let (status, _, _) = get(addr, "/api/remote-screen/wake").await;
    assert_eq!(status, 200);
    let records = requests(&log);
    assert_eq!(
        records[0]["headers"]["x-multicc-power-consent"],
        serde_json::Value::Null
    );
    // The forward is otherwise normal: the internal secret is still injected.
    assert!(records[0]["headers"]["x-multicc-remote-secret"].is_string());
}

#[tokio::test]
async fn a_stalled_upstream_before_headers_is_unavailable() {
    let inner = child("stall-head", &[("FIXTURE_HTTP", "no-head")]);
    let screen =
        RemoteScreen::new(Arc::clone(&inner)).with_idle_timeout(Duration::from_millis(150));
    let addr = serve(Arc::new(screen)).await;
    let start = Instant::now();
    let (status, _, body) = get(addr, "/api/remote-screen/frame").await;
    assert_eq!(status, 503);
    assert_eq!(text(&body), r#"{"ok":false,"error":"remote-unavailable"}"#);
    assert!(start.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn a_stalled_upstream_after_headers_drops_the_connection() {
    let inner = child("stall-body", &[("FIXTURE_HTTP", "stall")]);
    let screen =
        RemoteScreen::new(Arc::clone(&inner)).with_idle_timeout(Duration::from_millis(150));
    let addr = serve(Arc::new(screen)).await;
    let stream = TcpStream::connect(addr).await.expect("connect");
    let (mut sender, connection) = hyper::client::conn::http1::Builder::new()
        .handshake::<_, Full<Bytes>>(TokioIo::new(stream))
        .await
        .expect("handshake");
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let request = Request::builder()
        .uri("/api/remote-screen/frame")
        .body(Full::new(Bytes::new()))
        .expect("request");
    let response = sender.send_request(request).await.expect("head");
    assert_eq!(response.status().as_u16(), 200);
    // Headers already went out, so the idle timeout must abort the body
    // instead of answering a second time.
    let outcome = response.into_body().collect().await;
    assert!(outcome.is_err());
}

#[tokio::test]
async fn a_truncated_upstream_drops_the_connection() {
    let inner = child("truncate", &[("FIXTURE_HTTP", "truncate")]);
    let addr = serve(Arc::new(RemoteScreen::new(inner))).await;
    let start = Instant::now();
    let outcome = call(addr, "GET", "/api/remote-screen/frame", &[], &[]).await;
    // A short body with a longer declared content-length is a dropped
    // connection, never a clean end.
    assert!(outcome.is_err());
    assert!(start.elapsed() < Duration::from_secs(3));
}

/// Raw socket reader for the streaming tests.
struct Raw {
    stream: TcpStream,
    buffer: Vec<u8>,
}

impl Raw {
    async fn open(addr: SocketAddr, target: &str) -> Self {
        let mut stream = TcpStream::connect(addr).await.expect("connect");
        let request = format!("GET {target} HTTP/1.1\r\nhost: test\r\n\r\n");
        use tokio::io::AsyncWriteExt;
        stream
            .write_all(request.as_bytes())
            .await
            .expect("write request");
        Self {
            stream,
            buffer: Vec::new(),
        }
    }

    async fn fill(&mut self, limit: Duration) -> bool {
        use tokio::io::AsyncReadExt;
        let mut chunk = [0u8; 4096];
        match tokio::time::timeout(limit, self.stream.read(&mut chunk)).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => false,
            Ok(Ok(read)) => {
                self.buffer.extend_from_slice(&chunk[..read]);
                true
            }
        }
    }

    fn head_ended(&self) -> bool {
        self.buffer.windows(4).any(|window| window == b"\r\n\r\n")
    }
}

#[tokio::test]
async fn the_body_is_streamed_before_the_upstream_finishes() {
    let inner = child(
        "stream",
        &[("FIXTURE_HTTP", "stream"), ("FIXTURE_CHUNK_MS", "400")],
    );
    let addr = serve(Arc::new(RemoteScreen::new(inner))).await;
    let mut raw = Raw::open(addr, "/api/remote-screen/frame").await;
    let start = Instant::now();
    while !(raw.head_ended() && text(&raw.buffer).contains("chunk-1")) {
        assert!(
            start.elapsed() < Duration::from_millis(350),
            "first chunk did not arrive early: {}",
            text(&raw.buffer)
        );
        raw.fill(Duration::from_millis(50)).await;
    }
    assert!(text(&raw.buffer).starts_with("HTTP/1.1 200"));
    // The upstream would have ended after ~800ms; the first bytes arrived well
    // before that, so nothing is being buffered.
    assert!(start.elapsed() < Duration::from_millis(350));
}

#[tokio::test]
async fn client_abort_aborts_the_upstream() {
    let dir = temp_dir("abort");
    let abort = dir.join("abort.txt");
    let inner = child(
        "abort-child",
        &[
            ("FIXTURE_HTTP", "stream"),
            ("FIXTURE_CHUNKS", "0"),
            ("FIXTURE_CHUNK_MS", "40"),
            ("FIXTURE_ABORT_FILE", abort.to_str().expect("utf8")),
        ],
    );
    let addr = serve(Arc::new(RemoteScreen::new(Arc::clone(&inner)))).await;
    let mut raw = Raw::open(addr, "/api/remote-screen/frame?mode=rfb").await;
    let start = Instant::now();
    while !(raw.head_ended() && text(&raw.buffer).contains("chunk-1")) {
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "no first chunk: {}",
            text(&raw.buffer)
        );
        raw.fill(Duration::from_millis(100)).await;
    }
    drop(raw);
    assert!(wait_file(&abort, Duration::from_secs(3)).await);
}
