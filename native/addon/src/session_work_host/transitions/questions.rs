use super::*;

#[derive(Clone, Copy, PartialEq)]
enum Action {
    Move,
    Dismiss,
    Recover,
}
impl Action {
    fn source(self) -> &'static str {
        match self {
            Self::Move => "user_input_moved",
            Self::Dismiss => "user_input_dismiss",
            Self::Recover => "restart_recovery",
        }
    }
    fn evidence(self) -> &'static str {
        match self {
            Self::Move => "user_input_moved_separation",
            Self::Dismiss => "user_dismissed_question",
            Self::Recover => "request_user_input",
        }
    }
    fn letter(self) -> &'static str {
        if self == Self::Recover {
            "W"
        } else {
            "D"
        }
    }
}

pub(super) fn move_input<'a>(s: L<'a>, source: L<'a>, target: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let task = opts.get(c"taskId")?;
    let turn = opts.get(c"turnId")?;
    let owner = signal(s)?;
    if !callable(s.get(c"deps")?, c"moveUserInput")? && !callable(owner, c"moveAsync")? {
        return fail(s, "move_not_supported");
    }
    let record = dep(s, c"getRecord", &[source])?;
    if !record.truthy()? {
        return fail(s, "session_not_found");
    }
    let f = saved(
        s,
        &[
            ("id", source),
            ("target", target),
            ("targetTask", task),
            ("turn", turn),
            ("record", record),
        ],
    )?;
    if callable(owner, c"pendingAsync")? {
        after(f, call(owner, c"pendingAsync", &[source])?, move_pending)
    } else {
        move_pending(f, dep(s, c"pendingUserInput", &[source])?)
    }
}
fn move_pending<'a>(f: L<'a>, pending: L<'a>) -> Result<L<'a>> {
    if !pending.truthy()? {
        return fail(f, "no_pending_request");
    }
    if pending.get(c"resolved")?.is_true()? {
        return fail(f, "already_resolved");
    }
    f.set(c"pending", pending)?;
    let s = f.get(c"host")?;
    let owner = signal(s)?;
    let opts = fields(
        f,
        &[
            ("turnId", f.get(c"turn")?),
            ("taskId", f.get(c"targetTask")?),
        ],
    )?;
    let args = [f.get(c"id")?, f.get(c"target")?, opts];
    if callable(owner, c"moveAsync")? {
        opts.set(c"expectedRequestId", pending.get(c"requestId")?)?;
        after(f, call(owner, c"moveAsync", &args)?, moved)
    } else {
        moved(f, dep(s, c"moveUserInput", &args)?)
    }
}
fn moved<'a>(f: L<'a>, moved: L<'a>) -> Result<L<'a>> {
    if !moved.optional(c"ok")?.truthy()? {
        return Ok(moved);
    }
    f.set(c"moved", moved)?;
    f.set(c"request", moved.get(c"requestId")?)?;
    let task = n(f.get(c"pending")?.get(c"taskId")?)?;
    f.set(c"task", task)?;
    load_state(f)?;
    load_chat(f)?;
    dispatch(f, Action::Move)
}
fn load_state(f: L<'_>) -> Result<()> {
    let state = dep(f.get(c"host")?, c"getTaskState", &[f.get(c"record")?])?;
    f.set(
        c"state",
        if state.truthy()? {
            state
        } else {
            fields(f, &[])?
        },
    )
}
fn load_chat(f: L<'_>) -> Result<()> {
    f.set(
        c"cs",
        n(dep(f.get(c"host")?, c"getChatSession", &[f.get(c"id")?])?)?,
    )
}
pub(super) fn dismiss<'a>(s: L<'a>, id: L<'a>, request: L<'a>) -> Result<L<'a>> {
    let record = dep(s, c"getRecord", &[id])?;
    if !record.truthy()? {
        return fail(s, "session_not_found");
    }
    if !request.truthy()? {
        return fail(s, "request_id_required");
    }
    let f = saved(s, &[("id", id), ("request", request), ("record", record)])?;
    after(f, status(s, id)?, |f, queue| {
        f.set(c"queue", queue)?;
        if !queue.truthy()? {
            return dismiss_pending(f, queue);
        }
        after(
            f,
            pending_input(f.get(c"host")?, f.get(c"id")?)?,
            dismiss_pending,
        )
    })
}
fn status<'a>(s: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let target = scheduler(s)?;
    if target.nullish()? {
        undef(s)
    } else {
        call(target, c"status", &[id])
    }
}
fn dismiss_facts(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"host")?;
    let id = f.get(c"id")?;
    let streaming = dep(s, c"getChatSession", &[id])?
        .optional(c"isStreaming")?
        .is_true()?;
    let class =
        dep(s, c"getTaskState", &[dep(s, c"getRecord", &[id])?])?.optional(c"classifyState")?;
    let rt = runtime(s)?;
    let wait = if rt.nullish()? {
        undef(s)?
    } else {
        call(rt, c"hasPending", &[id])?
    };
    fields(
        f,
        &[
            ("streaming", flag(s, streaming)?),
            ("classifyState", class),
            ("externalWait", wait),
            (
                "liveness",
                maybe_call(s.get(c"deps")?, c"getTurnLiveness", &[id])?,
            ),
        ],
    )
}
fn dismiss_pending<'a>(f: L<'a>, pending: L<'a>) -> Result<L<'a>> {
    let s = f.get(c"host")?;
    let id = f.get(c"id")?;
    let request = f.get(c"request")?;
    load_chat(f)?;
    load_state(f)?;
    let input = fields(
        s,
        &[
            ("queue", f.get(c"queue")?),
            ("pending", pending),
            ("requestId", request),
        ],
    )?;
    input.spread_from(dismiss_facts(f)?)?;
    let decision = question("dismissal", input)?;
    if !decision.get(c"ok")?.truthy()? || decision.get(c"duplicate")?.truthy()? {
        return Ok(decision);
    }
    f.set(c"task", decision.get(c"taskId")?)?;
    f.set(c"liveness", decision.get(c"liveness")?)?;
    let owner = signal(s)?;
    let opts = fields(f, &[("dismissed", flag(s, true)?)])?;
    let p = if callable(owner, c"resolveAsync")? {
        opts.set(
            c"readDismissFacts",
            callback(f, "readDismissFacts", 0, 0, |f, _| dismiss_facts(f))?,
        )?;
        call(owner, c"resolveAsync", &[id, request, opts])?
    } else {
        dep(s, c"resolveUserInput", &[id, request, opts])?
    };
    after(f, p, |f, res| {
        if !res.optional(c"ok")?.truthy()? || res.get(c"duplicate")?.truthy()? {
            return Ok(res);
        }
        dispatch(f, Action::Dismiss)
    })
}
pub(super) fn settle<'a>(s: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let record = dep(s, c"getRecord", &[id])?;
    if !record.truthy()? {
        return fail(s, "session_not_found");
    }
    let f = saved(s, &[("id", id), ("record", record)])?;
    after(f, status(s, id)?, |f, q| {
        f.set(c"queue", q)?;
        after(
            f,
            pending_input(f.get(c"host")?, f.get(c"id")?)?,
            |f, pending| {
                let decision = question(
                    "recovery",
                    fields(f, &[("queue", f.get(c"queue")?), ("pending", pending)])?,
                )?;
                if !decision.get(c"ok")?.truthy()? {
                    return Ok(decision);
                }
                f.set(c"task", decision.get(c"taskId")?)?;
                f.set(c"request", decision.get(c"requestId")?)?;
                f.set(
                    c"liveness",
                    fields(
                        f,
                        &[
                            ("state", text(f, "inactive")?),
                            ("reason", text(f, "recovered_dead_runner")?),
                        ],
                    )?,
                )?;
                load_state(f)?;
                load_chat(f)?;
                dispatch(f, Action::Recover)
            },
        )
    })
}
fn dispatch(f: L<'_>, action: Action) -> Result<L<'_>> {
    let s = f.get(c"host")?;
    let id = f.get(c"id")?;
    let record = f.get(c"record")?;
    let state = f.get(c"state")?;
    let verdict = fields(
        f,
        &[
            ("state", text(f, action.letter())?),
            ("goal", fallback(state.get(c"goal")?, "".into())?),
            ("phase", fallback(state.get(c"phase")?, "".into())?),
            ("evidence", text(f, action.evidence())?),
            ("requestId", f.get(c"request")?),
        ],
    )?;
    let ctx = fields(
        f,
        &[
            ("sessionName", id),
            ("sessionId", or(record.get(c"id")?, id)?),
            ("cs", f.get(c"cs")?),
            (
                "isTerminal",
                flag(f, !record.get(c"kind")?.is_string("chat")?)?,
            ),
            ("taskId", f.get(c"task")?),
            ("source", text(f, action.source())?),
        ],
    )?;
    if action != Action::Move {
        ctx.set(c"liveness", f.get(c"liveness")?)?;
    }
    dep(s, c"dispatchStateAction", &[verdict, ctx])?;
    let p = map_get(s, c"pendingTransitions", id)?;
    if !p.truthy()? {
        return finish(f, action);
    }
    after(f, p, move |f, res| {
        if res.optional(c"ok")?.is_false()?
            && (action == Action::Recover
                || !res.get(c"code")?.is_string("stale_classification")?)
        {
            return Ok(res);
        }
        finish(f, action)
    })
}
fn reconcile<'a>(s: L<'a>, task: L<'a>, class: &str, reason: &str) -> Result<()> {
    if task.truthy()? {
        maybe_call(
            s.get(c"deps")?,
            c"reconcileTaskProjection",
            &[
                task,
                fields(
                    s,
                    &[
                        ("classifyState", text(s, class)?),
                        ("reason", text(s, reason)?),
                    ],
                )?,
            ],
        )?;
    }
    Ok(())
}
fn finish(f: L<'_>, action: Action) -> Result<L<'_>> {
    let s = f.get(c"host")?;
    let request = f.get(c"request")?;
    let reason = if action == Action::Recover {
        "recovered_pending_question"
    } else {
        action.evidence()
    };
    reconcile(s, f.get(c"task")?, action.letter(), reason)?;
    if action == Action::Recover {
        return fields(
            s,
            &[
                ("ok", flag(s, true)?),
                ("classifyState", text(s, "W")?),
                ("requestId", request),
            ],
        );
    }
    if action == Action::Move {
        let task = f.get(c"targetTask")?;
        reconcile(s, task, "W", reason)?;
        let q = or(f.get(c"moved")?.get(c"question")?, f.get(c"pending")?)?;
        let data = fields(f, &[])?;
        data.spread_from(q)?;
        data.set(c"requestId", request)?;
        data.set(
            c"taskId",
            if task.truthy()? {
                task
            } else {
                q.get(c"taskId")?
            },
        )?;
        dep(
            s,
            c"broadcast",
            &[f.get(c"target")?, question("requiredFrame", data)?],
        )?;
    }
    fields(
        s,
        &[
            ("ok", flag(s, true)?),
            ("requestId", request),
            (
                "resolution",
                text(
                    s,
                    if action == Action::Move {
                        "moved"
                    } else {
                        "dismissed"
                    },
                )?,
            ),
        ],
    )
}
