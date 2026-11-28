use super::*;

pub(super) fn result<'a>(
    p: L<'a>,
    attempted: bool,
    persisted: bool,
    durable: bool,
    partial: bool,
    code: L<'a>,
    err: L<'a>,
) -> Result<L<'a>> {
    frozen(
        p,
        &[
            ("attempted", flag(p, attempted)?),
            ("persisted", flag(p, persisted)?),
            ("durable", flag(p, durable)?),
            ("partial", flag(p, partial)?),
            ("code", fallback(code, V::Null)?),
            ("error", fallback(err, V::Null)?),
        ],
    )
}
fn early<'a>(p: L<'a>, code: &str, persisted: bool, durable: bool, partial: bool) -> Result<L<'a>> {
    result(
        p,
        false,
        persisted,
        durable,
        partial,
        text(p, code)?,
        null(p)?,
    )
}
fn release(c: L<'_>) -> Result<()> {
    life(c.get(c"s")?, c"releaseResultAppend", &[c.get(c"turn")?])?;
    Ok(())
}
fn done<'a>(c: L<'a>, persisted: bool, error: L<'a>) -> Result<L<'a>> {
    let s = c.get(c"s")?;
    let i = c.get(c"input")?;
    let turn = c.get(c"turn")?;
    let runner = c.get(c"runner")?;
    let final_row = c.get(c"final")?.is_true()?;
    if persisted
        && final_row
        && !life(
            s,
            c"recordConfirmedResult",
            &[turn, runner, c.get(c"appendInput")?.get(c"runnerId")?],
        )?
        .is_true()?
    {
        return result(
            s,
            true,
            true,
            false,
            false,
            text(s, "result_receipt_conflict")?,
            null(s)?,
        );
    }
    if !current(s, i)? {
        return result(
            s,
            true,
            persisted,
            false,
            !final_row,
            text(s, "stale_runner")?,
            null(s)?,
        );
    }
    let facts = fields(
        s,
        &[
            ("current", flag(s, true)?),
            ("persisted", flag(s, persisted)?),
        ],
    )?;
    let k = if c.get(c"boundary")?.is_string("result")? {
        c"recordResultEvent"
    } else {
        facts.set(c"final", flag(s, final_row)?)?;
        c"recordCloseResult"
    };
    let proof = life(s, k, &[turn, runner, facts])?;
    let checkpoint = c.get(c"checkpoint")?;
    if persisted && !final_row && checkpoint.truthy()? {
        life(
            s,
            c"recordPartialCheckpoint",
            &[
                turn,
                runner,
                fields(
                    s,
                    &[
                        ("current", flag(s, true)?),
                        ("persisted", flag(s, true)?),
                        ("checkpointKey", checkpoint),
                    ],
                )?,
            ],
        )?;
    }
    result(
        s,
        true,
        persisted,
        proof.get(c"resultDurable")?.is_true()?,
        !final_row,
        if error.truthy()? {
            text(s, "append_failed")?
        } else {
            proof.get(c"code")?
        },
        error,
    )
}
fn settled<'a>(c: L<'a>, res: Result<L<'a>>) -> Result<L<'a>> {
    // Finalizers call back into V8. Preserve a pending getter exception while
    // releasing the reservation and rethrow the same value afterwards.
    let outcome = match res {
        Ok(v) => Ok(v),
        Err(e) => Err(exception(c, e)?),
    };
    release(c)?;
    outcome.map_err(|e| e.throw_error())
}
fn after<'a>(c: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let outcome = (|| match success(a[0]) {
        Ok(persisted) => done(c, persisted, null(c)?),
        Err(e) => done(c, false, err_message(c, exception(c, e)?, "append failed")?),
    })();
    settled(c, outcome)
}
fn failed<'a>(c: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let outcome = (|| done(c, false, err_message(c, a[0], "append failed")?))();
    settled(c, outcome)
}
fn work<'a>(c: L<'a>, saved: L<'a>) -> Result<(L<'a>, bool)> {
    let s = c.get(c"s")?;
    let i = c.get(c"input")?;
    let t = c.get(c"turn")?;
    let r = c.get(c"runner")?;
    let is_event = i.get(c"boundary")?.is_string("result")?;
    let boundary = text(s, if is_event { "result" } else { "close" })?;
    if is_event {
        r.assign(c"resultEvent", flag(s, true)?)?;
    }
    if saved.truthy()? {
        if !current(s, i)? {
            return Ok((early(s, "stale_runner", false, false, false)?, false));
        }
        let proof = life(
            s,
            c"recordCloseResult",
            &[
                t,
                r,
                fields(
                    s,
                    &[
                        ("current", flag(s, true)?),
                        ("persisted", flag(s, true)?),
                        ("final", flag(s, true)?),
                    ],
                )?,
            ],
        )?;
        return Ok((
            early(
                s,
                "already_durable",
                true,
                proof.get(c"resultDurable")?.is_true()?,
                false,
            )?,
            false,
        ));
    }
    let final_row = is_event || finality(s, r, i.get(c"facts")?)?.get(c"final")?.is_true()?;
    let key = i.get(c"checkpointKey")?.clean_text()?;
    if !final_row
        && key.truthy()?
        && life(s, c"hasMatchingPartialCheckpoint", &[r, key])?.is_true()?
    {
        return Ok((
            early(s, "partial_already_durable", true, false, true)?,
            false,
        ));
    }
    if !i.get(c"message")?.truthy()? {
        if is_event {
            life(
                s,
                c"recordResultEvent",
                &[
                    t,
                    r,
                    fields(
                        s,
                        &[("current", flag(s, true)?), ("persisted", flag(s, false)?)],
                    )?,
                ],
            )?;
        }
        return Ok((
            early(s, "message_required", false, false, !final_row)?,
            false,
        ));
    }
    if !current(s, i)? {
        return Ok((early(s, "stale_runner", false, false, false)?, false));
    }
    c.set(c"boundary", boundary)?;
    c.set(c"checkpoint", key)?;
    c.set(c"final", flag(s, final_row)?)?;
    let write = || -> Result<L<'a>> {
        let msg = frozen(
            s,
            &[
                ("sessionId", t.get(c"sessionId")?),
                ("turnId", t.get(c"turnId")?),
                ("runnerId", r.get(c"runnerId")?),
                ("runnerKind", r.get(c"kind")?),
                ("boundary", boundary),
                ("final", flag(s, final_row)?),
                ("partial", flag(s, !final_row)?),
                ("checkpointKey", fallback(key, V::Null)?),
                ("message", i.get(c"message")?),
            ],
        )?;
        c.set(c"appendInput", msg)?;
        call(s.get(c"ports")?.get(c"history")?, c"appendFinal", &[msg])
    };
    let value = match write() {
        Ok(v) => v,
        Err(e) => {
            return Ok((
                done(c, false, err_message(c, exception(c, e)?, "append failed")?)?,
                false,
            ))
        }
    };
    let promise = call(
        resolved(value)?,
        c"then",
        &[
            function(c, "onAppended", 1, 1, after)?,
            function(c, "onAppendFailed", 1, 1, failed)?,
        ],
    )?;
    Ok((promise, true))
}
pub(in crate::chat_host) fn run<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(s, || {
        let i = default_object(a[0])?;
        let t = i.get(c"turn")?;
        let r = i.get(c"runner")?;
        if !current(s, i)? {
            return early(s, "stale_runner", false, false, false);
        }
        if !t.truthy()? || !r.truthy()? {
            return early(s, "runner_required", false, false, false);
        }
        let saved = life(s, c"confirmedResult", &[t])?;
        if saved.truthy()?
            && (!saved.get(c"runner")?.equals(r)?
                || !saved.get(c"runnerId")?.equals(r.get(c"runnerId")?)?)
        {
            return early(s, "result_owned_by_other_runner", false, false, false);
        }
        if t.get(c"resultDurable")?.truthy()? {
            if !t.get(c"resultRunnerId")?.equals(r.get(c"runnerId")?)? {
                return early(s, "result_owned_by_other_runner", false, false, false);
            }
            return early(s, "already_durable", true, true, false);
        }
        let c = fields(s, &[("s", s), ("input", i), ("turn", t), ("runner", r)])?;
        if !life(s, c"reserveResultAppend", &[t])?.truthy()? {
            return early(s, "result_append_in_flight", false, false, false);
        }
        match work(c, saved) {
            Ok((v, true)) => Ok(v),
            out => settled(c, out.map(|(v, _)| v)),
        }
    })
}
