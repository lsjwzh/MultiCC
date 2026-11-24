//! Attempt creation is one native command. Live host values preserve getter,
//! conversion and callback ordering; no JSON round trip or mutable table borrow
//! crosses a host callback. The runner still consumes the same record identity.
use crate::{
    js_live::LiveValue,
    provider_attempt_identity::{
        integer, number, provider_error, required, timeout_budget, validate_attempt_transition,
    },
    provider_attempt_lifecycle::{
        RustCurrentAttempts, RustProviderAttemptGenerations, RustProviderAttemptLifecycle,
    },
    provider_attempt_route::{attempt_snapshot, emit_route},
    provider_producers::drain_stale_producers,
};
use multicc_core::{
    cli_capability::is_resident,
    js::JsValue,
    provider_attempt_lifecycle::{AttemptBudget, AttemptFence, AttemptIdentity, BeginPhase, Fence},
};
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
    sys, Env, Result,
};
use napi_derive::napi;

struct Admission<'a> {
    current: &'a RustCurrentAttempts,
    key: multicc_core::js::JsString,
    active: bool,
}
impl Admission<'_> {
    fn release(&mut self) {
        if self.active {
            self.active = false;
            self.current.end_key(&self.key);
        }
    }
}
impl Drop for Admission<'_> {
    fn drop(&mut self) {
        self.release();
    }
}

fn call_method<'a>(object: LiveValue<'a>, key: &std::ffi::CStr) -> Result<LiveValue<'a>> {
    object.get(key)?.call(object, &[])
}
fn text<'a>(anchor: LiveValue<'a>, text: &str) -> Result<LiveValue<'a>> {
    anchor.from_value(&JsValue::string(text))
}
fn next_id<'a>(
    port: LiveValue<'a>,
    prefix: &str,
    label: &str,
    error: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
    let injected = port.get(c"nextId")?;
    if injected.kind()? == sys::ValueType::napi_function {
        return required(injected.call_plain(&[text(port, prefix)?])?, label, error);
    }
    // No host override: the owner mints the capability itself, in the same
    // `<prefix>_<uuid>` shape the host's `crypto.randomUUID()` default made.
    let id = multicc_core::random_id::prefixed_id(prefix).map_err(|source| {
        napi::Error::from_reason(format!("secure random ID generation failed: {source}"))
    })?;
    text(port, &id)
}

