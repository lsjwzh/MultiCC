//! Each configuration has an independent FIFO and generation of the SQLite snapshot.
//! The first synchronous projection after an external write starts an asynchronous read.
use crate::{
    host_methods::{async_result, function},
    route_response::*,
};
use napi_derive::napi;
use std::{fs, time::UNIX_EPOCH};

fn stamp(state: L<'_>) -> Result<L<'_>> {
    let file = state.get(c"file")?;
    if !file.truthy()? {
        return null(state);
    }
    let path = file.coerce_string()?.to_string_lossy();
    let parts = ["", "-wal", "-shm"].map(|suffix| {
        fs::metadata(format!("{path}{suffix}"))
            .ok()
            .and_then(|m| {
                Some(format!(
                    "{}:{}",
                    m.modified()
                        .ok()?
                        .duration_since(UNIX_EPOCH)
                        .ok()?
                        .as_nanos(),
                    m.len()
                ))
            })
            .unwrap_or_else(|| "-".into())
    });
    text(state, &parts.join("|"))
}
fn resolved(p: L<'_>) -> Result<L<'_>> {
    call(p.global()?.get(c"Promise")?, c"resolve", &[])
}
fn init<'a>(p: L<'a>, file: L<'a>) -> Result<L<'a>> {
    fields(
        p,
        &[
            ("file", file),
            ("ports", p.get(c"ports")?),
            ("queue", resolved(p)?),
            ("entries", fields(p, &[])?),
            ("stamp", null(p)?),
        ],
    )
}
fn enqueue<'a>(s: L<'a>, work: L<'a>) -> Result<L<'a>> {
    let run = call(s.get(c"queue")?, c"then", &[work])?;
    let tail = call(
        run,
        c"catch",
        &[function(s, "releaseQueue", 0, 0, |s, _| {
            s.from_value(&V::Undefined)
        })?],
    )?;
    s.set(c"queue", tail)?;
    Ok(run)
}
fn access<'a>(s: L<'a>, input: L<'a>) -> Result<L<'a>> {
    if !s.get(c"file")?.truthy()? {
        return resolved(s);
    }
    let fingerprint = if input.get(c"operation")?.is_string("read")? {
        stamp(s)?
    } else {
        null(s)?
    };
    let update = fields(s, &[("state", s), ("fingerprint", fingerprint)])?;
    let rows = call(s.get(c"ports")?, c"access", &[s.get(c"file")?, input])?;
    call(
        rows,
        c"then",
        &[function(update, "installSnapshot", 1, 1, |u, a| {
            let state = u.get(c"state")?;
            state.set(c"entries", a[0])?;
            state.set(c"stamp", u.get(c"fingerprint")?)?;
            u.from_value(&V::Undefined)
        })?],
    )
}
fn read(s: L<'_>) -> Result<L<'_>> {
    access(s, fields(s, &[("operation", text(s, "read")?)])?)
}
fn ready(s: L<'_>) -> Result<L<'_>> {
    let open = s.get(c"loaded")?;
    if open.truthy()? {
        return Ok(open);
    }
    let run = enqueue(s, function(s, "initialRead", 0, 0, |s, _| read(s))?)?;
    let loaded = call(
        run,
        c"catch",
        &[function(s, "retryInitialRead", 1, 1, |s, a| {
            s.set(c"loaded", null(s)?)?;
            Err(a[0].throw_error())
        })?],
    )?;
    s.set(c"loaded", loaded)?;
    Ok(loaded)
}
#[napi]
pub fn account_cache_host(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let ports = L::new(&env, ports);
    let p = fields(
        ports,
        &[
            ("ports", ports),
            ("readers", ports.global()?.get(c"Map")?.construct(&[])?),
        ],
    )?;
    p.set(c"state", init(p, null(p)?)?)?;
    Ok(fields(
        p,
        &[
            (
                "configure",
                function(p, "configure", 0, 1, |p, a| {
                    p.set(c"state", init(p, a[0].optional(c"file")?)?)?;
                    p.from_value(&V::Undefined)
                })?,
            ),
            (
                "snapshot",
                function(p, "snapshot", 0, 0, |p, _| p.get(c"state")?.get(c"entries"))?,
            ),
            (
                "ready",
                function(p, "ready", 0, 0, |p, _| ready(p.get(c"state")?))?,
            ),
            (
                "record",
                function(p, "record", 4, 4, |p, a| {
                    let state = p.get(c"state")?;
                    let initial = ready(state)?;
                    let input = fields(
                        p,
                        &[
                            ("operation", text(p, "record")?),
                            ("vendor", a[0]),
                            ("accountId", a[1]),
                            ("result", a[2]),
                            ("attemptAt", a[3]),
                        ],
                    )?;
                    let job = fields(
                        p,
                        &[("initial", initial), ("input", input), ("state", state)],
                    )?;
                    enqueue(
                        state,
                        function(job, "recordWhenReady", 0, 0, |j, _| {
                            call(
                                j.get(c"initial")?,
                                c"then",
                                &[function(j, "write", 0, 0, |j, _| {
                                    access(j.get(c"state")?, j.get(c"input")?)
                                })?],
                            )
                        })?,
                    )
                })?,
            ),
            (
                "project",
                function(p, "project", 1, 1, |p, a| {
                    let s = p.get(c"state")?;
                    if s.get(c"file")?.truthy()?
                        && !s.get(c"reload")?.truthy()?
                        && !stamp(s)?.equals(s.get(c"stamp")?)?
                    {
                        let work = enqueue(
                            s,
                            function(s, "reload", 0, 0, |s, _| async_result(s, || read(s)))?,
                        )?;
                        let clear = function(s, "clearReload", 0, 0, |s, _| {
                            s.set(c"reload", null(s)?)?;
                            s.from_value(&V::Undefined)
                        })?;
                        s.set(c"reload", call(work, c"then", &[clear, clear])?)?;
                    }
                    call(p.get(c"ports")?, c"project", &[a[0], s.get(c"entries")?])
                })?,
            ),
            (
                "register",
                function(p, "register", 2, 2, |p, a| {
                    call(p.get(c"readers")?, c"set", a)?;
                    p.from_value(&V::Undefined)
                })?,
            ),
            (
                "refresh",
                function(p, "refresh", 1, 1, |p, a| {
                    let reader = call(p.get(c"readers")?, c"get", &[a[0].get(c"appType")?])?;
                    if reader.nullish()? {
                        return p.from_value(&V::Undefined);
                    }
                    reader.call_plain(&[fallback(a[0].get(c"officialAccountId")?, "".into())?])
                })?,
            ),
        ],
    )?
    .raw())
}
