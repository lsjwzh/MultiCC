//! The WebSocket send wrapper: queue, coalescing, congestion and the 1013 cut.
//!
//! `src/ws-backpressure.js` sits in front of `ws.send` on every socket the
//! shared connection router owns, so a Rust WebSocket host cannot be
//! byte-compatible without these rules: a slow client is disconnected on the
//! same frame, with the same close code and the same metric and log lines.
//!
//! The kernel is pure. The caller supplies the clock (`set_now`), the retry
//! timer (`fire_timer`) and the socket through [`Transport`]; every decision
//! lands in [`Effect`] in the order the JavaScript made it. The frozen
//! implementation is `tests/helpers/legacy-ws-backpressure.js` and the
//! comparison corpus is
//! `docs/rust-migration/differential/ws-backpressure-golden.json`.
use sha2::{Digest, Sha256};

use crate::js::{self, coerce, JsValue};

/// `DEFAULTS` in the JavaScript, byte for byte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub high_water_bytes: usize,
    pub max_queue_bytes: usize,
    pub max_queue_messages: usize,
    pub max_congestion_ms: u64,
    pub retry_ms: u64,
    pub max_frame_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            high_water_bytes: 1024 * 1024,
            max_queue_bytes: 2 * 1024 * 1024,
            max_queue_messages: 4096,
            max_congestion_ms: 15_000,
            retry_ms: 25,
            max_frame_bytes: 8 * 1024 * 1024,
        }
    }
}

/// `COALESCE_TYPES`. Membership is a `Set.has` on the parsed `type`, so only an
/// exact string matches.
pub const COALESCE_TYPES: [&str; 8] = [
    "snapshot",
    "meta_snapshot",
    "task_state",
    "provider_token_stats",
    "role_token_stats",
    "aux_init",
    "aux_history",
    "session_status",
];

/// What `ws.send` accepts. `View` is an `ArrayBuffer` view, which the
/// coalescing check skips because it is neither a string nor a `Buffer`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Payload {
    Text(String),
    Buffer(Vec<u8>),
    View(Vec<u8>),
}

impl Payload {
    pub fn bytes(&self) -> &[u8] {
        match self {
            Self::Text(text) => text.as_bytes(),
            Self::Buffer(bytes) | Self::View(bytes) => bytes,
        }
    }
}

/// The second `ws.send` argument. `Callback` is the two-argument form
/// (`ws.send(data, cb)`), which the wrapper re-splits into no options at all.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Options {
    None,
    Binary(bool),
    Callback,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    /// `originalSend(data, options, cb)`.
    Send {
        bytes: usize,
        sha: String,
        options: Options,
    },
    Close {
        code: u16,
        reason: String,
    },
    /// `ws.close` threw, so the wrapper fell back to `ws.terminate()`.
    Terminate,
    Metric {
        name: &'static str,
        amount: f64,
        set: bool,
    },
    Log {
        event: &'static str,
        reason: &'static str,
        queue_bytes: usize,
        queue_messages: usize,
        buffered: usize,
    },
    /// The caller's own send callback, identified by the handle it enqueued with.
    Callback {
        index: u64,
        error: Option<String>,
    },
    Schedule {
        ms: u64,
    },
    Cancel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stats {
    pub queue_bytes: usize,
    pub queue_messages: usize,
    pub sending: bool,
    pub congested: bool,
    pub closed: bool,
}

/// The live socket. Both calls can throw in JavaScript, so both return a
/// `Result` whose `Err` is the thrown message.
pub trait Transport {
    fn send(&mut self, payload: &Payload, options: &Options) -> Result<(), String>;
    fn close(&mut self, code: u16, reason: &str) -> Result<(), String>;
    fn terminate(&mut self);
    fn buffered_amount(&self) -> usize;
}

#[derive(Clone, Debug)]
struct Item {
    payload: Payload,
    options: Options,
    callback: Option<u64>,
    bytes: usize,
    key: Option<String>,
}

pub struct Wrapper {
    limits: Limits,
    queue: Vec<Item>,
    queue_bytes: usize,
    sending: bool,
    timer: bool,
    congested_at: f64,
    closed: bool,
    now: f64,
    /// The callback handle of the frame the transport is still writing.
    in_flight: Option<Option<u64>>,
    effects: Vec<Effect>,
}

