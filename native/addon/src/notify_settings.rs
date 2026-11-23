//! Apply the read route's masking rule against the host's current push settings.
//! Keep submitted strings intact, including lone UTF-16 surrogates.
use crate::js_live::LiveValue;
use multicc_core::js::JsValue;
use multicc_core::notify_settings::is_current_placeholder;
use napi::bindgen_prelude::{JsObjectValue, Object, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn resolve_notify_settings_updates(
    env: Env,
    body: Unknown<'_>,
    current: Unknown<'_>,
) -> Result<sys::napi_value> {
    let body = LiveValue::new(&env, body);
    let current = LiveValue::new(&env, current);
    let updates = body.from_value(&JsValue::Object(Vec::new()))?;
    if body.kind()? != sys::ValueType::napi_object {
        return Ok(updates.raw());
    }
    let object = Object::from_raw(env.raw(), body.raw());
    for (field, key) in [(c"barkUrl", c"BARK_URL"), (c"webhookUrl", c"WEBHOOK_URL")] {
        if !object.has_c_own_property(field)? {
            continue;
        }
        let submitted = body.get(field)?;
        if let Some(text) = submitted.string()? {
            let previous = current.optional(key)?;
            let raw = previous.string()?.map(|s| s.to_string_lossy());
            if !is_current_placeholder(&text.to_string_lossy(), raw.as_deref(), previous.truthy()?)
            {
                updates.set(key, submitted)?;
            }
        }
    }
    Ok(updates.raw())
}
