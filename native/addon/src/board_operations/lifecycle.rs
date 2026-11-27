use super::*;

fn phase<'a>(ctx: L<'a>, operation: &str) -> Result<L<'a>> {
    let (opts, _) = pair(ctx)?;
    let commit = function(ctx, "mutation", 1, 1, {
        let lifecycle = matches!(operation, "archive" | "restore");
        let operation = operation.to_owned();
        move |ctx, a| {
            let (_, ports) = pair(ctx)?;
            let input = fields(
                ctx,
                &[("board", a[0]), ("operation", text(ctx, &operation)?)],
            )?;
            if lifecycle {
                input.set(c"taskId", ctx.get(c"task")?.get(c"id")?)?;
                input.set(c"now", call(ctx.global()?.get(c"Date")?, c"now", &[])?)?;
            } else {
                input.set(c"ids", ctx.get(c"ids")?)?;
            }
            invoke(ports, c"boardRule", &[text(ctx, "lifecycle")?, input])
        }
    })?;
    invoke(opts, c"commit", &[commit])
}
fn committed(ctx: L<'_>, name: &str) -> Result<()> {
    let result = phase(ctx, name)?;
    if result.get(c"ok")?.truthy()? {
        return Ok(());
    }
    let code = result.get(c"error")?;
    Err(coded(ctx, code, code, Some(500))?)
}
fn protected_call<'a>(ctx: L<'a>, action: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    let (opts, _) = pair(ctx)?;
    if ctx.get(c"runtime")?.get(c"boardPorts")?.truthy()? {
        let deps = opts.get(c"deps")?;
        if action == c"assertIdle" {
            let hook = deps.get(c"assertTaskIdle")?;
            return if hook.nullish()? {
                undef(ctx)
            } else {
                hook.call(
                    deps,
                    &[args[0], invoke(opts, c"taskIdentityIds", &[args[0]])?],
                )
            };
        }
        if action == c"preparePurge" {
            return optional_call(deps, c"prepareTaskDelete", args);
        }
        if !deps.get(c"purgeTaskData")?.truthy()? {
            return Err(denied(ctx, "task_delete_unavailable", None)?);
        }
        return call(deps, c"purgeTaskData", args);
    }
    let f = opts.get(action)?;
    if action == c"preparePurge" && f.nullish()? {
        undef(ctx)
    } else {
        f.call_plain(args)
    }
}
fn after_purge<'a>(ctx: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let (opts, _) = pair(ctx)?;
    committed(ctx, "delete")?;
    let ids = ctx.get(c"ids")?;
    invoke(
        opts,
        c"notify",
        &[ctx.get(c"dirId")?, ids, text(ctx, "deleted")?],
    )?;
    fields(
        ctx,
        &[
            ("ok", flag(ctx, true)?),
            ("deleted", flag(ctx, true)?),
            ("taskIds", ids),
        ],
    )
}
fn preflight_complete<'a>(ctx: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let guard = ctx.get(c"input")?.get(c"guard")?;
    if guard.truthy()? && !guard.call_plain(&[])?.truthy()? {
        return Err(denied(ctx, "no_longer_eligible", None)?);
    }
    committed(ctx, "barrier")?;
    let purging = async_result(ctx, || {
        protected_call(
            ctx,
            c"purge",
            &[
                ctx.get(c"task")?,
                ctx.get(c"ids")?,
                ctx.get(c"purgeOptions")?,
            ],
        )
    })?;
    let handled = recover(purging, ctx, |ctx, a| {
        let (_, ports) = pair(ctx)?;
        let reason = fields(ctx, &[("code", a[0].get(c"code")?)])?;
        if invoke(
            ports,
            c"boardRule",
            &[text(ctx, "permanentPurgeRefusal")?, reason],
        )?
        .truthy()?
        {
            ctx.catch(|| phase(ctx, "rollback"))?;
        }
        Err(a[0].throw_error())
    })?;
    then(handled, ctx, after_purge)
}
fn after_idle<'a>(ctx: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let (opts, ports) = pair(ctx)?;
    let task = ctx.get(c"task")?;
    let deleting = ctx.get(c"action")?.is_string("delete")?;
    let input = ctx.get(c"input")?;
    let expected = if deleting {
        input.get(c"expectedRevision")?
    } else {
        let b = ctx.get(c"req")?.get(c"body")?;
        let expected = b.optional(c"expectedRevision")?;
        if expected.nullish()? {
            b.optional(c"revision")?
        } else {
            expected
        }
    };
    let valid = invoke(
        ports,
        c"boardRule",
        &[
            text(ctx, "lifecycleValidate")?,
            fields(ctx, &[("task", task), ("expectedRevision", expected)])?,
        ],
    )?;
    if !valid.get(c"ok")?.truthy()? {
        return Err(denied(ctx, "revision_conflict", None)?);
    }
    let ids = invoke(opts, c"taskIdentityIds", &[task])?;
    let dir = invoke(opts, c"taskDirId", &[task])?;
    ctx.set(c"ids", ids)?;
    ctx.set(c"dirId", dir)?;
    if deleting {
        let purge_opts = fields(
            ctx,
            &[("force", flag(ctx, strict_true(input.get(c"force")?)?)?)],
        )?;
        if strict_true(input.get(c"automatic")?)? {
            purge_opts.set(c"automatic", flag(ctx, true)?)?;
        }
        ctx.set(c"purgeOptions", purge_opts)?;
        return then(
            protected_call(ctx, c"preparePurge", &[task, ids, purge_opts])?,
            ctx,
            preflight_complete,
        );
    }
    let res = ctx.get(c"res")?;
    let action = fold_string(ctx.get(c"action")?)?;
    let result = phase(ctx, &action)?;
    if !result.get(c"ok")?.truthy()? {
        return send(
            res,
            Some(500),
            fields(
                ctx,
                &[("ok", flag(ctx, false)?), ("error", result.get(c"error")?)],
            )?,
        );
    }
    invoke(opts, c"notify", &[dir, ids])?;
    let dto = invoke(
        opts,
        c"taskDto",
        &[invoke(opts, c"resolveTask", &[task.get(c"id")?])?],
    )?;
    send(
        res,
        None,
        fields(
            ctx,
            &[
                ("ok", flag(ctx, true)?),
                ("releasedSession", flag(ctx, false)?),
                ("releasedSessions", num(ctx, 0.)?),
                ("task", dto),
                (
                    "revision",
                    invoke(opts, c"getBoard", &[])?.get(c"revision")?,
                ),
            ],
        )?,
    )
}
fn run(ctx: L<'_>) -> Result<L<'_>> {
    let (opts, _) = pair(ctx)?;
    let id = ctx.get(c"id")?;
    let task = invoke(opts, c"resolveTask", &[id])?;
    let delete = ctx.get(c"action")?.is_string("delete")?;
    if !task.truthy()? {
        if delete {
            let removed = invoke(opts, c"getBoard", &[])?.get(c"deletedTaskIds")?;
            if !removed.nullish()? && call(removed, c"includes", &[id])?.truthy()? {
                return fields(
                    ctx,
                    &[("ok", flag(ctx, true)?), ("deleted", flag(ctx, true)?)],
                );
            }
        }
        return Err(denied(ctx, "task_not_found", Some(404))?);
    }
    let pending = ctx.get(c"runtime")?.get(c"pending")?;
    let id = task.get(c"id")?;
    if call(pending, c"has", &[id])?.truthy()?
        || call(opts.get(c"activeOperations")?, c"get", &[id])?.truthy()?
    {
        return Err(denied(ctx, "task_busy", None)?);
    }
    ctx.set(c"task", task)?;
    call(pending, c"add", &[id])?;
    let work = async_result(ctx, || {
        if !delete && task.get(c"deleting")?.truthy()? {
            return Err(denied(ctx, "task_deleting", None)?);
        }
        then(
            protected_call(ctx, c"assertIdle", &[task])?,
            ctx,
            after_idle,
        )
    })?;
    call(
        work,
        c"finally",
        &[function(ctx, "release", 0, 0, |ctx, _| {
            call(
                ctx.get(c"runtime")?.get(c"pending")?,
                c"delete",
                &[ctx.get(c"task")?.get(c"id")?],
            )
        })?],
    )
}
fn respond_error<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let err = a[0];
    let (_, ports) = pair(ctx)?;
    let code = err.get(c"code")?;
    let why = if code.truthy()? {
        code
    } else {
        fallback(err.get(c"message")?, "task_lifecycle_failed".into())?
    };
    let body = fields(ctx, &[("ok", flag(ctx, false)?), ("error", why)])?;
    for key in [c"reasons", c"tasks"] {
        let rows = err.get(key)?;
        if !rows.is_array()? || !rows.get(c"length")?.truthy()? {
            continue;
        }
        body.set(key, rows)?;
        if key == c"tasks" {
            let mut ids = err.get(c"taskIds")?;
            if !ids.is_array()? {
                ids = array(ctx)?;
                rows.for_each(|v| {
                    let id = v.optional(c"id")?;
                    if id.truthy()? {
                        call(ids, c"push", &[id])?;
                    }
                    Ok(())
                })?;
            }
            body.set(c"taskIds", ids)?;
            if code.is_string("TASK_HISTORY_REFERENCED")? {
                body.set(
                    c"message",
                    invoke(ports, c"historyRefusal", &[err])?.get(c"error")?,
                )?;
            }
        }
    }
    let status = if ctx.get(c"action")?.is_string("delete")? {
        fallback(err.get(c"status")?, 409f64.into())?
    } else if !ctx.get(c"task")?.truthy()? && code.is_string("task_not_found")? {
        num(ctx, 404.)?
    } else {
        num(ctx, 409.)?
    };
    json_status(ctx.get(c"res")?, status, body)
}
fn route<'a>(r: L<'a>, req: L<'a>, res: L<'a>, action: &str) -> Result<L<'a>> {
    async_result(r, || {
        let body = req.get(c"body")?;
        let options = fields(r, &[])?;
        if action == "delete" {
            options.set(c"force", flag(r, strict_true(body.optional(c"force")?)?)?)?;
            let rev = body.optional(c"expectedRevision")?;
            options.set(
                c"expectedRevision",
                if rev.nullish()? {
                    body.optional(c"revision")?
                } else {
                    rev
                },
            )?;
        }
        let ctx = fields(
            r,
            &[
                ("runtime", r),
                ("req", req),
                ("res", res),
                ("id", req.get(c"params")?.get(c"taskId")?),
                ("action", text(r, action)?),
                ("input", options),
            ],
        )?;
        let result = async_result(ctx, || run(ctx))?;
        let result = if action == "delete" {
            then(result, res, |res, a| send(res, None, a[0]))?
        } else {
            result
        };
        recover(result, ctx, respond_error)
    })
}
pub(super) fn create<'a>(p: L<'a>, options: L<'a>, board: bool) -> Result<L<'a>> {
    let r = owner(p, options)?;
    r.set(c"boardPorts", flag(r, board)?)?;
    r.set(c"pending", r.global()?.get(c"Set")?.construct(&[])?)?;
    methods(
        r,
        &[
            ("isBusy", 1, |r, a| {
                let task = invoke(r.get(c"options")?, c"resolveTask", &[a[0]])?;
                let id = task.optional(c"id")?;
                call(
                    r.get(c"pending")?,
                    c"has",
                    &[if id.truthy()? { id } else { a[0] }],
                )
            }),
            ("deleteById", 2, |r, a| {
                async_result(r, || {
                    run(fields(
                        r,
                        &[
                            ("runtime", r),
                            ("id", a[0]),
                            ("input", default_object(a[1])?),
                            ("action", text(r, "delete")?),
                        ],
                    )?)
                })
            }),
            ("archive", 2, |r, a| route(r, a[0], a[1], "archive")),
            ("restore", 2, |r, a| route(r, a[0], a[1], "restore")),
            ("delete", 2, |r, a| route(r, a[0], a[1], "delete")),
        ],
    )
}
