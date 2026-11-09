//! Native owner for the `/ws/workspace` and `/ws/meta` subscription lifecycle.
//!
//! One Rust struct owns the client registry, directory/fleet subscriptions,
//! recent-event ring, observer list, snapshot assembly, fan-out, heartbeat and
//! backpressure for those two paths. Node keeps only the transport: a `ws`
//! object is stored as an opaque host value, encoded frames are obtained once
//! per broadcast from a stateless `prepare` port, and the socket is driven
//! through `sendFrame`/`ping`/`terminate`/`close` ports. There is no second
//! client Map or per-client JavaScript object.
use crate::{
    js_host_value::{Value, Values},
    js_live::LiveValue as L,
};
use multicc_core::{
    js::{JsString, JsValue as V},
    workspace_sockets::{
        Backpressure, Clients, Effects, Heartbeat, HeartbeatTick, Limits, Queued, Replay, Scope,
    },
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, HashMap},
};

fn call<'e>(port: L<'e>, name: &std::ffi::CStr, args: &[L<'e>]) -> Result<L<'e>> {
    port.get(name)?.call_plain(args)
}

/// Metrics and diagnostics must never break a broadcast: the old code wrapped
/// each of these in a try/catch.
fn call_catch<'e>(port: L<'e>, name: &std::ffi::CStr, args: &[L<'e>]) -> Result<()> {
    let function = port.get(name)?;
    let _ = function.catch(|| function.call_plain(args));
    Ok(())
}

fn text<'e>(anchor: L<'e>, value: &str) -> Result<L<'e>> {
    anchor.from_value(&V::string(value))
}

fn number<'e>(anchor: L<'e>, value: f64) -> Result<L<'e>> {
    anchor.from_value(&V::Number(value))
}

fn metrics<'e>(port: L<'e>, name: &str, amount: f64, op: &str) -> Result<()> {
    call_catch(
        port,
        c"metric",
        &[text(port, name)?, number(port, amount)?, text(port, op)?],
    )
}

#[derive(Default)]
struct State {
    clients: Clients,
    sockets: HashMap<u64, Value>,
    heartbeat: HashMap<u64, Heartbeat>,
    backpressure: HashMap<u64, Backpressure<Value>>,
    timers: HashMap<u64, Value>,
    fields: HashMap<u64, Value>,
    replay: Replay<Value>,
    observers: BTreeMap<u64, Value>,
    observer_next: u64,
}

#[napi]
pub struct RustWorkspaceSockets {
    state: RefCell<State>,
    values: Values,
}

