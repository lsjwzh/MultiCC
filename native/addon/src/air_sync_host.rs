//! Per-isolate Air projection producer, serial commit/replay barrier and socket lifetime.
use crate::host_api::*;
use crate::host_methods::{env, raw, variadic_method};
use napi_derive::napi;
use std::ffi::CStr;

mod clients;
mod producer;
mod reads;

fn clock(s: L<'_>) -> Result<f64> {
    call(s.global()?.get(c"Date")?, c"now", &[])?.explicit_number()
}
fn stopped(s: L<'_>) -> Result<bool> {
    s.get(c"stopped")?.truthy()
}
fn noop<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    undef(p)
}
fn issue<'a>(s: L<'a>, code: &str) -> Result<L<'a>> {
    let e = error_value(s, "首页摘要暂不可用，请稍后重试")?;
    e.set(c"code", text(s, code)?)?;
    e.set(c"status", num(s, 503.)?)?;
    Ok(e)
}
fn reject<'a>(s: L<'a>, code: &str) -> Result<L<'a>> {
    call(s.global()?.get(c"Promise")?, c"reject", &[issue(s, code)?])
}
fn list<'a>(s: L<'a>, v: L<'a>) -> Result<L<'a>> {
    call(s.global()?.get(c"Array")?, c"from", &[v])
}
fn as_number<'a>(s: L<'a>, key: &CStr) -> Result<f64> {
    s.get(key)?.number()
}
fn current_issue(s: L<'_>) -> Result<L<'_>> {
    let stored = s.get(c"storageNotice")?.call_plain(&[])?;
    if stored.truthy()? {
        Ok(stored)
    } else {
        s.get(c"lastError")
    }
}
fn status(s: L<'_>) -> Result<L<'_>> {
    let problem = current_issue(s)?;
    let out = fields(s, &[("degraded", flag(s, problem.truthy()?)?)])?;
    if problem.truthy()? {
        out.set(c"issue", problem)?;
    }
    Ok(out)
}
fn serial<'a>(s: L<'a>, frame: L<'a>, action: Action, internal: bool) -> Result<L<'a>> {
    if stopped(s)? {
        return reject(s, "air_closed");
    }
    let n = as_number(s, c"pending")?;
    if !internal && n >= as_number(s, c"maxPending")? {
        return reject(s, "air_busy");
    }
    s.set(c"pending", num(s, n + 1.)?)?;
    let start = function(frame, "", 0, 0, move |frame, a| {
        if stopped(frame.get(c"s")?)? {
            return Err(issue(frame, "air_closed")?.throw_error());
        }
        action(frame, a)
    })?;
    let result = call(s.get(c"tail")?, c"then", &[start])?;
    let done = function(s, "", 0, 0, |s, _| {
        s.set(c"pending", num(s, as_number(s, c"pending")? - 1.)?)?;
        undef(s)
    })?;
    let settled = call(result, c"finally", &[done])?;
    let swallow = function(s, "", 0, 0, noop)?;
    s.set(c"tail", call(settled, c"then", &[swallow, swallow])?)?;
    Ok(settled)
}
fn invalidate<'a>(s: L<'a>, ids: L<'a>) -> Result<L<'a>> {
    if stopped(s)? {
        return undef(s);
    }
    if !ids.truthy()? {
        s.set(c"full", flag(s, true)?)?;
    } else if !ids.get(c"length")?.truthy()? {
        s.set(c"metaDirty", flag(s, true)?)?;
        s.set(
            c"metadataVersion",
            num(s, as_number(s, c"metadataVersion")? + 1.)?,
        )?;
    } else {
        let dirty = s.get(c"dirty")?;
        ids.for_each(|id| {
            call(dirty, c"add", &[id])?;
            Ok(())
        })?;
    }
    producer::schedule(s, s.get(c"debounceMs")?.explicit_number()?)?;
    undef(s)
}
fn observed<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let event = a[1];
    let kind = event.optional(c"type")?;
    for name in [
        "task_board_update",
        "task_state",
        "status",
        "summary",
        "session_queue_status",
        "session_configuration_applied",
        "session_created",
        "session_deleted",
        "session_renamed",
        "merge_state",
        "workspace_state",
    ] {
        if kind.is_string(name)? {
            let mut ids = event.get(c"taskIds")?;
            if !ids.truthy()? {
                let id = event.get(c"sessionId")?;
                ids = if id.truthy()? {
                    s.get(c"taskIdsForSession")?.call_plain(&[id])?
                } else {
                    null(s)?
                };
            }
            return invalidate(s, ids);
        }
    }
    undef(s)
}
fn close<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let prior = s.get(c"closePromise")?;
    if prior.truthy()? {
        return Ok(prior);
    }
    s.set(c"stopped", flag(s, true)?)?;
    producer::clear(s, s.get(c"timer")?)?;
    let unsub = s.get(c"unsubscribe")?;
    if !unsub.nullish()? {
        unsub.call_plain(&[])?;
    }
    let clients = s.get(c"clients")?;
    let attaching = s.get(c"attaching")?;
    let all = s
        .global()?
        .get(c"Set")?
        .construct(&[call(clients, c"keys", &[])?])?;
    attaching.for_each(|socket| {
        call(all, c"add", &[socket])?;
        Ok(())
    })?;
    all.for_each(|socket| {
        s.catch(|| {
            let closer = socket.get(c"close")?;
            if closer.nullish()? {
                undef(s)
            } else {
                closer.call(socket, &[num(s, 1001.)?, text(s, "服务关闭")?])
            }
        })?;
        Ok(())
    })?;
    call(clients, c"clear", &[])?;
    call(attaching, c"clear", &[])?;
    let result = then(s.get(c"inFlight")?, s, |s, _| s.get(c"tail"))?;
    let result = then(result, s, |s, _| {
        let index = s.get(c"index")?;
        let close = index.get(c"close")?;
        if close.nullish()? {
            undef(s)
        } else {
            close.call(index, &[])
        }
    })?;
    let result = then(result, s, noop)?;
    s.set(c"closePromise", result)?;
    Ok(result)
}
fn create<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let o = a[0];
    let build = o.get(c"build")?;
    let subscribe = o.get(c"subscribe")?;
    let ids = with_default(
        o.get(c"taskIdsForSession")?,
        function(ports, "taskIdsForSession", 0, 0, |s, _| array(s))?,
    )?;
    let send_frame = o.get(c"send")?;
    let logger = with_default(o.get(c"logger")?, o.global()?.get(c"console")?)?;
    let reconcile_ms = with_default(o.get(c"reconcileMs")?, num(o, 30000.)?)?;
    let debounce_ms = with_default(o.get(c"debounceMs")?, num(o, 100.)?)?;
    let mut index = o.get(c"index")?;
    if index.undefined()? {
        index = ports.get(c"createIndex")?.call_plain(&[])?;
    }
    let limit = with_default(o.get(c"maxPending")?, num(o, 64.)?)?;
    let retry_base = with_default(o.get(c"retryBaseMs")?, num(o, 5000.)?)?;
    let retry_max = with_default(o.get(c"retryMaxMs")?, num(o, 60000.)?)?;
    let storage = with_default(
        o.get(c"storageNotice")?,
        function(ports, "storageNotice", 0, 0, |s, _| null(s))?,
    )?;
    let Some(limit) = limit
        .number_value()?
        .filter(|n| n.fract() == 0. && (1.0..=256.0).contains(n))
    else {
        return Err(error_value(o, "invalid_air_queue_limit")?.throw_error());
    };
    let s = fields(
        ports,
        &[
            ("ports", ports),
            ("build", build),
            ("send", send_frame),
            ("taskIdsForSession", ids),
            ("logger", logger),
            ("index", index),
            ("storageNotice", storage),
            ("reconcileMs", reconcile_ms),
            ("debounceMs", debounce_ms),
            ("retryBaseMs", retry_base),
            ("retryMaxMs", retry_max),
            ("maxPending", num(o, limit)?),
            ("tail", resolved(undef(o)?)?),
            ("dueAt", num(o, f64::INFINITY)?),
            ("full", flag(o, true)?),
            ("lastError", null(o)?),
            ("publishedIssueCode", null(o)?),
        ],
    )?;
    for key in [
        c"checkedAt",
        c"metadataVersion",
        c"publishedMetadataVersion",
        c"retryAt",
        c"failures",
        c"pending",
    ] {
        s.set(key, num(s, 0.)?)?;
    }
    for (key, kind) in [
        (c"clients", c"Map"),
        (c"attaching", c"Set"),
        (c"dirty", c"Set"),
    ] {
        s.set(key, s.global()?.get(kind)?.construct(&[])?)?;
    }
    if !subscribe.nullish()? {
        s.set(
            c"unsubscribe",
            subscribe.call_plain(&[function(s, "", 2, 2, observed)?])?,
        )?;
    }
    producer::schedule(s, 0.)?;
    let api = fields(s, &[("index", index)])?;
    api.spread_from(defaulted_methods(
        s,
        &[
            ("ensureReady", 0, 0, reads::ensure_ready),
            ("invalidate", 1, 1, |s, a| invalidate(s, a[0])),
            ("attach", 2, 2, clients::attach),
            ("syncHttp", 0, 1, reads::sync_http),
            ("pageHttp", 0, 1, reads::page_http),
            ("flush", 0, 0, |s, _| producer::flush(s)),
            ("publishStatus", 0, 0, |s, _| clients::publish_status(s)),
            ("serialized", 0, 0, |s, _| {
                reads::query(s, &mut [text(s, "serialized")?])
            }),
            ("close", 0, 0, close),
        ],
    )?)?;
    let e = env(s);
    api.set(
        c"query",
        raw(s, variadic_method(&e, s, "query", 1, reads::query)?.raw()),
    )?;
    Ok(api)
}
#[napi]
pub fn air_sync_host_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    Ok(methods(p, &[("createAirSyncRuntime", 1, create)])?.raw())
}
