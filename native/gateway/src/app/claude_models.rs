//! `GET/HEAD/OPTIONS /api/claude/models` (was src/routes/claude-models.js).
//!
//! Everything that decides the answer lives in
//! `multicc_core::claude_models`; this file owns the in-process cache slot and
//! the cross-process copy that `listClaudeModelsSync()` reads on the Node side
//! (spawn/list hot paths cannot wait for a 300MB bundle scan). The cache file
//! is written only after a successful `cli` scan and never on the fallback, so
//! a failed write can only make the sync reader fall back — it is logged and
//! otherwise ignored, like a read of a corrupt file.
use std::path::Path;
use std::sync::Mutex;

use multicc_core::claude_models::{self, Cache, CACHE_FILE_NAME};
use serde_json::{json, Value};

/// Node kept this list in module state for the process lifetime. Requests are
/// serialized on `App::store_lock` (a blocking mutex held across the scan), so
/// a burst of N concurrent requests scans once and answers the rest from cache,
/// exactly like the single-threaded Node event loop.
#[derive(Default)]
pub struct State {
    cache: Option<Cache>,
}

pub type Shared = Mutex<State>;

fn write_cache_file(data_root: &Path, cache: &Cache) {
    let target = data_root.join(CACHE_FILE_NAME);
    if let Err(error) =
        multicc_core::state_file::write_json_atomic(&target, &claude_models::cache_document(cache))
    {
        // The route is unaffected; only the Node-side synchronous reader falls
        // back to the static list until the next gateway scan.
        crate::app::express::log_line(
            "warn",
            "claude_models_cache_write_failed",
            &[
                ("path", json!(target.to_string_lossy())),
                ("error", json!(error.to_string())),
            ],
        );
    }
}

/// Answers the route for one request. `now_ms` is the gateway clock, not a
/// stamp: the TTL boundary is judged when the request arrives and the cache's
/// `at` is taken once the scan finishes, like Node's two `Date.now()` reads.
pub fn get(
    data_root: &Path,
    home: &Path,
    original_url: &str,
    now_ms: fn() -> i64,
    state: &mut State,
) -> Value {
    let force = claude_models::force_refresh(&multicc_core::http_gate::query_value(
        original_url,
        "refresh",
    ));
    let bundle = claude_models::resolve_bundle(home);
    let answer = claude_models::answer(&mut state.cache, &bundle, force, now_ms);
    if let Some(stored) = answer.stored.as_ref() {
        write_cache_file(data_root, stored);
    }
    json!({
        "models": answer.models,
        "source": answer.source.as_str(),
        "cached": answer.source == claude_models::Source::Cache,
    })
}
