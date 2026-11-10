//! napi owner of the background-task turn-engine runtime.
//!
//! The JavaScript facade in `src/chat/background-task-runtime.js` only forwards
//! arguments, supplies host ports and arms one unref'd timer. All bookkeeping
//! (shadows, timed liveness marks, origins, owned tasks, metadata, native
//! sub-tasks and the completion coalescer) lives here.
//!
//! Ports arrive per call; no host function or object is retained by the class.
//! Every port call happens with no `RefCell` borrow held, so a host callback can
//! re-enter the owner safely.
use crate::js_live::LiveValue as L;
use multicc_core::background::{
    coalescer::{self, Coalescer, Item, DEFAULT_WINDOW_MS},
    metadata::{MetaInput, MetaStore},
    native_tasks::{NativeOutcome, NativeStore},
    snippet,
    state::{
        is_object_like, js_max, metadata_text, or_empty, own_entries, safe_description, spread,
        string_or_empty, OrderedMap, OrderedSet,
    },
};
use multicc_core::js::{
    coerce::{js_to_number, js_to_string, truthy},
    string::JsString,
    JsValue as V,
};
use napi::{
    bindgen_prelude::{JsValue as _, Unknown},
    sys, Env, Result,
};
use napi_derive::napi;
use std::{cell::RefCell, collections::VecDeque, ffi::CStr};

/// Poll interval for a writer shadow. `tail -F` reported a line as soon as it
/// was written; polling adds at most this much latency (documented difference).
const SHADOW_POLL_MS: f64 = 500.0;
/// A finished Monitor keeps its process considered alive this long so a late
/// hook can still deliver the terminal report.
const TERMINAL_DRAIN_MS: f64 = 5000.0;
const DEFAULT_PROGRESS_THROTTLE_MS: f64 = 5000.0;
const DEFAULT_DEDUP_TTL_MS: f64 = 5.0 * 60.0 * 1000.0;
const DEFAULT_LIVENESS_TTL_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
const DEFAULT_MAIN_TOOL_USE_CAP: f64 = 2000.0;
const DEFAULT_OUTPUT_CAP: f64 = 2000.0;

fn read(env: Env, value: Unknown<'_>) -> Result<V> {
    unsafe { crate::js_bridge::read_value(env.raw(), value.raw(), 0, &mut Vec::new()) }
}

fn write(env: Env, value: &V) -> Result<sys::napi_value> {
    unsafe { crate::js_bridge::write_value(env.raw(), value) }
}

fn key(name: &str) -> JsString {
    JsString::from_rust_str(name)
}

fn pair(name: &str, value: V) -> (JsString, V) {
    (key(name), value)
}

fn obj(entries: Vec<(&str, V)>) -> V {
    V::Object(
        entries
            .into_iter()
            .map(|(name, value)| pair(name, value))
            .collect(),
    )
}

fn jobj(entries: Vec<(JsString, V)>) -> V {
    V::Object(entries)
}

fn handled(value: bool) -> V {
    obj(vec![("handled", V::Bool(value))])
}

fn handled_decision(decision: &str) -> V {
    obj(vec![
        ("handled", V::Bool(true)),
        ("decision", V::string(decision)),
    ])
}

fn monitor_decision(decision: &str) -> V {
    obj(vec![
        ("handled", V::Bool(true)),
        ("monitorOwned", V::Bool(true)),
        ("decision", V::string(decision)),
    ])
}

fn monitor_owned() -> V {
    obj(vec![
        ("handled", V::Bool(true)),
        ("monitorOwned", V::Bool(true)),
    ])
}

fn truthy_opt(value: Option<&V>) -> bool {
    value.is_some_and(truthy)
}

fn selected(value: Option<&V>) -> Option<&V> {
    value.filter(|value| truthy(value))
}

/// `value || fallback` as a raw JavaScript value.
fn value_or(value: Option<&V>, fallback: V) -> V {
    match selected(value) {
        Some(value) => value.clone(),
        None => fallback,
    }
}

/// First truthy of a chain of raw values (`a || b || c`).
fn first_truthy<'a>(values: &[Option<&'a V>]) -> Option<&'a V> {
    values.iter().copied().flatten().find(|value| truthy(value))
}

#[derive(Clone, Copy, Debug)]
struct Options {
    progress_throttle_ms: f64,
    dedup_ttl_ms: f64,
    liveness_ttl_ms: f64,
    main_tool_use_cap: f64,
    output_cap: f64,
    completion_window_ms: f64,
}

fn positive_number(value: Option<&V>, fallback: f64) -> f64 {
    match value {
        Some(V::Number(number)) if number.is_finite() && *number > 0.0 => *number,
        _ => fallback,
    }
}

impl Options {
    fn from_value(value: &V) -> Self {
        // `createCoalescer` defaults the window only for `undefined`; `null`
        // and non-numeric values become zero, exactly like the old timer.
        let window = match value.get("completionWindowMs") {
            None | Some(V::Undefined) => DEFAULT_WINDOW_MS,
            Some(V::Null) => 0.0,
            Some(other) => {
                let number = js_to_number(other);
                if number.is_nan() {
                    0.0
                } else {
                    number
                }
            }
        };
        Self {
            progress_throttle_ms: positive_number(
                value.get("progressThrottleMs"),
                DEFAULT_PROGRESS_THROTTLE_MS,
            ),
            dedup_ttl_ms: positive_number(value.get("dedupTtlMs"), DEFAULT_DEDUP_TTL_MS),
            liveness_ttl_ms: positive_number(value.get("livenessTtlMs"), DEFAULT_LIVENESS_TTL_MS),
            main_tool_use_cap: positive_number(
                value.get("mainToolUseCap"),
                DEFAULT_MAIN_TOOL_USE_CAP,
            ),
            output_cap: positive_number(value.get("outputCap"), DEFAULT_OUTPUT_CAP),
            completion_window_ms: window,
        }
    }
}

/// Per-session `Map<String(taskId), timestamp>` with lazy TTL expiry.
#[derive(Clone, Debug, Default)]
struct TimedStore {
    ttl: f64,
    map: OrderedMap<OrderedMap<f64>>,
}

impl TimedStore {
    fn new(ttl: f64) -> Self {
        Self {
            ttl,
            map: OrderedMap::new(),
        }
    }

    fn entries<'a>(&'a mut self, session: &JsString) -> &'a mut OrderedMap<f64> {
        if !self.map.contains_key(session) {
            self.map.set(session.clone(), OrderedMap::new());
        }
        self.map.get_mut(session).expect("inserted above")
    }

    fn prune(&mut self, session: &JsString, now: f64) {
        let ttl = self.ttl;
        let Some(entries) = self.map.get_mut(session) else {
            return;
        };
        for name in entries.keys_vec() {
            if entries.get(&name).is_some_and(|at| now - at > ttl) {
                entries.delete(&name);
            }
        }
    }

    fn tag(&mut self, session: &JsString, task: &JsString, now: f64) -> bool {
        self.prune(session, now);
        self.entries(session).set(task.clone(), now);
        true
    }

    fn has(&mut self, session: &JsString, task: &JsString, now: f64) -> bool {
        let ttl = self.ttl;
        let Some(entries) = self.map.get_mut(session) else {
            return false;
        };
        let Some(at) = entries.get(task).copied() else {
            return false;
        };
        if now - at > ttl {
            entries.delete(task);
            if entries.is_empty() {
                self.map.delete(session);
            }
            return false;
        }
        true
    }

    fn consume(&mut self, session: &JsString, task: &JsString) -> bool {
        let Some(entries) = self.map.get_mut(session) else {
            return false;
        };
        let deleted = entries.delete(task).is_some();
        if entries.is_empty() {
            self.map.delete(session);
        }
        deleted
    }
}

#[derive(Clone, Debug)]
struct Shadow {
    task_id: V,
    output_file: V,
    description: V,
    offset: usize,
    last_progress_at: f64,
    next_poll_at: f64,
}

#[derive(Clone, Debug)]
struct Watch {
    live: bool,
    description: V,
    tool_use_id: Option<V>,
    ended_at: Option<f64>,
    terminal_handled: bool,
    terminal_queued: bool,
}

#[derive(Clone, Debug)]
struct Origin {
    turn_id: JsString,
    /// Kept for parity with the ledger record; classification only needs the
    /// turn id.
    #[allow(dead_code)]
    tool_use_id: Option<JsString>,
}

#[derive(Clone, Debug)]
struct Owned {
    at: f64,
    delivered: bool,
    description: JsString,
}

#[derive(Clone, Debug, Default)]
struct MainToolUses {
    set: OrderedSet,
    order: VecDeque<JsString>,
}

#[derive(Debug)]
struct State {
    options: Options,
    shadows: OrderedMap<OrderedMap<Shadow>>,
    task_output_awaiting: TimedStore,
    sync_bash: TimedStore,
    subagent: TimedStore,
    monitor: TimedStore,
    monitor_watches: OrderedMap<OrderedMap<Watch>>,
    monitor_events: TimedStore,
    task_origins: OrderedMap<OrderedMap<Origin>>,
    owned: OrderedMap<OrderedMap<Owned>>,
    stopped_notes: OrderedMap<Vec<JsString>>,
    main_tool_uses: OrderedMap<MainToolUses>,
    known_sessions: OrderedSet,
    session_values: OrderedMap<V>,
    native: NativeStore,
    metadata: MetaStore,
    coalescer: Coalescer,
    item_seq: u64,
}

impl State {
    fn new(options: Options) -> Self {
        Self {
            options,
            shadows: OrderedMap::new(),
            task_output_awaiting: TimedStore::new(options.dedup_ttl_ms),
            sync_bash: TimedStore::new(options.liveness_ttl_ms),
            subagent: TimedStore::new(options.liveness_ttl_ms),
            monitor: TimedStore::new(options.liveness_ttl_ms),
            monitor_watches: OrderedMap::new(),
            monitor_events: TimedStore::new(options.dedup_ttl_ms),
            task_origins: OrderedMap::new(),
            owned: OrderedMap::new(),
            stopped_notes: OrderedMap::new(),
            main_tool_uses: OrderedMap::new(),
            known_sessions: OrderedSet::new(),
            session_values: OrderedMap::new(),
            native: NativeStore::new(),
            metadata: MetaStore::new(),
            coalescer: Coalescer::new(options.completion_window_ms),
            item_seq: 0,
        }
    }

