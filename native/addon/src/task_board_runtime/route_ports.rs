//! The gateway owns HTTP routing. These methods adapt its captured request
//! context to an existing board transaction and preserve its response object.
use crate::{
    host_methods::{async_result, default_object, function},
    route_response::*,
};
use napi_derive::napi;
use std::ffi::CStr;

fn fake_request(context: L<'_>) -> Result<L<'_>> {
    let context = default_object(context)?;
    let parameter = |key| {
        let value = context.get(key)?;
        if value.undefined()? {
            text(context, "")
        } else {
            Ok(value)
        }
    };
    let params = fields(
        context,
        &[
            ("taskId", parameter(c"taskId")?),
            ("dirId", parameter(c"dirId")?),
        ],
    )?;
    fields(
        context,
        &[("params", params), ("body", context.get(c"body")?)],
    )
}

fn planning<'a>(
    runtime: L<'a>,
    handler: &'static CStr,
    context: L<'a>,
    res: L<'a>,
    lock: bool,
) -> Result<L<'a>> {
    if !lock {
        return call(runtime, handler, &[fake_request(context)?, res]);
    }
    let state = fields(
        runtime,
        &[("runtime", runtime), ("ctx", context), ("res", res)],
    )?;
    let perform = function(state, "", 0, 0, move |s, _| {
        call(
            s.get(c"runtime")?,
            handler,
            &[fake_request(s.get(c"ctx")?)?, s.get(c"res")?],
        )
    })?;
    call(
        runtime,
        c"withTaskLock",
        &[context.get(c"taskId")?, perform],
    )
}

fn retention<'a>(ports: L<'a>, ctx: L<'a>, res: L<'a>, remove: bool) -> Result<L<'a>> {
    let job = async_result(ports, || {
        let deps = ports.get(c"deps")?;
        let directory = ctx.get(c"dirId")?;
        let dirs = deps.get(c"directories")?;
        if dirs.nullish()? || !call(dirs, c"get", &[directory])?.truthy()? {
            return send(
                res,
                Some(404),
                fields(
                    res,
                    &[
                        ("ok", flag(res, false)?),
                        ("code", text(res, "directory_not_found")?),
                    ],
                )?,
            );
        }
        if deps.get(c"listShellTasks")?.kind()? != sys::ValueType::napi_function {
            return send(
                res,
                Some(503),
                fields(
                    res,
                    &[
                        ("ok", flag(res, false)?),
                        ("code", text(res, "task_inventory_unavailable")?),
                    ],
                )?,
            );
        }
        let list = function(deps, "", 0, 0, |d, _| call(d, c"listShellTasks", &[]))?;
        let owner = ports.get(c"retention")?;
        let pending = if remove {
            call(
                owner,
                c"deleteSelected",
                &[directory, list, ctx.get(c"body")?.optional(c"taskIds")?],
            )?
        } else {
            call(owner, c"preview", &[directory, list])?
        };
        let promise = call(ports.global()?.get(c"Promise")?, c"resolve", &[pending])?;
        call(
            promise,
            c"then",
            &[function(res, "", 1, 1, |res, a| {
                let body = fields(res, &[("ok", flag(res, true)?)])?;
                body.spread_from(a[0])?;
                send(res, None, body)
            })?],
        )
    })?;
    call(
        job,
        c"catch",
        &[function(res, "", 1, 1, |res, a| {
            let status = fallback(a[0].get(c"status")?, V::Number(500.))?;
            let body = fields(
                res,
                &[
                    ("ok", flag(res, false)?),
                    (
                        "code",
                        fallback(a[0].get(c"code")?, V::from("retention_failed"))?,
                    ),
                ],
            )?;
            call(call(res, c"status", &[status])?, c"json", &[body])
        })?],
    )
}

fn guarded<'a>(
    p: L<'a>,
    ctx: L<'a>,
    res: L<'a>,
    name: &'static CStr,
    label: &'static str,
) -> Result<L<'a>> {
    let state = fields(p, &[("ports", p), ("ctx", ctx), ("res", res)])?;
    let invoke = function(state, "", 0, 0, move |s, _| {
        let p = s.get(c"ports")?;
        let owner = if name == c"relocate" {
            p.get(c"taskRelocate")?
        } else {
            p
        };
        call(
            owner,
            name,
            &[fake_request(s.get(c"ctx")?)?, s.get(c"res")?],
        )
    })?;
    let promise = call(p.global()?.get(c"Promise")?, c"resolve", &[])?;
    let pending = call(promise, c"then", &[invoke])?;
    call(
        pending,
        c"catch",
        &[function(state, "", 1, 1, move |s, a| {
            let res = s.get(c"res")?;
            let reason = a[0].optional(c"message")?;
            let message = if reason.truthy()? { reason } else { a[0] };
            let line = call(
                text(s, &format!("[multicc/taskboard] {label} failed: "))?,
                c"concat",
                &[message],
            )?;
            call(s.get(c"ports")?.get(c"logger")?, c"log", &[line])?;
            if !res.get(c"headersSent")?.truthy()? {
                error(res, 500, "internal_error", false)?;
            }
            s.from_value(&V::Undefined)
        })?],
    )
}

#[napi]
pub fn task_board_route_ports(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let out = fields(p, &[])?;
    for (key, handler, locked) in [
        ("planningCreate", c"handleCreate", false),
        ("planningUpdate", c"handleUpdate", true),
        ("planningRename", c"handleRename", true),
        ("planningMove", c"handleMove", true),
    ] {
        out.set_key(
            text(p, key)?,
            function(p, key, 2, 2, move |p, a| {
                planning(p.get(c"planningRuntime")?, handler, a[0], a[1], locked)
            })?,
        )?;
    }
    for (key, remove) in [("retentionPreview", false), ("retentionDelete", true)] {
        out.set_key(
            text(p, key)?,
            function(p, key, 2, 2, move |p, a| retention(p, a[0], a[1], remove))?,
        )?;
    }
    out.set(
        c"status",
        function(p, "status", 2, 2, |p, a| {
            guarded(p, a[0], a[1], c"handleStatus", "status update")
        })?,
    )?;
    out.set(
        c"delete",
        function(p, "delete", 2, 2, |p, a| {
            call(
                p.get(c"taskLifecycle")?,
                c"delete",
                &[fake_request(a[0])?, a[1]],
            )
        })?,
    )?;
    for (key, method, label) in [
        ("relocate", c"relocate", "relocate"),
        ("chatSession", c"handleChatSession", "chat-session"),
    ] {
        out.set_key(
            text(p, key)?,
            function(p, key, 2, 2, move |p, a| {
                guarded(p, a[0], a[1], method, label)
            })?,
        )?;
    }
    Ok(call(p.global()?.get(c"Object")?, c"freeze", &[out])?.raw())
}
