//! The three rule-only pieces of `src/routes/static-assets.js` that the Rust
//! front door claims (`native/gateway/src/app/static_assets_routes.rs`):
//!
//! * `GET|HEAD /manage`, `/manage.html` → 302 `/air?view=…` (view alias table,
//!   the 17-name allowlist, and the `focus=aux` shorthand);
//! * `GET|HEAD /dashboard`, `/dashboard.html` → 302 `/air?view=overview…`;
//! * `GET|HEAD /air`, `/air.html` **only when `?view=planner`** → the same
//!   `view=overview` redirect (any other view keeps falling through to Node's
//!   versioned-HTML/`express.static` chain);
//! * the global `GET|HEAD` `.apk`/`.ipa` guard: every request whose decoded
//!   path ends in one of those suffixes, except the two canonical names
//!   `/multicc.apk` and `/multicc-ios.ipa`, is a `Cache-Control: no-store`
//!   404 (`res.status(404).end()`, an empty body).
//!
//! The rest of the module stays on Node: `_serveVersionedHtml` (the `?v=<mtime>`
//! rewrite and the chat/task-shell → task-entry hop), the `public/` mount with
//! its `.apk` download headers, and the `serveHtml` export share routes use.
//! `express.static`'s ETag/Last-Modified/Range behavior cannot be reproduced by
//! a pure rule, so `GET /multicc.apk`, `/multicc-ios.ipa` and every other file
//! path are deliberately not claimed.
//!
//! Matching is Express's default: literal segments case-insensitively, one
//! optional trailing slash, on the raw (undecoded) path. Query values are read
//! with the shared `qs` parser (`http_gate::query_value`), so a repeated key
//! (an array) or a nested key (`view[a]=1`, an object) is not a string and is
//! skipped exactly like `typeof req.query.x === 'string'`.

use url::form_urlencoded;

use crate::http_gate::{query_value, QueryValue};

/// The allowlist `allowed.has(requested)` is checked against.
pub const ALLOWED_VIEWS: [&str; 17] = [
    "overview",
    "schedules",
    "docs",
    "memory",
    "plugins",
    "settings",
    "voice",
    "goal",
    "aux",
    "provider",
    "global",
    "push",
    "tunnel",
    "bridges",
    "resources",
    "skillsync",
    "storage",
];

/// The alias table `aliases[requested]` is checked against.
pub const VIEW_ALIASES: [(&str, &str); 3] = [
    ("cron", "schedules"),
    ("tasks", "overview"),
    ("planner", "overview"),
];

/// `Object.prototype`'s own keys. The retired handler looked the alias table up
/// with `aliases[requested]`; for one of these names that lookup returns an
/// inherited function (or `Object.prototype` itself), which is truthy and is
/// then stringified by `new URLSearchParams({view})`. The result is never a
/// view the UI understands, but it is part of the byte-for-byte contract.
const OBJECT_PROTOTYPE_LOOKUPS: [(&str, &str); 12] = [
    ("__proto__", "[object Object]"),
    ("constructor", "function Object() { [native code] }"),
    (
        "__defineGetter__",
        "function __defineGetter__() { [native code] }",
    ),
    (
        "__defineSetter__",
        "function __defineSetter__() { [native code] }",
    ),
    (
        "hasOwnProperty",
        "function hasOwnProperty() { [native code] }",
    ),
    (
        "__lookupGetter__",
        "function __lookupGetter__() { [native code] }",
    ),
    (
        "__lookupSetter__",
        "function __lookupSetter__() { [native code] }",
    ),
    (
        "isPrototypeOf",
        "function isPrototypeOf() { [native code] }",
    ),
    (
        "propertyIsEnumerable",
        "function propertyIsEnumerable() { [native code] }",
    ),
    (
        "toLocaleString",
        "function toLocaleString() { [native code] }",
    ),
    ("toString", "function toString() { [native code] }"),
    ("valueOf", "function valueOf() { [native code] }"),
];

const OVERVIEW: &str = "overview";
const MANAGE_VIEW_FALLBACK: &str = "overview";

/// One claimed route. `Options` is Express's automatic answer for the paths
/// this cluster registers; `ForbiddenBinary` is the `.apk`/`.ipa` guard.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Manage,
    Dashboard,
    AirPlanner,
    Options,
    ForbiddenBinary,
}

