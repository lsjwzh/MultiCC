//! The rule half of the plugin cluster retired from `src/routes/plugins.js`:
//! `POST /api/channels/recheck` and `GET|HEAD /plugins/:id/*`.
//!
//! Both routes are pure policy once the two Node-only facts are in: which
//! plugin directory backs an id (`findPlugin`) and whether a task's question is
//! still open (`channelStillActive`). They arrive through one host port,
//! `POST /api/__host/plugins` (src/routes/plugins-host.js); the front door
//! (`native/gateway/src/app/plugins.rs`) does the request/response plumbing and
//! the file access, and this module holds the rules it must not get wrong:
//!
//! * the recheck body projection — `items.slice(0, 200)`, drop everything that
//!   is not object-like in the JS sense, then `sessionId.slice(0, 128)` and
//!   `category.slice(0, 32)` **in UTF-16 code units** (a cut through a surrogate
//!   pair leaves the lone high unit, exactly like `String.prototype.slice`);
//! * the response text — fixed key order `sessionId, category, active`,
//!   serialized with `JSON.stringify` rules (the lone unit becomes `\udXXX`);
//! * the path gate — `(req.params[0] || '').replace(/\\/g, '/')`, then "empty,
//!   any `..` substring, or a leading `/` is 非法路径";
//! * the two containment checks — `absolute.startsWith(root + sep)` and the UI
//!   subtree built from `path.join(root, path.dirname(ui || 'ui/index.html'))`.
//!   String prefix semantics matter: the UI directory itself
//!   (`root/ui`) is *not* inside `root/ui/`, so it is 403, not 200;
//! * the MIME table and `path.extname(...).toLowerCase()`.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::js::serde::from_serde;
use crate::js::{json_stringify, JsString, JsValue};

/// `items.slice(0, 200)`.
pub const RECHECK_LIMIT: usize = 200;
/// `sessionId.slice(0, 128)`.
pub const SESSION_ID_MAX: usize = 128;
/// `category.slice(0, 32)`.
pub const CATEGORY_MAX: usize = 32;

/// `found.manifest.ui || 'ui/index.html'` (the empty string is falsy).
pub const DEFAULT_UI: &str = "ui/index.html";

/// `res.set('Cache-Control', 'no-store')` on the recheck answer.
pub const RECHECK_CACHE_CONTROL: &str = "no-store";
/// `res.set('Cache-Control', 'no-store, no-cache, must-revalidate')` on a file.
pub const FILE_CACHE_CONTROL: &str = "no-store, no-cache, must-revalidate";

/// `{ error: '只接受本机插件的复核请求' }`.
pub const ERR_LOCAL_ONLY: &str = "只接受本机插件的复核请求";
/// `{ error: '非法路径' }`.
pub const ERR_ILLEGAL_PATH: &str = "非法路径";
/// `{ error: '文件不存在' }`.
pub const ERR_FILE_NOT_FOUND: &str = "文件不存在";
/// `{ error: '只有 UI 子树可访问' }`.
pub const ERR_UI_ONLY: &str = "只有 UI 子树可访问";

/// `{ error: \`插件 ${id} 不存在\` }` with the decoded id interpolated raw.
pub fn plugin_not_found_message(id: &str) -> String {
    format!("插件 {id} 不存在")
}

// ── POST /api/channels/recheck ─────────────────────────────────────────────

/// One surviving recheck item, already truncated, still in UTF-16 units (a
/// cut may have left a lone surrogate, which a `String` could not hold).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub session_id: JsString,
    pub category: JsString,
}

