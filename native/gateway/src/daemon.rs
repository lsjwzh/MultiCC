//! The front door itself: bind the public port, spawn and supervise Node on a
//! loopback internal port, and serve each client connection over HTTP/1 with a
//! router whose fallback forwards to Node 1:1 with a PROXY v1 header in front.

use std::io;
use std::net::{TcpListener as StdListener, ToSocketAddrs};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use multicc_core::network_policy::{find_available_port, resolve_network_policy};
use serde_json::{Map, Value};
use tokio::net::{TcpListener, TcpSocket};

use crate::app::App;
use crate::args::ServeOptions;
use crate::backoff::RestartPolicy;
use crate::forward::{native_routes, serve_connection, UpstreamHandle};

const DEFAULT_UPSTREAM_WAIT_MS: u64 = 30_000;
/// §6: while Node is down, retry the upstream connection every 100ms.
const UPSTREAM_RETRY: Duration = Duration::from_millis(100);
/// How often the supervisor looks at the child.
const TICK: Duration = Duration::from_millis(50);

fn log(message: &str) {
    // eprintln! panics when stderr is gone (a closed pipe); a log line must
    // never take down the process that owns the public port.
    use std::io::Write;
    let _ = writeln!(io::stderr(), "[multicc-gateway] {message}");
}

/// `--version` of the front door, printed by `main.rs`.
pub async fn serve(options: ServeOptions) -> i32 {
    if let Err(error) = std::env::set_current_dir(&options.cwd) {
        log(&format!("cannot enter {}: {error}", options.cwd.display()));
        return 1;
    }
    let dotenv_keys = load_dotenv(Path::new("."));
    let policy = match resolve_network_policy(&current_env()) {
        Ok(policy) => policy,
        Err(message) => {
            log(&message);
            return 1;
        }
    };
    let port = if policy.development {
        match find_available_port(i64::from(policy.port), &policy.host, 100) {
            Ok(port) => port,
            Err(message) => {
                log(&message);
                return 1;
            }
        }
    } else {
        policy.port
    };
    let listener = match bind_public(&policy.host, port) {
        Ok(listener) => listener,
        Err(error) => {
            // Node names this errno EADDRINUSE; the desktop supervisor and the
            // standalone launcher recognise a taken port by that word.
            let errno = if error.kind() == io::ErrorKind::AddrInUse {
                "EADDRINUSE: "
            } else {
                ""
            };
            log(&format!(
                "cannot bind {}:{port}: {errno}{error}",
                policy.host
            ));
            return 1;
        }
    };
    log(&format!(
        "listening on {}:{port}{}",
        policy.host,
        if policy.development {
            " (development port)"
        } else {
            ""
        }
    ));

    let upstream_wait = upstream_wait();
    // One router for every client connection; the per-connection upstream
    // handle is attached to each request by `serve_connection`.
    let app = Arc::new(App::from_env(&options, &policy));
    let root = app.data_root.clone();
    match tokio::task::spawn_blocking(move || crate::app::services::Runtime::load(&root)).await {
        Ok(Ok(runtime)) => {
            let _ = app.services.set(Arc::new(runtime));
        }
        _ => {
            log("cannot initialize service routes");
            return 1;
        }
    }
    let root = app.data_root.clone();
    match tokio::task::spawn_blocking(move || {
        multicc_core::workspace_sharing::external::Runtime::open(root.join("external-fleets.json"))
    })
    .await
    {
        Ok(Ok(runtime)) => {
            let _ = app.external_workspaces.set(Arc::new(runtime));
        }
        _ => {
            log("cannot initialize external workspaces");
            return 1;
        }
    }
    let router = native_routes(Arc::clone(&app));
    let mut supervisor = Supervisor::new(
        &options,
        port,
        RestartPolicy::new(backoff_scale()),
        dotenv_keys,
        Arc::clone(&app.auth),
        Arc::clone(&app.source_workspaces),
    );
    supervisor.start();
    let mut signals = match Signals::new() {
        Ok(signals) => signals,
        Err(error) => {
            log(&format!("cannot install signal handlers: {error}"));
            return 1;
        }
    };
    let mut parent_lifeline = options.stdin_lifeline.then(watch_stdin);
    let mut shutting_down = false;
    let mut exit_code: Option<i32> = None;

    loop {
        tokio::select! {
            accepted = listener.accept(), if !shutting_down => {
                match accepted {
                    Ok((stream, peer)) => {
                        let local = stream.local_addr().unwrap_or(peer);
                        let upstream =
                            UpstreamHandle::new(supervisor.upstream_port(), upstream_wait, peer, local);
                        let router = router.clone();
                        tokio::spawn(async move {
                            let _ = stream.set_nodelay(true);
                            serve_connection(stream, router, upstream).await;
                        });
                    }
                    Err(error) => {
                        log(&format!("accept failed: {error}"));
                        tokio::time::sleep(UPSTREAM_RETRY).await;
                    }
                }
            }
            signal = signals.next() => {
                match signal {
                    GatewaySignal::Hangup => log("SIGHUP ignored"),
                    GatewaySignal::Interrupt | GatewaySignal::Terminate => {
                        if !shutting_down {
                            shutting_down = true;
                            log("stop signal received; forwarding it to node and no longer accepting");
                        }
                        if !supervisor.request_stop(signal) {
                            // Nothing left to wait for.
                            exit_code = Some(0);
                        }
                    }
                }
            }
            _ = parent_gone(&mut parent_lifeline) => {
                parent_lifeline = None;
                if !shutting_down {
                    shutting_down = true;
                    log("stdin closed by our parent; stopping node and no longer accepting");
                }
                if !supervisor.request_stop(GatewaySignal::Interrupt) {
                    exit_code = Some(0);
                }
            }
            _ = tokio::time::sleep(TICK) => {}
        }

        if let Some((code, ran_for)) = supervisor.poll() {
            if shutting_down {
                log(&format!("node exited with {code}"));
                exit_code = Some(code);
            } else if code == 0 {
                // §7: Node only exits 0 on its own when it was asked to stop
                // for good (/api/desktop-shutdown) or to be restarted by
                // whoever started us (/api/restart in desktop mode). Either
                // way the decision is our parent's, exactly as it was before a
                // front door stood in between.
                log("node exited with 0 on its own; stopping");
                exit_code = Some(0);
            } else {
                log(&format!("node exited with {code}; scheduling a restart"));
                supervisor.schedule_restart(code, ran_for);
            }
        }
        // A restart that falls due in the same tick as a stop signal must not
        // spawn a Node we are about to abandon.
        if !shutting_down {
            supervisor.start_if_due();
        }
        if exit_code.is_some() {
            break;
        }
    }
    exit_code.unwrap_or(0)
}

