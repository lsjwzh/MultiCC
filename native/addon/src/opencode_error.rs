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
    classifier: Unknown<'_>,
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
    // Custom classifiers belong to callers that supply one explicitly.
    let classifier = LiveValue::new(&env, classifier);
    if classifier.kind()? == sys::ValueType::napi_function {
        let recognized = classifier.call_plain(&[error, error])?.truthy()?;
        return Ok(if recognized { error } else { null }.raw());
    }
    // Only this bounded stderr observation reaches the ordinary provider classifier.
    // Keep the original, untruncated error for the caller when it is recognized.
    let decision = cli.catch(|| {
        let stderr=error.get(c"message")?;
        let wire_error=if let Some(value)=stderr.string()? {
            serde_json::json!({"message":value.truncate_units(65536).to_string_lossy()})
        } else if let Some(value)=stderr.number_value()?.filter(|n|n.is_finite()) {
            serde_json::json!({"message":value})
        } else {serde_json::json!({})};
        let request=serde_json::json!({"source":"process_stderr","provider":"opencode","error":wire_error});
        let decision=classify_provider_error(request.to_string())?;
        Ok(decision!="null")
    })?.unwrap_or(false);
    Ok(if decision { error } else { null }.raw())
}
