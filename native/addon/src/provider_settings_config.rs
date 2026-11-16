//! Node transport for the `settingsConfig` builder and the `apiFormat` pair.
//!
//! Values cross as JSON through the bridge, so `undefined` members arrive as
//! absent keys -- which is exactly the distinction the retired code made with
//! `!== undefined`, and the only one these rules depend on.
use napi::bindgen_prelude::{JsValue as _, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;
use serde_json::Value;

use multicc_core::provider_settings_config as rules;

fn read(env: Env, input: Unknown<'_>) -> Result<Value> {
    let value =
        unsafe { crate::js_bridge::read_value(env.raw(), input.raw(), 0, &mut Vec::new()) }?;
    Ok(multicc_core::js::serde::to_serde(&value))
}

fn field<'a>(input: &'a Value, name: &str) -> Option<&'a Value> {
    input.get(name).filter(|value| !value.is_null())
}

fn app_type(input: &Value) -> Option<String> {
    input
        .get("appType")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// `buildSettingsConfig(appType, { ... })`. The loopback port is passed in as
/// `port` because it is a fact of the Node process (`process.env.PORT || 3000`),
/// not of the front door.
#[napi]
pub fn provider_build_settings_config(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let input = read(env, input)?;
    let port = match input.get("port") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => {
            multicc_core::js::serde::js_string(&Value::Number(number.clone()))
        }
        _ => "3000".to_string(),
    };
    let config = rules::build_settings_config(
        app_type(&input).as_deref(),
        &rules::SettingsInput {
            base_url: field(&input, "baseUrl"),
            auth_token: field(&input, "authToken"),
            model: field(&input, "model"),
            models: field(&input, "models"),
            provider_id: field(&input, "providerId"),
            alias_map: field(&input, "aliasMap"),
            port,
        },
    );
    let value = multicc_core::js::serde::from_serde(&config);
    unsafe { crate::js_bridge::write_value(env.raw(), &value) }
}

/// `normalizeApiFormat(value, appType)`. The third `cfg` argument the retired
/// signature carried was never read, so it is not transported.
#[napi]
pub fn provider_normalize_api_format(env: Env, input: Unknown<'_>) -> Result<String> {
    let input = read(env, input)?;
    Ok(
        rules::normalize_api_format(field(&input, "apiFormat"), app_type(&input).as_deref())
            .to_string(),
    )
}

/// `assertApiFormatMatchesAppType`: returns the rejection message, or `null`
/// when the format is unspecified or agrees with the pool. The caller throws,
/// so the `Error` identity and stack stay on the Node side.
#[napi]
pub fn provider_api_format_conflict(env: Env, input: Unknown<'_>) -> Result<Option<String>> {
    let input = read(env, input)?;
    Ok(rules::assert_api_format_matches_app_type(
        field(&input, "apiFormat"),
        app_type(&input).as_deref(),
    )
    .err())
}

/// `parseModelList(models, primary)`: the deduped, trimmed model list.
#[napi]
pub fn provider_parse_model_list(env: Env, input: Unknown<'_>) -> Result<Vec<String>> {
    let input = read(env, input)?;
    Ok(rules::parse_model_list(
        field(&input, "models"),
        field(&input, "model"),
    ))
}

/// `applyAliasMapToEnv(env, aliasMap)`: the whole env back, with each tier's
/// keys written or deleted. Returned rather than mutated so the caller decides
/// how to sync it onto its own object; every other key is passed through
/// untouched and in place, which is what makes the sync byte-identical to the
/// retired in-place loop.
#[napi]
pub fn provider_apply_alias_map(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let input = read(env, input)?;
    let mut map = match input.get("env") {
        Some(Value::Object(map)) => map.clone(),
        _ => serde_json::Map::new(),
    };
    rules::apply_alias_map_to_env(&mut map, field(&input, "aliasMap"));
    let value = multicc_core::js::serde::from_serde(&Value::Object(map));
    unsafe { crate::js_bridge::write_value(env.raw(), &value) }
}

/// `ensureZhipuFableAlias(env)`: `{ applied, env }`. The caller only syncs when
/// `applied` is true, so a non-Zhipu env is never rewritten.
#[napi]
pub fn provider_ensure_zhipu_fable_alias(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let input = read(env, input)?;
    let mut map = match input.get("env") {
        Some(Value::Object(map)) => map.clone(),
        _ => serde_json::Map::new(),
    };
    let applied = rules::ensure_zhipu_fable_alias(&mut map);
    let mut out = serde_json::Map::new();
    out.insert("applied".to_string(), Value::Bool(applied));
    out.insert("env".to_string(), Value::Object(map));
    let value = multicc_core::js::serde::from_serde(&Value::Object(out));
    unsafe { crate::js_bridge::write_value(env.raw(), &value) }
}

/// `isZhipuBaseUrl(baseUrl)`.
#[napi]
pub fn provider_is_zhipu_base_url(env: Env, input: Unknown<'_>) -> Result<bool> {
    let input = read(env, input)?;
    Ok(rules::is_zhipu_base_url(field(&input, "baseUrl")))
}

/// `detectResponsesCompatTarget(baseUrl)`.
#[napi]
pub fn provider_responses_compat_target(env: Env, input: Unknown<'_>) -> Result<Option<String>> {
    let input = read(env, input)?;
    let base_url = match field(&input, "baseUrl") {
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        _ => return Ok(None),
    };
    Ok(rules::detect_responses_compat_target(Some(&base_url)).map(str::to_string))
}

/// The bounded Zhipu fable mapping (`{ model, name }`). Exported so the Node
/// read path that projects it onto legacy configs reads the same literal the
/// write path fills in, instead of keeping a second copy.
#[napi]
pub fn provider_zhipu_fable_alias(env: Env) -> Result<sys::napi_value> {
    let value = multicc_core::js::serde::from_serde(&rules::zhipu_fable_alias());
    unsafe { crate::js_bridge::write_value(env.raw(), &value) }
}
