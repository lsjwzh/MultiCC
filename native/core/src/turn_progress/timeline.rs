//! Per-turn model timeline kernel (migrated from `src/chat/turn-timeline.js`).
//!
//! Spans of a turn that are NOT tool execution: `request` (a model request is
//! in flight and nothing has come back yet), `thinking` (reasoning streaming)
//! and `output` (answer text / tool-call arguments streaming). Tool spans live
//! on the persisted tool rows; this timeline only labels the model's own time.
//!
//! State is keyed by session name inside this owner — not hung on the live
//! `cs` object — and [`Timelines::forget`] is called from the chat-session
//! delete path so a removed session cannot leak a timeline (intentional
//! divergence: the legacy object died with `cs`).
//!
//! Two lanes share the segmenter: Claude stream-json (`stream_event`, plus
//! assistant tool_use / user tool_result frames) and the normalized adapter
//! events (codex, opencode, zcode, kimi, qoder, acp, ...).
use crate::background::state::{js_max, OrderedMap, OrderedSet};
use crate::js::coerce::{js_to_string, truthy};
use crate::js::{JsString, JsValue};

pub const MAX_SPANS: usize = 4000;
/// Same-kind frames closer than this merge into one span: streaming deltas
/// arrive every few ms and a span per delta would only bloat the transcript.
pub const MERGE_GAP_MS: f64 = 1500.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Request,
    Thinking,
    Output,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Request => "request",
            Kind::Thinking => "thinking",
            Kind::Output => "output",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Span {
    pub k: Kind,
    pub s: f64,
    pub e: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub origin: f64,
    pub spans: Vec<Span>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Stage {
    pub stage: &'static str,
    pub since: Option<f64>,
    pub age_ms: Option<f64>,
    pub precise: bool,
}

/// What the adapter `tool_update` branch needs to know about the live session
/// before it can decide whether the tool is already known. Both reads are
/// resolved by the addon while the owner is not borrowed.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolUpdateId {
    /// `evt.id || 'call_' + String((cs.currentToolCalls || []).length)`.
    pub id: JsValue,
    /// `(cs.currentToolCalls || []).some(x => x && x.id === id)`.
    pub already_known: bool,
}

pub struct Timeline {
    origin: f64,
    spans: Vec<Span>,
    open: OrderedSet,
    anon: u64,
    partial: bool,
    block: Option<Kind>,
}

impl Timeline {
    pub fn new(origin: f64) -> Self {
        Self {
            origin,
            spans: vec![Span {
                k: Kind::Request,
                s: origin,
                e: None,
            }],
            open: OrderedSet::new(),
            anon: 0,
            partial: false,
            block: None,
        }
    }

    pub fn origin(&self) -> f64 {
        self.origin
    }

    pub fn partial(&self) -> bool {
        self.partial
    }

    fn last(&self) -> Option<&Span> {
        self.spans.last()
    }

    fn close_open(&mut self, t: f64) {
        if let Some(cur) = self.spans.last_mut() {
            if cur.e.is_none() {
                cur.e = Some(js_max(cur.s, t));
            }
        }
    }

    fn push(&mut self, span: Span) {
        if self.spans.len() >= MAX_SPANS {
            return;
        }
        self.spans.push(span);
    }

    /// Streamed model output of `kind` observed at t.
    fn mark(&mut self, kind: Kind, t: f64) {
        if let Some(cur) = self.spans.last_mut() {
            if cur.k == Kind::Request && cur.e.is_none() {
                cur.e = Some(js_max(cur.s, t));
            }
        }
        if let Some(cur) = self.spans.last_mut() {
            if cur.k == kind && (cur.e.is_none() || t - cur.e.unwrap_or(cur.s) <= MERGE_GAP_MS) {
                cur.e = Some(js_max(cur.e.unwrap_or(cur.s), t));
                return;
            }
        }
        self.push(Span {
            k: kind,
            s: t,
            e: Some(t),
        });
    }

    /// A tool started: whatever the model was doing has ended.
    fn tool_start(&mut self, id: Option<&JsValue>, t: f64) {
        self.close_open(t);
        let key = match id {
            None | Some(JsValue::Null) | Some(JsValue::Undefined) => {
                let key = JsString::from_rust_str(&format!("#anon{}", self.anon));
                self.anon += 1;
                key
            }
            Some(JsValue::String(text)) if text.is_empty() => {
                let key = JsString::from_rust_str(&format!("#anon{}", self.anon));
                self.anon += 1;
                key
            }
            Some(other) => js_to_string(other),
        };
        self.open.insert(key);
    }

