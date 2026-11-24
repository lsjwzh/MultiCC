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
