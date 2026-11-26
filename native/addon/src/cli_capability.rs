use crate::route_response::*;
use napi_derive::napi;

/// The CLI catalogue and every view derived from it, as one JSON document.
/// `src/cli/cli-capability.js` reads it once at load and freezes it.
#[napi]
pub fn cli_catalog() -> napi::Result<String> {
    multicc_core::cli_capability::catalog().map_err(napi::Error::from_reason)
}

#[napi]
pub fn cli_supports_effort(cli: String, model: String, level: String) -> bool {
    multicc_core::cli_capability::supports_effort(&cli, &model, &level)
}

#[napi]
pub fn cli_legacy_claude_effort(model: Option<String>) -> Option<String> {
    multicc_core::cli_capability::legacy_claude_effort(model.as_deref().unwrap_or(""))
        .map(str::to_owned)
}

pub(crate) fn legacy_effort_value(
    model: crate::js_live::LiveValue<'_>,
) -> napi::Result<crate::js_live::LiveValue<'_>> {
    use multicc_core::js::JsValue;
    let level = cli_legacy_claude_effort(model.string()?.map(|s| s.to_string_lossy()));
    model.from_value(&level.map(JsValue::from).unwrap_or(JsValue::Null))
}

#[napi]
pub fn cli_effort_catalog() -> napi::Result<String> {
    serde_json::to_string(&multicc_core::effort_catalog::snapshot().efforts)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn cli_codex_reasoning_level(
    cli: String,
    level: String,
    model: Option<String>,
) -> Option<String> {
    multicc_core::codex_provider_home::reasoning_level(&cli, &level, model.as_deref())
}

#[napi]
pub fn cli_known_effort(level: String) -> bool {
    multicc_core::effort_catalog::snapshot()
        .efforts
        .values()
        .any(|spec| spec.levels.contains(&level))
}

#[napi]
pub async fn cli_reload_effort_catalog(file: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        multicc_core::effort_catalog::reload(std::path::Path::new(&file))
    })
    .await
    .map_err(|e| napi::Error::from_reason(e.to_string()))?
    .map_err(napi::Error::from_reason)
}

// require.resolve 与 fs 端口保留 Node 的包导出、符号链接和路径语义。
#[napi]
pub fn cli_bundled_claude_binary(
    env: Env,
    override_path: Unknown<'_>,
    platform: String,
    arch: String,
    resolve: Unknown<'_>,
    path: Unknown<'_>,
    exists: Unknown<'_>,
) -> Result<sys::napi_value> {
    let configured = L::new(&env, override_path);
    let exists = L::new(&env, exists);
    if configured.truthy()? && exists.call_plain(&[configured])?.truthy()? {
        return Ok(configured.raw());
    }
    let path = L::new(&env, path);
    let resolve = L::new(&env, resolve);
    let exe = text(path, multicc_core::claude_models::sdk_executable(&platform))?;
    for name in multicc_core::claude_models::sdk_packages(&platform, &arch) {
        let found = path.catch(|| {
            let manifest = resolve.call_plain(&[text(path, &format!("{name}/package.json"))?])?;
            let dir = call(path, c"dirname", &[manifest])?;
            let binary = call(path, c"join", &[dir, exe])?;
            Ok(exists.call_plain(&[binary])?.truthy()?.then_some(binary))
        })?;
        if let Some(binary) = found.flatten() {
            return Ok(binary.raw());
        }
    }
    Ok(null(path)?.raw())
}

#[napi]
pub fn cli_availability_summary(
    env: Env,
    clis: Unknown<'_>,
    commands: Unknown<'_>,
    bundled: Unknown<'_>,
    providers: Unknown<'_>,
    available: Unknown<'_>,
) -> Result<sys::napi_value> {
    let clis = L::new(&env, clis);
    let commands = L::new(&env, commands);
    let bundled = L::new(&env, bundled);
    let providers = L::new(&env, providers);
    let available = L::new(&env, available);
    let summary = fields(clis, &[])?;
    clis.for_each(|cli| {
        let value = if cli.is_string("claude")? {
            clis.catch(|| {
                if bundled.call_plain(&[])?.nullish()? {
                    call(providers, c"hasCliRelayProvider", &[cli])
                } else {
                    flag(clis, true)
                }
            })?
            .unwrap_or(flag(clis, false)?)
        } else {
            available.call_plain(&[commands.get_key(cli)?])?
        };
        summary.set_key(cli, fields(clis, &[("available", value)])?)
    })?;
    Ok(summary.raw())
}
