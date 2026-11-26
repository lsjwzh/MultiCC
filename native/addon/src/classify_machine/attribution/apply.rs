use super::*;

// Preserve the async function contract, including rejection on a synchronous
// failure before the first await. Host exceptions keep their object identity.
pub(in crate::classify_machine) fn apply<'a>(
    p: L<'a>,
    cs: L<'a>,
    name: L<'a>,
    result: L<'a>,
    context: L<'a>,
) -> Result<L<'a>> {
    async_result(p, begin(p, cs, name, result, context))
}
fn begin<'a>(p: L<'a>, cs: L<'a>, name: L<'a>, result: L<'a>, context: L<'a>) -> Result<L<'a>> {
    if !cs.truthy()? {
        return null(p);
    }
    let context = if context.undefined()? {
        fields(p, &[])?
    } else {
        context
    };
    let previous = opt(if turn::has_task_id(context)? {
        context.get(c"taskId")?
    } else {
        cs.get(c"_currentTaskId")?
    })?;
    let anchor = or(context.get(c"anchorStatus")?, || {
        transcript::status(p, name, opt(context.get(c"anchorMessageId")?)?)
    })?;
    let reason = or(context.get(c"supersededReason")?, || {
        if anchor.get(c"changed")?.truthy()? {
            text(p, "anchor_changed")
        } else {
            null(p)
        }
    })?;
    let s = fields(
        p,
        &[
            ("p", p),
            ("cs", cs),
            ("name", name),
            ("result", result),
            ("context", context),
            ("previous", previous),
            ("anchor", anchor),
            ("reason", reason),
        ],
    )?;
    if reason.truthy()? {
        let meta = fields(
            p,
            &[
                ("taskId", fallback(previous, V::Undefined)?),
                ("auxRunId", opt(context.get(c"runId")?)?),
            ],
        )?;
        return annotate(s, meta, superseded);
    }
    let bound = if context.get(c"shellReceiptId")?.truthy()? {
        null(p)?
    } else {
        opt(row(p, name)?.optional(c"taskBoundTaskId")?)?
    };
    let same = if result.get(c"relation")?.is_string("same")? {
        or(result.get(c"taskId")?, || Ok(previous))?
    } else {
        null(p)?
    };
    let id = or(bound, || {
        or(context.get(c"resolvedTaskId")?, || or(same, || fresh_id(p)))
    })?;
    let task = cs.get(c"currentTask")?;
    let title = or(result.get(c"taskName")?, || {
        fallback(task.optional(c"goal")?, "新任务".into())
    })?;
    let phase = or(result.get(c"phase")?, || {
        fallback(task.optional(c"phase")?, "planning".into())
    })?;
    s.set(c"id", id)?;
    s.set(c"title", title)?;
    s.set(c"phase", phase)?;
    s.set(c"changed", flag(p, !id.equals(previous)?)?)?;
    cs.assign(c"_currentTaskId", id)?;
    if is_fn(host(p, c"getUserInputSignalHost", &[])?.get(c"activateTurnAsync")?)? {
        let active = call(
            host(p, c"getUserInputSignalHost", &[])?,
            c"activateTurnAsync",
            &[name],
        )?;
        return chain(s, active, persist);
    }
    persist(s, &mut [])
}
fn annotate<'a>(s: L<'a>, meta: L<'a>, done: Handler) -> Result<L<'a>> {
    let p = s.get(c"p")?;
    let ctx = s.get(c"context")?;
    let opts = fields(
        s,
        &[("anchorMessageId", opt(ctx.get(c"anchorMessageId")?)?)],
    )?;
    let started = host(
        p,
        c"annotateChatTurn",
        &[s.get(c"name")?, ctx.get(c"turnId")?, meta, opts],
    );
    let fallback = |e| -> Result<L<'a>> {
        log_message(s, "aux_message_annotation_failed", e, &[])?;
        array(s)
    };
    match started {
        Err(e) => done(s, &mut [fallback(cause(s, e)?)?]),
        Ok(v) => {
            let next = cb(s, 1, done)?;
            let failure = cb(s, 1, |s, a| {
                log_message(s, "aux_message_annotation_failed", a[0], &[])?;
                let mut empty = [array(s)?];
                if s.get(c"reason")?.truthy()? {
                    superseded(s, &mut empty)
                } else {
                    finish(s, &mut empty)
                }
            })?;
            call(resolved_promise(v)?, c"then", &[next, failure])
        }
    }
}
fn superseded<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let ctx = s.get(c"context")?;
    let observed = opt(s.get(c"anchor")?.get(c"observedAnchorMessageId")?)?;
    let reason = s.get(c"reason")?;
    write_log(
        s.get(c"p")?,
        c"info",
        "task_attribution_superseded",
        fields(
            s,
            &[
                ("sessionId", s.get(c"name")?),
                ("runId", opt(ctx.get(c"runId")?)?),
                ("reason", reason),
                ("anchorMessageId", opt(ctx.get(c"anchorMessageId")?)?),
                ("observedAnchorMessageId", observed),
            ],
        )?,
    )?;
    fields(
        s,
        &[
            ("taskId", s.get(c"previous")?),
            ("superseded", flag(s, true)?),
            ("supersededReason", reason),
            ("observedAnchorMessageId", observed),
            ("annotated", a[0]),
        ],
    )
}
fn refine_row<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let entry = a[0];
    if !entry.truthy()? {
        return Ok(entry);
    }
    let id = entry.get(c"taskId")?;
    if !id.truthy()?
        || (!id.equals(s.get(c"previous")?)?
            && !id.equals(s.get(c"context")?.get(c"admittedTaskId")?)?)
    {
        return Ok(entry);
    }
    if fallback(entry.get(c"at")?, 0.0.into())?.explicit_number()? < s.get(c"start")?.number()? {
        return Ok(entry);
    }
    let row = crate::js_live::spread(entry)?;
    row.set(c"taskId", s.get(c"id")?)?;
    row.set(c"goal", s.get(c"title")?)?;
    row.set(c"phase", s.get(c"phase")?)?;
    let sub = s.get(c"substate")?;
    if entry.get(c"state")?.is_string("D")? && !sub.nullish()? {
        row.set(c"goalState", sub)?;
    }
    Ok(row)
}
fn persist<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let p = s.get(c"p")?;
    let cs = s.get(c"cs")?;
    let name = s.get(c"name")?;
    let id = s.get(c"id")?;
    let title = s.get(c"title")?;
    let phase = s.get(c"phase")?;
    let ctx = s.get(c"context")?;
    let result = s.get(c"result")?;
    if !cs.get(c"currentTask")?.truthy()? {
        cs.assign(c"currentTask", new_task(title)?)?;
    }
    let task = cs.get(c"currentTask")?;
    task.assign(c"goal", title)?;
    task.assign(c"phase", phase)?;
    let record = row(p, name)?;
    s.set(c"record", record)?;
    let state = host(p, c"getTaskState", &[record])?;
    let start = or(task.get(c"startedAt")?, || {
        fallback(state.get(c"startedAt")?, 0.0.into())
    })?
    .explicit_number()?;
    let manual = state.get(c"goalState")?.is_string("achieved")?
        && fallback(state.get(c"goalStateManualAt")?, 0.0.into())?.explicit_number()? >= start;
    let terminal = state.get(c"classifyState")?.is_string("D")?;
    let sub = if !terminal {
        null(p)?
    } else if manual {
        text(p, "achieved")?
    } else {
        super::super::dispatch::resolve_goal(
            text(p, "D")?,
            result.get(c"goalState")?,
            title,
            phase,
        )?
    };
    s.set(c"start", num(p, start)?)?;
    s.set(c"substate", sub)?;
    let history = state.get(c"classifyHistory")?;
    let refined = if history.is_array()? {
        call(history, c"map", &[cb(s, 1, refine_row)?])?
    } else {
        array(s)?
    };
    let run = opt(ctx.get(c"runId")?)?;
    let patch = fields(p, &[("goal", title), ("phase", phase), ("taskId", id)])?;
    if terminal {
        patch.set(c"goalState", sub)?;
    }
    patch.set(c"auxRunId", run)?;
    patch.set(c"taskIdentityState", text(p, "canonical")?)?;
    patch.set(c"taskIdentityPending", flag(p, false)?)?;
    patch.set(
        c"taskIdentityAnchorMessageId",
        opt(ctx.get(c"anchorMessageId")?)?,
    )?;
    patch.set(c"classifyHistory", refined)?;
    host(p, c"setTaskState", &[name, patch])?;
    let new = result.get(c"relation")?.is_string("new")?;
    let meta = fields(
        p,
        &[
            ("taskId", id),
            ("taskName", title),
            ("auxRunId", run),
            ("taskStart", if new { flag(p, true)? } else { undef(p)? }),
            ("taskSource", if new { text(p, "aux")? } else { undef(p)? }),
            (
                "taskText",
                if new {
                    string(fallback(cs.get(c"currentUserText")?, "".into())?)?
                } else {
                    undef(p)?
                },
            ),
        ],
    )?;
    annotate(s, meta, finish)
}
fn finish<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let annotated = a[0];
    let p = s.get(c"p")?;
    let cs = s.get(c"cs")?;
    let name = s.get(c"name")?;
    let id = s.get(c"id")?;
    let title = s.get(c"title")?;
    let phase = s.get(c"phase")?;
    let result = s.get(c"result")?;
    let board = host(p, c"getTaskBoardRuntime", &[])?;
    if s.get(c"changed")?.is_true()? && is_fn(board.get(c"reassignTurnTask")?)? {
        let meta = fields(
            s,
            &[
                ("taskName", title),
                (
                    "taskText",
                    string(fallback(cs.get(c"currentUserText")?, "".into())?)?,
                ),
            ],
        )?;
        call(
            board,
            c"reassignTurnTask",
            &[name, s.get(c"previous")?, id, annotated, meta],
        )?;
    } else if is_fn(board.get(c"onMessagePersisted")?)? {
        annotated.for_each(|m| {
            call(board, c"onMessagePersisted", &[name, m])?;
            Ok(())
        })?;
    }
    let letter = fallback(task_state(p, name)?.get(c"classifyState")?, "P".into())?;
    verdict::board_goal(p, name, title, phase, cs, letter)?;
    let related = result.get(c"relatedTaskId")?;
    let mut group = null(s)?;
    if related.truthy()? && !related.equals(id)? && is_fn(board.get(c"linkRelatedTasks")?)? {
        let linked = (|| -> Result<()> {
            let v = call(board, c"linkRelatedTasks", &[id, related])?;
            if v.optional(c"ok")?.truthy()? {
                group = opt(v.get(c"groupId")?)?;
            } else {
                write_log(
                    p,
                    c"info",
                    "task_group_link_skipped",
                    fields(
                        s,
                        &[
                            ("sessionId", name),
                            ("taskId", id),
                            ("relatedTaskId", related),
                            ("error", fallback(v.optional(c"error")?, "unknown".into())?),
                        ],
                    )?,
                )?;
            }
            Ok(())
        })();
        if let Err(e) = linked {
            log_error(
                s,
                "task_group_link_failed",
                cause(s, e)?,
                &[("taskId", id), ("relatedTaskId", related)],
            )?;
        }
    }
    if is_fn(board.get(c"onTaskAttributionSettled")?)? {
        let notify = (|| -> Result<()> {
            let meta = fields(
                s,
                &[
                    ("taskName", title),
                    ("phase", phase),
                    ("runId", opt(s.get(c"context")?.get(c"runId")?)?),
                ],
            )?;
            let ack = call(
                board,
                c"onTaskAttributionSettled",
                &[name, id, annotated, meta],
            )?;
            let failed = cb(s, 1, |s, a| {
                log_error(
                    s,
                    "task_module_classification_failed",
                    a[0],
                    &[("taskId", s.get(c"id")?)],
                )?;
                undef(s)
            })?;
            call(resolved_promise(ack)?, c"catch", &[failed])?;
            Ok(())
        })();
        if let Err(e) = notify {
            log_error(
                s,
                "task_module_classification_failed",
                cause(s, e)?,
                &[("taskId", id)],
            )?;
        }
    }
    let candidate = result.get(c"memoryCandidate")?;
    if candidate.truthy()? && is_fn(p.get(c"writeTaskMemoryCandidate")?)? {
        if let Err(e) = host(p, c"writeTaskMemoryCandidate", &[name, id, candidate]) {
            log_error(
                s,
                "task_memory_candidate_write_failed",
                cause(s, e)?,
                &[("taskId", id)],
            )?;
        }
    }
    if title.truthy()? {
        host(
            p,
            c"setSessionSummary",
            &[or(s.get(c"record")?.optional(c"id")?, || Ok(name))?, title],
        )?;
    }
    if turn::liveness(p, name)?
        .get(c"state")?
        .is_string("active")?
    {
        let label = p.get(c"phaseLabels")?.get_key(phase)?;
        verdict::running(p, name, verdict::running_label(title, label)?)?;
    }
    fields(
        s,
        &[
            ("taskId", id),
            ("taskName", title),
            ("phase", phase),
            ("changedIdentity", s.get(c"changed")?),
            ("annotated", annotated),
            ("taskGroupId", group),
            ("superseded", flag(s, false)?),
            (
                "observedAnchorMessageId",
                opt(s.get(c"anchor")?.get(c"observedAnchorMessageId")?)?,
            ),
        ],
    )
}
