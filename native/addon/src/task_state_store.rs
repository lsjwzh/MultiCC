//! Configure the sole session record writer and expose detachable methods.
//! The event emitter remains a JS closure so listeners see its original receiver.
use crate::{
    host_methods::{call, method},
    js_live::{fields, LiveValue as L},
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn task_state_store(
    env: Env,
    deps: Unknown<'_>,
    resolve_owner: Unknown<'_>,
    defaults: Unknown<'_>,
    payload: Unknown<'_>,
    emit: Unknown<'_>,
) -> Result<sys::napi_value> {
    let deps = L::new(&env, deps);
    let records = deps.get(c"persistedSessions")?;
    let chat = deps.get(c"chatBroadcast")?;
    let workspace = deps.get(c"workspaceBroadcast")?;
    let bus = deps.get(c"bus")?;
    let mut now = deps.get(c"now")?;
    if now.undefined()? {
        now = deps.global()?.get(c"Date")?.get(c"now")?;
    }
    if !bus.truthy()? || bus.get(c"emit")?.kind()? != sys::ValueType::napi_function {
        return Err(deps.type_error("[task-state-store] bus with emit() is required"));
    }
    let owner = L::new(&env, resolve_owner).call_plain(&[records])?;
    if !owner.truthy()? {
        return Err(deps.type_error(
            "[task-state-store] persistedSessions must be the native session record owner",
        ));
    }
    let emit = L::new(&env, emit).call_plain(&[bus])?;
    call(
        owner,
        c"configure",
        &[fields(
            deps,
            &[
                ("busEmit", emit),
                ("chatBroadcast", chat),
                ("workspaceBroadcast", workspace),
                ("taskStatePayload", L::new(&env, payload)),
                ("now", now),
            ],
        )?],
    )?;
    let api = fields(owner, &[])?;
    for (name, key, arity) in [
        ("getTaskState", c"getTaskState", 1),
        ("setTaskState", c"setTaskState", 3),
        ("appendClassifyHistory", c"appendClassifyHistory", 3),
        ("resetTaskState", c"resetTaskState", 1),
    ] {
        let optional_options = key == c"setTaskState";
        let bound = method(
            &env,
            owner,
            name,
            if optional_options { 2 } else { arity },
            arity,
            move |owner, args| {
                if optional_options && !args[2].truthy()? {
                    args[2] = fields(owner, &[])?;
                }
                call(owner, key, args)
            },
        )?;
        api.set(key, bound)?;
    }
    api.set(c"TASK_STATE_DEFAULTS", L::new(&env, defaults))?;
    Ok(api.raw())
}
