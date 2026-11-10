//! napi owner of the four turn-progress modules with private state.
//!
//! `src/chat/turn-progress.js` only forwards arguments, validates constructor
//! options and the heartbeat id/cadence contract, owns the single unref'd timer
//! and freezes returned objects. Every decision — heartbeat cadence, timing
//! records and the two log lines, the per-turn model timeline and the
//! delivery-handoff probe — lives in `multicc_core::turn_progress`.
//!
//! Host I/O is per-call: each method receives one `ports` object and reads the
//! callbacks it needs lazily, so no host function is retained. A throwing
//! `onHeartbeat` is caught and reported through `logWarn` (fixed bug: it used
//! to escape the interval callback as an uncaught exception).
use crate::js_live::LiveValue as L;
use multicc_core::background::state::js_max;
use multicc_core::js::coerce::{js_to_number, js_to_string, truthy};
use multicc_core::js::{JsString, JsValue as V};
use multicc_core::turn_progress::{heartbeat as hb, probe, timeline, timing};
use napi::{
    bindgen_prelude::{JsValue as _, Unknown},
    sys, Env, Result,
};
use napi_derive::napi;
use std::cell::RefCell;
use std::ffi::CStr;

fn read(env: Env, value: Unknown<'_>) -> Result<V> {
    unsafe { crate::js_bridge::read_value(env.raw(), value.raw(), 0, &mut Vec::new()) }
}

fn read_live(value: L<'_>) -> Result<V> {
    unsafe { crate::js_bridge::read_value(value.env(), value.raw(), 0, &mut Vec::new()) }
}

fn write(env: Env, value: &V) -> Result<sys::napi_value> {
    unsafe { crate::js_bridge::write_value(env.raw(), value) }
}

fn key(text: &str) -> JsString {
    JsString::from_rust_str(text)
}

fn string(text: &str) -> V {
    V::String(key(text))
}

fn obj(entries: Vec<(&str, V)>) -> V {
    V::Object(
        entries
            .into_iter()
            .map(|(name, value)| (key(name), value))
            .collect(),
    )
}

fn number(value: f64) -> V {
    V::Number(value)
}

fn opt_number(value: Option<f64>) -> V {
    value.map(V::Number).unwrap_or(V::Null)
}

fn opt_string(value: Option<&'static str>) -> V {
    value.map(string).unwrap_or(V::Null)
}

// ── host ports ──────────────────────────────────────────────────────────────

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

    /// The raw `now()` result (legacy stores it without coercion).
    fn now_raw(&self) -> Result<V> {
        let value = self.call(c"now", &[])?;
        read_live(value)
    }

    /// `_timestamp()`: `Number(now())`, a finite number or a TypeError.
    fn heartbeat_now(&self) -> Result<f64> {
        let number = js_to_number(&self.now_raw()?);
        if !number.is_finite() {
            return Err(self.anchor.type_error("now must return a finite number"));
        }
        Ok(number)
    }

    fn log_warn(&self, label: &str, error: L<'a>) -> Result<()> {
        let Ok(log) = self.function(c"logWarn") else {
            return Ok(());
        };
        let _ = self.call_caught(log, &[self.value(&string(label))?, error])?;
        Ok(())
    }
}

// ── value builders (legacy key order, frozen by the facade) ─────────────────

fn snapshot_value(snapshot: &hb::Snapshot) -> V {
    obj(vec![
        ("sessionId", V::String(snapshot.session_id.clone())),
        ("turnId", V::String(snapshot.turn_id.clone())),
        ("startedAt", number(snapshot.started_at)),
        ("lastUserVisibleAt", number(snapshot.last_user_visible_at)),
        ("lastActivityAt", number(snapshot.last_activity_at)),
        ("phase", string(snapshot.phase)),
        ("safeToolKind", opt_string(snapshot.safe_tool_kind)),
    ])
}

fn status_value(status: &hb::Status, silent_ms: f64) -> V {
    obj(vec![
        ("sessionId", V::String(status.session_id.clone())),
        ("turnId", V::String(status.turn_id.clone())),
        ("phase", string(status.phase)),
        ("safeToolKind", opt_string(status.safe_tool_kind)),
        ("startedAt", number(status.started_at)),
        ("silentMs", number(silent_ms)),
    ])
}

