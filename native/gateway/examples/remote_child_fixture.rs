//! Test-only stand-in for `multicc-remote` (docs/remote-screen-process.md §1).
//!
//! It speaks the process protocol (stdin config line, one stdout ready line,
//! logs on stderr, exit on stdin EOF) and a tiny HTTP server, with switches for
//! every failure the supervisor and the forwarder have to handle:
//!
//! | env | effect |
//! |---|---|
//! | `FIXTURE_MODE` | `ready` (default), `exit-before-ready`, `bad-ready-line`, `bad-version`, `silent` |
//! | `FIXTURE_STDIN_FILE` | write the raw first stdin line here (plus `.eof` once stdin closes) |
//! | `FIXTURE_FAIL_FIRST` | exit before ready once, using this path as the marker |
//! | `FIXTURE_READY_DELAY_MS` | wait before printing the ready line |
//! | `FIXTURE_EXIT_AFTER_MS` / `FIXTURE_EXIT_CODE` | crash this long after ready |
//! | `FIXTURE_STDERR` | `1` writes the stderr lines the log forwarder must clip |
//! | `FIXTURE_SECRET` | the secret the ready line hands out (default `fixture-secret`) |
//! | `FIXTURE_HTTP` | `echo` (default), `stream`, `stall`, `truncate` |
//! | `FIXTURE_STATUS` / `FIXTURE_CHUNKS` / `FIXTURE_CHUNK_MS` | echo status; stream chunk count (`0` = forever) and spacing |
//! | `FIXTURE_REQUESTS_FILE` | append one JSON record per request |
//! | `FIXTURE_ABORT_FILE` | append `aborted` when the client leaves mid-response |
//!
//! **Never built for release.** This is an example, not a `[[bin]]`: `cargo
//! build --release -p multicc-gateway` (what scripts/build-rust-kernels.js runs)
//! compiles only the package's bins, so the fixture neither costs a release
//! build any time nor lands in `target/release/`. `cargo test` builds it for
//! the two integration tests that spawn it.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

struct Request {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn main() {
    let mode = env_or("FIXTURE_MODE", "ready");
    let first_line = read_first_line();
    if let Some(path) = std::env::var_os("FIXTURE_STDIN_FILE") {
        let _ = std::fs::write(path, &first_line);
    }
    if let Some(path) = std::env::var_os("FIXTURE_FAIL_FIRST") {
        if std::fs::metadata(&path).is_err() {
            let _ = std::fs::write(&path, b"1");
            std::process::exit(exit_code(3));
        }
    }
    if mode == "exit-before-ready" {
        std::process::exit(exit_code(3));
    }
    watch_lifeline();
    match mode.as_str() {
        "bad-ready-line" => {
            println!("this is definitely not json");
            let _ = std::io::stdout().flush();
            park();
        }
        "bad-version" => {
            println!(r#"{{"ready":true,"v":2,"port":1,"secret":"s"}}"#);
            let _ = std::io::stdout().flush();
            park();
        }
        "huge-line" => {
            // No newline, beyond the supervisor's 64 KiB cap.
            print!("{}", "x".repeat(70 * 1024));
            let _ = std::io::stdout().flush();
            park();
        }
        "silent" => park(),
        _ => serve(),
    }
}

/// The protocol's first line, consumed byte by byte so the lifeline thread
/// still sees the rest of the stream (and its EOF).
fn read_first_line() -> Vec<u8> {
    let mut line = Vec::new();
    let mut stdin = std::io::stdin();
    let mut byte = [0u8; 1];
    loop {
        match stdin.read(&mut byte) {
            Ok(0) | Err(_) => return line,
            Ok(_) => {
                line.push(byte[0]);
                if byte[0] == b'\n' {
                    return line;
                }
            }
        }
    }
}

/// "stdin EOF means exit" (docs §1). A real `multicc-remote` stops within a
/// second; this fixture stops at once and records the EOF for the test.
fn watch_lifeline() {
    let marker = std::env::var_os("FIXTURE_STDIN_FILE");
    std::thread::spawn(move || {
        let mut sink = Vec::new();
        let _ = std::io::stdin().read_to_end(&mut sink);
        if let Some(path) = marker {
            let _ = std::fs::write(format!("{}.eof", path.to_string_lossy()), b"eof");
        }
        std::process::exit(0);
    });
}

fn park() -> ! {
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

fn serve() {
    if let Some(ms) = number("FIXTURE_READY_DELAY_MS") {
        std::thread::sleep(Duration::from_millis(ms));
    }
    if std::env::var("FIXTURE_STDERR").ok().as_deref() == Some("1") {
        eprintln!("alpha");
        eprintln!();
        eprintln!("   ");
        eprintln!("beta");
        eprintln!("{}", "L".repeat(700));
    }
    let listener = match TcpListener::bind(("127.0.0.1", 0)) {
        Ok(listener) => listener,
        Err(_) => std::process::exit(12),
    };
    let port = match listener.local_addr() {
        Ok(address) => address.port(),
        Err(_) => std::process::exit(13),
    };
    let secret = env_or("FIXTURE_SECRET", "fixture-secret");
    println!(r#"{{"ready":true,"v":1,"port":{port},"secret":"{secret}"}}"#);
    let _ = std::io::stdout().flush();
    if let Some(ms) = number("FIXTURE_EXIT_AFTER_MS") {
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(ms));
            std::process::exit(exit_code(7));
        });
    }
    for stream in listener.incoming().flatten() {
        let secret = secret.clone();
        std::thread::spawn(move || handle(stream, &secret));
    }
}

fn handle(mut stream: TcpStream, secret: &str) {
    let Some(request) = read_request(&mut stream) else {
        return;
    };
    record(&request, secret);
    match env_or("FIXTURE_HTTP", "echo").as_str() {
        "stream" => stream_body(stream),
        "stall" => stall(stream),
        "no-head" => stall_head(stream),
        "truncate" => truncate(stream),
        _ => echo(stream, &request),
    }
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        match stream.read(&mut byte) {
            Ok(0) | Err(_) => return None,
            Ok(_) => head.push(byte[0]),
        }
        if head.len() > 64 * 1024 {
            return None;
        }
    }
    let text = String::from_utf8_lossy(&head);
    let mut lines = text.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_string();
    let target = first.next()?.to_string();
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    let length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    if length > 0 && stream.read_exact(&mut body).is_err() {
        return None;
    }
    Some(Request {
        method,
        target,
        headers,
        body,
    })
}

