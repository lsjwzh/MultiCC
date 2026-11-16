//! The plugin cluster retired from `src/routes/plugins.js`:
//!
//! ```text
//! POST   /api/channels/recheck   -> 403 non-local | 200 {items:[{sessionId,category,active}]}
//! GET    /api/channels           -> 200 {available,plugins:[…]}
//! HEAD   /api/channels           -> same headers, no body
//! GET    /plugins/:id/*          -> 200 file | 400/403/404 | 500 (unreadable plugin dir)
//! HEAD   /plugins/:id/*          -> same headers, no body
//! OPTIONS                        -> Express's automatic answer
//! ```
//!
//! `POST /api/channels/recheck` and `GET|HEAD /api/channels` sit behind the
//! ordinary gate (`App::gate`): an anonymous call is the API 403. Recheck then
//! adds its own locality check on the real client address (`isLocalRequest`,
//! the same rule Node used — never the Host header). The channels answer adds
//! no extra authority check; it reads the same `Cache-Control: no-store`
//! `{available, plugins}` projection as before, with `channelsStatus` supplying
//! the registry and host facts.
//!
//! `/plugins/:id/*` is NOT simply behind the gate. The retired route was
//! mounted after Node's auth gate, and that gate lets a path through without a
//! login when [`multicc_core::http_entry::public_path`] says so — for a
//! non-`/api/` path that is every static extension (`.js .css .png .jpg .jpeg
//! .gif .svg .ico .woff .woff2 .ttf .json .apk .ipa`, case-insensitive). So an
//! anonymous `GET /plugins/x/ui/app.js` was a 200 while `index.html` or an
//! extensionless file was the HTML login redirect: a plugin page needs a login
//! but its sub-resources never did. The file route therefore runs the peer
//! allowlist for every path, exempts the public ones from the login gate and
//! sends the rest through `App::gate` (`handle_file`), exactly like the other
//! clusters that decide gate-or-not themselves.
//!
//! The Node process stays the owner of the two facts this front door cannot
//! see: which directory an id resolves to (the built-in plugin roots, their
//! manifests and the `readManifest` validation) and whether a task's question
//! is still open (the in-process channel registry). Both cross one host port,
//! `POST /api/__host/plugins` (src/routes/plugins-host.js):
//!
//! * `findPlugin {id}` -> `{ok:true,found:false}` or
//!   `{ok:true,found:true,dir,ui}`; the front door redoes every realpath and
//!   subtree decision itself and reads the file.
//! * `channelStillActive {items}` -> `{ok:true,active:[bool,…]}`, one answer
//!   per item, same order.
//! * `channelsStatus {}` -> `{ok:true,available:<bool>,plugins:[…],usage:[…]}`,
//!   `channelHost.status()` and `channelRegistry.usage()` verbatim; the front
//!   door applies the retired `inUse`/`subscriptions`/`uses` projection.
//!
//! Anything else — a transport failure, a malformed answer, a length mismatch,
//! `--no-node` (port 0 fails at once) — is the route's 503
//! `rust_backend_unavailable`, the same unavailable shape as the other host
//! port clusters. The one well-formed non-success answer the host can produce
//! (`{ok:false}` for a manifest whose `ui` is not a string) replays the 500
//! the retired handler produced when `path.dirname` threw.
//!
//! Rules (the projection, the path gate, containment, MIME) live in
//! [`multicc_core::plugin_routes`]; this module only wires them to Express's
//! response shapes.

// Express refusals are values here (`Err(Response)`), so the error variant is a
// full response body; the same shape is allowed in `native/addon`,
// `native/cdpd` and the other front-door clusters.
#![allow(clippy::result_large_err)]

use std::path::Path;

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::http_gate;
use multicc_core::plugin_routes::{self, Item, PluginFileError};
use serde_json::{json, Value};

use crate::app::express::{self, RequestCtx};
use crate::host_port;

