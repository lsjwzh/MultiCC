//! Routes the front door answers itself instead of forwarding to Node.
//!
//! Each one replaced a Node route that was deleted in the same change, so it
//! keeps that route's whole contract: the auth gate in front of it
//! (`multicc_core::http_gate`), Express's response behavior ([`express`]),
//! and the route's own request/response shapes. docs/gateway.md §8 lists
//! them and the few documented differences.

pub mod accept;
pub mod auth;
pub mod download;
pub mod express;
pub mod external_workspaces;
pub mod provider_limit_history;
pub mod quota_guard;
pub mod run_config_presets;
mod service_transport;
pub mod services;
pub mod source_workspaces;
pub mod uploads;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{Method, Request, Response};
use multicc_core::download_ticket::DownloadTickets;
use multicc_core::http_gate::{self, GateDecision, GatePolicy, GateRequest};
use multicc_core::js::string::js_trim;
use multicc_core::network_policy::{env_enabled, NetworkPolicy};

use crate::args::ServeOptions;
use express::RequestCtx;

/// A native route, matched the way Express matched the Node one:
/// case-insensitive, one optional trailing slash, raw (undecoded) path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Auth(auth::Route),
    Services(services::Route),
    ExternalWorkspaces(external_workspaces::Route),
    SourceWorkspaces(source_workspaces::Route),
    QuotaGuardGet,
    QuotaGuardPut,
    QuotaGuardOptions,
    ProviderLimitHistoryGet,
    ProviderLimitHistoryOptions,
    PresetsGet,
    PresetsPut,
    PresetsOptions,
    PresetsMerge,
    PresetsMergeOptions,
    DownloadTicket,
    DownloadTicketOptions,
    Download,
    DownloadOptions,
    UploadStats,
    UploadStatsOptions,
    UploadCleanup,
    UploadCleanupOptions,
}

/// The routes this front door owns. Anything else (including other methods
/// on these paths, which Express would have passed on) goes to Node.
///
/// Only paths with the exact-case `/api/` prefix are claimed: Node's auth
/// gate and JSON gzip test `req.path.startsWith('/api/')` case-sensitively,
/// and a differently-cased prefix took other branches there.
pub fn claim(method: &Method, path: &str) -> Option<Route> {
    if let Some(route) = source_workspaces::claim(method, path) {
        return Some(Route::SourceWorkspaces(route));
    }
    if let Some(route) = external_workspaces::claim(method, path) {
        return Some(Route::ExternalWorkspaces(route));
    }
    if let Some(route) = services::claim(path) {
        return Some(Route::Services(route));
    }
    if let Some(route) = auth::claim(method, path) {
        return Some(Route::Auth(route));
    }
    let rest = path.strip_prefix("/api/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest).to_ascii_lowercase();
    match (rest.as_str(), method.as_str()) {
        ("settings/quota-guard", "GET" | "HEAD") => Some(Route::QuotaGuardGet),
        ("settings/quota-guard", "PUT") => Some(Route::QuotaGuardPut),
        ("settings/quota-guard", "OPTIONS") => Some(Route::QuotaGuardOptions),
        ("providers/limit-history", "GET" | "HEAD") => Some(Route::ProviderLimitHistoryGet),
        ("providers/limit-history", "OPTIONS") => Some(Route::ProviderLimitHistoryOptions),
        ("run-config/presets", "GET" | "HEAD") => Some(Route::PresetsGet),
        ("run-config/presets", "PUT") => Some(Route::PresetsPut),
        ("run-config/presets", "OPTIONS") => Some(Route::PresetsOptions),
        ("run-config/presets/merge", "POST") => Some(Route::PresetsMerge),
        ("run-config/presets/merge", "OPTIONS") => Some(Route::PresetsMergeOptions),
        ("auth/download-ticket", "POST") => Some(Route::DownloadTicket),
        ("auth/download-ticket", "OPTIONS") => Some(Route::DownloadTicketOptions),
        ("download", "GET" | "HEAD") => Some(Route::Download),
        ("download", "OPTIONS") => Some(Route::DownloadOptions),
        ("uploads/stats", "GET" | "HEAD") => Some(Route::UploadStats),
        ("uploads/stats", "OPTIONS") => Some(Route::UploadStatsOptions),
        ("uploads/cleanup", "DELETE") => Some(Route::UploadCleanup),
        ("uploads/cleanup", "OPTIONS") => Some(Route::UploadCleanupOptions),
        _ => None,
    }
}

pub struct App {
    /// Static assets ship beside the canonical server entry, not the data root.
    pub public_dir: PathBuf,
    /// `MULTICC_PATHS.root` (src/paths.js `resolveDataDir`).
    pub data_root: PathBuf,
    pub services: std::sync::OnceLock<Arc<services::Runtime>>,
    pub external_workspaces:
        std::sync::OnceLock<Arc<multicc_core::workspace_sharing::external::Runtime>>,
    pub auth: Arc<crate::auth_control::Bridge>,
    pub source_workspaces: Arc<crate::auth_control::Bridge>,
    pub lan_only: bool,
    pub allow_legacy_token_query: bool,
    /// Node handled each of these requests to completion on one thread; the
    /// read-modify-write of a store must not interleave here either.
    store_lock: Mutex<()>,
    pub tickets: Mutex<DownloadTickets>,
    /// One quota-history handle per process, like the Node adapter: the first
    /// failed open is permanent (src/quota/provider-quota-history.js).
    pub provider_limit_history: provider_limit_history::Shared,
    /// `os.homedir()`: the official-account store lives under it.
    pub home_dir: PathBuf,
    /// The Node child's `process.cwd()` (physical path): what `path.resolve`
    /// resolves a relative download path against.
    pub node_cwd: String,
}

/// `process.cwd()` of a child started in `dir`: getcwd(3) reports the
/// physical path, so symlinks are resolved; Windows drops the `\\?\` prefix.
fn physical_dir(dir: &Path) -> String {
    let real = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let text = real.to_string_lossy().into_owned();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if cfg!(windows) && rest.as_bytes().get(1) == Some(&b':') => rest.to_string(),
        _ => text,
    }
}