    fn remember_session(&mut self, name: &JsString, raw: &V) {
        if !self.session_values.contains_key(name) {
            self.session_values.set(name.clone(), raw.clone());
        }
    }

    /// The raw session value used as the first argument of `broadcast` and
    /// `deliverSystem` (the legacy code reused whatever the caller passed).
    fn session_value(&self, name: &JsString) -> V {
        self.session_values
            .get(name)
            .cloned()
            .unwrap_or_else(|| V::String(name.clone()))
    }

    fn next_token(&mut self) -> u64 {
        self.item_seq += 1;
        self.item_seq
    }

    fn nested<'a, T>(
        map: &'a mut OrderedMap<OrderedMap<T>>,
        name: &JsString,
    ) -> &'a mut OrderedMap<T> {
        if !map.contains_key(name) {
            map.set(name.clone(), OrderedMap::new());
        }
        map.get_mut(name).expect("inserted above")
    }

    fn nested_ref<'a, T>(
        map: &'a OrderedMap<OrderedMap<T>>,
        name: &JsString,
    ) -> Option<&'a OrderedMap<T>> {
        map.get(name)
    }

    fn own_task(&mut self, session: &JsString, task: &JsString, description: Option<&V>, now: f64) {
        let liveness = self.options.liveness_ttl_ms;
        let entries = Self::nested(&mut self.owned, session);
        for name in entries.keys_vec() {
            if entries
                .get(&name)
                .is_some_and(|entry| now - entry.at > liveness)
            {
                entries.delete(&name);
            }
        }
        entries.set(
            task.clone(),
            Owned {
                at: now,
                delivered: false,
                description: safe_description(description, ""),
            },
        );
    }

    fn owned_task(&self, session: &JsString, task: &JsString, now: f64) -> Option<Owned> {
        let liveness = self.options.liveness_ttl_ms;
        Self::nested_ref(&self.owned, session)
            .and_then(|entries| entries.get(task))
            .filter(|entry| now - entry.at <= liveness)
            .cloned()
    }

    fn stop_session(&mut self, session: &JsString) -> u32 {
        let killed = self
            .shadows
            .get(session)
            .map_or(0, |shadows| shadows.len() as u32);
        self.shadows.delete(session);
        self.coalescer.cancel(session);
        self.native.stop(session);
        self.metadata.clear(session);
        self.task_output_awaiting.map.delete(session);
        self.sync_bash.map.delete(session);
        self.subagent.map.delete(session);
        self.monitor.map.delete(session);
        self.monitor_watches.delete(session);
        self.monitor_events.map.delete(session);
        self.task_origins.delete(session);
        self.owned.delete(session);
        self.stopped_notes.delete(session);
        self.main_tool_uses.delete(session);
        self.known_sessions.delete(session);
        self.session_values.delete(session);
        killed
    }
}

/// Host callbacks, read lazily from one per-call object.
struct Ports<'a> {
    anchor: L<'a>,
}

impl<'a> Ports<'a> {
    fn new(env: &'a Env, ports: Unknown<'a>) -> Self {
        Self {
            anchor: L::new(env, ports),
        }
    }

    fn function(&self, name: &CStr) -> Result<L<'a>> {
        self.anchor.get(name)
    }

    fn value(&self, value: &V) -> Result<L<'a>> {
        self.anchor.from_value(value)
    }

    fn call(&self, name: &CStr, arguments: &[L<'a>]) -> Result<L<'a>> {
        self.function(name)?.call_plain(arguments)
    }

    fn read_live(&self, value: L<'a>) -> Result<V> {
        unsafe { crate::js_bridge::read_value(value.env(), value.raw(), 0, &mut Vec::new()) }
    }

    fn now(&self) -> Result<f64> {
        self.call(c"now", &[])?.number()
    }

    fn broadcast(&self, session: &L<'a>, frame: &V) -> Result<()> {
        self.call(c"broadcast", &[*session, self.value(frame)?])?;
        Ok(())
    }

    fn observe(&self, observation: &V, label: &str) -> Result<()> {
        self.call(
            c"observe",
            &[self.value(observation)?, self.value(&V::string(label))?],
        )?;
        Ok(())
    }

    fn note_result_injected(&self, session: &L<'a>) -> Result<()> {
        self.call(c"noteBgResultInjected", &[*session])?;
        Ok(())
    }

    fn deliver_completed(&self, session: &L<'a>, nudge: &JsString, origin: &V) -> Result<()> {
        self.call(
            c"deliverSystem",
            &[
                *session,
                self.value(&V::String(nudge.clone()))?,
                self.value(origin)?,
            ],
        )?;
        Ok(())
    }

    fn log_warn(&self, message: &str, error: L<'a>) -> Result<()> {
        self.call(c"logWarn", &[self.value(&V::string(message))?, error])?;
        Ok(())
    }

    fn safe_text(&self, value: Option<&V>) -> Result<JsString> {
        let argument = self.value(value.unwrap_or(&V::Undefined))?;
        self.call(c"safeText", &[argument])?.coerce_string()
    }

    fn redact_event(&self, value: L<'a>) -> Result<V> {
        let redacted = self.call(c"redactEvent", &[value])?;
        self.read_live(redacted)
    }

    fn request_enrich(
        &self,
        session: &L<'a>,
        task_id: &V,
        token: u64,
        has_own_result: bool,
    ) -> Result<()> {
        self.call(
            c"requestEnrich",
            &[
                *session,
                self.value(task_id)?,
                self.value(&V::Number(token as f64))?,
                self.value(&V::Bool(has_own_result))?,
            ],
        )?;
        Ok(())
    }

    fn request_stop_task(&self, session: &L<'a>, task_id: &V) -> Result<()> {
        self.call(c"requestStopTask", &[*session, self.value(task_id)?])?;
        Ok(())
    }

    fn exception(&self) -> Result<L<'a>> {
        Ok(match self.anchor.exception_value()? {
            Some(exception) => exception,
            None => self.value(&V::Undefined)?,
        })
    }

    /// A JavaScript try/catch around one port call.
    fn call_caught(
        &self,
        function: L<'a>,
        arguments: &[L<'a>],
    ) -> Result<std::result::Result<L<'a>, L<'a>>> {
        match function.call_plain(arguments) {
            Ok(value) => Ok(Ok(value)),
            Err(_) => Ok(Err(self.exception()?)),
        }
    }
}

/// `chatState && chatState[key]` read once through the bridge.
fn chat_property(env: Env, chat: &L<'_>, name: &CStr) -> Result<V> {
    if !chat.truthy()? {
        return Ok(V::Undefined);
    }
    let value = chat.optional(name)?;
    unsafe { crate::js_bridge::read_value(env.raw(), value.raw(), 0, &mut Vec::new()) }
}

/// `chatState?.isStreaming === true`.
fn chat_streaming(chat: &L<'_>) -> Result<bool> {
    chat.optional(c"isStreaming")?.is_true()
}

/// `String(chatState && chatState._activeTurn && chatState._activeTurn.turnId || '').trim()`.
fn active_turn_id(chat: &L<'_>) -> Result<JsString> {
    let mut text = JsString::new();
    if chat.truthy()? {
        let active = chat.optional(c"_activeTurn")?;
        if active.truthy()? {
            let value = active.optional(c"turnId")?;
            if value.truthy()? {
                text = value.coerce_string()?;
            }
        }
    }
    Ok(text.trim())
}

/// `Array.isArray(chatState && chatState.currentToolCalls)` then a strict-id
/// `find`. The matched object is read once as a plain value. A missing
/// `tool_use_id` stays `undefined`, so a tool call without an id can still be
/// matched exactly like the old `find(item => item.id === toolUseId)`.
fn find_tool(env: Env, chat: &L<'_>, tool_use_id: Option<&V>) -> Result<Option<V>> {
    if !chat.truthy()? {
        return Ok(None);
    }
    let calls = chat.optional(c"currentToolCalls")?;
    if !calls.is_array()? {
        return Ok(None);
    }
    let wanted = chat.from_value(tool_use_id.unwrap_or(&V::Undefined))?;
    let mut found: Option<V> = None;
    calls.for_each(|item| {
        if found.is_none() && item.truthy()? && item.optional(c"id")?.equals(wanted)? {
            found = Some(unsafe {
                crate::js_bridge::read_value(env.raw(), item.raw(), 0, &mut Vec::new())
            }?);
        }
        Ok(())
    })?;
    Ok(found)
}

fn tool_name(tool: Option<&V>) -> Option<JsString> {
    match tool.and_then(|tool| tool.get("name")) {
        Some(V::String(name)) => Some(name.clone()),
        _ => None,
    }
}

fn tool_input(tool: Option<&V>) -> Option<&V> {
    tool.and_then(|tool| tool.get("input"))
        .filter(|input| truthy(input))
}

fn input_field<'a>(input: Option<&'a V>, name: &str) -> Option<&'a V> {
    input.and_then(|input| input.get(name))
}

fn replace_path_units(value: &JsString) -> JsString {
    JsString::from_units(
        value
            .as_units()
            .iter()
            .map(|unit| {
                if *unit == 0x2f || *unit == 0x2e {
                    0x2d
                } else {
                    *unit
                }
            })
            .collect(),
    )
}

fn split_trim_nonempty(text: &JsString) -> Vec<JsString> {
    let mut lines = Vec::new();
    for line in text
        .as_units()
        .split(|unit| *unit == 0x0a)
        .map(|units| JsString::from_units(units.to_vec()))
    {
        let line = line.trim();
        if !line.is_empty() {
            lines.push(line);
        }
    }
    lines
}

#[napi]
pub struct RustBackgroundTasks {
    state: RefCell<State>,
}

#[napi]
impl RustBackgroundTasks {
    #[napi(constructor)]
    pub fn new(env: Env, options: Unknown<'_>) -> Result<Self> {
        let options = Options::from_value(&read(env, options)?);
        Ok(Self {
            state: RefCell::new(State::new(options)),
        })
    }

