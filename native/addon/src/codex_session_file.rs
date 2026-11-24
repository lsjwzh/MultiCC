use napi_derive::napi;
use std::path::Path;

#[napi]
pub async fn codex_find_session_id_json(
    cwd: String,
    since_ms: f64,
    root: String,
) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || {
        multicc_core::codex_session_file::find_session_id(&cwd, since_ms, Path::new(&root))
            .unwrap_or_else(|| "null".to_owned())
    })
    .await
    .map_err(|error| napi::Error::from_reason(error.to_string()))
}
