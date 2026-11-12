//! The front door's one outbound HTTP client, behind the same proxy policy
//! the Node runtime uses (`src/network/outbound.js` over
//! `src/network/proxy-policy.js`; the pure rules are
//! [`multicc_core::outbound_proxy`]).
//!
//! The retired Node routes called `fetch` / `outboundFetch`, which selects an
//! exit per request: loopback stays direct, `NO_PROXY` entries stay direct,
//! everything else takes the HTTP(S) proxy from the environment or (on macOS)
//! from `scutil --proxy`. A diagnostic call that ignored that policy would
//! report a false failure on every machine that needs a proxy to reach the
//! internet, so the decision lives here instead of inside one route.
//!
//! Transport is `reqwest` (rustls with native roots plus
//! `NODE_EXTRA_CA_CERTS`): HTTPS targets go through a CONNECT tunnel and HTTP
//! targets use absolute-form when a proxy is selected, which is exactly what
//! `Proxy::all` produces. The system-proxy read keeps Node's budget (2s, 32KiB)
//! and its 30s cache; a failed read preserves the last known policy and never
//! silently falls back to a direct connection. Errors carry the
//! [`Mode`] that was in force, the counterpart of Node's
//! `error.multiccProxyMode`.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::Duration;

use multicc_core::outbound_proxy::{self, Cache, Env, ProxyConfig, ProxyError, SystemProxy};
use reqwest::{Client, Method, Url};
use tokio::sync::Mutex as AsyncMutex;

/// `execFile('/usr/sbin/scutil', ['--proxy'], { timeout: 2000, maxBuffer: 32768 })`.
const SCUTIL_TIMEOUT: Duration = Duration::from_secs(2);
const SCUTIL_MAX_OUTPUT: usize = 32768;
/// `createProxyPolicy`'s default `refreshMs`.
pub const SYSTEM_REFRESH_MS: i64 = 30_000;
/// `fetch`'s redirect ceiling (undici's default is 20).
const MAX_REDIRECTS: usize = 20;
/// One client per exit; the cache is bounded because the policy can change.
const MAX_CLIENTS: usize = 16;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Node's `error.multiccProxyMode` values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// The policy had not answered yet when the request failed.
    Discovery,
    Direct,
    EnvironmentProxy,
    SystemProxy,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Discovery => "proxy-discovery",
            Mode::Direct => "direct",
            Mode::EnvironmentProxy => "environment-proxy",
            Mode::SystemProxy => "system-proxy",
        }
    }

    fn from_config(config: &ProxyConfig) -> Mode {
        match config.mode {
            "environment-proxy" => Mode::EnvironmentProxy,
            "system-proxy" => Mode::SystemProxy,
            _ => Mode::Direct,
        }
    }
}

/// Why the request failed. Callers map this onto their route's public codes;
/// the detailed text never leaves the process.
#[derive(Debug)]
pub enum Kind {
    /// Proxy discovery/validation failed before any request was sent.
    Policy(ProxyError),
    Timeout,
    Network(String),
    TooLarge,
}

/// A failed outbound request plus the proxy mode that was in force.
#[derive(Debug)]
pub struct Error {
    pub mode: Mode,
    pub kind: Kind,
}

impl Error {
    fn new(mode: Mode, kind: Kind) -> Self {
        Self { mode, kind }
    }

    /// Node's abort timer maps to `jev_timeout`; a connection refused, DNS
    /// failure or proxy rejection maps to `jev_network`.
    pub fn is_timeout(&self) -> bool {
        matches!(self.kind, Kind::Timeout)
    }

    pub fn message(&self) -> String {
        match &self.kind {
            Kind::Policy(error) => error.to_string(),
            Kind::Timeout => "outbound request timed out".to_string(),
            Kind::Network(detail) => detail.clone(),
            Kind::TooLarge => "outbound response exceeded the size limit".to_string(),
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} (proxy mode {})",
            self.message(),
            self.mode.as_str()
        )
    }
}