/// §2: returns the keys this front door took from `.env`, so the child does
/// not inherit them: Node reads `.env` itself, and a value the UI rewrote
/// there (ACCESS_TOKEN) must win when Node is relaunched.
fn load_dotenv(directory: &Path) -> Vec<String> {
    let path = directory.join(".env");
    // §2: a missing .env is not an error.
    let Ok(bytes) = std::fs::read(&path) else {
        return Vec::new();
    };
    // Node's readFileSync(path, 'utf8') replaces invalid sequences.
    let text = String::from_utf8_lossy(&bytes);
    multicc_core::dotenv::apply_to_process_env(&text)
        .into_iter()
        .map(|(key, _)| key)
        .collect()
}

fn current_env() -> Map<String, Value> {
    std::env::vars()
        .map(|(key, value)| (key, Value::String(value)))
        .collect()
}

fn upstream_wait() -> Duration {
    let milliseconds = std::env::var("MULTICC_GATEWAY_UPSTREAM_WAIT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_UPSTREAM_WAIT_MS);
    Duration::from_millis(milliseconds)
}

fn backoff_scale() -> f64 {
    std::env::var("MULTICC_GATEWAY_BACKOFF_SCALE")
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(1.0)
}

/// Node's `server.listen` uses a backlog of 511; std's default is 128.
const NODE_BACKLOG: u32 = 511;

fn bind_public(host: &str, port: u16) -> io::Result<TcpListener> {
    let mut last_error = None;
    for address in (host, port).to_socket_addrs()? {
        let attempt = || -> io::Result<TcpListener> {
            let socket = if address.is_ipv4() {
                TcpSocket::new_v4()?
            } else {
                TcpSocket::new_v6()?
            };
            // libuv sets SO_REUSEADDR on every Unix listener.
            #[cfg(unix)]
            socket.set_reuseaddr(true)?;
            socket.bind(address)?;
            socket.listen(NODE_BACKLOG)
        };
        match attempt() {
            Ok(listener) => return Ok(listener),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error
        .unwrap_or_else(|| io::Error::new(io::ErrorKind::AddrNotAvailable, "no address to bind")))
}

/// §3: bind `127.0.0.1:0`, keep the number, release the probe socket.
fn reserve_internal_port() -> io::Result<u16> {
    let listener = StdListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// Exit 75 means "this internal port is taken", so the replacement must not be
/// the same number. The probe for the old port was released before Node even
/// started, so a fresh `:0` bind can hand it back; retry a few times.
fn reserve_other_internal_port(previous: u16) -> io::Result<u16> {
    for _ in 0..64 {
        let port = reserve_internal_port()?;
        if port != previous {
            return Ok(port);
        }
    }
    reserve_internal_port()
}

// ── supervision ─────────────────────────────────────────────────────────────

struct Node {
    _auth: crate::auth_control::Registration,
    _source: crate::auth_control::Registration,
    child: Child,
    started: Instant,
    /// Node's stdin. Never written: it only has to stay open. Whenever this
    /// process goes away (clean exit, panic, SIGKILL) the kernel closes it and
    /// Node reads EOF and shuts itself down, so it can never outlive us as an
    /// orphan still running every timer and CLI turn (docs/gateway.md §3).
    /// Windows has no signals: closing it on purpose is how a stop reaches Node.
    #[cfg_attr(unix, allow(dead_code))]
    lifeline: Option<ChildStdin>,
}

struct Supervisor<'a> {
    options: &'a ServeOptions,
    public_port: u16,
    internal_port: u16,
    upstream_port: Arc<AtomicU16>,
    node: Option<Node>,
    restart_at: Option<Instant>,
    policy: RestartPolicy,
    dotenv_keys: Vec<String>,
    auth: Arc<crate::auth_control::Bridge>,
    source: Arc<crate::auth_control::Bridge>,
}

impl<'a> Supervisor<'a> {
    fn new(
        options: &'a ServeOptions,
        public_port: u16,
        policy: RestartPolicy,
        dotenv_keys: Vec<String>,
        auth: Arc<crate::auth_control::Bridge>,
        source: Arc<crate::auth_control::Bridge>,
    ) -> Self {
        // No child exists yet: any value will do until `start` reserves one.
        Self {
            options,
            public_port,
            internal_port: 0,
            upstream_port: Arc::new(AtomicU16::new(0)),
            node: None,
            restart_at: None,
            policy,
            dotenv_keys,
            auth,
            source,
        }
    }

    fn upstream_port(&self) -> Arc<AtomicU16> {
        Arc::clone(&self.upstream_port)
    }

    /// Passes a stop on to Node: the same signal on Unix, EOF on its lifeline
    /// on Windows (both end in Node's graceful shutdown). False when there is
    /// no Node to wait for.
    fn request_stop(&mut self, signal: GatewaySignal) -> bool {
        let Some(node) = self.node.as_mut() else {
            return false;
        };
        #[cfg(unix)]
        forward_signal(node.child.id(), signal);
        #[cfg(not(unix))]
        {
            let _ = signal;
            node.lifeline = None;
        }
        true
    }

    fn start(&mut self) {
        if self.internal_port == 0 {
            match reserve_internal_port() {
                Ok(port) => self.internal_port = port,
                Err(error) => {
                    log(&format!("cannot reserve an internal port: {error}"));
                    self.restart_at = Some(Instant::now() + Duration::from_millis(500));
                    return;
                }
            }
        }
        self.upstream_port
            .store(self.internal_port, Ordering::SeqCst);
        let auth = match self.auth.open() {
            Ok(auth) => auth,
            Err(_) => {
                log("cannot bind authentication control channel");
                self.restart_at = Some(Instant::now() + Duration::from_millis(500));
                return;
            }
        };
        let source = match self.source.open() {
            Ok(source) => source,
            Err(_) => {
                log("cannot bind workspace source control channel");
                self.restart_at = Some(Instant::now() + Duration::from_millis(500));
                return;
            }
        };
        match spawn_node(
            self.options,
            self.public_port,
            self.internal_port,
            &self.dotenv_keys,
            &auth,
            &source,
        ) {
            Ok(mut child) => {
                log(&format!(
                    "node started (pid {}), internal port {}",
                    child.id(),
                    self.internal_port
                ));
                let lifeline = child.stdin.take();
                self.node = Some(Node {
                    _auth: auth,
                    _source: source,
                    child,
                    started: Instant::now(),
                    lifeline,
                });
                self.restart_at = None;
            }
            Err(error) => {
                log(&format!("cannot start {}: {error}", self.options.node));
                self.restart_at =
                    Some(Instant::now() + self.policy.next_delay(Some(1), Duration::ZERO));
            }
        }
    }

    fn start_if_due(&mut self) {
        if self.node.is_some() {
            return;
        }
        if let Some(at) = self.restart_at {
            if Instant::now() >= at {
                self.restart_at = None;
                self.start();
            }
        }
    }

    /// Returns the child's exit code and how long it ran, and clears it.
    fn poll(&mut self) -> Option<(i32, Duration)> {
        let node = self.node.as_mut()?;
        match node.child.try_wait() {
            Ok(Some(status)) => {
                let code = exit_status_code(status);
                let ran_for = node.started.elapsed();
                self.node = None;
                // Until the replacement starts, the old internal port belongs
                // to nobody; another process could take it and receive client
                // bytes. Clients wait on 0 instead.
                self.upstream_port.store(0, Ordering::SeqCst);
                Some((code, ran_for))
            }
            Ok(None) => None,
            Err(error) => {
                log(&format!("cannot poll node: {error}"));
                None
            }
        }
    }

    fn schedule_restart(&mut self, code: i32, ran_for: Duration) {
        // §4/§7: exit 75 means the internal port was taken; pick a new one.
        if code == 75 {
            match reserve_other_internal_port(self.internal_port) {
                Ok(port) => {
                    self.internal_port = port;
                    log(&format!("internal port collision; trying {port} next"));
                }
                Err(error) => log(&format!("cannot reserve a new internal port: {error}")),
            }
        }
        self.restart_at = Some(Instant::now() + self.policy.next_delay(Some(code), ran_for));
    }
}

fn spawn_node(
    options: &ServeOptions,
    public_port: u16,
    internal_port: u16,
    dotenv_keys: &[String],
    auth: &crate::auth_control::Registration,
    source: &crate::auth_control::Registration,
) -> io::Result<Child> {
    let mut command = Command::new(&options.node);
    for key in dotenv_keys {
        command.env_remove(key);
    }
    command
        .current_dir(&options.cwd)
        .arg(&options.script)
        .args(&options.script_args)
        .env("MULTICC_GATEWAY_CHILD", "1")
        .env("MULTICC_GATEWAY_AUTH_PORT", auth.port.to_string())
        .env("MULTICC_GATEWAY_AUTH_CAPABILITY", &auth.capability)
        .env("MULTICC_GATEWAY_SOURCE_PORT", source.port.to_string())
        .env("MULTICC_GATEWAY_SOURCE_CAPABILITY", &source.capability)
        .env("MULTICC_GATEWAY_INTERNAL_PORT", internal_port.to_string())
        .env("MULTICC_GATEWAY_PID", std::process::id().to_string())
        .env("PORT", public_port.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    // A desktop launcher starts us without a console. Without this flag
    // Windows would give the Node console program a new, visible one.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn()
}

/// §7 `--stdin-lifeline`: a blocking reader thread that reports EOF (or a read
/// error) once. The bytes themselves mean nothing.
fn watch_stdin() -> tokio::sync::oneshot::Receiver<()> {
    let (gone, receiver) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut stdin = io::stdin();
        let mut buffer = [0u8; 256];
        while let Ok(read) = stdin.read(&mut buffer) {
            if read == 0 {
                break;
            }
        }
        let _ = gone.send(());
    });
    receiver
}

async fn parent_gone(lifeline: &mut Option<tokio::sync::oneshot::Receiver<()>>) {
    match lifeline {
        Some(receiver) => {
            let _ = receiver.await;
        }
        None => std::future::pending().await,
    }
}

fn exit_status_code(status: ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    1
}

// ── signals ─────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GatewaySignal {
    Interrupt,
    Terminate,
    Hangup,
}

