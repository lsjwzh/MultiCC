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
//! The GitHub release fetch moved here. Node's `https.get` reads no proxy
//! environment variables, so this client is deliberately direct too; the
//! certificate story mirrors the service transport (native roots plus
//! `NODE_EXTRA_CA_CERTS`). One test hook exists:
//! `MULTICC_VERSION_CHECK_RELEASES_URL` retargets the fetch (and may be plain
//! HTTP), which is how the integration tests and the differential harness
//! script the upstream answer.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::Response;
use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper_rustls::HttpsConnectorBuilder;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use multicc_core::http_gate::query_value;
use multicc_core::system_info;
use serde_json::{json, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::App;
use crate::host_port;

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

/// `fetchLatestRelease`: direct TLS (no proxy variables, like `https.get`),
/// the two documented headers, and no status check — the retired code parsed
/// the body whatever the status, so a 404 with a JSON body was a quiet
/// "no tag", not an error.
async fn fetch_latest_release() -> Result<Option<String>, ()> {
    use rustls::pki_types::{pem::PemObject, CertificateDer};
    let mut roots = rustls::RootCertStore::empty();
    roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
    if let Some(file) = std::env::var_os("NODE_EXTRA_CA_CERTS").filter(|path| !path.is_empty()) {
        if let Ok(pem) = std::fs::read(file) {
            roots.add_parsable_certificates(
                CertificateDer::pem_slice_iter(&pem).filter_map(Result::ok),
            );
        }
    }
    let tls = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connector = HttpsConnectorBuilder::new()
        .with_tls_config(tls)
        .https_or_http()
        .enable_http1()
        .build();
    let client = Client::builder(TokioExecutor::new()).build::<_, Full<Bytes>>(connector);
    let url = std::env::var("MULTICC_VERSION_CHECK_RELEASES_URL")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| RELEASES_URL.to_owned());
    let request = hyper::http::Request::builder()
        .method("GET")
        .uri(url)
        .header("user-agent", "multicc-version-check/1.0")
        .header("accept", "application/vnd.github+json")
        .body(Full::new(Bytes::new()))
        .map_err(|_| ())?;
    let response = tokio::time::timeout(FETCH_TIMEOUT, client.request(request))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
    let body = tokio::time::timeout(FETCH_TIMEOUT, response.into_body().collect())
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?;
    let parsed: Value = serde_json::from_slice(&body.to_bytes()).map_err(|_| ())?;
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
    match fetch_latest_release().await {
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