fn payload_value(payload: &hb::Payload) -> V {
    obj(vec![
        ("sessionId", V::String(payload.session_id.clone())),
        ("turnId", V::String(payload.turn_id.clone())),
        ("elapsedMs", number(payload.elapsed_ms)),
        ("silentMs", number(payload.silent_ms)),
        ("phase", string(payload.phase)),
        ("toolKind", opt_string(payload.tool_kind)),
        ("activityAgeMs", number(payload.activity_age_ms)),
    ])
}

fn record_value(record: &timing::Record) -> V {
    obj(vec![
        ("sessionId", record.session.clone()),
        ("turnId", record.turn.clone()),
        ("cli", record.cli.clone()),
        ("t0", record.t0.clone()),
        ("t1", record.t1.clone().unwrap_or(V::Null)),
        ("t2", record.t2.clone().unwrap_or(V::Null)),
        ("t3", record.t3.clone().unwrap_or(V::Null)),
        ("logged", V::Bool(record.logged)),
    ])
}

fn timings_value(timings: &timing::Timings) -> V {
    obj(vec![
        ("t0", timings.t0.clone()),
        ("t1", timings.t1.clone().unwrap_or(V::Null)),
        ("t2", timings.t2.clone().unwrap_or(V::Null)),
        ("t3", timings.t3.clone().unwrap_or(V::Null)),
        ("spawnMs", opt_number(timings.spawn_ms)),
        ("sendMs", opt_number(timings.send_ms)),
        ("firstByteMs", opt_number(timings.first_byte_ms)),
        ("totalMs", opt_number(timings.total_ms)),
    ])
}

fn summary_value(plan: &timing::LogPlan) -> V {
    obj(vec![
        ("sessionId", plan.session.clone()),
        ("turnId", plan.turn.clone()),
        ("cli", plan.cli.clone()),
        ("t0", plan.t0.clone()),
        ("t1", plan.t1.clone().unwrap_or(V::Null)),
        ("t2", plan.t2.clone().unwrap_or(V::Null)),
        ("t3", plan.t3.clone().unwrap_or(V::Null)),
        (
            "ms",
            obj(vec![
                ("spawn", opt_number(plan.spawn_ms)),
                ("send", opt_number(plan.send_ms)),
                ("firstByte", opt_number(plan.first_byte_ms)),
                ("total", opt_number(plan.total_ms)),
            ]),
        ),
    ])
}

fn log_plan_value(plan: &timing::LogPlan) -> V {
    let summary = summary_value(plan);
    match &plan.reason {
        None => summary,
        Some(reason) => {
            let mut entries = vec![("reason".to_string(), V::String(reason.clone()))];
            if let V::Object(rest) = summary {
                for (name, value) in rest {
                    entries.push((name.to_string_lossy(), value));
                }
            }
            V::Object(
                entries
                    .into_iter()
                    .map(|(name, value)| (key(&name), value))
                    .collect(),
            )
        }
    }
}

fn stage_value(stage: &timeline::Stage) -> V {
    obj(vec![
        ("stage", string(stage.stage)),
        ("since", opt_number(stage.since)),
        ("ageMs", opt_number(stage.age_ms)),
        ("precise", V::Bool(stage.precise)),
    ])
}

fn spans_value(snapshot: &timeline::Snapshot) -> V {
    let spans = snapshot
        .spans
        .iter()
        .map(|span| {
            obj(vec![
                ("k", string(span.k.as_str())),
                ("s", number(span.s)),
                ("e", opt_number(span.e)),
            ])
        })
        .collect();
    obj(vec![
        ("origin", number(snapshot.origin)),
        ("spans", V::Array(spans)),
    ])
}

fn probe_value(entry: &probe::Entry) -> V {
    obj(vec![
        ("known", V::Bool(true)),
        ("handedOff", V::Bool(entry.handed_off)),
        ("turnId", entry.turn_id.clone()),
        ("at", number(entry.at)),
    ])
}

// ── the owner ───────────────────────────────────────────────────────────────

struct State {
    heartbeat: hb::Heartbeat,
    timing: timing::Timing,
    timelines: timeline::Timelines,
    probes: probe::Probes,
}

#[napi]
pub struct RustTurnProgress {
    state: RefCell<State>,
}

