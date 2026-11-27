//! Planning mutations use one FIFO per task. Probe stage changes against a clone,
//! wait for the session queue, then validate the revision again on the live board.
use crate::host_api::*;
use multicc_core::task_routes::planning_status;
use napi_derive::napi;
use std::ffi::CStr;

fn revision(body: L<'_>) -> Result<L<'_>> {
    let expected = body.optional(c"expectedRevision")?;
    if expected.nullish()? {
        body.optional(c"revision")
    } else {
        Ok(expected)
    }
}
fn status(code: L<'_>) -> Result<i32> {
    let key = code
        .string()?
        .map(|s| s.to_string_lossy())
        .unwrap_or_default();
    Ok(i32::from(planning_status(&key)))
}
fn rejected<'a>(res: L<'a>, outcome: L<'a>) -> Result<L<'a>> {
    let code = status(outcome.optional(c"error")?)?;
    let body = if outcome.truthy()? {
        outcome
    } else {
        fields(res, &[("error", text(res, "invalid_request")?)])?
    };
    send(res, Some(code), body)
}
fn board(p: L<'_>) -> Result<L<'_>> {
    p.get(c"getBoard")?.call_plain(&[])
}
fn created_task<'a>(p: L<'a>, result: L<'a>) -> Result<L<'a>> {
    board(p)?.get(c"tasks")?.get_key(result.get(c"taskId")?)
}
fn success<'a>(p: L<'a>, res: L<'a>, task: L<'a>) -> Result<L<'a>> {
    let board = board(p)?;
    let dto = p.get(c"taskDto")?.call_plain(&[task])?;
    send(
        res,
        None,
        fields(
            p,
            &[
                ("ok", flag(p, true)?),
                ("task", dto),
                ("revision", board.get(c"revision")?),
            ],
        )?,
    )
}
fn directory<'a>(p: L<'a>, id: L<'a>) -> Result<bool> {
    let check = p.get(c"hasDirectory")?;
    Ok(!callable(check)? || check.call_plain(&[id])?.truthy()?)
}
fn clean_id(value: L<'_>) -> Result<L<'_>> {
    call(string(fallback(value, "".into())?)?, c"trim", &[])
}
fn notify<'a>(p: L<'a>, task: L<'a>, kind: Option<&str>) -> Result<()> {
    let dir = if kind == Some("renamed") {
        p.get(c"taskDirId")?.call_plain(&[task])?
    } else {
        task.get(c"dirId")?
    };
    let ids = array(p)?;
    call(ids, c"push", &[task.get(c"id")?])?;
    let mut args = vec![dir, ids];
    if let Some(kind) = kind {
        args.push(text(p, kind)?);
    }
    p.get(c"notify")?.call_plain(&args)?;
    Ok(())
}
fn edit<'a>(ctx: L<'a>, candidate: L<'a>) -> Result<L<'a>> {
    let p = ctx.get(c"ports")?;
    let planning = p.get(c"planning")?;
    let input = ctx.get(c"input")?;
    let op = ctx.get(c"operation")?;
    if op.is_string("create")? {
        return call(planning, c"createPlannedTask", &[candidate, input]);
    }
    let id = ctx.get(c"task")?.get(c"id")?;
    if op.is_string("rename")? {
        return call(
            planning,
            c"renameTask",
            &[candidate, id, input.get(c"title")?],
        );
    }
    let name = if op.is_string("move")? {
        c"movePlannedTask"
    } else {
        c"updatePlannedTask"
    };
    call(
        planning,
        name,
        &[
            candidate,
            id,
            input,
            fields(p, &[("expectedRevision", revision(input)?)])?,
        ],
    )
}
fn commit(ctx: L<'_>) -> Result<L<'_>> {
    let apply = function(ctx, "applyPlanningChange", 1, 1, |ctx, args| {
        edit(ctx, args[0])
    })?;
    ctx.get(c"ports")?
        .get(c"commitMutation")?
        .call_plain(&[apply])
}
fn create<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let body = args[0].get(c"body")?;
    let mut input = if object(body)? {
        spread(body)?
    } else {
        fields(p, &[])?
    };
    let res = args[1];
    let source_id = clean_id(input.get(c"sourceTaskId")?)?;
    if source_id.truthy()? {
        let source = p.get(c"resolveTask")?.call_plain(&[source_id])?;
        let reason = if !source.truthy()? {
            Some("task_not_found")
        } else if source.get(c"status")?.is_string("archived")?
            || source.get(c"deleting")?.truthy()?
        {
            Some("task_archived")
        } else {
            None
        };
        if let Some(reason) = reason {
            return rejected(
                res,
                fields(p, &[("ok", flag(p, false)?), ("error", text(p, reason)?)])?,
            );
        }
        let value = |key: &CStr| -> Result<L<'a>> {
            let v = source.get(key)?;
            if v.nullish()? {
                null(p)
            } else {
                Ok(v)
            }
        };
        let desc = source.get(c"description")?;
        let defaults = fields(
            p,
            &[
                ("title", source.get(c"title")?),
                (
                    "description",
                    if desc.truthy()? {
                        desc
                    } else {
                        source.get(c"title")?
                    },
                ),
                ("dirId", p.get(c"taskDirId")?.call_plain(&[source])?),
                ("priority", value(c"priority")?),
                ("dueAt", value(c"dueAt")?),
                (
                    "acceptanceCriteria",
                    fallback(source.get(c"acceptanceCriteria")?, "".into())?,
                ),
            ],
        )?;
        defaults.spread_from(input)?;
        defaults.set(c"recordType", text(p, "planned")?)?;
        input = defaults;
    }
    let dir = clean_id(input.get(c"dirId")?)?;
    if dir.truthy()? && !directory(p, dir)? {
        return error(res, 409, "directory_not_found", false);
    }
    let result = commit(fields(
        p,
        &[
            ("ports", p),
            ("input", input),
            ("operation", text(p, "create")?),
        ],
    )?)?;
    if !result.get(c"ok")?.truthy()? {
        return rejected(res, result);
    }
    let task = created_task(p, result)?;
    notify(p, task, Some("created"))?;
    success(p, res, task)
}
fn after_stage<'a>(ctx: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let p = ctx.get(c"ports")?;
    let res = ctx.get(c"res")?;
    let prepared = args[0];
    if !prepared.optional(c"ok")?.truthy()? {
        let body = prepared.get(c"body")?;
        let body = if body.truthy()? {
            body
        } else {
            fields(
                p,
                &[(
                    "error",
                    fallback(prepared.get(c"error")?, "stage_change_blocked".into())?,
                )],
            )?
        };
        return call(
            call(
                res,
                c"status",
                &[fallback(prepared.get(c"status")?, 409.0.into())?],
            )?,
            c"json",
            &[body],
        );
    }
    let result = commit(ctx)?;
    if !result.get(c"ok")?.truthy()? {
        return rejected(res, result);
    }
    let task = created_task(p, result)?;
    notify(p, task, None)?;
    success(p, res, task)
}
fn renamed(ctx: L<'_>) -> Result<L<'_>> {
    let task = ctx.get(c"updated")?;
    let p = ctx.get(c"ports")?;
    notify(p, task, Some("renamed"))?;
    success(p, ctx.get(c"res")?, task)
}
fn update<'a>(p: L<'a>, args: &mut [L<'a>], op: &str) -> Result<L<'a>> {
    async_result(p, || {
        let req = args[0];
        let res = args[1];
        let task = p
            .get(c"resolveTask")?
            .call_plain(&[req.get(c"params")?.get(c"taskId")?])?;
        if !task.truthy()? {
            return error(res, 404, "task_not_found", false);
        }
        let body = req.get(c"body")?;
        let input = if object(body)? { body } else { fields(p, &[])? };
        let ctx = fields(
            p,
            &[
                ("ports", p),
                ("operation", text(p, op)?),
                ("task", task),
                ("input", input),
                ("res", res),
            ],
        )?;
        if op == "rename" {
            let result = commit(ctx)?;
            if !result.get(c"ok")?.truthy()? {
                return rejected(res, result);
            }
            let task = created_task(p, result)?;
            ctx.set(c"updated", task)?;
            let hook = p.get(c"afterRename")?;
            if !callable(hook)? {
                return renamed(ctx);
            }
            let renamed_promise = async_result(p, || hook.call_plain(&[task]))?;
            let logged = recover(renamed_promise, p, |p, args| {
                let msg = args[0].optional(c"message")?;
                let detail = if msg.truthy()? { msg } else { args[0] };
                let logger = p.get(c"logger")?;
                let logger = with_default(logger, p.global()?.get(c"console")?)?;
                call(
                    logger,
                    c"log",
                    &[text(
                        p,
                        &format!(
                            "[multicc/task-planning] title sync failed: {}",
                            fold_string(detail)?
                        ),
                    )?],
                )
            })?;
            return then(logged, ctx, |ctx, _| renamed(ctx));
        }
        if op == "update"
            && !input.get(c"dirId")?.undefined()?
            && !directory(p, clean_id(input.get(c"dirId")?)?)?
        {
            return error(res, 409, "directory_not_found", false);
        }
        let clone = p.get(c"cloneBoard")?.call_plain(&[board(p)?])?;
        let probe = edit(ctx, clone)?;
        if !probe.get(c"ok")?.truthy()? {
            return rejected(res, probe);
        }
        let stage = input.get(c"workflowStage")?;
        let hook = p.get(c"beforeStageChange")?;
        let preparation = if stage.is_string("done")?
            && !stage.equals(task.get(c"workflowStage")?)?
            && !hook.undefined()?
        {
            hook.call_plain(&[task, stage])?
        } else {
            fields(p, &[("ok", flag(p, true)?)])?
        };
        then(preparation, ctx, after_stage)
    })
}
fn lock<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let tails = p.get(c"operationTails")?;
        let id = string(fallback(args[0], "".into())?)?;
        let prior = call(tails, c"get", &[id])?;
        let result = then(prior, args[1], |work, _| work.call_plain(&[]))?;
        let settled = function(p, "release", 0, 0, |p, _| undef(p))?;
        let tail = call(result, c"then", &[settled, settled])?;
        call(tails, c"set", &[id, tail])?;
        let cleanup = fields(p, &[("tails", tails), ("id", id), ("tail", tail)])?;
        call(
            result,
            c"finally",
            &[function(cleanup, "clearTaskLock", 0, 0, |c, _| {
                let tails = c.get(c"tails")?;
                let id = c.get(c"id")?;
                if call(tails, c"get", &[id])?.equals(c.get(c"tail")?)? {
                    call(tails, c"delete", &[id])?;
                }
                undef(c)
            })?],
        )
    })
}

