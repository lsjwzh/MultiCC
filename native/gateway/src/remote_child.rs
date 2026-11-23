//! Supervisor for the `multicc-remote` child process and the ready line it
//! hands the front door.
//!
//! This is the Rust half of `src/remote-screen-rust.js` §「启动与看护」
//! (lines 130–269): locate the binary, spawn it with the protocol's stdin
//! lifeline, wait for the single ready line, keep only one start in flight,
//! restart with the 1s → 2 → 4 … 30s backoff that only fires when someone is
//! still asking, and clear the ladder after 60s of stability.
//!
//! Process protocol (docs/remote-screen-process.md §1): the first stdin line is
//! `{"v":1,"dir":DIR}` and stdin stays open (EOF means "exit"); the only stdout
//! line is `{"ready":true,"v":1,"port":…,"secret":…}`; logs go to stderr.
//!
//! Nothing here is wired into the router yet (`crate::app::remote_screen` is the
//! forwarding half and is equally unclaimed). The caller holds one
//! `Arc<RemoteChild>`, calls [`RemoteChild::ensure`] before every forwarded
//! request and [`RemoteChild::shutdown`] when the front door stops.
//!
//! The retired Node module had no shutdown path because the process was the
//! server itself; here the front door owns the listener, so shutdown closes
//! stdin (the same lifeline the child already watches), waits, then kills.

use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{watch, Mutex as AsyncMutex, Notify};

/// Protocol version of the process contract (docs/remote-screen-process.md §1).
pub const PROTOCOL_VERSION: u64 = 1;
/// `READY_TIMEOUT_MS` in src/remote-screen-rust.js.
pub const DEFAULT_READY_TIMEOUT: Duration = Duration::from_millis(10_000);
/// `RESTART_BASE_MS`.
pub const DEFAULT_RESTART_BASE: Duration = Duration::from_millis(1_000);
/// `RESTART_MAX_MS`.
pub const DEFAULT_RESTART_MAX: Duration = Duration::from_millis(30_000);
/// `STABLE_RESET_MS`: a run this long clears the backoff ladder.
pub const DEFAULT_STABLE_RESET: Duration = Duration::from_millis(60_000);
/// How long [`RemoteChild::shutdown`] waits for the stdin-EOF exit before it
/// kills the child. The protocol itself promises an exit within one second.
pub const DEFAULT_SHUTDOWN_GRACE: Duration = Duration::from_millis(2_000);
/// `SESSION` in src/remote-screen-rust.js: the directory name under
/// `<assistDir>` for frozen screenshots.
pub const SESSION: &str = "remote-screen";
/// src/remote-screen-rust.js `BIN_NAME`.
const BIN_NAME: &str = if cfg!(windows) {
    "multicc-remote.exe"
} else {
    "multicc-remote"
};
/// A ready line without a newline beyond this is `bad-ready-line`
/// (`> 64 * 1024` in the Node module).
const READY_LINE_LIMIT: usize = 64 * 1024;
/// Stderr lines are clipped to 500 characters before logging.
const STDERR_LINE_LIMIT: usize = 500;
/// Broadcast capacity for exit notices; a dropped receiver is fine (the WS
/// bridge reconnects), an overflowing one must not block the supervisor.
const EXIT_BROADCAST: usize = 16;

/// Where one log line goes. `None` writes the front door's own
/// `[multicc-gateway] <message>` line to stderr; tests inject a collector.
pub type LogFn = Arc<dyn Fn(&str) + Send + Sync>;

/// Everything that varies per deployment (or per test). The defaults are the
/// production constants above; tests shrink them to milliseconds.
#[derive(Clone)]
pub struct Config {
    /// `MULTICC_REMOTE_BIN`, else the sibling of the front door executable.
    /// `None` resolves that fallback at every start, like `remoteBinary()`.
    pub binary: Option<PathBuf>,
    /// `DIR` = `<assistDir>/remote-screen` (see [`remote_screen_dir`]).
    pub dir: PathBuf,
    pub ready_timeout: Duration,
    pub restart_base: Duration,
    pub restart_max: Duration,
    pub stable_reset: Duration,
    pub shutdown_grace: Duration,
    /// Extra child environment on top of the inherited one. Production passes
    /// nothing; tests pick fake-binary modes with it (never `std::env::set_var`).
    pub env: Vec<(String, String)>,
    pub log: Option<LogFn>,
}

