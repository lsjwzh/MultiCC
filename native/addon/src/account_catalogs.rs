//! Live per-account model views and provider identities. Account stores, proxy
//! plugins and the CLI scheduler are injected by the runtime that owns them.
mod claude;
mod codex;
mod official;
mod references;
use crate::host_api::*;
use multicc_core::js::JsString as S;
use napi_derive::napi;
use std::ffi::CStr;

fn bind<'a>(p: L<'a>, items: &[(&'static str, usize, usize, Action)]) -> Result<L<'a>> {
    let out = fields(p, &[])?;
    for &(name, arity, count, run) in items {
        out.define_key(text(p, name)?, function(p, name, arity, count, run)?)?
    }
    Ok(out)
}
fn push<'a>(a: L<'a>, v: L<'a>) -> Result<()> {
    call(a, c"push", &[v])?;
    Ok(())
}
fn map(p: L<'_>) -> Result<L<'_>> {
    p.global()?.get(c"Map")?.construct(&[])
}
fn plain<'a>(p: L<'a>, k: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    p.get(k)?.call_plain(args)
}
fn or<'a>(v: L<'a>, other: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    if v.truthy()? {
        Ok(v)
    } else {
        other()
    }
}
fn supported(t: L<'_>) -> Result<bool> {
    Ok(t.is_string("claude")? || t.is_string("codex")?)
}
fn valid(s: &S) -> bool {
    s.len() == 16 && s.as_units().iter().all(|&v| matches!(v,48..=57|97..=102))
}
fn cat<'a>(p: L<'a>, parts: &[L<'a>], sep: &str) -> Result<L<'a>> {
    let mut buf = S::new();
    for (i, v) in parts.iter().enumerate() {
        if i > 0 {
            buf.push_str(sep)
        }
        buf.push(&v.coerce_string()?);
    }
    p.from_value(&V::String(buf))
}

#[napi]
pub fn codex_account_catalog_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(codex::api(L::new(&env, ports))?.raw())
}
#[napi]
pub fn claude_model_list_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(claude::api(L::new(&env, ports))?.raw())
}
#[napi]
pub fn official_provider_catalog_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(official::api(L::new(&env, ports))?.raw())
}
