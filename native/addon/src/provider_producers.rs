//! Producer activity and draining policy over the shared Rust-owned ledgers.
//! Host effects run without a mutable ledger borrow; snapshots keep their identity.
use crate::{js_live::LiveValue, provider_authorization::background_lingers};
use multicc_core::js::JsValue;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

fn text<'a>(anchor: LiveValue<'a>, value: &str) -> Result<LiveValue<'a>> {
    anchor.from_value(&JsValue::string(value))
}
fn null(anchor: LiveValue<'_>) -> Result<LiveValue<'_>> {
    anchor.from_value(&JsValue::Null)
}
fn number(anchor: LiveValue<'_>, value: f64) -> Result<LiveValue<'_>> {
    anchor.from_value(&JsValue::Number(value))
}
fn method<'a>(object: LiveValue<'a>, name: &CStr, args: &[LiveValue<'a>]) -> Result<LiveValue<'a>> {
    object.get(name)?.call(object, args)
}
fn running(record: LiveValue<'_>) -> Result<bool> {
    Ok(record.truthy()? && method(record.get(c"lifecycle")?, c"running", &[])?.truthy()?)
}
fn snapshot<'a>(record: LiveValue<'a>, port: LiveValue<'a>) -> Result<LiveValue<'a>> {
    port.get(c"snapshot")?.call_plain(&[record])
}
fn now(port: LiveValue<'_>) -> Result<f64> {
    port.get(c"now")?.call_plain(&[])?.explicit_number()
}
fn age(producer: LiveValue<'_>, port: LiveValue<'_>) -> Result<f64> {
    let current = now(port)?;
    let last = producer.get(c"lastRequestAt")?.explicit_number()?;
    Ok(current
        - if last.is_nan() || last == 0.0 {
            0.0
        } else {
            last
        })
}
fn key<'a>(
    context: LiveValue<'a>,
    event: LiveValue<'a>,
    role: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
    let parts = context.from_value(&JsValue::Array(vec![]))?;
    parts.set(c"0", context.get(c"sessionId")?)?;
    let token = context.get(c"token")?;
    parts.set(
        c"1",
        if token.truthy()? {
            token
        } else {
            text(context, if role.is_string("aux")? { "aux" } else { "" })?
        },
    )?;
    parts.set(c"2", role)?;
    parts.set(c"3", event.get(c"providerId")?.clean_text()?)?;
    method(parts, c"join", &[text(context, "\0")?])
}
fn non_main<'a>(
    context: LiveValue<'a>,
    event: LiveValue<'a>,
    role: LiveValue<'a>,
    phase: LiveValue<'a>,
    port: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
    let session = context.get(c"sessionId")?;
    let record = context.get(c"record")?;
    let key = key(context, event, role)?;
    let ledger = port.get(c"nonMainProxyProducers")?;
    if phase.is_string("request")? {
        if !role.is_string("aux")?
            && (!context.get(c"exact")?.truthy()?
                || !record.truthy()?
                || (!running(record)? && !background_lingers(record)?))
        {
            return null(port);
        }
        method(ledger, c"start", &[key])?;
    } else {
        if !method(ledger, c"hasActive", &[key])?.truthy()? {
            return null(port);
        }
        if phase.is_string("end")? {
            method(ledger, c"end", &[key])?;
        }
    }
    let result = port.from_value(&JsValue::Object(vec![]))?;
    result.set(c"sessionId", session)?;
    result.freeze()
}
fn overlap(producer: LiveValue<'_>, port: LiveValue<'_>) -> Result<()> {
    producer.assign(
        c"count",
        number(producer, producer.get(c"count")?.number()? + 1.0)?,
    )?;
    producer.assign(c"ambiguous", producer.from_value(&JsValue::Bool(true))?)?;
    producer.assign(c"lastRequestAt", number(producer, now(port)?)?)
}
fn ambiguous(session: LiveValue<'_>, port: LiveValue<'_>) -> Result<()> {
    let ledger = port.get(c"proxyProducers")?;
    let producer = method(ledger, c"getActive", &[session])?;
    if producer.truthy()? && producer.get(c"count")?.positive()? {
        overlap(producer, port)?;
    } else {
        let set = ledger.get(c"setActive")?;
        set.call(
            ledger,
            &[
                session,
                null(port)?,
                null(port)?,
                number(port, 1.0)?,
                port.from_value(&JsValue::Bool(true))?,
                number(port, now(port)?)?,
            ],
        )?;
    }
    Ok(())
}
fn decrement(producer: LiveValue<'_>) -> Result<()> {
    let math = producer.global()?.get(c"Math")?;
    let max = math.get(c"max")?;
    producer.assign(
        c"count",
        max.call(
            math,
            &[
                number(producer, 0.0)?,
                number(producer, producer.get(c"count")?.number()? - 1.0)?,
            ],
        )?,
    )
}
fn drain_event(port: LiveValue<'_>) -> Result<LiveValue<'_>> {
    let event = port.from_value(&JsValue::object(vec![(
        "type",
        JsValue::string("provider_producer_force_drained"),
    )]))?;
    event.set(c"runtimeEpoch", port.get(c"runtimeEpoch")?)?;
    Ok(event)
}
fn remove(ledger: LiveValue<'_>, session: LiveValue<'_>) -> Result<()> {
    method(ledger, c"deleteActive", &[session])?;
    method(ledger, c"deleteEnded", &[session])?;
    Ok(())
}

#[napi]
pub fn provider_non_main_producer_key(
    env: Env,
    context: Unknown<'_>,
    event: Unknown<'_>,
    role: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(key(
        LiveValue::new(&env, context),
        LiveValue::new(&env, event),
        LiveValue::new(&env, role),
    )?
    .raw())
}

#[napi]
pub fn provider_proxy_activity(
    env: Env,
    event: Unknown<'_>,
    context: Unknown<'_>,
    port: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(activity(
        LiveValue::new(&env, event),
        LiveValue::new(&env, context),
        LiveValue::new(&env, port),
    )?
    .raw())
}
fn activity<'a>(
    event: LiveValue<'a>,
    context: LiveValue<'a>,
    port: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
    let session = context.get(c"sessionId")?;
    let record = context.get(c"record")?;
    if !session.truthy()? {
        return null(port);
    }
    let role = event.get(c"role")?;
    let role = if role.truthy()? {
        role
    } else {
        event.get(c"roleKind")?
    }
    .clean_text()?;
    let role = method(role, c"toLowerCase", &[])?;
    let phase = method(event.get(c"phase")?.clean_text()?, c"toLowerCase", &[])?;
    if role.truthy()? && !role.is_string("main")? {
        return non_main(context, event, role, phase, port);
    }
    let ledger = port.get(c"proxyProducers")?;
    if !context.get(c"exact")?.truthy()? {
        if phase.is_string("request")? {
            ambiguous(session, port)?;
            port.get(c"poisonProxyAttempt")?
                .call_plain(&[record, text(port, "proxy_route_token_mismatch")?])?;
        } else if phase.is_string("end")? {
            let producer = method(ledger, c"getActive", &[session])?;
            if producer.truthy()? {
                decrement(producer)?;
                if producer.get(c"count")?.is_number(0.0)? {
                    method(ledger, c"deleteActive", &[session])?;
                }
            }
        }
        return null(port);
    }
    if !role.is_string("main")? {
        return if running(record)? {
            snapshot(record, port)
        } else {
            null(port)
        };
    }
    let background = text(port, "background")?;
    let open = method(
        port.get(c"nonMainProxyProducers")?,
        c"hasActive",
        &[key(context, event, background)?],
    )?
    .truthy()?;
    let is_background = if phase.is_string("request")? {
        background_lingers(record)?
    } else {
        open && !method(ledger, c"getActive", &[session])?
            .optional(c"count")?
            .positive()?
    };
    if is_background {
        return non_main(context, event, background, phase, port);
    }
    if phase.is_string("request")? {
        method(ledger, c"deleteEnded", &[session])?;
        let producer = method(ledger, c"getActive", &[session])?;
        let resolver = port.get(c"resolveProviderRevision")?;
        let revision_matches = if record.truthy()? && resolver.truthy()? {
            port.catch(|| {
                resolver
                    .call_plain(&[record, event])?
                    .clean_text()?
                    .equals(record.get(c"providerRevision")?)
            })?
            .unwrap_or(false)
        } else {
            true
        };
        if !running(record)?
            || !revision_matches
            || (event.get(c"providerId")?.clean_text()?.truthy()?
                && !event
                    .get(c"providerId")?
                    .clean_text()?
                    .equals(record.get(c"providerId")?)?)
        {
            ambiguous(session, port)?;
            port.get(c"poisonProxyAttempt")?.call_plain(&[
                record,
                text(
                    port,
                    if revision_matches {
                        "provider_route_mismatch"
                    } else {
                        "provider_revision_mismatch"
                    },
                )?,
            ])?;
            return null(port);
        }
        if producer.truthy()? && producer.get(c"count")?.positive()? {
            overlap(producer, port)?;
        } else {
            let set = ledger.get(c"setActive")?;
            set.call(
                ledger,
                &[
                    session,
                    snapshot(record, port)?,
                    record.get(c"proxyRouteToken")?,
                    number(port, 1.0)?,
                    port.from_value(&JsValue::Bool(false))?,
                    number(port, now(port)?)?,
                ],
            )?;
        }
        return snapshot(record, port);
    }
    if phase.is_string("end")? {
        let producer = method(ledger, c"getActive", &[session])?;
        if !producer.truthy()? {
            return null(port);
        }
        decrement(producer)?;
        if producer.get(c"count")?.is_number(0.0)? {
            method(ledger, c"deleteActive", &[session])?;
            if !producer.get(c"ambiguous")?.truthy()? && producer.get(c"attempt")?.truthy()? {
                let set = ledger.get(c"setEnded")?;
                set.call(
                    ledger,
                    &[
                        session,
                        producer.get(c"attempt")?,
                        producer.get(c"proxyRouteToken")?,
                    ],
                )?;
            } else {
                method(ledger, c"deleteEnded", &[session])?;
            }
        }
        let attempt = producer.get(c"attempt")?;
        return if attempt.truthy()? {
            Ok(attempt)
        } else {
            null(port)
        };
    }
    if running(record)? {
        snapshot(record, port)
    } else {
        null(port)
    }
}

#[napi]
pub fn provider_bound_proxy_attempt(
    env: Env,
    input: Unknown<'_>,
    context: Unknown<'_>,
    port: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(bound(
        LiveValue::new(&env, input),
        LiveValue::new(&env, context),
        LiveValue::new(&env, port),
    )?
    .raw())
}
fn bound<'a>(
    input: LiveValue<'a>,
    context: LiveValue<'a>,
    port: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
    if !context.get(c"exact")?.truthy()? {
        return null(port);
    }
    let producer = method(
        port.get(c"proxyProducers")?,
        c"getActive",
        &[context.get(c"sessionId")?],
    )?;
    if !producer.truthy()?
        || !producer.get(c"count")?.is_number(1.0)?
        || producer.get(c"ambiguous")?.truthy()?
        || !producer.get(c"attempt")?.truthy()?
        || !producer
            .get(c"proxyRouteToken")?
            .equals(context.get(c"token")?)?
    {
        return null(port);
    }
    let record = context.get(c"record")?;
    let reference = producer.get(c"attempt")?;
    if !record.truthy()?
        || !reference.truthy()?
        || !method(record.get(c"lifecycle")?, c"matches", &[reference])?.truthy()?
        || !running(record)?
    {
        return null(port);
    }
    if input.get(c"providerId")?.clean_text()?.truthy()?
        && !input
            .get(c"providerId")?
            .clean_text()?
            .equals(record.get(c"providerId")?)?
    {
        return null(port);
    }
    let role = input.get(c"role")?;
    let role = if role.truthy()? {
        role
    } else {
        input.get(c"roleKind")?
    }
    .clean_text()?;
    if !method(role, c"toLowerCase", &[])?.is_string("main")? {
        return null(port);
    }
    snapshot(record, port)
}