impl RustWorkspaceSockets {
    fn socket<'e>(&self, env: &'e Env, id: u64) -> Result<Option<L<'e>>> {
        let value = { self.state.borrow().sockets.get(&id).cloned() };
        match value {
            Some(value) => {
                let anchor = self.values.anchor(env)?;
                Ok(Some(self.values.read(env, anchor, &value)?))
            }
            None => Ok(None),
        }
    }

    /// The host clock is only consulted while the transport is above the high
    /// water mark: below it the core never reads `now`, and the old JS queue
    /// only called `Date.now()` from its congested branch.
    fn clock_if_needed(port: L<'_>, buffered: f64, limits: &Limits) -> Result<f64> {
        if buffered >= limits.high_water_bytes as f64 {
            Ok(call(port, c"now", &[])?.number()?)
        } else {
            Ok(0.0)
        }
    }

    fn register(&self, env: &Env, socket: L<'_>, scope: Scope, fields: L<'_>) -> Result<u64> {
        let socket_value = self.values.capture(env, socket)?;
        let fields_value = self.values.capture(env, fields)?;
        let mut state = self.state.borrow_mut();
        let id = state.clients.insert(scope);
        state.sockets.insert(id, socket_value);
        state.heartbeat.insert(id, Heartbeat::default());
        state.backpressure.insert(id, Backpressure::default());
        state.fields.insert(id, fields_value);
        Ok(id)
    }

    fn dispatch_to<'e>(
        &self,
        env: &'e Env,
        port: L<'e>,
        ids: &[u64],
        payload: L<'e>,
        bounded: bool,
    ) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let prepared = call(port, c"prepare", &[payload])?;
        let data_live = prepared.get(c"data")?;
        let bytes = prepared.get(c"bytes")?.number()?.max(0.0) as usize;
        let key = prepared
            .get(c"key")?
            .string()?
            .map(|value: JsString| value.to_string_lossy());
        // One table entry shared by every recipient: the JS string is encoded
        // once and only referenced while it sits in a queue.
        let data = self.values.capture_host(env, data_live)?;
        let limits = Limits::default();
        let mut pending = Vec::with_capacity(ids.len());
        for &id in ids {
            let Some(socket) = self.socket(env, id)? else {
                continue;
            };
            let buffered = socket.get(c"bufferedAmount")?.number()?.max(0.0);
            let now = Self::clock_if_needed(port, buffered, &limits)?;
            let effects = {
                let mut state = self.state.borrow_mut();
                let Some(backpressure) = state.backpressure.get_mut(&id) else {
                    continue;
                };
                backpressure.enqueue(
                    Queued {
                        data: data.clone(),
                        key: key.clone(),
                        bytes,
                    },
                    bounded,
                    &limits,
                    buffered,
                    now,
                )
            };
            pending.push((id, effects));
        }
        for (id, effects) in pending {
            self.apply_effects(env, port, id, effects)?;
        }
        Ok(())
    }

    fn apply_effects<'e>(
        &self,
        env: &'e Env,
        port: L<'e>,
        id: u64,
        mut effects: Effects<Value>,
    ) -> Result<()> {
        if effects.overflow {
            metrics(port, "multicc_ws_queue_overflows_total", 1.0, "inc")?;
        }
        if effects.coalesced {
            metrics(port, "multicc_ws_messages_coalesced_total", 1.0, "inc")?;
        }
        // The frozen queue reported a new queue depth before trying to flush.
        if let Some(depth) = effects.depth {
            metrics(port, "multicc_ws_queue_depth", depth as f64, "set")?;
        }
        if effects.high_water {
            metrics(port, "multicc_ws_high_water_events_total", 1.0, "inc")?;
        }
        if let Some((queue_bytes, queue_messages)) = effects.disconnect_queue {
            metrics(
                port,
                "multicc_ws_backpressure_disconnects_total",
                1.0,
                "inc",
            )?;
            if let Some(reason) = effects.disconnect {
                if let Some(socket) = self.socket(env, id)? {
                    call_catch(
                        port,
                        c"backpressureLog",
                        &[
                            socket,
                            text(port, reason)?,
                            number(port, queue_bytes as f64)?,
                            number(port, queue_messages as f64)?,
                        ],
                    )?;
                    call(port, c"disconnect", &[socket])?;
                }
            }
        }
        if effects.schedule {
            self.schedule_flush(env, port, id)?;
        }
        if let Some(data) = effects.send.take() {
            if let Some(socket) = self.socket(env, id)? {
                let anchor = self.values.anchor(env)?;
                let data_live = self.values.read(env, anchor, &data)?;
                call(
                    port,
                    c"sendFrame",
                    &[socket, data_live, number(port, id as f64)?],
                )?;
            }
        }
        // Dropping the retired handles is what lets `Values::drain` release the
        // anchor table entries on the next entry.
        drop(effects.retire);
        Ok(())
    }

    fn schedule_flush(&self, env: &Env, port: L<'_>, id: u64) -> Result<()> {
        let existing = { self.state.borrow().timers.contains_key(&id) };
        if existing {
            return Ok(());
        }
        let timer = call(port, c"schedule", &[number(port, id as f64)?])?;
        let timer = self.values.capture(env, timer)?;
        self.state.borrow_mut().timers.insert(id, timer);
        Ok(())
    }

    fn flush_id(&self, env: &Env, port: L<'_>, id: u64) -> Result<()> {
        let Some(socket) = self.socket(env, id)? else {
            return Ok(());
        };
        let buffered = socket.get(c"bufferedAmount")?.number()?.max(0.0);
        let limits = Limits::default();
        let now = Self::clock_if_needed(port, buffered, &limits)?;
        let effects = {
            let mut state = self.state.borrow_mut();
            let Some(backpressure) = state.backpressure.get_mut(&id) else {
                return Ok(());
            };
            backpressure.flush(buffered, now, &limits)
        };
        self.apply_effects(env, port, id, effects)
    }
}