impl Config {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            binary: None,
            dir: dir.into(),
            ready_timeout: DEFAULT_READY_TIMEOUT,
            restart_base: DEFAULT_RESTART_BASE,
            restart_max: DEFAULT_RESTART_MAX,
            stable_reset: DEFAULT_STABLE_RESET,
            shutdown_grace: DEFAULT_SHUTDOWN_GRACE,
            env: Vec::new(),
            log: None,
        }
    }
}

/// What a successful start hands out: the loopback port and the per-process
/// secret every forwarded request carries (`x-multicc-remote-secret`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ready {
    pub port: u16,
    pub secret: String,
}

/// `unavailableError(code)`: the `code` property the retired handler mapped to
/// its 503 / capabilities answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteError {
    pub code: String,
}

impl RemoteError {
    pub fn new(code: impl Into<String>) -> Self {
        Self { code: code.into() }
    }
}

impl std::fmt::Display for RemoteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.code)
    }
}

impl std::error::Error for RemoteError {}

/// `stateSnapshot()`: what a status panel would show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateSnapshot {
    pub pid: Option<u32>,
    pub ready: Option<Ready>,
    pub attempts: u64,
    pub backoff_ms: u64,
    pub restart_pending: bool,
    pub last_error: Option<String>,
}

/// One "the child that was ready has exited" notice. The future WS bridge
/// closes every forwarded session on it (the retired module's `closeForwards`);
/// `stopping` says the exit was ours, so a reconnecting client must not expect
/// a restart.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExitNotice {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub stopping: bool,
}

/// `MULTICC_REMOTE_BIN`, else the `multicc-remote` beside this executable — the
/// front door is staged in the same `native/prebuilt/<platform>-<arch>/`
/// directory as the remote binary (scripts/stage-rust-kernels.js).
pub fn default_binary() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os("MULTICC_REMOTE_BIN") {
        if !value.is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join(BIN_NAME))
}

/// `src/paths.js` `assistDir`: isolated data roots keep it under the root,
/// the package root (the default) keeps the historical `~/.multicc/assist`.
/// `data_root`/`package_root` are the values [`crate::app::App`] already
/// derives from `MULTICC_DATA_DIR`, so this adds no second data-root rule.
pub fn assist_dir(data_root: &Path, package_root: &Path, home_dir: &Path) -> PathBuf {
    if data_root == package_root {
        home_dir.join(".multicc").join("assist")
    } else {
        data_root.join("assist")
    }
}

/// `DIR` in src/remote-screen-rust.js: the frozen-screenshot directory.
pub fn remote_screen_dir(data_root: &Path, package_root: &Path, home_dir: &Path) -> PathBuf {
    assist_dir(data_root, package_root, home_dir).join(SESSION)
}

/// The supervisor. Hold one as `Arc<RemoteChild>`; no global state.
pub struct RemoteChild {
    inner: Arc<Inner>,
}

impl RemoteChild {
    pub fn new(config: Config) -> Self {
        let (exits, _) = tokio::sync::broadcast::channel(EXIT_BROADCAST);
        Self {
            inner: Arc::new(Inner {
                config,
                state: Mutex::new(State::default()),
                exits,
            }),
        }
    }

    /// The configured `DIR` (the annotation path check will need it).
    pub fn dir(&self) -> &Path {
        &self.inner.config.dir
    }

    /// Starts the child if needed and returns its port/secret. Concurrent
    /// callers share one start; inside a backoff window this fails at once
    /// with `restarting` (and records that someone still wants it).
    pub async fn ensure(&self) -> Result<Ready, RemoteError> {
        ensure(&self.inner).await
    }

