//! End-to-end tests for the Rust front door. Each test runs the real
//! `multicc-gateway` binary against a Node fixture that parses the PROXY line
//! itself; nothing here depends on src/gateway-child.js.

use std::fs;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const GATEWAY_BIN: &str = env!("CARGO_BIN_EXE_multicc-gateway");
const FIXTURE: &str = include_str!("fixtures/upstream.js");

fn node_binary() -> String {
    std::env::var("MULTICC_TEST_NODE").unwrap_or_else(|_| "node".to_string())
}

fn unique(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "multicc-gateway-test-{}-{tag}-{nanos}",
        std::process::id()
    ))
}

fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

struct Gateway {
    dir: PathBuf,
    state: PathBuf,
    port: u16,
    child: Child,
}

impl Gateway {
    fn start(tag: &str, mode: &str, extra: &[(&str, String)]) -> Self {
        // free_port() releases its probe, and tests run in parallel: another
        // front door may take that number as its internal port first. That is
        // a harness race (production keeps the public port bound), so retry
        // on a fresh port instead of failing the test.
        Self::start_with(tag, mode, extra, false)
    }

    /// Like `start`, but our parent holds the gateway's stdin
    /// (`--stdin-lifeline`); drop `child.stdin` to ask it to stop.
    fn start_with(tag: &str, mode: &str, extra: &[(&str, String)], lifeline: bool) -> Self {
        for _ in 0..5 {
            let mut gateway = Self::spawn(tag, mode, extra, None, lifeline);
            if gateway.wait_ready_unless_port_taken() {
                return gateway;
            }
        }
        panic!("could not find a free public port for the gateway after 5 attempts");
    }

