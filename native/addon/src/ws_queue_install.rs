//! Each bound callback keeps the original transport and its connection's ports
//! alive. No callback can enter the patched send recursively.
use crate::{host_methods::function, route_response::*};
use napi_derive::napi;
fn transport_call<'a>(p: L<'a>, name: &std::ffi::CStr, args: &[L<'a>]) -> Result<L<'a>> {
    let mut params = vec![p.get(c"id")?];
    params.extend_from_slice(args);
    params.push(p.get(c"ports")?);
    let host = p.get(c"host")?;
    let site = format!("host.{}", name.to_string_lossy());
    crate::js_live::invoke(host, crate::js_iteration::read(host, name)?, &params, &site)
}
#[napi]
pub fn install_ws_queue(
    env: Env,
    ws: Unknown<'_>,
    host: Unknown<'_>,
    id: Unknown<'_>,
    ports: Unknown<'_>,
    registry: Unknown<'_>,
    assign: Unknown<'_>,
) -> Result<sys::napi_value> {
    let ws = L::new(&env, ws);
    let host = L::new(&env, host);
    let id = L::new(&env, id);
    if ws.get(c"_multiccBackpressure")?.truthy()? {
        return Ok(ws.get(c"_multiccBackpressure")?.raw());
    }
    let send = call(ws.get(c"send")?, c"bind", &[ws])?;
    let ports = call(
        ws.global()?.get(c"Object")?,
        c"create",
        &[L::new(&env, ports)],
    )?;
    let ctx = fields(
        ws,
        &[("host", host), ("id", id), ("ports", ports), ("send", send)],
    )?;
    let assign = L::new(&env, assign);
    let set = |target, key, value| assign.call_plain(&[target, text(ws, key)?, value]);
    set(
        ports,
        "sendFrame",
        function(ctx, "", 3, 3, |p, a| {
            let cb = function(p, "", 1, 1, |p, a| {
                p.catch(|| {
                    let err = if a[0].truthy()? {
                        let msg = a[0].get(c"message")?;
                        string(if msg.truthy()? { msg } else { a[0] })?
                    } else {
                        null(p)?
                    };
                    transport_call(p, c"sendResult", &[err])
                })?;
                p.from_value(&V::Undefined)
            })?;
            p.get(c"send")?.call_plain(&[a[1], a[2], cb])
        })?,
    )?;
    let immediate = function(ctx, "sendImmediate", 3, 3, |p, a| {
        p.catch(|| transport_call(p, c"sendImmediate", a))?;
        p.from_value(&V::Undefined)
    })?;
    let stats = function(ctx, "stats", 0, 0, |p, _| {
        if let Some(v) = p.catch(|| call(p.get(c"host")?, c"stats", &[p.get(c"id")?]))? {
            if v.truthy()? {
                return Ok(v);
            }
        }
        fields(
            p,
            &[
                ("queueBytes", num(p, 0.)?),
                ("queueMessages", num(p, 0.)?),
                ("sending", flag(p, false)?),
                ("congested", flag(p, false)?),
                ("closed", flag(p, true)?),
            ],
        )
    })?;
    let flush = function(ctx, "flush", 0, 0, |p, _| {
        p.catch(|| transport_call(p, c"flush", &[]))?;
        p.from_value(&V::Undefined)
    })?;
    let api = fields(
        ws,
        &[
            ("sendImmediate", immediate),
            ("stats", stats),
            ("flush", flush),
        ],
    )?;
    set(
        ws,
        "send",
        function(ctx, "", 3, 3, |p, a| {
            if let Err(error) = transport_call(p, c"send", a) {
                let cause = p.exception_value()?.ok_or(error)?;
                let cb = if a[1].kind()? == sys::ValueType::napi_function {
                    a[1]
                } else {
                    a[2]
                };
                if cb.kind()? == sys::ValueType::napi_function {
                    p.catch(|| cb.call_plain(&[cause]))?;
                }
            }
            p.from_value(&V::Undefined)
        })?,
    )?;
    set(ws, "_multiccBackpressure", api)?;
    let registry = L::new(&env, registry);
    if registry.truthy()? {
        call(registry, c"set", &[id, ports])?;
    }
    Ok(api.raw())
}