/// `Buffer.byteLength(String(data))` for text, `byteLength`/`length` otherwise.
pub fn byte_length(payload: &Payload) -> usize {
    payload.bytes().len()
}

/// `coalesceKey`: a parsed object whose `type` is in the set, keyed by the
/// first truthy of `dirId`, `sessionId`, `role`.
pub fn coalesce_key(payload: &Payload) -> Option<String> {
    let text = match payload {
        Payload::Text(text) => text.clone(),
        // `data.toString()` on a Buffer is a UTF-8 decode.
        Payload::Buffer(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        Payload::View(_) => return None,
    };
    let parsed = js::json_parse(&text).ok()?;
    if !coerce::truthy(&parsed) {
        return None;
    }
    let JsValue::String(kind) = parsed.get("type")? else {
        return None;
    };
    let kind = kind.to_string_lossy();
    if !COALESCE_TYPES.contains(&kind.as_str()) {
        return None;
    }
    let scope = coerce::or(
        coerce::or(parsed.get("dirId"), parsed.get("sessionId")),
        parsed.get("role"),
    );
    let scope = match scope {
        Some(value) if coerce::truthy(value) => coerce::js_to_string(value).to_string_lossy(),
        _ => String::new(),
    };
    Some(format!("{kind}:{scope}"))
}

fn digest(payload: &Payload) -> String {
    let hash = Sha256::digest(payload.bytes());
    hash.iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

impl Wrapper {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            queue: Vec::new(),
            queue_bytes: 0,
            sending: false,
            timer: false,
            congested_at: 0.0,
            closed: false,
            now: 0.0,
            in_flight: None,
            effects: Vec::new(),
        }
    }

    pub fn set_now(&mut self, now: f64) {
        self.now = now;
    }

    pub fn stats(&self) -> Stats {
        Stats {
            queue_bytes: self.queue_bytes,
            queue_messages: self.queue.len(),
            sending: self.sending,
            congested: self.congested_at != 0.0,
            closed: self.closed,
        }
    }

    pub fn take_effects(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.effects)
    }

    fn metric(&mut self, name: &'static str, amount: f64, set: bool) {
        self.effects.push(Effect::Metric { name, amount, set });
    }

    /// `ws.send` (`bounded`) and `sendImmediate` (`!bounded`).
    pub fn enqueue<T: Transport>(
        &mut self,
        payload: Payload,
        options: Options,
        callback: Option<u64>,
        bounded: bool,
        transport: &mut T,
    ) {
        // `typeof options === 'function'` moves the argument to the callback.
        let options = if options == Options::Callback {
            Options::None
        } else {
            options
        };
        if self.closed {
            if let Some(index) = callback {
                self.effects.push(Effect::Callback {
                    index,
                    error: Some("WebSocket backpressure transport closed".to_string()),
                });
            }
            return;
        }
        let bytes = byte_length(&payload);
        let key = coalesce_key(&payload);
        if let Some(key) = key.clone() {
            if let Some(index) = self
                .queue
                .iter()
                .position(|item| item.key.as_deref() == Some(key.as_str()))
            {
                self.queue_bytes -= self.queue[index].bytes;
                self.queue[index] = Item {
                    payload,
                    options,
                    callback,
                    bytes,
                    key: Some(key),
                };
                self.queue_bytes += bytes;
                self.metric("multicc_ws_messages_coalesced_total", 1.0, false);
                self.flush(transport);
                return;
            }
        }
        // The ceiling is widened by one maximum frame so an allowed oversize
        // frame still in the queue does not trip every later frame.
        let ceiling = self.limits.max_queue_bytes + self.limits.max_frame_bytes;
        let over_bytes = bytes > self.limits.max_frame_bytes || self.queue_bytes + bytes > ceiling;
        let over_messages = bounded && self.queue.len() >= self.limits.max_queue_messages;
        if over_bytes || over_messages {
            self.metric("multicc_ws_queue_overflows_total", 1.0, false);
            self.disconnect("queue_overflow", transport);
            if let Some(index) = callback {
                self.effects.push(Effect::Callback {
                    index,
                    error: Some("WebSocket send queue overflow".to_string()),
                });
            }
            return;
        }
        self.queue.push(Item {
            payload,
            options,
            callback,
            bytes,
            key,
        });
        self.queue_bytes += bytes;
        let depth = self.queue.len() as f64;
        self.metric("multicc_ws_queue_depth", depth, true);
        self.flush(transport);
    }

    /// The transport finished the frame it was writing.
    pub fn complete<T: Transport>(&mut self, error: Option<&str>, transport: &mut T) {
        let Some(callback) = self.in_flight.take() else {
            return;
        };
        self.sending = false;
        if let Some(index) = callback {
            self.effects.push(Effect::Callback {
                index,
                error: error.map(str::to_string),
            });
        }
        if error.is_some() {
            return self.disconnect("send_error", transport);
        }
        self.flush(transport);
    }

    /// The retry timer fired.
    pub fn fire_timer<T: Transport>(&mut self, transport: &mut T) {
        self.timer = false;
        self.flush(transport);
    }

    /// The socket's own `close` event: no 1013, just a quiet teardown.
    pub fn close_event(&mut self) {
        self.closed = true;
        if self.timer {
            self.effects.push(Effect::Cancel);
            self.timer = false;
        }
        self.queue.clear();
        self.queue_bytes = 0;
    }

    pub fn flush<T: Transport>(&mut self, transport: &mut T) {
        if self.closed || self.sending || self.queue.is_empty() {
            return;
        }
        if transport.buffered_amount() >= self.limits.high_water_bytes {
            if self.congested_at == 0.0 {
                self.congested_at = self.now;
            }
            self.metric("multicc_ws_high_water_events_total", 1.0, false);
            if self.now - self.congested_at >= self.limits.max_congestion_ms as f64 {
                return self.disconnect("high_water_timeout", transport);
            }
            self.schedule_flush();
            return;
        }
        self.congested_at = 0.0;
        let item = self.queue.remove(0);
        self.queue_bytes -= item.bytes;
        self.sending = true;
        self.effects.push(Effect::Send {
            bytes: item.bytes,
            sha: digest(&item.payload),
            options: item.options.clone(),
        });
        match transport.send(&item.payload, &item.options) {
            Ok(()) => self.in_flight = Some(item.callback),
            Err(message) => {
                self.sending = false;
                if let Some(index) = item.callback {
                    self.effects.push(Effect::Callback {
                        index,
                        error: Some(message),
                    });
                }
                self.disconnect("send_throw", transport);
            }
        }
    }

    fn schedule_flush(&mut self) {
        if self.timer || self.closed {
            return;
        }
        self.timer = true;
        let ms = self.limits.retry_ms;
        self.effects.push(Effect::Schedule { ms });
    }

    fn disconnect<T: Transport>(&mut self, reason: &'static str, transport: &mut T) {
        if self.closed {
            return;
        }
        self.closed = true;
        if self.timer {
            self.effects.push(Effect::Cancel);
            self.timer = false;
        }
        self.metric("multicc_ws_backpressure_disconnects_total", 1.0, false);
        self.effects.push(Effect::Log {
            event: "ws_backpressure_disconnect",
            reason,
            queue_bytes: self.queue_bytes,
            queue_messages: self.queue.len(),
            buffered: transport.buffered_amount(),
        });
        const CODE: u16 = 1013;
        const REASON: &str = "slow client; reconnect to resync";
        self.effects.push(Effect::Close {
            code: CODE,
            reason: REASON.to_string(),
        });
        if transport.close(CODE, REASON).is_err() {
            self.effects.push(Effect::Terminate);
            transport.terminate();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// Overridden by `ws-backpressure-mutations.py` so a mutated copy of this
    /// file still reads the frozen corpus.
    const GOLDEN: &str =
        include_str!("../../../docs/rust-migration/differential/ws-backpressure-golden.json");

    #[derive(Default)]
    struct Fake {
        buffered: usize,
        throw_next: Option<String>,
        close_throws: bool,
        terminated: bool,
    }

    impl Transport for Fake {
        fn send(&mut self, _payload: &Payload, _options: &Options) -> Result<(), String> {
            match self.throw_next.take() {
                Some(message) => Err(message),
                None => Ok(()),
            }
        }
        fn close(&mut self, _code: u16, _reason: &str) -> Result<(), String> {
            if self.close_throws {
                Err("close threw".to_string())
            } else {
                Ok(())
            }
        }
        fn terminate(&mut self) {
            self.terminated = true;
        }
        fn buffered_amount(&self) -> usize {
            self.buffered
        }
    }

    fn payload(spec: &Value) -> Payload {
        let bytes = match spec.get("fill").and_then(Value::as_str) {
            Some(fill) => fill
                .repeat(spec["length"].as_u64().expect("length") as usize)
                .into_bytes(),
            None => spec["value"].as_str().expect("value").as_bytes().to_vec(),
        };
        match spec["kind"].as_str().expect("kind") {
            "text" => Payload::Text(String::from_utf8(bytes).expect("utf-8 case")),
            "buffer" => Payload::Buffer(bytes),
            "view" => Payload::View(bytes),
            other => panic!("unknown payload kind {other}"),
        }
    }

    fn options_json(options: &Options) -> Value {
        match options {
            Options::None | Options::Callback => Value::Null,
            Options::Binary(binary) => json!({ "binary": binary }),
        }
    }

    fn effect_json(effect: &Effect) -> Value {
        match effect {
            Effect::Send {
                bytes,
                sha,
                options,
            } => {
                json!({ "e": "send", "bytes": bytes, "sha": sha, "options": options_json(options) })
            }
            Effect::Close { code, reason } => {
                json!({ "e": "close", "code": code, "reason": reason })
            }
            Effect::Terminate => json!({ "e": "terminate" }),
            Effect::Metric { name, amount, set } => {
                // Every amount the JavaScript emits is a counter or a queue
                // depth, so JSON.stringify wrote an integer literal.
                let amount = if amount.fract() == 0.0 {
                    json!(*amount as u64)
                } else {
                    json!(amount)
                };
                json!({ "e": "metric", "name": name, "amount": amount, "set": set })
            }
            Effect::Log {
                event,
                reason,
                queue_bytes,
                queue_messages,
                buffered,
            } => json!({ "e": "log", "event": event, "reason": reason,
                "queueBytes": queue_bytes, "queueMessages": queue_messages,
                "bufferedAmount": buffered }),
            Effect::Callback { index, error } => {
                json!({ "e": "callback", "index": index, "error": error })
            }
            Effect::Schedule { ms } => json!({ "e": "schedule", "ms": ms }),
            Effect::Cancel => json!({ "e": "cancel" }),
        }
    }

    fn stats_json(stats: &Stats) -> Value {
        json!({ "e": "stats", "queueBytes": stats.queue_bytes,
            "queueMessages": stats.queue_messages, "sending": stats.sending,
            "congested": stats.congested, "closed": stats.closed })
    }

    fn limits_from(overrides: &Value) -> Limits {
        let mut limits = Limits::default();
        let read = |key: &str| overrides.get(key).and_then(Value::as_u64);
        if let Some(value) = read("highWaterBytes") {
            limits.high_water_bytes = value as usize;
        }
        if let Some(value) = read("maxQueueBytes") {
            limits.max_queue_bytes = value as usize;
        }
        if let Some(value) = read("maxQueueMessages") {
            limits.max_queue_messages = value as usize;
        }
        if let Some(value) = read("maxCongestionMs") {
            limits.max_congestion_ms = value;
        }
        if let Some(value) = read("retryMs") {
            limits.retry_ms = value;
        }
        if let Some(value) = read("maxFrameBytes") {
            limits.max_frame_bytes = value as usize;
        }
        limits
    }

    #[test]
    fn the_corpus_covers_every_effect_kind() {
        let corpus: Value = serde_json::from_str(GOLDEN).expect("corpus JSON");
        let mut kinds: Vec<&str> = corpus["cases"]
            .as_array()
            .expect("cases")
            .iter()
            .flat_map(|case| case["effects"].as_array().expect("effects"))
            .map(|effect| effect["e"].as_str().expect("effect kind"))
            .collect();
        kinds.sort_unstable();
        kinds.dedup();
        assert_eq!(
            kinds,
            [
                "callback",
                "cancel",
                "close",
                "log",
                "metric",
                "schedule",
                "send",
                "stats",
                "terminate"
            ]
        );
    }

    #[test]
    fn the_frozen_defaults_and_coalescing_set_have_not_drifted() {
        let corpus: Value = serde_json::from_str(GOLDEN).expect("corpus JSON");
        let defaults = &corpus["defaults"];
        assert_eq!(limits_from(defaults), Limits::default());
        let mut types: Vec<&str> = COALESCE_TYPES.to_vec();
        types.sort_unstable();
        let frozen: Vec<&str> = corpus["coalesceTypes"]
            .as_array()
            .expect("coalesce types")
            .iter()
            .map(|value| value.as_str().expect("type name"))
            .collect();
        assert_eq!(types, frozen);
    }

    #[test]
    fn frozen_node_backpressure_decisions_match_effect_for_effect() {
        let corpus: Value = serde_json::from_str(GOLDEN).expect("corpus JSON");
        for case in corpus["cases"].as_array().expect("cases") {
            let name = case["name"].as_str().expect("case name");
            let mut wrapper = Wrapper::new(limits_from(&case["limits"]));
            let mut transport = Fake::default();
            let mut clock = 1_000.0;
            wrapper.set_now(clock);
            let mut ordinal: u64 = 0;
            let mut actual: Vec<Value> = Vec::new();
            for op in case["ops"].as_array().expect("ops") {
                match op["op"].as_str().expect("op name") {
                    "send" => {
                        let index = ordinal;
                        ordinal += 1;
                        let options = if op
                            .get("callbackAsOptions")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                        {
                            Options::Callback
                        } else {
                            match op.get("options").and_then(|value| value.get("binary")) {
                                Some(binary) => {
                                    Options::Binary(binary.as_bool().expect("binary flag"))
                                }
                                None => Options::None,
                            }
                        };
                        let callback = op
                            .get("callback")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                            .then_some(index);
                        let bounded = op["bounded"].as_bool().expect("bounded");
                        wrapper.enqueue(
                            payload(&op["data"]),
                            options,
                            callback,
                            bounded,
                            &mut transport,
                        );
                    }
                    "complete" => {
                        let error = op.get("error").and_then(Value::as_str);
                        wrapper.complete(error, &mut transport);
                    }
                    "throwNext" => {
                        transport.throw_next =
                            Some(op["message"].as_str().expect("throw message").to_string());
                    }
                    "closeThrows" => transport.close_throws = true,
                    "timer" => wrapper.fire_timer(&mut transport),
                    "buffered" => {
                        transport.buffered = op["bytes"].as_u64().expect("buffered") as usize;
                    }
                    "advance" => {
                        clock += op["ms"].as_f64().expect("advance ms");
                        wrapper.set_now(clock);
                    }
                    "closeEvent" => wrapper.close_event(),
                    "stats" => {
                        actual.extend(wrapper.take_effects().iter().map(effect_json));
                        actual.push(stats_json(&wrapper.stats()));
                    }
                    other => panic!("unknown op {other}"),
                }
            }
            actual.extend(wrapper.take_effects().iter().map(effect_json));
            let expected: Vec<Value> = case["effects"].as_array().expect("effects").to_vec();
            assert_eq!(
                actual.len(),
                expected.len(),
                "oracle case \"{name}\": effect count\n  rust: {}\n  node: {}",
                serde_json::to_string(&actual).unwrap_or_default(),
                serde_json::to_string(&expected).unwrap_or_default()
            );
            for (index, (left, right)) in actual.iter().zip(expected.iter()).enumerate() {
                assert_eq!(
                    left, right,
                    "oracle case \"{name}\": effect {index} diverged"
                );
            }
        }
        assert!(
            corpus["cases"].as_array().expect("cases").len() >= 20,
            "the corpus must keep every frozen case"
        );
    }
}
