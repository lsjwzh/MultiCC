//! A service request owns its upstream socket. Cancellation drops the driver;
//! upgrades transfer that ownership to the bidirectional tunnel. No retries of
//! bodies, pooling across callers, decompression, or automatic redirects.
use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, Request, Response, Uri},
};
use hyper::{
    body::{Bytes, Frame, Incoming, SizeHint},
    client::conn::http1,
};
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder};
use hyper_util::{client::legacy::connect::HttpConnector, rt::TokioIo};
use std::{
    future::Future,
    io,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    task::JoinHandle,
    time::{Instant, Sleep},
};
use tower::Service;
use url::Url;

const IDLE: Duration = Duration::from_secs(120);
#[derive(Clone)]
pub struct Transport(HttpsConnector<HttpConnector>);
impl Transport {
    pub fn new() -> io::Result<Self> {
        use rustls::pki_types::{pem::PemObject, CertificateDer};
        let mut roots = rustls::RootCertStore::empty();
        roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
        // Preserve the Node service proxy's extra-CA setting. A bad extra file
        // is ignored with a warning, never by disabling certificate validation.
        if let Some(file) = std::env::var_os("NODE_EXTRA_CA_CERTS").filter(|p| !p.is_empty()) {
            match std::fs::read(file) {
                Ok(pem) => {
                    roots.add_parsable_certificates(
                        CertificateDer::pem_slice_iter(&pem).filter_map(Result::ok),
                    );
                }
                Err(_) => eprintln!("[gateway] service proxy could not load NODE_EXTRA_CA_CERTS"),
            }
        }
        let tls = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        Ok(Self(
            HttpsConnectorBuilder::new()
                .with_tls_config(tls)
                .https_or_http()
                .enable_http1()
                .build(),
        ))
    }

    pub async fn forward(
        &self,
        mut request: Request<Body>,
        target: &Url,
        prefix: &str,
        suffix: &str,
        ws: bool,
    ) -> Result<Response<Body>, ()> {
        let client_upgrade = hyper::upgrade::on(&mut request);
        let host = &target[url::Position::BeforeHost..url::Position::AfterPort];
        let origin: Uri = format!("{}://{host}/", target.scheme())
            .parse()
            .map_err(|_| ())?;
        let path = format!(
            "{}{suffix}",
            target.path().strip_suffix('/').unwrap_or(target.path())
        );
        *request.uri_mut() = path.parse().map_err(|_| ())?;
        // Clone the original Host before removing hop-by-hop and private headers.
        let original_host = request
            .headers()
            .get("host")
            .cloned()
            .unwrap_or(HeaderValue::from_static(""));
        let mut headers = clean_headers(request.headers());
        headers.insert("host", host.parse().map_err(|_| ())?);
        headers.insert("x-forwarded-host", original_host);
        // The gateway currently accepts plain HTTP only, just like Node's socket.
        headers.insert("x-forwarded-proto", HeaderValue::from_static("http"));
        headers.insert("x-forwarded-prefix", prefix.parse().map_err(|_| ())?);
        headers.insert("x-multicc-service-hop", HeaderValue::from_static("1"));
        if ws {
            headers.insert("connection", HeaderValue::from_static("Upgrade"));
            headers.insert("upgrade", HeaderValue::from_static("websocket"));
        }
        *request.headers_mut() = headers;
        let stream = tokio::time::timeout(IDLE, self.0.clone().call(origin))
            .await
            .map_err(|_| ())?
            .map_err(|_| ())?;
        let upgraded = Arc::new(AtomicBool::new(false));
        let stream = IdleIo {
            inner: TokioIo::new(stream),
            deadline: Box::pin(tokio::time::sleep(IDLE)),
            upgraded: upgraded.clone(),
        };
        let (mut sender, conn) = http1::Builder::new()
            .preserve_header_case(true)
            .handshake::<_, Body>(TokioIo::new(stream))
            .await
            .map_err(|_| ())?;
        let guard = Driver(tokio::spawn(async move {
            let _ = conn.with_upgrades().await;
        }));
        let mut response = sender.send_request(request).await.map_err(|_| ())?;
        if ws {
            if response.status() != 101 {
                return Err(());
            }
            upgraded.store(true, Ordering::Relaxed);
            let upstream_upgrade = hyper::upgrade::on(&mut response);
            tokio::spawn(async move {
                let _guard = guard;
                if let Ok((client, upstream)) = tokio::try_join!(client_upgrade, upstream_upgrade) {
                    // Closing either half closes both streams; do not leave a
                    // half-closed service socket waiting indefinitely for EOF.
                    let (mut client, mut upstream) = (TokioIo::new(client), TokioIo::new(upstream));
                    let (mut cr, mut cw) = tokio::io::split(&mut client);
                    let (mut ur, mut uw) = tokio::io::split(&mut upstream);
                    tokio::select! { _ = tokio::io::copy(&mut cr, &mut uw) => {}, _ = tokio::io::copy(&mut ur, &mut cw) => {} }
                }
            });
            let mut headers = clean_headers(response.headers());
            headers.remove("set-cookie");
            headers.insert("connection", HeaderValue::from_static("Upgrade"));
            headers.insert("upgrade", HeaderValue::from_static("websocket"));
            let (mut parts, _) = response.into_parts();
            parts.headers = headers;
            return Ok(Response::from_parts(parts, Body::empty()));
        }
        // An unsolicited upgrade is never handed to an ordinary HTTP client.
        if response.status() == 101 {
            return Err(());
        }
        let mut headers = clean_headers(response.headers());
        headers.insert("cache-control", HeaderValue::from_static("no-store"));
        let cookies: Vec<_> = headers
            .get_all("set-cookie")
            .iter()
            .filter_map(|v| {
                let text = latin1(v.as_bytes());
                if text
                    .trim_start()
                    .to_ascii_lowercase()
                    .starts_with("multicc_")
                {
                    return None;
                }
                let pieces: Vec<_> = text
                    .split(';')
                    .enumerate()
                    .filter_map(|(i, part)| {
                        let trimmed = part.trim_start().to_ascii_lowercase();
                        (i == 0
                            || !(trimmed.starts_with("path=") || trimmed.starts_with("domain=")))
                        .then_some(part)
                    })
                    .collect();
                bytes_header(&format!("{}; Path={prefix}/", pieces.join(";")))
            })
            .collect();
        headers.remove("set-cookie");
        for cookie in cookies {
            headers.append("set-cookie", cookie);
        }
        if let Some(raw) = headers.get("location") {
            let base = target.path().strip_suffix('/').unwrap_or(target.path());
            let reference = format!("{}{base}{suffix}", target.origin().ascii_serialization());
            match Url::parse(&reference).and_then(|u| u.join(&latin1(raw.as_bytes()))) {
                Ok(location)
                    if location.origin() == target.origin()
                        && (location.path() == base
                            || location.path().starts_with(&format!("{base}/"))) =>
                {
                    let tail = &location.path()[base.len()..];
                    let relative = format!(
                        "{prefix}{}{}{}",
                        if tail.is_empty() { "/" } else { tail },
                        location
                            .query()
                            .filter(|v| !v.is_empty())
                            .map(|q| format!("?{q}"))
                            .unwrap_or_default(),
                        location
                            .fragment()
                            .filter(|v| !v.is_empty())
                            .map(|h| format!("#{h}"))
                            .unwrap_or_default()
                    );
                    if let Some(value) = bytes_header(&relative) {
                        headers.insert("location", value);
                    }
                }
                Err(_) => {
                    headers.remove("location");
                }
                _ => {}
            }
        }
        let (mut parts, body) = response.into_parts();
        parts.headers = headers;
        Ok(Response::from_parts(
            parts,
            Body::new(DrivenBody {
                body,
                _driver: guard,
            }),
        ))
    }
}

fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|b| char::from(*b)).collect()
}
fn bytes_header(text: &str) -> Option<HeaderValue> {
    let bytes: Option<Vec<u8>> = text.chars().map(|c| u8::try_from(c as u32).ok()).collect();
    HeaderValue::from_bytes(&bytes?).ok()
}

pub fn clean_headers(source: &HeaderMap) -> HeaderMap {
    let mut headers = source.clone();
    let connection: Vec<_> = source
        .get_all("connection")
        .iter()
        .flat_map(|v| {
            latin1(v.as_bytes())
                .split(',')
                .map(|v| v.trim().to_ascii_lowercase())
                .collect::<Vec<_>>()
        })
        .collect();
    for key in connection {
        headers.remove(key);
    }
    for key in [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ] {
        headers.remove(key);
    }
    let private: Vec<_> = headers
        .keys()
        .filter(|key| {
            key.as_str().starts_with("x-multicc-")
                || key.as_str().starts_with("x-forwarded-")
                || matches!(key.as_str(), "x-access-token" | "forwarded")
        })
        .cloned()
        .collect();
    for key in private {
        headers.remove(key);
    }
    if headers.contains_key("cookie") {
        let raw = headers
            .get_all("cookie")
            .iter()
            .map(|v| latin1(v.as_bytes()))
            .collect::<Vec<_>>()
            .join("; ");
        let cookie = raw
            .split(';')
            .filter(|part| {
                !part
                    .trim_start()
                    .to_ascii_lowercase()
                    .starts_with("multicc_")
            })
            .collect::<Vec<_>>()
            .join(";");
        headers.remove("cookie");
        if !cookie.is_empty() {
            if let Some(v) = bytes_header(&cookie) {
                headers.insert("cookie", v);
            }
        }
    }
    headers
}

struct Driver(JoinHandle<()>);
impl Drop for Driver {
    fn drop(&mut self) {
        self.0.abort();
    }
}
struct DrivenBody {
    body: Incoming,
    _driver: Driver,
}
impl http_body::Body for DrivenBody {
    type Data = Bytes;
    type Error = hyper::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, hyper::Error>>> {
        Pin::new(&mut self.body).poll_frame(cx)
    }
    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}

struct IdleIo<S> {
    inner: S,
    deadline: Pin<Box<Sleep>>,
    upgraded: Arc<AtomicBool>,
}
impl<S> IdleIo<S> {
    fn timed_out(&mut self, cx: &mut Context<'_>) -> bool {
        !self.upgraded.load(Ordering::Relaxed) && self.deadline.as_mut().poll(cx).is_ready()
    }
    fn activity(&mut self) {
        self.deadline.as_mut().reset(Instant::now() + IDLE);
    }
}
impl<S: AsyncRead + Unpin> AsyncRead for IdleIo<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.timed_out(cx) {
            return Poll::Ready(Err(io::ErrorKind::TimedOut.into()));
        }
        let before = buf.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(cx, buf);
        if buf.filled().len() > before {
            self.activity();
        }
        result
    }
}
impl<S: AsyncWrite + Unpin> AsyncWrite for IdleIo<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.timed_out(cx) {
            return Poll::Ready(Err(io::ErrorKind::TimedOut.into()));
        }
        let result = Pin::new(&mut self.inner).poll_write(cx, buf);
        if matches!(result, Poll::Ready(Ok(n)) if n > 0) {
            self.activity();
        }
        result
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}
