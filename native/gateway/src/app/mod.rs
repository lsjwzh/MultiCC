//! Routes the front door answers itself instead of forwarding to Node.
//!
//! Each one replaced a Node route that was deleted in the same change, so it
//! keeps that route's whole contract: the auth gate in front of it
//! (`multicc_core::http_gate`), Express's response behavior ([`express`]),
//! and the route's own request/response shapes. docs/gateway.md §8 lists
//! them and the few documented differences.

pub mod accept;
pub mod account_routes;
pub mod account_subscription;
pub mod agent_resources;
pub mod air_routes;
pub mod artifacts;
pub mod auth;
pub mod auto_provider_routing;
pub mod claude_models;
pub mod cli_switch;
pub mod directory_routes;
pub mod docs_memory_routes;
pub mod download;
pub mod event_routes;
pub mod express;
pub mod external_workspaces;
pub mod file_transfer;
pub mod host_ops_routes;
pub mod host_read;
pub mod model_catalogs;
pub mod orchestration_routes;
pub mod plugins;
pub mod provider_balance;
mod provider_balance_adapters;
mod provider_balance_panels;
pub mod provider_limit_history;
pub mod provider_relay;
pub mod providers;
pub mod push_routes;
pub mod quota_guard;
pub mod quota_routes;
pub mod release_history_routes;
pub mod remote_screen;
pub mod run_config_presets;
pub mod scan;
pub mod scoped_auth;
pub mod secrets_vault;
pub mod server_core;
mod service_transport;
pub mod services;
pub mod session_admin;
pub mod session_git;
pub mod session_routes;
pub mod share_machine_routes;
pub mod source_workspaces;
pub mod static_assets_routes;
pub mod static_web_root;
pub mod subagent_defaults;
pub mod system;
pub mod task_routes;
pub mod task_shell;
pub mod token_usage_by_role;
pub mod token_usage_global;
pub mod turn_ledger;
pub mod uploads;
pub mod voice_gateway;
pub mod voice_routes;
pub mod voice_runtime;

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

fn user_home() -> PathBuf {
    select_user_home(
        cfg!(windows),
        std::env::var_os("USERPROFILE"),
        std::env::var_os("HOME"),
    )
}

fn select_user_home(
    windows: bool,
    profile: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
) -> PathBuf {
    let nonempty = |value: &std::ffi::OsString| !value.is_empty();
    let profile = profile.filter(nonempty);
    let home = home.filter(nonempty);
    (if windows { profile.or(home) } else { home })
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// A native route, matched the way Express matched the Node one:
/// case-insensitive, one optional trailing slash, raw (undecoded) path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// Express's automatic OPTIONS for a path whose routes live in more than
    /// one cluster: the `Allow` list is the registration-order union of every
    /// cluster's share. A single-cluster path keeps its own cluster's
    /// responder (same answer, same error messages on host failure).
    AutoOptions,
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
    ServerInfoGet,
    ServerInfoOptions,
    VersionCheckGet,
    VersionCheckOptions,
    CodexProxyTraceGet,
    CodexProxyTraceOptions,
    ScanHistoryGet,
    ScanHistoryOptions,
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
    HostOps(host_ops_routes::Route),
    Orchestration(orchestration_routes::Route),
    ReleaseHistory(release_history_routes::Route),
    StaticAssets(static_assets_routes::Route),
    /// The `public/` static web root. The filesystem resolution happens in
    /// `static_web_root::claim` and travels as a [`static_web_root::Resolved`]
    /// request extension, so this variant carries no payload.
    StaticWebRoot,
    /// The dual-root `/artifacts` static mount. Like [`Route::StaticWebRoot`],
    /// the resolution happens in `artifacts::claim` and travels as an
    /// [`artifacts::Resolved`] request extension.
    Artifacts,
    ServerCore(server_core::Route),
    Plugins(plugins::Route),
    FilesGet,
    FilesOptions,
    Upload,
    UploadOptions,
    TurnLedger(turn_ledger::Route),
    TurnLedgerOptions(turn_ledger::Route),
    Providers(providers::Route),
    SessionGit(session_git::Route),
    TaskShell(task_shell::Route),
    SessionAdmin(session_admin::Route),
    SessionRoutes(session_routes::Route),
    CliSwitch(cli_switch::Route),
    ShareMachine(share_machine_routes::Route),
    TaskRoutes(task_routes::Route),
    Push(push_routes::Route),
    Air(air_routes::Route),
    Quota(quota_routes::Route),
    Account(account_routes::Route),
    Events(event_routes::Route),
    DocsMemory(docs_memory_routes::Route),
    Directory(directory_routes::Route),
    ProviderBalance(provider_balance::Route),
    ProviderRelay(provider_relay::Route),
    AutoProviderRouting(auto_provider_routing::Route),
    VoiceGateway(voice_gateway::Route),
    Voice(voice_routes::Route),
    VoiceRuntime(voice_runtime::Route),
}

