//! `GET/HEAD /api/providers/limit-history` (was
//! src/routes/provider-limit-history.js): per-provider quota trend series for
//! the provider cards. Parameter semantics and the response shape live in
//! `multicc_core::provider_limit_history`, the identity list in
//! `multicc_core::provider_catalog`, and the SQLite kernel in
//! `multicc_core::quota_history` (the same one the Node adapter opened through
//! napi). This file owns the file handle, the permanent "unavailable" verdict
//! and the chmod the Node adapter did on first open.
use std::path::Path;
use std::sync::Mutex;

use multicc_core::quota_history::{History, DEFAULT_RETENTION_MS};
use multicc_core::{provider_catalog, provider_limit_history};
use serde_json::{json, Value};

pub const FILE_NAME: &str = "provider-quota-history.db";

/// The adapter opened the database on the first method call and, once that
/// failed, never retried in this process; the same lifetime applies here.
#[derive(Default)]
pub struct State {
    history: Option<History>,
    unavailable: bool,
}

impl State {
    fn ensure(&mut self, file: &Path) -> bool {
        if self.history.is_some() {
            return true;
        }
        if self.unavailable {
            return false;
        }
        match History::open(&file.to_string_lossy(), Some(DEFAULT_RETENTION_MS)) {
            Ok(history) => {
                self.history = Some(history);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    // The Node adapter chmod'd the file after its first open;
                    // failing here must not make the store unavailable.
                    let _ = std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600));
                }
                true
            }
            Err(_) => {
                self.unavailable = true;
                false
            }
        }
    }
}

/// Answers the route. `home` is `$HOME` (the official-account directory is
/// fixed at `<HOME>/.multicc/official-accounts`).
pub fn get(
    data_root: &Path,
    home: &Path,
    original_url: &str,
    now_ms: i64,
    state: &mut State,
) -> Value {
    let params = provider_limit_history::params(original_url);
    let since = provider_limit_history::since_ms(&params, now_ms);
    let points = params.points;
    if !state.ensure(&data_root.join(FILE_NAME)) {
        return provider_limit_history::unavailable_response(now_ms, since, points);
    }
    let identities = provider_catalog::identities(data_root, home, &params.app_type, &params.id);
    let providers = if identities.is_empty() {
        // The adapter answered null without querying the kernel.
        json!({})
    } else {
        let input = provider_limit_history::kernel_input(&identities, since, points);
        let history = state.history.as_mut().expect("opened above");
        match history.query(&input) {
            // The adapter swallowed query errors into null.
            Ok(output) => provider_limit_history::providers_of(&output),
            Err(_) => json!({}),
        }
    };
    provider_limit_history::available_response(now_ms, since, points, providers)
}

/// The adapter's `recordEntry`/lazy open lived in Node; the handle lives in
/// [`State`] for the gateway's lifetime, like the adapter's.
pub type Shared = Mutex<State>;
