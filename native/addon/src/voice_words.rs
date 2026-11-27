//! Voice vocabulary and refinement host APIs. Only runtime-owned facilities
//! (optional SDK, JSON persistence, timers and the WHATWG stream) are ports.
mod config;
mod corrector;
mod learner;
mod miner;
mod stream;

use crate::host_api::*;
use multicc_core::js::JsString as S;
use napi::{bindgen_prelude::AsyncTask, ScopedTask};
use napi_derive::napi;
use std::{ffi::CStr, path::Path};
fn len(v: L<'_>) -> Result<usize> {
    Ok(v.get(c"length")?.number()? as usize)
}
fn push<'a>(v: L<'a>, x: L<'a>) -> Result<()> {
    call(v, c"push", &[x])?;
    Ok(())
}
fn join<'a>(v: L<'a>, separator: &str) -> Result<L<'a>> {
    call(v, c"join", &[text(v, separator)?])
}
fn ls<'a>(p: L<'a>, s: S) -> Result<L<'a>> {
    p.from_value(&V::String(s))
}
fn or_array(v: L<'_>) -> Result<L<'_>> {
    if v.truthy()? {
        Ok(v)
    } else {
        array(v)
    }
}
fn lower(v: L<'_>) -> Result<L<'_>> {
    call(v, c"toLowerCase", &[])
}
fn gcall<'a>(p: L<'a>, ctor: &CStr, method: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    call(p.global()?.get(ctor)?, method, args)
}
fn slice<'a>(v: L<'a>, start: f64, end: Option<f64>) -> Result<L<'a>> {
    let mut args = vec![num(v, start)?];
    if let Some(end) = end {
        args.push(num(v, end)?)
    }
    call(v, c"slice", &args)
}
fn regex<'a>(p: L<'a>, pattern: &str, flags: &str) -> Result<L<'a>> {
    p.global()?
        .get(c"RegExp")?
        .construct(&[text(p, pattern)?, text(p, flags)?])
}
fn error_message<'a>(p: L<'a>, err: napi::Error) -> Result<L<'a>> {
    if let Some(e) = p.exception_value()? {
        e.get(c"message")
    } else {
        text(p, &err.reason)
    }
}
fn read_json<'a>(p: L<'a>, file: L<'a>) -> Result<L<'a>> {
    Ok(p.catch(|| {
        json_call(
            p,
            c"parse",
            call(p.get(c"fs")?, c"readFileSync", &[file, text(p, "utf8")?])?,
        )
    })?
    .unwrap_or(null(p)?))
}
pub struct VoiceHistoryScan(String);
impl<'task> ScopedTask<'task> for VoiceHistoryScan {
    type Output = V;
    type JsValue = Unknown<'task>;
    fn compute(&mut self) -> Result<V> {
        Ok(multicc_core::voice_words::scan(Path::new(&self.0)))
    }
    fn resolve(&mut self, env: &'task Env, output: V) -> Result<Unknown<'task>> {
        let value = unsafe { crate::js_bridge::write_value(env.raw(), &output)? };
        Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), value) })
    }
}
#[napi]
pub fn voice_words_scan(dir: String) -> AsyncTask<VoiceHistoryScan> {
    AsyncTask::new(VoiceHistoryScan(dir))
}
#[napi]
pub fn voice_corrector_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(corrector::api(L::new(&env, ports))?.raw())
}
#[napi]
pub fn voice_miner_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(miner::api(L::new(&env, ports))?.raw())
}
#[napi]
pub fn voice_learner_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(learner::api(L::new(&env, ports))?.raw())
}
#[napi]
pub fn voice_config_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(config::api(L::new(&env, ports))?.raw())
}