    pub fn snapshot(&self) -> StateSnapshot {
        snapshot(&self.inner)
    }

    /// Exit notices for whatever forwards exist today (none yet: this is the
    /// hook the WS bridge will subscribe to).
    pub fn subscribe_exits(&self) -> tokio::sync::broadcast::Receiver<ExitNotice> {
        self.inner.exits.subscribe()
    }

    /// Closes stdin (the child's lifeline), waits for the exit, kills after
    /// `shutdown_grace`. Safe to call twice.
    pub async fn shutdown(&self) {
        shutdown(&self.inner).await
    }
}

// ── internals ──────────────────────────────────────────────────────────────

type Outcome = Result<Ready, RemoteError>;

#[derive(Default)]
struct State {
    process: Option<Arc<ProcessHandle>>,
    ready: Option<Ready>,
    /// The in-flight start every concurrent `ensure` waits on.
    starting: Option<watch::Sender<Option<Outcome>>>,
    attempts: u64,
    /// Wait before the *next* crash restart (`state.backoffMs`); it is doubled
    /// when a restart is scheduled, exactly like the retired module.
    backoff_ms: u64,
    /// `restartTimer !== null`.
    restart_pending: bool,
    /// A request arrived inside the backoff window.
    retry_demand: bool,
    last_error: Option<String>,
    stopping: bool,
}

struct Inner {
    config: Config,
    state: Mutex<State>,
    exits: tokio::sync::broadcast::Sender<ExitNotice>,
}

impl Inner {
    /// A poisoned lock must not take the supervisor down; the state it guards
    /// is plain bookkeeping that a panic mid-update can only leave stale.
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn log(&self, message: &str) {
        match &self.config.log {
            Some(sink) => sink(message),
            None => {
                // `eprintln!` panics when stderr is gone; a log line must not
                // take down the process that owns the public port.
                use std::io::Write;
                let _ = writeln!(io::stderr(), "[multicc-gateway] {message}");
            }
        }
    }
}

/// One start attempt. Whoever wins [`Flight::claim`] settles it; the leader,
/// the exit watchdog and a panic guard all race for that single outcome.
struct Flight {
    outcome: watch::Sender<Option<Outcome>>,
    settled: AtomicBool,
}

impl Flight {
    fn claim(&self) -> bool {
        !self.settled.swap(true, Ordering::SeqCst)
    }

    fn publish(&self, result: Outcome) {
        let _ = self.outcome.send(Some(result));
    }

    fn current(&self) -> Option<Outcome> {
        self.outcome.borrow().clone()
    }
}

fn ensure(inner: &Arc<Inner>) -> impl std::future::Future<Output = Outcome> + Send + '_ {
    ensure_inner(Arc::clone(inner))
}

async fn ensure_inner(inner: Arc<Inner>) -> Outcome {
    let mut outcome = {
        let mut state = inner.lock();
        if state.stopping {
            return Err(RemoteError::new("stopping"));
        }
        if let Some(ready) = state.ready.clone() {
            return Ok(ready);
        }
        if let Some(flight) = state.starting.as_ref() {
            flight.subscribe()
        } else if state.restart_pending {
            // Inside a backoff window: fail now, remember the demand, and let
            // the window's own timer start exactly one attempt.
            state.retry_demand = true;
            return Err(RemoteError::new("restarting"));
        } else {
            let (sender, receiver) = watch::channel(None);
            state.starting = Some(sender.clone());
            let leader = Arc::clone(&inner);
            tokio::spawn(async move {
                let flight = Arc::new(Flight {
                    outcome: sender,
                    settled: AtomicBool::new(false),
                });
                let guard = SettleOnDrop {
                    inner: Arc::clone(&leader),
                    flight: Arc::clone(&flight),
                };
                start_process(&leader, &flight).await;
                drop(guard);
            });
            receiver
        }
    };
    loop {
        if let Some(result) = outcome.borrow().clone() {
            return result;
        }
        if outcome.changed().await.is_err() {
            return Err(RemoteError::new("spawn-failed"));
        }
    }
}

