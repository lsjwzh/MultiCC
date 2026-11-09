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
}

#[napi]
impl RustSessionRecords {
    #[napi(constructor)]
    pub fn new(env: Env, anchor: Unknown<'_>) -> Result<Self> {
        Ok(Self {
            table: RefCell::new(Table::new()),
            dirs: RefCell::new(Table::new()),
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
    #[napi]
    pub fn init(&self, env: Env, entries: Unknown<'_>) -> Result<()> {
        self.values.drain(&env)?;
        let entries = L::new(&env, entries);
        let mut inserted: Vec<(JsString, Value)> = Vec::new();
        entries.for_each(|pair| {
            let key = self.key(pair.element(0)?)?;
            let record = pair.element(1)?;
            inserted.push((key, self.values.capture(&env, record)?));
            Ok(())
        })?;
        let mut table = self.table.borrow_mut();
        table.clear();
        for (key, value) in inserted {
            table.set(key, value);
        }
        Ok(())
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
}

#[napi]
pub fn session_records_protocol_version() -> u32 {
    1
}

/// `TASK_STATE_DEFAULTS` for the JS export, built from the same core rule the
/// record owner merges with, so the two can never drift.
#[napi]
pub fn session_records_task_state_defaults(env: Env) -> Result<sys::napi_value> {
    unsafe { crate::js_bridge::write_value(env.raw(), &task_state_defaults()) }
}
