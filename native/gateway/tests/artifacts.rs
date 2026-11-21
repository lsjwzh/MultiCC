//! Integration coverage for the `/artifacts` dual-root static mount retired
//! from `src/artifacts.js` and answered by the Rust front door
//! (`native/gateway/src/app/artifacts.rs`, kernels `multicc_core::static_web`):
//!
//!   GET|HEAD  /artifacts/<id>[/<file>]  -> express.static over two roots
//!     (<data root>/artifacts, then ~/.multicc/artifacts), a
//!     `?download=1`/`?dl=1` attachment middleware in front, `Cache-Control:
//!     no-store, must-revalidate` + `X-Content-Type-Options: nosniff` on every
//!     served file
//!
//! The three trees here are real, because every decision under test is a
//! filesystem decision: the primary root, the legacy fallback root, and the
//! `public/` root that answered next in the retired chain. The Node process is
//! only the protocol fixture (PROXY v1 + auth control); `requests.log` is how a
//! test proves the front door did *not* claim a request, which is
//! `serve-static`'s `fallthrough: true`. The byte-for-byte comparison against
//! the frozen Node module lives in
//! `docs/rust-migration/differential/artifacts-root.js`.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
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
        "multicc-gateway-artifacts-{}-{tag}-{nanos}",
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
        seed_trees(&dir);
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
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// The three trees every test shares: the primary artifact root under the data
/// root, the legacy root under HOME, and the public root the retired chain
/// fell through to. `both-roots` exists in both artifact roots so the primary
/// shadowing is observable.
fn seed_trees(dir: &Path) {
    let primary = dir.join("data").join("artifacts");
    let legacy = dir.join("home").join(".multicc").join("artifacts");
    let public = dir.join("public");
    fs::create_dir_all(primary.join("art-1").join("nested")).unwrap();
    fs::create_dir_all(primary.join("art-1").join("sub")).unwrap();
    fs::create_dir_all(primary.join("art-1").join("emptydir")).unwrap();
    fs::create_dir_all(primary.join("art-1").join(".hidden")).unwrap();
    fs::create_dir_all(primary.join("both-roots")).unwrap();
    fs::create_dir_all(legacy.join("art-legacy")).unwrap();
    fs::create_dir_all(legacy.join("both-roots")).unwrap();
    fs::create_dir_all(public.join("artifacts").join("pubid")).unwrap();
    fs::write(primary.join("art-1").join("guide.txt"), "primary guide").unwrap();
    fs::write(
        primary.join("art-1").join("index.html"),
        "<p>root index</p>",
    )
    .unwrap();
    fs::write(
        primary.join("art-1").join("nested").join("deep.txt"),
        "deep content",
    )
    .unwrap();
    fs::write(
        primary.join("art-1").join("sub").join("index.html"),
        "<p>sub index</p>",
    )
    .unwrap();
    fs::write(primary.join("art-1").join(".secret"), "hidden").unwrap();
    fs::write(
        primary.join("art-1").join(".hidden").join("bar.txt"),
        "dotdir",
    )
    .unwrap();
    fs::write(primary.join("art-1").join("app.apk"), "ARTAPK").unwrap();
    fs::write(
        primary.join("both-roots").join("shared.txt"),
        "primary shared",
    )
    .unwrap();
    fs::write(legacy.join("art-legacy").join("old.txt"), "legacy only").unwrap();
    fs::write(
        legacy.join("both-roots").join("shared.txt"),
        "legacy shared",
    )
    .unwrap();
    fs::write(
        public.join("artifacts").join("pubid").join("pub-only.txt"),
        "public chain",
    )
    .unwrap();
}

/// `send`'s ETag for a file: `W/"<size hex>-<mtime ms hex>"`. Node builds
/// `stat.mtime` as `new Date(Math.round(mtimeMs))`, so the sub-millisecond
/// part rounds (half up) instead of truncating.
fn file_mtime_ms(path: &Path) -> i64 {
    let elapsed = fs::metadata(path)
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(UNIX_EPOCH)
        .unwrap();
    let millis = elapsed.as_secs() as f64 * 1000.0 + f64::from(elapsed.subsec_nanos()) / 1e6;
    (millis + 0.5).floor() as i64
}