/// A panic (or any unwind) inside the leader must not leave every waiter
/// hanging on an unwritten channel: publish the fallback once.
struct SettleOnDrop {
    inner: Arc<Inner>,
    flight: Arc<Flight>,
}

impl Drop for SettleOnDrop {
    fn drop(&mut self) {
        if !self.flight.claim() {
            return;
        }
        self.flight.publish(Err(RemoteError::new("spawn-failed")));
        if let Ok(mut state) = self.inner.state.try_lock() {
            state.starting = None;
        }
    }
}

/// One child, shared between the stdin writer, the watchdog and shutdown.
struct ProcessHandle {
    pid: Option<u32>,
    /// Async mutex on purpose: the first protocol line is written *and*
    /// flushed through it, and shutdown takes the handle to signal EOF.
    stdin: AsyncMutex<Option<ChildStdin>>,
    kill: Notify,
    exited: watch::Sender<bool>,
    ready_published: AtomicBool,
}

impl ProcessHandle {
    async fn write_stdin(&self, bytes: &[u8]) -> io::Result<()> {
        let mut guard = self.stdin.lock().await;
        let Some(stdin) = guard.as_mut() else {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "stdin closed"));
        };
        stdin.write_all(bytes).await?;
        stdin.flush().await
    }

    async fn close_stdin(&self) {
        let mut guard = self.stdin.lock().await;
        guard.take();
    }

    fn request_kill(&self) {
        self.kill.notify_one();
    }

    async fn wait_exit(&self, budget: Duration) -> bool {
        let mut exited = self.exited.subscribe();
        if *exited.borrow() {
            return true;
        }
        let waited = tokio::time::timeout(budget, exited.wait_for(|done| *done)).await;
        matches!(waited, Ok(Ok(_)))
    }
}

async fn start_process(inner: &Arc<Inner>, flight: &Arc<Flight>) {
    let binary = match inner.config.binary.clone().or_else(default_binary) {
        Some(binary) => binary,
        None => {
            settle_failure(inner, flight, None, "binding-missing");
            return;
        }
    };
    if !binary.exists() {
        settle_failure(inner, flight, None, "binding-missing");
        return;
    }
    // The screenshot directory is a convenience for the child; a failure to
    // create it is ignored, exactly like `try { fs.mkdirSync } catch {}`.
    let _ = std::fs::create_dir_all(&inner.config.dir);
    let mut command = Command::new(&binary);
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for (key, value) in &inner.config.env {
        command.env(key, value);
    }
    // A desktop launcher starts the front door without a console; without this
    // flag Windows would give the child a visible one.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            settle_failure(inner, flight, None, &spawn_error_code(&error));
            return;
        }
    };
    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (exited, _) = watch::channel(false);
    let process = Arc::new(ProcessHandle {
        pid,
        stdin: AsyncMutex::new(stdin),
        kill: Notify::new(),
        exited,
        ready_published: AtomicBool::new(false),
    });
    let attempt = {
        let mut state = inner.lock();
        state.attempts += 1;
        state.process = Some(Arc::clone(&process));
        state.attempts
    };
    inner.log(&format!("remote_screen_starting attempt={attempt}"));
    if let Some(stderr) = stderr {
        tokio::spawn(stderr_lines(Arc::clone(inner), stderr));
    }
    tokio::spawn(watch_exit(
        Arc::clone(inner),
        child,
        Arc::clone(&process),
        Arc::clone(flight),
    ));
    let Some(line) = config_line(inner) else {
        settle_failure(inner, flight, Some(&process), "spawn-failed");
        return;
    };
    if process.write_stdin(line.as_bytes()).await.is_err() {
        settle_failure(inner, flight, Some(&process), "stdin-closed");
        return;
    }
    let Some(stdout) = stdout else {
        settle_failure(inner, flight, Some(&process), "spawn-failed");
        return;
    };
    read_ready_line(inner, flight, &process, stdout).await;
}

