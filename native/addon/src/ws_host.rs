//! Native owner for every socket the shared connection router accepts.
//!
//! One Rust struct owns the connection registry (replacing the router's
//! `connections` WeakMap), the per-connection heartbeat bookkeeping and the
//! frozen send-queue kernel (`ws_backpressure::Wrapper`, the byte-exact
//! replica of the retired `src/ws-backpressure.js`). Node keeps only the
//! transport: the `ws` object is stored as an opaque host value and is driven
//! through `sendFrame`/`ping`/`terminate`/`close` ports, exactly like the
//! workspace host. There is no second connection table in JavaScript.
//!
//! Re-entrancy: a fake (or misbehaving) socket may invoke the send completion
//! synchronously, so a `sendResult` can arrive while the wrapper is checked
//! out for an `enqueue`/`complete`. Such completions are stashed per
//! connection and drained iteratively after the wrapper is returned, which
//! preserves the old wrapper's depth-first drain order without ever calling a
//! port while the state borrow is held.
use crate::{
    js_host_value::{Value, Values},
    js_live::LiveValue as L,
};
use multicc_core::{
    api_contract::WS_API_VERSION,
    chat_replay_buffer::Sessions,
    js::JsValue as V,
    workspace_sockets::{Heartbeat, HeartbeatTick},
    ws_backpressure::{Effect, Limits, Options, Payload, Transport, Wrapper},
};
use napi::{
    bindgen_prelude::{FromNapiValue, Unknown},
    check_status, sys, Env, Result,
};
use napi_derive::napi;
use std::{cell::RefCell, collections::BTreeMap, ffi::CStr, ptr};

fn call<'e>(port: L<'e>, name: &CStr, args: &[L<'e>]) -> Result<L<'e>> {
    port.get(name)?.call_plain(args)
}

/// Metrics and diagnostics must never break the transport path: the retired
/// JavaScript wrapped each of these in a try/catch.
fn call_catch<'e>(port: L<'e>, name: &CStr, args: &[L<'e>]) -> Result<()> {
    let function = port.get(name)?;
    let _ = function.catch(|| function.call_plain(args));
    Ok(())
}

fn number<'e>(anchor: L<'e>, value: f64) -> Result<L<'e>> {
    anchor.from_value(&V::Number(value))
}

fn chat_event_frame<'e>(event: L<'e>, anchor: L<'e>) -> Result<String> {
    if event.kind()? != sys::ValueType::napi_object
        || event.get(c"type")?.kind()? != sys::ValueType::napi_string
    {
        return Err(event.type_error("WebSocket envelope requires a string type"));
    }
    let fields = event.from_value(&V::Object(vec![(
        "apiVersion".into(),
        V::string(WS_API_VERSION),
    )]))?;
    let encoded = call(anchor, c"stringifyWithFields", &[event, fields])?;
    if encoded.kind()? != sys::ValueType::napi_string {
        return Err(encoded.type_error("WebSocket envelope did not serialize to a string"));
    }
    unsafe { String::from_napi_value(encoded.env(), encoded.raw()) }
}

struct Connection {
    socket: Value,
    fields: Value,
    connected_at: f64,
    native: bool,
    heartbeat: Heartbeat,
    wrapper: Option<Wrapper>,
    timer: Option<Value>,
    callbacks: BTreeMap<u64, Value>,
    callback_next: u64,
    /// Send completions that arrived while the wrapper was checked out.
    pending_results: Vec<Option<String>>,
}

impl Connection {
    fn new(socket: Value, fields: Value, connected_at: f64, native: bool) -> Self {
        Self {
            socket,
            fields,
            connected_at,
            native,
            heartbeat: Heartbeat::default(),
            // Native-owned sockets (the workspace host) keep their own queue.
            wrapper: (!native).then(|| Wrapper::new(Limits::default())),
            timer: None,
            callbacks: BTreeMap::new(),
            callback_next: 0,
            pending_results: Vec::new(),
        }
    }
}

#[derive(Default)]
struct State {
    // BTreeMap iteration is insertion order (ids increase monotonically), the
    // same fan-out order the JavaScript `Set` of clients gave the heartbeat
    // sweep and the close diagnostics.
    connections: BTreeMap<u64, Connection>,
    next: u64,
}