    #[napi]
    pub fn handle_event(
        &self,
        env: Env,
        ports: Unknown<'_>,
        session: Unknown<'_>,
        chat_state: Unknown<'_>,
        event: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let session_value = read(env, session)?;
        if !truthy(&session_value) {
            return write(env, &handled(false));
        }
        let raw_event = read(env, event)?;
        if !truthy(&raw_event) || !is_object_like(&raw_event) {
            return write(env, &handled(false));
        }
        let ports = Ports::new(&env, ports);
        let session_l = L::new(&env, session);
        let chat = L::new(&env, chat_state);
        // Redaction is the first port call, exactly like the old handler.
        let event = ports.redact_event(L::new(&env, event))?;
        let session_key = js_to_string(&session_value);
        {
            let mut state = self.state.borrow_mut();
            state.known_sessions.insert(session_key.clone());
            state.remember_session(&session_key, &session_value);
        }
        let subtype_raw = value_or(event.get("subtype"), V::string(""));
        let subtype = js_to_string(&subtype_raw);
        let subtype_text = subtype.to_string_lossy();
        if matches!(
            subtype_text.as_str(),
            "task_started" | "task_progress" | "task_updated" | "task_notification"
        ) && !self
            .state
            .borrow_mut()
            .metadata
            .remember(&session_key, &MetaInput::from_value(&event))
        {
            return write(env, &handled_decision("stale-run"));
        }
        if let Some(result) = self.handle_native(&ports, &session_l, &session_key, &event)? {
            return write(env, &result);
        }
        let result = match subtype_text.as_str() {
            "monitor_prompt" => {
                self.handle_monitor_prompt(env, &ports, &session_l, &session_key, &chat, &event)?
            }
            "task_started" => {
                self.handle_started(env, &ports, &session_l, &session_key, &chat, &event)?
            }
            "task_progress" | "task_updated" => {
                self.handle_progress(&ports, &session_l, &session_key, &event)?
            }
            "task_notification" => {
                self.handle_completion(env, &ports, &session_l, &session_key, &chat, &event)?
            }
            "background_tasks_changed" => {
                self.handle_tasks_changed(&ports, &session_l, &session_key, &event)?
            }
            _ => handled(false),
        };
        write(env, &result)
    }

    fn handle_native(
        &self,
        ports: &Ports<'_>,
        session: &L<'_>,
        session_key: &JsString,
        event: &V,
    ) -> Result<Option<V>> {
        let subtype = js_to_string(&value_or(event.get("subtype"), V::string("")));
        let subtype_text = subtype.to_string_lossy();
        let done = match subtype_text.as_str() {
            "codex_task_started" | "codex_task_progress" => false,
            "codex_task_done" => true,
            _ => return Ok(None),
        };
        let started = subtype_text == "codex_task_started";
        let Some(task_id) = selected(event.get("task_id")).cloned() else {
            return Ok(None);
        };
        let id = js_to_string(&task_id);
        let heartbeat = truthy_opt(event.get("heartbeat"));
        let tool = matches!(selected(event.get("kind")), Some(V::String(kind)) if kind == "tool");
        let mut description = ports.safe_text(event.get("description"))?;
        if description.is_empty() {
            description = JsString::from_rust_str("Codex 子任务");
        }
        let now = ports.now()?;
        let outcome = self.state.borrow_mut().native.apply(
            session_key,
            &id,
            done,
            started,
            heartbeat,
            event.get("status"),
            tool,
            description,
            now,
        );
        let (changed, frame_type, status, task) = match outcome {
            NativeOutcome::Unchanged => {
                return Ok(Some(obj(vec![
                    ("handled", V::Bool(true)),
                    ("changed", V::Bool(false)),
                ])))
            }
            NativeOutcome::Applied {
                changed,
                frame_type,
                status,
                task,
            } => (changed, frame_type, status, task),
        };
        if !heartbeat {
            let observation = obj(vec![
                ("sessionId", V::String(session_key.clone())),
                ("taskId", V::String(id.clone())),
                ("status", V::String(status.clone())),
                (
                    "detail",
                    obj(vec![
                        ("description", V::String(task.description.clone())),
                        (
                            "kind",
                            V::string(if task.tool {
                                "codex-tool"
                            } else {
                                "codex-agent"
                            }),
                        ),
                    ]),
                ),
            ]);
            ports.observe(
                &observation,
                &format!("原生后台任务 {}", id.to_string_lossy()),
            )?;
        }
        let mut frame = vec![
            pair("type", V::string(frame_type)),
            pair("task_id", V::String(id.clone())),
            pair("description", V::String(task.description.clone())),
        ];
        if done {
            frame.push(pair("summary", V::String(task.description.clone())));
        }
        frame.push(pair("status", V::String(status)));
        frame.push(pair("background", V::Bool(true)));
        ports.broadcast(session, &jobj(frame))?;
        self.state.borrow_mut().native.evict(session_key);
        if changed {
            let tasks = self.active_rows(ports, session_key)?;
            ports.broadcast(
                session,
                &obj(vec![
                    ("type", V::string("background_tasks")),
                    ("tasks", V::Array(tasks)),
                ]),
            )?;
        }
        Ok(Some(obj(vec![
            ("handled", V::Bool(true)),
            ("changed", V::Bool(changed)),
        ])))
    }

    fn handle_started(
        &self,
        env: Env,
        ports: &Ports<'_>,
        session: &L<'_>,
        session_key: &JsString,
        chat: &L<'_>,
        event: &V,
    ) -> Result<V> {
        let Some(task_id) = selected(event.get("task_id")).cloned() else {
            return Ok(handled(false));
        };
        let task_key = js_to_string(&task_id);
        let tool_use_id = event.get("tool_use_id").cloned();
        let tool = find_tool(env, chat, tool_use_id.as_ref())?;
        let input = tool_input(tool.as_ref());
        let name = tool_name(tool.as_ref());
        let command = input_field(input, "command")
            .filter(|value| truthy(value))
            .cloned()
            .unwrap_or_else(|| V::string(""));
        let sync = name.as_ref().is_some_and(|name| name == "Bash")
            && !truthy_opt(input_field(input, "run_in_background"));
        let monitor = name.as_ref().is_some_and(|name| name == "Monitor");
        let persistent_monitor = monitor
            && input_field(input, "persistent").is_some_and(|value| matches!(value, V::Bool(true)));
        let subagent = tool_use_id.as_ref().is_some_and(truthy) && tool.is_none();
        {
            // `{...event, subagent_type: event.subagent_type || tool?.input?.subagent_type}`
            let mut meta = MetaInput::from_value(event);
            if !truthy_opt(event.get("subagent_type")) {
                if let Some(value) = input_field(input, "subagent_type") {
                    if truthy(value) {
                        meta.fields[2] = metadata_text(Some(value));
                    }
                }
            }
            self.state
                .borrow_mut()
                .metadata
                .remember(session_key, &meta);
        }
        let origin = self.record_task_origin(chat, session_key, &task_key, tool_use_id.as_ref())?;
        if sync {
            let now = ports.now()?;
            self.state
                .borrow_mut()
                .sync_bash
                .tag(session_key, &task_key, now);
        }
        if monitor {
            let now = ports.now()?;
            let mut state = self.state.borrow_mut();
            state.monitor.tag(session_key, &task_key, now);
            let dedup = state.options.dedup_ttl_ms;
            let watches = State::nested(&mut state.monitor_watches, session_key);
            for id in watches.keys_vec() {
                let expired = watches.get(&id).is_some_and(|watch| {
                    !watch.live && watch.ended_at.is_some_and(|ended| now - ended > dedup)
                });
                if expired {
                    watches.delete(&id);
                }
            }
            watches.set(
                task_key.clone(),
                Watch {
                    live: true,
                    description: or_empty(event.get("description")),
                    tool_use_id: tool_use_id.clone().filter(truthy),
                    ended_at: None,
                    terminal_handled: false,
                    terminal_queued: false,
                },
            );
        }
        if subagent {
            let now = ports.now()?;
            self.state
                .borrow_mut()
                .subagent
                .tag(session_key, &task_key, now);
        }
        if !sync && !monitor && !subagent {
            let now = ports.now()?;
            self.state
                .borrow_mut()
                .own_task(session_key, &task_key, event.get("description"), now);
        }
        let cwd = chat_property(env, chat, c"cwd")?;
        let output_file =
            self.monitor_output_file_path(ports, event.get("session_id"), &task_id, Some(&cwd))?;
        let kind = if sync {
            "sync-bash"
        } else if persistent_monitor {
            "monitor-persistent"
        } else if monitor {
            "monitor"
        } else if subagent {
            "agent-task"
        } else {
            "background-task"
        };
        let fields = self
            .state
            .borrow()
            .metadata
            .fields_entries(session_key, &task_id);
        let description = value_or(event.get("description"), V::string(""));
        let mut detail = vec![
            pair("kind", V::string(kind)),
            pair("description", description.clone()),
            pair("toolUseId", value_or(tool_use_id.as_ref(), V::Null)),
            pair(
                "originTurnId",
                origin
                    .as_ref()
                    .map(|origin| V::String(origin.turn_id.clone()))
                    .unwrap_or(V::Null),
            ),
            pair(
                "outputFile",
                output_file
                    .as_ref()
                    .map(|path| V::String(path.clone()))
                    .unwrap_or(V::Null),
            ),
        ];
        detail.extend(fields.iter().cloned());
        let observation = obj(vec![
            ("sessionId", V::String(session_key.clone())),
            ("taskId", task_id.clone()),
            ("status", V::string("running")),
            ("detail", jobj(detail)),
        ]);
        ports.observe(
            &observation,
            &format!("task ledger start {}", task_key.to_string_lossy()),
        )?;
        let mut frame = vec![
            pair("type", V::string("monitor_started")),
            pair("task_id", task_id.clone()),
        ];
        frame.extend(fields);
        frame.push(pair("description", description));
        frame.push(pair("command", command));
        frame.push(pair("background", V::Bool(!sync)));
        ports.broadcast(session, &jobj(frame))?;
        if !monitor {
            self.start_shadow(
                session_key,
                &task_id,
                output_file.as_ref(),
                event.get("description"),
            );
        }
        Ok(obj(vec![
            ("handled", V::Bool(true)),
            ("kind", V::string(kind)),
        ]))
    }

