use super::*;

// Each pass is sequential: a replay can durably settle a session and exclude
// it from the recovery pass before the next scheduler read begins.
pub(super) fn reconcile(p: L<'_>) -> Result<L<'_>> {
    let ids = p
        .catch(|| {
            call(
                p.global()?.get(c"Array")?,
                c"from",
                &[or(port(p, c"listSessionIds", &[])?, arr(p)?)?],
            )
        })?
        .unwrap_or(arr(p)?);
    let out = fields(
        p,
        &[
            ("settled", arr(p)?),
            ("failed", arr(p)?),
            ("failedIds", arr(p)?),
        ],
    )?;
    let mut chain = resolved(undef(p)?)?;
    for recovery in [false, true] {
        ids.for_each(|id| {
            let f = fields(p, &[("host", p), ("id", id), ("out", out)])?;
            let cb = function(f, "", 1, 1, move |f, _| {
                let result = async_result(f, || inspect(f, recovery))?;
                let handler = function(f, "", 1, 1, move |f, a| {
                    let id = f.get(c"id")?;
                    let out = f.get(c"out")?;
                    call(
                        out.get(c"failed")?,
                        c"push",
                        &[fields(f, &[("sessionId", id), ("error", a[0])])?],
                    )?;
                    call(out.get(c"failedIds")?, c"push", &[id])?;
                    log_err(
                        f,
                        if recovery {
                            "startup recovery failed"
                        } else {
                            "startup reconcile failed"
                        },
                        a[0],
                    )?;
                    undef(f)
                })?;
                call(result, c"catch", &[handler])
            })?;
            chain = call(chain, c"then", &[cb])?;
            Ok(())
        })?;
    }
    let f = fields(p, &[("host", p), ("out", out)])?;
    then(f, chain, |f, _| {
        let out = f.get(c"out")?;
        let ids = out.get(c"failedIds")?;
        let count = ids.get(c"length")?.explicit_number()?;
        if count > 0. {
            log(
                f.get(c"host")?,
                &format!(
                    "startup reconcile: {count} session(s) failed: {}",
                    js(call(ids, c"join", &[text(f, ", ")?])?)?
                ),
            )?;
        }
        Ok(out)
    })
}
fn inspect(f: L<'_>, recovery: bool) -> Result<L<'_>> {
    let p = f.get(c"host")?;
    let id = f.get(c"id")?;
    if recovery && store(p, c"bootRecovered", c"has", &[id])?.truthy()? {
        return undef(f);
    }
    let record = if recovery {
        port(p, c"getRecord", &[id])?
    } else {
        p.catch(|| port(p, c"getRecord", &[id]))?
            .unwrap_or(null(p)?)
    };
    let s = record.optional(c"unattended")?;
    if !active(s)? {
        return undef(f);
    }
    f.set(c"record", record)?;
    f.set(c"generation", store(p, c"generations", c"get", &[id])?)?;
    let task = or(
        p.catch(|| port(p, c"getTaskState", &[id]))?
            .unwrap_or(null(p)?),
        obj(p)?,
    )?;
    if recovery {
        f.set(c"classify", task.get(c"classifyState")?)?;
        f.set(c"busy", port(p, c"busy", &[id])?)?;
        return then(f, port(p, c"backlog", &[id])?, |f, queued| {
            if queued.truthy()? {
                recover(f, queued)
            } else {
                then(
                    f,
                    port(f.get(c"host")?, c"safeSchedulerStatus", &[f.get(c"id")?])?,
                    |f, status| recover(f, flag(f, status.optional(c"active")?.truthy()?)?),
                )
            }
        });
    }
    let cancelled = task.get(c"cancelledAt")?.explicit_number()?;
    let source = task.get(c"cancelSource")?;
    if !cancelled.is_finite() || cancelled == 0. || !source.truthy()? {
        return undef(f);
    }
    let number = |v| -> Result<f64> { fallback(v, V::Number(0.))?.explicit_number() };
    let at = number(task.get(c"endedAt")?)?.max(cancelled);
    if !(at > number(s.get(c"startedAt")?)? && at > number(s.get(c"lastSettleAt")?)?) {
        return undef(f);
    }
    let facts = fields(
        p,
        &[
            ("kind", text(p, "cancel")?),
            ("settle", text(p, "E")?),
            ("turnId", fallback(task.get(c"turnId")?, V::from(""))?),
            ("cancelSource", source),
            ("killReason", or(task.get(c"cancelReason")?, source)?),
        ],
    )?;
    f.set(c"facts", facts)?;
    f.set(c"settledAt", num(p, at)?)?;
    then(f, port(p, c"safeSchedulerStatus", &[id])?, |f, status| {
        if !current(f)? || status.optional(c"active")?.truthy()? {
            return undef(f);
        }
        let state = state(f.get(c"host")?, f.get(c"id")?)?;
        if !active(state)?
            || fallback(state.get(c"lastSettleAt")?, V::Number(0.))?.explicit_number()?
                >= f.get(c"settledAt")?.explicit_number()?
        {
            return undef(f);
        }
        replay(f, f.get(c"facts")?)
    })
}
fn recover<'a>(f: L<'a>, queued: L<'a>) -> Result<L<'a>> {
    let p = f.get(c"host")?;
    let id = f.get(c"id")?;
    if !current(f)? || store(p, c"bootRecovered", c"has", &[id])?.truthy()? {
        return undef(f);
    }
    let s = state(p, id)?;
    if !active(s)? {
        return undef(f);
    }
    let d = rule(
        p,
        c"bootRecover",
        &[fields(
            p,
            &[
                ("state", s),
                ("classifyState", f.get(c"classify")?),
                ("runActive", f.get(c"busy")?),
                ("queued", queued),
                ("now", now(p)?),
            ],
        )?],
    )?;
    if !d.optional(c"recover")?.is_true()? {
        return undef(f);
    }
    replay(
        f,
        fields(
            p,
            &[
                ("kind", text(p, "fault")?),
                ("settle", text(p, "E")?),
                ("turnId", text(p, "")?),
            ],
        )?,
    )
}
fn replay<'a>(f: L<'a>, facts: L<'a>) -> Result<L<'a>> {
    let p = f.get(c"host")?;
    let id = f.get(c"id")?;
    store(p, c"bootRecovered", c"add", &[id])?;
    then(f, turns::end(p, id, facts)?, |f, r| {
        if r.truthy()?
            && !(r.get(c"ok")?.is_false()? && r.get(c"code")?.is_string("duplicate_turn")?)
        {
            call(f.get(c"out")?.get(c"settled")?, c"push", &[r])?;
        }
        undef(f)
    })
}