/// `ws.send(data, …)`: classify the payload the way `byteLength`/`coalesceKey`
/// did. Strings are text; `Buffer` is coalescible binary; every other binary
/// view (typed array, `DataView`, `ArrayBuffer`) is binary that never
/// coalesces. Anything else went through `String(data)` for measuring.
fn classify(data: L<'_>) -> Result<Payload> {
    if let Some(text) = data.string()? {
        return Ok(Payload::Text(text.to_string_lossy()));
    }
    let env = data.env();
    let raw = data.raw();
    let mut is_buffer = false;
    check_status!(unsafe { sys::napi_is_buffer(env, raw, &mut is_buffer) })?;
    if is_buffer {
        let mut pointer = ptr::null_mut();
        let mut length = 0usize;
        check_status!(unsafe { sys::napi_get_buffer_info(env, raw, &mut pointer, &mut length) })?;
        let bytes = if length == 0 {
            Vec::new()
        } else {
            unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), length) }.to_vec()
        };
        return Ok(Payload::Buffer(bytes));
    }
    let mut is_typed_array = false;
    check_status!(unsafe { sys::napi_is_typedarray(env, raw, &mut is_typed_array) })?;
    if is_typed_array {
        let mut kind = sys::TypedarrayType::uint8_array;
        let mut length = 0usize;
        let mut pointer = ptr::null_mut();
        let mut array_buffer = ptr::null_mut();
        let mut byte_offset = 0usize;
        check_status!(unsafe {
            sys::napi_get_typedarray_info(
                env,
                raw,
                &mut kind,
                &mut length,
                &mut pointer,
                &mut array_buffer,
                &mut byte_offset,
            )
        })?;
        let element = match kind {
            sys::TypedarrayType::int8_array
            | sys::TypedarrayType::uint8_array
            | sys::TypedarrayType::uint8_clamped_array => 1usize,
            sys::TypedarrayType::int16_array | sys::TypedarrayType::uint16_array => 2,
            sys::TypedarrayType::int32_array
            | sys::TypedarrayType::uint32_array
            | sys::TypedarrayType::float32_array => 4,
            _ => 8,
        };
        let byte_length = length.saturating_mul(element);
        // `data` from the typed-array info is already offset-adjusted.
        let bytes = if byte_length == 0 {
            Vec::new()
        } else {
            unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), byte_length) }.to_vec()
        };
        return Ok(Payload::View(bytes));
    }
    let mut is_data_view = false;
    check_status!(unsafe { sys::napi_is_dataview(env, raw, &mut is_data_view) })?;
    if is_data_view {
        let mut byte_length = 0usize;
        let mut pointer = ptr::null_mut();
        let mut array_buffer = ptr::null_mut();
        let mut byte_offset = 0usize;
        check_status!(unsafe {
            sys::napi_get_dataview_info(
                env,
                raw,
                &mut byte_length,
                &mut pointer,
                &mut array_buffer,
                &mut byte_offset,
            )
        })?;
        let bytes = if byte_length == 0 {
            Vec::new()
        } else {
            unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), byte_length) }.to_vec()
        };
        return Ok(Payload::View(bytes));
    }
    let mut is_array_buffer = false;
    check_status!(unsafe { sys::napi_is_arraybuffer(env, raw, &mut is_array_buffer) })?;
    if is_array_buffer {
        let mut pointer = ptr::null_mut();
        let mut byte_length = 0usize;
        check_status!(unsafe {
            sys::napi_get_arraybuffer_info(env, raw, &mut pointer, &mut byte_length)
        })?;
        let bytes = if byte_length == 0 {
            Vec::new()
        } else {
            unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), byte_length) }.to_vec()
        };
        return Ok(Payload::View(bytes));
    }
    // The retired wrapper measured anything else as `String(data)` and passed
    // the original through; production only ever sends strings and binaries.
    Ok(Payload::Text(data.coerce_string()?.to_string_lossy()))
}

/// Parse the second `ws.send` argument. A function is the two-argument form
/// (`Options::Callback`, re-split by the kernel); an object contributes only
/// its `binary` flag — no production caller passes any other ws option key.
fn parse_options(options: L<'_>) -> Result<Options> {
    match options.kind()? {
        sys::ValueType::napi_undefined | sys::ValueType::napi_null => Ok(Options::None),
        sys::ValueType::napi_function => Ok(Options::Callback),
        _ => Ok(Options::Binary(options.get(c"binary")?.truthy()?)),
    }
}

/// The retired wrapper captured a synchronous transport throw with
/// `catch (err)`. Across napi that throw is a *pending exception*: dropping
/// the `napi::Error` without clearing it poisons the boundary and the kernel's
/// `send_throw` path would instead throw back out of `ws.send`. Read the
/// exception's message (clearing it) the way `String(err.message || err)`
/// would.
fn take_error_message(anchor: L<'_>, fallback: &str) -> String {
    if let Ok(Some(exception)) = anchor.exception_value() {
        if let Ok(Some(text)) = exception.get(c"message").and_then(|m| m.string()) {
            return text.to_string_lossy();
        }
        if let Ok(text) = exception.coerce_string() {
            return text.to_string_lossy();
        }
    }
    fallback.to_string()
}

fn js_err<T>(anchor: L<'_>, result: Result<T>, fallback: &str) -> std::result::Result<T, String> {
    result.map_err(|_| take_error_message(anchor, fallback))
}

/// The live socket the kernel drives. Both fallible calls map the thrown
/// JavaScript value to its message, exactly what the retired wrapper's
/// `catch (err)` saw.
struct JsTransport<'e, 'v> {
    env: &'e Env,
    values: &'v Values,
    port: L<'e>,
    socket: L<'e>,
}

impl Transport for JsTransport<'_, '_> {
    fn send(&mut self, payload: &Payload, options: &Options) -> std::result::Result<(), String> {
        let anchor = js_err(self.port, self.values.anchor(self.env), "send failed")?;
        let data = match payload {
            Payload::Text(text) => anchor.from_value(&V::string(text)),
            Payload::Buffer(bytes) | Payload::View(bytes) => {
                anchor.from_value(&V::Bytes(bytes.clone()))
            }
        };
        let data = js_err(self.port, data, "send failed")?;
        let options = match options {
            Options::None | Options::Callback => {
                js_err(self.port, anchor.from_value(&V::Undefined), "send failed")?
            }
            Options::Binary(binary) => {
                let object = js_err(
                    self.port,
                    anchor.from_value(&V::Object(vec![])),
                    "send failed",
                )?;
                let flag = js_err(
                    self.port,
                    anchor.from_value(&V::Bool(*binary)),
                    "send failed",
                )?;
                js_err(self.port, object.set(c"binary", flag), "send failed")?;
                object
            }
        };
        js_err(
            self.port,
            call(self.port, c"sendFrame", &[self.socket, data, options]),
            "send failed",
        )?;
        Ok(())
    }

