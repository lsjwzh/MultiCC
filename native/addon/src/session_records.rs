//! The single owner of the live session-record table (`persistedSessions`), its
//! `sessions.json` writer and the dirty/retry/rollback lifecycle, plus the
//! task-state store that writes through those records.
//!
//! Records stay live JavaScript objects so existing field writers keep their
//! identity and property order; the native owner holds them as opaque host
//! references and owns which ids exist, their order, and every durable effect.
//! No second table exists in Node: the JS facade forwards each Map-shaped call
//! here. Disk payloads are serialized by the host engine (so key order and
//! number formatting are byte-identical) while the envelope, rolling backups and
//! fsyncs are native.
use crate::{
    js_host_value::{Value, Values},
    js_live::LiveValue as L,
};
use multicc_core::{
    chat_runtime::{
        self, Outcome as TurnOutcome, PendingOutcome, Phase, Record as TurnRecord, RouteProofFacts,
        StartError,
    },
    cli_capability::transport_of,
    durable_state,
    js::{self, JsString, JsValue as V},
    session_records::{
        iso_timestamp_now, keep_history_entry, should_stamp_classify_updated_at,
        task_state_defaults, RetryState,
    },
    state_tx,
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    ffi::CStr,
    fs,
    path::PathBuf,
};

fn object(anchor: L<'_>) -> Result<L<'_>> {
    anchor.from_value(&V::Object(vec![]))
}
/// `obj?.name`, with `undefined`/`null` treated as "no such property".
fn prop<'a>(obj: L<'a>, name: &CStr) -> Result<L<'a>> {
    if obj.nullish()? {
        return obj.from_value(&V::Undefined);
    }
    obj.get(name)
}
/// `Object.prototype.hasOwnProperty.call(obj, name)`.
fn has_own(obj: L<'_>, name: &CStr) -> Result<bool> {
    // Own-property check without `Object.prototype.hasOwnProperty.call`:
    // `Reflect.getOwnPropertyDescriptor` needs no `this` binding and also
    // covers non-enumerable own keys and index keys on primitives.
    let reflect = obj.global()?.get(c"Reflect")?;
    let key = obj.from_value(&V::string(name.to_str().expect("static property")))?;
    let descriptor = reflect
        .get(c"getOwnPropertyDescriptor")?
        .call(reflect, &[obj, key])?;
    Ok(!descriptor.undefined()?)
}
fn error_message(error: L<'_>) -> Result<String> {
    let message = if error.truthy()? {
        error.get(c"message")?
    } else {
        error.from_value(&V::Undefined)?
    };
    Ok(if message.truthy()? {
        message.coerce_string()?.to_string_lossy()
    } else {
        error.coerce_string()?.to_string_lossy()
    })
}

/// `Object.isFrozen(value)` — true for primitives as well.
fn is_frozen(value: L<'_>) -> Result<bool> {
    let object = value.global()?.get(c"Object")?;
    object.get(c"isFrozen")?.call_plain(&[value])?.truthy()
}

/// `String(value || fallback)`.
fn truthy_string(value: L<'_>, fallback: &str) -> Result<JsString> {
    if value.truthy()? {
        value.coerce_string()
    } else {
        Ok(JsString::from_rust_str(fallback))
    }
}

/// `value == null ? null : String(value)`.
fn nullable_string(value: L<'_>) -> Result<Option<JsString>> {
    if value.nullish()? {
        Ok(None)
    } else {
        Ok(Some(value.coerce_string()?))
    }
}

/// Load-time identity normalisation for the retired `claude -p` chat lane. That
/// lane wrote the live transcript id to `_streamSessionId` and left a
/// placeholder in `cliSessionId`; the Agent SDK lane resumes by `cliSessionId`,
/// and both name the same `~/.claude/projects/<cwd>/<id>.jsonl`, so the
/// streamed id wins whenever it is present. Records of other CLIs are left
/// untouched.
fn normalize_claude_native_id(record: L<'_>) -> Result<bool> {
    let streamed = record.get(c"_streamSessionId")?;
    if !streamed.truthy()? {
        return Ok(false);
    }
    let cli = record.get(c"cli")?.string()?;
    if cli.as_ref().map(|value| value.to_string_lossy()).as_deref() != Some("claude") {
        return Ok(false);
    }
    record.set(c"cliSessionId", streamed)?;
    record.delete(c"_streamSessionId")?;
    Ok(true)
}

#[derive(Clone)]
struct Table {
    order: Vec<JsString>,
    map: HashMap<JsString, Value>,
}
impl Table {
    fn new() -> Self {
        Self {
            order: Vec::new(),
            map: HashMap::new(),
        }
    }
    fn len(&self) -> usize {
        self.order.len()
    }
    fn get(&self, id: &JsString) -> Option<Value> {
        self.map.get(id).cloned()
    }
    /// `Map#set`: a new id appends, an existing id keeps its position.
    fn set(&mut self, id: JsString, value: Value) {
        if self.map.insert(id.clone(), value).is_none() {
            self.order.push(id);
        }
    }
    fn delete(&mut self, id: &JsString) -> bool {
        if self.map.remove(id).is_some() {
            self.order.retain(|key| key != id);
            true
        } else {
            false
        }
    }
    fn clear(&mut self) {
        self.order.clear();
        self.map.clear();
    }
}

/// One preparation lease. `proof` is the frozen provider-route object the
/// failed/succeeded transition stored; it stays a host value so snapshots return
/// the same object identity the caller handed over.
#[derive(Clone)]
struct RuntimeEntry {
    record: TurnRecord,
    proof: Option<Value>,
}

/// Ordered native table for the per-session turn runtime state. The runtime
/// store is independent of `chatSessions` membership: a turn can be claimed
/// before a chat-session object exists, and deleting a chat session does not
/// erase the last preparation outcome.
#[derive(Default)]
struct RuntimeTable {
    order: Vec<JsString>,
    map: HashMap<JsString, RuntimeEntry>,
}
impl RuntimeTable {
    fn new() -> Self {
        Self::default()
    }
    fn get(&self, id: &JsString) -> Option<&RuntimeEntry> {
        self.map.get(id)
    }
    fn set(&mut self, id: JsString, entry: RuntimeEntry) {
        if self.map.insert(id.clone(), entry).is_none() {
            self.order.push(id);
        }
    }
}

/// Host ports. An absent port is "not configured", never silently replaced.
#[derive(Clone, Default)]
struct Ports {
    store_save: Option<Value>,
    stringify: Option<Value>,
    on_failure: Option<Value>,
    on_state: Option<Value>,
    set_timeout: Option<Value>,
    clear_timeout: Option<Value>,
    retry_tick: Option<Value>,
    bus_emit: Option<Value>,
    chat_broadcast: Option<Value>,
    workspace_broadcast: Option<Value>,
    task_state_payload: Option<Value>,
    now: Option<Value>,
}

struct Failure {
    at: String,
    source: String,
    mode: String,
    attempt: u32,
    message: String,
}

struct Snapshot {
    ids: Vec<JsString>,
    json: Vec<Option<JsString>>,
}

#[derive(Default)]
struct Persistence {
    retry: RetryState,
    last_failure: Option<Failure>,
    timer: Option<Value>,
    tx: Option<u64>,
    snapshot: Option<Snapshot>,
    snapshot_dirty: bool,
    retry_source: Option<String>,
}

/// A save failure carries either the host exception (so `cause` keeps its
/// identity) or a native message (missing writer, I/O error).
enum SaveFailure {
    Host(sys::napi_value),
    Message(String),
}
impl SaveFailure {
    fn into_live<'a>(self, env: &'a Env, anchor: L<'a>) -> Result<L<'a>> {
        match self {
            SaveFailure::Host(raw) => Ok(L::from_raw(env.raw(), raw)),
            SaveFailure::Message(message) => anchor.from_value(&V::string(&message)),
        }
    }
}

#[derive(Default)]
struct StatePaths {
    directories: Option<PathBuf>,
    sessions: Option<PathBuf>,
    journal: Option<PathBuf>,
}

#[napi]
pub struct RustSessionRecords {
    table: RefCell<Table>,
    dirs: RefCell<Table>,
    /// Live chat-session objects (`chatSessions`). They stay host references so
    /// the streaming/CLI/timer owners keep identity and property order.
    chat: RefCell<Table>,
    /// Per-session preparation lease (the frozen `runtime-store.js` state).
    runtime: RefCell<RuntimeTable>,
    /// Host clock for turn transitions; the facade supplies `Date.now` or a
    /// deterministic test clock.
    turn_now: RefCell<Option<Value>>,
    values: Values,
    persistence: RefCell<Persistence>,
    ports: RefCell<Ports>,
    paths: RefCell<StatePaths>,
    file: RefCell<Option<PathBuf>>,
    root: RefCell<Option<PathBuf>>,
    kind: RefCell<String>,
    max_retries: Cell<u32>,
    retry_delay_ms: Cell<f64>,
    next_tx: Cell<u64>,
}