    /// A tool result returned. Once nothing is outstanding the CLI sends the
    /// next model request immediately, so a request span opens here.
    fn tool_end(&mut self, id: Option<&JsValue>, t: f64) {
        let present = match id {
            None | Some(JsValue::Null) | Some(JsValue::Undefined) => None,
            Some(other) => Some(js_to_string(other)),
        };
        let mut removed = false;
        if let Some(key) = present.as_ref() {
            if self.open.contains(key) {
                self.open.delete(key);
                removed = true;
            }
        }
        if !removed {
            let first = self.open.iter().next().cloned();
            if let Some(first) = first {
                self.open.delete(&first);
            }
        }
        if !self.open.is_empty() {
            return;
        }
        self.close_open(t);
        self.push(Span {
            k: Kind::Request,
            s: t,
            e: None,
        });
    }

    /// Claude stream-json frames. Subagent traffic carries a
    /// `parent_tool_use_id` and belongs to the Task tool span, not the main
    /// model, so it is ignored.
    pub fn observe_claude(&mut self, evt: &JsValue, t: f64) {
        if truthy(
            &evt.get("parent_tool_use_id")
                .cloned()
                .unwrap_or(JsValue::Undefined),
        ) {
            return;
        }
        let type_name = evt.get("type").cloned().unwrap_or(JsValue::Undefined);
        if matches!(&type_name, JsValue::String(text) if text == "stream_event") {
            self.partial = true;
            let event = evt
                .get("event")
                .filter(|value| truthy(value))
                .cloned()
                .unwrap_or_else(|| JsValue::Object(Vec::new()));
            let event_type = event.get("type").cloned().unwrap_or(JsValue::Undefined);
            if matches!(&event_type, JsValue::String(text) if text == "content_block_start") {
                let block_type = event
                    .get("content_block")
                    .filter(|value| truthy(value))
                    .and_then(|block| block.get("type"))
                    .cloned()
                    .unwrap_or(JsValue::Undefined);
                let kind = if matches!(&block_type, JsValue::String(text)
                    if text == "thinking" || text == "redacted_thinking")
                {
                    Kind::Thinking
                } else {
                    Kind::Output
                };
                self.block = Some(kind);
                self.mark(kind, t);
            } else if matches!(&event_type, JsValue::String(text) if text == "content_block_delta")
            {
                let delta_type = event
                    .get("delta")
                    .filter(|value| truthy(value))
                    .and_then(|delta| delta.get("type"))
                    .cloned()
                    .unwrap_or(JsValue::Undefined);
                let kind = match &delta_type {
                    JsValue::String(text)
                        if text == "thinking_delta" || text == "signature_delta" =>
                    {
                        Kind::Thinking
                    }
                    JsValue::String(text) if text == "text_delta" || text == "input_json_delta" => {
                        Kind::Output
                    }
                    _ => self.block.unwrap_or(Kind::Output),
                };
                self.mark(kind, t);
            } else if matches!(&event_type, JsValue::String(text) if text == "content_block_stop")
                && self.block.is_some()
            {
                // The CLI emits the tool_use assistant message before this stop
                // frame; once a tool is running the output span is already
                // closed for good.
                if self.open.is_empty() {
                    self.mark(self.block.unwrap_or(Kind::Output), t);
                }
                self.block = None;
            }
            return;
        }
        let content = evt
            .get("message")
            .filter(|value| truthy(value))
            .and_then(|message| message.get("content"))
            .filter(|value| matches!(value, JsValue::Array(_)))
            .cloned()
            .unwrap_or_else(|| JsValue::Array(Vec::new()));
        let blocks: &[JsValue] = match &content {
            JsValue::Array(items) => items,
            _ => &[],
        };
        if matches!(&type_name, JsValue::String(text) if text == "assistant") {
            for block in blocks {
                if !truthy(block) {
                    continue;
                }
                if matches!(block.get("type"), Some(JsValue::String(text)) if text == "tool_use") {
                    self.tool_start(block.get("id"), t);
                }
            }
        } else if matches!(&type_name, JsValue::String(text) if text == "user") {
            for block in blocks {
                if !truthy(block) {
                    continue;
                }
                if matches!(block.get("type"), Some(JsValue::String(text)) if text == "tool_result")
                {
                    self.tool_end(block.get("tool_use_id"), t);
                }
            }
        }
    }

