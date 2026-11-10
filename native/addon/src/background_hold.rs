//! napi owner of the background hold.
//!
//! `src/chat/background-hold.js` only forwards arguments, supplies the host
//! facts (`isMainResult`, `hasBackground`), arms one unref'd timer and logs.
//! Every decision — what is held, when the turn may be released, which
//! self-wake decides the outcome, which injected messages are still unanswered,
//! which delivery identity was already written, and whether a typed message may
//! be delivered INTO the held turn — lives in `multicc_core::background_hold`.
use multicc_core::background_hold::{self as kernel, Hold, InjectFacts, InjectionRegistration};
use multicc_core::js::coerce::{js_to_number, truthy};
use multicc_core::js::serde::{from_serde, to_serde};
use multicc_core::js::JsValue as V;
use napi::{
    bindgen_prelude::{JsValue as _, Unknown},
    sys, Env, Result,
};
use napi_derive::napi;
use std::cell::RefCell;

fn read(env: Env, value: Unknown<'_>) -> Result<V> {
    unsafe { crate::js_bridge::read_value(env.raw(), value.raw(), 0, &mut Vec::new()) }
}

fn write(env: Env, value: &V) -> Result<sys::napi_value> {
    unsafe { crate::js_bridge::write_value(env.raw(), value) }
}

fn field<'a>(value: &'a V, name: &str) -> Option<&'a V> {
    value.get(name)
}

fn bool_field(value: &V, name: &str) -> bool {
    field(value, name).is_some_and(truthy)
}

fn string_field(value: &V, name: &str) -> Option<String> {
    match field(value, name) {
        Some(V::String(text)) => Some(text.to_string_lossy()),
        _ => None,
    }
}

/// A JS `String(value)`-free read: only a real string counts, mirroring the
/// legacy `typeof === 'string'` checks.
fn text_of(value: Option<&V>) -> Option<String> {
    match value {
        Some(V::String(text)) => Some(text.to_string_lossy()),
        _ => None,
    }
}

/// A core release plan as the JavaScript object the old code returned:
/// `{ ...held, <overrides> }`, with `undefined_keys` materialized as real
/// `undefined` properties so the shape is byte-identical to the legacy merge.
fn release_value(release: &kernel::Release) -> V {
    let mut entries = match from_serde(&release.event) {
        V::Object(entries) => entries,
        other => vec![(
            multicc_core::js::string::JsString::from_rust_str("value"),
            other,
        )],
    };
    for key in &release.undefined_keys {
        let key = multicc_core::js::string::JsString::from_rust_str(key);
        if !entries.iter().any(|(name, _)| name == &key) {
            entries.push((key, V::Undefined));
        }
    }
    V::Object(entries)
}

fn release_or_null(release: Option<kernel::Release>) -> V {
    match release {
        Some(release) => release_value(&release),
        None => V::Null,
    }
}

fn entry(name: &str, value: V) -> (multicc_core::js::string::JsString, V) {
    (
        multicc_core::js::string::JsString::from_rust_str(name),
        value,
    )
}

#[napi]
pub struct RustBackgroundHold {
    state: RefCell<Hold>,
}

#[napi]
impl RustBackgroundHold {
    #[napi(constructor)]
    pub fn new(env: Env, options: Unknown<'_>) -> Result<Self> {
        let options = read(env, options)?;
        let quiet_ms = field(&options, "quietMs")
            .map(js_to_number)
            .filter(|value| value.is_finite())
            .unwrap_or(kernel::QUIET_MS);
        let max_ms = field(&options, "maxMs")
            .map(js_to_number)
            .unwrap_or(kernel::DEFAULT_MAX_MS);
        Ok(Self {
            state: RefCell::new(Hold::new(quiet_ms, max_ms)),
        })
    }

    #[napi(getter)]
    pub fn held(&self) -> bool {
        self.state.borrow().is_held()
    }

    /// Outstanding injected messages (uuid-keyed, not a result counter).
    #[napi(getter)]
    pub fn injections(&self) -> u32 {
        self.state.borrow().injections()
    }

    #[napi(getter)]
    pub fn max_ms(&self) -> f64 {
        self.state.borrow().max_ms()
    }

    /// `start(event, { mainResult, backgroundActive })`.
    #[napi]
    pub fn start(&self, env: Env, event: Unknown<'_>, facts: Unknown<'_>) -> Result<bool> {
        let event = to_serde(&read(env, event)?);
        let facts = read(env, facts)?;
        Ok(self.state.borrow_mut().start(
            &event,
            bool_field(&facts, "mainResult"),
            bool_field(&facts, "backgroundActive"),
        ))
    }

    #[napi]
    pub fn observe(&self, env: Env, event: Unknown<'_>) -> Result<bool> {
        let event = to_serde(&read(env, event)?);
        Ok(self.state.borrow_mut().observe(&event))
    }

    /// `tick({ now, backgroundActive })` → released event or null.
    #[napi]
    pub fn tick(&self, env: Env, facts: Unknown<'_>) -> Result<sys::napi_value> {
        let facts = read(env, facts)?;
        let now = field(&facts, "now").map(js_to_number).unwrap_or(0.0);
        let released = self
            .state
            .borrow_mut()
            .tick(now, bool_field(&facts, "backgroundActive"));
        let value = release_or_null(released);
        write(env, &value)
    }

    /// Release now (cancel / insert-now). Returns the released event or null.
    #[napi]
    pub fn flush(&self, env: Env) -> Result<sys::napi_value> {
        let value = release_or_null(self.state.borrow_mut().finish());
        write(env, &value)
    }

