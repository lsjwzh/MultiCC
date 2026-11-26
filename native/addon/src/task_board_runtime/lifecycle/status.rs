use super::*;

fn task_id(req: L<'_>) -> Result<L<'_>> {
    req.get(c"params")?.optional(c"taskId")
}
fn optional_call<'a>(receiver: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    let f = receiver.get(key)?;
    if f.nullish()? {
        undef(receiver)
    } else {
        f.call(receiver, args)
    }
}

pub(super) fn reject<'a>(p: L<'a>, req: L<'a>, res: L<'a>) -> Result<bool> {
    let task = local(p, c"resolvedTask", &[task_id(req)?])?;
    let life = p.get(c"taskLifecycle")?;
    let deps = p.get(c"deps")?;
    let reason = if call(life, c"isBusy", &[task.optional(c"id")?])?.truthy()? {
        "task_busy"
    } else if task.optional(c"status")?.is_string("archived")?
        || task.optional(c"deleting")?.truthy()?
    {
        if task.get(c"deleting")?.truthy()? {
            "task_deleting"
        } else {
            "task_archived"
        }
    } else if task.truthy()?
        && optional_call(deps, c"taskShellTaskAccess", &[task])?
            .optional(c"readOnly")?
            .truthy()?
    {
        "task_board_read_only"
    } else {
        let current = local(p, c"resolvedTask", &[task_id(req)?])?;
        if !optional_call(
            deps,
            c"isTaskShellSession",
            &[current.optional(c"chatSessionId")?],
        )?
        .truthy()?
        {
            return Ok(false);
        }
        "task_shell_route_required"
    };
    error(res, 409, reason, false)?;
    Ok(true)
}
pub(super) fn resolve_queues<'a>(p: L<'a>, task: L<'a>, note: L<'a>) -> Result<L<'a>> {
    let worker = task.get(c"routing")?.optional(c"workerSessionId")?;
    let ids = array(p)?;
    if worker.truthy()? {
        call(ids, c"push", &[worker])?;
    } else {
        let refs = task.get(c"refs")?;
        if refs.truthy()? {
            let seen = p.global()?.get(c"Set")?.construct(&[])?;
            refs.for_each(|r| {
                let id = r.get(c"sessionId")?;
                if id.truthy()? && !call(seen, c"has", &[id])?.truthy()? {
                    call(seen, c"add", &[id])?;
                    call(ids, c"push", &[id])?;
                }
                Ok(())
            })?;
        }
    }
    let frame = fields(
        p,
        &[
            ("ports", p),
            ("task", task),
            ("note", note),
            ("ids", ids),
            ("index", num(p, 0.)?),
        ],
    )?;
    next_queue(frame)
}
fn next_queue(f: L<'_>) -> Result<L<'_>> {
    let ports = p(f)?;
    let ids = f.get(c"ids")?;
    let len = ids.get(c"length")?.number()? as u32;
    for i in (f.get(c"index")?.number()? as u32)..len {
        let id = ids.element(i)?;
        let rec = call(ports.get(c"records")?, c"get", &[id])?;
        if rec.optional(c"taskExecutionSlot")?.is_true()? {
            continue;
        }
        f.set(c"index", num(f, (i + 1).into())?)?;
        return after(
            f,
            local(
                ports,
                c"resolveSessionQueue",
                &[id, f.get(c"task")?.get(c"id")?],
            )?,
            |f, r| {
                if r.truthy()? && r.get(c"ok")?.is_false()? {
                    let code = r.get(c"code")?;
                    if !code.is_string("no_active_task")?
                        && !code.is_string("active_task_mismatch")?
                    {
                        let body = fields(
                            f,
                            &[
                                ("error", fallback(code, V::from("queue_resolution_failed"))?),
                                ("note", f.get(c"note")?),
                            ],
                        )?;
                        return fields(
                            f,
                            &[
                                ("ok", flag(f, false)?),
                                ("status", num(f, 409.)?),
                                ("body", body),
                            ],
                        );
                    }
                }
                next_queue(f)
            },
        );
    }
    ok(f)
}
fn valid(status: L<'_>) -> Result<bool> {
    Ok(status.is_string("active")? || status.is_string("done")? || status.is_string("archived")?)
}

pub(super) fn handle<'a>(p: L<'a>, req: L<'a>, res: L<'a>) -> Result<L<'a>> {
    let status = req.get(c"body")?.optional(c"status")?;
    if !valid(status)? {
        return error(res, 400, "invalid_status", false);
    }
    if status.is_string("archived")? {
        return call(p.get(c"taskLifecycle")?, c"archive", &[req, res]);
    }
    let task = local(p, c"resolvedTask", &[task_id(req)?])?;
    if task.optional(c"status")?.is_string("archived")? && status.is_string("active")? {
        return call(p.get(c"taskLifecycle")?, c"restore", &[req, res]);
    }
    if reject(p, req, res)? {
        return undef(p);
    }
    held(p, task_id(req)?, || unlocked(p, req, res))
}
fn unlocked<'a>(p: L<'a>, req: L<'a>, res: L<'a>) -> Result<L<'a>> {
    let task = local(p, c"resolvedTask", &[req.get(c"params")?.get(c"taskId")?])?;
    if !task.truthy()? {
        return error(res, 404, "task_not_found", false);
    }
    let body = req.get(c"body")?;
    let status = string(fallback(body.optional(c"status")?, V::from(""))?)?;
    if !valid(status)? {
        return error(res, 400, "invalid_status", false);
    }
    let mut expected = body.optional(c"expectedRevision")?;
    if expected.nullish()? {
        expected = body.optional(c"revision")?;
    }
    let planning = p.get(c"planning")?;
    let revision = if task.get(c"recordType")?.is_string("planned")? {
        call(
            planning,
            c"planningRevision",
            &[task.get(c"planningRevision")?],
        )?
    } else {
        null(p)?
    };
    if !revision.nullish()? && !expected.nullish()? {
        let check = call(planning, c"validateExpectedRevision", &[task, expected])?;
        if !check.get(c"ok")?.truthy()? {
            let code = if check.get(c"error")?.is_string("revision_conflict")? {
                409
            } else {
                400
            };
            return send(res, Some(code), check);
        }
    }
    let f = fields(
        p,
        &[
            ("ports", p),
            ("task", task),
            ("status", status),
            ("res", res),
            ("revision", revision),
        ],
    )?;
    if status.is_string("done")? {
        let pending = resolve_queues(
            p,
            task,
            text(
                p,
                "当前任务仍在执行；请先取消，或等待其进入冻结状态后再明确标记完成。",
            )?,
        )?;
        return after(f, pending, |f, queues| {
            if !queues.get(c"ok")?.truthy()? {
                let target = call(f.get(c"res")?, c"status", &[queues.get(c"status")?])?;
                return call(target, c"json", &[queues.get(c"body")?]);
            }
            mutate(f)
        });
    }
    mutate(f)
}
fn mutate(f: L<'_>) -> Result<L<'_>> {
    let ports = p(f)?;
    let task = f.get(c"task")?;
    let board = ports.get(c"board")?;
    let planning = ports.get(c"planning")?;
    let res = f.get(c"res")?;
    let revision = f.get(c"revision")?;
    if !revision.nullish()? {
        let actual = call(
            planning,
            c"planningRevision",
            &[task.get(c"planningRevision")?],
        )?;
        if !actual.equals(revision)? {
            return send(
                res,
                Some(409),
                fields(
                    f,
                    &[
                        ("error", text(f, "revision_conflict")?),
                        ("expectedRevision", revision),
                        ("actualRevision", actual),
                    ],
                )?,
            );
        }
    }
    let status = f.get(c"status")?;
    let json = f.global()?.get(c"JSON")?;
    let before = call(json, c"parse", &[call(json, c"stringify", &[task])?])?;
    task.assign(c"status", status)?;
    let at = call(f.global()?.get(c"Date")?, c"now", &[])?;
    task.assign(c"updatedAt", at)?;
    let changed = call(
        planning,
        c"alignStageWithStatus",
        &[task, status, at, board],
    )?;
    if !revision.nullish()? && !changed.truthy()? {
        task.assign(c"planningRevision", num(f, revision.number()? + 1.)?)?;
    }
    if !local(ports, c"save", &[])?.truthy()? {
        let object = f.global()?.get(c"Object")?;
        let reflect = f.global()?.get(c"Reflect")?;
        call(object, c"keys", &[task])?.for_each(|key| {
            if !call(reflect, c"deleteProperty", &[task, key])?.truthy()? {
                return Err(task.type_error("cannot delete task property"));
            }
            Ok(())
        })?;
        call(object, c"assign", &[task, before])?;
        return error(res, 500, "persistence_failed", false);
    }
    let module_id = task.get(c"moduleId")?;
    let module = if module_id.truthy()? {
        board.get(c"modules")?.get_key(module_id)?
    } else {
        null(f)?
    };
    let ids = array(f)?;
    call(ids, c"push", &[task.get(c"id")?])?;
    local(
        ports,
        c"notify",
        &[fallback(module.optional(c"dirId")?, V::Null)?, ids],
    )?;
    let body = fields(
        f,
        &[
            ("ok", flag(f, true)?),
            ("releasedSession", flag(f, false)?),
            ("releasedSessions", num(f, 0.)?),
            ("task", local(ports, c"taskDto", &[task])?),
            ("revision", board.get(c"revision")?),
        ],
    )?;
    send(res, None, body)?;
    undef(f)
}
