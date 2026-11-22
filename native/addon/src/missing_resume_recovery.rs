use crate::js_live::LiveValue as L;
use multicc_core::missing_resume_recovery;
use napi::bindgen_prelude::{JsValue as _, ToNapiValue, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;

/// Constant tables (ops, actions, evidence values, reasons).
#[napi]
pub fn missing_resume_recovery_catalog() -> Result<String> {
    missing_resume_recovery::catalog().map_err(napi::Error::from_reason)
}

/// One value-in/value-out entry for classify/decide/probe/resume-plan. The
/// payload crosses napi directly, so `undefined` and the non-finite numbers
/// survive a JSON boundary that would have folded them into null/0.
#[napi]
pub fn missing_resume_recovery_request_value(
    env: Env,
    op: String,
    input: Unknown<'_>,
) -> Result<sys::napi_value> {
    let raw = env.raw();
    let value = unsafe { crate::js_bridge::read_value(raw, input.raw(), 0, &mut Vec::new()) }?;
    let result =
        missing_resume_recovery::request_value(&op, &value).map_err(napi::Error::from_reason)?;
    unsafe { crate::js_bridge::write_value(raw, &result) }
}

/// Native replacement for `src/cli-adapters/claude-exp-history.js::hasNativeHistory`.
#[napi]
pub fn claude_exp_has_native_history(
    env: Env,
    record: Unknown<'_>,
    options: Option<Unknown<'_>>,
) -> Result<bool> {
    let absent = L::new(&env, ().into_unknown(&env)?);
    let rec = L::new(&env, record);
    let opts = options.map_or(absent, |v| L::new(&env, v));

    let raw_id = rec.get(c"cliSessionId")?;
    let session_id = if raw_id.truthy()? {
        raw_id.string()?.map(|s| s.to_string_lossy())
    } else {
        None
    };
    let cli = rec.get(c"cli")?.string()?.map(|s| s.to_string_lossy());
    let handoff = rec.get(c"pendingCliHandoff")?;
    let handoff_status = handoff
        .optional(c"status")?
        .string()?
        .map(|s| s.to_string_lossy());
    let handoff_to_cli = handoff
        .optional(c"toCli")?
        .string()?
        .map(|s| s.to_string_lossy());
    let handoff_reused_target = if handoff.nullish()? {
        None
    } else {
        let reused = handoff.get(c"reusedTarget")?;
        if reused.is_false()? {
            Some(false)
        } else if reused.is_true()? {
            Some(true)
        } else {
            None
        }
    };
    let config_dir = opts
        .optional(c"configDir")?
        .string()?
        .map(|s| s.to_string_lossy());

    Ok(missing_resume_recovery::claude_exp_has_native_history(
        cli.as_deref(),
        session_id.as_deref(),
        handoff_status.as_deref(),
        handoff_to_cli.as_deref(),
        handoff_reused_target,
        config_dir.as_deref(),
    ))
}
