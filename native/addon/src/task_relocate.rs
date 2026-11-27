use crate::route_response::*;
use napi_derive::napi;
fn refused<'a>(p: L<'a>, status: i32, why: &str) -> Result<L<'a>> {
    fields(
        p,
        &[
            ("status", num(p, status.into())?),
            ("body", fields(p, &[("error", text(p, why)?)])?),
        ],
    )
}
#[napi]
pub fn task_relocate_plan(env: Env, ops: Unknown<'_>, req: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ops);
    let r = L::new(&env, req);
    let task = p
        .get(c"resolveTask")?
        .call_plain(&[crate::js_iteration::read(
            crate::js_iteration::read(r, c"params")?,
            c"taskId",
        )?])?;
    let result = if !task.truthy()? {
        refused(p, 404, "task_not_found")?
    } else if task.get(c"deleting")?.truthy()? {
        refused(p, 409, "task_deleting")?
    } else if task.get(c"status")?.is_string("archived")? {
        refused(p, 409, "task_archived")?
    } else if p
        .get(c"isBusy")?
        .call_plain(&[task.get(c"id")?])?
        .truthy()?
    {
        refused(p, 409, "task_busy")?
    } else {
        let dir = call(
            string(fallback(r.get(c"body")?.optional(c"dirId")?, "".into())?)?,
            c"trim",
            &[],
        )?;
        if !dir.truthy()? {
            refused(p, 400, "dirId required")?
        } else {
            let target = call(p.get(c"directories")?, c"get", &[dir])?;
            if !target.truthy()? {
                refused(p, 404, "target directory not found")?
            } else {
                let current = p.get(c"taskDirId")?.call_plain(&[task])?;
                if current.equals(dir)? {
                    fields(p, &[("unchanged", flag(p, true)?), ("task", task)])?
                } else {
                    fields(
                        p,
                        &[
                            ("task", task),
                            ("targetDirId", dir),
                            ("targetDir", target),
                            ("currentDirId", current),
                        ],
                    )?
                }
            }
        }
    };
    Ok(result.raw())
}
#[napi]
pub fn task_relocate_commit(
    env: Env,
    board: Unknown<'_>,
    plan: Unknown<'_>,
    records: Unknown<'_>,
    record: Unknown<'_>,
    ledger: Unknown<'_>,
    assign: Unknown<'_>,
) -> Result<sys::napi_value> {
    let board = L::new(&env, board);
    let p = L::new(&env, plan);
    let records = L::new(&env, records);
    let rec = L::new(&env, record);
    let ledger = L::new(&env, ledger);
    let assign = L::new(&env, assign);
    let current = board.get(c"tasks")?.get_key(p.get(c"task")?.get(c"id")?)?;
    if !current.truthy()? {
        return Ok(fields(
            p,
            &[
                ("ok", flag(p, false)?),
                ("error", text(p, "task_not_found")?),
            ],
        )?
        .raw());
    }
    let dir = p.get(c"targetDirId")?;
    let set = |obj: L<'_>, key: &str, value: L<'_>| -> Result<()> {
        assign.call_plain(&[obj, text(obj, key)?, value])?;
        Ok(())
    };
    set(current, "dirId", dir)?;
    for (key, prop) in [("worktreePath", c"worktreePath"), ("branch", c"branch")] {
        if rec.truthy()? {
            let v = call(records, c"get", &[rec.get(c"id")?])?.optional(prop)?;
            set(current, key, fallback(v, V::Null)?)?;
        } else if ledger.truthy()? {
            set(current, key, ledger.get(prop)?)?;
        }
    }
    let refs = current.get(c"refs")?;
    if refs.truthy()? {
        refs.for_each(|r| {
            if r.optional(c"dirId")?.truthy()?
                && !r.get(c"dirId")?.equals(dir)?
                && r.get(c"sessionId")?.truthy()?
                && call(records, c"get", &[r.get(c"sessionId")?])?
                    .optional(c"dirId")?
                    .equals(dir)?
            {
                set(r, "dirId", dir)?;
            }
            Ok(())
        })?;
    }
    if current.get(c"moduleId")?.truthy()? {
        set(current, "moduleId", null(p)?)?;
    }
    set(
        current,
        "updatedAt",
        call(p.global()?.get(c"Date")?, c"now", &[])?,
    )?;
    Ok(fields(p, &[("ok", flag(p, true)?)])?.raw())
}
