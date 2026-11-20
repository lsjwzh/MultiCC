//! Rust-only host for the production chat WebSocket. A session's lock orders
//! durable transcript writes, replay snapshots and live fan-out. Provider IO
//! runs outside this lock, and connection loss does not abandon a turn.
mod auth;
mod frames;
mod launch;
mod route;
mod store;

pub use auth::ConnectionRequest;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, OnceLock,
};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use hyper::body::Bytes;
use multicc_core::{
    api_contract, auth_runtime, chat_turn_host, chat_ws_control,
    js::{self, JsString, JsValue as V},
    quota_guard, random_id, ws_admission,
};
use serde_json::{json, Value};
use tokio::sync::{oneshot, Mutex, OnceCell};
use tokio_tungstenite::{
    tungstenite::{
        protocol::{frame::coding::CloseCode, CloseFrame},
        Message,
    },
    WebSocketStream,
};

use crate::{app::App, ws_chat_hub::ChatHub, ws_registry::Frame};
use store::{optional_text, Stored};

const SEND_TIMEOUT: Duration = Duration::from_secs(5);
const PING_INTERVAL: Duration = Duration::from_secs(30);
const QUEUE_CAPACITY: usize = 512;
const QUEUE_BYTES: usize = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

type SessionCell = Arc<OnceCell<Arc<Mutex<Session>>>>;

#[derive(Default)]
pub struct Host {
    hub: Arc<ChatHub>,
    sessions: Mutex<HashMap<String, SessionCell>>,
    records: Mutex<()>,
    epoch: OnceLock<String>,
    route_generation: AtomicU64,
}

struct Session {
    stored: Stored,
    native_started: bool,
    active: Option<Active>,
}

struct Active {
    id: String,
    route: route::Route,
    start: Instant,
    cancel: Option<oneshot::Sender<()>>,
    content: String,
    delta: String,
    tools: Vec<Value>,
    tools_bytes: usize,
    error: Option<String>,
}

impl Host {
    async fn session(&self, app: &App, id: &str) -> Result<Arc<Mutex<Session>>, String> {
        let entry = self
            .sessions
            .lock()
            .await
            .entry(id.to_owned())
            .or_default()
            .clone();
        let session = entry
            .get_or_try_init(|| async {
                let _records = self.records.lock().await;
                let root = app.data_root.clone();
                let home = app.home_dir.clone();
                let package = app.package_root.clone();
                let id = id.to_owned();
                let (stored, native_started) = tokio::task::spawn_blocking(move || {
                    let stored = store::restore(&root, &home, &package, &id)?;
                    let native_started = store::is_claude(&stored.record)
                        && multicc_core::missing_resume_recovery::has_native_transcript(
                            &stored.native_id,
                        );
                    Ok::<_, String>((stored, native_started))
                })
                .await
                .map_err(|error| error.to_string())??;
                let native_started = native_started
                    || stored.messages.iter().any(|row| {
                        is_role(row, "assistant")
                            && !js::truthy_opt(row.get("_interim"))
                            && !js::truthy_opt(row.get("partial"))
                            && !js::truthy_opt(row.get("error"))
                    });
                Ok::<_, String>(Arc::new(Mutex::new(Session {
                    stored,
                    native_started,
                    active: None,
                })))
            })
            .await?;
        Ok(Arc::clone(session))
    }

    fn publish(&self, id: &str, frame: V, replay: bool) {
        if let Some(wire) = wire(&frame) {
            self.hub.publish(id, Bytes::from(wire), replay);
        }
    }

    fn send(&self, connection: u64, frame: V) {
        if let Some(wire) = wire(&frame) {
            let _ = self.hub.send(connection, Frame::Text(Bytes::from(wire)));
        }
    }

    fn route(&self, turn: &str, record: &V) -> Result<route::Route, (&'static str, String)> {
        if self.epoch.get().is_none() {
            let _ = self.epoch.set(new_id("rt")?);
        }
        let epoch = self.epoch.get().expect("route epoch installed");
        let generation = self.route_generation.fetch_add(1, Ordering::Relaxed) + 1;
        let attempt = new_id("attempt")?;
        Ok(route::Route::new(epoch, turn, &attempt, generation, record))
    }
}

