//! Shell journal decisions settle before annotations. A suggested or pending
//! separation has exclusive ownership of its transcript/cursor changes.
use super::*;
fn eligible(s: L<'_>) -> Result<bool> {
    Ok(!s.get(c"supersededReason")?.truthy()? && s.get(c"shellOwned")?.is_true()?)
}
fn journal_failure<'a>(s: L<'a>, error: L<'a>) -> Result<L<'a>> {
    log_message(
        s,
        "task_attribution_decision_failed",
        error,
        &[("turnId", s.get(c"turnId")?)],
    )?;
    after_decision(s, text(s, "none")?)
}
pub(super) fn settle(s: L<'_>) -> Result<L<'_>> {
    let p = s.get(c"p")?;
    if !eligible(s)? || !is_fn(runtime(p)?.get(c"recordTaskAttributionDecision")?)? {
        return after_decision(s, text(s, "none")?);
    }
    let res = s.get(c"res")?;
    let id = s.get(c"taskId")?;
    let unread = res.get(c"unclassified")?.is_true()? && !s.get(c"identityLocked")?.truthy()?;
    s.set(c"unclassified", flag(s, unread)?)?;
    let written = (|| {
        let request = if unread {
            fields(s, &[("unclassified", flag(s, true)?)])?
        } else {
            let dest = if res.get(c"relation")?.is_string("new")? {
                s.get(c"resolvedTaskId")?
            } else {
                let actual = res.get(c"taskId")?;
                if actual.truthy()? && !actual.equals(id)? {
                    actual
                } else {
                    null(s)?
                }
            };
            fields(
                s,
                &[
                    ("relation", res.get(c"relation")?),
                    ("taskId", dest),
                    ("taskName", res.get(c"taskName")?),
                    ("relatedTaskId", res.get(c"relatedTaskId")?),
                    ("directoryHint", opt(res.get(c"directoryHint")?)?),
                ],
            )?
        };
        field_names(request, s, &[c"turnId", c"anchorMessageId", c"runId"])?;
        request.set(c"currentTaskId", id)?;
        call(
            runtime(p)?,
            c"recordTaskAttributionDecision",
            &[s.get(c"name")?, s.get(c"shellReceiptId")?, request],
        )
    })();
    match written {
        Err(e) => journal_failure(s, cause(s, e)?),
        Ok(value) => {
            let ok = cb(s, 1, |s, a| {
                let action = if s.get(c"unclassified")?.is_true()? {
                    text(s, "none")?
                } else {
                    match a[0]
                        .optional(c"action")
                        .and_then(|v| fallback(v, "none".into()))
                    {
                        Ok(a) => a,
                        Err(e) => return journal_failure(s, cause(s, e)?),
                    }
                };
                after_decision(s, action)
            })?;
            let fail = cb(s, 1, |s, a| journal_failure(s, a[0]))?;
            call(resolved_promise(value)?, c"then", &[ok, fail])
        }
    }
}
fn stamped<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    host(
        s.get(c"p")?,
        c"setTaskState",
        &[
            s.get(c"name")?,
            fields(s, &[("auxRunId", s.get(c"runId")?)])?,
        ],
    )?;
    undef(s)
}
fn after_decision<'a>(s: L<'a>, action: L<'a>) -> Result<L<'a>> {
    let p = s.get(c"p")?;
    let res = s.get(c"res")?;
    s.set(c"action", action)?;
    if action.is_string("suggest")? {
        return chain(s, original(s)?, stamped);
    }
    if !action.is_string("apply")?
        && eligible(s)?
        && (s.get(c"source")?.is_string("turn-end")? || s.get(c"source")?.is_string("manual")?)
    {
        let ask = or(res.get(c"separation")?, || {
            if res.get(c"relation")?.is_string("new")? && res.get(c"taskName")?.truthy()? {
                fields(
                    s,
                    &[
                        ("title", res.get(c"taskName")?),
                        (
                            "reason",
                            text(s, "归集判定本轮为独立新任务（relation=new）")?,
                        ),
                    ],
                )
            } else {
                null(s)
            }
        })?;
        if ask.truthy()? {
            let ctx = runtime(p)?;
            let propose = ctx.get(c"proposeTaskSeparation")?;
            let offered = if propose.nullish()? {
                undef(s)?
            } else {
                let payload = fields(
                    s,
                    &[
                        ("separation", ask),
                        ("turnId", s.get(c"turnId")?),
                        ("anchorMessageId", s.get(c"anchorMessageId")?),
                    ],
                )?;
                propose.call(ctx, &[s.get(c"name")?, s.get(c"shellReceiptId")?, payload])?
            };
            return chain(s, offered, |s, a| {
                let suggestion = a[0];
                if !suggestion.truthy()? {
                    return after_separation(s);
                }
                let dest = suggestion.get(c"taskId")?;
                let meta = fields(
                    s,
                    &[
                        ("taskId", or(dest, || s.get(c"taskId"))?),
                        (
                            "taskName",
                            if dest.truthy()? {
                                suggestion.get(c"title")?
                            } else {
                                undef(s)?
                            },
                        ),
                        ("auxRunId", s.get(c"runId")?),
                    ],
                )?;
                chain(s, annotate(s, meta)?, stamped)
            });
        }
    }
    after_separation(s)
}
fn after_separation(s: L<'_>) -> Result<L<'_>> {
    let p = s.get(c"p")?;
    let res = s.get(c"res")?;
    let name = s.get(c"name")?;
    let destination = s.get(c"resolvedTaskId")?;
    if !s.get(c"action")?.is_string("apply")?
        && eligible(s)?
        && !destination.equals(s.get(c"taskId")?)?
        && runtime(p)?.get(c"proposeTaskShellAttribution")?.truthy()?
    {
        let meta = fields(
            s,
            &[
                ("taskId", destination),
                ("taskName", res.get(c"taskName")?),
                ("turnId", s.get(c"turnId")?),
                ("anchorMessageId", s.get(c"anchorMessageId")?),
            ],
        )?;
        call(
            runtime(p)?,
            c"proposeTaskShellAttribution",
            &[name, s.get(c"shellReceiptId")?, meta],
        )?;
        return undef(s);
    }
    let applied = apply(p, s.get(c"cs")?, name, res, annotation_context(s, false)?)?;
    chain(s, applied, |s, _| {
        if eligible(s)? && !s.get(c"action")?.is_string("apply")? {
            let p = s.get(c"p")?;
            let receipt = s.get(c"shellReceiptId")?;
            let ack = (|| {
                let data = fields(s, &[("taskId", s.get(c"resolvedTaskId")?)])?;
                field_names(
                    data,
                    s.get(c"res")?,
                    &[c"taskName", c"relation", c"relatedTaskId"],
                )?;
                field_names(data, s, &[c"turnId", c"anchorMessageId"])?;
                call(
                    runtime(p)?,
                    c"settleTaskShellAttribution",
                    &[s.get(c"name")?, receipt, data],
                )
            })();
            if let Err(e) = ack {
                log_message(
                    s,
                    "task_shell_attribution_failed",
                    cause(s, e)?,
                    &[("receiptId", receipt)],
                )?;
            }
        }
        undef(s)
    })
}
