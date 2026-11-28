use super::*;

fn clear<'a>(s: L<'a>, id: L<'a>) -> Result<()> {
    let map = s.get(c"classificationRetries")?;
    let retry = call(map, c"get", &[id])?;
    let timer = retry.optional(c"timer")?;
    if timer.truthy()? {
        s.global()?.get(c"clearTimeout")?.call_plain(&[timer])?;
    }
    call(map, c"delete", &[id])?;
    Ok(())
}

// A retry belongs to one active entry. A timer may fire after another
// classify or slot replacement; both the timer and durable entry are checked.
fn schedule_retry(f: L<'_>) -> Result<()> {
    let s = f.get(c"host")?;
    let id = f.get(c"id")?;
    let entry = f.get(c"entry")?;
    if !entry.truthy()? {
        return Ok(());
    }
    let map = s.get(c"classificationRetries")?;
    let prior = call(map, c"get", &[id])?;
    if prior.truthy()? && !prior.get(c"entryId")?.equals(entry)? {
        clear(s, id)?;
    }
    let attempts = fallback(
        call(map, c"get", &[id])?.optional(c"attempts")?,
        V::Number(0.),
    )?
    .number()?
        + 1.;
    let delay = 60000f64.min(1000. * 2f64.powf((attempts - 1.).min(6.)));
    let retry = fields(
        s,
        &[
            ("entryId", entry),
            ("attempts", num(s, attempts)?),
            ("timer", null(s)?),
        ],
    )?;
    f.set(c"retry", retry)?;
    let work = callback(f, "", 0, 0, |f, _| {
        let s = f.get(c"host")?;
        let id = f.get(c"id")?;
        let retry = f.get(c"retry")?;
        if !map_get(s, c"classificationRetries", id)?.equals(retry)? {
            return undef(s);
        }
        retry.set(c"timer", null(s)?)?;
        let opts = fields(s, &[])?;
        opts.spread_from(f.get(c"options")?)?;
        opts.set(c"_retryEntryId", f.get(c"entry")?)?;
        let p = transition(s, id, f.get(c"task")?, f.get(c"result")?, opts)?;
        call(p, c"catch", &[callback(s, "", 0, 0, |s, _| undef(s))?])?;
        undef(s)
    })?;
    let timer = s
        .global()?
        .get(c"setTimeout")?
        .call_plain(&[work, num(s, delay)?])?;
    retry.set(c"timer", timer)?;
    maybe_call(timer, c"unref", &[])?;
    call(map, c"set", &[id, retry])?;
    logger(
        s,
        c"warn",
        "session_scheduler_classification_retry_scheduled",
        fields(
            s,
            &[
                ("sessionId", id),
                ("entryId", entry),
                ("attempt", num(s, attempts)?),
                ("delayMs", num(s, delay)?),
            ],
        )?,
    )
}

