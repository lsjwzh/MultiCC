//! Attempt snapshot assembly, route event dispatch and finish coordination in
//! one native owner. The frozen objects the wire has always seen are built
//! here: host reads happen in the historical getter/callback order, and each
//! result's key order is the literal order this file writes.
use crate::js_live::LiveValue;
use crate::provider_attempt_lifecycle::RustCurrentAttempts;
use multicc_core::js::JsValue;
use multicc_core::provider_attempt_lifecycle::FinishPhase;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

fn text<'a>(anchor: LiveValue<'a>, value: &str) -> Result<LiveValue<'a>> {
    anchor.from_value(&JsValue::string(value))
}
fn boolean<'a>(anchor: LiveValue<'a>, value: bool) -> Result<LiveValue<'a>> {
    anchor.from_value(&JsValue::Bool(value))
}
fn null<'a>(anchor: LiveValue<'a>) -> Result<LiveValue<'a>> {
    anchor.from_value(&JsValue::Null)
}
fn object<'a>(anchor: LiveValue<'a>) -> Result<LiveValue<'a>> {
    anchor.from_value(&JsValue::Object(vec![]))
}
fn method<'a>(object: LiveValue<'a>, name: &CStr, args: &[LiveValue<'a>]) -> Result<LiveValue<'a>> {
    object.get(name)?.call(object, args)
}
/// JavaScript `value && value.name`: false-like values are returned unchanged,
/// so callers perform the same subsequent String/Number conversion without
/// accessing a boxed primitive's prototype.
fn and_property<'a>(value: LiveValue<'a>, name: &CStr) -> Result<LiveValue<'a>> {
    if value.truthy()? {
        value.get(name)
    } else {
        Ok(value)
    }
}
/// `clean(value) || null`: the trimmed string when it is non-empty.
fn clean_or_null<'a>(value: LiveValue<'a>) -> Result<LiveValue<'a>> {
    let cleaned = value.clean_text()?;
    if cleaned.truthy()? {
        Ok(cleaned)
    } else {
        null(value)
    }
}
/// `Number(value) || null`: `0`, `-0` and `NaN` all read as null.
fn number_or_null<'a>(value: LiveValue<'a>) -> Result<LiveValue<'a>> {
    let number = value.explicit_number()?;
    if number == 0.0 || number.is_nan() {
        null(value)
    } else {
        value.from_value(&JsValue::Number(number))
    }
}
/// `record ? record.<name> : null`.
fn record_field_or_null<'a>(record: LiveValue<'a>, name: &CStr) -> Result<LiveValue<'a>> {
    if record.truthy()? {
        record.get(name)
    } else {
        null(record)
    }
}

/// The frozen attempt snapshot the runner, audit and quota paths consume.
/// `record.lifecycle` is read three times before the record's own fields,
/// exactly as the host's snapshot() did: a Proxy-wrapped record observes the
/// same gets and calls in the same order.
pub(crate) fn attempt_snapshot<'a>(record: LiveValue<'a>) -> Result<LiveValue<'a>> {
    if !record.truthy()? {
        return null(record);
    }
    let fence = method(record.get(c"lifecycle")?, c"snapshot", &[])?;
    let budget = method(record.get(c"lifecycle")?, c"budget", &[])?;
    let status = method(record.get(c"lifecycle")?, c"status", &[])?;
    let snapshot = object(record)?;
    for key in [
        c"runtimeEpoch",
        c"decisionId",
        c"routeAttemptId",
        c"sessionId",
        c"turnId",
        c"cli",
        c"providerId",
        c"providerName",
        c"protocol",
        c"model",
        c"providerRevision",
        c"attemptNo",
        c"routeGeneration",
        c"stallTimeoutMs",
        c"requestTimeoutMs",
        c"connectTimeoutMs",
    ] {
        snapshot.set(key, record.get(key)?)?;
    }
    let deadline = budget.get(c"requestDeadlineAt")?;
    snapshot.set(
        c"requestDeadlineAt",
        if deadline.nullish()? {
            null(record)?
        } else {
            deadline
        },
    )?;
    snapshot.set(c"requestFailures", budget.get(c"requestFailures")?)?;
    snapshot.set(c"stalled", budget.get(c"stalled")?)?;
    let replay = fence.get(c"replayFence")?;
    snapshot.set(c"replayFence", replay)?;
    snapshot.set(
        c"visibleOutputObserved",
        fence.get(c"visibleOutputObserved")?,
    )?;
    snapshot.set(c"toolIntentObserved", fence.get(c"toolIntentObserved")?)?;
    snapshot.set(c"sideEffectObserved", fence.get(c"sideEffectObserved")?)?;
    snapshot.set(c"safeToReplay", boolean(record, replay.is_string("none")?)?)?;
    snapshot.set(c"outcome", status.get(c"outcome")?)?;
    let category = status.get(c"errorCategory")?;
    snapshot.set(
        c"errorCategory",
        if category.nullish()? {
            null(record)?
        } else {
            category
        },
    )?;
    snapshot.set(c"selectedAt", record.get(c"selectedAt")?)?;
    let finished = status.get(c"finishedAt")?;
    snapshot.set(
        c"finishedAt",
        if finished.nullish()? {
            null(record)?
        } else {
            finished
        },
    )?;
    snapshot.freeze()
}

