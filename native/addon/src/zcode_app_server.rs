//! ZCode session/event protocol owner. No vendor process is launched here.
//! Live handles retain tool-input identity and JS UTF-16 strings; all protocol
//! decisions, state transitions and output ordering execute in Rust.
mod mapper;
mod model;
mod tracker;

use crate::host_api::*;
use napi_derive::napi;

#[napi]
pub fn zcode_app_server_api(e: Env, process: Unknown<'_>) -> Result<sys::napi_value> {
    let process = L::new(&e, process);
    let methods = defaulted_methods(
        process,
        &[
            ("tokensOfUsage", 1, 1, |_, a| model::tokens(a[0])),
            ("buildRuntimeModel", 2, 2, |_, a| model::runtime(a[0], a[1])),
            ("createZcodeTurnMapper", 0, 1, |_, a| mapper::create(a[0])),
            ("createBackgroundTaskTracker", 0, 1, tracker::create),
        ],
    )?;
    let api = fields(process, &[])?;
    let preferences = fields(
        process,
        &[
            ("nativeSearchEnhancementsEnabled", flag(process, true)?),
            ("memoryEnabled", flag(process, false)?),
            ("askUserQuestionAutoResolutionEnabled", flag(process, true)?),
            ("modelContextBudgetStrategy", text(process, "preflight-v1")?),
        ],
    )?
    .freeze()?;
    api.set(c"RUNTIME_PREFERENCES", preferences)?;
    for (key, value) in [
        (c"DEFAULT_MODE", "yolo"),
        (c"DELIVERY_KIND", "web-remote-replayable"),
        (c"PROTOCOL_CLIENT_ID", "multicc-zcode-bridge"),
        (c"TERMINAL_ERROR_CODE", "zcode_terminal_error"),
        (c"INVALID_SESSION_CODE", "zcode_invalid_session_id"),
    ] {
        api.set(key, text(process, value)?)?;
    }
    api.spread_from(methods)?;
    Ok(api.raw())
}