pub(in crate::session_work_host) fn transition<'a>(
    s: L<'a>,
    id: L<'a>,
    task: L<'a>,
    result: L<'a>,
    opts: L<'a>,
) -> Result<L<'a>> {
    if !opts.get(c"_retryEntryId")?.truthy()? {
        clear(s, id)?;
    }
    let promise = async_result(s, || {
        let rt = runtime(s)?;
        let target = rt.optional(c"sessionScheduler")?;
        if !target.truthy()? || !id.truthy()? {
            return fail(s, "scheduler_not_ready");
        }
        let f = saved(
            s,
            &[
                ("id", id),
                ("task", task),
                ("result", result),
                ("options", opts),
                ("runtime", rt),
                ("target", target),
                ("entry", n(opts.get(c"_retryEntryId")?)?),
            ],
        )?;
        let run = async_result(s, || {
            let closing = map_get(s, c"turnClosures", id)?;
            if closing.truthy()? {
                after(f, closing, |f, _| read_slot(f))
            } else {
                read_slot(f)
            }
        })?;
        let failed = callback(f, "", 1, 1, |f, a| {
            let s = f.get(c"host")?;
            logger(
                s,
                c"warn",
                "session_scheduler_classification_transition_failed",
                fields(
                    s,
                    &[
                        ("sessionId", f.get(c"id")?),
                        ("error", a[0].get(c"message")?),
                    ],
                )?,
            )?;
            schedule_retry(f)?;
            fail(f, "classification_transition_failed")
        })?;
        let p = call(run, c"catch", &[failed])?;
        // Returning settleUserInput itself (without await) preserves its original
        // rejection. Only errors from invoking that operation trigger a retry.
        after(f, p, |f, r| {
            let pending = f.get(c"settlement")?;
            if pending.undefined()? {
                Ok(r)
            } else {
                Ok(pending)
            }
        })
    })?;
    if id.truthy()? {
        track(s, c"pendingTransitions", id, promise)
    } else {
        Ok(promise)
    }
}
fn read_slot(f: L<'_>) -> Result<L<'_>> {
    after(
        f,
        call(f.get(c"target")?, c"status", &[f.get(c"id")?])?,
        observe_slot,
    )
}
fn dispatch_result_entry(id: L<'_>) -> Result<bool> {
    let v = fallback(id, "".into())?.coerce_string()?.to_string_lossy();
    let mut parts = v.split(':');
    if parts.next() != Some("operation")
        || parts.next().unwrap_or("").is_empty()
        || parts.next() != Some("result")
    {
        return Ok(false);
    }
    Ok(match parts.next() {
        None => true,
        Some(v) => !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) && parts.next().is_none(),
    })
}
fn task_interrupted_entry(id: L<'_>) -> Result<bool> {
    let v = fallback(id, "".into())?.coerce_string()?.to_string_lossy();
    let mut parts = v.split(':');
    Ok(parts.next() == Some("task")
        && !parts.next().unwrap_or("").is_empty()
        && parts.next() == Some("interrupted")
        && parts.next().is_none())
}
fn observe_slot<'a>(f: L<'a>, q: L<'a>) -> Result<L<'a>> {
    let s = f.get(c"host")?;
    let id = f.get(c"id")?;
    let opts = f.get(c"options")?;
    let active = q.optional(c"active")?;
    let entry = active.optional(c"entryId")?;
    let retried = opts.get(c"_retryEntryId")?;
    if retried.truthy()? && !entry.equals(retried)? {
        clear(s, id)?;
        return fail(s, "stale_classification");
    }
    if entry.truthy()? {
        f.set(c"entry", entry)?;
    }
    if dispatch_result_entry(entry)? || task_interrupted_entry(entry)? {
        f.set(c"task", null(s)?)?;
    }
    let task = f.get(c"task")?;
    let slot = active.optional(c"taskId")?;
    if task.truthy()? && slot.truthy()? && !task.equals(slot)? {
        clear(s, id)?;
        return fail(s, "active_task_mismatch");
    }
    let state = q.optional(c"state")?;
    if active.truthy()?
        && opts.get(c"recoverMissingBoundary")?.is_true()?
        && (state.is_string("starting")? || state.is_string("running")?)
    {
        return after(
            f,
            call(f.get(c"target")?, c"turnEnded", &[id])?,
            |f, res| {
                if !res.optional(c"ok")?.truthy()? {
                    return if res.truthy()? {
                        Ok(res)
                    } else {
                        fail(f, "turn_boundary_recovery_failed")
                    };
                }
                let id = f.get(c"id")?;
                after(
                    f,
                    call(f.get(c"target")?, c"status", &[id])?,
                    |f, current| {
                        logger(
                            f.get(c"host")?,
                            c"info",
                            "session_scheduler_turn_boundary_recovered",
                            fields(
                                f,
                                &[
                                    ("sessionId", f.get(c"id")?),
                                    (
                                        "reason",
                                        fallback(
                                            f.get(c"options")?.get(c"livenessReason")?,
                                            "confirmed_inactive".into(),
                                        )?,
                                    ),
                                ],
                            )?,
                        )?;
                        apply(f, current)
                    },
                )
            },
        );
    }
    apply(f, q)
}
fn apply<'a>(f: L<'a>, q: L<'a>) -> Result<L<'a>> {
    let s = f.get(c"host")?;
    let id = f.get(c"id")?;
    let target = f.get(c"target")?;
    let result = f.get(c"result")?;
    let active = q.optional(c"active")?;
    if !active.truthy()?
        && result
            .get(c"evidence")?
            .is_string("user_dismissed_question")?
    {
        f.set(
            c"settlement",
            call(target, c"settleUserInput", &[id, result.get(c"requestId")?])?,
        )?;
        return undef(f);
    }
    let state = q.optional(c"state")?;
    if !active.truthy()? || !(state.is_string("assessing")? || state.is_string("frozen")?) {
        clear(s, id)?;
        return fail(s, "stale_classification");
    }
    let task = f.get(c"task")?;
    let expected = if task.truthy()? {
        task
    } else {
        n(active.get(c"taskId")?)?
    };
    let letter = result.optional(c"state")?;
    let class = if letter.is_string("E")? {
        "E"
    } else if letter.is_string("D")? {
        "D"
    } else if letter.is_string("B")? || call(f.get(c"runtime")?, c"hasPending", &[id])?.truthy()? {
        "B"
    } else {
        "W"
    };
    let opts = fields(
        f,
        &[
            ("expectedTaskId", expected),
            ("reason", text(f, &format!("classified_{class}"))?),
            ("classifyState", text(f, class)?),
        ],
    )?;
    f.set(c"completeOptions", opts)?;
    after(f, pending_input(s, id)?, |f, pending| {
        let opts = f.get(c"completeOptions")?;
        if pending.truthy()? && !pending.get(c"resolved")?.is_true()? {
            opts.set(c"awaitingRequestId", pending.get(c"requestId")?)?;
        }
        after(
            f,
            call(f.get(c"target")?, c"complete", &[f.get(c"id")?, opts])?,
            |f, res| {
                if !res.optional(c"ok")?.truthy()? {
                    return Ok(res);
                }
                clear(f.get(c"host")?, f.get(c"id")?)?;
                f.set(c"completed", res)?;
                after(f, call(f.get(c"runtime")?, c"tick", &[])?, |f, _| {
                    let class = f.get(c"completeOptions")?.get(c"classifyState")?;
                    let s = f.get(c"host")?;
                    if class.is_string("D")? {
                        call(s.get(c"deadRunnerRetries")?, c"delete", &[f.get(c"id")?])?;
                    } else if class.is_string("E")? {
                        return after(f, dead_runner(f)?, |f, _| f.get(c"completed"));
                    }
                    f.get(c"completed")
                })
            },
        )
    })
}

