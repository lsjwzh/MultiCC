//! Routes the front door answers itself instead of forwarding to Node.
//!
//! Each one replaced a Node route that was deleted in the same change, so it
//! keeps that route's whole contract: the auth gate in front of it
//! (`multicc_core::http_gate`), Express's response behavior ([`express`]),
//! and the route's own request/response shapes. docs/gateway.md §8 lists
//! them and the few documented differences.

pub mod accept;
pub mod account_subscription;
pub mod agent_resources;
pub mod auth;
pub mod claude_models;
pub mod download;
pub mod express;
pub mod external_workspaces;
pub mod file_transfer;
pub mod host_read;
pub mod model_catalogs;
pub mod provider_limit_history;
pub mod quota_guard;
pub mod run_config_presets;
pub mod secrets_vault;
mod service_transport;
pub mod services;
pub mod source_workspaces;
pub mod subagent_defaults;
pub mod token_usage_by_role;
pub mod token_usage_global;
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
    ClaudeModelsGet,
    ClaudeModelsOptions,
    ClaudeSubscriptionGet,
    ClaudeSubscriptionOptions,
    CodexSubscriptionGet,
    CodexSubscriptionOptions,
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
    TokenUsageGlobalGet,
    TokenUsageGlobalOptions,
    TokenUsageByRoleGet,
    TokenUsageByRoleOptions,
    SubagentDefaultsGet,
    SubagentDefaultsOptions,
    SubagentDefaultsSync,
    SubagentDefaultsSyncOptions,
    ModelCatalogGet(model_catalogs::Catalog),
    ModelCatalogOptions(model_catalogs::Catalog),
    ProviderModelsGet,
    ProviderModelsOptions,
    CodexModelsGet,
    CodexModelsOptions,
    CodexModelsSync,
    CodexModelsSyncOptions,
    AgentResourcesSkills,
    AgentPresets,
    AgentPreset,
    AgentClaudeSessions,
    AgentClaudeSessionDelete,
    AgentClaudeSessionsPurge,
    AgentResourcesOptionsGet,
    AgentResourcesOptionsDelete,
    /// `/api/agent-resources/claude-sessions` registers both a GET and a
    /// DELETE route, so Express answers OPTIONS with both.
    AgentResourcesOptionsShared,
    SecretsList,
    SecretsCreate,
    SecretsRename,
    SecretsDelete,
    SecretsReveal,
    /// `/api/secrets` registers GET and POST.
    SecretsOptionsCollection,
    SecretsOptionsRename,
    SecretsOptionsItem,
    SecretsOptionsValue,
    HostReadGet(host_read::Route),
    HostReadOptions(host_read::Route),
    FilesGet,
    FilesOptions,
    Upload,
    UploadOptions,
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
    if let Some(route) = model_catalogs::claim(method, path) {
        use model_catalogs::Route as Models;
        return Some(match route {
            Models::CatalogGet(catalog) => Route::ModelCatalogGet(catalog),
            Models::CatalogOptions(catalog) => Route::ModelCatalogOptions(catalog),
            Models::ProviderModelsGet => Route::ProviderModelsGet,
            Models::ProviderModelsOptions => Route::ProviderModelsOptions,
            Models::CodexModelsGet => Route::CodexModelsGet,
            Models::CodexModelsOptions => Route::CodexModelsOptions,
            Models::CodexModelsSync => Route::CodexModelsSync,
            Models::CodexModelsSyncOptions => Route::CodexModelsSyncOptions,
        });
    }
    if let Some(route) = agent_resources::claim(method, path) {
        return Some(route);
    }
    if let Some(route) = secrets_vault::claim(method, path) {
        return Some(route);
    }
    if let Some(claim) = file_transfer::claim(method, path) {
        return Some(match claim {
            file_transfer::Claim::Handle(route) => match route {
                file_transfer::Route::Files => Route::FilesGet,
                file_transfer::Route::Upload => Route::Upload,
            },
            file_transfer::Claim::Options(route) => match route {
                file_transfer::Route::Files => Route::FilesOptions,
                file_transfer::Route::Upload => Route::UploadOptions,
            },
        });
    }
    if let Some(claim) = host_read::claim(method, path) {
        return Some(match claim {
            host_read::Claim::Get(route) => Route::HostReadGet(route),
            host_read::Claim::Options(route) => Route::HostReadOptions(route),
        });
    }
    let rest = path.strip_prefix("/api/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest).to_ascii_lowercase();
    match (rest.as_str(), method.as_str()) {
        ("settings/quota-guard", "GET" | "HEAD") => Some(Route::QuotaGuardGet),
        ("settings/quota-guard", "PUT") => Some(Route::QuotaGuardPut),
        ("settings/quota-guard", "OPTIONS") => Some(Route::QuotaGuardOptions),
        ("providers/limit-history", "GET" | "HEAD") => Some(Route::ProviderLimitHistoryGet),
        ("providers/limit-history", "OPTIONS") => Some(Route::ProviderLimitHistoryOptions),
        ("claude/models", "GET" | "HEAD") => Some(Route::ClaudeModelsGet),
        ("claude/models", "OPTIONS") => Some(Route::ClaudeModelsOptions),
        ("claude/subscription", "GET" | "HEAD") => Some(Route::ClaudeSubscriptionGet),
        ("claude/subscription", "OPTIONS") => Some(Route::ClaudeSubscriptionOptions),
        ("codex/subscription", "GET" | "HEAD") => Some(Route::CodexSubscriptionGet),
        ("codex/subscription", "OPTIONS") => Some(Route::CodexSubscriptionOptions),
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
        ("token-usage/global", "GET" | "HEAD") => Some(Route::TokenUsageGlobalGet),
        ("token-usage/global", "OPTIONS") => Some(Route::TokenUsageGlobalOptions),
        ("token-usage/by-role", "GET" | "HEAD") => Some(Route::TokenUsageByRoleGet),
        ("token-usage/by-role", "OPTIONS") => Some(Route::TokenUsageByRoleOptions),
        ("subagent-defaults", "GET" | "HEAD") => Some(Route::SubagentDefaultsGet),
        ("subagent-defaults", "OPTIONS") => Some(Route::SubagentDefaultsOptions),
        ("subagent-defaults/sync", "POST") => Some(Route::SubagentDefaultsSync),
        ("subagent-defaults/sync", "OPTIONS") => Some(Route::SubagentDefaultsSyncOptions),
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
    /// The extracted model list, kept for the process lifetime like the
    /// retired Node module cache; src/claude-models.js reads the persisted
    /// copy for spawn/list callers.
    pub claude_models: claude_models::Shared,
    /// The global-usage aggregate and its 120s cache (was src/token-global.js).
    pub token_usage_global: token_usage_global::Shared,
    /// One sync request at a time, like the retired Node handler, which ran a
    /// whole request synchronously on the event loop.
    pub subagent_defaults: tokio::sync::Mutex<()>,
    /// The vault answered each request to completion on one thread in Node;
    /// every route here awaits one host round trip, so serialize them.
    pub secrets_vault: tokio::sync::Mutex<()>,
    /// The observation cache the retired Node route wrote, plus the
    /// process-local single-flight table and the system-proxy slot. `Arc` lets
    /// the leader query outlive the HTTP request that started it.
    pub account_subscription: Arc<account_subscription::Shared>,
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
        let subscriptions = Arc::new(account_subscription::Shared::new(&data_root));
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
            claude_models: Mutex::new(claude_models::State::default()),
            token_usage_global: Mutex::new(token_usage_global::State::default()),
            subagent_defaults: tokio::sync::Mutex::new(()),
            secrets_vault: tokio::sync::Mutex::new(()),
            account_subscription: subscriptions,
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
    host: u16,
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
    // multer owns the raw multipart body: the upload route runs in front of the
    // global `express.json` (it applies that step itself for JSON bodies, which
    // is where the retired stack parsed them).
    if let Route::Upload = route {
        return file_transfer::upload(&ctx, body).await;
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
        Route::ModelCatalogOptions(_)
        | Route::ProviderModelsOptions
        | Route::CodexModelsOptions => return options(&ctx, "GET,HEAD"),
        Route::CodexModelsSyncOptions => return options(&ctx, "POST"),
        Route::ModelCatalogGet(catalog) => {
            return model_catalogs::catalog(catalog, &ctx, host).await
        }
        Route::ProviderModelsGet => return model_catalogs::provider(&ctx, host).await,
        Route::CodexModelsGet => return model_catalogs::codex(&ctx, &body, host, false).await,
        Route::CodexModelsSync => return model_catalogs::codex(&ctx, &body, host, true).await,
        Route::AgentResourcesOptionsGet => return options(&ctx, "GET,HEAD"),
        Route::AgentResourcesOptionsDelete => return options(&ctx, "DELETE"),
        Route::AgentResourcesOptionsShared => return options(&ctx, "GET,HEAD,DELETE"),
        Route::AgentResourcesSkills => return agent_resources::skills(&ctx, host).await,
        Route::AgentPresets => return agent_resources::presets(&ctx, host).await,
        Route::AgentPreset => return agent_resources::preset(&ctx, host).await,
        Route::AgentClaudeSessions => return agent_resources::claude_sessions(&ctx, host).await,
        Route::AgentClaudeSessionDelete => {
            return agent_resources::delete_session(&ctx, host).await
        }
        Route::AgentClaudeSessionsPurge => {
            return agent_resources::purge_sessions(&ctx, host).await
        }
        Route::SecretsOptionsCollection => return options(&ctx, "GET,HEAD,POST"),
        Route::SecretsOptionsRename => return options(&ctx, "POST"),
        Route::SecretsOptionsItem => return options(&ctx, "DELETE"),
        Route::SecretsOptionsValue => return options(&ctx, "GET,HEAD"),
        Route::SecretsList => return secrets_vault::list(&app, &ctx, host).await,
        Route::SecretsCreate => return secrets_vault::create(&app, &ctx, &body, host).await,
        Route::SecretsRename => return secrets_vault::rename(&app, &ctx, &body, host).await,
        Route::SecretsDelete => return secrets_vault::remove(&app, &ctx, host).await,
        Route::SecretsReveal => return secrets_vault::reveal(&app, &ctx, host).await,
        Route::PresetsOptions | Route::QuotaGuardOptions => return options(&ctx, "GET,HEAD,PUT"),
        Route::PresetsMergeOptions | Route::DownloadTicketOptions => return options(&ctx, "POST"),
        Route::SubagentDefaultsOptions => return options(&ctx, "GET,HEAD"),
        Route::SubagentDefaultsSyncOptions => return options(&ctx, "POST"),
        Route::DownloadOptions
        | Route::UploadStatsOptions
        | Route::ProviderLimitHistoryOptions
        | Route::ClaudeModelsOptions
        | Route::ClaudeSubscriptionOptions
        | Route::CodexSubscriptionOptions
        | Route::TokenUsageGlobalOptions => return options(&ctx, "GET,HEAD"),
        Route::TokenUsageByRoleOptions => return options(&ctx, "GET,HEAD"),
        Route::HostReadOptions(route) => return options(&ctx, route.allow()),
        Route::FilesOptions => return options(&ctx, file_transfer::Route::Files.allow()),
        Route::UploadOptions => return options(&ctx, file_transfer::Route::Upload.allow()),
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
        // This route scans session transcripts; it must not hold the store
        // lock other read-modify-write routes share.
        Route::TokenUsageGlobalGet => {
            let worker = Arc::clone(&app);
            let original_url = ctx.original_url.clone();
            let answered = tokio::task::spawn_blocking(move || {
                let mut state = worker
                    .token_usage_global
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                token_usage_global::answer(&worker.home_dir, &original_url, now_ms, &mut state)
            })
            .await;
            return match answered {
                Ok((status, text)) => express::send(
                    &ctx,
                    status,
                    "application/json; charset=utf-8",
                    text.into_bytes(),
                    &[],
                ),
                Err(_) => express::error(&ctx, 500, "native route panicked"),
            };
        }
        // The host port is the Node child's internal listener; a route that
        // needs in-process Node state asks it only through that one call.
        Route::TokenUsageByRoleGet => return token_usage_by_role::get(&ctx, host).await,
        Route::HostReadGet(route) => return host_read::handle(&ctx, route, host, &peer).await,
        Route::FilesGet => return file_transfer::files(&ctx, host).await,
        Route::SubagentDefaultsGet => return subagent_defaults::get(&app, &ctx, host).await,
        Route::SubagentDefaultsSync => {
            return subagent_defaults::sync(&app, &ctx, &body, host).await
        }
        Route::ClaudeSubscriptionGet => {
            return account_subscription::get(&app, "claude", &ctx).await
        }
        Route::CodexSubscriptionGet => return account_subscription::get(&app, "codex", &ctx).await,
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
        if route == Route::ClaudeModelsGet {
            let mut state = worker
                .claude_models
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let value =
                claude_models::get(root, &worker.home_dir, &original_url, now_ms, &mut state);
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
        for (path, mixed, get, options) in [
            (
                "/api/claude/subscription",
                "/api/Claude/Subscription/",
                Route::ClaudeSubscriptionGet,
                Route::ClaudeSubscriptionOptions,
            ),
            (
                "/api/codex/subscription",
                "/api/Codex/Subscription/",
                Route::CodexSubscriptionGet,
                Route::CodexSubscriptionOptions,
            ),
        ] {
            assert_eq!(claim(&Method::GET, path), Some(get));
            assert_eq!(claim(&Method::HEAD, mixed), Some(get));
            assert_eq!(claim(&Method::OPTIONS, path), Some(options));
            assert_eq!(claim(&Method::OPTIONS, &format!("{path}/")), Some(options));
            assert_eq!(claim(&Method::POST, path), None);
            assert_eq!(claim(&Method::GET, &format!("{path}//")), None);
            assert_eq!(claim(&Method::GET, &path.replace("/api/", "/API/")), None);
        }
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
        assert_eq!(
            claim(&Method::GET, "/api/token-usage/global"),
            Some(Route::TokenUsageGlobalGet)
        );
        assert_eq!(
            claim(&Method::HEAD, "/api/Token-Usage/Global/"),
            Some(Route::TokenUsageGlobalGet)
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/token-usage/global"),
            Some(Route::TokenUsageGlobalOptions)
        );
        assert_eq!(claim(&Method::POST, "/api/token-usage/global"), None);
        assert_eq!(claim(&Method::GET, "/api/token-usage/global//"), None);
        assert_eq!(claim(&Method::GET, "/API/token-usage/global"), None);
        assert_eq!(
            claim(&Method::GET, "/api/token-usage/by-role"),
            Some(Route::TokenUsageByRoleGet)
        );
        assert_eq!(
            claim(&Method::HEAD, "/api/Token-Usage/By-Role/"),
            Some(Route::TokenUsageByRoleGet)
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/token-usage/by-role"),
            Some(Route::TokenUsageByRoleOptions)
        );
        assert_eq!(claim(&Method::POST, "/api/token-usage/by-role"), None);
        assert_eq!(claim(&Method::GET, "/API/token-usage/by-role"), None);
        assert_eq!(claim(&Method::GET, "/api/token-usage/by-role/x"), None);
        assert_eq!(claim(&Method::GET, "/api/token-usage"), None);
        assert_eq!(claim(&Method::GET, "/api/files"), Some(Route::FilesGet));
        assert_eq!(claim(&Method::HEAD, "/api/Files/"), Some(Route::FilesGet));
        assert_eq!(
            claim(&Method::OPTIONS, "/api/files"),
            Some(Route::FilesOptions)
        );
        assert_eq!(claim(&Method::POST, "/api/files"), None);
        assert_eq!(claim(&Method::GET, "/api/files//"), None);
        assert_eq!(claim(&Method::POST, "/api/upload"), Some(Route::Upload));
        assert_eq!(
            claim(&Method::OPTIONS, "/api/Upload/"),
            Some(Route::UploadOptions)
        );
        assert_eq!(claim(&Method::GET, "/api/upload"), None);
        assert_eq!(claim(&Method::HEAD, "/api/upload"), None);
    }

    #[test]
    fn model_catalog_claims_keep_the_express_shape() {
        use model_catalogs::Catalog;
        for (path, catalog) in [
            ("/api/opencode/models", Catalog::OpenCode),
            ("/api/Qoder/Models/", Catalog::Qoder),
            ("/api/grok/models", Catalog::Grok),
            ("/api/commandcode/models", Catalog::Commandcode),
            ("/api/codebuddy/models", Catalog::Codebuddy),
        ] {
            assert_eq!(
                claim(&Method::GET, path),
                Some(Route::ModelCatalogGet(catalog))
            );
            assert_eq!(
                claim(&Method::HEAD, path),
                Some(Route::ModelCatalogGet(catalog))
            );
            assert_eq!(
                claim(&Method::OPTIONS, path),
                Some(Route::ModelCatalogOptions(catalog))
            );
            assert_eq!(claim(&Method::POST, path), None);
            assert_eq!(claim(&Method::GET, &format!("{path}//")), None);
        }
        // The :id is one segment and keeps its case; the literal segments do
        // not.
        assert_eq!(
            claim(&Method::GET, "/api/Providers/Main/models"),
            Some(Route::ProviderModelsGet)
        );
        assert_eq!(
            model_catalogs::provider_id_from_path("/api/Providers/My%20Relay/models"),
            Some("My Relay".to_string())
        );
        assert_eq!(claim(&Method::GET, "/api/providers//models"), None);
        assert_eq!(claim(&Method::GET, "/api/providers/a/b/models"), None);
        assert_eq!(
            claim(&Method::GET, "/api/codex/models"),
            Some(Route::CodexModelsGet)
        );
        assert_eq!(
            claim(&Method::POST, "/api/codex/models/sync"),
            Some(Route::CodexModelsSync)
        );
        assert_eq!(claim(&Method::GET, "/api/codex/models/sync"), None);
        assert_eq!(claim(&Method::GET, "/api/opencode/models/extra"), None);
    }

    #[test]
    fn agent_resource_claims_keep_the_express_shape() {
        for (path, mixed, route) in [
            (
                "/api/agent-resources/skills",
                "/api/Agent-Resources/Skills/",
                Route::AgentResourcesSkills,
            ),
            (
                "/api/agent-presets",
                "/api/Agent-Presets/",
                Route::AgentPresets,
            ),
        ] {
            assert_eq!(claim(&Method::GET, path), Some(route));
            assert_eq!(claim(&Method::HEAD, mixed), Some(route));
            assert_eq!(
                claim(&Method::OPTIONS, path),
                Some(Route::AgentResourcesOptionsGet)
            );
            assert_eq!(claim(&Method::POST, path), None);
            assert_eq!(claim(&Method::DELETE, path), None);
            assert_eq!(claim(&Method::GET, &format!("{path}//")), None);
            assert_eq!(claim(&Method::GET, &path.replace("/api/", "/API/")), None);
        }
        // The :id is one non-empty segment, decoded, and keeps its case.
        assert_eq!(
            claim(&Method::GET, "/api/Agent-Presets/My%20Preset"),
            Some(Route::AgentPreset)
        );
        assert_eq!(
            agent_resources::preset_id_from_path("/api/agent-presets/My%20Preset"),
            Some("My Preset".to_string())
        );
        assert_eq!(
            claim(&Method::HEAD, "/api/agent-presets/my-preset/"),
            Some(Route::AgentPreset)
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/agent-presets/my-preset"),
            Some(Route::AgentResourcesOptionsGet)
        );
        assert_eq!(
            claim(&Method::GET, "/api/agent-presets"),
            Some(Route::AgentPresets)
        );
        assert_eq!(claim(&Method::GET, "/api/agent-presets/a/b"), None);

        // `/api/agent-resources/claude-sessions` registers GET and DELETE, so
        // OPTIONS collects both; the two-parameter path only has DELETE.
        assert_eq!(
            claim(&Method::GET, "/api/agent-resources/claude-sessions"),
            Some(Route::AgentClaudeSessions)
        );
        assert_eq!(
            claim(&Method::HEAD, "/api/Agent-Resources/Claude-Sessions/"),
            Some(Route::AgentClaudeSessions)
        );
        assert_eq!(
            claim(&Method::DELETE, "/api/agent-resources/claude-sessions"),
            Some(Route::AgentClaudeSessionsPurge)
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/agent-resources/claude-sessions"),
            Some(Route::AgentResourcesOptionsShared)
        );
        assert_eq!(
            claim(
                &Method::DELETE,
                "/api/agent-resources/claude-sessions/proj/abc"
            ),
            Some(Route::AgentClaudeSessionDelete)
        );
        assert_eq!(
            agent_resources::session_delete_params_from_path(
                "/api/agent-resources/claude-sessions/My%20Project/s%2Fid",
            ),
            Some(("My Project".to_string(), "s/id".to_string()))
        );
        assert_eq!(
            claim(
                &Method::OPTIONS,
                "/api/agent-resources/claude-sessions/proj/abc"
            ),
            Some(Route::AgentResourcesOptionsDelete)
        );
        assert_eq!(
            claim(
                &Method::GET,
                "/api/agent-resources/claude-sessions/proj/abc"
            ),
            None
        );
        // Exactly two extra segments.
        assert_eq!(
            claim(
                &Method::DELETE,
                "/api/agent-resources/claude-sessions/a/b/c"
            ),
            None
        );
        assert_eq!(
            claim(&Method::DELETE, "/api/agent-resources/claude-sessions//abc"),
            None
        );
        assert_eq!(
            claim(
                &Method::DELETE,
                "/api/agent-resources/claude-sessions/proj/"
            ),
            None
        );
    }

    #[test]
    fn secrets_vault_claims_keep_the_express_shape() {
        // The literal segment is case-insensitive (Express default routing);
        // the parameter is not.
        assert_eq!(
            claim(&Method::GET, "/api/SECRETS"),
            Some(Route::SecretsList)
        );
        assert_eq!(
            claim(&Method::HEAD, "/api/Secrets/"),
            Some(Route::SecretsList)
        );
        assert_eq!(
            claim(&Method::POST, "/api/secrets"),
            Some(Route::SecretsCreate)
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/Secrets"),
            Some(Route::SecretsOptionsCollection)
        );
        assert_eq!(claim(&Method::GET, "/API/secrets"), None);
        assert_eq!(claim(&Method::GET, "/api/secrets//"), None);
        assert_eq!(claim(&Method::PUT, "/api/secrets"), None);

        // One parameter segment; its case survives into the decoded name.
        assert_eq!(
            claim(&Method::DELETE, "/api/secrets/MiXeD"),
            Some(Route::SecretsDelete)
        );
        assert_eq!(
            secrets_vault::path_name("/api/Secrets/MiXeD/"),
            Some("MiXeD".to_string())
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/secrets/old"),
            Some(Route::SecretsOptionsItem)
        );
        assert_eq!(claim(&Method::GET, "/api/secrets/old"), None);
        // `rename` is an ordinary name for the DELETE route, and a trailing
        // slash is what strict routing off accepts.
        assert_eq!(
            claim(&Method::DELETE, "/api/secrets/rename"),
            Some(Route::SecretsDelete)
        );
        assert_eq!(
            claim(&Method::DELETE, "/api/secrets/old/"),
            Some(Route::SecretsDelete)
        );

        assert_eq!(
            claim(&Method::POST, "/api/secrets/old/rename"),
            Some(Route::SecretsRename)
        );
        assert_eq!(
            claim(&Method::POST, "/api/secrets/old/rename/"),
            Some(Route::SecretsRename)
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/secrets/old/rename"),
            Some(Route::SecretsOptionsRename)
        );
        assert_eq!(claim(&Method::GET, "/api/secrets/old/rename"), None);

        assert_eq!(
            claim(&Method::GET, "/api/secrets/old/value"),
            Some(Route::SecretsReveal)
        );
        assert_eq!(
            claim(&Method::HEAD, "/api/secrets/old/value/"),
            Some(Route::SecretsReveal)
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/secrets/old/value"),
            Some(Route::SecretsOptionsValue)
        );
        assert_eq!(claim(&Method::DELETE, "/api/secrets/old/value"), None);

        // Two segments with any other suffix, an empty segment and one slash
        // too many were not routes Express had.
        assert_eq!(claim(&Method::POST, "/api/secrets/old/other"), None);
        assert_eq!(claim(&Method::GET, "/api/secrets/old/value/extra"), None);
        assert_eq!(claim(&Method::DELETE, "/api/secrets//"), None);
        assert_eq!(claim(&Method::DELETE, "/api/secrets/old//"), None);
        // A different route family.
        assert_eq!(claim(&Method::GET, "/api/secret"), None);
        assert_eq!(claim(&Method::GET, "/api/secrets-tokens"), None);
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "multicc-gateway-{tag}-{}-{nanos}",
            std::process::id()
        ))
    }

    #[tokio::test]
    async fn subscription_panic_releases_the_single_flight_slot() {
        let dir = scratch("subscription-panic");
        std::fs::create_dir_all(&dir).unwrap();
        let shared = Arc::new(account_subscription::Shared::new(&dir));
        let first = shared
            .run_with("claude\0panic".to_string(), || async {
                panic!("injected query panic");
            })
            .await;
        assert_eq!(first, serde_json::json!({"status":"unavailable"}));
        // The guard removed the dead slot, so a fresh request runs a fresh
        // query instead of waiting on the panicked sender forever.
        let second = shared
            .run_with("claude\0panic".to_string(), || async {
                serde_json::json!({"status":"ok","value":1})
            })
            .await;
        assert_eq!(second["status"], "ok");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn subscription_waiters_share_one_query_and_survive_a_dropped_waiter() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let dir = scratch("subscription-abort");
        std::fs::create_dir_all(&dir).unwrap();
        let shared = Arc::new(account_subscription::Shared::new(&dir));
        let calls = Arc::new(AtomicUsize::new(0));
        let attempt = |shared: Arc<account_subscription::Shared>, calls: Arc<AtomicUsize>| {
            tokio::spawn(async move {
                shared
                    .run_with("codex\0abort".to_string(), move || async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                        serde_json::json!({"status":"ok","value":42})
                    })
                    .await
            })
        };
        let first = attempt(shared.clone(), calls.clone());
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        let second = attempt(shared.clone(), calls.clone());
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        first.abort();
        let answer = second.await.unwrap();
        assert_eq!(answer["value"], 42);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