fn value(payload: Value) -> V {
    js::from_serde(&payload)
}

fn wire(frame: &V) -> Option<String> {
    js::json_stringify(&api_contract::ws_envelope(frame, &V::Undefined)?)
}

fn error_frame(code: &str, detail: &str) -> V {
    let message = api_contract::sanitize(&V::string(detail), &JsString::from_rust_str(code));
    V::object(vec![
        ("type", V::from("error")),
        ("code", V::from(code)),
        ("error", V::String(message)),
        ("providerRouteScope", V::from("host")),
    ])
}

fn is_role(row: &V, role: &str) -> bool {
    store::role(row).is_some_and(|value| value == role)
}

fn close(code: Option<u16>, reason: &str) -> Message {
    Message::Close(code.map(|code| CloseFrame {
        code: CloseCode::from(code),
        reason: reason.into(),
    }))
}

async fn send_message<S>(socket: &mut WebSocketStream<S>, message: Message) -> bool
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    matches!(
        tokio::time::timeout(SEND_TIMEOUT, socket.send(message)).await,
        Ok(Ok(()))
    )
}

async fn send_frame<S>(socket: &mut WebSocketStream<S>, frame: V) -> bool
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    match wire(&frame) {
        Some(wire) => send_message(socket, Message::Text(wire.into())).await,
        None => false,
    }
}

async fn refuse<S>(socket: &mut WebSocketStream<S>, frame: V)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    if send_frame(socket, frame).await {
        send_message(socket, close(None, "")).await;
    }
}

pub async fn serve<S>(app: Arc<App>, request: ConnectionRequest, mut socket: WebSocketStream<S>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let id = request
        .session
        .as_deref()
        .filter(|id| !id.is_empty())
        .unwrap_or("_default");
    let mut facts = request.facts(&app).await;
    let initial = ws_admission::plan(&facts);
    if !initial.contains(&ws_admission::Step::Accept) {
        send_refusal(&mut socket, initial).await;
        return;
    }
    let root = app.data_root.clone();
    let records = tokio::task::spawn_blocking(move || store::records(&root)).await;
    let records = match records {
        Ok(Ok(records)) => records,
        Ok(Err(error)) => {
            refuse(
                &mut socket,
                error_frame("session_state_unavailable", &error),
            )
            .await;
            return;
        }
        Err(error) => {
            refuse(
                &mut socket,
                error_frame("session_state_unavailable", &error.to_string()),
            )
            .await;
            return;
        }
    };
    let record = store::lookup(&records, id);
    facts.session_internal_slot =
        record.and_then(|record| record.get("taskExecutionSlot")) == Some(&V::Bool(true));
    let steps = ws_admission::plan(&facts);
    if !steps.contains(&ws_admission::Step::Accept) {
        send_refusal(&mut socket, steps).await;
        return;
    }
    let permission = steps
        .into_iter()
        .find_map(|step| match step {
            ws_admission::Step::SharePermission(permission) => permission,
            _ => None,
        })
        .unwrap_or_default();
    if request.shell.is_some() {
        let detail = if permission.is_empty() {
            "Task shell history requires the task host"
        } else {
            "Shell history is unavailable through a session share"
        };
        refuse(&mut socket, error_frame("shell_scope_denied", detail)).await;
        return;
    }
    let kind = record
        .and_then(|record| record.get("kind"))
        .unwrap_or(&V::Undefined);
    if let Some(error) = chat_ws_control::open_session_error(
        id,
        record.is_some(),
        facts.session_internal_slot,
        kind,
        None,
    ) {
        refuse(&mut socket, error).await;
        return;
    }
    let session = match app.native_chat.session(&app, id).await {
        Ok(session) => session,
        Err(error) => {
            refuse(
                &mut socket,
                error_frame("session_state_unavailable", &error),
            )
            .await;
            return;
        }
    };
    let (mut attached, frames) = {
        let state = session.lock().await;
        let Some(attached) = app.native_chat.hub.attach(id, QUEUE_CAPACITY, QUEUE_BYTES) else {
            return;
        };
        let frames =
            frames::initial_frames(&app.native_chat.hub, id, &state, &attached, request.archive);
        (attached, frames)
    };
    for frame in frames {
        if !send_message(&mut socket, Message::Text(frame.into())).await {
            return;
        }
    }
    let mut ping =
        tokio::time::interval_at(tokio::time::Instant::now() + PING_INTERVAL, PING_INTERVAL);
    let mut unanswered = 0;
    loop {
        tokio::select! {
            _ = attached.connection.overflow.changed() => {
                let _ = send_message(&mut socket, close(Some(1013), "slow_client")).await;
                break;
            }
            _ = ping.tick() => {
                if unanswered == 3 || !send_message(&mut socket, Message::Ping(Bytes::new())).await { break; }
                unanswered += 1;
            }
            frame = attached.connection.receiver.recv() => {
                let Some(frame) = frame else { break };
                let Frame::Text(data) = &frame.frame else { continue };
                let Ok(text) = std::str::from_utf8(data) else { break };
                if !send_message(&mut socket, Message::Text(text.into())).await { break; }
            }
            frame = socket.next() => match frame {
                Some(Ok(Message::Text(text))) => {
                    if let Ok(message) = serde_json::from_str::<Value>(&text) {
                        input(&app, id, &session, attached.connection.id, &permission, message).await;
                    }
                }
                Some(Ok(Message::Binary(data))) => {
                    if let Ok(message) = serde_json::from_slice::<Value>(&data) {
                        input(&app, id, &session, attached.connection.id, &permission, message).await;
                    }
                }
                Some(Ok(Message::Pong(_))) => unanswered = 0,
                Some(Ok(Message::Ping(_))) => { let _ = tokio::time::timeout(SEND_TIMEOUT, socket.flush()).await; }
                Some(Ok(Message::Close(_))) => {
                    let _ = tokio::time::timeout(SEND_TIMEOUT, socket.flush()).await;
                    break;
                }
                _ => break,
            },
        }
    }
}

