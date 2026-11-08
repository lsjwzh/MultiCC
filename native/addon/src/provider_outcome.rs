//! Proxy usage attribution and proxy outcome coordination for the current
//! provider attempt (was `attributeProxyUsage`, `observeProxyOutcome` and
//! `proxyFailure` in src/chat/provider-attempt-runtime.js).
//!
//! The attempt record is still a host object: every read, method call and
//! assignment below happens on it in the order the JavaScript did, including
//! repeated reads, `now()` calls, object key order and freezing. A method is
//! looked up before its arguments are evaluated, as in a JS call expression.
//! Error codes are sanitized and 429 rejections normalized by
//! [`crate::api_error_text`] directly.
use crate::{
    api_error_text::{normalize_rejection, sanitize},
    cli_completion::{compatible, completed},
    js_live::LiveValue,
    provider_authorization::background_lingers,
    provider_producers::{bound, key},
};
use multicc_core::js::JsValue;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

type Entries<'a> = Vec<(&'static CStr, LiveValue<'a>)>;

fn text<'a>(anchor: LiveValue<'a>, value: &str) -> Result<LiveValue<'a>> {
    anchor.from_value(&JsValue::string(value))
}
fn null(anchor: LiveValue<'_>) -> Result<LiveValue<'_>> {
    anchor.from_value(&JsValue::Null)
}
fn boolean(anchor: LiveValue<'_>, value: bool) -> Result<LiveValue<'_>> {
    anchor.from_value(&JsValue::Bool(value))
}
fn number(anchor: LiveValue<'_>, value: f64) -> Result<LiveValue<'_>> {
    anchor.from_value(&JsValue::Number(value))
}
/// `value || null`.
fn or_null(value: LiveValue<'_>) -> Result<LiveValue<'_>> {
    if value.truthy()? {
        Ok(value)
    } else {
        null(value)
    }
}
/// `a || b`, evaluating `b` only when `a` is falsy.
fn or_else<'a>(
    value: LiveValue<'a>,
    other: impl FnOnce() -> Result<LiveValue<'a>>,
) -> Result<LiveValue<'a>> {
    if value.truthy()? {
        Ok(value)
    } else {
        other()
    }
}
/// `object.name(...args)`: the method is read before the arguments run.
fn call<'a>(
    object: LiveValue<'a>,
    name: &CStr,
    arguments: impl FnOnce() -> Result<Vec<LiveValue<'a>>>,
) -> Result<LiveValue<'a>> {
    let function = object.get(name)?;
    let arguments = arguments()?;
    function.call(object, &arguments)
}
fn lifecycle<'a>(
    record: LiveValue<'a>,
    name: &CStr,
    arguments: impl FnOnce() -> Result<Vec<LiveValue<'a>>>,
) -> Result<LiveValue<'a>> {
    call(record.get(c"lifecycle")?, name, arguments)
}
fn running(record: LiveValue<'_>) -> Result<bool> {
    lifecycle(record, c"running", || Ok(vec![]))?.truthy()
}
/// `sameAttempt(record, reference)`.
fn same_attempt<'a>(record: LiveValue<'a>, reference: LiveValue<'a>) -> Result<bool> {
    Ok(record.truthy()?
        && reference.truthy()?
        && lifecycle(record, c"matches", || Ok(vec![reference]))?.truthy()?)
}
fn lower(value: LiveValue<'_>) -> Result<LiveValue<'_>> {
    let value = value.clean_text()?;
    call(value, c"toLowerCase", || Ok(vec![]))
}
/// `Number(now())`.
fn now(port: LiveValue<'_>) -> Result<f64> {
    port.get(c"now")?.call_plain(&[])?.explicit_number()
}
fn object<'a>(anchor: LiveValue<'a>, entries: Entries<'a>) -> Result<LiveValue<'a>> {
    let object = anchor.from_value(&JsValue::Object(vec![]))?;
    for (name, value) in entries {
        object.set(name, value)?;
    }
    Ok(object)
}
fn frozen<'a>(anchor: LiveValue<'a>, entries: Entries<'a>) -> Result<LiveValue<'a>> {
    object(anchor, entries)?.freeze()
}
fn audit<'a>(port: LiveValue<'a>, session: LiveValue<'a>, entries: Entries<'a>) -> Result<()> {
    let event = object(port, entries)?;
    port.get(c"auditOnly")?.call_plain(&[session, event])?;
    Ok(())
}
fn current<'a>(port: LiveValue<'a>, session: LiveValue<'a>) -> Result<LiveValue<'a>> {
    call(port.get(c"currentBySession")?, c"get", || Ok(vec![session]))
}
/// `boundProxyAttempt(event)`: a fresh `proxyContext(event)` each time.
fn bound_attempt<'a>(event: LiveValue<'a>, port: LiveValue<'a>) -> Result<LiveValue<'a>> {
    let context = port.get(c"proxyContext")?.call_plain(&[event])?;
    bound(event, context, port)
}
/// `snapshotSession(sessionId)?.[name] || null`.
fn current_field<'a>(
    port: LiveValue<'a>,
    session: LiveValue<'a>,
    name: &CStr,
) -> Result<LiveValue<'a>> {
    let record = current(port, session.clean_text()?)?;
    let snapshot = port.get(c"snapshot")?.call_plain(&[record])?;
    or_null(snapshot.optional(name)?)
}