fn header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request
        .headers
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

/// One JSON line per request: what the front door forwarded.
fn record(request: &Request, secret: &str) {
    let Some(path) = std::env::var_os("FIXTURE_REQUESTS_FILE") else {
        return;
    };
    let headers = request
        .headers
        .iter()
        .map(|(name, value)| format!("\"{}\":\"{}\"", escape(name), escape(value)))
        .collect::<Vec<_>>()
        .join(",");
    let line = format!(
        "{{\"method\":\"{}\",\"target\":\"{}\",\"headers\":{{{}}},\"body\":\"{}\",\"secretOk\":{}}}\n",
        escape(&request.method),
        escape(&request.target),
        headers,
        escape(&String::from_utf8_lossy(&request.body)),
        header(request, "x-multicc-remote-secret") == Some(secret),
    );
    append(&path.to_string_lossy(), &line);
}

fn echo(mut stream: TcpStream, request: &Request) {
    let body = format!(
        "{{\"method\":\"{}\",\"target\":\"{}\",\"body\":\"{}\"}}",
        escape(&request.method),
        escape(&request.target),
        escape(&String::from_utf8_lossy(&request.body))
    );
    let status = number("FIXTURE_STATUS").unwrap_or(200);
    let _ = write!(
        stream,
        "HTTP/1.1 {status} OK\r\ncontent-type: application/json\r\ncache-control: no-store\r\n\
         x-screen-marker: fixture\r\nx-region-top: 3\r\nx-secret-leak: leak\r\n\
         set-cookie: session=abc\r\ncontent-length: {}\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.flush();
}

/// Chunked streaming; chunk 1 is written at once so a client can prove the
/// first bytes arrive before the upstream finishes.
fn stream_body(mut stream: TcpStream) {
    let spacing = number("FIXTURE_CHUNK_MS").unwrap_or(200);
    let chunks = number("FIXTURE_CHUNKS").unwrap_or(3);
    let head = "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\nx-screen-stream: 1\r\n\
                transfer-encoding: chunked\r\n\r\n";
    if stream.write_all(head.as_bytes()).is_err() {
        aborted();
        return;
    }
    let mut index = 0u64;
    loop {
        if chunks != 0 && index >= chunks {
            break;
        }
        if index > 0 && !sleep_alive(&mut stream, spacing) {
            aborted();
            return;
        }
        index += 1;
        let payload = format!("chunk-{index}");
        if stream
            .write_all(format!("{:x}\r\n{payload}\r\n", payload.len()).as_bytes())
            .is_err()
        {
            aborted();
            return;
        }
        if stream.flush().is_err() {
            aborted();
            return;
        }
    }
    let _ = stream.write_all(b"0\r\n\r\n");
    let _ = stream.flush();
}

/// Headers with a body that never comes: the forwarder's idle timeout fires.
fn stall(mut stream: TcpStream) {
    let _ = stream
        .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: image/jpeg\r\ncontent-length: 100\r\n\r\n");
    let _ = stream.flush();
    // Stay up until the other side hangs up, so the test can look at what the
    // client saw.
    let mut byte = [0u8; 64];
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.read(&mut byte);
}

/// Accepts the request and never answers: the forwarder's response-head idle
/// timeout has to fire while `headersSent` is still false.
fn stall_head(mut stream: TcpStream) {
    let mut byte = [0u8; 64];
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.read(&mut byte);
}

/// Declares 100 bytes, sends 7, hangs up: a broken upstream mid-body.
fn truncate(mut stream: TcpStream) {
    let _ = stream.write_all(
        b"HTTP/1.1 200 OK\r\ncontent-type: image/jpeg\r\ncontent-length: 100\r\n\r\npartial",
    );
    let _ = stream.flush();
}

fn aborted() {
    if let Some(path) = std::env::var_os("FIXTURE_ABORT_FILE") {
        append(&path.to_string_lossy(), "aborted\n");
    }
}

/// Sleeps in small steps so a client that leaves mid-stream is noticed.
fn sleep_alive(stream: &mut TcpStream, millis: u64) -> bool {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(5)));
    let mut spent = 0;
    let mut byte = [0u8; 64];
    while spent < millis {
        match stream.read(&mut byte) {
            Ok(0) => return false,
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return false,
        }
        std::thread::sleep(Duration::from_millis(5));
        spent += 5;
    }
    true
}

fn append(path: &str, text: &str) {
    use std::fs::OpenOptions;
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(text.as_bytes());
    }
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other if (other as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", other as u32)),
            other => out.push(other),
        }
    }
    out
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn number(name: &str) -> Option<u64> {
    std::env::var(name).ok()?.trim().parse().ok()
}

fn exit_code(default: i32) -> i32 {
    std::env::var("FIXTURE_EXIT_CODE")
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(default)
}