    fn wait_ready_unless_port_taken(&mut self) -> bool {
        let deadline = Instant::now() + Duration::from_secs(15);
        while !self.state.join("ready").exists() {
            if self.child.try_wait().unwrap().is_some() && self.log().contains("cannot bind") {
                return false;
            }
            if Instant::now() >= deadline {
                panic!(
                    "gateway/fixture never became ready\n--- gateway log ---\n{}",
                    self.log()
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        true
    }

    fn start_on(tag: &str, port: u16) -> Self {
        Self::spawn(tag, "echo", &[], Some(port), false)
    }

    fn spawn(
        tag: &str,
        mode: &str,
        extra: &[(&str, String)],
        port: Option<u16>,
        lifeline: bool,
    ) -> Self {
        let dir = unique(tag);
        let state = dir.join("state");
        fs::create_dir_all(&state).unwrap();
        fs::write(dir.join("server.js"), FIXTURE).unwrap();
        let port = port.unwrap_or_else(free_port);
        let log = fs::File::create(dir.join("gateway.log")).unwrap();
        let mut command = Command::new(GATEWAY_BIN);
        command
            .arg("serve")
            .arg("--cwd")
            .arg(&dir)
            .arg("--node")
            .arg(node_binary())
            .args(lifeline.then_some("--stdin-lifeline"))
            .arg("server.js")
            .env_clear()
            .env(
                "PATH",
                std::env::var_os("PATH").unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin".into()),
            )
            .env("PORT", port.to_string())
            .env("MULTICC_GATEWAY_UPSTREAM_WAIT_MS", "3000")
            .env("MULTICC_GATEWAY_BACKOFF_SCALE", "0.01")
            .env("FIXTURE_MODE", mode)
            .env("FIXTURE_STATE_DIR", &state)
            .stdin(if lifeline {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::null())
            .stderr(Stdio::from(log));
        // Windows needs its system variables even in a cleared environment
        // (Winsock reads SystemRoot); none of them exist elsewhere.
        for key in [
            "HOME",
            "TMPDIR",
            "SystemRoot",
            "SYSTEMROOT",
            "windir",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "PATHEXT",
            "ComSpec",
        ] {
            let value = std::env::var_os(key);
            if let Some(value) = value {
                command.env(key, value);
            }
        }
        for (key, value) in extra {
            command.env(key, value);
        }
        let child = command.spawn().expect("spawn multicc-gateway");
        Gateway {
            dir,
            state,
            port,
            child,
        }
    }

    fn log(&self) -> String {
        fs::read_to_string(self.dir.join("gateway.log")).unwrap_or_default()
    }

    fn connect(&self) -> TcpStream {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match TcpStream::connect(("127.0.0.1", self.port)) {
                Ok(stream) => {
                    stream.set_nodelay(true).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(30)))
                        .unwrap();
                    stream
                        .set_write_timeout(Some(Duration::from_secs(30)))
                        .unwrap();
                    return stream;
                }
                Err(error) if Instant::now() < deadline => {
                    let _ = error;
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("cannot connect to gateway: {error}\n{}", self.log()),
            }
        }
    }

    fn wait_exit(&mut self, timeout: Duration) -> Option<ExitStatus> {
        let deadline = Instant::now() + timeout;
        loop {
            match self.child.try_wait().unwrap() {
                Some(status) => return Some(status),
                None if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
                None => return None,
            }
        }
    }

    fn ports(&self) -> Vec<u16> {
        fs::read_to_string(self.state.join("ports.log"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| line.trim().parse().ok())
            .collect()
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn read_all(stream: &mut TcpStream) -> Vec<u8> {
    let mut out = Vec::new();
    stream.read_to_end(&mut out).unwrap();
    out
}

fn read_until(stream: &mut TcpStream, needle: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut byte = [0_u8; 1];
    while !out.ends_with(needle) {
        match stream.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => out.push(byte[0]),
            Err(error) => panic!("read failed: {error}"),
        }
    }
    out
}

fn payload(size: usize) -> Vec<u8> {
    let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
    (0..size)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 24) as u8
        })
        .collect()
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn expected_header(client_port: u16, gateway_port: u16) -> String {
    format!("PROXY TCP4 127.0.0.1 127.0.0.1 {client_port} {gateway_port}\n")
}

#[test]
fn upstream_receives_the_front_doors_own_proxy_header() {
    let gateway = Gateway::start("header", "report-header", &[]);
    let mut client = gateway.connect();
    let client_port = client.local_addr().unwrap().port();
    let response = read_all(&mut client);
    assert_eq!(
        String::from_utf8_lossy(&response),
        expected_header(client_port, gateway.port),
        "{}",
        gateway.log()
    );
}

#[test]
fn eight_megabytes_round_trip_byte_for_byte() {
    let gateway = Gateway::start("bulk", "echo", &[]);
    let mut client = gateway.connect();
    let data = payload(8 * 1024 * 1024);
    let mut writer = client.try_clone().unwrap();
    let sending = data.clone();
    let handle = std::thread::spawn(move || {
        writer.write_all(&sending).unwrap();
        writer.shutdown(Shutdown::Write).unwrap();
    });
    let received = read_all(&mut client);
    handle.join().unwrap();
    assert_eq!(received.len(), data.len(), "{}", gateway.log());
    assert_eq!(sha256(&received), sha256(&data));
}

#[test]
fn half_close_is_propagated_and_the_reply_survives() {
    let gateway = Gateway::start("half-close", "echo", &[]);
    let mut client = gateway.connect();
    client.write_all(b"hello half close").unwrap();
    client.shutdown(Shutdown::Write).unwrap();
    assert_eq!(read_all(&mut client), b"hello half close");
}

#[test]
fn an_upgrade_response_is_followed_by_raw_bytes() {
    let gateway = Gateway::start("upgrade", "upgrade", &[]);
    let mut client = gateway.connect();
    client
        .write_all(b"GET /upgrade HTTP/1.1\r\nHost: test\r\n\r\n")
        .unwrap();
    let headers = read_until(&mut client, b"\r\n\r\n");
    assert!(
        headers.starts_with(b"HTTP/1.1 101 Switching Protocols\r\n"),
        "{}",
        String::from_utf8_lossy(&headers)
    );
    client.write_all(b"raw upgrade bytes").unwrap();
    let mut echo = vec![0_u8; b"raw upgrade bytes".len()];
    client.read_exact(&mut echo).unwrap();
    assert_eq!(echo, b"raw upgrade bytes");
    client.shutdown(Shutdown::Write).unwrap();
}

#[test]
fn a_crashed_node_is_relaunched_and_the_next_connection_succeeds() {
    // The fixture exits 1 on its first run and serves on the second; the fast
    // BACKOFF_SCALE makes the relaunch immediate.
    let gateway = Gateway::start("crash-restart", "exit-1-once", &[]);
    assert!(
        gateway.ports().len() >= 2,
        "the fixture should have run twice: {:?}",
        gateway.ports()
    );
    let mut client = gateway.connect();
    client.write_all(b"after restart").unwrap();
    client.shutdown(Shutdown::Write).unwrap();
    assert_eq!(read_all(&mut client), b"after restart");
}

#[test]
fn exit_75_relaunches_quickly_on_a_different_internal_port() {
    let gateway = Gateway::start("port-75", "exit-75-once", &[]);
    let ports = gateway.ports();
    assert_eq!(ports.len(), 2, "{ports:?}\n{}", gateway.log());
    assert_ne!(
        ports[0], ports[1],
        "exit 75 must move to a new internal port"
    );
    let mut client = gateway.connect();
    client.write_all(b"new internal port").unwrap();
    client.shutdown(Shutdown::Write).unwrap();
    assert_eq!(read_all(&mut client), b"new internal port");
}

#[cfg(unix)]
#[test]
fn node_exits_on_its_own_when_the_front_door_is_killed() {
    let mut gateway = Gateway::start("lifeline", "echo", &[]);
    let pid: libc::pid_t = fs::read_to_string(gateway.state.join("pids.log"))
        .unwrap()
        .lines()
        .next()
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    // SIGKILL: the front door gets no chance to forward anything.
    gateway.child.kill().unwrap();
    gateway.child.wait().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    // SAFETY: signal 0 only probes whether the pid still exists.
    while unsafe { libc::kill(pid, 0) } == 0 {
        assert!(
            Instant::now() < deadline,
            "node outlived a SIGKILLed front door (orphan pid {pid})"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(unix)]
#[test]
fn sigint_is_forwarded_and_the_front_door_exits_with_the_child() {
    let marker = unique("signal-marker");
    let gateway = Gateway::start(
        "sigint",
        "echo",
        &[("FIXTURE_SIGNAL_MARKER", marker.display().to_string())],
    );
    // SAFETY: signalling the gateway process we just spawned.
    unsafe {
        libc::kill(gateway.child.id() as libc::pid_t, libc::SIGINT);
    }
    let mut gateway = gateway;
    let status = gateway
        .wait_exit(Duration::from_secs(10))
        .expect("the front door did not exit after SIGINT");
    assert_eq!(status.code(), Some(0), "{}", gateway.log());
    assert_eq!(fs::read_to_string(&marker).unwrap_or_default(), "SIGINT");
    assert_eq!(
        gateway.ports().len(),
        1,
        "a stopping front door must not relaunch node"
    );
    let _ = fs::remove_file(marker);
}

#[test]
fn an_unreachable_upstream_gets_a_503_after_the_wait() {
    let gateway = Gateway::start(
        "unreachable",
        "no-listen",
        &[("MULTICC_GATEWAY_UPSTREAM_WAIT_MS", "300".to_string())],
    );
    let mut client = gateway.connect();
    let response = read_all(&mut client);
    let text = String::from_utf8_lossy(&response);
    assert!(
        text.starts_with("HTTP/1.1 503 Service Unavailable\r\n"),
        "{text}"
    );
    assert!(text.contains("Retry-After: 2\r\n"), "{text}");
    assert!(text.contains("Connection: close\r\n"), "{text}");
}

#[test]
fn an_occupied_public_port_makes_the_front_door_exit_nonzero() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut gateway = Gateway::start_on("occupied", port);
    let status = gateway
        .wait_exit(Duration::from_secs(5))
        .expect("the front door should fail fast when the port is taken");
    assert_ne!(status.code(), Some(0), "{}", gateway.log());
    // Supervisors recognise a taken port by Node's errno name.
    assert!(gateway.log().contains("EADDRINUSE"), "{}", gateway.log());
    drop(listener);
}

#[test]
fn closing_its_stdin_stops_node_and_then_the_front_door() {
    let marker = unique("lifeline-marker");
    let mut gateway = Gateway::start_with(
        "stdin-lifeline",
        "echo",
        &[("FIXTURE_SIGNAL_MARKER", marker.display().to_string())],
        true,
    );
    drop(gateway.child.stdin.take());
    let status = gateway
        .wait_exit(Duration::from_secs(10))
        .expect("the front door did not stop after its stdin closed");
    assert_eq!(status.code(), Some(0), "{}", gateway.log());
    assert!(
        gateway.log().contains("stdin closed by our parent"),
        "{}",
        gateway.log()
    );
    // Unix forwards SIGINT; Windows closes Node's own lifeline instead.
    #[cfg(unix)]
    assert_eq!(fs::read_to_string(&marker).unwrap_or_default(), "SIGINT");
    assert_eq!(
        gateway.ports().len(),
        1,
        "a stopping front door must not relaunch node"
    );
    let _ = fs::remove_file(marker);
}

#[test]
fn without_the_flag_a_closed_stdin_changes_nothing() {
    // `nohup` and launchd hand us an stdin that reads EOF at once.
    let gateway = Gateway::start("no-lifeline", "echo", &[]);
    let mut gateway = gateway;
    assert!(
        gateway.wait_exit(Duration::from_millis(600)).is_none(),
        "{}",
        gateway.log()
    );
    let mut client = gateway.connect();
    client.write_all(b"still here").unwrap();
    client.shutdown(Shutdown::Write).unwrap();
    assert_eq!(read_all(&mut client), b"still here");
}

#[test]
fn node_exiting_zero_on_its_own_stops_the_front_door() {
    let mut gateway = Gateway::start("exit-zero", "exit-0-on-connect", &[]);
    let _client = gateway.connect();
    let status = gateway
        .wait_exit(Duration::from_secs(10))
        .expect("a clean exit from node must end the front door");
    assert_eq!(status.code(), Some(0), "{}", gateway.log());
    assert!(
        gateway.log().contains("on its own; stopping"),
        "{}",
        gateway.log()
    );
    assert_eq!(
        gateway.ports().len(),
        1,
        "a clean exit is not a crash: no relaunch"
    );
}

#[test]
fn a_forged_proxy_line_arrives_after_the_front_doors_own_line() {
    let gateway = Gateway::start("forged", "report-header-echo", &[]);
    let mut client = gateway.connect();
    let client_port = client.local_addr().unwrap().port();
    let forged = b"PROXY TCP4 9.9.9.9 8.8.8.8 1111 2222\r\nGET / HTTP/1.1\r\n\r\n";
    // Write before reading anything: the front door must still write its own
    // header first.
    client.write_all(forged).unwrap();
    client.shutdown(Shutdown::Write).unwrap();
    let response = read_all(&mut client);
    let header = expected_header(client_port, gateway.port);
    assert!(
        response.starts_with(header.as_bytes()),
        "first bytes were {:?}",
        String::from_utf8_lossy(&response[..response.len().min(120)])
    );
    assert_eq!(&response[header.len()..], forged);
}