const MANAGE_PATHS: [&str; 2] = ["/manage", "/manage.html"];
const DASHBOARD_PATHS: [&str; 2] = ["/dashboard", "/dashboard.html"];
const AIR_PATHS: [&str; 2] = ["/air", "/air.html"];

fn method_is(method: &str, wanted: &str) -> bool {
    method.eq_ignore_ascii_case(wanted)
}

/// Express route matching for a literal or `name`/`name.html` pair.
fn matches_literal(path: &str, names: &[&str]) -> bool {
    let trimmed = path.strip_suffix('/').unwrap_or(path);
    names.iter().any(|name| trimmed.eq_ignore_ascii_case(name))
}

/// The routes this module claims from `(method, path)` alone. `/air` is not
/// included: its read is claimed only when the query redirects (`claim_air`).
pub fn claim(method: &str, path: &str) -> Option<Route> {
    if method_is(method, "OPTIONS") {
        let registered = matches_literal(path, &MANAGE_PATHS)
            || matches_literal(path, &DASHBOARD_PATHS)
            || matches_literal(path, &AIR_PATHS);
        return registered.then_some(Route::Options);
    }
    if !(method_is(method, "GET") || method_is(method, "HEAD")) {
        return None;
    }
    if matches_literal(path, &MANAGE_PATHS) {
        return Some(Route::Manage);
    }
    if matches_literal(path, &DASHBOARD_PATHS) {
        return Some(Route::Dashboard);
    }
    if is_forbidden_binary(path) {
        return Some(Route::ForbiddenBinary);
    }
    None
}

/// `GET|HEAD /air` / `/air.html` when `req.query.view === 'planner'`.
pub fn claim_air(method: &str, path: &str, original_url: &str) -> Option<Route> {
    if !(method_is(method, "GET") || method_is(method, "HEAD")) {
        return None;
    }
    if !matches_literal(path, &AIR_PATHS) {
        return None;
    }
    air_planner_redirect(&QueryView::new(original_url)).map(|_| Route::AirPlanner)
}

/// `req.query` as the retired handlers read it: only the two tests they used,
/// `typeof value === 'string'` and `typeof value === 'string' && value`.
#[derive(Debug, Clone, Copy)]
pub struct QueryView<'a> {
    original_url: &'a str,
}

impl<'a> QueryView<'a> {
    pub fn new(original_url: &'a str) -> Self {
        Self { original_url }
    }

    /// `typeof req.query[name] === 'string'` — `Some` for a single plain pair,
    /// even an empty one; `None` for a missing key, an array or an object.
    pub fn string(&self, name: &str) -> Option<String> {
        match query_value(self.original_url, name) {
            QueryValue::Text(text) => Some(text),
            QueryValue::Missing | QueryValue::List(_) | QueryValue::Object => None,
        }
    }

    /// `typeof req.query[name] === 'string' && req.query[name]`: an empty
    /// string is falsy and skipped.
    pub fn truthy_string(&self, name: &str) -> Option<String> {
        self.string(name).filter(|text| !text.is_empty())
    }
}

/// `new URLSearchParams({…}).toString()` — the WHATWG form-urlencoded
/// serializer (`url`'s encoder uses the same byte set and turns space into
/// `+`).
fn overview_redirect(query: &QueryView, keys: &[&str]) -> String {
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("view", OVERVIEW);
    for key in keys {
        // `typeof req.query[key] === 'string' && req.query[key]`.
        if let Some(value) = query.truthy_string(key) {
            serializer.append_pair(key, &value);
        }
    }
    format!("/air?{}", serializer.finish())
}

/// `GET|HEAD /manage` and `/manage.html`.
pub fn manage_redirect(query: &QueryView) -> String {
    let requested = match query.string("view") {
        Some(view) => view,
        None if query.string("focus").as_deref() == Some("aux") => "aux".to_string(),
        None => MANAGE_VIEW_FALLBACK.to_string(),
    };
    let view = if let Some((_, canonical)) = VIEW_ALIASES
        .iter()
        .find(|(alias, _)| *alias == requested.as_str())
    {
        (*canonical).to_string()
    } else if let Some((_, coerced)) = OBJECT_PROTOTYPE_LOOKUPS
        .iter()
        .find(|(key, _)| *key == requested.as_str())
    {
        (*coerced).to_string()
    } else if let Some(allowed) = ALLOWED_VIEWS
        .iter()
        .find(|allowed| **allowed == requested.as_str())
    {
        (*allowed).to_string()
    } else {
        MANAGE_VIEW_FALLBACK.to_string()
    };

    let mut serializer = form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("view", &view);
    if let Some(token) = query.truthy_string("token") {
        serializer.append_pair("token", &token);
    }
    if let Some(external) = query.truthy_string("external") {
        serializer.append_pair("external", &external);
    }
    for key in ["dir", "task"] {
        if let Some(value) = query.truthy_string(key) {
            serializer.append_pair(key, &value);
        }
    }
    format!("/air?{}", serializer.finish())
}

