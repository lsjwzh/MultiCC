//! napi surface for the Rust transcript governor.
//!
//! Every call either returns a real JavaScript value (via the lossless bridge)
//! or throws. The host supplies its home directory; decision-making and
//! file IO live in `multicc_core::transcript_prune`.
use crate::js_live::LiveValue as L;
use multicc_core::js::JsValue;
use multicc_core::transcript_prune as core;
use napi::bindgen_prelude::{FromNapiValue, JsValue as _, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

fn read(env: Env, value: Unknown<'_>) -> Result<JsValue> {
    unsafe { crate::js_bridge::read_value(env.raw(), value.raw(), 0, &mut Vec::new()) }
}

fn live_string(obj: L<'_>, key: &CStr) -> Result<Option<String>> {
    let value = obj.get(key)?;
    if !value.truthy()? {
        return Ok(None);
    }
    Ok(value
        .string()?
        .map(|text| text.to_string_lossy())
        .filter(|text| !text.is_empty()))
}

fn live_object<'a>(obj: L<'a>, key: &CStr) -> Result<Option<L<'a>>> {
    let value = obj.get(key)?;
    if value.nullish()? || value.kind()? != sys::ValueType::napi_object || value.is_array()? {
        return Ok(None);
    }
    Ok(Some(value))
}

