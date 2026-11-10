//! Silent-period heartbeat kernel (migrated from
//! `src/chat/progress-heartbeat.js`).
//!
//! One active entry per session. An entry keeps the phase/tool category the
//! host last reported and three instants: turn start, last user-visible event
//! and last activity. The facade arms one unref'd timer from the earliest
//! `next_at`; `tick` fires every entry whose deadline has passed and the
//! addon owner calls the host `onHeartbeat` port with a frozen payload.
//!
//! The clock is never read inside this kernel: the addon owner reads the host
//! port at the exact points the legacy code did and passes the value in, so
//! "unknown key never calls now" and "phase is set before the clock is read"
//! stay observable.
//!
//! Fixed bug (intentional divergence from the legacy alias tables): the legacy
//! `PHASE_ALIASES[name] || 'running'` object lookup also accepted inherited
//! prototype members, so a phase named `constructor` (or `__proto__`) produced
//! a function/object instead of a canonical category. This kernel matches on
//! the canonical literals, so such inputs behave like any other unknown value.
use crate::background::state::{js_max, OrderedMap};
use crate::js::{
    coerce::{js_to_string, truthy},
    string::JsString,
    JsValue,
};

pub const DEFAULT_INTERVAL_MS: f64 = 8_000.0;

fn normalized(value: Option<&JsValue>) -> Option<JsString> {
    value
        .filter(|value| !matches!(value, JsValue::Undefined | JsValue::Null))
        .map(js_to_string)
}

fn normalized_text(value: Option<&JsString>) -> Option<String> {
    value.map(|text| text.trim().to_lowercase().to_string_lossy())
}

/// Canonical phase of an unknown/absent value (`sanitizePhase`).
pub fn sanitize_phase(value: Option<&JsString>) -> &'static str {
    match normalized_text(value).unwrap_or_default().as_str() {
        "starting" | "preparing" => "starting",
        "thinking" | "reasoning" => "thinking",
        "tool" | "executing" => "tool",
        "waiting" | "monitoring" => "waiting",
        "finalizing" => "finalizing",
        "recovering" => "recovering",
        _ => "running",
    }
}

/// `sanitizePhase(value)` for a raw JavaScript value.
pub fn sanitize_phase_value(value: Option<&JsValue>) -> &'static str {
    sanitize_phase(normalized(value).as_ref())
}

/// Canonical tool category of an unknown/absent value (`sanitizeToolKind`).
/// Alias matches are exact literals (own-property semantics); the fallback
/// order is the legacy regex order.
pub fn sanitize_tool_kind(value: Option<&JsString>) -> Option<&'static str> {
    let text = normalized_text(value)?;
    let alias = match text.as_str() {
        "bash" | "command" | "exec" | "process" | "shell" => Some("process"),
        "edit" | "file" | "filesystem" | "patch" | "read" | "write" => Some("filesystem"),
        "find" | "search" => Some("search"),
        "browser" => Some("browser"),
        "fetch" | "http" | "network" | "web" => Some("network"),
        "monitor" | "wait" => Some("monitor"),
        "agent" | "subagent" | "task" => Some("subagent"),
        "integration" | "mcp" => Some("integration"),
        "other" => Some("other"),
        _ => None,
    };
    if alias.is_some() {
        return alias;
    }
    if text.contains("agent") || text.contains("task") || text.contains("collab") {
        return Some("subagent");
    }
    if text.contains("wait") || text.contains("monitor") || text.contains("poll") {
        return Some("monitor");
    }
    if text.contains("exec")
        || text.contains("bash")
        || text.contains("command")
        || text.contains("shell")
        || text.contains("process")
    {
        return Some("process");
    }
    if text.contains("read")
        || text.contains("write")
        || text.contains("edit")
        || text.contains("patch")
        || text.contains("file")
    {
        return Some("filesystem");
    }
    if text.contains("find") || text.contains("search") {
        return Some("search");
    }
    if text.contains("fetch")
        || text.contains("http")
        || text.contains("network")
        || text.contains("web")
    {
        return Some("network");
    }
    if text.is_empty() {
        None
    } else {
        Some("other")
    }
}

/// `sanitizeToolKind(value)` for a raw JavaScript value.
pub fn sanitize_tool_kind_value(value: Option<&JsValue>) -> Option<&'static str> {
    sanitize_tool_kind(normalized(value).as_ref())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PhaseUpdate {
    pub phase: &'static str,
    pub tool_kind: Option<&'static str>,
}

