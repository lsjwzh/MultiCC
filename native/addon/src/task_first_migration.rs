use crate::{js_live::spread, route_response::*};
use napi_derive::napi;
fn promote<'a>(p: L<'a>, task: L<'a>) -> Result<L<'a>> {
    let store = p.get(c"store")?;
    if !crate::js_iteration::read(task, c"taskFirst")?.truthy()? {
        let id = task.get(c"id")?;
        let value = spread(task)?;
        value.define_key(text(p, "taskFirst")?, flag(p, true)?)?;
        call(store, c"set", &[text(p, "task")?, id, value])?;
    }
    call(p.get(c"roles")?, c"snapshot", &[task.get(c"id")?])?;
    call(store, c"get", &[text(p, "task")?, task.get(c"id")?])
}
#[napi]
pub fn task_first_promote(
    env: Env,
    ports: Unknown<'_>,
    task: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(promote(L::new(&env, ports), L::new(&env, task))?.raw())
}
#[napi]
pub fn task_first_adopt(
    env: Env,
    owner: Unknown<'_>,
    list: Unknown<'_>,
    all: Unknown<'_>,
    known: Unknown<'_>,
    indexed: Unknown<'_>,
    deleted: Unknown<'_>,
    errors: Unknown<'_>,
) -> Result<()> {
    let p = L::new(&env, owner);
    let all = L::new(&env, all);
    let known = L::new(&env, known);
    let indexed = L::new(&env, indexed);
    let deleted = L::new(&env, deleted);
    let errors = L::new(&env, errors);
    L::new(&env, list).for_each(|r| {
        if !crate::js_iteration::read(r, c"kind")?.is_string("chat")?
            || r.get(c"taskExecutionSlot")?.truthy()?
            || r.get(c"experimentalMode")?.truthy()?
        {
            return Ok(());
        }
        let typ = r.get(c"type")?;
        if typ.is_string("aux")? || typ.is_string("gateway")? {
            return Ok(());
        }
        let ports = p.get(c"ports")?;
        let directory = ports.get(c"getDirectory")?;
        if directory.nullish()? || !directory.call(ports, &[r.get(c"dirId")?])?.truthy()? {
            return Ok(());
        }
        let lookup = || call(known, c"get", &[r.get(c"id")?]);
        if deleted
            .call_plain(&[r.get(c"taskBoundTaskId")?])?
            .truthy()?
            || deleted
                .call_plain(&[lookup()?.optional(c"id")?])?
                .truthy()?
        {
            return Ok(());
        }
        if lookup()?.optional(c"taskFirst")?.truthy()?
            && call(indexed, c"has", &[lookup()?.get(c"id")?])?.truthy()?
        {
            return Ok(());
        }
        let result = (|| {
            let owner = p.get(c"open")?.call_plain(&[r.get(c"id")?])?;
            let task = p
                .get(c"adopt")?
                .call_plain(&[owner.get(c"id")?, r.get(c"id")?])?;
            call(all, c"set", &[task.get(c"id")?, promote(p, task)?])
        })();
        if let Err(error) = result {
            let cause = p.exception_value()?.ok_or(error)?;
            call(
                errors,
                c"push",
                &[fields(
                    p,
                    &[
                        ("sessionId", r.get(c"id")?),
                        (
                            "code",
                            fallback(cause.get(c"code")?, "task_migration_failed".into())?,
                        ),
                    ],
                )?],
            )?;
        }
        Ok(())
    })
}
#[napi]
pub fn task_first_index_plan(
    env: Env,
    owner: Unknown<'_>,
    original: Unknown<'_>,
    indexed: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, owner);
    let original = L::new(&env, original);
    let indexed = L::new(&env, indexed);
    let promoted = original.get(c"taskFirst")?.truthy()?
        && call(indexed, c"has", &[original.get(c"id")?])?.truthy()?;
    let task = if promoted {
        original
    } else {
        promote(p, original)?
    };
    Ok(fields(
        p,
        &[
            ("task", task),
            (
                "index",
                flag(
                    p,
                    !promoted && !call(indexed, c"has", &[task.get(c"id")?])?.truthy()?,
                )?,
            ),
        ],
    )?
    .raw())
}