/// `reattributedUsage(event, facts)`: `{ ...event }` without a derived
/// `uo_<32 hex>` event id, then the facts, frozen. The facts were evaluated
/// by the caller, before the spread, as the JS argument list was.
///
/// ProviderRouterPort has already normalized CPR input once. Its derived
/// `uo_*` id hashes the encoded process capability; changing that session to
/// the real one requires downstream validation to derive a fresh id from
/// `sourceEventId`.
fn reattributed<'a>(
    event: LiveValue<'a>,
    facts: Entries<'a>,
    port: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
    let usage = port.from_value(&JsValue::Object(vec![]))?;
    usage.spread_from(event)?;
    let id = usage.get(c"eventId")?.clean_text()?.string()?;
    let derived = id.is_some_and(|id| {
        let id = id.to_string_lossy();
        id.len() == 35
            && id.starts_with("uo_")
            && id[3..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    });
    if derived {
        usage.delete(c"eventId")?;
    }
    for (name, value) in facts {
        usage.set(name, value)?;
    }
    usage.freeze()
}

#[napi]
pub fn provider_attribute_proxy_usage(
    env: Env,
    event: Unknown<'_>,
    port: Unknown<'_>,
) -> Result<sys::napi_value> {
    let event = LiveValue::new(&env, event);
    let port = LiveValue::new(&env, port);
    let context = port.get(c"proxyContext")?.call_plain(&[event])?;
    let session = context.get(c"sessionId")?;
    let mut role = lower(or_else(event.get(c"role")?, || event.get(c"roleKind"))?)?;
    if role.is_string("main")?
        && context.get(c"exact")?.truthy()?
        && background_lingers(context.get(c"record")?)?
        && !bound_attempt(event, port)?.truthy()?
        && !call(port.get(c"proxyProducers")?, c"hasEnded", || {
            Ok(vec![session])
        })?
        .truthy()?
    {
        role = text(port, "background")?;
    }
    // A non-main request on a warm process proves the session, never the turn:
    // its usage is session-level only, excluded from attempt attribution.
    if !role.is_string("main")? {
        let key = key(context, event, role)?;
        let bound = call(port.get(c"nonMainProxyProducers")?, c"bindUsage", || {
            Ok(vec![key])
        })?;
        let facts = vec![
            (c"sessionId", session),
            (c"routeAttribution", text(port, "ambiguous")?),
            (c"producerBound", bound),
        ];
        return Ok(reattributed(event, facts, port)?.raw());
    }
    let mut attempt = bound_attempt(event, port)?;
    if !attempt.truthy()? {
        let producers = port.get(c"proxyProducers")?;
        let ended = call(producers, c"getEnded", || Ok(vec![session]))?;
        let record = current(port, session)?;
        if ended.truthy()?
            && context
                .get(c"token")?
                .equals(ended.get(c"proxyRouteToken")?)?
            && same_attempt(record, ended.get(c"attempt")?)?
            && (!event.get(c"providerId")?.clean_text()?.truthy()?
                || event
                    .get(c"providerId")?
                    .clean_text()?
                    .equals(ended.get(c"attempt")?.get(c"providerId")?)?)
        {
            attempt = ended.get(c"attempt")?;
            call(producers, c"deleteEnded", || Ok(vec![session]))?;
        }
    }
    if !attempt.truthy()? {
        let entries = vec![
            (c"type", text(port, "provider_attempt_late_ignored")?),
            (c"operation", text(port, "proxy_usage")?),
            (c"runtimeEpoch", port.get(c"runtimeEpoch")?),
            (c"turnId", null(port)?),
            (c"routeAttemptId", null(port)?),
            (c"routeGeneration", null(port)?),
            (
                c"providerId",
                or_null(event.get(c"providerId")?.clean_text()?)?,
            ),
            (
                c"currentRouteAttemptId",
                current_field(port, session, c"routeAttemptId")?,
            ),
            (
                c"currentRouteGeneration",
                current_field(port, session, c"routeGeneration")?,
            ),
        ];
        audit(port, session, entries)?;
        let facts = vec![
            (c"sessionId", session),
            (c"routeAttribution", text(port, "ambiguous")?),
        ];
        return Ok(reattributed(event, facts, port)?.raw());
    }
    let mut facts = vec![(c"sessionId", session)];
    for name in [
        c"turnId",
        c"runtimeEpoch",
        c"decisionId",
        c"routeAttemptId",
        c"routeGeneration",
        c"attemptNo",
    ] {
        facts.push((name, attempt.get(name)?));
    }
    facts.push((c"routeAttribution", text(port, "exact")?));
    facts.push((c"providerRevision", attempt.get(c"providerRevision")?));
    Ok(reattributed(event, facts, port)?.raw())
}