    fn close(&mut self, code: u16, reason: &str) -> std::result::Result<(), String> {
        let code = js_err(
            self.port,
            number(self.port, f64::from(code)),
            "close failed",
        )?;
        let reason = js_err(
            self.port,
            self.port.from_value(&V::string(reason)),
            "close failed",
        )?;
        js_err(
            self.port,
            call(self.port, c"close", &[self.socket, code, reason]),
            "close failed",
        )?;
        Ok(())
    }

    fn terminate(&mut self) {
        let _ = call_catch(self.port, c"terminate", &[self.socket]);
    }

    fn buffered_amount(&self) -> usize {
        self.socket
            .get(c"bufferedAmount")
            .and_then(|value| value.number())
            .map(|value| value.max(0.0) as usize)
            .unwrap_or(0)
    }
}

#[napi]
pub struct RustWsHost {
    state: RefCell<State>,
    values: Values,
    /// Per-session replay buffer and ordered client membership for `/ws/chat`.
    /// Frames are the already-encoded wire text; clients are connection ids.
    chat: RefCell<Sessions<String, u64>>,
    /// The router's shared ports, bound once so session fan-out and the
    /// replay burst can address connections without a port argument.
    ports: RefCell<Option<Value>>,
}

impl RustWsHost {
    /// The router's shared ports, bound by `bind_ports`.
    fn shared_ports<'e>(&self, env: &'e Env) -> Result<L<'e>> {
        let value = self.ports.borrow().clone();
        let Some(value) = value else {
            return Err(napi::Error::from_reason(
                "ws host ports are not bound (call bindPorts first)",
            ));
        };
        let anchor = self.values.anchor(env)?;
        self.values.read(env, anchor, &value)
    }

    fn socket<'e>(&self, env: &'e Env, id: u64) -> Result<Option<L<'e>>> {
        let value = {
            self.state
                .borrow()
                .connections
                .get(&id)
                .map(|conn| conn.socket.clone())
        };
        match value {
            Some(value) => {
                let anchor = self.values.anchor(env)?;
                Ok(Some(self.values.read(env, anchor, &value)?))
            }
            None => Ok(None),
        }
    }

    /// The host clock is only consulted while the transport is above the high
    /// water mark: below it the kernel never reads `now`, and the retired
    /// queue only called `Date.now()` from its congested branch.
    fn clock_if_needed(port: L<'_>, buffered: usize, limits: &Limits) -> Result<f64> {
        if buffered >= limits.high_water_bytes {
            Ok(call(port, c"now", &[])?.number()?)
        } else {
            Ok(0.0)
        }
    }

    /// Run one kernel operation with the wrapper checked out, then apply the
    /// effects it recorded and drain any completions that arrived
    /// re-entrantly. Ports are never invoked while the state borrow is held.
    fn with_wrapper<'e>(
        &'e self,
        env: &'e Env,
        port: L<'e>,
        id: u64,
        operation: impl FnOnce(&mut Wrapper, &mut JsTransport<'e, 'e>) -> Result<()>,
    ) -> Result<()> {
        let taken = {
            let mut state = self.state.borrow_mut();
            state.connections.get_mut(&id).map(|conn| {
                let socket = conn.socket.clone();
                (conn.wrapper.take(), socket)
            })
        };
        let Some((Some(mut wrapper), socket_value)) = taken else {
            return Ok(());
        };
        let anchor = self.values.anchor(env)?;
        let socket = self.values.read(env, anchor, &socket_value)?;
        let mut transport = JsTransport {
            env,
            values: &self.values,
            port,
            socket,
        };
        let buffered = transport.buffered_amount();
        // Every wrapper here was built with the default limits, so the host
        // clock gate reads the same constant the kernel was constructed with.
        let limits = Limits::default();
        let now = Self::clock_if_needed(port, buffered, &limits)?;
        wrapper.set_now(now);
        let outcome = operation(&mut wrapper, &mut transport);
        let effects = wrapper.take_effects();
        // Return the wrapper before any port runs, so a producer callback that
        // synchronously sends again finds a live queue (the retired wrapper
        // had no checked-out window either).
        {
            let mut state = self.state.borrow_mut();
            if let Some(conn) = state.connections.get_mut(&id) {
                conn.wrapper = Some(wrapper);
            }
            // If the connection was detached mid-flight the wrapper (and its
            // unreleased queue) simply drops.
        }
        outcome?;
        self.apply_effects(env, port, id, socket, effects)?;
        self.drain_pending(env, port, id)
    }

    fn drain_pending<'e>(&'e self, env: &'e Env, port: L<'e>, id: u64) -> Result<()> {
        loop {
            let next = {
                let mut state = self.state.borrow_mut();
                state.connections.get_mut(&id).and_then(|conn| {
                    if conn.pending_results.is_empty() {
                        None
                    } else {
                        Some(conn.pending_results.remove(0))
                    }
                })
            };
            let Some(error) = next else {
                return Ok(());
            };
            self.complete(env, port, id, error)?;
        }
    }

    fn complete<'e>(
        &'e self,
        env: &'e Env,
        port: L<'e>,
        id: u64,
        error: Option<String>,
    ) -> Result<()> {
        self.with_wrapper(env, port, id, |wrapper, transport| {
            wrapper.complete(error.as_deref(), transport);
            Ok(())
        })
    }

    fn apply_effects<'e>(
        &'e self,
        env: &'e Env,
        port: L<'e>,
        id: u64,
        socket: L<'e>,
        effects: Vec<Effect>,
    ) -> Result<()> {
        for effect in effects {
            match effect {
                // The transport already performed the send/close/terminate
                // inline; these arms record and schedule around it.
                Effect::Send { .. } => {}
                Effect::Close { .. } | Effect::Terminate => {}
                Effect::Metric { name, amount, set } => {
                    let name = port.from_value(&V::string(name))?;
                    let amount = number(port, amount)?;
                    let op = port.from_value(&V::string(if set { "set" } else { "inc" }))?;
                    call_catch(port, c"metric", &[name, amount, op])?;
                }
                Effect::Log {
                    event,
                    reason,
                    queue_bytes,
                    queue_messages,
                    buffered,
                } => {
                    // The retired `onLog(event, fields)` call; the kernel read
                    // `bufferedAmount` before `ws.close`, so it travels in the
                    // effect rather than being re-read from the socket here.
                    let fields = port.from_value(&V::object(vec![
                        ("reason", V::string(reason)),
                        ("queueBytes", V::Number(queue_bytes as f64)),
                        ("queueMessages", V::Number(queue_messages as f64)),
                        ("bufferedAmount", V::Number(buffered as f64)),
                    ]))?;
                    call_catch(
                        port,
                        c"backpressureLog",
                        &[socket, port.from_value(&V::string(event))?, fields],
                    )?;
                }
                Effect::Callback { index, error } => {
                    let callback = {
                        let mut state = self.state.borrow_mut();
                        state
                            .connections
                            .get_mut(&id)
                            .and_then(|conn| conn.callbacks.remove(&index))
                    };
                    if let Some(callback) = callback {
                        let anchor = self.values.anchor(env)?;
                        let callback = self.values.read(env, anchor, &callback)?;
                        let argument = match error {
                            Some(message) => {
                                let message = port.from_value(&V::string(&message))?;
                                port.global()?.get(c"Error")?.construct(&[message])?
                            }
                            None => port.from_value(&V::Undefined)?,
                        };
                        call_catch_arg(callback, argument)?;
                    }
                }
                Effect::Schedule { ms } => {
                    let exists = {
                        let state = self.state.borrow();
                        state
                            .connections
                            .get(&id)
                            .is_some_and(|conn| conn.timer.is_some())
                    };
                    if !exists {
                        let timer = call(
                            port,
                            c"schedule",
                            &[number(port, id as f64)?, number(port, ms as f64)?],
                        )?;
                        let timer = self.values.capture(env, timer)?;
                        let mut state = self.state.borrow_mut();
                        if let Some(conn) = state.connections.get_mut(&id) {
                            conn.timer = Some(timer);
                        }
                    }
                }
                Effect::Cancel => {
                    let timer = {
                        let mut state = self.state.borrow_mut();
                        state
                            .connections
                            .get_mut(&id)
                            .and_then(|conn| conn.timer.take())
                    };
                    if let Some(timer) = timer {
                        let anchor = self.values.anchor(env)?;
                        let timer = self.values.read(env, anchor, &timer)?;
                        call_catch(port, c"cancelSchedule", &[timer])?;
                    }
                }
            }
        }
        Ok(())
    }
}

