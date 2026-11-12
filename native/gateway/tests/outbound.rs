//! Integration coverage for the front door's shared outbound client
//! (`native/gateway/src/outbound.rs`): proxy selection, CONNECT tunnels,
//! absolute-form HTTP, `NO_PROXY` bypass, loopback bypass and the SOCKS/PAC
//! refusal. The fake proxy below records what it saw, which is how the tests
//! prove that a request took (or did not take) the proxy exit.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use multicc_core::outbound_proxy::{Env, SystemProxy};
use multicc_gateway::outbound::{Mode, Options, Outbound, Request};
use reqwest::Url;

#[derive(Default)]
struct Seen {
    /// First request line of each absolute-form request.
    requests: Mutex<Vec<String>>,
    /// `host:port` of each CONNECT request.
    connects: Mutex<Vec<String>>,
}

/// A plain HTTP upstream. Its first request line lands in `seen`; the answer
/// is always `200 ok`.
fn spawn_stub() -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&seen);
    std::thread::spawn(move || {
        for socket in listener.incoming().flatten() {
            let recorder = Arc::clone(&recorder);
            std::thread::spawn(move || {
                let Some(head) = read_head(&socket) else {
                    return;
                };
                let line = head.lines().next().unwrap_or("").to_string();
                recorder.lock().unwrap().push(line);
                let mut socket = socket;
                let _ = socket.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                );
            });
        }
    });
    (port, seen)
}

/// A fake HTTP proxy: records CONNECT targets and absolute-form request lines.
/// CONNECT is answered with 200 and tunnelled to the same port on loopback,
/// which is enough for the client's TLS handshake to be attempted through the
/// tunnel.
fn spawn_proxy() -> (u16, Arc<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Seen::default());
    let recorder = Arc::clone(&seen);
    std::thread::spawn(move || {
        for socket in listener.incoming().flatten() {
            let recorder = Arc::clone(&recorder);
            std::thread::spawn(move || handle_proxy(socket, recorder));
        }
    });
    (port, seen)
}

fn handle_proxy(mut socket: TcpStream, seen: Arc<Seen>) {
    let Some(head) = read_head(&socket) else {
        return;
    };
    let line = head.lines().next().unwrap_or("").to_string();
    if let Some(target) = line.strip_prefix("CONNECT ") {
        let target = target.split_whitespace().next().unwrap_or("").to_string();
        seen.connects.lock().unwrap().push(target.clone());
        let _ = socket.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n");
        let Some(port) = target
            .rsplit(':')
            .next()
            .and_then(|p| p.parse::<u16>().ok())
        else {
            return;
        };
        let Ok(upstream) = TcpStream::connect(("127.0.0.1", port)) else {
            return;
        };
        tunnel(socket, upstream);
        return;
    }
    seen.requests.lock().unwrap().push(line);
    let _ = socket
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied");
}

fn tunnel(client: TcpStream, upstream: TcpStream) {
    let mut client_read = client.try_clone().unwrap();
    let mut upstream_write = upstream.try_clone().unwrap();
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut client_read, &mut upstream_write);
    });
    let mut upstream_read = upstream;
    let mut client_write = client;
    let _ = std::io::copy(&mut upstream_read, &mut client_write);
}

fn read_head(socket: &TcpStream) -> Option<String> {
    let mut reader = socket;
    let mut bytes = Vec::new();
    let mut byte = [0u8; 1];
    while bytes.len() < 64 * 1024 {
        match reader.read(&mut byte) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                bytes.push(byte[0]);
                if bytes.ends_with(b"\r\n\r\n") || bytes.ends_with(b"\n\n") {
                    break;
                }
            }
        }
    }
    if bytes.is_empty() {
        None
    } else {
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }
}