    /// `evt.id || 'call_' + String(callsLength)`. The addon resolves
    /// `(cs.currentToolCalls || []).length` as a raw JS value so the template
    /// literal stringification matches.
    pub fn tool_update_id(evt: &JsValue, calls_length: Option<&JsValue>) -> JsValue {
        let id = evt.get("id").cloned().unwrap_or(JsValue::Undefined);
        if truthy(&id) {
            return id;
        }
        let length = calls_length.cloned().unwrap_or(JsValue::Undefined);
        let mut out = JsString::from_rust_str("call_");
        out.push(&js_to_string(&length));
        JsValue::String(out)
    }

    /// Normalized adapter events (all non-Claude lanes). `completed` is
    /// `evt.completed`; `already_known` comes from [`ToolUpdateId`].
    pub fn observe_adapter(&mut self, evt: &JsValue, id: &JsValue, already_known: bool, t: f64) {
        let type_name = evt.get("type").cloned().unwrap_or(JsValue::Undefined);
        let matches_type = |name: &str| matches!(&type_name, JsValue::String(text) if text == name);
        if matches_type("thinking") {
            self.mark(Kind::Thinking, t);
        } else if matches_type("assistant_text") {
            if truthy(evt.get("text").unwrap_or(&JsValue::Undefined)) {
                self.mark(Kind::Output, t);
            }
        } else if matches_type("tool_start") {
            let raw = evt.get("id").cloned();
            self.tool_start(raw.as_ref(), t);
        } else if matches_type("tool_result") {
            let raw = evt.get("id").cloned();
            self.tool_end(raw.as_ref(), t);
        } else if matches_type("tool_update") {
            if !self.open.contains(&js_to_string(id)) && !already_known {
                self.tool_start(Some(id), t);
            }
            if truthy(evt.get("completed").unwrap_or(&JsValue::Undefined)) {
                self.tool_end(Some(id), t);
            }
        } else if matches_type("part_delta") {
            self.partial = true;
            let delta = evt
                .get("delta")
                .filter(|value| is_typeof_object(value))
                .cloned()
                .unwrap_or_else(|| evt.clone());
            let delta_type = delta.get("type").cloned().unwrap_or(JsValue::Undefined);
            if matches!(&delta_type, JsValue::String(text) if text == "reasoning") {
                self.mark(Kind::Thinking, t);
            } else if matches!(&delta_type, JsValue::String(text) if text == "text") {
                self.mark(Kind::Output, t);
            }
        }
    }

    /// What the model is doing right now, for the live liveness pill. `cli` is
    /// the session's `cs.cli`; the caller may skip reading it when
    /// [`Timeline::partial`] is already true (the legacy expression
    /// short-circuits before touching `cs.cli`).
    pub fn current_stage(&self, cli: Option<&JsValue>, now: f64) -> Option<Stage> {
        let cur = self.last()?;
        let precise =
            self.partial || matches!(cli, Some(JsValue::String(text)) if text == "claude");
        if !self.open.is_empty() {
            return Some(Stage {
                stage: "tool",
                since: None,
                age_ms: None,
                precise,
            });
        }
        let last_at = cur.e.unwrap_or(cur.s);
        Some(Stage {
            stage: cur.k.as_str(),
            since: Some(cur.s),
            age_ms: Some(js_max(0.0, now - last_at)),
            precise,
        })
    }

    /// Persistable snapshot; still-open spans are closed at `now`. Zero-length
    /// request spans (results that streamed back instantly) are dropped.
    pub fn snapshot(&self, now: f64) -> Option<Snapshot> {
        if !self.origin.is_finite() {
            return None;
        }
        let mut spans = Vec::with_capacity(self.spans.len());
        for span in &self.spans {
            let e = span.e.unwrap_or_else(|| js_max(span.s, now));
            if span.k == Kind::Request && e - span.s <= 0.0 {
                continue;
            }
            spans.push(Span {
                k: span.k,
                s: span.s,
                e: Some(e),
            });
        }
        Some(Snapshot {
            origin: self.origin,
            spans,
        })
    }
}