/// `items.filter(item => item && typeof item === 'object').map(...)` over
/// `items.slice(0, 200)`. The slice happens first: non-object entries inside
/// the first 200 are dropped, and anything past them is never looked at.
///
/// `typeof` reports `"object"` for `null`, arrays and objects alike; the `item`
/// truthiness check removes `null`, so arrays and objects survive.
pub fn normalize_recheck_items(body: &Value) -> Vec<Item> {
    let value = from_serde(body);
    let Some(JsValue::Array(items)) = value.get("items") else {
        return Vec::new();
    };
    items
        .iter()
        .take(RECHECK_LIMIT)
        .filter(|item| matches!(item, JsValue::Array(_) | JsValue::Object(_)))
        .map(|item| Item {
            session_id: string_field(item, "sessionId", SESSION_ID_MAX),
            category: string_field(item, "category", CATEGORY_MAX),
        })
        .collect()
}

/// `typeof item[key] === 'string' ? item[key].slice(0, max) : ''`.
fn string_field(item: &JsValue, key: &str, max: usize) -> JsString {
    match item.get(key) {
        Some(JsValue::String(text)) => text.truncate_units(max),
        _ => JsString::new(),
    }
}

/// `res.json({ items: [...] })` for the recheck answer: one object per item,
/// keys in insertion order, `active` paired by position (`false` when the host
/// answered short, which the caller rejects before rendering).
pub fn recheck_response(items: &[Item], active: &[bool]) -> String {
    let entries: Vec<JsValue> = items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            JsValue::object(vec![
                ("sessionId", JsValue::String(item.session_id.clone())),
                ("category", JsValue::String(item.category.clone())),
                (
                    "active",
                    JsValue::Bool(active.get(index).copied().unwrap_or(false)),
                ),
            ])
        })
        .collect();
    let body = JsValue::object(vec![("items", JsValue::Array(entries))]);
    // No `undefined` can appear in this shape, so stringify cannot fail.
    json_stringify(&body).unwrap_or_else(|| "{\"items\":[]}".to_string())
}

// ── GET|HEAD /plugins/:id/* ────────────────────────────────────────────────

/// The only refusal `resolve_plugin_file` produces; all of them are the same
/// 400 `{"error":"非法路径"}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginFileError {
    IllegalPath,
}

/// `(req.params[0] || '').replace(/\\/g, '/')` followed by the retired
/// handler's three rejections. `..` is a *substring* test, so `a..b` is refused
/// too, and the check runs on the decoded value (so `%2e%2e` is caught).
pub fn resolve_plugin_file(relative_raw: &str) -> Result<String, PluginFileError> {
    let relative = relative_raw.replace('\\', "/");
    if relative.is_empty() || relative.contains("..") || relative.starts_with('/') {
        return Err(PluginFileError::IllegalPath);
    }
    Ok(relative)
}

/// `path.join(root, path.dirname(ui || 'ui/index.html'))`. `ui` comes from the
/// host port as the manifest's own value (or the default); an empty string is
/// falsy in JS and falls back the same way.
pub fn ui_root(root: &Path, ui: &str) -> PathBuf {
    let ui = if ui.is_empty() { DEFAULT_UI } else { ui };
    let dir = dirname(ui);
    PathBuf::from(join(root.to_string_lossy().as_ref(), &dir))
}

/// `absolute.startsWith(root + path.sep)`. A byte prefix on the lossy UTF-8
/// form, because Node's strings are the lossy form too. Note this excludes
/// `root` itself: the UI directory is not a file inside the UI subtree.
pub fn within(root: &Path, absolute: &Path) -> bool {
    let prefix = format!(
        "{}{}",
        root.to_string_lossy(),
        std::path::MAIN_SEPARATOR
    );
    absolute.to_string_lossy().starts_with(&prefix)
}

/// `MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'`.
pub fn mime_for(extension: &str) -> &'static str {
    match extension {
        ".html" => "text/html; charset=utf-8",
        ".js" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".json" => "application/json; charset=utf-8",
        ".svg" => "image/svg+xml",
        ".png" => "image/png",
        ".ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// The whole `res.set('Content-Type', …)` expression for a file path.
pub fn mime_for_path(path: &str) -> &'static str {
    mime_for(&extension_lower(path))
}