/// `JSON.stringify({ v: 1, dir: DIR }) + '\n'`.
fn config_line(inner: &Inner) -> Option<String> {
    let value = serde_json::json!({
        "v": PROTOCOL_VERSION,
        "dir": inner.config.dir.to_string_lossy(),
    });
    let mut line = serde_json::to_string(&value).ok()?;
    line.push('\n');
    Some(line)
}

async fn read_ready_line(
    inner: &Arc<Inner>,
    flight: &Arc<Flight>,
    process: &Arc<ProcessHandle>,
    mut stdout: ChildStdout,
) {
    let mut outcome = flight.outcome.subscribe();
    let deadline = tokio::time::sleep(inner.config.ready_timeout);
    tokio::pin!(deadline);
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut eof = false;
    loop {
        if flight.current().is_some() {
            // The exit watchdog settled this attempt first.
            return;
        }
        if eof {
            // stdout is gone but the child may still be alive: from here only
            // the exit watchdog or the ready timeout can decide this attempt.
            tokio::select! {
                _ = &mut deadline => {
                    settle_failure(inner, flight, Some(process), "ready-timeout");
                    return;
                }
                _ = outcome.changed() => return,
            }
        }
        tokio::select! {
            _ = &mut deadline => {
                settle_failure(inner, flight, Some(process), "ready-timeout");
                return;
            }
            changed = outcome.changed() => {
                // Settled elsewhere (exit before ready) or closed.
                if changed.is_err() || flight.current().is_some() {
                    return;
                }
            }
            read = stdout.read(&mut chunk) => {
                match read {
                    Ok(0) => eof = true,
                    Ok(n) => {
                        buffer.extend_from_slice(&chunk[..n]);
                        if let Some(index) = buffer.iter().position(|byte| *byte == b'\n') {
                            match parse_ready(&buffer[..index]) {
                                Some(ready) => {
                                    settle_success(inner, flight, process, ready);
                                    return;
                                }
                                None => {
                                    settle_failure(inner, flight, Some(process), "bad-ready-line");
                                    return;
                                }
                            }
                        } else if buffer.len() > READY_LINE_LIMIT {
                            settle_failure(inner, flight, Some(process), "bad-ready-line");
                            return;
                        }
                    }
                    Err(_) => eof = true,
                }
            }
        }
    }
}

/// The ready line's validation, exactly as the retired module wrote it:
/// `ready === true && v === 1 && Number.isInteger(port) && port > 0 &&
/// typeof secret === 'string' && secret`.
fn parse_ready(line: &[u8]) -> Option<Ready> {
    let value: serde_json::Value = serde_json::from_slice(line).ok()?;
    let object = value.as_object()?;
    if object.get("ready") != Some(&serde_json::Value::Bool(true)) {
        return None;
    }
    if object.get("v").and_then(serde_json::Value::as_f64) != Some(PROTOCOL_VERSION as f64) {
        return None;
    }
    let port = object.get("port")?.as_u64()?;
    if port == 0 || port > u64::from(u16::MAX) {
        return None;
    }
    let secret = object.get("secret")?.as_str()?;
    if secret.is_empty() {
        return None;
    }
    Some(Ready {
        port: port as u16,
        secret: secret.to_string(),
    })
}

fn settle_success(
    inner: &Arc<Inner>,
    flight: &Arc<Flight>,
    process: &Arc<ProcessHandle>,
    ready: Ready,
) {
    if !flight.claim() {
        return;
    }
    {
        let mut state = inner.lock();
        state.starting = None;
        state.ready = Some(ready.clone());
        state.last_error = None;
    }
    process.ready_published.store(true, Ordering::SeqCst);
    inner.log(&format!("remote_screen_ready port={}", ready.port));
    flight.publish(Ok(ready.clone()));
    // A run this long clears the ladder: a binary that dies right after the
    // ready line must not restart once a minute forever.
    let inner = Arc::clone(inner);
    let process = Arc::clone(process);
    let stable = inner.config.stable_reset;
    tokio::spawn(async move {
        tokio::time::sleep(stable).await;
        let mut state = inner.lock();
        let current = state
            .process
            .as_ref()
            .is_some_and(|candidate| Arc::ptr_eq(candidate, &process));
        if current && state.ready.is_some() {
            state.backoff_ms = 0;
        }
    });
}