/// The host port the Node child serves (`src/routes/plugins-host.js`).
const HOST_PATH: &str = "/api/__host/plugins";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// `POST /api/channels/recheck`
    Recheck,
    /// Express's automatic OPTIONS for the one registered method.
    RecheckOptions,
    /// `GET|HEAD /api/channels`
    Channels,
    /// Express's automatic OPTIONS for the registered read pair.
    ChannelsOptions,
    /// `GET|HEAD /plugins/:id/*`
    File,
    /// Express's automatic OPTIONS for the registered read pair.
    FileOptions,
}

/// Segment view of `/api/<rest>`, one optional trailing slash removed. The
/// `/api/` prefix must keep its exact case (see `App::claim`); literal segments
/// match case-insensitively like Express.
fn segments(path: &str) -> Option<Vec<&str>> {
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

fn recheck_path(path: &str) -> bool {
    segments(path).is_some_and(|parts| {
        parts.len() == 2
            && parts[0].eq_ignore_ascii_case("channels")
            && parts[1].eq_ignore_ascii_case("recheck")
    })
}

/// `GET|HEAD /api/channels`: exactly one literal segment after `/api/`, so
/// `/api/channels/targets` and `/api/channels/recheck` stay unclaimed here.
fn channels_path(path: &str) -> bool {
    segments(path)
        .is_some_and(|parts| parts.len() == 1 && parts[0].eq_ignore_ascii_case("channels"))
}

/// `strip_prefix` with Express's case-insensitive literal matching.
fn strip_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &text[prefix.len()..])
}

/// `app.get('/plugins/:id/*')` in path-to-regexp 0.1.13's own terms:
/// `/^\/plugins(?:\/([^/]+?))\/(.*)\/?$/i`. The slash after `:id` is
/// mandatory, so `/plugins/x` (no second segment) never matches and stays
/// unclaimed — the retired route pushed it on to the next layers. One
/// optional trailing slash is already inside `(.*)`, which is greedy
/// (`/plugins/x/a/` captures `a/`).
fn file_params(path: &str) -> Option<(&str, &str)> {
    let rest = strip_prefix_ci(path, "/plugins")?;
    let rest = rest.strip_prefix('/')?;
    let (id, wildcard) = rest.split_once('/')?;
    (!id.is_empty()).then_some((id, wildcard))
}

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    if recheck_path(path) {
        match method.as_str() {
            "POST" => return Some(Route::Recheck),
            "OPTIONS" => return Some(Route::RecheckOptions),
            _ => {}
        }
    }
    if channels_path(path) {
        match method.as_str() {
            "GET" | "HEAD" => return Some(Route::Channels),
            "OPTIONS" => return Some(Route::ChannelsOptions),
            _ => {}
        }
    }
    if file_params(path).is_some() {
        match method.as_str() {
            "GET" | "HEAD" => return Some(Route::File),
            "OPTIONS" => return Some(Route::FileOptions),
            _ => {}
        }
    }
    None
}

fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        503,
        &json!({
            "error": "插件接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

fn error_json(ctx: &RequestCtx, status: u16, message: &str) -> Response<Body> {
    express::json(ctx, status, &json!({ "error": message }), &[])
}

/// `decodeURIComponent` for one route parameter; `None` is Express's 400
/// (raised during routing, before the handler or any host call).
fn decoded(ctx: &RequestCtx, raw: &str) -> Result<String, Response<Body>> {
    super::download::decode_uri_component(raw)
        .ok_or_else(|| express::error(ctx, 400, "Failed to decode param"))
}

// ── POST /api/channels/recheck ─────────────────────────────────────────────

async fn recheck(ctx: &RequestCtx, body: &Value, peer: &str, host: u16) -> Response<Body> {
    // `isLocalRequest(req)`: the real client address, not the Host header.
    if !http_gate::is_local_request(peer, &ctx.headers) {
        return error_json(ctx, 403, plugin_routes::ERR_LOCAL_ONLY);
    }
    let items = plugin_routes::normalize_recheck_items(body);
    // `items.filter(...)` empty means the registry is never asked.
    let active = if items.is_empty() {
        Vec::new()
    } else {
        match still_active(ctx, host, &items).await {
            Ok(active) => active,
            Err(response) => return response,
        }
    };
    express::send(
        ctx,
        200,
        "application/json; charset=utf-8",
        plugin_routes::recheck_response(&items, &active).into_bytes(),
        &[("Cache-Control", plugin_routes::RECHECK_CACHE_CONTROL)],
    )
}

/// One `channelStillActive` round trip. The transport form is lossy UTF-8: a
/// lone surrogate left by a 128/32-unit cut reaches Node as U+FFFD, exactly
/// like the retired JS→Rust JSON edge did; the rendered response still carries
/// the original code unit.
async fn still_active(
    ctx: &RequestCtx,
    host: u16,
    items: &[Item],
) -> Result<Vec<bool>, Response<Body>> {
    let payload = json!({
        "op": "channelStillActive",
        "items": items
            .iter()
            .map(|item| json!({
                "sessionId": item.session_id.to_string_lossy(),
                "category": item.category.to_string_lossy(),
            }))
            .collect::<Vec<Value>>(),
    });
    let answer = host_port::call(host, HOST_PATH, &payload)
        .await
        .map_err(|_| unavailable(ctx))?;
    if answer.get("ok") != Some(&Value::Bool(true)) {
        return Err(unavailable(ctx));
    }
    let values = answer
        .get("active")
        .and_then(Value::as_array)
        .ok_or_else(|| unavailable(ctx))?;
    // Same length, same order, booleans only.
    if values.len() != items.len() {
        return Err(unavailable(ctx));
    }
    values
        .iter()
        .map(Value::as_bool)
        .collect::<Option<Vec<bool>>>()
        .ok_or_else(|| unavailable(ctx))
}

// ── GET|HEAD /api/channels ─────────────────────────────────────────────────

/// The two host facts the retired handler read in-process plus the projected
/// plugin list.
struct ChannelFacts {
    available: bool,
    plugins: Vec<Value>,
}

/// One `channelsStatus` round trip. `{ok:false}`, a non-bool `available`, a
/// non-array `plugins`/`usage`, or a non-object plugin element is the route's
/// 503 — the same contract as the other host-port clusters.
async fn channel_status(ctx: &RequestCtx, host: u16) -> Result<ChannelFacts, Response<Body>> {
    let answer = host_port::call(host, HOST_PATH, &json!({ "op": "channelsStatus" }))
        .await
        .map_err(|_| unavailable(ctx))?;
    if answer.get("ok") != Some(&Value::Bool(true)) {
        return Err(unavailable(ctx));
    }
    let available = answer
        .get("available")
        .and_then(Value::as_bool)
        .ok_or_else(|| unavailable(ctx))?;
    let plugins = answer
        .get("plugins")
        .and_then(Value::as_array)
        .ok_or_else(|| unavailable(ctx))?;
    let usage = answer
        .get("usage")
        .and_then(Value::as_array)
        .ok_or_else(|| unavailable(ctx))?;
    let plugins = plugin_routes::shape_channels(plugins, usage).map_err(|_| unavailable(ctx))?;
    Ok(ChannelFacts { available, plugins })
}

async fn channels(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let facts = match channel_status(ctx, host).await {
        Ok(facts) => facts,
        Err(response) => return response,
    };
    express::send(
        ctx,
        200,
        "application/json; charset=utf-8",
        plugin_routes::channels_response(facts.available, &facts.plugins).into_bytes(),
        &[("Cache-Control", plugin_routes::CHANNELS_CACHE_CONTROL)],
    )
}

// ── GET|HEAD /plugins/:id/* ────────────────────────────────────────────────

struct PluginFact {
    /// `found.dir`, unresolved: the front door realpaths it itself.
    dir: String,
    /// `found.manifest.ui || 'ui/index.html'` as the host port reported it.
    ui: String,
}

async fn find_plugin(
    ctx: &RequestCtx,
    host: u16,
    id: &str,
) -> Result<Option<PluginFact>, Response<Body>> {
    let answer = host_port::call(host, HOST_PATH, &json!({ "op": "findPlugin", "id": id }))
        .await
        .map_err(|_| unavailable(ctx))?;
    match answer.get("ok") {
        Some(Value::Bool(true)) => {}
        Some(Value::Bool(false)) => {
            // A manifest whose `ui` is a truthy non-string: the retired
            // `path.dirname(found.manifest.ui || 'ui/index.html')` threw a
            // TypeError and `safeErrorHandler` answered 500. The message is
            // log-only, like every other 500 detail.
            let detail = answer
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("invalid plugin manifest ui");
            return Err(express::error(ctx, 500, detail));
        }
        _ => return Err(unavailable(ctx)),
    }
    match answer.get("found") {
        Some(Value::Bool(false)) => Ok(None),
        Some(Value::Bool(true)) => {
            let dir = answer
                .get("dir")
                .and_then(Value::as_str)
                .ok_or_else(|| unavailable(ctx))?;
            let ui = match answer.get("ui") {
                None | Some(Value::Null) => plugin_routes::DEFAULT_UI.to_string(),
                Some(Value::String(ui)) => ui.clone(),
                Some(_) => return Err(unavailable(ctx)),
            };
            Ok(Some(PluginFact {
                dir: dir.to_string(),
                ui,
            }))
        }
        _ => Err(unavailable(ctx)),
    }
}

enum FileOutcome {
    Ok {
        body: Vec<u8>,
        mime: &'static str,
    },
    /// `fs.realpathSync(found.dir)` threw: the retired handler's 500.
    RootUnreadable(String),
    /// realpath of the target failed, or the read did (a directory included).
    NotFound,
    /// Outside `root + sep` (a symlink escapes the plugin directory).
    OutsideRoot,
    /// Inside the plugin but outside `join(root, dirname(ui))`.
    OutsideUi,
}

/// The retired handler's synchronous core, on a blocking thread. Order is the
/// contract: root realpath (500 on failure), target realpath (404), root
/// containment (400), UI containment (403), read (404), then the MIME table.
fn read_plugin_file(dir: String, ui: String, relative: String) -> FileOutcome {
    let root = match std::fs::canonicalize(&dir) {
        Ok(root) => root,
        Err(error) => return FileOutcome::RootUnreadable(format!("realpath {dir}: {error}")),
    };
    let absolute = match std::fs::canonicalize(Path::new(&dir).join(&relative)) {
        Ok(absolute) => absolute,
        Err(_) => return FileOutcome::NotFound,
    };
    if !plugin_routes::within(&root, &absolute) {
        return FileOutcome::OutsideRoot;
    }
    let ui_root = plugin_routes::ui_root(&root, &ui);
    if !plugin_routes::within(&ui_root, &absolute) {
        return FileOutcome::OutsideUi;
    }
    let body = match std::fs::read(&absolute) {
        Ok(body) => body,
        // EISDIR and EACCES are both the retired 404.
        Err(_) => return FileOutcome::NotFound,
    };
    FileOutcome::Ok {
        body,
        mime: plugin_routes::mime_for_path(&absolute.to_string_lossy()),
    }
}

async fn serve_file(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let Some((id_raw, wildcard_raw)) = file_params(&ctx.path) else {
        return express::error(ctx, 500, "plugins route claimed without path parameters");
    };
    // Express decodes every captured parameter while routing, `:id` first and
    // the anonymous `(.*)` second, before the handler runs.
    let id = match decoded(ctx, id_raw) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let wildcard = match decoded(ctx, wildcard_raw) {
        Ok(wildcard) => wildcard,
        Err(response) => return response,
    };
    let fact = match find_plugin(ctx, host, &id).await {
        Ok(fact) => fact,
        Err(response) => return response,
    };
    let Some(fact) = fact else {
        return error_json(ctx, 404, &plugin_routes::plugin_not_found_message(&id));
    };
    // `(req.params[0] || '').replace(/\\/g, '/')` plus the three refusals.
    let relative = match plugin_routes::resolve_plugin_file(&wildcard) {
        Ok(relative) => relative,
        Err(PluginFileError::IllegalPath) => {
            return error_json(ctx, 400, plugin_routes::ERR_ILLEGAL_PATH)
        }
    };
    // Node read the file synchronously; the file system work is the same, just
    // off the reactor. There is no size cap, exactly like `fs.readFileSync`.
    let outcome =
        tokio::task::spawn_blocking(move || read_plugin_file(fact.dir, fact.ui, relative)).await;
    match outcome {
        // `res.set('Content-Type', …)` then `res.set('Cache-Control', …)` then
        // `res.send(Buffer)`: ETag/Fresh/Content-Length/HEAD come from Express.
        Ok(FileOutcome::Ok { body, mime }) => express::send(
            ctx,
            200,
            mime,
            body,
            &[("Cache-Control", plugin_routes::FILE_CACHE_CONTROL)],
        ),
        Ok(FileOutcome::RootUnreadable(detail)) => express::error(ctx, 500, &detail),
        Ok(FileOutcome::NotFound) => error_json(ctx, 404, plugin_routes::ERR_FILE_NOT_FOUND),
        Ok(FileOutcome::OutsideRoot) => error_json(ctx, 400, plugin_routes::ERR_ILLEGAL_PATH),
        Ok(FileOutcome::OutsideUi) => error_json(ctx, 403, plugin_routes::ERR_UI_ONLY),
        Err(_) => express::error(ctx, 500, "plugin file read panicked"),
    }
}

/// The file route (and its automatic OPTIONS) decide gate-or-not themselves; the
/// recheck pair runs behind `App::gate` and the global JSON parser as before.
pub fn is_file_route(route: Route) -> bool {
    matches!(route, Route::File | Route::FileOptions)
}

/// Whether Node's auth gate would have let this request through without a login
/// (`http_entry::public_path`, the one shared rule, applied to the path Express
/// matched). Pure, so the exact boundary is unit tested.
pub fn file_is_public(method: &str, path: &str) -> bool {
    multicc_core::http_entry::public_path(method, &path.into())
}

/// What the front door does with a plugin file request before the route runs.
/// Node's order was `gate('peer')` for every path, then `gate('auth')` which
/// skips the login for a public path. Only the login is skippable: a public
/// path is still refused for a peer outside the LAN allowlist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileAdmission {
    /// `lan_only` and a peer outside the private networks: 403 before anything.
    PeerRejected,
    /// A public path from an allowed peer: no login check.
    Public,
    /// Everything else goes through `App::gate`.
    Gated,
}

/// Pure so the order (peer first, public second) is unit tested without an
/// `App`: the black-box fixture reaches the front door over loopback, which is
/// always a private address, so it cannot exercise the rejected branch.
pub fn file_admission(lan_only: bool, peer_is_private: bool, public: bool) -> FileAdmission {
    if lan_only && !peer_is_private {
        FileAdmission::PeerRejected
    } else if public {
        FileAdmission::Public
    } else {
        FileAdmission::Gated
    }
}

/// `GET|HEAD|OPTIONS /plugins/:id/*`. See [`FileAdmission`].
pub async fn handle_file(
    app: &std::sync::Arc<super::App>,
    route: Route,
    ctx: &RequestCtx,
    peer: &str,
    snapshot: &multicc_core::auth_runtime::Snapshot,
    host: u16,
) -> Response<Body> {
    match file_admission(
        app.lan_only,
        http_gate::is_private_network_address(peer),
        file_is_public(ctx.method.as_str(), &ctx.path),
    ) {
        FileAdmission::PeerRejected => {
            return express::json(
                ctx,
                403,
                &http_gate::public_peer_rejected_dto(&ctx.ids),
                &[],
            );
        }
        FileAdmission::Public => {}
        FileAdmission::Gated => {
            if let Some(refusal) = app.gate(ctx, peer, snapshot).await {
                return refusal;
            }
        }
    }
    match route {
        Route::FileOptions => super::options(ctx, "GET,HEAD"),
        _ => serve_file(ctx, host).await,
    }
}

pub async fn handle(
    route: Route,
    ctx: &RequestCtx,
    body: &Value,
    peer: &str,
    host: u16,
) -> Response<Body> {
    match route {
        Route::Recheck => recheck(ctx, body, peer, host).await,
        Route::RecheckOptions => super::options(ctx, "POST"),
        Route::Channels => channels(ctx, host).await,
        Route::ChannelsOptions => super::options(ctx, "GET,HEAD"),
        // The file routes are answered by `handle_file` before the global gate;
        // reaching here would be a dispatch bug, not a request.
        Route::File | Route::FileOptions => {
            express::error(ctx, 500, "plugin file route reached the gated handler")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recheck_is_one_post_literal() {
        assert_eq!(
            claim(&Method::POST, "/api/channels/recheck"),
            Some(Route::Recheck)
        );
        assert_eq!(
            claim(&Method::POST, "/api/channels/recheck/"),
            Some(Route::Recheck)
        );
        // Literal segments match case-insensitively; the `/api/` prefix does
        // not (the front door leaves differently-cased prefixes to Node).
        assert_eq!(
            claim(&Method::POST, "/api/Channels/ReCheck"),
            Some(Route::Recheck)
        );
        assert_eq!(claim(&Method::POST, "/API/channels/recheck"), None);
        assert_eq!(claim(&Method::GET, "/api/channels/recheck"), None);
        assert_eq!(claim(&Method::HEAD, "/api/channels/recheck"), None);
        assert_eq!(
            claim(&Method::OPTIONS, "/api/channels/recheck"),
            Some(Route::RecheckOptions)
        );
        assert_eq!(claim(&Method::POST, "/api/channels/recheck/x"), None);
        assert_eq!(claim(&Method::POST, "/api/channels/recheck//"), None);
        assert_eq!(claim(&Method::POST, "/api/channels"), None);
    }

    #[test]
    fn channels_is_the_one_read_literal() {
        assert_eq!(claim(&Method::GET, "/api/channels"), Some(Route::Channels));
        assert_eq!(claim(&Method::HEAD, "/api/channels"), Some(Route::Channels));
        // One optional trailing slash, like every other literal here.
        assert_eq!(claim(&Method::GET, "/api/channels/"), Some(Route::Channels));
        // Literal segments are case-insensitive; the `/api/` prefix is not.
        assert_eq!(claim(&Method::GET, "/api/ChAnNeLs"), Some(Route::Channels));
        assert_eq!(claim(&Method::GET, "/API/channels"), None);
        assert_eq!(
            claim(&Method::OPTIONS, "/api/channels"),
            Some(Route::ChannelsOptions)
        );
        // The two other registrations on this prefix are not this route.
        assert_eq!(claim(&Method::GET, "/api/channels/targets"), None);
        assert_eq!(claim(&Method::POST, "/api/channels"), None);
        assert_eq!(claim(&Method::PUT, "/api/channels"), None);
        assert_eq!(claim(&Method::DELETE, "/api/channels"), None);
        // An empty segment never matches.
        assert_eq!(claim(&Method::GET, "/api/channels//"), None);
        assert_eq!(claim(&Method::GET, "/api//channels"), None);
    }

    #[test]
    fn file_route_needs_the_second_slash() {
        assert_eq!(
            claim(&Method::GET, "/plugins/demo/ui/app.js"),
            Some(Route::File)
        );
        assert_eq!(
            claim(&Method::HEAD, "/plugins/demo/ui/app.js"),
            Some(Route::File)
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/plugins/demo/ui/app.js"),
            Some(Route::FileOptions)
        );
        // path-to-regexp 0.1.13's `/plugins/:id/*` requires the slash after
        // `:id`; without it the retired route never matched, so the path is
        // not ours (Node answers its own 404).
        assert_eq!(claim(&Method::GET, "/plugins/demo"), None);
        assert_eq!(claim(&Method::GET, "/plugins"), None);
        assert_eq!(claim(&Method::GET, "/plugins/"), None);
        assert_eq!(claim(&Method::GET, "/plugins//app.js"), None);
        assert_eq!(claim(&Method::GET, "/pluginsx/demo/a"), None);
        // Other verbs were never registered.
        assert_eq!(claim(&Method::POST, "/plugins/demo/ui/app.js"), None);
        assert_eq!(claim(&Method::PUT, "/plugins/demo/ui/app.js"), None);
    }

    #[test]
    fn file_route_matches_like_express() {
        // The route literal is case-insensitive; the captures are raw.
        assert_eq!(
            claim(&Method::GET, "/PLUGINS/demo/ui/app.js"),
            Some(Route::File)
        );
        // One optional trailing slash is inside `(.*)`, so `/plugins/x/` is a
        // match with an empty wildcard (the handler then answers 400).
        assert_eq!(claim(&Method::GET, "/plugins/x/"), Some(Route::File));
        assert_eq!(file_params("/plugins/x/"), Some(("x", "")));
        assert_eq!(file_params("/plugins/x/a/"), Some(("x", "a/")));
        assert_eq!(file_params("/plugins/x//y"), Some(("x", "/y")));
        assert_eq!(file_params("/plugins/x/a/b"), Some(("x", "a/b")));
        assert_eq!(file_params("/plugins/x"), None);
        assert_eq!(file_params("/plugins/"), None);
    }

    /// Measured against Node's own auth gate with an anonymous remote client:
    /// a static extension is a 200, a page or an extensionless file is the login
    /// redirect, and `Accept: text/html` changes nothing for the former.
    #[test]
    fn a_plugin_file_is_public_exactly_for_the_static_extensions() {
        for name in [
            "app.js",
            "style.css",
            "pic.png",
            "a.jpg",
            "a.jpeg",
            "a.gif",
            "logo.svg",
            "favicon.ico",
            "f.woff",
            "f.woff2",
            "f.ttf",
            "data.json",
            "x.apk",
            "x.ipa",
        ] {
            let path = format!("/plugins/demo/ui/{name}");
            assert!(file_is_public("GET", &path), "{path}");
            assert!(file_is_public("HEAD", &path), "{path}");
            assert!(file_is_public("OPTIONS", &path), "{path}");
        }
        // Case folds the way the shared rule does.
        assert!(file_is_public("GET", "/plugins/demo/ui/STYLE.CSS"));
        assert!(file_is_public("GET", "/plugins/demo/ui/Logo.SvG"));
        for name in [
            "index.html",
            "noext",
            "archive.bin",
            "empty.txt",
            "page.htm",
            "a.js.map",
            "a.jsx",
            "js",
            ".js.bak",
            "dir/",
        ] {
            let path = format!("/plugins/demo/ui/{name}");
            assert!(!file_is_public("GET", &path), "{path}");
        }
        // The extension is the end of the path, not a substring.
        assert!(!file_is_public("GET", "/plugins/demo/ui/app.js/x"));
        assert!(!file_is_public("GET", "/plugins/app.js/ui/page"));
    }

    /// The login exemption never reaches past the peer allowlist.
    #[test]
    fn the_peer_allowlist_comes_before_the_public_exemption() {
        // `lan_only`, a peer outside the private networks, a public path: refused.
        assert_eq!(
            file_admission(true, false, true),
            FileAdmission::PeerRejected
        );
        assert_eq!(
            file_admission(true, false, false),
            FileAdmission::PeerRejected
        );
        // `lan_only` with an allowed peer: public skips the login, the rest is gated.
        assert_eq!(file_admission(true, true, true), FileAdmission::Public);
        assert_eq!(file_admission(true, true, false), FileAdmission::Gated);
        // Not `lan_only`: the peer never matters.
        assert_eq!(file_admission(false, false, true), FileAdmission::Public);
        assert_eq!(file_admission(false, false, false), FileAdmission::Gated);
        assert_eq!(file_admission(false, true, false), FileAdmission::Gated);
    }

    #[test]
    fn only_the_file_pair_skips_the_global_gate() {
        assert!(is_file_route(Route::File));
        assert!(is_file_route(Route::FileOptions));
        assert!(!is_file_route(Route::Recheck));
        assert!(!is_file_route(Route::RecheckOptions));
        // The channels pair runs behind `App::gate` like recheck.
        assert!(!is_file_route(Route::Channels));
        assert!(!is_file_route(Route::ChannelsOptions));
    }
}
