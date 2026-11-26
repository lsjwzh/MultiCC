use super::*;

pub(super) fn canonical<'a>(
    p: L<'a>,
    task: L<'a>,
    override_ids: L<'a>,
    body: bool,
) -> Result<L<'a>> {
    let ids = or(override_ids, || plain(p, c"taskIdentityIds", &[task]))?;
    let set = p.global()?.get(c"Set")?.construct(&[ids])?;
    let ids = spread_array(set)?;
    let members = call(
        ids,
        c"map",
        &[function(p, "", 1, 1, |p, a| {
            let member = board_task(p, a[0])?;
            if member.truthy()? {
                fields(
                    p,
                    &[
                        ("refs", member.get(c"refs")?),
                        ("routing", member.get(c"routing")?),
                    ],
                )
            } else {
                null(p)
            }
        })?],
    )?;
    let history = p.get(c"loadHistory")?;
    if body {
        call(
            p.get(c"native")?,
            c"taskBoardCanonicalTaskBody",
            &[
                members,
                ids,
                task,
                history,
                p.get(c"core")?.get(c"messageText")?,
            ],
        )
    } else {
        call(
            p.get(c"native")?,
            c"taskBoardCanonicalMessages",
            &[members, ids, history],
        )
    }
}

pub(super) fn ensure<'a>(p: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let id = read(opts, c"taskId")?;
    let dir = opts.get(c"dirId")?;
    let session = opts.get(c"sessionId")?;
    let routing = opts.get(c"routing")?;
    let task_text = defined(opts.get(c"taskText")?, || text(p, ""))?;
    let origin = defined(opts.get(c"origin")?, || null(p))?;
    let ts = defined(opts.get(c"now")?, || now(p))?;
    let raw = board_task(p, id)?;
    let existing = if raw.truthy()? {
        plain(p, c"resolvedTask", &[id])?
    } else {
        null(p)?
    };
    let task = or(existing, || {
        core(
            p,
            c"createPendingTask",
            &[
                p.get(c"board")?,
                fields(
                    p,
                    &[
                        ("taskId", id),
                        ("dirId", dir),
                        ("sessionId", session),
                        ("taskText", task_text),
                        ("origin", origin),
                        ("now", ts),
                    ],
                )?,
            ],
        )
    })?;
    if !task.truthy()? {
        return fields(p, &[("task", null(p)?), ("created", flag(p, false)?)]);
    }
    let origins = p.get(c"core")?.get(c"TASK_ORIGINS")?;
    if call(origins, c"has", &[origin])?.truthy()? && !task.get(c"origin")?.equals(origin)? {
        task.assign(c"origin", origin)?
    }
    if session.truthy()? {
        let refs = or(task.get(c"refs")?, || array(p, &[]))?;
        let has = call(
            refs,
            c"some",
            &[function(session, "", 1, 1, |id, a| {
                flag(id, read(a[0], c"sessionId")?.equals(id)?)
            })?],
        )?;
        if !has.truthy()? {
            core(
                p,
                c"addRefToTask",
                &[
                    task,
                    fields(
                        p,
                        &[
                            ("sessionId", session),
                            ("dirId", dir),
                            ("userMsgId", null(p)?),
                            ("assistantMsgId", null(p)?),
                            ("ts", ts),
                            ("excerpt", text(p, "")?),
                        ],
                    )?,
                    ts,
                ],
            )?;
        }
    }
    if routing.truthy()? {
        core(p, c"setTaskRouting", &[task, routing])?;
    }
    fields(p, &[("task", task), ("created", flag(p, !raw.truthy()?)?)])
}

