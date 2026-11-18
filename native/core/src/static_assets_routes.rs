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
use crate::http_send::Header;
use crate::static_web::{self, decode_uri_component};

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

// ---------------------------------------------------------------------------
// The versioned-HTML middleware (`src/routes/static-assets.js`)
// ---------------------------------------------------------------------------

/// The four documents the retired middleware answered with `task-entry.html`.
const TASK_ENTRY_PATHS: [&str; 4] = ["chat", "chat.html", "task-shell", "task-shell.html"];

/// What the retired `app.use((req, res, next) => …)` middleware would do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VersionedPlan {
    /// `next()`: not a GET, an undecodable path, an escaping candidate, or no
    /// candidate file. The `express.static` mount is next in line.
    Skip,
    /// The chat/task-shell hop: `public/task-entry.html`, always rendered.
    TaskEntry,
    /// This `public/`-relative candidate, rendered when it is a regular file.
    Candidate { relative: String },
}

/// `req.query.air === '1'` plus a non-empty `task` or `session`: the one case
/// where `chat.html` stays the canonical renderer instead of hopping.
fn air_chat_renderer(rel: &str, query: &QueryView) -> bool {
    query.string("air").as_deref() == Some("1")
        && ["chat", "chat.html"].contains(&rel)
        && ["task", "session"]
            .iter()
            .any(|key| query.truthy_string(key).is_some())
}

/// The middleware's decision for `GET <path>`; callers must not run it for any
/// other method (the retired handler's first line was `req.method !== 'GET'`).
pub fn versioned_plan(path: &str, query: &QueryView) -> VersionedPlan {
    let Some(decoded) = decode_uri_component(path) else {
        return VersionedPlan::Skip;
    };
    let rel = decoded.trim_start_matches('/');
    if TASK_ENTRY_PATHS.contains(&rel) && !air_chat_renderer(rel, query) {
        return VersionedPlan::TaskEntry;
    }
    let candidate = if rel.is_empty() || rel == "/" {
        "index.html".to_string()
    } else if rel.ends_with(".html") {
        rel.to_string()
    } else {
        format!("{rel}.html")
    };
    // `path.resolve(publicDir, c)` followed by the `startsWith(publicDir + sep)`
    // containment test: a candidate that leaves the root failed the `if` and
    // fell through to the static mount.
    let resolved = static_web::normalize(&candidate);
    if resolved.starts_with('/') || resolved.starts_with("..") || resolved == "." {
        return VersionedPlan::Skip;
    }
    VersionedPlan::Candidate { relative: resolved }
}

/// The document name the `TaskEntry` hop renders.
pub const TASK_ENTRY_FILE: &str = "task-entry.html";

/// JS `\s`.
fn is_js_space(value: char) -> bool {
    matches!(value,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | '\u{20}' | '\u{a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}'
        | '\u{3000}' | '\u{feff}')
}

/// The attribute prefix `((?:src|href)\s*=\s*["'])`, matched at `start`.
/// Returns the index just past the opening quote.
fn attribute_prefix(chars: &[char], start: usize) -> Option<usize> {
    let name: String = chars
        .get(start..(start + 4).min(chars.len()))?
        .iter()
        .collect();
    let lower = name.to_ascii_lowercase();
    let mut index = if lower.starts_with("src") {
        start + 3
    } else if lower.starts_with("href") {
        start + 4
    } else {
        return None;
    };
    while chars.get(index).copied().is_some_and(is_js_space) {
        index += 1;
    }
    if chars.get(index).copied() != Some('=') {
        return None;
    }
    index += 1;
    while chars.get(index).copied().is_some_and(is_js_space) {
        index += 1;
    }
    match chars.get(index) {
        Some('"') | Some('\'') => Some(index + 1),
        _ => None,
    }
}

