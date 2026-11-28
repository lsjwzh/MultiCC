use super::*;
pub(super) fn result<'a>(
    p: L<'a>,
    attempted: bool,
    committed: bool,
    code: L<'a>,
    error: L<'a>,
    observer: L<'a>,
) -> Result<L<'a>> {
    frozen(
        p,
        &[
            ("attempted", flag(p, attempted)?),
            ("committed", flag(p, committed)?),
            ("code", fallback(code, V::Null)?),
            ("error", fallback(error, V::Null)?),
            ("observerError", fallback(observer, V::Null)?),
        ],
    )
}
fn snapshot(v: L<'_>) -> Result<L<'_>> {
    if object(v)? && !v.is_array()? {
        spread(v)?.freeze()
    } else {
        obj(v)?.freeze()
    }
}
pub(in crate::chat_host) fn run<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let i = default_object(a[0])?;
    let t = i.get(c"turn")?;
    let r = i.get(c"runner")?;
    let identity = i.get(c"identityOnly")?.is_true()?;
    let owns = || -> Result<bool> { Ok(identity || current(s, i)?) };
    let simple = |attempted, committed, code: &str| {
        result(s, attempted, committed, text(s, code)?, null(s)?, null(s)?)
    };
    if !owns()? {
        return simple(false, false, "stale_runner");
    }
    if !t.truthy()? || !r.truthy()? {
        return simple(false, false, "result_not_durable");
    }
    if identity {
        if !r.get(c"turnId")?.truthy()? || !r.get(c"turnId")?.equals(t.get(c"turnId")?)? {
            return simple(false, false, "result_owned_by_other_runner");
        }
    } else {
        if !t.get(c"resultDurable")?.is_true()? {
            return simple(false, false, "result_not_durable");
        }
        if !t.get(c"resultRunnerId")?.equals(r.get(c"runnerId")?)? {
            return simple(false, false, "result_owned_by_other_runner");
        }
    }
    if r.get(c"usageRecorded")?.is_true()? {
        return simple(false, true, "usage_already_recorded");
    }
    if !life(s, c"reserveUsageWrite", &[r])?.is_true()? {
        return simple(false, false, "usage_in_flight");
    }
    let out = (|| {
        let id = call(
            text(s, "usage:")?,
            c"concat",
            &[
                string(t.get(c"turnId")?)?,
                text(s, ":")?,
                string(r.get(c"runnerId")?)?,
            ],
        )?;
        let next = frozen(
            s,
            &[
                ("sessionId", t.get(c"sessionId")?),
                ("turnId", t.get(c"turnId")?),
                ("runnerId", r.get(c"runnerId")?),
                ("idempotencyKey", id),
                ("attribution", snapshot(i.get(c"attribution")?)?),
                ("usage", snapshot(i.get(c"usage")?)?),
            ],
        )?;
        let context = choose(r.get(c"usageCommitContext")?, next)?;
        if !owns()? {
            return simple(false, false, "stale_runner");
        }
        let port = s.get(c"ports")?.get(c"usage")?;
        if !r.get(c"legacyUsageRecorded")?.is_true()? {
            let write = || -> Result<bool> {
                let input = pick(
                    context,
                    &[
                        c"sessionId",
                        c"turnId",
                        c"runnerId",
                        c"idempotencyKey",
                        c"attribution",
                        c"usage",
                    ],
                )?
                .freeze()?;
                success(call(port, c"commit", &[input])?)
            };
            match write() {
                Ok(true) => {}
                Ok(false) => return simple(true, false, "usage_commit_failed"),
                Err(e) => {
                    return result(
                        s,
                        true,
                        false,
                        text(s, "usage_commit_failed")?,
                        err_message(s, exception(s, e)?, "usage commit failed")?,
                        null(s)?,
                    )
                }
            }
            r.assign(c"legacyUsageRecorded", flag(s, true)?)?;
            r.assign(c"usageCommitContext", context)?;
        }
        if !owns()? {
            return simple(true, true, "stale_runner");
        }
        let claimed = life(
            s,
            c"claimDurableUsage",
            &[r, fields(s, &[("resultDurable", flag(s, true)?)])?],
        )?;
        if !claimed.get(c"ok")?.truthy()? {
            return result(s, true, true, claimed.get(c"code")?, null(s)?, null(s)?);
        }
        if !owns()? {
            return simple(true, true, "stale_runner");
        }
        let mut observer = null(s)?;
        if port.get(c"afterCommit")?.truthy()? {
            let notify = || {
                call(
                    port,
                    c"afterCommit",
                    &[frozen(
                        s,
                        &[
                            ("sessionId", t.get(c"sessionId")?),
                            ("turnId", t.get(c"turnId")?),
                            ("runnerId", r.get(c"runnerId")?),
                            ("attribution", context.get(c"attribution")?),
                        ],
                    )?],
                )
            };
            if let Err(e) = notify() {
                observer = err_message(s, exception(s, e)?, "usage observer failed")?;
            }
        }
        result(
            s,
            true,
            true,
            if owns()? {
                null(s)?
            } else {
                text(s, "stale_runner")?
            },
            null(s)?,
            observer,
        )
    })();
    // Clear a pending V8 exception before the finalizer re-enters JS, then throw
    // the same value again (including a caller's throwing getter).
    let outcome = match out {
        Ok(v) => Ok(v),
        Err(e) => Err(exception(s, e)?),
    };
    life(s, c"releaseUsageWrite", &[r])?;
    outcome.map_err(|e| e.throw_error())
}
