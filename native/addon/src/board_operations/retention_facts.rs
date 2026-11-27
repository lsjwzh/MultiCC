//! Collect host facts only for eligible shells. The core owns the final predicate and ordering.
use super::*;

fn timestamp(v: L<'_>) -> Result<L<'_>> {
    if let Some(n) = v.number_value()? {
        return num(v, if n.is_finite() && n > 0. { n } else { 0. });
    }
    let date = v.global()?.get(c"Date")?;
    if v.kind()? == sys::ValueType::napi_string {
        return fallback(call(date, c"parse", &[v])?, 0f64.into());
    }
    if object(v)? && v.instance_of(date)? {
        return timestamp(call(v, c"getTime", &[])?);
    }
    num(v, 0.)
}

pub(super) fn interaction<'a>(p: L<'a>, task: L<'a>, record: L<'a>) -> Result<L<'a>> {
    let row = spread(task)?;
    let refs = task.get(c"refs")?;
    let refs = if refs.is_array()? {
        call(
            refs,
            c"map",
            &[function(p, "projectTimestamp", 1, 1, |_, a| {
                let r = spread(a[0])?;
                r.set(c"timestamp", timestamp(a[0].get(c"ts")?)?)?;
                Ok(r)
            })?],
        )?
    } else {
        array(p)?
    };
    row.set(c"refs", refs)?;
    let rec = spread(record)?;
    rec.set(c"lastWorkTimestamp", timestamp(record.get(c"lastWorkAt")?)?)?;
    invoke(
        p,
        c"domain",
        &[fields(
            p,
            &[
                ("op", text(p, "lastInteraction")?),
                ("task", row),
                ("record", rec),
            ],
        )?],
    )
}

pub(super) fn candidates<'a>(p: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let pins = options.get(c"pinnedIds")?;
    if !pins.is_array()? {
        return Err(error_value(p, "air pins unavailable")?.throw_error());
    }
    let excluded = with_default(options.get(c"excludedIds")?, array(p)?)?;
    let set = p.global()?.get(c"Set")?;
    let skipped = set.construct(&[call(excluded, c"filter", &[p.global()?.get(c"Boolean")?])?])?;
    let pinned = set.construct(&[pins])?;
    let board = options.get(c"board")?;
    let dir = options.get(c"dirId")?;
    let shells = options.get(c"shellTasks")?;
    let records = options.get(c"records")?;
    let facts = fields(p, &[])?;
    shells.for_each(|shell| {
        if !shell.get(c"dirId")?.equals(dir)? || !shell.get(c"ready")?.truthy()? {
            return Ok(());
        }
        let id = shell.get(c"id")?;
        if call(skipped, c"has", &[id])?.truthy()? {
            return Ok(());
        }
        let tasks = board.get(c"tasks")?;
        let task = if tasks.nullish()? {
            undef(p)?
        } else {
            tasks.get_key(id)?
        };
        let record = call(records, c"get", &[shell.get(c"sessionId")?])?;
        if !task.truthy()?
            || !invoke(options, c"taskDirId", &[task])?.equals(dir)?
            || task.get(c"deleting")?.truthy()?
            || task.get(c"mergedIntoTaskId")?.truthy()?
        {
            return Ok(());
        }
        let status = task.get(c"status")?;
        if !status.is_string("done")?
            && !(status.is_string("archived")?
                && task.get(c"archivedFromStatus")?.is_string("done")?)
        {
            return Ok(());
        }
        let lineage = invoke(options, c"taskLineageIds", &[task])?;
        if !lineage.get(c"length")?.is_number(1.)?
            || call(pinned, c"has", &[lineage.element(0)?])?.truthy()?
        {
            return Ok(());
        }
        if !record.truthy()?
            || !record.get(c"taskBoundTaskId")?.equals(task.get(c"id")?)?
            || !record.get(c"dirId")?.equals(dir)?
            || record.get(c"workspaceOwnerSessionId")?.truthy()?
        {
            return Ok(());
        }
        let dir = invoke(options, c"taskDirId", &[task])?;
        let run = invoke(options, c"getRunState", &[record.get(c"id")?])?;
        let check = options.get(c"isSessionBusy")?;
        let busy = if check.undefined()? {
            flag(p, false)?
        } else {
            check.call_plain(&[record.get(c"id")?])?
        };
        let value = fields(
            p,
            &[
                ("dirId", dir),
                ("lineage", lineage),
                ("record", record),
                ("runState", run),
                ("busy", busy),
                ("lastInteraction", interaction(p, task, record)?),
            ],
        )?;
        facts.set_key(id, value)
    })?;
    let order = call(p.global()?.get(c"Object")?, c"keys", &[facts])?;
    call(
        order,
        c"sort",
        &[function(p, "localeOrder", 2, 2, |_, a| {
            call(a[0], c"localeCompare", &[a[1]])
        })?],
    )?;
    invoke(
        p,
        c"domain",
        &[fields(
            p,
            &[
                ("op", text(p, "retention")?),
                ("board", board),
                ("shellTasks", shells),
                ("dirId", dir),
                ("facts", facts),
                ("pinnedIds", pins),
                ("excludedIds", excluded),
                ("idOrder", order),
            ],
        )?],
    )
}
