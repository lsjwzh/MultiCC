use super::*;

fn refused<'a>(ctx: L<'a>, body: L<'a>, status: L<'a>) -> Result<L<'a>> {
    let merged = fields(ctx, &[("ok", flag(ctx, false)?)])?;
    merged.spread_from(body)?;
    json_status(ctx.get(c"res")?, status, merged)
}
fn fail<'a>(ctx: L<'a>, code: L<'a>, status: L<'a>) -> Result<L<'a>> {
    refused(ctx, fields(ctx, &[("error", code)])?, status)
}
fn fail_move<'a>(ctx: L<'a>, err: L<'a>) -> Result<L<'a>> {
    let (opts, _) = pair(ctx)?;
    let logger = with_default(opts.get(c"logger")?, ctx.global()?.get(c"console")?)?;
    optional_call(
        logger,
        c"warn",
        &[
            text(ctx, "task_relocate_failed")?,
            fields(
                ctx,
                &[
                    ("taskId", ctx.get(c"task")?.get(c"id")?),
                    ("error", err.get(c"message")?),
                ],
            )?,
        ],
    )?;
    fail(
        ctx,
        fallback(err.get(c"code")?, "task_relocate_failed".into())?,
        fallback(err.get(c"status")?, 500f64.into())?,
    )
}
fn commit(ctx: L<'_>) -> Result<L<'_>> {
    let (opts, _) = pair(ctx)?;
    let plan = ctx.get(c"plan")?;
    let t = ctx.get(c"task")?;
    let result = invoke(
        opts,
        c"commit",
        &[function(ctx, "relocateBoard", 1, 1, |ctx, a| {
            let (_, ports) = pair(ctx)?;
            invoke(
                ports,
                c"commit",
                &[
                    a[0],
                    ctx.get(c"plan")?,
                    ctx.get(c"runtime")?.get(c"workspace")?.get(c"records")?,
                    ctx.get(c"record")?,
                    ctx.get(c"ledger")?,
                    ports.get(c"assign")?,
                ],
            )
        })?],
    )?;
    if !result.get(c"ok")?.truthy()? {
        return fail(
            ctx,
            fallback(result.get(c"error")?, "persistence_failed".into())?,
            num(ctx, 500.)?,
        );
    }
    let target = plan.get(c"targetDirId")?;
    let shell = ctx.get(c"runtime")?.get(c"shell")?;
    if callable(shell)? {
        shell.call_plain(&[t.get(c"id")?, target])?;
    }
    for dir in [plan.get(c"currentDirId")?, target] {
        invoke(
            opts,
            c"notify",
            &[dir, ctx.get(c"ids")?, text(ctx, "relocated")?],
        )?;
    }
    let dto = invoke(
        opts,
        c"taskDto",
        &[invoke(opts, c"resolveTask", &[t.get(c"id")?])?],
    )?;
    send(
        ctx.get(c"res")?,
        None,
        fields(
            ctx,
            &[
                ("ok", flag(ctx, true)?),
                ("task", dto),
                ("dirId", target),
                ("cwd", ctx.get(c"cwd")?),
                ("carried", ctx.get(c"carried")?),
                (
                    "planned",
                    flag(
                        ctx,
                        !ctx.get(c"before")?.truthy()? && !ctx.get(c"ledger")?.truthy()?,
                    )?,
                ),
            ],
        )?,
    )
}
fn move_ledger(ctx: L<'_>) -> Result<L<'_>> {
    let task = ctx.get(c"task")?;
    let path = task.get(c"worktreePath")?;
    let old = ctx.get(c"oldDir")?;
    if !path.truthy()?
        || !task.get(c"branch")?.truthy()?
        || !old.truthy()?
        || path.equals(ctx.get(c"before")?)?
    {
        return undef(ctx);
    }
    let result = invoke(
        ctx.get(c"runtime")?.get(c"workspace")?,
        c"gitRelocateWorktree",
        &[
            old,
            ctx.get(c"plan")?.get(c"targetDir")?,
            pick(task, &[c"id", c"worktreePath", c"branch"])?,
            fields(ctx, &[("carry", flag(ctx, true)?)])?,
        ],
    )?;
    then(result, ctx, |ctx, a| {
        let moved = a[0];
        if !moved.get(c"ok")?.truthy()? {
            ctx.set(c"finished", flag(ctx, true)?)?;
            return refused(
                ctx,
                moved,
                num(
                    ctx,
                    if moved.get(c"blocked")?.truthy()? {
                        409.
                    } else {
                        500.
                    },
                )?,
            );
        }
        ctx.set(c"ledger", moved)?;
        if !ctx.get(c"carried")?.truthy()? {
            ctx.set(c"carried", fallback(moved.get(c"carried")?, V::Null)?)?;
        }
        undef(ctx)
    })
}
fn move_workspaces(ctx: L<'_>) -> Result<L<'_>> {
    let rec = ctx.get(c"record")?;
    if !rec.truthy()? {
        return move_ledger(ctx);
    }
    let moved = invoke(
        ctx.get(c"runtime")?.get(c"workspace")?,
        c"relocateSessionWorkspace",
        &[
            rec.get(c"id")?,
            ctx.get(c"plan")?.get(c"targetDirId")?,
            fields(
                ctx,
                &[("force", flag(ctx, true)?), ("carry", flag(ctx, true)?)],
            )?,
        ],
    )?;
    then(moved, ctx, |ctx, a| {
        let result = a[0];
        if !result.get(c"ok")?.truthy()? {
            ctx.set(c"finished", flag(ctx, true)?)?;
            return json_status(
                ctx.get(c"res")?,
                fallback(result.get(c"status")?, 500f64.into())?,
                result.get(c"body")?,
            );
        }
        ctx.set(c"carried", fallback(result.get(c"carried")?, V::Null)?)?;
        let cwd = result.get(c"cwd")?;
        if cwd.truthy()? {
            ctx.set(c"cwd", cwd)?;
        }
        move_ledger(ctx)
    })
}
fn idle<'a>(ctx: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let deps = ctx.get(c"runtime")?.get(c"workspace")?;
    let task = ctx.get(c"task")?;
    let plan = ctx.get(c"plan")?;
    let target = plan.get(c"targetDirId")?;
    let session = task.get(c"chatSessionId")?;
    let record = if session.truthy()? {
        call(deps.get(c"records")?, c"get", &[session])?
    } else {
        null(ctx)?
    };
    ctx.set(c"record", record)?;
    ctx.set(
        c"before",
        fallback(record.optional(c"worktreePath")?, V::Null)?,
    )?;
    let current = plan.get(c"currentDirId")?;
    let old = if current.truthy()? {
        call(deps.get(c"directories")?, c"get", &[current])?
    } else {
        null(ctx)?
    };
    ctx.set(c"oldDir", old)?;
    let shell = ctx.get(c"runtime")?.get(c"shell")?;
    if callable(shell)? {
        let result = shell.call_plain(&[
            task.get(c"id")?,
            target,
            fields(ctx, &[("dryRun", flag(ctx, true)?)])?,
        ])?;
        if !result.get(c"ok")?.truthy()? {
            return fail(
                ctx,
                fallback(result.get(c"code")?, "task_shell_shared".into())?,
                num(ctx, 409.)?,
            );
        }
    }
    ctx.set(c"carried", null(ctx)?)?;
    ctx.set(c"ledger", null(ctx)?)?;
    ctx.set(c"cwd", plan.get(c"targetDir")?.get(c"path")?)?;
    let work = async_result(ctx, || move_workspaces(ctx))?;
    call(
        work,
        c"then",
        &[
            function(ctx, "afterWorktrees", 1, 1, |ctx, a| {
                if ctx.get(c"finished")?.truthy()? {
                    Ok(a[0])
                } else {
                    commit(ctx)
                }
            })?,
            function(ctx, "worktreeFailed", 1, 1, |ctx, a| fail_move(ctx, a[0]))?,
        ],
    )
}
fn relocate<'a>(r: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(r, || {
        let opts = r.get(c"options")?;
        let deps = opts.get(c"deps")?;
        let plan = invoke(r.get(c"ports")?, c"plan", &[r.get(c"policy")?, a[0]])?;
        let ctx = fields(r, &[("runtime", r), ("plan", plan), ("res", a[1])])?;
        if plan.get(c"status")?.truthy()? {
            return refused(ctx, plan.get(c"body")?, plan.get(c"status")?);
        }
        let t = plan.get(c"task")?;
        if plan.get(c"unchanged")?.truthy()? {
            return send(
                a[1],
                None,
                fields(
                    ctx,
                    &[
                        ("ok", flag(ctx, true)?),
                        ("unchanged", flag(ctx, true)?),
                        ("task", invoke(opts, c"taskDto", &[t])?),
                    ],
                )?,
            );
        }
        let ids = invoke(opts, c"taskIdentityIds", &[t])?;
        ctx.set(c"ids", ids)?;
        ctx.set(c"task", t)?;
        let check = async_result(ctx, || optional_call(deps, c"assertTaskIdle", &[t, ids]))?;
        call(
            check,
            c"then",
            &[
                function(ctx, "idle", 1, 1, idle)?,
                function(ctx, "busy", 1, 1, |ctx, a| {
                    fail(
                        ctx,
                        fallback(a[0].get(c"code")?, "task_busy".into())?,
                        num(ctx, 409.)?,
                    )
                })?,
            ],
        )
    })
}
pub(super) fn create<'a>(p: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let opts = pick(
        opts,
        &[
            c"deps",
            c"resolveTask",
            c"taskIdentityIds",
            c"taskDirId",
            c"commit",
            c"notify",
            c"taskDto",
            c"isBusy",
            c"logger",
        ],
    )?;
    let r = owner(p, opts)?;
    let policy = pick(opts, &[c"resolveTask", c"taskDirId", c"isBusy"])?;
    let deps = opts.get(c"deps")?;
    let workspace = pick(
        deps,
        &[
            c"records",
            c"directories",
            c"relocateSessionWorkspace",
            c"gitRelocateWorktree",
        ],
    )?;
    r.set(c"workspace", workspace)?;
    policy.set(c"directories", workspace.get(c"directories")?)?;
    r.set(c"policy", policy)?;
    r.set(c"shell", deps.get(c"relocateShellTask")?)?;
    methods(r, &[("relocate", 2, relocate)])
}