/// The `provider_route_event` dispatch. A missing emit port or record is a
/// no-op, and a throwing subscriber is swallowed at the same boundary the
/// host wrapped in try/catch.
pub(crate) fn emit_route<'a>(
    port: LiveValue<'a>,
    record: LiveValue<'a>,
    phase: &str,
    extra: LiveValue<'a>,
) -> Result<()> {
    let emit = port.get(c"emit")?;
    if !emit.truthy()? || !record.truthy()? {
        return Ok(());
    }
    let fence = method(record.get(c"lifecycle")?, c"snapshot", &[])?;
    let event = object(record)?;
    event.set(c"type", text(record, "provider_route_event")?)?;
    event.set(c"version", record.from_value(&JsValue::Number(1.0))?)?;
    event.set(c"providerRouteScope", text(record, "attempt")?)?;
    event.set(c"runtimeEpoch", record.get(c"runtimeEpoch")?)?;
    event.set(c"routePhase", text(record, phase)?)?;
    for key in [
        c"sessionId",
        c"turnId",
        c"cli",
        c"decisionId",
        c"routeAttemptId",
        c"routeGeneration",
        c"attemptNo",
        c"providerId",
        c"providerName",
        c"protocol",
        c"model",
        c"providerRevision",
    ] {
        event.set(key, record.get(key)?)?;
    }
    let replay = fence.get(c"replayFence")?;
    event.set(c"replayFence", replay)?;
    event.set(c"safeToReplay", boolean(record, replay.is_string("none")?)?)?;
    let ts = port.get(c"now")?.call_plain(&[])?.explicit_number()?;
    event.set(c"ts", record.from_value(&JsValue::Number(ts))?)?;
    event.spread_from(extra)?;
    event.freeze()?;
    // The session argument is read after the event is complete, as the
    // host's `emit(record.sessionId, event)` argument evaluation did.
    let session = record.get(c"sessionId")?;
    let _ = port.catch(|| emit.call_plain(&[session, event]))?;
    Ok(())
}

#[napi]
pub fn provider_attempt_snapshot(env: Env, record: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(attempt_snapshot(LiveValue::new(&env, record))?.raw())
}

/// The capability/id mint the host used to default to `crypto.randomUUID()`
/// for. The owner that admits an attempt now names it, in the same
/// `<prefix>_<uuid>` shape; tests still inject their own `nextId`.
#[napi]
pub fn provider_mint_prefixed_id(prefix: String) -> Result<String> {
    multicc_core::random_id::prefixed_id(&prefix).map_err(|error| {
        napi::Error::from_reason(format!("secure random generation failed: {error}"))
    })
}

