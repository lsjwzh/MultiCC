//! Writer-group timers stay on the host event loop so callers can cancel them.
use crate::{host_methods::method, js_iteration::read, route_response::*};
use multicc_core::writer_group::{alive, POLL_MS};
use napi::bindgen_prelude::ToNapiValue;
use napi_derive::napi;

fn group_alive(pid: L<'_>) -> Result<bool> {
    let Some(pid) = pid.number_value()? else {
        return Ok(false);
    };
    if !cfg!(unix) || pid.fract() != 0.0 || pid <= 1.0 {
        return Ok(false);
    }
    Ok(pid > f64::from(u32::MAX) || alive(pid as u32))
}

#[napi]
pub fn writer_group_api(env: Env) -> Result<sys::napi_value> {
    let anchor = L::new(&env, ().into_unknown(&env)?);
    let globals = anchor.global()?;
    let groups = method(&env, globals, "processGroups", 0, 0, |g, _| {
        flag(g, cfg!(unix))
    })?;
    let spawn = method(&env, globals, "detachedSpawn", 0, 0, |g, _| {
        let options = fields(g, &[])?;
        if cfg!(unix) {
            options.set(c"detached", flag(g, true)?)?;
        }
        Ok(options)
    })?;
    let check = method(&env, globals, "groupAlive", 1, 1, |g, args| {
        flag(g, group_alive(args[0])?)
    })?;
    let wait = method(&env, globals, "whenGroupEmpty", 2, 3, |g, args| {
        let pid = args[0];
        let done = args[1];
        let options = args[2];
        let interval = if options.undefined()? {
            options
        } else {
            read(options, c"pollMs")?
        };
        if !group_alive(pid)? {
            done.call_plain(&[])?;
            return null(g);
        }
        let state = fields(g, &[("pid", pid), ("done", done)])?;
        let callback_env = Env::from_raw(g.env());
        let poll = method(&callback_env, state, "poll", 0, 0, |state, _| {
            if !group_alive(state.get(c"pid")?)? {
                state
                    .global()?
                    .get(c"clearInterval")?
                    .call_plain(&[state.get(c"timer")?])?;
                state.get(c"done")?.call_plain(&[])?;
            }
            state.from_value(&V::Undefined)
        })?;
        let interval = if interval.undefined()? {
            num(g, POLL_MS as f64)?
        } else {
            interval
        };
        let timer = g.get(c"setInterval")?.call_plain(&[poll, interval])?;
        state.set(c"timer", timer)?;
        let unref = read(timer, c"unref")?;
        if !unref.nullish()? {
            unref.call(timer, &[])?;
        }
        Ok(L::from_raw(g.env(), timer.raw()))
    })?;
    Ok(fields(
        globals,
        &[
            ("processGroups", groups),
            ("detachedSpawn", spawn),
            ("groupAlive", check),
            ("whenGroupEmpty", wait),
            ("GROUP_POLL_MS", num(globals, POLL_MS as f64)?),
        ],
    )?
    .raw())
}