/// The producer's own send callback; the retired wrapper called it without a
/// receiver and never let its throw escape the flush.
fn call_catch_arg<'e>(callback: L<'e>, argument: L<'e>) -> Result<()> {
    let _ = callback.catch(|| callback.call_plain(&[argument]));
    Ok(())
}

#[napi]
impl RustWsHost {
    #[napi(constructor)]
    pub fn new(env: Env, anchor: Unknown<'_>) -> Result<Self> {
        Ok(Self {
            state: RefCell::new(State::default()),
            values: Values::new(L::new(&env, anchor))?,
            chat: RefCell::new(Sessions::default()),
            ports: RefCell::new(None),
        })
    }

    /// Register an accepted socket. `fields` is the close-log identity the
    /// router used to keep in its WeakMap; `native` marks the two workspace
    /// hosts whose heartbeat and queue stay with their own owner.
    #[napi]
    pub fn attach(
        &self,
        env: Env,
        socket: Unknown<'_>,
        fields: Unknown<'_>,
        native: bool,
        connected_at: f64,
    ) -> Result<u32> {
        self.values.drain(&env)?;
        let socket = self.values.capture(&env, L::new(&env, socket))?;
        let fields = self.values.capture(&env, L::new(&env, fields))?;
        let mut state = self.state.borrow_mut();
        state.next = state
            .next
            .checked_add(1)
            .ok_or_else(|| napi::Error::from_reason("ws host connection ids exhausted"))?;
        let id = state.next;
        state
            .connections
            .insert(id, Connection::new(socket, fields, connected_at, native));
        drop(state);
        self.values.drain(&env)?;
        Ok(id as u32)
    }

