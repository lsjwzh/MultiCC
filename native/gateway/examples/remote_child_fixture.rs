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
//! | `FIXTURE_PID_FILE` | write this process' pid here (process-existence checks) |
//! | `FIXTURE_FAIL_FIRST` | exit before ready once, using this path as the marker |
//! | `FIXTURE_READY_DELAY_MS` | wait before printing the ready line |
//! | `FIXTURE_EXIT_AFTER_MS` / `FIXTURE_EXIT_CODE` | crash this long after ready |
//! | `FIXTURE_STDERR` | `1` writes the stderr lines the log forwarder must clip |
//! | `FIXTURE_SECRET` | the secret the ready line hands out (default `fixture-secret`) |
//! | `FIXTURE_HTTP` | `echo` (default), `stream`, `stall`, `truncate` |
//! | `FIXTURE_STATUS` / `FIXTURE_CHUNKS` / `FIXTURE_CHUNK_MS` | echo status; stream chunk count (`0` = forever) and spacing |
//! | `FIXTURE_REQUESTS_FILE` | append one JSON record per request |
//! | `FIXTURE_ABORT_FILE` | append `aborted` when the client leaves mid-response |
//! | `FIXTURE_ANNOTATION` | `/internal/annotation` answer: `ok` (default), `status500`, `notjson`, `array`, `number`, `stall` |
//! | `FIXTURE_WS` | answer a `/ws/*` upgrade with: `echo` (default), `burst`, `slow`, `close:<code>`, `close-empty`, `drop` |
//! | `FIXTURE_WS_FILE` | append WS events (`open`, `frame:<op>:<len>`, `close:<code>`, `eof`) |
//! | `FIXTURE_WS_STATS_FILE` | overwritten each burst frame with the frames written so far |
//! | `FIXTURE_WS_CHUNK` | bytes per burst frame (default 4096) |
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
    // Test-only: record this process' pid so a test can assert the child is
    // really gone (process existence), not just that it stopped logging.
    if let Some(path) = std::env::var_os("FIXTURE_PID_FILE") {
        let _ = std::fs::write(path, std::process::id().to_string());
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
    if request.target == "/internal/annotation" {
        if let Some(mode) = std::env::var("FIXTURE_ANNOTATION")
            .ok()
            .filter(|value| !value.is_empty())
        {
            annotation(stream, &mode);
            return;
        }
    }
    // The WS bridge always dials `/ws/remote-screen...`; scoping the switch to
    // that target lets one fixture process serve the HTTP forward
    // (`/api/remote-screen`) and the WS bridge together, which is what the
    // shared-child wiring test needs. Every WS-only test dials `/ws/*` too, so
    // their behavior is unchanged.
    if std::env::var_os("FIXTURE_WS").is_some() && request.target.starts_with("/ws/") {
        ws_serve(stream, &request);
        return;
    }
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

/// `/internal/annotation` answers (`FIXTURE_ANNOTATION`). The request has
/// already been recorded; this only picks the reply the front-door relay must
/// classify (ok / non-200 / unparsable / valid array / non-object JSON /
/// never).
fn annotation(mut stream: TcpStream, mode: &str) {
    let (status, body) = match mode {
        "status500" => (500, "{}"),
        "notjson" => (200, "this is not json"),
        "array" => (200, r#"[{"ok":true}]"#),
        "number" => (200, "123"),
        "stall" => return stall(stream),
        _ => (200, r#"{"ok":true,"refresh":true,"text":"done"}"#),
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status} OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
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

// ── WebSocket server (docs §4) ──────────────────────────────────────────────
//
// A minimal RFC 6455 server: the handshake, plus just enough framing for the
// bridge tests. Everything is std: SHA-1 and base64 are hand-rolled so the
// example needs neither the crate's runtime dependencies nor a new
// dev-dependency.

const WS_CLOSE: u8 = 0x8;
const WS_TEXT: u8 = 0x1;
const WS_BINARY: u8 = 0x2;

fn ws_serve(mut stream: TcpStream, request: &Request) {
    let key = header(request, "sec-websocket-key")
        .unwrap_or("")
        .to_string();
    let accept = base64(&sha1(
        format!("{key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11").as_bytes(),
    ));
    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\
         sec-websocket-accept: {accept}\r\n\r\n"
    );
    if stream.write_all(response.as_bytes()).is_err() || stream.flush().is_err() {
        return;
    }
    ws_event("open");
    let mode = env_or("FIXTURE_WS", "echo");
    if mode == "drop" {
        // No close frame: the peer sees an abrupt EOF (ws code 1006).
        return;
    }
    if mode == "burst" {
        ws_burst(&mut stream);
        return;
    }
    let slow = mode == "slow";
    let close_after_first = mode
        .strip_prefix("close:")
        .and_then(|code| code.trim().parse::<u16>().ok());
    let close_empty = mode == "close-empty";
    loop {
        let Some((opcode, payload)) = ws_read(&mut stream) else {
            ws_event("eof");
            return;
        };
        match opcode {
            WS_TEXT | WS_BINARY => {
                ws_event(&format!("frame:{opcode}:{}", payload.len()));
                if let Some(code) = close_after_first {
                    ws_send_close(&mut stream, code, "");
                    return;
                }
                if close_empty {
                    let _ = ws_write(&mut stream, WS_CLOSE, &[]);
                    return;
                }
                if slow {
                    std::thread::sleep(Duration::from_millis(10));
                }
                if ws_write(&mut stream, opcode, &payload).is_err() {
                    return;
                }
            }
            WS_CLOSE => {
                let code = if payload.len() >= 2 {
                    u16::from_be_bytes([payload[0], payload[1]])
                } else {
                    1005
                };
                ws_event(&format!("close:{code}"));
                ws_send_close(&mut stream, code, "");
                return;
            }
            _ => {}
        }
    }
}

/// Sends binary frames as fast as the peer reads, recording the running count.
/// A paused reader stalls the writes here, so the counter plateaus — the
/// statistics assertion the backpressure test reads.
fn ws_burst(stream: &mut TcpStream) {
    let chunk = number("FIXTURE_WS_CHUNK").unwrap_or(4096) as usize;
    let payload = vec![b'B'; chunk.max(1)];
    let mut written: u64 = 0;
    loop {
        if ws_write(stream, WS_BINARY, &payload).is_err() {
            return;
        }
        written += 1;
        if let Some(path) = std::env::var_os("FIXTURE_WS_STATS_FILE") {
            let _ = std::fs::write(path, written.to_string());
        }
    }
}

fn ws_event(text: &str) {
    if let Some(path) = std::env::var_os("FIXTURE_WS_FILE") {
        append(&path.to_string_lossy(), &format!("{text}\n"));
    }
}

fn ws_send_close(stream: &mut TcpStream, code: u16, reason: &str) {
    let mut payload = code.to_be_bytes().to_vec();
    payload.extend_from_slice(reason.as_bytes());
    let _ = ws_write(stream, WS_CLOSE, &payload);
}

fn ws_write(stream: &mut TcpStream, opcode: u8, payload: &[u8]) -> std::io::Result<()> {
    let mut frame = Vec::with_capacity(payload.len() + 10);
    frame.push(0x80 | opcode);
    let length = payload.len();
    if length < 126 {
        frame.push(length as u8);
    } else if length <= 0xffff {
        frame.push(126);
        frame.extend_from_slice(&(length as u16).to_be_bytes());
    } else {
        frame.push(127);
        frame.extend_from_slice(&(length as u64).to_be_bytes());
    }
    frame.extend_from_slice(payload);
    stream.write_all(&frame)?;
    stream.flush()
}

/// Reads one (unfragmented) client frame, unmasking it. Client frames are
/// always masked.
fn ws_read(stream: &mut TcpStream) -> Option<(u8, Vec<u8>)> {
    let mut head = [0u8; 2];
    stream.read_exact(&mut head).ok()?;
    let opcode = head[0] & 0x0f;
    let masked = head[1] & 0x80 != 0;
    let mut length = (head[1] & 0x7f) as u64;
    if length == 126 {
        let mut ext = [0u8; 2];
        stream.read_exact(&mut ext).ok()?;
        length = u16::from_be_bytes(ext) as u64;
    } else if length == 127 {
        let mut ext = [0u8; 8];
        stream.read_exact(&mut ext).ok()?;
        length = u64::from_be_bytes(ext);
    }
    let mut mask = [0u8; 4];
    if masked {
        stream.read_exact(&mut mask).ok()?;
    }
    let mut payload = vec![0u8; length as usize];
    if length > 0 {
        stream.read_exact(&mut payload).ok()?;
    }
    if masked {
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[index % 4];
        }
    }
    Some((opcode, payload))
}

/// SHA-1 (FIPS 180-1), just for `Sec-WebSocket-Accept`.
fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut message = data.to_vec();
    let bit_len = (data.len() as u64).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());
    for offset in (0..message.len()).step_by(64) {
        let block = &message[offset..offset + 64];
        let mut w = [0u32; 80];
        for (index, word) in w.iter_mut().take(16).enumerate() {
            let bytes = &block[index * 4..index * 4 + 4];
            *word = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        }
        for index in 16..80 {
            w[index] = (w[index - 3] ^ w[index - 8] ^ w[index - 14] ^ w[index - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (index, word) in w.iter().enumerate() {
            let (f, k) = match index {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut digest = [0u8; 20];
    for (index, word) in h.iter().enumerate() {
        digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    digest
}

fn base64(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let byte0 = chunk[0] as u32;
        let byte1 = *chunk.get(1).unwrap_or(&0) as u32;
        let byte2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (byte0 << 16) | (byte1 << 8) | byte2;
        out.push(ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[triple as usize & 0x3f] as char
        } else {
            '='
        });
    }
    out
}
