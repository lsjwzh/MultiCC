//! Auto Provider turn runtime — the Rust half of
//! `src/chat/auto-provider-runtime.js`.
//!
//! The runtime owns per-session route state and turns a pool snapshot into
//! routing decisions. Assembling that snapshot (provider catalog, limit cache,
//! quota guard, price table) is host I/O and stays in JavaScript; this module
//! takes the snapshot as plain data and answers the questions that must not be
//! duplicated.
//!
//! [`retry_not_before`] is the read-only fact the unattended supervisor parks
//! on: the earliest epoch-ms at which this session's own lane could accept a
//! turn again. It never mutates anything, so it is safe to ask at any time.
//!
//! Behaviour is frozen by
//! `native/core/tests/fixtures/auto-provider-runtime.json`, recorded from the
//! Node oracle before the migration (see
//! `scripts/generate-auto-provider-fixtures.js`).

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::auto_provider_policy::{choose_candidate, failover_safety};
use crate::js::serde::{js_string, js_to_number, truthy, truthy_opt};

/// Failure reasons that forbid switching the physical route inside the current
/// logical turn (the replay fence is already closed).
const UNSAFE_HANDOFF_REASONS: [&str; 3] = [
    "unsafe_failure_phase",
    "unsafe_replay_boundary",
    "provider_replay_fence_closed",
];

/// The fields the policy chooser reads, exactly as its JavaScript bridge sends
/// them (`CANDIDATE_FIELDS` in `src/chat/auto-provider-policy.js`).
const CANDIDATE_FIELDS: [&str; 11] = [
    "enabled",
    "providerId",
    "limitState",
    "limitReason",
    "tier",
    "cli",
    "model",
    "priority",
    "index",
    "usedPercent",
    "trustDomain",
];

/// Turns kept before the oldest is dropped. A session never has more than a
/// handful in flight (a turn plus the continuation it reserved); the cap only
/// bounds a long-lived process whose closures JavaScript has already released.
const MAX_TURNS: usize = 128;

fn map() -> Map<String, Value> {
    Map::new()
}

fn put(target: &mut Map<String, Value>, key: &str, value: Value) {
    target.insert(key.to_string(), value);
}

/// `value || null`.
fn or_null(value: Option<&Value>) -> Value {
    match value {
        Some(other) if truthy(other) => other.clone(),
        _ => Value::Null,
    }
}

fn object(value: Map<String, Value>) -> Value {
    Value::Object(value)
}

fn text(value: &str) -> Value {
    Value::String(value.to_string())
}

/// A JSON object from ordered pairs.
fn record(pairs: Vec<(&str, Value)>) -> Value {
    let mut out = map();
    for (key, value) in pairs {
        put(&mut out, key, value);
    }
    object(out)
}

fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value
        .and_then(Value::as_object)
        .and_then(|map| map.get(key))
}

fn field_text(value: Option<&Value>, key: &str) -> Option<String> {
    field(value, key).map(js_string)
}

/// The lane a candidate runs on (`candidate.cli || home`).
fn lane_of(candidate: &Value, home: &str) -> String {
    match field(Some(candidate), "cli") {
        Some(value) if truthy(value) => js_string(value),
        _ => home.to_string(),
    }
}

fn provider_id_of(candidate: &Value) -> Value {
    field(Some(candidate), "providerId")
        .cloned()
        .unwrap_or(Value::Null)
}