/// The late/unbound audit fields copied from the reported tuple.
fn reported<'a>(event: LiveValue<'a>) -> Result<Entries<'a>> {
    Ok(vec![
        (
            c"runtimeEpoch",
            or_null(event.get(c"runtimeEpoch")?.clean_text()?)?,
        ),
        (c"turnId", or_null(event.get(c"turnId")?.clean_text()?)?),
        (
            c"routeAttemptId",
            or_null(event.get(c"routeAttemptId")?.clean_text()?)?,
        ),
        (
            c"routeGeneration",
            number_or_null_value(event.get(c"routeGeneration")?)?,
        ),
    ])
}
/// `Number(value) || null`.
fn number_or_null_value(value: LiveValue<'_>) -> Result<LiveValue<'_>> {
    let n = value.explicit_number()?;
    if n == 0.0 || n.is_nan() {
        null(value)
    } else {
        number(value, n)
    }
}
/// The current attempt's identity, for audits about it.
fn identity<'a>(record: LiveValue<'a>) -> Result<Entries<'a>> {
    let mut entries = Vec::new();
    for name in [
        c"runtimeEpoch",
        c"turnId",
        c"routeAttemptId",
        c"routeGeneration",
    ] {
        entries.push((name, record.get(name)?));
    }
    Ok(entries)
}
fn accepted<'a>(port: LiveValue<'a>, failure: LiveValue<'a>) -> Result<LiveValue<'a>> {
    frozen(
        port,
        vec![
            (c"accepted", boolean(port, true)?),
            (c"code", null(port)?),
            (c"failure", failure),
        ],
    )
}
/// `proxyOutcome?.termination === value`.
fn terminated(outcome: LiveValue<'_>, value: &str) -> Result<bool> {
    outcome.optional(c"termination")?.is_string(value)
}