fn is_watchdog(f: L<'_>) -> Result<bool> {
    let s = f.get(c"host")?;
    if f.get(c"result")?
        .optional(c"cancel")?
        .optional(c"source")?
        .is_string("process_watchdog")?
    {
        return Ok(true);
    }
    let state = dep(
        s,
        c"getTaskState",
        &[dep(s, c"getRecord", &[f.get(c"id")?])?],
    )?;
    if !state
        .optional(c"cancelSource")?
        .is_string("process_watchdog")?
    {
        return Ok(false);
    }
    let cancelled = fallback(state.get(c"cancelledAt")?, V::Number(0.))?.explicit_number()?;
    Ok(cancelled > 0.
        && call(s.global()?.get(c"Date")?, c"now", &[])?.number()? - cancelled <= 60_000.)
}
fn dead_runner(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"host")?;
    let p = async_result(s, || {
        if !is_watchdog(f)?
            || f.get(c"result")?
                .optional(c"cancel")?
                .optional(c"runnerStopped")?
                .is_false()?
        {
            return undef(s);
        }
        let target = scheduler(s)?;
        if !target.truthy()? {
            return undef(s);
        }
        f.set(c"retryTarget", target)?;
        after(f, call(target, c"status", &[f.get(c"id")?])?, |f, fresh| {
            if !fresh.optional(c"classifyState")?.is_string("E")?
                || fresh.get(c"active")?.truthy()?
            {
                return undef(f);
            }
            let queue = fresh.get(c"queued")?;
            if queue.truthy()? && queue.get(c"length")?.positive()? {
                return undef(f);
            }
            let s = f.get(c"host")?;
            let id = f.get(c"id")?;
            let entry = f.get(c"entry")?;
            let streak =
                fallback(map_get(s, c"deadRunnerRetries", id)?, V::Number(0.))?.number()? + 1.;
            let info = fields(
                f,
                &[
                    ("sessionId", id),
                    ("entryId", entry),
                    ("streak", num(f, streak)?),
                ],
            )?;
            if streak > 2. {
                logger(
                    s,
                    c"warn",
                    "session_scheduler_dead_runner_retry_exhausted",
                    info,
                )?;
                return undef(f);
            }
            f.set(c"retryInfo", info)?;
            let key = format!(
                "watchdog-retry:{}",
                or(entry, id)?.coerce_string()?.to_string_lossy()
            );
            let opts = fields(
                f,
                &[
                    ("action", text(f, "retry")?),
                    ("actor", text(f, "process_watchdog")?),
                    ("reason", text(f, "dead_runner_auto_retry")?),
                    ("idempotencyKey", text(f, &key)?),
                ],
            )?;
            after(
                f,
                call(f.get(c"retryTarget")?, c"resolve", &[id, opts])?,
                |f, r| {
                    if r.optional(c"ok")?.truthy()? && !r.get(c"duplicate")?.truthy()? {
                        let s = f.get(c"host")?;
                        let info = f.get(c"retryInfo")?;
                        call(
                            s.get(c"deadRunnerRetries")?,
                            c"set",
                            &[f.get(c"id")?, info.get(c"streak")?],
                        )?;
                        logger(s, c"warn", "session_scheduler_dead_runner_auto_retry", info)?;
                    }
                    undef(f)
                },
            )
        })
    })?;
    call(
        p,
        c"catch",
        &[callback(f, "", 1, 1, |f, a| {
            logger(
                f.get(c"host")?,
                c"warn",
                "session_scheduler_dead_runner_retry_failed",
                fields(
                    f,
                    &[
                        ("sessionId", f.get(c"id")?),
                        ("entryId", f.get(c"entry")?),
                        ("error", a[0].optional(c"message")?),
                    ],
                )?,
            )?;
            undef(f)
        })?],
    )
}