/// Extract only the Claude-relevant identity fields lazily via `LiveValue` so
/// large persisted session records are never cloned across the napi boundary.
fn read_claude_session_ref(env: &Env, record: Unknown<'_>) -> Result<core::ClaudeSessionRef> {
    let live = L::new(env, record);
    if live.nullish()? || live.kind()? != sys::ValueType::napi_object || live.is_array()? {
        return Ok(core::ClaudeSessionRef::default());
    }
    let mut out = core::ClaudeSessionRef {
        cli: live_string(live, c"cli")?,
        cli_session_id: live_string(live, c"cliSessionId")?,
        stream_session_id: live_string(live, c"_streamSessionId")?,
        ..core::ClaudeSessionRef::default()
    };
    if let Some(states) = live_object(live, c"cliStates")? {
        if let Some(claude) = live_object(states, c"claude")? {
            out.claude_cli_session_id = live_string(claude, c"cliSessionId")?;
            out.claude_stream_session_id = live_string(claude, c"streamSessionId")?;
        }
        if let Some(claude_exp) = live_object(states, c"claude-exp")? {
            out.claude_exp_cli_session_id = live_string(claude_exp, c"cliSessionId")?;
            out.claude_exp_stream_session_id = live_string(claude_exp, c"streamSessionId")?;
        }
    }
    Ok(out)
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
pub fn transcript_claude_targets(env: Env, record: Unknown<'_>) -> Result<sys::napi_value> {
    let session = read_claude_session_ref(&env, record)?;
    let targets = core::claude_transcript_targets(&session);
    write(
        env,
        &JsValue::Array(targets.iter().map(|id| JsValue::string(id)).collect()),
    )
}

#[napi]
pub fn transcript_find_session_claude(
    env: Env,
    cwd: String,
    record: Unknown<'_>,
    home: String,
) -> Result<Option<String>> {
    let session = read_claude_session_ref(&env, record)?;
    Ok(core::find_session_claude_file(&cwd, &session, &home))
}

#[napi]
pub fn transcript_prune_session_claude(
    env: Env,
    cwd: String,
    record: Unknown<'_>,
    home: String,
    options: Unknown<'_>,
) -> Result<sys::napi_value> {
    let session = read_claude_session_ref(&env, record)?;
    let options = core::Options::from_js(Some(&read(env, options)?)).map_err(reason)?;
    let outcome = core::prune_session_claude(&cwd, &session, &home, &options);
    write(env, &core::session_prune_outcome_value(&outcome))
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

fn opt_string(v: L<'_>, empty: JsValue) -> Result<L<'_>> {
    if v.truthy()? {
        v.global()?.get(c"String")?.call_plain(&[v])
    } else {
        v.from_value(&empty)
    }
}

fn unknown(v: L<'_>) -> Result<Unknown<'_>> {
    // v is borrowed in the active callback scope and keeps its original V8 value.
    unsafe { Unknown::from_napi_value(v.env(), v.raw()) }
}
fn string_arg(v: L<'_>) -> Result<String> {
    unsafe { String::from_napi_value(v.env(), v.raw()) }
}
fn optional_id(v: L<'_>) -> Result<Option<String>> {
    let s = opt_string(v, JsValue::Null)?;
    if s.nullish()? {
        Ok(None)
    } else {
        Ok(Some(string_arg(s)?))
    }
}
fn file_result<'a>(owner: L<'a>, name: &str, file: Option<String>, opts: L<'a>) -> Result<L<'a>> {
    let env = Env::from_raw(owner.env());
    let opts = if opts.undefined()? {
        crate::js_live::fields(owner, &[])?
    } else {
        opts
    };
    let raw = if matches!(name, "pruneFile" | "maybePrune") {
        transcript_prune_file(env, file, unknown(opts)?)?
    } else {
        transcript_measure_file(env, file, unknown(opts)?)?
    };
    Ok(L::from_raw(owner.env(), raw))
}
fn prune_command<'a>(os: L<'a>, name: &str, args: &[L<'a>]) -> Result<L<'a>> {
    use crate::{host_methods::call, js_live::fields};
    let env = Env::from_raw(os.env());
    let first = args[0];
    let home = || string_arg(call(os, c"homedir", &[])?);
    let path = |value: Option<String>| os.from_value(&value.map_or(JsValue::Null, JsValue::from));
    let raw = match name {
        "claudeTranscriptTargets" => transcript_claude_targets(env, unknown(first)?)?,
        "isRealUserTurn" => {
            return os.from_value(&JsValue::Bool(transcript_real_user_turn(
                env,
                unknown(first)?,
            )?))
        }
        "isSubstantiveTurn" => {
            return os.from_value(&JsValue::Bool(transcript_substantive_turn(
                env,
                unknown(first)?,
            )?))
        }
        "userVisibleText" => transcript_user_visible_text(env, unknown(first)?)?,
        "triggersFor" => transcript_triggers_for(env, unknown(first)?, unknown(args[1])?)?,
        "compactCutIndex" => transcript_compact_cut_index(env, unknown(first)?)?,
        "measureFile" | "pruneFile" => return file_result(os, name, optional_id(first)?, args[1]),
        _ => {
            let cwd = string_arg(opt_string(first, JsValue::from(""))?)?;
            match name {
                "claudeProjectDir" => return path(Some(transcript_project_dir(cwd, home()?))),
                "findSessionClaudeFile" => {
                    return path(transcript_find_session_claude(
                        env,
                        cwd,
                        unknown(args[1])?,
                        home()?,
                    )?)
                }
                "pruneSessionClaude" => {
                    let home = home()?;
                    let options = if args[2].undefined()? {
                        fields(os, &[])?
                    } else {
                        args[2]
                    };
                    transcript_prune_session_claude(
                        env,
                        cwd,
                        unknown(args[1])?,
                        home,
                        unknown(options)?,
                    )?
                }
                _ => {
                    let file = transcript_find(cwd, optional_id(args[1])?, home()?);
                    if name == "findTranscriptFile" {
                        return path(file);
                    }
                    return file_result(os, name, file, args[2]);
                }
            }
        }
    };
    Ok(L::from_raw(os.env(), raw))
}
/// The facade resolves the current Node home directory on each path operation.
/// Its methods enter the same Rust routines as direct native API callers.
#[napi]
pub fn transcript_pruning_api(env: Env, os: Unknown<'_>) -> Result<sys::napi_value> {
    use crate::{host_methods::method, js_live::fields};
    let os = L::new(&env, os);
    let api = fields(os, &[])?;
    for (name, capacity, length) in [
        ("maybePrune", 3, 2),
        ("pruneFile", 2, 1),
        ("claudeTranscriptTargets", 1, 1),
        ("findSessionClaudeFile", 2, 2),
        ("pruneSessionClaude", 3, 2),
        ("measure", 3, 2),
        ("measureFile", 2, 1),
        ("findTranscriptFile", 2, 2),
        ("claudeProjectDir", 1, 1),
        ("isRealUserTurn", 1, 1),
        ("isSubstantiveTurn", 1, 1),
        ("userVisibleText", 1, 1),
        ("triggersFor", 2, 2),
        ("compactCutIndex", 1, 1),
    ] {
        let f = method(&env, os, name, length, capacity, move |os, a| {
            prune_command(os, name, a)
        })?;
        api.set_key(api.from_value(&name.into())?, f)?;
    }
    let defaults = os.from_value(&core::defaults_value())?;
    for (name, key) in [
        ("DEFAULT_MAX_BYTES", c"maxBytes"),
        ("DEFAULT_TARGET_TOKENS", c"targetTokens"),
        ("DEFAULT_HARD_MAX_TOKENS", c"hardMaxTokens"),
        ("DEFAULT_MAX_ENTRY_BYTES", c"maxEntryBytes"),
        ("DEFAULT_HARD_ENTRY_BYTES", c"hardEntryBytes"),
        ("DEFAULT_KEEP_TURNS_LADDER", c"keepTurnsLadder"),
        ("DEFAULT_SCAN_MIN_BYTES", c"scanMinBytes"),
        ("DEFAULT_TOKEN_WATERMARK", c"tokenWatermark"),
    ] {
        api.set_key(api.from_value(&name.into())?, defaults.get(key)?)?;
    }
    Ok(api.raw())
}
