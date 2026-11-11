//! Integration coverage for `GET/HEAD/OPTIONS /api/token-usage/global` against
//! the real `multicc-gateway` binary. The Node process here is only the
//! protocol fixture (PROXY v1 + auth control), exactly like `tests/gateway.rs`;
//! no Node route or oracle runs.
//!
//! The answer contains today/week/month windows, so the fixture HOME is written
//! relative to the run's clock in a pinned zone (`TZ=Asia/Shanghai`): one row
//! today, one 40 days back (never in `today`/`week`/`month`), and a Codex
//! rollout for today. The frozen Node oracle and the online byte comparison
//! live in docs/rust-migration/differential/token-usage-global.js; this test
//! owns the HTTP contract (status, headers, dedupe, cache/refresh, 500).

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::{Duration as ChronoDuration, Utc};
use serde_json::{json, Value};

const GATEWAY_BIN: &str = env!("CARGO_BIN_EXE_multicc-gateway");
const FIXTURE_JS: &str = include_str!("fixtures/upstream.js");
const TOKEN: &str = "secret-token-1";
const TIMEZONE: &str = "Asia/Shanghai";

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-token-usage-{}-{tag}-{nanos}",
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
    body: Vec<u8>,
}

impl Response {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

struct Gateway {
    dir: PathBuf,
    home: PathBuf,
    port: u16,
    child: Child,
}

impl Gateway {
    fn start(tag: &str, timezone: &str) -> Self {
        let dir = unique(tag);
        let data = dir.join("data");
        let home = dir.join("home");
        let state = dir.join("state");
        for path in [&dir, &data, &home, &state] {
            fs::create_dir_all(path).unwrap();
        }
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
            .env("TZ", timezone)
            .env("MULTICC_DATA_DIR", &data)
            .env("MULTICC_GATEWAY_UPSTREAM_WAIT_MS", "3000")
            .env("MULTICC_GATEWAY_BACKOFF_SCALE", "0.01")
            .env("FIXTURE_MODE", "echo")
            .env("FIXTURE_STATE_DIR", &state)
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
        let gateway = Self {
            dir,
            home,
            port,
            child,
        };
        let deadline = Instant::now() + Duration::from_secs(15);
        while !state.join("ready").exists() {
            assert!(
                Instant::now() < deadline,
                "gateway never became ready\n{}",
                gateway.log()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        gateway
    }

    fn log(&self) -> String {
        fs::read_to_string(self.dir.join("gateway.log")).unwrap_or_default()
    }

    fn exchange(&self, method: &str, url: &str, extra: &[(&str, &str)]) -> Response {
        let mut request = format!(
            "{method} {url} HTTP/1.1\r\nHost: localhost\r\nX-Request-Id: diff-req-1\r\nConnection: close\r\n"
        );
        for (name, value) in extra {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        request.push_str("\r\n");
        // The gateway's port is probed and released before it binds, so a
        // parallel run can briefly steer a fresh connection at another
        // listener that resets it. Replay only when nothing was read: a reset
        // after any byte arrived means the response really was cut short.
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
        Response {
            status,
            headers,
            body: raw[split + 4..].to_vec(),
        }
    }

    fn write_claude(&self, relative: &str, rows: &[String]) {
        let file = self.home.join(".claude/projects").join(relative);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, rows.join("\n") + "\n").unwrap();
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// `YYYY-MM-DDThh:00:00+08:00` for a local day offset from today.
fn local_stamp(days_ago: i64, hour: u32) -> String {
    let zone: chrono_tz::Tz = TIMEZONE.parse().unwrap();
    let now = Utc::now().with_timezone(&zone);
    let date = (now - ChronoDuration::days(days_ago)).date_naive();
    format!("{}T{:02}:00:00+08:00", date, hour)
}

fn local_day(days_ago: i64) -> String {
    let zone: chrono_tz::Tz = TIMEZONE.parse().unwrap();
    let now = Utc::now().with_timezone(&zone);
    (now - ChronoDuration::days(days_ago))
        .date_naive()
        .format("%Y-%m-%d")
        .to_string()
}

fn claude_row(timestamp: &str, request: &str, model: &str, input: f64, output: f64) -> String {
    json!({
        "timestamp": timestamp,
        "requestId": request,
        "type": "assistant",
        "message": {
            "id": request,
            "model": model,
            "usage": {
                "input_tokens": input,
                "output_tokens": output,
                "cache_creation_input_tokens": 2,
                "cache_read_input_tokens": 3,
            }
        }
    })
    .to_string()
}

fn seed_home(gateway: &Gateway) {
    let today = claude_row(&local_stamp(0, 3), "req-1", "claude-test", 10.0, 5.0);
    let duplicate = today.clone();
    let older = claude_row(&local_stamp(40, 3), "req-old", "claude-old", 7.0, 1.0);
    gateway.write_claude("p1/session.jsonl", &[today, duplicate, older]);
    let codex = gateway
        .home
        .join(".codex/sessions/2026/11/11/rollout.jsonl");
    fs::create_dir_all(codex.parent().unwrap()).unwrap();
    let stamp = local_stamp(0, 2);
    fs::write(
        &codex,
        format!(
            "{{\"type\":\"session_meta\",\"timestamp\":\"{stamp}\",\"payload\":{{\"id\":\"thread\"}}}}\n\
             {{\"type\":\"turn_context\",\"timestamp\":\"{stamp}\",\"payload\":{{\"model\":\"gpt-test\"}}}}\n\
             {{\"type\":\"event_msg\",\"timestamp\":\"{stamp}\",\"payload\":{{\"type\":\"token_count\",\"info\":{{\"total_token_usage\":{{\"input_tokens\":100,\"cached_input_tokens\":40,\"output_tokens\":10}}}}}}}}\n"
        ),
    )
    .unwrap();
}

fn num(value: &Value) -> f64 {
    value
        .as_f64()
        .unwrap_or_else(|| panic!("not a number: {value}"))
}

/// Expected `claude-test` totals for a given fixture revision.
struct Totals {
    scanned: f64,
    responses: f64,
    input: f64,
    output: f64,
    cache_write: f64,
    cache_read: f64,
    msgs: f64,
    by_day: f64,
    by_day_fresh: f64,
}

const BEFORE_EXTRA_FILE: Totals = Totals {
    scanned: 2.0,
    responses: 3.0,
    input: 10.0,
    output: 5.0,
    cache_write: 2.0,
    cache_read: 3.0,
    msgs: 1.0,
    by_day: 20.0,
    by_day_fresh: 15.0,
};

const AFTER_EXTRA_FILE: Totals = Totals {
    scanned: 3.0,
    responses: 4.0,
    input: 11.0,
    output: 6.0,
    cache_write: 4.0,
    cache_read: 6.0,
    msgs: 2.0,
    by_day: 27.0,
    by_day_fresh: 17.0,
};

fn assert_success(body: &Value, totals: &Totals) {
    assert_eq!(num(&body["scannedFiles"]), totals.scanned, "{body}");
    assert_eq!(num(&body["responses"]), totals.responses, "{body}");
    let all = &body["windows"]["all"]["claude-test"];
    assert_eq!(num(&all["inputTokens"]), totals.input, "{body}");
    assert_eq!(num(&all["outputTokens"]), totals.output, "{body}");
    assert_eq!(num(&all["cacheWrite"]), totals.cache_write, "{body}");
    assert_eq!(num(&all["cacheRead"]), totals.cache_read, "{body}");
    assert_eq!(num(&all["msgs"]), totals.msgs, "{body}");
    assert_eq!(body["windows"]["today"]["claude-test"], *all);
    // The duplicate row in the same file never counts twice.
    assert_eq!(
        num(&body["windows"]["all"]["claude-old"]["inputTokens"]),
        7.0
    );
    assert!(
        body["windows"]["month"].get("claude-old").is_none(),
        "40 days ago is never in this month: {body}"
    );
    let codex = &body["windows"]["all"]["gpt-test"];
    assert_eq!(num(&codex["inputTokens"]), 60.0);
    assert_eq!(num(&codex["cacheRead"]), 40.0);
    assert_eq!(
        num(&body["byDay"][local_day(0)]["claude-test"]),
        totals.by_day
    );
    assert_eq!(
        num(&body["byDayFresh"][local_day(0)]["claude-test"]),
        totals.by_day_fresh
    );
    assert_eq!(num(&body["byDay"][local_day(40)]["claude-old"]), 13.0);
}

#[test]
fn token_usage_global_scans_dedupes_and_caches() {
    let started = Utc::now();
    let gateway = Gateway::start("success", TIMEZONE);
    seed_home(&gateway);

    fs::create_dir_all(&gateway.home).unwrap();
    let first = gateway.exchange("GET", "/api/token-usage/global", &[]);
    assert_eq!(first.status, 200, "{}", gateway.log());
    assert_eq!(
        first.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    let body: Value = serde_json::from_str(&first.text()).unwrap();
    assert_success(&body, &BEFORE_EXTRA_FILE);
    assert_eq!(
        body["sources"]["claude"],
        json!(gateway.home.join(".claude/projects").to_string_lossy())
    );
    assert_eq!(
        body["sources"]["codex"],
        json!(gateway.home.join(".codex/sessions").to_string_lossy())
    );
    let generated = body["generatedAt"].as_str().unwrap();
    assert_eq!(generated.len(), 24, "toISOString form: {generated}");
    assert!(generated.ends_with('Z'));
    let stamp = chrono::DateTime::parse_from_rfc3339(generated).unwrap();
    let finished = Utc::now();
    assert!(
        stamp.with_timezone(&Utc) >= started - ChronoDuration::seconds(1)
            && stamp.with_timezone(&Utc) <= finished + ChronoDuration::seconds(1),
        "generatedAt must be this run's clock: {generated}"
    );

    // A cache hit returns the identical body, even after a new file appears.
    gateway.write_claude(
        "p1/later.jsonl",
        &[claude_row(
            &local_stamp(0, 4),
            "req-2",
            "claude-test",
            1.0,
            1.0,
        )],
    );
    let cached = gateway.exchange("GET", "/api/token-usage/global", &[]);
    assert_eq!(cached.status, 200);
    assert_eq!(
        cached.text(),
        first.text(),
        "cache hit must be byte identical"
    );
    // refresh=true is not the established flag and must not force a scan.
    let spelled = gateway.exchange("GET", "/api/token-usage/global?refresh=true", &[]);
    assert_eq!(spelled.text(), first.text());
    // refresh=1 rescans and sees the new file.
    let refreshed = gateway.exchange("GET", "/api/token-usage/global?refresh=1", &[]);
    assert_eq!(refreshed.status, 200);
    let body: Value = serde_json::from_str(&refreshed.text()).unwrap();
    assert_success(&body, &AFTER_EXTRA_FILE);
    assert_ne!(refreshed.text(), first.text());

    // HEAD answers the cached refresh answer with no body.
    let head = gateway.exchange("HEAD", "/api/token-usage/global", &[]);
    assert_eq!(head.status, 200);
    assert_eq!(head.body, Vec::<u8>::new(), "HEAD never carries a body");
    assert_eq!(
        head.header("content-length"),
        refreshed.header("content-length")
    );
    assert_eq!(head.header("etag"), refreshed.header("etag"));
    // OPTIONS is Express's automatic answer for the GET route.
    let options = gateway.exchange("OPTIONS", "/api/token-usage/global", &[]);
    assert_eq!(options.status, 200);
    assert_eq!(options.header("allow"), Some("GET,HEAD"));
    assert_eq!(options.text(), "GET,HEAD");
}

#[test]
fn token_usage_global_reports_an_unusable_timezone_as_the_public_500() {
    let gateway = Gateway::start("bad-timezone", "Bogus/Zone");
    fs::create_dir_all(&gateway.home).unwrap();
    let response = gateway.exchange("GET", "/api/token-usage/global", &[]);
    assert_eq!(response.status, 500, "{}", gateway.log());
    assert_eq!(
        response.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    assert_eq!(
        response.text(),
        "{\"error\":\"Token usage is temporarily unavailable\"}"
    );
    // The failed scan must not be cached: the same request fails again.
    let again = gateway.exchange("GET", "/api/token-usage/global", &[]);
    assert_eq!(again.status, 500);
}

#[test]
fn token_usage_global_is_zero_without_transcripts() {
    let gateway = Gateway::start("empty", TIMEZONE);
    let response = gateway.exchange("GET", "/api/token-usage/global", &[]);
    assert_eq!(response.status, 200, "{}", gateway.log());
    let body: Value = serde_json::from_str(&response.text()).unwrap();
    assert_eq!(num(&body["scannedFiles"]), 0.0);
    assert_eq!(num(&body["responses"]), 0.0);
    assert_eq!(body["windows"]["all"], json!({}));
    assert_eq!(body["byDay"], json!({}));
}
