use super::*;

fn wedge<'a>(s: L<'a>, it: L<'a>, reason: &str, reasons: L<'a>, at: f64) -> Result<()> {
    let session = it.get(c"sessionId")?;
    let active =
        reasons.is_array()? && call(reasons, c"includes", &[text(s, "run_active")?])?.truthy()?;
    let held = active
        && is_fn(s.get(c"heldForBackground")?)?
        && s.catch(|| port(s, c"heldForBackground", &[session])?.is_true())?
            .unwrap_or(false);
    let tracked = s.get(c"blockedDelivery")?;
    if !matches!(reason, "session_busy" | "delivery_locked")
        || !typed(it.get(c"payload")?)?
        || (active && !held)
    {
        call(tracked, c"delete", &[session])?;
        return Ok(());
    }
    let mut state = call(tracked, c"get", &[session])?;
    if !state.truthy()? {
        if tracked.get(c"size")?.number()? > 1000. {
            call(tracked, c"clear", &[])?;
        }
        state = fields(s, &[("since", num(s, at)?), ("notified", flag(s, false)?)])?;
        call(tracked, c"set", &[session, state])?;
    }
    let waited = at - state.get(c"since")?.number()?;
    if state.get(c"notified")?.truthy()? || waited < s.get(c"stuckDeliveryNoticeMs")?.number()? {
        return Ok(());
    }
    state.set(c"notified", flag(s, true)?)?;
    let notify = s.get(c"notifyStuckDelivery")?;
    if !notify.nullish()? {
        let msg = fields(
            s,
            &[
                ("sessionId", session),
                ("item", it),
                ("reason", text(s, reason)?),
                ("reasons", reasons),
                ("waitedMs", num(s, waited)?),
                ("heldForBackground", flag(s, held)?),
            ],
        )?;
        if let Err(e) = notify.call_plain(&[msg]) {
            let error = s.exception_value()?.ok_or(e)?;
            log(
                s,
                &[
                    text(s, "[orchestration] stuck-delivery notice failed: ")?,
                    error.get(c"message")?,
                ],
            )?;
        }
    }
    Ok(())
}
fn skip<'a>(s: L<'a>, it: L<'a>, reason: &str, detail: L<'a>) -> Result<()> {
    let at = port(s, c"now", &[])?.explicit_number()?;
    let session = it.get(c"sessionId")?;
    let reasons =
        if matches!(reason, "session_busy" | "delivery_locked") && is_fn(s.get(c"busyReasons")?)? {
            let value = s.catch(|| port(s, c"busyReasons", &[session, detail]))?;
            or(value.unwrap_or(null(s)?), null(s)?)?
        } else {
            null(s)?
        };
    wedge(s, it, reason, reasons, at)?;
    let logs = s.get(c"deliverySkipLogAt")?;
    if at - or(call(logs, c"get", &[session])?, num(s, 0.)?)?.number()? < 15000. {
        return Ok(());
    }
    if logs.get(c"size")?.number()? > 1000. {
        call(logs, c"clear", &[])?;
    }
    call(logs, c"set", &[session, num(s, at)?])?;
    let entry = fields(
        s,
        &[
            ("sessionId", session),
            ("entryId", it.get(c"id")?),
            ("reason", text(s, reason)?),
        ],
    )?;
    if reasons.truthy()? && reasons.get(c"length")?.truthy()? {
        entry.set(c"reasons", reasons)?;
    }
    log(
        s,
        &[text(s, "[orchestration] delivery_skipped ")?, json(entry)?],
    )
}
pub(super) fn select<'a>(s: L<'a>, items: L<'a>, draft: L<'a>, at: L<'a>) -> Result<L<'a>> {
    let it = unit(
        s,
        c"sessionScheduler",
        c"selectSessionItem",
        &[items, draft, at],
    )?;
    if !it.truthy()? {
        return null(s);
    }
    let projected = unit(s, c"sessionScheduler", c"projectItemLineage", &[it, draft])?;
    let session = it.get(c"sessionId")?;
    if port(s, c"isBusy", &[session, projected])?.truthy()? {
        let injectable = is_fn(s.get(c"heldTurnInjectable")?)?
            && s.catch(|| port(s, c"heldTurnInjectable", &[descriptor(s, it)?])?.is_true())?
                .unwrap_or(false);
        if !injectable {
            skip(s, it, "session_busy", projected)?;
            if is_fn(s.get(c"noteBlockedDelivery")?)? {
                s.catch(|| port(s, c"noteBlockedDelivery", &[session]))?;
            }
            return null(s);
        }
    }
    if unit(s, c"inFlightDeliveries", c"has", &[it.get(c"id")?])?.truthy()? {
        return null(s);
    }
    if unit(
        s,
        c"inFlightDeliveryGroups",
        c"has",
        &[port(s, c"deliveryGroup", &[session])?],
    )?
    .truthy()?
    {
        skip(s, it, "delivery_in_flight", undef(s)?)?;
        return null(s);
    }
    if port(s, c"isDeliveryLocked", &[session, projected])?.truthy()? {
        skip(s, it, "delivery_locked", undef(s)?)?;
        return null(s);
    }
    unit(s, c"blockedDelivery", c"delete", &[session])?;
    Ok(it)
}
