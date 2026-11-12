//! `GET/HEAD /api/server-info`, `GET/HEAD /api/version-check` and
//! `GET/HEAD /api/debug/codex-proxy-trace`, retired from `src/routes/system.js`.
//!
//! The rules — LAN address ranking, semver comparison, remote tag selection,
//! the DTO shapes and their key order — live in `multicc_core::system_info`.
//! Node keeps only what a front-door process cannot know: its own network
//! interfaces, port/bind, uptime, the cached install version, the Codex proxy
//! trace ring, and `git ls-remote` (repo-actor owns the git environment: the
//! runtime-patched PATH, the non-interactive env and the per-repo queue). All
//! of that crosses the host port ([`crate::host_port`]); see
//! `src/routes/system-host.js` for that side.
//!
//! The GitHub release fetch moved here and uses the front door's shared
//! outbound client ([`crate::outbound`]), so it follows the same proxy policy
//! as the Node runtime (loopback direct, `NO_PROXY` direct, HTTP(S) proxy
//! otherwise); the certificate story is native roots plus
//! `NODE_EXTRA_CA_CERTS`. Redirects stay unfolded, like the retired
//! `https.get`. One test hook exists: `MULTICC_VERSION_CHECK_RELEASES_URL`
//! retargets the fetch (and may be plain HTTP), which is how the integration
//! tests and the differential harness script the upstream answer.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::Response;
use multicc_core::http_gate::query_value;
use multicc_core::system_info;
use serde_json::{json, Value};
use url::Url;

use crate::app::express::{self, RequestCtx};
use crate::app::App;
use crate::host_port;
use crate::outbound::{Outbound, Request};

/// The host port the Node child serves (`src/routes/system-host.js`).
const HOST_PATH: &str = "/api/__host/system";

const RELEASES_URL: &str = "https://api.github.com/repos/lsjwzh/MultiCC/releases/latest";

/// Node's `https.get(…, { timeout: 15000 })` is a socket-inactivity timeout;
/// this is a whole-request deadline instead (documented in docs/gateway.md §9).
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);

fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        503,
        &json!({
            "error": "主机信息接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

/// `GET /api/server-info`: Node reports its own facts, Rust ranks and renders.
pub async fn server_info(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let facts = match host_port::call(host, HOST_PATH, &json!({ "op": "server-info" })).await {
        Ok(value) => value,
        Err(_) => return unavailable(ctx),
    };
    express::json(ctx, 200, &system_info::server_info(&facts), &[])
}

/// `GET /api/debug/codex-proxy-trace`: the limit rule is Rust's
/// (`Number(…)` + `Number.isInteger && > 0`, capped at 200); the ring is
/// Node's, and the host applies the slice it was given.
pub async fn codex_proxy_trace(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let limit = system_info::proxy_trace_limit(&query_value(&ctx.original_url, "limit"));
    let answer = host_port::call(host, HOST_PATH, &json!({ "op": "trace", "limit": limit })).await;
    match answer {
        Ok(value) => match value.get("entries") {
            Some(entries @ Value::Array(_)) => {
                express::json(ctx, 200, &json!({ "entries": entries }), &[])
            }
            _ => unavailable(ctx),
        },
        Err(_) => unavailable(ctx),
    }
}

/// The frozen fallback DTO: `res.json({ ...DEFAULT_VERSION_RESULT })` after
/// `readInstallMetadata` threw.
fn default_version_result(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        200,
        &system_info::version_check(&json!({
            "current": "0.0.0",
            "channel": "dev",
            "latest": null,
            "apiError": true,
        })),
        &[],
    )
}

/// `readInstallMetadata` on the package root the front door itself resolved.
/// Any failure (missing or malformed package.json) maps to the default DTO,
/// exactly the retired handler's catch.
fn read_install_metadata(app: &App) -> Option<(String, String)> {
    let package_json = std::fs::read_to_string(app.package_root.join("package.json")).ok()?;
    let channel_sidecar = std::fs::read_to_string(app.package_root.join(".multicc_channel")).ok();
    system_info::install_metadata(&package_json, channel_sidecar.as_deref())
}

/// `fetchLatestRelease`: the shared outbound client with the two documented
/// headers and no status check — the retired code parsed the body whatever
/// the status, so a 404 with a JSON body was a quiet "no tag", not an error.
async fn fetch_latest_release(outbound: &Outbound) -> Result<Option<String>, ()> {
    let url = std::env::var("MULTICC_VERSION_CHECK_RELEASES_URL")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| RELEASES_URL.to_owned());
    let url = Url::parse(&url).map_err(|_| ())?;
    let mut request = Request::get(url, FETCH_TIMEOUT);
    request.headers = vec![
        (
            "user-agent".to_string(),
            "multicc-version-check/1.0".to_string(),
        ),
        (
            "accept".to_string(),
            "application/vnd.github+json".to_string(),
        ),
    ];
    let reply = outbound.send(request).await.map_err(|_| ())?;
    let parsed: Value = serde_json::from_slice(&reply.body).map_err(|_| ())?;
    // `release && release.tag_name ? release.tag_name : null`.
    Ok(match parsed.get("tag_name") {
        Some(Value::String(tag)) if !tag.is_empty() => Some(tag.clone()),
        _ => None,
    })
}

/// `GET /api/version-check`. This route never 503s: the retired handler caught
/// everything into the frozen default DTO, and a failed tag discovery (API
/// error or git fallback miss) is data, not an outage.
pub async fn version_check(app: &Arc<App>, ctx: &RequestCtx, host: u16) -> Response<Body> {
    let Some((current, channel)) = read_install_metadata(app) else {
        return default_version_result(ctx);
    };
    let mut latest: Option<String> = None;
    let mut api_error = false;
    match fetch_latest_release(&app.outbound).await {
        Ok(tag) => latest = tag,
        Err(_) => api_error = true,
    }
    if latest.is_none() {
        // The git fallback keeps repo-actor's semantics (queue, PATH, env) by
        // asking the host to run it; a failure here is silent, like the
        // retired `catch (_) {}`.
        if let Ok(value) = host_port::call(host, HOST_PATH, &json!({ "op": "ls-remote" })).await {
            if value.get("ok").and_then(Value::as_bool) == Some(true) {
                latest = system_info::latest_tag_from_remote(
                    value.get("output").and_then(Value::as_str).unwrap_or(""),
                );
            }
        }
    }
    express::json(
        ctx,
        200,
        &system_info::version_check(&json!({
            "current": current,
            "channel": channel,
            "latest": latest,
            "apiError": api_error,
        })),
        &[],
    )
}
