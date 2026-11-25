//! Balance strategy classification for a provider's upstream base URL.
use napi_derive::napi;

#[napi]
pub fn provider_balance_strategy(base_url: String) -> Option<String> {
    multicc_core::provider_balance_target::strategy_for_base_url(&base_url).map(str::to_string)
}

use crate::js_live::LiveValue as L;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};

// Keep URI component conversion in the JS realm (including URIError for a lone
// surrogate); only transport and AbortSignal lifetime belong to the Node host.
#[napi]
pub fn provider_balance_path(
    env: Env,
    app_type: Unknown<'_>,
    id: Unknown<'_>,
    cached: bool,
) -> Result<String> {
    let app_type = L::new(&env, app_type);
    let encode = |value| -> Result<String> {
        Ok(app_type
            .global()?
            .get(c"encodeURIComponent")?
            .call_plain(&[value])?
            .coerce_string()?
            .to_string_lossy())
    };
    Ok(format!(
        "/api/providers/{}/{}/balance{}",
        encode(app_type)?,
        encode(L::new(&env, id))?,
        if cached { "?cached=1" } else { "" }
    ))
}

#[napi]
pub fn provider_balance_url(env: Env, options: Unknown<'_>, path: String) -> Result<String> {
    let options = L::new(&env, options);
    let port = if options.get(c"getPort")?.kind()? == sys::ValueType::napi_function {
        options
            .get(c"getPort")?
            .call(options, &[])?
            .number_value()?
    } else {
        None
    };
    if let Some(port) = port.filter(|p| p.fract() == 0.0 && (1.0..=65535.0).contains(p)) {
        return Ok(format!("http://127.0.0.1:{port}{path}"));
    }
    Err(options
        .global()?
        .get(c"Error")?
        .call_plain(&[options.from_value(&"provider balance gateway port unavailable".into())?])?
        .throw_error())
}
