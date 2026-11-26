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
    Ok(resolve_live(crate::js_live::LiveValue::new(&env, input))?.raw())
}

pub(crate) fn resolve_live(
    input: crate::js_live::LiveValue<'_>,
) -> Result<crate::js_live::LiveValue<'_>> {
    use crate::js_live::fields;
    use napi::bindgen_prelude::FromNapiValue;
    let input = if input.undefined()? {
        fields(input, &[])?
    } else {
        input
    };
    let json = input.global()?.get(c"JSON")?;
    let parse = json.get(c"parse")?;
    let raw = json.get(c"stringify")?.call(json, &[input])?;
    let encoded = unsafe { String::from_napi_value(input.env(), raw.raw()) }?;
    let result = resolve_turn_state(encoded)?;
    parse.call(json, &[input.from_value(&result.into())?])
}

#[napi]
pub fn turn_state_api(env: napi::Env) -> Result<napi::sys::napi_value> {
    use crate::{host_methods::method, route_response::*};
    use napi::bindgen_prelude::ToNapiValue;
    let owner = L::new(&env, ().into_unknown(&env)?);
    let boundaries = owner.from_value(&V::Array(
        multicc_core::turn_state::ABNORMAL_BOUNDARIES
            .iter()
            .map(|v| V::from(*v))
            .collect(),
    ))?;
    let set = owner.global()?.get(c"Set")?.construct(&[boundaries])?;
    Ok(fields(
        owner,
        &[
            ("ABNORMAL_BOUNDARIES", set),
            (
                "resolveTurnState",
                method(&env, owner, "resolveTurnState", 0, 1, |_, a| {
                    resolve_live(a[0])
                })?,
            ),
        ],
    )?
    .raw())
}
