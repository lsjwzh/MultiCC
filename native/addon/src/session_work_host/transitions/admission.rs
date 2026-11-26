use super::*;

pub(super) fn admit<'a>(s: L<'a>, id: L<'a>, body: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    if !dep(s, c"getRecord", &[id])?.truthy()? {
        return fail(s, "session_not_found");
    }
    let f = saved(s, &[("id", id), ("text", body), ("opts", opts)])?;
    if opts.get(c"interrupt")?.truthy()? {
        let target = scheduler(s)?;
        if target.truthy()? {
            return after(f, call(target, c"status", &[id])?, |f, q| {
                if q.optional(c"active")?.truthy()? {
                    let s = f.get(c"host")?;
                    let id = f.get(c"id")?;
                    let force = text(s, "force_insert")?;
                    let p = super::super::cancel::cancel_active_turn(
                        s,
                        id,
                        fields(s, &[("source", force), ("reason", force)])?,
                    )?;
                    after(f, p, |f, _| check_auth(f))
                } else {
                    check_auth(f)
                }
            });
        }
    }
    check_auth(f)
}
fn check_auth(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"host")?;
    let id = f.get(c"id")?;
    let record = dep(s, c"getRecord", &[id])?;
    let cli = record.optional(c"cli")?;
    let ports = if cli.is_string("zcode")? {
        Some((c"zcodeAuth", c"ensureZcodeAuth", "ZCode 尚未配置 API Key。"))
    } else if cli.is_string("kimi")? {
        Some((c"kimiAuth", c"ensureKimiAuth", "Kimi Code 尚未登录。"))
    } else {
        None
    };
    if let Some((port, method, fallback_msg)) = ports {
        let result = call(s.get(port)?, method, &[record])?;
        if !result.get(c"ok")?.truthy()? {
            let message = result.get(c"message")?;
            let code = text(s, "configuration_required")?;
            dep(
                s,
                c"broadcast",
                &[
                    id,
                    fields(
                        s,
                        &[
                            ("type", text(s, "error")?),
                            ("error", fallback(message, fallback_msg.into())?),
                            ("code", code),
                        ],
                    )?,
                ],
            )?;
            return fields(
                s,
                &[
                    ("ok", flag(s, false)?),
                    ("code", code),
                    ("message", message),
                ],
            );
        }
    }
    let close = map_get(s, c"turnClosures", id)?;
    if close.truthy()? {
        after(f, close, |f, _| initialize(f))
    } else {
        initialize(f)
    }
}
fn initialize(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"host")?;
    let rt = runtime(s)?;
    if !rt.optional(c"admitSessionWork")?.truthy()? || !rt.get(c"sessionScheduler")?.truthy()? {
        return fail(s, "scheduler_not_ready");
    }
    f.set(c"runtime", rt)?;
    let p = async_result(s, || {
        let q = signal(s)?;
        let id = f.get(c"id")?;
        if callable(q, c"pendingAsync")? {
            after(f, call(q, c"pendingAsync", &[id])?, |f, _| refresh(f))
        } else {
            refresh(f)
        }
    })?;
    let rejected = callback(f, "", 1, 1, |f, a| {
        let s = f.get(c"host")?;
        let err = a[0];
        let q = signal(s)?;
        logger(
            s,
            c"warn",
            "session_work_admission_failed",
            fields(
                s,
                &[
                    ("sessionId", f.get(c"id")?),
                    ("code", fallback(err.optional(c"code")?, "unknown".into())?),
                    (
                        "questionOwner",
                        text(
                            s,
                            if callable(q, c"pendingAsync")? {
                                "ordered"
                            } else {
                                "legacy"
                            },
                        )?,
                    ),
                ],
            )?,
        )?;
        Err(err.throw_error())
    })?;
    let accepted = callback(f, "", 1, 1, |f, a| admitted(f, a[0]))?;
    call(p, c"then", &[accepted, rejected])
}
fn refresh(f: L<'_>) -> Result<L<'_>> {
    let q = signal(f.get(c"host")?)?;
    if callable(q, c"refreshAdmissionFactsAsync")? {
        after(
            f,
            call(q, c"refreshAdmissionFactsAsync", &[f.get(c"id")?])?,
            |f, _| submit(f),
        )
    } else {
        submit(f)
    }
}
fn submit(f: L<'_>) -> Result<L<'_>> {
    let input = fields(
        f,
        &[
            ("sessionId", f.get(c"id")?),
            ("text", f.get(c"text")?),
            ("options", f.get(c"opts")?),
            ("hostAdmission", flag(f, true)?),
        ],
    )?;
    call(f.get(c"runtime")?, c"admitSessionWork", &[input])
}
fn admitted<'a>(f: L<'a>, result: L<'a>) -> Result<L<'a>> {
    let s = f.get(c"host")?;
    let id = f.get(c"id")?;
    if !result.get(c"ok")?.truthy()? {
        let code = result.get(c"code")?;
        let message = if code.is_string("request_id_mismatch")? {
            "这条回答不属于当前待确认问题，未执行。".to_string()
        } else {
            format!(
                "消息入队失败：{}",
                fallback(code, "scheduler_rejected".into())?
                    .coerce_string()?
                    .to_string_lossy()
            )
        };
        dep(
            s,
            c"broadcast",
            &[
                id,
                fields(
                    s,
                    &[("type", text(s, "error")?), ("error", text(s, &message)?)],
                )?,
            ],
        )?;
    } else {
        let note = result.get(c"notification")?;
        if note.truthy()? {
            if let Err(e) = dep(s, c"broadcast", &[id, note]) {
                let message = if let Some(value) = s.exception_value()? {
                    value.get(c"message")?
                } else {
                    text(s, &e.reason)?
                };
                logger(
                    s,
                    c"warn",
                    "session_user_input_notification_failed",
                    fields(s, &[("sessionId", id), ("error", message)])?,
                )?;
            }
        }
    }
    Ok(result)
}

pub(super) fn resolve_task<'a>(s: L<'a>, id: L<'a>, task: L<'a>) -> Result<L<'a>> {
    let rt = runtime(s)?;
    let target = rt.optional(c"sessionScheduler")?;
    if !target.truthy()? {
        return fail(s, "scheduler_not_ready");
    }
    let f = fields(s, &[("id", id), ("runtime", rt), ("task", task)])?;
    after(f, call(target, c"status", &[id])?, |f, queue| {
        let active = queue.get(c"active")?;
        if !active.truthy()? {
            return fail(f, "no_active_task");
        }
        let task = active.get(c"taskId")?;
        if task.truthy()? && !task.equals(f.get(c"task")?)? {
            return fail(f, "active_task_mismatch");
        }
        let opts = fields(
            f,
            &[
                ("action", text(f, "resolve")?),
                ("reason", text(f, "task board explicitly marked completed")?),
                ("actor", text(f, "user")?),
            ],
        )?;
        let rt = f.get(c"runtime")?;
        after(
            f,
            call(
                rt.get(c"sessionScheduler")?,
                c"resolve",
                &[f.get(c"id")?, opts],
            )?,
            |f, result| {
                if result.get(c"ok")?.truthy()? {
                    after(result, call(f.get(c"runtime")?, c"tick", &[])?, |res, _| {
                        Ok(res)
                    })
                } else {
                    Ok(result)
                }
            },
        )
    })
}
