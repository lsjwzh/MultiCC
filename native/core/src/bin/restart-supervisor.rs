use fs2::FileExt;
use multicc_core::{
    restart_probe::{gateway_pid, is_local_address, probe, ProbeResult},
    restart_process::{wait_for_exit, ProcessObserver},
    restart_supervisor::{Event, LaunchMode, State, Supervisor},
};
use serde::Deserialize;
use std::{
    env, fs,
    io::{self, Read, Write},
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
struct ClientConfig {
    origin: String,
    expected_pids: Vec<u32>,
    port: Option<u16>,
    #[serde(default)]
    token: String,
}

#[derive(Deserialize)]
struct HoldConfig {
    node: PathBuf,
    launcher: PathBuf,
    data: PathBuf,
}

fn hold_foreground(config: HoldConfig) -> io::Result<()> {
    // The caller owns the write end. EOF means its terminal/process is gone;
    // D disarms the guard after an explicit external stop.
    let mut byte = [0u8; 1];
    let count = io::stdin().read(&mut byte)?;
    if count == 1 && byte[0] == b'D' {
        return Ok(());
    }
    let status = Command::new(config.node)
        .arg(config.launcher)
        .args(["--stop", "--data"])
        .arg(config.data)
        .stdin(Stdio::null())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other("foreground stop failed"))
    }
}

async fn request_restart(config: ClientConfig) -> Result<(), Box<dyn std::error::Error>> {
    let mut origin = reqwest::Url::parse(&config.origin)?;
    let host = origin.host_str().unwrap_or("").to_owned();
    let literal = host.trim_matches(['[', ']']).parse::<IpAddr>().ok();
    let addresses = origin
        .port_or_known_default()
        .and_then(|port| (host.trim_matches(['[', ']']), port).to_socket_addrs().ok())
        .map(|items| items.collect::<Vec<_>>())
        .unwrap_or_default();
    let local = !addresses.is_empty()
        && addresses
            .iter()
            .all(|address| is_local_address(address.ip()));
    if origin.scheme() != "http"
        || !local
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.port_or_known_default().is_none()
    {
        return Err("restart client requires a local HTTP origin".into());
    }
    origin.set_path("/readyz");
    origin.set_query(None);
    origin.set_fragment(None);
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3));
    if literal.is_none() {
        builder = builder.resolve_to_addrs(&host, &addresses);
    }
    let client = builder.build()?;
    let initial = client.get(origin.clone()).send().await?;
    let old_pid: u32 = initial
        .headers()
        .get("x-multicc-gateway-pid")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or("gateway identity unavailable")?;
    if !config.expected_pids.contains(&old_pid) {
        return Err("gateway identity does not match the selected installation".into());
    }
    let observer = ProcessObserver::open(old_pid)?;
    let mut endpoint = origin.clone();
    endpoint.set_path("/api/restart");
    let mut body = serde_json::json!({"expectedPid": old_pid});
    if let Some(port) = config.port {
        body["port"] = serde_json::json!(port);
    }
    // A loopback request never needs the access token. This also keeps a
    // hostname resolver from forwarding it outside the local interface.
    let token = if addresses.iter().all(|address| address.ip().is_loopback()) {
        ""
    } else {
        config.token.as_str()
    };
    let response = client
        .post(endpoint)
        .header("x-access-token", token)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await?;
    if response.status().as_u16() != 202 {
        return Err(format!(
            "restart request rejected (HTTP {})",
            response.status().as_u16()
        )
        .into());
    }
    let body: serde_json::Value = serde_json::from_slice(&response.bytes().await?)?;
    let generation = body
        .get("restartId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("restart acknowledgement lacks identity")?
        .to_owned();
    if let Some(port) = config.port {
        origin
            .set_port(Some(port))
            .map_err(|_| "invalid restart port")?;
    }
    eprintln!("Restart scheduled; waiting for the new instance to become ready...");
    // Source restarts may need a clean Rust build before the new gateway runs.
    let deadline = Instant::now() + Duration::from_secs(700);
    while Instant::now() < deadline {
        if let Ok(response) = client.get(origin.clone()).send().await {
            let id = response
                .headers()
                .get("x-multicc-restart-generation")
                .and_then(|v| v.to_str().ok());
            if response.status().as_u16() == 200 && id == Some(generation.as_str()) {
                let payload = response.bytes().await?;
                if serde_json::from_slice::<serde_json::Value>(&payload)
                    .ok()
                    .and_then(|v| v.get("status").and_then(|v| v.as_str()).map(str::to_owned))
                    .as_deref()
                    == Some("ready")
                    && observer.exited()?
                {
                    println!("MultiCC restarted and is ready at {origin}");
                    return Ok(());
                }
            } else if response.status().as_u16() == 200 && observer.exited()? {
                return Err("restart port is occupied by an unverified service".into());
            }
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    Err("restart did not complete; inspect restart-supervisor.log".into())
}

#[derive(Deserialize)]
struct Config {
    mode: String,
    old_pid: u32,
    port: u16,
    #[serde(default = "loopback")]
    probe_host: String,
    #[serde(default)]
    current_port: Option<u16>,
    #[serde(default)]
    verify_initial: bool,
    generation: String,
    generation_file: PathBuf,
    #[serde(default)]
    port_file: Option<PathBuf>,
    lock_file: PathBuf,
    cwd: PathBuf,
    gateway: PathBuf,
    #[serde(default)]
    source_launcher: Option<PathBuf>,
    node: PathBuf,
    log_path: PathBuf,
    #[serde(default = "old_timeout")]
    old_timeout_ms: u64,
    #[serde(default = "ready_timeout")]
    ready_timeout_ms: u64,
}
fn old_timeout() -> u64 {
    80_000
}
fn loopback() -> String {
    "127.0.0.1".into()
}
fn ready_timeout() -> u64 {
    120_000
}

#[cfg(target_os = "macos")]
fn launchd_owns(pid: u32) -> Result<bool, String> {
    let child = Command::new("/bin/launchctl")
        .args(["list", "com.multicc.server"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let mut child = child.map_err(|_| "cannot inspect launchd ownership")?;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("launchd ownership check timed out".into());
            }
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|_| "cannot read launchd ownership")?;
    if !output.status.success() {
        return Ok(false);
    }
    Ok(launchd_pid(&String::from_utf8_lossy(&output.stdout)) == Some(pid))
}

#[cfg(any(target_os = "macos", test))]
fn launchd_pid(text: &str) -> Option<u32> {
    text.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        (key.trim().trim_matches('"') == "PID")
            .then(|| value.trim().trim_end_matches(';').trim().parse().ok())
            .flatten()
    })
}

