use super::*;
pub(super) fn deferred<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let f = frame(p, id)?;
    then(f, port(p, c"readEvaluationFacts", &[id])?, |f, v| {
        rule(f.get(c"host")?, c"deferEvaluation", &[v])
    })
}
fn transcript<'a>(p: L<'a>, id: L<'a>, hint: L<'a>) -> Result<(L<'a>, L<'a>)> {
    let history = p
        .catch(|| port(p, c"getHistory", &[id]))?
        .unwrap_or(null(p)?);
    let recent = arr(p)?;
    let mut last = text(p, "")?;
    if history.is_array()? {
        history.for_each(|msg| {
            if !msg.truthy()? {
                return Ok(());
            }
            let role = msg.get(c"role")?;
            if !role.is_string("assistant")? && !role.is_string("user")? {
                return Ok(());
            }
            let content = msg.get(c"content")?;
            if content.kind()? == sys::ValueType::napi_string {
                call(
                    recent,
                    c"push",
                    &[fields(p, &[("role", role), ("content", content)])?],
                )?;
                if role.is_string("assistant")? && call(content, c"trim", &[])?.truthy()? {
                    last = content;
                }
            }
            Ok(())
        })?;
    }
    if hint.truthy()? && call(string(hint)?, c"trim", &[])?.truthy()? {
        last = string(hint)?;
    }
    Ok((call(recent, c"slice", &[num(p, -8.)?])?, last))
}
pub(super) fn should_hold<'a>(p: L<'a>, id: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    if !active(state(p, id)?)? {
        return flag(p, false);
    }
    let hint = opts.get(c"assistantText")?;
    if hint.truthy()? && call(string(hint)?, c"trim", &[])?.truthy()? {
        return flag(p, true);
    }
    flag(p, transcript(p, id, hint)?.1.truthy()?)
}
fn spinner<'a>(p: L<'a>, id: L<'a>, on: bool) -> Result<()> {
    let s = state(p, id)?;
    if s.truthy()? && s.get(c"evaluating")?.is_true()? != on {
        persist(
            p,
            id,
            patch(s, &[("evaluating", flag(p, on)?), ("updatedAt", now(p)?)])?,
            false,
        )?;
    }
    Ok(())
}
fn run(f: L<'_>) -> Result<L<'_>> {
    let p = f.get(c"host")?;
    let id = f.get(c"id")?;
    if lifecycle::expire(p, id)? {
        return fail(p, "expired", None);
    }
    let s = state(p, id)?;
    if !active(s)? {
        return fail(p, "not_active", None);
    }
    let (recent, last) = transcript(p, id, f.get(c"opts")?.get(c"assistantText")?)?;
    f.set(c"state", s)?;
    f.set(c"recent", recent)?;
    f.set(c"last", last)?;
    then(f, port(p, c"getPendingQuestion", &[id])?, question)
}
fn question<'a>(f: L<'a>, pending: L<'a>) -> Result<L<'a>> {
    let p = f.get(c"host")?;
    let id = f.get(c"id")?;
    let s = f.get(c"state")?;
    if !current(f)? || !active(state(p, id)?)? {
        return fail(p, "superseded", None);
    }
    let q = if pending.truthy()?
        && !pending.get(c"resolved")?.is_true()?
        && pending.get(c"requestId")?.truthy()?
    {
        let opts = pending.get(c"options")?;
        fields(
            p,
            &[
                ("requestId", string(pending.get(c"requestId")?)?),
                (
                    "question",
                    string(fallback(pending.get(c"question")?, V::from(""))?)?,
                ),
                (
                    "options",
                    if opts.is_array()? {
                        call(opts, c"slice", &[])?
                    } else {
                        arr(p)?
                    },
                ),
            ],
        )?
    } else {
        null(p)?
    };
    let mut last = f.get(c"last")?;
    let reason = f.get(c"opts")?.get(c"reason")?;
    if !last.truthy()? && (reason.is_string("start")? || reason.is_string("resume")?) {
        last = transcript(p, id, undef(p)?)?.1;
    }
    let evidence = fields(
        p,
        &[
            ("goal", s.get(c"goal")?),
            ("criteria", s.get(c"criteria")?),
            ("lastOutput", last),
            ("recent", f.get(c"recent")?),
            ("history", s.get(c"history")?),
            ("pendingQuestion", q),
            (
                "classifyState",
                port(p, c"getTaskState", &[id])?.optional(c"classifyState")?,
            ),
            ("rounds", s.get(c"rounds")?),
            ("maxDurationMinutes", s.get(c"maxDurationMinutes")?),
        ],
    )?;
    if !last.truthy()? {
        return fail(p, "no_output", None);
    }
    let aux = port(p, c"getAuxQueue", &[])?;
    if !callable(aux.optional(c"enqueue")?)? {
        return fail(p, "aux_unavailable", None);
    }
    f.set(c"evidence", evidence)?;
    spinner(p, id, true)?;
    let pending = async_result(f, || {
        let prompt = rule(p, c"buildVerdictPrompt", &[evidence])?;
        call(
            aux,
            c"enqueue",
            &[fields(
                p,
                &[
                    ("type", text(p, "unattended_verdict")?),
                    ("priority", text(p, "interactive")?),
                    ("prompt", prompt),
                    (
                        "meta",
                        fields(p, &[("sessionName", id), ("unattended", flag(p, true)?)])?,
                    ),
                ],
            )?],
        )
    })?;
    call(
        pending,
        c"then",
        &[
            cont(f, |f, r| {
                let v = r.optional(c"text")?;
                let text = if v.kind()? == sys::ValueType::napi_string {
                    v
                } else {
                    text(f, "")?
                };
                f.set(c"reply", text)?;
                queue_check(f)
            })?,
            cont(f, |f, e| {
                let p = f.get(c"host")?;
                if !current(f)? {
                    return fail(p, "superseded", None);
                }
                if e.optional(c"cancelled")?.truthy()? {
                    spinner(p, f.get(c"id")?, false)?;
                    return fail(p, "cancelled", None);
                }
                let message = or(e.optional(c"message")?, fallback(e, V::from("aux_failed"))?)?;
                f.set(
                    c"auxError",
                    text(p, &format!("aux_failed: {}", js(message)?))?,
                )?;
                queue_check(f)
            })?,
        ],
    )
}
fn queue_check(f: L<'_>) -> Result<L<'_>> {
    let p = f.get(c"host")?;
    let id = f.get(c"id")?;
    if !current(f)? {
        return fail(p, "superseded", None);
    }
    if store(p, c"queued", c"has", &[id])?.truthy()? {
        decide(f, flag(p, true)?)
    } else {
        then(f, deferred(p, id)?, decide)
    }
}
fn decide<'a>(f: L<'a>, pending: L<'a>) -> Result<L<'a>> {
    let p = f.get(c"host")?;
    let id = f.get(c"id")?;
    let latest = state(p, id)?;
    if !current(f)? || !active(latest)? {
        return fail(p, "superseded", None);
    }
    if lifecycle::expire(p, id)? {
        return fail(p, "expired", None);
    }
    let e = f.get(c"auxError")?;
    let v = if e.truthy()? {
        fields(p, &[("ok", flag(p, false)?), ("error", e)])?
    } else {
        rule(p, c"parseVerdict", &[f.get(c"reply")?])?
    };
    let valid = v.get(c"ok")?.truthy()?;
    let d = rule(
        p,
        c"decide",
        &[fields(
            p,
            &[
                ("state", latest),
                ("verdict", if valid { v } else { undef(p)? }),
                (
                    "parseError",
                    if valid {
                        undef(p)?
                    } else {
                        fallback(v.get(c"error")?, V::from("unparseable_verdict"))?
                    },
                ),
                ("evaluation", f.get(c"evidence")?),
                ("workPending", pending),
                ("now", now(p)?),
            ],
        )?],
    )?;
    let mut next = d.get(c"nextState")?;
    let settled = f.get(c"opts")?.get(c"settledAt")?;
    if settled.truthy()? {
        next = patch(next, &[("lastSettleAt", settled)])?;
    }
    if !persist(p, id, next, false)? {
        spinner(p, id, false)?;
        return fail(p, "persist_failed", None);
    }
    d.assign(c"nextState", next)?;
    effects::decision_trace(p, id, d)?;
    if d.get(c"action")?.is_string("none")? && d.get(c"reason")?.is_string("backlog_pending")? {
        timers::backlog(p, id, d, 0.)?;
    }
    f.set(c"decision", d)?;
    let pending = async_result(f, || effects::apply(f, d))?;
    call(
        pending,
        c"then",
        &[
            cont(f, |f, _| {
                let d = f.get(c"decision")?;
                fields(
                    f,
                    &[
                        ("ok", flag(f, true)?),
                        ("action", d.get(c"action")?),
                        ("unattended", d.get(c"nextState")?),
                    ],
                )
            })?,
            cont(f, |f, e| {
                log_err(f, "apply failed", e)?;
                fail(f, "apply_failed", None)
            })?,
        ],
    )
}
pub(super) fn evaluate<'a>(p: L<'a>, id: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    // A replacement run may evaluate while the old Aux request is still pending.
    let previous = store(p, c"inFlight", c"get", &[id])?;
    if previous.truthy()? && !current(previous)? {
        store(p, c"inFlight", c"delete", &[id])?;
        store(p, c"queued", c"delete", &[id])?;
        effects::release(p, id)?;
    }
    effects::hold(p, id, opts.get(c"fallbackPush")?)?;
    if lifecycle::expire(p, id)? {
        return resolved(fail(p, "expired", None)?);
    }
    if store(p, c"inFlight", c"has", &[id])?.truthy()? {
        store(p, c"queued", c"add", &[id])?;
        return resolved(fields(
            p,
            &[("ok", flag(p, true)?), ("deferred", flag(p, true)?)],
        )?);
    }
    if !active(state(p, id)?)? {
        effects::release(p, id)?;
        return resolved(fail(p, "not_active", None)?);
    }
    let f = frame(p, id)?;
    f.set(c"opts", opts)?;
    store(p, c"inFlight", c"set", &[id, f])?;
    let pending = rescue(f, async_result(f, || run(f))?, |f, e| {
        log_err(f, "evaluation failed", e)?;
        if current(f)? {
            spinner(f.get(c"host")?, f.get(c"id")?, false)?;
        }
        fail(f, "evaluation_failed", None)
    })?;
    let done = then(f, pending, |f, r| {
        let p = f.get(c"host")?;
        let id = f.get(c"id")?;
        if !store(p, c"inFlight", c"get", &[id])?.equals(f)? {
            return Ok(r);
        }
        if !r.optional(c"ok")?.truthy()? || r.get(c"action")?.is_string("none")? {
            effects::release(p, id)?;
        } else {
            store(p, c"heldPushes", c"delete", &[id])?;
        }
        Ok(r)
    })?;
    call(
        done,
        c"finally",
        &[function(f, "", 0, 0, |f, _| {
            let p = f.get(c"host")?;
            let id = f.get(c"id")?;
            if !store(p, c"inFlight", c"get", &[id])?.equals(f)? {
                return undef(f);
            }
            store(p, c"inFlight", c"delete", &[id])?;
            if store(p, c"queued", c"delete", &[id])?.truthy()? && current(f)? {
                port(
                    p,
                    c"immediate",
                    &[function(f, "", 0, 0, |f, _| {
                        if !current(f)? {
                            return undef(f);
                        }
                        evaluate(
                            f.get(c"host")?,
                            f.get(c"id")?,
                            fields(f, &[("reason", text(f, "coalesced")?)])?,
                        )
                    })?],
                )?;
            }
            undef(f)
        })?],
    )
}