    fn record_task_origin(
        &self,
        chat: &L<'_>,
        session_key: &JsString,
        task_key: &JsString,
        tool_use_id: Option<&V>,
    ) -> Result<Option<Origin>> {
        let turn_id = active_turn_id(chat)?;
        if turn_id.is_empty() {
            return Ok(None);
        }
        let origin = Origin {
            turn_id,
            tool_use_id: tool_use_id.filter(|value| truthy(value)).map(js_to_string),
        };
        let mut state = self.state.borrow_mut();
        state.known_sessions.insert(session_key.clone());
        State::nested(&mut state.task_origins, session_key).set(task_key.clone(), origin.clone());
        Ok(Some(origin))
    }

    fn start_shadow(
        &self,
        session_key: &JsString,
        task_id: &V,
        output_file: Option<&JsString>,
        description: Option<&V>,
    ) {
        let Some(output_file) = output_file else {
            return;
        };
        if !truthy(task_id) {
            return;
        }
        let id = js_to_string(task_id);
        let mut state = self.state.borrow_mut();
        state.known_sessions.insert(session_key.clone());
        let shadows = State::nested(&mut state.shadows, session_key);
        if shadows.contains_key(&id) {
            return;
        }
        shadows.set(
            id,
            Shadow {
                task_id: task_id.clone(),
                output_file: V::String(output_file.clone()),
                description: or_empty(description),
                offset: 0,
                last_progress_at: f64::NEG_INFINITY,
                // Poll at the next tick; the facade derives its delay from
                // `nextDue`.
                next_poll_at: 0.0,
            },
        );
    }

    fn stop_shadow(&self, session_key: &JsString, task_key: &JsString) -> bool {
        let mut state = self.state.borrow_mut();
        let Some(shadows) = state.shadows.get_mut(session_key) else {
            return false;
        };
        let removed = shadows.delete(task_key).is_some();
        if shadows.is_empty() {
            state.shadows.delete(session_key);
        }
        removed
    }

    fn is_background_shadow(&self, session_key: &JsString, task_key: &JsString, now: f64) -> bool {
        !self
            .state
            .borrow_mut()
            .sync_bash
            .has(session_key, task_key, now)
    }

    fn handle_progress(
        &self,
        ports: &Ports<'_>,
        session: &L<'_>,
        session_key: &JsString,
        event: &V,
    ) -> Result<V> {
        let Some(task_id) = selected(event.get("task_id")).cloned() else {
            return Ok(handled(false));
        };
        let task_key = js_to_string(&task_id);
        let patch_status = event
            .get("patch")
            .filter(|value| !value.is_nullish())
            .and_then(|patch| patch.get("status"));
        let status =
            snippet::status_for_progress(first_truthy(&[event.get("status"), patch_status]));
        let fields = self
            .state
            .borrow()
            .metadata
            .fields_entries(session_key, &task_id);
        let mut detail = vec![
            pair(
                "description",
                value_or(
                    first_truthy(&[event.get("description"), event.get("summary")]),
                    V::string(""),
                ),
            ),
            pair("toolUseId", value_or(event.get("tool_use_id"), V::Null)),
            pair(
                "lastOutput",
                value_or(
                    first_truthy(&[
                        event.get("output"),
                        event.get("content"),
                        event.get("summary"),
                    ]),
                    V::string(""),
                ),
            ),
            pair("error", value_or(event.get("error"), V::Null)),
        ];
        detail.extend(fields.iter().cloned());
        let observation = obj(vec![
            ("sessionId", V::String(session_key.clone())),
            ("taskId", task_id.clone()),
            ("status", V::string(status)),
            ("detail", jobj(detail)),
        ]);
        ports.observe(
            &observation,
            &format!("task ledger update {}", task_key.to_string_lossy()),
        )?;
        let now = ports.now()?;
        let background = self.is_background_shadow(session_key, &task_key, now);
        let mut frame = vec![
            pair("type", V::string("monitor_progress")),
            pair("task_id", task_id.clone()),
        ];
        frame.extend(fields);
        frame.push(pair(
            "description",
            V::String(safe_description(
                first_truthy(&[event.get("description"), event.get("summary")]),
                "后台任务仍在执行",
            )),
        ));
        frame.push(pair("status", V::string(status)));
        frame.push(pair("background", V::Bool(background)));
        ports.broadcast(session, &jobj(frame))?;
        Ok(obj(vec![
            ("handled", V::Bool(true)),
            ("status", V::string(status)),
        ]))
    }

    fn handle_completion(
        &self,
        env: Env,
        ports: &Ports<'_>,
        session: &L<'_>,
        session_key: &JsString,
        chat: &L<'_>,
        event: &V,
    ) -> Result<V> {
        let task_id = event.get("task_id").cloned().unwrap_or(V::Undefined);
        let task_key = js_to_string(&task_id);
        self.state
            .borrow_mut()
            .metadata
            .finish(session_key, &task_id);
        let watch = {
            let state = self.state.borrow();
            State::nested_ref(&state.monitor_watches, session_key)
                .and_then(|watches| watches.get(&task_key))
                .cloned()
        };
        let watch = match watch {
            Some(watch) => {
                let now = ports.now()?;
                let mut state = self.state.borrow_mut();
                if let Some(entry) = state
                    .monitor_watches
                    .get_mut(session_key)
                    .and_then(|watches| watches.get_mut(&task_key))
                {
                    entry.live = false;
                    entry.ended_at = Some(now);
                }
                Some(watch)
            }
            None => None,
        };
        if truthy(&task_id) {
            self.stop_shadow(session_key, &task_key);
        }
        let origin = {
            let mut state = self.state.borrow_mut();
            let origin = if truthy(&task_id) {
                State::nested_ref(&state.task_origins, session_key)
                    .and_then(|entries| entries.get(&task_key))
                    .cloned()
            } else {
                None
            };
            if truthy(&task_id) {
                if let Some(entries) = state.task_origins.get_mut(session_key) {
                    entries.delete(&task_key);
                    if entries.is_empty() {
                        state.task_origins.delete(session_key);
                    }
                }
            }
            origin
        };
        let output_file: Option<V> = match selected(event.get("output_file")) {
            Some(value) => Some(value.clone()),
            None => {
                if truthy(&task_id) && truthy_opt(event.get("session_id")) {
                    let cwd = chat_property(env, chat, c"cwd")?;
                    self.monitor_output_file_path(
                        ports,
                        event.get("session_id"),
                        &task_id,
                        Some(&cwd),
                    )?
                    .map(V::String)
                } else {
                    None
                }
            }
        };
        let snippet = self.output_snippet(
            ports,
            output_file.as_ref(),
            event.get("result"),
            event.get("summary"),
        )?;
        let ledger_status = snippet::status_for_completion(event.get("status"));
        let fields = self
            .state
            .borrow()
            .metadata
            .fields_entries(session_key, &task_id);
        let error = match selected(event.get("error")) {
            Some(error) => error.clone(),
            None => {
                if ledger_status == "failed" {
                    value_or(event.get("summary"), V::string("task failed"))
                } else {
                    V::Null
                }
            }
        };
        let mut detail = vec![
            pair(
                "description",
                value_or(
                    first_truthy(&[event.get("description"), event.get("summary")]),
                    V::string(""),
                ),
            ),
            pair("toolUseId", value_or(event.get("tool_use_id"), V::Null)),
            pair(
                "originTurnId",
                origin
                    .as_ref()
                    .map(|origin| V::String(origin.turn_id.clone()))
                    .unwrap_or(V::Null),
            ),
            pair("outputFile", output_file.clone().unwrap_or(V::Null)),
            pair("lastOutput", V::String(snippet.clone())),
        ];
        detail.extend(fields.iter().cloned());
        detail.push(pair("error", error));
        let observation = obj(vec![
            ("sessionId", V::String(session_key.clone())),
            ("taskId", task_id.clone()),
            ("status", V::string(ledger_status)),
            ("detail", jobj(detail)),
        ]);
        ports.observe(
            &observation,
            &format!("task ledger finish {}", task_key.to_string_lossy()),
        )?;
        let now = ports.now()?;
        let sync = self
            .state
            .borrow_mut()
            .sync_bash
            .has(session_key, &task_key, now);
        let mut frame = vec![
            pair("type", V::string("monitor_done")),
            pair("task_id", task_id.clone()),
        ];
        frame.extend(fields);
        frame.push(pair(
            "status",
            event.get("status").cloned().unwrap_or(V::Undefined),
        ));
        frame.push(pair(
            "summary",
            value_or(event.get("summary"), V::string("")),
        ));
        frame.push(pair("output", V::String(snippet.clone())));
        frame.push(pair("background", V::Bool(!sync)));
        ports.broadcast(session, &jobj(frame))?;
        if !chat.truthy()? {
            return Ok(handled_decision("none"));
        }
        let is_streaming = chat_streaming(chat)?;
        let (awaiting, subagent, monitor, sidechain, owned) = {
            let mut state = self.state.borrow_mut();
            let awaiting = state.task_output_awaiting.has(session_key, &task_key, now);
            let subagent = state.subagent.has(session_key, &task_key, now);
            let monitor = watch.is_some() || state.monitor.has(session_key, &task_key, now);
            let sidechain = watch.is_none()
                && truthy_opt(event.get("tool_use_id"))
                && !Self::is_main_tool_use(&state, session_key, event.get("tool_use_id").unwrap());
            let owned = if watch.is_none() && truthy(&task_id) {
                state.owned_task(session_key, &task_key, now)
            } else {
                None
            };
            (awaiting, subagent, monitor, sidechain, owned)
        };
        // Classifier precedence, inline: taskoutput, sync-bash, sidechain,
        // Monitor, then inject. The legacy `invalid` branch is unreachable
        // because this owner *is* the classifier.
        let reason = if awaiting {
            Some("taskoutput")
        } else if sync {
            Some("sync-bash")
        } else if subagent || sidechain {
            Some("sidechain")
        } else if monitor {
            Some("monitor")
        } else {
            None
        };
        if let Some(reason) = reason {
            match reason {
                "taskoutput" => {
                    if owned.is_some() {
                        self.mark_owned_delivered(session_key, &task_key);
                    }
                    self.state
                        .borrow_mut()
                        .task_output_awaiting
                        .consume(session_key, &task_key);
                }
                "sync-bash" => {
                    if owned.is_some() {
                        self.mark_owned_delivered(session_key, &task_key);
                    }
                    self.state
                        .borrow_mut()
                        .sync_bash
                        .consume(session_key, &task_key);
                }
                "sidechain" => {
                    if owned.is_some() {
                        self.mark_owned_delivered(session_key, &task_key);
                    }
                    self.state
                        .borrow_mut()
                        .subagent
                        .consume(session_key, &task_key);
                }
                "monitor" => {
                    if owned.is_some() {
                        self.mark_owned_delivered(session_key, &task_key);
                    }
                    self.state
                        .borrow_mut()
                        .monitor
                        .consume(session_key, &task_key);
                    if let Some(watch) = &watch {
                        if !watch.terminal_queued && !is_streaming {
                            {
                                let mut state = self.state.borrow_mut();
                                if let Some(entry) = state
                                    .monitor_watches
                                    .get_mut(session_key)
                                    .and_then(|watches| watches.get_mut(&task_key))
                                {
                                    entry.terminal_queued = true;
                                }
                            }
                            ports.note_result_injected(session)?;
                            let desc = value_or(event.get("summary"), watch.description.clone());
                            let status = value_or(event.get("status"), V::string("completed"));
                            let token = self.state.borrow_mut().next_token();
                            let item = Item::monitor(
                                desc,
                                status,
                                snippet.clone(),
                                Some(task_id.clone()).filter(|value| !value.is_nullish()),
                                watch.tool_use_id.clone(),
                                token,
                            );
                            let now = ports.now()?;
                            self.state
                                .borrow_mut()
                                .coalescer
                                .add(session_key.clone(), item, now);
                            if truthy(&task_id) {
                                ports.request_enrich(
                                    session,
                                    &task_id,
                                    token,
                                    truthy_opt(event.get("result")),
                                )?;
                            }
                        }
                    }
                }
                _ => unreachable!(),
            }
            return Ok(handled_decision(reason));
        }
        if self.turn_already_has_result(env, chat, event.get("tool_use_id"), origin.as_ref())? {
            return Ok(handled_decision("turn-result"));
        }
        if let Some(owned) = &owned {
            if owned.delivered {
                return Ok(handled_decision("native-prompt"));
            }
            if is_streaming {
                return Ok(handled_decision("live-turn"));
            }
        }
        let description = match &owned {
            Some(owned) if !owned.description.is_empty() => V::String(owned.description.clone()),
            _ => V::String(safe_description(
                first_truthy(&[event.get("description"), event.get("summary")]),
                "后台任务",
            )),
        };
        let status = value_or(event.get("status"), V::string("completed"));
        let token = self.state.borrow_mut().next_token();
        let item = Item::task(
            description,
            status,
            snippet,
            Some(value_or(event.get("task_id"), V::Null)).filter(|value| !value.is_nullish()),
            Some(value_or(event.get("tool_use_id"), V::Null)).filter(|value| !value.is_nullish()),
            token,
        );
        let result = (|| -> Result<()> {
            ports.note_result_injected(session)?;
            {
                let mut state = self.state.borrow_mut();
                state.known_sessions.insert(session_key.clone());
                state.coalescer.add(session_key.clone(), item, now);
            }
            if truthy(&task_id) {
                ports.request_enrich(session, &task_id, token, truthy_opt(event.get("result")))?;
            }
            if owned.is_some() {
                self.mark_owned_delivered(session_key, &task_key);
            }
            Ok(())
        })();
        match result {
            Ok(()) => Ok(handled_decision("inject")),
            Err(_) => {
                let exception = ports.exception()?;
                ports.log_warn("background task completion buffering failed", exception)?;
                Ok(handled_decision("failed"))
            }
        }
    }

