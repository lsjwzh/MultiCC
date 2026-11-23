use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use super::HISTORY_PAGE;
use multicc_core::{
    chat_history_file::{self, encode_rows},
    durable_state,
    js::{self, JsString, JsValue as V},
    quota_guard, random_id,
    session_records::{self, SessionDirectory},
    state_file,
    task_shell::chat::Rejection,
    task_store::TaskStore,
};
use sha2::{Digest, Sha256};

pub struct Stored {
    pub record: V,
    pub cwd: PathBuf,
    pub native_id: String,
    pub history_path: PathBuf,
    pub messages: Vec<V>,
    pub hidden: HashSet<JsString>,
    pub token_usage: V,
}

pub fn records(root: &Path) -> Result<Vec<V>, String> {
    match durable_state::load_or_recover(&root.join("sessions.json"))? {
        Some(V::Array(records)) => Ok(records),
        None => Ok(Vec::new()),
        _ => Err("sessions.json payload is not an array".into()),
    }
}

pub fn lookup<'a>(records: &'a [V], session: &str) -> Option<&'a V> {
    records
        .iter()
        .rfind(|row| matches!(row.get("id"), Some(V::String(id)) if id == session))
}

pub fn update_record(root: &Path, session: &str, apply: impl FnOnce(&mut V)) -> Result<V, String> {
    let mut all = records(root)?;
    let record = all
        .iter_mut()
        .rfind(|row| matches!(row.get("id"), Some(V::String(id)) if id == session))
        .ok_or("chat session disappeared before update")?;
    apply(record);
    let record = record.clone();
    durable_state::save(&root.join("sessions.json"), "sessions", &V::Array(all))?;
    Ok(record)
}

fn transcript_stem(session: &str) -> Result<(), String> {
    if chat_history_file::safe_stem(session.encode_utf16()) != session {
        return Err("invalid chat session id".into());
    }
    Ok(())
}

fn read_messages(path: &Path, session: &str) -> Result<Vec<V>, String> {
    let mut messages = chat_history_file::read_transcript(path)
        .map_err(|error| format!("cannot read chat history: {error}"))?;
    messages.retain(|message| matches!(message, V::Object(_)));
    for (index, message) in messages.iter_mut().enumerate() {
        if js::truthy_opt(message.get("role")) && !js::truthy_opt(message.get("id")) {
            // Legacy rows need a stable ID even on a read-only reconnect.
            let mut hash = Sha256::new();
            hash.update(session.as_bytes());
            hash.update((index as u64).to_be_bytes());
            hash.update(js::json_stringify_or_undefined(message).as_bytes());
            quota_guard::set(
                message,
                "id",
                V::from(format!("m_legacy_{:x}", hash.finalize())),
            );
        }
    }
    Ok(messages)
}

pub(super) fn last_task_message(
    root: &Path,
    id: &str,
    board: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    transcript_stem(id)?;
    let path = chat_history_file::transcript_path(&root.join("chat_history"), id);
    let mut last = serde_json::Value::Null;
    chat_history_file::visit_transcript(&path, |row| {
        let task = text(&row, "taskId");
        if !task.is_empty()
            && !js::truthy_opt(row.get("inherited"))
            && !board["deletedTaskIds"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|id| id == &task))
        {
            last = serde_json::json!({"taskId":task,
            "taskName":row.get("taskName").map(js::to_serde),
            "content":row.get("content").and_then(|content| match content {
                V::String(text) => Some(text.truncate_units(120).to_string_lossy()), _ => None,
            })});
        }
    })
    .map_err(|error| format!("cannot read chat history: {error}"))?;
    Ok(last)
}

pub(super) fn session_messages(root: &Path, id: &str) -> Result<Vec<V>, String> {
    transcript_stem(id)?;
    read_messages(
        &chat_history_file::transcript_path(&root.join("chat_history"), id),
        id,
    )
}

