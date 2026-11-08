//! Native owner of one resident `claude` child process.
//!
//! The JavaScript lane keeps only the conversation-level state machine (turn
//! boundaries, background hold, idle recycle). Everything wire-shaped lives
//! here: argv/env/settings materialization (delegated to the pure
//! `multicc_core::claude_lane` kernel), stdin framing, stdout classification,
//! stderr tail, control-request correlation and process teardown.
//!
//! Stream messages cross to JS as the original JSON line text. JS therefore
//! does exactly one `JSON.parse` per message instead of paying per-property
//! N-API marshalling for every event object the old SDK yielded.

use multicc_core::claude_lane::{
    self, Classified, ControlResponse, LaneState, LaunchInput, LineFramer, PendingKind,
};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Result, Status};
use napi_derive::napi;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot, Notify};

/// `(kind, a, b)` — see `Inner::emit`. Messages carry the raw line in `a`.
type LaneEvent =
    ThreadsafeFunction<(String, String, String), (), (String, String, String), Status, false, true>;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StartInput {
    binary: String,
    binary_args: Vec<String>,
    #[serde(flatten)]
    launch: LaunchInput,
    cwd: Option<String>,
    hook_callback: bool,
    initialize_timeout_ms: Option<f64>,
    control_timeout_ms: Option<f64>,
}

fn error(message: impl Into<String>) -> napi::Error {
    napi::Error::from_reason(message.into())
}

enum WriteCmd {
    Line(String),
    End,
}

#[derive(Clone)]
enum InitState {
    Waiting,
    Ready,
    Failed(String),
}

struct Inner {
    callback: LaneEvent,
    state: Mutex<LaneState>,
    pending: Mutex<HashMap<String, (PendingKind, oneshot::Sender<ControlResponse>)>>,
    writer: Mutex<Option<mpsc::UnboundedSender<WriteCmd>>>,
    kill: Mutex<Option<mpsc::UnboundedSender<Option<String>>>>,
    init: Mutex<InitState>,
    init_notify: Notify,
    stderr: Arc<Mutex<String>>,
    alive: AtomicBool,
    pid: AtomicI32,
    control_timeout_ms: AtomicU64,
}

