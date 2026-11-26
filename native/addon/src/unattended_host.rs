//! Per-supervisor runtime. Persisted session records own durable state. Timers,
//! admissions and pending verdicts belong to this instance and are never serialized.
use crate::{
    host_methods::{async_result, default_object, function},
    route_response::*,
};
use napi_derive::napi;
use std::ffi::CStr;
mod effects;
mod evaluation;
mod kernel;
mod lifecycle;
mod startup;
mod timers;
mod turns;

fn undef(p: L<'_>) -> Result<L<'_>> {
    p.from_value(&V::Undefined)
}
fn arr(p: L<'_>) -> Result<L<'_>> {
    p.from_value(&V::Array(vec![]))
}
fn obj(p: L<'_>) -> Result<L<'_>> {
    fields(p, &[])
}
fn callable(v: L<'_>) -> Result<bool> {
    Ok(v.kind()? == sys::ValueType::napi_function)
}
fn js(v: L<'_>) -> Result<String> {
    Ok(string(v)?.coerce_string()?.to_string_lossy())
}
fn str_or(v: L<'_>, s: &str) -> Result<String> {
    js(fallback(v, V::from(s))?)
}
fn or<'a>(v: L<'a>, other: L<'a>) -> Result<L<'a>> {
    Ok(if v.truthy()? { v } else { other })
}
fn def<'a>(v: L<'a>, other: L<'a>) -> Result<L<'a>> {
    Ok(if v.undefined()? { other } else { v })
}
fn patch<'a>(base: L<'a>, items: &[(&str, L<'a>)]) -> Result<L<'a>> {
    call(
        base.global()?.get(c"Object")?,
        c"assign",
        &[obj(base)?, base, fields(base, items)?],
    )
}
fn port<'a>(p: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    p.get(key)?.call_plain(args)
}
fn rule<'a>(p: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    call(p.get(c"kernel")?, key, args)
}
fn now(p: L<'_>) -> Result<L<'_>> {
    port(p, c"now", &[])
}
fn store<'a>(p: L<'a>, name: &CStr, method: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    call(p.get(name)?, method, args)
}
fn state<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let v = port(p, c"getRecord", &[id])?.optional(c"unattended")?;
    if v.truthy()? && v.kind()? == sys::ValueType::napi_object {
        Ok(v)
    } else {
        null(p)
    }
}
fn active(v: L<'_>) -> Result<bool> {
    v.optional(c"status")?.is_string("active")
}
fn fail<'a>(p: L<'a>, code: &str, status: Option<u16>) -> Result<L<'a>> {
    let r = fields(p, &[("ok", flag(p, false)?), ("code", text(p, code)?)])?;
    if let Some(s) = status {
        r.set(c"status", num(p, s.into())?)?;
    }
    Ok(r)
}
fn success(s: L<'_>) -> Result<L<'_>> {
    fields(s, &[("ok", flag(s, true)?), ("unattended", s)])
}
fn tag(p: L<'_>) -> Result<L<'_>> {
    let cached = p.get(c"tag")?;
    if cached.truthy()? {
        return Ok(cached);
    }
    let v = p.catch(|| rule(p, c"tag", &[]))?.unwrap_or(undef(p)?);
    let v = string(fallback(v, V::from("[无人值守 Unattended]"))?)?;
    p.set(c"tag", v)?;
    Ok(v)
}
fn clean<'a>(p: L<'a>, v: L<'a>) -> Result<String> {
    let s = if v.nullish()? {
        text(p, "")?
    } else {
        string(v)?
    };
    let parts = call(s, c"split", &[tag(p)?])?;
    js(call(call(parts, c"join", &[text(p, " ")?])?, c"trim", &[])?)
}
fn tagged<'a>(p: L<'a>, s: &str) -> Result<L<'a>> {
    let v = clean(p, text(p, s)?)?;
    if v.is_empty() {
        tag(p)
    } else {
        text(p, &format!("{} {v}", js(tag(p)?)?))
    }
}
fn caught<'a>(p: L<'a>, e: napi::Error) -> Result<L<'a>> {
    if let Some(v) = p.exception_value()? {
        Ok(v)
    } else {
        p.global()?.get(c"Error")?.construct(&[text(p, &e.reason)?])
    }
}
fn log(p: L<'_>, msg: &str) -> Result<()> {
    port(p, c"log", &[text(p, &format!("[unattended] {msg}"))?])?;
    Ok(())
}
fn log_err(f: L<'_>, what: &str, e: L<'_>) -> Result<()> {
    let msg = js(or(e.optional(c"message")?, e)?)?;
    log(
        f.get(c"host")?,
        &format!("{what} for {}: {msg}", js(f.get(c"id")?)?),
    )
}
fn frame<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    fields(
        p,
        &[
            ("host", p),
            ("id", id),
            ("record", port(p, c"getRecord", &[id])?),
            ("generation", store(p, c"generations", c"get", &[id])?),
        ],
    )
}
fn current(f: L<'_>) -> Result<bool> {
    let p = f.get(c"host")?;
    let id = f.get(c"id")?;
    Ok(f.get(c"record")?.equals(port(p, c"getRecord", &[id])?)?
        && f.get(c"generation")?
            .equals(store(p, c"generations", c"get", &[id])?)?)
}
fn renew<'a>(p: L<'a>, id: L<'a>) -> Result<()> {
    store(p, c"generations", c"set", &[id, obj(p)?])?;
    Ok(())
}
type Step = for<'a> fn(L<'a>, L<'a>) -> Result<L<'a>>;
fn cont<'a>(f: L<'a>, step: Step) -> Result<L<'a>> {
    function(f, "", 1, 1, move |f, a| step(f, a[0]))
}
fn resolved(v: L<'_>) -> Result<L<'_>> {
    call(v.global()?.get(c"Promise")?, c"resolve", &[v])
}
fn then<'a>(f: L<'a>, pending: L<'a>, step: Step) -> Result<L<'a>> {
    call(resolved(pending)?, c"then", &[cont(f, step)?])
}
fn rescue<'a>(f: L<'a>, pending: L<'a>, step: Step) -> Result<L<'a>> {
    call(pending, c"catch", &[cont(f, step)?])
}
fn ignore<'a>(f: L<'a>, pending: L<'a>, action: &'static str) -> Result<()> {
    let handler = function(f, "", 1, 1, move |f, a| {
        log_err(f, action, a[0])?;
        undef(f)
    })?;
    call(resolved(pending)?, c"catch", &[handler])?;
    Ok(())
}
fn persist<'a>(p: L<'a>, id: L<'a>, next: L<'a>, new_generation: bool) -> Result<bool> {
    let record = port(p, c"getRecord", &[id])?;
    let previous = record.optional(c"unattended")?;
    let existed = record.truthy()? && record.has(c"unattended")?;
    if let Err(e) = port(p, c"persistState", &[id, next]) {
        let v = caught(p, e)?;
        let msg = js(or(v.optional(c"message")?, v)?)?;
        // The live record is assigned before the synchronous journal write.
        // Roll back only our assignment if the port threw after changing it.
        if record.truthy()? {
            let observed = record.get(c"unattended")?;
            if (observed.equals(next)? || (next.nullish()? && observed.undefined()?))
                && !observed.equals(previous)?
            {
                if existed {
                    record.assign(c"unattended", previous)?;
                } else {
                    record.delete(c"unattended")?;
                }
            }
        }
        log(p, &format!("persist failed for {}: {msg}", js(id)?))?;
        return Ok(false);
    }
    if new_generation {
        renew(p, id)?;
    }
    if !active(next)? {
        if next.truthy()? {
            effects::withdraw(p, id, None)?;
        }
        timers::clear(p, id, c"backlogRechecks")?;
    }
    timers::sync(p, id, next)?;
    p.catch(|| {
        port(
            p,
            c"broadcast",
            &[
                id,
                fields(
                    p,
                    &[("type", text(p, "unattended_state")?), ("unattended", next)],
                )?,
            ],
        )
    })?;
    Ok(true)
}
#[napi]
pub fn unattended_host_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    for name in ["getRecord", "persistState"] {
        if !callable(p.get_key(text(p, name)?)?)? {
            return Err(p.type_error(&format!("[unattended] {name} port required")));
        }
    }
    for (name, ctor) in [
        ("inFlight", c"Map"),
        ("queued", c"Set"),
        ("bootRecovered", c"Set"),
        ("heldPushes", c"Map"),
        ("pendingInjections", c"Map"),
        ("faultEpoch", c"Map"),
        ("generations", c"Map"),
        ("timers", c"Map"),
        ("retryTimers", c"Map"),
        ("admittingRetries", c"Set"),
        ("backlogRechecks", c"Map"),
    ] {
        p.set_key(text(p, name)?, p.global()?.get(ctor)?.construct(&[])?)?;
    }
    let api = obj(p)?;
    for (name, len, count) in [
        ("armFromRequest", 2, 3),
        ("clear", 1, 1),
        ("evaluate", 1, 2),
        ("get", 1, 1),
        ("handoffAccepted", 2, 2),
        ("noteUserMessage", 1, 1),
        ("onTurnEnd", 1, 2),
        ("reconcileStartup", 0, 0),
        ("rearmTimer", 1, 1),
        ("resume", 1, 2),
        ("shouldHoldPush", 1, 2),
        ("shutdown", 0, 0),
        ("start", 1, 2),
        ("stats", 0, 0),
        ("stop", 1, 1),
        ("tag", 0, 0),
        ("update", 1, 2),
    ] {
        let method = function(p, name, len, count, move |p, a| match name {
            "get" => state(p, a[0]),
            "tag" => tag(p),
            "stats" => {
                let r = obj(p)?;
                for k in [
                    c"inFlight",
                    c"queued",
                    c"heldPushes",
                    c"timers",
                    c"retryTimers",
                    c"backlogRechecks",
                ] {
                    r.set(k, p.get(k)?.get(c"size")?)?;
                }
                Ok(r)
            }
            "armFromRequest" => lifecycle::arm(p, a[0], a[1], default_object(a[2])?),
            "start" | "resume" => async_result(p, || {
                lifecycle::start_resume(p, a[0], default_object(a[1])?, name == "resume")
            }),
            "update" => lifecycle::update(p, a[0], default_object(a[1])?),
            "stop" => lifecycle::stop(p, a[0]),
            "clear" => lifecycle::clear(p, a[0]),
            "shutdown" => timers::shutdown(p),
            "rearmTimer" => {
                timers::sync(p, a[0], state(p, a[0])?)?;
                undef(p)
            }
            "evaluate" => evaluation::evaluate(p, a[0], default_object(a[1])?),
            "shouldHoldPush" => evaluation::should_hold(p, a[0], default_object(a[1])?),
            "noteUserMessage" | "handoffAccepted" => {
                turns::input(p, a[0], a.get(1).copied(), name == "handoffAccepted")
            }
            "onTurnEnd" => async_result(p, || turns::end(p, a[0], default_object(a[1])?)),
            _ => async_result(p, || startup::reconcile(p)),
        })?;
        api.set_key(text(p, name)?, method)?;
    }
    Ok(api.freeze()?.raw())
}