    /// Register a delivery identity BEFORE its line is written.
    /// `{ action: 'write' | 'append_only' | 'refuse', uuid, reason }`.
    #[napi]
    pub fn begin_injection(
        &self,
        env: Env,
        identity: String,
        uuid: String,
    ) -> Result<sys::napi_value> {
        let value = match self.state.borrow_mut().begin_injection(&identity, &uuid) {
            InjectionRegistration::Write { uuid } => V::Object(vec![
                entry("action", V::string("write")),
                entry("uuid", V::string(&uuid)),
            ]),
            InjectionRegistration::AppendOnly { uuid } => V::Object(vec![
                entry("action", V::string("append_only")),
                entry("uuid", V::string(&uuid)),
            ]),
            InjectionRegistration::Refuse { reason } => V::Object(vec![
                entry("action", V::string("refuse")),
                entry("reason", V::string(reason)),
            ]),
        };
        write(env, &value)
    }

    /// The stdin write failed: release the identity so a retry may write it.
    #[napi]
    pub fn abort_injection(&self, identity: String) {
        self.state.borrow_mut().abort_injection(&identity);
    }

    /// True exactly once when the cap timer first fires on a held turn. Release
    /// does not follow from it; it only unlocks the host's visible notice.
    #[napi]
    pub fn cap_reached(&self, background_active: bool) -> bool {
        self.state.borrow_mut().cap_reached(background_active)
    }

    #[napi]
    pub fn dispose(&self) {
        self.state.borrow_mut().dispose();
    }
}

/// `holdMaxMs(env)` — `MULTICC_BACKGROUND_HOLD_MAX_MS` parsing.
#[napi]
pub fn background_hold_max_ms(env: Env, value: Unknown<'_>) -> Result<f64> {
    let value = read(env, value)?;
    Ok(match value {
        V::Undefined => kernel::hold_max_ms(None),
        other => kernel::hold_max_ms(Some(&to_serde(&other))),
    })
}

/// The pure delivery predicate. `held` / `turnActive` are facts too so the host
/// never has to re-tell the state machine what it already knows.
#[napi]
pub fn background_hold_may_inject(env: Env, facts: Unknown<'_>) -> Result<sys::napi_value> {
    let facts = read(env, facts)?;
    let decision = kernel::may_inject(&InjectFacts {
        held: bool_field(&facts, "held"),
        user_typed: bool_field(&facts, "userTyped"),
        attributable: bool_field(&facts, "attributable"),
        turn_active: bool_field(&facts, "turnActive"),
        process_alive: bool_field(&facts, "processAlive"),
        process_stale: bool_field(&facts, "processStale"),
        process_contract: string_field(&facts, "processContract"),
        wanted_contract: string_field(&facts, "wantedContract"),
        delivery_settled: bool_field(&facts, "deliverySettled"),
    });
    let value = V::Object(vec![
        entry("inject", V::Bool(decision.inject)),
        entry("reason", V::string(decision.reason)),
    ]);
    write(env, &value)
}

/// "A human typed this in the chat box" — the rule lives in Rust; the host
/// objects are read here and never copied back.
#[napi]
pub fn background_hold_user_typed(env: Env, item: Unknown<'_>, opts: Unknown<'_>) -> Result<bool> {
    let item = read(env, item)?;
    let opts = read(env, opts)?;
    let empty = V::Object(Vec::new());
    let payload = match field(&item, "payload") {
        Some(payload @ V::Object(_)) => payload,
        _ => &empty,
    };
    let facts = kernel::TypedFacts {
        payload_type: text_of(field(payload, "type")),
        source: text_of(field(payload, "source")),
        origin_continue: bool_field(&opts, "originContinue"),
        origin_dispatch_id: field(&opts, "originDispatchId").is_some_and(truthy),
        payload_origin_dispatch_id: field(payload, "originDispatchId").is_some_and(truthy),
        request_id: field(payload, "requestId").is_some_and(truthy),
        user_input_request_id: field(&opts, "userInputRequestId").is_some_and(truthy),
    };
    Ok(kernel::is_direct_user_typed(&facts))
}

/// The one staleness comparison shared by the stream pump and the injectable
/// predicate: `{ routeChanged, configChanged, vaultStale, stale }`.
#[napi]
pub fn background_hold_process_stale(
    env: Env,
    running: Unknown<'_>,
    wanted: Unknown<'_>,
) -> Result<sys::napi_value> {
    let running = read(env, running)?;
    let wanted = read(env, wanted)?;
    let on = |value: &V, name: &str| text_of(field(value, name));
    let staleness = kernel::process_stale(
        &kernel::ProcessFacts {
            route_url: on(&running, "routeUrl"),
            route_token: on(&running, "routeToken"),
            fingerprint: on(&running, "fingerprint"),
            vault_digest: on(&running, "vaultDigest"),
        },
        &kernel::ProcessFacts {
            route_url: on(&wanted, "routeUrl"),
            route_token: on(&wanted, "routeToken"),
            fingerprint: on(&wanted, "fingerprint"),
            vault_digest: on(&wanted, "vaultDigest"),
        },
    );
    let value = V::Object(vec![
        entry("routeChanged", V::Bool(staleness.route_changed)),
        entry("configChanged", V::Bool(staleness.config_changed)),
        entry("vaultStale", V::Bool(staleness.vault_stale)),
        entry("stale", V::Bool(staleness.stale())),
    ]);
    write(env, &value)
}

/// Stable digest of the facts that decide which process serves a turn.
#[napi]
pub fn background_hold_spawn_contract(env: Env, facts: Unknown<'_>) -> Result<String> {
    let facts = to_serde(&read(env, facts)?);
    Ok(kernel::spawn_contract(&facts))
}