/// Every cluster whose routes can share one path with another cluster, in the
/// order `server.js` registered the retired Express routes. A source returns
/// only the methods *that* cluster registers on the path: Express's automatic
/// OPTIONS answer is `appendMethods` over every matching layer in registration
/// order, so the first match must not answer alone.
///
/// Clusters whose paths never overlap another cluster's stay out of this list;
/// their own `claim` already unions their internal layers.
static OPTIONS_SOURCES: &[fn(&str) -> Option<String>] = &[
    // `/api/settings/{notify,tunnel,access-token,power}` and
    // `/api/tunnel/funnel`: host-read's GET/HEAD, registered before the
    // host-write POST. `/api/settings/task-attribution`: the host-write POST,
    // registered before the task-surface GET (the task-routes source below),
    // so the host-ops source must stay ahead of it.
    host_read::options_share,
    host_ops_routes::options_share,
    // `/api/sessions/:id`: session-admin's GET/HEAD then session-create/
    // profile/bundle/lifecycle; `/api/directories/:id/sessions`: session-admin
    // then session-create.
    session_admin_share,
    session_routes::options_share,
    // `POST /api/air/tasks/mark-achieved` registered before Air's
    // `GET /api/air/tasks/:id`.
    task_routes::options_share,
    air_routes::options_share,
    // `/api/providers/:id/models` (model catalogs, registered by the retired
    // server.js first) and `PATCH|DELETE /api/providers/:appType/:id`
    // (providers management).
    model_catalogs::options_share,
    providers::options_share,
    task_shell::options_share,
    quota_routes::options_share,
    account_routes::options_share,
    event_routes::options_share,
    docs_memory_routes::options_share,
    directory_routes::options_share,
    push_routes::options_share,
    share_machine_routes::options_share,
    // Orchestration / unattended: no path is shared with another cluster today
    // (the measured unions are single-source), but the cluster registers its
    // own multi-method paths here so a future overlap unions instead of
    // shadowing.
    orchestration_routes::options_share,
    release_history_routes::options_share,
    // Release assets, iOS OTA and chat history: every path is single-source
    // today (measured), registered so a future overlap unions.
];

/// session-admin's share is paired with its guard segment for its own
/// responder; the union only needs the method list.
fn session_admin_share(path: &str) -> Option<String> {
    session_admin::options_share(path).map(|(allow, _)| allow.to_string())
}

/// The whole-app `Allow` for `path` when several clusters registered routes on
/// it; `None` when at most one cluster did (that cluster's own responder is
/// already exact, including its guard probe and host-failure message).
fn options_allow(path: &str) -> Option<String> {
    let shares: Vec<String> = OPTIONS_SOURCES
        .iter()
        .filter_map(|source| source(path))
        .collect();
    if shares.len() < 2 {
        return None;
    }
    Some(multicc_core::route_options::merge(
        shares.iter().map(String::as_str),
    ))
}

/// Segment view of `/api/<rest>`, one optional trailing slash removed. Same
/// shape rule as every cluster's matcher.
fn path_segments(path: &str) -> Option<Vec<&str>> {
    let rest = path.strip_prefix("/api/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.is_empty() {
        return None;
    }
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    Some(parts)
}

/// The `:id` segment of `publicSessionAccessGuard`'s two `app.use` mounts
/// (`/api/sessions/:id`, `/api/v1/sessions/:id`), which run before the
/// automatic OPTIONS answer.
fn guard_segment(path: &str) -> Option<usize> {
    let parts = path_segments(path)?;
    if parts[0].eq_ignore_ascii_case("sessions") && parts.len() >= 2 {
        Some(1)
    } else if parts.len() >= 3
        && parts[0].eq_ignore_ascii_case("v1")
        && parts[1].eq_ignore_ascii_case("sessions")
    {
        Some(2)
    } else {
        None
    }
}

fn is_v1_path(path: &str) -> bool {
    path_segments(path)
        .and_then(|parts| parts.first().copied())
        .is_some_and(|head| head.eq_ignore_ascii_case("v1"))
}

/// `claim` plus the one route whose claim needs the query string: `GET|HEAD /`
/// is claimed only when it redirects (`?id=`/`?newid=`/`?cwd=` is the
/// terminal-session chain, which Express passed on to the HTML middleware).
pub fn claim_uri(method: &Method, uri: &axum::http::Uri) -> Option<Route> {
    claim(method, uri.path())
        .or_else(|| release_history_routes::claim_uri(method, uri).map(Route::ReleaseHistory))
        .or_else(|| static_assets_routes::claim_uri(method, uri).map(Route::StaticAssets))
}