fn env_text(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

impl App {
    /// The Node package root is the directory of the script we run (Node's
    /// `__dirname` resolves symlinks, so canonicalize like it does).
    pub fn package_root(options: &ServeOptions) -> PathBuf {
        let script = options.cwd.join(&options.script);
        std::fs::canonicalize(&script)
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| options.cwd.clone())
    }

    pub fn from_env(options: &ServeOptions, policy: &NetworkPolicy) -> Self {
        let package_root = Self::package_root(options);
        let raw_data = env_text("MULTICC_DATA_DIR");
        let raw_data = js_trim(&raw_data);
        let data_root = if raw_data.is_empty() {
            package_root.clone()
        } else {
            package_root.join(raw_data)
        };
        Self {
            public_dir: package_root.join("public"),
            data_root,
            services: std::sync::OnceLock::new(),
            external_workspaces: std::sync::OnceLock::new(),
            auth: Arc::new(crate::auth_control::Bridge::default()),
            source_workspaces: Arc::new(crate::auth_control::Bridge::default()),
            lan_only: policy.lan_only,
            allow_legacy_token_query: env_enabled(&env_text("MULTICC_ALLOW_LEGACY_TOKEN_QUERY")),
            store_lock: Mutex::new(()),
            tickets: Mutex::new(DownloadTickets::new()),
            provider_limit_history: Mutex::new(provider_limit_history::State::default()),
            home_dir: std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default(),
            node_cwd: physical_dir(&options.cwd),
        }
    }

    fn gate(
        &self,
        ctx: &RequestCtx,
        peer: &str,
        snapshot: &multicc_core::auth_runtime::Snapshot,
    ) -> Option<Response<Body>> {
        let policy = GatePolicy {
            access_token: snapshot.secret.clone(),
            lan_only: self.lan_only,
            allow_legacy_token_query: self.allow_legacy_token_query,
        };
        let now_ms = now_ms();
        let request = GateRequest {
            method: ctx.method.as_str(),
            path: &ctx.path,
            original_url: &ctx.original_url,
            peer,
            headers: &ctx.headers,
            now_ms,
        };
        let root = self.data_root.to_string_lossy().into_owned();
        let decision = http_gate::authorize(
            &policy,
            &request,
            |credential| {
                multicc_core::machines::authorize(
                    &root,
                    credential,
                    ctx.method.as_str(),
                    &ctx.original_url,
                )
                .is_some()
            },
            |ticket| {
                self.tickets
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .verify(ticket, &ctx.original_url, now_ms)
            },
        );
        match decision {
            GateDecision::Allow => None,
            GateDecision::PeerRejected => Some(express::json(
                ctx,
                403,
                &http_gate::public_peer_rejected_dto(&ctx.ids),
                &[],
            )),
            GateDecision::AuthRequired => Some(express::json(
                ctx,
                403,
                &http_gate::auth_required_dto(&ctx.ids),
                &[],
            )),
            GateDecision::LoginRedirect(location) => Some(express::redirect(ctx, &location)),
        }
    }
}