impl std::error::Error for Error {}

/// Constructor inputs. The defaults read the process environment; tests inject
/// a deterministic environment, platform, DNS map and system-proxy snapshot.
#[derive(Default)]
pub struct Options {
    /// Defaults to [`outbound_proxy::env_from_process`].
    pub env: Option<Env>,
    /// Defaults to the host platform (`darwin` enables system discovery).
    pub platform: Option<String>,
    /// Discovery TTL; defaults to [`SYSTEM_REFRESH_MS`].
    pub refresh_ms: Option<i64>,
    /// Name overrides so a test can point a public-looking host at loopback.
    pub resolve: Vec<(String, SocketAddr)>,
    /// A pre-seeded "last known" system proxy, as if a read had just
    /// succeeded. Tests use it to cover the SOCKS/PAC refusal without
    /// `scutil`.
    pub system: Option<SystemProxy>,
    /// PEM bundle consulted in addition to the native roots. `None` means
    /// "read `NODE_EXTRA_CA_CERTS` like Node"; an explicit empty bundle means
    /// no extra root.
    pub extra_ca_pem: Option<Vec<u8>>,
}

/// One request. `timeout` is the whole exchange (connect, redirects, body),
/// the counterpart of `AbortSignal.timeout`.
pub struct Request {
    pub method: Method,
    pub url: Url,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    pub timeout: Duration,
    pub follow_redirects: bool,
    pub max_body: Option<usize>,
}

impl Request {
    pub fn get(url: Url, timeout: Duration) -> Self {
        Self {
            method: Method::GET,
            url,
            headers: Vec::new(),
            body: None,
            timeout,
            follow_redirects: false,
            max_body: None,
        }
    }
}

/// A buffered response. The routes here read JSON or text, never stream.
#[derive(Debug)]
pub struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

pub struct Outbound {
    env: Env,
    platform: String,
    refresh_ms: i64,
    /// The shared policy slot: last system-proxy value and its stamp.
    policy: Mutex<Cache>,
    /// One `scutil` read at a time, like Node's single-flight `pending`.
    discovery: AsyncMutex<()>,
    clients: Mutex<HashMap<String, Client>>,
    resolve: Vec<(String, SocketAddr)>,
    extra_ca: Vec<reqwest::Certificate>,
}

impl Outbound {
    /// The production client: process environment, host platform, Node's
    /// extra root certificates.
    pub fn from_process() -> Self {
        Self::new(Options::default())
    }

    pub fn new(options: Options) -> Self {
        let env = options.env.unwrap_or_else(outbound_proxy::env_from_process);
        let platform = options
            .platform
            .unwrap_or_else(|| std::env::consts::OS.to_string());
        let extra_pem = match options.extra_ca_pem {
            Some(pem) => pem,
            None => std::env::var_os("NODE_EXTRA_CA_CERTS")
                .filter(|path| !path.is_empty())
                .and_then(|path| std::fs::read(path).ok())
                .unwrap_or_default(),
        };
        // A malformed bundle is ignored, like the retired handlers.
        let extra_ca = reqwest::Certificate::from_pem_bundle(&extra_pem).unwrap_or_default();
        let mut cache = Cache {
            slot: outbound_proxy::SystemSlot::default(),
            refresh_ms: options.refresh_ms.unwrap_or(SYSTEM_REFRESH_MS),
        };
        if let Some(system) = options.system {
            cache.slot.store(system, now_ms());
        }
        Self {
            env,
            platform,
            refresh_ms: cache.refresh_ms,
            policy: Mutex::new(cache),
            discovery: AsyncMutex::new(()),
            clients: Mutex::new(HashMap::new()),
            resolve: options.resolve,
            extra_ca,
        }
    }

