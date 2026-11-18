//! Integration coverage for the `public/` static web root retired from
//! `src/routes/static-assets.js` and answered by the Rust front door
//! (`native/gateway/src/app/static_web_root.rs`, kernels
//! `multicc_core::static_web` + `multicc_core::static_assets_routes`):
//!
//!   GET       <any>   -> the versioned-HTML middleware (the `?v=<mtime>` rewrite)
//!   GET|HEAD  <any>   -> express.static(public/, { extensions: ['html'] })
//!
//! The `public/` tree here is real, because every decision under test is a
//! filesystem decision: a document, an asset the rewrite stamps, a directory
//! with and without an index, a dotfile, an unreadable file and a symlink that
//! leaves the root. The Node process is only the protocol fixture (PROXY v1 +
//! auth control); `requests.log` is how a test proves the front door did *not*
//! claim a request, which is `serve-static`'s `fallthrough: true`. The
//! byte-for-byte comparison against the frozen Node module lives in
//! `docs/rust-migration/differential/static-web-root.js`.

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
        "multicc-gateway-static-web-{}-{tag}-{nanos}",
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
        seed_public(&dir.join("public"));
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


/// The tree every test shares. `index.html` and `air.css` exist so the rewrite
/// has something to stamp; `docs/` has an index and `empty/` does not.
fn seed_public(root: &PathBuf) {
    fs::create_dir_all(root).unwrap();
    fs::create_dir_all(root.join("docs")).unwrap();
    fs::create_dir_all(root.join("empty")).unwrap();
    fs::create_dir_all(root.join(".hidden")).unwrap();
    fs::write(
        root.join("index.html"),
        "<link href=\"air.css\"><script src=\"missing.js\"></script>",
    )
    .unwrap();
    fs::write(root.join("task-entry.html"), "<link href=\"air.css\">").unwrap();
    fs::write(root.join("chat.html"), "<p>canonical chat</p>").unwrap();
    fs::write(root.join("air.css"), "body{color:red}").unwrap();
    fs::write(root.join("plain.txt"), "hello!").unwrap();
    fs::write(root.join("multicc.apk"), "APKAPK").unwrap();
    fs::write(root.join("multicc-ios.ipa"), "IPAIPA").unwrap();
    fs::write(root.join(".env"), "SECRET=1").unwrap();
    fs::write(root.join(".hidden").join("bar.txt"), "intermediate").unwrap();
    fs::write(root.join("docs").join("index.html"), "<p>docs index</p>").unwrap();
    fs::write(root.join("docs").join("guide.html"), "<p>guide</p>").unwrap();
}

/// `send`'s ETag for a file: `W/"<size hex>-<mtime ms hex>"`. Node builds
/// `stat.mtime` as `new Date(Math.round(mtimeMs))`, so the sub-millisecond
/// part rounds (half up) instead of truncating.
fn file_mtime_ms(path: &PathBuf) -> i64 {
    let elapsed = fs::metadata(path)
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(UNIX_EPOCH)
        .unwrap();
    let millis = elapsed.as_secs() as f64 * 1000.0 + f64::from(elapsed.subsec_nanos()) / 1e6;
    (millis + 0.5).floor() as i64
}

/// The `?v=` stamp is `Math.floor(stat.mtimeMs)` — a different rule from the
/// ETag's `Math.round`, which is why both helpers exist.
fn file_mtime_floor(path: &PathBuf) -> i64 {
    let elapsed = fs::metadata(path)
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(UNIX_EPOCH)
        .unwrap();
    let millis = elapsed.as_secs() as f64 * 1000.0 + f64::from(elapsed.subsec_nanos()) / 1e6;
    millis.floor() as i64
}

fn file_etag(path: &PathBuf) -> String {
    let size = fs::metadata(path).unwrap().len();
    format!("W/\"{:x}-{:x}\"", size, file_mtime_ms(path))
}

// ── express.static: the plain file ──────────────────────────────────────────

