use crate::{js_bridge, js_live::LiveValue};
use multicc_core::chat_runtime::{self, CancelTurnIdentity, TaskRestore};
use multicc_core::chat_ws_control::{self, Action, Command};
use multicc_core::js::JsValue;
use multicc_core::session_records::{self, SessionDirectory};
use multicc_core::task_shell::chat as shell_chat;
use napi::bindgen_prelude::Function;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn chat_ws_control_action(message_type: String, share_permission: String) -> &'static str {
    match chat_ws_control::action(&message_type, &share_permission) {
        Action::Pong => "pong",
        Action::Ignore => "ignore",
        Action::Continue => "continue",
    }
}

#[napi]
pub fn chat_ws_command(
    message_type: String,
    share_permission: String,
    needs_task_shell: bool,
    has_shell_query: bool,
    task_shell: bool,
    has_text: bool,
) -> &'static str {
    match chat_ws_control::command(
        &message_type,
        &share_permission,
        needs_task_shell,
        has_shell_query,
        task_shell,
        has_text,
    ) {
        Command::Ignore => "ignore",
        Command::Typing => "typing",
        Command::Cancel => "cancel",
        Command::ClearHistory => "clearHistory",
        Command::Message => "message",
        Command::ClearShellHistory => "clearShellHistory",
        Command::RouteShellInput => "routeShellInput",
        Command::RequireShellRoute => "requireShellRoute",
    }
}

#[napi]
pub fn chat_ws_is_legacy_cancel(text: String) -> bool {
    chat_ws_control::is_legacy_cancel(&text)
}

#[napi]
pub fn chat_task_shell_input(
    env: Env,
    shell_id: String,
    input: Unknown<'_>,
    control_task: Function<(), Option<String>>,
) -> Result<sys::napi_value> {
    let live = LiveValue::new(&env, input);
    let input = unsafe { js_bridge::read_value(env.raw(), live.raw(), 0, &mut Vec::new())? };
    let task = if shell_chat::intent(&input) == shell_chat::Intent::Work {
        None
    } else {
        control_task.call(())?
    };
    let result = match shell_chat::normalize(&input, task.as_deref()) {
        Ok(payload) => {
            let (id, fingerprint) = shell_chat::receipt_identity(&shell_id, &payload);
            JsValue::object(vec![
                ("ok", JsValue::Bool(true)),
                ("payload", payload),
                ("id", JsValue::from(id)),
                ("fingerprint", JsValue::from(fingerprint)),
            ])
        }
        Err(error) => JsValue::object(vec![
            ("ok", JsValue::Bool(false)),
            ("code", JsValue::from(error.code)),
            ("message", JsValue::from(error.message)),
        ]),
    };
    Ok(live.from_value(&result)?.raw())
}

#[napi]
pub fn chat_cancel_turn_identity(
    has_live_turn: bool,
    has_live_turn_id: bool,
    has_schedule_entry: bool,
    has_persisted_active_id: bool,
    classify_state: String,
) -> &'static str {
    match chat_runtime::cancel_turn_identity(
        has_live_turn,
        has_live_turn_id,
        has_schedule_entry,
        has_persisted_active_id,
        &classify_state,
    ) {
        CancelTurnIdentity::Live => "live",
        CancelTurnIdentity::PersistedActive => "persistedActive",
        CancelTurnIdentity::Recovery => "recovery",
        CancelTurnIdentity::Idle => "idle",
    }
}

#[napi]
pub fn chat_session_directory(
    present: bool,
    session_type: String,
    workspace_state: String,
    login_cwd_exists: Function<(), bool>,
    worktree_exists: Function<(), bool>,
) -> Result<&'static str> {
    let selected = session_records::session_directory(
        present,
        &session_type,
        &workspace_state,
        || login_cwd_exists.call(()),
        || worktree_exists.call(()),
    )?;
    Ok(match selected {
        SessionDirectory::Home => "home",
        SessionDirectory::Aux => "aux",
        SessionDirectory::Gateway => "gateway",
        SessionDirectory::Login => "login",
        SessionDirectory::Worktree => "worktree",
        SessionDirectory::Unavailable => "unavailable",
    })
}

#[napi]
pub fn chat_unavailable_workspace_stem(env: Env, id: Unknown<'_>) -> Result<String> {
    let id = LiveValue::new(&env, id).coerce_string()?;
    Ok(session_records::unavailable_workspace_stem(&id))
}

#[napi]
pub fn chat_ws_open_error(
    env: Env,
    session: String,
    present: bool,
    internal: bool,
    kind: Unknown<'_>,
    invalid_reason: Unknown<'_>,
) -> Result<sys::napi_value> {
    let kind = LiveValue::new(&env, kind);
    let reason = LiveValue::new(&env, invalid_reason).string()?;
    let value = unsafe { js_bridge::read_value(env.raw(), kind.raw(), 0, &mut Vec::new())? };
    let error =
        chat_ws_control::open_session_error(&session, present, internal, &value, reason.as_ref());
    Ok(kind.from_value(&error.unwrap_or(JsValue::Null))?.raw())
}

#[napi]
pub fn chat_restore_task(env: Env, candidate: Unknown<'_>) -> Result<sys::napi_value> {
    let record = LiveValue::new(&env, candidate);
    if !record.nullish()? {
        let detached = record.get(c"taskDetached")?.is_true()?;
        let task = if detached {
            record.from_value(&JsValue::Null)?
        } else {
            record.get(c"taskId")?
        };
        if matches!(
            chat_runtime::restore_task_step(detached, task.truthy()?),
            TaskRestore::Found
        ) {
            return Ok(task.raw());
        }
    }
    Ok(record.from_value(&JsValue::Null)?.raw())
}

#[napi]
pub fn chat_seed_live_session(
    env: Env,
    assistant_turns: u32,
    cli: Unknown<'_>,
    cwd: Unknown<'_>,
    task: Unknown<'_>,
) -> Result<sys::napi_value> {
    let cli = LiveValue::new(&env, cli);
    let state = cli.from_value(&chat_runtime::live_session_defaults(
        assistant_turns as usize,
    ))?;
    if cli.truthy()? {
        state.set(c"cli", cli)?;
    }
    state.set(c"cwd", LiveValue::new(&env, cwd))?;
    state.set(c"_currentTaskId", LiveValue::new(&env, task))?;
    Ok(state.raw())
}