impl PhaseUpdate {
    pub fn from_text(phase: Option<&JsString>, tool_kind: Option<&JsString>) -> Self {
        Self {
            phase: sanitize_phase(phase),
            tool_kind: sanitize_tool_kind(tool_kind),
        }
    }

    /// `readPhaseUpdate(phaseOrUpdate, safeToolKind)`: an object update reads
    /// its own `safeToolKind` (falling back to `toolKind`); anything else is a
    /// bare phase plus the separate kind argument.
    pub fn from_values(update: Option<&JsValue>, safe_tool_kind: Option<&JsValue>) -> Self {
        let is_object = update.is_some_and(|value| {
            truthy(value)
                && matches!(
                    value,
                    JsValue::Object(_) | JsValue::Array(_) | JsValue::Bytes(_) | JsValue::Date(_)
                )
        });
        if is_object {
            let value = update.expect("object update");
            let phase = value.get("phase");
            let tool = match value {
                JsValue::Object(entries)
                    if entries.iter().any(|(key, _)| key == "safeToolKind") =>
                {
                    value.get("safeToolKind")
                }
                _ => value.get("toolKind"),
            };
            return Self {
                phase: sanitize_phase_value(phase),
                tool_kind: sanitize_tool_kind_value(tool),
            };
        }
        Self {
            phase: sanitize_phase_value(update),
            tool_kind: sanitize_tool_kind_value(safe_tool_kind),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub session_id: JsString,
    pub turn_id: JsString,
    pub started_at: f64,
    pub last_user_visible_at: f64,
    pub last_activity_at: f64,
    pub phase: &'static str,
    pub safe_tool_kind: Option<&'static str>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Status {
    pub session_id: JsString,
    pub turn_id: JsString,
    pub phase: &'static str,
    pub safe_tool_kind: Option<&'static str>,
    pub started_at: f64,
    pub last_user_visible_at: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Payload {
    pub session_id: JsString,
    pub turn_id: JsString,
    pub elapsed_ms: f64,
    pub silent_ms: f64,
    pub phase: &'static str,
    pub tool_kind: Option<&'static str>,
    pub activity_age_ms: f64,
}

#[derive(Clone, Debug)]
struct Entry {
    session_id: JsString,
    turn_id: JsString,
    started_at: f64,
    last_user_visible_at: f64,
    last_activity_at: f64,
    phase: &'static str,
    safe_tool_kind: Option<&'static str>,
    last_heartbeat_period: f64,
    next_at: f64,
    seq: u64,
}

impl Entry {
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            session_id: self.session_id.clone(),
            turn_id: self.turn_id.clone(),
            started_at: self.started_at,
            last_user_visible_at: self.last_user_visible_at,
            last_activity_at: self.last_activity_at,
            phase: self.phase,
            safe_tool_kind: self.safe_tool_kind,
        }
    }
}

/// `<session.length>:<session><turn>` — the legacy `_key` shape.
pub fn key(session: &JsString, turn: &JsString) -> JsString {
    let mut out = JsString::from_rust_str(&session.len().to_string());
    out.push_str(":");
    out.push(session);
    out.push(turn);
    out
}

/// `_find`'s id normalization: nullish becomes empty, everything else goes
/// through `String(value).trim()`. `None` when either id is empty.
pub fn clean_pair(
    session: Option<&JsValue>,
    turn: Option<&JsValue>,
) -> Option<(JsString, JsString)> {
    let session = normalized(session)
        .map(|text| text.trim())
        .unwrap_or_default();
    let turn = normalized(turn).map(|text| text.trim()).unwrap_or_default();
    if session.is_empty() || turn.is_empty() {
        return None;
    }
    Some((session, turn))
}

#[derive(Clone, Debug)]
pub struct Due {
    pub key: JsString,
    pub seq: u64,
    pub next_at: f64,
}

pub struct Heartbeat {
    interval_ms: f64,
    turns: OrderedMap<Entry>,
    next_seq: u64,
}

impl Heartbeat {
    pub fn new(interval_ms: f64) -> Self {
        Self {
            interval_ms,
            turns: OrderedMap::new(),
            next_seq: 0,
        }
    }

    pub fn interval_ms(&self) -> f64 {
        self.interval_ms
    }

    pub fn active_turns(&self) -> usize {
        self.turns.len()
    }