/// The routes this front door owns. Anything else (including other methods
/// on these paths, which Express would have passed on) goes to Node.
///
/// Only paths with the exact-case `/api/` prefix are claimed: Node's auth
/// gate and JSON gzip test `req.path.startsWith('/api/')` case-sensitively,
/// and a differently-cased prefix took other branches there.
pub fn claim(method: &Method, path: &str) -> Option<Route> {
    if method == Method::OPTIONS && options_allow(path).is_some() {
        return Some(Route::AutoOptions);
    }
    // The server-core literals `/healthz`, `/readyz`, `/metrics` and
    // `/api/repo-operations/:operationId`. None overlaps another cluster, so
    // the cluster answers its own OPTIONS; they are exact/single-segment
    // matchers and can be claimed up front.
    if let Some(route) = server_core::claim(method, path) {
        return Some(Route::ServerCore(route));
    }
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
    if let Some(claim) = turn_ledger::claim(method, path) {
        return Some(match claim {
            turn_ledger::Claim::Handle(route) => Route::TurnLedger(route),
            turn_ledger::Claim::Options(route) => Route::TurnLedgerOptions(route),
        });
    }
    if let Some(route) = provider_balance::claim(method, path) {
        return Some(Route::ProviderBalance(route));
    }
    if let Some(route) = provider_relay::claim(method, path) {
        return Some(Route::ProviderRelay(route));
    }
    if let Some(route) = session_git::claim(method, path) {
        return Some(Route::SessionGit(route));
    }
    if let Some(route) = task_shell::claim(method, path) {
        return Some(Route::TaskShell(route));
    }
    if let Some(route) = session_admin::claim(method, path) {
        return Some(Route::SessionAdmin(route));
    }
    // After session-admin: it keeps `GET /api/sessions/:id` and the shared
    // `OPTIONS` unions (which already include this cluster's `PATCH`/`DELETE`
    // and the `/api/directories/:id/sessions` `POST`). This cluster claims the
    // write half and its own literals; directory-routes is disjoint.
    if let Some(route) = session_routes::claim(method, path) {
        return Some(Route::SessionRoutes(route));
    }
    // Cross-CLI switching: one literal under the session guard
    // (`POST /api/sessions/:id/switch-cli`), disjoint from the other clusters.
    if let Some(route) = cli_switch::claim(method, path) {
        return Some(Route::CliSwitch(route));
    }
    // Before Air: `POST /api/air/tasks/mark-achieved` is a literal this cluster
    // owns, while Air keeps `GET /api/air/tasks/:id`. Express registered the
    // POST first, so the shared path's OPTIONS union starts with POST.
    if let Some(route) = task_routes::claim(method, path) {
        return Some(Route::TaskRoutes(route));
    }
    if let Some(route) = air_routes::claim(method, path) {
        return Some(Route::Air(route));
    }
    if let Some(route) = quota_routes::claim(method, path) {
        return Some(Route::Quota(route));
    }
    // The account / credential cluster owns its own `/api/{claude,codex}/accounts`,
    // `/api/{claude,codex}/oauth`, `/api/{zcode,kimi}/auth` (minus the two
    // forwarded `login` POSTs), `/api/cli-accounts` and
    // `/api/commandcode/auth` literals; none overlaps another cluster.
    if let Some(route) = account_routes::claim(method, path) {
        return Some(Route::Account(route));
    }
    // The sharing / machines / workspaces cluster owns `/api/machines*`,
    // `/api/sessions/:id/share*`, `/api/share/:token/*`, `/api/workspaces/*`
    // and the public `/share/:token` page. The first four are disjoint from
    // every other cluster; the session-share literals are distinct from
    // session-admin's and session-routes' (`share`, `shares`, `share-messages`,
    // `share/:token`), which own the rest of `/api/sessions/:id`.
    if let Some(route) = share_machine_routes::claim(method, path) {
        return Some(Route::ShareMachine(route));
    }
    if let Some(route) = event_routes::claim(method, path) {
        return Some(Route::Events(route));
    }
    if let Some(route) = docs_memory_routes::claim(method, path) {
        return Some(Route::DocsMemory(route));
    }
    if let Some(route) = directory_routes::claim(method, path) {
        return Some(Route::Directory(route));
    }
    if let Some(route) = providers::claim(method, path) {
        return Some(Route::Providers(route));
    }
    if let Some(route) = auto_provider_routing::claim(method, path) {
        return Some(Route::AutoProviderRouting(route));
    }
    if let Some(route) = voice_gateway::claim(method, path) {
        return Some(Route::VoiceGateway(route));
    }
    if let Some(route) = voice_routes::claim(method, path) {
        return Some(Route::Voice(route));
    }
    if let Some(route) = voice_runtime::claim(method, path) {
        return Some(Route::VoiceRuntime(route));
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
    if let Some(route) = push_routes::claim(method, path) {
        return Some(Route::Push(route));
    }
    // The host-and-system operations cluster owns `/api/restart`,
    // `/api/desktop-shutdown`, `/api/update*`, `/api/system/{developer-tools,
    // disk-access,agent-permissions,agent-install,ops-env,ops-run,env-doctor}*`,
    // `/api/settings/{notify,tunnel,access-token,power*,task-attribution}`,
    // `/api/tunnel/{restart/:provider,sakurafrp/public-url,funnel}`,
    // `/api/skill-sync/*`, `/api/sessions/:id/doctor` and
    // `/api/doctor/runs/*`. Every literal is disjoint from the other clusters;
    // the shared OPTIONS paths are handled by `OPTIONS_SOURCES` above.
    if let Some(route) = host_ops_routes::claim(method, path) {
        return Some(Route::HostOps(route));
    }
    // The orchestration and unattended cluster owns the Aux and goal routes
    // (`/api/aux/*`, `/api/settings/goal`, `/api/goal/precheck`) and 13
    // session-scoped routes: aux-runs, unattended, scheduled messages, tasks,
    // dispatches, user-input dismiss, queue, queue/action and the **v1** waits
    // listing. The unprefixed `GET /api/sessions/:id/waits` and the other six
    // wait-injector / detached routes are deliberately not claimed.
    if let Some(route) = orchestration_routes::claim(method, path) {
        return Some(Route::Orchestration(route));
    }
    if let Some(route) = release_history_routes::claim(method, path) {
        return Some(Route::ReleaseHistory(route));
    }
    if let Some(claim) = host_read::claim(method, path) {
        return Some(match claim {
            host_read::Claim::Get(route) => Route::HostReadGet(route),
            host_read::Claim::Options(route) => Route::HostReadOptions(route),
        });
    }
    // The static-assets rules: the three redirect families and the global
    // `.apk`/`.ipa` guard (the query-dependent `/air` case lives in
    // `claim_uri`). Last among the path-prefix matchers, like the retired
    // `mountRoutes(app)` which sat after the earlier API routes; the guard is
    // still broad, so claiming it after every literal keeps another cluster's
    // path (if one ever ended in `.apk`) untouched.
    if let Some(route) = static_assets_routes::claim(method, path) {
        return Some(Route::StaticAssets(route));
    }
    // The plugin cluster (`src/routes/plugins.js`): the literal
    // `POST /api/channels/recheck` (registered by `mount(app)`, after the auth
    // gate) and `GET /plugins/:id/*` (registered after it in `server.js`). It
    // sits after the static-assets guard on purpose: Express registered the
    // global `.apk`/`.ipa` rule first, so a plugin file with that extension
    // keeps the guard's 404. `/plugins/:id/*` needs its second slash
    // (path-to-regexp), so `/plugins/x` stays unclaimed.
    if let Some(route) = plugins::claim(method, path) {
        return Some(Route::Plugins(route));
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
        ("server-info", "GET" | "HEAD") => Some(Route::ServerInfoGet),
        ("server-info", "OPTIONS") => Some(Route::ServerInfoOptions),
        ("version-check", "GET" | "HEAD") => Some(Route::VersionCheckGet),
        ("version-check", "OPTIONS") => Some(Route::VersionCheckOptions),
        ("debug/codex-proxy-trace", "GET" | "HEAD") => Some(Route::CodexProxyTraceGet),
        ("debug/codex-proxy-trace", "OPTIONS") => Some(Route::CodexProxyTraceOptions),
        ("scan/history", "GET" | "HEAD") => Some(Route::ScanHistoryGet),
        ("scan/history", "OPTIONS") => Some(Route::ScanHistoryOptions),
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
    /// The private stream that hands `/ws/chat` client sockets to the chat
    /// engine in the Node child (`chat_bridge.rs`).
    pub chat: Arc<crate::chat_bridge::ChatBridge>,
    pub(crate) native_chat: Arc<crate::ws_chat_native::Host>,
    pub lan_only: bool,
    pub allow_legacy_token_query: bool,
    /// `--node` was given. The authentication runtime (access token, sessions,
    /// WS tickets, shutdown flag) lives in that Node child; `--no-node` owns a
    /// local copy when `.env` supplied a usable ACCESS_TOKEN. A route that needs
    /// the snapshot with neither owner fails closed (docs/gateway.md §8.1).
    pub node_enabled: bool,
    /// When this front door started. `--no-node` has no child whose
    /// `process.uptime()` the server-core probes could report, so `/healthz`
    /// answers this process's own uptime instead (`server_core::local_healthz`).
    pub started: std::time::Instant,
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
    /// `src/routes/providers.js` ran each write handler to completion on the
    /// event loop; these routes await host round trips instead.
    pub providers_write: tokio::sync::Mutex<()>,
    /// `src/routes/session-git.js` ran each merge/sync/rebase/cleanup handler
    /// to completion on the event loop; these routes await host round trips
    /// that mutate real worktrees, so serialize them.
    pub session_git_write: tokio::sync::Mutex<()>,
    /// `src/task-shell/routes.js` ran each write handler to completion on the
    /// event loop; these routes await host round trips that mutate the task
    /// store, so serialize them.
    pub task_shell_write: tokio::sync::Mutex<()>,
    /// `src/routes/session-admin.js` ran each write handler to completion on
    /// the event loop; these routes await host round trips that mutate the
    /// classify state machine, so serialize them.
    pub session_admin_write: tokio::sync::Mutex<()>,
    /// `src/routes/session-memory.js`, `session-bundle.js`, `session-lifecycle.js`,
    /// `session-create.js`, `session-meta.js` and `session-profile.js` ran each
    /// write handler to completion on the event loop; these routes await host
    /// round trips that mutate session records, spawn or kill CLI children,
    /// re-stage configuration and fork transcripts, so serialize them.
    pub session_routes_write: tokio::sync::Mutex<()>,
    /// `src/machines.js`, `src/routes/share.js` and `src/routes/workspaces.js`
    /// ran each write handler to completion on the event loop; these routes
    /// await host round trips that mutate the machine registry, its grants, a
    /// share record, the WS-ticket table and the workspace hibernation store,
    /// so serialize them.
    pub share_machine_write: tokio::sync::Mutex<()>,
    /// Serializes the host-and-system operations cluster (restart/update,
    /// `.env` writes, macOS settings, shell jobs).
    pub host_ops_write: tokio::sync::Mutex<()>,
    pub orchestration_write: tokio::sync::Mutex<()>,
    /// Serializes the release-asset/chat-history writes (the one-time UDID
    /// token issue and consume, and the transcript message delete).
    pub release_history_write: tokio::sync::Mutex<()>,
    /// `src/routes/task-planning.js`, `src/routes/task-board.js`,
    /// `src/routes/task-goal.js` and `src/task-shell/attribution-settings.js`
    /// ran each write handler to completion on the event loop; these routes
    /// await host round trips that mutate the board file, the task store, the
    /// chat-session binding and the retention flights, so serialize them.
    pub task_routes_write: tokio::sync::Mutex<()>,
    /// `src/push/*` mounted its write routes on one Node thread; the retired
    /// handlers mutated the shared subscription and device Maps, so serialize
    /// the host round trips that write them.
    pub push_write: tokio::sync::Mutex<()>,
    /// `src/workspace/air-routes.js` ran each write handler to completion on
    /// the event loop; these routes await host round trips that mutate pins,
    /// todos, tasks and worktrees, so serialize them.
    pub air_write: tokio::sync::Mutex<()>,
    /// `src/events/routes.js`, `src/triggers/index.js` and the global-rule
    /// write path ran each handler to completion on the event loop; these
    /// routes await host round trips that mutate the rule store, session
    /// records and trigger timers, so serialize them.
    pub event_write: tokio::sync::Mutex<()>,
    /// The nine quota & pricing modules ran each write handler to completion
    /// on the event loop; these routes await host round trips that refresh the
    /// price table, open login windows, install arkcli and rewrite the
    /// quota-bar cache, so serialize them.
    pub quota_write: tokio::sync::Mutex<()>,
    /// The eight account / credential modules ran each write handler to
    /// completion on the event loop; these routes await host round trips that
    /// write the keychain, account records and login-terminal sessions, so
    /// serialize them.
    pub account_write: tokio::sync::Mutex<()>,
    /// `src/routes/voice-gateway.js` ran each write handler synchronously; the
    /// ensure/remove routes here await one host round trip instead.
    pub voice_gateway_write: tokio::sync::Mutex<()>,
    /// `src/routes/voice-gateway-global.js` also ran the whole launch flow and
    /// every write to completion on the event loop; these routes await several
    /// host round trips each.
    pub voice_runtime_write: tokio::sync::Mutex<()>,
    /// `src/docs-registry.js`, the memory browser, the memo router and the
    /// notes store ran each write handler to completion on the event loop;
    /// these routes await host round trips that mutate the registry table, the
    /// memory store, a memo file or a chat turn, so serialize them.
    pub docs_memory_write: tokio::sync::Mutex<()>,
    /// `src/directory/service.js` ran each write handler (register, sample,
    /// reorder, update, delete, push, commit, layout writes) to completion on
    /// the event loop; these routes await host round trips that mutate the
    /// directory table, the filesystem, git repos and the layout file.
    pub directory_write: tokio::sync::Mutex<()>,
    /// `src/routes/voice.js` ran the feedback / hotword-reject / vocab-delete /
    /// settings / asr-model handlers to completion on the event loop; these
    /// routes await one host round trip instead. refine / confirm /
    /// progress-summary only enqueue auxiliary work and are not serialized.
    pub voice_routes: tokio::sync::Mutex<()>,
    /// The observation cache the retired Node route wrote, plus the
    /// process-local single-flight table and the system-proxy slot. `Arc` lets
    /// the leader query outlive the HTTP request that started it.
    pub account_subscription: Arc<account_subscription::Shared>,
    /// The front door's single outbound HTTP exit: proxy discovery, NO_PROXY
    /// and loopback rules are the Node runtime's (`src/network/outbound.js`).
    pub outbound: crate::outbound::Outbound,
    /// The Node package root (the directory of the script we run): the
    /// version-check route reads package.json and .multicc_channel from it.
    pub package_root: PathBuf,
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
            chat: Arc::new(crate::chat_bridge::ChatBridge::default()),
            native_chat: Arc::new(crate::ws_chat_native::Host::default()),
            lan_only: policy.lan_only,
            allow_legacy_token_query: env_enabled(&env_text("MULTICC_ALLOW_LEGACY_TOKEN_QUERY")),
            node_enabled: options.node_enabled(),
            started: std::time::Instant::now(),
            store_lock: Mutex::new(()),
            tickets: Mutex::new(DownloadTickets::new()),
            provider_limit_history: Mutex::new(provider_limit_history::State::default()),
            claude_models: Mutex::new(claude_models::State::default()),
            token_usage_global: Mutex::new(token_usage_global::State::default()),
            subagent_defaults: tokio::sync::Mutex::new(()),
            secrets_vault: tokio::sync::Mutex::new(()),
            providers_write: tokio::sync::Mutex::new(()),
            session_git_write: tokio::sync::Mutex::new(()),
            task_shell_write: tokio::sync::Mutex::new(()),
            session_admin_write: tokio::sync::Mutex::new(()),
            session_routes_write: tokio::sync::Mutex::new(()),
            share_machine_write: tokio::sync::Mutex::new(()),
            host_ops_write: tokio::sync::Mutex::new(()),
            orchestration_write: tokio::sync::Mutex::new(()),
            release_history_write: tokio::sync::Mutex::new(()),
            task_routes_write: tokio::sync::Mutex::new(()),
            push_write: tokio::sync::Mutex::new(()),
            air_write: tokio::sync::Mutex::new(()),
            quota_write: tokio::sync::Mutex::new(()),
            account_write: tokio::sync::Mutex::new(()),
            event_write: tokio::sync::Mutex::new(()),
            docs_memory_write: tokio::sync::Mutex::new(()),
            directory_write: tokio::sync::Mutex::new(()),
            voice_gateway_write: tokio::sync::Mutex::new(()),
            voice_runtime_write: tokio::sync::Mutex::new(()),
            voice_routes: tokio::sync::Mutex::new(()),
            account_subscription: subscriptions,
            outbound: crate::outbound::Outbound::from_process(),
            package_root,
            home_dir: user_home(),
            node_cwd: physical_dir(&options.cwd),
        }
    }

    /// The auth gate in front of every claimed route. Node's
    /// `authorizeScopedRequest` and the ordinary credential run in one order;
    /// only the fleet half is async because its live share state sits behind
    /// the source control channel (see [`scoped_auth`]). `peer` stays the
    /// address from the PROXY line, so locality is judged on the real
    /// requester rather than the front door's loopback.
    pub(crate) async fn gate(
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
        // `authorizeScopedRequest` is `machines.authorize(req) || fleet...`, so
        // the share store is asked only when the machine scope did not already
        // allow this request (server.js:421). Both halves are read live: the
        // machine registry from the data root, the share record and membership
        // through the child's source control port.
        let root = self.data_root.to_string_lossy().into_owned();
        let machine_scoped = http_gate::machine_credential(&request).map(|credential| {
            multicc_core::machines::authorize(
                &root,
                credential,
                ctx.method.as_str(),
                &ctx.original_url,
            )
            .is_some()
        });
        let fleet_scoped =
            machine_scoped != Some(true) && scoped_auth::fleet_scoped(self, ctx).await;
        let decision = http_gate::authorize(
            &policy,
            &request,
            machine_scoped,
            |ticket| {
                self.tickets
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .verify(ticket, &ctx.original_url, now_ms)
            },
            fleet_scoped,
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

/// Express's automatic OPTIONS for a path several clusters registered routes
/// on: their registration-order `Allow` union. When the path sits under the
/// public-session access guard, that `app.use` layer runs before the automatic
/// answer, so an internal execution slot still gets the same 404 as a missing
/// session (the guard round trip is session-admin's, exactly as before).
async fn auto_options(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let allow = options_allow(&ctx.path).unwrap_or_default();
    let Some(index) = guard_segment(&ctx.path) else {
        return options(ctx, &allow);
    };
    let parts = path_segments(&ctx.path).unwrap_or_default();
    let id = parts.get(index).copied().unwrap_or("");
    match session_admin::guard_facts(host, id, ctx.method.as_str()).await {
        Ok(found) if found.internal => session_admin::guarded_404(ctx, is_v1_path(&ctx.path)),
        Ok(_) => options(ctx, &allow),
        Err(_) => session_admin::unavailable(ctx),
    }
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

/// `--no-node` with no local authentication runtime: the honest shape of "this
/// route needs an auth runtime and this front door has none" (no Node child and
/// no usable `ACCESS_TOKEN` in `.env`). Same status, content type, `Connection`
/// and `code` as the forwarded-route refusal in `crate::forward`, but the
/// `error` names the missing state instead of pretending the request would have
/// gone to Node. No Express headers or log line: nothing ran, exactly like the
/// fallback refusal.
const AUTH_RUNTIME_ABSENT_BODY: &str = concat!(
    r#"{"error":"Authentication state is held by the Node runtime, which this front door was started without (--no-node).","#,
    r#""code":"node_runtime_absent"}"#
);

fn auth_runtime_absent() -> Response<Body> {
    Response::builder()
        .status(503)
        .header("Content-Type", "application/json")
        .header("Connection", "close")
        .body(Body::from(AUTH_RUNTIME_ABSENT_BODY))
        .expect("static response parts")
}

/// Answers `route`: the auth gate, then `express.json`, then the handler.
pub async fn handle(
    app: Arc<App>,
    route: Route,
    request: Request<Body>,
    client: SocketAddr,
    host: u16,
    upstream: crate::forward::UpstreamHandle,
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
    // Relay reads use the same scoped grant owner as inference. Preserve the
    // original peer when the live host validates mcr1/fleet credentials.
    if matches!(route, Route::ProviderRelay(_))
        || matches!(route, Route::ProviderBalance(route) if provider_balance::is_relay(route))
    {
        let headers = match provider_relay::admission(&ctx, &peer, host).await {
            Ok(headers) => headers,
            Err(response) => return *response,
        };
        // These read routes were mounted before express.json; even POST quota
        // ignores its body. Parsing here would reject formerly accepted reads.
        drop(body);
        let mut response = match route {
            Route::ProviderRelay(route) => provider_relay::handle(route, &ctx, host).await,
            Route::ProviderBalance(route) => {
                provider_balance::handle(&app, route, &ctx, host).await
            }
            _ => unreachable!(),
        };
        provider_relay::append_headers(&mut response, &headers);
        return response;
    }
    // §8.1: every route below needs the authentication snapshot. With `--node`
    // it lives in the Node child; with `--no-node` the front door owns a local
    // copy when `.env` supplied an ACCESS_TOKEN. Only when neither owner exists
    // (no child, no valid token) does a route fail closed at once instead of
    // waiting out the control-stream timeout (3s) and reporting it as a generic
    // 503. `--node` keeps the old behavior exactly; the re-snapshots in
    // `auth.rs` are only reachable after this point, so they need no separate
    // guard.
    if !app.node_enabled && !app.auth.has_local() {
        // `/healthz` and `/readyz` are public paths whose facts this process
        // owns when there is no child (`server_core::local_healthz`), so a
        // Rust-only start still answers a deployment's liveness and readiness
        // probes with no authentication owner at all. Everything else keeps
        // failing closed.
        if let Route::ServerCore(route) = route {
            if server_core::is_public_probe(route) {
                return server_core::handle_public_probe(&app, route, &ctx, &peer);
            }
        }
        return auth_runtime_absent();
    }
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
    // The share surface is exempt from the ordinary gate by token authority
    // (`/share/:token` and the `/api/share/:token/*` reads), so this cluster
    // decides public-vs-gated itself, exactly like `auth.rs`.
    if let Route::ShareMachine(route) = route {
        return share_machine_routes::handle(&app, route, &ctx, body, &peer, &snapshot, host).await;
    }
    // One host port for the host-and-system operations cluster. It decides
    // locality from the real client address before asking Node.
    if let Route::HostOps(route) = route {
        return host_ops_routes::handle(&app, route, &ctx, body, &peer, &snapshot, host).await;
    }
    // Orchestration / unattended: same host-port shape; it decides the session
    // guard (both envelopes) itself.
    if let Route::Orchestration(route) = route {
        return orchestration_routes::handle(&app, route, &ctx, body, &peer, &snapshot, host).await;
    }
    // Release assets / iOS OTA / chat history: the OTA fetchers cannot log in, so
    // this cluster decides gate-or-not itself from the shared HTTP-entry rule.
    if let Route::ReleaseHistory(route) = route {
        return release_history_routes::handle(
            &app, route, &ctx, body, &peer, &snapshot, host, upstream,
        )
        .await;
    }
    // Server core: `/healthz` and `/readyz` are public (the shared HTTP-entry
    // exemption); `/metrics` and `/api/repo-operations` keep the ordinary gate.
    // The cluster runs the peer allowlist itself for every path.
    if let Route::ServerCore(route) = route {
        return server_core::handle(&app, route, &ctx, &peer, &snapshot, host).await;
    }
    // Temp artifacts: `/artifacts/<id>` is a capability path the Node gate
    // lets through (`http_entry::public_path`), so this cluster runs the peer
    // check itself and skips the ordinary gate only for those public shapes.
    if let Route::Artifacts = route {
        return artifacts::handle(
            &app,
            &ctx,
            &peer,
            &snapshot,
            parts.extensions.get::<artifacts::Resolved>(),
        )
        .await;
    }
    // Plugin UI files: Node's auth gate lets a static-extension path through
    // without a login (`http_entry::public_path`), so this route runs the peer
    // allowlist itself and decides the login gate from that shared rule. The
    // recheck pair stays behind the ordinary gate below.
    if let Route::Plugins(route) = route {
        if plugins::is_file_route(route) {
            return plugins::handle_file(&app, route, &ctx, &peer, &snapshot, host).await;
        }
    }
    if let Some(refusal) = app.gate(&ctx, &peer, &snapshot).await {
        return refusal;
    }
    // multer owns the raw multipart body: the upload route runs in front of the
    // global `express.json` (it applies that step itself for JSON bodies, which
    // is where the retired stack parsed them).
    if let Route::Upload = route {
        return file_transfer::upload(&ctx, body).await;
    }
    // CLI switching runs its own `publicSessionAccessGuard` before parsing the
    // body, exactly like the retired `app.use('/api/sessions/:id')` layer that
    // sat in front of the global `express.json`.
    if let Route::CliSwitch(route) = route {
        return cli_switch::handle(route, &ctx, body, host).await;
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
        Route::StaticAssets(route) => return static_assets_routes::handle(route, &ctx),
        // The retired `express.static(public/)` mount and the versioned-HTML
        // middleware in front of it, both resolved before the claim.
        Route::StaticWebRoot => {
            return static_web_root::handle(
                &app,
                &ctx,
                parts.extensions.get::<static_web_root::Resolved>(),
            )
            .await
        }
        Route::Plugins(route) => return plugins::handle(route, &ctx, &body, &peer, host).await,
        Route::AutoOptions => return auto_options(&ctx, host).await,
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
        Route::ServerInfoGet => return system::server_info(&ctx, host).await,
        Route::VersionCheckGet => return system::version_check(&app, &ctx, host).await,
        Route::CodexProxyTraceGet => return system::codex_proxy_trace(&ctx, host).await,
        Route::ScanHistoryGet => return scan::history(&ctx, host).await,
        Route::ServerInfoOptions
        | Route::VersionCheckOptions
        | Route::CodexProxyTraceOptions
        | Route::ScanHistoryOptions => return options(&ctx, "GET,HEAD"),
        Route::DownloadOptions
        | Route::UploadStatsOptions
        | Route::ProviderLimitHistoryOptions
        | Route::ClaudeModelsOptions
        | Route::ClaudeSubscriptionOptions
        | Route::CodexSubscriptionOptions
        | Route::TokenUsageGlobalOptions => return options(&ctx, "GET,HEAD"),
        Route::TokenUsageByRoleOptions => return options(&ctx, "GET,HEAD"),
        Route::HostReadOptions(route) => return options(&ctx, route.allow()),
        Route::TurnLedgerOptions(route) => return options(&ctx, route.allow()),
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
        Route::TurnLedger(route) => return turn_ledger::handle(&ctx, route, host).await,
        Route::FilesGet => return file_transfer::files(&ctx, host).await,
        Route::SubagentDefaultsGet => return subagent_defaults::get(&app, &ctx, host).await,
        Route::SubagentDefaultsSync => {
            return subagent_defaults::sync(&app, &ctx, &body, host).await
        }
        Route::Providers(route) => return providers::handle(&app, route, &ctx, &body, host).await,
        Route::SessionGit(route) => {
            return session_git::handle(&app, route, &ctx, &body, host).await
        }
        Route::TaskShell(route) => return task_shell::handle(&app, route, &ctx, &body, host).await,
        Route::SessionAdmin(route) => {
            return session_admin::handle(&app, route, &ctx, &body, host).await
        }
        Route::SessionRoutes(route) => {
            return session_routes::handle(&app, route, &ctx, &body, host).await
        }
        Route::TaskRoutes(route) => {
            return task_routes::handle(&app, route, &ctx, &body, host).await
        }
        Route::Push(route) => return push_routes::handle(&app, route, &ctx, &body, host).await,
        Route::Air(route) => return air_routes::handle(&app, route, &ctx, &body, host).await,
        Route::Quota(route) => return quota_routes::handle(&app, route, &ctx, &body, host).await,
        Route::Account(route) => {
            return account_routes::handle(&app, route, &ctx, &body, host).await
        }
        Route::Events(route) => return event_routes::handle(&app, route, &ctx, &body, host).await,
        Route::DocsMemory(route) => {
            return docs_memory_routes::handle(&app, route, &ctx, &body, host).await
        }
        Route::Directory(route) => {
            return directory_routes::handle(&app, route, &ctx, &body, host).await
        }
        Route::ProviderBalance(route) => {
            return provider_balance::handle(&app, route, &ctx, host).await
        }
        Route::AutoProviderRouting(route) => {
            return auto_provider_routing::handle(&app, route, &ctx, &body, host).await
        }
        Route::VoiceGateway(route) => {
            return voice_gateway::handle(&app, route, &ctx, &body, host).await
        }
        Route::Voice(route) => return voice_routes::handle(&app, route, &ctx, &body, host).await,
        Route::VoiceRuntime(route) => {
            return voice_runtime::handle(&app, route, &ctx, &body, host).await
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
    fn user_home_uses_the_windows_profile_and_preserves_unix_home() {
        let profile = Some(r"C:\Users\pat".into());
        let home = Some("/home/pat".into());
        assert_eq!(
            select_user_home(true, profile.clone(), home.clone()),
            PathBuf::from(r"C:\Users\pat")
        );
        assert_eq!(
            select_user_home(false, profile, home.clone()),
            PathBuf::from("/home/pat")
        );
        assert_eq!(
            select_user_home(true, Some("".into()), home),
            PathBuf::from("/home/pat")
        );
    }

    #[test]
    fn literal_paths_union_the_param_shape_methods() {
        // `/api/sessions/import` and `/api/sessions/import-zip` are matched both
        // by the `:id` shape (session-admin's GET/HEAD, session-profile's
        // PATCH, session-lifecycle's DELETE) and by the literal bundle POST.
        for path in ["/api/sessions/import", "/api/sessions/import-zip"] {
            assert_eq!(
                options_allow(path).as_deref(),
                Some("GET,HEAD,PATCH,POST,DELETE"),
                "{path}"
            );
            assert_eq!(claim(&Method::OPTIONS, path), Some(Route::AutoOptions));
        }
    }

    #[test]
    fn a_pure_param_path_keeps_its_whole_allow() {
        assert_eq!(
            options_allow("/api/sessions/s1").as_deref(),
            Some("GET,HEAD,PATCH,DELETE")
        );
        // One cluster only: its own responder already holds the exact answer
        // (and its own host-failure message), so the front door leaves it there.
        assert_eq!(options_allow("/api/sessions/s1/memory"), None);
        assert!(matches!(
            claim(&Method::OPTIONS, "/api/sessions/s1/memory"),
            Some(Route::SessionRoutes(_))
        ));
        assert_eq!(options_allow("/api/v1/sessions/s1"), None);
    }

    #[test]
    fn multi_cluster_contributions_keep_express_order() {
        // Task-routes' literal POST registered before Air's `:id` GET/HEAD.
        assert_eq!(
            options_allow("/api/air/tasks/mark-achieved").as_deref(),
            Some("POST,GET,HEAD")
        );
        // session-admin's GET/HEAD registered before session-create's POST.
        assert_eq!(
            options_allow("/api/directories/d1/sessions").as_deref(),
            Some("GET,HEAD,POST")
        );
        // Model catalogs' `GET /api/providers/:id/models` shares its
        // three-segment shape with providers' `PATCH|DELETE
        // /api/providers/:appType/:id`; the retired server.js mounted the GET
        // first (mountProviderModelRoutes before mountManagementRoutes).
        assert_eq!(
            options_allow("/api/providers/Main/models").as_deref(),
            Some("GET,HEAD,PATCH,DELETE")
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/providers/Main/models"),
            Some(Route::AutoOptions)
        );
        // A provider management path has no catalog twin: its own responder
        // stays in charge.
        assert_eq!(options_allow("/api/providers/claude/claude-1"), None);
        assert_eq!(
            claim(&Method::OPTIONS, "/api/air/tasks/mark-achieved"),
            Some(Route::AutoOptions)
        );
    }

    #[test]
    fn unknown_paths_still_fall_through_to_node() {
        assert_eq!(options_allow("/api/not-a-route"), None);
        assert_eq!(claim(&Method::OPTIONS, "/api/not-a-route"), None);
        assert_eq!(claim(&Method::OPTIONS, "/api/nope/nothing"), None);
        assert_eq!(
            claim(&Method::OPTIONS, "/api/sessions"),
            Some(Route::SessionAdmin(session_admin::Route::Options {
                allow: "GET,HEAD",
                guard_segment: None
            }))
        );
        // The guard mount is a path shape, not a cluster: it never makes a
        // path the front door does not own into an answer.
        assert_eq!(guard_segment("/api/sessions/import"), Some(1));
        assert_eq!(guard_segment("/api/v1/sessions/s1"), Some(2));
        assert_eq!(guard_segment("/api/directories/d1/sessions"), None);
    }

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
        for (path, mixed, get) in [
            (
                "/api/server-info",
                "/api/Server-Info/",
                Route::ServerInfoGet,
            ),
            (
                "/api/version-check",
                "/api/Version-Check/",
                Route::VersionCheckGet,
            ),
            (
                "/api/debug/codex-proxy-trace",
                "/api/Debug/Codex-Proxy-Trace/",
                Route::CodexProxyTraceGet,
            ),
            (
                "/api/scan/history",
                "/api/Scan/History/",
                Route::ScanHistoryGet,
            ),
        ] {
            assert_eq!(claim(&Method::GET, path), Some(get));
            assert_eq!(claim(&Method::HEAD, mixed), Some(get));
            assert!(matches!(
                claim(&Method::OPTIONS, path),
                Some(Route::ServerInfoOptions)
                    | Some(Route::VersionCheckOptions)
                    | Some(Route::CodexProxyTraceOptions)
                    | Some(Route::ScanHistoryOptions)
            ));
            assert_eq!(claim(&Method::POST, path), None);
            assert_eq!(claim(&Method::GET, &format!("{path}//")), None);
            assert_eq!(claim(&Method::GET, &path.replace("/api/", "/API/")), None);
        }
        assert_eq!(claim(&Method::GET, "/api/debug"), None);
        assert_eq!(claim(&Method::GET, "/api/scan"), None);
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
