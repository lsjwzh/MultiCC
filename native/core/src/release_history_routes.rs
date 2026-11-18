//! Path matching and request-shape rules for the release-asset, iOS OTA and
//! chat-history cluster retired from `src/routes/system.js`, `src/ios-udid.js`,
//! `src/routes/chat-history.js` and `src/routes/static-assets.js`:
//!
//! * `GET /api/apk-info`, `GET /api/ios-ota-info`
//! * `GET /ios-ota/manifest.plist`, `GET /ios-ota/udid.mobileconfig`
//! * `GET /ios-ota/udid/result/:token`, `POST /ios-ota/udid/callback/:token`
//! * `DELETE /api/sessions/:id/messages/:msgId`
//! * `GET /api/sessions/:id/history`, `GET /api/sessions/:id/context-level`
//! * `GET /multicc.apk` -- only the decision travels (see [`Route::ApkDownload`])
//! * `GET /` -- only the two redirect answers (see [`root_redirect`])
//!
//! `GET /multicc.apk` is claimed here, but the local-file branch is not a
//! host answer: the retired handler's `next()` landed in `express.static`,
//! so the host reports the fall-through and the gateway streams the file
//! itself through its static web root (Range/ETag/Last-Modified). Only the
//! redirect and the bare 404 are ordinary host answers.
//!
//! Matching rules are the same Express-compatible ones every cluster uses:
//! literal segments case-insensitively (the exact-case `api` prefix excepted:
//! Node's auth gate and JSON gzip test `startsWith('/api/')` case-sensitively),
//! a `:param` as one non-empty segment, one optional trailing slash, the raw
//! (undecoded) path, and the automatic `OPTIONS` `Allow` with `HEAD` right
//! after each `GET`.
//!
//! The authentication exemptions are not a second rule: [`is_public`] is the
//! shared HTTP-entry predicate (`http_entry::public_path`, plus the Apple
//! device callback that the entry admits by path *and* content type).

use crate::http_entry;
use crate::http_gate::{query_value, QueryValue};
use crate::js::JsString;

/// One claimed route. `Options` is Express's automatic responder for a path
/// this cluster registers; `guard_segment` names the `:id` segment the
/// `publicSessionAccessGuard` `app.use` layer observes in front of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    ApkInfo,
    IosOtaInfo,
    ManifestPlist,
    UdidProfile,
    UdidResult,
    UdidCallback,
    MessageDelete,
    History,
    ContextLevel,
    /// `GET|HEAD /multicc.apk`. The host decides local-file / redirect /
    /// missing; a local file is streamed by the static web root, which is why
    /// this route could only move once that mount did.
    ApkDownload,
    /// `GET|HEAD /` when the redirect decision is made (no host fact).
    Root,
    Options {
        allow: &'static str,
        guard_segment: Option<usize>,
    },
}

impl Route {
    /// The host-port operation. `Root` and `Options` never reach the host.
    pub fn op(self) -> Option<&'static str> {
        Some(match self {
            Route::ApkInfo => "apk-info",
            Route::IosOtaInfo => "ios-ota-info",
            Route::ManifestPlist => "ios-ota-manifest",
            Route::UdidProfile => "udid-profile",
            Route::UdidResult => "udid-result",
            Route::UdidCallback => "udid-callback",
            Route::MessageDelete => "message-delete",
            Route::History => "history",
            Route::ContextLevel => "context-level",
            Route::ApkDownload => "apk-download",
            Route::Root | Route::Options { .. } => return None,
        })
    }

    /// Whether the retired handler mutates host state. The UDID profile issues
    /// a one-time token into the pending map, the callback consumes it, and the
    /// message delete rewrites the transcript.
    pub fn is_write(self) -> bool {
        matches!(
            self,
            Route::UdidProfile | Route::UdidCallback | Route::MessageDelete
        )
    }

    /// The path parameters as `(name, segment index)` relative to [`segments`].
    pub fn params(self) -> &'static [(&'static str, usize)] {
        match self {
            Route::UdidResult | Route::UdidCallback => &[("token", 3)],
            Route::MessageDelete => &[("id", 2), ("msgId", 4)],
            Route::History | Route::ContextLevel => &[("id", 2)],
            _ => &[],
        }
    }
}

