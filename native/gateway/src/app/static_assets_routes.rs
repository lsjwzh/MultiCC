//! The rule-only half of `src/routes/static-assets.js`, answered here instead
//! of by Node (kernel: [`multicc_core::static_assets_routes`]):
//!
//! ```text
//! GET|HEAD  /manage  /manage.html        -> 302 /air?view=…      (alias + allowlist)
//! GET|HEAD  /dashboard  /dashboard.html  -> 302 /air?view=overview…
//! GET|HEAD  /air  /air.html?view=planner -> 302 /air?view=overview…
//! GET|HEAD  *.{apk,ipa}                  -> 404 Cache-Control: no-store (empty)
//! ```
//!
//! Everything else the module mounts stays on Node: the versioned-HTML
//! middleware (the `?v=<mtime>` rewrite and the chat/task-shell → task-entry
//! hop), the `public/` `express.static` mount with the `.apk`/`.ipa` download
//! headers, and the `serveHtml` export share routes use. In particular
//! `GET /multicc.apk` and `/multicc-ios.ipa` are never claimed — with a local
//! file they are a streamed `sendFile`, and `send`'s ETag/Last-Modified/Range
//! behavior is not a rule this front door reproduces. Any `/air` whose view is
//! not exactly `planner` also falls through, exactly like the retired
//! `next()`.
//!
//! Authentication is the ordinary gate (`App::gate`): in Node the whole static
//! cluster is mounted after the auth gate, and the shared entry rule already
//! makes `.apk`/`.ipa` URLs public. The response shapes are Express's
//! ([`express::redirect`], `res.status(404).end()`); the differential
//! `docs/rust-migration/differential/static-assets-routes.js` checks them byte
//! for byte against the frozen Node module.

use axum::body::Body;
use axum::http::{Method, Response, Uri};

pub use multicc_core::static_assets_routes::Route;
use multicc_core::static_assets_routes::{self, QueryView};

use crate::app::express::{self, RequestCtx};

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    static_assets_routes::claim(method.as_str(), path)
}

/// `/air` is claimed only when the query redirects; every other read of it is
/// Node's versioned-HTML chain.
pub fn claim_uri(method: &Method, uri: &Uri) -> Option<Route> {
    let target = uri.path_and_query().map(|value| value.as_str())?;
    static_assets_routes::claim_air(method.as_str(), uri.path(), target)
}

/// Differential-only mutations. They exist so
/// `docs/rust-migration/differential/static-assets-routes.js` can prove it
/// fails when a constant is wrong (the brief's three cases: a missing allowlist
/// entry, a wrong alias, and a swapped `token`/`external` order) without editing
/// source or rebuilding Rust. Unset (the production default) applies nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mutation {
    None,
    WhitelistDrop,
    AliasWrong,
    ParamOrder,
}

fn mutation() -> Mutation {
    match std::env::var("MULTICC_STATIC_ASSETS_MUTATION").as_deref() {
        Ok("whitelist-drop") => Mutation::WhitelistDrop,
        Ok("alias-wrong") => Mutation::AliasWrong,
        Ok("param-order") => Mutation::ParamOrder,
        _ => Mutation::None,
    }
}

fn mutate(location: String) -> String {
    match mutation() {
        Mutation::None => location,
        Mutation::WhitelistDrop => location.replace("view=storage", "view=overview"),
        Mutation::AliasWrong => location.replace("view=schedules", "view=overview"),
        Mutation::ParamOrder => swap_token_external(location),
    }
}

/// The wrong order: `external` before `token`.
fn swap_token_external(location: String) -> String {
    let Some((path, query)) = location.split_once('?') else {
        return location;
    };
    let mut parts: Vec<&str> = query.split('&').collect();
    let token = parts.iter().position(|part| part.starts_with("token="));
    let external = parts.iter().position(|part| part.starts_with("external="));
    if let (Some(token), Some(external)) = (token, external) {
        if token < external {
            parts.swap(token, external);
        }
    }
    format!("{path}?{}", parts.join("&"))
}

/// `res.status(404).end()` after `res.set('Cache-Control', 'no-store')`: an
/// empty body, no Content-Type and no ETag. Node stamps `Content-Length: 0`
/// for an ended GET response but not for HEAD, where it never has a body.
fn forbidden_binary(ctx: &RequestCtx) -> Response<Body> {
    let mut builder = express::with_base_headers(Response::builder().status(404), ctx)
        .header("Cache-Control", "no-store");
    let body = if express::is_head(ctx) {
        // An exact-size empty body would make Axum invent `Content-Length: 0`,
        // which Node does not send for a HEAD `res.end()`.
        express::no_content_body()
    } else {
        builder = builder.header("Content-Length", "0");
        Body::empty()
    };
    express::log_request(ctx, 404);
    builder.body(body).expect("static response parts")
}

pub fn handle(route: Route, ctx: &RequestCtx) -> Response<Body> {
    let query = QueryView::new(&ctx.original_url);
    match route {
        Route::Manage => {
            express::redirect(ctx, &mutate(static_assets_routes::manage_redirect(&query)))
        }
        Route::Dashboard => express::redirect(
            ctx,
            &mutate(static_assets_routes::dashboard_redirect(&query)),
        ),
        Route::AirPlanner => match static_assets_routes::air_planner_redirect(&query) {
            Some(location) => express::redirect(ctx, &mutate(location)),
            // Claimed only when the redirect decision was made.
            None => express::error(ctx, 500, "air planner route claimed without a redirect"),
        },
        Route::Options => super::options(ctx, "GET,HEAD"),
        Route::ForbiddenBinary => forbidden_binary(ctx),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_delegates_to_the_kernel() {
        assert_eq!(claim(&Method::GET, "/manage"), Some(Route::Manage));
        assert_eq!(claim(&Method::GET, "/air"), None);
        assert_eq!(claim(&Method::GET, "/x.apk"), Some(Route::ForbiddenBinary));
        assert_eq!(claim(&Method::GET, "/multicc.apk"), None);
        assert_eq!(claim(&Method::POST, "/manage"), None);
    }

    #[test]
    fn claim_uri_claims_only_the_planner_air() {
        let air = |text: &str| claim_uri(&Method::GET, &text.parse::<Uri>().unwrap());
        assert_eq!(air("/air?view=planner"), Some(Route::AirPlanner));
        assert_eq!(air("/air"), None);
        assert_eq!(air("/air?view=other"), None);
    }

    #[test]
    fn param_order_mutation_swaps_the_two_keys() {
        assert_eq!(
            swap_token_external("/air?view=docs&token=t&external=e&dir=d".to_string()),
            "/air?view=docs&external=e&token=t&dir=d"
        );
        assert_eq!(
            swap_token_external("/air?view=docs&dir=d".to_string()),
            "/air?view=docs&dir=d"
        );
    }
}
