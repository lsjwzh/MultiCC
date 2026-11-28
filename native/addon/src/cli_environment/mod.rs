//! One environment owner per Node realm: command maps and environment refreshes
//! observe the same revision. Only the OS and live JS handles cross the border.
use crate::host_api::*;
use multicc_core::js::JsString;
use napi_derive::napi;
mod accounts;
mod commands;
mod windows;

fn process(p: L<'_>) -> Result<L<'_>> {
    p.global()?.get(c"process")
}
fn env(p: L<'_>) -> Result<L<'_>> {
    process(p)?.get(c"env")
}
fn win(p: L<'_>) -> Result<L<'_>> {
    flag(p, process(p)?.get(c"platform")?.is_string("win32")?)
}
fn prop<'a>(obj: L<'a>, key: &str) -> Result<L<'a>> {
    obj.get_key(text(obj, key)?)
}
fn default<'a>(value: L<'a>, fallback: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    if value.undefined()? {
        fallback()
    } else {
        Ok(value)
    }
}
fn or<'a>(value: L<'a>, fallback: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    if value.truthy()? {
        Ok(value)
    } else {
        fallback()
    }
}
fn own_key<'a>(environment: L<'a>, name: &str, exact: bool) -> Result<Option<L<'a>>> {
    let name = text(environment, name)?;
    let object = environment.global()?.get(c"Object")?;
    if exact && call(object, c"hasOwn", &[environment, name])?.truthy()? {
        return Ok(Some(name));
    }
    let upper = name.get(c"toUpperCase")?.call(name, &[])?;
    let mut found = None;
    call(object, c"keys", &[environment])?.for_each_while(|k| {
        if k.get(c"toUpperCase")?.call(k, &[])?.equals(upper)? {
            found = Some(k);
            Ok(false)
        } else {
            Ok(true)
        }
    })?;
    Ok(found)
}
fn env_value<'a>(environment: L<'a>, name: &str) -> Result<L<'a>> {
    match own_key(environment, name, true)? {
        Some(key) => environment.get_key(key),
        None => undef(environment),
    }
}
fn list<'a>(p: L<'a>, values: &[L<'a>]) -> Result<L<'a>> {
    let out = array(p)?;
    for (i, v) in values.iter().enumerate() {
        out.set_element(i as u32, *v)?
    }
    Ok(out)
}
fn normalized(input: JsString) -> JsString {
    let s = input.trim();
    let units = s.as_units();
    if units.len() >= 2 && units.first() == Some(&34) && units.last() == Some(&34) {
        s.slice_units(1, units.len() - 1)
    } else {
        s
    }
}
fn units(p: L<'_>, v: JsString) -> Result<L<'_>> {
    p.from_value(&V::String(v))
}
fn string_or_empty(v: L<'_>) -> Result<JsString> {
    if !v.truthy()? {
        Ok(JsString::new())
    } else {
        string(v)?.coerce_string()
    }
}
#[napi]
pub fn cli_environment_api(env: Env, host: Unknown<'_>) -> Result<sys::napi_value> {
    let host = L::new(&env, host);
    let qoder_versions = host.global()?.get(c"Map")?.construct(&[])?;
    let owner = fields(host, &[("host", host), ("qoder", qoder_versions)])?;
    windows::reset(owner)?;
    let windows = windows::api(owner)?;
    owner.set(c"windows", windows)?;
    let commands = commands::api(owner)?;
    owner.set(c"commands", commands)?;
    let accounts = accounts::api(owner)?;
    let api = fields(
        owner,
        &[
            ("cliCommands", commands),
            ("windowsEnv", windows),
            ("agyAccounts", accounts),
        ],
    )?;
    Ok(api.raw())
}