/// `src/apk-distribution.js`'s `APK_NAME`: the one local file name the
/// download route may stream out of `public/`.
pub const APK_NAME: &str = "multicc.apk";

/// The query keys the chat-history handlers read.
pub const QUERY_KEYS: &[&str] = &["historyScope", "before", "around", "limit", "plan"];

/// The largest device reply `express.raw({ limit })` accepted.
pub const UDID_CALLBACK_LIMIT: usize = 64 * 1024;

struct Layer {
    segs: &'static [&'static str],
    method: &'static str,
    kind: Route,
}

const fn layer(segs: &'static [&'static str], method: &'static str, kind: Route) -> Layer {
    Layer { segs, method, kind }
}

/// Registration order of the retired mounts (system, then the UDID routes it
/// mounts, then chat history).
static LAYERS: &[Layer] = &[
    layer(&["api", "apk-info"], "GET", Route::ApkInfo),
    layer(&["api", "ios-ota-info"], "GET", Route::IosOtaInfo),
    layer(&["ios-ota", "manifest.plist"], "GET", Route::ManifestPlist),
    layer(&["ios-ota", "udid.mobileconfig"], "GET", Route::UdidProfile),
    layer(
        &["ios-ota", "udid", "result", ":token"],
        "GET",
        Route::UdidResult,
    ),
    layer(
        &["ios-ota", "udid", "callback", ":token"],
        "POST",
        Route::UdidCallback,
    ),
    layer(
        &["api", "sessions", ":id", "messages", ":msgId"],
        "DELETE",
        Route::MessageDelete,
    ),
    layer(
        &["api", "sessions", ":id", "history"],
        "GET",
        Route::History,
    ),
    layer(
        &["api", "sessions", ":id", "context-level"],
        "GET",
        Route::ContextLevel,
    ),
    layer(&["multicc.apk"], "GET", Route::ApkDownload),
    layer(&[], "GET", Route::Root),
];

/// `path` -> its segments (the leading `/` removed), or `None` when it cannot
/// match. One optional trailing slash is removed, as Express tolerated; a
/// doubled or interior empty segment is not a match. `/` is the empty list.
pub fn segments(path: &str) -> Option<Vec<&str>> {
    let rest = path.strip_prefix('/')?;
    if rest.is_empty() {
        return Some(Vec::new());
    }
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

fn layer_matches(layer: &Layer, parts: &[&str]) -> bool {
    layer.segs.len() == parts.len()
        && layer
            .segs
            .iter()
            .zip(parts)
            .all(|(name, part)| match name.strip_prefix(':') {
                Some(_) => !part.is_empty(),
                None if *name == "api" => part == name,
                None => part.eq_ignore_ascii_case(name),
            })
}

/// The matcher. `GET` and `HEAD` share every read route; `OPTIONS` is the
/// automatic responder for any registered path. `GET /` is answered only when
/// [`claim_root`] says so, so the bare path never claims here for a read.
pub fn claim(method: &str, path: &str) -> Option<Route> {
    let parts = segments(path)?;
    if method.eq_ignore_ascii_case("OPTIONS") {
        let allow = allow_for(path)?;
        return Some(Route::Options {
            allow: intern(&allow),
            guard_segment: guard_index(&parts),
        });
    }
    if parts.is_empty() {
        return None;
    }
    let wanted = if method.eq_ignore_ascii_case("HEAD") {
        "GET"
    } else {
        method
    };
    LAYERS
        .iter()
        .find(|layer| layer.method.eq_ignore_ascii_case(wanted) && layer_matches(layer, &parts))
        .map(|layer| layer.kind)
}

/// `GET|HEAD /` is ours only when it redirects; `?id=`, `?newid=` and `?cwd=`
/// (a terminal session) fall through to the static-file chain on Node.
pub fn claim_root(method: &str, original_url: &str) -> Option<Route> {
    let read = method.eq_ignore_ascii_case("GET") || method.eq_ignore_ascii_case("HEAD");
    let path = original_url.split(['?', '#']).next().unwrap_or("");
    (read && path == "/" && root_redirect(original_url).is_some()).then_some(Route::Root)
}

/// What `app.get('/')` did: `?id=__aux__` is the old dashboard's shorthand for
/// the assistant panel; any other `id`, `newid` or `cwd` (qs truthiness: a
/// non-empty string, any array or any object) belongs to the terminal-session
/// chain; otherwise the root redirects to Air. `None` is "call `next()`".
pub fn root_redirect(original_url: &str) -> Option<&'static str> {
    let truthy = |value: QueryValue| match value {
        QueryValue::Missing => false,
        QueryValue::Text(text) => !text.is_empty(),
        QueryValue::List(_) | QueryValue::Object => true,
    };
    if query_value(original_url, "id") == QueryValue::Text("__aux__".into()) {
        return Some("/air?view=aux");
    }
    if truthy(query_value(original_url, "id"))
        || truthy(query_value(original_url, "newid"))
        || truthy(query_value(original_url, "cwd"))
    {
        return None;
    }
    Some("/air")
}

