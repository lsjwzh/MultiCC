use super::*;
use crate::host_methods::{arg, env, raw};

pub(super) fn admission<'a>(p: L<'a>, a: L<'a>) -> Result<L<'a>> {
    let caller = record(p, read(a, c"callerSessionId")?)?;
    let worker = record(p, a.get(c"targetSessionId")?)?;
    let trimmed = |key| call(string(fallback(a.get(key)?, "".into())?)?, c"trim", &[]);
    let id = trimmed(c"taskId")?;
    let op = trimmed(c"operationId")?;
    let voice = plain(p, c"isVoiceRouterRecord", &[caller])?.truthy()?
        && read(caller, c"dirId")?.nullish()?;
    let same_dir = caller.optional(c"dirId")?.truthy()?
        && caller.get(c"dirId")?.equals(worker.optional(c"dirId")?)?;
    if !caller.truthy()?
        || !worker.truthy()?
        || !id.truthy()?
        || !op.truthy()?
        || (!same_dir && !voice)
        || !worker.get(c"dirId")?.truthy()?
        || !worker_record(worker)?
    {
        return flag(p, false);
    }
    let existing = board_task(p, id)?;
    if existing
        .optional(c"routing")?
        .optional(c"operationId")?
        .truthy()?
        && existing.get(c"routing")?.get(c"operationId")?.equals(op)?
    {
        return flag(p, true);
    }
    let commander = caller.get(c"type")?.is_string("commander")?;
    let worker_id = || or(worker.get(c"id")?, || a.get(c"targetSessionId"));
    let caller_id = || or(caller.get(c"id")?, || a.get(c"callerSessionId"));
    let dir = fallback(worker.get(c"dirId")?, V::Null)?;
    let sid = worker_id()?;
    let task_text = fallback(a.get(c"taskText")?, "".into())?;
    let routing = fields(
        p,
        &[
            (
                "mode",
                text(
                    p,
                    if commander {
                        "commander"
                    } else {
                        "router-tool"
                    },
                )?,
            ),
            ("callerSessionId", fallback(caller_id()?, V::Null)?),
            (
                "targetSessionId",
                if commander {
                    caller_id()?
                } else {
                    worker_id()?
                },
            ),
            ("workerSessionId", worker_id()?),
            ("operationId", op),
            ("status", fallback(a.get(c"status")?, "admitted".into())?),
            (
                "oneWay",
                flag(p, !a.get(c"resultMode")?.is_string("tool")?)?,
            ),
            ("routedAt", now(p)?),
        ],
    )?;
    let indexed = transcript::ensure(
        p,
        fields(
            p,
            &[
                ("taskId", id),
                ("dirId", dir),
                ("sessionId", sid),
                ("taskText", task_text),
                ("routing", routing),
            ],
        )?,
    )?;
    if !indexed.get(c"task")?.truthy()? {
        return flag(p, false);
    }
    indexed.get(c"task")?.assign(
        c"runState",
        text(
            p,
            if a.get(c"status")?.is_string("running")? {
                "running"
            } else {
                "queued"
            },
        )?,
    )?;
    plain(p, c"save", &[])?;
    changed_notice(
        p,
        worker.get(c"dirId")?,
        id,
        indexed.get(c"created")?.truthy()?,
    )?;
    flag(p, true)
}

fn bound<'a>(p: L<'a>, sid: L<'a>) -> Result<L<'a>> {
    let id = string(fallback(sid, "".into())?)?;
    if !id.truthy()? {
        return Ok(id);
    }
    let task_id = record(p, id)?.optional(c"taskBoundTaskId")?;
    if task_id.kind()? != sys::ValueType::napi_string || !task_id.truthy()? {
        return text(p, "");
    }
    if !board_task(p, task_id)?
        .optional(c"chatSessionId")?
        .equals(id)?
    {
        return text(p, "");
    }
    fallback(
        plain(p, c"resolvedTask", &[task_id])?.optional(c"id")?,
        "".into(),
    )
}

