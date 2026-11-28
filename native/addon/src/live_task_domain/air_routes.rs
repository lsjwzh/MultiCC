//! Compatibility endpoints for embedders which still mount the Air lists on Express.
use super::*;

fn fail<'a>(p: L<'a>, res: L<'a>, e: napi::Error, toggle: bool, ignore: bool) -> Result<L<'a>> {
    let cause = error_value(p, e)?;
    let status = fallback(cause.get(c"status")?, V::Number(500.))?;
    let target = call(res, c"status", &[status])?;
    let code = cause.get(c"code")?;
    let code = if code.truthy()? {
        code
    } else if ignore {
        text(p, "todo_ignore_failed")?
    } else {
        p.get(c"codes")?.get(c"failed")?
    };
    let message = if toggle && cause.get(c"status")?.truthy()? {
        cause.get(c"message")?
    } else {
        text(p, "Request failed")?
    };
    let body = fields(
        p,
        &[
            ("ok", flag(p, false)?),
            ("code", code),
            ("message", message),
        ],
    )?;
    call(target, c"json", &[body])?;
    undef(p)
}
pub(super) fn mount<'a>(p: L<'a>, target: L<'a>, ignore: bool) -> Result<L<'a>> {
    let route = p.get(c"route")?;
    if !ignore {
        let read = function(p, "readRoute", 2, 2, |p, a| {
            let body = fields(
                p,
                &[("ok", flag(p, true)?), ("taskIds", call(p, c"read", &[])?)],
            )?;
            call(a[1], c"json", &[body])?;
            undef(p)
        })?;
        call(target, c"get", &[route, read])?;
        let replace = function(p, "replaceRoute", 2, 2, |p, a| {
            let body = a[0].get(c"body")?;
            let body = if body.truthy()? {
                body
            } else {
                fields(p, &[])?
            };
            if !body.get(c"taskIds")?.is_array()? {
                return send(
                    a[1],
                    Some(400),
                    fields(
                        p,
                        &[
                            ("ok", flag(p, false)?),
                            ("code", text(p, "task_ids_required")?),
                            ("message", text(p, "taskIds 必须是数组")?),
                        ],
                    )?,
                );
            }
            let run = || {
                let ids = call(p, c"replace", &[body.get(c"taskIds")?])?;
                call(
                    a[1],
                    c"json",
                    &[fields(p, &[("ok", flag(p, true)?), ("taskIds", ids)])?],
                )?;
                undef(p)
            };
            run().or_else(|e| fail(p, a[1], e, false, false))
        })?;
        call(target, c"post", &[route, replace])?;
    }
    let toggle_route = if ignore {
        route
    } else {
        call(string(route)?, c"concat", &[text(p, "/toggle")?])?
    };
    let toggle = function(p, "toggleRoute", 2, 2, move |p, a| {
        let run = || {
            let body = a[0].get(c"body")?;
            let body = if body.truthy()? {
                body
            } else {
                fields(p, &[])?
            };
            let result = call(p, c"toggle", &[body.get(c"taskId")?])?;
            let response = fields(p, &[("ok", flag(p, true)?)])?;
            if ignore {
                response.spread_from(result)?;
            } else {
                response.set(c"taskIds", result)?;
            }
            call(a[1], c"json", &[response])?;
            undef(p)
        };
        run().or_else(|e| fail(p, a[1], e, true, ignore))
    })?;
    call(target, c"post", &[toggle_route, toggle])?;
    undef(p)
}