impl RustSessionRecords {
    fn key(&self, value: L<'_>) -> Result<JsString> {
        match value.string()? {
            Some(id) => Ok(id),
            None => value.coerce_string(),
        }
    }
    fn read<'a>(&self, env: &'a Env, anchor: L<'a>, value: &Value) -> Result<L<'a>> {
        self.values.read(env, anchor, value)
    }
    fn port(&self, pick: impl Fn(&Ports) -> Option<Value>) -> Option<Value> {
        pick(&self.ports.borrow())
    }
    fn capture_fn(&self, env: &Env, value: L<'_>) -> Result<Option<Value>> {
        if value.kind()? == sys::ValueType::napi_function {
            Ok(Some(self.values.capture(env, value)?))
        } else {
            Ok(None)
        }
    }
    /// The pending-exception value, if one exists, cleared so the host can keep
    /// running (rollback) and rethrow it later with its identity.
    fn exception(anchor: L<'_>) -> Result<Option<sys::napi_value>> {
        Ok(anchor.exception_value()?.map(|value| value.raw()))
    }
    fn stringify(&self, env: &Env, anchor: L<'_>, value: L<'_>) -> Result<Option<JsString>> {
        let port = self.port(|ports| ports.stringify.clone()).ok_or_else(|| {
            napi::Error::from_reason("session records stringify port is required")
        })?;
        let output = self.read(env, anchor, &port)?.call_plain(&[value])?;
        output.string()
    }
    fn records_array<'a>(&self, env: &'a Env, anchor: L<'a>) -> Result<L<'a>> {
        let array = anchor.from_value(&V::Array(vec![]))?;
        let ids = self.table.borrow().order.clone();
        for (index, id) in ids.iter().enumerate() {
            let value = self.table.borrow().get(id).expect("ordered id");
            let record = self.values.read(env, anchor, &value)?;
            array.set_element(index as u32, record)?;
        }
        Ok(array)
    }
    /// Same array shape as `records_array`, for a table that is not the session
    /// table (the directory registry).
    fn table_array<'a>(&self, env: &'a Env, anchor: L<'a>, table: &Table) -> Result<L<'a>> {
        let array = anchor.from_value(&V::Array(vec![]))?;
        let ids = table.order.clone();
        for (index, id) in ids.iter().enumerate() {
            let value = table.get(id).expect("ordered id");
            let record = self.values.read(env, anchor, &value)?;
            array.set_element(index as u32, record)?;
        }
        Ok(array)
    }
    /// Host-engine `JSON.stringify` of one table payload (byte-exact key order,
    /// number formatting and lone surrogates).
    fn table_compact(
        &self,
        env: &Env,
        anchor: L<'_>,
        table: &Table,
    ) -> std::result::Result<String, String> {
        let array = self
            .table_array(env, anchor, table)
            .map_err(|error| error.reason.clone())?;
        let port = self
            .port(|ports| ports.stringify.clone())
            .ok_or_else(|| "session records stringify port is required".to_string())?;
        let callback = self
            .read(env, anchor, &port)
            .map_err(|error| error.reason.clone())?;
        let output = callback
            .call_plain(&[array])
            .map_err(|error| error.reason.clone())?;
        match output.string().map_err(|error| error.reason.clone())? {
            Some(text) => Ok(text.to_string_lossy()),
            None => Ok("null".to_string()),
        }
    }
    /// Resolve a configured path, relative paths against the process cwd (the
    /// same base Node's `fs` calls used).
    fn resolve(path: PathBuf) -> PathBuf {
        if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(&path))
                .unwrap_or(path)
        }
    }
    fn marker_path(&self, variable: &str) -> Option<PathBuf> {
        if std::env::var("NODE_ENV").ok().as_deref() != Some("test") {
            return None;
        }
        let marker = std::env::var(variable).ok()?;
        if marker.is_empty() {
            return None;
        }
        let root = Self::resolve(self.root.borrow().clone()?);
        let marker = Self::resolve(PathBuf::from(marker));
        let inside = marker == root || marker.starts_with(&root);
        (inside && marker.exists()).then_some(marker)
    }
    /// Test-only injected "process died here" points in the transaction and
    /// replay sequences. A marker file must exist inside the isolated root and
    /// `NODE_ENV` must be `test`; production never reads these variables.
    fn crash_at(&self, selector: &str, step: &str) -> bool {
        if self
            .marker_path("MULTICC_TEST_STATE_TX_CRASH_FILE")
            .is_none()
        {
            return false;
        }
        std::env::var(selector).ok().as_deref() == Some(step)
    }
    fn crash(&self, step: &str) -> Result<()> {
        if self.crash_at("MULTICC_TEST_STATE_TX_CRASH_AT", step) {
            return Err(napi::Error::from_reason(format!(
                "STATE_TX_CRASH: injected crash at {step}"
            )));
        }
        Ok(())
    }
    fn replay_crash_after(&self, files_applied: usize) -> bool {
        if self
            .marker_path("MULTICC_TEST_STATE_REPLAY_CRASH_FILE")
            .is_none()
        {
            return false;
        }
        std::env::var("MULTICC_TEST_STATE_REPLAY_CRASH_AFTER")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            == Some(files_applied)
    }
    fn table_from_pairs(&self, env: &Env, entries: L<'_>) -> Result<Table> {
        let mut table = Table::new();
        entries.for_each(|pair| {
            let key = self.key(pair.element(0)?)?;
            let record = pair.element(1)?;
            table.set(key, self.values.capture(env, record)?);
            Ok(())
        })?;
        Ok(table)
    }
    /// Load directories.json (primary, then `.bak1..3`) and install it into the
    /// native table. Corruption is reported as data (`errorKind`) so the JS
    /// adapter can construct the same `CorruptedStateError` the StateStore threw.
    fn load_directories_internal<'a>(&self, env: &'a Env, anchor: L<'a>) -> Result<L<'a>> {
        let file =
            self.paths.borrow().directories.clone().ok_or_else(|| {
                napi::Error::from_reason("state owner directoriesFile is required")
            })?;
        let out = object(anchor)?;
        match durable_state::load_or_recover_report(&file) {
            Ok(loaded) => {
                let mut table = self.dirs.borrow_mut();
                table.clear();
                let mut size = 0u32;
                if let Some(value) = &loaded.value {
                    let V::Array(items) = value else {
                        return Err(napi::Error::from_reason(
                            "STATE_CORRUPTED: directories payload is not an array",
                        ));
                    };
                    for item in items {
                        let key_value = item.get("id").unwrap_or(&V::Undefined);
                        let key = multicc_core::js::js_to_string(key_value);
                        // Install a live JavaScript record, not a Rust-side
                        // snapshot: callers mutate fields in place and compare
                        // object identity, exactly as they did with the Map.
                        let live = anchor.from_value(item)?;
                        let captured = self.values.capture(env, live)?;
                        table.set(key, captured);
                        size += 1;
                    }
                }
                out.set(
                    c"present",
                    anchor.from_value(&V::Bool(loaded.value.is_some()))?,
                )?;
                out.set(
                    c"recovered",
                    anchor.from_value(&V::Bool(loaded.recovered_from.is_some()))?,
                )?;
                out.set(
                    c"recoveredFrom",
                    match &loaded.recovered_from {
                        Some(path) => anchor.from_value(&V::String(JsString::from_rust_str(
                            &path.to_string_lossy(),
                        )))?,
                        None => anchor.from_value(&V::Null)?,
                    },
                )?;
                out.set(c"size", anchor.from_value(&V::Number(size as f64))?)?;
                out.set(c"errorKind", anchor.from_value(&V::Null)?)?;
                out.set(c"raw", anchor.from_value(&V::Null)?)?;
                Ok(out)
            }
            Err(failure) => {
                self.dirs.borrow_mut().clear();
                out.set(c"present", anchor.from_value(&V::Bool(false))?)?;
                out.set(c"recovered", anchor.from_value(&V::Bool(false))?)?;
                out.set(c"recoveredFrom", anchor.from_value(&V::Null)?)?;
                out.set(c"size", anchor.from_value(&V::Number(0.0))?)?;
                out.set(c"errorKind", anchor.from_value(&V::string(failure.kind()))?)?;
                out.set(
                    c"raw",
                    match failure.raw_excerpt() {
                        Some(raw) => anchor.from_value(&V::string(raw))?,
                        None => anchor.from_value(&V::Null)?,
                    },
                )?;
                Ok(out)
            }
        }
    }
    fn save_directories_internal(&self, env: &Env, anchor: L<'_>) -> Result<()> {
        let file =
            self.paths.borrow().directories.clone().ok_or_else(|| {
                napi::Error::from_reason("state owner directoriesFile is required")
            })?;
        let compact = {
            let table = self.dirs.borrow();
            self.table_compact(env, anchor, &table)
                .map_err(napi::Error::from_reason)?
        };
        durable_state::save_compact(&file, "directories", &compact)
            .map_err(napi::Error::from_reason)
    }
    /// `MULTICC_TEST_SESSION_PERSISTENCE_FAIL_FILE` inside the temp data root.
    /// The marker is only honoured under `NODE_ENV=test`, exactly as before.
    fn marker_failure(&self, anchor: L<'_>) -> Result<Option<SaveFailure>> {
        if std::env::var("NODE_ENV").ok().as_deref() != Some("test") {
            return Ok(None);
        }
        let Ok(marker) = std::env::var("MULTICC_TEST_SESSION_PERSISTENCE_FAIL_FILE") else {
            return Ok(None);
        };
        if marker.is_empty() {
            return Ok(None);
        }
        let Some(root) = self.root.borrow().clone() else {
            return Ok(None);
        };
        let resolve = |path: PathBuf| {
            if path.is_absolute() {
                path
            } else {
                std::env::current_dir()
                    .map(|cwd| cwd.join(&path))
                    .unwrap_or(path)
            }
        };
        let root = resolve(root);
        let marker = resolve(PathBuf::from(marker));
        let inside = marker == root || marker.starts_with(&root);
        if !inside || !marker.exists() {
            return Ok(None);
        }
        let error = anchor.global()?.get(c"Error")?.construct(&[
            anchor.from_value(&V::string("injected sessions.json persistence failure"))?
        ])?;
        error.set(c"code", anchor.from_value(&V::string("EIO"))?)?;
        Ok(Some(SaveFailure::Host(error.raw())))
    }
    fn save(&self, env: &Env, anchor: L<'_>) -> std::result::Result<(), SaveFailure> {
        let array = self
            .records_array(env, anchor)
            .map_err(|error| SaveFailure::Message(error.reason.clone()))?;
        let compact = match self.stringify(env, anchor, array) {
            Ok(Some(text)) => text.to_string_lossy(),
            Ok(None) => "null".to_string(),
            Err(_) => {
                return Err(
                    match Self::exception(anchor)
                        .map_err(|error| SaveFailure::Message(error.reason.clone()))?
                    {
                        Some(exception) => SaveFailure::Host(exception),
                        None => SaveFailure::Message("JSON.stringify failed".into()),
                    },
                );
            }
        };
        if let Some(store_save) = self.port(|ports| ports.store_save.clone()) {
            // The historical port receives a detached JSON snapshot: the
            // caller's array must not retain mutable record references.
            let parsed = js::json_parse(&compact).unwrap_or(V::Null);
            let payload = anchor
                .from_value(&parsed)
                .map_err(|error| SaveFailure::Message(error.reason.clone()))?;
            let save = self
                .read(env, anchor, &store_save)
                .map_err(|error| SaveFailure::Message(error.reason.clone()))?;
            return match save.call_plain(&[payload]) {
                Ok(_) => Ok(()),
                Err(error) => match Self::exception(anchor)
                    .map_err(|error| SaveFailure::Message(error.reason.clone()))?
                {
                    Some(exception) => Err(SaveFailure::Host(exception)),
                    None => Err(SaveFailure::Message(error.reason)),
                },
            };
        }
        if let Some(failure) = self
            .marker_failure(anchor)
            .map_err(|error| SaveFailure::Message(error.reason.clone()))?
        {
            return Err(failure);
        }
        let Some(file) = self.file.borrow().clone() else {
            return Err(SaveFailure::Message(
                "session persistence has no writer configured".into(),
            ));
        };
        durable_state::save_compact(&file, &self.kind.borrow(), &compact)
            .map_err(SaveFailure::Message)
    }
    fn take_snapshot(
        &self,
        env: &Env,
        anchor: L<'_>,
    ) -> std::result::Result<Snapshot, SaveFailure> {
        let ids = self.table.borrow().order.clone();
        let mut json = Vec::with_capacity(ids.len());
        for id in &ids {
            let value = self.table.borrow().get(id).expect("ordered id");
            let record = self
                .read(env, anchor, &value)
                .map_err(|error| SaveFailure::Message(error.reason.clone()))?;
            match self.stringify(env, anchor, record) {
                Ok(text) => json.push(text),
                Err(_) => {
                    return Err(
                        match Self::exception(anchor)
                            .map_err(|error| SaveFailure::Message(error.reason.clone()))?
                        {
                            Some(exception) => SaveFailure::Host(exception),
                            None => SaveFailure::Message("JSON.stringify failed".into()),
                        },
                    );
                }
            }
        }
        Ok(Snapshot { ids, json })
    }
    fn restore(&self, env: &Env, anchor: L<'_>, snapshot: &Snapshot) -> Result<()> {
        let mut restored: Vec<(JsString, Value)> = Vec::with_capacity(snapshot.ids.len());
        for (id, json) in snapshot.ids.iter().zip(snapshot.json.iter()) {
            let value = match json {
                Some(text) => {
                    let parsed = js::json_parse(&text.to_string_lossy())
                        .map_err(|_| napi::Error::from_reason("snapshot_parse_failed"))?;
                    let live = anchor.from_value(&parsed)?;
                    self.values.capture(env, live)?
                }
                None => Value::Native(V::Undefined),
            };
            restored.push((id.clone(), value));
        }
        let mut table = self.table.borrow_mut();
        table.clear();
        for (id, value) in restored {
            table.set(id, value);
        }
        Ok(())
    }
    fn state_value<'a>(&self, anchor: L<'a>) -> Result<L<'a>> {
        let persistence = self.persistence.borrow();
        let out = object(anchor)?;
        out.set(
            c"dirty",
            anchor.from_value(&V::Bool(persistence.retry.dirty))?,
        )?;
        out.set(
            c"retryAttempt",
            anchor.from_value(&V::Number(persistence.retry.attempt as f64))?,
        )?;
        out.set(
            c"retryScheduled",
            anchor.from_value(&V::Bool(persistence.timer.is_some()))?,
        )?;
        out.set(
            c"lastFailure",
            match &persistence.last_failure {
                Some(failure) => anchor.from_value(&V::object(vec![
                    ("at", V::string(&failure.at)),
                    ("source", V::string(&failure.source)),
                    ("mode", V::string(&failure.mode)),
                    ("attempt", V::Number(failure.attempt as f64)),
                    ("message", V::string(&failure.message)),
                ]))?,
                None => anchor.from_value(&V::Null)?,
            },
        )?;
        Ok(out)
    }
    fn emit_state(&self, env: &Env, anchor: L<'_>) -> Result<()> {
        let Some(port) = self.port(|ports| ports.on_state.clone()) else {
            return Ok(());
        };
        let payload = self.state_value(anchor)?;
        let callback = self.read(env, anchor, &port)?;
        let _ = callback.catch(|| callback.call_plain(&[payload]));
        Ok(())
    }
    fn cancel_retry(&self, env: &Env, anchor: L<'_>) -> Result<()> {
        let timer = self.persistence.borrow_mut().timer.take();
        if let Some(timer) = timer {
            if let Some(clear) = self.port(|ports| ports.clear_timeout.clone()) {
                let callback = self.read(env, anchor, &clear)?;
                let value = self.read(env, anchor, &timer)?;
                let _ = callback.catch(|| callback.call_plain(&[value]));
            }
        }
        self.persistence.borrow_mut().retry.attempt = 0;
        Ok(())
    }
    fn mark_clean(&self, env: &Env, anchor: L<'_>) -> Result<()> {
        self.persistence.borrow_mut().retry.mark_clean();
        self.persistence.borrow_mut().last_failure = None;
        self.cancel_retry(env, anchor)?;
        self.emit_state(env, anchor)
    }
    fn report(
        &self,
        env: &Env,
        anchor: L<'_>,
        error: L<'_>,
        source: &str,
        mode: &str,
        attempt: u32,
    ) -> Result<()> {
        let message = error_message(error)?;
        let dirty = self.persistence.borrow().retry.dirty;
        {
            let mut persistence = self.persistence.borrow_mut();
            persistence.last_failure = Some(Failure {
                at: iso_timestamp_now(),
                source: source.to_string(),
                mode: mode.to_string(),
                attempt,
                message,
            });
        }
        if let Some(port) = self.port(|ports| ports.on_failure.clone()) {
            let payload = object(anchor)?;
            payload.set(c"mode", anchor.from_value(&V::string(mode))?)?;
            payload.set(c"source", anchor.from_value(&V::string(source))?)?;
            payload.set(c"attempt", anchor.from_value(&V::Number(attempt as f64))?)?;
            payload.set(c"dirty", anchor.from_value(&V::Bool(dirty))?)?;
            payload.set(c"error", error)?;
            let callback = self.read(env, anchor, &port)?;
            let _ = callback.catch(|| callback.call_plain(&[payload]));
        }
        self.emit_state(env, anchor)
    }
    fn schedule_retry(&self, env: &Env, anchor: L<'_>, source: &str) -> Result<()> {
        {
            let persistence = self.persistence.borrow();
            if !persistence
                .retry
                .can_schedule(persistence.timer.is_some(), self.max_retries.get())
            {
                return Ok(());
            }
        }
        let set_timeout = self
            .port(|ports| ports.set_timeout.clone())
            .ok_or_else(|| napi::Error::from_reason("session retry timer port is required"))?;
        let tick = self
            .port(|ports| ports.retry_tick.clone())
            .ok_or_else(|| napi::Error::from_reason("session retry tick port is required"))?;
        let set_timeout = self.read(env, anchor, &set_timeout)?;
        let tick = self.read(env, anchor, &tick)?;
        let timer = set_timeout.call_plain(&[
            tick,
            anchor.from_value(&V::Number(self.retry_delay_ms.get()))?,
        ])?;
        let unref = prop(timer, c"unref")?;
        if unref.kind()? == sys::ValueType::napi_function {
            unref.call(timer, &[])?;
        }
        let captured = self.values.capture(env, timer)?;
        {
            let mut persistence = self.persistence.borrow_mut();
            persistence.timer = Some(captured);
            persistence.retry_source = Some(source.to_string());
        }
        self.emit_state(env, anchor)
    }
    fn rollback_internal(&self, env: &Env, anchor: L<'_>) -> Result<()> {
        let (snapshot, dirty) = {
            let mut persistence = self.persistence.borrow_mut();
            persistence.retry.mutating = false;
            persistence.tx = None;
            (persistence.snapshot.take(), persistence.snapshot_dirty)
        };
        if let Some(snapshot) = snapshot {
            self.restore(env, anchor, &snapshot)?;
        }
        self.persistence.borrow_mut().retry.dirty = dirty;
        self.emit_state(env, anchor)
    }
    fn finish_commit(&self, env: &Env, anchor: L<'_>) -> Result<()> {
        {
            let mut persistence = self.persistence.borrow_mut();
            persistence.retry.mutating = false;
            persistence.tx = None;
            persistence.snapshot = None;
        }
        self.mark_clean(env, anchor)
    }
    fn best_effort_save(&self, env: &Env, anchor: L<'_>, source: &str) -> Result<bool> {
        match self.save(env, anchor) {
            Ok(()) => {
                self.mark_clean(env, anchor)?;
                Ok(true)
            }
            Err(failure) => {
                let error = failure.into_live(env, anchor)?;
                self.persistence.borrow_mut().retry.mark_dirty();
                self.report(env, anchor, error, source, "best_effort", 0)?;
                self.schedule_retry(env, anchor, source)?;
                Ok(false)
            }
        }
    }
    fn merged_task_state<'a>(&self, anchor: L<'a>, record: L<'a>) -> Result<L<'a>> {
        let out = anchor.from_value(&task_state_defaults())?;
        if record.truthy()? {
            let state = record.get(c"taskState")?;
            if state.truthy()? {
                out.spread_from(state)?;
            }
        }
        Ok(out)
    }
    fn now<'a>(&self, env: &'a Env, anchor: L<'a>) -> Result<L<'a>> {
        if let Some(port) = self.port(|ports| ports.now.clone()) {
            return self.read(env, anchor, &port)?.call_plain(&[]);
        }
        let date = anchor.global()?.get(c"Date")?;
        date.get(c"now")?.call(date, &[])
    }
    fn result<'a>(&self, anchor: L<'a>, status: &str) -> Result<L<'a>> {
        let out = object(anchor)?;
        out.set(c"status", anchor.from_value(&V::string(status))?)?;
        Ok(out)
    }

    // ── Turn runtime store (the frozen `src/chat/runtime-store.js` semantics) ──
    /// `current(sessionId)`: the stored entry, or the not-stored idle default.
    fn turn_entry(&self, session: &JsString) -> RuntimeEntry {
        self.runtime
            .borrow()
            .get(session)
            .cloned()
            .unwrap_or(RuntimeEntry {
                record: TurnRecord::default_for(session.clone()),
                proof: None,
            })
    }
    fn turn_store(&self, session: JsString, record: TurnRecord, proof: Option<Value>) {
        self.runtime
            .borrow_mut()
            .set(session, RuntimeEntry { record, proof });
    }
    /// The injected `now()`; the facade always supplies `Date.now` or a test
    /// clock, so an absent port is a configuration error, never a silent clock.
    fn turn_clock(&self, env: &Env, anchor: L<'_>) -> Result<f64> {
        let port = self
            .turn_now
            .borrow()
            .clone()
            .ok_or_else(|| napi::Error::from_reason("turn runtime clock is not configured"))?;
        self.read(env, anchor, &port)?
            .call_plain(&[])?
            .explicit_number()
    }
    fn turn_string<'a>(&self, anchor: L<'a>, value: Option<&JsString>) -> Result<L<'a>> {
        match value {
            Some(value) => anchor.from_value(&V::String(value.clone())),
            None => anchor.from_value(&V::Null),
        }
    }
    fn turn_number<'a>(&self, anchor: L<'a>, value: Option<f64>) -> Result<L<'a>> {
        match value {
            Some(value) => anchor.from_value(&V::Number(value)),
            None => anchor.from_value(&V::Null),
        }
    }
    fn turn_outcome_value<'a>(
        &self,
        anchor: L<'a>,
        outcome: Option<&TurnOutcome>,
    ) -> Result<L<'a>> {
        match outcome {
            None => anchor.from_value(&V::Null),
            Some(outcome) => {
                let out = object(anchor)?;
                out.set(
                    c"turnId",
                    anchor.from_value(&V::String(outcome.turn_id.clone()))?,
                )?;
                out.set(
                    c"status",
                    anchor.from_value(&V::String(outcome.status.clone()))?,
                )?;
                out.set(
                    c"reason",
                    self.turn_string(anchor, outcome.reason.as_ref())?,
                )?;
                out.set(c"at", anchor.from_value(&V::Number(outcome.at))?)?;
                out.freeze()
            }
        }
    }
    /// `freezeRecord(current(sessionId))` — the clone's property order is the
    /// frozen Node oracle's: lastOutcome precedes providerRouteProof, which
    /// precedes pendingOutcome.
    fn turn_state_value<'a>(
        &self,
        env: &Env,
        anchor: L<'a>,
        record: &TurnRecord,
        proof: Option<&Value>,
    ) -> Result<L<'a>> {
        let out = object(anchor)?;
        out.set(
            c"sessionId",
            anchor.from_value(&V::String(record.session_id.clone()))?,
        )?;
        if record.phase == Phase::Idle {
            out.set(c"phase", anchor.from_value(&V::string("idle"))?)?;
            out.set(c"turnId", anchor.from_value(&V::Null)?)?;
            out.set(
                c"generation",
                anchor.from_value(&V::Number(record.generation))?,
            )?;
            out.set(
                c"lastOutcome",
                self.turn_outcome_value(anchor, record.last_outcome.as_ref())?,
            )?;
        } else {
            out.set(
                c"turnId",
                self.turn_string(anchor, record.turn_id.as_ref())?,
            )?;
            out.set(
                c"phase",
                anchor.from_value(&V::string(record.phase.as_str()))?,
            )?;
            out.set(
                c"generation",
                anchor.from_value(&V::Number(record.generation))?,
            )?;
            out.set(c"cli", self.turn_string(anchor, record.cli.as_ref())?)?;
            out.set(
                c"transport",
                self.turn_string(anchor, record.transport.as_ref())?,
            )?;
            out.set(
                c"messageDurable",
                anchor.from_value(&V::Bool(record.message_durable))?,
            )?;
            out.set(
                c"providerRouteResolved",
                anchor.from_value(&V::Bool(record.provider_route_resolved))?,
            )?;
            out.set(c"claimedAt", self.turn_number(anchor, record.claimed_at)?)?;
            out.set(c"startedAt", self.turn_number(anchor, record.started_at)?)?;
            out.set(
                c"finishingAt",
                self.turn_number(anchor, record.finishing_at)?,
            )?;
            out.set(
                c"lastOutcome",
                self.turn_outcome_value(anchor, record.last_outcome.as_ref())?,
            )?;
        }
        if let Some(proof) = proof {
            out.set(c"providerRouteProof", self.read(env, anchor, proof)?)?;
        }
        let pending = match &record.pending_outcome {
            Some(pending) => {
                let value = object(anchor)?;
                value.set(
                    c"status",
                    anchor.from_value(&V::String(pending.status.clone()))?,
                )?;
                value.set(
                    c"reason",
                    self.turn_string(anchor, pending.reason.as_ref())?,
                )?;
                value.freeze()?
            }
            None => anchor.from_value(&V::Undefined)?,
        };
        out.set(c"pendingOutcome", pending)?;
        out.freeze()
    }
    /// `Object.freeze({ ok, ...(code ? { code } : {}), state })`.
    fn turn_result<'a>(
        &self,
        env: &Env,
        anchor: L<'a>,
        ok: bool,
        code: Option<&str>,
        record: &TurnRecord,
        proof: Option<&Value>,
    ) -> Result<L<'a>> {
        let state = self.turn_state_value(env, anchor, record, proof)?;
        let out = object(anchor)?;
        out.set(c"ok", anchor.from_value(&V::Bool(ok))?)?;
        if let Some(code) = code {
            out.set(c"code", anchor.from_value(&V::string(code))?)?;
        }
        out.set(c"state", state)?;
        out.freeze()
    }
    /// `settle(...)` and every failure that routes through it. The clock is read
    /// only after the transition is known to be legal, exactly as the Node
    /// implementation did.
    #[allow(clippy::too_many_arguments)]
    fn turn_settle_result(
        &self,
        env: &Env,
        anchor: L<'_>,
        session: JsString,
        turn: JsString,
        allowed: &[Phase],
        status: JsString,
        reason: Option<JsString>,
    ) -> Result<sys::napi_value> {
        let entry = self.turn_entry(&session);
        if let Err(failure) = chat_runtime::match_phase(&entry.record, &turn, allowed) {
            return Ok(self
                .turn_result(
                    env,
                    anchor,
                    false,
                    Some(failure.code()),
                    &entry.record,
                    entry.proof.as_ref(),
                )?
                .raw());
        }
        let now = self.turn_clock(env, anchor)?;
        let record = match chat_runtime::settle(&entry.record, &turn, allowed, status, reason, now)
        {
            Ok(record) => record,
            Err(failure) => {
                return Ok(self
                    .turn_result(
                        env,
                        anchor,
                        false,
                        Some(failure.code()),
                        &entry.record,
                        entry.proof.as_ref(),
                    )?
                    .raw());
            }
        };
        self.turn_store(session, record.clone(), None);
        Ok(self
            .turn_result(env, anchor, true, None, &record, None)?
            .raw())
    }
    /// `[true, ...]` phases from the JS `allowedPhases` argument. Unknown names
    /// are dropped: `phases.includes(record.phase)` could never match them.
    fn turn_allowed(&self, value: L<'_>) -> Result<Vec<Phase>> {
        if value.nullish()? {
            return Ok(vec![Phase::Preparing, Phase::Running]);
        }
        if !value.is_array()? {
            return Err(napi::Error::from_reason("allowedPhases must be an array"));
        }
        let length = value.get(c"length")?.number()? as u32;
        let mut phases = Vec::new();
        for index in 0..length {
            let Some(name) = value.element(index)?.string()? else {
                continue;
            };
            match name.to_string_lossy().as_str() {
                "idle" => phases.push(Phase::Idle),
                "preparing" => phases.push(Phase::Preparing),
                "running" => phases.push(Phase::Running),
                "finishing" => phases.push(Phase::Finishing),
                _ => {}
            }
        }
        Ok(phases)
    }
    /// `ownsConcreteRouteProof(proof, sessionId, turnId)` facts. The identity
    /// comparisons are strict equals on the live values, not string coercion.
    fn turn_route_proof(
        &self,
        proof: L<'_>,
        session: L<'_>,
        turn: L<'_>,
    ) -> Result<RouteProofFacts> {
        // `const route = proof && proof.route` — a nullish proof has no fields.
        let route = if proof.truthy()? {
            proof.get(c"route")?
        } else {
            proof.from_value(&V::Undefined)?
        };
        let truthy = |name: &CStr| -> Result<bool> { prop(route, name)?.truthy() };
        let generation = prop(route, c"routeGeneration")?.number().ok();
        let attempt = prop(route, c"attemptNo")?.number().ok();
        Ok(RouteProofFacts {
            kind_provider_route: prop(proof, c"kind")?
                .string()?
                .is_some_and(|kind| kind.to_string_lossy() == "provider-route"),
            resolved_true: prop(proof, c"resolved")?.is_true()?,
            proof_frozen: is_frozen(proof)?,
            route_frozen: is_frozen(route)?,
            session_matches: prop(proof, c"sessionId")?.equals(session)?,
            turn_matches: prop(proof, c"turnId")?.equals(turn)?,
            runtime_epoch: truthy(c"runtimeEpoch")?,
            decision_id: truthy(c"decisionId")?,
            route_attempt_id: truthy(c"routeAttemptId")?,
            provider_id: truthy(c"providerId")?,
            protocol: truthy(c"protocol")?,
            model: truthy(c"model")?,
            provider_revision: truthy(c"providerRevision")?,
            route_generation: generation,
            attempt_no: attempt,
        })
    }
}

