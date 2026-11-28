//! Both live Maps and the replay hub must observe the very same native tables.
//! The closures retain V8-visible handles so detached methods and cycles work.
use crate::{host_methods::function, route_response::*};
use napi_derive::napi;
#[napi]
pub fn record_owner_facade(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    p.set(c"directoriesFile", null(p)?)?;
    p.set(c"sessionsFile", null(p)?)?;
    let out = fields(
        p,
        &[("native", p.get(c"native")?), ("anchor", p.get(c"anchor")?)],
    )?;
    out.set(
        c"configure",
        function(p, "configure", 1, 1, |p, a| {
            for key in [c"directoriesFile", c"sessionsFile"] {
                if a[0].optional(key)?.kind()? == sys::ValueType::napi_string {
                    p.set(key, a[0].get(key)?)?;
                }
            }
            call(p.get(c"native")?, c"configure", a)
        })?,
    )?;
    for (name, count) in [
        (c"commitCrossFileWrite", 1),
        (c"replayJournals", 0),
        (c"initDirectories", 1),
        (c"saveDirectories", 0),
    ] {
        let label = name.to_str().unwrap();
        out.set(
            name,
            function(p, label, count, count, move |p, a| {
                call(p.get(c"native")?, name, a)
            })?,
        )?;
    }
    for (name, key) in [
        (c"loadDirectories", c"directoriesFile"),
        (c"loadSessions", c"sessionsFile"),
    ] {
        out.set(
            name,
            function(p, name.to_str().unwrap(), 0, 0, move |p, _| {
                let result = call(p.get(c"native")?, name, &[])?;
                if result.get(c"errorKind")?.truthy()? {
                    return Err(p
                        .get(c"error")?
                        .call_plain(&[p.get(key)?, result])?
                        .throw_error());
                }
                Ok(result)
            })?,
        )?;
    }
    Ok(out.raw())
}
fn hub(host: L<'_>) -> Result<L<'_>> {
    if !host.truthy()?
        || host.get(c"replayPushEvent")?.kind()? != sys::ValueType::napi_function
        || host.get(c"fanOutEvent")?.kind()? != sys::ValueType::napi_function
    {
        return Err(host.type_error(
            "[chat-replay-hub] a native RustWsHost with chat session support is required",
        ));
    }
    let out = fields(host, &[])?;
    for (key, method) in [
        (c"push", c"replayPushEvent"),
        (c"clear", c"replayClear"),
        (c"size", c"replayLen"),
        (c"events", c"replayEvents"),
        (c"burst", c"replayBurst"),
        (c"join", c"clientJoin"),
        (c"leave", c"clientLeave"),
        (c"clearClients", c"clientClear"),
        (c"clientCount", c"clientCount"),
    ] {
        out.set(key, call(host.get(method)?, c"bind", &[host])?)?;
    }
    out.set(
        c"clientsOf",
        function(host, "clientsOf", 1, 1, |h, a| {
            let view = fields(h, &[])?;
            let pair = fields(h, &[("host", h), ("id", a[0])])?;
            let get = function(pair, "get size", 0, 0, |p, _| {
                call(p.get(c"host")?, c"clientCount", &[p.get(c"id")?])
            })?;
            call(
                h.global()?.get(c"Object")?,
                c"defineProperty",
                &[
                    view,
                    text(h, "size")?,
                    fields(h, &[("get", get), ("enumerable", flag(h, true)?)])?,
                ],
            )?;
            view.freeze()
        })?,
    )?;
    for (key, method) in [
        (c"broadcast", c"fanOutEvent"),
        (c"drop", c"sessionDrop"),
        (c"reset", c"sessionReset"),
    ] {
        out.set(key, call(host.get(method)?, c"bind", &[host])?)?;
    }
    out.freeze()
}
#[napi]
pub fn replay_hub(env: Env, host: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(hub(L::new(&env, host))?.raw())
}
#[napi]
pub fn chat_replay_runtime(
    env: Env,
    host: Unknown<'_>,
    sessions: Unknown<'_>,
) -> Result<sys::napi_value> {
    let host = L::new(&env, host);
    let replay = hub(host)?;
    call(
        L::new(&env, sessions),
        c"onForget",
        &[replay.get(c"reset")?],
    )?;
    Ok(fields(host, &[("wsHost", host), ("chatReplay", replay)])?.raw())
}
