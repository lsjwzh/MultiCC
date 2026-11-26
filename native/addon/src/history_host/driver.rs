use super::*;

fn deleted(p: L<'_>) -> Result<L<'_>> {
    coded(
        p,
        "chat_history_session_deleted",
        "CHAT_HISTORY_SESSION_DELETED",
    )
}
fn deliver<'a>(list: L<'a>, method: &CStr, value: L<'a>) -> Result<()> {
    list.for_each(|w| {
        call(w, method, &[value])?;
        Ok(())
    })
}
fn settle<'a>(p: L<'a>, id: L<'a>, op: L<'a>, method: &CStr, value: L<'a>) -> Result<()> {
    let waiters = p.get(c"waiters")?;
    let pending = call(waiters, c"get", &[id])?;
    if !pending.truthy()? {
        return Ok(());
    }
    let list = call(pending, c"get", &[op])?;
    if list.truthy()? {
        call(pending, c"delete", &[op])?;
        if !pending.get(c"size")?.truthy()? {
            call(waiters, c"delete", &[id])?;
        }
        deliver(list, method, value)?;
    }
    Ok(())
}
pub(super) fn fail_waiters<'a>(p: L<'a>, id: L<'a>, reason: L<'a>) -> Result<L<'a>> {
    let waiters = p.get(c"waiters")?;
    let pending = call(waiters, c"get", &[id])?;
    if pending.truthy()? {
        call(waiters, c"delete", &[id])?;
        call(pending, c"values", &[])?.for_each(|list| deliver(list, c"reject", reason))?;
    }
    undefined(p)
}
fn cancel<'a>(p: L<'a>, id: L<'a>, result: L<'a>) -> Result<()> {
    let cancelled = result.optional(c"cancelled")?;
    if cancelled.is_array()? {
        cancelled.for_each(|op| settle(p, id, op, c"reject", deleted(p)?))?;
    }
    Ok(())
}
pub(super) fn mutate<'a>(p: L<'a>, id: L<'a>, kind: L<'a>, payload: L<'a>) -> Result<L<'a>> {
    let id = string(id)?;
    let enqueued = match run(p, "enqueueMutation", &[id, kind, payload]) {
        Ok(r) => r,
        Err(e) => {
            let reason = caught(p, e)?;
            if reason
                .optional(c"message")?
                .is_string("chat_history_session_deleted")?
            {
                return call(p.global()?.get(c"Promise")?, c"reject", &[deleted(p)?]);
            }
            return Err(reason.throw_error());
        }
    };
    cancel(p, id, enqueued)?;
    let op = enqueued.get(c"operationId")?;
    let promise = p.global()?.get(c"Promise")?;
    if op.nullish()? {
        return call(promise, c"resolve", &[flag(p, true)?]);
    }
    let waiters = p.get(c"waiters")?;
    let mut pending = call(waiters, c"get", &[id])?;
    if !pending.truthy()? {
        pending = p.global()?.get(c"Map")?.construct(&[])?;
        call(waiters, c"set", &[id, pending])?;
    }
    let mut list = call(pending, c"get", &[op])?;
    if !list.truthy()? {
        list = array(p, &[])?;
        call(pending, c"set", &[op, list])?;
    }
    let waiter = call(promise, c"withResolvers", &[])?;
    call(list, c"push", &[waiter])?;
    driver_start(p, id)?;
    waiter.get(c"promise")
}
fn perform(f: L<'_>) -> Result<L<'_>> {
    let p = f.get(c"ports")?;
    let step = f.get(c"step")?;
    let id = step.get(c"sessionId")?;
    let payload = step.get(c"payload")?;
    let history = deps(p)?.get(c"history")?;
    let method = step.get(c"method")?;
    if method.is_string("visibility")? {
        return call(history, c"writeVisibilityAsync", &[id, payload]);
    }
    if !method.is_string("transcript")? {
        let message = string(method)?.coerce_string()?.to_string_lossy();
        return Err(napi::Error::from_reason(format!(
            "unknown chat history write step: {message}"
        )));
    }
    if payload.kind()? == sys::ValueType::napi_string {
        return call(history, c"writeAsync", &[id, payload]);
    }
    then(f, call(history, c"appendAsync", &[id, payload])?, |f, r| {
        if r.optional(c"conflict")?.is_true()? {
            return Err(coded(
                f,
                "chat history changed during append",
                "CHAT_HISTORY_CONCURRENT_MODIFICATION",
            )?
            .throw_error());
        }
        if r.optional(c"appended")?.is_false()? {
            let p = f.get(c"ports")?;
            let step = f.get(c"step")?;
            let resend = run(p, "resendPendingWrite", &[step.get(c"operationId")?])?;
            return call(
                deps(p)?.get(c"history")?,
                c"writeAsync",
                &[step.get(c"sessionId")?, resend.get(c"messagesJson")?],
            );
        }
        Ok(r)
    })
}
fn effects<'a>(p: L<'a>, id: L<'a>, items: L<'a>) -> Result<bool> {
    let mut first = None;
    if items.is_array()? {
        items.for_each(|effect| {
            if let Err(e) = call(deps(p)?, c"chatBroadcast", &[id, effect.get(c"payload")?]) {
                let reason = caught(p, e)?;
                let event = effect.get(c"logEvent")?;
                first.get_or_insert(event.is_string("chat_history_annotation_failed")?);
                if run(
                    p,
                    "logFailure",
                    &[
                        fallback(event, V::from("chat_history_broadcast_failed"))?,
                        reason,
                        id,
                    ],
                )
                .is_err()
                {
                    p.exception_value()?;
                }
            }
            Ok(())
        })?;
    }
    Ok(first.unwrap_or(false))
}
fn complete<'a>(f: L<'a>, ok: bool, value: L<'a>) -> Result<L<'a>> {
    let p = f.get(c"ports")?;
    let id = f.get(c"id")?;
    let op = f.get(c"step")?.get(c"operationId")?;
    let (reason, meta) = if ok {
        (null(p)?, value)
    } else {
        (value, null(p)?)
    };
    let after = run(
        p,
        "completeMutationStep",
        &[id, op, flag(p, ok)?, reason, meta],
    )?;
    if reason
        .optional(c"code")?
        .is_string("CHAT_HISTORY_CONCURRENT_MODIFICATION")?
    {
        call(p.get(c"service")?, c"invalidate", &[id])?;
    }
    let annotation_failed = effects(p, id, after.get(c"effects")?)?;
    if after.get(c"finished")?.is_true()? {
        if after.get(c"failed")?.is_true()? {
            let err = if ok { after.get(c"result")? } else { reason };
            settle(p, id, op, c"reject", err)?;
        } else {
            let result = if annotation_failed {
                array(p, &[])?
            } else {
                after.get(c"result")?
            };
            settle(p, id, op, c"resolve", result)?;
        }
    }
    undefined(p)
}
/// Consume all immediately ready completions. Return the pending I/O Promise
/// at the first write, or null when this session's driver can detach.
pub(super) fn advance<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    loop {
        let step = run(p, "nextMutationStep", &[id])?;
        if !step.truthy()? || step.get(c"type")?.is_string("idle")? {
            return null(p);
        }
        if step.get(c"type")?.is_string("done")? {
            cancel(p, id, step)?;
            let failed = step.get(c"failed")?.is_true()?;
            settle(
                p,
                id,
                step.get(c"operationId")?,
                if failed { c"reject" } else { c"resolve" },
                if failed {
                    step.get(c"error")?
                } else {
                    step.get(c"result")?
                },
            )?;
            continue;
        }
        let f = frame(p, id)?;
        f.set(c"step", step)?;
        let wait = async_result(f, || perform(f))?;
        return call(
            wait,
            c"then",
            &[
                continuation(f, |f, v| complete(f, true, v))?,
                continuation(f, |f, e| complete(f, false, e))?,
            ],
        );
    }
}
