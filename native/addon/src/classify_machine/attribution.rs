//! Per-request continuations. The Aux queue owns execution and the transcript
//! owns annotations; only the live request may refine the current task.
mod apply;
mod context;
mod queue;
use super::*;
pub(super) use apply::apply;
pub(super) use context::conversation;
pub(super) use queue::{enqueue_scan, run};
use std::ffi::CStr;
type Handler = for<'a> fn(L<'a>, &mut [L<'a>]) -> Result<L<'a>>;
fn cb<'a>(s: L<'a>, n: usize, f: Handler) -> Result<L<'a>> {
    let env = Env::from_raw(s.env());
    let bound = method(&env, s, "", n, n, f)?;
    Ok(L::from_raw(s.env(), bound.raw()))
}
fn or<'a>(v: L<'a>, fallback: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    if v.truthy()? {
        Ok(v)
    } else {
        fallback()
    }
}
fn opt(v: L<'_>) -> Result<L<'_>> {
    fallback(v, V::Null)
}
fn undef(v: L<'_>) -> Result<L<'_>> {
    v.from_value(&V::Undefined)
}
fn is_fn(v: L<'_>) -> Result<bool> {
    Ok(v.kind()? == sys::ValueType::napi_function)
}
fn host<'a>(p: L<'a>, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    p.get(name)?.call_plain(args)
}
fn row<'a>(p: L<'a>, name: L<'a>) -> Result<L<'a>> {
    call(p.get(c"persistedSessions")?, c"get", &[name])
}
fn task_state<'a>(p: L<'a>, name: L<'a>) -> Result<L<'a>> {
    host(p, c"getTaskState", &[row(p, name)?])
}
fn resolved_promise(v: L<'_>) -> Result<L<'_>> {
    call(v.global()?.get(c"Promise")?, c"resolve", &[v])
}
fn cause<'a>(s: L<'a>, e: napi::Error) -> Result<L<'a>> {
    match s.exception_value()? {
        Some(v) => Ok(v),
        None => s.global()?.get(c"Error")?.construct(&[text(s, &e.reason)?]),
    }
}
fn async_result<'a>(s: L<'a>, value: Result<L<'a>>) -> Result<L<'a>> {
    match value {
        Ok(v) => resolved_promise(v),
        Err(e) => {
            let error = cause(s, e)?;
            call(s.global()?.get(c"Promise")?, c"reject", &[error])
        }
    }
}
fn chain<'a>(s: L<'a>, value: L<'a>, f: Handler) -> Result<L<'a>> {
    call(resolved_promise(value)?, c"then", &[cb(s, 1, f)?])
}
fn write_log<'a>(p: L<'a>, level: &CStr, event: &str, body: L<'a>) -> Result<()> {
    let logger = p.get(c"logger")?;
    let log = logger.get(level)?;
    if !log.nullish()? {
        log.call(logger, &[text(p, event)?, body])?;
    }
    Ok(())
}
fn log_error<'a>(s: L<'a>, event: &str, error: L<'a>, extra: &[(&str, L<'a>)]) -> Result<()> {
    let data = fields(s, extra)?;
    data.set(c"sessionId", s.get(c"name")?)?;
    let message = or(error.optional(c"message")?, || {
        string(fallback(error, "".into())?)
    })?;
    data.set(c"error", message)?;
    write_log(s.get(c"p")?, c"warn", event, data)
}
// Some diagnostic ports persist exactly error.message, including undefined.
fn log_message<'a>(s: L<'a>, event: &str, error: L<'a>, extra: &[(&str, L<'a>)]) -> Result<()> {
    let data = fields(s, extra)?;
    data.set(c"sessionId", s.get(c"name")?)?;
    data.set(c"error", error.get(c"message")?)?;
    write_log(s.get(c"p")?, c"warn", event, data)
}
fn fresh_id(p: L<'_>) -> Result<L<'_>> {
    let id = call(p.get(c"crypto")?, c"randomUUID", &[])?;
    let mut out = JsString::from("tsk_");
    out.push(&call(id, c"replaceAll", &[text(p, "-")?, text(p, "")?])?.coerce_string()?);
    p.from_value(&V::String(out))
}
fn field_names<'a>(to: L<'a>, from: L<'a>, keys: &[&CStr]) -> Result<()> {
    for key in keys {
        to.set(key, from.get(key)?)?;
    }
    Ok(())
}