/// `fail(code)` + `scheduleRestart()`: the one path every startup failure
/// takes (missing binary, spawn error, bad line, timeout, stdin write, exit
/// before ready).
fn settle_failure(
    inner: &Arc<Inner>,
    flight: &Arc<Flight>,
    process: Option<&Arc<ProcessHandle>>,
    code: &str,
) {
    if !flight.claim() {
        return;
    }
    {
        let mut state = inner.lock();
        state.starting = None;
        state.last_error = Some(code.to_string());
        if let Some(process) = process {
            let current = state
                .process
                .as_ref()
                .is_some_and(|candidate| Arc::ptr_eq(candidate, process));
            if current {
                state.process = None;
            }
        }
    }
    if let Some(process) = process {
        process.request_kill();
    }
    inner.log(&format!("remote_screen_start_failed error={code}"));
    // Before the waiters resume: an `ensure()` that runs the instant this
    // failure is reported must see the backoff window, not a free start.
    schedule_restart(inner);
    flight.publish(Err(RemoteError::new(code)));
}

/// The single manager of the process' exit: it owns the `Child`, so `wait()` is
/// never raced with another waiter, and a shutdown kill arrives through
/// [`ProcessHandle::kill`].
async fn watch_exit(
    inner: Arc<Inner>,
    mut child: tokio::process::Child,
    process: Arc<ProcessHandle>,
    flight: Arc<Flight>,
) {
    let status = loop {
        tokio::select! {
            status = child.wait() => break status.ok(),
            _ = process.kill.notified() => {
                let _ = child.start_kill();
            }
        }
    };
    finish_exit(&inner, &flight, &process, status);
    // Shutdown must not return until exit state, logging, and notices are done.
    // Retain the value even if shutdown has not subscribed yet.
    process.exited.send_replace(true);
}

fn finish_exit(
    inner: &Arc<Inner>,
    flight: &Arc<Flight>,
    process: &Arc<ProcessHandle>,
    status: Option<ExitStatus>,
) {
    let (code, signal) = status_parts(status);
    if !flight.claim() {
        // The start path settled this attempt (ready, or a failure that already
        // reported `last_error`). Only a child that had reached ready still owes
        // the forwards an exit notice.
        if process.ready_published.load(Ordering::SeqCst) {
            ready_exit(inner, process, code, signal);
        }
        return;
    }
    let code = format!(
        "exited-before-ready:{}",
        code.map(|code| code.to_string())
            .or_else(|| signal_name(signal))
            .unwrap_or_else(|| "null".to_string())
    );
    {
        let mut state = inner.lock();
        state.starting = None;
        state.last_error = Some(code.clone());
        let current = state
            .process
            .as_ref()
            .is_some_and(|candidate| Arc::ptr_eq(candidate, process));
        if current {
            state.process = None;
        }
    }
    inner.log(&format!("remote_screen_start_failed error={code}"));
    // The window exists before any waiter can resume, exactly like `fail()` +
    // `scheduleRestart()` running in one tick in the retired module.
    schedule_restart(inner);
    flight.publish(Err(RemoteError::new(&code)));
}