#[napi]
impl RustTurnProgress {
    /// Options are validated by the facade (legacy TypeErrors); the owner only
    /// stores the two numbers.
    #[napi(constructor)]
    pub fn new(env: Env, interval_ms: Unknown<'_>, max_identities: Unknown<'_>) -> Result<Self> {
        let interval = js_to_number(&read(env, interval_ms)?);
        let max_identities = js_to_number(&read(env, max_identities)?);
        Ok(Self {
            state: RefCell::new(State {
                heartbeat: hb::Heartbeat::new(interval),
                timing: timing::Timing::new(),
                timelines: timeline::Timelines::new(),
                probes: probe::Probes::new(max_identities),
            }),
        })
    }

    // ── heartbeat ──────────────────────────────────────────────────────────

    /// `start(sessionId, turnId, update)`: clean ids, drop a predecessor, read
    /// the clock, then normalize the phase and insert.
    #[napi]
    pub fn heartbeat_start(
        &self,
        env: Env,
        session: Unknown<'_>,
        turn: Unknown<'_>,
        update: Unknown<'_>,
        ports: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let session = js_to_string(&read(env, session)?);
        let turn = js_to_string(&read(env, turn)?);
        let update = read(env, update)?;
        let ports = Ports::new(&env, ports);
        {
            self.state
                .borrow_mut()
                .heartbeat
                .remove_session_predecessors(&session);
        }
        let now = ports.heartbeat_now()?;
        let parsed = hb::PhaseUpdate::from_values(Some(&update), None);
        let snapshot = self
            .state
            .borrow_mut()
            .heartbeat
            .start(&session, &turn, now, &parsed);
        write(env, &snapshot_value(&snapshot))
    }

    #[napi]
    pub fn heartbeat_touch_visible(
        &self,
        env: Env,
        session: Unknown<'_>,
        turn: Unknown<'_>,
        ports: Unknown<'_>,
    ) -> Result<bool> {
        let session = js_to_string(&read(env, session)?);
        let turn = js_to_string(&read(env, turn)?);
        let found = self.state.borrow().heartbeat.find(&session, &turn);
        let Some(found) = found else {
            return Ok(false);
        };
        let now = Ports::new(&env, ports).heartbeat_now()?;
        Ok(self.state.borrow_mut().heartbeat.touch_visible(&found, now))
    }

    #[napi]
    pub fn heartbeat_touch_activity(
        &self,
        env: Env,
        session: Unknown<'_>,
        turn: Unknown<'_>,
        ports: Unknown<'_>,
    ) -> Result<bool> {
        let session = js_to_string(&read(env, session)?);
        let turn = js_to_string(&read(env, turn)?);
        let found = self.state.borrow().heartbeat.find(&session, &turn);
        let Some(found) = found else {
            return Ok(false);
        };
        let now = Ports::new(&env, ports).heartbeat_now()?;
        Ok(self
            .state
            .borrow_mut()
            .heartbeat
            .touch_activity(&found, now))
    }

    /// Phase first, clock afterwards: a throwing `now` still keeps the new
    /// phase, exactly like the legacy `updatePhase`.
    #[napi]
    pub fn heartbeat_update_phase(
        &self,
        env: Env,
        session: Unknown<'_>,
        turn: Unknown<'_>,
        update: Unknown<'_>,
        safe_tool_kind: Unknown<'_>,
        ports: Unknown<'_>,
    ) -> Result<bool> {
        let session = js_to_string(&read(env, session)?);
        let turn = js_to_string(&read(env, turn)?);
        let update = read(env, update)?;
        let safe_tool_kind = read(env, safe_tool_kind)?;
        let found = self.state.borrow().heartbeat.find(&session, &turn);
        let Some(found) = found else {
            return Ok(false);
        };
        let parsed = hb::PhaseUpdate::from_values(Some(&update), Some(&safe_tool_kind));
        self.state
            .borrow_mut()
            .heartbeat
            .update_phase(&found, &parsed);
        let now = Ports::new(&env, ports).heartbeat_now()?;
        Ok(self
            .state
            .borrow_mut()
            .heartbeat
            .touch_activity(&found, now))
    }