/// `typeof value === 'object'` for a non-nullish value, as far as the lossless
/// transport can represent it (functions never reach a kernel).
fn is_typeof_object(value: &JsValue) -> bool {
    matches!(
        value,
        JsValue::Object(_) | JsValue::Array(_) | JsValue::Bytes(_) | JsValue::Date(_)
    )
}

pub struct Timelines {
    by_session: OrderedMap<Timeline>,
}

impl Timelines {
    pub fn new() -> Self {
        Self {
            by_session: OrderedMap::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.by_session.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_session.is_empty()
    }

    /// `startTurn`: origin is `Number.isFinite(cs.turnStartedAt) ?
    /// cs.turnStartedAt : now`. The caller resolves the value.
    pub fn start(&mut self, session: &JsValue, origin: f64) {
        self.by_session
            .set(js_to_string(session), Timeline::new(origin));
    }

    pub fn forget(&mut self, session: &JsValue) -> bool {
        self.by_session.delete(&js_to_string(session)).is_some()
    }

    fn state(&self, session: &JsValue) -> Option<&Timeline> {
        self.by_session.get(&js_to_string(session))
    }

    fn state_mut(&mut self, session: &JsValue) -> Option<&mut Timeline> {
        let key = js_to_string(session);
        self.by_session.get_mut(&key)
    }

    pub fn contains(&self, session: &JsValue) -> bool {
        self.state(session).is_some()
    }

    pub fn partial(&self, session: &JsValue) -> Option<bool> {
        self.state(session).map(Timeline::partial)
    }

    pub fn observe_claude(&mut self, session: &JsValue, evt: &JsValue, t: f64) {
        if let Some(state) = self.state_mut(session) {
            state.observe_claude(evt, t);
        }
    }

    pub fn tool_update_id(evt: &JsValue, calls_length: Option<&JsValue>) -> JsValue {
        Timeline::tool_update_id(evt, calls_length)
    }

    pub fn observe_adapter(
        &mut self,
        session: &JsValue,
        evt: &JsValue,
        id: &JsValue,
        already_known: bool,
        t: f64,
    ) {
        if let Some(state) = self.state_mut(session) {
            state.observe_adapter(evt, id, already_known, t);
        }
    }

    pub fn current_stage(
        &self,
        session: &JsValue,
        cli: Option<&JsValue>,
        now: f64,
    ) -> Option<Stage> {
        self.state(session)?.current_stage(cli, now)
    }

    pub fn snapshot(&self, session: &JsValue, now: f64) -> Option<Snapshot> {
        self.state(session)?.snapshot(now)
    }

    pub fn field(&self, session: &JsValue, now: f64) -> Option<Snapshot> {
        self.snapshot(session, now)
    }
}

impl Default for Timelines {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(text: &str) -> JsValue {
        JsValue::String(JsString::from_rust_str(text))
    }

    fn object(entries: Vec<(&str, JsValue)>) -> JsValue {
        JsValue::Object(
            entries
                .into_iter()
                .map(|(key, value)| (JsString::from_rust_str(key), value))
                .collect(),
        )
    }

    fn session() -> JsValue {
        value("sess")
    }

    /// Snapshot spans with still-open spans closed at `now`.
    fn kinds(state: &Timelines, now: f64) -> Vec<(&'static str, f64, Option<f64>)> {
        state
            .snapshot(&session(), now)
            .unwrap()
            .spans
            .into_iter()
            .map(|span| (span.k.as_str(), span.s, span.e))
            .collect()
    }

    #[test]
    fn new_timeline_opens_a_request_span_at_the_origin() {
        let mut timelines = Timelines::new();
        timelines.start(&session(), 100.0);
        assert_eq!(
            kinds(&timelines, 200.0),
            vec![("request", 100.0, Some(200.0))]
        );
        assert!(!timelines.contains(&value("other")));
        assert!(timelines.forget(&session()));
        assert!(!timelines.forget(&session()));
        assert_eq!(timelines.len(), 0);
    }