#[napi]
impl RustWorkspaceSockets {
    #[napi(constructor)]
    pub fn new(env: Env, anchor: Unknown<'_>) -> Result<Self> {
        Ok(Self {
            state: RefCell::new(State::default()),
            values: Values::new(L::new(&env, anchor))?,
        })
    }

    /// Register a `/ws/workspace` client and send its initial snapshot. Returns
    /// the internal client id (0 when the directory is unknown and the socket
    /// was closed). The caller binds `pong`/`close` listeners using that id.
    #[napi]
    pub fn attach_workspace(
        &self,
        env: Env,
        socket: Unknown<'_>,
        dir_id: String,
        fields: Unknown<'_>,
        port: Unknown<'_>,
    ) -> Result<u32> {
        self.values.drain(&env)?;
        let socket = L::new(&env, socket);
        let fields = L::new(&env, fields);
        let port = L::new(&env, port);
        let dir = port.from_value(&V::string(&dir_id))?;
        if !call(port, c"directoriesHas", &[dir])?.truthy()? {
            let payload = port.from_value(&V::object(vec![
                ("type", V::string("error")),
                ("error", V::string("unknown directory")),
            ]))?;
            let prepared = call(port, c"prepare", &[payload])?;
            call(
                port,
                c"sendFrame",
                &[socket, prepared.get(c"data")?, number(port, 0.0)?],
            )?;
            call(port, c"close", &[socket])?;
            self.values.drain(&env)?;
            return Ok(0);
        }
        let id = self.register(&env, socket, Scope::Directory(dir_id.clone()), fields)?;
        let sessions = call(port, c"workspaceSnapshot", &[dir])?;
        let events = call(port, c"events", &[dir])?;
        let queues = call(port, c"queueSnapshot", &[dir])?;
        let payload = port.from_value(&V::Object(vec![]))?;
        payload.set(c"type", text(port, "snapshot")?)?;
        payload.set(c"dirId", dir)?;
        payload.set(c"sessions", sessions)?;
        payload.set(c"events", events)?;
        payload.set(c"queues", queues)?;
        self.dispatch_to(&env, port, &[id], payload, true)?;
        self.values.drain(&env)?;
        Ok(id as u32)
    }

    /// Register a `/ws/meta` fleet client and send the one-shot fleet snapshot.
    #[napi]
    pub fn attach_meta(
        &self,
        env: Env,
        socket: Unknown<'_>,
        fields: Unknown<'_>,
        port: Unknown<'_>,
    ) -> Result<u32> {
        self.values.drain(&env)?;
        let socket = L::new(&env, socket);
        let fields = L::new(&env, fields);
        let port = L::new(&env, port);
        let id = self.register(&env, socket, Scope::Fleet, fields)?;
        let entries = call(port, c"directoriesEntries", &[])?;
        let fleet = port.from_value(&V::Array(vec![]))?;
        let index = Cell::new(0u32);
        entries.for_each(|entry| {
            // Same destructuring as `for (const [dirId, directory] of directories)`.
            let (dir, directory) = entry.iterator_pair()?;
            let label = directory.optional(c"label")?;
            let sessions = call(port, c"workspaceSnapshot", &[dir])?;
            let events = call(port, c"events", &[dir])?;
            let queues = call(port, c"queueSnapshot", &[dir])?;
            let item = port.from_value(&V::Object(vec![]))?;
            item.set(c"dirId", dir)?;
            item.set(
                c"dirLabel",
                if label.truthy()? {
                    label
                } else {
                    port.from_value(&V::Null)?
                },
            )?;
            item.set(c"sessions", sessions)?;
            item.set(c"events", events)?;
            item.set(c"queues", queues)?;
            fleet.set_element(index.get(), item)?;
            index.set(index.get() + 1);
            Ok(())
        })?;
        let payload = port.from_value(&V::Object(vec![]))?;
        payload.set(c"type", text(port, "meta_snapshot")?)?;
        payload.set(c"fleet", fleet)?;
        self.dispatch_to(&env, port, &[id], payload, true)?;
        self.values.drain(&env)?;
        Ok(id as u32)
    }