/// The `:id` segment `publicSessionAccessGuard` observes before a route (and
/// before its `OPTIONS`): `/api/sessions/:id/*`.
pub fn guard_index(parts: &[&str]) -> Option<usize> {
    (parts.len() >= 3 && parts[0] == "api" && parts[1].eq_ignore_ascii_case("sessions"))
        .then_some(2)
}

/// Every `Allow` string [`LAYERS`] can produce, so [`Route::Options`] can keep a
/// `&'static str` (the front door's route enum stays `Copy`).
const ALLOWS: &[&str] = &["GET,HEAD", "POST", "DELETE"];

fn intern(allow: &str) -> &'static str {
    ALLOWS
        .iter()
        .copied()
        .find(|candidate| *candidate == allow)
        .unwrap_or("")
}

/// This cluster's share of Express's automatic OPTIONS `Allow` for `path`: the
/// methods it registers on that exact path in registration order, each `GET`
/// followed by `HEAD`.
pub fn allow_for(path: &str) -> Option<String> {
    let parts = segments(path)?;
    let mut methods: Vec<&'static str> = Vec::new();
    let mut matched = false;
    for layer in LAYERS {
        if !layer_matches(layer, &parts) {
            continue;
        }
        matched = true;
        if !methods.contains(&layer.method) {
            methods.push(layer.method);
        }
        if layer.method == "GET" && !methods.contains(&"HEAD") {
            methods.push("HEAD");
        }
    }
    matched.then(|| methods.join(","))
}

/// This cluster's share of the front-door `OPTIONS` union across clusters.
pub fn options_share(path: &str) -> Option<String> {
    allow_for(path)
}

/// The shared HTTP-entry exemption: a path the Node gate lets through without
/// an access token. The manifest (`itms-services` cannot log in) and the result
/// page are public by [`http_entry::public_path`]; the device callback is public
/// only for the two content types Apple's Profile Service sends.
pub fn is_public(method: &str, path: &str, content_type: Option<&str>) -> bool {
    let path = JsString::from(path);
    http_entry::public_path(method, &path)
        || (http_entry::udid_callback_path(method, &path)
            && http_entry::udid_content_type(&JsString::from(content_type.unwrap_or(""))))
}

/// The ways `express.raw({ type: () => true, inflate: false, limit })` refuses a
/// device reply, all of which the retired route answered with fixed text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawError {
    /// 413: declared or received more than [`UDID_CALLBACK_LIMIT`].
    TooLarge,
    /// 415 (a content encoding with `inflate: false`) and every other parse
    /// failure: the retired route answered both with 400.
    Invalid,
}

impl RawError {
    pub fn status(self) -> u16 {
        match self {
            RawError::TooLarge => 413,
            RawError::Invalid => 400,
        }
    }
}