async fn send_refusal<S>(socket: &mut WebSocketStream<S>, steps: Vec<ws_admission::Step>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    for step in steps {
        match step {
            ws_admission::Step::SessionMissing => {
                send_frame(socket, value(json!({"type":"error","error":"Session does not exist.","data":"Session does not exist.\r\n"}))).await;
            }
            ws_admission::Step::Close { code, reason } => {
                send_message(socket, close(code, reason.unwrap_or(""))).await;
                break;
            }
            _ => {}
        }
    }
}

async fn input(
    app: &Arc<App>,
    id: &str,
    session: &Arc<Mutex<Session>>,
    connection: u64,
    permission: &str,
    message: Value,
) {
    let host = &app.native_chat;
    let kind = message["type"].as_str().unwrap_or("");
    match chat_ws_control::action(kind, permission) {
        chat_ws_control::Action::Pong => {
            host.send(connection, value(json!({"type":"pong"})));
            return;
        }
        chat_ws_control::Action::Ignore => return,
        chat_ws_control::Action::Continue => {}
    }
    let prompt = message["text"].as_str().filter(|text| !text.is_empty());
    if kind == "cancel"
        || (kind == "user_message" && prompt.is_some_and(chat_ws_control::is_legacy_cancel))
    {
        let mut session = session.lock().await;
        if let Some(cancel) = session.active.as_mut().and_then(|turn| turn.cancel.take()) {
            let _ = cancel.send(());
        }
        return;
    }
    if kind == "clear_history" {
        host.send(
            connection,
            error_frame(
                "chat_history_action_unavailable",
                "Clearing chat history requires the history host",
            ),
        );
        return;
    }
    let Some(prompt) = prompt.filter(|_| kind == "user_message") else {
        return;
    };
    let error = admit(app, id, session, connection, prompt, &message).await;
    if let Err((code, message)) = error {
        host.send(connection, error_frame(code, &message));
    }
}