    fn is_main_tool_use(state: &State, session_key: &JsString, id: &V) -> bool {
        truthy(id)
            && state
                .main_tool_uses
                .get(session_key)
                .is_some_and(|record| record.set.contains(&js_to_string(id)))
    }

    fn mark_owned_delivered(&self, session_key: &JsString, task_key: &JsString) {
        if let Some(entry) = self
            .state
            .borrow_mut()
            .owned
            .get_mut(session_key)
            .and_then(|entries| entries.get_mut(task_key))
        {
            entry.delivered = true;
        }
    }

    fn turn_already_has_result(
        &self,
        env: Env,
        chat: &L<'_>,
        tool_use_id: Option<&V>,
        origin: Option<&Origin>,
    ) -> Result<bool> {
        let Some(tool_use_id) = selected(tool_use_id) else {
            return Ok(false);
        };
        let Some(tool) = find_tool(env, chat, Some(tool_use_id))? else {
            return Ok(false);
        };
        if !matches!(tool.get("result"), Some(V::String(_))) {
            return Ok(false);
        }
        let input = tool_input(Some(&tool));
        if truthy_opt(input_field(input, "run_in_background")) {
            let active = active_turn_id(chat)?;
            let streaming = chat.truthy()? && chat_streaming(chat)?;
            return Ok(streaming
                && origin
                    .is_some_and(|origin| !origin.turn_id.is_empty() && active == origin.turn_id));
        }
        Ok(true)
    }

    fn output_snippet(
        &self,
        ports: &Ports<'_>,
        output_file: Option<&V>,
        result: Option<&V>,
        report: Option<&V>,
    ) -> Result<JsString> {
        let result_value = selected(result).cloned();
        if !truthy_opt(output_file) && result_value.is_none() {
            return Ok(JsString::new());
        }
        let value = match &result_value {
            Some(result) => result.clone(),
            None => {
                let Some(output_file) = output_file else {
                    return Ok(JsString::new());
                };
                let read = ports.call_caught(
                    ports.function(c"readFile")?,
                    &[ports.value(output_file)?, ports.value(&V::string("utf8"))?],
                )?;
                match read {
                    Ok(value) => match ports.read_live(value) {
                        Ok(value) => value,
                        Err(_) => return Ok(JsString::new()),
                    },
                    Err(_) => return Ok(JsString::new()),
                }
            }
        };
        let text = string_or_empty(Some(&value));
        let final_report = if result_value.is_some() {
            Some(text.clone())
        } else {
            snippet::agent_report(&text)
        };
        let fallback = final_report.clone().unwrap_or_else(|| text.clone());
        let chosen = if final_report
            .as_ref()
            .is_some_and(|report| report.is_empty())
            && truthy_opt(report)
        {
            js_to_string(report.expect("checked truthy"))
        } else {
            fallback
        };
        let redacted = ports.call_caught(
            ports.function(c"redactText")?,
            &[ports.value(&V::String(chosen))?],
        )?;
        let output = match redacted {
            Ok(value) => value.coerce_string()?,
            Err(_) => return Ok(JsString::new()),
        };
        let cap = self.state.borrow().options.output_cap;
        Ok(match final_report {
            Some(_) => snippet::report_snippet(&output, cap),
            None => snippet::log_snippet(&output, cap),
        })
    }

    fn monitor_output_file_path(
        &self,
        ports: &Ports<'_>,
        session_id: Option<&V>,
        task_id: &V,
        cwd: Option<&V>,
    ) -> Result<Option<JsString>> {
        if !truthy(task_id) {
            return Ok(None);
        }
        let compute = || -> Result<JsString> {
            let tmp = ports.call(c"tmpdir", &[])?.coerce_string()?;
            let tmp_real = ports
                .call(c"realpath", &[ports.value(&V::String(tmp))?])?
                .coerce_string()?;
            let cwd_value = match cwd {
                Some(value) if truthy(value) => value.clone(),
                _ => V::string("."),
            };
            let encoded = replace_path_units(
                &ports
                    .call(c"realpath", &[ports.value(&cwd_value)?])?
                    .coerce_string()?,
            );
            let uid = ports.call(c"getuid", &[])?.coerce_string()?;
            let session = match session_id {
                Some(value) if truthy(value) => js_to_string(value),
                _ => JsString::new(),
            };
            let mut path = tmp_real;
            path.push_str("/claude-");
            path.push(&uid);
            path.push_str("/");
            path.push(&encoded);
            path.push_str("/");
            path.push(&session);
            path.push_str("/tasks/");
            path.push(&js_to_string(task_id));
            path.push_str(".output");
            Ok(path)
        };
        match compute() {
            Ok(path) => Ok(Some(path)),
            Err(_) => {
                let exception = ports.exception()?;
                ports.log_warn("background task output path unavailable", exception)?;
                Ok(None)
            }
        }
    }

