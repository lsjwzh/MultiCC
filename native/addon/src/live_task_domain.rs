//! Live task-domain entry points. The maps and callbacks are V8 values so that
//! proxy identity, re-entry and detached methods follow the caller's objects.
use crate::{
    host_methods::{arg, async_result, default_object, env, function, raw, typed},
    route_response::*,
};
use napi_derive::napi;

mod air;
mod air_routes;
mod policy;
mod registry;

fn undef(p: L<'_>) -> Result<L<'_>> {
    p.from_value(&V::Undefined)
}
fn error_value<'a>(p: L<'a>, e: napi::Error) -> Result<L<'a>> {
    if let Some(thrown) = p.exception_value()? {
        return Ok(thrown);
    }
    let value = p
        .global()?
        .get(c"Error")?
        .construct(&[text(p, &e.reason)?])?;
    value.set(c"code", text(p, e.status.as_ref())?)?;
    Ok(value)
}
fn mapped(p: L<'_>, e: napi::Error) -> napi::Error {
    let result = error_value(p, e).and_then(|value| {
        crate::cli_switch::normalize_native_error(env(p), arg(value)?)
            .map(|handle| raw(p, handle).throw_error())
    });
    match result {
        Ok(e) | Err(e) => e,
    }
}
fn expose<'a>(
    p: L<'a>,
    api: L<'a>,
    name: &'static str,
    len: usize,
    count: usize,
    run: impl for<'v> Fn(L<'v>, &mut [L<'v>]) -> Result<L<'v>> + 'static,
) -> Result<()> {
    api.define_key(text(p, name)?, function(p, name, len, count, run)?)
}
fn getter<'a>(
    p: L<'a>,
    api: L<'a>,
    name: &'static str,
    run: impl for<'v> Fn(L<'v>, &mut [L<'v>]) -> Result<L<'v>> + 'static,
) -> Result<()> {
    let desc = fields(
        p,
        &[
            ("get", function(p, name, 0, 0, run)?),
            ("configurable", flag(p, true)?),
            ("enumerable", flag(p, true)?),
        ],
    )?;
    call(
        p.global()?.get(c"Object")?,
        c"defineProperty",
        &[api, text(p, name)?, desc],
    )?;
    Ok(())
}
fn board_store<'a>(p: L<'a>, board: L<'a>) -> Result<L<'a>> {
    if board.kind()? != sys::ValueType::napi_object {
        return null(p);
    }
    let found = call(p.get(c"stores")?, c"get", &[board])?;
    if found.truthy()? {
        Ok(found)
    } else {
        null(p)
    }
}
fn for_wire<'a>(p: L<'a>, value: L<'a>, depth: L<'a>) -> Result<L<'a>> {
    if value.kind()? != sys::ValueType::napi_object {
        return Ok(value);
    }
    let owner = call(p.get(c"tracked")?, c"get", &[value])?;
    if !owner.nullish()? {
        let original = call(owner, c"rawOf", &[value])?;
        if original.truthy()? {
            return Ok(original);
        }
    }
    if depth.is_number(0.)? || value.is_array()? {
        return Ok(value);
    }
    let keys = call(p.global()?.get(c"Object")?, c"keys", &[value])?;
    let mut copy = None;
    keys.for_each(|key| {
        let child = value.get_key(key)?;
        let next = for_wire(p, child, num(p, depth.number()? - 1.)?)?;
        if !next.equals(value.get_key(key)?)? {
            let changed = match copy {
                Some(obj) => obj,
                None => {
                    let obj = crate::js_live::spread(value)?;
                    copy = Some(obj);
                    obj
                }
            };
            changed.set_key(key, next)?;
        }
        Ok(())
    })?;
    Ok(copy.unwrap_or(value))
}
fn replace<'a>(p: L<'a>, target: L<'a>, next: L<'a>) -> Result<L<'a>> {
    let owner = call(p.get(c"tracked")?, c"get", &[target])?;
    if !owner.nullish()? && call(owner, c"replaceTracked", &[target, next])?.truthy()? {
        return Ok(target);
    }
    let object = p.global()?.get(c"Object")?;
    call(object, c"keys", &[target])?.for_each(|key| {
        if !call(object, c"hasOwn", &[next, key])?.truthy()?
            && !call(
                p.global()?.get(c"Reflect")?,
                c"deleteProperty",
                &[target, key],
            )?
            .truthy()?
        {
            return Err(target.type_error("Cannot delete property"));
        }
        Ok(())
    })?;
    call(object, c"assign", &[target, next])?;
    Ok(target)
}
fn domain<'a>(p: L<'a>, cmd: L<'a>, asynchronous: bool) -> Result<L<'a>> {
    let store = board_store(p, cmd.optional(c"board")?)?;
    if store.truthy()? {
        return call(
            store,
            if asynchronous { c"callAsync" } else { c"call" },
            &[cmd],
        );
    }
    let json = p.global()?.get(c"JSON")?;
    let encode = || call(json, c"stringify", &[for_wire(p, cmd, num(p, 3.)?)?]);
    if asynchronous {
        return call(p, c"runQueuedDomain", &[encode()?]);
    }
    let run = || {
        let input = typed::<String>(encode()?)?;
        let value = crate::task_domain::task_domain(input)?;
        call(json, c"parse", &[text(p, &value)?])
    };
    run().map_err(|e| mapped(p, e))
}
fn attention(p: L<'_>) -> Result<L<'_>> {
    let out = fields(p, &[])?;
    for (label, action, len, count) in [
        ("attentionKind", "kind", 1, 1),
        ("noteRunState", "note", 3, 4),
        ("markSeen", "seen", 1, 2),
        ("pendingAttention", "pending", 1, 1),
        ("normalizeAttention", "normalize", 2, 2),
    ] {
        expose(p, out, label, len, count, move |p, a| {
            let cmd = fields(
                p,
                &[("op", text(p, "attention")?), ("action", text(p, action)?)],
            )?;
            if action == "kind" {
                cmd.set(c"state", a[0])?;
                return domain(p, cmd, false);
            }
            let task = if action == "normalize" { a[1] } else { a[0] };
            cmd.set(c"task", task)?;
            match action {
                "pending" => return domain(p, cmd, false),
                "normalize" => cmd.set(c"source", a[0])?,
                _ => {
                    if action == "note" {
                        cmd.set(c"previous", a[1])?;
                        cmd.set(c"next", a[2])?;
                    }
                    let time = a[count - 1];
                    cmd.set(
                        c"at",
                        if time.undefined()? {
                            call(p.global()?.get(c"Date")?, c"now", &[])?
                        } else {
                            time
                        },
                    )?;
                }
            }
            let answer = domain(p, cmd, false)?;
            if task.truthy()? {
                replace(p, task, answer.get(c"task")?)?;
            }
            if action == "normalize" {
                undef(p)
            } else {
                answer.get(c"changed")
            }
        })?;
    }
    Ok(out)
}
#[napi]
pub fn live_task_domain_host(e: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&e, ports);
    let weak = p.global()?.get(c"WeakMap")?;
    p.set(c"stores", weak.construct(&[])?)?;
    let tracked = weak.construct(&[])?;
    p.set(c"tracked", tracked)?;
    let out = fields(
        p,
        &[
            ("trackedProxies", tracked),
            ("taskAttention", attention(p)?),
        ],
    )?;
    expose(p, out, "registerBoardStore", 2, 2, |p, a| {
        call(p.get(c"stores")?, c"set", a)?;
        undef(p)
    })?;
    expose(p, out, "boardStoreOf", 1, 1, |p, a| board_store(p, a[0]))?;
    expose(p, out, "forWire", 1, 2, |p, a| {
        for_wire(p, a[0], if a[1].undefined()? { num(p, 3.)? } else { a[1] })
    })?;
    expose(p, out, "replace", 2, 2, |p, a| replace(p, a[0], a[1]))?;
    expose(p, out, "taskDomain", 1, 1, |p, a| domain(p, a[0], false))?;
    expose(p, out, "taskDomainAsync", 1, 1, |p, a| {
        async_result(p, || domain(p, a[0], true))
    })?;
    expose(p, out, "cloneBoard", 1, 1, |p, a| {
        let store = board_store(p, a[0])?;
        if store.truthy()? {
            return call(store, c"cloneRaw", &[]);
        }
        let json = p.global()?.get(c"JSON")?;
        call(json, c"parse", &[call(json, c"stringify", &[a[0]])?])
    })?;
    expose(p, out, "createTaskBoardRepository", 1, 1, |p, a| {
        let run = function(p, "runRepository", 1, 1, |p, a| {
            domain(p, a[0], false).map_err(|e| mapped(p, e))
        })?;
        Ok(raw(
            p,
            crate::task_domain::task_board_repository(env(p), arg(a[0])?, arg(run)?)?,
        ))
    })?;
    registry::install(p, out)?;
    policy::install(p, out)?;
    air::install(p, out)?;
    Ok(out.raw())
}