async fn admit(
    app: &Arc<App>,
    id: &str,
    session: &Arc<Mutex<Session>>,
    connection: u64,
    prompt: &str,
    incoming: &Value,
) -> Result<(), (&'static str, String)> {
    let mut state = session.lock().await;
    let client_id = incoming["clientMsgId"]
        .as_str()
        .filter(|value| !value.trim().is_empty());
    if let Some(client_id) = client_id {
        if let Some(row) = state.stored.messages.iter().rev().find(|row| {
            is_role(row, "user") && optional_text(row, "clientMsgId").as_deref() == Some(client_id)
        }) {
            app.native_chat.send(connection, metadata(row));
            return Ok(());
        }
    }
    if state.active.is_some() {
        return Err((
            "session_busy",
            "A turn is already running for this session".into(),
        ));
    }
    let record = &state.stored.record;
    if !store::is_claude(record) {
        return Err((
            "chat_provider_unavailable",
            "The native chat host requires a Claude session".into(),
        ));
    }
    if [
        "provider",
        "providerSelection",
        "subagent",
        "taskBoundTaskId",
        "experimentalMode",
        "pendingCliHandoff",
    ]
    .iter()
    .any(|field| js::truthy_opt(record.get(field)))
        || js::truthy_opt(record.get("cliAccounts"))
        || incoming["unattended"].is_object()
        || incoming["goal"] == true
        || incoming["taskShell"] == true
        || incoming["userInputRequestId"].is_string()
    {
        return Err((
            "chat_route_unavailable",
            "This session or message requires the configured task or provider host".into(),
        ));
    }
    if prompt.len() > MAX_OUTPUT_BYTES {
        return Err((
            "message_too_large",
            "Chat message exceeds the input limit".into(),
        ));
    }
    let (turn_id, message_id, prompt_uuid) = (
        new_id("turn")?,
        new_id("m")?,
        random_id::random_uuid_v4().map_err(|error| ("internal_error", error.to_string()))?,
    );
    let options = launch::launch_options(app, &state);
    let route = app.native_chat.route(&turn_id, record)?;
    let mut user = value(
        json!({"role":"user", "content":prompt, "ts":auth_runtime::now_ms(), "turnId":turn_id}),
    );
    if let Some(client_id) = client_id {
        quota_guard::set(&mut user, "clientMsgId", V::from(client_id));
    }
    quota_guard::set(&mut user, "id", V::from(message_id));
    save_row(&mut state.stored, user.clone())
        .await
        .map_err(|message| ("message_not_durable", message))?;
    let host = Arc::clone(&app.native_chat);
    host.publish(id, metadata(&user), false);
    let (cancel, cancelled) = oneshot::channel();
    let selected = route.event(id, "selected", "none");
    state.active = Some(Active {
        id: turn_id.clone(),
        route,
        start: Instant::now(),
        cancel: Some(cancel),
        content: String::new(),
        delta: String::new(),
        tools: Vec::new(),
        tools_bytes: 0,
        error: None,
    });
    host.hub.clear_replay(id);
    host.publish(
        id,
        value(json!({"type":"stream_start","turnId":turn_id})),
        false,
    );
    host.publish(id, selected, false);
    let prompt = prompt.to_owned();
    let session = Arc::clone(session);
    let id = id.to_owned();
    tokio::spawn(async move {
        let outcome = chat_turn_host::run(options, &prompt, &prompt_uuid, cancelled, |event| {
            let (host, session, id, turn_id) = (
                Arc::clone(&host),
                Arc::clone(&session),
                id.clone(),
                turn_id.clone(),
            );
            async move { observe(&host, &id, &session, &turn_id, event).await }
        })
        .await;
        finish(&host, &id, &session, &turn_id, outcome).await;
    });
    Ok(())
}

fn new_id(prefix: &str) -> Result<String, (&'static str, String)> {
    random_id::prefixed_id(prefix).map_err(|error| ("internal_error", error.to_string()))
}

async fn save_row(stored: &mut Stored, row: V) -> Result<(), String> {
    let mut messages = std::mem::take(&mut stored.messages);
    let path: PathBuf = stored.history_path.clone();
    messages.push(row);
    let (mut messages, saved) = tokio::task::spawn_blocking(move || {
        let saved = store::write_history(&path, &messages);
        (messages, saved)
    })
    .await
    .map_err(|error| error.to_string())?;
    use multicc_core::state_file::WriteStage;
    if saved.as_ref().is_err_and(|failure| {
        !matches!(
            failure.stage,
            WriteStage::ChmodTarget | WriteStage::OpenDirectory | WriteStage::FsyncDirectory
        )
    }) {
        messages.pop();
    }
    stored.messages = messages;
    saved.map_err(|failure| format!("{:?}: {}", failure.stage, failure.error))
}

