use crate::js_live::LiveValue;
use multicc_core::js::JsValue;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

// Bounded error metadata only; no filesystem or network work on the host thread.
#[napi]
pub fn classify_provider_error(input: String) -> Result<String> {
    multicc_core::provider_error::classify(&input).map_err(napi::Error::from_reason)
}

/// The classifier tables JavaScript policy reads: `{ cancellationCodes }`.
#[napi]
pub fn provider_error_facts() -> String {
    multicc_core::provider_error::facts()
}

/// Preserve substantive RPC errors; inspect full stderr only after process exit.
/// The temporary callback retains the existing bounded metadata bridge until
/// the event host moves to Rust alongside the classifier already in core.
#[napi]
pub fn opencode_process_error(
    env: Env,
    cli: Unknown<'_>,
    raw: Unknown<'_>,
    stderr: Unknown<'_>,
    classify: Unknown<'_>,
) -> Result<sys::napi_value> {
    let cli = LiveValue::new(&env, cli);
    let raw = LiveValue::new(&env, raw);
    let null = cli.from_value(&JsValue::Null)?;
    if !cli.is_string("opencode")?
        || (raw.truthy()? && !raw.get(c"code")?.is_string("agent_exited")?)
    {
        return Ok(null.raw());
    }
    let error = cli.from_value(&JsValue::Object(vec![]))?;
    error.set(c"source", cli.from_value(&JsValue::from("process_stderr"))?)?;
    error.set(c"provider", cli)?;
    error.set(c"message", LiveValue::new(&env, stderr))?;
    let decision = LiveValue::new(&env, classify).call_plain(&[error, error])?;
    Ok(if decision.truthy()? { error } else { null }.raw())
}