    /// `policy.proxyForUrl`: loopback before discovery, then the cached
    /// configuration; an empty string means a direct connection.
    pub async fn proxy_for_url(&self, url: &Url) -> Result<String, Error> {
        if loopback(url) {
            return Ok(String::new());
        }
        let config = self
            .configuration()
            .await
            .map_err(|kind| Error::new(Mode::Discovery, kind))?;
        Ok(outbound_proxy::proxy_of(&config, url))
    }

    /// Send one request through the policy. Redirects are re-evaluated hop by
    /// hop, like undici's routing dispatcher.
    pub async fn send(&self, request: Request) -> Result<Reply, Error> {
        let mut mode = if loopback(&request.url) {
            Mode::Direct
        } else {
            Mode::Discovery
        };
        let outcome =
            tokio::time::timeout(request.timeout, self.exchange(&request, &mut mode)).await;
        match outcome {
            Ok(Ok(reply)) => Ok(reply),
            Ok(Err(kind)) => Err(Error::new(mode, kind)),
            Err(_) => Err(Error::new(mode, Kind::Timeout)),
        }
    }

    async fn exchange(&self, request: &Request, mode: &mut Mode) -> Result<Reply, Kind> {
        let mut url = request.url.clone();
        let mut method = request.method.clone();
        let mut body = request.body.clone();
        let mut headers = request.headers.clone();
        for _hop in 0..=MAX_REDIRECTS {
            let proxy = if loopback(&url) {
                *mode = Mode::Direct;
                String::new()
            } else {
                let config = self.configuration().await?;
                *mode = Mode::from_config(&config);
                outbound_proxy::proxy_of(&config, &url)
            };
            let client = self.client(&proxy)?;
            let mut builder = client.request(method.clone(), url.clone());
            for (name, value) in &headers {
                builder = builder.header(name, value);
            }
            if let Some(body) = &body {
                builder = builder.body(body.clone());
            }
            let response = builder.send().await.map_err(map_reqwest)?;
            let status = response.status().as_u16();
            let location = if request.follow_redirects && follows(status) {
                response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string)
            } else {
                None
            };
            let Some(location) = location else {
                let bytes = response.bytes().await.map_err(map_reqwest)?;
                if matches!(request.max_body, Some(cap) if bytes.len() > cap) {
                    return Err(Kind::TooLarge);
                }
                return Ok(Reply {
                    status,
                    body: bytes.to_vec(),
                });
            };
            // `new URL(location, url)`: an unusable target behaves like a
            // transport failure, which is how fetch reports it.
            let next = url
                .join(&location)
                .map_err(|_| Kind::Network("invalid redirect location".to_string()))?;
            if !same_origin(&url, &next) {
                // Fetch drops credentials when the redirect leaves the origin.
                headers.retain(|(name, _)| {
                    !name.eq_ignore_ascii_case("authorization")
                        && !name.eq_ignore_ascii_case("cookie")
                        && !name.eq_ignore_ascii_case("proxy-authorization")
                });
            }
            // 303 always becomes GET; 301/302 rewrite POST. 307/308 keep the
            // method and body.
            if status == 303 || ((status == 301 || status == 302) && method == Method::POST) {
                method = Method::GET;
                body = None;
                headers.retain(|(name, _)| {
                    !name.eq_ignore_ascii_case("content-length")
                        && !name.eq_ignore_ascii_case("content-type")
                        && !name.eq_ignore_ascii_case("content-encoding")
                        && !name.eq_ignore_ascii_case("content-language")
                        && !name.eq_ignore_ascii_case("content-location")
                });
            }
            url = next;
        }
        Err(Kind::Network("too many redirects".to_string()))
    }

    /// `configuration()`: read `scutil` on darwin when the environment carries
    /// no proxy variables and the cached value is past its TTL.
    async fn configuration(&self) -> Result<ProxyConfig, Kind> {
        let due = self.platform == "darwin"
            && !outbound_proxy::has_proxy_env(&self.env)
            && self
                .policy
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .slot
                .due(now_ms(), self.refresh_ms);
        if due {
            // Node shared one in-flight `pending` read; re-check after taking
            // the turn because the previous holder may have just refreshed.
            let _guard = self.discovery.lock().await;
            let due = self
                .policy
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .slot
                .due(now_ms(), self.refresh_ms);
            if due {
                let read = read_mac_system_proxy().await;
                // The stamp is taken after the read, like the JavaScript.
                self.policy
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .accept(now_ms(), read)
                    .map_err(Kind::Policy)?;
            }
        }
        let policy = self
            .policy
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        outbound_proxy::resolve_proxy_config(&self.env, policy.slot.value.as_ref())
            .map_err(Kind::Policy)
    }

    /// One client per exit (direct or one proxy URL). Direct is explicit:
    /// `.no_proxy()` also disables reqwest's own system-proxy discovery, so
    /// the only decision is the one made above.
    fn client(&self, proxy: &str) -> Result<Client, Kind> {
        let key = if proxy.is_empty() {
            "direct".to_string()
        } else {
            proxy.to_string()
        };
        if let Some(client) = self
            .clients
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&key)
        {
            return Ok(client.clone());
        }
        let mut builder = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT);
        for (host, address) in &self.resolve {
            builder = builder.resolve(host, *address);
        }
        for certificate in &self.extra_ca {
            builder = builder.add_root_certificate(certificate.clone());
        }
        if !proxy.is_empty() {
            builder = builder.proxy(
                reqwest::Proxy::all(proxy)
                    .map_err(|error| Kind::Network(format!("proxy address rejected: {error}")))?,
            );
        }
        let client = builder
            .build()
            .map_err(|error| Kind::Network(format!("outbound client: {error}")))?;
        let mut clients = self
            .clients
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if clients.len() >= MAX_CLIENTS {
            clients.clear();
        }
        clients.insert(key, client.clone());
        Ok(client)
    }
}