impl Inner {
    fn emit(&self, kind: &str, a: &str, b: &str) {
        let _ = self.callback.call(
            (kind.to_string(), a.to_string(), b.to_string()),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    }

    fn emit_exit(&self, code: Option<i32>, signal: Option<String>, tail: String) {
        self.emit(
            "exit",
            &code.map(|code| code.to_string()).unwrap_or_default(),
            &json!({ "signal": signal, "stderrTail": tail }).to_string(),
        );
    }

    fn write(&self, line: String) -> Result<()> {
        let sender = self
            .writer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(|| error("Claude lane is not running"))?;
        sender
            .send(WriteCmd::Line(line))
            .map_err(|_| error("Claude lane stdin is closed"))
    }

    fn fail_pending(&self, reason: &str) {
        let pending = {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            std::mem::take(&mut *pending)
        };
        for (id, (kind, sender)) in pending {
            let _ = sender.send(ControlResponse {
                request_id: id,
                success: false,
                payload: json!({}),
                error: Some(reason.to_string()),
                error_code: Some("lane_closed".into()),
            });
            let _ = kind;
        }
    }

    fn fail_init(&self, reason: &str) {
        let mut init = self.init.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(*init, InitState::Waiting) {
            *init = InitState::Failed(reason.to_string());
            drop(init);
            self.init_notify.notify_waiters();
        }
    }

    fn mark_initialized(&self) {
        let mut init = self.init.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(*init, InitState::Waiting) {
            *init = InitState::Ready;
            drop(init);
            self.init_notify.notify_waiters();
        }
    }

    async fn wait_initialized(&self) -> Result<()> {
        loop {
            let notified = self.init_notify.notified();
            {
                let init = self.init.lock().unwrap_or_else(|e| e.into_inner());
                match &*init {
                    InitState::Ready => return Ok(()),
                    InitState::Failed(reason) => return Err(error(reason.clone())),
                    InitState::Waiting => {}
                }
            }
            notified.await;
        }
    }

    async fn control(&self, kind: PendingKind, line: String, timeout: Duration) -> Result<String> {
        // The caller already built the line with a fresh id; recover it so the
        // pending entry is keyed exactly like the response.
        let request_id = serde_json::from_str::<serde_json::Value>(&line)
            .ok()
            .and_then(|value| {
                value
                    .get("request_id")
                    .and_then(|id| id.as_str())
                    .map(str::to_string)
            })
            .ok_or_else(|| error("control request is missing request_id"))?;
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(request_id.clone(), (kind, sender));
        if let Err(write_error) = self.write(line) {
            self.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&request_id);
            return Err(write_error);
        }
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(response)) => {
                if response.success {
                    Ok(response.payload.to_string())
                } else {
                    Err(error(response.error.unwrap_or_else(|| {
                        "Claude Code rejected the control request".to_string()
                    })))
                }
            }
            Ok(Err(_)) => Err(error("Claude lane control channel closed")),
            Err(_) => {
                self.pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&request_id);
                Err(error("Claude Code control request timed out"))
            }
        }
    }

    fn control_timeout(&self) -> Duration {
        Duration::from_millis(self.control_timeout_ms.load(Ordering::SeqCst))
    }

    fn next_id(&self) -> String {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .request_id()
    }

    fn handle_line(self: &Arc<Self>, line: &str) {
        let classified = match claude_lane::classify_line(line) {
            Ok(classified) => classified,
            Err(message) => {
                self.emit("error", &message, "");
                self.fail_pending(&message);
                self.fail_init(&message);
                return;
            }
        };
        match classified {
            Classified::Blank | Classified::KeepAlive { .. } | Classified::Swallowed => {}
            Classified::ControlResponse(response) => {
                let initialize = {
                    let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    state.initialize_request.as_deref() == Some(response.request_id.as_str())
                };
                if initialize {
                    if response.success {
                        self.state
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .mark_initialized();
                        self.mark_initialized();
                    } else {
                        let message = response
                            .error
                            .clone()
                            .unwrap_or_else(|| "Claude Code rejected initialize".to_string());
                        self.fail_init(&message);
                        self.emit("error", &message, "");
                    }
                }
                let sender = self
                    .pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&response.request_id);
                if let Some((_, sender)) = sender {
                    let _ = sender.send(response);
                }
            }
            Classified::HookCallback(hook) => {
                self.emit("hook_callback", &hook.request_id, &hook.input.to_string());
            }
            Classified::ControlCancel { request_id } => {
                self.emit("control_cancel", &request_id, "");
            }
            Classified::UnknownControlRequest {
                request_id,
                subtype,
            } => {
                // `remote_tool_*` control requests are intentionally answered by
                // the session tool service, not by the SDK lane.
                if !subtype.starts_with("remote_") {
                    let message = format!("Unsupported control request subtype: {subtype}");
                    let line =
                        claude_lane::control_response_error_line(&request_id, &message, None);
                    let _ = self.write(line);
                }
            }
            Classified::Stream(text) => {
                // Delivered verbatim: one JSON.parse on the JS side.
                self.emit("message", &text, "");
            }
        }
    }
}

#[napi]
pub struct RustClaudeLane {
    inner: Arc<Inner>,
    started: AtomicBool,
}

#[napi]
impl RustClaudeLane {
    #[napi(constructor)]
    pub fn new(callback: LaneEvent) -> Self {
        Self {
            inner: Arc::new(Inner {
                callback,
                state: Mutex::new(LaneState::new(claude_lane::random_prefix())),
                pending: Mutex::new(HashMap::new()),
                writer: Mutex::new(None),
                kill: Mutex::new(None),
                init: Mutex::new(InitState::Waiting),
                init_notify: Notify::new(),
                stderr: Arc::new(Mutex::new(String::new())),
                alive: AtomicBool::new(false),
                pid: AtomicI32::new(0),
                control_timeout_ms: AtomicU64::new(10_000),
            }),
            started: AtomicBool::new(false),
        }
    }

    #[napi(getter)]
    pub fn pid(&self) -> i32 {
        self.inner.pid.load(Ordering::SeqCst)
    }

    #[napi(getter)]
    pub fn alive(&self) -> bool {
        self.inner.alive.load(Ordering::SeqCst)
    }