    #[test]
    fn mark_closes_request_and_merges_same_kind_within_the_gap() {
        let mut timelines = Timelines::new();
        timelines.start(&session(), 0.0);
        {
            let state = timelines.state_mut(&session()).unwrap();
            state.mark(Kind::Output, 1000.0);
            state.mark(Kind::Output, 2000.0);
            // 3000 - 2000 <= 1500 merges; a farther frame opens a new span.
            state.mark(Kind::Output, 3000.0);
            state.mark(Kind::Thinking, 3300.0);
        }
        assert_eq!(
            kinds(&timelines, 4000.0),
            vec![
                ("request", 0.0, Some(1000.0)),
                ("output", 1000.0, Some(3000.0)),
                ("thinking", 3300.0, Some(3300.0)),
            ]
        );
    }

    #[test]
    fn tool_start_and_tool_end_track_the_open_set_in_insertion_order() {
        let mut timelines = Timelines::new();
        timelines.start(&session(), 0.0);
        {
            let state = timelines.state_mut(&session()).unwrap();
            state.tool_start(Some(&value("a")), 100.0);
            state.tool_start(Some(&value("b")), 200.0);
            // Unknown id removes the first open tool, not the named one.
            state.tool_end(Some(&value("nope")), 300.0);
            assert_eq!(state.open.to_vec(), vec![JsString::from_rust_str("b")]);
            assert_eq!(state.spans.last().unwrap().e, Some(100.0));
            state.tool_end(Some(&value("b")), 400.0);
            assert!(state.open.is_empty());
            // Missing and empty ids get distinct anonymous keys.
            state.tool_start(None, 500.0);
            state.tool_start(Some(&value("")), 600.0);
            assert_eq!(
                state.open.to_vec(),
                vec![
                    JsString::from_rust_str("#anon0"),
                    JsString::from_rust_str("#anon1")
                ]
            );
        }
        assert_eq!(
            kinds(&timelines, 1000.0),
            vec![
                ("request", 0.0, Some(100.0)),
                ("request", 400.0, Some(500.0)),
            ]
        );
    }

    #[test]
    fn claude_stream_event_marks_thinking_and_output() {
        let mut timelines = Timelines::new();
        timelines.start(&session(), 0.0);
        let frame =
            |event: JsValue| object(vec![("type", value("stream_event")), ("event", event)]);
        timelines.observe_claude(
            &session(),
            &frame(object(vec![
                ("type", value("content_block_start")),
                ("content_block", object(vec![("type", value("thinking"))])),
            ])),
            100.0,
        );
        timelines.observe_claude(
            &session(),
            &frame(object(vec![
                ("type", value("content_block_delta")),
                ("delta", object(vec![("type", value("text_delta"))])),
            ])),
            200.0,
        );
        timelines.observe_claude(
            &session(),
            &frame(object(vec![("type", value("content_block_stop"))])),
            300.0,
        );
        assert!(timelines.partial(&session()).unwrap());
        // The stop frame re-marks the block kind recorded at block start, so a
        // text delta after a thinking block still closes on "thinking" — the
        // legacy segmenter's own quirk.
        assert_eq!(
            kinds(&timelines, 400.0),
            vec![
                ("request", 0.0, Some(100.0)),
                ("thinking", 100.0, Some(100.0)),
                ("output", 200.0, Some(200.0)),
                ("thinking", 300.0, Some(300.0)),
            ]
        );
        // Subagent frames are ignored.
        let subagent = object(vec![
            ("type", value("stream_event")),
            ("parent_tool_use_id", value("toolu_1")),
            (
                "event",
                object(vec![("type", value("content_block_start"))]),
            ),
        ]);
        timelines.observe_claude(&session(), &subagent, 400.0);
        assert_eq!(kinds(&timelines, 400.0).len(), 4);
    }

