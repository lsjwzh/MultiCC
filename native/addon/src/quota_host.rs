//! Shared live-value adapters for the quota host's injected stores, clocks and callbacks.
pub(crate) use crate::{
    host_methods::{async_result, default_object, function},
    js_live::spread,
    route_response::*,
};
use std::ffi::CStr;
pub(crate) type Action = for<'a> fn(L<'a>, &mut [L<'a>]) -> Result<L<'a>>;
pub(crate) fn methods<'a>(
    owner: L<'a>,
    entries: &[(&'static str, usize, Action)],
) -> Result<L<'a>> {
    let out = fields(owner, &[])?;
    for &(name, n, run) in entries {
        out.define_key(text(owner, name)?, function(owner, name, n, n, run)?)?;
    }
    Ok(out)
}
pub(crate) fn undef(p: L<'_>) -> Result<L<'_>> {
    p.from_value(&V::Undefined)
}
pub(crate) fn callable(v: L<'_>) -> Result<bool> {
    Ok(v.kind()? == sys::ValueType::napi_function)
}
pub(crate) fn object(v: L<'_>) -> Result<bool> {
    Ok(v.kind()? == sys::ValueType::napi_object)
}
pub(crate) fn now(p: L<'_>) -> Result<L<'_>> {
    p.get(c"now")?.call_plain(&[])
}
pub(crate) fn array(p: L<'_>) -> Result<L<'_>> {
    p.global()?.get(c"Array")?.construct(&[])
}
pub(crate) fn pick<'a>(v: L<'a>, keys: &[&CStr]) -> Result<L<'a>> {
    let out = fields(v, &[])?;
    for &k in keys {
        out.set(k, v.optional(k)?)?;
    }
    Ok(out)
}
pub(crate) fn resolved(v: L<'_>) -> Result<L<'_>> {
    call(v.global()?.get(c"Promise")?, c"resolve", &[v])
}
pub(crate) fn ignored<'a>(p: L<'a>, action: impl FnOnce() -> Result<L<'a>>) -> Result<()> {
    p.catch(|| {
        let result = resolved(action()?)?;
        call(
            result,
            c"catch",
            &[function(p, "ignore", 0, 0, |p, _| undef(p))?],
        )
    })?;
    Ok(())
}
pub(crate) fn error_value<'a>(p: L<'a>, message: &str) -> Result<L<'a>> {
    p.global()?.get(c"Error")?.construct(&[text(p, message)?])
}
pub(crate) fn fold_string(v: L<'_>) -> Result<String> {
    Ok(string(v)?.coerce_string()?.to_string_lossy())
}
/// The bound owner keeps callback arguments alive across Promise turns.
pub(crate) fn then<'a>(v: L<'a>, owner: L<'a>, run: Action) -> Result<L<'a>> {
    call(
        resolved(v)?,
        c"then",
        &[function(owner, "onFulfilled", 1, 1, run)?],
    )
}
pub(crate) fn recover<'a>(v: L<'a>, owner: L<'a>, run: Action) -> Result<L<'a>> {
    call(
        resolved(v)?,
        c"catch",
        &[function(owner, "onRejected", 1, 1, run)?],
    )
}
pub(crate) fn constant<'a>(value: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    Ok(value)
}
pub(crate) fn with_default<'a>(v: L<'a>, other: L<'a>) -> Result<L<'a>> {
    Ok(if v.undefined()? { other } else { v })
}
pub(crate) fn json_call<'a>(p: L<'a>, name: &std::ffi::CStr, v: L<'a>) -> Result<L<'a>> {
    call(p.global()?.get(c"JSON")?, name, &[v])
}
