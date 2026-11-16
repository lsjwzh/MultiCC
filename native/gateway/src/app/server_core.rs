//! The server-core cluster retired from `server.js` + `src/health.js`:
//!
//! ```text
//! GET|HEAD  /healthz                            -> 200 {status,uptimeSeconds,requestId}
//! GET|HEAD  /readyz                             -> 200|503 {status,requestId[,checks]}
//! GET|HEAD  /metrics                            -> 200 text/plain; charset=utf-8; version=0.0.4
//! GET|HEAD  /api/repo-operations/:operationId   -> 200 operation | 404 {error}
//! ```
//!
//! `/healthz` and `/readyz` are public paths (the shared HTTP-entry exemption);
//! `/metrics` is not, and `/api/repo-operations` sits behind the ordinary gate —
//! an unauthenticated non-API GET is redirected to `/login`, exactly like the
//! retired Express stack (src/routes/auth.js). The peer allowlist runs for every
//! path first, public ones included.
//!
//! Every fact behind these routes lives in the Node child: process uptime, the
//! readiness flags (`serviceReady`, the shutdown flag, the commander-migration
//! snapshot), the merged metrics table and the repo-actor operation status. They
//! cross one host port, `POST /api/__host/server-core`
//! (`src/routes/server-core-host.js`); this module validates the DTO, renders the
//! response and reproduces Express's headers. `/metrics` is sorted and serialized
//! here, from the merged `{ name: number }` table the host returns.
//!
//! Sorting premise. The retired `metrics.render` sorted with
//! `([a],[b]) => a.localeCompare(b)`. ICU collation is NOT byte order in general
//! (`a_b` sorts before `a:b`, and `a_1` before `a1`), but every metric name this
//! process emits uses the same `[a-z0-9_]+` snake_case shape with underscores at
//! the same positions up to the first differing word, and for that alphabet the
//! two orders coincide (verified against the full static name set). The
//! differential corpus only uses names where they agree.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::auth_runtime::Snapshot;
use multicc_core::http_gate::{self, is_private_network_address};
use multicc_core::js::serde::number_to_js_string;
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::App;
use crate::host_port;

/// The host port the Node child serves (`src/routes/server-core-host.js`).
const HOST_PATH: &str = "/api/__host/server-core";
const METRICS_CONTENT_TYPE: &str = "text/plain; charset=utf-8; version=0.0.4";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Healthz,
    Readyz,
    Metrics,
    RepoOperation,
    /// Express's automatic OPTIONS answer. `public` is the HTTP-entry exemption:
    /// `/healthz` and `/readyz` skip the auth gate, `/metrics` and
    /// `/api/repo-operations` do not.
    Options {
        public: bool,
    },
}

fn get_like(method: &Method) -> bool {
    *method == Method::GET || *method == Method::HEAD
}

/// Express matched these paths case-insensitively with one optional trailing
/// slash. The `/api/` prefix must keep its exact case: Node's gate and JSON gzip
/// test `req.path.startsWith('/api/')` case-sensitively (see `App::claim`).
pub fn claim(method: &Method, path: &str) -> Option<Route> {
    let read = get_like(method);
    let options = *method == Method::OPTIONS;
    let trimmed = path.strip_suffix('/').unwrap_or(path);
    let root = |candidate: &str| trimmed.eq_ignore_ascii_case(candidate);
    if root("/healthz") {
        return read
            .then_some(Route::Healthz)
            .or_else(|| options.then_some(Route::Options { public: true }));
    }
    if root("/readyz") {
        return read
            .then_some(Route::Readyz)
            .or_else(|| options.then_some(Route::Options { public: true }));
    }
    if root("/metrics") {
        return read
            .then_some(Route::Metrics)
            .or_else(|| options.then_some(Route::Options { public: false }));
    }
    operation_segment(path)?;
    read.then_some(Route::RepoOperation)
        .or_else(|| options.then_some(Route::Options { public: false }))
}