pub(super) fn persisted<'a>(p: L<'a>, sid: L<'a>, msg: L<'a>) -> Result<L<'a>> {
    if !msg.optional(c"taskId")?.truthy()? || !msg.get(c"role")?.truthy()? {
        return flag(p, false);
    }
    let rec = record(p, sid)?;
    if !rec.truthy()?
        || rec.get(c"type")?.is_string("commander")?
        || rec.get(c"type")?.is_string("aux")?
        || rec.get(c"type")?.is_string("gateway")?
    {
        return flag(p, false);
    }
    let mut task = plain(p, c"resolvedTask", &[msg.get(c"taskId")?])?;
    let created = !task.truthy()?
        && msg.get(c"role")?.is_string("user")?
        && msg.get(c"taskStart")?.is_true()?;
    if created {
        let opts = fields(
            p,
            &[
                ("taskId", msg.get(c"taskId")?),
                ("dirId", fallback(rec.get(c"dirId")?, V::Null)?),
                ("sessionId", sid),
                (
                    "taskText",
                    or(msg.get(c"taskText")?, || core(p, c"messageText", &[msg]))?,
                ),
                (
                    "origin",
                    core(p, c"taskOriginForSource", &[msg.get(c"taskSource")?])?,
                ),
                ("now", or(msg.get(c"ts")?, || now(p))?),
            ],
        )?;
        task = ensure(p, opts)?.get(c"task")?;
    }
    if !task.truthy()? {
        return flag(p, false);
    }
    let ids = p
        .global()?
        .get(c"Set")?
        .construct(&[plain(p, c"taskIdentityIds", &[task])?])?;
    let history = or(plain(p, c"loadHistory", &[sid])?, || array(p, &[]))?;
    let index = call(
        history,
        c"findIndex",
        &[function(msg, "", 1, 1, |msg, a| {
            flag(msg, a[0].optional(c"id")?.equals(msg.get(c"id")?)?)
        })?],
    )?
    .number()? as i64;
    let mut user = if msg.get(c"role")?.is_string("user")? {
        msg
    } else {
        null(p)?
    };
    if !user.truthy()? && index != -1 {
        for i in (0..index).rev() {
            let candidate = history.element(i as u32)?;
            if candidate.optional(c"role")?.is_string("user")?
                && call(ids, c"has", &[candidate.get(c"taskId")?])?.truthy()?
            {
                user = candidate;
                break;
            }
        }
    }
    let reference = fields(
        p,
        &[
            ("sessionId", sid),
            ("dirId", fallback(rec.get(c"dirId")?, V::Null)?),
            ("userMsgId", fallback(user.optional(c"id")?, V::Null)?),
            (
                "assistantMsgId",
                if msg.get(c"role")?.is_string("assistant")? {
                    fallback(msg.get(c"id")?, V::Null)?
                } else {
                    null(p)?
                },
            ),
            ("ts", or(msg.get(c"ts")?, || now(p))?),
            ("excerpt", text(p, "")?),
        ],
    )?;
    let mut changed = core(
        p,
        c"addRefToTask",
        &[task, reference, or(msg.get(c"ts")?, || now(p))?],
    )?
    .truthy()?;
    let core_obj = p.get(c"core")?;
    if !task.get(c"titleSource")?.is_string("manual")?
        && task
            .get(c"title")?
            .equals(core_obj.get(c"PENDING_TASK_TITLE")?)?
        && user.truthy()?
    {
        let derived = core(
            p,
            c"deriveTaskTitle",
            &[or(user.get(c"taskText")?, || {
                core(p, c"messageText", &[user])
            })?],
        )?;
        if !derived.equals(core_obj.get(c"PENDING_TASK_TITLE")?)? {
            task.assign(c"title", derived)?;
            task.assign(c"updatedAt", or(msg.get(c"ts")?, || now(p))?)?;
            changed = true
        }
    }
    let started =
        msg.get(c"role")?.is_string("user")? && !task.get(c"runState")?.is_string("running")?;
    if started {
        task.assign(c"runState", text(p, "running")?)?
    }
    if created || changed || started {
        plain(p, c"save", &[])?;
        changed_notice(p, rec.get(c"dirId")?, task.get(c"id")?, created)?;
    }
    flag(p, true)
}