    /// Remove the connection after its `close` event. Cancels a pending retry
    /// timer and releases the queued frames; returns the identity and final
    /// heartbeat snapshot for the close log, or null for an unknown id.
    #[napi]
    pub fn detach(&self, env: Env, id: u32, port: Unknown<'_>) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let port = L::new(&env, port);
        let conn = { self.state.borrow_mut().connections.remove(&(id as u64)) };
        // A closed socket never stays a member of any chat session.
        self.chat.borrow_mut().detach(&(id as u64));
        let Some(conn) = conn else {
            let anchor = self.values.anchor(&env)?;
            let null = anchor.from_value(&V::Null)?;
            self.values.drain(&env)?;
            return Ok(null.raw());
        };
        if let Some(timer) = conn.timer {
            let anchor = self.values.anchor(&env)?;
            let timer = self.values.read(&env, anchor, &timer)?;
            call_catch(port, c"cancelSchedule", &[timer])?;
        }
        // `close_event` releases the queue and the kernel's timer flag; its
        // effects are discarded because the socket is already closing.
        if let Some(mut wrapper) = conn.wrapper {
            wrapper.close_event();
        }
        let anchor = self.values.anchor(&env)?;
        let output = anchor.from_value(&V::Object(vec![]))?;
        let fields = self.values.read(&env, anchor, &conn.fields)?;
        output.set(c"fields", fields)?;
        output.set(c"connectedAt", number(anchor, conn.connected_at)?)?;
        output.set(
            c"timedOut",
            anchor.from_value(&V::Bool(conn.heartbeat.timed_out()))?,
        )?;
        output.set(
            c"missedPongs",
            number(anchor, conn.heartbeat.missed_pongs() as f64)?,
        )?;
        output.set(c"native", anchor.from_value(&V::Bool(conn.native))?)?;
        self.values.drain(&env)?;
        Ok(output.raw())
    }

    /// A pong completes the current window and clears the missed count.
    #[napi]
    pub fn on_pong(&self, id: u32) -> Result<()> {
        if let Some(conn) = self.state.borrow_mut().connections.get_mut(&(id as u64)) {
            conn.heartbeat.on_pong();
        }
        Ok(())
    }

    /// The patched `ws.send`: subject to the message-count tripwire.
    #[napi]
    pub fn send(
        &self,
        env: Env,
        id: u32,
        data: Unknown<'_>,
        options: Unknown<'_>,
        callback: Unknown<'_>,
        port: Unknown<'_>,
    ) -> Result<()> {
        self.enqueue(env, id as u64, data, options, callback, port, true)
    }

    /// The replay burst: byte cap and congestion timer still apply, the
    /// message-count tripwire does not (the retired `sendImmediate`).
    #[napi]
    pub fn send_immediate(
        &self,
        env: Env,
        id: u32,
        data: Unknown<'_>,
        options: Unknown<'_>,
        callback: Unknown<'_>,
        port: Unknown<'_>,
    ) -> Result<()> {
        self.enqueue(env, id as u64, data, options, callback, port, false)
    }

    /// Bind the router's shared ports once. Session fan-out and the replay
    /// burst address connections through `ports.connPort(id)` (that
    /// connection's `sendFrame` view) and `ports.terminate(socket)`.
    #[napi]
    pub fn bind_ports(&self, env: Env, ports: Unknown<'_>) -> Result<()> {
        self.values.drain(&env)?;
        let value = self.values.capture(&env, L::new(&env, ports))?;
        *self.ports.borrow_mut() = Some(value);
        self.values.drain(&env)?;
        Ok(())
    }

    /// Append one encoded frame to the session's replay buffer (500-frame
    /// FIFO cap).
    #[napi]
    pub fn replay_push(&self, session: String, frame: String) {
        self.chat.borrow_mut().session(&session).push(frame);
    }

    #[napi]
    pub fn replay_push_event(&self, env: Env, session: String, event: Unknown<'_>) -> Result<bool> {
        let event = L::new(&env, event);
        let anchor = self.values.anchor(&env)?;
        let Some(frame) = event.catch(|| chat_event_frame(event, anchor))? else {
            return Ok(false);
        };
        self.replay_push(session, frame);
        Ok(true)
    }

    /// `cs.streamReplay = []`.
    #[napi]
    pub fn replay_clear(&self, session: String) {
        if let Some(entry) = self.chat.borrow_mut().get_mut(&session) {
            entry.clear_replay();
        }
    }

    #[napi]
    pub fn replay_len(&self, session: String) -> u32 {
        self.chat
            .borrow()
            .get(&session)
            .map_or(0, |entry| entry.replay().len() as u32)
    }

    /// The buffered frames in order (diagnostics and the dispatch progress
    /// reducer; the live burst never crosses into JavaScript).
    #[napi]
    pub fn replay_frames(&self, session: String) -> Vec<String> {
        self.chat
            .borrow()
            .get(&session)
            .map(|entry| entry.replay().iter().cloned().collect())
            .unwrap_or_default()
    }

    #[napi]
    pub fn replay_events(&self, env: Env, session: String) -> Result<sys::napi_value> {
        let frames = self.replay_frames(session);
        let anchor = self.values.anchor(&env)?;
        let output = anchor.from_value(&V::Array(Vec::new()))?;
        let json = anchor.global()?.get(c"JSON")?;
        let parse = json.get(c"parse")?;
        let mut index = 0;
        for frame in frames {
            let text = anchor.from_value(&V::string(&frame))?;
            if let Some(event) = anchor.catch(|| parse.call(json, &[text]))? {
                output.set_element(index, event)?;
                index += 1;
            }
        }
        Ok(output.raw())
    }