/// The raw `:operationId` segment of `/api/repo-operations/<segment>`, matched
/// like the Express layer: exact-case `/api/` prefix, one optional trailing
/// slash, exactly one non-empty segment (a literal `/` ends the parameter).
fn operation_segment(path: &str) -> Option<&str> {
    let rest = path.strip_prefix("/api/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let (head, tail) = rest.split_once('/')?;
    if !head.eq_ignore_ascii_case("repo-operations") || tail.is_empty() || tail.contains('/') {
        return None;
    }
    Some(tail)
}

fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        503,
        &json!({
            "error": "服务核心接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

/// Differential-only mutations. `docs/rust-migration/differential/server-core.js`
/// reruns the corpus with one of these set to prove it fails when the new code
/// drifts (the brief's three cases: sort direction, a missing space in the
/// Content-Type, and the 404 text). Unset (the production default) applies
/// nothing, so this costs one environment lookup per rendered response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mutation {
    None,
    SortDesc,
    ContentTypeSpace,
    NotFoundText,
}

fn mutation() -> Mutation {
    match std::env::var("MULTICC_SERVER_CORE_MUTATION").as_deref() {
        Ok("sort-desc") => Mutation::SortDesc,
        Ok("content-type-space") => Mutation::ContentTypeSpace,
        Ok("not-found-text") => Mutation::NotFoundText,
        _ => Mutation::None,
    }
}

fn metrics_content_type() -> &'static str {
    match mutation() {
        Mutation::ContentTypeSpace => "text/plain;charset=utf-8; version=0.0.4",
        _ => METRICS_CONTENT_TYPE,
    }
}

fn not_found_message() -> &'static str {
    match mutation() {
        Mutation::NotFoundText => "operation not found!",
        _ => "operation not found",
    }
}

/// The merged metrics table (`name value` per line, sorted ascending by name,
/// trailing newline). Empty input renders as a single newline, matching the
/// retired `[…].join('\n') + '\n'`.
pub fn render_metrics(table: &Map<String, Value>) -> String {
    let mut entries: Vec<(&str, &Value)> = table
        .iter()
        .map(|(name, value)| (name.as_str(), value))
        .collect();
    entries.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    if mutation() == Mutation::SortDesc {
        entries.reverse();
    }
    let mut out = String::new();
    for (name, value) in entries {
        let Some(number) = value.as_number() else {
            continue;
        };
        let Some(as_f64) = number.as_f64() else {
            continue;
        };
        if !as_f64.is_finite() {
            continue;
        }
        out.push_str(name);
        out.push(' ');
        out.push_str(&number_to_js_string(number));
        out.push('\n');
    }
    if out.is_empty() {
        out.push('\n');
    }
    out
}

/// The host's `{ op: "health" }` answer, or the standard 503 when the child is
/// absent or answers a shape this route cannot trust.
async fn health_facts(host: u16) -> Option<Value> {
    let value = host_port::call(host, HOST_PATH, &json!({ "op": "health" }))
        .await
        .ok()?;
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    Some(value)
}

async fn healthz(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let Some(value) = health_facts(host).await else {
        return unavailable(ctx);
    };
    let Some(uptime) = value.get("uptimeSeconds").filter(|v| v.is_number()) else {
        return unavailable(ctx);
    };
    express::json(
        ctx,
        200,
        &json!({
            "status": "ok",
            "uptimeSeconds": uptime,
            "requestId": &ctx.ids.0,
        }),
        &[("Cache-Control", "no-store")],
    )
}

async fn readyz(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let Some(value) = health_facts(host).await else {
        return unavailable(ctx);
    };
    let Some(ready) = value.get("ready").and_then(Value::as_bool) else {
        return unavailable(ctx);
    };
    let mut body = Map::new();
    body.insert(
        "status".to_string(),
        Value::String(if ready { "ready" } else { "not_ready" }.to_string()),
    );
    body.insert("requestId".to_string(), Value::String(ctx.ids.0.clone()));
    // `if (checks && typeof checks === 'object') body.checks = checks;` —
    // appended after requestId, so the key order stays status, requestId, checks.
    if let Some(checks) = value.get("checks") {
        if checks.is_object() || checks.is_array() {
            body.insert("checks".to_string(), checks.clone());
        }
    }
    express::json(
        ctx,
        if ready { 200 } else { 503 },
        &Value::Object(body),
        &[("Cache-Control", "no-store")],
    )
}

async fn metrics(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let value = match host_port::call(host, HOST_PATH, &json!({ "op": "metrics" })).await {
        Ok(value) => value,
        Err(_) => return unavailable(ctx),
    };
    let Some(table) = value.get("metrics").and_then(Value::as_object) else {
        return unavailable(ctx);
    };
    // Every value must be a JSON number; a stale child that sends anything else
    // is a shape this route cannot reproduce, so answer the standard 503.
    if table.values().any(|value| !value.is_number()) {
        return unavailable(ctx);
    }
    express::send(
        ctx,
        200,
        metrics_content_type(),
        render_metrics(table).into_bytes(),
        &[],
    )
}