fn property(row: &V, field: &str) -> V {
    row.get(field).cloned().unwrap_or(V::Undefined)
}

fn metadata(row: &V) -> V {
    let client = row.get("clientMsgId").cloned().unwrap_or(V::Null);
    let mut props = vec![
        ("type", V::from("chat_msg_meta")),
        ("id", property(row, "id")),
        ("role", property(row, "role")),
        ("ts", property(row, "ts")),
        ("clientMsgId", client),
    ];
    if is_role(row, "user") {
        let mut committed = vec![
            ("id", property(row, "id")),
            ("role", V::from("user")),
            ("content", property(row, "content")),
            ("ts", property(row, "ts")),
        ];
        for field in ["clientMsgId", "turnId"] {
            if let Some(V::String(text)) = row.get(field) {
                committed.push((field, V::String(text.truncate_units(160))));
            }
        }
        props.push(("message", V::object(committed)));
    }
    V::object(props)
}

async fn observe(host: &Host, id: &str, session: &Mutex<Session>, turn_id: &str, mut event: Value) {
    let mut state = session.lock().await;
    let Some(turn) = state
        .active
        .as_mut()
        .filter(|turn| turn.id == turn_id && turn.cancel.is_some())
    else {
        return;
    };
    match event["type"].as_str() {
        Some("system") if event["subtype"] == "init" => return,
        Some("assistant") => {
            let is_error = event["is_api_error_message"] == true
                || event["isApiErrorMessage"] == true
                || (event["error"].is_string() && event["message"]["model"] == "<synthetic>");
            let Some(blocks) = event["message"]["content"].as_array_mut() else {
                return;
            };
            if is_error {
                turn.error = Some(
                    blocks
                        .iter()
                        .filter_map(|block| block["text"].as_str())
                        .collect::<String>(),
                );
                return;
            }
            for block in blocks.iter() {
                match block["type"].as_str() {
                    Some("text") => {
                        append_text(&mut turn.content, block["text"].as_str().unwrap_or(""))
                    }
                    Some("tool_use") if turn.tools.len() < 128 => {
                        let tool = json!({"name":block["name"],"input":block["input"],"id":block["id"],"startedAt":auth_runtime::now_ms()});
                        let bytes = tool.to_string().len();
                        if bytes <= MAX_OUTPUT_BYTES.saturating_sub(turn.tools_bytes) {
                            turn.tools_bytes += bytes;
                            turn.tools.push(tool);
                        }
                    }
                    _ => {}
                }
            }
            turn.delta.clear();
            blocks.retain(|block| block["type"] != "text");
            if !turn.content.is_empty() {
                blocks.insert(0, json!({"type":"text","text":turn.content}));
            }
            event["message"]["textSnapshot"] = Value::Bool(true);
        }
        Some("stream_event") if event["event"]["delta"]["type"] == "text_delta" => {
            append_text(
                &mut turn.delta,
                event["event"]["delta"]["text"].as_str().unwrap_or(""),
            );
        }
        Some(_) => {}
        None => return,
    }
    host.publish(id, turn.route.tag(value(event)), true);
}

fn append_text(text: &mut String, extra: &str) {
    let mut end = extra.len().min(MAX_OUTPUT_BYTES.saturating_sub(text.len()));
    while !extra.is_char_boundary(end) {
        end -= 1;
    }
    text.push_str(&extra[..end]);
}