    /// `cs.clients.add(ws)`: idempotent, keeps the original position.
    #[napi]
    pub fn client_join(&self, session: String, id: u32) {
        self.chat.borrow_mut().session(&session).join(u64::from(id));
    }

    /// `cs.clients.delete(ws)`.
    #[napi]
    pub fn client_leave(&self, session: String, id: u32) {
        if let Some(entry) = self.chat.borrow_mut().get_mut(&session) {
            entry.leave(&u64::from(id));
        }
    }

    /// `cs.clients.clear()`.
    #[napi]
    pub fn client_clear(&self, session: String) {
        if let Some(entry) = self.chat.borrow_mut().get_mut(&session) {
            entry.clear_clients();
        }
    }

    /// `cs.clients.size`.
    #[napi]
    pub fn client_count(&self, session: String) -> u32 {
        self.chat
            .borrow()
            .get(&session)
            .map_or(0, |entry| entry.clients().len() as u32)
    }

    #[napi]
    pub fn client_ids(&self, session: String) -> Vec<u32> {
        self.chat
            .borrow()
            .get(&session)
            .map(|entry| entry.clients().iter().map(|id| *id as u32).collect())
            .unwrap_or_default()
    }

    /// A chat session is being created or destroyed: empty its buffer and
    /// drop its membership without touching the sockets.
    #[napi]
    pub fn session_reset(&self, session: String) {
        self.chat.borrow_mut().remove(&session);
    }

    /// Session destroy: terminate every client in membership order (a throwing
    /// terminate is swallowed), then forget the whole session. Returns how
    /// many clients were terminated.
    #[napi]
    pub fn session_drop(&self, env: Env, session: String) -> Result<u32> {
        self.values.drain(&env)?;
        let removed = self.chat.borrow_mut().remove(&session);
        let Some(removed) = removed else {
            return Ok(0);
        };
        if removed.clients().is_empty() {
            return Ok(0);
        }
        let ports = self.shared_ports(&env)?;
        let mut terminated = 0;
        for id in removed.clients() {
            let Some(socket) = self.socket(&env, *id)? else {
                continue;
            };
            call_catch(ports, c"terminate", &[socket])?;
            terminated += 1;
        }
        self.values.drain(&env)?;
        Ok(terminated)
    }

    /// `broadcastTo` over one chat session: send the frame to every member
    /// whose socket is OPEN, in membership order. A throwing send is swallowed
    /// and does not stop the rest. Returns how many sends were attempted.
    #[napi]
    pub fn fan_out(&self, env: Env, session: String, frame: String) -> Result<u32> {
        self.values.drain(&env)?;
        let members: Vec<u64> = self
            .chat
            .borrow()
            .get(&session)
            .map(|entry| entry.clients().to_vec())
            .unwrap_or_default();
        if members.is_empty() {
            return Ok(0);
        }
        let ports = self.shared_ports(&env)?;
        let mut attempted = 0;
        for id in members {
            let Some(socket) = self.socket(&env, id)? else {
                continue;
            };
            if socket.get(c"readyState")?.number()? != 1.0 {
                continue;
            }
            attempted += 1;
            let connection_ports = call(ports, c"connPort", &[number(ports, id as f64)?])?;
            let data = ports.from_value(&V::string(&frame))?;
            let undefined = ports.from_value(&V::Undefined)?;
            ports.catch(|| {
                self.enqueue_live(&env, id, data, undefined, undefined, connection_ports, true)
            })?;
        }
        self.values.drain(&env)?;
        Ok(attempted)
    }

    #[napi]
    pub fn fan_out_event(&self, env: Env, session: String, event: Unknown<'_>) -> Result<u32> {
        let frame = chat_event_frame(L::new(&env, event), self.values.anchor(&env)?)?;
        self.fan_out(env, session, frame)
    }

    /// The reconnect replay burst: every buffered frame, in order, through the
    /// send path that bypasses the message-count tripwire (the byte cap and
    /// congestion timer still apply). A throwing send is swallowed per frame.
    #[napi]
    pub fn replay_burst(&self, env: Env, id: u32, session: String) -> Result<u32> {
        self.values.drain(&env)?;
        let frames: Vec<String> = self
            .chat
            .borrow()
            .get(&session)
            .map(|entry| entry.replay().iter().cloned().collect())
            .unwrap_or_default();
        if frames.is_empty() {
            return Ok(0);
        }
        let id = u64::from(id);
        let ports = self.shared_ports(&env)?;
        let connection_ports = call(ports, c"connPort", &[number(ports, id as f64)?])?;
        let mut sent = 0;
        for frame in frames {
            let data = ports.from_value(&V::string(&frame))?;
            let undefined = ports.from_value(&V::Undefined)?;
            ports.catch(|| {
                self.enqueue_live(
                    &env,
                    id,
                    data,
                    undefined,
                    undefined,
                    connection_ports,
                    false,
                )
            })?;
            sent += 1;
        }
        self.values.drain(&env)?;
        Ok(sent)
    }

