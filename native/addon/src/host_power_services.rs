//! Power consent persistence and live settings. The async host only awaits the
//! service call selected here, then resumes this state with its original value.
use crate::{host_methods::method, js_iteration::read, route_response::*};
use multicc_core::js::JsString;
use napi_derive::napi;

fn done<'a>(state: L<'a>, value: L<'a>) -> Result<L<'a>> {
    state.assign(c"pending", flag(state, false)?)?;
    state.assign(c"value", value)?;
    Ok(state)
}

fn pending<'a>(state: L<'a>, phase: &str, value: L<'a>) -> Result<L<'a>> {
    state.assign(c"phase", text(state, phase)?)?;
    state.assign(c"pending", flag(state, true)?)?;
    state.assign(c"value", value)?;
    Ok(state)
}

fn service<'a>(
    deps: L<'a>,
    ports: L<'a>,
    key: &std::ffi::CStr,
    factory: &std::ffi::CStr,
) -> Result<L<'a>> {
    let service = deps.get(key)?;
    if service.truthy()? {
        Ok(service)
    } else {
        ports.get(factory)?.call_plain(&[])
    }
}

fn failed(state: L<'_>) -> Result<L<'_>> {
    let password = state.get(c"password")?;
    let value = fields(
        state,
        &[
            ("available", call(password, c"isAvailable", &[])?),
            ("set", flag(state, false)?),
            ("canEdit", state.get(c"canEdit")?),
            ("error", text(state, "read-failed")?),
        ],
    )?;
    let status = state.get(c"status")?;
    status.assign(c"unlockPassword", value)?;
    done(state, status)
}

fn protected<'a>(state: L<'a>, action: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    match action() {
        Ok(result) => Ok(result),
        Err(error) => {
            state.exception_value()?.ok_or(error)?;
            failed(state)
        }
    }
}

fn password_result<'a>(state: L<'a>, set: L<'a>) -> Result<L<'a>> {
    let status = state.get(c"status")?;
    let requested = call(state.get(c"preferences")?, c"read", &[set])?;
    let available = call(state.get(c"password")?, c"isAvailable", &[])?;
    let enabled = if set.truthy()? {
        if requested.truthy()? {
            requested
        } else {
            status.get(c"enabled")?
        }
    } else {
        set
    };
    let value = fields(
        state,
        &[
            ("available", available),
            ("set", set),
            ("canEdit", state.get(c"canEdit")?),
            ("requested", requested),
            ("enabled", enabled),
            ("requiredByLid", status.get(c"enabled")?),
        ],
    )?;
    status.assign(c"unlockPassword", value)?;
    if read(read(status, c"unlockPassword")?, c"enabled")?.truthy()? {
        let probe = service(
            state.get(c"deps")?,
            state.get(c"ports")?,
            c"unlockProbe",
            c"getUnlockProbe",
        )?;
        pending(
            state,
            "authorization",
            call(probe, c"desktopPermissions", &[])?,
        )
    } else {
        done(state, status)
    }
}

#[napi]
pub fn host_power_settings_start(
    env: Env,
    deps: Unknown<'_>,
    req: Unknown<'_>,
    ports: Unknown<'_>,
) -> Result<sys::napi_value> {
    let deps = L::new(&env, deps);
    let state = fields(
        deps,
        &[
            ("deps", deps),
            ("req", L::new(&env, req)),
            ("ports", L::new(&env, ports)),
        ],
    )?;
    let value = if !call(read(deps, c"macosPower")?, c"isAvailable", &[])?.truthy()? {
        done(
            state,
            fields(
                state,
                &[
                    ("available", flag(state, false)?),
                    ("enabled", flag(state, false)?),
                ],
            )?,
        )?
    } else {
        pending(
            state,
            "lid",
            call(deps.get(c"macosPower")?, c"getLidModeSettings", &[])?,
        )?
    };
    Ok(value.raw())
}

