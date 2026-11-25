//! Host-owned workloads that prevent eviction of an idle chat process.
use crate::{
    js_iteration::read,
    js_live::{invoke, LiveValue as L},
};
use multicc_core::js::JsValue as V;
use napi::{bindgen_prelude::Unknown, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

fn active<'a>(owner: L<'a>, key: &CStr, id: L<'a>, site: &str) -> Result<bool> {
    let method = owner.optional(key)?;
    Ok(!method.nullish()? && invoke(owner, method, &[id], site)?.truthy()?)
}

#[napi]
pub fn resident_pool_blocker(
    env: Env,
    background: Unknown<'_>,
    admission: Unknown<'_>,
    work: Unknown<'_>,
    id: Unknown<'_>,
) -> Result<Option<&'static str>> {
    let background = L::new(&env, background);
    let id = L::new(&env, id);
    let primary = read(background, c"hasProcessBackgroundTasks")?;
    let check = if primary.truthy()? {
        primary
    } else {
        read(background, c"hasLiveBackgroundTasks")?
    };
    let plain = id.from_value(&V::Undefined)?;
    if invoke(plain,check,&[id],"(backgroundTaskRuntime.hasProcessBackgroundTasks || backgroundTaskRuntime.hasLiveBackgroundTasks)")?.truthy()? {
        return Ok(Some("background_task"));
    }
    let lease = id.catch(|| {
        let owner = L::new(&env, admission).call_plain(&[])?;
        active(
            owner,
            c"hasActiveLease",
            id,
            "getWorkspaceAdmission(...)?.hasActiveLease",
        )
    })?;
    match lease {
        Some(true) => return Ok(Some("workspace_lease")),
        None => return Ok(Some("workspace_lease_unknown")),
        Some(false) => {}
    }
    Ok(active(
        L::new(&env, work),
        c"isRunActive",
        id,
        "sessionWorkHost?.isRunActive",
    )?
    .then_some("running_task"))
}
