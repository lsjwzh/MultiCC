//! Native chat uses the same app-server protocol bridge as the compatibility
//! runtime. The WebSocket host owns the turn and checkpoints its thread ID.
use multicc_core::chat_turn_host::{Outcome, RunResult};
use serde_json::{json, Value};
use std::{collections::HashSet, ffi::OsString, io, path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::oneshot,
    time::timeout,
};

const START_TIMEOUT: Duration = Duration::from_secs(70);
const IDLE_TIMEOUT: Duration = Duration::from_secs(600);
const EXIT_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_FRAME: u64 = 4 * 1024 * 1024;
const TAIL_BYTES: usize = 8192;

pub(super) struct Launch {
    pub cwd: PathBuf,
    pub home: PathBuf,
    pub thread: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

pub(super) enum Event {
    Thread(String),
    Frame(Value),
}

pub(super) fn binary() -> OsString {
    std::env::var_os("CODEX_BIN")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| if cfg!(windows) { "codex.exe" } else { "codex" }.into())
}

pub(super) fn valid_thread(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

impl Launch {
    fn spawn(&self) -> io::Result<Child> {
        let mut command = Command::new(std::env::current_exe()?);
        command
            .args([
                "codex-app-bridge",
                "--resident",
                "--chat-host",
                "--codex-bin",
            ])
            .arg(binary())
            .current_dir(&self.cwd)
            .env_clear()
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home);
        for key in [
            "PATH",
            "SystemRoot",
            "ComSpec",
            "PATHEXT",
            "LANG",
            "LC_ALL",
            "TMPDIR",
            "TMP",
            "TEMP",
            "CODEX_HOME",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "no_proxy",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        for (flag, value) in [
            ("--thread-id", &self.thread),
            ("--model", &self.model),
            ("--effort", &self.effort),
        ] {
            if let Some(value) = value {
                command.arg(flag).arg(value);
            }
        }
        #[cfg(unix)]
        command.process_group(0);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
    }
}

async fn stderr_tail(mut stderr: tokio::process::ChildStderr) -> Vec<u8> {
    let mut tail = Vec::new();
    let mut chunk = [0; 4096];
    while let Ok(count @ 1..) = stderr.read(&mut chunk).await {
        let discard = (tail.len() + count).saturating_sub(TAIL_BYTES);
        tail.drain(..discard);
        tail.extend_from_slice(&chunk[..count]);
    }
    tail
}

#[cfg(unix)]
fn signal_group(pid: Option<u32>, signal: i32) -> bool {
    let Some(pid) = pid else { return false };
    // The bridge and its app-server share the process group created at spawn.
    unsafe { libc::kill(-(pid as i32), signal) == 0 }
}

async fn stop(child: &mut Child) -> bool {
    #[cfg(unix)]
    let pid = child.id();
    let stopped = match timeout(EXIT_TIMEOUT, child.wait()).await {
        Ok(result) => result.is_ok(),
        Err(_) => {
            #[cfg(unix)]
            signal_group(pid, libc::SIGKILL);
            let _ = child.start_kill();
            timeout(EXIT_TIMEOUT, child.wait())
                .await
                .is_ok_and(|result| result.is_ok())
        }
    };
    #[cfg(unix)]
    if signal_group(pid, 0) {
        signal_group(pid, libc::SIGKILL);
        for _ in 0..30 {
            if !signal_group(pid, 0) {
                return stopped;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        return false;
    }
    stopped
}

pub(super) async fn run<F, Fut>(
    launch: Launch,
    prompt: &str,
    mut cancel: oneshot::Receiver<()>,
    mut emit: F,
) -> RunResult
where
    F: FnMut(Event) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let mut child = match launch.spawn() {
        Ok(child) => child,
        Err(error) => {
            return RunResult {
                outcome: Outcome::Failed(format!("Codex bridge spawn failed: {error}")),
                writer_stopped: true,
            }
        }
    };
    let mut input = child.stdin.take().expect("piped stdin");
    let mut output = BufReader::new(child.stdout.take().expect("piped stdout"));
    let mut stderr = tokio::spawn(stderr_tail(child.stderr.take().expect("piped stderr")));
    let request = json!({"text":prompt}).to_string() + "\n";
    let mut decoder = Decoder::default();
    let mut line = Vec::new();
    let mut outcome = {
        let write = input.write_all(request.as_bytes());
        tokio::pin!(write);
        let mut sent = false;
        let startup = tokio::time::sleep(START_TIMEOUT);
        tokio::pin!(startup);
        loop {
            let mut frame = (&mut output).take(MAX_FRAME + 1);
            let next = tokio::select! {
                biased;
                _ = &mut cancel => break Outcome::Cancelled,
                _ = &mut startup, if !sent => break Outcome::Failed("Codex app-server startup timed out".into()),
                result = &mut write, if decoder.ready && !sent => {
                    match result {
                        Ok(()) => { sent = true; continue; }
                        Err(error) => break Outcome::Failed(format!("Codex bridge stdin failed: {error}")),
                    }
                }
                result = timeout(IDLE_TIMEOUT, frame.read_until(b'\n', &mut line)) => result,
            };
            match next {
                Ok(Ok(0)) => {
                    break Outcome::Failed(decoder.error.take().unwrap_or_else(|| {
                        "Codex bridge exited before completing the turn".into()
                    }))
                }
                Ok(Ok(_)) if line.len() as u64 <= MAX_FRAME => (),
                Ok(Ok(_)) => {
                    break Outcome::Failed(
                        "Codex bridge frame exceeded the chat output limit".into(),
                    )
                }
                Ok(Err(error)) => {
                    break Outcome::Failed(format!("Codex bridge stdout failed: {error}"))
                }
                Err(_) => {
                    break Outcome::Failed(
                        "Codex app-server produced no events before the idle deadline".into(),
                    )
                }
            }
            let frame = multicc_core::json_lenient::from_slice::<Value>(&line);
            line.clear();
            let Ok(frame) = frame else {
                break Outcome::Failed("Codex bridge returned an invalid event".into());
            };
            match decoder.decode(frame) {
                Ok(Some(event)) => {
                    if let Err(error) = emit(event).await {
                        break Outcome::Failed(error);
                    }
                }
                Ok(None) => (),
                Err(outcome) => break outcome,
            }
        }
    };
    // Closing the resident bridge input asks it to stop the app-server and
    // flush the native rollout before the host can admit the next turn.
    drop(input);
    drop(output);
    let writer_stopped = stop(&mut child).await;
    match timeout(Duration::from_secs(1), &mut stderr).await {
        Ok(Ok(tail)) => {
            if let Outcome::Failed(error) = &mut outcome {
                let tail = String::from_utf8_lossy(&tail);
                let tail = tail.trim();
                if !tail.is_empty() {
                    error.push('\n');
                    error.push_str(tail);
                }
            }
        }
        Err(_) => stderr.abort(),
        _ => (),
    }
    if !writer_stopped && matches!(outcome, Outcome::Result(_)) {
        outcome = Outcome::Failed("Codex process did not release the native thread".into());
    }
    RunResult {
        outcome,
        writer_stopped,
    }
}

#[derive(Default)]
struct Decoder {
    ready: bool,
    turn_id: Option<String>,
    deltas: HashSet<String>,
    usage: Value,
    error: Option<String>,
}

impl Decoder {
    fn decode(&mut self, frame: Value) -> Result<Option<Event>, Outcome> {
        let params = &frame["params"];
        let item = &params["item"];
        let turn = &params["turn"];
        let method = frame["method"].as_str().unwrap_or("");
        if method.starts_with("item/")
            && self
                .turn_id
                .as_deref()
                .is_none_or(|id| params["turnId"].as_str().is_some_and(|source| source != id))
        {
            return Ok(None);
        }
        let event = match method {
            "multicc/chat_thread_ready" => {
                let id = params["threadId"]
                    .as_str()
                    .filter(|id| valid_thread(id))
                    .ok_or_else(|| {
                        Outcome::Failed("Codex app-server returned an invalid thread ID".into())
                    })?;
                self.ready = true;
                return Ok(Some(Event::Thread(id.into())));
            }
            "turn/started" => {
                self.turn_id = turn["id"].as_str().map(String::from);
                return Ok(None);
            }
            "item/agentMessage/delta" => {
                if let Some(id) = params["itemId"].as_str() {
                    self.deltas.insert(id.into());
                }
                text_frame(&params["delta"])
            }
            "item/completed" if item["type"] == "agentMessage" => {
                if item["id"].as_str().is_some_and(|id| self.deltas.remove(id)) {
                    return Ok(None);
                }
                text_frame(&item["text"])
            }
            "item/started" if item["type"] == "commandExecution" => {
                json!({"type":"assistant","message":{"content":[{
                    "type":"tool_use","id":item["id"],"name":"Bash","input":{"command":item["command"]}
                }]}})
            }
            "item/completed" if item["type"] == "commandExecution" => {
                json!({"type":"user","message":{"content":[{
                    "type":"tool_result","tool_use_id":item["id"],"content":item["aggregatedOutput"],"is_error":item["status"] == "failed" || item["exitCode"].as_i64().is_some_and(|code| code != 0)
                }]}})
            }
            "thread/tokenUsage/updated"
                if self
                    .turn_id
                    .as_deref()
                    .is_some_and(|id| params["turnId"] == id) =>
            {
                self.add_usage(&params["tokenUsage"]);
                return Ok(None);
            }
            "error" => {
                self.error = params["error"]["message"]
                    .as_str()
                    .or_else(|| params["message"].as_str())
                    .map(String::from);
                return Ok(None);
            }
            "turn/completed" if self.turn_id.as_deref().is_some_and(|id| turn["id"] == id) => {
                return Err(match turn["status"].as_str() {
                    Some("completed") => Outcome::Result(
                        json!({"type":"result","subtype":"success","is_error":false,
                    "usage": self.usage.as_object().cloned().unwrap_or_default()}),
                    ),
                    Some("interrupted") => Outcome::Cancelled,
                    status => Outcome::Failed(
                        turn["error"]["message"]
                            .as_str()
                            .map(String::from)
                            .or_else(|| self.error.take())
                            .unwrap_or_else(|| {
                                format!("Codex turn {}", status.unwrap_or("failed"))
                            }),
                    ),
                })
            }
            _ => return Ok(None),
        };
        Ok(Some(Event::Frame(event)))
    }

    fn add_usage(&mut self, usage: &Value) {
        let last = usage
            .get("last")
            .filter(|row| row.is_object())
            .or_else(|| usage.get("total"))
            .unwrap_or(usage);
        let get = |key: &str| last[key].as_u64().unwrap_or(0);
        let cached = get("cachedInputTokens");
        for (key, count) in [
            ("input_tokens", get("inputTokens").saturating_sub(cached)),
            ("cached_input_tokens", cached),
            ("cache_read_input_tokens", cached),
            ("cache_creation_input_tokens", get("cacheWriteInputTokens")),
            ("output_tokens", get("outputTokens")),
            ("reasoning_output_tokens", get("reasoningOutputTokens")),
        ] {
            let previous = self.usage[key].as_u64().unwrap_or(0);
            self.usage[key] = json!(previous.saturating_add(count));
        }
        if usage["modelContextWindow"].is_number() {
            self.usage["model_context_window"] = usage["modelContextWindow"].clone();
        }
    }
}

fn text_frame(text: &Value) -> Value {
    json!({"type":"assistant","message":{"content":[{"type":"text","text":text}]}})
}