#[test]
fn a_plain_file_carries_sends_headers_and_the_stat_etag() {
    let gateway = Gateway::start("plain");
    let response = gateway.get("/plain.txt");
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(response.body, "hello!");
    assert_eq!(
        response.header("content-type"),
        Some("text/plain; charset=UTF-8")
    );
    assert_eq!(response.header("accept-ranges"), Some("bytes"));
    assert_eq!(response.header("cache-control"), Some("public, max-age=0"));
    assert_eq!(response.header("content-length"), Some("6"));
    assert_eq!(
        response.header("etag"),
        Some(file_etag(&gateway.dir.join("public/plain.txt")).as_str())
    );
    assert!(response.header("last-modified").is_some());
    assert!(!gateway.forwarded("GET", "/plain.txt"));
}

#[test]
fn a_head_request_keeps_the_headers_and_drops_the_body() {
    let gateway = Gateway::start("head");
    let response = gateway.head("/plain.txt");
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(response.raw_body, Vec::<u8>::new());
    assert_eq!(response.header("content-length"), Some("6"));
    assert_eq!(
        response.header("content-type"),
        Some("text/plain; charset=UTF-8")
    );
}

#[test]
fn the_release_binaries_keep_the_set_headers_hook() {
    let gateway = Gateway::start("binaries");
    let apk = gateway.get("/multicc.apk");
    assert_eq!(apk.status, 200, "{}", gateway.log());
    assert_eq!(apk.body, "APKAPK");
    assert_eq!(
        apk.header("content-type"),
        Some("application/vnd.android.package-archive")
    );
    assert_eq!(
        apk.header("content-disposition"),
        Some("attachment; filename=\"multicc.apk\"")
    );
    assert_eq!(
        apk.header("cache-control"),
        Some("no-store, no-cache, must-revalidate")
    );
    assert_eq!(apk.header("pragma"), Some("no-cache"));
    assert_eq!(apk.header("expires"), Some("0"));
    assert_eq!(apk.header("accept-ranges"), Some("bytes"));

    let ipa = gateway.get("/multicc-ios.ipa");
    assert_eq!(ipa.status, 200);
    assert_eq!(ipa.header("content-type"), Some("application/octet-stream"));
    assert_eq!(
        ipa.header("content-disposition"),
        Some("attachment; filename=\"multicc-ios.ipa\"")
    );
}

// ── Range and conditional requests ─────────────────────────────────────────

#[test]
fn ranges_follow_the_range_parser_and_multi_range_is_a_plain_200() {
    let gateway = Gateway::start("range");
    let single = gateway.exchange("GET", "/plain.txt", &[("Range", "bytes=1-3")]);
    assert_eq!(single.status, 206, "{}", gateway.log());
    assert_eq!(single.body, "ell");
    assert_eq!(single.header("content-range"), Some("bytes 1-3/6"));
    assert_eq!(single.header("content-length"), Some("3"));

    let suffix = gateway.exchange("GET", "/plain.txt", &[("Range", "bytes=-2")]);
    assert_eq!(suffix.status, 206);
    assert_eq!(suffix.body, "o!");
    assert_eq!(suffix.header("content-range"), Some("bytes 4-5/6"));

    // `combine: true` merges adjacent ranges into one.
    let adjacent = gateway.exchange("GET", "/plain.txt", &[("Range", "bytes=0-1,2-3")]);
    assert_eq!(adjacent.status, 206);
    assert_eq!(adjacent.header("content-range"), Some("bytes 0-3/6"));

    // Two disjoint ranges are a regular full-body 200, never multipart.
    let multi = gateway.exchange("GET", "/plain.txt", &[("Range", "bytes=0-1,3-4")]);
    assert_eq!(multi.status, 200);
    assert_eq!(multi.body, "hello!");
    assert_eq!(multi.header("content-range"), None);

    // A syntactically invalid range is ignored, not rejected.
    let bogus = gateway.exchange("GET", "/plain.txt", &[("Range", "items=0-1")]);
    assert_eq!(bogus.status, 200);
    assert_eq!(bogus.body, "hello!");
}