/// The checks `body-parser` makes before it reads a single byte of the device
/// reply. `Ok(true)` means "read the body"; `Ok(false)` means there is no body
/// to read (neither `Transfer-Encoding` nor a numeric `Content-Length`), which
/// leaves `req.body` unset and is the callback's later 400.
pub fn raw_precheck(
    transfer_encoding: Option<&str>,
    content_length: Option<&str>,
    content_encoding: Option<&str>,
) -> Result<bool, RawError> {
    // `typeis.hasBody`: `!isNaN(req.headers['content-length'])` (so an empty
    // header value counts, as `Number('')` is 0).
    let numeric = |value: &str| !crate::js::js_string_to_number(value).is_nan();
    if transfer_encoding.is_none() && !content_length.is_some_and(numeric) {
        return Ok(false);
    }
    let encoding = content_encoding.unwrap_or("identity").to_ascii_lowercase();
    if encoding != "identity" {
        return Err(RawError::Invalid);
    }
    if let Some(length) = content_length.and_then(|value| value.trim().parse::<usize>().ok()) {
        if length > UDID_CALLBACK_LIMIT {
            return Err(RawError::TooLarge);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(method: &str, path: &str) -> Option<Route> {
        claim(method, path)
    }

    fn sample_path(layer: &Layer) -> String {
        let mut path = String::new();
        for seg in layer.segs {
            path.push('/');
            path.push_str(if seg.starts_with(':') { "x" } else { seg });
        }
        if path.is_empty() {
            path.push('/');
        }
        path
    }

    #[test]
    fn claims_every_route_except_the_bare_root() {
        use Route::*;
        let cases = [
            ("GET", "/api/apk-info", ApkInfo),
            ("GET", "/api/ios-ota-info", IosOtaInfo),
            ("GET", "/ios-ota/manifest.plist", ManifestPlist),
            ("GET", "/ios-ota/udid.mobileconfig", UdidProfile),
            ("GET", "/ios-ota/udid/result/abc", UdidResult),
            ("POST", "/ios-ota/udid/callback/abc", UdidCallback),
            ("DELETE", "/api/sessions/s1/messages/m1", MessageDelete),
            ("GET", "/api/sessions/s1/history", History),
            ("GET", "/api/sessions/s1/context-level", ContextLevel),
            ("GET", "/multicc.apk", ApkDownload),
        ];
        assert_eq!(LAYERS.len(), cases.len() + 1);
        for (method, path, expected) in cases {
            assert_eq!(route(method, path), Some(expected), "{method} {path}");
        }
        assert_eq!(route("HEAD", "/api/apk-info"), Some(ApkInfo));
        assert_eq!(route("HEAD", "/ios-ota/udid/callback/abc"), None);
        assert_eq!(route("HEAD", "/api/sessions/s1/messages/m1"), None);
        // The bare root only claims through the redirect decision.
        assert_eq!(route("GET", "/"), None);
    }

    #[test]
    fn multicc_apk_is_claimed_for_the_download_decision() {
        assert_eq!(route("GET", "/multicc.apk"), Some(Route::ApkDownload));
        assert_eq!(route("HEAD", "/multicc.apk"), Some(Route::ApkDownload));
        assert_eq!(route("GET", "/MULTICC.APK"), Some(Route::ApkDownload));
        assert_eq!(route("GET", "/multicc.apk/"), Some(Route::ApkDownload));
        assert_eq!(route("POST", "/multicc.apk"), None);
    }

    #[test]
    fn the_other_static_routes_stay_on_node() {
        for path in [
            "/multicc-ios.ipa",
            "/manage",
            "/dashboard",
            "/air",
            "/ios-ota",
            "/ios-ota/",
            "/ios-udid-result.js",
        ] {
            assert_eq!(route("GET", path), None, "{path}");
            assert_eq!(route("OPTIONS", path), None, "OPTIONS {path}");
        }
    }

    #[test]
    fn near_misses_and_other_methods_are_not_claimed() {
        for (method, path) in [
            ("POST", "/api/apk-info"),
            ("PUT", "/api/ios-ota-info"),
            ("GET", "/api/apk-info/extra"),
            ("GET", "/ios-ota/manifest.plist/extra"),
            ("POST", "/ios-ota/udid.mobileconfig"),
            ("GET", "/ios-ota/udid/callback/abc"),
            ("POST", "/ios-ota/udid/result/abc"),
            ("GET", "/ios-ota/udid/result"),
            ("GET", "/ios-ota/udid/result/a/b"),
            ("GET", "/api/sessions/s1/messages/m1"),
            ("DELETE", "/api/sessions/s1/messages"),
            ("DELETE", "/api/sessions/s1/messages/m1/extra"),
            ("POST", "/api/sessions/s1/history"),
            ("DELETE", "/api/sessions/s1/history"),
            ("GET", "/api/sessions/s1/history/x"),
            ("GET", "/api/sessions/s1"),
            ("GET", "/api/sessions/s1/context-levels"),
            ("GET", "/api/v1/sessions/s1/history"),
        ] {
            assert_eq!(route(method, path), None, "{method} {path}");
        }
    }

    #[test]
    fn trailing_slash_is_tolerated_but_empty_segments_are_not() {
        assert_eq!(route("GET", "/api/apk-info/"), Some(Route::ApkInfo));
        assert_eq!(
            route("GET", "/api/sessions/s1/history/"),
            Some(Route::History)
        );
        assert_eq!(route("GET", "/api/sessions//history"), None);
        assert_eq!(route("GET", "/api/sessions/s1/history//"), None);
        assert_eq!(route("GET", "//api/apk-info"), None);
        assert_eq!(route("GET", "/ios-ota//manifest.plist"), None);
    }

    #[test]
    fn literals_are_case_insensitive_and_the_api_prefix_is_not() {
        assert_eq!(route("GET", "/API/apk-info"), None);
        assert_eq!(route("GET", "/api/APK-Info"), Some(Route::ApkInfo));
        assert_eq!(
            route("GET", "/IOS-OTA/Manifest.PLIST"),
            Some(Route::ManifestPlist)
        );
        assert_eq!(
            route("GET", "/api/Sessions/S1/Context-Level"),
            Some(Route::ContextLevel)
        );
        // A param is one raw segment: an encoded slash stays inside it.
        assert_eq!(
            route("GET", "/api/sessions/a%2Fb/history"),
            Some(Route::History)
        );
        assert_eq!(route("GET", "/api/sessions/a/b/history"), None);
    }

    #[test]
    fn params_index_into_the_segment_list() {
        let parts = segments("/ios-ota/udid/result/tok").unwrap();
        for (name, index) in Route::UdidResult.params() {
            assert_eq!((*name, parts[*index]), ("token", "tok"));
        }
        let parts = segments("/api/sessions/s1/messages/m9").unwrap();
        let named: Vec<(&str, &str)> = Route::MessageDelete
            .params()
            .iter()
            .map(|(name, index)| (*name, parts[*index]))
            .collect();
        assert_eq!(named, vec![("id", "s1"), ("msgId", "m9")]);
        let parts = segments("/api/sessions/s1/history").unwrap();
        assert_eq!(parts[Route::History.params()[0].1], "s1");
        assert_eq!(parts[Route::ContextLevel.params()[0].1], "s1");
    }

    #[test]
    fn ops_are_unique_and_only_writes_serialize() {
        let all = [
            Route::ApkInfo,
            Route::IosOtaInfo,
            Route::ManifestPlist,
            Route::UdidProfile,
            Route::UdidResult,
            Route::UdidCallback,
            Route::MessageDelete,
            Route::History,
            Route::ContextLevel,
        ];
        let mut ops: Vec<&str> = all.iter().filter_map(|route| route.op()).collect();
        assert_eq!(ops.len(), 9);
        ops.sort_unstable();
        ops.dedup();
        assert_eq!(ops.len(), 9);
        assert_eq!(Route::Root.op(), None);
        let writes: Vec<Route> = all.iter().copied().filter(|r| r.is_write()).collect();
        assert_eq!(
            writes,
            vec![
                Route::UdidProfile,
                Route::UdidCallback,
                Route::MessageDelete
            ]
        );
        assert!(!Route::History.is_write());
        assert!(!Route::ContextLevel.is_write());
    }

    #[test]
    fn allow_values_match_the_measured_express_values() {
        let measured = [
            ("/api/apk-info", "GET,HEAD"),
            ("/api/ios-ota-info", "GET,HEAD"),
            ("/ios-ota/manifest.plist", "GET,HEAD"),
            ("/ios-ota/udid.mobileconfig", "GET,HEAD"),
            ("/ios-ota/udid/result/t", "GET,HEAD"),
            ("/ios-ota/udid/callback/t", "POST"),
            ("/api/sessions/s1/messages/m1", "DELETE"),
            ("/api/sessions/s1/history", "GET,HEAD"),
            ("/api/sessions/s1/context-level", "GET,HEAD"),
            ("/multicc.apk", "GET,HEAD"),
            ("/", "GET,HEAD"),
        ];
        for (path, allow) in measured {
            assert_eq!(allow_for(path).as_deref(), Some(allow), "{path}");
            assert_eq!(options_share(path).as_deref(), Some(allow), "{path}");
        }
        assert_eq!(allow_for("/api/sessions/s1"), None);
    }

    #[test]
    fn options_is_claimed_for_every_registered_path_with_its_guard() {
        for layer in LAYERS {
            let path = sample_path(layer);
            match route("OPTIONS", &path) {
                Some(Route::Options {
                    allow,
                    guard_segment,
                }) => {
                    assert_eq!(Some(allow), allow_for(&path).as_deref(), "{path}");
                    let parts = segments(&path).unwrap();
                    assert_eq!(guard_segment, guard_index(&parts), "{path}");
                    let expected =
                        (layer.segs.len() >= 3 && layer.segs[1] == "sessions").then_some(2);
                    assert_eq!(guard_segment, expected, "{path}");
                }
                other => panic!("{path}: {other:?}"),
            }
        }
    }

    #[test]
    fn every_computed_allow_value_is_interned() {
        for layer in LAYERS {
            let path = sample_path(layer);
            let allow = allow_for(&path).expect("registered path");
            assert_eq!(intern(&allow), allow, "{path} -> {allow}");
        }
        assert_eq!(intern("nope"), "");
    }

    #[test]
    fn guard_segment_follows_the_session_id() {
        assert_eq!(guard_index(&["api", "sessions", "s1", "history"]), Some(2));
        assert_eq!(guard_index(&["api", "apk-info"]), None);
        assert_eq!(guard_index(&["ios-ota", "udid", "result", "t"]), None);
        assert_eq!(
            guard_index(&["api", "v1", "sessions", "s1", "history"]),
            None
        );
        assert_eq!(guard_index(&["API", "sessions", "s1", "history"]), None);
    }

    #[test]
    fn root_redirects_to_air_unless_a_terminal_session_is_named() {
        assert_eq!(root_redirect("/"), Some("/air"));
        assert_eq!(root_redirect("/?foo=1"), Some("/air"));
        assert_eq!(root_redirect("/?id=__aux__"), Some("/air?view=aux"));
        assert_eq!(
            root_redirect("/?id=__aux__&cwd=/tmp"),
            Some("/air?view=aux")
        );
        assert_eq!(root_redirect("/?id=s1"), None);
        assert_eq!(root_redirect("/?newid=s1"), None);
        assert_eq!(root_redirect("/?cwd=%2Ftmp"), None);
        // An empty value is falsy; an array or object is truthy.
        assert_eq!(root_redirect("/?id="), Some("/air"));
        assert_eq!(root_redirect("/?id"), Some("/air"));
        assert_eq!(root_redirect("/?id[]="), None);
        assert_eq!(root_redirect("/?id[a]=1"), None);
        assert_eq!(root_redirect("/?id=1&id=2"), None);
        // Only the exact string is the shorthand.
        assert_eq!(root_redirect("/?id=__AUX__"), None);
        assert_eq!(root_redirect("/?id=__aux__&id=x"), None);
    }

    #[test]
    fn claim_root_needs_a_read_of_the_bare_path_that_redirects() {
        assert_eq!(claim_root("GET", "/"), Some(Route::Root));
        assert_eq!(claim_root("HEAD", "/?x=1"), Some(Route::Root));
        assert_eq!(claim_root("GET", "/?id=s1"), None);
        assert_eq!(claim_root("POST", "/"), None);
        assert_eq!(claim_root("GET", "/air"), None);
        assert_eq!(claim_root("GET", "/index.html"), None);
        assert_eq!(claim_root("GET", "//"), None);
    }

    #[test]
    fn the_public_exemption_is_the_shared_entry_rule() {
        // Public: the manifest and the result page; the callback only for Apple's
        // two content types.
        assert!(is_public("GET", "/ios-ota/manifest.plist", None));
        assert!(is_public("HEAD", "/ios-ota/manifest.plist", None));
        let token = "a".repeat(64);
        assert!(is_public(
            "GET",
            &format!("/ios-ota/udid/result/{token}"),
            None
        ));
        assert!(!is_public(
            "HEAD",
            &format!("/ios-ota/udid/result/{token}"),
            None
        ));
        assert!(!is_public("GET", "/ios-ota/udid/result/short", None));
        let callback = format!("/ios-ota/udid/callback/{token}");
        for content_type in [
            "application/pkcs7-signature",
            "application/x-apple-aspen-deviceinfo",
            "Application/PKCS7-Signature; charset=binary",
        ] {
            assert!(
                is_public("POST", &callback, Some(content_type)),
                "{content_type}"
            );
        }
        for content_type in [None, Some(""), Some("application/json"), Some("text/plain")] {
            assert!(
                !is_public("POST", &callback, content_type),
                "{content_type:?}"
            );
        }
        assert!(!is_public(
            "GET",
            &callback,
            Some("application/pkcs7-signature")
        ));
        assert!(!is_public(
            "POST",
            "/ios-ota/udid/callback/short",
            Some("application/pkcs7-signature")
        ));
        // The profile download and the JSON infos stay behind the gate.
        assert!(!is_public("GET", "/ios-ota/udid.mobileconfig", None));
        assert!(!is_public("GET", "/api/apk-info", None));
        assert!(!is_public("GET", "/api/ios-ota-info", None));
        assert!(!is_public("GET", "/api/sessions/s1/history", None));
        assert!(!is_public("DELETE", "/api/sessions/s1/messages/m1", None));
        assert!(!is_public("GET", "/", None));
    }

    #[test]
    fn raw_precheck_orders_the_body_parser_refusals() {
        // No body framing at all: nothing is read, the callback answers 400.
        assert_eq!(raw_precheck(None, None, None), Ok(false));
        assert_eq!(raw_precheck(None, Some("abc"), None), Ok(false));
        assert_eq!(raw_precheck(None, Some(""), None), Ok(true));
        assert_eq!(raw_precheck(None, Some("0"), None), Ok(true));
        assert_eq!(raw_precheck(Some("chunked"), None, None), Ok(true));
        assert_eq!(raw_precheck(None, Some("65536"), None), Ok(true));
        assert_eq!(
            raw_precheck(None, Some("65537"), None),
            Err(RawError::TooLarge)
        );
        // A content encoding is refused (inflate:false) before any size check.
        assert_eq!(
            raw_precheck(None, Some("999999"), Some("gzip")),
            Err(RawError::Invalid)
        );
        assert_eq!(raw_precheck(None, Some("5"), Some("Identity")), Ok(true));
        assert_eq!(
            raw_precheck(Some("chunked"), None, Some("br")),
            Err(RawError::Invalid)
        );
        assert_eq!(RawError::TooLarge.status(), 413);
        assert_eq!(RawError::Invalid.status(), 400);
    }
}