#[napi]
pub fn provider_force_release_producers(
    env: Env,
    session: Unknown<'_>,
    reason: Unknown<'_>,
    port: Unknown<'_>,
) -> Result<sys::napi_value> {
    let port = LiveValue::new(&env, port);
    let id = LiveValue::new(&env, session).clean_text()?;
    let result = if !id.truthy()? {
        port.from_value(&JsValue::object(vec![
            ("ok", false.into()),
            ("code", JsValue::string("invalid_session")),
        ]))?
    } else {
        let ledger = port.get(c"proxyProducers")?;
        let producer = method(ledger, c"getActive", &[id])?;
        if !producer.truthy()? || producer.get(c"count")?.number()? <= 0.0 {
            port.from_value(&JsValue::object(vec![
                ("ok", true.into()),
                ("code", JsValue::string("no_producers")),
                ("released", 0.0.into()),
            ]))?
        } else {
            let released = producer.get(c"count")?;
            let audit = port.get(c"auditOnly")?;
            let event = drain_event(port)?;
            event.set(
                c"turnId",
                if producer.get(c"attempt")?.truthy()? {
                    producer.get(c"attempt")?.get(c"turnId")?
                } else {
                    null(port)?
                },
            )?;
            event.set(c"count", released)?;
            event.set(c"ageMs", number(port, age(producer, port)?)?)?;
            let reason = LiveValue::new(&env, reason).clean_text()?;
            event.set(
                c"reason",
                if reason.truthy()? {
                    reason
                } else {
                    text(port, "force_release")?
                },
            )?;
            audit.call_plain(&[id, event])?;
            remove(ledger, id)?;
            let result = port.from_value(&JsValue::object(vec![
                ("ok", true.into()),
                ("code", JsValue::string("released")),
            ]))?;
            result.set(c"released", released)?;
            result
        }
    };
    Ok(result.freeze()?.raw())
}