#[test]
fn an_unsatisfiable_range_is_the_416_envelope_with_the_content_range() {
    let gateway = Gateway::start("range-416");
    let response = gateway.exchange("GET", "/plain.txt", &[("Range", "bytes=99-")]);
    assert_eq!(response.status, 416, "{}", gateway.log());
    assert_eq!(response.header("content-range"), Some("bytes */6"));
    let body: Value = serde_json::from_str(&response.body).unwrap();
    assert_eq!(body["ok"], false);
    assert_eq!(body["error"], "request_error");
    assert_eq!(body["code"], "request_error");
}

#[test]
fn conditional_requests_answer_304_and_412() {
    let gateway = Gateway::start("conditional");
    let etag = file_etag(&gateway.dir.join("public/plain.txt"));
    let fresh = gateway.exchange("GET", "/plain.txt", &[("If-None-Match", &etag)]);
    assert_eq!(fresh.status, 304, "{}", gateway.log());
    assert_eq!(fresh.raw_body, Vec::<u8>::new());
    assert_eq!(fresh.header("content-type"), None);
    assert_eq!(fresh.header("content-length"), None);
    assert_eq!(fresh.header("etag"), Some(etag.as_str()));
    assert_eq!(fresh.header("cache-control"), Some("public, max-age=0"));

    // `no-cache` on the request makes `fresh()` return false.
    let revalidate = gateway.exchange(
        "GET",
        "/plain.txt",
        &[("If-None-Match", &etag), ("Cache-Control", "no-cache")],
    );
    assert_eq!(revalidate.status, 200);

    let failed = gateway.exchange("GET", "/plain.txt", &[("If-Match", "\"nope\"")]);
    assert_eq!(failed.status, 412);
    let body: Value = serde_json::from_str(&failed.body).unwrap();
    assert_eq!(body["error"], "request_error");
    assert_eq!(body["code"], "request_error");

    let modified = gateway.exchange(
        "GET",
        "/plain.txt",
        &[("If-Modified-Since", "Sat, 01 Jan 2050 00:00:00 GMT")],
    );
    assert_eq!(modified.status, 304);
}

// ── Directories, the index list and the extension retry ────────────────────

