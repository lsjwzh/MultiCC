//! Preview is read-only. Evictions and confirmed deletions share a per-directory FIFO.
use super::*;

fn eligible(ctx: L<'_>, ignore_busy: bool) -> Result<L<'_>> {
    let (opts, ports) = pair(ctx)?;
    let board = call(opts, c"getBoard", &[])?;
    let shells = ctx.get(c"list")?.call_plain(&[])?;
    let pins = call(opts, c"getPinnedTaskIds", &[])?;
    let input = pick(
        opts,
        &[
            c"records",
            c"getRunState",
            c"isSessionBusy",
            c"taskDirId",
            c"taskLineageIds",
        ],
    )?;
    input.set(c"board", board)?;
    input.set(c"shellTasks", shells)?;
    input.set(c"pinnedIds", pins)?;
    input.set(c"dirId", ctx.get(c"dirId")?)?;
    input.set(c"excludedIds", ctx.get(c"excluded")?)?;
    let items = retention_facts::candidates(ports, input)?;
    if ignore_busy {
        return Ok(items);
    }
    let out = array(ctx)?;
    items.for_each(|item| {
        if !optional_call(opts, c"isTaskBusy", &[item.get(c"id")?])?.truthy()? {
            call(out, c"push", &[item])?;
        }
        Ok(())
    })?;
    Ok(out)
}
fn contains<'a>(rows: L<'a>, id: L<'a>) -> Result<bool> {
    let mut found = false;
    rows.for_each_while(|item| {
        found = item.get(c"id")?.equals(id)?;
        Ok(!found)
    })?;
    Ok(found)
}
fn skip<'a>(ctx: L<'a>, reason: L<'a>) -> Result<()> {
    call(
        ctx.get(c"skipped")?,
        c"push",
        &[fields(ctx, &[("id", ctx.get(c"id")?), ("reason", reason)])?],
    )?;
    Ok(())
}
fn evicted(ctx: L<'_>, yes: bool) -> Result<L<'_>> {
    let out = fields(ctx, &[("evicted", flag(ctx, yes)?)])?;
    if yes {
        out.set(c"taskId", ctx.get(c"id")?)?;
    }
    Ok(out)
}
fn finish(ctx: L<'_>) -> Result<L<'_>> {
    let (_, ports) = pair(ctx)?;
    let mode = ctx.get(c"mode")?;
    if mode.is_string("evict")? {
        return Err(coded(
            ctx,
            text(ctx, "task_shell_task_limit")?,
            text(ctx, "No safely removable completed task is available")?,
            Some(409),
        )?);
    }
    let dir = ctx.get(c"dirId")?;
    let mut count = 0.;
    ctx.get(c"list")?.call_plain(&[])?.for_each(|t| {
        if t.get(c"dirId")?.equals(dir)? {
            count += 1.;
        }
        Ok(())
    })?;
    let out = fields(
        ctx,
        &[("count", num(ctx, count)?), ("limit", ports.get(c"limit")?)],
    )?;
    if mode.is_string("preview")? {
        out.set(c"maxBatch", num(ctx, 100.)?)?;
        out.set(c"tasks", ctx.get(c"safe")?)?;
    } else {
        out.set(c"deleted", ctx.get(c"deleted")?)?;
        out.set(c"skipped", ctx.get(c"skipped")?)?;
    }
    Ok(out)
}
fn prepare_opts(ctx: L<'_>) -> Result<L<'_>> {
    fields(
        ctx,
        &[
            ("force", flag(ctx, false)?),
            ("automatic", flag(ctx, true)?),
        ],
    )
}
fn delete_opts(ctx: L<'_>) -> Result<L<'_>> {
    let options = prepare_opts(ctx)?;
    options.set(
        c"guard",
        function(
            fields(ctx, &[("flight", ctx), ("id", ctx.get(c"id")?)])?,
            "stillEligible",
            0,
            0,
            |guard, _| {
                flag(
                    guard,
                    contains(eligible(guard.get(c"flight")?, true)?, guard.get(c"id")?)?,
                )
            },
        )?,
    )?;
    Ok(options)
}
fn capacity(ctx: L<'_>) -> Result<bool> {
    ctx.get(c"capacity")?.call_plain(&[])?.truthy()
}

fn after_preflight(ctx: L<'_>) -> Result<L<'_>> {
    let mode = ctx.get(c"mode")?;
    let id = ctx.get(c"id")?;
    let (opts, ports) = pair(ctx)?;
    let task = ctx.get(c"task")?;
    let preview = mode.is_string("preview")?;
    let select = mode.is_string("selection")?;
    if select || preview {
        if !contains(eligible(ctx, false)?, id)? {
            if select {
                skip(ctx, text(ctx, "no_longer_eligible")?)?;
            }
            return undef(ctx);
        }
        if preview {
            let safe = ctx.get(c"safe")?;
            let title = task.get(c"title")?;
            let row = fields(
                ctx,
                &[
                    ("id", id),
                    ("title", if title.truthy()? { title } else { id }),
                    ("lastInteractionAt", ctx.get(c"candidate")?.get(c"at")?),
                ],
            )?;
            call(safe, c"push", &[row])?;
            return undef(ctx);
        }
    } else {
        let pins = call(opts, c"getPinnedTaskIds", &[])?;
        if !pins.is_array()? {
            return Err(error_value(ctx, "air pins unavailable")?.throw_error());
        }
        let mut pinned = false;
        call(opts, c"taskLineageIds", &[task])?.for_each_while(|key| {
            pinned = call(pins, c"includes", &[key])?.truthy()?;
            Ok(!pinned)
        })?;
        if pinned {
            return undef(ctx);
        }
        let session = ctx.get(c"candidate")?.get(c"sessionId")?;
        if invoke(ports, c"isOpen", &[call(opts, c"getRunState", &[session])?])?.truthy()?
            || optional_call(opts, c"isSessionBusy", &[session])?.truthy()?
        {
            return undef(ctx);
        }
    }
    let remove = async_result(ctx, || call(opts, c"deleteById", &[id, delete_opts(ctx)?]))?;
    call(
        remove,
        c"then",
        &[
            function(ctx, "deleted", 1, 1, |ctx, _| {
                if ctx.get(c"mode")?.is_string("selection")? {
                    call(ctx.get(c"deleted")?, c"push", &[ctx.get(c"id")?])?;
                    return undef(ctx);
                }
                if capacity(ctx)? {
                    return finish(ctx);
                }
                evicted(ctx, true)
            })?,
            function(ctx, "deleteRefused", 1, 1, |ctx, a| {
                let code = a[0].get(c"code")?;
                if ctx.get(c"mode")?.is_string("selection")? {
                    skip(ctx, fallback(code, "delete_failed".into())?)?;
                    return undef(ctx);
                }
                for reason in [
                    "no_longer_eligible",
                    "task_busy",
                    "task_session_shared",
                    "shell_workspace_referenced",
                    "TASK_HISTORY_REFERENCED",
                    "task_workspace_dirty",
                    "task_workspace_unmerged",
                    "task_workspace_ignored",
                    "task_workspace_unverifiable",
                ] {
                    if code.is_string(reason)? {
                        return undef(ctx);
                    }
                }
                Err(a[0].throw_error())
            })?,
        ],
    )
}
fn advance(ctx: L<'_>) -> Result<L<'_>> {
    let mode = ctx.get(c"mode")?;
    let select = mode.is_string("selection")?;
    let evict = mode.is_string("evict")?;
    let rows = ctx.get(c"rows")?;
    let (opts, _) = pair(ctx)?;
    let mut i = ctx.get(c"offset")?.number()? as u32;
    while i < rows.get(c"length")?.number()? as u32 {
        let item = rows.element(i)?;
        i += 1;
        if evict && !capacity(ctx)? {
            return evicted(ctx, false);
        }
        let id = if select { item } else { item.get(c"id")? };
        ctx.set(c"id", id)?;
        if select && !contains(eligible(ctx, false)?, id)? {
            skip(ctx, text(ctx, "no_longer_eligible")?)?;
            continue;
        }
        let tasks = call(opts, c"getBoard", &[])?.get(c"tasks")?;
        let task = if tasks.nullish()? {
            undef(ctx)?
        } else {
            tasks.get_key(id)?
        };
        if !task.truthy()? || (evict && task.get(c"deleting")?.truthy()?) {
            if select {
                skip(ctx, text(ctx, "no_longer_eligible")?)?;
            }
            continue;
        }
        ctx.set(c"candidate", item)?;
        ctx.set(c"offset", num(ctx, i.into())?)?;
        ctx.set(c"task", task)?;
        let preflight = async_result(ctx, || {
            call(
                opts,
                c"prepareDelete",
                &[task, list_one(id)?, prepare_opts(ctx)?],
            )
        })?;
        let outcome = call(
            preflight,
            c"then",
            &[
                function(ctx, "afterPreflight", 1, 1, |ctx, _| after_preflight(ctx))?,
                function(ctx, "unsafeCandidate", 1, 1, |ctx, a| {
                    if ctx.get(c"mode")?.is_string("selection")? {
                        skip(ctx, fallback(a[0].get(c"code")?, "delete_failed".into())?)?;
                    }
                    undef(ctx)
                })?,
            ],
        )?;
        let outcome = if select {
            // A selection reports per-task failures while finishing the remaining items.
            recover(outcome, ctx, |ctx, a| {
                skip(ctx, fallback(a[0].get(c"code")?, "delete_failed".into())?)?;
                undef(ctx)
            })?
        } else {
            outcome
        };
        return then(outcome, ctx, |ctx, a| {
            if !a[0].undefined()? {
                return Ok(a[0]);
            }
            if ctx.get(c"mode")?.is_string("preview")?
                && ctx.get(c"safe")?.get(c"length")?.is_number(100.)?
            {
                return finish(ctx);
            }
            advance(ctx)
        });
    }
    finish(ctx)
}
fn begin(ctx: L<'_>) -> Result<L<'_>> {
    if ctx.get(c"mode")?.is_string("evict")? && !capacity(ctx)? {
        return evicted(ctx, false);
    }
    if !ctx.get(c"mode")?.is_string("selection")? {
        ctx.set(c"rows", eligible(ctx, false)?)?;
    }
    advance(ctx)
}
fn queued(ctx: L<'_>) -> Result<L<'_>> {
    let flights = ctx.get(c"runtime")?.get(c"flights")?;
    let dir = ctx.get(c"dirId")?;
    let prev = call(flights, c"get", &[dir])?;
    // Register before invoking any user port: a synchronous re-entry queues behind this invocation.
    let gate =
        ctx.global()?
            .get(c"Promise")?
            .construct(&[function(ctx, "hold", 2, 2, |ctx, a| {
                ctx.set(c"release", a[0])?;
                undef(ctx)
            })?])?;
    call(flights, c"set", &[dir, gate])?;
    ctx.set(c"gate", gate)?;
    let work = if prev.truthy()? {
        then(prev, ctx, |ctx, _| begin(ctx))?
    } else {
        async_result(ctx, || begin(ctx))?
    };
    call(
        work,
        c"finally",
        &[function(ctx, "release", 0, 0, |ctx, _| {
            ctx.get(c"release")?.call_plain(&[])?;
            let flights = ctx.get(c"runtime")?.get(c"flights")?;
            let dir = ctx.get(c"dirId")?;
            if call(flights, c"get", &[dir])?.equals(ctx.get(c"gate")?)? {
                call(flights, c"delete", &[dir])?;
            }
            undef(ctx)
        })?],
    )
}
fn start<'a>(r: L<'a>, a: &[L<'a>], mode: &str) -> Result<L<'a>> {
    async_result(r, || {
        let excluded = if mode == "evict" {
            with_default(a[3], array(r)?)?
        } else {
            array(r)?
        };
        let ctx = fields(
            r,
            &[
                ("runtime", r),
                ("dirId", a[0]),
                ("list", a[1]),
                ("mode", text(r, mode)?),
                ("offset", num(r, 0.)?),
                ("excluded", excluded),
            ],
        )?;
        match mode {
            "evict" => ctx.set(c"capacity", a[2])?,
            "preview" => {
                ctx.set(c"safe", array(r)?)?;
                return begin(ctx);
            }
            _ => {
                let ids = a[2];
                let mut valid = ids.is_array()?;
                if valid {
                    let count = ids.get(c"length")?.number()?;
                    valid = (1.0..=100.0).contains(&count)
                        && r.global()?
                            .get(c"Set")?
                            .construct(&[ids])?
                            .get(c"size")?
                            .is_number(count)?;
                    if valid {
                        ids.for_each_while(|id| {
                            valid = id.kind()? == sys::ValueType::napi_string && id.truthy()?;
                            Ok(valid)
                        })?;
                    }
                }
                if !valid {
                    return Err(coded(
                        r,
                        text(r, "invalid_selection")?,
                        text(r, "Select 1–100 distinct tasks from the preview")?,
                        Some(400),
                    )?);
                }
                ctx.set(c"rows", ids)?;
                ctx.set(c"skipped", array(r)?)?;
                ctx.set(c"deleted", array(r)?)?;
            }
        }
        queued(ctx)
    })
}
pub(super) fn create<'a>(ports: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let r = owner(ports, options)?;
    r.set(c"flights", r.global()?.get(c"Map")?.construct(&[])?)?;
    methods(
        r,
        &[
            ("preview", 2, |r, a| start(r, a, "preview")),
            ("deleteSelected", 3, |r, a| start(r, a, "selection")),
            ("evict", 4, |r, a| start(r, a, "evict")),
        ],
    )
}