async fn repo_operation(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let Some(raw) = operation_segment(&ctx.path) else {
        // Claimed only when the matcher accepted it.
        return express::error(ctx, 500, "repo-operation route claimed without a segment");
    };
    // `decodeURIComponent` for the operation id; a throw is Express's own 400
    // ("Failed to decode param"), handled by the error middleware.
    let Some(id) = super::download::decode_uri_component(raw) else {
        return express::error(ctx, 400, "Failed to decode param");
    };
    let answer = host_port::call(
        host,
        HOST_PATH,
        &json!({ "op": "repoOperation", "operationId": id }),
    )
    .await;
    match answer {
        Ok(value) if value.get("ok").and_then(Value::as_bool) == Some(true) => {
            match value.get("operation") {
                Some(Value::Null) => {
                    express::json(ctx, 404, &json!({ "error": not_found_message() }), &[])
                }
                Some(operation @ Value::Object(_)) => express::json(ctx, 200, operation, &[]),
                _ => unavailable(ctx),
            }
        }
        Ok(_) => unavailable(ctx),
        Err(_) => unavailable(ctx),
    }
}

pub async fn handle(
    app: &Arc<App>,
    route: Route,
    ctx: &RequestCtx,
    peer: &str,
    snapshot: &Snapshot,
    host: u16,
) -> Response<Body> {
    // Node's `gate('peer')` runs for every path, public ones included.
    if app.lan_only && !is_private_network_address(peer) {
        return express::json(
            ctx,
            403,
            &http_gate::public_peer_rejected_dto(&ctx.ids),
            &[],
        );
    }
    let public = matches!(
        route,
        Route::Healthz | Route::Readyz | Route::Options { public: true }
    );
    if !public {
        if let Some(refusal) = app.gate(ctx, peer, snapshot).await {
            return refusal;
        }
    }
    match route {
        Route::Healthz => healthz(ctx, host).await,
        Route::Readyz => readyz(ctx, host).await,
        Route::Metrics => metrics(ctx, host).await,
        Route::RepoOperation => repo_operation(ctx, host).await,
        Route::Options { .. } => super::options(ctx, "GET,HEAD"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn get(path: &str) -> Option<Route> {
        claim(&Method::GET, path)
    }

    #[test]
    fn claim_matches_root_literals_case_insensitively_with_optional_slash() {
        assert_eq!(get("/healthz"), Some(Route::Healthz));
        assert_eq!(get("/Healthz/"), Some(Route::Healthz));
        assert_eq!(get("/readyz"), Some(Route::Readyz));
        assert_eq!(get("/metrics/"), Some(Route::Metrics));
        assert_eq!(claim(&Method::HEAD, "/healthz"), Some(Route::Healthz));
        assert_eq!(
            claim(&Method::OPTIONS, "/healthz"),
            Some(Route::Options { public: true })
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/metrics"),
            Some(Route::Options { public: false })
        );
        assert_eq!(claim(&Method::POST, "/healthz"), None);
    }

    #[test]
    fn claim_matches_the_operation_segment_only_for_exact_api_prefix() {
        assert_eq!(get("/api/repo-operations/op-1"), Some(Route::RepoOperation));
        assert_eq!(
            get("/api/repo-operations/op-1/"),
            Some(Route::RepoOperation)
        );
        assert_eq!(get("/api/Repo-Operations/op-1"), Some(Route::RepoOperation));
        assert_eq!(get("/api/repo-operations/"), None);
        assert_eq!(get("/api/repo-operations/a/b"), None);
        // Exact-case `/api/`: an upper-case prefix would take a different gate
        // branch in Node, so it is not claimed here.
        assert_eq!(get("/API/repo-operations/op-1"), None);
        assert_eq!(
            claim(&Method::OPTIONS, "/api/repo-operations/op-1"),
            Some(Route::Options { public: false })
        );
        assert_eq!(claim(&Method::POST, "/api/repo-operations/op-1"), None);
    }

    #[test]
    fn operation_segment_keeps_the_raw_value() {
        assert_eq!(
            operation_segment("/api/repo-operations/a%2Fb"),
            Some("a%2Fb")
        );
        assert_eq!(operation_segment("/api/repo-operations/a b"), Some("a b"));
    }

    #[test]
    fn render_sorts_by_name_and_ends_with_one_newline() {
        let table = Map::from_iter([
            ("multicc_ws_clients".to_string(), json!(2)),
            ("multicc_active_turns".to_string(), json!(1)),
            ("multicc_git_queue_depth".to_string(), json!(0)),
        ]);
        assert_eq!(
            render_metrics(&table),
            "multicc_active_turns 1\nmulticc_git_queue_depth 0\nmulticc_ws_clients 2\n"
        );
    }

    #[test]
    fn render_uses_js_number_formatting() {
        let table = Map::from_iter([
            ("multicc_decimal".to_string(), json!(0.5)),
            ("multicc_big".to_string(), json!(1e21)),
            ("multicc_int".to_string(), json!(5)),
        ]);
        assert_eq!(
            render_metrics(&table),
            "multicc_big 1e+21\nmulticc_decimal 0.5\nmulticc_int 5\n"
        );
    }

    #[test]
    fn empty_metrics_render_as_a_single_newline() {
        assert_eq!(render_metrics(&Map::new()), "\n");
    }
}