#[test]
fn a_directory_without_a_slash_is_the_301_document() {
    let gateway = Gateway::start("dir-301");
    let response = gateway.get("/docs");
    assert_eq!(response.status, 301, "{}", gateway.log());
    assert_eq!(response.header("location"), Some("/docs/"));
    assert_eq!(
        response.header("content-type"),
        Some("text/html; charset=UTF-8")
    );
    assert_eq!(
        response.header("content-security-policy"),
        Some("default-src 'none'")
    );
    assert_eq!(response.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(
        response.body,
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Redirecting</title>\n</head>\n<body>\n<pre>Redirecting to /docs/</pre>\n</body>\n</html>\n"
    );
    assert_eq!(
        response.header("content-length"),
        Some(response.body.len().to_string().as_str())
    );

    // The query string rides along, and the leading slashes collapse.
    let with_query = gateway.get("/docs?x=1&y=2");
    assert_eq!(with_query.header("location"), Some("/docs/?x=1&y=2"));
}

#[test]
fn a_directory_with_a_slash_serves_its_index_or_falls_through() {
    let gateway = Gateway::start("dir-index");
    let served = gateway.get("/docs/");
    assert_eq!(served.status, 200, "{}", gateway.log());
    assert_eq!(served.body, "<p>docs index</p>");
    assert_eq!(
        served.header("content-type"),
        Some("text/html; charset=UTF-8")
    );

    // No index entry: `sendIndex` exhausts its list and `fallthrough` passes
    // the request to Node.
    let missing = gateway.get("/empty/");
    assert_eq!(missing.status, 200, "{}", gateway.log());
    assert!(gateway.forwarded("GET", "/empty/"));
}

#[test]
fn an_extension_less_path_retries_the_html_candidate() {
    let gateway = Gateway::start("extensions");
    // The versioned-HTML middleware claims this one first (it is a GET), so the
    // retry is observable on HEAD, which that middleware skipped.
    let response = gateway.head("/docs/guide");
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(
        response.header("content-type"),
        Some("text/html; charset=UTF-8")
    );
    assert_eq!(response.header("cache-control"), Some("public, max-age=0"));
    assert_eq!(response.header("content-length"), Some("12"));
    assert!(!gateway.forwarded("HEAD", "/docs/guide"));
}

// ── fallthrough: every <500 error is a plain next() ────────────────────────

#[test]
fn the_fallthrough_errors_reach_node_untouched() {
    let gateway = Gateway::start("fallthrough");
    // 404 (dotfile in the last segment), 400 (bad escape, null byte) and 403
    // (an escaping `..`) were all a plain `next()`.
    for url in [
        "/.env",
        "/%",
        "/a%00b",
        "/../etc/passwd",
        "/nope",
        "/nope.txt",
    ] {
        let response = gateway.get(url);
        assert_eq!(response.status, 200, "{url}: {}", gateway.log());
        assert!(gateway.forwarded("GET", url), "{url} should reach Node");
    }
    // An intermediate dot segment is served, unlike a trailing one.
    let intermediate = gateway.get("/.hidden/bar.txt");
    assert_eq!(intermediate.status, 200);
    assert_eq!(intermediate.body, "intermediate");
}

#[test]
fn other_methods_and_upgrades_are_never_claimed() {
    let gateway = Gateway::start("methods");
    for method in ["POST", "PUT", "DELETE", "PATCH"] {
        let response = gateway.exchange(method, "/plain.txt", &[]);
        assert_eq!(response.status, 200, "{method}: {}", gateway.log());
        assert!(gateway.forwarded(method, "/plain.txt"), "{method}");
    }
    // Node's HTTP server routes an upgrade to the `upgrade` listener, so the
    // retired Express chain never saw one.
    let upgrade = gateway.exchange(
        "GET",
        "/plain.txt",
        &[("Connection", "Upgrade"), ("Upgrade", "websocket")],
    );
    assert_ne!(upgrade.body, "hello!", "{}", gateway.log());

    // OPTIONS keeps reaching Node: the retired mount registered no route, so
    // Express had no Allow to synthesise.
    let options = gateway.options("/plain.txt");
    assert_eq!(options.status, 200);
    assert!(gateway.forwarded("OPTIONS", "/plain.txt"));
}

// ── The versioned-HTML middleware ──────────────────────────────────────────

#[test]
fn the_versioned_middleware_stamps_local_assets_and_sends_no_store() {
    let gateway = Gateway::start("versioned");
    // Bare `GET /` is the root redirect the front door already owns; the
    // terminal-session form is what the retired `next()` passed down here.
    let response = gateway.get("/?id=s1");
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(
        response.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(
        response.header("cache-control"),
        Some("no-store, no-cache, must-revalidate")
    );
    assert_eq!(response.header("pragma"), Some("no-cache"));
    // The asset that exists is stamped with its floored mtimeMs; the one that
    // does not is kept verbatim.
    let mtime = file_mtime_floor(&gateway.dir.join("public/air.css"));
    assert_eq!(
        response.body,
        format!("<link href=\"air.css?v={mtime}\"><script src=\"missing.js\"></script>")
    );
    // `res.send` derives its own weak sha1 ETag, not send's stat tag.
    let etag = response.header("etag").unwrap();
    assert!(etag.starts_with("W/\""), "{etag}");
    assert!(!etag.contains(&format!("{:x}", mtime)), "{etag}");
}

#[test]
fn the_chat_and_task_shell_documents_hop_to_task_entry() {
    let gateway = Gateway::start("task-entry");
    for url in ["/chat", "/chat.html", "/task-shell", "/task-shell.html"] {
        let response = gateway.get(url);
        assert_eq!(response.status, 200, "{url}: {}", gateway.log());
        assert!(response.body.starts_with("<link href=\"air.css?v="), "{url}");
        assert_eq!(
            response.header("cache-control"),
            Some("no-store, no-cache, must-revalidate"),
            "{url}"
        );
    }
    // `?air=1` with a task or session keeps the canonical chat renderer.
    let canonical = gateway.get("/chat.html?air=1&task=t1");
    assert_eq!(canonical.body, "<p>canonical chat</p>");
    let hop = gateway.get("/chat.html?air=1");
    assert!(hop.body.starts_with("<link href=\"air.css?v="));
}

#[test]
fn head_skips_the_versioned_middleware_and_hits_the_static_mount() {
    let gateway = Gateway::start("head-static");
    // GET /chat.html renders task-entry.html; HEAD serves the real document,
    // because the retired middleware's first line was `req.method !== 'GET'`.
    let get = gateway.get("/chat.html");
    assert!(get.body.starts_with("<link href=\"air.css?v="));
    assert_eq!(
        get.header("cache-control"),
        Some("no-store, no-cache, must-revalidate")
    );
    let head = gateway.head("/chat.html");
    assert_eq!(head.status, 200, "{}", gateway.log());
    assert_eq!(head.header("cache-control"), Some("public, max-age=0"));
    assert_eq!(head.header("content-length"), Some("21"));
    assert_eq!(
        head.header("etag"),
        Some(file_etag(&gateway.dir.join("public/chat.html")).as_str())
    );
}

#[test]
fn an_unreadable_document_is_an_empty_500() {
    let gateway = Gateway::start("unreadable");
    // `fs.readFile` failing inside the versioned middleware was
    // `res.status(500).end()`: no body, no Content-Type, no ETag.
    let path = gateway.dir.join("public/locked.html");
    fs::write(&path, "<p>locked</p>").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        let response = gateway.get("/locked.html");
        assert_eq!(response.status, 500, "{}", gateway.log());
        assert_eq!(response.raw_body, Vec::<u8>::new());
        assert_eq!(response.header("content-type"), None);
        assert_eq!(response.header("etag"), None);
        assert_eq!(response.header("content-length"), Some("0"));
        // HEAD skips that middleware, and send never opens the file for a
        // HEAD: the real mount answers 200 with the full header set.
        let head = gateway.head("/locked.html");
        assert_eq!(head.status, 200, "{}", gateway.log());
        assert_eq!(head.raw_body, Vec::<u8>::new());
        assert_eq!(
            head.header("content-type"),
            Some("text/html; charset=UTF-8")
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        // A non-HTML name reaches the static mount on GET too, where the
        // stream error arrives after send's headers: `safeErrorHandler`
        // renders the 500 envelope on top of them.
        let asset = gateway.dir.join("public/locked.txt");
        fs::write(&asset, "locked asset").unwrap();
        fs::set_permissions(&asset, fs::Permissions::from_mode(0o000)).unwrap();
        let direct = gateway.get("/locked.txt");
        assert_eq!(direct.status, 500, "{}", gateway.log());
        assert_eq!(direct.header("accept-ranges"), Some("bytes"));
        assert_eq!(direct.header("cache-control"), Some("public, max-age=0"));
        assert_eq!(
            direct.header("etag"),
            Some(file_etag(&asset).as_str())
        );
        let body: Value = serde_json::from_str(&direct.body).unwrap();
        assert_eq!(body["error"], "internal_error");
        assert_eq!(body["code"], "EACCES");
        fs::set_permissions(&asset, fs::Permissions::from_mode(0o644)).unwrap();
    }
}

#[test]
fn a_symlink_out_of_the_root_is_served_like_send_serves_it() {
    let gateway = Gateway::start("symlink");
    #[cfg(unix)]
    {
        let outside = gateway.dir.join("outside.txt");
        fs::write(&outside, "outside!").unwrap();
        std::os::unix::fs::symlink(&outside, gateway.dir.join("public/link.txt")).unwrap();
        // send resolves the path textually and stats it: a symlink target
        // outside the root is served, exactly as the retired mount served it.
        let response = gateway.get("/link.txt");
        assert_eq!(response.status, 200, "{}", gateway.log());
        assert_eq!(response.body, "outside!");
        assert_eq!(
            response.header("content-type"),
            Some("text/plain; charset=UTF-8")
        );
    }
}