    fn handle_monitor_prompt(
        &self,
        env: Env,
        ports: &Ports<'_>,
        session: &L<'_>,
        session_key: &JsString,
        chat: &L<'_>,
        event: &V,
    ) -> Result<V> {
        let task_id = event.get("task_id").cloned().unwrap_or(V::Undefined);
        let task_key = js_to_string(&task_id);
        let watch = {
            let state = self.state.borrow();
            State::nested_ref(&state.monitor_watches, session_key)
                .and_then(|watches| watches.get(&task_key))
                .cloned()
        };
        let Some(watch) = watch else {
            return self.handle_task_prompt(env, ports, session, session_key, chat, event);
        };
        let dedup = self.state.borrow().options.dedup_ttl_ms;
        if !watch.live {
            let now = ports.now()?;
            if watch.ended_at.is_some_and(|ended| now - ended > dedup) {
                return Ok(handled(false));
            }
        }
        let in_turn = chat_streaming(chat)?;
        let has_status = truthy_opt(event.get("status"));
        let probe = truthy_opt(event.get("probe"));
        if !has_status && (in_turn || !probe) {
            self.show_monitor_event(ports, session, &watch, event)?;
        }
        if in_turn && !(has_status && watch.terminal_queued) {
            return Ok(handled(false));
        }
        if probe {
            return Ok(monitor_owned());
        }
        if !has_status {
            return Ok(monitor_decision("progress"));
        }
        {
            let mut state = self.state.borrow_mut();
            if let Some(entry) = state
                .monitor_watches
                .get_mut(session_key)
                .and_then(|watches| watches.get_mut(&task_key))
            {
                entry.terminal_handled = true;
            }
        }
        if watch.terminal_queued {
            return Ok(monitor_decision("duplicate"));
        }
        {
            let mut state = self.state.borrow_mut();
            if let Some(entry) = state
                .monitor_watches
                .get_mut(session_key)
                .and_then(|watches| watches.get_mut(&task_key))
            {
                entry.terminal_queued = true;
            }
        }
        let event_id = selected(event.get("event_id")).cloned();
        if let Some(event_id) = &event_id {
            let now = ports.now()?;
            if self
                .state
                .borrow_mut()
                .monitor_events
                .has(session_key, &js_to_string(event_id), now)
            {
                return Ok(monitor_decision("duplicate"));
            }
        }
        let cap = self.state.borrow().options.output_cap;
        let output = string_or_empty(event.get("output"));
        let snippet = output.truncate_units(cap.trunc().max(0.0) as usize);
        let desc = value_or(
            first_truthy(&[event.get("summary"), Some(&watch.description)]),
            V::string("Monitor"),
        );
        let status = event.get("status").cloned().unwrap_or(V::Undefined);
        let token = self.state.borrow_mut().next_token();
        let item = Item::monitor(
            desc,
            status,
            snippet,
            Some(task_id.clone()).filter(|value| !value.is_nullish()),
            watch.tool_use_id.clone(),
            token,
        );
        ports.note_result_injected(session)?;
        let now = ports.now()?;
        self.state
            .borrow_mut()
            .coalescer
            .add(session_key.clone(), item, now);
        if let Some(event_id) = event_id {
            let now = ports.now()?;
            self.state
                .borrow_mut()
                .monitor_events
                .tag(session_key, &js_to_string(&event_id), now);
        }
        Ok(monitor_decision("inject"))
    }

    fn show_monitor_event(
        &self,
        ports: &Ports<'_>,
        session: &L<'_>,
        watch: &Watch,
        event: &V,
    ) -> Result<()> {
        let output = string_or_empty(event.get("output"));
        let lines = split_trim_nonempty(&output);
        let label = safe_description(
            first_truthy(&[Some(&watch.description), event.get("summary")]),
            "Monitor",
        );
        let description = match lines.last() {
            Some(last) => {
                let mut text = label.clone();
                text.push_str(" · ");
                text.push(last);
                safe_description(Some(&V::String(text)), "后台任务仍在执行")
            }
            None => label,
        };
        ports.broadcast(
            session,
            &obj(vec![
                ("type", V::string("monitor_progress")),
                (
                    "task_id",
                    event.get("task_id").cloned().unwrap_or(V::Undefined),
                ),
                ("background", V::Bool(true)),
                ("description", V::String(description)),
            ]),
        )
    }

    fn handle_task_prompt(
        &self,
        env: Env,
        ports: &Ports<'_>,
        session: &L<'_>,
        session_key: &JsString,
        chat: &L<'_>,
        event: &V,
    ) -> Result<V> {
        let task_id = event.get("task_id").cloned().unwrap_or(V::Undefined);
        let task_key = js_to_string(&task_id);
        let owned = if truthy(&task_id) {
            let now = ports.now()?;
            self.state.borrow().owned_task(session_key, &task_key, now)
        } else {
            None
        };
        let Some(owned) = owned else {
            return Ok(handled(false));
        };
        if !owned.delivered && chat.truthy()? && chat_streaming(chat)? {
            return Ok(handled(false));
        }
        if truthy_opt(event.get("probe")) {
            return Ok(monitor_owned());
        }
        if owned.delivered {
            return Ok(monitor_decision("duplicate"));
        }
        // Marked before the snippet is read: a read failure still means the
        // result was handed to the agent.
        self.mark_owned_delivered(session_key, &task_key);
        ports.note_result_injected(session)?;
        let description = if owned.description.is_empty() {
            V::String(safe_description(event.get("summary"), "后台任务"))
        } else {
            V::String(owned.description.clone())
        };
        let status = value_or(event.get("status"), V::string("completed"));
        let snippet =
            self.output_snippet(ports, event.get("output_file"), event.get("result"), None)?;
        let token = self.state.borrow_mut().next_token();
        let item = Item::task(
            description,
            status,
            snippet,
            Some(value_or(event.get("task_id"), V::Null)).filter(|value| !value.is_nullish()),
            Some(value_or(event.get("tool_use_id"), V::Null)).filter(|value| !value.is_nullish()),
            token,
        );
        let now = ports.now()?;
        self.state
            .borrow_mut()
            .coalescer
            .add(session_key.clone(), item, now);
        if truthy(&task_id) {
            ports.request_enrich(session, &task_id, token, truthy_opt(event.get("result")))?;
        }
        let _ = env;
        Ok(monitor_decision("inject"))
    }