/// `GET|HEAD /dashboard` and `/dashboard.html`.
pub fn dashboard_redirect(query: &QueryView) -> String {
    overview_redirect(query, &["dir", "task", "token", "external"])
}

/// `GET|HEAD /air` / `/air.html` — `Some` only for `?view=planner`.
pub fn air_planner_redirect(query: &QueryView) -> Option<String> {
    (query.string("view").as_deref() == Some("planner"))
        .then(|| overview_redirect(query, &["dir", "task", "token", "external"]))
}

/// `decodeURIComponent(text)`, `None` where it throws (a stray `%`, a bad
/// escape, or bytes that are not UTF-8).
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let nibble = |byte: u8| (byte as char).to_digit(16).map(|digit| digit as u8);
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = bytes.get(index + 1).copied().and_then(nibble)?;
            let low = bytes.get(index + 2).copied().and_then(nibble)?;
            out.push(high << 4 | low);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `/\.(apk|ipa)$/i`.
fn has_binary_suffix(path: &str) -> bool {
    let lowered = path.to_ascii_lowercase();
    lowered.ends_with(".apk") || lowered.ends_with(".ipa")
}

/// The global `.apk`/`.ipa` guard. The suffix test runs on
/// `decodeURIComponent(req.path)` (the raw path when decoding throws), while
/// the two canonical names are compared exactly, case-sensitively.
pub fn is_forbidden_binary(path: &str) -> bool {
    let requested = decode_uri_component(path).unwrap_or_else(|| path.to_string());
    requested != "/multicc.apk" && requested != "/multicc-ios.ipa" && has_binary_suffix(&requested)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manage(url: &str) -> String {
        manage_redirect(&QueryView::new(url))
    }

    #[test]
    fn manage_defaults_to_the_overview() {
        assert_eq!(manage("/manage"), "/air?view=overview");
        assert_eq!(manage("/manage?view="), "/air?view=overview");
        assert_eq!(manage("/manage?view=bogus"), "/air?view=overview");
        assert_eq!(manage("/manage?view=planner"), "/air?view=overview");
        assert_eq!(manage("/manage?view=tasks"), "/air?view=overview");
        assert_eq!(manage("/manage?view=cron"), "/air?view=schedules");
    }

    #[test]
    fn manage_keeps_every_allowed_view() {
        for view in ALLOWED_VIEWS {
            assert_eq!(
                manage(&format!("/manage?view={view}")),
                format!("/air?view={view}")
            );
        }
    }

    #[test]
    fn manage_reads_the_focus_aux_shorthand() {
        assert_eq!(manage("/manage?focus=aux"), "/air?view=aux");
        assert_eq!(manage("/manage?focus=other"), "/air?view=overview");
        // A view string always wins over focus, even an empty or unknown one.
        assert_eq!(manage("/manage?focus=aux&view=docs"), "/air?view=docs");
    }

    #[test]
    fn manage_emits_token_then_external_then_dir_task() {
        assert_eq!(
            manage("/manage?task=t1&dir=d1&external=ext&token=tok&view=docs"),
            "/air?view=docs&token=tok&external=ext&dir=d1&task=t1"
        );
        // Empty strings are falsy and skipped; arrays/objects are not strings.
        assert_eq!(
            manage("/manage?view=docs&token=&external=&dir=&task="),
            "/air?view=docs"
        );
        assert_eq!(
            manage("/manage?view=docs&token=a&token=b&external=a&external=b"),
            "/air?view=docs"
        );
        assert_eq!(
            manage("/manage?view=docs&token[a]=1&dir[a]=1"),
            "/air?view=docs"
        );
    }

    #[test]
    fn manage_query_values_are_form_urlencoded() {
        assert_eq!(
            manage("/manage?view=docs&token=a%20b%26c&dir=%E4%B8%AD%E6%96%87"),
            "/air?view=docs&token=a+b%26c&dir=%E4%B8%AD%E6%96%87"
        );
        // URLSearchParams encodes these; encodeURIComponent would not.
        assert_eq!(
            manage("/manage?view=docs&task=%7E%21*%27%28%29"),
            "/air?view=docs&task=%7E%21*%27%28%29"
        );
    }

    #[test]
    fn manage_repeats_the_object_prototype_lookup_quirk() {
        assert_eq!(
            manage("/manage?view=__proto__"),
            "/air?view=%5Bobject+Object%5D"
        );
        assert_eq!(
            manage("/manage?view=constructor"),
            "/air?view=function+Object%28%29+%7B+%5Bnative+code%5D+%7D"
        );
    }

    #[test]
    fn dashboard_emits_dir_task_token_external() {
        let dashboard = |url: &str| dashboard_redirect(&QueryView::new(url));
        assert_eq!(dashboard("/dashboard"), "/air?view=overview");
        assert_eq!(
            dashboard("/dashboard?external=e&token=t&task=k&dir=d&view=docs"),
            "/air?view=overview&dir=d&task=k&token=t&external=e"
        );
        assert_eq!(
            dashboard("/dashboard?dir=&task=&token=&external="),
            "/air?view=overview"
        );
        assert_eq!(dashboard("/dashboard?dir=a&dir=b"), "/air?view=overview");
    }

    #[test]
    fn air_claims_only_the_planner_view() {
        let air = |url: &str| air_planner_redirect(&QueryView::new(url));
        assert_eq!(air("/air"), None);
        assert_eq!(air("/air?view=overview"), None);
        assert_eq!(air("/air?view=other"), None);
        assert_eq!(air("/air?view=planner&view=docs"), None);
        assert_eq!(
            air("/air?view=planner&task=t&dir=d&token=x&external=e"),
            Some("/air?view=overview&dir=d&task=t&token=x&external=e".to_string())
        );
    }

    #[test]
    fn claim_follows_express_matching_and_keeps_air_query_dependent() {
        assert_eq!(claim("GET", "/manage"), Some(Route::Manage));
        assert_eq!(claim("HEAD", "/Manage.HTML/"), Some(Route::Manage));
        assert_eq!(claim("GET", "/dashboard.html"), Some(Route::Dashboard));
        assert_eq!(claim("POST", "/manage"), None);
        assert_eq!(claim("GET", "/manage//"), None);
        assert_eq!(claim("GET", "/manage"), Some(Route::Manage));
        assert_eq!(claim("OPTIONS", "/manage"), Some(Route::Options));
        assert_eq!(claim("OPTIONS", "/air"), Some(Route::Options));
        assert_eq!(claim("OPTIONS", "/dashboard.html/"), Some(Route::Options));
        assert_eq!(claim("OPTIONS", "/air"), Some(Route::Options));
        assert_eq!(claim("OPTIONS", "/elsewhere"), None);
        // /air itself is query-dependent.
        assert_eq!(claim("GET", "/air"), None);
        assert_eq!(
            claim_air("GET", "/air", "/air?view=planner"),
            Some(Route::AirPlanner)
        );
        assert_eq!(
            claim_air("HEAD", "/air.html", "/air.html?view=planner"),
            Some(Route::AirPlanner)
        );
        assert_eq!(claim_air("GET", "/air", "/air"), None);
        assert_eq!(claim_air("POST", "/air", "/air?view=planner"), None);
    }

    #[test]
    fn binary_guard_matches_the_express_regex() {
        for path in [
            "/x.apk",
            "/x.APK",
            "/x.ipa",
            "/nested/other.apk",
            "/plugins/x/y.apk",
            "/a.b.ipa",
            "/x%2Eapk",
            "/%61pk.APK",
            "/MULTICC.APK",
            "/multicc-ios.IPA",
        ] {
            assert!(is_forbidden_binary(path), "{path}");
        }
        for path in [
            "/multicc.apk",
            "/multicc-ios.ipa",
            "/multicc.apk/",
            "/x.apk/",
            "/foo.apk.txt",
            "/x.apx",
            "/apk",
            "/manage",
            "/",
        ] {
            assert!(!is_forbidden_binary(path), "{path}");
        }
        // A malformed escape falls back to the raw path; the raw path still
        // ends in `.apk`, so the guard still applies.
        assert!(is_forbidden_binary("/x%zz.apk"));
        // `%2F` decodes into a separator but the suffix still governs.
        assert!(is_forbidden_binary("/nested%2Fother.apk"));
    }
}
