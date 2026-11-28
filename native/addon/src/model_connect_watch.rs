//! Per-request timer lifetime across HTTP/1, HTTP/2 and early downstream close.
use crate::{host_methods::function, route_response::*};
use napi_derive::napi;

fn end<'a>(p: L<'a>, request: L<'a>) -> Result<L<'a>> {
    let pending = p.get(c"pending")?;
    let watch = call(pending, c"get", &[request])?;
    if watch.truthy()? {
        watch.set(c"active", flag(p, false)?)?;
        call(watch.get(c"timer")?, c"cancel", &[])?;
        for event in ["close", "finish"] {
            call(
                watch.get(c"response")?,
                c"removeListener",
                &[text(p, event)?, watch.get(c"done")?],
            )?;
        }
        call(pending, c"delete", &[request])?;
    }
    p.from_value(&V::Undefined)
}
#[napi]
pub fn model_connect_timers(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    p.set(c"pending", p.global()?.get(c"WeakMap")?.construct(&[])?)?;
    Ok(fields(
        p,
        &[
            ("end", function(p, "end", 1, 1, |p, a| end(p, a[0]))?),
            (
                "begin",
                function(p, "begin", 2, 2, |p, a| {
                    let (request, ctx) = (a[0], a[1]);
                    let ms = ctx
                        .optional(c"attempt")?
                        .optional(c"connectTimeoutMs")?
                        .explicit_number()?;
                    let stall = ctx.optional(c"stall")?;
                    if !request.truthy()?
                        || stall.nullish()?
                        || !call(stall, c"isArmed", &[])?.truthy()?
                        || !(ms > 0.)
                    {
                        return p.from_value(&V::Undefined);
                    }
                    end(p, request)?;
                    let res = ctx.get(c"response")?;
                    let w = fields(
                        p,
                        &[
                            ("ports", p),
                            ("request", request),
                            ("stall", stall),
                            ("response", res),
                            ("active", flag(p, true)?),
                        ],
                    )?;
                    let done = function(w, "connectionSettled", 0, 0, |w, _| {
                        end(w.get(c"ports")?, w.get(c"request")?)
                    })?;
                    let timeout = function(w, "connectionTimeout", 0, 0, |w, _| {
                        if w.get(c"active")?.truthy()? {
                            end(w.get(c"ports")?, w.get(c"request")?)?;
                            call(w.get(c"stall")?, c"connectTimeout", &[])?;
                        }
                        w.from_value(&V::Undefined)
                    })?;
                    w.set(c"done", done)?;
                    w.set(c"timer", call(p, c"schedule", &[timeout, num(p, ms)?])?)?;
                    for event in ["close", "finish"] {
                        call(res, c"once", &[text(p, event)?, done])?;
                    }
                    call(p.get(c"pending")?, c"set", &[request, w])?;
                    p.from_value(&V::Undefined)
                })?,
            ),
        ],
    )?
    .raw())
}
