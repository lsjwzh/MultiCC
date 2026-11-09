//! napi surface for the Rust transcript governor.
//!
//! Every call either returns a real JavaScript value (via the lossless bridge)
//! or throws. The JavaScript facade in `src/chat/transcript-prune.js` only
//! forwards the arguments and injects `os.homedir()`; all decision-making and
//! file IO live in `multicc_core::transcript_prune`.
use multicc_core::js::JsValue;
use multicc_core::transcript_prune as core;
use napi::bindgen_prelude::{JsValue as _, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;

fn read(env: Env, value: Unknown<'_>) -> Result<JsValue> {
    unsafe { crate::js_bridge::read_value(env.raw(), value.raw(), 0, &mut Vec::new()) }
}

fn write(env: Env, value: &JsValue) -> Result<sys::napi_value> {
    unsafe { crate::js_bridge::write_value(env.raw(), value) }
}

fn reason(message: String) -> napi::Error {
    napi::Error::from_reason(message)
}

fn report(
    env: Env,
    result: std::result::Result<Option<core::Report>, String>,
) -> Result<sys::napi_value> {
    match result {
        Ok(Some(report)) => write(env, &core::report_value(&report)),
        Ok(None) => write(env, &JsValue::Null),
        Err(message) => Err(reason(message)),
    }
}

#[napi]
pub fn transcript_prune_defaults(env: Env) -> Result<sys::napi_value> {
    write(env, &core::defaults_value())
}

#[napi]
pub fn transcript_project_dir(cwd: String, home: String) -> String {
    core::claude_project_dir(&cwd, &home)
}

#[napi]
pub fn transcript_find(cwd: String, session: Option<String>, home: String) -> Option<String> {
    core::find_transcript_file(&cwd, session.as_deref(), &home)
}

#[napi]
pub fn transcript_prune_file(
    env: Env,
    file: Option<String>,
    options: Unknown<'_>,
) -> Result<sys::napi_value> {
    let options = core::Options::from_js(Some(&read(env, options)?)).map_err(reason)?;
    report(env, core::prune_file(file.as_deref(), &options))
}

#[napi]
pub fn transcript_prune_maybe(
    env: Env,
    cwd: String,
    session: Option<String>,
    home: String,
    options: Unknown<'_>,
) -> Result<sys::napi_value> {
    let options = core::Options::from_js(Some(&read(env, options)?)).map_err(reason)?;
    report(
        env,
        core::prune_maybe(&cwd, session.as_deref(), &home, &options),
    )
}

#[napi]
pub fn transcript_measure_file(
    env: Env,
    file: Option<String>,
    options: Unknown<'_>,
) -> Result<sys::napi_value> {
    let options = core::MeasureOptions::from_js(Some(&read(env, options)?)).map_err(reason)?;
    write(
        env,
        &core::level_value(&core::measure_file(file.as_deref(), &options)),
    )
}

#[napi]
pub fn transcript_measure(
    env: Env,
    cwd: String,
    session: Option<String>,
    home: String,
    options: Unknown<'_>,
) -> Result<sys::napi_value> {
    let options = core::MeasureOptions::from_js(Some(&read(env, options)?)).map_err(reason)?;
    write(
        env,
        &core::level_value(&core::measure_maybe(
            &cwd,
            session.as_deref(),
            &home,
            &options,
        )),
    )
}

#[napi]
pub fn transcript_real_user_turn(env: Env, value: Unknown<'_>) -> Result<bool> {
    Ok(core::is_real_user_turn(&read(env, value)?))
}

#[napi]
pub fn transcript_substantive_turn(env: Env, value: Unknown<'_>) -> Result<bool> {
    Ok(core::is_substantive_turn(&read(env, value)?))
}

#[napi]
pub fn transcript_user_visible_text(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    write(
        env,
        &JsValue::String(core::user_visible_text(&read(env, value)?)),
    )
}

#[napi]
pub fn transcript_triggers_for(
    env: Env,
    metrics: Unknown<'_>,
    thresholds: Unknown<'_>,
) -> Result<sys::napi_value> {
    let metrics = read(env, metrics)?;
    let thresholds = read(env, thresholds)?;
    let reasons = core::triggers_for_js(&metrics, &thresholds).map_err(reason)?;
    write(
        env,
        &JsValue::Array(reasons.into_iter().map(JsValue::string).collect::<Vec<_>>()),
    )
}

#[napi]
pub fn transcript_compact_cut_index(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    let parsed = read(env, value)?;
    let JsValue::Array(items) = parsed else {
        return Err(reason("transcript_prune_invalid_lines".to_string()));
    };
    let mut lines = Vec::with_capacity(items.len());
    for item in items {
        let JsValue::String(text) = item else {
            return Err(reason("transcript_prune_invalid_lines".to_string()));
        };
        // Line content crosses as UTF-8; a lone surrogate can only appear here
        // as an escape sequence inside the line, which survives.
        lines.push(text.to_string_lossy());
    }
    write(env, &core::cut_value(&core::compact_cut_index(&lines)))
}
