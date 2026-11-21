//! Synchronous spawn configuration over the shared atomic state-file writer.
use crate::{js_live::LiveValue as L, provider_claude_proxy_policy::assign_error_code};
use multicc_core::{js::JsValue as V, state_file};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::{ffi::CStr, fs, io, path::Path};

const BLANK_KEYS: &[&CStr] = &[
    c"ANTHROPIC_BASE_URL",
    c"ANTHROPIC_AUTH_TOKEN",
    c"ANTHROPIC_API_KEY",
    c"ANTHROPIC_CUSTOM_HEADERS",
    c"ANTHROPIC_MODEL",
    c"ANTHROPIC_SMALL_FAST_MODEL",
    c"ANTHROPIC_DEFAULT_OPUS_MODEL",
    c"ANTHROPIC_DEFAULT_SONNET_MODEL",
    c"ANTHROPIC_DEFAULT_HAIKU_MODEL",
    c"ANTHROPIC_DEFAULT_FABLE_MODEL",
    c"CLAUDE_CODE_SIMPLE",
];

fn routing_env(input: L<'_>) -> Result<L<'_>> {
    let result = input.from_value(&V::Object(vec![]))?;
    if !input.truthy()? || input.kind()? != sys::ValueType::napi_object {
        return Ok(result);
    }
    let entries = input
        .global()?
        .get(c"Object")?
        .get(c"entries")?
        .call_plain(&[input])?;
    entries.for_each(|pair| {
        let key = pair.element(0)?;
        let text = key.coerce_string()?.to_string_lossy();
        let value = pair.element(1)?;
        if (text.starts_with("ANTHROPIC_") || text.starts_with("CLAUDE_CODE_"))
            && value.kind()? == sys::ValueType::napi_string
        {
            result.set_key(key, value)?;
        }
        Ok(())
    })?;
    Ok(result)
}

fn io_failure(anchor: L<'_>, error: io::Error) -> napi::Error {
    let code = match error.kind() {
        io::ErrorKind::NotFound => "ENOENT",
        io::ErrorKind::AlreadyExists => "EEXIST",
        io::ErrorKind::PermissionDenied => "EACCES",
        io::ErrorKind::NotADirectory => "ENOTDIR",
        io::ErrorKind::IsADirectory => "EISDIR",
        _ => "CLAUDE_SETTINGS_WRITE_FAILED",
    };
    let thrown = (|| {
        let message = anchor.from_value(&V::from(error.to_string()))?;
        let thrown = anchor.global()?.get(c"Error")?.construct(&[message])?;
        assign_error_code(thrown, anchor.from_value(&V::from(code))?)?;
        Ok::<_, napi::Error>(thrown.throw_error())
    })();
    thrown.unwrap_or_else(|error| error)
}

#[napi]
pub fn claude_routing_env(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(routing_env(L::new(&env, input))?.raw())
}

#[napi]
pub fn claude_settings_override(
    env: Env,
    directory: String,
    session: Unknown<'_>,
    child_env: Unknown<'_>,
    extra: Unknown<'_>,
) -> Result<Option<String>> {
    let child_env = L::new(&env, child_env);
    let routed = routing_env(child_env)?;
    let extra = L::new(&env, extra);
    let extra_object = extra.truthy()? && extra.kind()? == sys::ValueType::napi_object;
    let keys = child_env.global()?.get(c"Object")?.get(c"keys")?;
    let has_env = keys.call_plain(&[routed])?.get(c"length")?.truthy()?;
    if !has_env && !(extra_object && keys.call_plain(&[extra])?.get(c"length")?.truthy()?) {
        return Ok(None);
    }
    let reflect = child_env.global()?.get(c"Reflect")?;
    for key in BLANK_KEYS {
        let name = child_env.from_value(&V::from(key.to_str().expect("routing key")))?;
        if !reflect
            .get(c"has")?
            .call(reflect, &[routed, name])?
            .truthy()?
        {
            routed.set(key, child_env.from_value(&V::from(""))?)?;
        }
    }
    let path = Path::new(&directory);
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(state_file::DIR_MODE);
    }
    builder
        .create(path)
        .map_err(|error| io_failure(child_env, error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(state_file::DIR_MODE))
            .map_err(|error| io_failure(child_env, error))?;
    }
    let session = L::new(&env, session);
    let name = if session.truthy()? {
        session
    } else {
        session.from_value(&V::from("session"))?
    };
    let name = session.global()?.get(c"String")?.call_plain(&[name])?;
    let encoded = session
        .global()?
        .get(c"encodeURIComponent")?
        .call_plain(&[name])?;
    let file = path.join(format!(
        "{}.json",
        encoded.coerce_string()?.to_string_lossy()
    ));
    let document = child_env.from_value(&V::Object(vec![]))?;
    if extra_object {
        document.spread_from(extra)?;
    }
    document.set(c"env", routed)?;
    // The compatibility file boundary retains V8's toJSON, undefined, UTF-16
    // and key-order semantics before the shared Rust writer persists bytes.
    let json = document.global()?.get(c"JSON")?;
    let text = json.get(c"stringify")?.call(
        json,
        &[
            document,
            document.from_value(&V::Null)?,
            document.from_value(&V::Number(2.0))?,
        ],
    )?;
    let text = text
        .string()?
        .ok_or_else(|| text.type_error("Settings must serialize to a JSON string"))?;
    state_file::write_text_atomic(
        &file,
        &text.to_string_lossy(),
        state_file::FILE_MODE,
        state_file::DIR_MODE,
    )
    .map_err(|error| io_failure(child_env, error))?;
    Ok(Some(file.to_string_lossy().into_owned()))
}