pub(super) fn queue<'a>(p: L<'a>, e: L<'a>) -> Result<L<'a>> {
    let id = or(string(fallback(read(e, c"taskId")?, "".into())?)?, || {
        bound(p, e.get(c"sessionId")?)
    })?;
    let task = if id.truthy()? {
        plain(p, c"resolvedTask", &[id])?
    } else {
        null(p)?
    };
    if !task.truthy()? {
        return fields(
            p,
            &[
                ("ok", flag(p, false)?),
                ("code", text(p, "task_not_found")?),
            ],
        );
    }
    let unchanged = |reason: Option<&str>| -> Result<L<'a>> {
        let v = fields(p, &[("ok", flag(p, true)?), ("changed", flag(p, false)?)])?;
        if let Some(reason) = reason {
            v.set(c"code", text(p, reason)?)?;
        }
        Ok(v)
    };
    let kind = string(fallback(e.get(c"type")?, "".into())?)?;
    let reconcile = kind.is_string("reconcile")?;
    if !reconcile && core(p, c"foreignRunSession", &[task, e.get(c"sessionId")?])?.truthy()? {
        return unchanged(Some("foreign_session_event"));
    }
    if kind.is_string("queued")? && !e.get(c"workKind")?.is_string("task")? {
        return unchanged(None);
    }
    let state = raw(
        p,
        crate::task_board_queue::task_board_queue_run_state(
            env(p),
            crate::host_methods::typed(kind)?,
            arg(e)?,
            arg(p.get(c"runStateForFreezeReason")?)?,
            arg(p.get(c"runStateForLetter")?)?,
        )?,
    );
    if !state.truthy()? {
        return unchanged(None);
    }
    let at = or(num(p, e.get(c"at")?.explicit_number()?)?, || now(p))?;
    if task.get(c"runStateAt")?.truthy()?
        && at.number()? < task.get(c"runStateAt")?.explicit_number()?
        && !reconcile
    {
        return unchanged(Some("stale_queue_event"));
    }
    let max_at = || {
        call(
            p.global()?.get(c"Math")?,
            c"max",
            &[fallback(task.get(c"runStateAt")?, V::Number(0.))?, at],
        )
    };
    if task.get(c"runState")?.equals(state)? && !reconcile {
        task.assign(c"runStateAt", max_at()?)?;
        return unchanged(None);
    }
    let changed = !task.get(c"runState")?.equals(state)?;
    if changed {
        call(
            p.get(c"attention")?,
            c"noteRunState",
            &[task, task.get(c"runState")?, state],
        )?;
    }
    task.assign(c"runState", state)?;
    task.assign(c"runStateAt", max_at()?)?;
    task.assign(c"updatedAt", now(p)?)?;
    if task.get(c"routing")?.truthy()? {
        task.get(c"routing")?.assign(c"status", state)?;
        task.get(c"routing")?
            .assign(c"freezeReason", fallback(e.get(c"freezeReason")?, V::Null)?)?;
    }
    plain(p, c"save", &[])?;
    let dir = core(p, c"taskDirId", &[p.get(c"board")?, task])?;
    plain(
        p,
        c"notify",
        &[fallback(dir, V::Null)?, array(p, &[task.get(c"id")?])?],
    )?;
    fields(
        p,
        &[
            ("ok", flag(p, true)?),
            ("changed", flag(p, changed)?),
            ("republished", flag(p, !changed)?),
        ],
    )
}

pub(super) fn reconcile<'a>(p: L<'a>, id: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let classify = defined(read(opts, c"classifyState")?, || null(p))?;
    let reason = defined(opts.get(c"reason")?, || text(p, ""))?;
    queue(
        p,
        fields(
            p,
            &[
                ("type", text(p, "reconcile")?),
                ("taskId", id),
                ("classifyState", classify),
                ("reason", reason),
                ("at", now(p)?),
            ],
        )?,
    )
}