pub(super) fn reassign<'a>(p: L<'a>, args: &[L<'a>]) -> Result<L<'a>> {
    let (sid, old_id, new_id) = (args[0], args[1], args[2]);
    if !new_id.truthy()? || old_id.equals(new_id)? {
        return flag(p, false);
    }
    let rec = record(p, sid)?;
    if !worker_record(rec)?
        || (rec.get(c"taskBoundTaskId")?.truthy()?
            && !new_id.equals(rec.get(c"taskBoundTaskId")?)?)
    {
        return flag(p, false);
    }
    let msgs = defined(args[3], || array(p, &[]))?;
    let meta = default_object(args[4])?;
    let find_role = |xs, role: &'static str| -> Result<L<'a>> {
        fallback(
            call(
                xs,
                c"find",
                &[function(p, "", 1, 1, move |p, a| {
                    flag(p, a[0].optional(c"role")?.is_string(role)?)
                })?],
            )?,
            V::Null,
        )
    };
    let user = find_role(msgs, "user")?;
    let assistant = find_role(call(spread_array(msgs)?, c"reverse", &[])?, "assistant")?;
    let mapped = call(
        msgs,
        c"map",
        &[function(p, "", 1, 1, |_, a| a[0].optional(c"id"))?],
    )?;
    let ids = p.global()?.get(c"Set")?.construct(&[call(
        mapped,
        c"filter",
        &[p.global()?.get(c"Boolean")?],
    )?])?;
    let old = if old_id.truthy()? {
        plain(p, c"resolvedTask", &[old_id])?
    } else {
        null(p)?
    };
    let mut old_changed = false;
    if old.truthy()? && ids.get(c"size")?.truthy()? {
        let before = old.get(c"refs")?.get(c"length")?;
        let filtered = call(
            old.get(c"refs")?,
            c"filter",
            &[function(ids, "", 1, 1, |ids, r| {
                flag(
                    ids,
                    !call(ids, c"has", &[read(r[0], c"userMsgId")?])?.truthy()?
                        && !call(ids, c"has", &[r[0].get(c"assistantMsgId")?])?.truthy()?,
                )
            })?],
        )?;
        old.assign(c"refs", filtered)?;
        old_changed = !old.get(c"refs")?.get(c"length")?.equals(before)?;
        if old_changed {
            old.assign(c"updatedAt", now(p)?)?;
        }
    }
    let indexed = ensure(
        p,
        fields(
            p,
            &[
                ("taskId", new_id),
                ("dirId", fallback(rec.get(c"dirId")?, V::Null)?),
                ("sessionId", sid),
                (
                    "taskText",
                    or(read(meta, c"taskText")?, || {
                        fallback(user.optional(c"content")?, "".into())
                    })?,
                ),
                ("now", or(user.optional(c"ts")?, || now(p))?),
            ],
        )?,
    )?;
    let task = indexed.get(c"task")?;
    if !task.truthy()? {
        return flag(p, false);
    }
    let at = now(p)?;
    let reference = fields(
        p,
        &[
            ("sessionId", sid),
            ("dirId", fallback(rec.get(c"dirId")?, V::Null)?),
            ("userMsgId", fallback(user.optional(c"id")?, V::Null)?),
            (
                "assistantMsgId",
                fallback(assistant.optional(c"id")?, V::Null)?,
            ),
            (
                "ts",
                or(assistant.optional(c"ts")?, || {
                    or(user.optional(c"ts")?, || Ok(at))
                })?,
            ),
            ("excerpt", text(p, "")?),
        ],
    )?;
    let mut changed = core(p, c"addRefToTask", &[task, reference, at])?.truthy()?;
    let trimmed = call(
        string(fallback(meta.get(c"taskName")?, "".into())?)?,
        c"trim",
        &[],
    )?;
    let title = call(trimmed, c"slice", &[num(p, 0.)?, num(p, 40.)?])?;
    if !task.get(c"titleSource")?.is_string("manual")?
        && title.truthy()?
        && !task.get(c"title")?.equals(title)?
    {
        task.assign(c"title", title)?;
        task.assign(c"updatedAt", at)?;
        changed = true;
    }
    if !changed && !old_changed && !indexed.get(c"created")?.truthy()? {
        return flag(p, false);
    }
    plain(p, c"save", &[])?;
    let ids = if old_id.truthy()? {
        array(p, &[new_id, old_id])?
    } else {
        array(p, &[new_id])?
    };
    plain(p, c"notify", &[fallback(rec.get(c"dirId")?, V::Null)?, ids])?;
    if old.truthy()?
        && old_changed
        && old.get(c"refs")?.get(c"length")?.is_number(0.)?
        && old.get(c"moduleAssignment")?.truthy()?
        && !old.get(c"status")?.is_string("archived")?
        && old.get(c"origin")?.is_string("session")?
        && !old.get(c"chatSessionId")?.truthy()?
        && !old.get(c"routing")?.truthy()?
        && !old.get(c"worktreePath")?.truthy()?
        && !old.get(c"branch")?.truthy()?
    {
        call(
            p.get(c"classification")?,
            c"archiveMissing",
            &[p.get(c"classificationPorts")?, old],
        )?;
    }
    flag(p, true)
}