/// `path.extname(path).toLowerCase()` (posix rules: a leading dot is not an
/// extension, `a.` is the extension `.`, a slash resets the name).
pub fn extension_lower(path: &str) -> String {
    let chars: Vec<char> = path.chars().collect();
    if chars.is_empty() {
        return String::new();
    }
    let mut start_dot: isize = -1;
    let mut start_part: usize = 0;
    let mut end: isize = -1;
    let mut matched_slash = true;
    let mut pre_dot_state = 0i8;
    let mut index = chars.len() as isize - 1;
    while index >= 0 {
        let code = chars[index as usize];
        if code == '/' {
            if !matched_slash {
                start_part = index as usize + 1;
                break;
            }
            index -= 1;
            continue;
        }
        if end == -1 {
            matched_slash = false;
            end = index + 1;
        }
        if code == '.' {
            if start_dot == -1 {
                start_dot = index;
            } else if pre_dot_state != 1 {
                pre_dot_state = 1;
            }
        } else if start_dot != -1 {
            pre_dot_state = -1;
        }
        index -= 1;
    }
    if start_dot == -1
        || end == -1
        || pre_dot_state == 0
        || (pre_dot_state == 1
            && start_dot == end - 1
            && start_dot == start_part as isize + 1)
    {
        return String::new();
    }
    chars[start_dot as usize..end as usize]
        .iter()
        .collect::<String>()
        .to_lowercase()
}

/// `path.posix.dirname`, quirk for quirk (including the `//` a root-level
/// single segment produces, which `join` collapses again).
fn dirname(path: &str) -> String {
    let chars: Vec<char> = path.chars().collect();
    if chars.is_empty() {
        return ".".to_string();
    }
    let has_root = chars[0] == '/';
    let mut end: isize = -1;
    let mut matched_slash = true;
    let mut index = chars.len() as isize - 1;
    while index >= 1 {
        if chars[index as usize] == '/' {
            if !matched_slash {
                end = index;
                break;
            }
        } else {
            matched_slash = false;
        }
        index -= 1;
    }
    if end == -1 {
        return if has_root { "/" } else { "." }.to_string();
    }
    if has_root && end == 1 {
        return "//".to_string();
    }
    chars[..end as usize].iter().collect()
}

/// `path.posix.join(base, rest)`.
fn join(base: &str, rest: &str) -> String {
    normalize(&format!("{base}/{rest}"))
}