#[napi]
impl RustSessionRecords {
    #[napi(constructor)]
    pub fn new(env: Env, anchor: Unknown<'_>) -> Result<Self> {
        Ok(Self {
            table: RefCell::new(Table::new()),
            dirs: RefCell::new(Table::new()),
            chat: RefCell::new(Table::new()),
            runtime: RefCell::new(RuntimeTable::new()),
            turn_now: RefCell::new(None),
            values: Values::new(L::new(&env, anchor))?,
            persistence: RefCell::new(Persistence::default()),
            ports: RefCell::new(Ports::default()),
            paths: RefCell::new(StatePaths::default()),
            file: RefCell::new(None),
            root: RefCell::new(None),
            kind: RefCell::new("sessions".to_string()),
            max_retries: Cell::new(3),
            retry_delay_ms: Cell::new(250.0),
            next_tx: Cell::new(0),
        })
    }
    /// Replace the table from an iterable of `[id, record]` pairs (a Map's
    /// entries, or an array of pairs). Used once at boot after the Node loader
    /// has parsed and migrated the on-disk state; the source is not retained.
    ///
    /// Returns true when a load-time normalisation changed a record (the caller
    /// then persists the table once). The only normalisation is the retired
    /// `claude -p` lane's identity: that lane stored the live transcript id in
    /// `_streamSessionId` and left a placeholder in `cliSessionId`; the Agent
    /// SDK lane resumes by `cliSessionId`, and both name the same
    /// `~/.claude/projects/<cwd>/<id>.jsonl`, so the transcript id wins.
    #[napi]
    pub fn init(&self, env: Env, entries: Unknown<'_>) -> Result<bool> {
        self.values.drain(&env)?;
        let entries = L::new(&env, entries);
        let mut inserted: Vec<(JsString, Value)> = Vec::new();
        let mut normalized = false;
        entries.for_each(|pair| {
            let key = self.key(pair.element(0)?)?;
            let record = pair.element(1)?;
            normalized |= normalize_claude_native_id(record)?;
            inserted.push((key, self.values.capture(&env, record)?));
            Ok(())
        })?;
        let mut table = self.table.borrow_mut();
        table.clear();
        for (key, value) in inserted {
            table.set(key, value);
        }
        Ok(normalized)
    }
    /// Replace the directory registry from an iterable of `[id, record]` pairs.
    /// Used at boot for the legacy-schema migration; the source is not retained.
    #[napi]
    pub fn init_directories(&self, env: Env, entries: Unknown<'_>) -> Result<()> {
        self.values.drain(&env)?;
        let table = self.table_from_pairs(&env, L::new(&env, entries))?;
        *self.dirs.borrow_mut() = table;
        Ok(())
    }
    /// Load directories.json (primary, then `.bak1..3`) into the native table.
    /// The result carries recovery metadata and, on failure, the information the
    /// JS adapter needs to throw the same `CorruptedStateError` as StateStore.
    #[napi]
    pub fn load_directories(&self, env: Env) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        Ok(self.load_directories_internal(&env, anchor)?.raw())
    }
    #[napi]
    pub fn directory_get(&self, env: Env, id: Unknown<'_>) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let key = self.key(L::new(&env, id))?;
        let value = self.dirs.borrow().get(&key);
        Ok(match value {
            Some(value) => self.read(&env, anchor, &value)?.raw(),
            None => anchor.from_value(&V::Undefined)?.raw(),
        })
    }
    /// `Map#set` for the directory registry. The key is explicit so callers keep
    /// ordinary `Map` semantics even if a record's own `id` field is absent.
    #[napi]
    pub fn directory_set(&self, env: Env, id: Unknown<'_>, record: Unknown<'_>) -> Result<()> {
        self.values.drain(&env)?;
        let key = self.key(L::new(&env, id))?;
        let captured = self.values.capture(&env, L::new(&env, record))?;
        self.dirs.borrow_mut().set(key, captured);
        Ok(())
    }
    #[napi]
    pub fn directory_has(&self, env: Env, id: Unknown<'_>) -> Result<bool> {
        self.values.drain(&env)?;
        let key = self.key(L::new(&env, id))?;
        Ok(self.dirs.borrow().map.contains_key(&key))
    }
    #[napi]
    pub fn directory_delete(&self, env: Env, id: Unknown<'_>) -> Result<bool> {
        self.values.drain(&env)?;
        let key = self.key(L::new(&env, id))?;
        let removed = self.dirs.borrow_mut().delete(&key);
        self.values.drain(&env)?;
        Ok(removed)
    }
    #[napi]
    pub fn directory_clear(&self, env: Env) -> Result<()> {
        self.values.drain(&env)?;
        self.dirs.borrow_mut().clear();
        Ok(())
    }
    #[napi]
    pub fn directory_size(&self) -> u32 {
        self.dirs.borrow().len() as u32
    }
    /// Entries as `[[id, record], ...]`; the facade turns this into Map
    /// iterators so no table copy lives in Node.
    #[napi]
    pub fn directory_entries(&self, env: Env) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let ids = self.dirs.borrow().order.clone();
        let outer = anchor.from_value(&V::Array(vec![]))?;
        for (index, id) in ids.iter().enumerate() {
            let value = self.dirs.borrow().get(id).expect("ordered id");
            let pair = anchor.from_value(&V::Array(vec![]))?;
            pair.set_element(0, anchor.from_value(&V::String(id.clone()))?)?;
            pair.set_element(1, self.read(&env, anchor, &value)?)?;
            outer.set_element(index as u32, pair)?;
        }
        Ok(outer.raw())
    }
    /// Write directories.json through the host stringifier and the native
    /// StateStore writer (envelope, atomic rename, three rolling backups).
    #[napi]
    pub fn save_directories(&self, env: Env) -> Result<()> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        self.save_directories_internal(&env, anchor)
    }
    /// One native transaction for a directory delete that also cascades
    /// sessions: journal write, both StateStore writes, journal clear. A crash
    /// at any point leaves the journal for `replay_journals` to finish.
    #[napi]
    pub fn commit_cross_file_write(&self, env: Env, spec: Unknown<'_>) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let spec = L::new(&env, spec);
        let kind = prop(spec, c"kind")?
            .string()?
            .map(|kind| kind.to_string_lossy())
            .filter(|kind| !kind.is_empty())
            .unwrap_or_else(|| "state-tx".to_string());
        let (directories_file, sessions_file, journal_dir) = {
            let paths = self.paths.borrow();
            (
                paths.directories.clone(),
                paths.sessions.clone(),
                paths.journal.clone(),
            )
        };
        let directories_file = directories_file
            .ok_or_else(|| napi::Error::from_reason("state owner directoriesFile is required"))?;
        let sessions_file = sessions_file
            .ok_or_else(|| napi::Error::from_reason("state owner sessionsFile is required"))?;
        let journal_dir = journal_dir
            .ok_or_else(|| napi::Error::from_reason("state owner journalDir is required"))?;
        let directories_payload = {
            let table = self.dirs.borrow();
            self.table_compact(&env, anchor, &table)
                .map_err(napi::Error::from_reason)?
        };
        let sessions_payload = {
            let table = self.table.borrow();
            self.table_compact(&env, anchor, &table)
                .map_err(napi::Error::from_reason)?
        };
        let id = state_tx::new_tx_id().map_err(napi::Error::from_reason)?;
        let ts = self
            .now(&env, anchor)?
            .number()
            .unwrap_or_else(|_| state_tx::now_millis());
        let entry = state_tx::JournalEntry {
            id: id.clone(),
            kind,
            ts: multicc_core::js::number_to_string(ts),
            files: vec![
                state_tx::JournalFile {
                    path: directories_file,
                    payload: Some(directories_payload),
                    kind: "directories".to_string(),
                    version: 1,
                    rotate: 3,
                },
                state_tx::JournalFile {
                    path: sessions_file,
                    payload: Some(sessions_payload),
                    kind: "sessions".to_string(),
                    version: 1,
                    rotate: 3,
                },
            ],
        };
        let journal = state_tx::journal_file(&journal_dir, &id);
        durable_state::save_compact_with(
            &journal,
            "state-tx-journal",
            1,
            0,
            Some(&state_tx::encode(&entry)),
        )
        .map_err(napi::Error::from_reason)?;
        self.crash("journal")?;
        for (index, file) in entry.files.iter().enumerate() {
            state_tx::apply_file(file).map_err(|error| {
                napi::Error::from_reason(format!(
                    "[state-tx] apply failed for tx {}: {error}",
                    entry.id
                ))
            })?;
            self.crash(if index == 0 {
                "directories"
            } else {
                "sessions"
            })?;
        }
        let _ = fs::remove_file(&journal);
        let out = object(anchor)?;
        out.set(
            c"txId",
            anchor.from_value(&V::String(JsString::from_rust_str(&entry.id)))?,
        )?;
        Ok(out.raw())
    }
    /// Boot replay: scan `tx-*.json`, apply every readable entry in the order
    /// its `files` array recorded, then delete it. Unreadable or malformed
    /// journals move aside to `broken/` so boot never blocks on one.
    #[napi]
    pub fn replay_journals(&self, env: Env) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let journal_dir = self
            .paths
            .borrow()
            .journal
            .clone()
            .ok_or_else(|| napi::Error::from_reason("state owner journalDir is required"))?;
        let mut replayed = 0u32;
        let mut skipped = 0u32;
        let mut crashed = false;
        let mut messages: Vec<String> = Vec::new();
        let entries = match fs::read_dir(&journal_dir) {
            Ok(entries) => entries,
            Err(_) => {
                let out = object(anchor)?;
                out.set(c"replayed", anchor.from_value(&V::Number(0.0))?)?;
                out.set(c"skipped", anchor.from_value(&V::Number(0.0))?)?;
                out.set(c"crashed", anchor.from_value(&V::Bool(false))?)?;
                out.set(c"messages", anchor.from_value(&V::Array(vec![]))?)?;
                return Ok(out.raw());
            }
        };
        for entry in entries {
            let Ok(entry) = entry else { continue };
            let name = entry.file_name().to_string_lossy().to_string();
            if !state_tx::is_journal_name(&name) {
                continue;
            }
            let full = journal_dir.join(&name);
            let parsed = match durable_state::read(&full) {
                Ok(Some(value)) => value,
                Ok(None) => continue,
                Err(failure) => {
                    skipped += 1;
                    messages.push(format!(
                        "[state-tx] skipping unreadable journal {name}: {}",
                        failure.code()
                    ));
                    state_tx::move_aside(&full);
                    continue;
                }
            };
            let decoded = match state_tx::decode(&parsed) {
                Ok(decoded) => decoded,
                Err(error) => {
                    skipped += 1;
                    messages.push(format!("[state-tx] apply failed for {name}: {error}"));
                    state_tx::move_aside(&full);
                    continue;
                }
            };
            let mut failure = None;
            let mut applied = 0usize;
            for file in &decoded.files {
                if let Err(error) = state_tx::apply_file(file) {
                    failure = Some(error);
                    break;
                }
                applied += 1;
                if self.replay_crash_after(applied) {
                    crashed = true;
                    break;
                }
            }
            if crashed {
                break;
            }
            match failure {
                Some(error) => {
                    skipped += 1;
                    messages.push(format!("[state-tx] apply failed for {name}: {error}"));
                    state_tx::move_aside(&full);
                }
                None => {
                    let _ = fs::remove_file(&full);
                    replayed += 1;
                    messages.push(format!("[state-tx] replayed journal {name}"));
                }
            }
        }
        let out = object(anchor)?;
        out.set(c"replayed", anchor.from_value(&V::Number(replayed as f64))?)?;
        out.set(c"skipped", anchor.from_value(&V::Number(skipped as f64))?)?;
        out.set(c"crashed", anchor.from_value(&V::Bool(crashed))?)?;
        let list = anchor.from_value(&V::Array(vec![]))?;
        for (index, message) in messages.iter().enumerate() {
            list.set_element(index as u32, anchor.from_value(&V::string(message))?)?;
        }
        out.set(c"messages", list)?;
        Ok(out.raw())
    }
    /// Configure host ports and the durable writer. Absent keys are left
    /// unchanged, so the record owner and the persistence adapter can configure
    /// their own slice independently.
    #[napi]
    pub fn configure(&self, env: Env, options: Unknown<'_>) -> Result<()> {
        self.values.drain(&env)?;
        let options = L::new(&env, options);
        if options.nullish()? {
            return Ok(());
        }
        for (name, slot) in [
            (c"storeSave", 0usize),
            (c"stringify", 1),
            (c"onFailure", 2),
            (c"onState", 3),
            (c"setTimeout", 4),
            (c"clearTimeout", 5),
            (c"retryTick", 6),
            (c"busEmit", 7),
            (c"chatBroadcast", 8),
            (c"workspaceBroadcast", 9),
            (c"taskStatePayload", 10),
            (c"now", 11),
        ] {
            if let Some(captured) = self.capture_fn(&env, prop(options, name)?)? {
                let mut ports = self.ports.borrow_mut();
                match slot {
                    0 => ports.store_save = Some(captured),
                    1 => ports.stringify = Some(captured),
                    2 => ports.on_failure = Some(captured),
                    3 => ports.on_state = Some(captured),
                    4 => ports.set_timeout = Some(captured),
                    5 => ports.clear_timeout = Some(captured),
                    6 => ports.retry_tick = Some(captured),
                    7 => ports.bus_emit = Some(captured),
                    8 => ports.chat_broadcast = Some(captured),
                    9 => ports.workspace_broadcast = Some(captured),
                    10 => ports.task_state_payload = Some(captured),
                    _ => ports.now = Some(captured),
                }
            }
        }
        if let Some(file) = prop(options, c"file")?.string()? {
            *self.file.borrow_mut() = Some(PathBuf::from(file.to_string_lossy()));
        }
        if let Some(root) = prop(options, c"root")?.string()? {
            *self.root.borrow_mut() = Some(PathBuf::from(root.to_string_lossy()));
        }
        if let Some(directories) = prop(options, c"directoriesFile")?.string()? {
            self.paths.borrow_mut().directories =
                Some(PathBuf::from(directories.to_string_lossy()));
        }
        if let Some(sessions) = prop(options, c"sessionsFile")?.string()? {
            self.paths.borrow_mut().sessions = Some(PathBuf::from(sessions.to_string_lossy()));
        }
        if let Some(journal) = prop(options, c"journalDir")?.string()? {
            self.paths.borrow_mut().journal = Some(PathBuf::from(journal.to_string_lossy()));
        }
        if let Some(kind) = prop(options, c"kind")?.string()? {
            *self.kind.borrow_mut() = kind.to_string_lossy();
        }
        if let Ok(delay) = prop(options, c"retryDelayMs")?.number() {
            if delay.is_finite() && delay > 0.0 {
                self.retry_delay_ms.set(delay);
            }
        }
        if let Some(retries) = prop(options, c"maxRetries")?.number_value()? {
            self.max_retries.set(retries.max(0.0) as u32);
        }
        Ok(())
    }
    #[napi]
    pub fn get(&self, env: Env, session: Unknown<'_>) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let key = self.key(L::new(&env, session))?;
        let value = self.table.borrow().get(&key);
        Ok(match value {
            Some(value) => self.read(&env, anchor, &value)?.raw(),
            None => anchor.from_value(&V::Undefined)?.raw(),
        })
    }
    #[napi]
    pub fn set(&self, env: Env, session: Unknown<'_>, record: Unknown<'_>) -> Result<()> {
        self.values.drain(&env)?;
        let key = self.key(L::new(&env, session))?;
        let captured = self.values.capture(&env, L::new(&env, record))?;
        self.table.borrow_mut().set(key, captured);
        Ok(())
    }
    #[napi]
    pub fn has(&self, env: Env, session: Unknown<'_>) -> Result<bool> {
        self.values.drain(&env)?;
        let key = self.key(L::new(&env, session))?;
        Ok(self.table.borrow().map.contains_key(&key))
    }
    #[napi]
    pub fn delete(&self, env: Env, session: Unknown<'_>) -> Result<bool> {
        self.values.drain(&env)?;
        let key = self.key(L::new(&env, session))?;
        let removed = self.table.borrow_mut().delete(&key);
        self.values.drain(&env)?;
        Ok(removed)
    }
    #[napi]
    pub fn clear(&self, env: Env) -> Result<()> {
        self.values.drain(&env)?;
        self.table.borrow_mut().clear();
        Ok(())
    }
    #[napi]
    pub fn size(&self) -> u32 {
        self.table.borrow().len() as u32
    }
    /// Entries as `[[id, record], ...]`; the facade turns this into Map
    /// iterators so no table copy lives in Node.
    #[napi]
    pub fn entries_snapshot(&self, env: Env) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let ids = self.table.borrow().order.clone();
        let outer = anchor.from_value(&V::Array(vec![]))?;
        for (index, id) in ids.iter().enumerate() {
            let value = self.table.borrow().get(id).expect("ordered id");
            let pair = anchor.from_value(&V::Array(vec![]))?;
            pair.set_element(0, anchor.from_value(&V::String(id.clone()))?)?;
            pair.set_element(1, self.read(&env, anchor, &value)?)?;
            outer.set_element(index as u32, pair)?;
        }
        Ok(outer.raw())
    }
    #[napi]
    pub fn list_by_dir(&self, env: Env, dir: Unknown<'_>) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let dir = L::new(&env, dir);
        let ids = self.table.borrow().order.clone();
        let out = anchor.from_value(&V::Array(vec![]))?;
        let mut count = 0u32;
        for id in &ids {
            let value = self.table.borrow().get(id).expect("ordered id");
            let record = self.read(&env, anchor, &value)?;
            if record.get(c"dirId")?.equals(dir)? {
                out.set_element(count, record)?;
                count += 1;
            }
        }
        Ok(out.raw())
    }
    /// Synchronous transaction: snapshot, run one mutator against the live
    /// records Map, save, then commit or roll back the whole table. Returns a
    /// small result object so the JS adapter can preserve `PersistenceError`
    /// identity and rethrow mutator exceptions unchanged.
    #[napi]
    pub fn mutate(
        &self,
        env: Env,
        source: String,
        records: Unknown<'_>,
        mutator: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        if self.persistence.borrow().retry.mutating {
            return Ok(self.result(anchor, "nested")?.raw());
        }
        let snapshot = match self.take_snapshot(&env, anchor) {
            Ok(snapshot) => snapshot,
            Err(failure) => {
                let out = self.result(anchor, "snapshot")?;
                out.set(c"error", failure.into_live(&env, anchor)?)?;
                return Ok(out.raw());
            }
        };
        {
            let mut persistence = self.persistence.borrow_mut();
            persistence.retry.mutating = true;
            persistence.snapshot_dirty = persistence.retry.dirty;
            persistence.tx = None;
            persistence.snapshot = Some(snapshot);
        }
        let outcome = L::new(&env, mutator).call_plain(&[L::new(&env, records)]);
        let value = match outcome {
            Err(error) => {
                let exception = Self::exception(anchor)?;
                self.rollback_internal(&env, anchor)?;
                let out = self.result(anchor, "mutator")?;
                out.set(
                    c"error",
                    match exception {
                        Some(exception) => L::from_raw(env.raw(), exception),
                        None => anchor.from_value(&V::string(&error.reason))?,
                    },
                )?;
                return Ok(out.raw());
            }
            Ok(value) => value,
        };
        if value.truthy()? && value.get(c"then")?.kind()? == sys::ValueType::napi_function {
            self.rollback_internal(&env, anchor)?;
            return Ok(self.result(anchor, "async")?.raw());
        }
        match self.save(&env, anchor) {
            Ok(()) => {
                self.finish_commit(&env, anchor)?;
                let out = self.result(anchor, "ok")?;
                out.set(c"value", value)?;
                Ok(out.raw())
            }
            Err(failure) => {
                let cause = failure.into_live(&env, anchor)?;
                self.rollback_internal(&env, anchor)?;
                self.report(&env, anchor, cause, &source, "required", 0)?;
                let out = self.result(anchor, "required")?;
                out.set(c"error", cause)?;
                Ok(out.raw())
            }
        }
    }
    #[napi]
    pub fn begin(&self, env: Env, _source: String) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        if self.persistence.borrow().retry.mutating {
            return Ok(self.result(anchor, "nested")?.raw());
        }
        let snapshot = match self.take_snapshot(&env, anchor) {
            Ok(snapshot) => snapshot,
            Err(failure) => {
                let out = self.result(anchor, "snapshot")?;
                out.set(c"error", failure.into_live(&env, anchor)?)?;
                return Ok(out.raw());
            }
        };
        let token = self.next_tx.get() + 1;
        self.next_tx.set(token);
        {
            let mut persistence = self.persistence.borrow_mut();
            persistence.retry.mutating = true;
            persistence.snapshot_dirty = persistence.retry.dirty;
            persistence.tx = Some(token);
            persistence.snapshot = Some(snapshot);
        }
        let out = self.result(anchor, "ok")?;
        out.set(c"token", anchor.from_value(&V::Number(token as f64))?)?;
        Ok(out.raw())
    }
    #[napi]
    pub fn commit(&self, env: Env, token: f64, source: String) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let token = token as u64;
        let active = {
            let persistence = self.persistence.borrow();
            persistence.retry.mutating && persistence.tx == Some(token)
        };
        if !active {
            return Ok(self.result(anchor, "closed")?.raw());
        }
        match self.save(&env, anchor) {
            Ok(()) => {
                self.finish_commit(&env, anchor)?;
                Ok(self.result(anchor, "ok")?.raw())
            }
            Err(failure) => {
                let cause = failure.into_live(&env, anchor)?;
                self.rollback_internal(&env, anchor)?;
                self.report(&env, anchor, cause, &source, "required", 0)?;
                let out = self.result(anchor, "required")?;
                out.set(c"error", cause)?;
                Ok(out.raw())
            }
        }
    }
    #[napi]
    pub fn rollback(&self, env: Env, token: f64) -> Result<()> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let token = token as u64;
        let active = {
            let persistence = self.persistence.borrow();
            persistence.retry.mutating && persistence.tx == Some(token)
        };
        if active {
            self.rollback_internal(&env, anchor)?;
        }
        Ok(())
    }
    #[napi]
    pub fn best_effort(&self, env: Env, source: String) -> Result<bool> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        self.best_effort_save(&env, anchor, &source)
    }
    #[napi]
    pub fn retry_tick(&self, env: Env) -> Result<()> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let source = {
            let mut persistence = self.persistence.borrow_mut();
            if persistence.timer.is_none() {
                return Ok(());
            }
            persistence.timer = None;
            persistence.retry.begin_attempt();
            persistence.retry_source.clone().unwrap_or_default()
        };
        match self.save(&env, anchor) {
            Ok(()) => self.mark_clean(&env, anchor)?,
            Err(failure) => {
                let error = failure.into_live(&env, anchor)?;
                let attempt = {
                    let mut persistence = self.persistence.borrow_mut();
                    persistence.retry.mark_dirty();
                    persistence.retry.attempt
                };
                self.report(&env, anchor, error, &source, "best_effort_retry", attempt)?;
                self.schedule_retry(&env, anchor, &source)?;
            }
        }
        Ok(())
    }
    #[napi]
    pub fn status(&self, env: Env) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        Ok(self.state_value(anchor)?.raw())
    }
    #[napi]
    pub fn stop(&self, env: Env) -> Result<()> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let timer = self.persistence.borrow_mut().timer.take();
        if let Some(timer) = timer {
            if let Some(clear) = self.port(|ports| ports.clear_timeout.clone()) {
                let callback = self.read(&env, anchor, &clear)?;
                let value = self.read(&env, anchor, &timer)?;
                let _ = callback.catch(|| callback.call_plain(&[value]));
            }
        }
        self.emit_state(&env, anchor)
    }
    #[napi]
    pub fn get_task_state(&self, env: Env, record: Unknown<'_>) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let record = L::new(&env, record);
        Ok(self.merged_task_state(anchor, record)?.raw())
    }
    #[napi]
    pub fn set_task_state(
        &self,
        env: Env,
        session: Unknown<'_>,
        patch: Unknown<'_>,
        options: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let session = L::new(&env, session);
        let key = self.key(session)?;
        let Some(record_value) = self.table.borrow().get(&key) else {
            return Ok(anchor.from_value(&V::Null)?.raw());
        };
        let record = self.read(&env, anchor, &record_value)?;
        let current = self.merged_task_state(anchor, record)?;
        let patch = L::new(&env, patch);
        let owns_classify = has_own(patch, c"classifyState")?;
        let changed = if owns_classify {
            !patch
                .get(c"classifyState")?
                .equals(current.get(c"classifyState")?)?
        } else {
            false
        };
        let owns_stamp = has_own(patch, c"classifyUpdatedAt")?;
        let next = object(anchor)?;
        next.spread_from(current)?;
        next.spread_from(patch)?;
        if should_stamp_classify_updated_at(owns_classify, changed, owns_stamp) {
            let now = self.now(&env, anchor)?;
            next.set(c"classifyUpdatedAt", now)?;
        }
        record.assign(c"taskState", next)?;
        if let Some(bus) = self.port(|ports| ports.bus_emit.clone()) {
            let bus = self.read(&env, anchor, &bus)?;
            let event = anchor.from_value(&V::string("task:state-changed"))?;
            bus.call_plain(&[event, session, current, next])?;
        }
        let save = !prop(L::new(&env, options), c"save")?.is_false()?;
        if save {
            self.best_effort_save(&env, anchor, "runtime.task-state")?;
        }
        if let Some(payload_port) = self.port(|ports| ports.task_state_payload.clone()) {
            let payload = self
                .read(&env, anchor, &payload_port)?
                .call_plain(&[next])?;
            if let Some(chat) = self.port(|ports| ports.chat_broadcast.clone()) {
                let chat = self.read(&env, anchor, &chat)?;
                let _ = chat.catch(|| chat.call_plain(&[session, payload]));
            }
            let dir = record.get(c"dirId")?;
            if dir.truthy()? {
                if let Some(workspace) = self.port(|ports| ports.workspace_broadcast.clone()) {
                    let workspace = self.read(&env, anchor, &workspace)?;
                    let event = object(anchor)?;
                    event.spread_from(payload)?;
                    event.set(c"sessionId", session)?;
                    let _ = workspace.catch(|| workspace.call_plain(&[dir, event]));
                }
            }
        }
        Ok(next.raw())
    }
    /// Replaces the previous direct `persisted.taskState = ts` history write
    /// (same last-7-days window) without a save or broadcast; the surrounding
    /// `setTaskState` call still persists it.
    #[napi]
    pub fn append_classify_history(
        &self,
        env: Env,
        session: Unknown<'_>,
        entry: Unknown<'_>,
        cutoff: f64,
    ) -> Result<bool> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let key = self.key(L::new(&env, session))?;
        let Some(record_value) = self.table.borrow().get(&key) else {
            return Ok(false);
        };
        let record = self.read(&env, anchor, &record_value)?;
        let state = record.get(c"taskState")?;
        let state = if state.truthy()? {
            state
        } else {
            object(anchor)?
        };
        let history = state.get(c"classifyHistory")?;
        let kept = anchor.from_value(&V::Array(vec![]))?;
        let mut count = 0u32;
        if history.is_array()? {
            let length = history.get(c"length")?.number()? as u32;
            for index in 0..length {
                let item = history.element(index)?;
                let at = item.get(c"at")?.number().ok();
                if keep_history_entry(at, cutoff) {
                    kept.set_element(count, item)?;
                    count += 1;
                }
            }
        }
        kept.set_element(count, L::new(&env, entry))?;
        state.assign(c"classifyHistory", kept)?;
        record.assign(c"taskState", state)?;
        Ok(true)
    }
    /// `record.taskState = {}` during task deletion (no save/broadcast).
    #[napi]
    pub fn reset_task_state(&self, env: Env, session: Unknown<'_>) -> Result<bool> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let key = self.key(L::new(&env, session))?;
        let Some(record_value) = self.table.borrow().get(&key) else {
            return Ok(false);
        };
        let record = self.read(&env, anchor, &record_value)?;
        record.assign(c"taskState", anchor.from_value(&V::Object(vec![]))?)?;
        Ok(true)
    }

    // ── Live chat-session table (`chatSessions`) ──
    // Membership and order are native; the `cs` objects stay live host
    // references so streaming/CLI/timer owners keep identity and field order.
    #[napi]
    pub fn chat_get(&self, env: Env, session: Unknown<'_>) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let key = self.key(L::new(&env, session))?;
        let found = self.chat.borrow().get(&key);
        match found {
            Some(value) => Ok(self.read(&env, anchor, &value)?.raw()),
            None => Ok(anchor.from_value(&V::Undefined)?.raw()),
        }
    }
    #[napi]
    pub fn chat_set(&self, env: Env, session: Unknown<'_>, value: Unknown<'_>) -> Result<()> {
        self.values.drain(&env)?;
        let key = self.key(L::new(&env, session))?;
        let captured = self.values.capture(&env, L::new(&env, value))?;
        self.chat.borrow_mut().set(key, captured);
        Ok(())
    }
    #[napi]
    pub fn chat_has(&self, env: Env, session: Unknown<'_>) -> Result<bool> {
        self.values.drain(&env)?;
        let key = self.key(L::new(&env, session))?;
        Ok(self.chat.borrow().map.contains_key(&key))
    }
    #[napi]
    pub fn chat_delete(&self, env: Env, session: Unknown<'_>) -> Result<bool> {
        self.values.drain(&env)?;
        let key = self.key(L::new(&env, session))?;
        Ok(self.chat.borrow_mut().delete(&key))
    }
    #[napi]
    pub fn chat_clear(&self, env: Env) -> Result<()> {
        self.values.drain(&env)?;
        self.chat.borrow_mut().clear();
        Ok(())
    }
    #[napi]
    pub fn chat_size(&self, env: Env) -> Result<f64> {
        self.values.drain(&env)?;
        Ok(self.chat.borrow().len() as f64)
    }
    /// Ordered `[id, session]` snapshot — the same iteration shape the session
    /// facade uses (`src/session/records.js`).
    #[napi]
    pub fn chat_entries(&self, env: Env) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let pairs = anchor.from_value(&V::Array(vec![]))?;
        let entries: Vec<(JsString, Value)> = {
            let table = self.chat.borrow();
            table
                .order
                .iter()
                .map(|id| {
                    let value = table.map.get(id).expect("ordered id").clone();
                    (id.clone(), value)
                })
                .collect()
        };
        for (index, (key, value)) in entries.iter().enumerate() {
            let pair = anchor.from_value(&V::Array(vec![]))?;
            pair.set_element(0, anchor.from_value(&V::String(key.clone()))?)?;
            pair.set_element(1, self.read(&env, anchor, value)?)?;
            pairs.set_element(index as u32, pair)?;
        }
        Ok(pairs.raw())
    }

    // ── Turn runtime store ──
    /// Install the host clock (`Date.now` or a deterministic test clock).
    #[napi]
    pub fn turn_configure(&self, env: Env, now: Unknown<'_>) -> Result<()> {
        self.values.drain(&env)?;
        let captured = self.values.capture_host(&env, L::new(&env, now))?;
        *self.turn_now.borrow_mut() = Some(captured);
        Ok(())
    }
    #[napi]
    pub fn turn_claim(
        &self,
        env: Env,
        session: Unknown<'_>,
        turn: Unknown<'_>,
        meta: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let session_value = L::new(&env, session);
        let turn_value = L::new(&env, turn);
        let meta = L::new(&env, meta);
        // `String(sessionId || '').trim()`
        let session_key = truthy_string(session_value, "")?.trim();
        let turn_key = truthy_string(turn_value, "")?.trim();
        let previous = self.turn_entry(&session_key);
        if session_key.is_empty() || turn_key.is_empty() {
            return Ok(self
                .turn_result(
                    &env,
                    anchor,
                    false,
                    Some("invalid_identity"),
                    &previous.record,
                    previous.proof.as_ref(),
                )?
                .raw());
        }
        if previous.record.phase != Phase::Idle {
            return Ok(self
                .turn_result(
                    &env,
                    anchor,
                    false,
                    Some("turn_in_flight"),
                    &previous.record,
                    previous.proof.as_ref(),
                )?
                .raw());
        }
        let cli_value = prop(meta, c"cli")?;
        let transport_value = prop(meta, c"transport")?;
        let cli = truthy_string(cli_value, "claude")?;
        let transport = if transport_value.truthy()? {
            transport_value.coerce_string()?
        } else {
            JsString::from_rust_str(transport_of(&cli_value.coerce_string()?.to_string_lossy()))
        };
        let now = self.turn_clock(&env, anchor)?;
        let record = match chat_runtime::claim(
            &previous.record,
            session_key.clone(),
            turn_key,
            cli,
            transport,
            now,
        ) {
            Ok(record) => record,
            Err(failure) => {
                return Ok(self
                    .turn_result(
                        &env,
                        anchor,
                        false,
                        Some(failure.code()),
                        &previous.record,
                        previous.proof.as_ref(),
                    )?
                    .raw());
            }
        };
        // A new preparation lease starts without the previous turn's proof.
        self.turn_store(session_key, record.clone(), None);
        Ok(self
            .turn_result(&env, anchor, true, None, &record, None)?
            .raw())
    }
    #[napi]
    pub fn turn_mark_message_durable(
        &self,
        env: Env,
        session: Unknown<'_>,
        turn: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let session_key = self.key(L::new(&env, session))?;
        let turn_key = self.key(L::new(&env, turn))?;
        let entry = self.turn_entry(&session_key);
        let record = match chat_runtime::mark_message_durable(&entry.record, &turn_key) {
            Ok(record) => record,
            Err(failure) => {
                return Ok(self
                    .turn_result(
                        &env,
                        anchor,
                        false,
                        Some(failure.code()),
                        &entry.record,
                        entry.proof.as_ref(),
                    )?
                    .raw());
            }
        };
        self.turn_store(session_key, record.clone(), entry.proof.clone());
        Ok(self
            .turn_result(&env, anchor, true, None, &record, entry.proof.as_ref())?
            .raw())
    }
    #[napi]
    pub fn turn_mark_provider_route_resolved(
        &self,
        env: Env,
        session: Unknown<'_>,
        turn: Unknown<'_>,
        route: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let session_value = L::new(&env, session);
        let turn_value = L::new(&env, turn);
        let route = L::new(&env, route);
        let session_key = self.key(session_value)?;
        let turn_key = self.key(turn_value)?;
        let entry = self.turn_entry(&session_key);
        if let Err(failure) =
            chat_runtime::match_phase(&entry.record, &turn_key, &[Phase::Preparing])
        {
            return Ok(self
                .turn_result(
                    &env,
                    anchor,
                    false,
                    Some(failure.code()),
                    &entry.record,
                    entry.proof.as_ref(),
                )?
                .raw());
        }
        let resolved = prop(route, c"resolved")?.is_true()?;
        let proof_value = prop(route, c"proof")?;
        let owned = resolved
            && chat_runtime::owns_concrete_route_proof(&self.turn_route_proof(
                proof_value,
                session_value,
                turn_value,
            )?);
        if !owned {
            let reason = if resolved {
                JsString::from_rust_str("invalid-provider-route-proof")
            } else {
                truthy_string(prop(route, c"reason")?, "route-failed")?
            };
            return self.turn_settle_result(
                &env,
                anchor,
                session_key,
                turn_key,
                &[Phase::Preparing],
                JsString::from_rust_str("failed"),
                Some(reason),
            );
        }
        let record = match chat_runtime::mark_provider_route_resolved(&entry.record, &turn_key) {
            Ok(record) => record,
            Err(failure) => {
                return Ok(self
                    .turn_result(
                        &env,
                        anchor,
                        false,
                        Some(failure.code()),
                        &entry.record,
                        entry.proof.as_ref(),
                    )?
                    .raw());
            }
        };
        let proof = self.values.capture_host(&env, proof_value)?;
        self.turn_store(session_key, record.clone(), Some(proof.clone()));
        Ok(self
            .turn_result(&env, anchor, true, None, &record, Some(&proof))?
            .raw())
    }
    #[napi]
    pub fn turn_provider_route_failed(
        &self,
        env: Env,
        session: Unknown<'_>,
        turn: Unknown<'_>,
        reason: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let session_key = self.key(L::new(&env, session))?;
        let turn_key = self.key(L::new(&env, turn))?;
        let reason = L::new(&env, reason);
        let reason = if reason.undefined()? {
            Some(JsString::from_rust_str("route-failed"))
        } else {
            nullable_string(reason)?
        };
        self.turn_settle_result(
            &env,
            anchor,
            session_key,
            turn_key,
            &[Phase::Preparing],
            JsString::from_rust_str("failed"),
            reason,
        )
    }
    #[napi]
    pub fn turn_abort_preparation(
        &self,
        env: Env,
        session: Unknown<'_>,
        turn: Unknown<'_>,
        reason: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let session_key = self.key(L::new(&env, session))?;
        let turn_key = self.key(L::new(&env, turn))?;
        let reason = L::new(&env, reason);
        let reason = if reason.undefined()? {
            Some(JsString::from_rust_str("preparation-failed"))
        } else {
            nullable_string(reason)?
        };
        self.turn_settle_result(
            &env,
            anchor,
            session_key,
            turn_key,
            &[Phase::Preparing],
            JsString::from_rust_str("failed"),
            reason,
        )
    }
    #[napi]
    pub fn turn_settle(
        &self,
        env: Env,
        session: Unknown<'_>,
        turn: Unknown<'_>,
        outcome: Unknown<'_>,
        allowed: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let session_key = self.key(L::new(&env, session))?;
        let turn_key = self.key(L::new(&env, turn))?;
        let outcome = L::new(&env, outcome);
        let status = if outcome.nullish()? {
            JsString::from_rust_str("completed")
        } else {
            truthy_string(prop(outcome, c"status")?, "completed")?
        };
        let reason = if outcome.nullish()? {
            None
        } else {
            nullable_string(prop(outcome, c"reason")?)?
        };
        let phases = self.turn_allowed(L::new(&env, allowed))?;
        self.turn_settle_result(&env, anchor, session_key, turn_key, &phases, status, reason)
    }
    #[napi]
    pub fn turn_start(
        &self,
        env: Env,
        session: Unknown<'_>,
        turn: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let session_key = self.key(L::new(&env, session))?;
        let turn_key = self.key(L::new(&env, turn))?;
        let entry = self.turn_entry(&session_key);
        if let Err(failure) =
            chat_runtime::match_phase(&entry.record, &turn_key, &[Phase::Preparing])
        {
            return Ok(self
                .turn_result(
                    &env,
                    anchor,
                    false,
                    Some(failure.code()),
                    &entry.record,
                    entry.proof.as_ref(),
                )?
                .raw());
        }
        let mut missing: Vec<&'static str> = Vec::new();
        if !entry.record.message_durable {
            missing.push("durable-user-message");
        }
        if !entry.record.provider_route_resolved {
            missing.push("provider-route");
        }
        if !missing.is_empty() {
            let state = self.turn_state_value(&env, anchor, &entry.record, entry.proof.as_ref())?;
            let out = object(anchor)?;
            out.set(c"ok", anchor.from_value(&V::Bool(false))?)?;
            out.set(
                c"code",
                anchor.from_value(&V::string("spawn_proof_missing"))?,
            )?;
            let names = anchor.from_value(&V::Array(vec![]))?;
            for (index, name) in missing.iter().enumerate() {
                names.set_element(index as u32, anchor.from_value(&V::string(name))?)?;
            }
            out.set(c"missing", names.freeze()?)?;
            out.set(c"state", state)?;
            return Ok(out.freeze()?.raw());
        }
        // The oracle mutates the record before reading the clock, so a
        // re-entrant read observes `phase: 'running'` with `startedAt` still
        // null. Publish that interim state, then stamp the timestamp.
        let mut record = match chat_runtime::start(&entry.record, &turn_key, 0.0) {
            Ok(record) => record,
            Err(StartError::Transition(failure)) => {
                return Ok(self
                    .turn_result(
                        &env,
                        anchor,
                        false,
                        Some(failure.code()),
                        &entry.record,
                        entry.proof.as_ref(),
                    )?
                    .raw());
            }
            Err(StartError::Missing(_)) => {
                return Err(napi::Error::from_reason("turn start proof mismatch"));
            }
        };
        record.started_at = None;
        self.turn_store(session_key.clone(), record.clone(), entry.proof.clone());
        let now = self.turn_clock(&env, anchor)?;
        record.started_at = Some(now);
        self.turn_store(session_key, record.clone(), entry.proof.clone());
        Ok(self
            .turn_result(&env, anchor, true, None, &record, entry.proof.as_ref())?
            .raw())
    }
    #[napi]
    pub fn turn_begin_cleanup(
        &self,
        env: Env,
        session: Unknown<'_>,
        turn: Unknown<'_>,
        outcome: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let session_key = self.key(L::new(&env, session))?;
        let turn_key = self.key(L::new(&env, turn))?;
        let outcome = L::new(&env, outcome);
        let status = if outcome.nullish()? {
            JsString::from_rust_str("completed")
        } else {
            truthy_string(prop(outcome, c"status")?, "completed")?
        };
        let reason = if outcome.nullish()? {
            None
        } else {
            nullable_string(prop(outcome, c"reason")?)?
        };
        let entry = self.turn_entry(&session_key);
        if let Err(failure) = chat_runtime::match_phase(&entry.record, &turn_key, &[Phase::Running])
        {
            return Ok(self
                .turn_result(
                    &env,
                    anchor,
                    false,
                    Some(failure.code()),
                    &entry.record,
                    entry.proof.as_ref(),
                )?
                .raw());
        }
        // Same interim publication as `start`: the oracle flips the phase before
        // calling `now()`, so a re-entrant read sees finishing with no
        // `finishingAt`/`pendingOutcome` yet.
        let mut record = match chat_runtime::begin_cleanup(
            &entry.record,
            &turn_key,
            status.clone(),
            reason.clone(),
            0.0,
        ) {
            Ok(record) => record,
            Err(failure) => {
                return Ok(self
                    .turn_result(
                        &env,
                        anchor,
                        false,
                        Some(failure.code()),
                        &entry.record,
                        entry.proof.as_ref(),
                    )?
                    .raw());
            }
        };
        record.finishing_at = None;
        record.pending_outcome = None;
        self.turn_store(session_key.clone(), record.clone(), entry.proof.clone());
        let now = self.turn_clock(&env, anchor)?;
        record.finishing_at = Some(now);
        record.pending_outcome = Some(PendingOutcome { status, reason });
        self.turn_store(session_key, record.clone(), entry.proof.clone());
        Ok(self
            .turn_result(&env, anchor, true, None, &record, entry.proof.as_ref())?
            .raw())
    }
    #[napi]
    pub fn turn_cleanup(
        &self,
        env: Env,
        session: Unknown<'_>,
        turn: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let session_key = self.key(L::new(&env, session))?;
        let turn_key = self.key(L::new(&env, turn))?;
        let entry = self.turn_entry(&session_key);
        if let Err(failure) =
            chat_runtime::match_phase(&entry.record, &turn_key, &[Phase::Finishing])
        {
            return Ok(self
                .turn_result(
                    &env,
                    anchor,
                    false,
                    Some(failure.code()),
                    &entry.record,
                    entry.proof.as_ref(),
                )?
                .raw());
        }
        let now = self.turn_clock(&env, anchor)?;
        let record = match chat_runtime::cleanup(&entry.record, &turn_key, now) {
            Ok(record) => record,
            Err(failure) => {
                return Ok(self
                    .turn_result(
                        &env,
                        anchor,
                        false,
                        Some(failure.code()),
                        &entry.record,
                        entry.proof.as_ref(),
                    )?
                    .raw());
            }
        };
        self.turn_store(session_key, record.clone(), None);
        Ok(self
            .turn_result(&env, anchor, true, None, &record, None)?
            .raw())
    }
    #[napi]
    pub fn turn_claim_proof(
        &self,
        env: Env,
        session: Unknown<'_>,
        turn: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let session_value = L::new(&env, session);
        let turn_value = L::new(&env, turn);
        let session_key = self.key(session_value)?;
        let entry = self.turn_entry(&session_key);
        let claimed = match &entry.record.turn_id {
            Some(turn_id) if entry.record.phase != Phase::Idle => anchor
                .from_value(&V::String(turn_id.clone()))?
                .equals(turn_value)?,
            _ => false,
        };
        let out = object(anchor)?;
        out.set(c"kind", anchor.from_value(&V::string("runtime-claim"))?)?;
        out.set(c"sessionId", session_value)?;
        out.set(c"turnId", turn_value)?;
        out.set(c"claimed", anchor.from_value(&V::Bool(claimed))?)?;
        Ok(out.freeze()?.raw())
    }
    #[napi]
    pub fn turn_snapshot(&self, env: Env, session: Unknown<'_>) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let session_key = self.key(L::new(&env, session))?;
        let entry = self.turn_entry(&session_key);
        Ok(self
            .turn_state_value(&env, anchor, &entry.record, entry.proof.as_ref())?
            .raw())
    }
    #[napi]
    pub fn turn_list(&self, env: Env) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let anchor = self.values.anchor(&env)?;
        let entries: Vec<RuntimeEntry> = {
            let table = self.runtime.borrow();
            table
                .order
                .iter()
                .filter_map(|id| table.map.get(id).cloned())
                .collect()
        };
        let list = anchor.from_value(&V::Array(vec![]))?;
        for (index, entry) in entries.iter().enumerate() {
            let state = self.turn_state_value(&env, anchor, &entry.record, entry.proof.as_ref())?;
            list.set_element(index as u32, state)?;
        }
        Ok(list.freeze()?.raw())
    }
}

// napi emits its registration (`cfg(not(test))`) only for non-test builds, so
// the test build sees no Rust caller for exports that JS calls by name.
#[napi]
#[cfg_attr(test, allow(dead_code))]
pub fn session_records_protocol_version() -> u32 {
    1
}

/// `TASK_STATE_DEFAULTS` for the JS export, built from the same core rule the
/// record owner merges with, so the two can never drift.
#[napi]
#[cfg_attr(test, allow(dead_code))]
pub fn session_records_task_state_defaults(env: Env) -> Result<sys::napi_value> {
    unsafe { crate::js_bridge::write_value(env.raw(), &task_state_defaults()) }
}
