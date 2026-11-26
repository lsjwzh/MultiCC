use crate::{host_methods::call, js_live::LiveValue as L};
use multicc_core::{goal_precheck, js::JsValue};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn goal_dimension_labels(env: Env) -> Result<sys::napi_value> {
    let entries = goal_precheck::DIMENSIONS
        .into_iter()
        .map(|(key, label)| (key.into(), JsValue::from(label)))
        .collect();
    unsafe { crate::js_bridge::write_value(env.raw(), &JsValue::Object(entries)) }
}

fn label_keys(labels: L<'_>) -> Result<Vec<L<'_>>> {
    let object = labels.global()?.get(c"Object")?;
    let keys = call(object, c"keys", &[labels])?;
    let len = keys.get(c"length")?.number()? as u32;
    (0..len).map(|i| keys.element(i)).collect()
}

#[napi]
pub fn build_goal_precheck_prompt(
    env: Env,
    labels: Unknown<'_>,
    enabled: Unknown<'_>,
    task: Unknown<'_>,
) -> Result<sys::napi_value> {
    let labels = L::new(&env, labels);
    let enabled = L::new(&env, enabled);
    let mut selected = Vec::new();
    for key in label_keys(labels)? {
        if enabled.call_plain(&[key])?.truthy()? {
            selected.push(key);
        }
    }
    // A dimension getter can mutate the exported label table before fallback.
    if selected.is_empty() {
        selected = label_keys(labels)?;
    }
    let criteria = selected
        .into_iter()
        .map(|key| labels.get_key(key)?.coerce_string())
        .collect::<Result<Vec<_>>>()?;
    let task = L::new(&env, task).coerce_string()?;
    let prompt = goal_precheck::build_prompt(&criteria, &task);
    Ok(labels.from_value(&JsValue::String(prompt))?.raw())
}
