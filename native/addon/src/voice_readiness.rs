//! Voice readiness over host values. Only readiness flags cross into the rules.
use crate::js_live::LiveValue;
use multicc_core::{
    js::{from_serde, JsValue},
    voice_routes,
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub const VOICE_NOT_READY: &str = voice_routes::NOT_READY;

#[napi]
pub fn voice_readiness(
    env: Env,
    local: bool,
    has_cloud_key: bool,
    streaming: Unknown<'_>,
    download: Unknown<'_>,
) -> Result<sys::napi_value> {
    let streaming = LiveValue::new(&env, streaming);
    let download = LiveValue::new(&env, download);
    let summary = voice_routes::readiness_summary(
        local,
        has_cloud_key,
        |provider| {
            // The old short-circuit expression reads an available provider twice.
            let key = streaming.from_value(&JsValue::string(provider))?;
            Ok::<_, napi::Error>(
                streaming.get_key(key)?.truthy()?
                    && streaming.get_key(key)?.get(c"ready")?.truthy()?,
            )
        },
        || {
            if !download.truthy()? {
                return Ok(None);
            }
            Ok(download
                .get(c"state")?
                .string()?
                .map(|state| state.to_string_lossy()))
        },
    )?;
    let body = download.from_value(&from_serde(&summary))?;
    body.set(c"download", download)?;
    Ok(body.raw())
}
