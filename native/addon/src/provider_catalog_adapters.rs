//! Provider catalog and CPR host adapters. Host records and callbacks stay live
//! across the boundary so that cache references and method receivers are stable.
use crate::host_api::*;
use napi_derive::napi;
use std::ffi::CStr;
mod models;
mod router;
mod vendor;

fn truthy_field<'a>(v: L<'a>, keys: &[&CStr], fallback: L<'a>) -> Result<L<'a>> {
    for key in keys {
        let x = v.optional(key)?;
        if x.truthy()? {
            return Ok(x);
        }
    }
    Ok(fallback)
}
fn concat<'a>(anchor: L<'a>, values: &[L<'a>]) -> Result<L<'a>> {
    call(text(anchor, "")?, c"concat", values)
}
fn empty_if_null(v: L<'_>) -> Result<L<'_>> {
    if v.nullish()? {
        text(v, "")
    } else {
        string(v)
    }
}
fn set_new(p: L<'_>) -> Result<L<'_>> {
    p.global()?.get(c"Set")?.construct(&[])
}
fn bind<'a>(f: L<'a>, owner: L<'a>) -> Result<L<'a>> {
    call(f, c"bind", &[owner])
}

#[napi]
pub fn provider_models_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(models::api(L::new(&env, ports))?.raw())
}
#[napi]
pub fn provider_router_adapter_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(router::api(L::new(&env, ports))?.raw())
}
#[napi]
pub fn native_vendor_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(vendor::api(L::new(&env, ports))?.raw())
}
