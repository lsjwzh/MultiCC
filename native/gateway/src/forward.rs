//! §6: L7 forwarding.
//!
//! Each accepted client connection is served by hyper's HTTP/1 server, which
//! drives an [`axum::Router`]. Native routes answer in Rust; everything else
//! falls back to Node over **one dedicated upstream connection that belongs to
//! that client connection**: opened lazily on the first forwarded request with
//! a PROXY v1 line in front, reused for later requests, and never shared with
//! another client (src/request-locality.js trusts the socket's remote address).
//!
//! Request and response bodies are streamed frame by frame; nothing is
//! buffered. WebSocket-style upgrades are spliced: the 101 response goes back
//! to the client and both upgraded byte streams are joined with
//! `copy_bidirectional`.

use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::Extension;
use axum::http::{Request, Response, StatusCode};
use axum::routing::get;
use axum::Router;
use hyper::body::Incoming;
use hyper::client::conn::http1::{Builder as ClientBuilder, SendRequest};
use hyper::service::Service as HyperService;
use hyper_util::rt::TokioIo;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tower::Service as TowerService;

use crate::app::App;
use crate::proxy_header::format_proxy_header;

/// §6: while Node is down, retry the upstream connection every 100ms.
const UPSTREAM_RETRY: Duration = Duration::from_millis(100);

/// Test-only native route, exposed only when `MULTICC_GATEWAY_TEST_ROUTES=1`
/// (see docs/gateway.md §6). Production routers have no native routes yet.
pub const TEST_ROUTE: &str = "/__gateway_test/native";
pub const TEST_ROUTE_BODY: &str = "multicc-gateway: answered by the rust front door\n";

/// Why a forwarded request could not reach Node.
enum ForwardError {
    /// No upstream connection could be opened within the wait: answer 503.
    Unavailable,
    /// An upstream connection existed but the request could not be sent: 502.
    Failed,
}

/// One client connection's dedicated upstream connection(s) to Node.
///
/// Cloned per request through a request extension. The state is shared only
/// between requests of the same accepted client connection.
#[derive(Clone)]
pub struct UpstreamHandle {
    state: Arc<UpstreamState>,
}

struct UpstreamState {
    /// The current connection, if one is open. `None` after Node closed it, a
    /// send failed, or the connection was consumed by an upgrade.
    sender: Mutex<Option<SendRequest<Body>>>,
    /// The internal port of the Node process currently being supervised. Read
    /// per connection so a relaunch on a new port is picked up.
    port: Arc<AtomicU16>,
    /// How long to keep retrying a Node that is starting up.
    wait: Duration,
    /// The real client address and this front door's local address: the two
    /// addresses of the PROXY v1 line (§5).
    client: SocketAddr,
    local: SocketAddr,
}

impl UpstreamHandle {
    pub fn new(
        port: Arc<AtomicU16>,
        wait: Duration,
        client: SocketAddr,
        local: SocketAddr,
    ) -> Self {
        Self {
            state: Arc::new(UpstreamState {
                sender: Mutex::new(None),
                port,
                wait,
                client,
                local,
            }),
        }
    }

    /// Forwards `request` over this connection's upstream connection, opening
    /// one (or a replacement) when needed.
    async fn send(&self, request: Request<Body>) -> Result<Response<Incoming>, ForwardError> {
        let mut state = self.state.sender.lock().await;
        let mut pending = Some(request);
        // Two attempts: the second always uses a fresh connection, which is
        // what makes a keep-alive connection Node closed mid-flight recover.
        for _ in 0..2 {
            if state.is_none() {
                *state = self.open().await;
            }
            let Some(sender) = state.as_mut() else {
                return Err(ForwardError::Unavailable);
            };
            // Wait for the connection to accept another request (it is idle
            // after the previous response), or notice that Node closed it.
            if sender.ready().await.is_err() {
                *state = None;
                continue;
            }
            let Some(request) = pending.take() else {
                return Err(ForwardError::Failed);
            };
            match sender.try_send_request(request).await {
                Ok(response) => return Ok(response),
                Err(mut error) => {
                    *state = None;
                    pending = error.take_message();
                    if pending.is_none() {
                        return Err(ForwardError::Failed);
                    }
                }
            }
        }
        Err(ForwardError::Failed)
    }

    /// Drops the cached sender: the upstream connection is gone or consumed
    /// (an upgrade took its IO).
    async fn discard(&self) {
        *self.state.sender.lock().await = None;
    }

    /// §6: connect to `127.0.0.1:<port>`, write the PROXY line first, then
    /// handshake HTTP/1 (preserving header case) and spawn the connection
    /// task. Retries every 100ms until the wait expires.
    async fn open(&self) -> Option<SendRequest<Body>> {
        let deadline = Instant::now() + self.state.wait;
        loop {
            let port = self.state.port.load(Ordering::SeqCst);
            if port != 0 {
                if let Some(sender) = self.connect(port).await {
                    return Some(sender);
                }
            }
            if Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(UPSTREAM_RETRY).await;
        }
    }