pub fn shell_history(
    root: &Path,
    all: &[V],
    shell_id: &str,
    session: &str,
    archive: bool,
) -> Result<Vec<V>, String> {
    TaskStore::with_chat_scope(
        &root.join("task-shells.sqlite"),
        shell_id,
        session,
        |id, directory| session_in_directory(all, id, directory),
        |store, session_ids| {
            let history_root = root.join("chat_history");
            let mut messages = Vec::new();
            for id in session_ids {
                transcript_stem(&id)?;
                let hidden = if archive {
                    HashSet::new()
                } else {
                    chat_history_file::read_hidden_ids(&chat_history_file::visibility_path(
                        &history_root,
                        &id,
                    ))
                    .map_err(|error| format!("cannot read chat visibility: {error}"))?
                };
                let transcript =
                    read_messages(&chat_history_file::transcript_path(&history_root, &id), &id)?;
                for mut row in transcript {
                    if matches!(row.get("id"), Some(V::String(id)) if hidden.contains(id)) {
                        continue;
                    }
                    let source_id = row
                        .get("id")
                        .filter(|value| js::truthy(value))
                        .cloned()
                        .unwrap_or_else(|| V::from("live-turn"));
                    let mut combined_id = JsString::from_rust_str(&format!("{id}:"));
                    combined_id.push(&js::js_to_string(&source_id));
                    quota_guard::set(&mut row, "id", V::String(combined_id));
                    quota_guard::set(&mut row, "sourceSessionId", V::from(id.clone()));
                    quota_guard::set(&mut row, "sourceMessageId", source_id);
                    let streaming = id == session && row.get("streaming") == Some(&V::Bool(true));
                    quota_guard::set(&mut row, "streaming", V::Bool(streaming));
                    messages.push(row);
                }
                messages.sort_by(shell_message_order);
                // One extra row lets the wire page report that older messages
                // exist without retaining all linked transcripts in memory.
                let overflow = messages.len().saturating_sub(HISTORY_PAGE + 1);
                messages.drain(..overflow);
            }
            for row in &mut messages {
                apply_shell_attribution(store, row)?;
            }
            Ok(messages)
        },
    )
}

pub(super) fn session_in_directory(
    all: &[V],
    id: &str,
    directory: Option<&serde_json::Value>,
) -> bool {
    lookup(all, id).is_some_and(|record| {
        record.get("taskExecutionSlot") != Some(&V::Bool(true))
            && record.get("dirId").map(js::to_serde).as_ref() == directory
    })
}

pub fn replay_shell_input(
    root: &Path,
    shell: Option<&str>,
    session: &str,
    shared: bool,
    message: &V,
) -> Result<Option<V>, Rejection> {
    let all = records(root).map_err(|error| Rejection::state("task_shell_failed", error))?;
    TaskStore::replay_chat_input(
        &root.join("task-shells.sqlite"),
        shell,
        session,
        shared,
        |id, directory| session_in_directory(&all, id, directory),
        message,
    )
}

fn shell_message_order(left: &V, right: &V) -> std::cmp::Ordering {
    let time = |row: &V| {
        let number = js::js_to_number(row.get("ts").unwrap_or(&V::Undefined));
        if number.is_nan() {
            0.0
        } else {
            number
        }
    };
    let streaming = |row: &V| row.get("streaming") == Some(&V::Bool(true));
    time(left)
        .partial_cmp(&time(right))
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| streaming(left).cmp(&streaming(right)))
}

fn apply_shell_attribution(store: &TaskStore, row: &mut V) -> Result<(), String> {
    let (Some(session), Some(turn)) = (
        optional_text(row, "sourceSessionId"),
        optional_text(row, "turnId"),
    ) else {
        return Ok(());
    };
    let attribution = store.chat_turn_attribution(&session, &turn)?;
    if let Some(task_id) = attribution["taskId"].as_str() {
        quota_guard::set(row, "taskId", V::from(task_id));
        if !attribution["taskName"].is_null() {
            quota_guard::set(row, "taskName", js::from_serde(&attribution["taskName"]));
        }
        let operation = attribution
            .get("operationId")
            .filter(|value| js::serde::truthy(value))
            .map_or(V::Null, js::from_serde);
        quota_guard::set(row, "attributionOperationId", operation);
        quota_guard::set(row, "attributionOverridden", V::Bool(true));
    }
    Ok(())
}