    /// Transport completion reported by the `sendFrame` port.
    #[napi]
    pub fn send_result(
        &self,
        env: Env,
        id: u32,
        error: Unknown<'_>,
        port: Unknown<'_>,
    ) -> Result<()> {
        self.values.drain(&env)?;
        let id = id as u64;
        let error = {
            let error = L::new(&env, error);
            if error.nullish()? {
                None
            } else {
                Some(error.coerce_string()?.to_string_lossy())
            }
        };
        let port = L::new(&env, port);
        // A synchronous completion inside an in-progress kernel call finds the
        // wrapper checked out: stash it, the outer call drains in order.
        let checked_out = {
            let state = self.state.borrow();
            match state.connections.get(&id) {
                Some(conn) => conn.wrapper.is_none(),
                None => return Ok(()),
            }
        };
        if checked_out {
            let mut state = self.state.borrow_mut();
            if let Some(conn) = state.connections.get_mut(&id) {
                conn.pending_results.push(error);
            }
            return Ok(());
        }
        self.complete(&env, port, id, error)?;
        self.values.drain(&env)?;
        Ok(())
    }

    /// The per-connection retry timer fired: continue draining the queue.
    #[napi]
    pub fn flush_client(&self, env: Env, id: u32, port: Unknown<'_>) -> Result<()> {
        self.values.drain(&env)?;
        let id = id as u64;
        let port = L::new(&env, port);
        {
            let timer = {
                let mut state = self.state.borrow_mut();
                state
                    .connections
                    .get_mut(&id)
                    .and_then(|conn| conn.timer.take())
            };
            drop(timer);
        }
        self.with_wrapper(&env, port, id, |wrapper, transport| {
            wrapper.fire_timer(transport);
            Ok(())
        })?;
        self.values.drain(&env)?;
        Ok(())
    }

    /// The retired API's explicit `flush()`: a flush attempt outside the timer
    /// path (timer bookkeeping untouched).
    #[napi]
    pub fn flush(&self, env: Env, id: u32, port: Unknown<'_>) -> Result<()> {
        self.values.drain(&env)?;
        let port = L::new(&env, port);
        self.with_wrapper(&env, port, id as u64, |wrapper, transport| {
            wrapper.flush(transport);
            Ok(())
        })?;
        self.values.drain(&env)?;
        Ok(())
    }

    /// One heartbeat window for every registered socket. The timer itself
    /// stays in the shared connection router; the decision (and the
    /// terminate) is native. Native-owned (workspace) sockets are skipped:
    /// their windows are decided by their own owner.
    #[napi]
    pub fn tick(&self, env: Env, port: Unknown<'_>) -> Result<u32> {
        self.values.drain(&env)?;
        let port = L::new(&env, port);
        let ids: Vec<u64> = { self.state.borrow().connections.keys().cloned().collect() };
        let mut terminated = 0u32;
        for id in ids {
            let skip = {
                let state = self.state.borrow();
                state
                    .connections
                    .get(&id)
                    .is_none_or(|conn| conn.native || conn.heartbeat.timed_out())
            };
            if skip {
                continue;
            }
            let Some(socket) = self.socket(&env, id)? else {
                continue;
            };
            // The retired loop skipped sockets that were closing and ones that
            // had already timed out before counting this window.
            if socket.get(c"readyState")?.number()? != 1.0 {
                continue;
            }
            let tick = {
                let mut state = self.state.borrow_mut();
                state
                    .connections
                    .get_mut(&id)
                    .map(|conn| conn.heartbeat.tick())
            };
            match tick {
                Some(HeartbeatTick::Ping) => {
                    call(port, c"ping", &[socket])?;
                }
                Some(HeartbeatTick::Terminate) => {
                    let (missed, fields) = {
                        let state = self.state.borrow();
                        state.connections.get(&id).map_or((0, None), |conn| {
                            (conn.heartbeat.missed_pongs(), Some(conn.fields.clone()))
                        })
                    };
                    if let Some(fields) = fields {
                        let anchor = self.values.anchor(&env)?;
                        let fields = self.values.read(&env, anchor, &fields)?;
                        call_catch(
                            port,
                            c"heartbeatTimeout",
                            &[fields, socket, number(port, missed as f64)?],
                        )?;
                    }
                    call(port, c"terminate", &[socket])?;
                    terminated += 1;
                }
                _ => {}
            }
        }
        self.values.drain(&env)?;
        Ok(terminated)
    }

    /// Queue snapshot for the retired `_multiccBackpressure.stats()` surface,
    /// or null once detached. `congestedAt` was a timestamp nobody read; the
    /// kernel reports the flag itself (both consumers only read `queueBytes`).
    #[napi]
    pub fn stats(&self, env: Env, id: u32) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let output = {
            let state = self.state.borrow();
            match state.connections.get(&(id as u64)) {
                Some(conn) => match conn.wrapper.as_ref() {
                    Some(wrapper) => {
                        let stats = wrapper.stats();
                        V::object(vec![
                            ("queueBytes", V::Number(stats.queue_bytes as f64)),
                            ("queueMessages", V::Number(stats.queue_messages as f64)),
                            ("sending", V::Bool(stats.sending)),
                            ("congested", V::Bool(stats.congested)),
                            ("closed", V::Bool(stats.closed)),
                        ])
                    }
                    None => V::Null,
                },
                None => V::Null,
            }
        };
        let anchor = self.values.anchor(&env)?;
        let output = anchor.from_value(&output)?;
        self.values.drain(&env)?;
        Ok(output.raw())
    }

    #[napi]
    pub fn len(&self) -> u32 {
        self.state.borrow().connections.len() as u32
    }

    #[napi]
    pub fn is_empty(&self) -> bool {
        self.state.borrow().connections.is_empty()
    }

    /// Release every connection, timer and callback. Open sockets are closed
    /// by the host lifecycle; this only drops native state.
    #[napi]
    pub fn close(&self, env: Env, port: Unknown<'_>) -> Result<()> {
        self.values.drain(&env)?;
        let port = L::new(&env, port);
        let timers: Vec<Value> = {
            let mut state = self.state.borrow_mut();
            let timers = state
                .connections
                .values_mut()
                .filter_map(|conn| conn.timer.take())
                .collect();
            state.connections.clear();
            timers
        };
        for timer in timers {
            let anchor = self.values.anchor(&env)?;
            let timer = self.values.read(&env, anchor, &timer)?;
            call_catch(port, c"cancelSchedule", &[timer])?;
        }
        self.values.drain(&env)?;
        Ok(())
    }
}

