use super::*;

pub(super) fn clear<'a>(p: L<'a>, id: L<'a>, map: &CStr) -> Result<()> {
    let entry = store(p, map, c"get", &[id])?;
    if !entry.undefined()? {
        store(p, map, c"delete", &[id])?;
        p.catch(|| port(p, c"clearTimeout", &[entry.get(c"timer")?]))?;
    }
    Ok(())
}
// The entry object identifies this particular timer even if the host reuses handles.
fn arm<'a>(f: L<'a>, map: &'static CStr, delay: f64, step: Step) -> Result<()> {
    let p = f.get(c"host")?;
    let id = f.get(c"id")?;
    clear(p, id, map)?;
    let cb = function(f, "", 0, 0, move |f, _| {
        let p = f.get(c"host")?;
        let id = f.get(c"id")?;
        if store(p, map, c"get", &[id])?.equals(f)? {
            store(p, map, c"delete", &[id])?;
            if current(f)? {
                let pending = async_result(f, || step(f, undef(p)?))?;
                ignore(f, pending, "timer failed")?;
            }
        }
        undef(p)
    })?;
    let timer = port(p, c"setTimeout", &[cb, num(p, delay.max(0.))?])?;
    if callable(timer.optional(c"unref")?)? {
        call(timer, c"unref", &[])?;
    }
    f.set(c"timer", timer)?;
    store(p, map, c"set", &[id, f])?;
    Ok(())
}
pub(super) fn sync<'a>(p: L<'a>, id: L<'a>, s: L<'a>) -> Result<()> {
    for (map, key, step) in [
        (c"timers", c"deadlineAt", deadline as Step),
        (c"retryTimers", c"retryAt", retry as Step),
    ] {
        clear(p, id, map)?;
        if !active(s)? {
            continue;
        }
        let at = s.get(key)?.explicit_number()?;
        if at.is_finite() && at > 0. {
            arm(frame(p, id)?, map, at - now(p)?.explicit_number()?, step)?;
        }
    }
    Ok(())
}
fn deadline<'a>(f: L<'a>, _: L<'a>) -> Result<L<'a>> {
    lifecycle::expire(f.get(c"host")?, f.get(c"id")?)?;
    undef(f)
}
pub(super) fn shutdown(p: L<'_>) -> Result<L<'_>> {
    p.set(c"clockEpoch", obj(p)?)?;
    store(p, c"admittingRetries", c"clear", &[])?;
    for map in [c"timers", c"retryTimers", c"backlogRechecks"] {
        store(p, map, c"keys", &[])?.for_each(|id| clear(p, id, map))?;
    }
    undef(p)
}
fn same(f: L<'_>) -> Result<bool> {
    let p = f.get(c"host")?;
    let s = state(p, f.get(c"id")?)?;
    let before = f.get(c"before")?;
    Ok(current(f)?
        && active(s)?
        && f.get(c"epoch")?.equals(p.get(c"clockEpoch")?)?
        && s.get(c"startedAt")?.equals(before.get(c"startedAt")?)?
        && s.get(c"lastTurnEndId")?
            .equals(before.get(c"lastTurnEndId")?)?
        && s.get(c"retryAt")?.explicit_number()? == f.get(c"retryAt")?.explicit_number()?)
}
fn postpone(f: L<'_>) -> Result<()> {
    if same(f)? {
        arm(
            frame(f.get(c"host")?, f.get(c"id")?)?,
            c"retryTimers",
            1000.,
            retry,
        )?;
    }
    Ok(())
}
fn consume(f: L<'_>) -> Result<()> {
    let p = f.get(c"host")?;
    let id = f.get(c"id")?;
    if same(f)?
        && !persist(
            p,
            id,
            patch(
                state(p, id)?,
                &[
                    ("retryAt", null(p)?),
                    ("retryCategory", null(p)?),
                    ("updatedAt", now(p)?),
                ],
            )?,
            false,
        )?
    {
        postpone(f)?;
    }
    Ok(())
}
fn retry<'a>(f: L<'a>, _: L<'a>) -> Result<L<'a>> {
    let p = f.get(c"host")?;
    let id = f.get(c"id")?;
    let at = now(p)?.explicit_number()?;
    let s = state(p, id)?;
    if !active(s)? || lifecycle::expire(p, id)? {
        return undef(f);
    }
    let retry_at = s.get(c"retryAt")?.explicit_number()?;
    if !retry_at.is_finite() || retry_at <= 0. {
        return undef(f);
    }
    if at < retry_at {
        arm(frame(p, id)?, c"retryTimers", retry_at - at, retry)?;
        return undef(f);
    }
    f.set(c"before", s)?;
    f.set(c"retryAt", num(p, retry_at)?)?;
    f.set(c"epoch", p.get(c"clockEpoch")?)?;
    let pending = async_result(f, || port(p, c"getSchedulerStatus", &[id]))?;
    call(
        pending,
        c"then",
        &[
            cont(f, admit)?,
            cont(f, |f, e| {
                log_err(f, "retry queue check failed", e)?;
                postpone(f)?;
                undef(f)
            })?,
        ],
    )
}
fn admit<'a>(f: L<'a>, status: L<'a>) -> Result<L<'a>> {
    let p = f.get(c"host")?;
    let id = f.get(c"id")?;
    if !same(f)? || lifecycle::expire(p, id)? {
        return undef(f);
    }
    if status.truthy()? && callable(p.get(c"kernel")?.get(c"selectQueued")?)? {
        match turns::probe(p, status) {
            Ok(probe) => {
                if probe.get(c"handoffPending")?.is_true()? {
                    effects::withdraw_ids(p, id, probe.get(c"faultEntryIds")?)?;
                    postpone(f)?;
                    return undef(f);
                }
            }
            Err(e) => {
                log_err(f, "retry selection failed", caught(p, e)?)?;
                postpone(f)?;
                return undef(f);
            }
        }
    }
    if port(p, c"busy", &[id])?.is_true()? || !callable(p.get(c"inject")?)? {
        consume(f)?;
        return undef(f);
    }
    let s = state(p, id)?;
    let parts = arr(p)?;
    call(
        parts,
        c"push",
        &[
            text(p, "unattended-fault")?,
            id,
            s.get(c"startedAt")?,
            s.get(c"lastTurnEndId")?,
            f.get(c"retryAt")?,
        ],
    )?;
    let key = call(p.global()?.get(c"JSON")?, c"stringify", &[parts])?;
    if store(p, c"admittingRetries", c"has", &[key])?.truthy()? {
        return undef(f);
    }
    store(p, c"admittingRetries", c"add", &[key])?;
    f.set(c"key", key)?;
    f.set(c"faultEpoch", store(p, c"faultEpoch", c"get", &[id])?)?;
    let pending = async_result(f, || {
        let count = str_or(s.get(c"stall")?.optional(c"consecutiveFaults")?, "1")?;
        effects::trace(
            p,
            id,
            tagged(p, &format!("故障后自动继续（第 {count} 次）"))?,
        )?;
        port(
            p,
            c"inject",
            &[
                id,
                tagged(p, &js(rule(p, c"faultInstruction", &[])?)?)?,
                fields(
                    p,
                    &[
                        ("unattendedRecovery", flag(p, true)?),
                        ("idempotencyKey", key),
                    ],
                )?,
            ],
        )
    })?;
    let done = then(f, pending, |f, r| {
        let p = f.get(c"host")?;
        let id = f.get(c"id")?;
        if !same(f)? {
            let entry = r.optional(c"entry")?.optional(c"id")?;
            if entry.truthy()? && !r.optional(c"duplicate")?.truthy()? {
                let ids = arr(p)?;
                call(ids, c"push", &[entry])?;
                effects::withdraw_ids(p, id, ids)?;
            }
            return undef(f);
        }
        if r.is_false()? || r.optional(c"ok")?.is_false()? {
            postpone(f)?;
        } else {
            effects::receipt(f, r, true)?;
            consume(f)?;
        }
        undef(f)
    })?;
    let done = rescue(f, done, |f, e| {
        log_err(f, "retry admission failed", e)?;
        postpone(f)?;
        undef(f)
    })?;
    call(
        done,
        c"finally",
        &[function(f, "", 0, 0, |f, _| {
            let p = f.get(c"host")?;
            if f.get(c"epoch")?.equals(p.get(c"clockEpoch")?)? {
                store(p, c"admittingRetries", c"delete", &[f.get(c"key")?])?;
            }
            undef(p)
        })?],
    )
}
fn owed(f: L<'_>) -> Result<bool> {
    let p = f.get(c"host")?;
    let s = state(p, f.get(c"id")?)?;
    Ok(current(f)?
        && active(s)?
        && f.get(c"epoch")?.equals(p.get(c"clockEpoch")?)?
        && s.get(c"lastTurnEndId")?.equals(f.get(c"turn")?)?
        && s.get(c"lastSettleAt")?.equals(f.get(c"settle")?)?)
}
pub(super) fn backlog<'a>(p: L<'a>, id: L<'a>, d: L<'a>, attempt: f64) -> Result<()> {
    let delay = d.get(c"recheckAfterMs")?.explicit_number()?;
    let max = d.get(c"recheckMaxAttempts")?.explicit_number()?;
    if !delay.is_finite() || delay <= 0. || !max.is_finite() || max <= 0. {
        return Ok(());
    }
    clear(p, id, c"backlogRechecks")?;
    if attempt >= max {
        return log(
            p,
            &format!(
                "backlog recheck gave up for {} after {attempt} attempts",
                js(id)?
            ),
        );
    }
    let s = state(p, id)?;
    if !active(s)? {
        return Ok(());
    }
    let f = frame(p, id)?;
    for (key, val) in [
        (c"turn", s.get(c"lastTurnEndId")?),
        (c"settle", s.get(c"lastSettleAt")?),
        (c"attempt", num(p, attempt + 1.)?),
        (c"decision", d),
        (c"epoch", p.get(c"clockEpoch")?),
    ] {
        f.set(key, val)?;
    }
    arm(f, c"backlogRechecks", delay, |f, _| {
        let p = f.get(c"host")?;
        let id = f.get(c"id")?;
        if !owed(f)?
            || lifecycle::expire(p, id)?
            || port(p, c"busy", &[id])?.is_true()?
            || store(p, c"inFlight", c"has", &[id])?.truthy()?
            || state(p, id)?.get(c"evaluating")?.is_true()?
        {
            return undef(f);
        }
        then(f, evaluation::deferred(p, id)?, |f, wait| {
            let p = f.get(c"host")?;
            let id = f.get(c"id")?;
            if !owed(f)? {
                return undef(f);
            }
            if wait.truthy()? {
                backlog(
                    p,
                    id,
                    f.get(c"decision")?,
                    f.get(c"attempt")?.explicit_number()?,
                )?;
                undef(f)
            } else {
                evaluation::evaluate(
                    p,
                    id,
                    fields(p, &[("reason", text(p, "backlog_recheck")?)])?,
                )
            }
        })
    })
}
