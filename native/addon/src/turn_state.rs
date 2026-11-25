use napi::Result;
use napi_derive::napi;

/// Turn-state constant tables as one JSON document.
/// The host uses it once to initialize the shared boundary set.
#[napi]
pub fn turn_state_catalog() -> Result<String> {
    multicc_core::turn_state::catalog().map_err(napi::Error::from_reason)
}

/// Project structured runtime facts onto one P/D/W/B/E verdict.
#[napi]
pub fn resolve_turn_state(input: String) -> Result<String> {
    multicc_core::turn_state::resolve_json(&input).map_err(napi::Error::from_reason)
}

/// Preserve V8's JSON boundary (including toJSON, exceptions and key order).
#[napi]
pub fn resolve_turn_state_value(
    env: napi::Env,
    input: napi::bindgen_prelude::Unknown<'_>,
) -> Result<napi::sys::napi_value> {
    use crate::js_live::{fields, LiveValue as L};
    use napi::bindgen_prelude::FromNapiValue;
    let input = L::new(&env, input);
    let input = if input.undefined()? {
        fields(input, &[])?
    } else {
        input
    };
    let json = input.global()?.get(c"JSON")?;
    let parse = json.get(c"parse")?;
    let raw = json.get(c"stringify")?.call(json, &[input])?;
    let encoded = unsafe { String::from_napi_value(env.raw(), raw.raw()) }?;
    let result = resolve_turn_state(encoded)?;
    Ok(parse
        .call(json, &[input.from_value(&result.into())?])?
        .raw())
}
