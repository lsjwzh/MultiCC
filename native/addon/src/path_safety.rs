//! Existing path/fs/os ports supply platform behavior; Rust owns ancestor walks
//! and the HOME/root guard. The bounded synchronous walk preserves existing
//! callers and adds no directory enumeration or recursive file scan.
use crate::js_live::LiveValue as L;
use multicc_core::js::{JsString, JsValue as V};
use napi::bindgen_prelude::Unknown;
use napi::{sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

fn call<'a>(receiver: L<'a>, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    receiver.get(name)?.call(receiver, args)
}
fn real_path<'a>(value: L<'a>, fs: L<'a>, path: L<'a>) -> Result<L<'a>> {
    let absolute = call(path, c"resolve", &[value])?;
    let mut cursor = absolute;
    let mut tail = Vec::new();
    while !call(fs, c"existsSync", &[cursor])?.truthy()? {
        let parent = call(path, c"dirname", &[cursor])?;
        if parent.equals(cursor)? {
            return Ok(absolute);
        }
        tail.insert(0, call(path, c"basename", &[cursor])?);
        cursor = parent;
    }
    // Only realpath and joining were best effort. Resolve, existence probes,
    // dirname and basename errors must keep their original exception identity.
    Ok(value
        .catch(|| {
            let join = path.get(c"join")?;
            let resolved = call(fs, c"realpathSync", &[cursor])?;
            let mut parts = vec![resolved];
            parts.extend(tail);
            join.call(path, &parts)
        })?
        .unwrap_or(absolute))
}

#[napi]
pub fn path_safety_real_path(
    env: Env,
    value: Unknown<'_>,
    fs: Unknown<'_>,
    path: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(real_path(L::new(&env, value), L::new(&env, fs), L::new(&env, path))?.raw())
}

#[napi]
pub fn path_safety_home_or_above(
    env: Env,
    value: Unknown<'_>,
    fs: Unknown<'_>,
    path: Unknown<'_>,
    os: Unknown<'_>,
) -> Result<bool> {
    let value = L::new(&env, value);
    let fs = L::new(&env, fs);
    let path = L::new(&env, path);
    let os = L::new(&env, os);
    let resolved = real_path(value, fs, path)?;
    let home = real_path(call(os, c"homedir", &[])?, fs, path)?;
    if resolved.equals(home)? {
        return Ok(true);
    }
    if home.equals(resolved)? {
        return Ok(true);
    }
    let starts_with = home.get(c"startsWith")?;
    let mut prefix: JsString = resolved.coerce_string()?;
    prefix.push(&path.get(c"sep")?.coerce_string()?);
    if starts_with
        .call(home, &[value.from_value(&V::String(prefix))?])?
        .truthy()?
    {
        return Ok(true);
    }
    resolved.equals(call(path, c"parse", &[resolved])?.get(c"root")?)
}
