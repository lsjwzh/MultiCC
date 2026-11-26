use super::*;

pub(super) fn dto<'a>(p: L<'a>, task: L<'a>) -> Result<L<'a>> {
    let board = p.get(c"board")?;
    let deps = p.get(c"deps")?;
    let modules = board.get(c"modules")?;
    let tasks = fields(p, &[])?;
    tasks.define_key(read(task, c"id")?, task)?;
    let single = fields(
        p,
        &[
            ("modules", modules),
            ("tasks", tasks),
            ("taskGroups", board.get(c"taskGroups")?),
        ],
    )?;
    let dto = core(
        p,
        c"buildBoardDto",
        &[
            single,
            p.get(c"getSessionRunState")?,
            fields(p, &[("sessionHasTurn", p.get(c"sessionHasTurn")?)])?,
        ],
    )?
    .get(c"tasks")?
    .element(0)?;
    let length = plain(p, c"taskIdentityIds", &[task])?
        .get(c"length")?
        .number()?;
    dto.assign(
        c"mergedTaskCount",
        call(
            p.global()?.get(c"Math")?,
            c"max",
            &[num(p, 0.)?, num(p, length - 1.)?],
        )?,
    )?;
    let display = call(
        p.get(c"native")?,
        c"taskDisplayFields",
        &[task, deps.get(c"taskShortCode")?],
    )?;
    call(p.global()?.get(c"Object")?, c"assign", &[dto, display])?;
    let body = transcript::canonical(p, task, undef(p)?, true)?;
    if dto
        .get(c"title")?
        .equals(p.get(c"core")?.get(c"PENDING_TASK_TITLE")?)?
        && body.get(c"text")?.truthy()?
    {
        dto.assign(
            c"title",
            core(p, c"deriveTaskTitle", &[body.get(c"text")?])?,
        )?;
    }
    dto.assign(c"body", body.get(c"text")?)?;
    dto.assign(c"bodyMessageId", body.get(c"messageId")?)?;
    dto.assign(c"bodySessionId", body.get(c"sessionId")?)?;
    dto.assign(c"legacy", body.get(c"legacy")?)?;
    let identity = if body.get(c"text")?.truthy()? {
        if body.get(c"legacy")?.truthy()? {
            "legacy"
        } else {
            "canonical"
        }
    } else if task.get(c"routing")?.optional(c"operationId")?.truthy()? {
        "orphaned_admission"
    } else {
        "legacy_unresolved"
    };
    dto.assign(c"identityState", text(p, identity)?)?;
    if dto.optional(c"routing")?.truthy()? {
        let route = dto.get(c"routing")?;
        let target = record(p, dto.get(c"routing")?.get(c"targetSessionId")?)?;
        route.assign(
            c"targetLabel",
            or(target.optional(c"label")?, || {
                dto.get(c"routing")?.get(c"targetSessionId")
            })?,
        )?;
        if dto.get(c"routing")?.get(c"workerSessionId")?.truthy()? {
            let worker = record(p, dto.get(c"routing")?.get(c"workerSessionId")?)?;
            if worker.optional(c"taskExecutionSlot")?.is_true()? {
                dto.get(c"routing")?.delete(c"workerSessionId")?;
                dto.get(c"routing")?
                    .assign(c"internalExecution", flag(p, true)?)?;
            } else {
                dto.get(c"routing")?.assign(
                    c"workerLabel",
                    or(worker.optional(c"label")?, || {
                        dto.get(c"routing")?.get(c"workerSessionId")
                    })?,
                )?;
            }
        }
    }
    let ids = or(dto.get(c"sessionIds")?, || array(p, &[]))?;
    let visible = call(
        ids,
        c"filter",
        &[function(p, "", 1, 1, |p, a| {
            flag(
                p,
                !record(p, a[0])?.optional(c"taskExecutionSlot")?.is_true()?,
            )
        })?],
    )?;
    dto.assign(c"sessionIds", visible)?;
    attach(p, dto)
}

pub(super) fn attach<'a>(p: L<'a>, dto: L<'a>) -> Result<L<'a>> {
    let deps = p.get(c"deps")?;
    if deps.get(c"taskShellTaskAccess")?.truthy()? {
        let access = call(
            deps,
            c"taskShellTaskAccess",
            &[or(board_task(p, read(dto, c"id")?)?, || Ok(dto))?],
        )?;
        call(p.global()?.get(c"Object")?, c"assign", &[dto, access])?;
    }
    let id = dto.optional(c"chatSessionId")?;
    let bound = if id.truthy()? {
        record(p, dto.get(c"chatSessionId")?)?
    } else {
        id
    };
    let state = if bound.truthy()? {
        let value = bound.get(c"workspaceState")?;
        let sleeping = value.is_string("hibernated")?
            || value.is_string("hibernating")?
            || value.is_string("thawing")?;
        text(p, if sleeping { "hibernated" } else { "awake" })?
    } else {
        null(p)?
    };
    dto.assign(c"workspaceState", state)?;
    dto.assign(
        c"lastWorkAt",
        or(bound.optional(c"lastWorkAt")?, || {
            fallback(bound.optional(c"createdAt")?, V::Null)
        })?,
    )?;
    dto.assign(
        c"hibernatedAt",
        fallback(bound.optional(c"hibernatedAt")?, V::Null)?,
    )?;
    Ok(dto)
}
