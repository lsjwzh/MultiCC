//! 进程级契约（docs/remote-screen-process.md §1/§2/§5）：真启动二进制，
//! 钉住就绪行、stdin-EOF 自杀、--version 与内部 secret 鉴权。
//!
//! 这里不 mock 任何东西 —— 生命周期与握手是 Node 侧唯一的接口，必须端到端跑。

mod support;

use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};
use support::temp_dir;

struct Started {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    port: u16,
    secret: String,
    ready: Value,
}

fn start(config_line: &str, stats: Option<&Path>) -> Started {
    let mut command = Command::new(env!("CARGO_BIN_EXE_multicc-remote"));
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    match stats {
        Some(path) => {
            command.env("MULTICC_REMOTE_STATS_FILE", path);
        }
        None => {
            command.env_remove("MULTICC_REMOTE_STATS_FILE");
        }
    }
    let mut child = command.spawn().expect("起不来 multicc-remote");
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(config_line.as_bytes()).unwrap();
    stdin.write_all(b"\n").unwrap();
    stdin.flush().unwrap();

    let stdout = child.stdout.take().unwrap();
    let (tx, lines) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if tx.send(line.trim_end().to_string()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let line = lines
        .recv_timeout(Duration::from_secs(10))
        .expect("10 秒内没收到就绪行");
    let ready: Value = serde_json::from_str(&line).expect("就绪行不是 JSON");
    let port = ready["port"].as_u64().expect("就绪行缺 port") as u16;
    let secret = ready["secret"].as_str().expect("就绪行缺 secret").to_string();
    Started { child, stdin: Some(stdin), lines, port, secret, ready }
}

/// 原始 HTTP/1.1：这里要验证的是进程自己起的 axum，不引 reqwest 这类重依赖。
fn http_get(
    port: u16,
    path: &str,
    secret: Option<&str>,
) -> (u16, std::collections::HashMap<String, String>, String) {
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).expect("连不上就绪行给的端口");
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
    if let Some(secret) = secret {
        request.push_str(&format!("x-multicc-remote-secret: {secret}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).unwrap();
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((text.as_str(), ""));
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .expect("状态行读不出来");
    let headers: std::collections::HashMap<String, String> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    (status, headers, body.to_string())
}

fn wait_exit(child: &mut Child, limit: Duration) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + limit;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return Some(status);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

impl Drop for Started {
    fn drop(&mut self) {
        // 测完不留进程：这是本测试自己起的，必须自己收掉。
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn ready_line_stdin_eof_exit_stats_file_and_secret_auth() {
    let dir = temp_dir("process");
    let stats_path = dir.join("remote-stats.json");
    let config = format!("{{\"v\":1,\"dir\":{}}}", serde_json::to_string(&dir).unwrap());
    let started = start(&config, Some(&stats_path));

    // §1 就绪行：四个字段，secret 是 64 位十六进制，端口只绑回环。
    assert_eq!(started.ready["ready"], serde_json::json!(true));
    assert_eq!(started.ready["v"], serde_json::json!(1));
    assert_eq!(started.secret.len(), 64);
    assert!(started.secret.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    assert_eq!(
        started.ready.as_object().unwrap().keys().cloned().collect::<Vec<_>>(),
        vec!["ready", "v", "port", "secret"],
        "就绪行不能多字段：Node 只认这一份"
    );
    let bound = std::net::TcpStream::connect(("127.0.0.1", started.port));
    assert!(bound.is_ok());

    // §2 鉴权：带 secret 正常，不带给 403 且不回任何细节。
    let (status, headers, body) = http_get(started.port, "/api/remote-screen/capabilities", Some(&started.secret));
    assert_eq!(status, 200);
    assert_eq!(headers["content-type"], "application/json; charset=utf-8");
    assert_eq!(headers["cache-control"], "no-store");
    let caps: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(caps["ok"], serde_json::json!(true));
    assert!(caps["streams"].as_object().unwrap().contains_key("h264"));
    assert!(caps["streams"].as_object().unwrap().contains_key("rfb"));

    let (status, headers, body) = http_get(started.port, "/api/remote-screen/capabilities", None);
    assert_eq!(status, 403, "没有 secret 一律 403");
    assert_eq!(body, "", "403 不带任何细节");
    assert!(!headers.contains_key("content-type"));
    let (status, _, body) = http_get(started.port, "/api/remote-screen/capabilities", Some("deadbeef"));
    assert_eq!((status, body.as_str()), (403, ""));

    // §5 统计文件：200 ms 一次，内容是一个完整 JSON（这里没有流）。
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Ok(text) = std::fs::read_to_string(&stats_path) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                assert_eq!(value, serde_json::json!({ "connections": [] }));
                break;
            }
        }
        assert!(Instant::now() < deadline, "统计文件没出现或不是完整 JSON");
        std::thread::sleep(Duration::from_millis(20));
    }

    // §1 stdin 读到 EOF → 1 秒内自己退出；不留孤儿进程。
    let mut started = started;
    drop(started.stdin.take());
    let status = wait_exit(&mut started.child, Duration::from_secs(1))
        .expect("stdin EOF 后 1 秒内必须退出");
    assert_eq!(status.code(), Some(0));
    // stdout 是控制通道：就绪行只有那一行。
    std::thread::sleep(Duration::from_millis(50));
    assert!(started.lines.try_recv().is_err(), "就绪行之后 stdout 不该再有字节");
}

#[test]
fn version_flag_prints_protocol_and_crate_version_without_reading_stdin() {
    let output = Command::new(env!("CARGO_BIN_EXE_multicc-remote"))
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim_end(),
        format!("multicc-remote 1 {}", env!("CARGO_PKG_VERSION"))
    );
    assert_eq!(String::from_utf8_lossy(&output.stderr), "");
}

#[test]
fn a_missing_or_bad_config_exits_with_code_two_and_no_ready_line() {
    let closed = Command::new(env!("CARGO_BIN_EXE_multicc-remote"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(closed.status.code(), Some(2));
    assert_eq!(String::from_utf8_lossy(&closed.stdout), "", "起不来就别打就绪行");

    for line in ["not json", "{\"v\":2,\"dir\":\"/tmp/x\"}", "{\"v\":1}", "{\"v\":1,\"dir\":\"\"}"] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_multicc-remote"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(format!("{line}\n").as_bytes()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "{line}: 配置坏了还不退出");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(status.code(), Some(2), "{line}");
        let mut stdout = String::new();
        child.stdout.take().unwrap().read_to_string(&mut stdout).unwrap();
        assert_eq!(stdout, "", "{line}");
    }
}
