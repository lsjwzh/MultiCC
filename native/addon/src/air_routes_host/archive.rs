use super::*;
pub(super) fn archive(p: L<'_>) -> Result<L<'_>> {
    let d = deps(p)?;
    let shells = array(p)?;
    js_or(lookup(shell(p)?, c"listTasks", &[])?, array(p)?)?.for_each(|t| {
        if t.get(c"embedded")?.truthy()?
            || (t.get(c"separatedFromTaskId")?.truthy()? && !t.get(c"ready")?.truthy()?)
        {
            append(
                shells,
                pick(t, &[c"id", c"embedded", c"separatedFromTaskId", c"ready"])?,
            )?;
        }
        Ok(())
    })?;
    let busy_sessions = array(p)?;
    let busy_tasks = array(p)?;
    let activity = fields(p, &[])?;
    d.get(c"records")?.for_each(|pair| {
        let (id, r) = pair.iterator_pair()?;
        if !r.get(c"kind")?.is_string("chat")? {
            return Ok(());
        }
        activity.define_key(id, r.get(c"lastWorkAt")?)?;
        let run = lookup(d, c"getSessionRunState", &[id])?;
        if ports(p)?
            .get(c"isOpenRunState")?
            .call_plain(&[run])?
            .truthy()?
            || lookup(d, c"isSessionBusy", &[id])?.truthy()?
        {
            append(busy_sessions, id)?;
            for task in [
                r.get(c"taskBoundTaskId")?,
                r.get(c"taskState")?.optional(c"taskId")?,
                lookup(d, c"currentTaskId", &[id])?,
                lookup(shell(p)?, c"stateTarget", &[id])?.optional(c"taskId")?,
            ] {
                if task.truthy()? {
                    append(busy_tasks, task)?;
                }
            }
        }
        Ok(())
    })?;
    // Selection and admission run in the same host turn. No await may
    // separate the server-side activity check from the board transaction.
    let ids = domain(
        p,
        &[
            ("op", text(p, "airInactiveDone")?),
            ("board", call(d, c"getBoard", &[])?),
            ("shellTasks", shells),
            ("busySessions", busy_sessions),
            ("busyTasks", busy_tasks),
            ("activity", activity),
            ("now", now_ms(p)?),
        ],
    )?;
    then(call(d, c"archiveInactive", &[ids])?, p, |p, a| {
        if !a[0].get(c"ok")?.truthy()? {
            return refuse(p, "归档保存失败", 500., "archive_failed");
        }
        let live = p.get(c"live")?;
        let ids = a[0].get(c"archived")?;
        if live.truthy()? && ids.get(c"length")?.truthy()? {
            call(live, c"invalidate", &[ids])?;
            // Writes must be visible to a client refreshing immediately.
            call(live, c"invalidate", &[array(p)?])?;
            let result = a[0];
            return then(call(live, c"flush", &[])?, result, |result, _| Ok(result));
        }
        Ok(a[0])
    })
}
