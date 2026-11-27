use super::*;

pub(super) fn tag<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if !object(a[0])? || a[0].is_array()? {
        return Err(identity::provider_error(
            p.get(c"ProviderAttemptError")?,
            "provider event is required",
            "PROVIDER_ATTEMPT_EVENT_INVALID",
        )?);
    }
    let out = spread(scrub::route(a[0])?)?;
    out.spread_from(attempt_fields(p, a[1])?)?;
    out.freeze()
}

pub(super) fn scope<'a>(_: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let safe = scrub::route(a[0])?;
    if !object(safe)? || safe.is_array()? {
        return Ok(safe);
    }
    let kind = safe.get(c"type")?.string()?;
    let owned = kind.as_ref().is_some_and(|s| {
        matches!(
            s.to_string_lossy().as_str(),
            "part_delta"
                | "stream_event"
                | "assistant"
                | "user"
                | "result"
                | "error"
                | "api_error_policy"
                | "provider_token_stats"
                | "rate_limit_event"
        )
    });
    if !owned || !safe.get(c"providerRouteScope")?.nullish()? {
        return Ok(safe);
    }
    let out = spread(safe)?;
    out.set(c"providerRouteScope", text(safe, "host")?)?;
    Ok(out)
}

pub(super) fn mark<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let event = a[0];
    if !object(event)? || event.is_array()? || !event.get(c"type")?.is_string("assistant")? {
        return Ok(event);
    }
    let copy = spread(event)?;
    let descriptor = fields(
        p,
        &[
            ("value", flag(p, true)?),
            ("enumerable", flag(p, false)?),
            ("configurable", flag(p, false)?),
            ("writable", flag(p, false)?),
        ],
    )?;
    call(
        p.global()?.get(c"Object")?,
        c"defineProperty",
        &[copy, p.get(c"marker")?, descriptor],
    )?;
    Ok(copy)
}

fn running(record: L<'_>, reference: L<'_>) -> Result<bool> {
    Ok(matching(record, reference)?
        && call(record.get(c"lifecycle")?, c"running", &[])?.truthy()?)
}

fn late<'a>(p: L<'a>, session: L<'a>, r: L<'a>, current: L<'a>, operation: &str) -> Result<()> {
    let clean = |k| fallback(member(r, k)?.clean_text()?, V::Null);
    let field = |k| {
        if current.truthy()? {
            current.get(k)
        } else {
            null(p)
        }
    };
    let event = fields(
        p,
        &[
            ("type", text(p, "provider_attempt_late_ignored")?),
            ("operation", text(p, operation)?),
            ("runtimeEpoch", clean(c"runtimeEpoch")?),
            ("turnId", clean(c"turnId")?),
            ("routeAttemptId", clean(c"routeAttemptId")?),
            (
                "routeGeneration",
                fallback(
                    num(p, member(r, c"routeGeneration")?.explicit_number()?)?,
                    V::Null,
                )?,
            ),
            ("currentRouteAttemptId", field(c"routeAttemptId")?),
            ("currentRouteGeneration", field(c"routeGeneration")?),
        ],
    )?;
    audit(p, session, event)
}

pub(super) fn accept<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let session = member(a[0], c"sessionId")?.clean_text()?;
    let record = current(p, session)?;
    let accepted = running(record, a[0])?;
    if !accepted {
        late(p, session, a[0], record, "event_admission")?;
    }
    flag(p, accepted)
}

pub(super) fn rejected<'a>(p: L<'a>, code: &str) -> Result<L<'a>> {
    fields(
        p,
        &[("accepted", flag(p, false)?), ("code", text(p, code)?)],
    )?
    .freeze()
}

pub(super) fn observe<'a>(p: L<'a>, reference: L<'a>, event: L<'a>) -> Result<L<'a>> {
    let session = member(reference, c"sessionId")?.clean_text()?;
    let record = current(p, session)?;
    if !running(record, reference)? {
        late(p, session, reference, record, "event")?;
        return rejected(p, "stale_attempt");
    }
    let marker = p.get(c"marker")?;
    let trusted = crate::provider_event_policy::provider_host_text_envelope(
        environment(p),
        arg(event)?,
        arg(marker)?,
    )?;
    let lifecycle = record.get(c"lifecycle")?;
    let previous = call(lifecycle, c"snapshot", &[])?.get(c"replayFence")?;
    let reconciled = trusted && call(lifecycle, c"reconcileHostError", &[event])?.truthy()?;
    let next = if reconciled {
        text(p, "none")?
    } else {
        call(lifecycle, c"observeFence", &[event, marker])?
    };
    if (reconciled && !previous.is_string("none")?) || (!reconciled && next.truthy()?) {
        let change = fields(
            p,
            &[
                (
                    "type",
                    text(
                        p,
                        if reconciled {
                            "provider_fence_reconciled"
                        } else {
                            "provider_fence_advanced"
                        },
                    )?,
                ),
                ("runtimeEpoch", record.get(c"runtimeEpoch")?),
                ("turnId", record.get(c"turnId")?),
                ("routeAttemptId", record.get(c"routeAttemptId")?),
                ("routeGeneration", record.get(c"routeGeneration")?),
                ("providerId", record.get(c"providerId")?),
                ("fromFence", previous),
                ("replayFence", next),
            ],
        )?;
        if reconciled {
            change.set(c"reasonCode", text(p, "host_error_envelope")?)?;
        }
        audit(p, session, change)?;
    }
    let result = fields(p, &[("accepted", flag(p, true)?), ("code", null(p)?)])?;
    result.spread_from(attempt_snapshot(record)?)?;
    result.freeze()
}
