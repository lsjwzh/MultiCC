//! Integration coverage for the rule-only static-asset routes retired from
//! `src/routes/static-assets.js` and answered by the Rust front door
//! (`native/gateway/src/app/static_assets_routes.rs`, kernel
//! `native/core/src/static_assets_routes.rs`):
//!
//!   GET|HEAD  /manage  /manage.html        -> 302 /air?view=…
//!   GET|HEAD  /dashboard  /dashboard.html  -> 302 /air?view=overview…
//!   GET|HEAD  /air  /air.html?view=planner -> 302 /air?view=overview…
//!   GET|HEAD  *.{apk,ipa}                  -> 404 Cache-Control: no-store
//!
//! Everything else the Node module mounts stays on Node. The Node process here
//! is only the protocol fixture (PROXY v1 + auth control): unknown paths answer
//! `ok` and every request lands in `requests.log`, which is how the fallback
//! assertions prove a request was forwarded. The byte-for-byte comparison with
//! the frozen Node module lives in
//! `docs/rust-migration/differential/static-assets-routes.js`.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

const GATEWAY_BIN: &str = env!("CARGO_BIN_EXE_multicc-gateway");
const FIXTURE_JS: &str = include_str!("fixtures/upstream.js");
const TOKEN: &str = "secret-token-1";

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-static-assets-{}-{tag}-{nanos}",
        std::process::id()
    ))
}

fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

struct Response {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
    raw_body: Vec<u8>,
}