/// `path.posix.normalize`.
fn normalize(input: &str) -> String {
    if input.is_empty() {
        return ".".to_string();
    }
    let absolute = input.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for segment in input.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                match parts.last() {
                    Some(last) if *last != ".." => {
                        parts.pop();
                    }
                    _ => {
                        if !absolute {
                            parts.push("..");
                        }
                    }
                }
            }
            other => parts.push(other),
        }
    }
    let joined = parts.join("/");
    if absolute {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn items(value: Value) -> Vec<Item> {
        normalize_recheck_items(&value)
    }

    fn lossy(item: &Item) -> (String, String) {
        (item.session_id.to_string_lossy(), item.category.to_string_lossy())
    }

    // ── recheck projection ──────────────────────────────────────────────

    #[test]
    fn only_object_like_items_survive_in_order() {
        let projected = items(json!({
            "items": [
                null, 1, "x", true, false, 0, "",
                { "sessionId": "sess-active", "category": "attention" },
                [], [1]
            ]
        }));
        assert_eq!(projected.len(), 3);
        assert_eq!(
            lossy(&projected[0]),
            ("sess-active".to_string(), "attention".to_string())
        );
        // Arrays are objects for `typeof`; their missing fields become "".
        assert_eq!(lossy(&projected[1]), (String::new(), String::new()));
        assert_eq!(lossy(&projected[2]), (String::new(), String::new()));
    }

    #[test]
    fn items_are_sliced_before_filtering() {
        let mut raw = vec![Value::Null; 199];
        raw.push(json!({ "sessionId": "kept", "category": "attention" }));
        raw.push(json!({ "sessionId": "past-the-cut", "category": "attention" }));
        let projected = items(json!({ "items": raw }));
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].session_id.to_string_lossy(), "kept");
    }

    #[test]
    fn two_hundred_items_are_kept_and_two_hundred_one_are_not() {
        let make = |count: usize| {
            let list: Vec<Value> = (0..count)
                .map(|index| json!({ "sessionId": format!("s{index}"), "category": "done" }))
                .collect();
            items(json!({ "items": list }))
        };
        assert_eq!(make(200).len(), 200);
        let cut = make(201);
        assert_eq!(cut.len(), 200);
        assert_eq!(cut[199].session_id.to_string_lossy(), "s199");
    }

    #[test]
    fn a_missing_or_non_array_items_value_projects_nothing() {
        assert!(items(json!({})).is_empty());
        assert!(items(json!({ "items": "sess-active" })).is_empty());
        assert!(items(json!({ "items": { "sessionId": "x" } })).is_empty());
        assert!(items(Value::Null).is_empty());
        assert!(items(json!([])).is_empty());
    }

    #[test]
    fn non_string_fields_become_empty_strings() {
        let projected = items(json!({
            "items": [{ "sessionId": 7, "category": ["attention"] }, {}, { "sessionId": null }]
        }));
        for item in &projected {
            assert_eq!(lossy(item), (String::new(), String::new()));
        }
    }

    #[test]
    fn session_id_is_cut_at_128_utf16_units() {
        let long = "x".repeat(200);
        let projected = items(json!({ "items": [{ "sessionId": long, "category": "attention" }] }));
        assert_eq!(projected[0].session_id.len(), 128);
        assert_eq!(projected[0].session_id.to_string_lossy(), "x".repeat(128));
    }

    #[test]
    fn category_is_cut_at_32_utf16_units() {
        let long = "y".repeat(40);
        let projected = items(json!({ "items": [{ "sessionId": "s", "category": long }] }));
        assert_eq!(projected[0].category.len(), 32);
        assert_eq!(projected[0].category.to_string_lossy(), "y".repeat(32));
    }

    #[test]
    fn exactly_128_and_32_units_are_kept_whole() {
        let session = "a".repeat(128);
        let category = "b".repeat(32);
        let projected =
            items(json!({ "items": [{ "sessionId": session, "category": category }] }));
        assert_eq!(projected[0].session_id.len(), 128);
        assert_eq!(projected[0].category.len(), 32);
        assert!(projected[0].session_id.is_well_formed());
        assert!(projected[0].category.is_well_formed());
    }

    #[test]
    fn a_surrogate_pair_straddling_the_128_cut_leaves_the_lone_high_unit() {
        // 127 units, then an emoji (two units): the cut keeps only the first.
        let session = format!("{}😀tail", "a".repeat(127));
        let projected =
            items(json!({ "items": [{ "sessionId": session, "category": "attention" }] }));
        let units = projected[0].session_id.as_units();
        assert_eq!(units.len(), 128);
        assert_eq!(units[127], 0xD83D);
        assert!(!projected[0].session_id.is_well_formed());
    }

    #[test]
    fn a_surrogate_pair_straddling_the_32_cut_leaves_the_lone_high_unit() {
        let category = format!("{}😀", "b".repeat(31));
        let projected =
            items(json!({ "items": [{ "sessionId": "s", "category": category }] }));
        let units = projected[0].category.as_units();
        assert_eq!(units.len(), 32);
        assert_eq!(units[31], 0xD83D);
    }

    #[test]
    fn a_pair_ending_exactly_at_the_cut_survives_whole() {
        let session = format!("{}😀", "a".repeat(126));
        let projected =
            items(json!({ "items": [{ "sessionId": session, "category": "" }] }));
        assert_eq!(projected[0].session_id.len(), 128);
        assert!(projected[0].session_id.is_well_formed());
    }

    #[test]
    fn the_response_keeps_key_order_and_renders_a_lone_surrogate_like_json_stringify() {
        let projected = items(json!({
            "items": [{ "sessionId": "sess-active", "category": "attention" }]
        }));
        assert_eq!(
            recheck_response(&projected, &[true]),
            r#"{"items":[{"sessionId":"sess-active","category":"attention","active":true}]}"#
        );
        assert_eq!(
            recheck_response(&projected, &[false]),
            r#"{"items":[{"sessionId":"sess-active","category":"attention","active":false}]}"#
        );

        let cut = items(json!({
            "items": [{ "sessionId": format!("{}😀", "a".repeat(127)), "category": "" }]
        }));
        let text = recheck_response(&cut, &[true]);
        assert!(
            text.contains("\"sessionId\":\"aaaa"),
            "sessionId is first: {text}"
        );
        assert!(text.contains("\\ud83d"), "lone unit as an escape: {text}");
        assert!(text.ends_with("\"category\":\"\",\"active\":true}]}"), "{text}");
    }

    #[test]
    fn the_empty_answer_is_the_empty_items_array() {
        assert_eq!(recheck_response(&[], &[]), r#"{"items":[]}"#);
    }

    #[test]
    fn active_pairs_by_position_and_missing_answers_render_false() {
        let projected = items(json!({
            "items": [
                { "sessionId": "a", "category": "x" },
                { "sessionId": "b", "category": "x" }
            ]
        }));
        assert_eq!(
            recheck_response(&projected, &[true]),
            r#"{"items":[{"sessionId":"a","category":"x","active":true},{"sessionId":"b","category":"x","active":false}]}"#
        );
    }

    // ── path gate ───────────────────────────────────────────────────────

    #[test]
    fn resolve_accepts_ordinary_relative_paths() {
        assert_eq!(
            resolve_plugin_file("ui/index.html").as_deref(),
            Ok("ui/index.html")
        );
        assert_eq!(
            resolve_plugin_file("ui//app.js").as_deref(),
            Ok("ui//app.js")
        );
        assert_eq!(resolve_plugin_file("./app.js").as_deref(), Ok("./app.js"));
        assert_eq!(resolve_plugin_file("ui/").as_deref(), Ok("ui/"));
        assert_eq!(resolve_plugin_file(".").as_deref(), Ok("."));
        assert_eq!(
            resolve_plugin_file("中文 name.html").as_deref(),
            Ok("中文 name.html")
        );
        // The gateway decodes `req.params[0]` before calling this, so the
        // literal escape text is not a traversal: it is an ordinary name here.
        // `%2e%2e` was already turned into ".." by the caller.
        assert_eq!(
            resolve_plugin_file("%2e%2e/secret.txt").as_deref(),
            Ok("%2e%2e/secret.txt")
        );
    }

    #[test]
    fn resolve_normalizes_backslashes_before_checking() {
        assert_eq!(
            resolve_plugin_file(r"ui\sub\page.html").as_deref(),
            Ok("ui/sub/page.html")
        );
        // The traversal test runs on the normalized value.
        assert_eq!(
            resolve_plugin_file(r"ui\..\secret.txt"),
            Err(PluginFileError::IllegalPath)
        );
        assert_eq!(
            resolve_plugin_file(r"\etc\passwd"),
            Err(PluginFileError::IllegalPath)
        );
    }

    #[test]
    fn resolve_refuses_empty_traversal_and_absolute_paths() {
        for raw in [
            "",
            "..",
            "../secret.txt",
            "ui/../secret.txt",
            "a/../b",
            "../%2e%2e",
            "a..b",
            ".hidden..",
            "/etc/passwd",
            "/",
            "//etc/passwd",
        ] {
            assert_eq!(
                resolve_plugin_file(raw),
                Err(PluginFileError::IllegalPath),
                "{raw}"
            );
        }
    }

    // ── containment ─────────────────────────────────────────────────────

    #[test]
    fn within_requires_the_separator_so_the_root_itself_is_outside() {
        let root = Path::new("/srv/apps/demo");
        assert!(within(root, Path::new("/srv/apps/demo/ui/index.html")));
        assert!(within(root, Path::new("/srv/apps/demo/ui")));
        // The root itself is not inside `root + sep`.
        assert!(!within(root, Path::new("/srv/apps/demo")));
        // A sibling with a shared string prefix is not inside it either.
        assert!(!within(root, Path::new("/srv/apps/demolition/x")));
        assert!(!within(root, Path::new("/srv/apps/other/x")));
    }

    #[test]
    fn ui_root_defaults_and_dirnames_the_entry() {
        let root = Path::new("/srv/apps/demo");
        assert_eq!(ui_root(root, "ui/index.html"), root.join("ui"));
        assert_eq!(ui_root(root, "ui/app.js"), root.join("ui"));
        assert_eq!(ui_root(root, "index.html"), root.to_path_buf());
        assert_eq!(ui_root(root, "a/b/c.html"), root.join("a/b"));
        assert_eq!(ui_root(root, "/index.html"), root.to_path_buf());
        // Falsy `ui` falls back to the default before `dirname`.
        assert_eq!(ui_root(root, ""), root.join("ui"));
        // A trailing slash has no entry, so `dirname` is `.`.
        assert_eq!(ui_root(root, "ui/"), root.to_path_buf());
    }

    #[test]
    fn the_ui_directory_itself_is_not_inside_the_ui_subtree() {
        let root = Path::new("/srv/apps/demo");
        let ui = ui_root(root, DEFAULT_UI);
        assert!(within(&ui, Path::new("/srv/apps/demo/ui/index.html")));
        assert!(!within(&ui, Path::new("/srv/apps/demo/ui")));
        assert!(!within(&ui, Path::new("/srv/apps/demo/secret.txt")));
    }

    #[test]
    fn a_flat_ui_root_is_the_plugin_root_but_still_excludes_it() {
        let root = Path::new("/srv/apps/flat");
        let ui = ui_root(root, "index.html");
        assert_eq!(ui, root.to_path_buf());
        assert!(within(&ui, Path::new("/srv/apps/flat/plugin.json")));
        assert!(!within(&ui, Path::new("/srv/apps/flat")));
    }

    // ── MIME ────────────────────────────────────────────────────────────

    #[test]
    fn the_mime_table_matches_the_retired_one() {
        for (extension, expected) in [
            (".html", "text/html; charset=utf-8"),
            (".js", "text/javascript; charset=utf-8"),
            (".css", "text/css; charset=utf-8"),
            (".json", "application/json; charset=utf-8"),
            (".svg", "image/svg+xml"),
            (".png", "image/png"),
            (".ico", "image/x-icon"),
            (".txt", "application/octet-stream"),
            ("", "application/octet-stream"),
            (".", "application/octet-stream"),
            (".webp", "application/octet-stream"),
        ] {
            assert_eq!(mime_for(extension), expected, "{extension}");
        }
        assert_eq!(mime_for(".HTML"), "application/octet-stream");
        assert_eq!(mime_for_path("index.HTML"), "text/html; charset=utf-8");
        assert_eq!(mime_for_path("style.CSS"), "text/css; charset=utf-8");
    }

    #[test]
    fn extension_lower_follows_path_extname() {
        assert_eq!(extension_lower("/a/b/index.html"), ".html");
        assert_eq!(extension_lower("app.JS"), ".js");
        assert_eq!(extension_lower("noext"), "");
        assert_eq!(extension_lower(".hidden"), "");
        assert_eq!(extension_lower("a."), ".");
        assert_eq!(extension_lower("dir.d/file"), "");
        assert_eq!(extension_lower(""), "");
        assert_eq!(extension_lower("a.b.c"), ".c");
        assert_eq!(extension_lower("ui/sub/deep/page.html"), ".html");
    }

    #[test]
    fn the_not_found_message_interpolates_the_id_raw() {
        assert_eq!(plugin_not_found_message("ghost"), "插件 ghost 不存在");
        assert_eq!(plugin_not_found_message("幽灵"), "插件 幽灵 不存在");
        assert_eq!(plugin_not_found_message(".."), "插件 .. 不存在");
    }
}