pub fn restore(root: &Path, home: &Path, package: &Path, session: &str) -> Result<Stored, String> {
    // The legacy on-disk codec replaces every character outside this set.
    // Reject ambiguous ids before resolving the shared history pathname.
    transcript_stem(session)?;
    let mut all = records(root)?;
    let index = all
        .iter()
        .rposition(|row| matches!(row.get("id"), Some(V::String(id)) if id == session))
        .ok_or("chat session disappeared before restoration")?;
    let record = &mut all[index];
    if record.get("taskExecutionSlot") == Some(&V::Bool(true)) {
        return Err("chat session disappeared before restoration".into());
    }
    let cwd = resolve_cwd(record, root, home, package, session)?;
    let history_root = root.join("chat_history");
    let history_path = chat_history_file::transcript_path(&history_root, session);
    let messages = read_messages(&history_path, session)?;
    let hidden = chat_history_file::read_hidden_ids(&chat_history_file::visibility_path(
        &history_root,
        session,
    ))
    .map_err(|error| format!("cannot read chat visibility: {error}"))?;
    let token_usage = std::fs::read_to_string(root.join("token_usage.json"))
        .ok()
        .and_then(|text| js::json_parse(&text).ok())
        .and_then(|value| value.get(session).cloned())
        .unwrap_or(V::Null);
    let old_id =
        optional_text(record, "cliSessionId").or_else(|| optional_text(record, "_streamSessionId"));
    let (record, native_id) = match old_id {
        Some(id) => (record.clone(), id),
        None if is_claude(record) => {
            let id = random_id::random_uuid_v4().map_err(|error| error.to_string())?;
            quota_guard::set(record, "cliSessionId", V::from(id.clone()));
            let record = record.clone();
            durable_state::save(&root.join("sessions.json"), "sessions", &V::Array(all))?;
            (record, id)
        }
        None => (record.clone(), String::new()),
    };
    Ok(Stored {
        record,
        cwd,
        native_id,
        history_path,
        messages,
        hidden,
        token_usage,
    })
}

pub(super) fn resolve_cwd(
    record: &V,
    root: &Path,
    home: &Path,
    package: &Path,
    session: &str,
) -> Result<PathBuf, String> {
    let path = optional_text(record, "cwd").map(PathBuf::from);
    let tree = optional_text(record, "worktreePath").map(PathBuf::from);
    let directory = session_records::session_directory(
        true,
        &text(record, "type"),
        &text(record, "workspaceState"),
        || {
            Ok::<_, String>(
                js::truthy_opt(record.get("loginFlow"))
                    && path.as_ref().is_some_and(|path| path.is_dir()),
            )
        },
        || Ok(tree.as_ref().is_some_and(|path| path.is_dir())),
    )?;
    Ok(match directory {
        SessionDirectory::Aux => path.unwrap_or_else(|| package.to_owned()),
        SessionDirectory::Gateway => {
            let path = path.unwrap_or_else(|| home.join(".multicc/gateway"));
            std::fs::create_dir_all(&path)
                .map_err(|error| format!("cannot create chat workspace: {error}"))?;
            path
        }
        SessionDirectory::Worktree => tree.expect("existing worktree"),
        SessionDirectory::Login => path.expect("existing login workspace"),
        SessionDirectory::Home => home.to_owned(),
        SessionDirectory::Unavailable => {
            root.join("unavailable-workspaces")
                .join(session_records::unavailable_workspace_stem(
                    &JsString::from(session),
                ))
        }
    })
}

pub fn write_history(path: &Path, messages: &[V]) -> Result<(), state_file::WriteFailure> {
    let (bytes, _) = encode_rows(messages);
    state_file::write_bytes_atomic_traced(path, &bytes, state_file::FILE_MODE, state_file::DIR_MODE)
}

pub fn optional_text(value: &V, field: &str) -> Option<String> {
    match value.get(field) {
        Some(V::String(text)) if !text.is_empty() => Some(text.to_string_lossy()),
        _ => None,
    }
}

pub fn text(value: &V, field: &str) -> String {
    optional_text(value, field).unwrap_or_default()
}

pub fn role(message: &V) -> Option<&JsString> {
    match message.get("role") {
        Some(V::String(role)) => Some(role),
        _ => None,
    }
}

pub fn cli(record: &V) -> String {
    optional_text(record, "cli").unwrap_or_else(|| "claude".into())
}

pub fn is_claude(record: &V) -> bool {
    multicc_core::cli_capability::name_of(&cli(record)) == "claude"
}

pub fn is_codex_app(record: &V) -> bool {
    record.get("cli") == Some(&V::from("codex-exp"))
}

pub fn is_codex(record: &V) -> bool {
    is_codex_app(record) || record.get("cli") == Some(&V::from("codex"))
}
