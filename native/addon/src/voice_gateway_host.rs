//! Live record-store and loopback operations for the realtime voice gateway.
use crate::host_api::*;
use napi_derive::napi;
use std::ffi::CStr;

mod domain;
mod launch;
mod routes;
mod runtime;
mod service;

const GLOBAL: &str = "__voice_gateway__";
const PROVIDER: &str = "qwen-audio-agent";
const ROUTER: &str = "__voice_router__";
const LOOPBACK: &str = "http://127.0.0.1:3000";
use multicc_core::voice_gateway_routes::HOST_PATH as GATEWAY_PATH;
use multicc_core::voice_runtime_routes::HOST_PATH as RUNTIME_PATH;

fn clean(v: L<'_>) -> Result<L<'_>> {
    if v.kind()? == sys::ValueType::napi_string {
        call(v, c"trim", &[])
    } else {
        text(v, "")
    }
}

fn or<'a>(first: L<'a>, second: L<'a>) -> Result<L<'a>> {
    Ok(if first.truthy()? { first } else { second })
}

// Functions with a final default parameter accept it without including it in Function.length.
fn default_method<'a>(
    api: L<'a>,
    ctx: L<'a>,
    name: &'static str,
    required: usize,
    action: Action,
) -> Result<()> {
    api.define_key(
        text(ctx, name)?,
        function(ctx, name, required, required + 1, action)?,
    )
}

fn success(p: L<'_>) -> Result<L<'_>> {
    fields(p, &[("ok", flag(p, true)?)])
}
fn failure<'a>(p: L<'a>, code: &str) -> Result<L<'a>> {
    fields(p, &[("ok", flag(p, false)?), ("code", text(p, code)?)])
}
fn ok(result: L<'_>) -> Result<bool> {
    result.get(c"ok")?.truthy()
}
fn map_get<'a>(map: L<'a>, id: L<'a>) -> Result<L<'a>> {
    call(map, c"get", &[id])
}
fn check_map(map: L<'_>, msg: &str) -> Result<()> {
    if !map.instance_of(map.global()?.get(c"Map")?)? {
        return Err(map.type_error(msg));
    }
    Ok(())
}
fn opt_call<'a>(v: L<'a>, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    let cb = v.optional(name)?;
    if cb.nullish()? {
        undef(v)
    } else {
        cb.call(v, args)
    }
}
fn stamp<'a>(p: L<'a>, time: Option<L<'a>>) -> Result<L<'a>> {
    let date = p.global()?.get(c"Date")?;
    let date = match time {
        Some(t) if t.nullish()? || t.is_string("")? => return null(p),
        Some(t) if t.instance_of(date)? => t,
        Some(t) => date.construct(&[t])?,
        None => date.construct(&[])?,
    };
    if !call(date, c"getTime", &[])?.number()?.is_finite() {
        null(p)
    } else {
        call(date, c"toISOString", &[])
    }
}

#[napi]
pub fn voice_launch_registry_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let out = fields(p, &[])?;
    default_method(out, p, "createVoiceLaunchRegistry", 0, launch::create)?;
    out.set(c"DEFAULT_TTL_MS", num(p, launch::TTL)?)?;
    out.set(c"MAX_TICKETS", num(p, launch::CAPACITY)?)?;
    out.set(c"GLOBAL_VOICE_ROUTER_ID", text(p, ROUTER)?)?;
    Ok(out.raw())
}
#[napi]
pub fn voice_gateway_domain_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(domain::api(L::new(&env, ports))?.raw())
}
#[napi]
pub fn voice_gateway_host_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let out = methods(p, &[("publicBaseUrl", 1, |_, a| routes::public_base(a[0]))])?;
    default_method(out, p, "createVoiceGatewayHost", 0, routes::create)?;
    out.set(c"HOST_PATH", text(p, GATEWAY_PATH)?)?;
    Ok(out.raw())
}
#[napi]
pub fn voice_runtime_host_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let out = fields(p, &[])?;
    default_method(out, p, "createVoiceRuntimeHost", 0, runtime::create)?;
    out.set(c"HOST_PATH", text(p, RUNTIME_PATH)?)?;
    Ok(out.raw())
}
