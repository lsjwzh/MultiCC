use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use multicc_core::{
    chat_history_file::{self, encode_rows},
    durable_state,
    js::{self, JsString, JsValue as V},
    quota_guard, random_id,
    session_records::{self, SessionDirectory},
    state_file,
};

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

pub fn restore(root: &Path, home: &Path, package: &Path, session: &str) -> Result<Stored, String> {
    // The legacy on-disk codec replaces every character outside this set.
    // Reject ambiguous ids before resolving the shared history pathname.
    if matches!(session, "." | "..")
        || chat_history_file::safe_stem(session.encode_utf16()) != session
    {
        return Err("invalid chat session id".into());
    }
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
    let mut messages = chat_history_file::read_transcript(&history_path)
        .map_err(|error| format!("cannot read chat history: {error}"))?;
    messages.retain(|message| matches!(message, V::Object(_)));
    for message in &mut messages {
        if role(message).is_some() && !js::truthy_opt(message.get("id")) {
            quota_guard::set(
                message,
                "id",
                V::from(random_id::prefixed_id("m").map_err(|error| error.to_string())?),
            );
        }
    }
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

fn resolve_cwd(
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
        SessionDirectory::Unavailable => root.join("unavailable-workspaces").join(session),
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