#[cfg(not(target_os = "macos"))]
fn launchd_owns(_pid: u32) -> Result<bool, String> {
    Ok(false)
}

struct Marker<'a>(&'a PathBuf, &'a str);
impl Drop for Marker<'_> {
    fn drop(&mut self) {
        if fs::read_to_string(self.0).ok().as_deref() == Some(self.1) {
            let _ = fs::remove_file(self.0);
        }
    }
}

fn run(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let mut mode = match config.mode.as_str() {
        "source" => LaunchMode::SourceForeground,
        "background" => LaunchMode::Background,
        "standalone" => LaunchMode::Standalone,
        "desktop" => LaunchMode::Desktop,
        _ => return Err("invalid restart mode".into()),
    };
    if mode == LaunchMode::Background && launchd_owns(config.old_pid)? {
        // launchd owns the next spawn; never compete with its KeepAlive job.
        mode = LaunchMode::Standalone;
        eprintln!("restart delegated to the matching launchd service");
    }
    if config.port == 0
        || config.generation.is_empty()
        || config.generation.len() > 128
        || !config
            .generation
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("invalid restart configuration".into());
    }
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&config.lock_file)?;
    lock.try_lock_exclusive()
        .map_err(|_| "restart already in progress")?;
    let old = ProcessObserver::open(config.old_pid)?;
    let probe_host = match config.probe_host.as_str() {
        "0.0.0.0" => "127.0.0.1",
        "::" => "::1",
        value => value,
    };
    let candidates = (probe_host, config.current_port.unwrap_or(config.port))
        .to_socket_addrs()?
        .filter(|address| is_local_address(address.ip()))
        .collect::<Vec<_>>();
    let selected = if config.verify_initial {
        candidates.into_iter().find(|address| {
            gateway_pid(*address, Duration::from_millis(1500))
                .ok()
                .flatten()
                == Some(config.old_pid)
        })
    } else {
        candidates.into_iter().next()
    };
    let address = SocketAddr::new(
        selected
            .ok_or("cannot verify the original local gateway address")?
            .ip(),
        config.port,
    );
    fs::write(&config.generation_file, &config.generation)?;
    let _marker = Marker(&config.generation_file, &config.generation);
    let port_marker = format!("{}:{}", config.generation, config.port);
    if let Some(path) = &config.port_file {
        fs::write(path, &port_marker)?;
    }
    let _port_marker = config
        .port_file
        .as_ref()
        .map(|path| Marker(path, &port_marker));
    // The caller starts graceful shutdown only after the lock and observer exist.
    println!("READY");
    io::stdout().flush()?;
    let mut state = Supervisor::new(mode, 3).ok_or("invalid attempt limit")?;
    if !wait_for_exit(
        &old,
        Duration::from_millis(config.old_timeout_ms),
        Duration::from_millis(100),
    )? {
        state.observe(Event::OldExitTimeout);
        return Err("old instance did not exit before deadline".into());
    }
    state.observe(Event::OldExited);
    let ready_ms = if mode == LaunchMode::Background
        && config.source_launcher.is_some()
        && config.ready_timeout_ms == ready_timeout()
    {
        600_000
    } else {
        config.ready_timeout_ms
    };
    let deadline = Instant::now() + Duration::from_millis(ready_ms);
    let mut child: Option<Child> = None;
    loop {
        if Instant::now() >= deadline {
            state.observe(Event::ReadinessTimeout);
            return Err("new instance did not become ready before deadline".into());
        }
        match probe(address, &config.generation, Duration::from_millis(500)) {
            Ok(ProbeResult::Ready) => {
                state.observe(Event::VerifiedNewInstanceReady);
                if state.state() == State::Ready {
                    break;
                }
            }
            Ok(ProbeResult::ForeignService) => {
                state.observe(Event::PortOccupied);
                return Err(
                    "port occupied by an unverified service; no process was terminated".into(),
                );
            }
            Ok(ProbeResult::NotReady | ProbeResult::Unreachable) => {}
            Err(error) => eprintln!("readiness probe: {error}"),
        }
        if matches!(state.state(), State::Launch { .. }) {
            let output = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&config.log_path)?;
            let errors = output.try_clone()?;
            let mut command = if let Some(launcher) = &config.source_launcher {
                let mut command = Command::new(&config.node);
                command.arg(launcher).env("MULTICC_SOURCE_DAEMON", "1");
                command
            } else {
                let mut command = Command::new(&config.gateway);
                command
                    .args(["serve", "--cwd"])
                    .arg(&config.cwd)
                    .arg("--node")
                    .arg(&config.node)
                    .arg("server.js");
                command
            };
            match command
                .current_dir(&config.cwd)
                .env("MULTICC_RESTART_GENERATION", &config.generation)
                .env("MULTICC_RESTART_EXACT_PORT", "1")
                .env_remove("MULTICC_GATEWAY_CHILD")
                .env_remove("MULTICC_GATEWAY_PID")
                .env_remove("MULTICC_RESTART_CONFIG")
                .stdin(Stdio::null())
                .stdout(Stdio::from(output))
                .stderr(Stdio::from(errors))
                .spawn()
            {
                Ok(next) => {
                    child = Some(next);
                    state.observe(Event::LaunchStarted);
                }
                Err(error) => {
                    eprintln!("launch failed: {error}");
                    state.observe(Event::LaunchFailed);
                }
            }
        }
        if let Some(process) = child.as_mut() {
            if let Some(status) = process.try_wait()? {
                eprintln!("started process exited: {status}");
                state.observe(Event::StartedProcessExited);
                child = None;
            }
        }
        if let State::Failed(reason) = state.state() {
            return Err(format!("restart failed: {reason:?}").into());
        }
        thread::sleep(Duration::from_millis(250));
    }
    eprintln!("restart complete: verified new instance is ready");
    Ok(())
}