impl RustWsHost {
    /// The `ws.send(data, options, callback)` signature, mirrored across the
    /// boundary; splitting it would only re-assemble at the napi method.
    #[allow(clippy::too_many_arguments)]
    fn enqueue(
        &self,
        env: Env,
        id: u64,
        data: Unknown<'_>,
        options: Unknown<'_>,
        callback: Unknown<'_>,
        port: Unknown<'_>,
        bounded: bool,
    ) -> Result<()> {
        self.enqueue_live(
            &env,
            id,
            L::new(&env, data),
            L::new(&env, options),
            L::new(&env, callback),
            L::new(&env, port),
            bounded,
        )
    }

    /// `enqueue` over values that are already live, so native callers (the
    /// session fan-out and the replay burst) share the exact send path the
    /// patched `ws.send` uses.
    #[allow(clippy::too_many_arguments)]
    fn enqueue_live<'e>(
        &'e self,
        env: &'e Env,
        id: u64,
        data: L<'e>,
        options_live: L<'e>,
        callback_live: L<'e>,
        port: L<'e>,
        bounded: bool,
    ) -> Result<()> {
        self.values.drain(env)?;
        let payload = classify(data)?;
        let options = parse_options(options_live)?;
        // `ws.send(data, callback)` re-splits exactly like the retired wrapper.
        let callback_live = if options == Options::Callback {
            options_live
        } else {
            callback_live
        };
        let options = if options == Options::Callback {
            Options::None
        } else {
            options
        };
        let has_callback = callback_live.kind()? == sys::ValueType::napi_function;
        let known = { self.state.borrow().connections.contains_key(&id) };
        if !known {
            // The connection detached (its close event already ran): the
            // retired wrapper reported through the callback instead of
            // throwing, exactly like its own closed branch.
            if has_callback {
                let message =
                    port.from_value(&V::string("WebSocket backpressure transport closed"))?;
                let error = port.global()?.get(c"Error")?.construct(&[message])?;
                call_catch_arg(callback_live, error)?;
            }
            return Ok(());
        }
        let handle = if has_callback {
            let value = self.values.capture(env, callback_live)?;
            let mut state = self.state.borrow_mut();
            // `known` above settled existence; the entry cannot leave between
            // two host calls on one thread.
            let conn = state
                .connections
                .get_mut(&id)
                .expect("connection registered above");
            conn.callback_next = conn.callback_next.checked_add(1).unwrap_or(1);
            let handle = conn.callback_next;
            conn.callbacks.insert(handle, value);
            Some(handle)
        } else {
            None
        };
        self.with_wrapper(env, port, id, |wrapper, transport| {
            wrapper.enqueue(payload, options, handle, bounded, transport);
            Ok(())
        })?;
        self.values.drain(env)?;
        Ok(())
    }
}

/// A scratch anchor for module-level functions that receive no argument:
/// `from_value` only needs a value from the same environment.
fn scratch(env: &Env) -> Result<L<'_>> {
    let mut raw = ptr::null_mut();
    check_status!(unsafe { sys::napi_get_undefined(env.raw(), &mut raw) })?;
    Ok(L::from_raw(env.raw(), raw))
}

/// The frozen `DEFAULTS` of the retired `src/ws-backpressure.js`, exposed so
/// the one remaining JavaScript consumer (the workspace fan-out timer) reads
/// the same constants instead of a second copy.
#[napi]
pub fn ws_backpressure_limits(env: Env) -> Result<sys::napi_value> {
    let limits = Limits::default();
    let anchor = scratch(&env)?;
    let output = anchor.from_value(&V::object(vec![
        ("highWaterBytes", V::Number(limits.high_water_bytes as f64)),
        ("maxQueueBytes", V::Number(limits.max_queue_bytes as f64)),
        (
            "maxQueueMessages",
            V::Number(limits.max_queue_messages as f64),
        ),
        (
            "maxCongestionMs",
            V::Number(limits.max_congestion_ms as f64),
        ),
        ("retryMs", V::Number(limits.retry_ms as f64)),
        ("maxFrameBytes", V::Number(limits.max_frame_bytes as f64)),
    ]))?;
    Ok(output.raw())
}

/// The retired `coalesceKey`: a parsed object whose `type` is coalescible,
/// keyed by the first truthy of `dirId`/`sessionId`/`role`; null otherwise.
#[napi]
pub fn ws_coalesce_key(env: Env, data: Unknown<'_>) -> Result<sys::napi_value> {
    let data = L::new(&env, data);
    let key = classify(data)
        .ok()
        .and_then(|payload| multicc_core::ws_backpressure::coalesce_key(&payload));
    let output = match key {
        Some(key) => data.from_value(&V::string(&key))?,
        None => data.from_value(&V::Null)?,
    };
    Ok(output.raw())
}