#[cfg(unix)]
pub struct Signals {
    interrupt: tokio::signal::unix::Signal,
    terminate: tokio::signal::unix::Signal,
    hangup: tokio::signal::unix::Signal,
}

#[cfg(unix)]
impl Signals {
    pub fn new() -> io::Result<Self> {
        use tokio::signal::unix::{signal, SignalKind};
        Ok(Self {
            interrupt: signal(SignalKind::interrupt())?,
            terminate: signal(SignalKind::terminate())?,
            hangup: signal(SignalKind::hangup())?,
        })
    }

    pub async fn next(&mut self) -> GatewaySignal {
        tokio::select! {
            _ = self.interrupt.recv() => GatewaySignal::Interrupt,
            _ = self.terminate.recv() => GatewaySignal::Terminate,
            _ = self.hangup.recv() => GatewaySignal::Hangup,
        }
    }
}

#[cfg(not(unix))]
pub struct Signals;

#[cfg(not(unix))]
impl Signals {
    pub fn new() -> io::Result<Self> {
        Ok(Self)
    }

    pub async fn next(&mut self) -> GatewaySignal {
        let _ = tokio::signal::ctrl_c().await;
        GatewaySignal::Interrupt
    }
}

#[cfg(unix)]
fn forward_signal(pid: u32, signal: GatewaySignal) {
    let number = match signal {
        GatewaySignal::Interrupt => libc::SIGINT,
        GatewaySignal::Terminate => libc::SIGTERM,
        GatewaySignal::Hangup => libc::SIGHUP,
    };
    // SAFETY: kill(2) with a pid we spawned and a signal number from libc.
    unsafe {
        libc::kill(pid as libc::pid_t, number);
    }
}