    #[napi]
    pub fn heartbeat_stop(
        &self,
        env: Env,
        session: Unknown<'_>,
        turn: Unknown<'_>,
    ) -> Result<bool> {
        let session = js_to_string(&read(env, session)?);
        let turn = js_to_string(&read(env, turn)?);
        let found = self.state.borrow().heartbeat.find(&session, &turn);
        let Some(found) = found else {
            return Ok(false);
        };
        Ok(self.state.borrow_mut().heartbeat.stop(&found))
    }

    #[napi]
    pub fn heartbeat_status(
        &self,
        env: Env,
        session: Unknown<'_>,
        ports: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let session = js_to_string(&read(env, session)?);
        let status = self.state.borrow().heartbeat.status(&session);
        let Some(status) = status else {
            return write(env, &V::Null);
        };
        let now = Ports::new(&env, ports).heartbeat_now()?;
        let silent_ms = js_max(0.0, now - status.last_user_visible_at);
        write(env, &status_value(&status, silent_ms))
    }

    #[napi]
    pub fn heartbeat_stop_all(&self) -> u32 {
        self.state.borrow_mut().heartbeat.stop_all() as u32
    }

    /// Earliest deadline for the facade's single timer (`null` when idle).
    #[napi]
    pub fn heartbeat_next_due(&self) -> Option<f64> {
        self.state.borrow().heartbeat.next_due()
    }

    /// Number of active entries (test aid replacing the legacy per-entry timers).
    #[napi]
    pub fn heartbeat_active_turns(&self) -> u32 {
        self.state.borrow().heartbeat.active_turns() as u32
    }

