use napi::bindgen_prelude::{JsValue as _, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn homebrew_takeover_request(
    env: Env,
    op: String,
    input: Unknown<'_>,
) -> Result<sys::napi_value> {
    let raw = env.raw();
    let value = unsafe { crate::js_bridge::read_value(raw, input.raw(), 0, &mut Vec::new()) }?;
    let output = multicc_core::homebrew_takeover::request(&op, &value);
    unsafe { crate::js_bridge::write_value(raw, &output) }
}

/// Resolve PATH in its original order using the host platform's path rules.
/// Keep the caller's realpath injection (including symlink and error handling).
#[napi]
pub fn homebrew_resolve_owner(
    env: Env,
    cmd: Unknown<'_>,
    env_path: Unknown<'_>,
    realpath: Unknown<'_>,
    path: Unknown<'_>,
    exists: Unknown<'_>,
    addon: Unknown<'_>,
) -> Result<sys::napi_value> {
    use crate::{
        host_methods::call,
        js_live::{fields, LiveValue as L},
    };
    use multicc_core::js::JsValue as V;
    let cmd = L::new(&env, cmd);
    let path = L::new(&env, path);
    let exists = L::new(&env, exists);
    let null = cmd.from_value(&V::Null)?;
    if !cmd.truthy()? {
        return Ok(null.raw());
    }
    let resolved = if call(path, c"isAbsolute", &[cmd])?.truthy()? {
        cmd
    } else {
        if call(cmd, c"includes", &[cmd.from_value(&"/".into())?])?.truthy()? {
            return Ok(null.raw());
        }
        let input = L::new(&env, env_path);
        let search = if input.truthy()? {
            input.global()?.get(c"String")?.call_plain(&[input])?
        } else {
            input.from_value(&"".into())?
        };
        let entries = call(search, c"split", &[path.get(c"delimiter")?])?;
        let mut found = None;
        entries.for_each_while(|dir| {
            if dir.truthy()? {
                let candidate = call(path, c"join", &[dir, cmd])?;
                if exists.call_plain(&[candidate])?.truthy()? {
                    found = Some(candidate);
                    return Ok(false);
                }
            }
            Ok(true)
        })?;
        let Some(found) = found else {
            return Ok(null.raw());
        };
        found
    };
    let Some(real) = cmd.catch(|| L::new(&env, realpath).call_plain(&[resolved]))? else {
        return Ok(null.raw());
    };
    let real = cmd.global()?.get(c"String")?.call_plain(&[real])?;
    let input = fields(
        cmd,
        &[
            ("real", real),
            ("resolved", resolved),
            ("basename", call(path, c"basename", &[resolved])?),
        ],
    )?;
    Ok(call(
        L::new(&env, addon),
        c"homebrewTakeoverRequest",
        &[cmd.from_value(&"owner".into())?, input],
    )?
    .raw())
}