/// The host reports each physical request independently of token accounting;
/// bind its purpose and terminal evidence to the admitted attempt so probes,
/// late responses and provider-rendered text cannot decide another turn.
#[napi]
pub fn provider_observe_proxy_outcome(
    env: Env,
    event: Unknown<'_>,
    port: Unknown<'_>,
) -> Result<sys::napi_value> {
    let event = LiveValue::new(&env, event);
    let port = LiveValue::new(&env, port);
    let session = event.get(c"sessionId")?.clean_text()?;
    let record = current(port, session)?;
    let role = or_else(event.get(c"roleKind")?, || {
        or_else(event.get(c"role")?, || text(port, "main"))
    })?;
    let role = lower(role)?;
    let unbound = 'check: {
        if !role.is_string("main")?
            || !event.get(c"routeAttribution")?.is_string("exact")?
            || !same_attempt(record, event)?
        {
            break 'check true;
        }
        let left = record.get(c"decisionId")?;
        if !left.equals(event.get(c"decisionId")?.clean_text()?)? {
            break 'check true;
        }
        let left = record.get(c"attemptNo")?;
        let right = event.get(c"attemptNo")?.explicit_number()?;
        if !left.equals(number(port, right)?)? {
            break 'check true;
        }
        for name in [c"providerId", c"providerRevision"] {
            let left = record.get(name)?;
            if !left.equals(event.get(name)?.clean_text()?)? {
                break 'check true;
            }
        }
        !running(record)?
    };
    if unbound {
        let mut entries = vec![
            (c"type", text(port, "provider_attempt_late_ignored")?),
            (c"operation", text(port, "proxy_outcome")?),
        ];
        entries.extend(reported(event)?);
        for (name, field) in [
            (c"currentRouteAttemptId", c"routeAttemptId"),
            (c"currentRouteGeneration", c"routeGeneration"),
        ] {
            let value = if record.truthy()? {
                record.get(field)?
            } else {
                null(port)?
            };
            entries.push((name, value));
        }
        audit(port, session, entries)?;
        let result = vec![
            (c"accepted", boolean(port, false)?),
            (c"code", text(port, "proxy_attempt_unbound")?),
        ];
        return Ok(frozen(port, result)?.raw());
    }
    let outcome = or_null(event.get(c"proxyOutcome")?)?;
    if outcome.truthy()? && !outcome.get(c"requestKind")?.is_string("inference")? {
        let result = vec![
            (c"accepted", boolean(port, true)?),
            (c"code", text(port, "non_inference_request")?),
            (c"failure", null(port)?),
        ];
        return Ok(frozen(port, result)?.raw());
    }
    if !lower(event.get(c"status")?)?.is_string("error")? {
        if terminated(outcome, "completed")? {
            lifecycle(record, c"completed", || Ok(vec![]))?;
        }
        // Recovery is diagnostic only: the final verdict rests on the whole
        // turn's completion evidence, and the original error stays recorded.
        if terminated(outcome, "completed")?
            && record.get(c"proxyFailure")?.truthy()?
            && !record.get(c"proxyFailure")?.get(c"recovered")?.is_true()?
        {
            let failure = port.from_value(&JsValue::Object(vec![]))?;
            failure.spread_from(record.get(c"proxyFailure")?)?;
            failure.set(c"recovered", boolean(port, true)?)?;
            failure.set(c"recoveredAt", number(port, now(port)?)?)?;
            record.assign(c"proxyFailure", failure.freeze()?)?;
            let mut entries = vec![
                (
                    c"type",
                    text(port, "provider_attempt_proxy_failure_recovered")?,
                ),
                (c"operation", text(port, "proxy_outcome")?),
            ];
            entries.extend(reported(event)?);
            entries.push((c"currentRouteAttemptId", record.get(c"routeAttemptId")?));
            entries.push((c"currentRouteGeneration", record.get(c"routeGeneration")?));
            audit(port, session, entries)?;
        }
        return Ok(accepted(port, null(port)?)?.raw());
    }
    let status = event.get(c"statusCode")?.explicit_number()?;
    let http_status =
        (status.fract() == 0.0 && (400.0..=599.0).contains(&status)).then_some(status);
    let http = match http_status {
        Some(status) => number(port, status)?,
        None => null(port)?,
    };
    // Every error enters the event log; later recovery, a newer error or a
    // switched attempt never erases that history.
    let mut entries = vec![
        (
            c"type",
            text(port, "provider_attempt_proxy_failure_observed")?,
        ),
        (c"operation", text(port, "proxy_outcome")?),
    ];
    entries.extend(identity(record)?);
    entries.push((c"providerId", record.get(c"providerId")?));
    entries.push((c"httpStatus", http));
    let code = or_else(event.get(c"errorCode")?.clean_text()?, || {
        text(port, "UPSTREAM_HTTP_ERROR")
    })?;
    let undefined = port.from_value(&JsValue::Undefined)?;
    entries.push((c"code", sanitize(code, undefined, undefined)?));
    entries.push((c"requestId", or_null(outcome.optional(c"requestId")?)?));
    entries.push((c"termination", or_null(outcome.optional(c"termination")?)?));
    audit(port, session, entries)?;
    // Socket teardown must not replace stronger upstream failure evidence.
    if http_status.is_none()
        && terminated(outcome, "downstream_disconnect")?
        && record.get(c"proxyFailure")?.truthy()?
    {
        return Ok(accepted(port, record.get(c"proxyFailure")?)?.raw());
    }
    // Only the shared request watchdog supplies a budget; unmanaged callers
    // keep their previous error policy.
    let budgeted = lifecycle(record, c"observeFailure", || {
        let deadline = event.get(c"requestDeadlineAt")?;
        let deadline = match deadline.number_value()? {
            Some(value) if value.is_finite() => event.get(c"requestDeadlineAt")?,
            _ => number(port, f64::NAN)?,
        };
        Ok(vec![
            deadline,
            boolean(port, terminated(outcome, "upstream_failure")?)?,
            number(port, http_status.unwrap_or(0.0))?,
        ])
    })?;
    if event.get(c"modelProgress")?.is_true()? {
        lifecycle(record, c"advance", || {
            Ok(vec![text(port, "visible_output")?])
        })?;
    }
    let failure_code = or_else(event.get(c"errorCode")?.clean_text()?, || {
        text(port, "UPSTREAM_HTTP_ERROR")
    })?;
    // 5xx/408/429 are transient errors the client retries itself; only real
    // hangs (watchdog silence) and the absolute deadline consume the budget.
    let exhausted = if !budgeted.truthy()? {
        budgeted
    } else {
        or_else(
            lifecycle(record, c"stallRetryExhausted", || Ok(vec![failure_code]))?,
            || {
                lifecycle(record, c"deadlineReached", || {
                    Ok(vec![number(port, now(port)?)?])
                })
            },
        )?
    };
    // A structured rejection only ever rides a 429 and is untrusted input.
    let rejection = if http_status == Some(429.0) {
        normalize_rejection(event.get(c"rejection")?)?
    } else {
        null(port)?
    };
    let failure = port.from_value(&JsValue::Object(vec![]))?;
    failure.set(c"source", text(port, "proxy_response")?)?;
    if budgeted.truthy()? {
        let budget = lifecycle(record, c"budget", || Ok(vec![]))?;
        failure.set(c"requestDeadlineAt", budget.get(c"requestDeadlineAt")?)?;
        failure.set(c"retryBudgetExhausted", exhausted)?;
    }
    if event.get(c"modelProgress")?.is_true()? {
        failure.set(c"partialOutput", boolean(port, true)?)?;
    }
    failure.set(c"provider", record.get(c"cli")?)?;
    failure.set(c"providerId", record.get(c"providerId")?)?;
    failure.set(c"providerName", record.get(c"providerName")?)?;
    failure.set(c"httpStatus", http)?;
    if rejection.truthy()? {
        failure.set(c"rejection", rejection)?;
    }
    failure.set(c"code", failure_code)?;
    let message = match http_status {
        Some(status) => format!("upstream HTTP {status}"),
        None if terminated(outcome, "downstream_disconnect")? => {
            "downstream response connection closed".to_string()
        }
        None => "upstream request failed".to_string(),
    };
    failure.set(c"message", text(port, &message)?)?;
    failure.set(c"observedAt", number(port, now(port)?)?)?;
    if outcome.truthy()? {
        failure.set(c"proxyOutcome", outcome)?;
        failure.set(c"requestId", outcome.get(c"requestId")?)?;
    }
    record.assign(c"proxyFailure", failure.freeze()?)?;
    // Host-observed silence, not a client that walked away: the route is dead
    // and later requests for this attempt are refused instead of re-dialed.
    if lifecycle(record, c"retireIfStalled", || {
        Ok(vec![record.get(c"proxyFailure")?.get(c"code")?, exhausted])
    })?
    .truthy()?
    {
        let mut entries = vec![
            (c"type", text(port, "provider_attempt_stalled")?),
            (c"operation", text(port, "proxy_outcome")?),
        ];
        entries.extend(identity(record)?);
        entries.push((c"providerId", record.get(c"providerId")?));
        entries.push((c"code", record.get(c"proxyFailure")?.get(c"code")?));
        entries.push((
            c"requestId",
            or_null(record.get(c"proxyFailure")?.get(c"requestId")?)?,
        ));
        audit(port, session, entries)?;
    }
    Ok(accepted(port, record.get(c"proxyFailure")?)?.raw())
}

/// The current attempt's proxy failure, unless the runner completed and the
/// result is durable: raw diagnostics stay readable, but the final verdict
/// ignores history the whole-turn completion evidence supersedes.
#[napi]
pub fn provider_proxy_failure(
    env: Env,
    reference: Unknown<'_>,
    facts: Unknown<'_>,
    port: Unknown<'_>,
) -> Result<sys::napi_value> {
    let reference = LiveValue::new(&env, reference);
    let facts = LiveValue::new(&env, facts);
    let port = LiveValue::new(&env, port);
    let session = if reference.truthy()? {
        reference.get(c"sessionId")?
    } else {
        reference
    };
    let record = current(port, session.clean_text()?)?;
    if !same_attempt(record, reference)? || !record.get(c"proxyFailure")?.truthy()? {
        return Ok(null(port)?.raw());
    }
    if facts.get(c"resultDurable")?.is_true()?
        && completed(facts.get(c"completion")?)?
        && compatible(record.get(c"proxyFailure")?, facts.get(c"completion")?)?
    {
        return Ok(null(port)?.raw());
    }
    let copy = port.from_value(&JsValue::Object(vec![]))?;
    copy.spread_from(record.get(c"proxyFailure")?)?;
    Ok(copy.freeze()?.raw())
}