fn loopback(url: &Url) -> bool {
    outbound_proxy::is_loopback(url.host_str().unwrap_or(""))
}

fn follows(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn map_reqwest(error: reqwest::Error) -> Kind {
    if error.is_timeout() {
        Kind::Timeout
    } else {
        Kind::Network(error.to_string())
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// `readMacSystemProxy`: a 2s deadline and a 32KiB ceiling; failures are
/// errors so the caller can preserve the last known policy. Shared with the
/// subscription route's own policy slot.
pub async fn read_mac_system_proxy() -> Result<SystemProxy, ProxyError> {
    let output = tokio::time::timeout(
        SCUTIL_TIMEOUT,
        tokio::process::Command::new("/usr/sbin/scutil")
            .arg("--proxy")
            .kill_on_drop(true)
            .output(),
    )
    .await;
    match output {
        Ok(Ok(output)) if output.status.success() && output.stdout.len() <= SCUTIL_MAX_OUTPUT => {
            Ok(outbound_proxy::parse_mac_system_proxy(
                &String::from_utf8_lossy(&output.stdout),
            ))
        }
        _ => Err(ProxyError("system proxy discovery failed")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_targets_are_recognised_before_discovery() {
        for text in [
            "http://127.0.0.1:3000/x",
            "http://localhost:3000/x",
            "https://[::1]:3000/x",
        ] {
            assert!(loopback(&Url::parse(text).unwrap()), "{text}");
        }
        assert!(!loopback(&Url::parse("https://jev.example/x").unwrap()));
    }

    #[test]
    fn modes_use_the_javascript_names() {
        assert_eq!(Mode::Discovery.as_str(), "proxy-discovery");
        assert_eq!(Mode::Direct.as_str(), "direct");
        assert_eq!(Mode::EnvironmentProxy.as_str(), "environment-proxy");
        assert_eq!(Mode::SystemProxy.as_str(), "system-proxy");
    }
}
