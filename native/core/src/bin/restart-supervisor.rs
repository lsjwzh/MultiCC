use fs2::FileExt;
use multicc_core::{
    restart_probe::{probe, ProbeResult},
    restart_process::{wait_for_exit, ProcessObserver},
    restart_supervisor::{Event, LaunchMode, State, Supervisor},
};
use serde::Deserialize;
use std::{
    env, fs,
    io::{self, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
struct Config {
    mode: String,
    old_pid: u32,
    port: u16,
    #[serde(default = "loopback")]
    probe_host: IpAddr,
    generation: String,
    generation_file: PathBuf,
    lock_file: PathBuf,
    cwd: PathBuf,
    gateway: PathBuf,
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
fn loopback() -> IpAddr {
    IpAddr::V4(Ipv4Addr::LOCALHOST)
}
fn ready_timeout() -> u64 {
    120_000
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
    let mode = match config.mode.as_str() {
        "source" => LaunchMode::SourceForeground,
        "background" => LaunchMode::Background,
        "standalone" => LaunchMode::Standalone,
        "desktop" => LaunchMode::Desktop,
        _ => return Err("invalid restart mode".into()),
    };
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
        .open(&config.lock_file)?;
    lock.try_lock_exclusive()
        .map_err(|_| "restart already in progress")?;
    let old = ProcessObserver::open(config.old_pid)?;
    fs::write(&config.generation_file, &config.generation)?;
    let _marker = Marker(&config.generation_file, &config.generation);
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
    if !config.probe_host.is_loopback() {
        return Err("restart probe host must be loopback".into());
    }
    let address = SocketAddr::new(config.probe_host, config.port);
    let deadline = Instant::now() + Duration::from_millis(config.ready_timeout_ms);
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
            match Command::new(&config.gateway)
                .args(["serve", "--cwd"])
                .arg(&config.cwd)
                .arg("--node")
                .arg(&config.node)
                .arg("server.js")
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
    let result = env::var("MULTICC_RESTART_CONFIG")
        .map_err(|e| e.to_string())
        .and_then(|value| serde_json::from_str(&value).map_err(|e| e.to_string()))
        .and_then(|config| run(config).map_err(|e| e.to_string()));
    if let Err(error) = result {
        eprintln!("restart-supervisor: {error}");
        std::process::exit(1);
    }
}
