//! Public Node entry points for the same provider projections as the gateway.
use napi::{
    bindgen_prelude::{JsValue as _, Unknown},
    sys, Env, Result,
};
use napi_derive::napi;
use serde_json::Value;
use std::path::Path;
fn input(env: Env, value: Unknown<'_>) -> Result<Value> {
    Ok(multicc_core::js::serde::to_serde(&unsafe {
        crate::js_bridge::read_value(env.raw(), value.raw(), 0, &mut Vec::new())
    }?))
}
fn output(env: Env, value: &Value) -> Result<sys::napi_value> {
    unsafe { crate::js_bridge::write_value(env.raw(), &multicc_core::js::serde::from_serde(value)) }
}
#[napi]
pub fn provider_usage_stats(
    env: Env,
    root: String,
    providers: Unknown<'_>,
) -> Result<sys::napi_value> {
    let providers = input(env, providers)?;
    output(
        env,
        &multicc_core::provider_usage::usage(
            Path::new(&root),
            providers.as_array().map(Vec::as_slice).unwrap_or_default(),
        ),
    )
}
#[napi]
pub fn provider_daily_windows(env: Env, root: String) -> Result<sys::napi_value> {
    output(
        env,
        &multicc_core::provider_usage::daily_windows(Path::new(&root)),
    )
}
#[napi]
pub fn provider_wire_model(
    env: Env,
    model: Unknown<'_>,
    opts: Unknown<'_>,
) -> Result<sys::napi_value> {
    output(
        env,
        &multicc_core::provider_routing::wire_model(&input(env, model)?, &input(env, opts)?),
    )
}
#[napi]
pub fn provider_valid_model(
    env: Env,
    kind: String,
    model: String,
    summary: Unknown<'_>,
) -> Result<bool> {
    Ok(multicc_core::provider_routing::valid_model(
        &kind,
        &model,
        &input(env, summary)?,
    ))
}
#[napi]
pub fn provider_vendor_home(root: String, lane: String, session: String) -> Result<String> {
    multicc_core::provider_routing::vendor::home(Path::new(&root), &lane, &session)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(napi::Error::from_reason)
}
#[napi]
pub fn provider_vendor_route(
    env: Env,
    lane: String,
    row: Unknown<'_>,
    summary: Unknown<'_>,
    session: Unknown<'_>,
    root: String,
    limits: Unknown<'_>,
) -> Result<sys::napi_value> {
    use crate::route_response::*;
    let limits = L::new(&env, limits);
    output(
        env,
        &vendor_plan(
            &lane,
            &input(env, row)?,
            &input(env, summary)?,
            &input(env, session)?,
            Path::new(&root),
            limits,
        )?,
    )
}
fn vendor_plan(
    lane: &str,
    row: &Value,
    summary: &Value,
    session: &Value,
    root: &Path,
    limits: crate::route_response::L<'_>,
) -> Result<Value> {
    use crate::route_response::*;
    multicc_core::provider_routing::vendor::build(lane, row, summary, session, root, |name| {
        let value = call(
            limits,
            c"resolveLimit",
            &[text(limits, name).map_err(|e| e.reason)?],
        )
        .map_err(|e| e.reason)?;
        registry::data(value).map_err(|e| e.reason)
    })
    .map_err(napi::Error::from_reason)
}
#[napi]
pub fn provider_aux_target(
    env: Env,
    protocol: String,
    id: String,
    row: Unknown<'_>,
    summary: Unknown<'_>,
    port: String,
    official: bool,
) -> Result<sys::napi_value> {
    output(
        env,
        &multicc_core::provider_routing::targets::aux(
            &protocol,
            &id,
            &input(env, row)?,
            &input(env, summary)?,
            &port,
            official,
        ),
    )
}
#[napi]
pub fn provider_balance_target(env: Env, row: Unknown<'_>, id: String) -> Result<sys::napi_value> {
    output(
        env,
        &multicc_core::provider_routing::targets::balance(&input(env, row)?, &id),
    )
}
#[napi]
pub fn provider_import_token(
    env: Env,
    kind: String,
    row: Unknown<'_>,
    port: String,
) -> Result<String> {
    Ok(multicc_core::provider_routing::targets::import_token(
        &kind,
        &input(env, row)?,
        &port,
    ))
}
#[napi]
pub fn provider_cli_relay(
    env: Env,
    kind: String,
    row: Unknown<'_>,
    force: bool,
    port: String,
) -> Result<sys::napi_value> {
    output(
        env,
        &multicc_core::provider_routing::targets::relay(&kind, &input(env, row)?, force, &port),
    )
}
#[napi]
pub fn provider_apply_relay_catalog(
    env: Env,
    provider: Unknown<'_>,
    options: Unknown<'_>,
    now: f64,
) -> Result<sys::napi_value> {
    use crate::route_response::L;
    let row = L::new(&env, provider);
    let delta = multicc_core::provider_routing::import::catalog(
        &input(env, provider)?,
        &input(env, options)?,
        now,
    )
    .map_err(napi::Error::from_reason)?;
    let delta = L::from_raw(env.raw(), output(env, &delta)?);
    row.assign(c"settingsConfig", delta.get(c"settingsConfig")?)?;
    row.assign(c"relayModelCatalog", delta.get(c"relayModelCatalog")?)?;
    Ok(delta.get(c"result")?.raw())
}
mod registry;
#[napi]
pub fn provider_claude_routing_facts(env: Env, row: Unknown<'_>) -> Result<sys::napi_value> {
    let row = input(env, row)?;
    let (token, view) = multicc_core::provider_routing::spawn::claude_route(&row);
    let cfg = multicc_core::provider_routing::config(&row);
    output(
        env,
        &serde_json::json!({"hasToken":token,"storedBase":multicc_core::js::serde::truthy(&cfg["env"]["ANTHROPIC_BASE_URL"]),"settings":view}),
    )
}
mod environment;
#[napi]
pub fn provider_anthropic_routing_keys() -> Vec<&'static str> {
    environment::ROUTING.to_vec()
}
#[napi]
pub fn provider_initial_selection(
    env: Env,
    records: Unknown<'_>,
    defaults: Unknown<'_>,
) -> Result<sys::napi_value> {
    output(
        env,
        &multicc_core::provider_catalog::initial_selection(
            &input(env, records)?,
            &input(env, defaults)?,
        ),
    )
}

mod proxy;