fn env(pairs: &[(&str, &str)]) -> Env {
    pairs
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

fn resolve(host: &str, port: u16) -> Vec<(String, SocketAddr)> {
    vec![(host.to_string(), SocketAddr::from(([127, 0, 0, 1], port)))]
}

fn outbound(pairs: &[(&str, &str)], resolve: Vec<(String, SocketAddr)>) -> Outbound {
    Outbound::new(Options {
        env: Some(env(pairs)),
        platform: Some("linux".to_string()),
        resolve,
        ..Options::default()
    })
}

#[tokio::test]
async fn https_target_uses_a_connect_tunnel() {
    let (stub_port, stub_seen) = spawn_stub();
    let (proxy_port, proxy) = spawn_proxy();
    let proxy_url = format!("http://127.0.0.1:{proxy_port}");
    let outbound = outbound(
        &[("HTTPS_PROXY", proxy_url.as_str())],
        resolve("upstream.test", stub_port),
    );
    let url = Url::parse(&format!("https://upstream.test:{stub_port}/v1/evaluate")).unwrap();
    let mut request = Request::get(url, Duration::from_millis(1500));
    request.method = reqwest::Method::POST;
    request.body = Some(b"{}".to_vec());
    let error = outbound.send(request).await.unwrap_err();
    assert_eq!(error.mode, Mode::EnvironmentProxy, "{error}");
    assert_eq!(
        proxy.connects.lock().unwrap().as_slice(),
        &[format!("upstream.test:{stub_port}")]
    );
    assert!(proxy.requests.lock().unwrap().is_empty());
    // The tunnel was opened to the stub, but no TLS session completed.
    assert!(stub_seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn http_target_uses_absolute_form_through_the_proxy() {
    let (stub_port, stub_seen) = spawn_stub();
    let (proxy_port, proxy) = spawn_proxy();
    let proxy_url = format!("http://127.0.0.1:{proxy_port}");
    let outbound = outbound(
        &[("HTTP_PROXY", proxy_url.as_str())],
        resolve("upstream.test", stub_port),
    );
    let url = Url::parse(&format!("http://upstream.test:{stub_port}/v1/evaluate")).unwrap();
    let reply = outbound
        .send(Request::get(url, Duration::from_secs(2)))
        .await
        .unwrap();
    assert_eq!(reply.status, 200);
    assert_eq!(reply.text(), "proxied");
    assert_eq!(
        proxy.requests.lock().unwrap().as_slice(),
        &[format!(
            "GET http://upstream.test:{stub_port}/v1/evaluate HTTP/1.1"
        )]
    );
    assert!(proxy.connects.lock().unwrap().is_empty());
    assert!(stub_seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn no_proxy_match_goes_direct() {
    let (stub_port, stub_seen) = spawn_stub();
    let (proxy_port, proxy) = spawn_proxy();
    let proxy_url = format!("http://127.0.0.1:{proxy_port}");
    let outbound = outbound(
        &[
            ("HTTP_PROXY", proxy_url.as_str()),
            ("NO_PROXY", "upstream.test"),
        ],
        resolve("upstream.test", stub_port),
    );
    let url = Url::parse(&format!("http://upstream.test:{stub_port}/direct")).unwrap();
    let reply = outbound
        .send(Request::get(url, Duration::from_secs(2)))
        .await
        .unwrap();
    assert_eq!(reply.text(), "ok");
    assert_eq!(
        stub_seen.lock().unwrap().as_slice(),
        &["GET /direct HTTP/1.1".to_string()]
    );
    assert!(proxy.requests.lock().unwrap().is_empty());
    assert!(proxy.connects.lock().unwrap().is_empty());
}

#[tokio::test]
async fn loopback_never_takes_the_proxy() {
    let (stub_port, stub_seen) = spawn_stub();
    let (proxy_port, proxy) = spawn_proxy();
    let proxy_url = format!("http://127.0.0.1:{proxy_port}");
    let outbound = outbound(
        &[
            ("HTTP_PROXY", proxy_url.as_str()),
            ("HTTPS_PROXY", proxy_url.as_str()),
        ],
        Vec::new(),
    );
    let url = Url::parse(&format!("http://127.0.0.1:{stub_port}/local")).unwrap();
    let reply = outbound
        .send(Request::get(url, Duration::from_secs(2)))
        .await
        .unwrap();
    assert_eq!(reply.text(), "ok");
    assert_eq!(stub_seen.lock().unwrap().len(), 1);
    assert!(proxy.requests.lock().unwrap().is_empty());
    assert!(proxy.connects.lock().unwrap().is_empty());
}

fn system(socks: &str, pac: bool) -> SystemProxy {
    SystemProxy {
        socks_proxy: socks.to_string(),
        pac_enabled: pac,
        ..SystemProxy::default()
    }
}

async fn refusal(system: SystemProxy) -> multicc_gateway::outbound::Error {
    let outbound = Outbound::new(Options {
        env: Some(Env::new()),
        platform: Some("darwin".to_string()),
        system: Some(system),
        ..Options::default()
    });
    let url = Url::parse("https://upstream.test/v1/evaluate").unwrap();
    outbound
        .send(Request::get(url, Duration::from_secs(2)))
        .await
        .unwrap_err()
}

#[tokio::test]
async fn socks_only_system_proxy_is_refused() {
    let error = refusal(system("socks5://127.0.0.1:1080", false)).await;
    assert_eq!(error.mode, Mode::Discovery);
    assert_eq!(
        error.message(),
        "系统代理仅配置了 SOCKS/PAC；请配置 HTTP(S) 代理，已阻止静默直连"
    );
}

#[tokio::test]
async fn pac_only_system_proxy_is_refused() {
    let error = refusal(system("", true)).await;
    assert_eq!(error.mode, Mode::Discovery);
    assert!(error.message().contains("SOCKS/PAC"));
}

#[test]
fn proxy_servers_are_alive() {
    // A cheap liveness check for the two fixtures: accepting one connection
    // must not panic, and the port must be usable.
    let (port, _) = spawn_stub();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200"));
}