    #[test]
    fn claude_assistant_and_user_frames_track_tool_spans() {
        let mut timelines = Timelines::new();
        timelines.start(&session(), 0.0);
        let block = object(vec![("type", value("tool_use")), ("id", value("toolu_9"))]);
        timelines.observe_claude(
            &session(),
            &object(vec![
                ("type", value("assistant")),
                (
                    "message",
                    object(vec![("content", JsValue::Array(vec![block]))]),
                ),
            ]),
            500.0,
        );
        let stage = timelines.current_stage(&session(), None, 700.0).unwrap();
        assert_eq!(stage.stage, "tool");
        assert_eq!((stage.since, stage.age_ms), (None, None));
        timelines.observe_claude(
            &session(),
            &object(vec![
                ("type", value("user")),
                (
                    "message",
                    object(vec![(
                        "content",
                        JsValue::Array(vec![object(vec![
                            ("type", value("tool_result")),
                            ("tool_use_id", value("toolu_9")),
                        ])]),
                    )]),
                ),
            ]),
            900.0,
        );
        assert_eq!(
            kinds(&timelines, 1000.0),
            vec![
                ("request", 0.0, Some(500.0)),
                ("request", 900.0, Some(1000.0)),
            ]
        );
    }

    #[test]
    fn adapter_tool_update_id_and_known_check() {
        let evt = object(vec![("type", value("tool_update"))]);
        assert_eq!(
            Timelines::tool_update_id(&evt, Some(&JsValue::Number(3.0))),
            value("call_3")
        );
        assert_eq!(
            Timelines::tool_update_id(&evt, None),
            value("call_undefined")
        );
        let with_id = object(vec![("type", value("tool_update")), ("id", value("x"))]);
        assert_eq!(
            Timelines::tool_update_id(&with_id, Some(&JsValue::Number(1.0))),
            value("x")
        );

        let mut timelines = Timelines::new();
        timelines.start(&session(), 0.0);
        timelines.observe_adapter(&session(), &with_id, &value("x"), true, 10.0);
        assert_eq!(kinds(&timelines, 10.0), vec![("request", 0.0, Some(10.0))]);
        timelines.observe_adapter(&session(), &with_id, &value("x"), false, 20.0);
        assert_eq!(timelines.state(&session()).unwrap().open.len(), 1);
        let completed = object(vec![
            ("type", value("tool_update")),
            ("id", value("x")),
            ("completed", JsValue::Bool(true)),
        ]);
        timelines.observe_adapter(&session(), &completed, &value("x"), false, 30.0);
        assert!(timelines.state(&session()).unwrap().open.is_empty());
        assert_eq!(
            kinds(&timelines, 40.0),
            vec![("request", 0.0, Some(20.0)), ("request", 30.0, Some(40.0)),]
        );
    }

    #[test]
    fn current_stage_precision_and_backwards_clock_clamp() {
        let mut timelines = Timelines::new();
        timelines.start(&session(), 50.0);
        let stage = timelines
            .current_stage(&session(), Some(&value("claude")), 40.0)
            .unwrap();
        assert_eq!(stage.stage, "request");
        assert_eq!((stage.since, stage.age_ms), (Some(50.0), Some(0.0)));
        assert!(stage.precise, "claude is precise from t0");
        assert!(timelines.current_stage(&value("nope"), None, 0.0).is_none());

        let mut adapted = Timelines::new();
        adapted.start(&session(), 0.0);
        adapted
            .state_mut(&session())
            .unwrap()
            .mark(Kind::Output, 10.0);
        let stage = adapted
            .current_stage(&session(), Some(&value("codex")), 100.0)
            .unwrap();
        assert_eq!((stage.stage, stage.age_ms), ("output", Some(90.0)));
        assert!(!stage.precise);
    }

    #[test]
    fn snapshot_drops_instant_request_spans_and_rejects_a_bad_origin() {
        let mut timelines = Timelines::new();
        timelines.start(&session(), 100.0);
        {
            let state = timelines.state_mut(&session()).unwrap();
            state.tool_start(Some(&value("t")), 100.0);
            state.tool_end(Some(&value("t")), 100.0);
            state.mark(Kind::Output, 150.0);
        }
        let snapshot = timelines.snapshot(&session(), 200.0).unwrap();
        assert_eq!(snapshot.origin, 100.0);
        assert_eq!(
            snapshot
                .spans
                .iter()
                .map(|span| (span.k.as_str(), span.s, span.e))
                .collect::<Vec<_>>(),
            // The instant tool round-trip request span is dropped; the request
            // span that the tool result opened stays because output closed it.
            vec![
                ("request", 100.0, Some(150.0)),
                ("output", 150.0, Some(150.0)),
            ]
        );
        let mut broken = Timelines::new();
        broken.start(&session(), f64::NAN);
        assert!(broken.snapshot(&session(), 0.0).is_none());
    }
}
