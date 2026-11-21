//! Preserve live store ports while Rust owns capacity routing and the limit.
use crate::js_live::LiveValue as L;
use multicc_core::js::JsValue as V;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn task_directory_capacity_limit() -> u32 {
    multicc_core::task_domain::MAX_TASKS_PER_DIRECTORY as u32
}

#[napi]
pub fn task_directory_capacity(
    env: Env,
    store: Unknown<'_>,
    directory: Unknown<'_>,
    capacity: bool,
    domain: Unknown<'_>,
) -> Result<sys::napi_value> {
    let store = L::new(&env, store);
    let directory = L::new(&env, directory);
    if store.get(c"rule")?.truthy()? {
        // The original ternary reads rule twice, including a second getter.
        let callback = store.get(c"rule")?;
        let input = store.from_value(&V::Object(vec![]))?;
        input.set(
            c"action",
            store.from_value(&V::from(if capacity {
                "directoryCapacity"
            } else {
                "directoryCount"
            }))?,
        )?;
        input.set(c"dirId", directory)?;
        if callback.kind()? != sys::ValueType::napi_function {
            return Err(store.type_error("store.rule is not a function"));
        }
        return Ok(callback.call(store, &[input])?.raw());
    }
    let input = store.from_value(&V::Object(vec![]))?;
    input.set(c"op", store.from_value(&V::from("capacity"))?)?;
    let list = store.get(c"list")?;
    if list.kind()? != sys::ValueType::napi_function {
        return Err(store.type_error("store.list is not a function"));
    }
    input.set(
        c"tasks",
        list.call(store, &[store.from_value(&V::from("task"))?])?,
    )?;
    input.set(c"dirId", directory)?;
    let result = L::new(&env, domain).call_plain(&[input])?;
    Ok(result
        .get(if capacity { c"atCapacity" } else { c"count" })?
        .raw())
}
