use super::*;
mod receipt;

// A request is distinct from the task it judges; match its ID before clearing
// the live slot, including on queue rejection and cancellation.
fn option<'a>(o: L<'a>, key: &CStr, default: V) -> Result<L<'a>> {
    let v = o.get(key)?;
    if v.undefined()? {
        o.from_value(&default)
    } else {
        Ok(v)
    }
}
fn source<'a>(s: L<'a>, data: &[(&str, L<'a>)], turn: bool) -> Result<L<'a>> {
    let event = fields(s, data)?;
    field_names(event, s, &[c"runId", c"anchorMessageId", c"source"])?;
    if turn {
        event.set(c"turnId", s.get(c"turnId")?)?;
    }
    Ok(event)
}
fn annotate<'a>(s: L<'a>, meta: L<'a>) -> Result<L<'a>> {
    let p = s.get(c"p")?;
    host(
        p,
        c"annotateChatTurn",
        &[
            s.get(c"name")?,
            s.get(c"turnId")?,
            meta,
            fields(s, &[("anchorMessageId", s.get(c"anchorMessageId")?)])?,
        ],
    )
}
fn original<'a>(s: L<'a>) -> Result<L<'a>> {
    annotate(
        s,
        fields(
            s,
            &[
                ("taskId", fallback(s.get(c"taskId")?, V::Undefined)?),
                ("auxRunId", s.get(c"runId")?),
            ],
        )?,
    )
}
fn runtime(p: L<'_>) -> Result<L<'_>> {
    host(p, c"getTaskContextHost", &[])
}
fn fresh_run(p: L<'_>) -> Result<L<'_>> {
    call(p.get(c"crypto")?, c"randomUUID", &[])
}
fn submit<'a>(s: L<'a>, meta: L<'a>, scan: bool) -> Result<L<'a>> {
    let p = s.get(c"p")?;
    let request = fields(
        p,
        &[
            ("type", text(p, "intent_classify")?),
            ("systemPrompt", s.get(c"systemPrompt")?),
            ("prompt", s.get(c"prompt")?),
            ("meta", meta),
        ],
    )?;
    if !scan {
        request.set(c"id", s.get(c"runId")?)?;
    }
    let work = call(super::super::queue(p)?, c"enqueue", &[request])?;
    let success = cb(s, 1, if scan { scan_settled } else { turn_settled })?;
    let accepted = call(work, c"then", &[success])?;
    let failure = cb(s, 1, if scan { scan_failed } else { turn_failed })?;
    let handled = call(accepted, c"catch", &[failure])?;
    if !scan {
        let failure = cb(s, 1, |s, a| {
            log_error(
                s,
                "task_attribution_failure_handler_failed",
                a[0],
                &[("turnId", s.get(c"turnId")?)],
            )?;
            undef(s)
        })?;
        call(handled, c"catch", &[failure])?;
    }
    undef(s)
}
pub(in crate::classify_machine) fn enqueue_scan<'a>(
    p: L<'a>,
    name: L<'a>,
    reply: L<'a>,
) -> Result<L<'a>> {
    let run = fresh_run(p)?;
    let history = host(p, c"viewChatHistory", &[name])?;
    let cs = call(p.get(c"chatSessions")?, c"get", &[name])?;
    let id = opt(cs.optional(c"_currentTaskId")?)?;
    let provisional = if task_state(p, name)?
        .get(c"taskIdentityPending")?
        .is_true()?
    {
        id
    } else {
        null(p)?
    };
    let recent = host(p, c"recentTaskContext", &[history])?;
    let related = context::related(p, name, transcript::last_user(history)?, reply, recent)?;
    let s = fields(
        p,
        &[
            ("p", p),
            ("name", name),
            ("runId", run),
            ("taskId", id),
            ("provisional", provisional),
            ("source", text(p, "scan")?),
        ],
    )?;
    let directory = context::directories(s, id)?;
    context::prompts(
        s,
        directory,
        recent,
        related,
        reply,
        transcript::first_user(history)?,
        true,
    )?;
    let meta = fields(
        p,
        &[
            ("sid", name),
            ("startup", flag(p, true)?),
            ("runId", run),
            ("anchorMessageId", s.get(c"anchorMessageId")?),
            ("taskId", id),
        ],
    )?;
    submit(s, meta, true)
}
pub(in crate::classify_machine) fn run<'a>(
    p: L<'a>,
    cs: L<'a>,
    name: L<'a>,
    opts: L<'a>,
) -> Result<L<'a>> {
    let opts = if opts.undefined()? {
        fields(p, &[])?
    } else {
        opts
    };
    let turn = option(opts, c"turnId", V::Null)?;
    let skip = option(opts, c"skipCancel", false.into())?;
    let manual = option(opts, c"manual", false.into())?;
    let from = option(opts, c"source", V::Null)?;
    let locked = option(opts, c"identityLocked", false.into())?;
    let admitted = option(opts, c"admittedTaskId", V::Null)?;
    let reply = fallback(cs.get(c"currentAssistantText")?, "".into())?;
    let user = fallback(cs.get(c"currentUserText")?, "".into())?;
    if user.get(c"length")?.number()? < 1. && reply.get(c"length")?.number()? < 20. {
        return undef(p);
    }
    let sid = or(row(p, name)?.optional(c"id")?, || Ok(name))?;
    let state = task_state(p, name)?;
    if state.get(c"classifyState")?.is_string("E")?
        && state.get(c"cancelledAt")?.truthy()?
        && !cs.get(c"_taskShellReceiptId")?.truthy()?
    {
        write_log(
            p,
            c"info",
            "classify_skipped_after_cancel",
            fields(p, &[("sessionId", name)])?,
        )?;
        return undef(p);
    }
    let history = host(p, c"viewChatHistory", &[name])?;
    let id = opt(cs.get(c"_currentTaskId")?)?;
    let shell = opt(cs.get(c"_taskShellReceiptId")?)?;
    let owned = shell.truthy()? && call(runtime(p)?, c"ownsTaskShell", &[name])?.truthy()?;
    let recent = host(p, c"recentTaskContext", &[history])?;
    if owned {
        call(runtime(p)?, c"taskShellRecentTasks", &[name, shell])?.for_each(|r| {
            let contains = cb(r, 1, |r, a| {
                flag(r, a[0].get(c"taskId")?.equals(r.get(c"taskId")?)?)
            })?;
            if !call(recent, c"some", &[contains])?.truthy()? {
                call(recent, c"push", &[r])?;
            }
            Ok(())
        })?;
    }
    let related = context::related(p, sid, user, reply, recent)?;
    let s = fields(
        p,
        &[
            ("p", p),
            ("name", name),
            ("cs", cs),
            ("taskId", id),
            ("turnId", turn),
            ("shellReceiptId", shell),
            ("shellOwned", flag(p, owned)?),
            ("identityLocked", locked),
            ("admittedTaskId", opt(admitted)?),
        ],
    )?;
    let directory = context::directories(s, id)?;
    let first = transcript::first_user(history)?;
    let state = task_state(p, name)?;
    let provisional = if !owned && state.get(c"taskIdentityPending")?.is_true()? {
        id
    } else {
        null(p)?
    };
    s.set(c"provisional", provisional)?;
    let run = fresh_run(p)?;
    s.set(c"runId", run)?;
    s.set(
        c"source",
        or(from, || {
            text(
                p,
                if manual.truthy()? {
                    "manual"
                } else {
                    "turn-end"
                },
            )
        })?,
    )?;
    context::prompts(s, directory, recent, related, reply, first, false)?;
    if !skip.truthy()? {
        call(super::super::queue(p)?, c"cancelClassifyFor", &[name])?;
    }
    cs.assign(c"_classifyTaskId", run)?;
    let meta = fields(
        p,
        &[
            ("sessionName", name),
            ("sessionId", sid),
            ("runId", run),
            ("turnId", turn),
            ("manual", manual),
            ("identityLocked", locked),
            ("anchorMessageId", s.get(c"anchorMessageId")?),
            ("taskId", id),
        ],
    )?;
    submit(s, meta, false)
}
fn evidence<'a>(
    s: L<'a>,
    answer: L<'a>,
    res: L<'a>,
    resolved: L<'a>,
    anchor: L<'a>,
    reason: L<'a>,
    scan: bool,
) -> Result<()> {
    let prior = s.get(c"taskId")?;
    let body = source(
        s,
        &[
            ("taskId", if reason.truthy()? { prior } else { resolved }),
            ("priorTaskId", prior),
            (
                "observedAnchorMessageId",
                anchor.get(c"observedAnchorMessageId")?,
            ),
            ("rawText", answer.get(c"text")?),
            ("parsed", res),
            ("superseded", flag(s, reason.truthy()?)?),
            ("supersededReason", reason),
            (
                "latencyMs",
                num(s, now(s)?.number()? - s.get(c"started")?.number()?)?,
            ),
        ],
        !scan,
    )?;
    field_names(body, s, &[c"systemPrompt", c"prompt"])?;
    if !scan {
        field_names(body, s, &[c"identityLocked", c"admittedTaskId"])?;
    }
    context::record(s, body)
}
fn annotation_context<'a>(s: L<'a>, scan: bool) -> Result<L<'a>> {
    let c = fields(
        s,
        &[(
            "source",
            text(s, if scan { "multicc/scan" } else { "multicc/aux" })?,
        )],
    )?;
    field_names(
        c,
        s,
        &[
            c"runId",
            c"taskId",
            c"admittedTaskId",
            c"resolvedTaskId",
            c"anchorMessageId",
            c"anchorStatus",
            c"supersededReason",
        ],
    )?;
    if !scan {
        field_names(c, s, &[c"turnId", c"shellReceiptId"])?;
    }
    Ok(c)
}
fn scan_settled<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = s.get(c"p")?;
    let name = s.get(c"name")?;
    let id = s.get(c"taskId")?;
    let answer = a[0];
    if answer.get(c"cancelled")?.truthy()? {
        context::record(s, source(s, &[("cancelled", flag(s, true)?)], false)?)?;
        return undef(s);
    }
    let res = context::parse(s, answer)?;
    let resolved = or(row(p, name)?.optional(c"taskBoundTaskId")?, || {
        if res.get(c"relation")?.is_string("same")? {
            or(res.get(c"taskId")?, || Ok(id))
        } else {
            or(s.get(c"provisional")?, || fresh_id(p))
        }
    })?;
    let cs = call(p.get(c"chatSessions")?, c"get", &[name])?;
    let anchor = transcript::status(p, name, s.get(c"anchorMessageId")?)?;
    let reason = if anchor.get(c"changed")?.truthy()? {
        text(s, "anchor_changed")?
    } else {
        null(s)?
    };
    evidence(s, answer, res, resolved, anchor, reason, true)?;
    s.set(c"admittedTaskId", s.get(c"provisional")?)?;
    s.set(c"resolvedTaskId", resolved)?;
    s.set(c"anchorStatus", anchor)?;
    s.set(c"supersededReason", reason)?;
    apply(p, cs, name, res, annotation_context(s, true)?)
}
fn scan_failed<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let e = a[0];
    if e.optional(c"cancelled")?.truthy()? {
        return undef(s);
    }
    let message = e.get(c"message")?;
    context::record(s, source(s, &[("error", message)], false)?)?;
    let msg = format!(
        "[multicc/scan] classify {} failed: {}",
        s.get(c"name")?.coerce_string()?.to_string_lossy(),
        message.coerce_string()?.to_string_lossy()
    );
    call(s.global()?.get(c"console")?, c"warn", &[text(s, &msg)?])?;
    undef(s)
}
fn turn_settled<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = s.get(c"p")?;
    let cs = s.get(c"cs")?;
    let name = s.get(c"name")?;
    let id = s.get(c"taskId")?;
    let superseded = !cs.get(c"_classifyTaskId")?.equals(s.get(c"runId")?)?;
    if !superseded {
        cs.assign(c"_classifyTaskId", null(s)?)?;
    }
    let answer = a[0];
    if answer.get(c"cancelled")?.truthy()? {
        context::record(
            s,
            source(s, &[("cancelled", flag(s, true)?), ("taskId", id)], true)?,
        )?;
        return original(s);
    }
    let parsed = context::parse(s, answer)?;
    let locked = s.get(c"identityLocked")?.truthy()?;
    let res = if locked {
        let res = crate::js_live::spread(parsed)?;
        res.set(c"relation", text(s, "same")?)?;
        res.set(c"taskId", id)?;
        res.set(c"relatedTaskId", null(s)?)?;
        res.set(
            c"directoryHint",
            if s.get(c"firstTurn")?.is_true()? {
                parsed.get(c"directoryHint")?
            } else {
                null(s)?
            },
        )?;
        res
    } else {
        parsed
    };
    let owned = s.get(c"shellOwned")?.is_true()?;
    let bound = if owned {
        null(s)?
    } else {
        opt(row(p, name)?.optional(c"taskBoundTaskId")?)?
    };
    let resolved = or(
        or(bound, || {
            if locked {
                Ok(id)
            } else if res.get(c"relation")?.is_string("same")? {
                or(res.get(c"taskId")?, || Ok(id))
            } else if owned {
                null(s)
            } else {
                s.get(c"admittedTaskId")
            }
        })?,
        || fresh_id(p),
    )?;
    let anchor = transcript::status(p, name, s.get(c"anchorMessageId")?)?;
    let reason = if anchor.get(c"changed")?.truthy()? {
        text(s, "anchor_changed")?
    } else if superseded {
        text(s, "newer_aux_request")?
    } else {
        null(s)?
    };
    evidence(s, answer, res, resolved, anchor, reason, false)?;
    s.set(c"res", res)?;
    s.set(c"resolvedTaskId", resolved)?;
    s.set(c"anchorStatus", anchor)?;
    s.set(c"supersededReason", reason)?;
    receipt::settle(s)
}
fn turn_failed<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let cs = s.get(c"cs")?;
    let e = a[0];
    if cs.get(c"_classifyTaskId")?.equals(s.get(c"runId")?)? {
        cs.assign(c"_classifyTaskId", null(s)?)?;
    }
    let event = source(s, &[("taskId", s.get(c"taskId")?)], true)?;
    field_names(event, s, &[c"systemPrompt", c"prompt"])?;
    let cancelled = e.optional(c"cancelled")?.truthy()?;
    if cancelled {
        event.set(c"cancelled", flag(s, true)?)?;
    } else {
        event.set(c"error", e.get(c"message")?)?;
    }
    context::record(s, event)?;
    let annotated = original(s)?;
    if cancelled {
        return Ok(annotated);
    }
    s.set(c"failure", e)?;
    chain(s, annotated, |s, _| {
        let p = s.get(c"p")?;
        let name = s.get(c"name")?;
        let message = s.get(c"failure")?.get(c"message")?;
        let msg = format!(
            "[multicc/aux] Classify FAILED for {}: {}",
            name.coerce_string()?.to_string_lossy(),
            message.coerce_string()?.to_string_lossy()
        );
        call(s.global()?.get(c"console")?, c"log", &[text(s, &msg)?])?;
        s.catch(|| {
            let raw = fields(
                s,
                &[
                    ("source", text(s, "aux_http")?),
                    ("provider", text(s, "aux")?),
                    (
                        "message",
                        string(fallback(message, "classify failed".into())?)?,
                    ),
                ],
            )?;
            let ctx = fields(
                s,
                &[
                    ("source", text(s, "aux_http")?),
                    ("provider", text(s, "aux")?),
                    ("sessionId", name),
                ],
            )?;
            call(
                host(p, c"getApiErrorHost", &[])?,
                c"recordApiError",
                &[raw, ctx],
            )
        })?;
        write_log(
            p,
            c"warn",
            "task_attribution_failed",
            fields(
                s,
                &[
                    ("sessionId", name),
                    ("turnId", s.get(c"turnId")?),
                    ("error", message),
                ],
            )?,
        )?;
        undef(s)
    })
}