/// `((?:src|href)\s*=\s*["'])(?!https?:)(?!\/\/)([^"'?#]+\.)(js|css)(["'])` →
/// `$1$2$3?v=<mtime>$4`, the cache-busting rewrite for embedded WebViews.
///
/// `mtime` receives the asset's `public/`-relative name (group 2 + group 3) and
/// returns its raw `stat.mtimeMs`, or `None` where `statSync` threw — in which
/// case the match is kept verbatim, exactly like the retired `catch`.
pub fn version_html(html: &str, mtime: &dyn Fn(&str) -> Option<f64>) -> String {
    let chars: Vec<char> = html.chars().collect();
    let forbidden = |value: char| matches!(value, '"' | '\'' | '?' | '#');
    let mut out = String::with_capacity(html.len());
    let mut cursor = 0usize;
    let mut at = 0usize;
    while at < chars.len() {
        let Some(value_start) = attribute_prefix(&chars, at) else {
            at += 1;
            continue;
        };
        let rest: String = chars[value_start..].iter().collect();
        let lower_rest = rest.to_ascii_lowercase();
        if lower_rest.starts_with("http:")
            || lower_rest.starts_with("https:")
            || lower_rest.starts_with("//")
        {
            at += 1;
            continue;
        }
        let mut run_end = value_start;
        while chars.get(run_end).copied().is_some_and(|c| !forbidden(c)) {
            run_end += 1;
        }
        // Group 4 is a quote, and a quote is the only thing that can end the
        // run and still match.
        let quote = match chars.get(run_end) {
            Some('"') => '"',
            Some('\'') => '\'',
            _ => {
                at += 1;
                continue;
            }
        };
        let run: String = chars[value_start..run_end].iter().collect();
        let lower_run = run.to_ascii_lowercase();
        // `([^"'?#]+\.)(js|css)`: at least one character, then the dot.
        let extension_len = if lower_run.ends_with(".js") && run.chars().count() >= 4 {
            2
        } else if lower_run.ends_with(".css") && run.chars().count() >= 5 {
            3
        } else {
            at += 1;
            continue;
        };
        let split = run.chars().count() - extension_len;
        let name: String = run.chars().take(split).collect();
        let extension: String = run.chars().skip(split).collect();
        let prefix: String = chars[at..value_start].iter().collect();
        let head: String = chars[cursor..at].iter().collect();
        out.push_str(&head);
        match mtime(&run) {
            Some(mtime_ms) => {
                let stamp = crate::js::number::number_to_string(mtime_ms.floor());
                out.push_str(&prefix);
                out.push_str(&name);
                out.push_str(&extension);
                out.push_str("?v=");
                out.push_str(&stamp);
                out.push(quote);
            }
            None => {
                let whole: String = chars[at..=run_end].iter().collect();
                out.push_str(&whole);
            }
        }
        cursor = run_end + 1;
        at = cursor;
    }
    out.extend(chars[cursor..].iter());
    out
}