impl Response {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

struct Gateway {
    dir: PathBuf,
    state: PathBuf,
    port: u16,
    child: Child,
}

impl Gateway {
    fn start(tag: &str) -> Self {
        let mut last_log = String::new();
        for attempt in 0..6 {
            match Self::start_once(&format!("{tag}-{attempt}")) {
                Ok(gateway) => return gateway,
                Err(log) => {
                    last_log = log;
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
        panic!("gateway never became ready\n{last_log}");
    }

    /// `free_port` only reserves `127.0.0.1`, while the gateway binds
    /// `0.0.0.0`; parallel tests can hand the same ephemeral port to two
    /// gateways, so a bind failure is retried with a fresh port.
    fn start_once(tag: &str) -> Result<Self, String> {
        let dir = unique(tag);
        let data = dir.join("data");
        let home = dir.join("home");
        let state = dir.join("state");
        for path in [&dir, &data, &home, &state] {
            fs::create_dir_all(path).unwrap();
        }
        let script_path = dir.join("host-script.json");
        fs::write(&script_path, json!({}).to_string()).unwrap();
        fs::write(dir.join("server.js"), FIXTURE_JS).unwrap();
        let port = free_port();
        let log = fs::File::create(dir.join("gateway.log")).unwrap();
        let mut command = Command::new(GATEWAY_BIN);
        command
            .arg("serve")
            .arg("--cwd")
            .arg(&dir)
            .arg("--node")
            .arg(std::env::var("MULTICC_TEST_NODE").unwrap_or_else(|_| "node".to_string()))
            .arg("server.js")
            .env_clear()
            .env(
                "PATH",
                std::env::var_os("PATH").unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin".into()),
            )
            .env("PORT", port.to_string())
            .env("ACCESS_TOKEN", TOKEN)
            .env("HOME", &home)
            .env("MULTICC_DATA_DIR", &data)
            .env("MULTICC_GATEWAY_UPSTREAM_WAIT_MS", "3000")
            .env("MULTICC_GATEWAY_BACKOFF_SCALE", "0.01")
            .env("FIXTURE_MODE", "echo")
            .env("FIXTURE_STATE_DIR", &state)
            .env("FIXTURE_HOST_SCRIPT", &script_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(log));
        for key in [
            "TMPDIR",
            "SystemRoot",
            "SYSTEMROOT",
            "windir",
            "TEMP",
            "TMP",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let child = command.spawn().expect("spawn multicc-gateway");
        let mut gateway = Self {
            dir,
            state,
            port,
            child,
        };
        let deadline = Instant::now() + Duration::from_secs(15);
        while !gateway.state.join("ready").exists() {
            if let Ok(Some(status)) = gateway.child.try_wait() {
                return Err(format!("{}\nchild exited: {status}", gateway.log()));
            }
            if Instant::now() >= deadline {
                return Err(gateway.log());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(gateway)
    }

    fn log(&self) -> String {
        fs::read_to_string(self.dir.join("gateway.log")).unwrap_or_default()
    }

    fn fixture_requests(&self) -> Vec<Value> {
        fs::read_to_string(self.state.join("requests.log"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    /// Whether the protocol fixture (standing in for the whole Node server)
    /// saw this request — i.e. the front door did not claim it.
    fn forwarded(&self, method: &str, url: &str) -> bool {
        self.fixture_requests().iter().any(|entry| {
            entry["method"].as_str() == Some(method) && entry["url"].as_str() == Some(url)
        })
    }

    fn exchange(&self, method: &str, url: &str, extra: &[(&str, &str)]) -> Response {
        let mut host = "localhost";
        let mut lines = String::new();
        for &(name, value) in extra {
            if name.eq_ignore_ascii_case("host") {
                host = value;
            } else {
                lines.push_str(name);
                lines.push_str(": ");
                lines.push_str(value);
                lines.push_str("\r\n");
            }
        }
        let request = format!(
            "{method} {url} HTTP/1.1\r\nHost: {host}\r\nX-Request-Id: diff-req-1\r\n\
             {lines}Connection: close\r\n\r\n"
        );
        let mut raw = Vec::new();
        for attempt in 0..4 {
            let mut stream = TcpStream::connect(("127.0.0.1", self.port)).expect("connect gateway");
            stream
                .set_read_timeout(Some(Duration::from_secs(30)))
                .unwrap();
            stream.write_all(request.as_bytes()).unwrap();
            raw.clear();
            match stream.read_to_end(&mut raw) {
                Ok(_) => break,
                Err(error)
                    if raw.is_empty()
                        && attempt < 3
                        && matches!(
                            error.kind(),
                            std::io::ErrorKind::ConnectionReset
                                | std::io::ErrorKind::ConnectionAborted
                                | std::io::ErrorKind::BrokenPipe
                        ) =>
                {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(error) => panic!("gateway exchange failed: {error:?}"),
            }
        }
        let split = raw
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("response headers");
        let head = String::from_utf8_lossy(&raw[..split]);
        let mut lines = head.split("\r\n");
        let status = lines
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse().ok())
            .expect("status line");
        let headers = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
            .collect();
        let raw_body = raw[split + 4..].to_vec();
        Response {
            status,
            headers,
            body: String::from_utf8_lossy(&raw_body).into_owned(),
            raw_body,
        }
    }

    fn get(&self, url: &str) -> Response {
        self.exchange("GET", url, &[])
    }

    fn head(&self, url: &str) -> Response {
        self.exchange("HEAD", url, &[])
    }

    fn options(&self, url: &str) -> Response {
        self.exchange("OPTIONS", url, &[])
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

// ── The three redirect families ─────────────────────────────────────────────

#[test]
fn manage_redirects_through_the_alias_table_and_the_allowlist() {
    let gateway = Gateway::start("manage");
    let cases = [
        ("/manage", "/air?view=overview"),
        ("/manage.html", "/air?view=overview"),
        ("/Manage.HTML/", "/air?view=overview"),
        ("/manage?view=docs", "/air?view=docs"),
        ("/manage?view=storage", "/air?view=storage"),
        ("/manage?view=cron", "/air?view=schedules"),
        ("/manage?view=tasks", "/air?view=overview"),
        ("/manage?view=planner", "/air?view=overview"),
        ("/manage?view=bogus", "/air?view=overview"),
        ("/manage?view=", "/air?view=overview"),
        ("/manage?focus=aux", "/air?view=aux"),
        ("/manage?focus=other", "/air?view=overview"),
        ("/manage?focus=aux&view=docs", "/air?view=docs"),
        (
            "/manage?task=t1&dir=d1&external=ext&token=tok&view=docs",
            "/air?view=docs&token=tok&external=ext&dir=d1&task=t1",
        ),
        ("/manage?view=docs&token=&dir=&task=", "/air?view=docs"),
        (
            "/manage?view=docs&token=a%20b%26c&dir=%E4%B8%AD%E6%96%87",
            "/air?view=docs&token=a+b%26c&dir=%E4%B8%AD%E6%96%87",
        ),
        ("/manage?view=docs&token=a&token=b", "/air?view=docs"),
    ];
    for (url, location) in cases {
        let response = gateway.get(url);
        assert_eq!(response.status, 302, "{url}: {}", gateway.log());
        assert_eq!(response.header("location"), Some(location), "{url}");
        assert_eq!(response.header("vary"), Some("Accept"), "{url}");
        assert_eq!(
            response.header("content-type"),
            Some("text/plain; charset=utf-8"),
            "{url}"
        );
        assert_eq!(
            response.body,
            format!("Found. Redirecting to {location}"),
            "{url}"
        );
        assert!(!gateway.forwarded("GET", url), "{url} was forwarded");
    }
}

#[test]
fn dashboard_and_the_planner_air_redirect_with_their_own_parameter_order() {
    let gateway = Gateway::start("redirects");
    let cases = [
        ("/dashboard", "/air?view=overview"),
        ("/dashboard.html", "/air?view=overview"),
        (
            "/dashboard?external=e&token=t&task=k&dir=d&view=docs",
            "/air?view=overview&dir=d&task=k&token=t&external=e",
        ),
        (
            "/dashboard?dir=&task=&token=&external=",
            "/air?view=overview",
        ),
        (
            "/air?view=planner&task=t&dir=d&token=x&external=e",
            "/air?view=overview&dir=d&task=t&token=x&external=e",
        ),
        ("/air.html?view=planner", "/air?view=overview"),
    ];
    for (url, location) in cases {
        let response = gateway.get(url);
        assert_eq!(response.status, 302, "{url}: {}", gateway.log());
        assert_eq!(response.header("location"), Some(location), "{url}");
        assert!(!gateway.forwarded("GET", url), "{url} was forwarded");
    }
}

#[test]
fn head_redirects_match_get_without_a_body() {
    let gateway = Gateway::start("head");
    for url in ["/manage?view=docs", "/dashboard", "/air?view=planner"] {
        let full = gateway.get(url);
        let head = gateway.head(url);
        assert_eq!(head.status, full.status, "{url}");
        assert_eq!(head.header("location"), full.header("location"), "{url}");
        assert_eq!(
            head.header("content-length"),
            full.header("content-length"),
            "{url}"
        );
        assert!(head.raw_body.is_empty(), "{url} HEAD has no body");
    }
}

#[test]
fn redirect_body_follows_the_accept_header() {
    let gateway = Gateway::start("accept");
    let html = gateway.exchange(
        "GET",
        "/manage?view=docs",
        &[("Accept", "text/html,*/*;q=0.8")],
    );
    assert_eq!(html.status, 302);
    assert_eq!(
        html.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(html.body, "<p>Found. Redirecting to /air?view=docs</p>");
    // The query is escaped for the HTML body, never for the Location header.
    let escaped = gateway.exchange(
        "GET",
        "/manage?view=docs&task=%3Cx%3E%26",
        &[("Accept", "text/html")],
    );
    assert_eq!(
        escaped.header("location"),
        Some("/air?view=docs&task=%3Cx%3E%26")
    );
    assert_eq!(
        escaped.body,
        "<p>Found. Redirecting to /air?view=docs&amp;task=%3Cx%3E%26</p>"
    );
}

// ── The `.apk` / `.ipa` guard ───────────────────────────────────────────────

#[test]
fn stray_binaries_are_an_empty_no_store_404() {
    let gateway = Gateway::start("guard");
    // The two canonical names are compared case-sensitively, the suffix is
    // not: `/MULTICC.APK` is a stray binary.
    for url in [
        "/x.apk",
        "/x.APK",
        "/plugins/x/y.apk",
        "/nested%2Fother.apk",
        "/x%2Eapk",
        "/MULTICC.APK",
    ] {
        let response = gateway.get(url);
        assert_eq!(response.status, 404, "{url}: {}", gateway.log());
        assert_eq!(response.header("cache-control"), Some("no-store"), "{url}");
        assert_eq!(response.header("content-length"), Some("0"), "{url}");
        assert_eq!(response.header("content-type"), None, "{url}");
        assert_eq!(response.header("etag"), None, "{url}");
        assert!(response.raw_body.is_empty(), "{url}");
        assert!(!gateway.forwarded("GET", url), "{url} was forwarded");
    }
    // HEAD answers the same headers with no body; Node never stamps
    // Content-Length on a HEAD `res.end()`.
    let head = gateway.head("/x.apk");
    assert_eq!(head.status, 404);
    assert_eq!(head.header("cache-control"), Some("no-store"));
    assert_eq!(head.header("content-length"), None);
    assert!(head.raw_body.is_empty());
}

#[test]
fn the_two_canonical_binaries_and_the_guard_edges_fall_back_to_node() {
    let gateway = Gateway::start("guard-edges");
    let cases = [
        "/multicc.apk",
        "/multicc-ios.ipa",
        "/x.apk/",
        "/foo.apk.txt",
        "/x.apx",
    ];
    for url in cases {
        let response = gateway.get(url);
        assert_eq!(response.status, 200, "{url}: {}", gateway.log());
        assert_eq!(response.body, "ok", "{url}");
        assert!(gateway.forwarded("GET", url), "{url} was not forwarded");
    }
}

// ── Express behavior and the claim boundary ─────────────────────────────────

#[test]
fn options_lists_get_and_head_for_every_registered_path() {
    let gateway = Gateway::start("options");
    for url in [
        "/manage",
        "/manage.html",
        "/dashboard",
        "/dashboard.html",
        "/air",
        "/air.html",
    ] {
        let response = gateway.options(url);
        assert_eq!(response.status, 200, "{url}");
        assert_eq!(response.header("allow"), Some("GET,HEAD"), "{url}");
        assert_eq!(response.body, "GET,HEAD", "{url}");
        assert!(!gateway.forwarded("OPTIONS", url), "{url} was forwarded");
    }
}

#[test]
fn unclaimed_reads_and_other_methods_stay_on_node() {
    let gateway = Gateway::start("boundary");
    let cases = [
        ("GET", "/air"),
        ("GET", "/air?view=overview"),
        ("GET", "/air?view=docs"),
        ("GET", "/air?view=planner&view=docs"),
        ("GET", "/air.html?view=settings"),
        ("GET", "/manage//"),
        ("GET", "/manage/extra"),
        ("POST", "/manage"),
        ("POST", "/dashboard"),
        ("PUT", "/air?view=planner"),
        // The guard itself only claims GET and HEAD.
        ("POST", "/x.apk"),
        ("DELETE", "/y.ipa"),
        ("OPTIONS", "/x.apk"),
    ];
    for (method, url) in cases {
        let response = gateway.exchange(method, url, &[]);
        assert!(
            gateway.forwarded(method, url),
            "{method} {url} should have been forwarded"
        );
        // The fixture's fallback answer, not a front-door redirect or 404.
        assert_eq!(response.body, "ok", "{method} {url}: {}", gateway.log());
    }
}