#[napi]
pub fn provider_begin_attempt(
    env: Env,
    current: &RustCurrentAttempts,
    generations: &RustProviderAttemptGenerations,
    input: Unknown<'_>,
    port: Unknown<'_>,
) -> Result<sys::napi_value> {
    let input = LiveValue::new(&env, input);
    // Preserve the public JS property's TypeError, rather than N-API's
    // generic ToObject error. Undefined is defaulted by the host wrapper.
    if input.kind()? == sys::ValueType::napi_null {
        return Err(input.type_error("Cannot read properties of null (reading 'sessionId')"));
    }
    let port = LiveValue::new(&env, port);
    let error = port.get(c"ProviderAttemptError")?;
    let session = required(input.get(c"sessionId")?, "sessionId", error)?;
    let key = session.string()?.expect("required identity is a string");
    if !current.begin_key(key.clone()) {
        return Err(provider_error(
            error,
            "provider attempt is still running",
            "PROVIDER_ATTEMPT_IN_FLIGHT",
        )?);
    }
    let mut admission = Admission {
        current,
        key,
        active: true,
    };
    let turn = required(input.get(c"turnId")?, "turnId", error)?;
    let cli = required(input.get(c"cli")?, "cli", error)?;
    let cli = cli.get(c"toLowerCase")?.call(cli, &[])?;
    let provider = required(input.get(c"providerId")?, "providerId", error)?;
    let name = input.get(c"providerName")?.clean_text()?;
    let name = if name.truthy()? { name } else { provider };
    let protocol = required(input.get(c"protocol")?, "protocol", error)?;
    let model = input.get(c"model")?.clean_text()?;
    let revision = required(input.get(c"providerRevision")?, "providerRevision", error)?;
    let sub = input.get(c"subagentProviderId")?.clean_text()?;
    if sub.truthy()? {
        required(sub, "subagentProviderId", error)?;
    }
    let attempt_no = integer(input.get(c"attemptNo")?, "attemptNo", error)?;
    let continuation = input.get(c"continuation")?.is_true()?;
    // These native methods perform only short table operations. Their N-API
    // handles preserve old record identity when emit replaces the current one.
    let previous = LiveValue::from_raw(env.raw(), current.get_key(&env, &admission.key)?);
    let previous = if previous.truthy()? {
        previous
    } else {
        port.from_value(&JsValue::Null)?
    };
    let (fence, budget) = if previous.nullish()? {
        (
            port.from_value(&JsValue::Undefined)?,
            port.from_value(&JsValue::Undefined)?,
        )
    } else {
        (
            call_method(previous.get(c"lifecycle")?, c"snapshot")?,
            call_method(previous.get(c"lifecycle")?, c"budget")?,
        )
    };
    let producers = port.get(c"proxyProducers")?;
    let producer = producers.get(c"getActive")?.call(producers, &[session])?;
    drain_stale_producers(session, turn, producer, port)?;
    let facts = port.from_value(&JsValue::Object(vec![]))?;
    for (k, v) in [
        (c"turnId", turn),
        (
            c"continuation",
            port.from_value(&JsValue::Bool(continuation))?,
        ),
        (c"providerId", provider),
        (c"model", model),
        (c"protocol", protocol),
        (c"attemptNo", attempt_no),
    ] {
        facts.set(k, v)?;
    }
    validate_attempt_transition(previous, fence, facts, error)?;
    let generation = generations.next_key(admission.key.clone());
    let spawn_key = input.get(c"spawnKey")?.clean_text()?;
    // A warm child bakes this capability into its spawn contract. Only that
    // unchanged contract can reuse it; attempt identity still always advances.
    let resident = cli
        .string()?
        .is_some_and(|s| is_resident(&s.to_string_lossy()));
    let token = if resident
        && spawn_key.truthy()?
        && previous.truthy()?
        && previous.get(c"proxyRouteToken")?.truthy()?
        && previous.get(c"spawnKey")?.equals(spawn_key)?
    {
        previous.get(c"proxyRouteToken")?
    } else {
        next_id(port, "proxy-route", "proxyRouteToken", error)?
    };
    let decision = if previous.truthy()? && previous.get(c"turnId")?.equals(turn)? {
        previous.get(c"decisionId")?
    } else {
        next_id(port, "route-decision", "decisionId", error)?
    };
    let attempt = next_id(port, "route-attempt", "routeAttemptId", error)?;
    let epoch = port.get(c"runtimeEpoch")?;
    let record = port.from_value(&JsValue::Object(vec![]))?;
    for (k, v) in [
        (c"runtimeEpoch", epoch),
        (c"decisionId", decision),
        (c"routeAttemptId", attempt),
        (c"sessionId", session),
        (c"turnId", turn),
        (c"cli", cli),
        (c"providerId", provider),
        (c"providerName", name),
        (c"protocol", protocol),
        (c"model", model),
        (c"providerRevision", revision),
    ] {
        record.set(k, v)?;
    }
    for key in [c"effort", c"claudeWorkflow"] {
        let value = input.get(key)?;
        if !value.undefined()? {
            record.set(key, value)?;
        }
    }
    let allowed = port.from_value(&JsValue::Array(vec![]))?;
    allowed.set_element(0, provider)?;
    if sub.truthy()? && !sub.equals(provider)? {
        allowed.set_element(1, sub)?;
    }
    record.set(c"allowedSubProviderIds", allowed.freeze()?)?;
    record.set(c"attemptNo", attempt_no)?;
    record.set(
        c"routeGeneration",
        port.from_value(&JsValue::Number(generation))?,
    )?;
    record.set(c"proxyRouteToken", token)?;
    record.set(c"spawnKey", spawn_key)?;
    for k in [c"stallTimeoutMs", c"requestTimeoutMs", c"connectTimeoutMs"] {
        record.set(
            k,
            port.from_value(&JsValue::Number(timeout_budget(input.get(k)?)?))?,
        )?;
    }
    let level = if continuation && previous.truthy()? {
        Fence::parse(
            &fence
                .get(c"replayFence")?
                .coerce_string()?
                .to_string_lossy(),
        )
        .expect("native lifecycle returns a valid fence")
    } else {
        Fence::None
    };
    let visible = continuation && fence.optional(c"visibleOutputObserved")?.truthy()?;
    let tool = continuation && fence.optional(c"toolIntentObserved")?.truthy()?;
    let side_effect = continuation && fence.optional(c"sideEffectObserved")?.truthy()?;
    let deadline = if previous.optional(c"turnId")?.equals(turn)? {
        budget.get(c"requestDeadlineAt")?.number_value()?
    } else {
        None
    };
    let failures = if previous.optional(c"turnId")?.equals(turn)? {
        budget.get(c"requestFailures")?.number()?
    } else {
        0.0
    };
    let identity = AttemptIdentity::new(&JsValue::object(vec![
        ("runtimeEpoch", JsValue::String(epoch.string()?.unwrap())),
        (
            "routeAttemptId",
            JsValue::String(attempt.string()?.unwrap()),
        ),
        ("routeGeneration", JsValue::Number(generation)),
        ("turnId", JsValue::String(turn.string()?.unwrap())),
    ]));
    let lifecycle = RustProviderAttemptLifecycle::from_parts(
        AttemptFence::new(level, visible, tool, side_effect),
        AttemptBudget::new(deadline, failures),
        identity,
    );
    let lifecycle = unsafe { RustProviderAttemptLifecycle::to_napi_value(env.raw(), lifecycle) }?;
    record.set(c"lifecycle", LiveValue::from_raw(env.raw(), lifecycle))?;
    record.set(c"proxyFailure", port.from_value(&JsValue::Null)?)?;
    record.set(c"selectedAt", number(port.get(c"now")?.call_plain(&[])?)?)?;
    current.set_key(&env, admission.key.clone(), record.raw())?;
    // Finish/begin reentry from an event callback sees the installed record.
    admission.release();
    let switched = previous.truthy()?
        && previous.get(c"turnId")?.equals(turn)?
        && (!previous.get(c"providerId")?.equals(provider)?
            || !previous.get(c"model")?.equals(model)?);
    let extra = port.from_value(&JsValue::Object(vec![]))?;
    if switched {
        extra.set(c"fromProviderId", previous.get(c"providerId")?)?;
        extra.set(c"fromModel", previous.get(c"model")?)?;
    }
    let reason = input.get(c"reasonCode")?.clean_text()?;
    extra.set(
        c"reasonCode",
        if reason.truthy()? {
            reason
        } else {
            text(port, BeginPhase::default_reason_code(switched))?
        },
    )?;
    let phase = BeginPhase::select(continuation, switched).as_str();
    emit_route(port, record, phase, extra)?;
    Ok(attempt_snapshot(record)?.raw())
}