/// `finishAttempt(reference, facts)`: staleness audit, lifecycle finalization,
/// route event dispatch and stream redactor cleanup in one native command.
/// The returned `{ ok, code, attempt }` is frozen with the wire's key order.
#[napi]
pub fn provider_finish_attempt(
    env: Env,
    current: &RustCurrentAttempts,
    reference: Unknown<'_>,
    facts: Unknown<'_>,
    port: Unknown<'_>,
) -> Result<sys::napi_value> {
    let reference = LiveValue::new(&env, reference);
    let facts = LiveValue::new(&env, facts);
    let port = LiveValue::new(&env, port);
    let session = and_property(reference, c"sessionId")?.clean_text()?;
    let key = session.string()?.expect("clean text is a string");
    let record = LiveValue::from_raw(env.raw(), current.get_key(&env, &key)?);
    let same = record.truthy()?
        && reference.truthy()?
        && method(record.get(c"lifecycle")?, c"matches", &[reference])?.truthy()?;
    if !same {
        let event = object(port)?;
        event.set(c"type", text(port, "provider_attempt_late_ignored")?)?;
        event.set(c"operation", text(port, "finish")?)?;
        event.set(
            c"runtimeEpoch",
            clean_or_null(and_property(reference, c"runtimeEpoch")?)?,
        )?;
        event.set(
            c"turnId",
            clean_or_null(and_property(reference, c"turnId")?)?,
        )?;
        event.set(
            c"routeAttemptId",
            clean_or_null(and_property(reference, c"routeAttemptId")?)?,
        )?;
        event.set(
            c"routeGeneration",
            number_or_null(and_property(reference, c"routeGeneration")?)?,
        )?;
        event.set(
            c"currentRouteAttemptId",
            record_field_or_null(record, c"routeAttemptId")?,
        )?;
        event.set(
            c"currentRouteGeneration",
            record_field_or_null(record, c"routeGeneration")?,
        )?;
        port.get(c"auditOnly")?.call_plain(&[session, event])?;
        let result = object(port)?;
        result.set(c"ok", boolean(port, false)?)?;
        result.set(c"code", text(port, "stale_attempt")?)?;
        result.set(c"attempt", attempt_snapshot(record)?)?;
        return Ok(result.freeze()?.raw());
    }
    let running = method(record.get(c"lifecycle")?, c"running", &[])?.truthy()?;
    if !running {
        let event = object(port)?;
        event.set(c"type", text(port, "provider_attempt_late_ignored")?)?;
        event.set(c"operation", text(port, "finish")?)?;
        for key in [
            c"runtimeEpoch",
            c"turnId",
            c"routeAttemptId",
            c"routeGeneration",
        ] {
            event.set(key, record.get(key)?)?;
        }
        event.set(c"currentRouteAttemptId", record.get(c"routeAttemptId")?)?;
        event.set(c"currentRouteGeneration", record.get(c"routeGeneration")?)?;
        port.get(c"auditOnly")?.call_plain(&[session, event])?;
        let result = object(port)?;
        result.set(c"ok", boolean(port, false)?)?;
        result.set(c"code", text(port, "attempt_not_running")?)?;
        result.set(c"attempt", attempt_snapshot(record)?)?;
        return Ok(result.freeze()?.raw());
    }
    // The host's TypeError for `finishAttempt(reference, null)`: facts is
    // only read once staleness and liveness are settled.
    if facts.kind()? == sys::ValueType::napi_null {
        return Err(facts.type_error("Cannot read properties of null (reading 'outcome')"));
    }
    let outcome = facts.optional(c"outcome")?.clean_text()?;
    let outcome = if outcome.truthy()? {
        outcome
    } else {
        text(port, "released")?
    };
    method(record.get(c"lifecycle")?, c"setOutcome", &[outcome])?;
    let category = clean_or_null(facts.optional(c"errorCategory")?)?;
    method(record.get(c"lifecycle")?, c"setErrorCategory", &[category])?;
    // JS resolves both the receiver and method before evaluating Number(now()).
    // The clock is an injected callback and can synchronously change the
    // prototype or reenter the runtime; call the originally resolved method.
    let lifecycle = record.get(c"lifecycle")?;
    let set_finished = lifecycle.get(c"setFinishedAt")?;
    let finished = port.get(c"now")?.call_plain(&[])?.explicit_number()?;
    set_finished.call(lifecycle, &[port.from_value(&JsValue::Number(finished))?])?;
    let extra = object(port)?;
    extra.set(c"errorCategory", category)?;
    extra.set(
        c"reasonCode",
        clean_or_null(facts.optional(c"reasonCode")?)?,
    )?;
    let outcome_text = outcome.string()?.expect("clean outcome is a string");
    let phase = FinishPhase::select(&outcome_text.to_string_lossy()).as_str();
    emit_route(port, record, phase, extra)?;
    let redactors = port.get(c"streamRedactors")?;
    let attempt = record.get(c"routeAttemptId")?;
    redactors.get(c"delete")?.call(redactors, &[attempt])?;
    let result = object(port)?;
    result.set(c"ok", boolean(port, true)?)?;
    result.set(c"code", null(port)?)?;
    result.set(c"attempt", attempt_snapshot(record)?)?;
    Ok(result.freeze()?.raw())
}