fn main() {
    if env::args().any(|arg| arg == "--version") {
        println!("restart-supervisor 1 {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if env::args().any(|arg| arg == "--request") {
        let mut input = String::new();
        let result = io::stdin()
            .take(65537)
            .read_to_string(&mut input)
            .map_err(|e| e.to_string())
            .and_then(|_| {
                if input.len() > 65536 {
                    Err("request too large".into())
                } else {
                    serde_json::from_str(&input).map_err(|e| e.to_string())
                }
            })
            .and_then(|config| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|e| e.to_string())?
                    .block_on(request_restart(config))
                    .map_err(|e| e.to_string())
            });
        if let Err(error) = result {
            eprintln!("restart-supervisor: {error}");
            std::process::exit(1);
        }
        return;
    }
    if env::args().any(|arg| arg == "--hold") {
        let result = env::var("MULTICC_RESTART_HOLD")
            .map_err(|e| e.to_string())
            .and_then(|value| serde_json::from_str(&value).map_err(|e| e.to_string()))
            .and_then(|config| hold_foreground(config).map_err(|e| e.to_string()));
        if let Err(error) = result {
            eprintln!("restart-supervisor: {error}");
            std::process::exit(1);
        }
        return;
    }
    let result = env::var("MULTICC_RESTART_CONFIG")
        .map_err(|e| e.to_string())
        .and_then(|value| serde_json::from_str(&value).map_err(|e| e.to_string()))
        .and_then(|config| run(config).map_err(|e| e.to_string()));
    if let Err(error) = result {
        eprintln!("restart-supervisor: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn launchd_output_requires_the_exact_pid_field() {
        assert_eq!(super::launchd_pid("{\n  \"PID\" = 123;\n}"), Some(123));
        assert_eq!(super::launchd_pid("{ \"OtherPID\" = 123; }"), None);
        assert_eq!(super::launchd_pid("{\n  \"PID\" = bad;\n}"), None);
    }
}