    /// Remove a client after its `close` event. Cancels a pending flush timer
    /// and releases queued frames.
    #[napi]
    pub fn detach(&self, env: Env, id: u32, port: Unknown<'_>) -> Result<()> {
        self.values.drain(&env)?;
        let port = L::new(&env, port);
        let (timer, retired) = {
            let mut state = self.state.borrow_mut();
            let id = id as u64;
            state.clients.remove(id);
            state.sockets.remove(&id);
            state.heartbeat.remove(&id);
            state.fields.remove(&id);
            let timer = state.timers.remove(&id);
            let retired = state
                .backpressure
                .remove(&id)
                .map(|mut backpressure| backpressure.close())
                .unwrap_or_default();
            (timer, retired)
        };
        if let Some(timer) = timer {
            let anchor = self.values.anchor(&env)?;
            let timer = self.values.read(&env, anchor, &timer)?;
            call_catch(port, c"cancelSchedule", &[timer])?;
        }
        drop(retired);
        self.values.drain(&env)?;
        Ok(())
    }

    /// A pong completes the current window and clears the missed count.
    #[napi]
    pub fn on_pong(&self, id: u32) -> Result<()> {
        if let Some(heartbeat) = self.state.borrow_mut().heartbeat.get_mut(&(id as u64)) {
            heartbeat.on_pong();
        }
        Ok(())
    }