/// `handleExit()`: clear ready, remember why, tell every forward, restart.
fn ready_exit(
    inner: &Arc<Inner>,
    process: &Arc<ProcessHandle>,
    code: Option<i32>,
    signal: Option<i32>,
) {
    let (stopping, error) = {
        let mut state = inner.lock();
        let current = state
            .process
            .as_ref()
            .is_some_and(|candidate| Arc::ptr_eq(candidate, process));
        if !current {
            return; // replaced by a newer child, or shutdown already cleared it
        }
        state.process = None;
        let stopping = state.stopping;
        let mut error = None;
        if !stopping {
            state.ready = None;
            let text = exit_text(code, signal);
            state.last_error = Some(text.clone());
            error = Some(text);
        }
        (stopping, error)
    };
    match error {
        Some(error) => {
            inner.log(&format!("remote_screen_exited error={error}"));
            schedule_restart(inner);
        }
        None => inner.log("remote_screen_stopped"),
    }
    // Last, so every listener that wakes on it already sees the new state
    // (ready cleared, `last_error` set, the restart window scheduled).
    let _ = inner.exits.send(ExitNotice {
        code,
        signal,
        stopping,
    });
}

/// `scheduleRestart()`: one timer per failure, delay `backoff || base` capped
/// at `restart_max`, the stored backoff doubles, and the timer only starts
/// anything when a request arrived inside the window.
fn schedule_restart(inner: &Arc<Inner>) {
    let delay = {
        let mut state = inner.lock();
        if state.restart_pending || state.stopping {
            return;
        }
        let base = duration_ms(inner.config.restart_base);
        let max = duration_ms(inner.config.restart_max);
        let delay = if state.backoff_ms > 0 {
            state.backoff_ms
        } else {
            base.min(max)
        };
        state.backoff_ms = delay.saturating_mul(2).min(max);
        state.restart_pending = true;
        delay
    };
    let inner = Arc::clone(inner);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(delay)).await;
        let retry = {
            let mut state = inner.lock();
            state.restart_pending = false;
            if state.stopping || !state.retry_demand {
                false
            } else {
                state.retry_demand = false;
                true
            }
        };
        if retry {
            let _ = ensure(&inner).await;
        }
    });
}

/// `stderr.on('data')` → one log line per complete line, empty lines dropped,
/// 500 characters kept. A trailing half line is never flushed (the retired
/// module did not flush it either).
async fn stderr_lines(inner: Arc<Inner>, mut stderr: ChildStderr) {
    let mut pending: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stderr.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                pending.extend_from_slice(&chunk[..n]);
                while let Some(index) = pending.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<u8> = pending.drain(..=index).collect();
                    emit_stderr(&inner, &line[..line.len() - 1]);
                }
            }
        }
    }
}

fn emit_stderr(inner: &Inner, raw: &[u8]) {
    let text = String::from_utf8_lossy(raw);
    if text.trim().is_empty() {
        return;
    }
    // `slice(0, 500)` counts UTF-16 code units; `chars()` differs only for
    // astral characters, which no log line of this child produces.
    let clipped: String = text.chars().take(STDERR_LINE_LIMIT).collect();
    inner.log(&format!("remote_screen_stderr {clipped}"));
}

fn snapshot(inner: &Arc<Inner>) -> StateSnapshot {
    let state = inner.lock();
    StateSnapshot {
        pid: state.process.as_ref().and_then(|process| process.pid),
        ready: state.ready.clone(),
        attempts: state.attempts,
        backoff_ms: state.backoff_ms,
        restart_pending: state.restart_pending,
        last_error: state.last_error.clone(),
    }
}

async fn shutdown(inner: &Arc<Inner>) {
    let process = {
        let mut state = inner.lock();
        state.stopping = true;
        state.retry_demand = false;
        state.restart_pending = false;
        state.ready = None;
        state.process.clone()
    };
    let Some(process) = process else {
        return;
    };
    process.close_stdin().await;
    if process.wait_exit(inner.config.shutdown_grace).await {
        return;
    }
    process.request_kill();
    let _ = process
        .wait_exit(Duration::from_millis(500).min(inner.config.shutdown_grace))
        .await;
    let mut state = inner.lock();
    if state
        .process
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, &process))
    {
        state.process = None;
    }
}

