//! Mutations act on the board store's live proxy. Its transaction callback
//! owns the before-image, including the revision and task object identities.
use crate::{
    host_methods::{async_result, function},
    js_live::spread,
    route_response::*,
    task_board_host::{concat, Host, Properties},
};
use napi_derive::napi;
mod tasks;

fn undefined(p: L<'_>) -> Result<L<'_>> {
    p.from_value(&V::Undefined)
}
fn array(p: L<'_>) -> Result<L<'_>> {
    p.from_value(&V::Array(Vec::new()))
}
fn failure<'e>(p: L<'e>, error: L<'e>) -> Result<L<'e>> {
    fields(p, &[("ok", flag(p, false)?), ("error", error)])
}
fn task_key(id: L<'_>) -> Result<L<'_>> {
    string(fallback(id, V::from(""))?)
}
fn resolved<'e>(p: L<'e>, id: L<'e>) -> Result<L<'e>> {
    Host(p).core(c"resolveTask", &[Host(p).board()?, task_key(id)?])
}
fn caught<'e>(p: L<'e>, err: napi::Error) -> Result<L<'e>> {
    match p.exception_value()? {
        Some(v) => Ok(v),
        None => p
            .global()?
            .get(c"Error")?
            .construct(&[text(p, &err.reason)?]),
    }
}

fn persist<'e>(p: L<'e>, expected: L<'e>) -> Result<L<'e>> {
    let persisted = call(p.get(c"boardStore")?, c"persist", &[expected])?;
    if persisted.optional(c"conflict")?.truthy()? {
        let logger = p.get(c"logger")?;
        let write = logger.get(c"warn")?.or(|| logger.get(c"log"))?;
        let message = concat(
            Host(p),
            &[
                text(p, "[multicc/taskboard] revision conflict: disk=")?,
                persisted.get(c"conflict")?.get(c"diskRevision")?,
                text(p, ", backup=")?,
                persisted.get(c"conflict")?.get(c"backup")?,
            ],
        )?;
        write.call(logger, &[message])?;
    }
    Ok(persisted)
}

fn bump_revision(p: L<'_>) -> Result<L<'_>> {
    let board = Host(p).board()?;
    let n = board.get(c"revision")?.explicit_number()?;
    let previous = if n.is_nan() || n == 0. { 0. } else { n };
    board.assign(
        c"schemaVersion",
        p.get(c"planning")?.get(c"TASK_BOARD_SCHEMA_VERSION")?,
    )?;
    board.assign(c"revision", num(p, previous + 1.)?)?;
    num(p, previous)
}

fn write_revision<'e>(p: L<'e>, previous: L<'e>) -> Result<()> {
    let result = persist(p, previous)?;
    if result.optional(c"revision")?.explicit_number()?.is_finite() {
        Host(p).board()?.assign(
            c"revision",
            num(p, result.get(c"revision")?.explicit_number()?)?,
        )?;
    }
    Ok(())
}

fn save(p: L<'_>) -> Result<L<'_>> {
    let previous = bump_revision(p)?;
    if let Err(err) = write_revision(p, previous) {
        let reason = caught(p, err)?;
        Host(p).board()?.assign(c"revision", previous)?;
        let message = concat(
            Host(p),
            &[
                text(p, "[multicc/taskboard] save failed: ")?,
                reason.get(c"message")?,
            ],
        )?;
        call(p.get(c"logger")?, c"log", &[message])?;
        return flag(p, false);
    }
    flag(p, true)
}

fn mutate<'e>(p: L<'e>, callback: L<'e>) -> Result<L<'e>> {
    let frame = fields(p, &[("ports", p), ("mutate", callback)])?;
    let transaction = function(frame, "", 1, 1, |f, args| {
        let p = f.get(c"ports")?;
        let rollback = args[0];
        let result = match f.get(c"mutate")?.call_plain(&[Host(p).board()?]) {
            Ok(result) => result,
            Err(err) => {
                let reason = caught(p, err)?;
                rollback.call_plain(&[])?;
                return failure(
                    p,
                    fallback(reason.optional(c"code")?, V::from("invalid_request"))?,
                );
            }
        };
        if !result.optional(c"ok")?.truthy()? {
            rollback.call_plain(&[])?;
            return result.or(|| failure(p, text(p, "invalid_request")?));
        }
        let previous = bump_revision(p)?;
        if let Err(err) = write_revision(p, previous) {
            let reason = caught(p, err)?;
            let message = concat(
                Host(p),
                &[
                    text(p, "[multicc/taskboard] planning save failed: ")?,
                    reason.optional(c"message")?.or(|| Ok(reason))?,
                ],
            )?;
            call(p.get(c"logger")?, c"log", &[message])?;
            rollback.call_plain(&[])?;
            return failure(p, text(p, "persistence_failed")?);
        }
        let out = spread(result)?;
        out.set(
            c"taskId",
            fallback(result.get(c"task")?.optional(c"id")?, V::Null)?,
        )?;
        Ok(out)
    })?;
    call(p.get(c"boardStore")?, c"transaction", &[transaction])
}

fn hold<'e>(p: L<'e>, id: L<'e>) -> Result<L<'e>> {
    let id = resolved(p, id)?
        .optional(c"id")?
        .or(|| call(task_key(id)?, c"trim", &[]))?;
    if !id.truthy()? {
        return function(p, "", 0, 0, |p, _| undefined(p));
    }
    let active = p.get(c"activeTaskOperations")?;
    let depth = fallback(call(active, c"get", &[id])?, V::Number(0.))?.number()?;
    call(active, c"set", &[id, num(p, depth + 1.)?])?;
    let frame = fields(
        p,
        &[("id", id), ("active", active), ("held", flag(p, true)?)],
    )?;
    function(frame, "", 0, 0, |f, _| {
        if f.get(c"held")?.truthy()? {
            f.set(c"held", flag(f, false)?)?;
            let id = f.get(c"id")?;
            let active = f.get(c"active")?;
            let next = fallback(call(active, c"get", &[id])?, V::Number(1.))?.number()? - 1.;
            if next > 0. {
                call(active, c"set", &[id, num(f, next)?])?;
            } else {
                call(active, c"delete", &[id])?;
            }
        }
        undefined(f)
    })
}

fn notify<'e>(p: L<'e>, dir: L<'e>, ids: L<'e>, kind: L<'e>) -> Result<L<'e>> {
    let payload = fields(
        p,
        &[("type", text(p, "task_board_update")?), ("taskIds", ids)],
    )?;
    if kind.truthy()? {
        payload.set(c"kind", kind)?;
    }
    let dirs = p.global()?.get(c"Set")?.construct(&[])?;
    if dir.truthy()? {
        call(dirs, c"add", &[dir])?;
    }
    if ids.is_array()? {
        ids.for_each(|id| {
            let task = Host(p).tasks()?.get_key(id)?;
            if task.truthy()? {
                if let Some(d) =
                    p.catch(|| Host(p).core(c"taskDirId", &[Host(p).board()?, task]))?
                {
                    if d.truthy()? {
                        call(dirs, c"add", &[d])?;
                    }
                }
            }
            Ok(())
        })?;
    }
    p.catch(|| -> Result<()> {
        let broadcast = p.get(c"workspaceBroadcast")?;
        if dirs.get(c"size")?.truthy()? {
            dirs.for_each(|dir| {
                broadcast.call_plain(&[dir, payload])?;
                Ok(())
            })?;
        } else {
            broadcast.call_plain(&[null(p)?, payload])?;
        }
        Ok(())
    })?;
    undefined(p)
}

fn update<'e>(p: L<'e>, id: L<'e>, patch: L<'e>, options: L<'e>) -> Result<L<'e>> {
    let required = if options.undefined()? {
        false
    } else {
        options.get(c"requirePersist")?.truthy()?
    };
    let task = Host(p).tasks()?.get_key(id)?;
    if !task.truthy()? {
        return undefined(p);
    }
    let previous = spread(task)?;
    let object = p.global()?.get(c"Object")?;
    call(object, c"assign", &[task, patch])?;
    task.assign(c"updatedAt", Host(p).now()?)?;
    if !save(p)?.truthy()? && required {
        let reflect = p.global()?.get(c"Reflect")?;
        call(object, c"keys", &[task])?.for_each(|key| {
            if !call(reflect, c"deleteProperty", &[task, key])?.truthy()? {
                return Err(task.type_error("Cannot delete task property"));
            }
            Ok(())
        })?;
        call(object, c"assign", &[task, previous])?;
        let error = p
            .global()?
            .get(c"Error")?
            .construct(&[text(p, "task state could not be persisted")?])?;
        error.assign(c"code", text(p, "TASK_PERSISTENCE_FAILED")?)?;
        return Err(error.throw_error());
    }
    let ids = array(p)?;
    ids.set_element(0, id)?;
    notify(p, null(p)?, ids, undefined(p)?)
}

#[napi]
pub fn task_board_state_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = fields(p, &[])?;
    for (name, length, count) in [
        ("persistWithRecovery", 1, 1),
        ("save", 0, 0),
        ("commitPlanningMutation", 1, 1),
        ("resolvedTask", 1, 1),
        ("taskIdentityIds", 1, 1),
        ("holdTaskOperation", 1, 1),
        ("notify", 3, 3),
        ("updateBoardTask", 2, 3),
        ("registerShellTask", 1, 1),
        ("markTaskSeen", 1, 1),
        ("archiveTasks", 1, 1),
    ] {
        let method = function(p, name, length, count, move |p, a| match name {
            "persistWithRecovery" => persist(p, a[0]),
            "save" => save(p),
            "commitPlanningMutation" => mutate(p, a[0]),
            "resolvedTask" => resolved(p, a[0]),
            "taskIdentityIds" => {
                if a[0].truthy()? {
                    Host(p).core(c"taskLineageIds", &[Host(p).board()?, a[0].get(c"id")?])
                } else {
                    array(p)
                }
            }
            "holdTaskOperation" => hold(p, a[0]),
            "notify" => notify(p, a[0], a[1], a[2]),
            "updateBoardTask" => update(p, a[0], a[1], a[2]),
            "registerShellTask" => tasks::register(p, a[0]),
            "markTaskSeen" => tasks::mark_seen(p, a[0]),
            "archiveTasks" => async_result(p, || tasks::archive(p, a[0])),
            _ => unreachable!(),
        })?;
        api.set_key(text(p, name)?, method)?;
    }
    Ok(api.raw())
}