    /// Delete any predecessor for the session. One host session owns at most
    /// one active turn; the addon runs this before reading the clock so a
    /// throwing `now` still leaves the stale entry gone.
    pub fn remove_session_predecessors(&mut self, session: &JsString) {
        let stale: Vec<JsString> = self
            .turns
            .iter()
            .filter(|(_, entry)| &entry.session_id == session)
            .map(|(key, _)| key.clone())
            .collect();
        for key in stale {
            self.turns.delete(&key);
        }
    }

    pub fn start(
        &mut self,
        session: &JsString,
        turn: &JsString,
        now: f64,
        update: &PhaseUpdate,
    ) -> Snapshot {
        let seq = self.next_seq;
        self.next_seq += 1;
        let entry = Entry {
            session_id: session.clone(),
            turn_id: turn.clone(),
            started_at: now,
            last_user_visible_at: now,
            last_activity_at: now,
            phase: update.phase,
            safe_tool_kind: if update.phase == "tool" {
                update.tool_kind
            } else {
                None
            },
            last_heartbeat_period: 0.0,
            next_at: now + self.interval_ms,
            seq,
        };
        let snapshot = entry.snapshot();
        self.turns.set(key(session, turn), entry);
        snapshot
    }

    /// Cleaned key for `_find`, or `None` when the entry is not active.
    pub fn find(&self, session: &JsString, turn: &JsString) -> Option<JsString> {
        let candidate = key(session, turn);
        self.turns.contains_key(&candidate).then_some(candidate)
    }

    pub fn touch_visible(&mut self, found: &JsString, now: f64) -> bool {
        let seq = self.next_seq;
        self.next_seq += 1;
        let interval = self.interval_ms;
        match self.turns.get_mut(found) {
            Some(entry) => {
                entry.last_user_visible_at = now;
                entry.last_activity_at = now;
                entry.last_heartbeat_period = 0.0;
                entry.next_at = now + interval;
                entry.seq = seq;
                true
            }
            None => false,
        }
    }

    pub fn touch_activity(&mut self, found: &JsString, now: f64) -> bool {
        match self.turns.get_mut(found) {
            Some(entry) => {
                entry.last_activity_at = now;
                true
            }
            None => false,
        }
    }

    /// Phase first; the addon reads the clock afterwards so a throwing `now`
    /// keeps the phase change, exactly like the legacy `updatePhase`.
    pub fn update_phase(&mut self, found: &JsString, update: &PhaseUpdate) -> bool {
        match self.turns.get_mut(found) {
            Some(entry) => {
                entry.phase = update.phase;
                entry.safe_tool_kind = if update.phase == "tool" {
                    update.tool_kind
                } else {
                    None
                };
                true
            }
            None => false,
        }
    }

    pub fn stop(&mut self, found: &JsString) -> bool {
        self.turns.delete(found).is_some()
    }

    /// `status(sessionId)` before the clock-dependent `silentMs` is added.
    pub fn status(&self, session: &JsString) -> Option<Status> {
        self.turns
            .values()
            .find(|entry| &entry.session_id == session)
            .map(|entry| Status {
                session_id: session.clone(),
                turn_id: entry.turn_id.clone(),
                phase: entry.phase,
                safe_tool_kind: entry.safe_tool_kind,
                started_at: entry.started_at,
                last_user_visible_at: entry.last_user_visible_at,
            })
    }

    pub fn stop_all(&mut self) -> usize {
        let count = self.turns.len();
        self.turns = OrderedMap::new();
        count
    }

    pub fn next_due(&self) -> Option<f64> {
        self.turns
            .values()
            .map(|entry| entry.next_at)
            .fold(None, |due: Option<f64>, next| {
                Some(match due {
                    Some(current) => current.min(next),
                    None => next,
                })
            })
    }

    /// Every entry whose deadline has passed, in `(next_at, seq)` order.
    pub fn due(&self, at: f64) -> Vec<Due> {
        let mut due: Vec<Due> = self
            .turns
            .iter()
            .filter(|(_, entry)| at >= entry.next_at)
            .map(|(key, entry)| Due {
                key: key.clone(),
                seq: entry.seq,
                next_at: entry.next_at,
            })
            .collect();
        due.sort_by(|left, right| {
            left.next_at
                .partial_cmp(&right.next_at)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(left.seq.cmp(&right.seq))
        });
        due
    }