fn file_etag(path: &Path) -> String {
    let size = fs::metadata(path).unwrap().len();
    format!("W/\"{:x}-{:x}\"", size, file_mtime_ms(path))
}

fn primary_file(gateway: &Gateway, relative: &str) -> PathBuf {
    gateway.dir.join("data").join("artifacts").join(relative)
}

// ── the dual root: primary hit, legacy fallback, primary shadowing ──────────

#[test]
fn a_primary_file_carries_the_no_store_preset_and_the_stat_etag() {
    let gateway = Gateway::start("primary");
    let response = gateway.get("/artifacts/art-1/guide.txt");
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(response.body, "primary guide");
    assert_eq!(
        response.header("content-type"),
        Some("text/plain; charset=UTF-8")
    );
    assert_eq!(response.header("accept-ranges"), Some("bytes"));
    assert_eq!(
        response.header("cache-control"),
        Some("no-store, must-revalidate")
    );
    assert_eq!(response.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(response.header("content-length"), Some("13"));
    assert_eq!(
        response.header("etag"),
        Some(file_etag(&primary_file(&gateway, "art-1/guide.txt")).as_str())
    );
    assert_eq!(response.header("content-disposition"), None);
    assert!(!gateway.forwarded("GET", "/artifacts/art-1/guide.txt"));
}

#[test]
fn a_legacy_only_file_is_served_by_the_fallback_root() {
    let gateway = Gateway::start("legacy");
    let response = gateway.get("/artifacts/art-legacy/old.txt");
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(response.body, "legacy only");
    assert_eq!(
        response.header("cache-control"),
        Some("no-store, must-revalidate")
    );
    assert!(!gateway.forwarded("GET", "/artifacts/art-legacy/old.txt"));
}

#[test]
fn the_primary_root_shadows_the_legacy_root() {
    let gateway = Gateway::start("shadow");
    let response = gateway.get("/artifacts/both-roots/shared.txt");
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(response.body, "primary shared");
    assert!(!gateway.forwarded("GET", "/artifacts/both-roots/shared.txt"));
}

#[test]
fn the_mount_point_matches_case_insensitively() {
    let gateway = Gateway::start("case");
    let response = gateway.get("/ARTIFACTS/art-1/guide.txt");
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(response.body, "primary guide");
}

#[test]
fn a_head_request_keeps_the_headers_and_drops_the_body() {
    let gateway = Gateway::start("head");
    let response = gateway.head("/artifacts/art-1/guide.txt");
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(response.raw_body, Vec::<u8>::new());
    assert_eq!(response.header("content-length"), Some("13"));
    assert_eq!(
        response.header("cache-control"),
        Some("no-store, must-revalidate")
    );
}

// ── Range and conditional requests ride the same send engine ────────────────

#[test]
fn a_range_request_is_a_206_with_the_content_range() {
    let gateway = Gateway::start("range");
    let response = gateway.exchange(
        "GET",
        "/artifacts/art-1/guide.txt",
        &[("Range", "bytes=1-3")],
    );
    assert_eq!(response.status, 206, "{}", gateway.log());
    assert_eq!(response.body, "rim");
    assert_eq!(response.header("content-range"), Some("bytes 1-3/13"));
    assert_eq!(
        response.header("cache-control"),
        Some("no-store, must-revalidate")
    );
}

#[test]
fn a_matching_if_none_match_is_a_304() {
    let gateway = Gateway::start("conditional");
    let etag = file_etag(&primary_file(&gateway, "art-1/guide.txt"));
    let response = gateway.exchange(
        "GET",
        "/artifacts/art-1/guide.txt",
        &[("If-None-Match", &etag)],
    );
    assert_eq!(response.status, 304, "{}", gateway.log());
    assert_eq!(response.raw_body, Vec::<u8>::new());
    assert_eq!(response.header("etag"), Some(etag.as_str()));
}

// ── the ?download=1 / ?dl=1 attachment middleware ───────────────────────────

#[test]
fn download_one_forces_an_attachment_with_the_basename() {
    let gateway = Gateway::start("download");
    let response = gateway.get("/artifacts/art-1/guide.txt?download=1");
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(response.body, "primary guide");
    assert_eq!(
        response.header("content-disposition"),
        Some("attachment; filename=\"guide.txt\"")
    );

    let dl = gateway.get("/artifacts/art-1/guide.txt?dl=1");
    assert_eq!(
        dl.header("content-disposition"),
        Some("attachment; filename=\"guide.txt\"")
    );

    // `0` is not `1`, and a repeated key parses to an array in qs, which
    // never `=== '1'`.
    for url in [
        "/artifacts/art-1/guide.txt?download=0",
        "/artifacts/art-1/guide.txt?download=1&download=1",
    ] {
        let inline = gateway.get(url);
        assert_eq!(inline.status, 200, "{url}: {}", gateway.log());
        assert_eq!(inline.header("content-disposition"), None, "{url}");
    }
}

#[test]
fn the_disposition_rides_the_directory_redirect() {
    let gateway = Gateway::start("download-301");
    // `path.basename('/art-1/sub')` is the directory name, and the middleware
    // ran before serve-static, so the 301 carries the attachment too.
    let response = gateway.get("/artifacts/art-1/sub?download=1");
    assert_eq!(response.status, 301, "{}", gateway.log());
    assert_eq!(
        response.header("location"),
        Some("/artifacts/art-1/sub/?download=1")
    );
    assert_eq!(
        response.header("content-disposition"),
        Some("attachment; filename=\"sub\"")
    );
}

// ── directories: the 301 and the index ───────────────────────────────────────

#[test]
fn a_directory_without_a_slash_is_the_301_document() {
    let gateway = Gateway::start("dir-301");
    let response = gateway.get("/artifacts/art-1/sub");
    assert_eq!(response.status, 301, "{}", gateway.log());
    assert_eq!(response.header("location"), Some("/artifacts/art-1/sub/"));
    assert_eq!(
        response.header("content-type"),
        Some("text/html; charset=UTF-8")
    );
    assert_eq!(
        response.body,
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Redirecting</title>\n</head>\n<body>\n<pre>Redirecting to /artifacts/art-1/sub/</pre>\n</body>\n</html>\n"
    );
    // The query string rides along, after the added slash.
    let with_query = gateway.get("/artifacts/art-1/sub?x=1");
    assert_eq!(
        with_query.header("location"),
        Some("/artifacts/art-1/sub/?x=1")
    );

    let index = gateway.get("/artifacts/art-1/sub/");
    assert_eq!(index.status, 200, "{}", gateway.log());
    assert_eq!(index.body, "<p>sub index</p>");
    assert_eq!(
        index.header("content-type"),
        Some("text/html; charset=UTF-8")
    );

    // The root index of an artifact id answers the trailing-slash form.
    let root = gateway.get("/artifacts/art-1/");
    assert_eq!(root.status, 200, "{}", gateway.log());
    assert_eq!(root.body, "<p>root index</p>");
}

// ── layering: the .apk guard behind the roots, the public root after ────────

#[test]
fn an_apk_inside_an_artifact_is_served_by_the_artifact_roots() {
    let gateway = Gateway::start("apk");
    let response = gateway.get("/artifacts/art-1/app.apk");
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(response.body, "ARTAPK");
    // The artifact preset, not the release-binary hook: no attachment.
    assert_eq!(
        response.header("cache-control"),
        Some("no-store, must-revalidate")
    );
    assert_eq!(response.header("content-disposition"), None);
    assert!(!gateway.forwarded("GET", "/artifacts/art-1/app.apk"));
}

#[test]
fn an_unknown_apk_is_the_global_guards_answer() {
    let gateway = Gateway::start("apk-guard");
    // Both artifact roots miss, and the retired chain's global `.apk`/`.ipa`
    // guard answered before the public root.
    let response = gateway.get("/artifacts/art-1/missing.apk");
    assert_eq!(response.status, 404, "{}", gateway.log());
    assert!(!gateway.forwarded("GET", "/artifacts/art-1/missing.apk"));
}

#[test]
fn a_path_only_the_public_root_has_is_served_by_that_layer() {
    let gateway = Gateway::start("chain");
    // Neither artifact root has `pubid`, so the retired chain's next layer —
    // the `public/` static mount — answered, with its own cache preset.
    let response = gateway.get("/artifacts/pubid/pub-only.txt");
    assert_eq!(response.status, 200, "{}", gateway.log());
    assert_eq!(response.body, "public chain");
    assert_eq!(response.header("cache-control"), Some("public, max-age=0"));
    assert!(!gateway.forwarded("GET", "/artifacts/pubid/pub-only.txt"));
}

// ── fallthrough: every miss is a plain next() ───────────────────────────────

#[test]
fn the_fallthrough_errors_reach_node_untouched() {
    let gateway = Gateway::start("fallthrough");
    // A missing file, a dotfile in the last segment, a dot *directory* (the
    // explicit `dotfiles: 'ignore'` this mount passed ignores every segment,
    // unlike the public root's legacy rule), an index-less directory and an
    // escaping `..` were all a plain `next()`.
    for url in [
        "/artifacts/art-1/nope.txt",
        "/artifacts/art-1/.secret",
        "/artifacts/art-1/.hidden/bar.txt",
        "/artifacts/art-1/emptydir/",
        "/artifacts/../etc/passwd",
    ] {
        let response = gateway.get(url);
        assert_eq!(response.status, 200, "{url}: {}", gateway.log());
        assert!(gateway.forwarded("GET", url), "{url} should reach Node");
    }
}

#[test]
fn other_methods_and_upgrades_are_never_claimed() {
    let gateway = Gateway::start("methods");
    for method in ["POST", "PUT", "DELETE", "PATCH"] {
        let response = gateway.exchange(method, "/artifacts/art-1/guide.txt", &[]);
        assert_eq!(response.status, 200, "{method}: {}", gateway.log());
        assert!(
            gateway.forwarded(method, "/artifacts/art-1/guide.txt"),
            "{method}"
        );
    }
    // Node's HTTP server routes an upgrade to the `upgrade` listener, so the
    // retired Express chain never saw one.
    let upgrade = gateway.exchange(
        "GET",
        "/artifacts/art-1/guide.txt",
        &[("Connection", "Upgrade"), ("Upgrade", "websocket")],
    );
    assert_ne!(upgrade.body, "primary guide", "{}", gateway.log());
}

// ── the error paths that were not a plain next() ────────────────────────────

#[test]
fn an_unreadable_asset_is_the_500_envelope_after_sends_headers() {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let gateway = Gateway::start("unreadable");
        let path = primary_file(&gateway, "art-1/locked.txt");
        fs::write(&path, "locked asset").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        let response = gateway.get("/artifacts/art-1/locked.txt");
        assert_eq!(response.status, 500, "{}", gateway.log());
        // send's headers were already written when the stream failed: the
        // error envelope lands on top of the artifact preset.
        assert_eq!(response.header("accept-ranges"), Some("bytes"));
        assert_eq!(
            response.header("cache-control"),
            Some("no-store, must-revalidate")
        );
        let body: Value = serde_json::from_str(&response.body).unwrap();
        assert_eq!(body["error"], "internal_error");
        assert_eq!(body["code"], "EACCES");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    }
}

#[test]
fn a_symlink_inside_the_root_is_served_like_send_serves_it() {
    #[cfg(unix)]
    {
        let gateway = Gateway::start("symlink");
        std::os::unix::fs::symlink(
            Path::new("nested").join("deep.txt"),
            primary_file(&gateway, "art-1/linked.txt"),
        )
        .unwrap();
        let response = gateway.get("/artifacts/art-1/linked.txt");
        assert_eq!(response.status, 200, "{}", gateway.log());
        assert_eq!(response.body, "deep content");
    }
}
