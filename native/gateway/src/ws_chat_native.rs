//! Rust-only host for the production chat WebSocket. A session's lock orders
//! durable transcript writes, replay snapshots and live fan-out. Provider IO
//! runs outside this lock, and connection loss does not abandon a turn.
mod auth;
mod frames;
mod launch;
mod provider;
mod question;
mod route;
mod shell;
mod shell_http;
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
const HISTORY_PAGE: usize = 5;

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
    shell_worker: bool,
}

#[derive(Clone, Copy)]
struct ShellRoute<'a> {
    required: bool,
    id: Option<&'a str>,
}

struct Active {
    id: String,
    task: Option<String>,
    delivery: Option<String>,
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
                    shell_worker: false,
                })))
            })
            .await?;
        Ok(Arc::clone(session))
    }

    fn publish(&self, id: &str, frame: V, replay: bool) {
        if frame.get("type") == Some(&V::from("error")) {
            let code = store::text(&frame, "code");
            let detail = api_contract::sanitize(
                frame.get("error").unwrap_or(&V::Null),
                &JsString::from(code.as_str()),
            );
            eprintln!("[multicc-gateway] native chat failed ({id}): {code}: {detail}");
        }
        if let Some(wire) = wire(&frame) {
            self.hub.publish(id, Bytes::from(wire), replay);
        }
    }

    fn send(&self, connection: u64, frame: V) {
        if let Some(wire) = wire(&frame) {
            let _ = self.hub.send(connection, Frame::Text(Bytes::from(wire)));
        }
    }

    fn route(
        &self,
        turn: &str,
        record: &V,
        provider: Option<&provider::Provider>,
    ) -> Result<route::Route, (&'static str, String)> {
        if self.epoch.get().is_none() {
            let _ = self.epoch.set(new_id("rt")?);
        }
        let epoch = self.epoch.get().expect("route epoch installed");
        let generation = self.route_generation.fetch_add(1, Ordering::Relaxed) + 1;
        let attempt = new_id("attempt")?;
        Ok(route::Route::new(
            epoch, turn, &attempt, generation, record, provider,
        ))
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
    let shell_route = ShellRoute {
        id: request.shell.as_deref(),
        required: request.shell.is_some()
            || record.is_some_and(|record| js::truthy_opt(record.get("taskBoundTaskId"))),
    };
    let bound_task = record.and_then(|record| optional_text(record, "taskBoundTaskId"));
    let kind = record
        .and_then(|record| record.get("kind"))
        .unwrap_or(&V::Undefined);
    let open_error = chat_ws_control::open_session_error(
        id,
        record.is_some(),
        facts.session_internal_slot,
        kind,
        None,
    );
    let shell_history = if let Some(shell_id) = request.shell.clone() {
        let history = if permission.is_empty() {
            let root = app.data_root.clone();
            let id = id.to_owned();
            let archive = request.archive;
            tokio::task::spawn_blocking(move || {
                store::shell_history(&root, &records, &shell_id, &id, archive)
            })
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result)
        } else {
            Err("Shell history is unavailable through a session share".into())
        };
        match history {
            Ok(history) => Some(history),
            Err(error) => {
                refuse(
                    &mut socket,
                    value(json!({"type":"error","code":"shell_scope_denied","error":error})),
                )
                .await;
                return;
            }
        }
    } else {
        None
    };
    if let Some(error) = open_error {
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
    let (mut attached, frames, queue) = {
        let state = session.lock().await;
        let root = app.data_root.clone();
        let session_id = id.to_owned();
        let record = state.stored.record.clone();
        let captured = shell::blocking(move || {
            let question = question::read(&root, &session_id, &record)?;
            let queue = multicc_core::orchestration_store::chat_queue_snapshot(
                &root.join("orchestration.sqlite"),
                &session_id,
            );
            Ok((question, queue))
        })
        .await;
        let (question, queue) = match captured {
            Ok(captured) => captured,
            Err(error) => {
                refuse(
                    &mut socket,
                    error_frame("session_work_owner_unavailable", &error),
                )
                .await;
                return;
            }
        };
        let Some(attached) = app.native_chat.hub.attach(id, QUEUE_CAPACITY, QUEUE_BYTES) else {
            return;
        };
        let frames = frames::initial_frames(
            &app,
            id,
            &state,
            &attached,
            request.archive,
            shell_history,
            shell_route.required,
        )
        .await;
        let mut frames = frames;
        let last = question
            .category
            .get("lastResolvedUserInput")
            .unwrap_or(&V::Null);
        if let Some(frame) = wire(&multicc_core::session_question::replay(
            &question.pending,
            last,
        )) {
            frames.push(frame);
        }
        (attached, frames, queue)
    };
    let resume_queue = queue.as_ref().is_ok_and(|frame| {
        store::text(frame, "state") == "idle"
            && matches!(frame.get("items"), Some(V::Array(items)) if !items.is_empty())
    });
    let queue = match queue {
        Ok(queue) => wire(&queue),
        Err(error) => {
            eprintln!("[multicc-gateway] chat queue snapshot failed: {error}");
            None
        }
    };
    for frame in frames.into_iter().chain(queue) {
        if !send_message(&mut socket, Message::Text(frame.into())).await {
            return;
        }
    }
    if permission.is_empty() && resume_queue {
        if let Some(task) = bound_task {
            shell::wake(&app, id, &session, task).await;
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
                    if let Ok(message) = js::json_parse(&text) {
                        input(&app, id, &session, attached.connection.id, &permission, message, shell_route).await;
                    }
                }
                Some(Ok(Message::Binary(data))) => {
                    if let Some(message) = std::str::from_utf8(&data).ok().and_then(|text| js::json_parse(text).ok()) {
                        input(&app, id, &session, attached.connection.id, &permission, message, shell_route).await;
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
    message: V,
    shell_route: ShellRoute<'_>,
) {
    let host = &app.native_chat;
    let kind = store::text(&message, "type");
    let kind = kind.as_str();
    match chat_ws_control::action(kind, permission) {
        chat_ws_control::Action::Pong => {
            host.send(connection, value(json!({"type":"pong"})));
            return;
        }
        chat_ws_control::Action::Ignore => return,
        chat_ws_control::Action::Continue => {}
    }
    let prompt = store::optional_text(&message, "text");
    use chat_ws_control::Command;
    let command = chat_ws_control::command(
        kind,
        permission,
        shell_route.required || message.get("taskShell") == Some(&V::Bool(true)),
        shell_route.id.is_some(),
        message.get("taskShell") == Some(&V::Bool(true)),
        prompt.is_some(),
    );
    match command {
        Command::Ignore | Command::Typing => {}
        Command::Cancel => cancel_active(session).await,
        Command::ClearHistory | Command::ClearShellHistory => {
            host.send(
                connection,
                error_frame(
                    "chat_history_action_unavailable",
                    "Clearing chat history requires the history host",
                ),
            );
        }
        Command::RequireShellRoute => {
            host.send(connection, frames::require_shell_route(id));
        }
        Command::RouteShellInput => {
            use multicc_core::task_shell::chat::Rejection;
            let client_id = property(&message, "clientMsgId");
            let root = app.data_root.clone();
            let shell = shell_route.id.map(ToOwned::to_owned);
            let execution = id.to_owned();
            let shared = !permission.is_empty();
            let input_message = message.clone();
            let replay = tokio::task::spawn_blocking(move || {
                store::replay_shell_input(&root, shell.as_deref(), &execution, shared, &message)
            })
            .await;
            let frame = match replay {
                Ok(Ok(Some(frame))) => frame,
                Ok(Err(error)) => error.frame(client_id),
                Err(error) => {
                    Rejection::state("task_shell_failed", error.to_string()).frame(client_id)
                }
                Ok(Ok(None)) => {
                    submit_from_shell(app, id, session, shell_route, &input_message, shared).await
                }
            };
            let queued =
                if kind != "cancel" && frame.get("type") == Some(&V::from("task_shell_routed")) {
                    optional_text(&frame, "sessionId").zip(optional_text(&frame, "taskId"))
                } else {
                    None
                };
            host.send(connection, frame);
            if let Some((execution, task)) = queued {
                if execution == id {
                    shell::wake(app, id, session, task).await;
                } else if let Ok(target) = host.session(app, &execution).await {
                    shell::wake(app, &execution, &target, task).await;
                }
            }
        }
        Command::Message => {
            let prompt = prompt.expect("message command requires a prompt");
            if chat_ws_control::is_legacy_cancel(&prompt) {
                cancel_active(session).await;
            } else if let Err((code, message)) = admit(
                app,
                id,
                session,
                connection,
                &prompt,
                &js::to_serde(&message),
            )
            .await
            {
                host.send(connection, error_frame(code, &message));
            }
        }
    }
}

async fn submit_from_shell(
    app: &Arc<App>,
    addressed: &str,
    session: &Arc<Mutex<Session>>,
    route: ShellRoute<'_>,
    message: &V,
    shared: bool,
) -> V {
    let Some(shell_id) = route.id.filter(|_| !shared) else {
        return shell::submit(app, addressed, session, route, message, None).await;
    };
    let intent = multicc_core::task_shell::chat::intent(message);
    let (task, target) =
        match shell::linked_target(&app.data_root, shell_id, addressed, intent).await {
            Ok(found) => found,
            Err(error) => return shell::delivery_error(&error),
        };
    let target_session = if target == addressed {
        Arc::clone(session)
    } else {
        match app.native_chat.session(app, &target).await {
            Ok(session) => session,
            Err(error) => return shell::delivery_error(&error),
        }
    };
    shell::submit(app, &target, &target_session, route, message, Some(&task)).await
}

pub(crate) async fn shell_registry(app: &App, request: Value) -> Result<Value, String> {
    let root = app.data_root.clone();
    shell::blocking(move || shell::registry(&root, &request)).await
}

pub(crate) async fn shell_delivery(app: &Arc<App>, request: Value) -> Result<Value, String> {
    shell_http::deliver(app, request).await
}

pub(crate) async fn recover_shell_queue(app: &Arc<App>) -> Result<(), String> {
    let root = app.data_root.clone();
    let candidates = shell::blocking(move || {
        if !root.join("orchestration.sqlite").try_exists().map_err(|error|error.to_string())?
            && !root.join("orchestration.json").try_exists().map_err(|error|error.to_string())? {
            return Ok(Vec::new());
        }
        let all = store::records(&root)?;
        let mut queue = shell::queue_store(&root)?;
        let mut prepared = queue.request("scheduleRecoverOwnedPrepareExperimental",&json!({"entries":[]}))?;
        let mut entries = Vec::new();
        for id in prepared["sessions"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            let record = store::lookup(&all,id).unwrap_or(&V::Null);
            let mut snapshot = question::read(&root,id,record)?;
            quota_guard::set(&mut snapshot.category,"recoveryRecordType",record.get("type").cloned().unwrap_or(V::Null));
            entries.push(json!({"sessionId":id,"initial":{
                "pendingQuestionJson":js::json_stringify_or_undefined(&snapshot.pending),
                "activeTurnJson":js::json_stringify_or_undefined(&snapshot.active),
                "categoryJson":js::json_stringify_or_undefined(&snapshot.category)}}));
        }
        if !entries.is_empty() { prepared = queue.request("scheduleRecoverOwnedPrepareExperimental",&json!({"entries":entries}))?; }
        if prepared["sessions"].as_array().is_some_and(|ids| !ids.is_empty()) {
            return Err(format!("schedule recovery backfill refused: {}",prepared["sessions"]));
        }
        let at = shell::now();
        queue.request("scheduleRecoverOwnedCommitExperimental",&json!({
            "expectedRevision":prepared["state"]["revision"],"expectedDataVersion":prepared["dataVersion"],
            "at":at,"updatedAt":at,"facts":prepared["facts"]}))?;
        let tasks = shell::task_store(&root)?;
        let mut candidates = Vec::new();
        for record in &all {
            let id = store::text(record,"id");
            if !store::is_claude(record) || record.get("taskExecutionSlot") == Some(&V::Bool(true)) { continue; }
            let task = tasks.chat_task_for_session(&id)?;
            let Some(task_id) = task["id"].as_str() else { continue; };
            let frame = multicc_core::orchestration_store::chat_queue_snapshot(&root.join("orchestration.sqlite"),&id)?;
            if matches!(frame.get("items"),Some(V::Array(items)) if !items.is_empty()) {
                candidates.push((id,task_id.to_owned()));
            }
        }
        Ok(candidates)
    }).await?;
    for (id, task) in candidates {
        let session = app.native_chat.session(app, &id).await?;
        shell::wake(app, &id, &session, task).await;
    }
    Ok(())
}

pub(crate) async fn question_access(app: &App, id: &str) -> Result<Option<bool>, String> {
    let root = app.data_root.clone();
    let id = id.to_owned();
    shell::blocking(move || {
        Ok(store::lookup(&store::records(&root)?, &id)
            .map(|record| record.get("taskExecutionSlot") == Some(&V::Bool(true))))
    })
    .await
}

pub(crate) async fn dismiss_question(
    app: &App,
    id: &str,
    request_id: &str,
) -> Result<Value, String> {
    let state = app.native_chat.session(app, id).await?;
    let state = state.lock().await;
    let root = app.data_root.clone();
    let session_id = id.to_owned();
    let record = state.stored.record.clone();
    let command = value(
        json!({"action":"resolve","requestId":request_id,"dismissed":true,
        "nativeDismissal":true,"streaming":state.active.is_some() || state.shell_worker}),
    );
    let result =
        shell::blocking(move || question::transition(&root, &session_id, &record, command)).await?;
    if result.notification != V::Null {
        app.native_chat.publish(id, result.notification, false);
        return Ok(json!({"ok":true,"requestId":request_id,"resolution":"dismissed"}));
    }
    Ok(result.result)
}

async fn cancel_active(session: &Mutex<Session>) {
    let mut session = session.lock().await;
    if let Some(cancel) = session.active.as_mut().and_then(|turn| turn.cancel.take()) {
        let _ = cancel.send(());
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
    let answer = incoming["userInputRequestId"]
        .as_str()
        .map(js::js_trim)
        .filter(|id| !id.is_empty());
    let previous = client_id
        .and_then(|client_id| {
            state.stored.messages.iter().rev().find(|row| {
                is_role(row, "user")
                    && optional_text(row, "clientMsgId").as_deref() == Some(client_id)
            })
        })
        .cloned();
    let replayed_answer = if let Some(row) = previous {
        if answer.is_none() && row.get("userInputRequestId").is_none() {
            app.native_chat.send(connection, metadata(&row));
            return Ok(());
        }
        if optional_text(&row, "userInputRequestId").as_deref() != answer
            || store::text(&row, "content") != prompt
        {
            return Err((
                "idempotency_conflict",
                "Reply does not match the saved message".into(),
            ));
        }
        let (root, session_id, record) = (
            app.data_root.clone(),
            id.to_owned(),
            state.stored.record.clone(),
        );
        let snapshot = shell::blocking(move || question::read(&root, &session_id, &record))
            .await
            .map_err(|error| ("session_work_owner_unavailable", error))?;
        if optional_text(&snapshot.pending, "requestId").as_deref() != answer
            || !multicc_core::session_question::is_open(&snapshot.pending)
        {
            app.native_chat.send(connection, metadata(&row));
            return Ok(());
        }
        Some(row)
    } else {
        None
    };
    if state.active.is_some() || state.shell_worker {
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
    let launched = prepare_turn(
        app,
        id,
        &mut state,
        prompt,
        client_id,
        TurnInput::Direct {
            answer,
            previous: replayed_answer,
        },
    )
    .await?;
    let app = Arc::clone(app);
    let prompt = prompt.to_owned();
    let session = Arc::clone(session);
    let id = id.to_owned();
    tokio::spawn(async move {
        let _ = run_turn(&app, &id, &session, launched, &prompt, None).await;
    });
    Ok(())
}

struct RunningTurn {
    options: multicc_core::claude_process::StartInput,
    reference_seed: String,
    turn_id: String,
    attempt_id: String,
    prompt_uuid: String,
    cancelled: oneshot::Receiver<()>,
    provider_proxy: Option<provider::Proxy>,
}

enum TurnInput<'a> {
    Direct {
        answer: Option<&'a str>,
        previous: Option<V>,
    },
    Shell(&'a shell::Delivery),
}

async fn prepare_turn(
    app: &App,
    id: &str,
    state: &mut Session,
    prompt: &str,
    client_id: Option<&str>,
    input: TurnInput<'_>,
) -> Result<RunningTurn, (&'static str, String)> {
    let (delivery, answer, previous) = match input {
        TurnInput::Direct { answer, previous } => (None, answer, previous),
        TurnInput::Shell(delivery) => (Some(delivery), None, None),
    };
    let root = app.data_root.clone();
    let session_id = id.to_owned();
    let record = state.stored.record.clone();
    let snapshot = shell::blocking(move || question::read(&root, &session_id, &record))
        .await
        .map_err(|error| ("session_work_owner_unavailable", error))?;
    if let Some(answer) = answer {
        let pending = &snapshot.pending;
        let current = snapshot.category.get("userInputSignalTurnId");
        if optional_text(pending, "requestId").as_deref() != Some(answer)
            || (js::truthy_opt(current) && current != pending.get("turnId"))
        {
            return Err((
                "stale_control",
                "The question belongs to another turn".into(),
            ));
        }
        if !multicc_core::session_question::is_open(pending) {
            return Err((
                "answer_already_resolved",
                "The question has already been settled".into(),
            ));
        }
    }
    let (turn_id, message_id, prompt_uuid) = (
        previous
            .as_ref()
            .and_then(|row| optional_text(row, "turnId"))
            .map_or_else(|| new_id("turn"), Ok)?,
        new_id("m")?,
        random_id::random_uuid_v4().map_err(|error| ("internal_error", error.to_string()))?,
    );
    let mut options = launch::launch_options(state);
    let reference_seed = match delivery {
        Some(delivery) => delivery
            .reference_seed(!options.launch.resume)
            .await
            .map_err(|error| ("task_shell_context_unavailable", error))?,
        None => String::new(),
    };
    let provider = provider::Provider::load(&app.data_root, &state.stored.record)
        .await
        .map_err(|error| ("chat_provider_unavailable", error))?;
    let route = app
        .native_chat
        .route(&turn_id, &state.stored.record, provider.as_ref())?;
    let provider_proxy = match provider {
        Some(provider) => Some(
            provider
                .open(&mut options.launch, id)
                .await
                .map_err(|error| ("chat_provider_unavailable", error.to_string()))?,
        ),
        None => None,
    };
    let mut user = value(
        json!({"role":"user", "content":prompt, "ts":auth_runtime::now_ms(), "turnId":turn_id}),
    );
    if let Some(client_id) = client_id {
        quota_guard::set(&mut user, "clientMsgId", V::from(client_id));
    }
    if let Some(delivery) = delivery {
        quota_guard::set(&mut user, "taskId", V::from(delivery.task.as_str()));
        quota_guard::set(&mut user, "deliveryId", V::from(delivery.entry.as_str()));
        quota_guard::set(&mut user, "taskStart", V::Bool(!delivery.answer));
        quota_guard::set(&mut user, "taskSource", V::from("task-shell"));
        quota_guard::set(&mut user, "taskText", V::from(prompt));
        if let Some(role) = delivery.role_prompt.as_ref() {
            options.launch.system_prompt_append = Some(role.to_owned());
        }
    }
    quota_guard::set(&mut user, "id", V::from(message_id));
    if let Some(answer) = answer {
        quota_guard::set(&mut user, "userInputRequestId", V::from(answer));
    }
    if let Some(previous) = previous {
        user = previous;
    } else {
        save_row(&mut state.stored, user.clone())
            .await
            .map_err(|message| ("message_not_durable", message))?;
    }
    if let Some(delivery) = delivery {
        delivery
            .handoff()
            .await
            .map_err(|message| ("chat_handoff_failed", message))?;
    }
    let root = app.data_root.clone();
    let session_id = id.to_owned();
    let record = state.stored.record.clone();
    let command = value(
        json!({"action":"beginTurn","expectedVersion":snapshot.version,"turnId":turn_id,
        "originContinue":delivery.is_some_and(|delivery| delivery.answer) || answer.is_some(),"answerRequestId":answer,
        "activeTurn":{"_activeTurn":{"turnId":turn_id},"isStreaming":true,
            "_currentTaskId":delivery.map(|delivery| &delivery.task)}}),
    );
    let question =
        shell::blocking(move || question::transition(&root, &session_id, &record, command))
            .await
            .map_err(|error| ("session_work_owner_unavailable", error))?;
    if question.result["ok"] != true {
        return Err(("stale_control", question.result.to_string()));
    }
    let host = &app.native_chat;
    if question.notification != V::Null {
        host.publish(id, question.notification, false);
    }
    host.publish(id, metadata(&user), false);
    let (cancel, cancelled) = oneshot::channel();
    let mut selected = route.event(id, "selected", "none");
    quota_guard::set(&mut selected, "reasonCode", V::from("route_resolved"));
    let attempt_id = store::text(&route.scope, "routeAttemptId");
    state.active = Some(Active {
        id: turn_id.clone(),
        task: delivery.map(|delivery| delivery.task.clone()),
        delivery: delivery.map(|delivery| delivery.entry.clone()),
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
    let turn = state.active.as_ref().expect("installed turn");
    if turn.task.is_some() {
        host.publish(id, turn.attribute(frames::notify("running", prompt)), false);
    }
    host.publish(
        id,
        turn.attribute(value(json!({"type":"stream_start","turnId":turn_id}))),
        false,
    );
    host.publish(id, turn.attribute(selected), false);
    Ok(RunningTurn {
        options,
        reference_seed,
        turn_id,
        attempt_id,
        prompt_uuid,
        cancelled,
        provider_proxy,
    })
}

async fn run_turn(
    app: &App,
    id: &str,
    session: &Arc<Mutex<Session>>,
    mut launched: RunningTurn,
    prompt: &str,
    scheduled: Option<(&shell::Writer, &shell::Delivery)>,
) -> TurnEnd {
    let host = &app.native_chat;
    let turn_id = launched.turn_id.as_str();
    let attempt_id = launched.attempt_id.as_str();
    launch::prepare_history(app, &launched.options).await;
    let question_tool =
        question::open(&mut launched.options.launch, app, session, id, turn_id).await;
    let provider_prompt = if launched.reference_seed.is_empty() {
        std::borrow::Cow::Borrowed(prompt)
    } else {
        std::borrow::Cow::Owned(format!("{}{prompt}", launched.reference_seed))
    };
    let result = match question_tool {
        Ok(_tool) => {
            chat_turn_host::run(
                launched.options,
                &provider_prompt,
                &launched.prompt_uuid,
                launched.cancelled,
                |event| observe(host, id, session, turn_id, event),
                |pid| async move {
                    if let Some((writer, delivery)) = scheduled {
                        writer.started(pid, turn_id, attempt_id, delivery).await?;
                    }
                    Ok(())
                },
            )
            .await
        }
        Err(error) => chat_turn_host::RunResult {
            outcome: chat_turn_host::Outcome::Failed(error),
            writer_stopped: true,
        },
    };
    drop(launched.provider_proxy);
    let usage_durable = matches!(&result.outcome, chat_turn_host::Outcome::Result(event) if event["usage"].is_object());
    let (phase, awaiting) = finish(app, id, session, &launched.turn_id, result.outcome).await;
    TurnEnd {
        id: launched.turn_id,
        attempt: launched.attempt_id,
        phase,
        awaiting,
        stopped: result.writer_stopped,
        usage_durable: usage_durable && phase == "succeeded",
    }
}

struct TurnEnd {
    id: String,
    attempt: String,
    phase: &'static str,
    awaiting: Option<String>,
    stopped: bool,
    usage_durable: bool,
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
        for field in ["clientMsgId", "turnId", "taskId", "taskShortCode"] {
            if let Some(V::String(text)) = row.get(field) {
                committed.push((field, V::String(text.truncate_units(160))));
            }
        }
        props.push(("message", V::object(committed)));
    }
    if let Some(task) = row.get("taskId") {
        props.push(("taskId", task.clone()));
    }
    V::object(props)
}

impl Active {
    fn attribute(&self, mut frame: V) -> V {
        if let Some(task) = self.task.as_deref() {
            quota_guard::set(&mut frame, "taskId", V::from(task));
        }
        frame
    }

    fn attempt_frame(&self, frame: V) -> V {
        self.attribute(self.route.tag(frame))
    }
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
    host.publish(id, turn.attempt_frame(value(event)), true);
}

fn append_text(text: &mut String, extra: &str) {
    let mut end = extra.len().min(MAX_OUTPUT_BYTES.saturating_sub(text.len()));
    while !extra.is_char_boundary(end) {
        end -= 1;
    }
    text.push_str(&extra[..end]);
}

async fn finish(
    app: &App,
    id: &str,
    session: &Mutex<Session>,
    turn_id: &str,
    outcome: chat_turn_host::Outcome,
) -> (&'static str, Option<String>) {
    use chat_turn_host::Outcome;
    let host = &app.native_chat;
    let mut state = session.lock().await;
    if !state.active.as_ref().is_some_and(|turn| turn.id == turn_id) {
        return ("failed", None);
    }
    let mut turn = state.active.take().expect("owned turn");
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
    let mut content = std::mem::take(&mut turn.content);
    append_text(&mut content, &turn.delta);
    let fence = if !turn.tools.is_empty() {
        "tool_intent"
    } else if !content.is_empty() {
        "visible_output"
    } else {
        "none"
    };
    let mut api_error = V::Null;
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
                &mut turn,
                content,
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
                        turn.attempt_frame(V::object(vec![
                            ("type", V::from("result")),
                            ("total_cost_usd", cost),
                            ("usage", usage),
                            (
                                "durationMs",
                                V::Number(turn.start.elapsed().as_millis() as f64),
                            ),
                            ("num_turns", V::Number(count as f64)),
                            ("modelAttribution", turn.route.model_attribution()),
                        ])),
                        false,
                    );
                    host.publish(id, turn.attempt_frame(value(event)), false);
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
                .take()
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
            if turn.task.is_some() {
                let safe = api_contract::sanitize(
                    &V::from(detail.as_str()),
                    &JsString::from("chat_provider_error"),
                );
                host.publish(
                    id,
                    turn.attempt_frame(V::object(vec![
                        ("type", V::from("result")),
                        (
                            "subtype",
                            event["subtype"].as_str().map_or(V::Undefined, V::from),
                        ),
                        ("is_error", V::Bool(true)),
                        ("errors", V::Array(vec![V::String(safe)])),
                    ])),
                    false,
                );
            }
            api_error = frames::provider_failure(
                host,
                id,
                &turn,
                &detail,
                event["subtype"].as_str(),
                fence,
            );
            "failed"
        }
        Outcome::Failed(error) => {
            api_error = frames::provider_failure(host, id, &turn, &error, None, fence);
            "failed"
        }
        Outcome::Cancelled => {
            if let Err(error) = save_assistant(host, id, &mut state, &mut turn, content, None).await
            {
                host.publish(id, error_frame("chat_result_not_durable", &error), false);
            }
            "released"
        }
    };
    let root = app.data_root.clone();
    let session_id = id.to_owned();
    let record = state.stored.record.clone();
    let command =
        value(json!({"action":"finishNative","turnId":turn_id,"succeeded":phase == "succeeded"}));
    let question = shell::blocking(move || {
        let finished = question::transition(&root, &session_id, &record, command)?;
        if finished.result["ok"] != true {
            return Err(finished.result.to_string());
        }
        question::read(&root, &session_id, &record)
    })
    .await;
    let (phase, awaiting) = match question {
        Ok(question) => {
            let awaiting = multicc_core::session_question::is_open(&question.pending)
                .then(|| optional_text(&question.pending, "requestId"))
                .flatten();
            (phase, awaiting)
        }
        Err(error) => {
            host.publish(
                id,
                error_frame("session_work_owner_unavailable", &error),
                false,
            );
            ("failed", None)
        }
    };
    if let Some(task) = turn.task.as_deref() {
        let root = app.data_root.clone();
        let session_id = id.to_owned();
        let turn_id = turn_id.to_owned();
        let task = task.to_owned();
        let persisted_error = api_error.clone();
        let auto_route = (phase == "succeeded")
            .then(|| provider::remembered_route(&state.stored.record, &turn.route))
            .flatten();
        let _records = host.records.lock().await;
        let updated = tokio::task::spawn_blocking(move || {
            store::update_record(&root, &session_id, |record| {
                let mut state = record
                    .get("taskState")
                    .filter(|state| matches!(state, V::Object(_)))
                    .cloned()
                    .unwrap_or_else(|| V::Object(Vec::new()));
                quota_guard::set(&mut state, "taskId", V::from(task));
                quota_guard::set(&mut state, "userInputSignalTurnId", V::from(turn_id));
                quota_guard::set(&mut state, "apiError", persisted_error);
                if phase == "released" {
                    quota_guard::set(&mut state, "cancelledAt", V::Number(auth_runtime::now_ms()));
                    quota_guard::set(&mut state, "cancelReason", V::from("user_cancelled"));
                } else {
                    quota_guard::set(&mut state, "cancelledAt", V::Null);
                    quota_guard::set(&mut state, "cancelReason", V::Null);
                }
                quota_guard::set(record, "taskState", state);
                if let Some(auto_route) = auto_route {
                    quota_guard::set(record, "autoProviderLastRoute", auto_route);
                }
            })
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result);
        match updated {
            Ok(record) => {
                state.stored.record = record;
                if let Some(frame) = frames::task_state(&state.stored) {
                    host.publish(id, turn.attribute(frame), false);
                }
            }
            Err(error) => host.publish(
                id,
                error_frame("chat_task_state_not_durable", &error),
                false,
            ),
        }
    }
    let mut route_event = turn.route.event(id, phase, fence);
    quota_guard::set(
        &mut route_event,
        "errorCategory",
        api_error.get("category").cloned().unwrap_or(V::Null),
    );
    quota_guard::set(&mut route_event, "reasonCode", V::from("finalize"));
    host.publish(id, turn.attribute(route_event), false);
    if turn.task.is_some() && phase != "failed" {
        let goal = state
            .stored
            .record
            .get("taskState")
            .and_then(|task| optional_text(task, "goal"));
        host.publish(
            id,
            turn.attribute(frames::notify(
                if awaiting.is_some() && phase == "succeeded" {
                    "waiting"
                } else {
                    phase
                },
                goal.as_deref().unwrap_or(""),
            )),
            false,
        );
    }
    host.hub.clear_replay(id);
    host.publish(
        id,
        turn.attribute(value(json!({"type":"stream_end"}))),
        false,
    );
    (phase, awaiting)
}

async fn save_assistant(
    host: &Host,
    id: &str,
    state: &mut Session,
    turn: &mut Active,
    content: String,
    result: Option<(&V, &V)>,
) -> Result<(), String> {
    if content.is_empty() && turn.tools.is_empty() && (result.is_none() || turn.delivery.is_none())
    {
        return Ok(());
    }
    let mut row = value(json!({"role":"assistant","content":content}));
    if !turn.tools.is_empty() {
        quota_guard::set(
            &mut row,
            "tools",
            value(json!(std::mem::take(&mut turn.tools))),
        );
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
        quota_guard::set(&mut row, "modelAttribution", turn.route.model_attribution());
    } else {
        quota_guard::set(&mut row, "partial", V::Bool(true));
        quota_guard::set(&mut row, "cancelled", V::Bool(true));
    }
    quota_guard::set(&mut row, "ts", V::Number(auth_runtime::now_ms()));
    quota_guard::set(&mut row, "turnId", V::from(turn.id.as_str()));
    for (field, value) in [("taskId", &turn.task), ("deliveryId", &turn.delivery)] {
        if let Some(value) = value {
            quota_guard::set(&mut row, field, V::from(value.as_str()));
        }
    }
    quota_guard::set(
        &mut row,
        "id",
        V::from(new_id("m").map_err(|(_, error)| error)?),
    );
    save_row(&mut state.stored, row.clone()).await?;
    host.publish(id, metadata(&row), false);
    Ok(())
}