    /// Fire one due deadline: re-check the entry is still the same generation
    /// and still armed, advance the deadline, then decide whether a payload is
    /// due. The addon emits the payload AFTER this borrow is dropped.
    pub fn fire(&mut self, due: &Due, at: f64) -> Option<Payload> {
        let interval = self.interval_ms;
        let entry = self.turns.get_mut(&due.key)?;
        if entry.seq != due.seq || entry.next_at != due.next_at {
            return None;
        }
        entry.next_at = at + interval;
        let silent_ms = js_max(0.0, at - entry.last_user_visible_at);
        if silent_ms < interval {
            return None;
        }
        let period = (silent_ms / interval).floor();
        if period <= entry.last_heartbeat_period {
            return None;
        }
        entry.last_heartbeat_period = period;
        Some(Payload {
            session_id: entry.session_id.clone(),
            turn_id: entry.turn_id.clone(),
            elapsed_ms: js_max(0.0, at - entry.started_at),
            silent_ms,
            phase: entry.phase,
            tool_kind: entry.safe_tool_kind,
            activity_age_ms: js_max(0.0, at - entry.last_activity_at),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> JsString {
        JsString::from_rust_str(value)
    }

    fn value(text: &str) -> JsValue {
        JsValue::String(JsString::from_rust_str(text))
    }

    #[test]
    fn alias_lookup_is_own_property_only() {
        // Fixed bug: these resolved through Object.prototype before.
        assert_eq!(sanitize_phase_value(Some(&value("constructor"))), "running");
        assert_eq!(sanitize_phase_value(Some(&value("__proto__"))), "running");
        assert_eq!(
            sanitize_tool_kind_value(Some(&value("constructor"))),
            Some("other")
        );
        assert_eq!(
            sanitize_tool_kind_value(Some(&value("__proto__"))),
            Some("other")
        );
        assert_eq!(
            sanitize_tool_kind_value(Some(&value("BASH"))),
            Some("process")
        );
        assert_eq!(
            sanitize_tool_kind_value(Some(&value("wait_agent"))),
            Some("subagent")
        );
        assert_eq!(sanitize_tool_kind_value(Some(&value(""))), None);
        assert_eq!(sanitize_phase_value(Some(&JsValue::Null)), "running");
    }

    #[test]
    fn sanitizers_match_the_alias_tables_and_regex_order() {
        assert_eq!(sanitize_phase(Some(&text(" Preparing "))), "starting");
        assert_eq!(sanitize_phase(Some(&text("EXECUTING"))), "tool");
        assert_eq!(sanitize_phase(Some(&text("monitoring"))), "waiting");
        assert_eq!(sanitize_phase(Some(&text("nope"))), "running");
        assert_eq!(sanitize_tool_kind(Some(&text("mcp"))), Some("integration"));
        assert_eq!(
            sanitize_tool_kind(Some(&text("poll_loop"))),
            Some("monitor")
        );
        assert_eq!(
            sanitize_tool_kind(Some(&text("CommandRunner"))),
            Some("process")
        );
        assert_eq!(
            sanitize_tool_kind(Some(&text("file_read"))),
            Some("filesystem")
        );
        assert_eq!(
            sanitize_tool_kind(Some(&text("web_search"))),
            Some("search")
        );
        assert_eq!(sanitize_tool_kind(Some(&text("https"))), Some("network"));
        assert_eq!(sanitize_tool_kind(Some(&text("mystery"))), Some("other"));
    }

    #[test]
    fn read_phase_update_prefers_own_safe_tool_kind() {
        let update = JsValue::Object(vec![
            ("phase".into(), value("executing")),
            ("safeToolKind".into(), value("bash")),
            ("toolKind".into(), value("edit")),
        ]);
        let parsed = PhaseUpdate::from_values(Some(&update), None);
        assert_eq!(parsed.phase, "tool");
        assert_eq!(parsed.tool_kind, Some("process"));

        let update = JsValue::Object(vec![
            ("phase".into(), value("executing")),
            ("toolKind".into(), value("edit")),
        ]);
        let parsed = PhaseUpdate::from_values(Some(&update), None);
        assert_eq!(parsed.tool_kind, Some("filesystem"));

        let parsed = PhaseUpdate::from_values(Some(&value("thinking")), Some(&value("bash")));
        assert_eq!(parsed.phase, "thinking");
        assert_eq!(parsed.tool_kind, Some("process"));

        // An array is typeof 'object', so the object branch wins and the
        // separate safeToolKind argument is ignored: both properties are
        // missing, hence no tool kind.
        let parsed = PhaseUpdate::from_values(
            Some(&JsValue::Array(vec![value("thinking")])),
            Some(&value("bash")),
        );
        assert_eq!(parsed.phase, "running");
        assert_eq!(parsed.tool_kind, None);
    }

    #[test]
    fn one_turn_per_session_and_period_walk() {
        let mut hb = Heartbeat::new(30_000.0);
        let start = PhaseUpdate::from_text(Some(&text("thinking")), None);
        hb.start(&text("s"), &text("t"), 1_000.0, &start);
        assert_eq!(hb.active_turns(), 1);
        assert_eq!(hb.next_due(), Some(31_000.0));
        assert!(hb.due(30_999.0).is_empty());
        let due = hb.due(31_000.0);
        assert_eq!(due.len(), 1);
        let payload = hb.fire(&due[0], 31_000.0).expect("payload");
        assert_eq!(payload.silent_ms, 30_000.0);
        assert_eq!(payload.elapsed_ms, 30_000.0);
        assert_eq!(payload.activity_age_ms, 30_000.0);
        assert_eq!(hb.next_due(), Some(61_000.0));
        // A re-fire of the same snapshot is rejected (generation changed).
        assert_eq!(hb.fire(&due[0], 31_000.0), None);
        // A new turn for the same session replaces the predecessor. The addon
        // runs this before reading the clock, hence the separate call.
        hb.remove_session_predecessors(&text("s"));
        hb.start(&text("s"), &text("t2"), 32_000.0, &start);
        assert_eq!(hb.active_turns(), 1);
        assert_eq!(hb.status(&text("s")).unwrap().turn_id, text("t2"));
    }

    #[test]
    fn touch_visible_realigns_and_resets_the_period() {
        let mut hb = Heartbeat::new(100.0);
        let start = PhaseUpdate::from_text(None, None);
        hb.start(&text("s"), &text("t"), 0.0, &start);
        let found = hb.find(&text("s"), &text("t")).expect("found");
        let due = hb.due(100.0);
        assert!(hb.fire(&due[0], 100.0).is_some());
        assert!(hb.touch_visible(&found, 150.0));
        assert_eq!(hb.next_due(), Some(250.0));
        let due = hb.due(250.0);
        let payload = hb.fire(&due[0], 250.0).expect("second period");
        assert_eq!(payload.silent_ms, 100.0);
        assert_eq!(payload.elapsed_ms, 250.0);
        assert!(hb.find(&text("x"), &text("y")).is_none());
    }

    #[test]
    fn tool_kind_survives_only_in_the_tool_phase() {
        let mut hb = Heartbeat::new(100.0);
        hb.start(
            &text("s"),
            &text("t"),
            0.0,
            &PhaseUpdate::from_text(Some(&text("executing")), Some(&text("bash"))),
        );
        let found = hb.find(&text("s"), &text("t")).expect("found");
        assert_eq!(
            hb.status(&text("s")).unwrap().safe_tool_kind,
            Some("process")
        );
        assert!(hb.update_phase(
            &found,
            &PhaseUpdate::from_text(Some(&text("thinking")), Some(&text("bash"))),
        ));
        assert_eq!(hb.status(&text("s")).unwrap().safe_tool_kind, None);
        assert!(hb.stop(&found));
        assert!(!hb.stop(&found));
    }

    #[test]
    fn durations_clamp_at_zero_after_a_backwards_clock() {
        let mut hb = Heartbeat::new(10.0);
        let start = PhaseUpdate::from_text(None, None);
        hb.start(&text("s"), &text("t"), 500.0, &start);
        let found = hb.find(&text("s"), &text("t")).unwrap();
        // touchVisible re-arms from the (backwards) value it is handed.
        assert!(hb.touch_visible(&found, 100.0));
        assert_eq!(hb.next_due(), Some(110.0));
        assert!(hb.due(109.0).is_empty());
        let due = hb.due(110.0);
        let payload = hb.fire(&due[0], 110.0).expect("payload");
        // elapsed and activity age clamp at 0; silentMs does not.
        assert_eq!(payload.elapsed_ms, 0.0);
        assert_eq!(payload.silent_ms, 10.0);
        assert_eq!(payload.activity_age_ms, 10.0);
    }

    #[test]
    fn clean_pair_trims_and_rejects_empty() {
        assert_eq!(clean_pair(None, None), None);
        assert_eq!(
            clean_pair(Some(&value(" s ")), Some(&value(" t "))),
            Some((text("s"), text("t")))
        );
        assert_eq!(clean_pair(Some(&value(" ")), Some(&value("t"))), None);
        assert_eq!(clean_pair(Some(&JsValue::Null), Some(&value("t"))), None);
    }
}