    #[napi]
    pub fn stderr_tail(&self) -> String {
        self.inner
            .stderr
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Spawn the child, write the private settings file, send `initialize` and
    /// return `{ pid, argv }` (argv excludes the injected binary args).
    #[napi]
    pub async fn start(&self, config: String) -> Result<String> {
        if self.started.swap(true, Ordering::SeqCst) {
            return Err(error("Claude lane already started"));
        }
        let input: StartInput = multicc_core::json_lenient::from_str(&config)
            .map_err(|parse| error(format!("invalid Claude lane config: {parse}")))?;
        if input.binary.trim().is_empty() {
            return Err(error("Claude binary is missing"));
        }
        let launch = claude_lane::launch(&input.launch);
        if !input.launch.settings_path.is_empty() {
            write_private_settings(&input.launch.settings_path, &launch.settings)?;
        }
        if let Some(ms) = input
            .control_timeout_ms
            .filter(|ms| ms.is_finite() && *ms > 0.0)
        {
            self.inner
                .control_timeout_ms
                .store(ms.min(600_000.0) as u64, Ordering::SeqCst);
        }
        let initialize_timeout = Duration::from_millis(
            input
                .initialize_timeout_ms
                .filter(|ms| ms.is_finite() && *ms > 0.0)
                .map(|ms| ms.min(600_000.0) as u64)
                .unwrap_or(30_000),
        );

        let mut command = tokio::process::Command::new(&input.binary);
        command
            .args(&input.binary_args)
            .args(&launch.argv)
            .env_clear()
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in &launch.env {
            command.env(key, value);
        }
        if let Some(cwd) = input.cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
            command.current_dir(cwd);
        }
        #[cfg(windows)]
        {
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = command
            .spawn()
            .map_err(|spawn| error(format!("failed to spawn Claude Code: {spawn}")))?;
        let pid = child.id().unwrap_or(0) as i32;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        self.inner.pid.store(pid, Ordering::SeqCst);
        self.inner.alive.store(true, Ordering::SeqCst);

        let (write_tx, write_rx) = mpsc::unbounded_channel::<WriteCmd>();
        *self.inner.writer.lock().unwrap_or_else(|e| e.into_inner()) = Some(write_tx);
        if let Some(stdin) = stdin {
            tokio::spawn(writer_loop(stdin, write_rx));
        }

        let (kill_tx, kill_rx) = mpsc::unbounded_channel::<Option<String>>();
        *self.inner.kill.lock().unwrap_or_else(|e| e.into_inner()) = Some(kill_tx);

        if let Some(stdout) = stdout {
            tokio::spawn(reader_loop(stdout, self.inner.clone()));
        }
        let stderr_task =
            stderr.map(|stderr| tokio::spawn(stderr_loop(stderr, self.inner.stderr.clone())));
        tokio::spawn(supervise(child, kill_rx, self.inner.clone(), stderr_task));

        let request_id = {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            state.begin_initialize()
        };
        let initialize = claude_lane::initialize_line(
            &request_id,
            input.hook_callback,
            input.launch.system_prompt_append.as_deref(),
        );
        self.inner.write(initialize)?;

        // Fail closed when the real CLI never answers initialize.
        let inner = self.inner.clone();
        tokio::spawn(async move {
            tokio::time::sleep(initialize_timeout).await;
            let waiting = matches!(
                *inner.init.lock().unwrap_or_else(|e| e.into_inner()),
                InitState::Waiting
            );
            if waiting {
                inner.fail_init("Claude Code did not answer initialize");
                let _ = inner
                    .kill
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_ref()
                    .map(|sender| sender.send(Some("SIGTERM".into())));
            }
        });

        Ok(json!({ "pid": pid, "argv": launch.argv }).to_string())
    }

    /// Write one already-built `user` line, waiting for the initialize
    /// handshake first (the conservative ordering; the JS SDK did not wait).
    #[napi]
    pub async fn send_user(&self, line: String) -> Result<()> {
        self.inner.wait_initialized().await?;
        self.inner.write(line)
    }

    #[napi]
    pub async fn interrupt(&self) -> Result<()> {
        let id = self.inner.next_id();
        let line = claude_lane::interrupt_line(&id, true);
        self.inner
            .control(PendingKind::Interrupt, line, self.inner.control_timeout())
            .await?;
        Ok(())
    }

    #[napi]
    pub async fn set_model(&self, model: Option<String>) -> Result<()> {
        let id = self.inner.next_id();
        let line = claude_lane::set_model_line(&id, model.as_deref());
        self.inner
            .control(PendingKind::SetModel, line, self.inner.control_timeout())
            .await?;
        Ok(())
    }

    #[napi]
    pub async fn get_task_output(&self, task_id: String) -> Result<String> {
        let id = self.inner.next_id();
        let line = claude_lane::get_task_output_line(&id, &task_id);
        self.inner
            .control(
                PendingKind::GetTaskOutput,
                line,
                self.inner.control_timeout(),
            )
            .await
    }

    #[napi]
    pub async fn stop_task(&self, task_id: String) -> Result<()> {
        let id = self.inner.next_id();
        let line = claude_lane::stop_task_line(&id, &task_id);
        self.inner
            .control(PendingKind::StopTask, line, self.inner.control_timeout())
            .await?;
        Ok(())
    }

    #[napi]
    pub fn respond_control(&self, request_id: String, response_json: String) -> Result<()> {
        let payload: serde_json::Value = multicc_core::json_lenient::from_str(&response_json)
            .map_err(|parse| error(format!("invalid hook response: {parse}")))?;
        self.inner
            .write(claude_lane::control_response_line(&request_id, &payload))
    }

    #[napi]
    pub fn respond_control_error(&self, request_id: String, message: String) -> Result<()> {
        self.inner.write(claude_lane::control_response_error_line(
            &request_id,
            &message,
            None,
        ))
    }

    #[napi]
    pub fn close_input(&self) {
        if let Some(sender) = self
            .inner
            .writer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            let _ = sender.send(WriteCmd::End);
        }
    }