/// The retired mount's `setHeaders` hook: the two canonical release binaries
/// are the only `.apk`/`.ipa` names the guard lets through, and both are sent
/// as a no-store attachment. The order is the hook's `res.set` order, which is
/// the order Node writes them.
pub fn download_headers(path: &str) -> Vec<Header> {
    let named = |content_type: &str, filename: &str| {
        vec![
            Header::new("Content-Type", content_type),
            Header::new(
                "Content-Disposition",
                &format!("attachment; filename=\"{filename}\""),
            ),
            Header::new("Cache-Control", "no-store, no-cache, must-revalidate"),
            Header::new("Pragma", "no-cache"),
            Header::new("Expires", "0"),
        ]
    };
    if path.ends_with(".apk") {
        return named("application/vnd.android.package-archive", "multicc.apk");
    }
    if path.ends_with(".ipa") {
        return named("application/octet-stream", "multicc-ios.ipa");
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Measured against the real `html.replace(/…/gi, …)` with the same stub
    /// mtimes (node_modules/express is the oracle; see the probe in the
    /// commit message). Every pair below is the JS output byte for byte.
    #[test]
    fn version_html_matches_the_retired_regexp() {
        let mtime = |name: &str| match name {
            "air.css" => Some(111.0),
            "a.js" => Some(222.0),
            "x/y.js" => Some(333.0),
            "A.JS" => Some(444.0),
            "deep.min.js" => Some(555.0),
            _ => None,
        };
        let cases: [(&str, &str); 24] = [
            (r#"<link href="air.css">"#, r#"<link href="air.css?v=111">"#),
            (
                r#"<script src="a.js"></script>"#,
                r#"<script src="a.js?v=222"></script>"#,
            ),
            (
                r#"<script src='a.js'></script>"#,
                r#"<script src='a.js?v=222'></script>"#,
            ),
            (r#"<script src = "a.js">"#, r#"<script src = "a.js?v=222">"#),
            (
                "<script src\t=\n\"a.js\">",
                "<script src\t=\n\"a.js?v=222\">",
            ),
            (r#"<script src="x/y.js">"#, r#"<script src="x/y.js?v=333">"#),
            (r#"<script src="A.JS">"#, r#"<script src="A.JS?v=444">"#),
            (
                r#"<script src="deep.min.js">"#,
                r#"<script src="deep.min.js?v=555">"#,
            ),
            // The two negative lookaheads and the protocol-relative form.
            (
                r#"<script src="https://cdn/a.js">"#,
                r#"<script src="https://cdn/a.js">"#,
            ),
            (
                r#"<script src="http://cdn/a.js">"#,
                r#"<script src="http://cdn/a.js">"#,
            ),
            (
                r#"<script src="//cdn/a.js">"#,
                r#"<script src="//cdn/a.js">"#,
            ),
            // `?` and `#` end the value run, so an already-versioned or
            // fragment URL never matches.
            (r#"<script src="a.js?v=1">"#, r#"<script src="a.js?v=1">"#),
            (r#"<script src="a.js#frag">"#, r#"<script src="a.js#frag">"#),
            // A missing file keeps the match verbatim (the retired `catch`).
            (
                r#"<script src="unknown.js">"#,
                r#"<script src="unknown.js">"#,
            ),
            // No word boundary: `data-src` matches at its `src`.
            (
                r#"<div data-src="a.js">"#,
                r#"<div data-src="a.js?v=222">"#,
            ),
            // The quotes need not match each other.
            (r#"<script src="a.js'>"#, r#"<script src="a.js?v=222'>"#),
            // `[^"'?#]+\.` needs a character before the dot.
            (r#"<script src=".js">"#, r#"<script src=".js">"#),
            (r#"<script src="a.mjs">"#, r#"<script src="a.mjs">"#),
            (
                r#"<link href="air.css"><script src="a.js">"#,
                r#"<link href="air.css?v=111"><script src="a.js?v=222">"#,
            ),
            (r#"<script src="">"#, r#"<script src="">"#),
            (r#"<script src="a.jsx">"#, r#"<script src="a.jsx">"#),
            (r#"<a href="a.css">x</a>"#, r#"<a href="a.css">x</a>"#),
            (r#"<script SRC="a.js">"#, r#"<script SRC="a.js?v=222">"#),
            // An unterminated value has no group 4.
            (r#"<script src="a.js"#, r#"<script src="a.js"#),
        ];
        for (input, expected) in cases {
            assert_eq!(version_html(input, &mtime), expected, "input: {input}");
        }
    }

    #[test]
    fn version_html_floors_the_mtime_like_math_floor() {
        let mtime = |_: &str| Some(1_763_000_000_123.9);
        assert_eq!(
            version_html(r#"<link href="air.css">"#, &mtime),
            r#"<link href="air.css?v=1763000000123">"#
        );
    }

    #[test]
    fn versioned_plan_follows_the_retired_middleware() {
        let plan = |target: &str| versioned_plan(path_of(target), &QueryView::new(target));
        assert_eq!(plan("/"), VersionedPlan::Candidate { relative: "index.html".to_string() });
        assert_eq!(plan("/air"), VersionedPlan::Candidate { relative: "air.html".to_string() });
        assert_eq!(plan("/air.html"), VersionedPlan::Candidate { relative: "air.html".to_string() });
        assert_eq!(
            plan("/docs/guide"),
            VersionedPlan::Candidate { relative: "docs/guide.html".to_string() }
        );
        // The chat/task-shell hop, and the one `?air=1` exception to it.
        assert_eq!(plan("/chat"), VersionedPlan::TaskEntry);
        assert_eq!(plan("/chat.html"), VersionedPlan::TaskEntry);
        assert_eq!(plan("/task-shell"), VersionedPlan::TaskEntry);
        assert_eq!(plan("/task-shell.html"), VersionedPlan::TaskEntry);
        assert_eq!(plan("/chat.html?air=1"), VersionedPlan::TaskEntry);
        assert_eq!(plan("/chat.html?air=1&task="), VersionedPlan::TaskEntry);
        assert_eq!(plan("/chat.html?air=0&task=t1"), VersionedPlan::TaskEntry);
        assert_eq!(
            plan("/chat.html?air=1&task=t1"),
            VersionedPlan::Candidate { relative: "chat.html".to_string() }
        );
        assert_eq!(
            plan("/chat?air=1&session=s1"),
            VersionedPlan::Candidate { relative: "chat.html".to_string() }
        );
        // An array `air` is not the string '1'; the hop stands.
        assert_eq!(plan("/chat?air=1&air=1&task=t1"), VersionedPlan::TaskEntry);
        // An undecodable path and an escaping candidate both fall through.
        assert_eq!(plan("/%"), VersionedPlan::Skip);
        assert_eq!(plan("/../etc/passwd"), VersionedPlan::Skip);
        assert_eq!(plan("/a/../../etc"), VersionedPlan::Skip);
        // Leading slashes are stripped, not normalised away.
        assert_eq!(
            plan("//air"),
            VersionedPlan::Candidate { relative: "air.html".to_string() }
        );
    }

    fn path_of(target: &str) -> &str {
        match target.find('?') {
            Some(cut) => &target[..cut],
            None => target,
        }
    }

    #[test]
    fn download_headers_cover_only_the_two_release_binaries() {
        let names: Vec<String> = download_headers("/p/multicc.apk")
            .iter()
            .map(|header| header.name.clone())
            .collect();
        assert_eq!(
            names,
            vec![
                "Content-Type",
                "Content-Disposition",
                "Cache-Control",
                "Pragma",
                "Expires"
            ]
        );
        let ipa = download_headers("/p/multicc-ios.ipa");
        assert_eq!(
            String::from_utf8_lossy(&ipa[0].value),
            "application/octet-stream"
        );
        assert_eq!(
            String::from_utf8_lossy(&ipa[1].value),
            "attachment; filename=\"multicc-ios.ipa\""
        );
        assert!(download_headers("/p/air.css").is_empty());
    }

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
