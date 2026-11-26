//! Claim under a write transaction, run host probes outside it, then finish
//! only the matching lease. A projection refresh covers ambiguous commit errors.
use super::*;

fn pending_rows(draft: L<'_>) -> Result<L<'_>> {
    candidate(
        draft,
        "waits",
        fields(draft, &[("status", text(draft, "pending")?)])?,
    )
}
enum Due {
    Expire,
    Delay,
    Poll,
}
fn due(w: L<'_>, at: f64) -> Result<Option<Due>> {
    if !w.get(c"status")?.is_string("pending")? {
        return Ok(None);
    }
    let m = metadata(w)?;
    let mode = w.get(c"mode")?;
    if mode.is_string("callback")? {
        return Ok(m
            .get(c"expireAt")?
            .number_value()?
            .filter(|n| n.is_finite() && *n <= at)
            .map(|_| Due::Expire));
    }
    let delay = mode.is_string("delay")?;
    let (id, until, next) = if delay {
        (c"delayLeaseId", c"delayLeasedUntil", c"dueAt")
    } else {
        (c"pollLeaseId", c"pollLeasedUntil", c"nextAt")
    };
    if m.get(id)?.truthy()?
        && m.get(until)?
            .number_value()?
            .is_some_and(|n| n.is_finite() && n > at)
    {
        return Ok(None);
    }
    Ok(m.get(next)?
        .number_value()?
        .filter(|n| n.is_finite() && *n <= at)
        .map(|_| if delay { Due::Delay } else { Due::Poll }))
}
fn empty_claims(s: L<'_>) -> Result<L<'_>> {
    fields(s, &[("claims", arr(s)?), ("expired", arr(s)?)])
}
fn claim_draft<'a>(s: L<'a>, draft: L<'a>) -> Result<L<'a>> {
    let at = clock(s)?;
    let result = empty_claims(s)?;
    pending_rows(draft)?.for_each(|w| {
        let Some(action) = due(w, at)? else {
            return Ok(());
        };
        let id = w.get(c"id")?;
        let session = w.get(c"sessionId")?;
        let ts = num(s, at)?;
        match action {
            Due::Expire => {
                w.assign(c"status", text(s, "cancelled")?)?;
                w.assign(c"cancelledAt", ts)?;
                w.assign(c"updatedAt", ts)?;
                call(
                    result.get(c"expired")?,
                    c"push",
                    &[fields(s, &[("sessionId", session), ("id", id)])?],
                )?;
            }
            kind => {
                let (mode, id_key, until_key) = match kind {
                    Due::Delay => ("delay", "delayLeaseId", "delayLeasedUntil"),
                    _ => ("poll", "pollLeaseId", "pollLeasedUntil"),
                };
                let lease = call(
                    service(s, c"crypto", c"randomBytes", &[num(s, 16.)?])?,
                    c"toString",
                    &[text(s, "hex")?],
                )?;
                let m = metadata(w)?;
                set(m, id_key, lease)?;
                let duration = s.get(c"pollLeaseMs")?;
                let until = if duration.kind()? == sys::ValueType::napi_string {
                    message(s, &[ts, duration])?
                } else {
                    num(s, at + duration.explicit_number()?)?
                };
                set(m, until_key, until)?;
                w.assign(c"metadata", m)?;
                w.assign(c"updatedAt", ts)?;
                let json = s.global()?.get(c"JSON")?;
                let copy = call(json, c"parse", &[call(json, c"stringify", &[m])?])?;
                let claim = fields(
                    s,
                    &[
                        ("id", id),
                        ("mode", text(s, mode)?),
                        ("sessionId", session),
                        (id_key, lease),
                        ("metadata", copy),
                    ],
                )?;
                call(result.get(c"claims")?, c"push", &[claim])?;
            }
        }
        Ok(())
    })?;
    Ok(result)
}
fn claim_due(s: L<'_>) -> Result<L<'_>> {
    let predicate = callback(s, "", 1, 1, |s, a| {
        let at = clock(s)?;
        let mut found = false;
        pending_rows(a[0])?.for_each_while(|w| {
            found = due(w, at)?.is_some();
            Ok(!found)
        })?;
        flag(s, found)
    })?;
    let mutate = callback(s, "", 1, 1, |s, a| claim_draft(s, a[0]))?;
    let empty = callback(s, "", 0, 0, |s, _| empty_claims(s))?;
    let p = service(s, c"store", c"mutateIf", &[predicate, mutate, empty])?;
    after(s, p, |s, result| {
        result
            .get(c"expired")?
            .for_each(|w| remove_pending(s, w.get(c"sessionId")?, w.get(c"id")?))?;
        result.get(c"claims")
    })
}
fn matches<'a>(m: L<'a>, output: L<'a>) -> Result<bool> {
    let contains = m.get(c"untilContains")?;
    if contains.truthy()? {
        return call(output, c"includes", &[contains])?.truthy();
    }
    let pattern = m.get(c"untilRegex")?;
    if !pattern.truthy()? {
        return Ok(false);
    }
    Ok(m.catch(|| {
        call(
            m.global()?.get(c"RegExp")?.construct(&[pattern])?,
            c"test",
            &[output],
        )?
        .truthy()
    })?
    .unwrap_or(false))
}
fn finish_draft<'a>(st: L<'a>, draft: L<'a>) -> Result<L<'a>> {
    let s = st.get(c"s")?;
    let claim = st.get(c"claim")?;
    let out = |action: &str| fields(s, &[("action", text(s, action)?)]);
    let w = draft.get(c"waits")?.get_key(claim.get(c"id")?)?;
    if !w.truthy()? || !w.get(c"status")?.is_string("pending")? {
        return out("gone");
    }
    let m = metadata(w)?;
    if !m.get(c"pollLeaseId")?.equals(claim.get(c"pollLeaseId")?)? {
        return out("lease_lost");
    }
    let at = clock(s)?;
    let count = m.get(c"checks")?.explicit_number()?;
    let checks = if count.is_nan() { 1. } else { count + 1. };
    m.assign(c"checks", num(s, checks)?)?;
    m.assign(c"pollLeaseId", null(s)?)?;
    m.assign(c"pollLeasedUntil", null(s)?)?;
    w.assign(c"updatedAt", num(s, at)?)?;
    let err = st.get(c"error")?;
    let output = st.get(c"output")?;
    if !err.truthy()? && matches(m, output)? {
        let r = out("resolve")?;
        r.set(c"output", output)?;
        return Ok(r);
    }
    if checks >= m.get(c"maxChecks")?.explicit_number()? {
        let r = out("timeout")?;
        r.set(c"checks", num(s, checks)?)?;
        return Ok(r);
    }
    m.assign(
        c"nextAt",
        num(s, at + m.get(c"intervalSec")?.explicit_number()? * 1000.)?,
    )?;
    w.assign(c"metadata", m)?;
    let r = out("retry")?;
    r.set(
        c"error",
        if err.truthy()? {
            string(or_value(err.optional(c"message")?, err)?)?
        } else {
            null(s)?
        },
    )?;
    Ok(r)
}
fn finish_poll<'a>(st: L<'a>, output: L<'a>, error: L<'a>) -> Result<L<'a>> {
    let s = st.get(c"s")?;
    let st = state(
        s,
        &[
            ("claim", st.get(c"claim")?),
            ("output", output),
            ("error", error),
        ],
    )?;
    let mutate = callback(st, "", 1, 1, |st, a| finish_draft(st, a[0]))?;
    after(
        st,
        service(s, c"store", c"mutate", &[mutate])?,
        |st, outcome| {
            let s = st.get(c"s")?;
            let claim = st.get(c"claim")?;
            let id = claim.get(c"id")?;
            let action = outcome.get(c"action")?;
            let promise = if action.is_string("resolve")? {
                service(s, c"waits", c"resolvePoll", &[id, outcome.get(c"output")?])?
            } else if action.is_string("timeout")? {
                let msg = message(
                    s,
                    &[
                        text(s, "[轮询超时] 等待的条件在 ")?,
                        outcome.get(c"checks")?,
                        text(s, " 次检查后仍未满足，请决定是继续等待还是改用其它方式。")?,
                    ],
                )?;
                service(
                    s,
                    c"waits",
                    c"resolvePoll",
                    &[id, msg, fields(s, &[("deliveryText", msg)])?],
                )?
            } else {
                return Ok(outcome);
            };
            st.set(c"outcome", outcome)?;
            after(st, promise, |st, r| {
                let claim = st.get(c"claim")?;
                if r.get(c"ok")?.truthy()? {
                    remove_pending(st.get(c"s")?, claim.get(c"sessionId")?, claim.get(c"id")?)?;
                }
                st.get(c"outcome")
            })
        },
    )
}
fn process_delay<'a>(st: L<'a>, claim: L<'a>) -> Result<L<'a>> {
    let s = st.get(c"s")?;
    let m = claim.get(c"metadata")?;
    let id = claim.get(c"id")?;
    let scheduled = m.get(c"kind")?.is_string(SCHEDULED)?;
    let payload = fields(s, &[("dueAt", m.get(c"dueAt")?)])?;
    let options = if scheduled {
        let msg = trim(fallback(m.get(c"scheduledMessageText")?, "".into())?)?;
        if !msg.truthy()? {
            log_parts(
                s,
                &[
                    text(s, "[orchestration] scheduled message ")?,
                    id,
                    text(s, " has no durable payload; cancelling")?,
                ],
            )?;
            return service(s, c"waits", c"cancel", &[id]);
        }
        payload.set(c"scheduledMessage", flag(s, true)?)?;
        fields(s, &[("sessionWork", fields(s, &[("text", msg)])?)])?
    } else {
        let reason = trim(fallback(m.get(c"reason")?, "".into())?)?;
        payload.set(c"reason", reason)?;
        let msg = if reason.truthy()? {
            message(s, &[text(s, "🔇【延迟条件已到】")?, reason])?
        } else {
            text(s, "🔇【延迟条件已到】请检查当前状态并继续处理。")?
        };
        fields(s, &[("deliveryText", msg)])?
    };
    st.set(c"scheduled", flag(s, scheduled)?)?;
    after(
        st,
        service(s, c"waits", c"resolveDelay", &[id, payload, options])?,
        |st, r| {
            let s = st.get(c"s")?;
            if !r.get(c"ok")?.truthy()? {
                return undef(s);
            }
            let claim = st.get(c"claim")?;
            remove_pending(s, claim.get(c"sessionId")?, claim.get(c"id")?)?;
            if !st.get(c"scheduled")?.truthy()? {
                return undef(s);
            }
            let notified = async_result(s, || {
                service(
                    s,
                    c"sessionScheduler",
                    c"noteQueued",
                    &[r.get(c"outboxId")?],
                )
            })?;
            let logged = after(s, notified, |s, notice| {
                if !notice.optional(c"ok")?.truthy()? {
                    log_parts(
                        s,
                        &[
                            text(s, "[orchestration] scheduled message queue notice failed: ")?,
                            fallback(notice.optional(c"code")?, "unknown".into())?,
                        ],
                    )?;
                }
                undef(s)
            })?;
            recover(s, logged, |s, e| {
                log_parts(
                    s,
                    &[
                        text(s, "[orchestration] scheduled message queue notice failed: ")?,
                        e.get(c"message")?,
                    ],
                )?;
                undef(s)
            })
        },
    )
}
fn process_claim<'a>(s: L<'a>, claim: L<'a>) -> Result<L<'a>> {
    let st = state(s, &[("claim", claim)])?;
    if claim.get(c"mode")?.is_string("delay")? {
        return process_delay(st, claim);
    }
    let probe = async_result(s, || {
        s.get(c"probe")?.call_plain(&[claim.get(c"metadata")?])
    })?;
    let attempt = after(st, probe, |st, output| {
        finish_poll(st, clipped(output, 1024 * 1024)?, null(st)?)
    })?;
    recover(st, attempt, |st, e| {
        let s = st.get(c"s")?;
        let id = st.get(c"claim")?.get(c"id")?;
        log_parts(
            s,
            &[
                text(s, "[orchestration] poll ")?,
                id,
                text(s, " failed: ")?,
                e.get(c"message")?,
            ],
        )?;
        let finished = async_result(s, || finish_poll(st, text(s, "")?, e))?;
        recover(st, finished, |st, e| {
            let s = st.get(c"s")?;
            log_parts(
                s,
                &[
                    text(s, "[orchestration] poll ")?,
                    st.get(c"claim")?.get(c"id")?,
                    text(s, " state update failed: ")?,
                    e.get(c"message")?,
                ],
            )?;
            undef(s)
        })
    })
}
pub(in super::super) fn process_polls(s: L<'_>) -> Result<L<'_>> {
    let claims = claim_due(s)?;
    let settled = after(s, claims, |s, claims| {
        let group = arr(s)?;
        claims.for_each(|claim| {
            let promise = async_result(s, || process_claim(s, claim))?;
            call(group, c"push", &[promise])?;
            Ok(())
        })?;
        call(s.global()?.get(c"Promise")?, c"allSettled", &[group])
    })?;
    let refreshed = after(s, settled, |s, _| refresh_pending(s))?;
    after(s, refreshed, |s, _| undef(s))
}
