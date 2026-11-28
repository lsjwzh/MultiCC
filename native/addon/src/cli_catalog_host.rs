//! Live module facades for CLI model catalogs and the private catalog HTTP port.
use crate::host_api::*;
use multicc_core::cli_catalog_host as kernel;
use napi_derive::napi;
use serde_json::Value;
use std::{collections::HashMap, ffi::CStr};
mod agy;
mod dynamic;
mod host;
mod open_code;
mod vendors;

fn truthy_or<'a>(v: L<'a>, d: L<'a>) -> Result<L<'a>> {
    Ok(if v.truthy()? { v } else { d })
}
fn from_json<'a>(p: L<'a>, v: &Value) -> Result<L<'a>> {
    p.from_value(&multicc_core::js::from_serde(v))
}
fn live_json(v: L<'_>) -> Result<Value> {
    let serialized = json_call(v, c"stringify", v)?;
    if serialized.undefined()? {
        return Ok(Value::Null);
    }
    serde_json::from_str(&fold_string(serialized)?)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}
fn wall(p: L<'_>) -> Result<L<'_>> {
    call(p.global()?.get(c"Date")?, c"now", &[])
}
fn fresh(entry: L<'_>, ttl: f64) -> Result<bool> {
    Ok(entry.truthy()? && wall(entry)?.number()? - entry.get(c"at")?.number()? < ttl)
}
fn cache<'a>(p: L<'a>, models: L<'a>) -> Result<()> {
    p.set(
        c"cache",
        fields(p, &[("at", wall(p)?), ("models", models)])?,
    )
}
fn test_cache<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    p.set(c"cache", fields(p, &[("at", a[0]), ("models", a[1])])?)?;
    undef(p)
}
fn reset_cache<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    p.set(c"cache", null(p)?)?;
    undef(p)
}
fn immediate<'a>(cb: L<'a>, args: &[L<'a>]) -> Result<L<'a>> {
    let mut all = vec![cb];
    all.extend_from_slice(args);
    cb.global()?.get(c"setImmediate")?.call_plain(&all)
}
/// A hit promises the then-current cache, including replacement by a concurrent refresh.
fn immediate_cache<'a>(state: L<'a>, callback: L<'a>) -> Result<L<'a>> {
    let owner = fields(state, &[("state", state), ("callback", callback)])?;
    let deliver = function(owner, "", 0, 0, |owner, _| {
        let state = owner.get(c"state")?;
        let models = state.get(c"cache")?.get(c"models")?;
        owner
            .get(c"callback")?
            .call_plain(&[null(state)?, models, text(state, "cache")?])
    })?;
    immediate(deliver, &[])
}
fn next_tick<'a>(cb: L<'a>, args: &[L<'a>]) -> Result<L<'a>> {
    let mut all = vec![cb];
    all.extend_from_slice(args);
    call(cb.global()?.get(c"process")?, c"nextTick", &all)
}
fn reg<'a>(
    out: L<'a>,
    ctx: L<'a>,
    name: &'static str,
    arity: usize,
    n: usize,
    run: Action,
) -> Result<()> {
    out.define_key(text(ctx, name)?, function(ctx, name, arity, n, run)?)
}
fn promise<'a>(p: L<'a>) -> Result<(L<'a>, L<'a>)> {
    let slot = fields(p, &[])?;
    let executor = function(slot, "", 2, 2, |s, a| {
        s.set(c"resolve", a[0])?;
        s.set(c"reject", a[1])?;
        undef(s)
    })?;
    Ok((p.global()?.get(c"Promise")?.construct(&[executor])?, slot))
}
fn caught(p: L<'_>, err: napi::Error) -> Result<L<'_>> {
    match p.exception_value()? {
        Some(e) => Ok(e),
        None => error_value(p, &err.reason),
    }
}
fn process_env(p: L<'_>) -> Result<L<'_>> {
    p.global()?.get(c"process")?.get(c"env")
}
fn home(p: L<'_>) -> Result<String> {
    fold_string(call(p, c"homedir", &[])?)
}
fn get_fn<'a>(v: L<'a>, key: &CStr) -> Result<L<'a>> {
    v.get(key)?.call_plain(&[])
}

#[napi]
pub async fn agy_cli_catalog_read(
    pin: HashMap<String, String>,
    cwd: String,
    timeout_ms: f64,
) -> Result<String> {
    let delay = if timeout_ms >= 1.0 && timeout_ms <= i32::MAX as f64 {
        timeout_ms as u64
    } else {
        1
    };
    let rows = kernel::agy_query(pin, cwd, delay)
        .await
        .map_err(napi::Error::from_reason)?;
    Ok(Value::Array(rows).to_string())
}
#[napi]
pub fn open_code_models_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(open_code::api(L::new(&env, ports))?.raw())
}
#[napi]
pub fn agy_models_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(agy::api(L::new(&env, ports))?.raw())
}
#[napi]
pub fn model_catalogs_host_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(host::api(L::new(&env, ports))?.raw())
}
