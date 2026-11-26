//! Cancellation joins concurrent callers per session. Each operation retains the original
//! runner and turn across await points, so settlement cannot clear a replacement.
use super::*;
use crate::host_methods::{arg, env, raw};
use std::ffi::CStr;

mod dispatch;
mod runners;
type Step = for<'a> fn(L<'a>, L<'a>) -> Result<L<'a>>;

fn empty(v: L<'_>) -> Result<L<'_>> {
    v.from_value(&V::Undefined)
}
fn h(f: L<'_>) -> Result<L<'_>> {
    f.get(c"host")
}
fn id(f: L<'_>) -> Result<L<'_>> {
    f.get(c"sessionId")
}
fn deps(f: L<'_>) -> Result<L<'_>> {
    h(f)?.get(c"deps")
}
fn d<'a>(f: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    call(deps(f)?, key, args)
}
fn chat(f: L<'_>) -> Result<L<'_>> {
    d(f, c"getChatSession", &[id(f)?])
}
fn task_state(f: L<'_>) -> Result<L<'_>> {
    let record = d(f, c"getRecord", &[id(f)?])?;
    fallback(d(f, c"getTaskState", &[record])?, V::Object(vec![]))
}
fn now(v: L<'_>) -> Result<L<'_>> {
    call(v.global()?.get(c"Date")?, c"now", &[])
}
fn opt<'a>(o: L<'a>, k: &CStr, default: L<'a>) -> Result<L<'a>> {
    let v = o.get(k)?;
    Ok(if v.undefined()? { default } else { v })
}
fn normalize(v: L<'_>) -> Result<L<'_>> {
    fallback(v, V::Null)
}
fn interpolate<'a>(anchor: L<'a>, prefix: &str, parts: &[(L<'a>, &str)]) -> Result<L<'a>> {
    let mut output = multicc_core::js::JsString::from_rust_str(prefix);
    for (value, suffix) in parts {
        output.push(&value.coerce_string()?);
        output.push_str(suffix);
    }
    anchor.from_value(&V::String(output))
}
fn callable(v: L<'_>) -> Result<bool> {
    Ok(v.kind()? == sys::ValueType::napi_function)
}
fn has_dep(f: L<'_>, key: &CStr) -> Result<bool> {
    callable(deps(f)?.get(key)?)
}
fn log<'a>(f: L<'a>, method: &CStr, args: &[L<'a>]) -> Result<()> {
    let l = h(f)?.get(c"log")?;
    let fun = l.get(method)?;
    if !fun.nullish()? {
        fun.call(l, args)?;
    }
    Ok(())
}
fn warn<'a>(f: L<'a>, msg: &str, extra: &[(&str, L<'a>)]) -> Result<()> {
    let fields_obj = fields(f, &[("sessionId", id(f)?)])?;
    fields_obj.spread_from(fields(f, extra)?)?;
    log(f, c"warn", &[text(f, msg)?, fields_obj])
}
fn warn_error<'a>(f: L<'a>, msg: &str, result: Result<L<'a>>) -> Result<()> {
    if let Err(err) = result {
        let reason = match f.exception_value()? {
            Some(v) => v.get(c"message")?,
            None => text(f, &err.reason)?,
        };
        warn(f, msg, &[("error", reason)])?;
    }
    Ok(())
}
fn response<'a>(f: L<'a>, code: &str) -> Result<L<'a>> {
    fields(f, &[("ok", flag(f, false)?), ("code", text(f, code)?)])
}
fn ignore<'a>(f: L<'a>, _: L<'a>) -> Result<L<'a>> {
    empty(f)
}
fn schedule_step<'a>(f: L<'a>, v: L<'a>, success: Step, failure: Option<Step>) -> Result<L<'a>> {
    let promise = call(f.global()?.get(c"Promise")?, c"resolve", &[v])?;
    let ok = callback(f, "", 1, 1, move |f, a| success(f, a[0]))?;
    if let Some(fail) = failure {
        let rejected = callback(f, "", 1, 1, move |f, a| fail(f, a[0]))?;
        call(promise, c"then", &[ok, rejected])
    } else {
        call(promise, c"then", &[ok])
    }
}
fn rejected_catch<'a>(f: L<'a>, p: L<'a>, fail: Step) -> Result<L<'a>> {
    call(
        p,
        c"catch",
        &[callback(f, "", 1, 1, move |f, a| fail(f, a[0]))?],
    )
}

fn repeat_finish<'a>(f: L<'a>, _: L<'a>) -> Result<L<'a>> {
    let task = f.get(c"taskId")?;
    if task.truthy()? && has_dep(f, c"reconcileTaskProjection")? {
        let options = fields(
            f,
            &[
                ("classifyState", text(f, "E")?),
                ("reason", text(f, "cancel_repeat")?),
            ],
        )?;
        f.catch(|| d(f, c"reconcileTaskProjection", &[task, options]))?;
    }
    fields(
        f,
        &[
            ("ok", flag(f, true)?),
            ("alreadyCancelled", flag(f, true)?),
            ("classifyState", text(f, "E")?),
            ("operationId", f.get(c"operationId")?),
        ],
    )
}
fn repeat_log<'a>(f: L<'a>, err: L<'a>) -> Result<L<'a>> {
    warn(
        f,
        "session_cancel_repeat_close_failed",
        &[("error", err.get(c"message")?)],
    )?;
    empty(f)
}
fn wait_transition(f: L<'_>) -> Result<L<'_>> {
    call(h(f)?.get(c"pendingTransitions")?, c"get", &[id(f)?])
}
fn repeat_drain<'a>(f: L<'a>, _: L<'a>) -> Result<L<'a>> {
    let p = async_result(f, || wait_transition(f))?;
    rejected_catch(f, p, ignore)
}
fn repeat_close<'a>(f: L<'a>, current: L<'a>) -> Result<L<'a>> {
    let active = current.optional(c"active")?;
    if !active.truthy()? {
        return empty(f);
    }
    let cancel = fields(
        f,
        &[
            ("source", text(f, "cancel_repeat")?),
            ("reason", text(f, "cancel_repeat")?),
            (
                "supersededByEntryId",
                normalize(active.optional(c"supersededByEntryId")?)?,
            ),
        ],
    )?;
    let result = fields(f, &[("state", text(f, "E")?), ("cancel", cancel)])?;
    let opts = fields(
        f,
        &[
            ("recoverMissingBoundary", flag(f, true)?),
            ("livenessReason", text(f, "cancel_repeat_boundary")?),
        ],
    )?;
    let p = super::transitions::classify_transition(
        h(f)?,
        id(f)?,
        normalize(active.optional(c"taskId")?)?,
        result,
        opts,
    )?;
    schedule_step(f, p, repeat_drain, None)
}
fn clear_entry<'a>(f: L<'a>, _: L<'a>) -> Result<L<'a>> {
    let m = h(f)?.get(c"cancelOperations")?;
    let entry = call(m, c"get", &[id(f)?])?;
    if entry.equals(f)? {
        call(m, c"delete", &[id(f)?])?;
    }
    empty(f)
}
fn duplicate<'a>(f: L<'a>, v: L<'a>) -> Result<L<'a>> {
    let out = crate::js_live::spread(v)?;
    out.set(c"deduplicated", flag(f, true)?)?;
    Ok(out)
}
fn cancel<'a>(s: L<'a>, session: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let o = crate::host_methods::default_object(opts)?;
    let reason = opt(o, c"reason", text(s, "user_cancelled")?)?;
    let kill = opt(o, c"killReason", text(s, "user_cancel")?)?;
    let source = opt(o, c"source", text(s, "manual_cancel")?)?;
    let op = opt(o, c"operationId", null(s)?)?;
    let f = fields(
        s,
        &[
            ("host", s),
            ("sessionId", session),
            ("reason", reason),
            ("killReason", kill),
            ("source", source),
            ("operationId", op),
        ],
    )?;
    if o.get(c"providerError")?.truthy()? {
        let stopped = runners::provider_stop(f)?;
        if stopped.get(c"ok")?.truthy()? {
            let out = fields(
                f,
                &[
                    ("ok", flag(f, true)?),
                    ("providerErrorStop", flag(f, true)?),
                ],
            )?;
            out.spread_from(stopped)?;
            return Ok(out);
        }
    }
    if !d(f, c"getRecord", &[session])?.truthy()? {
        return response(f, "session_not_found");
    }
    let m = s.get(c"cancelOperations")?;
    let in_flight = call(m, c"get", &[session])?;
    if in_flight.truthy()? {
        return schedule_step(f, in_flight.get(c"promise")?, duplicate, None);
    }
    let ts = task_state(f)?;
    if ts.get(c"classifyState")?.is_string("E")?
        && ts.get(c"cancelledAt")?.truthy()?
        && runners::stopped(f)?
    {
        f.set(c"taskId", normalize(chat(f)?.optional(c"_currentTaskId")?)?)?;
        if !scheduler(s)?.truthy()? {
            return repeat_finish(f, empty(f)?);
        }
        let p = async_result(f, || {
            let v = call(scheduler(s)?, c"status", &[session])?;
            schedule_step(f, v, repeat_close, None)
        })?;
        return schedule_step(f, rejected_catch(f, p, repeat_log)?, repeat_finish, None);
    }
    f.set(
        c"source",
        string(fallback(source, "manual_cancel".into())?)?,
    )?;
    if op.truthy()? {
        f.set(
            c"operationId",
            call(string(op)?, c"slice", &[num(f, 0.)?, num(f, 128.)?])?,
        )?;
    } else {
        f.set(c"operationId", null(f)?)?;
    }
    f.set(c"requestedAt", now(f)?)?;
    let p = async_result(f, || {
        if scheduler(s)?.truthy()? {
            let v = call(scheduler(s)?, c"status", &[session])?;
            schedule_step(f, v, dispatch::capture, None)
        } else {
            dispatch::capture(f, null(f)?)
        }
    })?;
    f.set(c"promise", p)?;
    call(m, c"set", &[session, f])?;
    let clear = callback(f, "", 0, 0, |f, _| clear_entry(f, empty(f)?))?;
    call(p, c"then", &[clear, clear])?;
    Ok(p)
}
pub(super) fn cancel_active_turn<'a>(s: L<'a>, id: L<'a>, o: L<'a>) -> Result<L<'a>> {
    async_result(s, || cancel(s, id, o))
}
pub(super) fn install<'a>(s: L<'a>, api: L<'a>) -> Result<()> {
    for (key, fallback) in [
        (c"runnerStopTimeoutMs".as_ref(), 5000.),
        (c"runnerKillGraceMs", 1500.),
    ] {
        let v = s
            .get(c"deps")?
            .get(key)?
            .number_value()?
            .filter(|x| x.is_finite())
            .unwrap_or(fallback);
        s.set(key, num(s, v)?)?;
    }
    api.set(
        c"cancelActiveTurn",
        callback(s, "cancelActiveTurn", 1, 2, |s, a| {
            cancel_active_turn(s, a[0], a[1])
        })?,
    )?;
    api.set(
        c"stopActiveTurnForProviderError",
        callback(s, "stopActiveTurnForProviderError", 1, 2, |s, a| {
            let o = crate::host_methods::default_object(a[1])?;
            let f = fields(
                s,
                &[
                    ("host", s),
                    ("sessionId", a[0]),
                    ("reason", opt(o, c"reason", text(s, "provider_log_error")?)?),
                    ("source", opt(o, c"source", text(s, "provider_log")?)?),
                ],
            )?;
            runners::provider_stop(f)
        })?,
    )
}