    /// One 30s heartbeat window for every owned socket. The timer itself stays
    /// in the shared connection router; the decision (and close) is native.
    #[napi]
    pub fn tick_heartbeat(&self, env: Env, port: Unknown<'_>) -> Result<u32> {
        self.values.drain(&env)?;
        let port = L::new(&env, port);
        let ids = { self.state.borrow().clients.ids() };
        let mut terminated = 0;
        for id in ids {
            let Some(socket) = self.socket(&env, id)? else {
                continue;
            };
            // The old loop skipped sockets that were closing and ones that had
            // already timed out before counting this window.
            if socket.get(c"readyState")?.number()? != 1.0 {
                continue;
            }
            if self
                .state
                .borrow()
                .heartbeat
                .get(&id)
                .is_none_or(Heartbeat::timed_out)
            {
                continue;
            }
            let tick = {
                let mut state = self.state.borrow_mut();
                state.heartbeat.get_mut(&id).map(Heartbeat::tick)
            };
            match tick {
                Some(HeartbeatTick::Ping) => {
                    call(port, c"ping", &[socket])?;
                }
                Some(HeartbeatTick::Terminate) => {
                    let missed = self
                        .state
                        .borrow()
                        .heartbeat
                        .get(&id)
                        .map_or(0, Heartbeat::missed_pongs);
                    let fields = { self.state.borrow().fields.get(&id).cloned() };
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

    /// Fan a workspace payload out to observers, the directory's scoped clients
    /// and every fleet client (with `dirId` appended last).
    #[napi]
    pub fn publish(
        &self,
        env: Env,
        dir_id: String,
        payload: Unknown<'_>,
        port: Unknown<'_>,
    ) -> Result<()> {
        self.values.drain(&env)?;
        let port = L::new(&env, port);
        let payload = L::new(&env, payload);
        let dir = port.from_value(&V::string(&dir_id))?;
        let observers: Vec<Value> = {
            let state = self.state.borrow();
            state.observers.values().cloned().collect()
        };
        for observer in observers {
            let anchor = self.values.anchor(&env)?;
            let observer = self.values.read(&env, anchor, &observer)?;
            call_catch(port, c"notify", &[observer, dir, payload])?;
        }
        let (scoped, fleet) = {
            let state = self.state.borrow();
            (state.clients.scoped(&dir_id), state.clients.fleet())
        };
        self.dispatch_to(&env, port, &scoped, payload, true)?;
        if !fleet.is_empty() {
            let meta = port.from_value(&V::Object(vec![]))?;
            meta.spread_from(payload)?;
            meta.set(c"dirId", dir)?;
            self.dispatch_to(&env, port, &fleet, meta, true)?;
        }
        self.values.drain(&env)?;
        Ok(())
    }

    /// Add an observer (a JS function). Duplicate identity is a no-op, matching
    /// `Set.add`. Returns the id used by `unsubscribe`.
    #[napi]
    pub fn subscribe(&self, env: Env, observer: Unknown<'_>) -> Result<u32> {
        self.values.drain(&env)?;
        let observer = L::new(&env, observer);
        let existing: Vec<(u64, Value)> = {
            let state = self.state.borrow();
            state
                .observers
                .iter()
                .map(|(id, value)| (*id, value.clone()))
                .collect()
        };
        for (id, value) in existing {
            let anchor = self.values.anchor(&env)?;
            if self.values.read(&env, anchor, &value)?.equals(observer)? {
                return Ok(id as u32);
            }
        }
        let value = self.values.capture(&env, observer)?;
        let id = {
            let mut state = self.state.borrow_mut();
            state.observer_next += 1;
            let id = state.observer_next;
            state.observers.insert(id, value);
            id
        };
        self.values.drain(&env)?;
        Ok(id as u32)
    }

    #[napi]
    pub fn unsubscribe(&self, id: u32) -> Result<()> {
        self.state.borrow_mut().observers.remove(&(id as u64));
        Ok(())
    }

    /// The hydrated ring as a fresh JS array of the same live event objects.
    #[napi]
    pub fn recent_events(&self, env: Env, dir_id: String) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let events: Vec<Value> = {
            let state = self.state.borrow();
            state
                .replay
                .get(&dir_id)
                .map(|ring| ring.iter().cloned().collect())
                .unwrap_or_default()
        };
        let anchor = self.values.anchor(&env)?;
        let array = anchor.from_value(&V::Array(vec![]))?;
        for (index, event) in events.iter().enumerate() {
            let live = self.values.read(&env, anchor, event)?;
            array.set_element(index as u32, live)?;
        }
        self.values.drain(&env)?;
        Ok(array.raw())
    }

    /// Install the disk-loaded ring for a directory (last 200 kept).
    #[napi]
    pub fn hydrate_events(&self, env: Env, dir_id: String, events: Unknown<'_>) -> Result<u32> {
        self.values.drain(&env)?;
        let events = L::new(&env, events);
        let mut collected = Vec::new();
        events.for_each(|event| {
            collected.push(self.values.capture(&env, event)?);
            Ok(())
        })?;
        let kept = self.state.borrow_mut().replay.hydrate(&dir_id, collected);
        self.values.drain(&env)?;
        Ok(kept as u32)
    }

    #[napi]
    pub fn append_event(&self, env: Env, dir_id: String, event: Unknown<'_>) -> Result<()> {
        self.values.drain(&env)?;
        let event = self.values.capture(&env, L::new(&env, event))?;
        let evicted = self.state.borrow_mut().replay.push(&dir_id, event);
        drop(evicted);
        self.values.drain(&env)?;
        Ok(())
    }

    #[napi]
    pub fn has_events(&self, dir_id: String) -> bool {
        self.state.borrow().replay.has(&dir_id)
    }

    #[napi]
    pub fn client_count(&self, dir_id: String) -> u32 {
        self.state.borrow().clients.directory_clients(&dir_id) as u32
    }

    #[napi]
    pub fn has_client(&self, env: Env, dir_id: String, socket: Unknown<'_>) -> Result<bool> {
        self.values.drain(&env)?;
        let socket = L::new(&env, socket);
        let ids = { self.state.borrow().clients.scoped(&dir_id) };
        for id in ids {
            let value = { self.state.borrow().sockets.get(&id).cloned() };
            if let Some(value) = value {
                let anchor = self.values.anchor(&env)?;
                if self.values.read(&env, anchor, &value)?.equals(socket)? {
                    self.values.drain(&env)?;
                    return Ok(true);
                }
            }
        }
        self.values.drain(&env)?;
        Ok(false)
    }

    #[napi]
    pub fn directory_count(&self) -> u32 {
        self.state.borrow().clients.directory_count() as u32
    }

    #[napi]
    pub fn fleet_len(&self) -> u32 {
        self.state.borrow().clients.fleet_len() as u32
    }

    /// Heartbeat state for the connection-close log, or null once detached.
    #[napi]
    pub fn socket_stats(&self, env: Env, id: u32) -> Result<sys::napi_value> {
        self.values.drain(&env)?;
        let output = {
            let state = self.state.borrow();
            match state.heartbeat.get(&(id as u64)) {
                Some(heartbeat) => V::object(vec![
                    ("missedPongs", V::Number(heartbeat.missed_pongs() as f64)),
                    ("timedOut", V::Bool(heartbeat.timed_out())),
                ]),
                None => V::Null,
            }
        };
        let anchor = self.values.anchor(&env)?;
        let value = anchor.from_value(&output)?;
        self.values.drain(&env)?;
        Ok(value.raw())
    }

    /// Fired by the per-client retry timer: continue draining the queue.
    #[napi]
    pub fn flush_client(&self, env: Env, id: u32, port: Unknown<'_>) -> Result<()> {
        self.values.drain(&env)?;
        let port = L::new(&env, port);
        {
            let timer = self.state.borrow_mut().timers.remove(&(id as u64));
            drop(timer);
        }
        self.flush_id(&env, port, id as u64)?;
        self.values.drain(&env)?;
        Ok(())
    }

    /// Transport send completion for `sendFrame(id, …)`.
    #[napi]
    pub fn backpressure_result(
        &self,
        env: Env,
        id: u32,
        error: Unknown<'_>,
        port: Unknown<'_>,
    ) -> Result<()> {
        self.values.drain(&env)?;
        let id = id as u64;
        if !self.state.borrow().backpressure.contains_key(&id) {
            // The unknown-directory error frame has no registered client.
            return Ok(());
        }
        let ok = L::new(&env, error).nullish()?;
        let port = L::new(&env, port);
        let Some(socket) = self.socket(&env, id)? else {
            return Ok(());
        };
        let buffered = socket.get(c"bufferedAmount")?.number()?.max(0.0);
        let limits = Limits::default();
        let now = Self::clock_if_needed(port, buffered, &limits)?;
        let effects = {
            let mut state = self.state.borrow_mut();
            let Some(backpressure) = state.backpressure.get_mut(&id) else {
                return Ok(());
            };
            backpressure.send_result(ok, &limits, buffered, now)
        };
        self.apply_effects(&env, port, id, effects)?;
        self.values.drain(&env)?;
        Ok(())
    }

    /// Release every client, ring and observer. Open sockets are closed by the
    /// host lifecycle; this only drops native state and cancels timers.
    #[napi]
    pub fn close(&self, env: Env, port: Unknown<'_>) -> Result<()> {
        self.values.drain(&env)?;
        let port = L::new(&env, port);
        let timers: Vec<Value> = {
            let mut state = self.state.borrow_mut();
            let timers = state.timers.drain().map(|(_, timer)| timer).collect();
            state.clients = Clients::default();
            state.sockets.clear();
            state.heartbeat.clear();
            state.backpressure.clear();
            state.fields.clear();
            state.observers.clear();
            state.replay.clear();
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