fn strict_eq(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

fn list_of(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

fn contains_value(list: &[Value], needle: &Value) -> bool {
    list.iter().any(|item| item == needle)
}

/// `candidate.limitState === 'exhausted'`.
fn is_exhausted(candidate: &Value) -> bool {
    matches!(field(Some(candidate), "limitState"), Some(Value::String(state)) if state == "exhausted")
}

/// `selection.maxAttempts` (already normalized to the enabled pool size).
fn max_attempts(selection: &Value) -> f64 {
    field(Some(selection), "maxAttempts")
        .map(js_to_number)
        .unwrap_or(f64::NAN)
}

fn prefers_max_quota(selection: &Value) -> bool {
    field(Some(selection), "preferMaxQuota") != Some(&Value::Bool(false))
}

fn sticky_enabled(selection: &Value) -> bool {
    truthy_opt(field(Some(selection), "sticky"))
}

fn cli_switch(selection: &Value) -> Option<String> {
    let value = field(Some(selection), "cliSwitch")?;
    truthy(value).then(|| js_string(value))
}

fn routing_configured(selection: &Value) -> bool {
    truthy_opt(field(Some(selection), "routing"))
}

fn emit_effect(session_id: &str, event: Value) -> Value {
    record(vec![
        ("kind", text("emit")),
        ("sessionId", Value::String(session_id.to_string())),
        ("event", event),
    ])
}

fn info_effect(name: &str, fields: Value) -> Value {
    record(vec![
        ("kind", text("info")),
        ("name", Value::String(name.to_string())),
        ("fields", fields),
    ])
}

fn envelope(value: Value, effects: Vec<Value>) -> Value {
    record(vec![
        ("value", value),
        ("undefined", Value::Bool(false)),
        ("error", Value::Null),
        ("effects", Value::Array(effects)),
    ])
}

fn envelope_undefined(effects: Vec<Value>) -> Value {
    record(vec![
        ("value", Value::Null),
        ("undefined", Value::Bool(true)),
        ("error", Value::Null),
        ("effects", Value::Array(effects)),
    ])
}

fn envelope_error(message: &str, code: &str, effects: Vec<Value>) -> Value {
    record(vec![
        ("value", Value::Null),
        ("undefined", Value::Bool(false)),
        (
            "error",
            record(vec![
                ("message", Value::String(message.to_string())),
                ("code", Value::String(code.to_string())),
            ]),
        ),
        ("effects", Value::Array(effects)),
    ])
}

/// The policy chooser's input projection (`chooseCandidate` in
/// `src/chat/auto-provider-policy.js`).
fn project_candidate(candidate: &Value) -> Value {
    let mut out = map();
    let Some(fields) = candidate.as_object() else {
        return object(out);
    };
    for key in CANDIDATE_FIELDS {
        if let Some(value) = fields.get(key) {
            out.insert(key.to_string(), value.clone());
        }
    }
    if let Some(price) = fields.get("price").filter(|price| truthy(price)) {
        out.insert("priced".to_string(), Value::Bool(true));
        if let Some(blended) = field(Some(price), "blended") {
            out.insert("blended".to_string(), blended.clone());
        }
    }
    object(out)
}

/// The knobs of one `chooseCandidate` call.
#[derive(Default)]
struct Choose {
    attempted: Vec<Value>,
    preferred_tier: Value,
    ladder: Value,
    pinned: Option<Value>,
    sticky_provider_id: Value,
    prefer_cli: Value,
    by_price: bool,
    by_quota: bool,
}

/// `chooseCandidate` — the chosen candidate by identity, plus the skipped rows
/// as the wire shape `{ providerId, reason }`.
fn choose(candidates: &[Value], knobs: &Choose) -> (Option<Value>, Value) {
    let mut request = map();
    put(
        &mut request,
        "candidates",
        Value::Array(candidates.iter().map(project_candidate).collect()),
    );
    put(
        &mut request,
        "attempted",
        Value::Array(knobs.attempted.clone()),
    );
    put(
        &mut request,
        "stickyProviderId",
        knobs.sticky_provider_id.clone(),
    );
    put(&mut request, "preferredTier", knobs.preferred_tier.clone());
    put(&mut request, "ladder", knobs.ladder.clone());
    put(
        &mut request,
        "pinned",
        knobs.pinned.clone().unwrap_or(Value::Null),
    );
    put(&mut request, "preferCli", knobs.prefer_cli.clone());
    put(&mut request, "byPrice", Value::Bool(knobs.by_price));
    put(&mut request, "byQuota", Value::Bool(knobs.by_quota));
    let payload = Value::Object(request).to_string();
    let answer: Value =
        serde_json::from_str(&choose_candidate(&payload).unwrap_or_else(|_| "null".to_string()))
            .unwrap_or(Value::Null);
    let index = answer.get("candidate").and_then(Value::as_u64);
    let candidate = index.and_then(|at| candidates.get(at as usize)).cloned();
    let mut skipped = Vec::new();
    if let Some(Value::Array(rows)) = answer.get("skipped") {
        for row in rows {
            let at = field(Some(row), "index")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            let provider_id = candidates
                .get(at)
                .map(provider_id_of)
                .unwrap_or(Value::Null);
            let reason = match field(Some(row), "reason") {
                Some(Value::Null) | None => field(candidates.get(at), "limitReason")
                    .cloned()
                    .unwrap_or(Value::Null),
                Some(other) => other.clone(),
            };
            skipped.push(record(vec![
                ("providerId", provider_id),
                ("reason", reason),
            ]));
        }
    }
    (candidate, Value::Array(skipped))
}

/// `failoverSafety` on the raw decision/attempt.
fn safety(decision: &Value, attempt: &Value) -> (bool, Option<String>) {
    let request = record(vec![
        ("decision", decision.clone()),
        ("attempt", attempt.clone()),
    ]);
    let answer: Value = serde_json::from_str(
        &failover_safety(&request.to_string()).unwrap_or_else(|_| "null".to_string()),
    )
    .unwrap_or(Value::Null);
    let ok = matches!(answer.get("ok"), Some(Value::Bool(true)));
    let reason = answer
        .get("reason")
        .filter(|value| truthy(value))
        .map(js_string);
    (ok, reason)
}

/// Per-session state of one turn closure.
struct Turn {
    session_id: String,
    turn_id: Value,
    cli: String,
    selection: Value,
    candidates: Vec<Value>,
    other_lanes: Vec<Value>,
    routing: Value,
    preferred_tier: Value,
    ladder: Value,
    by_price: bool,
    price_tiered: bool,
    attempted: Vec<Value>,
    pending: Option<Value>,
    current: Option<Value>,
    physical_attempt: i64,
    selection_failure_reason: Option<String>,
}

/// The per-session route state and the turns that read it. One instance per
/// `createAutoProviderRuntime` call, exactly like the JS closure it replaced.
#[derive(Default)]
pub struct Runtime {
    sticky: BTreeMap<String, String>,
    current: BTreeMap<String, Value>,
    selection_key: BTreeMap<String, Value>,
    pending: BTreeMap<String, Value>,
    seed_lane: BTreeMap<String, Value>,
    hops: BTreeMap<String, i64>,
    turns: BTreeMap<u64, Turn>,
    next_turn: u64,
}

impl Runtime {
    /// `syncSelection` first half: reset this session's route state when its
    /// policy key changed, then say what host fact (if any) the second half
    /// needs.
    pub fn sync_prepare(&mut self, request: &Value) -> Value {
        let session_id = field_text(Some(request), "sessionId").unwrap_or_default();
        let key = field(Some(request), "key").cloned().unwrap_or(Value::Null);
        let cli = field(Some(request), "cli")
            .map(js_string)
            .unwrap_or_else(|| "claude".to_string());
        let selection = field(Some(request), "selection")
            .cloned()
            .unwrap_or(Value::Null);
        let last = field(Some(request), "lastRoute")
            .cloned()
            .unwrap_or(Value::Null);
        let has_key_field = field(Some(request), "lastRouteHasSelectionKey")
            .map(truthy)
            .unwrap_or(false);
        if self.selection_key.get(&session_id) == Some(&key) {
            return record(vec![("action", text("same"))]);
        }
        let first_seen = !self.selection_key.contains_key(&session_id);
        self.sticky.remove(&session_id);
        self.current.remove(&session_id);
        self.pending.remove(&session_id);
        self.seed_lane.remove(&session_id);
        self.hops.remove(&session_id);
        self.selection_key.insert(session_id.clone(), key.clone());
        if !truthy(&last) {
            // seedFromPool also needs a `lastGoodRoute` lookup; JavaScript owns
            // that call and reports back through `sync_finish_seed`.
            let want = truthy(&key) && sticky_enabled(&selection);
            return record(vec![("action", text("seed")), ("want", Value::Bool(want))]);
        }
        if !first_seen || !truthy(&key) || !sticky_enabled(&selection) {
            return record(vec![("action", text("none"))]);
        }
        if let Some(last_cli) = field(Some(&last), "cli") {
            if truthy(last_cli) && js_string(last_cli) != cli {
                return record(vec![("action", text("none"))]);
            }
        }
        let candidates = list_of(field(Some(&selection), "candidates"));
        let last_provider = field(Some(&last), "providerId");
        let found = candidates.iter().find(|item| {
            if field(Some(item), "enabled") == Some(&Value::Bool(false)) {
                return false;
            }
            if !strict_eq(field(Some(item), "providerId"), last_provider) {
                return false;
            }
            match field(Some(item), "cli") {
                Some(item_cli) if truthy(item_cli) => js_string(item_cli) == cli,
                _ => true,
            }
        });
        let Some(candidate) = found else {
            return record(vec![("action", text("none"))]);
        };
        if has_key_field {
            let matches = strict_eq(field(Some(&last), "selectionKey"), Some(&key));
            if matches {
                if let Some(provider) = field(Some(candidate), "providerId") {
                    self.sticky.insert(session_id, js_string(provider));
                }
            }
            return record(vec![("action", text("none"))]);
        }
        record(vec![
            ("action", text("legacy")),
            (
                "candidate",
                record(vec![
                    (
                        "providerId",
                        field(Some(candidate), "providerId")
                            .cloned()
                            .unwrap_or(Value::Null),
                    ),
                    (
                        "model",
                        field(Some(candidate), "model")
                            .cloned()
                            .unwrap_or(Value::Null),
                    ),
                    (
                        "autoModel",
                        Value::Bool(truthy_opt(field(Some(candidate), "autoModel"))),
                    ),
                    ("cli", Value::String(cli)),
                ]),
            ),
        ])
    }

    /// `seedFromPool` second half, once JavaScript has the pool-memory record.
    pub fn sync_finish_seed(&mut self, request: &Value) -> Value {
        let session_id = field_text(Some(request), "sessionId").unwrap_or_default();
        let cli = field(Some(request), "cli")
            .map(js_string)
            .unwrap_or_else(|| "claude".to_string());
        let selection = field(Some(request), "selection")
            .cloned()
            .unwrap_or(Value::Null);
        let Some(seed) = field(Some(request), "seed").filter(|seed| truthy(seed)) else {
            return envelope(Value::Null, Vec::new());
        };
        let Some(provider) = field(Some(seed), "providerId").filter(|value| truthy(value)) else {
            return envelope(Value::Null, Vec::new());
        };
        let seed_cli = match field(Some(seed), "cli") {
            Some(value) if truthy(value) => js_string(value),
            _ => cli.clone(),
        };
        let candidates = list_of(field(Some(&selection), "candidates"));
        let known = candidates.iter().any(|item| {
            field(Some(item), "enabled") != Some(&Value::Bool(false))
                && strict_eq(field(Some(item), "providerId"), Some(provider))
                && {
                    let lane = match field(Some(item), "cli") {
                        Some(value) if truthy(value) => js_string(value),
                        _ => cli.clone(),
                    };
                    lane == seed_cli
                }
        });
        if !known {
            return envelope(Value::Null, Vec::new());
        }
        if seed_cli == cli {
            self.sticky.insert(session_id.clone(), js_string(provider));
        } else if cli_switch(&selection).is_some() && !routing_configured(&selection) {
            self.seed_lane.insert(
                session_id.clone(),
                record(vec![
                    ("cli", Value::String(seed_cli.clone())),
                    ("providerId", provider.clone()),
                ]),
            );
        } else {
            return envelope(Value::Null, Vec::new());
        }
        let fields = record(vec![
            ("sessionId", Value::String(session_id.clone())),
            ("cli", Value::String(seed_cli)),
            ("providerId", provider.clone()),
            ("succeededAt", or_null(field(Some(seed), "succeededAt"))),
        ]);
        envelope(
            Value::Null,
            vec![info_effect("auto_provider_pool_memory_seed", fields)],
        )
    }

    /// The legacy (unsigned) route match: the persisted model must still be one
    /// the line runs.
    pub fn sync_finish_legacy(&mut self, request: &Value) -> Value {
        let session_id = field_text(Some(request), "sessionId").unwrap_or_default();
        if !field(Some(request), "found").map(truthy).unwrap_or(false) {
            return envelope(Value::Null, Vec::new());
        }
        let choices = list_of(field(Some(request), "choices"));
        let model = field(Some(request), "model")
            .cloned()
            .unwrap_or(Value::Null);
        let last_model = field(Some(request), "lastModel")
            .cloned()
            .unwrap_or(Value::Null);
        let matches = if choices.is_empty() {
            or_null(Some(&last_model)) == model
        } else {
            contains_value(&choices, &last_model)
        };
        if matches {
            if let Some(provider) = field(Some(request), "providerId") {
                self.sticky.insert(session_id, js_string(provider));
            }
        }
        envelope(Value::Null, Vec::new())
    }

    /// `planTurn`: may this turn run on another lane?
    pub fn plan_turn(&mut self, request: &Value) -> Value {
        let session_id = field_text(Some(request), "sessionId").unwrap_or_default();
        let cli = field(Some(request), "cli")
            .map(js_string)
            .unwrap_or_else(|| "claude".to_string());
        let selection = field(Some(request), "selection")
            .cloned()
            .unwrap_or(Value::Null);
        let candidates = list_of(field(Some(request), "candidates"));
        let ladder = field(Some(request), "ladder")
            .cloned()
            .unwrap_or(Value::Null);
        let decision = field(Some(request), "routingDecision")
            .cloned()
            .unwrap_or(Value::Null);
        let by_price = field(Some(request), "byPrice").map(truthy).unwrap_or(false);
        let price_tiered = field(Some(request), "priceTiered")
            .map(truthy)
            .unwrap_or(false);
        let origin_continue = field(Some(request), "originContinue")
            .map(truthy)
            .unwrap_or(false);
        let direct_input = field(Some(request), "directUserInput")
            .map(truthy)
            .unwrap_or(false);
        let available = |lane: &str| -> bool {
            field(Some(request), "availability")
                .and_then(|map| field(Some(map), lane))
                .map(|value| value == &Value::Bool(true))
                .unwrap_or(true)
        };

        let hops = self.hops.get(&session_id).copied().unwrap_or(0);
        if (hops as f64) >= max_attempts(&selection) {
            return envelope(Value::Null, Vec::new());
        }
        let pending = self.pending.get(&session_id).cloned();
        if let Some(pending) = &pending {
            if let Some(pending_cli) = field(Some(pending), "cli").filter(|value| truthy(value)) {
                if js_string(pending_cli) != cli {
                    if !available(&js_string(pending_cli)) {
                        self.pending.remove(&session_id);
                        return envelope(Value::Null, Vec::new());
                    }
                    let mut effects = Vec::new();
                    let value = self.plan(
                        &session_id,
                        &cli,
                        pending,
                        None,
                        &Value::Null,
                        false,
                        &mut effects,
                    );
                    return envelope(value, effects);
                }
                return envelope(Value::Null, Vec::new());
            }
            return envelope(Value::Null, Vec::new());
        }
        // A continuation stays on its lane unless a handoff reserved another
        // one, or that lane is already out of usable lines.
        if origin_continue && !direct_input {
            if routing_configured(&selection) {
                return envelope(Value::Null, Vec::new());
            }
            let home_usable = candidates.iter().any(|candidate| {
                lane_of(candidate, &cli) == cli
                    && field(Some(candidate), "enabled") != Some(&Value::Bool(false))
                    && !is_exhausted(candidate)
            });
            if home_usable {
                return envelope(Value::Null, Vec::new());
            }
        }
        if let Some(seed) = self.seed_lane.remove(&session_id) {
            let seed_cli = field_text(Some(&seed), "cli").unwrap_or_default();
            let remembered = candidates.iter().find(|candidate| {
                field_text(Some(candidate), "cli").as_deref() == Some(seed_cli.as_str())
                    && strict_eq(
                        field(Some(candidate), "providerId"),
                        field(Some(&seed), "providerId"),
                    )
                    && field(Some(candidate), "enabled") != Some(&Value::Bool(false))
                    && !is_exhausted(candidate)
            });
            if let Some(remembered) = remembered {
                if available(&lane_of(remembered, &cli)) {
                    let reservation = record(vec![
                        ("sessionId", Value::String(session_id.clone())),
                        ("originTurnId", Value::Null),
                        ("fromCli", Value::String(cli.clone())),
                        ("cli", Value::String(seed_cli)),
                        ("fromProviderId", Value::Null),
                        ("fromProviderName", Value::Null),
                        ("providerId", provider_id_of(remembered)),
                        (
                            "providerName",
                            or_null(field(Some(remembered), "providerName")),
                        ),
                        ("model", or_null(field(Some(remembered), "model"))),
                        ("reasonCode", text("auto_pool_memory")),
                        ("planned", Value::Bool(true)),
                    ]);
                    self.pending.insert(session_id.clone(), reservation.clone());
                    let mut effects = Vec::new();
                    let value = self.plan(
                        &session_id,
                        &cli,
                        &reservation,
                        Some(remembered),
                        &Value::Null,
                        false,
                        &mut effects,
                    );
                    return envelope(value, effects);
                }
            }
        }
        let reachable: Vec<Value> = candidates
            .iter()
            .filter(|candidate| {
                lane_of(candidate, &cli) == cli || available(&lane_of(candidate, &cli))
            })
            .cloned()
            .collect();
        let preferred_tier = or_null(field(Some(&decision), "tier"));
        let sticky = if sticky_enabled(&selection) {
            self.sticky
                .get(&session_id)
                .map(|id| Value::String(id.clone()))
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        let choose_list = |list: Vec<Value>| -> Option<Value> {
            let knobs = Choose {
                attempted: Vec::new(),
                preferred_tier: preferred_tier.clone(),
                ladder: ladder.clone(),
                pinned: None,
                sticky_provider_id: sticky.clone(),
                prefer_cli: Value::String(cli.clone()),
                by_price,
                by_quota: prefers_max_quota(&selection),
            };
            choose(&list, &knobs).0
        };
        let picked = match cli_switch(&selection).as_deref() {
            Some("routing") => choose_list(reachable),
            _ => {
                let home: Vec<Value> = reachable
                    .iter()
                    .filter(|candidate| lane_of(candidate, &cli) == cli)
                    .cloned()
                    .collect();
                if choose_list(home).is_some() {
                    return envelope(Value::Null, Vec::new());
                }
                let other: Vec<Value> = reachable
                    .iter()
                    .filter(|candidate| lane_of(candidate, &cli) != cli)
                    .cloned()
                    .collect();
                choose_list(other)
            }
        };
        let Some(picked) = picked else {
            return envelope(Value::Null, Vec::new());
        };
        if lane_of(&picked, &cli) == cli {
            return envelope(Value::Null, Vec::new());
        }
        let reason_code = if cli_switch(&selection).as_deref() == Some("routing") {
            "auto_cli_routing"
        } else {
            "auto_cli_failover"
        };
        let reservation = record(vec![
            ("sessionId", Value::String(session_id.clone())),
            ("originTurnId", Value::Null),
            ("fromCli", Value::String(cli.clone())),
            ("cli", Value::String(lane_of(&picked, &cli))),
            ("fromProviderId", Value::Null),
            ("fromProviderName", Value::Null),
            ("providerId", provider_id_of(&picked)),
            (
                "providerName",
                or_null(field(Some(&picked), "providerName")),
            ),
            ("model", or_null(field(Some(&picked), "model"))),
            ("reasonCode", text(reason_code)),
            ("planned", Value::Bool(true)),
        ]);
        self.pending.insert(session_id.clone(), reservation.clone());
        let mut effects = Vec::new();
        let value = self.plan(
            &session_id,
            &cli,
            &reservation,
            Some(&picked),
            &decision,
            price_tiered,
            &mut effects,
        );
        envelope(value, effects)
    }

    /// `plan(...)`: reserve the lane, narrate it, and hand back the switch.
    #[allow(clippy::too_many_arguments)]
    fn plan(
        &mut self,
        session_id: &str,
        from_cli: &str,
        reservation: &Value,
        candidate: Option<&Value>,
        decision: &Value,
        price_tiered: bool,
        effects: &mut Vec<Value>,
    ) -> Value {
        let hops = self.hops.get(session_id).copied().unwrap_or(0);
        self.hops.insert(session_id.to_string(), hops + 1);
        let mut event = map();
        put(&mut event, "type", text("provider_auto_route"));
        put(&mut event, "version", Value::from(1));
        put(&mut event, "mode", text("auto"));
        put(
            &mut event,
            "sessionId",
            Value::String(session_id.to_string()),
        );
        put(&mut event, "turnId", Value::Null);
        put(&mut event, "routePhase", text("cli_switch_planned"));
        put(
            &mut event,
            "cli",
            field(Some(reservation), "cli")
                .cloned()
                .unwrap_or(Value::Null),
        );
        put(&mut event, "fromCli", Value::String(from_cli.to_string()));
        put(
            &mut event,
            "providerId",
            field(Some(reservation), "providerId")
                .cloned()
                .unwrap_or(Value::Null),
        );
        put(
            &mut event,
            "providerName",
            or_null(field(Some(reservation), "providerName")),
        );
        put(
            &mut event,
            "model",
            or_null(field(Some(reservation), "model")),
        );
        put(&mut event, "tier", or_null(field(candidate, "tier")));
        put(
            &mut event,
            "reasonCode",
            or_null(field(Some(reservation), "reasonCode")),
        );
        put(&mut event, "routing", decision.clone());
        if price_tiered {
            if let Some(price) = field(candidate, "price").filter(|price| truthy(price)) {
                put(
                    &mut event,
                    "price",
                    field(Some(price), "blended")
                        .cloned()
                        .unwrap_or(Value::Null),
                );
                put(
                    &mut event,
                    "priceSource",
                    or_null(field(Some(price), "source")),
                );
            }
        }
        let event = object(event);
        effects.push(emit_effect(session_id, event));
        let fields = record(vec![
            ("sessionId", Value::String(session_id.to_string())),
            ("fromCli", Value::String(from_cli.to_string())),
            (
                "cli",
                field(Some(reservation), "cli")
                    .cloned()
                    .unwrap_or(Value::Null),
            ),
            (
                "providerId",
                field(Some(reservation), "providerId")
                    .cloned()
                    .unwrap_or(Value::Null),
            ),
            (
                "reasonCode",
                or_null(field(Some(reservation), "reasonCode")),
            ),
        ]);
        effects.push(info_effect("auto_provider_cli_switch_planned", fields));
        record(vec![
            (
                "cli",
                field(Some(reservation), "cli")
                    .cloned()
                    .unwrap_or(Value::Null),
            ),
            ("fromCli", Value::String(from_cli.to_string())),
            (
                "providerId",
                field(Some(reservation), "providerId")
                    .cloned()
                    .unwrap_or(Value::Null),
            ),
            (
                "providerName",
                or_null(field(Some(reservation), "providerName")),
            ),
            ("model", or_null(field(Some(reservation), "model"))),
            (
                "reasonCode",
                or_null(field(Some(reservation), "reasonCode")),
            ),
        ])
    }

    /// `beginTurn`: pin this turn's pool and return a handle to it.
    pub fn begin_turn(&mut self, request: &Value) -> Value {
        let session_id = field_text(Some(request), "sessionId").unwrap_or_default();
        let turn_id = field(Some(request), "turnId")
            .cloned()
            .unwrap_or(Value::Null);
        let cli = field(Some(request), "cli")
            .map(js_string)
            .unwrap_or_else(|| "claude".to_string());
        let selection = field(Some(request), "selection")
            .cloned()
            .unwrap_or(Value::Null);
        let pool = list_of(field(Some(request), "candidates"));
        let routing = field(Some(request), "routingDecision")
            .cloned()
            .unwrap_or(Value::Null);
        let ladder = field(Some(request), "ladder")
            .cloned()
            .unwrap_or(Value::Null);
        let by_price = field(Some(request), "byPrice").map(truthy).unwrap_or(false);
        let price_tiered = field(Some(request), "priceTiered")
            .map(truthy)
            .unwrap_or(false);
        let (candidates, other_lanes): (Vec<Value>, Vec<Value>) = pool
            .into_iter()
            .partition(|candidate| lane_of(candidate, &cli) == cli);
        let preferred_tier = or_null(field(Some(&routing), "tier"));
        let mut pending = self.pending.get(&session_id).cloned();
        if let Some(reservation) = &pending {
            if let Some(pending_cli) = field(Some(reservation), "cli").filter(|value| truthy(value))
            {
                if js_string(pending_cli) != cli {
                    self.pending.remove(&session_id);
                    pending = None;
                }
            }
        }
        let mut attempted = Vec::new();
        if let Some(reservation) = &pending {
            if let Some(from) =
                field(Some(reservation), "fromProviderId").filter(|value| truthy(value))
            {
                let from_cli_ok = match field(Some(reservation), "fromCli") {
                    Some(value) if truthy(value) => js_string(value) == cli,
                    _ => true,
                };
                if from_cli_ok {
                    attempted.push(from.clone());
                }
            }
        }
        self.next_turn += 1;
        let handle = self.next_turn;
        let turn = Turn {
            session_id,
            turn_id,
            cli,
            selection,
            candidates,
            other_lanes,
            routing,
            preferred_tier,
            ladder,
            by_price,
            price_tiered,
            attempted,
            pending,
            current: None,
            physical_attempt: 0,
            selection_failure_reason: None,
        };
        self.turns.insert(handle, turn);
        while self.turns.len() > MAX_TURNS {
            let oldest = *self.turns.keys().next().expect("non-empty");
            self.turns.remove(&oldest);
        }
        envelope(record(vec![("handle", Value::from(handle))]), Vec::new())
    }

    fn with_turn<R>(
        &mut self,
        handle: u64,
        f: impl FnOnce(&mut Self, &mut Turn) -> R,
    ) -> Option<R> {
        let mut turn = self.turns.remove(&handle)?;
        let result = f(self, &mut turn);
        self.turns.insert(handle, turn);
        Some(result)
    }

    /// `initial()`.
    pub fn turn_initial(&mut self, handle: u64) -> Value {
        self.with_turn(handle, |runtime, turn| {
            let mut effects = Vec::new();
            match runtime.select(turn, &mut effects, "auto_initial_selection") {
                Some(value) => envelope(value, effects),
                None => envelope_error(
                    "Auto Provider has no eligible candidate",
                    "AUTO_PROVIDER_POOL_EXHAUSTED",
                    effects,
                ),
            }
        })
        .unwrap_or_else(|| {
            envelope_error(
                "unknown auto provider turn",
                "AUTO_PROVIDER_TURN_UNKNOWN",
                Vec::new(),
            )
        })
    }

    /// `failover(decision, attempt)`.
    pub fn turn_failover(&mut self, request: &Value) -> Value {
        let handle = field(Some(request), "handle")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let decision = field(Some(request), "decision")
            .cloned()
            .unwrap_or(Value::Null);
        let attempt = field(Some(request), "attempt")
            .cloned()
            .unwrap_or(Value::Null);
        let now = field(Some(request), "now")
            .map(js_to_number)
            .unwrap_or(f64::NAN);
        let background = field(Some(request), "backgroundActive")
            .map(truthy)
            .unwrap_or(false);
        self.with_turn(handle, |runtime, turn| {
            let mut effects = Vec::new();
            let (ok, reason) = safety(&decision, &attempt);
            if !ok {
                let current = turn.current.clone();
                let reason = reason.unwrap_or_else(|| "unknown".to_string());
                runtime.publish(
                    turn,
                    &mut effects,
                    "blocked",
                    current.as_ref(),
                    &[("reasonCode", Value::String(reason))],
                );
                return envelope(Value::Null, effects);
            }
            if background {
                let current = turn.current.clone();
                runtime.publish(
                    turn,
                    &mut effects,
                    "blocked",
                    current.as_ref(),
                    &[("reasonCode", text("background_tasks_active"))],
                );
                let value = runtime.terminal_failure(
                    turn,
                    &decision,
                    "auto_background_tasks_active",
                    &attempt,
                );
                return envelope(value, effects);
            }
            let safety_reason = reason.unwrap_or_default();
            let Some(result) = runtime.select(turn, &mut effects, &safety_reason) else {
                let terminal = turn
                    .selection_failure_reason
                    .clone()
                    .unwrap_or_else(|| "provider_exhausted".to_string());
                let value = runtime.terminal_failure(
                    turn,
                    &decision,
                    &format!("auto_{terminal}"),
                    &attempt,
                );
                return envelope(value, effects);
            };
            let from_candidate = turn
                .candidates
                .iter()
                .find(|candidate| {
                    strict_eq(
                        field(Some(candidate), "providerId"),
                        field(Some(&attempt), "providerId"),
                    )
                })
                .cloned();
            let from_id = field(Some(&attempt), "providerId")
                .cloned()
                .unwrap_or(Value::Null);
            let category = field(Some(&decision), "error")
                .and_then(|error| field(Some(error), "category"))
                .cloned()
                .unwrap_or_else(|| text("unknown"));
            let provider_failover = record(vec![
                ("fromProviderId", from_id.clone()),
                (
                    "toProviderId",
                    field(Some(&result), "providerId")
                        .cloned()
                        .unwrap_or(Value::Null),
                ),
                (
                    "fromTrustDomain",
                    or_null(field(from_candidate.as_ref(), "trustDomain")),
                ),
                (
                    "toTrustDomain",
                    or_null(field(turn.current.as_ref(), "trustDomain")),
                ),
                ("category", category),
            ]);
            // `{ ...decision, action, reason, delayMs, retryAt, attempt, providerFailover }`.
            let mut retry = match decision.clone() {
                Value::Object(map) => map,
                _ => map(),
            };
            retry.insert("action".to_string(), text("retry"));
            retry.insert("reason".to_string(), text("provider_failover"));
            retry.insert("delayMs".to_string(), Value::from(0));
            retry.insert("retryAt".to_string(), Value::from(now));
            retry.insert(
                "attempt".to_string(),
                Value::from(turn.physical_attempt - 1),
            );
            retry.insert("providerFailover".to_string(), provider_failover);
            let from_name = or_null(field(from_candidate.as_ref(), "providerName"));
            let from_name = if truthy(&from_name) {
                from_name
            } else if truthy(&from_id) {
                from_id
            } else {
                Value::Null
            };
            let value = record(vec![
                ("invocationOptions", result),
                ("decision", object(retry)),
                ("fromProviderName", from_name),
                (
                    "toProviderName",
                    or_null(field(turn.current.as_ref(), "providerName")),
                ),
            ]);
            envelope(value, effects)
        })
        .unwrap_or_else(|| {
            envelope_error(
                "unknown auto provider turn",
                "AUTO_PROVIDER_TURN_UNKNOWN",
                Vec::new(),
            )
        })
    }

    /// `prepareHandoff(decision, attempt)`.
    pub fn turn_prepare_handoff(&mut self, request: &Value) -> Value {
        let handle = field(Some(request), "handle")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let decision = field(Some(request), "decision")
            .cloned()
            .unwrap_or(Value::Null);
        let attempt = field(Some(request), "attempt")
            .cloned()
            .unwrap_or(Value::Null);
        let background = field(Some(request), "backgroundActive")
            .map(truthy)
            .unwrap_or(false);
        let available = |lane: &str| -> bool {
            field(Some(request), "availability")
                .and_then(|map| field(Some(map), lane))
                .map(|value| value == &Value::Bool(true))
                .unwrap_or(true)
        };
        self.with_turn(handle, |runtime, turn| {
            let mut effects = Vec::new();
            let (ok, reason) = safety(&decision, &attempt);
            let reason = reason.unwrap_or_default();
            let unsafe_handoff = !ok && UNSAFE_HANDOFF_REASONS.contains(&reason.as_str());
            let switching = cli_switch(&turn.selection).is_some();
            if !unsafe_handoff && !(ok && switching) {
                return envelope(Value::Null, effects);
            }
            if background {
                return envelope(Value::Null, effects);
            }
            let mut excluded = turn.attempted.clone();
            if let Some(provider) =
                field(Some(&attempt), "providerId").filter(|value| truthy(value))
            {
                if !contains_value(&excluded, provider) {
                    excluded.push(provider.clone());
                }
            }
            let by_quota = prefers_max_quota(&turn.selection);
            let build = |list: &[Value]| -> (Option<Value>, Value) {
                let knobs = Choose {
                    attempted: excluded.clone(),
                    preferred_tier: turn.preferred_tier.clone(),
                    ladder: turn.ladder.clone(),
                    pinned: None,
                    sticky_provider_id: Value::Null,
                    prefer_cli: Value::Null,
                    by_price: turn.by_price,
                    by_quota,
                };
                choose(list, &knobs)
            };
            let (mut picked, mut skipped) = if unsafe_handoff {
                build(&turn.candidates)
            } else {
                (None, Value::Array(Vec::new()))
            };
            if picked.is_none() && switching {
                let hops = runtime.hops.get(&turn.session_id).copied().unwrap_or(0);
                if (hops as f64) < max_attempts(&turn.selection) {
                    let other: Vec<Value> = turn
                        .other_lanes
                        .iter()
                        .filter(|candidate| available(&lane_of(candidate, &turn.cli)))
                        .cloned()
                        .collect();
                    let (next, next_skipped) = build(&other);
                    picked = next;
                    skipped = next_skipped;
                }
            }
            let Some(picked) = picked else {
                return envelope(Value::Null, effects);
            };
            let reason_code = if unsafe_handoff {
                reason.clone()
            } else {
                "lane_pool_exhausted".to_string()
            };
            let from_provider = field(Some(&attempt), "providerId")
                .filter(|value| truthy(value))
                .cloned()
                .or_else(|| {
                    field(turn.current.as_ref(), "providerId")
                        .filter(|value| truthy(value))
                        .cloned()
                })
                .unwrap_or(Value::Null);
            let from_name = turn
                .candidates
                .iter()
                .find(|candidate| {
                    strict_eq(
                        field(Some(candidate), "providerId"),
                        field(Some(&attempt), "providerId"),
                    )
                })
                .and_then(|candidate| {
                    field(Some(candidate), "providerName")
                        .filter(|value| truthy(value))
                        .cloned()
                })
                .or_else(|| {
                    field(Some(&attempt), "providerId")
                        .filter(|value| truthy(value))
                        .cloned()
                })
                .or_else(|| {
                    field(turn.current.as_ref(), "providerName")
                        .filter(|value| truthy(value))
                        .cloned()
                })
                .unwrap_or(Value::Null);
            let mut reservation = map();
            put(
                &mut reservation,
                "sessionId",
                Value::String(turn.session_id.clone()),
            );
            put(&mut reservation, "originTurnId", turn.turn_id.clone());
            put(&mut reservation, "fromProviderId", from_provider.clone());
            put(&mut reservation, "fromProviderName", from_name.clone());
            put(&mut reservation, "providerId", provider_id_of(&picked));
            put(
                &mut reservation,
                "providerName",
                or_null(field(Some(&picked), "providerName")),
            );
            put(
                &mut reservation,
                "model",
                or_null(field(Some(&picked), "model")),
            );
            put(
                &mut reservation,
                "reasonCode",
                Value::String(reason_code.clone()),
            );
            if lane_of(&picked, &turn.cli) != turn.cli {
                put(
                    &mut reservation,
                    "cli",
                    Value::String(lane_of(&picked, &turn.cli)),
                );
                put(&mut reservation, "fromCli", Value::String(turn.cli.clone()));
            }
            let reservation = object(reservation);
            runtime
                .pending
                .insert(turn.session_id.clone(), reservation.clone());
            let from_trust = turn
                .candidates
                .iter()
                .find(|candidate| {
                    strict_eq(field(Some(candidate), "providerId"), Some(&from_provider))
                })
                .and_then(|candidate| field(Some(candidate), "trustDomain").cloned())
                .unwrap_or(Value::Null);
            let details = [
                ("fromProviderId", from_provider),
                ("fromProviderName", from_name),
                ("fromTrustDomain", from_trust),
                (
                    "toTrustDomain",
                    or_null(field(Some(&picked), "trustDomain")),
                ),
                ("reasonCode", Value::String(reason_code)),
                ("skipped", skipped),
            ];
            runtime.publish(
                turn,
                &mut effects,
                "handoff_pending",
                Some(&picked),
                &details,
            );
            envelope(reservation, effects)
        })
        .unwrap_or_else(|| {
            envelope_error(
                "unknown auto provider turn",
                "AUTO_PROVIDER_TURN_UNKNOWN",
                Vec::new(),
            )
        })
    }

    /// `recordSuccess(attempt)` — returns `undefined`.
    pub fn turn_record_success(&mut self, request: &Value) -> Value {
        let handle = field(Some(request), "handle")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let attempt = field(Some(request), "attempt")
            .cloned()
            .unwrap_or(Value::Null);
        self.with_turn(handle, |runtime, turn| {
            let mut effects = Vec::new();
            let provider = field(Some(&attempt), "providerId")
                .filter(|value| truthy(value))
                .cloned()
                .or_else(|| {
                    field(turn.current.as_ref(), "providerId")
                        .filter(|value| truthy(value))
                        .cloned()
                });
            let Some(provider) = provider else {
                return envelope_undefined(effects);
            };
            if sticky_enabled(&turn.selection) {
                runtime
                    .sticky
                    .insert(turn.session_id.clone(), js_string(&provider));
            }
            runtime.hops.remove(&turn.session_id);
            let current = turn.current.clone();
            runtime.publish(
                turn,
                &mut effects,
                "succeeded",
                current.as_ref(),
                &[("reasonCode", text("turn_succeeded"))],
            );
            envelope_undefined(effects)
        })
        .unwrap_or_else(|| {
            envelope_error(
                "unknown auto provider turn",
                "AUTO_PROVIDER_TURN_UNKNOWN",
                Vec::new(),
            )
        })
    }

    /// `snapshot(sessionId)` — the last route event of that session.
    pub fn snapshot(&self, session_id: &str) -> Value {
        self.current.get(session_id).cloned().unwrap_or(Value::Null)
    }

    /// `clearSession(sessionId)`.
    pub fn clear_session(&mut self, session_id: &str) {
        self.sticky.remove(session_id);
        self.current.remove(session_id);
        self.selection_key.remove(session_id);
        self.pending.remove(session_id);
        self.seed_lane.remove(session_id);
        self.hops.remove(session_id);
        let stale: Vec<u64> = self
            .turns
            .iter()
            .filter(|(_, turn)| turn.session_id == session_id)
            .map(|(handle, _)| *handle)
            .collect();
        for handle in stale {
            self.turns.remove(&handle);
        }
    }

    /// `select(reasonCode)`: the next line of this turn's pool, or `None`.
    fn select(
        &mut self,
        turn: &mut Turn,
        effects: &mut Vec<Value>,
        reason_code: &str,
    ) -> Option<Value> {
        turn.selection_failure_reason = None;
        if (turn.physical_attempt as f64) >= max_attempts(&turn.selection) {
            let all = turn.candidates.iter().all(|candidate| {
                field(Some(candidate), "enabled") == Some(&Value::Bool(false))
                    || contains_value(&turn.attempted, &provider_id_of(candidate))
            });
            let reason = if all {
                "candidate_pool_exhausted"
            } else {
                "attempt_budget_exhausted"
            };
            turn.selection_failure_reason = Some(reason.to_string());
            let current = turn.current.clone();
            self.publish(
                turn,
                effects,
                "exhausted",
                current.as_ref(),
                &[("reasonCode", text(reason))],
            );
            return None;
        }
        let sticky = if sticky_enabled(&turn.selection) {
            self.sticky
                .get(&turn.session_id)
                .map(|id| Value::String(id.clone()))
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        let pinned = turn.pending.as_ref().map(|pending| {
            record(vec![
                (
                    "providerId",
                    field(Some(pending), "providerId")
                        .cloned()
                        .unwrap_or(Value::Null),
                ),
                ("model", or_null(field(Some(pending), "model"))),
            ])
        });
        let knobs = Choose {
            attempted: turn.attempted.clone(),
            preferred_tier: turn.preferred_tier.clone(),
            ladder: turn.ladder.clone(),
            pinned,
            sticky_provider_id: sticky,
            prefer_cli: Value::Null,
            by_price: turn.by_price,
            by_quota: prefers_max_quota(&turn.selection),
        };
        let (picked, skipped) = choose(&turn.candidates, &knobs);
        let Some(picked) = picked else {
            turn.selection_failure_reason = Some("candidate_pool_exhausted".to_string());
            let current = turn.current.clone();
            self.publish(
                turn,
                effects,
                "exhausted",
                current.as_ref(),
                &[
                    ("reasonCode", text("candidate_pool_exhausted")),
                    ("skipped", skipped),
                ],
            );
            return None;
        };
        let previous = turn.current.clone();
        turn.current = Some(picked.clone());
        if sticky_enabled(&turn.selection) {
            self.sticky
                .insert(turn.session_id.clone(), js_string(&provider_id_of(&picked)));
        }
        if turn.pending.is_some() {
            self.pending.remove(&turn.session_id);
        }
        turn.attempted.push(provider_id_of(&picked));
        turn.physical_attempt += 1;
        let details = [
            (
                "fromProviderId",
                previous
                    .as_ref()
                    .and_then(|candidate| field(Some(candidate), "providerId"))
                    .cloned()
                    .unwrap_or(Value::Null),
            ),
            (
                "fromProviderName",
                previous
                    .as_ref()
                    .and_then(|candidate| field(Some(candidate), "providerName"))
                    .cloned()
                    .unwrap_or(Value::Null),
            ),
            (
                "fromTrustDomain",
                previous
                    .as_ref()
                    .and_then(|candidate| field(Some(candidate), "trustDomain"))
                    .cloned()
                    .unwrap_or(Value::Null),
            ),
            (
                "toTrustDomain",
                or_null(field(Some(&picked), "trustDomain")),
            ),
            ("reasonCode", Value::String(reason_code.to_string())),
            ("skipped", skipped),
        ];
        let phase = if previous.is_some() {
            "switched"
        } else {
            "selected"
        };
        self.publish(turn, effects, phase, Some(&picked), &details);
        Some(record(vec![
            ("providerId", provider_id_of(&picked)),
            ("model", or_null(field(Some(&picked), "model"))),
            ("reasonCode", Value::String(reason_code.to_string())),
        ]))
    }

    /// `terminalFailure(...)`.
    fn terminal_failure(
        &self,
        turn: &Turn,
        decision: &Value,
        reason_code: &str,
        attempt: &Value,
    ) -> Value {
        let mut terminal = match decision.clone() {
            Value::Object(map) => map,
            _ => map(),
        };
        terminal.insert("action".to_string(), text("fail_fast"));
        terminal.insert("reason".to_string(), Value::String(reason_code.to_string()));
        terminal.insert("delayMs".to_string(), Value::from(0));
        terminal.insert("retryAt".to_string(), Value::Null);
        let from_name = turn
            .candidates
            .iter()
            .find(|candidate| {
                strict_eq(
                    field(Some(candidate), "providerId"),
                    field(Some(attempt), "providerId"),
                )
            })
            .and_then(|candidate| {
                field(Some(candidate), "providerName")
                    .filter(|value| truthy(value))
                    .cloned()
            })
            .or_else(|| {
                field(Some(attempt), "providerId")
                    .filter(|value| truthy(value))
                    .cloned()
            })
            .or_else(|| {
                field(turn.current.as_ref(), "providerName")
                    .filter(|value| truthy(value))
                    .cloned()
            })
            .unwrap_or(Value::Null);
        record(vec![
            ("invocationOptions", Value::Null),
            ("decision", object(terminal)),
            ("terminal", Value::Bool(true)),
            ("reasonCode", Value::String(reason_code.to_string())),
            ("fromProviderName", from_name),
            ("toProviderName", Value::Null),
        ])
    }

    /// `publish(phase, candidate, details)`: store the event, then emit it, then
    /// log it.
    fn publish(
        &mut self,
        turn: &mut Turn,
        effects: &mut Vec<Value>,
        phase: &str,
        candidate: Option<&Value>,
        details: &[(&str, Value)],
    ) {
        let mut event = map();
        put(&mut event, "type", text("provider_auto_route"));
        put(&mut event, "version", Value::from(1));
        put(&mut event, "mode", text("auto"));
        put(
            &mut event,
            "sessionId",
            Value::String(turn.session_id.clone()),
        );
        put(&mut event, "turnId", turn.turn_id.clone());
        put(
            &mut event,
            "protocol",
            match field(candidate, "protocol") {
                Some(value) if truthy(value) => value.clone(),
                _ => field(Some(&turn.selection), "protocol")
                    .cloned()
                    .unwrap_or(Value::Null),
            },
        );
        put(&mut event, "routePhase", Value::String(phase.to_string()));
        put(
            &mut event,
            "providerId",
            or_null(field(candidate, "providerId")),
        );
        put(
            &mut event,
            "providerName",
            or_null(field(candidate, "providerName")),
        );
        put(&mut event, "model", or_null(field(candidate, "model")));
        put(&mut event, "tier", or_null(field(candidate, "tier")));
        put(
            &mut event,
            "trustDomain",
            or_null(field(candidate, "trustDomain")),
        );
        put(&mut event, "fromTrustDomain", Value::Null);
        put(
            &mut event,
            "toTrustDomain",
            or_null(field(candidate, "trustDomain")),
        );
        put(&mut event, "attemptNo", Value::from(turn.physical_attempt));
        put(
            &mut event,
            "maxAttempts",
            field(Some(&turn.selection), "maxAttempts")
                .cloned()
                .unwrap_or(Value::Null),
        );
        put(&mut event, "preferredTier", turn.preferred_tier.clone());
        put(&mut event, "routing", turn.routing.clone());
        if truthy_opt(field(Some(&turn.selection), "cliSwitch")) {
            put(
                &mut event,
                "cli",
                match field(candidate, "cli") {
                    Some(value) if truthy(value) => value.clone(),
                    _ => Value::String(turn.cli.clone()),
                },
            );
        }
        if turn.price_tiered {
            if let Some(price) = field(candidate, "price").filter(|price| truthy(price)) {
                put(
                    &mut event,
                    "price",
                    field(Some(price), "blended")
                        .cloned()
                        .unwrap_or(Value::Null),
                );
                put(
                    &mut event,
                    "priceSource",
                    or_null(field(Some(price), "source")),
                );
            }
        }
        for (key, value) in details {
            event.insert((*key).to_string(), value.clone());
        }
        let event = object(event);
        self.current.insert(turn.session_id.clone(), event.clone());
        effects.push(emit_effect(&turn.session_id, event.clone()));
        let fields = record(vec![
            ("sessionId", Value::String(turn.session_id.clone())),
            ("turnId", turn.turn_id.clone()),
            ("phase", Value::String(phase.to_string())),
            (
                "providerId",
                field(Some(&event), "providerId")
                    .cloned()
                    .unwrap_or(Value::Null),
            ),
            (
                "fromProviderId",
                or_null(field(Some(&event), "fromProviderId")),
            ),
            (
                "trustDomain",
                field(Some(&event), "trustDomain")
                    .cloned()
                    .unwrap_or(Value::Null),
            ),
            (
                "fromTrustDomain",
                field(Some(&event), "fromTrustDomain")
                    .cloned()
                    .unwrap_or(Value::Null),
            ),
            (
                "toTrustDomain",
                field(Some(&event), "toTrustDomain")
                    .cloned()
                    .unwrap_or(Value::Null),
            ),
            ("reasonCode", or_null(field(Some(&event), "reasonCode"))),
            ("attemptNo", Value::from(turn.physical_attempt)),
        ]);
        effects.push(info_effect("auto_provider_route", fields));
    }
}

/// `value[key]` where `value` is an object; a non-object has no properties.
fn member<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value
        .and_then(Value::as_object)
        .and_then(|map| map.get(key))
}

fn is_text(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value::String(text)) if text == expected)
}

fn number_or_nan(value: Option<&Value>) -> f64 {
    value.map(js_to_number).unwrap_or(f64::NAN)
}

/// `later(at)`: only a finite time in the future can unblock the pool, and the
/// earliest one wins.
fn later(earliest: &mut Option<f64>, at: Option<&Value>, now: f64) {
    let value = number_or_nan(at);
    if !value.is_finite() || value <= now {
        return;
    }
    if earliest.is_none_or(|current| value < current) {
        *earliest = Some(value);
    }
}

/// `retryNotBefore`: the earliest epoch-ms at which the pool could accept a
/// turn again, or `None` when some local line is usable now / no reset is known.
///
/// Only the session's own lane counts. Two limits are read from each line's
/// limit summary, mirroring the `limit_state` unblock fields: a rejected park
/// (`blockedUntilMs`) and a full window (`usedPercent >= 100` with `resetMs`,
/// or `usedPercentage >= 100` with `resetsAtMs`). A revoked credential has no
/// self-recovery time and contributes nothing.
///
/// `candidates` rows are `{ cli, enabled, limitState, summary }`; `summary` is
/// the limit-cache entry's own summary, or `null` when none is known.
pub fn retry_not_before(candidates: &[Value], cli: &str, now: f64) -> Option<f64> {
    let local: Vec<&Value> = candidates
        .iter()
        .filter(|candidate| {
            is_text(member(Some(candidate), "cli"), cli)
                && member(Some(candidate), "enabled") != Some(&Value::Bool(false))
        })
        .collect();
    if local.is_empty() {
        return None;
    }
    // An exhausted candidate is not a whole-pool outage: another line can run.
    if local
        .iter()
        .any(|candidate| !is_text(member(Some(candidate), "limitState"), "exhausted"))
    {
        return None;
    }
    let mut earliest: Option<f64> = None;
    for candidate in local {
        let Some(summary) = member(Some(candidate), "summary").filter(|value| value.is_object())
        else {
            continue;
        };
        if member(Some(summary), "revoked") == Some(&Value::Bool(true)) {
            continue;
        }
        if is_text(member(Some(summary), "kind"), "availability")
            && is_text(member(Some(summary), "status"), "rejected")
        {
            later(&mut earliest, member(Some(summary), "blockedUntilMs"), now);
        }
        if let Some(Value::Array(windows)) = member(Some(summary), "windows") {
            for window in windows {
                if !truthy(window) {
                    continue;
                }
                if number_or_nan(member(Some(window), "usedPercent")) < 100.0 {
                    continue;
                }
                later(&mut earliest, member(Some(window), "resetMs"), now);
            }
        }
        if number_or_nan(member(Some(summary), "usedPercentage")) >= 100.0 {
            later(&mut earliest, member(Some(summary), "resetsAtMs"), now);
        }
    }
    earliest
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(cli: &str, limit_state: &str, summary: Value) -> Value {
        json!({ "cli": cli, "limitState": limit_state, "summary": summary })
    }

    #[test]
    fn an_usable_local_line_means_no_wait() {
        let rows = vec![
            row(
                "claude",
                "exhausted",
                json!({ "usedPercentage": 100, "resetsAtMs": 9_000 }),
            ),
            row("claude", "ok", Value::Null),
            row(
                "codex",
                "exhausted",
                json!({ "usedPercentage": 100, "resetsAtMs": 4_000 }),
            ),
        ];
        assert_eq!(retry_not_before(&rows, "claude", 1_000.0), None);
    }

    #[test]
    fn only_the_sessions_own_lane_counts() {
        let rows = vec![
            row(
                "codex",
                "exhausted",
                json!({ "usedPercentage": 100, "resetsAtMs": 4_000 }),
            ),
            row("claude", "ok", Value::Null),
        ];
        // The local lane is usable, so the codex reset is irrelevant.
        assert_eq!(retry_not_before(&rows, "claude", 1_000.0), None);
        // With no local line at all there is nothing to wait for either.
        assert_eq!(retry_not_before(&rows, "zcode", 1_000.0), None);
        assert_eq!(retry_not_before(&[], "claude", 1_000.0), None);
    }

    #[test]
    fn disabled_lines_are_not_part_of_the_pool() {
        let rows = vec![json!({
            "cli": "claude", "enabled": false, "limitState": "exhausted",
            "summary": { "usedPercentage": 100, "resetsAtMs": 4_000 },
        })];
        assert_eq!(retry_not_before(&rows, "claude", 1_000.0), None);
    }

    #[test]
    fn every_exhausted_local_line_contributes_its_earliest_recovery() {
        let rows = vec![
            row(
                "claude",
                "exhausted",
                json!({
                    "kind": "availability", "status": "rejected", "blockedUntilMs": 3_000,
                }),
            ),
            row(
                "claude",
                "exhausted",
                json!({
                    "windows": [
                        { "usedPercent": 100, "resetMs": 2_000 },
                        { "usedPercent": 40, "resetMs": 500 },
                    ],
                    "usedPercentage": 100,
                    "resetsAtMs": 5_000,
                }),
            ),
        ];
        assert_eq!(retry_not_before(&rows, "claude", 1_000.0), Some(2_000.0));
    }

    #[test]
    fn revoked_and_past_and_unknown_resets_contribute_nothing() {
        let revoked = vec![row(
            "claude",
            "exhausted",
            json!({ "revoked": true, "windows": [{ "usedPercent": 100, "resetMs": 9_000 }] }),
        )];
        assert_eq!(retry_not_before(&revoked, "claude", 1_000.0), None);

        let past = vec![row(
            "claude",
            "exhausted",
            json!({ "windows": [{ "usedPercent": 100, "resetMs": 900 }] }),
        )];
        assert_eq!(retry_not_before(&past, "claude", 1_000.0), None);

        let unknown = vec![
            row("claude", "exhausted", Value::Null),
            row("claude", "exhausted", json!({})),
        ];
        assert_eq!(retry_not_before(&unknown, "claude", 1_000.0), None);
    }

    #[test]
    fn a_partial_window_is_judged_by_used_percent_alone() {
        let rows = vec![row(
            "claude",
            "exhausted",
            json!({
                "kind": "availability", "status": "ok", "blockedUntilMs": 3_000,
                "windows": [{ "usedPercent": 99.9, "resetMs": 2_000 }],
                "usedPercentage": 99,
                "resetsAtMs": 4_000,
            }),
        )];
        // Under 100 is not a full window, and no other field unblocks the pool.
        assert_eq!(retry_not_before(&rows, "claude", 1_000.0), None);

        // A missing `usedPercent` is NaN, and `NaN < 100` is false, so the old
        // code fell through to the reset time and the reset counted. Recorded
        // as-is: the port must not "fix" this.
        let rows = vec![row(
            "claude",
            "exhausted",
            json!({ "windows": [{ "resetMs": 2_500 }] }),
        )];
        assert_eq!(retry_not_before(&rows, "claude", 1_000.0), Some(2_500.0));
    }

    #[test]
    fn a_truthy_non_object_window_is_skipped_but_does_not_stop_the_scan() {
        let rows = vec![row(
            "claude",
            "exhausted",
            json!({ "windows": [null, 5, { "usedPercent": 100, "resetMs": 2_000 }] }),
        )];
        assert_eq!(retry_not_before(&rows, "claude", 1_000.0), Some(2_000.0));
    }

    // ── the route state machine ────────────────────────────────────────────

    /// A normalized candidate as `catalogCandidates` would hand it over.
    fn line(id: &str, cli: &str, priority: i64, limit_state: &str) -> Value {
        json!({
            "providerId": id,
            "providerName": id,
            "cli": cli,
            "model": format!("{id}-model"),
            "protocol": "anthropic",
            "trustDomain": "official",
            "priority": priority,
            "index": 0,
            "enabled": true,
            "limitState": limit_state,
            "limitReason": null,
            "usedPercent": null,
            "tier": null,
        })
    }

    fn selection(candidates: Value, sticky: bool, cli_switch: Option<&str>) -> Value {
        let mut value = json!({
            "version": 1,
            "mode": "auto",
            "protocol": "anthropic",
            "candidates": candidates,
            "maxAttempts": 2,
            "sticky": sticky,
            "preferMaxQuota": true,
            "allowCrossTrust": false,
        });
        if let Some(kind) = cli_switch {
            value["cliSwitch"] = json!(kind);
        }
        value
    }

    fn quota_decision() -> Value {
        json!({
            "action": "wait_reset",
            "reason": "quota_reset_required",
            "delayMs": 60_000,
            "error": {
                "category": "billing_quota",
                "phase": "before_first_token",
                "partialOutput": false,
                "sideEffects": false,
            },
        })
    }

    fn open_attempt(provider_id: &str) -> Value {
        json!({
            "providerId": provider_id,
            "replayFence": "none",
            "visibleOutputObserved": false,
            "toolIntentObserved": false,
            "sideEffectObserved": false,
        })
    }

    #[test]
    fn sync_prepare_seeds_once_then_resets_on_a_changed_key() {
        let mut runtime = Runtime::default();
        let selection = selection(json!([line("a", "claude", 1, "ok")]), true, None);
        let request = json!({
            "sessionId": "s", "key": "k1", "cli": "claude",
            "selection": selection, "lastRoute": null, "lastRouteHasSelectionKey": false,
        });
        let step = runtime.sync_prepare(&request);
        assert_eq!(step["action"], json!("seed"));
        assert_eq!(step["want"], json!(true));
        // A cloned policy is the same pool.
        assert_eq!(runtime.sync_prepare(&request)["action"], json!("same"));

        runtime.sticky.insert("s".to_string(), "a".to_string());
        let mut changed = request.clone();
        changed["key"] = json!("k2");
        assert_eq!(runtime.sync_prepare(&changed)["action"], json!("seed"));
        assert!(
            !runtime.sticky.contains_key("s"),
            "a changed policy resets the route"
        );
    }

    #[test]
    fn sync_finish_seed_sticks_the_remembered_line_and_narrates_it() {
        let mut runtime = Runtime::default();
        let selection = selection(json!([line("a", "claude", 1, "ok")]), true, None);
        let envelope = runtime.sync_finish_seed(&json!({
            "sessionId": "s", "cli": "claude", "selection": selection,
            "seed": { "cli": "claude", "providerId": "a", "succeededAt": 5 },
        }));
        assert_eq!(envelope["effects"][0]["kind"], json!("info"));
        assert_eq!(
            envelope["effects"][0]["name"],
            json!("auto_provider_pool_memory_seed")
        );
        assert_eq!(envelope["effects"][0]["fields"]["providerId"], json!("a"));
        assert_eq!(runtime.sticky.get("s"), Some(&"a".to_string()));

        // A line the pool cannot reach contributes nothing.
        let mut other = Runtime::default();
        let envelope = other.sync_finish_seed(&json!({
            "sessionId": "s", "cli": "claude", "selection": selection,
            "seed": { "cli": "codex", "providerId": "a" },
        }));
        assert_eq!(envelope["effects"], json!([]));
        assert!(!other.sticky.contains_key("s"));
    }

    #[test]
    fn sync_finish_legacy_requires_the_persisted_model_to_still_be_served() {
        let mut matched = Runtime::default();
        matched.sync_finish_legacy(&json!({
            "sessionId": "s", "found": true, "providerId": "a",
            "model": "a-model", "choices": [], "lastModel": "a-model",
        }));
        assert_eq!(matched.sticky.get("s"), Some(&"a".to_string()));

        let mut mismatched = Runtime::default();
        mismatched.sync_finish_legacy(&json!({
            "sessionId": "s", "found": true, "providerId": "a",
            "model": "a-model", "choices": [], "lastModel": "other-model",
        }));
        assert!(!mismatched.sticky.contains_key("s"));
    }

    #[test]
    fn plan_turn_reserves_another_lane_then_replays_the_same_plan() {
        let candidates = json!([
            line("a", "claude", 1, "exhausted"),
            line("b", "codex", 1, "ok"),
        ]);
        let selection = selection(candidates.clone(), true, Some("failover"));
        let request = json!({
            "sessionId": "s", "cli": "claude", "selection": selection,
            "candidates": candidates, "ladder": null, "byPrice": false,
            "priceTiered": false, "routingDecision": null,
            "originContinue": false, "directUserInput": false,
            "availability": { "codex": true },
        });
        let mut runtime = Runtime::default();
        let envelope = runtime.plan_turn(&request);
        assert_eq!(envelope["value"]["cli"], json!("codex"));
        assert_eq!(envelope["value"]["reasonCode"], json!("auto_cli_failover"));
        assert_eq!(envelope["effects"][0]["kind"], json!("emit"));
        assert_eq!(
            envelope["effects"][0]["event"]["routePhase"],
            json!("cli_switch_planned")
        );
        assert_eq!(
            envelope["effects"][1]["name"],
            json!("auto_provider_cli_switch_planned")
        );
        assert_eq!(runtime.hops.get("s"), Some(&1));
        assert!(runtime.pending.contains_key("s"));

        // The reservation survives; asking again replays it and burns another hop.
        let again = runtime.plan_turn(&request);
        assert_eq!(again["value"]["cli"], json!("codex"));
        assert_eq!(runtime.hops.get("s"), Some(&2));
    }

    #[test]
    fn begin_turn_selects_fails_over_and_records_success() {
        let candidates = json!([line("a", "claude", 1, "ok"), line("b", "claude", 2, "ok"),]);
        let selection = selection(candidates.clone(), true, None);
        let mut runtime = Runtime::default();
        let begun = runtime.begin_turn(&json!({
            "sessionId": "s", "turnId": "t1", "cli": "claude", "selection": selection,
            "candidates": candidates, "ladder": null, "byPrice": false,
            "priceTiered": false, "routingDecision": null,
        }));
        let handle = begun["value"]["handle"].as_u64().expect("handle");

        let initial = runtime.turn_initial(handle);
        assert_eq!(initial["value"]["providerId"], json!("a"));
        assert_eq!(
            initial["effects"][0]["event"]["routePhase"],
            json!("selected")
        );

        let failed = runtime.turn_failover(&json!({
            "handle": handle, "decision": quota_decision(), "attempt": open_attempt("a"),
            "now": 1_000.0, "backgroundActive": false,
        }));
        assert_eq!(
            failed["value"]["invocationOptions"]["providerId"],
            json!("b")
        );
        assert_eq!(failed["value"]["decision"]["action"], json!("retry"));
        assert_eq!(
            failed["value"]["decision"]["providerFailover"]["fromProviderId"],
            json!("a")
        );

        let succeeded = runtime.turn_record_success(&json!({
            "handle": handle, "attempt": { "providerId": "b" },
        }));
        assert_eq!(succeeded["undefined"], json!(true));
        assert_eq!(runtime.sticky.get("s"), Some(&"b".to_string()));
        assert_eq!(runtime.snapshot("s")["routePhase"], json!("succeeded"));

        runtime.clear_session("s");
        assert_eq!(runtime.snapshot("s"), Value::Null);
        assert!(!runtime.turn_initial(handle)["error"].is_null());
    }
}
