use super::*;

pub(super) fn register<'e>(p: L<'e>, input: L<'e>) -> Result<L<'e>> {
    let frame = fields(p, &[("p", p), ("input", input)])?;
    let run = function(frame, "", 1, 1, |f, a| {
        let p = f.get(c"p")?;
        let input = f.get(c"input")?;
        let draft = a[0];
        let deleted = draft.get(c"deletedTaskIds")?;
        if !deleted.nullish()? && call(deleted, c"includes", &[input.get(c"id")?])?.truthy()? {
            return failure(p, text(p, "task_deleted")?);
        }
        let mut task = draft.get(c"tasks")?.get_key(input.get(c"id")?)?;
        if task.truthy()?
            && (task.get(c"mergedIntoTaskId")?.truthy()?
                || (task.get(c"chatSessionId")?.truthy()?
                    && !task
                        .get(c"chatSessionId")?
                        .equals(input.get(c"sessionId")?)?))
        {
            return failure(p, text(p, "task_identity_conflict")?);
        }
        if !task.truthy()? {
            let args = fields(
                p,
                &[
                    ("taskId", input.get(c"id")?),
                    ("dirId", input.get(c"dirId")?),
                    ("sessionId", input.get(c"sessionId")?),
                    ("taskText", input.get(c"title")?),
                    ("origin", text(p, "manual")?),
                    ("now", input.get(c"createdAt")?),
                ],
            )?;
            task = Host(p).core(c"createPendingTask", &[draft, args])?;
        }
        if !task.truthy()? {
            return failure(p, text(p, "task_index_failed")?);
        }
        task.assign(c"chatSessionId", input.get(c"sessionId")?)?;
        task.assign(c"ownerShellId", input.get(c"ownerShellId")?)?;
        task.assign(
            c"forkedFromTaskId",
            fallback(input.get(c"forkedFromTaskId")?, V::Null)?,
        )?;
        if input.get(c"ownerShellId")?.truthy()?
            && !input.get(c"forkedFromTaskId")?.truthy()?
            && !task.get(c"routing")?.truthy()?
        {
            task.assign(c"origin", text(p, "session")?)?;
        }
        let routing = fields(
            p,
            &[
                ("mode", text(p, "task-bound")?),
                ("workerSessionId", input.get(c"sessionId")?),
                ("oneWay", flag(p, true)?),
            ],
        )?;
        Host(p).core(c"setTaskRouting", &[task, routing])?;
        fields(p, &[("ok", flag(p, true)?)])
    })?;
    mutate(p, run)
}

pub(super) fn mark_seen<'e>(p: L<'e>, id: L<'e>) -> Result<L<'e>> {
    let task = resolved(p, task_key(id)?)?;
    if !call(p.get(c"attention")?, c"markSeen", &[task])?.truthy()? {
        return flag(p, false);
    }
    save(p)?;
    let dir = fallback(
        Host(p).core(c"taskDirId", &[Host(p).board()?, task])?,
        V::Null,
    )?;
    let ids = array(p)?;
    ids.set_element(0, task.get(c"id")?)?;
    notify(p, dir, ids, undefined(p)?)?;
    flag(p, true)
}

fn archive_result<'e>(p: L<'e>, ok: bool, ids: L<'e>, skipped: L<'e>) -> Result<L<'e>> {
    fields(
        p,
        &[
            ("ok", flag(p, ok)?),
            ("archived", ids),
            ("skipped", skipped),
        ],
    )
}

pub(super) fn archive<'e>(p: L<'e>, input: L<'e>, idle_only: bool) -> Result<L<'e>> {
    let map = function(p, "", 1, 1, |_, a| task_key(a[0]))?;
    let input = input.or(|| array(p))?;
    let keys = call(input, c"map", &[map])?;
    let keys = call(keys, c"filter", &[p.global()?.get(c"Boolean")?])?;
    let wanted = p.global()?.get(c"Set")?.construct(&[keys])?;
    let ids = array(p)?;
    let skipped = array(p)?;
    wanted.for_each(|id| {
        let task = Host(p).tasks()?.get_key(id)?;
        if task.truthy()?
            && (!idle_only || task.get(c"status")?.is_string("done")?)
            && !task.get(c"status")?.is_string("archived")?
            && !task.get(c"deleting")?.truthy()?
            && !call(p.get(c"taskLifecycle")?, c"isBusy", &[id])?.truthy()?
        {
            call(ids, c"push", &[id])?;
        } else {
            let row = fields(
                p,
                &[("taskId", id), ("error", text(p, "task_busy_or_missing")?)],
            )?;
            call(skipped, c"push", &[row])?;
        }
        Ok(())
    })?;
    if !ids.get(c"length")?.truthy()? {
        return archive_result(p, true, ids, skipped);
    }
    let run = function(ids, "", 1, 1, |ids, a| {
        let tasks = a[0].get(c"tasks")?;
        let at = Host(ids).now()?;
        ids.for_each(|id| {
            let task = tasks.get_key(id)?;
            if !task.get(c"status")?.is_string("archived")? {
                task.assign(c"archivedFromStatus", task.get(c"status")?)?;
            }
            task.assign(c"status", text(task, "archived")?)?;
            task.assign(c"updatedAt", at)?;
            if task.get(c"recordType")?.is_string("planned")? {
                let revision = fallback(task.get(c"planningRevision")?, V::Number(1.))?;
                // Older boards may store this field as a string.
                let next = if revision.kind()? == sys::ValueType::napi_string {
                    concat(Host(task), &[revision, text(task, "1")?])?
                } else {
                    num(task, revision.number()? + 1.)?
                };
                task.assign(c"planningRevision", next)?;
            }
            Ok(())
        })?;
        fields(ids, &[("ok", flag(ids, true)?)])
    })?;
    let result = mutate(p, run)?;
    if !result.optional(c"ok")?.truthy()? {
        let skipped = array(p)?;
        wanted.for_each(|id| {
            let row = fields(
                p,
                &[
                    ("taskId", id),
                    (
                        "error",
                        fallback(result.optional(c"error")?, V::from("persistence_failed"))?,
                    ),
                ],
            )?;
            call(skipped, c"push", &[row])?;
            Ok(())
        })?;
        return archive_result(p, false, array(p)?, skipped);
    }
    notify(p, null(p)?, ids, undefined(p)?)?;
    archive_result(p, true, ids, skipped)
}