#[napi]
pub fn task_planning_routes_api(env: Env, host: Unknown<'_>) -> Result<sys::napi_value> {
    let host = L::new(&env, host);
    Ok(methods(
        host,
        &[
            ("responseStatus", 1, |p, a| num(p, status(a[0])?.into())),
            ("expectedRevision", 1, |_, a| revision(a[0])),
            ("createTaskPlanningRuntime", 1, |host, a| {
                let p = spread(default_object(a[0])?)?;
                for k in [c"getBoard", c"commitMutation", c"taskDto", c"resolveTask"] {
                    if !callable(p.get(k)?)? {
                        return Err(error_value(host, "[task-planning] invalid runtime ports")?
                            .throw_error());
                    }
                }
                p.set(c"cloneBoard", host.get(c"cloneBoard")?)?;
                p.set(c"planning", host.get(c"planning")?)?;
                p.set(c"operationTails", p.global()?.get(c"Map")?.construct(&[])?)?;
                methods(
                    p,
                    &[
                        ("withTaskLock", 2, lock),
                        ("handleCreate", 2, create),
                        ("handleUpdate", 2, |p, a| update(p, a, "update")),
                        ("handleMove", 2, |p, a| update(p, a, "move")),
                        ("handleRename", 2, |p, a| update(p, a, "rename")),
                    ],
                )?
                .freeze()
            }),
        ],
    )?
    .raw())
}
