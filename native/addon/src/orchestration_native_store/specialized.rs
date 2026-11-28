use super::*;

#[path = "canonical.rs"]
mod canonical;
pub(super) use canonical::capture;
fn prototype(s: L<'_>) -> Result<L<'_>> {
    s.global()?.get(c"Object")?.get(c"prototype")
}
fn inherited(s: L<'_>, id: L<'_>) -> Result<bool> {
    call(s.global()?.get(c"Reflect")?, c"has", &[prototype(s)?, id])?.truthy()
}
fn proxy(s: L<'_>, v: L<'_>) -> Result<bool> {
    s.get(c"ports")?.get(c"isProxy")?.call_plain(&[v])?.truthy()
}
fn objectish(v: L<'_>) -> Result<bool> {
    Ok(matches!(
        v.kind()?,
        sys::ValueType::napi_object | sys::ValueType::napi_function
    ))
}
fn fallback(f: L<'_>) -> Result<L<'_>> {
    transaction::mutate_in_slot(f.get(c"s")?, f.get(c"legacy")?)
}
fn admit_fallback(f: L<'_>) -> Result<L<'_>> {
    yes(f, fallback(f)?, |f, r| {
        fields(f, &[("legacy", flag(f, true)?), ("value", r)])
    })
}
fn refresh_revision(s: L<'_>) -> Result<()> {
    revision(s, request(s, "info", fields(s, &[])?)?)
}
fn end(s: L<'_>) -> Result<()> {
    request(s, "end", fields(s, &[])?)?;
    s.set(c"metrics", request(s, "metrics", fields(s, &[])?)?)
}
fn guarded<'a>(f: L<'a>, asynchronous: bool, run: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    let s = f.get(c"s")?;
    f.set(c"expected", s.get(c"revision")?)?;
    f.set(c"header", request(s, "begin", fields(s, &[])?)?)?;
    let finish_error = |s: L<'a>, reason: L<'a>| -> Result<L<'a>> {
        request(s, "end", fields(s, &[])?)?;
        refresh_revision(s)?;
        end(s)?;
        Err(reason.throw_error())
    };
    let r = match run() {
        Ok(r) => r,
        Err(err) => {
            if let Some(e) = s.exception_value()? {
                return finish_error(s, e);
            }
            end(s)?;
            return Err(err);
        }
    };
    if asynchronous {
        let ok = cb(f, 1, |f, a| {
            let v = f.get(c"view")?;
            if v.truthy()? {
                view::revoke(v)?;
            }
            end(f.get(c"s")?)?;
            Ok(a[0])
        })?;
        let bad = cb(f, 1, |f, a| {
            let s = f.get(c"s")?;
            request(s, "end", fields(s, &[])?)?;
            refresh_revision(s)?;
            let v = f.get(c"view")?;
            if v.truthy()? {
                view::revoke(v)?;
            }
            end(s)?;
            Err(a[0].throw_error())
        })?;
        call(resolve(r)?, c"then", &[ok, bad])
    } else {
        end(s)?;
        Ok(r)
    }
}
fn simple_key(f: L<'_>) -> Result<Option<L<'_>>> {
    let id = f.get(c"id")?;
    if objectish(id)? || id.kind()? == sys::ValueType::napi_symbol {
        return Ok(None);
    }
    let id = string(id)?;
    if inherited(f, id)? {
        Ok(None)
    } else {
        Ok(Some(id))
    }
}
fn clock(f: L<'_>) -> Result<L<'_>> {
    num(f, f.get(c"clock")?.call_plain(&[])?.explicit_number()?)
}
fn cancel(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"s")?;
    let Some(id) = simple_key(f)? else {
        return fallback(f);
    };
    guarded(f, false, || {
        let check = request(s, "waitCancelCheck", fields(f, &[("id", id)])?)?;
        if !check.get(c"pending")?.truthy()? {
            let r = check.get(c"result")?;
            if r.get(c"code")?.is_string("not_pending")? {
                let raw = check.get(c"statusJson")?;
                r.set(
                    c"status",
                    if raw.nullish()? {
                        undefined(s)?
                    } else {
                        parse(raw)?
                    },
                )?
            }
            request(s, "noop", fields(s, &[])?)?;
            return Ok(r);
        }
        let r = request(
            s,
            "waitCancelCommit",
            fields(
                s,
                &[
                    ("id", id),
                    ("expectedRevision", f.get(c"expected")?),
                    ("at", clock(f)?),
                    ("updatedAt", now(s)?),
                ],
            )?,
        )?;
        refresh_revision(s)?;
        Ok(r)
    })
}
fn running(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"s")?;
    let id = f.get(c"id")?;
    let patch = f.get(c"patch")?;
    if objectish(id)?
        || id.kind()? == sys::ValueType::napi_symbol
        || patch.kind()? != sys::ValueType::napi_object
        || proxy(s, patch)?
        || patch.is_array()?
    {
        return fallback(f);
    }
    let obj = s.global()?.get(c"Object")?;
    let proto = call(obj, c"getPrototypeOf", &[patch])?;
    if !proto.nullish()? && !proto.equals(prototype(s)?)? {
        return fallback(f);
    }
    let id = string(id)?;
    if inherited(s, id)? {
        return fallback(f);
    }
    let desc = call(obj, c"getOwnPropertyDescriptors", &[patch])?;
    for key in [c"pid", c"externalId"] {
        let d = desc.get(key)?;
        if (!d.truthy()? && patch.has(key)?) || (d.truthy()? && !has(d, "value")?) {
            return fallback(f);
        }
        let val = d.optional(c"value")?;
        if !val.nullish()?
            && !matches!(
                val.kind()?,
                sys::ValueType::napi_string
                    | sys::ValueType::napi_number
                    | sys::ValueType::napi_boolean
            )
        {
            return fallback(f);
        }
    }
    guarded(f, false, || {
        let pid = desc.get(c"pid")?.optional(c"value")?;
        let n = if pid.nullish()? {
            None
        } else {
            Some(pid.explicit_number()?)
        };
        let ext = desc.get(c"externalId")?.optional(c"value")?;
        let input = fields(
            s,
            &[
                ("id", id),
                ("pidFinite", flag(s, n.is_some_and(f64::is_finite))?),
                (
                    "pid",
                    if let Some(n) = n {
                        num(s, n)?
                    } else {
                        null(s)?
                    },
                ),
                (
                    "externalJson",
                    if ext.truthy()? {
                        json(string(ext)?)?
                    } else {
                        null(s)?
                    },
                ),
            ],
        )?;
        let plan = request(s, "operationRunningPlan", input)?;
        if !plan.get(c"pending")?.truthy()? {
            request(s, "noop", fields(s, &[])?)?;
            return parse(plan.get(c"resultJson")?);
        }
        input.set(c"expectedRevision", f.get(c"expected")?)?;
        input.set(c"at", clock(f)?)?;
        input.set(c"updatedAt", now(s)?)?;
        let r = request(s, "operationRunningCommit", input)?;
        refresh_revision(s)?;
        parse(r.get(c"resultJson")?)
    })
}
fn settle(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"s")?;
    let id = f.get(c"id")?;
    let rid = f.get(c"request")?;
    if id.kind()? != sys::ValueType::napi_string
        || rid.kind()? != sys::ValueType::napi_string
        || inherited(s, id)?
    {
        return fallback(f);
    }
    let input = fields(s, &[("id", id), ("requestJson", json(rid)?)])?;
    guarded(f, true, || {
        let plan = request(s, "scheduleSettlePlan", input)?;
        if plan.get(c"legacy")?.truthy()? {
            request(s, "end", fields(s, &[])?)?;
            return fallback(f);
        }
        if !plan.get(c"pending")?.truthy()? {
            request(s, "noop", fields(s, &[])?)?;
            return plan.get(c"result");
        }
        input.set(c"expectedRevision", f.get(c"expected")?)?;
        input.set(c"at", clock(f)?)?;
        input.set(c"scheduleUpdatedAt", clock(f)?)?;
        input.set(c"updatedAt", now(s)?)?;
        let r = request(s, "scheduleSettleCommit", input)?;
        refresh_revision(s)?;
        Ok(r)
    })
}
fn outbox(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"s")?;
    let p = f.get(c"policy")?;
    let action = p.get(c"action")?;
    let recover = action.is_string("recover")?;
    let ack = action.is_string("ack")?;
    let real_error = if !recover && !ack {
        let r = p.get(c"reason")?;
        !r.nullish()?
            && !proxy(s, r)?
            && s.get(c"ports")?
                .get(c"isNativeError")?
                .call_plain(&[r])?
                .truthy()?
            && r.instance_of(s.global()?.get(c"Error")?)?
    } else {
        false
    };
    if p.get(c"customBackoff")?.truthy()?
        || !p
            .get(c"now")?
            .equals(s.global()?.get(c"Date")?.get(c"now")?)?
    {
        return fallback(f);
    }
    for field in [c"baseBackoffMs", c"maxBackoffMs"] {
        if !p
            .get(field)?
            .number_value()?
            .is_some_and(|n| (0. ..=1e15).contains(&n))
        {
            return fallback(f);
        }
    }
    if !recover
        && (p.get(c"customCrypto")?.truthy()?
            || p.get(c"id")?.kind()? != sys::ValueType::napi_string
            || inherited(s, p.get(c"id")?)?
            || p.get(c"token")?.kind()? != sys::ValueType::napi_string
            || (!ack && p.get(c"reason")?.kind()? != sys::ValueType::napi_string && !real_error)
            || (action.is_string("fail")?
                && p.get(c"retryable")?.kind()? != sys::ValueType::napi_boolean)
            || (action.is_string("defer")? && p.get(c"delayMs")?.number()? > 1e15))
    {
        return fallback(f);
    }
    guarded(f, true, || {
        let input = fields(
            s,
            &[
                ("at", num(s, call(p, c"now", &[])?.explicit_number()?)?),
                ("maxAttempts", p.get(c"maxAttempts")?),
                ("baseBackoffMs", p.get(c"baseBackoffMs")?),
                ("maxBackoffMs", p.get(c"maxBackoffMs")?),
                ("action", action),
                ("id", p.get(c"id")?),
                ("tokenJson", json(p.get(c"token")?)?),
                (
                    "reasonJson",
                    if real_error {
                        undefined(s)?
                    } else {
                        json(p.get(c"reason")?)?
                    },
                ),
                ("reasonDeferred", flag(s, real_error)?),
                ("retryable", p.get(c"retryable")?),
                ("delayMs", p.get(c"delayMs")?),
            ],
        )?;
        f.set(c"input", input)?;
        yes(f, request_async(s, "outboxRecoverPlan", input)?, |f, r| {
            if !r.get(c"needsReason")?.truthy()? {
                return outbox_commit(f, r);
            }
            let s = f.get(c"s")?;
            let input = f.get(c"input")?;
            input.set(
                c"reasonJson",
                json(fields(
                    s,
                    &[("value", call(f.get(c"policy")?, c"formatReason", &[])?)],
                )?)?,
            )?;
            input.set(c"reasonDeferred", flag(s, false)?)?;
            input.set(c"reasonFormatted", flag(s, true)?)?;
            yes(
                f,
                request_async(s, "outboxRecoverPlan", input)?,
                outbox_commit,
            )
        })
    })
}
fn outbox_commit<'a>(f: L<'a>, r: L<'a>) -> Result<L<'a>> {
    let s = f.get(c"s")?;
    if !r.get(c"changed")?.truthy()? {
        request(s, "noop", fields(s, &[])?)?;
        return parse(r.get(c"resultJson")?);
    }
    let input = f.get(c"input")?;
    input.set(c"expectedRevision", f.get(c"expected")?)?;
    input.set(c"updatedAt", now(s)?)?;
    yes(
        s,
        request_async(s, "outboxRecoverCommit", input)?,
        |s, r| {
            refresh_revision(s)?;
            parse(r.get(c"resultJson")?)
        },
    )
}
fn admission(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"s")?;
    let p = f.get(c"policy")?;
    let Some(id) = canonical::eligible(s, p)? else {
        return admit_fallback(f);
    };
    guarded(f, true, || {
        let prototype_key =
            p.get(c"id")?.kind()? != sys::ValueType::napi_symbol && inherited(s, id)?;
        if prototype_key {
            f.set(
                c"view",
                view::create(s, f.get(c"header")?, null(s)?, null(s)?)?,
            )?;
        }
        let spec_json = json(p.get(c"spec")?)?;
        let buffer = s.get(c"ports")?.get(c"Buffer")?;
        let bytes = call(buffer, c"from", &[spec_json, text(s, "utf8")?])?;
        let key = p.get(c"idempotencyKey")?;
        let normalized = if key.truthy()? {
            call(string(key)?, c"toWellFormed", &[])?
        } else {
            null(s)?
        };
        let input = spread(p)?;
        input.set(c"id", id)?;
        for (orig, tag, raw) in [
            (c"id", c"idSymbol", c"idValueJson"),
            (c"ownerSessionId", c"ownerSymbol", c"ownerValueJson"),
            (c"resultSessionId", c"resultSymbol", c"resultValueJson"),
        ] {
            let v = p.get(orig)?;
            input.set(tag, flag(s, v.kind()? == sys::ValueType::napi_symbol)?)?;
            let wire = json(v)?;
            input.set(
                raw,
                if wire.nullish()? {
                    text(s, "null")?
                } else {
                    wire
                },
            )?;
        }
        for k in [c"ownerSessionId", c"resultSessionId", c"now", c"spec"] {
            input.set(k, undefined(s)?)?
        }
        input.set(c"idempotencyKey", normalized)?;
        input.set(c"prototypeKey", flag(s, prototype_key)?)?;
        input.set(c"expectedRevision", f.get(c"expected")?)?;
        f.set(c"input", input)?;
        f.set(c"bytes", bytes)?;
        f.set(c"specJson", spec_json)?;
        if prototype_key {
            let req = spread(input)?;
            req.set(c"specJson", spec_json)?;
            let r = request(s, "operationAdmitPlan", req)?;
            admit_plan(f, r)
        } else {
            yes(
                f,
                transport::async_transport(
                    s,
                    "requestAdmissionAsync",
                    "operationAdmitPlan",
                    input,
                    Some(bytes),
                )?,
                admit_plan,
            )
        }
    })
}
fn admit_plan<'a>(f: L<'a>, mut r: L<'a>) -> Result<L<'a>> {
    let s = f.get(c"s")?;
    let input = f.get(c"input")?;
    if r.get(c"needsPrototype")?.truthy()? {
        let item = f
            .get(c"view")?
            .get(c"root")?
            .get(c"operations")?
            .get_key(input.get(c"id")?)?;
        input.set(c"prototypeKnown", flag(s, true)?)?;
        input.set(c"prototypeTruthy", flag(s, item.truthy()?)?)?;
        let req = spread(input)?;
        req.set(c"specJson", f.get(c"specJson")?)?;
        r = request(s, "operationAdmitPlan", req)?;
    }
    if r.get(c"pending")?.truthy()? {
        let p = transport::async_transport(
            s,
            "requestAdmissionAsync",
            "operationAdmit",
            input,
            Some(f.get(c"bytes")?),
        )?;
        yes(f, p, admit_done)
    } else {
        admit_done(f, r)
    }
}
fn admit_done<'a>(f: L<'a>, r: L<'a>) -> Result<L<'a>> {
    let s = f.get(c"s")?;
    if r.get(c"legacy")?.truthy()? {
        request(s, "end", fields(s, &[])?)?;
        return admit_fallback(f);
    }
    if !r.get(c"unchanged")?.truthy()? {
        refresh_revision(s)?
    }
    Ok(r)
}
pub(super) fn install(s: L<'_>, api: L<'_>) -> Result<()> {
    for (name, fields, op) in [
        (
            "cancelWait",
            &["id", "clock", "legacy"][..],
            cancel as fn(L<'_>) -> Result<L<'_>>,
        ),
        (
            "markRunningOperation",
            &["id", "patch", "clock", "legacy"][..],
            running,
        ),
        (
            "settleScheduleInput",
            &["id", "request", "clock", "legacy"][..],
            settle,
        ),
        ("executeOutbox", &["policy", "legacy"][..], outbox),
        (
            "executeOperationAdmit",
            &["policy", "legacy"][..],
            admission,
        ),
    ] {
        set(
            api,
            name,
            function(s, name, fields.len(), fields.len(), move |s, a| {
                let args = fields
                    .iter()
                    .copied()
                    .zip(a.iter().copied())
                    .collect::<Vec<_>>();
                enqueue(frame(s, &args)?, move |f| {
                    ensure_open(f.get(c"s")?)?;
                    op(f)
                })
            })?,
        )?;
    }
    Ok(())
}
