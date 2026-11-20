//! Claude turn execution shared by the gateway and the stream protocol kernel.
//! A turn holds its process lease through exit. The caller owns the durable
//! user message and must finish the transcript before publishing completion.
use std::future::Future;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::{timeout, Instant};

use crate::claude_process::{ClaudeProcess, Event, StartInput};
use crate::exact_secret::{normalize_secrets, redact_fragments, Secrets};
use crate::js::JsString;

const STOP_GRACE: Duration = Duration::from_secs(5);
const PULSE_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_PENDING_EVENTS: usize = 128;

pub enum Outcome {
    Result(Value),
    Cancelled,
    Failed(String),
}

/// Each turn has its own stdout stream. Late frames can only reach this
/// invocation, even after a cancellation and immediate retry by the client.
/// The Claude session id and resume flag carry context across process exits.
pub async fn run<F, Fut>(
    options: StartInput,
    text: &str,
    user_uuid: &str,
    mut cancel: oneshot::Receiver<()>,
    mut emit: F,
) -> Outcome
where
    F: FnMut(Value) -> Fut,
    Fut: Future<Output = ()>,
{
    let secrets = normalize_secrets(
        [
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
        ]
        .into_iter()
        .filter_map(|key| {
            options
                .launch
                .env
                .get(key)?
                .as_str()
                .map(JsString::from_rust_str)
        }),
    );
    let prompt = json!({
        "type": "user",
        "session_id": options.launch.session_id,
        "uuid": user_uuid,
        "parent_tool_use_id": null,
        "message": {"role": "user", "content": [{"type": "text", "text": text}]},
    });
    let (send, mut events) = mpsc::channel(MAX_PENDING_EVENTS);
    let (overflow, mut saturated) = watch::channel(false);
    let process = ClaudeProcess::new(move |event| {
        if let Err(mpsc::error::TrySendError::Full(_)) = send.try_send(event) {
            overflow.send_replace(true);
        }
    });
    let startup = async {
        process.start_native(options).await?;
        process.send_user(prompt.to_string()).await
    };
    let started = tokio::select! {
        biased;
        _ = &mut cancel => {
            stop(&process, &mut events, true).await;
            return Outcome::Cancelled;
        }
        result = startup => result,
    };
    if let Err(error) = started {
        let detail = with_stderr(error.to_string(), &process.stderr_tail(), &secrets);
        stop(&process, &mut events, false).await;
        return Outcome::Failed(detail);
    }
    let result = loop {
        tokio::select! {
            biased;
            _ = &mut cancel => break Outcome::Cancelled,
            _ = saturated.changed() => break Outcome::Failed("Claude process output exceeded the turn event queue".into()),
            event = timeout(PULSE_TIMEOUT, events.recv()) => match event {
                Ok(Some(Event::Message(line))) => match decode_event(&line, &secrets) {
                    Ok(event) if main_result(&event) => {
                        break if cancelled_result(&event) { Outcome::Cancelled } else { Outcome::Result(event) };
                    }
                    Ok(event) => emit(event).await,
                    Err(error) => break Outcome::Failed(format!("invalid Claude event: {error}")),
                },
                Ok(Some(Event::Error(error))) => {
                    break Outcome::Failed(with_stderr(error, &process.stderr_tail(), &secrets));
                }
                Ok(Some(Event::Exit { code, signal, stderr_tail })) => {
                    break Outcome::Failed(with_stderr(
                        format!("Claude process exited before the result (code {code:?}, signal {signal:?})"),
                        &stderr_tail,
                        &secrets,
                    ));
                }
                Ok(Some(Event::HookCallback { request_id, .. })) => {
                    // This host did not register a hook and cannot answer a
                    // provider-controlled callback as though it had run.
                    let _ = process.respond_control_error(request_id, "hook is not registered".into());
                }
                Ok(Some(Event::ControlCancel { .. })) => {}
                Ok(None) => break Outcome::Failed("Claude process event stream closed".into()),
                Err(_) => break Outcome::Failed("Claude process produced no events before the idle deadline".into()),
            }
        }
    };
    stop(&process, &mut events, matches!(result, Outcome::Cancelled)).await;
    result
}

fn main_result(event: &Value) -> bool {
    event["type"] == "result"
        && event["parent_tool_use_id"].is_null()
        && event["origin"]["kind"] != "task-notification"
}

fn cancelled_result(event: &Value) -> bool {
    matches!(
        event["terminal_reason"].as_str(),
        Some("cancelled" | "aborted" | "interrupted")
    )
}

pub fn completed_result(event: &Value) -> bool {
    event["subtype"] == "success"
        && event["is_error"] == false
        && (event.get("terminal_reason").is_none() || event["terminal_reason"] == "completed")
}

fn decode_event(line: &str, secrets: &Secrets) -> Result<Value, String> {
    let safe = crate::provider_scrub_json::scrub_json(line, secrets)?;
    serde_json::from_str::<Value>(&safe).map_err(|error| error.to_string())
}

async fn stop(process: &ClaudeProcess, events: &mut mpsc::Receiver<Event>, interrupt: bool) {
    // Await the interrupt acknowledgement while draining output. Closing the
    // input afterwards gives the CLI time to flush its native transcript.
    if interrupt && process.alive() {
        let _ = timeout(Duration::from_secs(2), process.interrupt()).await;
    }
    process.close_input();
    if wait_for_exit(process, events).await {
        return;
    }
    process.kill(Some("SIGKILL".into()));
    let _ = wait_for_exit(process, events).await;
}

async fn wait_for_exit(process: &ClaudeProcess, events: &mut mpsc::Receiver<Event>) -> bool {
    let deadline = Instant::now() + STOP_GRACE;
    loop {
        if !process.alive() {
            return true;
        }
        match tokio::time::timeout_at(deadline, events.recv()).await {
            Ok(Some(Event::Exit { .. })) => return true,
            Ok(Some(_)) => {}
            _ => return !process.alive(),
        }
    }
}

fn with_stderr(mut message: String, tail: &str, secrets: &Secrets) -> String {
    let tail = tail.trim();
    if !tail.is_empty() {
        message.push('\n');
        message.push_str(tail);
    }
    let safe = redact_fragments(vec![JsString::from_rust_str(&message)], secrets);
    safe.first()
        .map_or_else(String::new, JsString::to_string_lossy)
}
