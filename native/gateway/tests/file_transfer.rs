//! Integration coverage for the file-browser routes retired from
//! `src/routes/file-transfer.js` and answered by the Rust front door
//! (`native/gateway/src/app/file_transfer.rs`):
//!
//!   GET/HEAD/OPTIONS  /api/files
//!   POST/OPTIONS      /api/upload
//!
//! The Node process here is only the protocol fixture (PROXY v1 + auth
//! control): it answers `POST /api/__host/file-transfer` from
//! `script.fileTransfer` and appends every request body to
//! `file-transfer-calls.jsonl`. Route matching, the query trim semantics, the
//! listing response shape and `parent`, the multipart parser and its policy
//! table, temp-file naming and the stored bytes are Rust, and are what these
//! tests assert. `TMPDIR` is private to each gateway so the upload directory is
//! inspectable.

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
        "multicc-gateway-file-transfer-{}-{tag}-{nanos}",
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
}

impl Response {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).expect("JSON response")
    }
}

struct Gateway {
    dir: PathBuf,
    state: PathBuf,
    upload_dir: PathBuf,
    port: u16,
    child: Child,
}

impl Gateway {
    fn start(tag: &str, script: Value) -> Self {
        let mut last_log = String::new();
        for attempt in 0..6 {
            match Self::start_once(&format!("{tag}-{attempt}"), &script) {
                Ok(gateway) => return gateway,
                Err((log, retryable)) => {
                    last_log = log;
                    if !retryable {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
        panic!("gateway never became ready\n{last_log}");
    }

    fn start_once(tag: &str, script: &Value) -> Result<Self, (String, bool)> {
        let dir = unique(tag);
        let data = dir.join("data");
        let home = dir.join("home");
        let state = dir.join("state");
        let upload_dir = dir.join("tmp");
        for path in [&dir, &data, &home, &state, &upload_dir] {
            fs::create_dir_all(path).unwrap();
        }
        let script_path = dir.join("host-script.json");
        fs::write(&script_path, script.to_string()).unwrap();
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
            // `os.tmpdir()` for both the front door and the fixture.
            .env("TMPDIR", &upload_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log));
        for key in ["SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let child = command.spawn().expect("spawn multicc-gateway");
        let mut gateway = Self {
            dir,
            state,
            upload_dir,
            port,
            child,
        };
        let deadline = Instant::now() + Duration::from_secs(15);
        while !gateway.state.join("ready").exists() {
            if let Ok(Some(status)) = gateway.child.try_wait() {
                let log = gateway.log();
                let retryable = log.contains("EADDRINUSE") || log.contains("cannot bind");
                return Err((format!("{log}\nchild exited: {status}"), retryable));
            }
            if Instant::now() >= deadline {
                return Err((gateway.log(), false));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(gateway)
    }

    fn log(&self) -> String {
        fs::read_to_string(self.dir.join("gateway.log")).unwrap_or_default()
    }

    /// Replace the script the fixture reads on every host-port request.
    fn set_script(&self, script: Value) {
        fs::write(self.dir.join("host-script.json"), script.to_string()).unwrap();
    }

    fn host_calls(&self) -> Vec<Value> {
        fs::read_to_string(self.state.join("file-transfer-calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn uploads(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(&self.upload_dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn exchange(&self, method: &str, url: &str, head: &[(&str, &str)], body: &[u8]) -> Response {
        let mut host = "localhost";
        let mut request_id = "diff-req-1";
        let mut lines = String::new();
        for &(name, value) in head {
            if name.eq_ignore_ascii_case("host") {
                host = value;
            } else if name.eq_ignore_ascii_case("x-request-id") {
                request_id = value;
            } else {
                lines.push_str(name);
                lines.push_str(": ");
                lines.push_str(value);
                lines.push_str("\r\n");
            }
        }
        if !body.is_empty() {
            lines.push_str(&format!("Content-Length: {}\r\n", body.len()));
        }
        let mut request = format!(
            "{method} {url} HTTP/1.1\r\nHost: {host}\r\nX-Request-Id: {request_id}\r\n\
             {lines}Connection: close\r\n\r\n"
        )
        .into_bytes();
        request.extend_from_slice(body);
        let mut raw = Vec::new();
        for attempt in 0..4 {
            let mut stream = TcpStream::connect(("127.0.0.1", self.port)).expect("connect gateway");
            stream
                .set_read_timeout(Some(Duration::from_secs(30)))
                .unwrap();
            stream.write_all(&request).unwrap();
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
        Response {
            status,
            headers,
            body: String::from_utf8_lossy(&raw[split + 4..]).into_owned(),
        }
    }

    fn get(&self, url: &str) -> Response {
        self.exchange("GET", url, &[], b"")
    }

    fn head_request(&self, url: &str) -> Response {
        self.exchange("HEAD", url, &[], b"")
    }

    fn options(&self, url: &str) -> Response {
        self.exchange("OPTIONS", url, &[], b"")
    }

    fn post_bytes(&self, url: &str, content_type: Option<&str>, body: &[u8]) -> Response {
        match content_type {
            Some(value) => self.exchange("POST", url, &[("Content-Type", value)], body),
            None => self.exchange("POST", url, &[], body),
        }
    }

    fn post_file(&self, filename: &str, mime: &str, data: &[u8], boundary: &str) -> Response {
        let mut body = Vec::new();
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; \
                 filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(data);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        self.post_bytes(
            "/api/upload",
            Some(&format!("multipart/form-data; boundary={boundary}")),
            &body,
        )
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn script_with(file_transfer: Value) -> Value {
    json!({ "fileTransfer": file_transfer })
}

// ── /api/files ─────────────────────────────────────────────────────────────

#[test]
fn files_answers_with_the_listing_shape_and_parent() {
    let entries = json!([
        { "name": "src", "isDir": true, "path": "/work/dir/src", "size": null },
        { "name": "a.txt", "isDir": false, "path": "/work/dir/a.txt", "size": 3 },
    ]);
    let gateway = Gateway::start(
        "files-ok",
        script_with(json!({
            "files:session-1": { "ok": true, "dir": "/work/dir", "entries": entries.clone() },
        })),
    );

    let response = gateway.get("/api/files?path=%2Fwork%2Fdir&session=session-1");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.body,
        json!({ "path": "/work/dir", "parent": "/work", "files": entries }).to_string()
    );
    assert_eq!(
        response.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    assert_eq!(response.header("x-powered-by"), Some("Express"));
    assert!(response.header("etag").is_some());
    // The Rust side trimmed both query values before asking the host.
    assert_eq!(
        gateway.host_calls(),
        vec![json!({ "op": "files", "path": "/work/dir", "session": "session-1" })]
    );

    let head = gateway.head_request("/api/files?path=%2Fwork%2Fdir&session=session-1");
    assert_eq!(head.status, 200);
    assert_eq!(head.body, "");
    assert_eq!(
        head.header("content-length"),
        response.header("content-length")
    );

    let options = gateway.options("/api/files");
    assert_eq!(options.status, 200);
    assert_eq!(options.header("allow"), Some("GET,HEAD"));
    assert_eq!(options.body, "GET,HEAD");
}

#[test]
fn files_root_has_no_parent() {
    let gateway = Gateway::start(
        "files-root",
        script_with(json!({ "files": { "ok": true, "dir": "/", "entries": [] } })),
    );
    let response = gateway.get("/api/files");
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(
        response.json(),
        json!({ "path": "/", "parent": null, "files": [] })
    );
}

#[test]
fn files_listing_failure_is_the_old_400() {
    let gateway = Gateway::start(
        "files-400",
        script_with(json!({
            "files": { "ok": false, "message": "ENOENT: no such file or directory, scandir '/nope'" },
        })),
    );
    let response = gateway.get("/api/files?path=%2Fnope");
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(
        response.body,
        json!({ "error": "ENOENT: no such file or directory, scandir '/nope'" }).to_string()
    );
}

#[test]
fn files_host_fault_and_unavailable_port_are_500() {
    let script = script_with(json!({ "files": { "ok": false } }));
    let gateway = Gateway::start("files-500", script.clone());
    let response = gateway.get("/api/files");
    assert_eq!(response.status, 500, "{}", response.body);
    assert!(
        response.body.contains("internal_error"),
        "{}",
        response.body
    );

    // The fixture drops the connection when the script asks it to.
    gateway.set_script(json!({ "hostDown": true }));
    let response = gateway.get("/api/files");
    assert_eq!(response.status, 500, "{}", response.body);
    assert!(
        response.body.contains("internal_error"),
        "{}",
        response.body
    );
}

#[test]
fn files_array_query_is_the_handler_type_error() {
    let gateway = Gateway::start(
        "files-array",
        script_with(json!({ "files": { "ok": true, "dir": "/on-demand", "entries": [] } })),
    );
    // `req.query.path` is an array; `.trim` is not a function, exactly like the
    // retired handler's TypeError.
    let response = gateway.get("/api/files?path=a&path=b");
    assert_eq!(response.status, 500, "{}", response.body);
    assert!(response.body.contains("internal_error"));
    assert!(gateway.host_calls().is_empty());
}

// ── /api/upload ────────────────────────────────────────────────────────────

#[test]
fn upload_stores_the_chat_file_and_reports_it() {
    let gateway = Gateway::start("upload-ok", script_with(json!({})));
    let response = gateway.post_file("note.txt", "text/plain", b"hello", "BOUNDARY");
    assert_eq!(response.status, 200, "{}", response.body);
    let body = response.json();
    assert_eq!(body["name"], "note.txt");
    let saved = body["path"].as_str().expect("path");
    assert!(
        saved.starts_with(&format!("{}/multicc_", gateway.upload_dir.display())),
        "{saved}"
    );
    let file = saved.rsplit('/').next().unwrap();
    let prefix = "multicc_";
    assert!(file.starts_with(prefix), "{file}");
    assert!(file.ends_with(".txt"), "{file}");
    let stamp = &file[prefix.len()..file.len() - 4];
    let (millis, random) = stamp.split_once('_').expect("millis_random");
    assert!(millis.parse::<u64>().is_ok(), "{millis}");
    assert_eq!(random.len(), 8);
    assert!(random.chars().all(|ch| ch.is_ascii_hexdigit()), "{random}");
    assert_eq!(fs::read(saved).unwrap(), b"hello");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(saved).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    // The route announced the stored file on stdout like the Node route did.
    assert!(
        gateway
            .log()
            .contains(&format!("[multicc] Uploaded: {saved} (note.txt)")),
        "{}",
        gateway.log()
    );
}

#[test]
fn upload_keeps_the_latin1_filename_the_old_stack_reported() {
    let gateway = Gateway::start("upload-utf8", script_with(json!({})));
    // Raw UTF-8 bytes for "a.png" with a non-ASCII prefix: busboy decoded the
    // header as latin1, so the old route answered the mojibake. Rust must too.
    let filename = "中.png";
    let response = gateway.post_file(filename, "image/png", b"png", "B");
    assert_eq!(response.status, 200, "{}", response.body);
    let mojibake: String = filename
        .as_bytes()
        .iter()
        .map(|byte| *byte as char)
        .collect();
    assert_eq!(response.json()["name"], mojibake);
    assert_eq!(gateway.uploads().len(), 1);
    assert!(gateway.uploads()[0].ends_with(".png"));
}

#[test]
fn upload_without_a_multipart_file_is_the_old_400() {
    let gateway = Gateway::start("upload-no-file", script_with(json!({})));

    let json_body = gateway.post_bytes("/api/upload", Some("application/json"), br#"{"a":1}"#);
    assert_eq!(json_body.status, 400, "{}", json_body.body);
    assert_eq!(json_body.body, json!({ "error": "No file" }).to_string());

    let plain = gateway.post_bytes("/api/upload", Some("text/plain"), b"x");
    assert_eq!(plain.status, 400);
    assert_eq!(plain.body, json!({ "error": "No file" }).to_string());

    // No Content-Type at all: multer skips the body, the handler answers.
    let bare = gateway.post_bytes("/api/upload", None, b"x");
    assert_eq!(bare.status, 400);
    assert_eq!(bare.body, json!({ "error": "No file" }).to_string());

    // An invalid JSON body is rejected by the global express.json first.
    let invalid = gateway.post_bytes("/api/upload", Some("application/json"), b"{oops");
    assert_eq!(invalid.status, 400, "{}", invalid.body);
    assert_eq!(invalid.json()["code"], "request_error");

    // A multipart body with an empty form carries no file either.
    let empty = gateway.post_bytes(
        "/api/upload",
        Some("multipart/form-data; boundary=B"),
        b"--B--\r\n",
    );
    assert_eq!(empty.status, 400, "{}", empty.body);
    assert_eq!(empty.body, json!({ "error": "No file" }).to_string());

    // A multipart request without a boundary is a parse failure.
    let no_boundary = gateway.post_bytes("/api/upload", Some("multipart/form-data"), b"x");
    assert_eq!(no_boundary.status, 500, "{}", no_boundary.body);
    assert_eq!(no_boundary.json()["code"], "UPLOAD_FAILED");

    assert!(gateway.uploads().is_empty());
}

#[test]
fn upload_policy_table_is_byte_identical() {
    let gateway = Gateway::start("upload-policy", script_with(json!({})));

    let mut wrong_field = Vec::new();
    wrong_field.extend_from_slice(
        b"--B\r\nContent-Disposition: form-data; name=\"other\"; filename=\"a.png\"\r\n\
          Content-Type: image/png\r\n\r\ndata\r\n--B--\r\n",
    );
    let response = gateway.post_bytes(
        "/api/upload",
        Some("multipart/form-data; boundary=B"),
        &wrong_field,
    );
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(
        response.body,
        json!({
            "error": "expected one file field named file",
            "code": "UPLOAD_UNEXPECTED_FIELD",
        })
        .to_string()
    );

    let mut field_part = Vec::new();
    field_part.extend_from_slice(
        b"--B\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\nhello\r\n--B--\r\n",
    );
    let response = gateway.post_bytes(
        "/api/upload",
        Some("multipart/form-data; boundary=B"),
        &field_part,
    );
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(
        response.body,
        json!({
            "error": "exactly one file and no fields are allowed",
            "code": "UPLOAD_TOO_MANY_PARTS",
        })
        .to_string()
    );

    let mut two_files = Vec::new();
    for name in ["a.png", "b.png"] {
        two_files.extend_from_slice(
            format!(
                "--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n\
                 Content-Type: image/png\r\n\r\ndata\r\n"
            )
            .as_bytes(),
        );
    }
    two_files.extend_from_slice(b"--B--\r\n");
    let response = gateway.post_bytes(
        "/api/upload",
        Some("multipart/form-data; boundary=B"),
        &two_files,
    );
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(
        response.body,
        json!({
            "error": "exactly one file and no fields are allowed",
            "code": "UPLOAD_TOO_MANY_PARTS",
        })
        .to_string()
    );

    let response = gateway.post_file("tool.exe", "application/x-msdownload", b"MZ", "B");
    assert_eq!(response.status, 415, "{}", response.body);
    assert_eq!(
        response.body,
        json!({
            "error": "unsupported upload media type",
            "code": "UPLOAD_UNSUPPORTED_MEDIA_TYPE",
        })
        .to_string()
    );

    // fieldNameSize is the disposition *field* name, not the file name.
    let long_field = "a".repeat(65);
    let mut long_name_part = Vec::new();
    long_name_part.extend_from_slice(
        format!(
            "--B\r\nContent-Disposition: form-data; name=\"{long_field}\"; \
             filename=\"a.png\"\r\nContent-Type: image/png\r\n\r\nx\r\n--B--\r\n"
        )
        .as_bytes(),
    );
    let response = gateway.post_bytes(
        "/api/upload",
        Some("multipart/form-data; boundary=B"),
        &long_name_part,
    );
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(response.json()["code"], "UPLOAD_FIELD_INVALID");

    // An octet-stream part with no filename is a file multer resumes, so a
    // lone one leaves the request without a file at all.
    let mut octet_part = Vec::new();
    octet_part.extend_from_slice(
        b"--B\r\nContent-Disposition: form-data; name=\"file\"\r\n\
          Content-Type: application/octet-stream\r\n\r\nx\r\n--B--\r\n",
    );
    let response = gateway.post_bytes(
        "/api/upload",
        Some("multipart/form-data; boundary=B"),
        &octet_part,
    );
    assert_eq!(response.status, 400, "{}", response.body);
    assert_eq!(response.body, json!({ "error": "No file" }).to_string());

    // multer aborts on a part whose disposition has no name.
    let mut unnamed_part = Vec::new();
    unnamed_part.extend_from_slice(
        b"--B\r\nContent-Disposition: form-data; filename=\"a.png\"\r\n\
          Content-Type: image/png\r\n\r\nx\r\n--B--\r\n",
    );
    let response = gateway.post_bytes(
        "/api/upload",
        Some("multipart/form-data; boundary=B"),
        &unnamed_part,
    );
    assert_eq!(response.status, 500, "{}", response.body);
    assert_eq!(
        response.body,
        json!({
            "error": "upload failed",
            "code": "UPLOAD_FAILED",
        })
        .to_string()
    );

    assert!(gateway.uploads().is_empty());
}

#[test]
fn upload_over_the_file_limit_is_413() {
    let gateway = Gateway::start("upload-413", script_with(json!({})));
    // busboy emits `limit` when the byte count *reaches* the cap, so a file of
    // exactly 25 MiB is over it.
    let exact = vec![b'x'; 25 * 1024 * 1024];
    let response = gateway.post_file("exact.bin", "application/octet-stream", &exact, "B");
    assert_eq!(response.status, 413, "{}", response.body);
    assert_eq!(
        response.body,
        json!({
            "error": "upload exceeds 25 MiB limit",
            "code": "UPLOAD_FILE_TOO_LARGE",
        })
        .to_string()
    );
    let data = vec![b'x'; 25 * 1024 * 1024 + 1];
    let response = gateway.post_file("big.bin", "application/octet-stream", &data, "B");
    assert_eq!(response.status, 413, "{}", response.body);
    assert_eq!(
        response.body,
        json!({
            "error": "upload exceeds 25 MiB limit",
            "code": "UPLOAD_FILE_TOO_LARGE",
        })
        .to_string()
    );
    assert!(gateway.uploads().is_empty());
}

#[test]
fn upload_options_allow_only_post() {
    let gateway = Gateway::start("upload-options", script_with(json!({})));
    let response = gateway.options("/api/upload");
    assert_eq!(response.status, 200);
    assert_eq!(response.header("allow"), Some("POST"));
    assert_eq!(response.body, "POST");
}