/// `Date.now()`.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// Express's automatic OPTIONS answer for a path with these methods.
fn options(ctx: &RequestCtx, allow: &str) -> Response<Body> {
    express::send(
        ctx,
        200,
        "text/html; charset=utf-8",
        allow.as_bytes().to_vec(),
        &[("Allow", allow)],
    )
}

/// Answers `route`: the auth gate, then `express.json`, then the handler.
pub async fn handle(
    app: Arc<App>,
    route: Route,
    request: Request<Body>,
    client: SocketAddr,
) -> Response<Body> {
    if let Route::ExternalWorkspaces(route) = route {
        return external_workspaces::handle(app, route, request, client).await;
    }
    if let Route::Services(route) = route {
        return services::handle(app, route, request, client).await;
    }
    let (parts, body) = request.into_parts();
    let ctx = RequestCtx::new(&parts);
    // src/gateway-child.js hands Node the PROXY line's address text, which is
    // this Display form (IPv4-mapped IPv6 included).
    let peer = client.ip().to_string();
    let snapshot = match app.auth.snapshot().await {
        Ok(snapshot) => snapshot,
        Err(_) => return express::error(&ctx, 503, "authentication runtime unavailable"),
    };
    if snapshot.shutting_down
        && (ctx.path.to_ascii_lowercase().starts_with("/api/")
            || ctx.path.eq_ignore_ascii_case("/api"))
    {
        return express::json(
            &ctx,
            503,
            &http_gate::error_dto(
                "SERVER_SHUTTING_DOWN",
                "server is shutting down",
                &[],
                &ctx.ids,
            ),
            &[("Retry-After", "1")],
        );
    }
    if let Route::Auth(route) = route {
        return auth::handle(&app, route, &ctx, body, &peer, snapshot).await;
    }
    if let Route::SourceWorkspaces(route) = route {
        return source_workspaces::handle(&app, route, &ctx, &peer, body, snapshot).await;
    }
    if let Some(refusal) = app.gate(&ctx, &peer, &snapshot) {
        return refusal;
    }
    // The ticket route sits in front of the global `express.json` with its
    // own `express.json({ limit: '4kb' })`; everything else gets the global one.
    let limit = match route {
        Route::DownloadTicket => 4 * 1024,
        _ => express::JSON_LIMIT,
    };
    let body = match express::json_body(&ctx, body, limit).await {
        Ok(value) => value,
        Err(error) => return express::error(&ctx, error.status, error.reason),
    };
    match route {
        Route::PresetsOptions | Route::QuotaGuardOptions => return options(&ctx, "GET,HEAD,PUT"),
        Route::PresetsMergeOptions | Route::DownloadTicketOptions => return options(&ctx, "POST"),
        Route::DownloadOptions | Route::UploadStatsOptions | Route::ProviderLimitHistoryOptions => {
            return options(&ctx, "GET,HEAD")
        }
        Route::UploadCleanupOptions => return options(&ctx, "DELETE"),
        Route::DownloadTicket => {
            let (status, value) = download::issue(&app, &body, now_ms());
            let extra: &[(&str, &str)] = if status == 200 {
                &[("Cache-Control", "no-store")]
            } else {
                &[]
            };
            return express::json(&ctx, status, &value, extra);
        }
        Route::Download => return download::download(&app, &ctx).await,
        _ => {}
    }
    let worker = Arc::clone(&app);
    let original_url = ctx.original_url.clone();
    let answered = tokio::task::spawn_blocking(move || {
        let _held = worker.store_lock.lock().unwrap_or_else(|e| e.into_inner());
        let root = &worker.data_root;
        if route == Route::ProviderLimitHistoryGet {
            let mut state = worker
                .provider_limit_history
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let value = provider_limit_history::get(
                root,
                &worker.home_dir,
                &original_url,
                now_ms(),
                &mut state,
            );
            return (200, multicc_core::js::serde::js_json_stringify(&value));
        }
        // Keep this route's saved JSON lossless: unknown fields can contain
        // UTF-16 surrogates which serde_json::Value cannot represent.
        if matches!(route, Route::QuotaGuardGet | Route::QuotaGuardPut) {
            let (status, value) = match route {
                Route::QuotaGuardGet => quota_guard::get(root),
                _ => quota_guard::put(root, &body),
            };
            return (status, multicc_core::js::json_stringify(&value).unwrap());
        }
        let (status, value) = match route {
            Route::PresetsGet => run_config_presets::get(root),
            Route::PresetsPut => run_config_presets::put(root, &body),
            Route::PresetsMerge => run_config_presets::merge(root, &body),
            Route::UploadStats => uploads::stats(),
            Route::UploadCleanup => uploads::cleanup(),
            _ => unreachable!("answered above"),
        };
        (status, multicc_core::js::serde::js_json_stringify(&value))
    })
    .await;
    match answered {
        Ok((status, text)) => {
            // The Node route set this before its availability check, so 304s
            // carry it too.
            let extra: &[(&str, &str)] = if route == Route::ProviderLimitHistoryGet {
                &[("Cache-Control", "no-store")]
            } else {
                &[]
            };
            express::send(
                &ctx,
                status,
                "application/json; charset=utf-8",
                text.into_bytes(),
                extra,
            )
        }
        Err(_) => express::error(&ctx, 500, "native route panicked"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_follow_express_matching() {
        assert_eq!(
            claim(&Method::GET, "/api/Settings/Quota-Guard/"),
            Some(Route::QuotaGuardGet)
        );
        assert_eq!(
            claim(&Method::PUT, "/api/settings/quota-guard"),
            Some(Route::QuotaGuardPut)
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/settings/quota-guard"),
            Some(Route::QuotaGuardOptions)
        );
        assert_eq!(claim(&Method::GET, "/API/settings/quota-guard"), None);
        assert_eq!(claim(&Method::GET, "/api/settings/quota-guard//"), None);
        assert_eq!(claim(&Method::POST, "/api/settings/quota-guard"), None);
        assert_eq!(
            claim(&Method::GET, "/api/providers/limit-history"),
            Some(Route::ProviderLimitHistoryGet)
        );
        assert_eq!(
            claim(&Method::HEAD, "/api/Providers/Limit-History/"),
            Some(Route::ProviderLimitHistoryGet)
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/providers/limit-history"),
            Some(Route::ProviderLimitHistoryOptions)
        );
        assert_eq!(claim(&Method::POST, "/api/providers/limit-history"), None);
        assert_eq!(claim(&Method::GET, "/api/providers/limit-history//"), None);
        assert_eq!(claim(&Method::GET, "/API/providers/limit-history"), None);
        assert_eq!(
            claim(&Method::GET, "/api/run-config/presets"),
            Some(Route::PresetsGet)
        );
        assert_eq!(
            claim(&Method::HEAD, "/api/Run-Config/Presets/"),
            Some(Route::PresetsGet)
        );
        assert_eq!(
            claim(&Method::PUT, "/api/run-config/presets"),
            Some(Route::PresetsPut)
        );
        assert_eq!(
            claim(&Method::POST, "/api/run-config/presets/merge"),
            Some(Route::PresetsMerge)
        );
        assert_eq!(claim(&Method::POST, "/api/run-config/presets"), None);
        assert_eq!(claim(&Method::GET, "/api/run-config/presets//"), None);
        assert_eq!(claim(&Method::GET, "/API/run-config/presets"), None);
        assert_eq!(claim(&Method::GET, "/api/run%2Dconfig/presets"), None);
        assert_eq!(
            claim(&Method::HEAD, "/api/Download/"),
            Some(Route::Download)
        );
        assert_eq!(claim(&Method::POST, "/api/download"), None);
        assert_eq!(
            claim(&Method::POST, "/api/auth/download-ticket"),
            Some(Route::DownloadTicket)
        );
        assert_eq!(claim(&Method::GET, "/api/auth/download-ticket"), None);
        assert_eq!(
            claim(&Method::DELETE, "/api/uploads/cleanup"),
            Some(Route::UploadCleanup)
        );
        assert_eq!(claim(&Method::GET, "/api/uploads/cleanup"), None);
        assert_eq!(claim(&Method::GET, "/api/files"), None);
        assert_eq!(claim(&Method::POST, "/api/upload"), None);
    }
}