#[napi]
pub fn host_power_settings_resume(
    env: Env,
    state: Unknown<'_>,
    success: bool,
    value: Unknown<'_>,
) -> Result<sys::napi_value> {
    let state = L::new(&env, state);
    let value = L::new(&env, value);
    let phase = state.get(c"phase")?;
    let result = if phase.is_string("lid")? {
        if !success {
            return Err(value.throw_error());
        }
        state.assign(c"status", value)?;
        let deps = state.get(c"deps")?;
        if deps.get(c"batteryGuard")?.truthy()? {
            value.assign(
                c"batteryGuard",
                call(deps.get(c"batteryGuard")?, c"getStatus", &[])?,
            )?;
        }
        let ports = state.get(c"ports")?;
        state.assign(
            c"password",
            service(deps, ports, c"unlockPassword", c"getUnlockPassword")?,
        )?;
        state.assign(
            c"preferences",
            service(deps, ports, c"powerPreferences", c"getPowerPreferences")?,
        )?;
        state.assign(
            c"canEdit",
            flag(
                state,
                call(deps, c"isLocalRequest", &[state.get(c"req")?])?.truthy()?,
            )?,
        )?;
        protected(state, || {
            let password = state.get(c"password")?;
            let available = call(password, c"isAvailable", &[])?;
            if available.truthy()? {
                pending(state, "password", call(password, c"hasPassword", &[])?)
            } else {
                password_result(state, available)
            }
        })?
    } else if !success {
        failed(state)?
    } else if phase.is_string("password")? {
        protected(state, || password_result(state, value))?
    } else {
        protected(state, || {
            let status = state.get(c"status")?;
            if !read(value, c"state")?.is_string("authorized")? {
                read(status, c"unlockPassword")?.assign(c"enabled", flag(state, false)?)?;
                read(status, c"unlockPassword")?.assign(c"authorization", value)?;
            }
            done(state, status)
        })?
    };
    Ok(result.raw())
}

fn read_preferences<'a>(state: L<'a>, legacy: L<'a>) -> Result<L<'a>> {
    let operation = (|| {
        let body = call(
            state.get(c"fs")?,
            c"readFileSync",
            &[state.get(c"file")?, text(state, "utf8")?],
        )?;
        let value = call(state.global()?.get(c"JSON")?, c"parse", &[body])?;
        if read(value, c"autoUnlock")?.kind()? != sys::ValueType::napi_boolean {
            return Err(state
                .global()?
                .get(c"Error")?
                .construct(&[text(state, "invalid power preferences")?])?
                .throw_error());
        }
        read(value, c"autoUnlock")
    })();
    match operation {
        Ok(value) => Ok(value),
        Err(error) => {
            let cause = state.exception_value()?.ok_or(error)?;
            if read(cause, c"code")?.is_string("ENOENT")? {
                Ok(legacy)
            } else {
                Err(cause.throw_error())
            }
        }
    }
}

fn write_preferences<'a>(state: L<'a>, value: L<'a>) -> Result<L<'a>> {
    let fs = state.get(c"fs")?;
    call(
        fs,
        c"mkdirSync",
        &[
            state.get(c"dir")?,
            fields(
                state,
                &[
                    ("recursive", flag(state, true)?),
                    ("mode", num(state, 448.0)?),
                ],
            )?,
        ],
    )?;
    let tmp = JsString::concat(&[
        &state.get(c"file")?.coerce_string()?,
        &JsString::from("."),
        &state.get(c"pid")?.coerce_string()?,
        &JsString::from(".tmp"),
    ]);
    let tmp = state.from_value(&V::String(tmp))?;
    let operation = (|| {
        let write = fs.get(c"writeFileSync")?;
        let encoded = call(
            state.global()?.get(c"JSON")?,
            c"stringify",
            &[fields(state, &[("autoUnlock", value)])?],
        )?;
        let body = JsString::concat(&[&encoded.coerce_string()?, &JsString::from("\n")]);
        write.call(
            fs,
            &[
                tmp,
                state.from_value(&V::String(body))?,
                fields(state, &[("mode", num(state, 384.0)?)])?,
            ],
        )?;
        call(fs, c"renameSync", &[tmp, state.get(c"file")?])
    })();
    let cause = match operation {
        Ok(_) => None,
        Err(error) => Some(state.exception_value()?.ok_or(error)?),
    };
    call(
        fs,
        c"rmSync",
        &[tmp, fields(state, &[("force", flag(state, true)?)])?],
    )?;
    if let Some(cause) = cause {
        return Err(cause.throw_error());
    }
    state.from_value(&V::Undefined)
}

#[napi]
pub fn host_power_preferences(
    env: Env,
    fs: Unknown<'_>,
    path: Unknown<'_>,
    dir: Unknown<'_>,
    pid: Unknown<'_>,
) -> Result<sys::napi_value> {
    let fs = L::new(&env, fs);
    let dir = L::new(&env, dir);
    let file = call(
        L::new(&env, path),
        c"join",
        &[dir, text(fs, "power-settings.json")?],
    )?;
    let state = fields(
        fs,
        &[
            ("fs", fs),
            ("dir", dir),
            ("file", file),
            ("pid", L::new(&env, pid)),
        ],
    )?;
    Ok(fields(
        state,
        &[
            (
                "read",
                method(&env, state, "read", 0, 1, |state, args| {
                    let legacy = if args[0].undefined()? {
                        flag(state, false)?
                    } else {
                        args[0]
                    };
                    read_preferences(state, legacy)
                })?,
            ),
            (
                "write",
                method(&env, state, "write", 1, 1, |state, args| {
                    write_preferences(state, args[0])
                })?,
            ),
        ],
    )?
    .raw())
}
