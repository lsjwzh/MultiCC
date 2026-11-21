use crate::{
    js_live::LiveValue,
    provider_claude_proxy_policy::assign_error_code,
    provider_terminal_routes::{clean, object, property},
};
use multicc_core::{codex_provider_home as home, js::JsValue, json_lenient};
use napi::{bindgen_prelude::Unknown, Env, Error, Result};
use napi_derive::napi;
use serde_json::Value;
use std::path::Path;

#[napi]
pub fn codex_provider_materialize(
    target: String,
    global_auth: String,
    settings: String,
    auth_only: bool,
) -> Result<String> {
    let settings: Value = json_lenient::from_str(&settings)
        .map_err(|_| Error::from_reason("CODEX_PROVIDER_CONFIG_INVALID"))?;
    let target = Path::new(&target);
    let global_auth = Path::new(&global_auth);
    if auth_only {
        home::materialize_auth(target, global_auth, &settings).map(str::to_owned)
    } else {
        home::materialize_direct(target, global_auth, &settings).map(|env| env.to_string())
    }
    .map_err(Error::from_reason)
}

#[napi]
pub fn codex_provider_official_home(target: String, id: String, config: String) -> Result<()> {
    home::materialize_official(Path::new(&target), &id, &config).map_err(Error::from_reason)
}

#[napi]
pub fn codex_provider_sanitize_home(target: String, proxy_path: String) -> Result<()> {
    home::sanitize_official(Path::new(&target), &proxy_path).map_err(Error::from_reason)
}

#[napi]
pub fn codex_provider_official_env_keys(keys: Vec<String>) -> Vec<String> {
    keys.into_iter()
        .filter(|key| home::official_env_key(key))
        .collect()
}

#[napi]
pub fn codex_proxy_config_required(env: Env, options: Unknown<'_>) -> Result<bool> {
    let options = LiveValue::new(&env, options);
    let options = if options.undefined()? {
        object(options)?
    } else {
        options
    };
    if options.nullish()? {
        return Err(
            options.type_error("Cannot read properties of null (reading 'subagentProviderId')")
        );
    }
    let mut reader = None;
    let subagent = property(&mut reader, options, c"subagentProviderId")?;
    let subagent = clean(&mut reader, subagent)?;
    if subagent.truthy()? {
        return Ok(true);
    }
    let provider = property(&mut reader, options, c"providerId")?;
    let provider = clean(&mut reader, provider)?;
    Ok(provider.truthy()? && !provider.is_string("_default_")?)
}

#[napi]
pub fn assert_codex_proxy_config_applied(env: Env, options: Unknown<'_>) -> Result<bool> {
    let options = LiveValue::new(&env, options);
    let options = if options.undefined()? {
        object(options)?
    } else {
        options
    };
    if options.nullish()? {
        return Err(options.type_error("Cannot destructure property 'required' of '(intermediate value)(intermediate value)(intermediate value)' as it is null."));
    }
    let mut reader = None;
    let required = property(&mut reader, options, c"required")?;
    let applied = property(&mut reader, options, c"applied")?.is_true()?;
    if required.is_true()? && !applied {
        let message = options.from_value(&JsValue::string(
            "Codex managed provider route could not be materialized",
        ))?;
        let error = options.global()?.get(c"Error")?.construct(&[message])?;
        assign_error_code(
            error,
            options.from_value(&JsValue::string("CODEX_PROXY_CONFIG_REQUIRED"))?,
        )?;
        return Err(error.throw_error());
    }
    Ok(applied)
}