    async fn connect(&self, port: u16) -> Option<SendRequest<Body>> {
        let mut stream = TcpStream::connect(SocketAddr::from(([127, 0, 0, 1], port)))
            .await
            .ok()?;
        let _ = stream.set_nodelay(true);
        let proxy = format_proxy_header(self.state.client, self.state.local);
        stream.write_all(proxy.as_bytes()).await.ok()?;
        let (sender, connection) = ClientBuilder::new()
            .preserve_header_case(true)
            .handshake::<_, Body>(TokioIo::new(stream))
            .await
            .ok()?;
        // The connection task drives the socket for every request on it (and
        // completes when Node closes the connection or it is upgraded).
        // `.with_upgrades()` is what lets a 101 response hand us the IO.
        tokio::spawn(async move {
            let _ = connection.with_upgrades().await;
        });
        Some(sender)
    }
}

/// The router driven by every accepted client connection: native routes first,
/// Node as the fallback.
pub fn native_routes(app: Arc<App>) -> Router {
    let mut router = Router::new();
    if std::env::var("MULTICC_GATEWAY_TEST_ROUTES").ok().as_deref() == Some("1") {
        router = router.route(TEST_ROUTE, get(|| async { TEST_ROUTE_BODY }));
    }
    router.fallback(dispatch).layer(Extension(app))
}

/// §8: a route the front door owns is answered here; everything else, and
/// every other method on those paths, goes to Node exactly as before.
async fn dispatch(
    Extension(upstream): Extension<UpstreamHandle>,
    Extension(app): Extension<Arc<App>>,
    request: Request<Body>,
) -> Response<Body> {
    if let Some(route) = crate::app::claim(request.method(), request.uri().path()) {
        let host = upstream.state.port.load(Ordering::SeqCst);
        return crate::app::handle(app, route, request, upstream.state.client, host).await;
    }
    forward(upstream, request).await
}

/// §6: the fallback. Streams the request to Node and the response back.
async fn forward(upstream: UpstreamHandle, mut request: Request<Body>) -> Response<Body> {
    // Taken before the request is forwarded: the upgrade belongs to the client
    // connection, not to Node's request extensions.
    let client_upgrade = hyper::upgrade::on(&mut request);
    let mut response = match upstream.send(request).await {
        Ok(response) => response,
        Err(ForwardError::Unavailable) => return error_response(StatusCode::SERVICE_UNAVAILABLE),
        Err(ForwardError::Failed) => return error_response(StatusCode::BAD_GATEWAY),
    };
    if response.status() == StatusCode::SWITCHING_PROTOCOLS {
        // §6: both sides upgraded; join the raw byte streams and let the
        // upstream connection go (its IO now belongs to the upgrade).
        let upstream_upgrade = hyper::upgrade::on(&mut response);
        upstream.discard().await;
        tokio::spawn(async move {
            let (client_io, upstream_io) = match tokio::try_join!(client_upgrade, upstream_upgrade)
            {
                Ok(pair) => pair,
                Err(_) => return,
            };
            let mut client_io = TokioIo::new(client_io);
            let mut upstream_io = TokioIo::new(upstream_io);
            let _ = tokio::io::copy_bidirectional(&mut client_io, &mut upstream_io).await;
        });
    }
    response.map(Body::new)
}

/// §6: the synthetic answer when Node cannot be reached (503) or accepted the
/// connection but not the request (502). `Connection: close` tears the client
/// connection down afterwards.
fn error_response(status: StatusCode) -> Response<Body> {
    let mut builder = Response::builder()
        .status(status)
        .header("connection", "close");
    if status == StatusCode::SERVICE_UNAVAILABLE {
        builder = builder.header("retry-after", "2");
    }
    builder.body(Body::empty()).expect("static error response")
}

/// Serves one accepted client connection: preserve header case, keep-alive on,
/// upgrades enabled.
pub async fn serve_connection(stream: TcpStream, router: Router, upstream: UpstreamHandle) {
    let mut builder = hyper::server::conn::http1::Builder::new();
    builder.preserve_header_case(true);
    let service = ConnectionService { router, upstream };
    // `.with_upgrades()` lets a 101 response hand the raw socket over.
    let _ = builder
        .serve_connection(TokioIo::new(stream), service)
        .with_upgrades()
        .await;
}

/// hyper's service for one client connection: injects the per-connection
/// upstream handle into every request, then runs the router.
#[derive(Clone)]
struct ConnectionService {
    router: Router,
    upstream: UpstreamHandle,
}

impl HyperService<Request<Incoming>> for ConnectionService {
    type Response = Response<Body>;
    type Error = Infallible;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn call(&self, request: Request<Incoming>) -> Self::Future {
        let mut request = request.map(Body::new);
        request.extensions_mut().insert(self.upstream.clone());
        let mut router = self.router.clone();
        Box::pin(async move {
            match TowerService::call(&mut router, request).await {
                Ok(response) => Ok(response),
                Err(never) => match never {},
            }
        })
    }
}