async fn finish(
    host: &Host,
    id: &str,
    session: &Mutex<Session>,
    turn_id: &str,
    outcome: chat_turn_host::Outcome,
) {
    use chat_turn_host::Outcome;
    let mut state = session.lock().await;
    if !state.active.as_ref().is_some_and(|turn| turn.id == turn_id) {
        return;
    }
    let turn = state.active.take().expect("owned turn");
    let outcome = if turn.cancel.is_none() {
        Outcome::Cancelled
    } else {
        outcome
    };
    if !state.native_started && !matches!(outcome, Outcome::Result(_)) {
        let native_id = state.stored.native_id.clone();
        state.native_started = tokio::task::spawn_blocking(move || {
            multicc_core::missing_resume_recovery::has_native_transcript(&native_id)
        })
        .await
        .unwrap_or(false);
    }
    let mut content = turn.content;
    append_text(&mut content, &turn.delta);
    let fence = if !turn.tools.is_empty() {
        "tool_intent"
    } else if !content.is_empty() {
        "visible_output"
    } else {
        "none"
    };
    let phase = match outcome {
        Outcome::Result(event)
            if chat_turn_host::completed_result(&event) && turn.error.is_none() =>
        {
            state.native_started = true;
            if content.is_empty() {
                append_text(&mut content, event["result"].as_str().unwrap_or(""));
            }
            let cost = event
                .get("total_cost_usd")
                .and_then(Value::as_f64)
                .map_or(V::Undefined, V::Number);
            let usage = event
                .get("usage")
                .map_or_else(|| value(json!({})), js::from_serde);
            match save_assistant(
                host,
                id,
                &mut state,
                turn_id,
                content,
                turn.tools,
                Some((&cost, &usage)),
            )
            .await
            {
                Ok(()) => {
                    let count = state
                        .stored
                        .messages
                        .iter()
                        .filter(|message| is_role(message, "assistant"))
                        .count();
                    host.publish(
                        id,
                        turn.route.tag(V::object(vec![
                            ("type", V::from("result")),
                            ("total_cost_usd", cost),
                            ("usage", usage),
                            (
                                "durationMs",
                                V::Number(turn.start.elapsed().as_millis() as f64),
                            ),
                            ("num_turns", V::Number(count as f64)),
                        ])),
                        false,
                    );
                    host.publish(id, turn.route.tag(value(event)), false);
                    "succeeded"
                }
                Err(error) => {
                    host.publish(id, error_frame("chat_result_not_durable", &error), false);
                    "failed"
                }
            }
        }
        Outcome::Result(event) => {
            let detail = turn
                .error
                .or_else(|| {
                    event["errors"].as_array().map(|errors| {
                        errors
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                })
                .filter(|error| !error.is_empty())
                .or_else(|| event["result"].as_str().map(ToOwned::to_owned))
                .unwrap_or_else(|| "Claude returned a failed result".into());
            host.publish(
                id,
                turn.route.tag(error_frame("chat_provider_error", &detail)),
                false,
            );
            "failed"
        }
        Outcome::Failed(error) => {
            host.publish(
                id,
                turn.route.tag(error_frame("chat_provider_error", &error)),
                false,
            );
            "failed"
        }
        Outcome::Cancelled => {
            if let Err(error) =
                save_assistant(host, id, &mut state, turn_id, content, turn.tools, None).await
            {
                host.publish(id, error_frame("chat_result_not_durable", &error), false);
            }
            "released"
        }
    };
    host.publish(id, turn.route.event(id, phase, fence), false);
    host.hub.clear_replay(id);
    host.publish(id, value(json!({"type":"stream_end"})), false);
}

async fn save_assistant(
    host: &Host,
    id: &str,
    state: &mut Session,
    turn_id: &str,
    content: String,
    tools: Vec<Value>,
    result: Option<(&V, &V)>,
) -> Result<(), String> {
    if content.is_empty() && tools.is_empty() {
        return Ok(());
    }
    let mut row = value(json!({"role":"assistant","content":content}));
    if !tools.is_empty() {
        quota_guard::set(&mut row, "tools", value(json!(tools)));
    }
    if let Some((cost, usage)) = result {
        quota_guard::set(
            &mut row,
            "cost",
            if cost.is_nullish() {
                V::Null
            } else {
                cost.clone()
            },
        );
        quota_guard::set(&mut row, "usage", usage.clone());
    } else {
        quota_guard::set(&mut row, "partial", V::Bool(true));
        quota_guard::set(&mut row, "cancelled", V::Bool(true));
    }
    quota_guard::set(&mut row, "ts", V::Number(auth_runtime::now_ms()));
    quota_guard::set(&mut row, "turnId", V::from(turn_id));
    quota_guard::set(
        &mut row,
        "id",
        V::from(new_id("m").map_err(|(_, error)| error)?),
    );
    save_row(&mut state.stored, row.clone()).await?;
    host.publish(id, metadata(&row), false);
    Ok(())
}