// ── small helpers ──────────────────────────────────────────────────────────

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn spawn_error_code(error: &io::Error) -> String {
    match error.kind() {
        io::ErrorKind::NotFound => "ENOENT".to_string(),
        io::ErrorKind::PermissionDenied => "EACCES".to_string(),
        _ => "spawn-failed".to_string(),
    }
}

fn status_parts(status: Option<ExitStatus>) -> (Option<i32>, Option<i32>) {
    let Some(status) = status else {
        return (None, None);
    };
    let code = status.code();
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        (code, status.signal())
    }
    #[cfg(not(unix))]
    {
        (code, None)
    }
}

/// `exited code=<c>[ signal=<s>]` (`code=null` when a signal killed it, like
/// Node's `code === null`).
fn exit_text(code: Option<i32>, signal: Option<i32>) -> String {
    let mut text = format!(
        "exited code={}",
        code.map(|code| code.to_string())
            .unwrap_or_else(|| "null".to_string())
    );
    if let Some(signal) = signal_name(signal) {
        text.push_str(&format!(" signal={signal}"));
    }
    text
}

/// Node reports `signal` as a name (`'SIGKILL'`); map the common numbers back.
#[cfg(unix)]
pub(crate) fn signal_name(signal: Option<i32>) -> Option<String> {
    let signal = signal?;
    let name = match signal {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        libc::SIGCHLD => "SIGCHLD",
        libc::SIGCONT => "SIGCONT",
        libc::SIGSTOP => "SIGSTOP",
        libc::SIGTSTP => "SIGTSTP",
        libc::SIGTTIN => "SIGTTIN",
        libc::SIGTTOU => "SIGTTOU",
        libc::SIGURG => "SIGURG",
        libc::SIGXCPU => "SIGXCPU",
        libc::SIGXFSZ => "SIGXFSZ",
        libc::SIGVTALRM => "SIGVTALRM",
        libc::SIGPROF => "SIGPROF",
        libc::SIGWINCH => "SIGWINCH",
        libc::SIGIO => "SIGIO",
        libc::SIGSYS => "SIGSYS",
        _ => return Some(signal.to_string()),
    };
    Some(name.to_string())
}

#[cfg(not(unix))]
fn signal_name(_signal: Option<i32>) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_lines_follow_the_js_validation() {
        assert_eq!(
            parse_ready(br#"{"ready":true,"v":1,"port":53122,"secret":"s"}"#),
            Some(Ready {
                port: 53122,
                secret: "s".to_string()
            })
        );
        assert!(parse_ready(br#"{"ready":true,"v":2,"port":1,"secret":"s"}"#).is_none());
        assert!(parse_ready(br#"{"ready":true,"v":1,"port":0,"secret":"s"}"#).is_none());
        assert!(parse_ready(br#"{"ready":true,"v":1,"port":65536,"secret":"s"}"#).is_none());
        assert!(parse_ready(br#"{"ready":true,"v":1,"port":1,"secret":""}"#).is_none());
        assert!(parse_ready(br#"{"ready":true,"v":1,"port":1}"#).is_none());
        assert!(parse_ready(br#"{"ready":false,"v":1,"port":1,"secret":"s"}"#).is_none());
        assert!(parse_ready(b"ready").is_none());
    }

    #[test]
    fn assist_dir_matches_create_paths() {
        let package = Path::new("/opt/multicc");
        let home = Path::new("/home/user");
        assert_eq!(
            assist_dir(package, package, home),
            home.join(".multicc").join("assist")
        );
        assert_eq!(
            remote_screen_dir(Path::new("/tmp/data"), package, home),
            Path::new("/tmp/data/assist/remote-screen")
        );
    }

    #[test]
    fn exit_text_keeps_node_spelling() {
        assert_eq!(exit_text(Some(3), None), "exited code=3");
        #[cfg(unix)]
        assert_eq!(exit_text(None, Some(9)), "exited code=null signal=SIGKILL");
        #[cfg(not(unix))]
        assert_eq!(exit_text(None, Some(9)), "exited code=null");
    }
}