#[napi]
pub fn provider_drain_stale_producers(
    env: Env,
    session: Unknown<'_>,
    turn: Unknown<'_>,
    producer: Unknown<'_>,
    port: Unknown<'_>,
) -> Result<()> {
    let port = LiveValue::new(&env, port);
    let producer = LiveValue::new(&env, producer);
    if !producer.truthy()? || !producer.get(c"count")?.positive()? {
        return Ok(());
    }
    let elapsed = age(producer, port)?;
    if elapsed.is_finite()
        && producer.get(c"lastRequestAt")?.truthy()?
        && elapsed >= port.get(c"producerStaleGraceMs")?.number()?
    {
        let session = LiveValue::new(&env, session);
        let audit = port.get(c"auditOnly")?;
        let event = drain_event(port)?;
        event.set(c"turnId", LiveValue::new(&env, turn))?;
        event.set(c"count", producer.get(c"count")?)?;
        event.set(c"ageMs", number(port, elapsed)?)?;
        event.set(c"graceMs", port.get(c"producerStaleGraceMs")?)?;
        event.set(c"reason", text(port, "stale_producer_grace")?)?;
        audit.call_plain(&[session, event])?;
        remove(port.get(c"proxyProducers")?, session)?;
        Ok(())
    } else {
        Err(port
            .get(c"ProviderAttemptError")?
            .construct(&[
                text(port, "previous provider request has not drained")?,
                text(port, "PROVIDER_PRODUCER_NOT_DRAINED")?,
            ])?
            .throw_error())
    }
}