    /// Fire every deadline that passed at `at`. Each `fire` re-checks the entry
    /// generation, then the host callback runs with the borrow released.
    #[napi]
    pub fn heartbeat_due(&self, env: Env, at: Unknown<'_>, ports: Unknown<'_>) -> Result<()> {
        let at = js_to_number(&read(env, at)?);
        let ports = Ports::new(&env, ports);
        let due = self.state.borrow().heartbeat.due(at);
        for item in due {
            let payload = self.state.borrow_mut().heartbeat.fire(&item, at);
            let Some(payload) = payload else {
                continue;
            };
            let callback = ports.function(c"onHeartbeat")?;
            let argument = ports.value(&payload_value(&payload))?;
            match ports.call_caught(callback, &[argument]) {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    // Fixed bug: a throwing callback used to become an
                    // uncaught exception inside the interval handler. Report it
                    // and keep the remaining entries firing.
                    ports.log_warn("progress_heartbeat_failed", error)?;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    // ── turn timing ────────────────────────────────────────────────────────

    /// `begin(sessionId, turnId, { t0, cli })`.
    #[napi]
    pub fn timing_begin(
        &self,
        env: Env,
        session: Unknown<'_>,
        turn: Unknown<'_>,
        options: Unknown<'_>,
        ports: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let session = read(env, session)?;
        let turn = read(env, turn)?;
        let options = read(env, options)?;
        if !truthy(&session) || !truthy(&turn) {
            return write(env, &V::Null);
        }
        self.state.borrow_mut().timing.evict_logged();
        let ports = Ports::new(&env, ports);
        let t0 = match timing::finite_number(options.get("t0")) {
            Some(value) => V::Number(value),
            None => ports.now_raw()?,
        };
        let cli = match options.get("cli") {
            Some(value) if truthy(value) => value.clone(),
            _ => V::Null,
        };
        let record = self
            .state
            .borrow_mut()
            .timing
            .begin(&session, &turn, t0, cli);
        write(env, &record_value(&record))
    }

    /// `markSpawned` / `markSent`: first mark wins, clock read only when the
    /// supplied timestamp is not a finite number.
    #[napi]
    pub fn timing_mark(
        &self,
        env: Env,
        session: Unknown<'_>,
        turn: Unknown<'_>,
        field: Unknown<'_>,
        ts: Unknown<'_>,
        ports: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let session = read(env, session)?;
        let turn = read(env, turn)?;
        let instant = match read(env, field)? {
            V::String(name) if name == "t1" => timing::Instant::Spawned,
            V::String(name) if name == "t2" => timing::Instant::Sent,
            _ => return write(env, &V::Null),
        };
        let found = self.state.borrow().timing.find(&session, Some(&turn));
        let Some(found) = found else {
            return write(env, &V::Null);
        };
        if !self.state.borrow().timing.instant_is_empty(&found, instant) {
            return write(env, &V::Null);
        }
        let ts = read(env, ts)?;
        let value = match timing::finite_number(Some(&ts)) {
            Some(value) => V::Number(value),
            None => Ports::new(&env, ports).now_raw()?,
        };
        let record = self
            .state
            .borrow_mut()
            .timing
            .set_instant(&found, instant, value);
        match record {
            Some(record) => write(env, &record_value(&record)),
            None => write(env, &V::Null),
        }
    }

    #[napi]
    pub fn timing_mark_first_byte(
        &self,
        env: Env,
        session: Unknown<'_>,
        turn: Unknown<'_>,
        ts: Unknown<'_>,
        ports: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let session = read(env, session)?;
        let turn = read(env, turn)?;
        let found = self.state.borrow().timing.find(&session, Some(&turn));
        let Some(found) = found else {
            return write(env, &V::Null);
        };
        if !self
            .state
            .borrow()
            .timing
            .instant_is_empty(&found, timing::Instant::FirstByte)
        {
            return write(env, &V::Null);
        }
        let ts = read(env, ts)?;
        let value = match timing::finite_number(Some(&ts)) {
            Some(value) => V::Number(value),
            None => Ports::new(&env, ports).now_raw()?,
        };
        let outcome = self
            .state
            .borrow_mut()
            .timing
            .mark_first_byte(&found, value);
        let Some((record, plan)) = outcome else {
            return write(env, &V::Null);
        };
        if let Some(plan) = plan {
            let ports = Ports::new(&env, ports);
            let callback = ports.function(c"emitTiming")?;
            let argument = ports.value(&log_plan_value(&plan))?;
            callback.call_plain(&[argument])?;
        }
        write(env, &record_value(&record))
    }

    #[napi]
    pub fn timing_abort(
        &self,
        env: Env,
        session: Unknown<'_>,
        turn: Unknown<'_>,
        reason: Unknown<'_>,
        ports: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let session = read(env, session)?;
        let turn = read(env, turn)?;
        let reason = read(env, reason)?;
        let found = self.state.borrow().timing.find(&session, Some(&turn));
        let Some(found) = found else {
            return write(env, &V::Null);
        };
        if self.state.borrow().timing.logged(&found) {
            return write(env, &V::Null);
        }
        let outcome = self
            .state
            .borrow_mut()
            .timing
            .abort(&found, timing::Timing::abort_reason(Some(&reason)));
        let Some((record, plan)) = outcome else {
            return write(env, &V::Null);
        };
        let ports = Ports::new(&env, ports);
        let callback = ports.function(c"emitAbort")?;
        let argument = ports.value(&log_plan_value(&plan))?;
        callback.call_plain(&[argument])?;
        write(env, &record_value(&record))
    }

    #[napi]
    pub fn timing_get(
        &self,
        env: Env,
        session: Unknown<'_>,
        turn: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let session = read(env, session)?;
        let turn = read(env, turn)?;
        let record = self
            .state
            .borrow()
            .timing
            .get(&session, Some(&turn))
            .cloned();
        match record {
            Some(record) => write(env, &record_value(&record)),
            None => write(env, &V::Null),
        }
    }

    /// `turnTimingsField`: `undefined` until the first byte is known.
    #[napi]
    pub fn timing_field(
        &self,
        env: Env,
        session: Unknown<'_>,
        turn: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let session = read(env, session)?;
        let turn = read(env, turn)?;
        let field = self.state.borrow().timing.field(&session, Some(&turn));
        match field {
            Some(field) => write(env, &timings_value(&field)),
            None => write(env, &V::Undefined),
        }
    }

    #[napi]
    pub fn timing_drop(&self, env: Env, session: Unknown<'_>, turn: Unknown<'_>) {
        let Ok(session) = read(env, session) else {
            return;
        };
        let turn = read(env, turn).ok();
        self.state.borrow_mut().timing.drop(&session, turn.as_ref());
    }

    // ── turn timeline (state keyed by session name) ─────────────────────────

    /// `startTurn(cs, now)`: `origin = Number.isFinite(cs.turnStartedAt) ?
    /// cs.turnStartedAt : now`, `null` when cs is falsy.
    #[napi]
    pub fn timeline_start(
        &self,
        env: Env,
        session: Unknown<'_>,
        cs: Unknown<'_>,
        at: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let at = js_to_number(&read(env, at)?);
        let cs = L::new(&env, cs);
        if !cs.truthy()? {
            return write(env, &V::Null);
        }
        let started = cs.get(c"turnStartedAt")?.number_value()?;
        let origin = started.filter(|value| value.is_finite()).unwrap_or(at);
        let session = read(env, session)?;
        self.state.borrow_mut().timelines.start(&session, origin);
        write(env, &number(origin))
    }

    #[napi]
    pub fn timeline_observe_claude(
        &self,
        env: Env,
        session: Unknown<'_>,
        cs: Unknown<'_>,
        evt: Unknown<'_>,
        at: Unknown<'_>,
    ) -> Result<()> {
        let at = js_to_number(&read(env, at)?);
        if !L::new(&env, cs).truthy()? {
            return Ok(());
        }
        let session_value = read(env, session)?;
        if !self.state.borrow().timelines.contains(&session_value) {
            return Ok(());
        }
        let event = L::new(&env, evt);
        if !event.truthy()? || event.kind()? != sys::ValueType::napi_object {
            return Ok(());
        }
        let evt = read_live(event)?;
        self.state
            .borrow_mut()
            .timelines
            .observe_claude(&session_value, &evt, at);
        Ok(())
    }

    #[napi]
    pub fn timeline_observe_adapter(
        &self,
        env: Env,
        session: Unknown<'_>,
        cs: Unknown<'_>,
        evt: Unknown<'_>,
        at: Unknown<'_>,
    ) -> Result<()> {
        let at = js_to_number(&read(env, at)?);
        let chat = L::new(&env, cs);
        if !chat.truthy()? {
            return Ok(());
        }
        let session_value = read(env, session)?;
        if !self.state.borrow().timelines.contains(&session_value) {
            return Ok(());
        }
        let event = L::new(&env, evt);
        if !event.truthy()? || event.kind()? != sys::ValueType::napi_object {
            return Ok(());
        }
        let evt = read_live(event)?;
        let is_tool_update =
            matches!(evt.get("type"), Some(V::String(name)) if name == "tool_update");
        if !is_tool_update {
            self.state.borrow_mut().timelines.observe_adapter(
                &session_value,
                &evt,
                &V::Null,
                false,
                at,
            );
            return Ok(());
        }
        // `evt.id || 'call_' + String((cs.currentToolCalls || []).length)`
        let calls = chat.optional(c"currentToolCalls")?;
        let length = if calls.truthy()? {
            read_live(calls.get(c"length")?)?
        } else {
            V::Number(0.0)
        };
        let id = timeline::Timelines::tool_update_id(&evt, Some(&length));
        let id_live = L::from_raw(env.raw(), unsafe {
            crate::js_bridge::write_value(env.raw(), &id)?
        });
        let mut already_known = false;
        if calls.truthy()? && calls.is_array()? {
            calls.for_each(|item| {
                if already_known || !item.truthy()? {
                    return Ok(());
                }
                already_known = item.get(c"id")?.equals(id_live)?;
                Ok(())
            })?;
        }
        self.state.borrow_mut().timelines.observe_adapter(
            &session_value,
            &evt,
            &id,
            already_known,
            at,
        );
        Ok(())
    }

    /// Live model stage. `cs.cli` is only read when the lane has not shown
    /// frame-level partials yet (the legacy `||` short-circuits first).
    #[napi]
    pub fn timeline_current_stage(
        &self,
        env: Env,
        session: Unknown<'_>,
        cs: Unknown<'_>,
        at: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let at = js_to_number(&read(env, at)?);
        let chat = L::new(&env, cs);
        if !chat.truthy()? {
            return write(env, &V::Null);
        }
        let session_value = read(env, session)?;
        let partial = self.state.borrow().timelines.partial(&session_value);
        let Some(partial) = partial else {
            return write(env, &V::Null);
        };
        let cli = if partial {
            None
        } else {
            Some(read_live(chat.optional(c"cli")?)?)
        };
        let stage = self
            .state
            .borrow()
            .timelines
            .current_stage(&session_value, cli.as_ref(), at);
        match stage {
            Some(stage) => write(env, &stage_value(&stage)),
            None => write(env, &V::Null),
        }
    }

    #[napi]
    pub fn timeline_snapshot(
        &self,
        env: Env,
        session: Unknown<'_>,
        cs: Unknown<'_>,
        at: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let at = js_to_number(&read(env, at)?);
        if !L::new(&env, cs).truthy()? {
            return write(env, &V::Null);
        }
        let session_value = read(env, session)?;
        let snapshot = self.state.borrow().timelines.snapshot(&session_value, at);
        match snapshot {
            Some(snapshot) => write(env, &spans_value(&snapshot)),
            None => write(env, &V::Null),
        }
    }

    #[napi]
    pub fn timeline_field(
        &self,
        env: Env,
        session: Unknown<'_>,
        cs: Unknown<'_>,
        at: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        self.timeline_snapshot(env, session, cs, at)
    }

    /// Chat-session delete hook; drops the by-name timeline.
    #[napi]
    pub fn timeline_forget(&self, env: Env, session: Unknown<'_>) -> Result<bool> {
        let session = read(env, session)?;
        Ok(self.state.borrow_mut().timelines.forget(&session))
    }

    // ── delivery-handoff probe ─────────────────────────────────────────────

    #[napi]
    pub fn probe_record(
        &self,
        env: Env,
        session: Unknown<'_>,
        client_msg_id: Unknown<'_>,
        delivery_id: Unknown<'_>,
        facts: Unknown<'_>,
        ports: Unknown<'_>,
    ) -> Result<()> {
        let session = read(env, session)?;
        let client_msg_id = read(env, client_msg_id)?;
        let delivery_id = read(env, delivery_id)?;
        let facts = read(env, facts)?;
        if !truthy(&session) || (!truthy(&client_msg_id) && !truthy(&delivery_id)) {
            return Ok(());
        }
        self.state.borrow_mut().probes.ensure_session(&session);
        let ports = Ports::new(&env, ports);
        let at = match ports.now_raw() {
            Ok(value) => js_to_number(&value),
            Err(error) => {
                // Fixed bug: the legacy call left an empty per-session table
                // behind when the clock threw.
                self.state.borrow_mut().probes.prune_empty(&session);
                return Err(error);
            }
        };
        let handed_off = matches!(facts.get("handedOff"), Some(V::Bool(true)));
        let turn_id = match facts.get("turnId") {
            Some(value) if truthy(value) => value.clone(),
            _ => V::Null,
        };
        self.state.borrow_mut().probes.record(
            &session,
            Some(&client_msg_id),
            Some(&delivery_id),
            handed_off,
            turn_id,
            at,
        );
        Ok(())
    }

    #[napi]
    pub fn probe_lookup(
        &self,
        env: Env,
        session: Unknown<'_>,
        identity: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let session = read(env, session)?;
        let identity = read(env, identity)?;
        if !truthy(&session) || !truthy(&identity) {
            return write(env, &V::Null);
        }
        let entry = self
            .state
            .borrow()
            .probes
            .lookup(&session, &identity)
            .cloned();
        match entry {
            Some(entry) => write(env, &probe_value(&entry)),
            None => write(env, &V::Null),
        }
    }

    #[napi]
    pub fn probe_forget(&self, env: Env, session: Unknown<'_>) -> Result<bool> {
        let session = read(env, session)?;
        Ok(self.state.borrow_mut().probes.forget(&session))
    }

    #[napi]
    pub fn probe_session_count(&self) -> u32 {
        self.state.borrow().probes.session_count() as u32
    }
}

// ── pure exports used directly by the facade ────────────────────────────────

#[napi]
pub fn turn_progress_sanitize_phase(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    let value = read(env, value)?;
    write(env, &string(hb::sanitize_phase_value(Some(&value))))
}

#[napi]
pub fn turn_progress_sanitize_tool_kind(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    let value = read(env, value)?;
    write(env, &opt_string(hb::sanitize_tool_kind_value(Some(&value))))
}

#[napi]
pub fn turn_progress_should_reexecute(
    env: Env,
    duplicate_seen: Unknown<'_>,
    duplicate_persisted: Unknown<'_>,
    probe: Unknown<'_>,
) -> Result<bool> {
    let seen = read(env, duplicate_seen)?;
    let persisted = read(env, duplicate_persisted)?;
    let probe = read(env, probe)?;
    Ok(probe::should_reexecute(&seen, &persisted, Some(&probe)))
}