    fn handle_tasks_changed(
        &self,
        ports: &Ports<'_>,
        session: &L<'_>,
        session_key: &JsString,
        event: &V,
    ) -> Result<V> {
        let tasks: Vec<V> = match event.get("tasks") {
            Some(V::Array(items)) => items.clone(),
            Some(value) if truthy(value) => {
                return Err(ports.anchor.type_error("event.tasks.map is not a function"))
            }
            _ => Vec::new(),
        };
        let mut ids = OrderedSet::new();
        for task in &tasks {
            ids.insert(js_to_string(task.get("task_id").unwrap_or(&V::Undefined)));
        }
        // Legacy retires every live watch that the new list no longer carries,
        // including the empty-list case (an absent/empty `tasks` means no live
        // background tasks). Collect first so `now()` is only called when a
        // watch actually goes stale, matching the oracle's lazy `now()` calls.
        let stale_ids: Vec<JsString> = {
            let state = self.state.borrow();
            state
                .monitor_watches
                .get(session_key)
                .map(|watches| {
                    watches
                        .keys_vec()
                        .into_iter()
                        .filter(|id| {
                            watches
                                .get(id)
                                .is_some_and(|watch| watch.live && !ids.contains(id))
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        if !stale_ids.is_empty() {
            let mut state = self.state.borrow_mut();
            if let Some(watches) = state.monitor_watches.get_mut(session_key) {
                for id in stale_ids {
                    if let Some(entry) = watches.get_mut(&id) {
                        entry.live = false;
                        entry.ended_at = Some(ports.now()?);
                    }
                }
            }
        }
        let rows = self
            .state
            .borrow_mut()
            .metadata
            .snapshot(session_key, &tasks);
        ports.broadcast(
            session,
            &obj(vec![
                ("type", V::string("background_tasks")),
                ("tasks", V::Array(rows)),
            ]),
        )?;
        Ok(handled(true))
    }

    #[napi]
    pub fn record_main_tool_use_id(
        &self,
        env: Env,
        session: Unknown<'_>,
        id: Unknown<'_>,
    ) -> Result<bool> {
        let session = read(env, session)?;
        let id = read(env, id)?;
        if !truthy(&session) || !truthy(&id) {
            return Ok(false);
        }
        let session_key = js_to_string(&session);
        let id_key = js_to_string(&id);
        let mut state = self.state.borrow_mut();
        state.known_sessions.insert(session_key.clone());
        let cap = state.options.main_tool_use_cap;
        if !state.main_tool_uses.contains_key(&session_key) {
            state
                .main_tool_uses
                .set(session_key.clone(), MainToolUses::default());
        }
        let record = state
            .main_tool_uses
            .get_mut(&session_key)
            .expect("record inserted above");
        if record.set.contains(&id_key) {
            return Ok(false);
        }
        record.set.insert(id_key.clone());
        record.order.push_back(id_key);
        while record.order.len() as f64 > cap {
            if let Some(front) = record.order.pop_front() {
                record.set.delete(&front);
            }
        }
        Ok(true)
    }

    #[napi]
    pub fn mark_task_output_awaiting(
        &self,
        env: Env,
        ports: Unknown<'_>,
        session: Unknown<'_>,
        input: Unknown<'_>,
    ) -> Result<bool> {
        let session = read(env, session)?;
        let input = read(env, input)?;
        if !truthy(&session) || !matches!(input.get("block"), Some(V::Bool(true))) {
            return Ok(false);
        }
        let Some(task_id) = selected(input.get("task_id")) else {
            return Ok(false);
        };
        let ports = Ports::new(&env, ports);
        let session_key = js_to_string(&session);
        let task_key = js_to_string(task_id);
        let now = ports.now()?;
        let mut state = self.state.borrow_mut();
        state.known_sessions.insert(session_key.clone());
        state.remember_session(&session_key, &session);
        Ok(state.task_output_awaiting.tag(&session_key, &task_key, now))
    }

    #[napi]
    pub fn has_live_background_tasks(
        &self,
        env: Env,
        ports: Unknown<'_>,
        session: Unknown<'_>,
    ) -> Result<bool> {
        let session = read(env, session)?;
        if !truthy(&session) {
            return Ok(false);
        }
        let session_key = js_to_string(&session);
        let keys = {
            let state = self.state.borrow();
            if state.native.has(&session_key) {
                return Ok(true);
            }
            match state.shadows.get(&session_key) {
                Some(shadows) if !shadows.is_empty() => shadows.keys_vec(),
                _ => return Ok(false),
            }
        };
        let ports = Ports::new(&env, ports);
        let now = ports.now()?;
        let mut state = self.state.borrow_mut();
        for task in keys {
            if !state.sync_bash.has(&session_key, &task, now) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    #[napi]
    pub fn has_process_background_tasks(
        &self,
        env: Env,
        ports: Unknown<'_>,
        session: Unknown<'_>,
    ) -> Result<bool> {
        if self.has_live_background_tasks(env, ports, session)? {
            return Ok(true);
        }
        let session = read(env, session)?;
        if !truthy(&session) {
            return Ok(false);
        }
        let session_key = js_to_string(&session);
        let watches = {
            let state = self.state.borrow();
            State::nested_ref(&state.monitor_watches, &session_key)
                .map(|watches| watches.values().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        };
        if watches.is_empty() {
            return Ok(false);
        }
        let ports = Ports::new(&env, ports);
        let now = ports.now()?;
        Ok(watches.iter().any(|watch| {
            watch.live
                || (!watch.terminal_handled
                    && watch
                        .ended_at
                        .is_some_and(|ended| now - ended < TERMINAL_DRAIN_MS))
        }))
    }

    #[napi]
    pub fn background_silence_ms(
        &self,
        env: Env,
        ports: Unknown<'_>,
        session: Unknown<'_>,
        at: Option<f64>,
    ) -> Result<f64> {
        let session = read(env, session)?;
        if !truthy(&session) {
            return Ok(0.0);
        }
        let ports = Ports::new(&env, ports);
        let at = match at {
            Some(at) => at,
            None => ports.now()?,
        };
        let session_key = js_to_string(&session);
        let keys = {
            let state = self.state.borrow();
            match state.shadows.get(&session_key) {
                Some(shadows) if !shadows.is_empty() => shadows.keys_vec(),
                _ => return Ok(state.native.silence(&session_key, at)),
            }
        };
        let mut longest = self.state.borrow().native.silence(&session_key, at);
        for task in keys {
            let now = ports.now()?;
            if !self.is_background_shadow(&session_key, &task, now) {
                continue;
            }
            let last = self
                .state
                .borrow()
                .shadows
                .get(&session_key)
                .and_then(|shadows| shadows.get(&task))
                .map(|shadow| shadow.last_progress_at);
            if let Some(last) = last {
                longest = js_max(longest, at - last);
            }
        }
        Ok(longest)
    }

    #[napi]
    pub fn list_active_background_tasks(
        &self,
        env: Env,
        ports: Unknown<'_>,
        session: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let session = read(env, session)?;
        if !truthy(&session) {
            return write(env, &V::Array(Vec::new()));
        }
        let session_key = js_to_string(&session);
        let ports = Ports::new(&env, ports);
        let rows = self.active_rows(&ports, &session_key)?;
        write(env, &V::Array(rows))
    }

    fn active_rows(&self, ports: &Ports<'_>, session_key: &JsString) -> Result<Vec<V>> {
        let mut out: Vec<V> = Vec::new();
        {
            let state = self.state.borrow();
            for (id, description) in state.native.list(session_key) {
                out.push(obj(vec![
                    ("id", V::String(id.clone())),
                    ("task_id", V::String(id)),
                    ("description", V::String(description)),
                ]));
            }
            if let Some(watches) = State::nested_ref(&state.monitor_watches, session_key) {
                for (id, watch) in watches.iter() {
                    if watch.live {
                        out.push(obj(vec![
                            ("id", V::String(id.clone())),
                            ("task_id", V::String(id.clone())),
                            (
                                "description",
                                V::String(safe_description(
                                    Some(&watch.description),
                                    "后台任务仍在执行",
                                )),
                            ),
                        ]));
                    }
                }
            }
        }
        let shadows: Vec<(JsString, V)> = {
            let state = self.state.borrow();
            state
                .shadows
                .get(session_key)
                .map(|shadows| {
                    shadows
                        .iter()
                        .map(|(id, shadow)| (id.clone(), shadow.description.clone()))
                        .collect()
                })
                .unwrap_or_default()
        };
        if !shadows.is_empty() {
            let now = ports.now()?;
            for (id, description) in shadows {
                if self.is_background_shadow(session_key, &id, now) {
                    out.push(obj(vec![
                        ("id", V::String(id.clone())),
                        ("task_id", V::String(id)),
                        (
                            "description",
                            V::String(safe_description(Some(&description), "后台任务仍在执行")),
                        ),
                    ]));
                }
            }
        }
        let mut seen = OrderedSet::new();
        for task in &out {
            if let Some(task_id) = task.get("task_id") {
                seen.insert(js_to_string(task_id));
            }
        }
        let active = self.state.borrow().metadata.active(session_key);
        for task in active {
            let id = value_or(
                first_truthy(&[task.get("task_id"), task.get("id")]),
                V::Undefined,
            );
            if !seen.contains(&js_to_string(&id)) {
                out.push(task);
            }
        }
        let state = self.state.borrow();
        let mut result = Vec::with_capacity(out.len());
        for task in out {
            let id = value_or(
                first_truthy(&[task.get("task_id"), task.get("id")]),
                V::Undefined,
            );
            let fields = state.metadata.fields_entries(session_key, &id);
            let description = match state.metadata.description(session_key, &id) {
                Some(text) if !text.is_empty() => V::String(text),
                _ => task.get("description").cloned().unwrap_or(V::Undefined),
            };
            let merged = spread(own_entries(&task), fields);
            let merged = spread(merged, vec![pair("description", description)]);
            result.push(V::Object(merged));
        }
        Ok(result)
    }

    #[napi]
    pub fn reap_session_shadows(
        &self,
        env: Env,
        ports: Unknown<'_>,
        session: Unknown<'_>,
        opts: Unknown<'_>,
    ) -> Result<u32> {
        let session_value = read(env, session)?;
        if !truthy(&session_value) {
            return Ok(0);
        }
        let ports = Ports::new(&env, ports);
        let session_l = L::new(&env, session);
        let session_key = js_to_string(&session_value);
        let opts = read(env, opts)?;
        let reason = js_to_string(&value_or(opts.get("reason"), V::string("process_exit")));
        let snapshot: Vec<(JsString, V)> = {
            let state = self.state.borrow();
            state
                .metadata
                .active(&session_key)
                .into_iter()
                .map(|task| {
                    let id = value_or(
                        first_truthy(&[task.get("task_id"), task.get("id")]),
                        V::Undefined,
                    );
                    (
                        js_to_string(&id),
                        task.get("description").cloned().unwrap_or(V::Undefined),
                    )
                })
                .collect()
        };
        let mut ids = OrderedSet::new();
        {
            let state = self.state.borrow();
            if let Some(shadows) = state.shadows.get(&session_key) {
                for id in shadows.keys() {
                    ids.insert(id.clone());
                }
            }
            if let Some(watches) = State::nested_ref(&state.monitor_watches, &session_key) {
                for (id, watch) in watches.iter() {
                    if watch.live {
                        ids.insert(id.clone());
                    }
                }
            }
        }
        for (id, _) in &snapshot {
            ids.insert(id.clone());
        }
        let native_tasks = self.state.borrow().native.reap_list(&session_key);
        let mut reaped = native_tasks.len() as u32;
        for (id, description) in native_tasks {
            let tool = self
                .state
                .borrow()
                .native
                .task_tool(&session_key, &id)
                .unwrap_or(false);
            let mut text = description;
            text.push_str(" · 进程已退出，任务中断");
            let mut safe = ports.safe_text(Some(&V::String(text)))?;
            if safe.is_empty() {
                safe = JsString::from_rust_str("Codex 子任务");
            }
            let now = ports.now()?;
            let outcome = self.state.borrow_mut().native.apply(
                &session_key,
                &id,
                true,
                false,
                false,
                Some(&V::string("interrupted")),
                tool,
                safe,
                now,
            );
            if let NativeOutcome::Applied {
                frame_type,
                status,
                task,
                ..
            } = outcome
            {
                let observation = obj(vec![
                    ("sessionId", V::String(session_key.clone())),
                    ("taskId", V::String(id.clone())),
                    ("status", V::String(status.clone())),
                    (
                        "detail",
                        obj(vec![
                            ("description", V::String(task.description.clone())),
                            (
                                "kind",
                                V::string(if task.tool {
                                    "codex-tool"
                                } else {
                                    "codex-agent"
                                }),
                            ),
                        ]),
                    ),
                ]);
                ports.observe(
                    &observation,
                    &format!("原生后台任务 {}", id.to_string_lossy()),
                )?;
                let frame = vec![
                    pair("type", V::string(frame_type)),
                    pair("task_id", V::String(id.clone())),
                    pair("description", V::String(task.description.clone())),
                    pair("summary", V::String(task.description)),
                    pair("status", V::String(status)),
                    pair("background", V::Bool(true)),
                ];
                ports.broadcast(&session_l, &jobj(frame))?;
                self.state.borrow_mut().native.evict(&session_key);
            }
        }
        for task_id in ids.to_vec() {
            let now = ports.now()?;
            let background = self.is_background_shadow(&session_key, &task_id, now);
            let description = {
                let mut state = self.state.borrow_mut();
                let description = value_or(
                    first_truthy(&[
                        State::nested_ref(&state.shadows, &session_key)
                            .and_then(|shadows| shadows.get(&task_id))
                            .map(|shadow| &shadow.description),
                        State::nested_ref(&state.monitor_watches, &session_key)
                            .and_then(|watches| watches.get(&task_id))
                            .map(|watch| &watch.description),
                        snapshot
                            .iter()
                            .find(|(id, _)| id == &task_id)
                            .map(|(_, description)| description),
                    ]),
                    V::string(""),
                );
                if let Some(watch) = state
                    .monitor_watches
                    .get_mut(&session_key)
                    .and_then(|watches| watches.get_mut(&task_id))
                {
                    watch.live = false;
                    watch.ended_at = Some(now);
                    watch.terminal_handled = true;
                }
                description
            };
            self.stop_shadow(&session_key, &task_id);
            let origin = {
                let mut state = self.state.borrow_mut();
                let origin = State::nested_ref(&state.task_origins, &session_key)
                    .and_then(|entries| entries.get(&task_id))
                    .cloned();
                if let Some(entries) = state.task_origins.get_mut(&session_key) {
                    entries.delete(&task_id);
                    if entries.is_empty() {
                        state.task_origins.delete(&session_key);
                    }
                }
                origin
            };
            let mut error = JsString::from_rust_str("background task interrupted (");
            error.push(&reason);
            error.push_str(")");
            let observation = obj(vec![
                ("sessionId", V::String(session_key.clone())),
                ("taskId", V::String(task_id.clone())),
                ("status", V::string("interrupted")),
                (
                    "detail",
                    obj(vec![
                        ("description", description.clone()),
                        ("reason", V::String(reason.clone())),
                        (
                            "originTurnId",
                            origin
                                .as_ref()
                                .map(|origin| V::String(origin.turn_id.clone()))
                                .unwrap_or(V::Null),
                        ),
                        ("error", V::String(error)),
                    ]),
                ),
            ]);
            ports.observe(
                &observation,
                &format!("task ledger reap {}", task_id.to_string_lossy()),
            )?;
            let fields = self
                .state
                .borrow()
                .metadata
                .fields_entries(&session_key, &V::String(task_id.clone()));
            let mut frame = vec![
                pair("type", V::string("monitor_done")),
                pair("task_id", V::String(task_id.clone())),
            ];
            frame.extend(fields);
            frame.push(pair("status", V::string("interrupted")));
            frame.push(pair(
                "summary",
                V::String(safe_description(Some(&description), "后台任务已中断")),
            ));
            frame.push(pair("background", V::Bool(background)));
            ports.broadcast(&session_l, &jobj(frame))?;
            reaped += 1;
        }
        self.state.borrow_mut().metadata.clear(&session_key);
        Ok(reaped)
    }

    #[napi]
    pub fn stop_for_insert(
        &self,
        env: Env,
        ports: Unknown<'_>,
        session: Unknown<'_>,
    ) -> Result<u32> {
        let session_value = read(env, session)?;
        if !truthy(&session_value) {
            return Ok(0);
        }
        let ports = Ports::new(&env, ports);
        let session_l = L::new(&env, session);
        let session_key = js_to_string(&session_value);
        let tasks = self.active_rows(&ports, &session_key)?;
        for task in &tasks {
            if let Some(task_id) = selected(task.get("task_id")) {
                ports.request_stop_task(&session_l, task_id)?;
            }
        }
        {
            let mut state = self.state.borrow_mut();
            state.coalescer.cancel(&session_key);
            if let Some(entries) = state.owned.get_mut(&session_key) {
                for entry in entries.values_mut() {
                    entry.delivered = true;
                }
            }
            if !tasks.is_empty() {
                let notes: Vec<JsString> = tasks
                    .iter()
                    .map(|task| {
                        let mut line = js_to_string(task.get("task_id").unwrap_or(&V::Undefined));
                        line.push_str(": ");
                        line.push(&js_to_string(
                            task.get("description").unwrap_or(&V::Undefined),
                        ));
                        line
                    })
                    .collect();
                state.stopped_notes.set(session_key, notes);
            }
        }
        Ok(tasks.len() as u32)
    }

    #[napi]
    pub fn take_stopped_note(&self, env: Env, session: Unknown<'_>) -> Result<String> {
        let session = read(env, session)?;
        if !truthy(&session) {
            return Ok(String::new());
        }
        let notes = self
            .state
            .borrow_mut()
            .stopped_notes
            .delete(&js_to_string(&session));
        let Some(notes) = notes else {
            return Ok(String::new());
        };
        let mut text = String::from(
            "[Background tasks stopped] The user interrupted the previous turn with this message, which stopped these background tasks before they finished. Do not wait for their notifications; rerun one only if it is still needed.\n",
        );
        for (index, line) in notes.iter().enumerate() {
            if index > 0 {
                text.push('\n');
            }
            text.push_str("- ");
            text.push_str(&line.to_string_lossy());
        }
        text.push_str("\n\n");
        Ok(text)
    }

    #[napi]
    pub fn stop_session(&self, env: Env, session: Unknown<'_>) -> Result<u32> {
        let session = read(env, session)?;
        if !truthy(&session) {
            return Ok(0);
        }
        Ok(self
            .state
            .borrow_mut()
            .stop_session(&js_to_string(&session)))
    }

    #[napi]
    pub fn stop_all(&self) -> Result<u32> {
        let sessions = {
            let state = self.state.borrow();
            let mut sessions = OrderedSet::new();
            for name in state.known_sessions.iter() {
                sessions.insert(name.clone());
            }
            for name in state.shadows.keys() {
                sessions.insert(name.clone());
            }
            for name in state.task_output_awaiting.map.keys() {
                sessions.insert(name.clone());
            }
            for name in state.sync_bash.map.keys() {
                sessions.insert(name.clone());
            }
            for name in state.subagent.map.keys() {
                sessions.insert(name.clone());
            }
            for name in state.monitor.map.keys() {
                sessions.insert(name.clone());
            }
            for name in state.task_origins.keys() {
                sessions.insert(name.clone());
            }
            for name in state.owned.keys() {
                sessions.insert(name.clone());
            }
            for name in state.main_tool_uses.keys() {
                sessions.insert(name.clone());
            }
            sessions.to_vec()
        };
        let mut killed = 0;
        let mut state = self.state.borrow_mut();
        for session in sessions {
            killed += state.stop_session(&session);
        }
        Ok(killed)
    }

    /// Earliest deadline the facade must wake for: the next coalescer flush or
    /// the next writer-shadow poll, whichever comes first. `null` means idle.
    #[napi]
    pub fn next_due(&self) -> Result<Option<f64>> {
        let state = self.state.borrow();
        let mut due = state.coalescer.next_due();
        for shadows in state.shadows.values() {
            for shadow in shadows.values() {
                due = Some(match due {
                    Some(current) => current.min(shadow.next_poll_at),
                    None => shadow.next_poll_at,
                });
            }
        }
        Ok(due)
    }

    /// Poll due shadows and flush due coalescer windows. The facade calls this
    /// from its single timer; `now` defaults to the host clock.
    #[napi]
    pub fn tick(&self, env: Env, ports: Unknown<'_>, now: Option<f64>) -> Result<u32> {
        let ports = Ports::new(&env, ports);
        let now = match now {
            Some(now) => now,
            None => ports.now()?,
        };
        let due_shadows: Vec<(JsString, JsString)> = {
            let state = self.state.borrow();
            let mut due = Vec::new();
            for (session, shadows) in state.shadows.iter() {
                for (task, shadow) in shadows.iter() {
                    if now >= shadow.next_poll_at {
                        due.push((session.clone(), task.clone()));
                    }
                }
            }
            due
        };
        for (session_key, task_key) in due_shadows {
            let (output_file, description, task_id) = {
                let state = self.state.borrow();
                let Some(shadow) = state
                    .shadows
                    .get(&session_key)
                    .and_then(|shadows| shadows.get(&task_key))
                else {
                    continue;
                };
                (
                    shadow.output_file.clone(),
                    shadow.description.clone(),
                    shadow.task_id.clone(),
                )
            };
            let read = ports.call_caught(
                ports.function(c"readFile")?,
                &[ports.value(&output_file)?, ports.value(&V::string("utf8"))?],
            )?;
            let content = match read {
                Ok(value) => match ports.read_live(value)? {
                    V::String(text) => text,
                    other => string_or_empty(Some(&other)),
                },
                Err(_) => JsString::new(),
            };
            let last_progress = {
                let mut state = self.state.borrow_mut();
                let Some(shadow) = state
                    .shadows
                    .get_mut(&session_key)
                    .and_then(|shadows| shadows.get_mut(&task_key))
                else {
                    continue;
                };
                shadow.next_poll_at = now + SHADOW_POLL_MS;
                if content.len() < shadow.offset {
                    shadow.offset = 0;
                }
                let appended = content.slice_units(shadow.offset, content.len());
                shadow.offset = content.len();
                if appended.trim().is_empty() {
                    continue;
                }
                shadow.last_progress_at
            };
            let throttle = self.state.borrow().options.progress_throttle_ms;
            if now - last_progress < throttle {
                continue;
            }
            {
                let mut state = self.state.borrow_mut();
                if let Some(shadow) = state
                    .shadows
                    .get_mut(&session_key)
                    .and_then(|shadows| shadows.get_mut(&task_key))
                {
                    shadow.last_progress_at = now;
                }
            }
            let session_value = self.state.borrow().session_value(&session_key);
            let session_l = ports.value(&session_value)?;
            ports.broadcast(
                &session_l,
                &obj(vec![
                    ("type", V::string("monitor_progress")),
                    ("task_id", task_id),
                    (
                        "description",
                        V::String(safe_description(Some(&description), "后台任务仍在执行")),
                    ),
                    ("background", V::Bool(true)),
                ]),
            )?;
        }
        let due_sessions = self.state.borrow().coalescer.due(now);
        let mut flushed = 0u32;
        for session_key in due_sessions {
            let items = {
                let mut state = self.state.borrow_mut();
                match state.coalescer.flush(&session_key) {
                    Some(items) => items,
                    None => continue,
                }
            };
            let nudge = coalescer::build_nudge(&items);
            let bg_task_ids: Vec<V> = items
                .iter()
                .filter_map(|item| item.task_id.as_ref().filter(|value| truthy(value)).cloned())
                .collect();
            let bg_tool_use_ids: Vec<V> = items
                .iter()
                .filter_map(|item| {
                    item.tool_use_id
                        .as_ref()
                        .filter(|value| truthy(value))
                        .cloned()
                })
                .collect();
            let origin = if bg_task_ids.is_empty() && bg_tool_use_ids.is_empty() {
                V::Object(Vec::new())
            } else {
                obj(vec![
                    ("bgTaskIds", V::Array(bg_task_ids)),
                    ("bgToolUseIds", V::Array(bg_tool_use_ids)),
                ])
            };
            let session_value = self.state.borrow().session_value(&session_key);
            let session_l = ports.value(&session_value)?;
            ports.deliver_completed(&session_l, &nudge, &origin)?;
            flushed += 1;
        }
        Ok(flushed)
    }

    /// Landing point for the asynchronous control-channel enrichment. Returns
    /// `false` when the coalescer window already flushed (nothing to replace).
    #[napi]
    pub fn apply_control_output(
        &self,
        env: Env,
        token: f64,
        output: Unknown<'_>,
        truncated: bool,
    ) -> Result<bool> {
        let output = read(env, output)?;
        let text = match output {
            V::String(text) => text,
            V::Null | V::Undefined => return Ok(false),
            other => js_to_string(&other),
        };
        let cap = self.state.borrow().options.output_cap;
        let snippet = snippet::control_snippet(&text, truncated, cap);
        Ok(self
            .state
            .borrow_mut()
            .coalescer
            .update_snippet(token as u64, snippet))
    }
}
