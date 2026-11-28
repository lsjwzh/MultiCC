//! Native CLI login configuration and process ports shared by the auth routes.
use crate::{
    host_api::*,
    host_methods::{arg, env, raw},
};
use napi_derive::napi;
use std::{ffi::CStr, fs, path::PathBuf};

mod kimi;
mod zcode;

fn process_env(p: L<'_>) -> Result<L<'_>> {
    p.get(c"process")?.get(c"env")
}
fn join<'a>(p: L<'a>, dir: L<'a>, name: &str) -> Result<L<'a>> {
    call(p.get(c"path")?, c"join", &[dir, text(p, name)?])
}
fn filename(v: L<'_>) -> Result<PathBuf> {
    Ok(PathBuf::from(fold_string(v)?))
}
fn mkdir<'a>(p: L<'a>, dir: L<'a>, private: bool) -> Result<()> {
    let path = filename(dir)?;
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    #[cfg(not(unix))]
    let _ = private;
    builder
        .create(&path)
        .map_err(|e| crate::node_fs_error::throw(p, &e, "mkdir", Some(&path), None))
}
fn nonempty<'a>(p: L<'a>, v: L<'a>) -> Result<L<'a>> {
    if v.truthy()? {
        Ok(v)
    } else {
        text(p, "")
    }
}
fn trimmed_string(v: L<'_>) -> Result<L<'_>> {
    call(string(nonempty(v, v)?)?, c"trim", &[])
}
fn trimmed(v: L<'_>) -> Result<L<'_>> {
    call(nonempty(v, v)?, c"trim", &[])
}
fn keys(v: L<'_>) -> Result<L<'_>> {
    call(v.global()?.get(c"Object")?, c"keys", &[v])
}
fn json_string<'a>(p: L<'a>, value: L<'a>) -> Result<L<'a>> {
    call(
        p.global()?.get(c"JSON")?,
        c"stringify",
        &[value, null(p)?, num(p, 2.)?],
    )
}
fn denied<'a>(p: L<'a>, message: &str, ability: (&str, L<'a>)) -> Result<L<'a>> {
    fields(
        p,
        &[
            ("ok", flag(p, false)?),
            ("code", text(p, "configuration_required")?),
            ("message", text(p, message)?),
            ability,
        ],
    )
}
fn admitted<'a>(p: L<'a>, provider: L<'a>, source: L<'a>) -> Result<L<'a>> {
    fields(
        p,
        &[
            ("ok", flag(p, true)?),
            ("provider", provider),
            ("source", source),
        ],
    )
}

#[napi]
pub fn kimi_auth_host(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(kimi::api(L::new(&env, ports))?.raw())
}
#[napi]
pub fn zcode_auth_host(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(zcode::api(L::new(&env, ports))?.raw())
}