    #[napi]
    pub fn kill(&self, signal: Option<String>) {
        if let Some(sender) = self
            .inner
            .kill
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            let _ = sender.send(Some(signal.unwrap_or_else(|| "SIGTERM".to_string())));
        }
    }
}

impl Drop for RustClaudeLane {
    fn drop(&mut self) {
        if let Some(sender) = self
            .inner
            .kill
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            let _ = sender.send(Some("SIGKILL".to_string()));
        }
    }
}

fn write_private_settings(path: &str, content: &str) -> Result<()> {
    use std::io::Write;
    if let Some(parent) = std::path::Path::new(path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|io| error(format!("cannot create Claude settings directory: {io}")))?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|io| error(format!("cannot write Claude settings file: {io}")))?;
    file.write_all(content.as_bytes())
        .map_err(|io| error(format!("cannot write Claude settings file: {io}")))?;
    Ok(())
}

async fn writer_loop(mut stdin: ChildStdin, mut receiver: mpsc::UnboundedReceiver<WriteCmd>) {
    while let Some(command) = receiver.recv().await {
        match command {
            WriteCmd::Line(line) => {
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if stdin.write_all(b"\n").await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
            WriteCmd::End => {
                let _ = stdin.shutdown().await;
                break;
            }
        }
    }
    // Dropping the pipe is the protocol's end-of-input.
    drop(stdin);
}

async fn reader_loop(mut stdout: ChildStdout, inner: Arc<Inner>) {
    let mut framer = LineFramer::new();
    let mut buffer = [0u8; 16 * 1024];
    loop {
        match stdout.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => {
                for line in framer.push(&buffer[..read]) {
                    inner.handle_line(&line);
                }
            }
            Err(_) => break,
        }
    }
    if let Some(tail) = framer.finish() {
        inner.handle_line(&tail);
    }
}

async fn stderr_loop(mut stderr: tokio::process::ChildStderr, tail: Arc<Mutex<String>>) {
    let mut buffer = [0u8; 8 * 1024];
    loop {
        match stderr.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => {
                let text = String::from_utf8_lossy(&buffer[..read]);
                let mut tail = tail.lock().unwrap_or_else(|e| e.into_inner());
                tail.push_str(&text);
                if tail.chars().count() > 4000 {
                    let keep: String = {
                        let count = tail.chars().count();
                        tail.chars().skip(count - 4000).collect()
                    };
                    *tail = keep;
                }
            }
            Err(_) => break,
        }
    }
}

async fn supervise(
    mut child: Child,
    mut kills: mpsc::UnboundedReceiver<Option<String>>,
    inner: Arc<Inner>,
    stderr_task: Option<tokio::task::JoinHandle<()>>,
) {
    let status = loop {
        tokio::select! {
            waited = child.wait() => break waited.ok(),
            requested = kills.recv() => {
                if let Some(Some(signal)) = requested {
                    signal_child(child.id(), &signal);
                }
            }
        }
    };
    inner.alive.store(false, Ordering::SeqCst);
    // Give the stderr reader a beat to drain so the tail is complete.
    if let Some(task) = stderr_task {
        let _ = tokio::time::timeout(Duration::from_millis(500), task).await;
    }
    let tail = inner
        .stderr
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let (code, signal) = match status {
        Some(status) => (status.code(), status.signal().map(signal_name)),
        None => (None, None),
    };
    inner.fail_pending("Claude Code process exited");
    inner.fail_init("Claude Code process exited");
    inner.emit_exit(code, signal, tail);
}

#[cfg(unix)]
fn signal_name(number: i32) -> String {
    match number {
        libc::SIGKILL => "SIGKILL".into(),
        libc::SIGINT => "SIGINT".into(),
        libc::SIGTERM => "SIGTERM".into(),
        other => other.to_string(),
    }
}

#[cfg(unix)]
fn signal_child(pid: Option<u32>, signal: &str) {
    let Some(pid) = pid else { return };
    let number = match signal {
        "SIGKILL" => libc::SIGKILL,
        "SIGINT" => libc::SIGINT,
        _ => libc::SIGTERM,
    };
    // SAFETY: sending a signal to a child pid we own.
    unsafe {
        libc::kill(pid as i32, number);
    }
}

#[cfg(not(unix))]
fn signal_child(_pid: Option<u32>, _signal: &str) {}
