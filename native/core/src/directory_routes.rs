//! The directory / onboarding / UI-layout route cluster's rules kernel.
//!
//! `src/directory/service.js`, `src/directory/ui-layout.js` and
//! `src/ui-layout.js` are retired. What is left of them is the process-local
//! world (the `directories.json` table, git subprocesses, the filesystem scan
//! and mkdir, the session table) behind one Node host port,
//! `POST /api/__host/directory` (`src/routes/directory-host.js`).
//!
//! This module owns the parts that are decisions, not effects:
//!
//! * input validation and normalization (trim, `create` truthiness, the
//!   `rolePrompt` length cap in UTF-16 units, the id list caps),
//! * the path-safety verdict (`isHomeOrAbove`: `$HOME`, any ancestor of it,
//!   the filesystem root) applied to *realpath facts* the host resolves,
//! * the browse decision tree (dotfile rule, shell-style prefix match, the
//!   200-entry cap) over the host's readdir facts plus its `localeCompare`
//!   permutation,
//! * DTO assembly and key order (`{...dir, counts, pushState}`,
//!   `{...dir, reused, createdFiles}`, `{ok:true, ...result}`),
//! * the error code → status mapping and the error envelope
//!   `{code, error, ...extra, requestId?}`,
//! * the `?order` merge rule for the layout document and the registry reorder
//!   plan, and the porcelain `git status` parsing.
//!
//! The kernels deliberately take path *facts* (`base`, `parent`, `realBase`,
//! `realHome`, per-entry `path`) from the host instead of re-implementing
//! Node's `path` module: a second, subtly different path normalizer is exactly
//! how the old `paths.js`/`directories.js` pair diverged.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use crate::js::serde::{js_string, js_trim, truthy, truthy_opt};
use crate::js::string::{is_js_whitespace_char, JsString};

/// `service.js` `browseFs`'s `.slice(0, 200)`.
pub const MAX_BROWSE_ENTRIES: usize = 200;
/// `service.js` `update`'s `rolePrompt.length > 40000` (JS `length`).
pub const MAX_ROLE_PROMPT: usize = 40_000;

/// `src/ui-layout.js` bounds.
pub const UI_SCHEMA_VERSION: u64 = 1;
pub const UI_MAX_IDS: usize = 2000;
pub const UI_MAX_ID_LENGTH: usize = 200;
pub const UI_MAX_DIRS: usize = 500;

/// `src/directory/controller.js` `STATUS`.
pub fn service_status(code: &str) -> u16 {
    match code {
        "not_found" => 404,
        "invalid" => 400,
        _ => 500,
    }
}

/// `send(res, r)`'s failure branch:
/// `{ code: r.code || 'internal', error: r.message, ...extra }`, plus
/// `requestId` when the status is 5xx and the caller has one.
pub fn service_error(
    code: &str,
    message: &str,
    extra: Option<&Value>,
    request_id: Option<&str>,
) -> Value {
    let mut body = Map::new();
    body.insert("code".into(), Value::String(code.to_string()));
    body.insert("error".into(), Value::String(message.to_string()));
    if let Some(Value::Object(fields)) = extra {
        for (key, value) in fields {
            body.insert(key.clone(), value.clone());
        }
    }
    if service_status(code) >= 500 {
        if let Some(id) = request_id {
            body.insert("requestId".into(), Value::String(id.to_string()));
        }
    }
    Value::Object(body)
}

/// `{ ok: true, ...value }` with JS spread order (an existing `ok` key keeps
/// its position and gets the new value).
pub fn merge_ok(value: &Value) -> Value {
    let mut body = Map::new();
    body.insert("ok".into(), Value::Bool(true));
    if let Value::Object(fields) = value {
        for (key, item) in fields {
            body.insert(key.clone(), item.clone());
        }
    }
    Value::Object(body)
}

/// `{ ...base, key: value, ... }` for the annotate/create DTOs.
pub fn with_fields(base: &Value, fields: Vec<(&str, Value)>) -> Value {
    let mut body = match base {
        Value::Object(map) => map.clone(),
        other => {
            let mut map = Map::new();
            map.insert("0".into(), other.clone());
            map
        }
    };
    for (key, value) in fields {
        body.insert(key.to_string(), value);
    }
    Value::Object(body)
}

fn is_root_path(path: &str) -> bool {
    std::path::Path::new(path).parent().is_none()
}

/// `src/path-safety.js` `isHomeOrAbove`, on realpath facts the host resolved:
/// exactly `$HOME`, an ancestor of `$HOME`, or the filesystem root. The
/// `real_home.starts_with(real_path + separator)` test mirrors the JS string
/// concatenation exactly (the root gets a doubled separator, which cannot
/// prefix a real home, and is caught by the root test below).
pub fn is_home_or_above(real_path: &str, real_home: &str) -> bool {
    if real_path == real_home {
        return true;
    }
    let prefixed = format!("{real_path}{}", std::path::MAIN_SEPARATOR);
    if real_home.starts_with(&prefixed) {
        return true;
    }
    is_root_path(real_path)
}

/// `selectable: !helpers.isHomeOrAbove(baseDir)`.
pub fn browse_selectable(real_base: &str, real_home: &str) -> bool {
    !is_home_or_above(real_base, real_home)
}

/// `browseFs`'s filter/map/sort/slice, given the readdir facts and the
/// `localeCompare` permutation the host computed for the whole directory.
///
/// Restricting the full sorted order to the filtered subset is equivalent to
/// sorting the subset: filtering preserves order and `Array#sort` is stable.
pub fn browse_entries(dirents: &[Value], order: &[usize], prefix: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for index in order {
        let Some(entry) = dirents.get(*index) else {
            continue;
        };
        let name = entry.get("name").and_then(Value::as_str).unwrap_or("");
        let mut is_dir = truthy_opt(entry.get("isDirectory"));
        if !is_dir && truthy_opt(entry.get("isSymbolicLink")) {
            // A symlink to a directory is selectable, exactly like the JS
            // `isDirectory(join(base, name))` fallback.
            is_dir = truthy_opt(entry.get("targetIsDirectory"));
        }
        if !is_dir {
            continue;
        }
        if name.starts_with('.') && !prefix.starts_with('.') {
            continue;
        }
        if !prefix.is_empty() && !name.to_lowercase().starts_with(prefix) {
            continue;
        }
        let mut item = Map::new();
        item.insert("name".into(), Value::String(name.to_string()));
        item.insert(
            "path".into(),
            entry.get("path").cloned().unwrap_or(Value::Null),
        );
        out.push(Value::Object(item));
        if out.len() >= MAX_BROWSE_ENTRIES {
            break;
        }
    }
    out
}

/// The 26 per-`(cli, kind)` counters, in the order `listAnnotated` declares.
pub const COUNT_CLIS: [&str; 13] = [
    "claude",
    "codex",
    "opencode",
    "zcode",
    "qoder",
    "kimi",
    "codebuddy",
    "dsh",
    "gemini",
    "grok",
    "agy",
    "commandcode",
    "pi",
];

fn label(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(item) if truthy(item) => js_string(item),
        _ => fallback.to_string(),
    }
}

/// `sessions.listByDir(d.id)` → the counts object.
pub fn counts_for(sessions: &[Value]) -> Value {
    let mut counts = Map::new();
    for cli in COUNT_CLIS {
        for kind in ["terminal", "chat"] {
            counts.insert(format!("{cli}_{kind}"), Value::from(0));
        }
    }
    for session in sessions {
        let key = format!(
            "{}_{}",
            label(session.get("cli"), "claude"),
            label(session.get("kind"), "terminal")
        );
        if let Some(Value::Number(count)) = counts.get_mut(&key) {
            let next = count.as_i64().unwrap_or(0) + 1;
            *count = serde_json::Number::from(next);
        }
    }
    Value::Object(counts)
}

/// `{ ...d, counts, pushState }`.
pub fn annotate_dir(dir: &Value, sessions: &[Value], push_state: Value) -> Value {
    with_fields(
        dir,
        vec![("counts", counts_for(sessions)), ("pushState", push_state)],
    )
}

/// `catch (error) { pushState = { available: false, ... reason } }`.
pub fn push_state_failure(message: &str) -> Value {
    let mut state = Map::new();
    state.insert("available".into(), Value::Bool(false));
    state.insert("hasRemote".into(), Value::Bool(false));
    state.insert("ahead".into(), Value::from(0));
    state.insert("behind".into(), Value::from(0));
    state.insert("reason".into(), Value::String(message.to_string()));
    Value::Object(state)
}

fn js_trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_whitespace_char)
}

/// `uncommitted`: `(await git.statusPorcelain(path)).trimEnd()` split into
/// `{status: line.slice(0, 2), path: line.slice(3)}`. `--porcelain` lines are
/// `XY` + a space + path, so the first three UTF-16 units are always ASCII.
pub fn parse_porcelain(out: &str) -> Vec<Value> {
    let trimmed = js_trim_end(out);
    if trimmed.is_empty() {
        return Vec::new();
    }
    trimmed
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(|line| {
            let units = JsString::from_rust_str(line);
            let mut item = Map::new();
            item.insert(
                "status".into(),
                Value::String(units.slice_units(0, 2).to_string_lossy()),
            );
            item.insert(
                "path".into(),
                Value::String(units.slice_units(3, usize::MAX).to_string_lossy()),
            );
            Value::Object(item)
        })
        .collect()
}

/// `reorder`: dedupe, drop unknown ids and keep the client's relative order.
pub fn reorder_plan(ids: &[Value], known: &[String]) -> Vec<String> {
    let known: HashSet<&str> = known.iter().map(String::as_str).collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut wanted = Vec::new();
    for raw in ids {
        let id = if truthy(raw) {
            js_string(raw)
        } else {
            String::new()
        };
        if id.is_empty() || seen.contains(&id) || !known.contains(id.as_str()) {
            continue;
        }
        seen.insert(id.clone());
        wanted.push(id);
    }
    wanted
}

/// `reorder`'s `rest`: the known ids the client did not mention, in registry
/// order.
pub fn reorder_tail(known: &[String], wanted: &[String]) -> Vec<String> {
    let wanted: HashSet<&str> = wanted.iter().map(String::as_str).collect();
    known
        .iter()
        .filter(|id| !wanted.contains(id.as_str()))
        .cloned()
        .collect()
}

/// `emptyLayout()`.
pub fn empty_layout() -> Value {
    let mut layout = Map::new();
    layout.insert("dirOrder".into(), Value::Array(Vec::new()));
    layout.insert("sessionOrder".into(), Value::Object(Map::new()));
    layout.insert("updatedAt".into(), Value::Null);
    Value::Object(layout)
}

/// `normalizeOrder(value, known)`.
pub fn normalize_order(value: &Value, known: Option<&HashSet<String>>) -> Vec<Value> {
    let Value::Array(items) = value else {
        return Vec::new();
    };
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for raw in items {
        let Value::String(text) = raw else {
            continue;
        };
        let id = js_trim(text);
        if id.is_empty() || id.encode_utf16().count() > UI_MAX_ID_LENGTH {
            continue;
        }
        if let Some(known) = known {
            if !known.contains(id) {
                continue;
            }
        }
        if seen.contains(id) {
            continue;
        }
        seen.insert(id.to_string());
        out.push(Value::String(id.to_string()));
        if out.len() >= UI_MAX_IDS {
            break;
        }
    }
    out
}

/// The known-set snapshot a single layout request is normalized against.
#[derive(Default)]
pub struct UiKnown {
    pub dir_ids: HashSet<String>,
    pub session_ids: HashMap<String, HashSet<String>>,
}

/// `normalizeLayout(raw, { knownDirIds, sessionIdsByDir })`. With no `known`
/// snapshot this is the structural normalization applied when the file is
/// loaded; with one, the read-side pruning served to clients.
pub fn normalize_layout(raw: &Value, known: Option<&UiKnown>) -> Value {
    let mut layout = Map::new();
    let Value::Object(src) = raw else {
        return empty_layout();
    };

    let dir_known = known.map(|snapshot| &snapshot.dir_ids);
    layout.insert(
        "dirOrder".into(),
        Value::Array(normalize_order(
            src.get("dirOrder").unwrap_or(&Value::Null),
            dir_known,
        )),
    );

    let mut session_order = Map::new();
    if let Some(Value::Object(by_src_dir)) = src.get("sessionOrder") {
        let mut dirs = 0usize;
        for (dir_id, order) in by_src_dir {
            if dirs >= UI_MAX_DIRS {
                break;
            }
            if dir_id.is_empty() || dir_id.encode_utf16().count() > UI_MAX_ID_LENGTH {
                continue;
            }
            if let Some(snapshot) = known {
                if !snapshot.dir_ids.contains(dir_id) {
                    continue;
                }
            }
            let sessions = known.and_then(|snapshot| snapshot.session_ids.get(dir_id));
            let list = normalize_order(order, sessions);
            if list.is_empty() {
                continue;
            }
            session_order.insert(dir_id.clone(), Value::Array(list));
            dirs += 1;
        }
    }
    layout.insert("sessionOrder".into(), Value::Object(session_order));

    let stamp = match src.get("updatedAt") {
        Some(Value::String(text)) if !js_trim(text).is_empty() => js_trim(text).to_string(),
        _ => String::new(),
    };
    let updated_at = if !stamp.is_empty() && stamp.encode_utf16().count() <= 40 {
        Value::String(stamp)
    } else {
        Value::Null
    };
    layout.insert("updatedAt".into(), updated_at);
    Value::Object(layout)
}

/// `setDirOrder`: replace the document's `dirOrder` in place.
pub fn apply_dir_order(doc: &mut Value, order: &Value, known: &HashSet<String>) {
    if let Value::Object(map) = doc {
        map.insert(
            "dirOrder".into(),
            Value::Array(normalize_order(order, Some(known))),
        );
    }
}

/// `setSessionOrder`: returns `false` for an unknown directory (the 404).
/// A list that normalizes to empty removes the entry rather than storing [].
pub fn apply_session_order(doc: &mut Value, dir_id: &str, order: &Value, known: &UiKnown) -> bool {
    if !known.dir_ids.contains(dir_id) {
        return false;
    }
    let next = normalize_order(order, known.session_ids.get(dir_id));
    if let Value::Object(map) = doc {
        if let Some(Value::Object(session_order)) = map.get_mut("sessionOrder") {
            if next.is_empty() {
                session_order.remove(dir_id);
            } else {
                session_order.insert(dir_id.to_string(), Value::Array(next));
            }
        }
    }
    true
}

/// `persist()`'s `layout.updatedAt = now()`.
pub fn stamp_updated_at(doc: &mut Value, stamp: &str) {
    if let Value::Object(map) = doc {
        map.insert("updatedAt".into(), Value::String(stamp.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    fn set(items: &[&str]) -> HashSet<String> {
        strings(items).into_iter().collect()
    }

    #[test]
    fn home_itself_and_every_ancestor_are_refused() {
        assert!(is_home_or_above("/Users/pat", "/Users/pat"));
        assert!(is_home_or_above("/Users", "/Users/pat"));
        assert!(is_home_or_above("/", "/Users/pat"));
    }

    #[test]
    fn a_sibling_or_child_of_home_is_allowed() {
        assert!(!is_home_or_above("/Users/pat/projects", "/Users/pat"));
        assert!(!is_home_or_above("/Users/other", "/Users/pat"));
        // `/Users/pat2` must not look like an ancestor of `/Users/pat`.
        assert!(!is_home_or_above("/Users/pat2", "/Users/pat"));
        assert!(!is_home_or_above("/tmp/work", "/Users/pat"));
    }

    #[test]
    fn a_symlink_resolved_to_home_is_refused_by_the_verdict() {
        // The host realpaths `/tmp/link -> /Users/pat` before asking; the
        // verdict must reject the resolved path, not the lexical one.
        assert!(is_home_or_above("/Users/pat", "/Users/pat"));
        assert!(browse_selectable("/private/var/folders/x", "/Users/pat"));
        assert!(!browse_selectable("/Users/pat", "/Users/pat"));
    }

    #[test]
    fn browse_filters_dotfiles_prefixes_symlinks_and_caps() {
        let dirents = vec![
            json!({"name": "Beta", "path": "/b/Beta", "isDirectory": true}),
            json!({"name": ".hidden", "path": "/b/.hidden", "isDirectory": true}),
            json!({"name": "alpha", "path": "/b/alpha", "isDirectory": true}),
            json!({"name": "alink", "path": "/b/alink", "isDirectory": false, "isSymbolicLink": true, "targetIsDirectory": true}),
            json!({"name": "afile", "path": "/b/afile", "isDirectory": false}),
            json!({"name": "broken", "path": "/b/broken", "isDirectory": false, "isSymbolicLink": true, "targetIsDirectory": false}),
        ];
        // The host sorted the whole readdir with localeCompare (case-insensitive
        // here): .hidden, afile, alink, alpha, Beta, broken.
        let order: Vec<usize> = vec![1, 4, 3, 2, 0, 5];
        let all = browse_entries(&dirents, &order, "");
        let names: Vec<&str> = all
            .iter()
            .map(|item| item["name"].as_str().unwrap())
            .collect();
        // A bare listing hides dotfiles; `alink` is a symlink to a directory.
        assert_eq!(names, vec!["alink", "alpha", "Beta"]);
        // Dotfiles stay visible when the typed prefix itself starts with a dot.
        let dotted = browse_entries(&dirents, &order, ".h");
        assert_eq!(dotted.len(), 1);
        assert_eq!(dotted[0]["name"], ".hidden");
        assert_eq!(dotted[0]["path"], "/b/.hidden");
        // Case-insensitive prefix match, symlink-to-directory included.
        let a = browse_entries(&dirents, &order, "a");
        let a_names: Vec<&str> = a
            .iter()
            .map(|item| item["name"].as_str().unwrap())
            .collect();
        assert_eq!(a_names, vec!["alink", "alpha"]);
        // A file is never listed, and neither is a dangling symlink.
        assert!(all.iter().all(|item| item["name"] != "afile"));
        assert!(all.iter().all(|item| item["name"] != "broken"));
    }

    #[test]
    fn browse_caps_at_two_hundred_entries_preserving_order() {
        let dirents: Vec<Value> = (0..250)
            .map(|index| json!({"name": format!("d{index:03}"), "path": format!("/b/d{index:03}"), "isDirectory": true}))
            .collect();
        let order: Vec<usize> = (0..250).collect();
        let listed = browse_entries(&dirents, &order, "");
        assert_eq!(listed.len(), MAX_BROWSE_ENTRIES);
        assert_eq!(listed[0]["name"], "d000");
        assert_eq!(listed[199]["name"], "d199");
    }

    #[test]
    fn counts_use_the_cli_kind_fallbacks_and_ignore_unknown_keys() {
        let sessions = vec![
            json!({"cli": "codex", "kind": "chat"}),
            json!({"cli": "codex", "kind": "chat"}),
            json!({"kind": "terminal"}),
            json!({"cli": "", "kind": ""}),
            json!({"cli": "unknown", "kind": "terminal"}),
            json!({"cli": "claude", "kind": "gateway"}),
        ];
        let counts = counts_for(&sessions);
        assert_eq!(counts["codex_chat"], 2);
        assert_eq!(counts["claude_terminal"], 2);
        assert_eq!(counts["claude_chat"], 0);
        let keys: Vec<&str> = counts
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys.len(), 26);
        assert_eq!(keys[0], "claude_terminal");
        assert_eq!(keys[1], "claude_chat");
        assert_eq!(keys[25], "pi_chat");
    }

    #[test]
    fn annotate_keeps_the_directory_keys_then_counts_and_push_state() {
        let dir = json!({"id": "d1", "name": "Demo", "path": "/d1", "createdAt": "t"});
        let annotated = annotate_dir(&dir, &[], json!({"available": true}));
        let keys: Vec<&str> = annotated
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec!["id", "name", "path", "createdAt", "counts", "pushState"]
        );
        assert_eq!(annotated["pushState"]["available"], true);
    }

    #[test]
    fn push_state_failure_has_the_documented_key_order() {
        let state = push_state_failure("boom");
        let keys: Vec<&str> = state
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec!["available", "hasRemote", "ahead", "behind", "reason"]
        );
        assert_eq!(state["reason"], "boom");
    }

    #[test]
    fn porcelain_parsing_keeps_the_leading_status_space() {
        let out = " M src/app.js\n?? new file.txt\nA  staged.txt\n\n";
        let files = parse_porcelain(out);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0], json!({"status": " M", "path": "src/app.js"}));
        assert_eq!(files[1], json!({"status": "??", "path": "new file.txt"}));
        assert_eq!(files[2], json!({"status": "A ", "path": "staged.txt"}));
        assert!(parse_porcelain("   \n\t\n").is_empty());
    }

    #[test]
    fn reorder_dedupes_drops_unknowns_and_appends_the_tail() {
        let known = strings(&["a", "b", "c", "d"]);
        let ids = json!(["c", "nope", "c", "", null, 7, "a", ["x"]]);
        let wanted = reorder_plan(ids.as_array().unwrap(), &known);
        // `7` stringifies to a known-less id and is dropped.
        assert_eq!(wanted, strings(&["c", "a"]));
        assert_eq!(reorder_tail(&known, &wanted), strings(&["b", "d"]));
    }

    #[test]
    fn normalize_order_trims_dedupes_filters_and_caps() {
        let known = set(&["a", "b"]);
        let order = json!([" a ", 5, null, "a", "b", "zzz", "x".repeat(201)]);
        let out = normalize_order(&order, Some(&known));
        assert_eq!(out, vec![json!("a"), json!("b")]);
        assert!(normalize_order(&json!({"0": "a"}), Some(&known)).is_empty());
        let long: Vec<Value> = (0..(UI_MAX_IDS + 5))
            .map(|i| json!(format!("id{i}")))
            .collect();
        assert_eq!(normalize_order(&Value::Array(long), None).len(), UI_MAX_IDS);
    }

    #[test]
    fn normalize_layout_prunes_and_has_a_stable_key_order() {
        let raw = json!({
            "dirOrder": ["d1", "gone"],
            "sessionOrder": {"d1": ["s1", "s2", "gone"], "d2": ["s3"], "gone": ["s4"]},
            "updatedAt": "2026-11-15T00:00:00.000Z",
            "extra": "dropped",
        });
        let known = UiKnown {
            dir_ids: set(&["d1"]),
            session_ids: HashMap::from([
                ("d1".to_string(), set(&["s1", "s2"])),
                ("d2".to_string(), set(&["s3"])),
            ]),
        };
        let layout = normalize_layout(&raw, Some(&known));
        let keys: Vec<&str> = layout
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, vec!["dirOrder", "sessionOrder", "updatedAt"]);
        assert_eq!(layout["dirOrder"], json!(["d1"]));
        assert_eq!(layout["sessionOrder"], json!({"d1": ["s1", "s2"]}));
        // Without a known snapshot the structure alone is normalized.
        let structural = normalize_layout(&raw, None);
        assert_eq!(
            structural["sessionOrder"],
            json!({"d1": ["s1", "s2", "gone"], "d2": ["s3"], "gone": ["s4"]})
        );
        assert_eq!(normalize_layout(&json!([]), None), empty_layout());
    }

    #[test]
    fn session_order_for_an_unknown_directory_is_the_404() {
        let known = UiKnown {
            dir_ids: set(&["d1"]),
            session_ids: HashMap::from([("d1".to_string(), set(&["s1"]))]),
        };
        let mut doc = empty_layout();
        assert!(!apply_session_order(
            &mut doc,
            "nope",
            &json!(["s1"]),
            &known
        ));
        assert!(apply_session_order(
            &mut doc,
            "d1",
            &json!(["s1", "s1"]),
            &known
        ));
        assert_eq!(doc["sessionOrder"], json!({"d1": ["s1"]}));
        // Dragging a fleet back to default removes the entry entirely.
        assert!(apply_session_order(&mut doc, "d1", &json!([]), &known));
        assert_eq!(doc["sessionOrder"], json!({}));
    }

    #[test]
    fn dir_order_replacement_keeps_unknown_session_entries() {
        let mut doc = json!({"dirOrder": [], "sessionOrder": {"d1": ["s1"]}, "updatedAt": "old"});
        apply_dir_order(&mut doc, &json!(["b", "a", "zzz"]), &set(&["a", "b"]));
        assert_eq!(doc["dirOrder"], json!(["b", "a"]));
        assert_eq!(doc["sessionOrder"], json!({"d1": ["s1"]}));
        stamp_updated_at(&mut doc, "new");
        assert_eq!(doc["updatedAt"], "new");
    }

    #[test]
    fn the_error_envelope_matches_the_controller() {
        let plain = service_error("invalid", "name and path required", None, None);
        let keys: Vec<&str> = plain
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, vec!["code", "error"]);
        let extra = service_error(
            "invalid",
            "directory has 1 session(s); pass ?force=1 to delete them too",
            Some(&json!({"sessions": ["s1"]})),
            None,
        );
        let keys: Vec<&str> = extra
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, vec!["code", "error", "sessions"]);
        let internal = service_error("internal", "persist failed: x", None, Some("rid"));
        assert_eq!(internal["requestId"], "rid");
        assert_eq!(service_status("not_found"), 404);
        assert_eq!(service_status("invalid"), 400);
        assert_eq!(service_status("internal"), 500);
        assert_eq!(service_status("weird"), 500);
    }

    #[test]
    fn merged_ok_keeps_the_result_key_order() {
        let merged = merge_ok(&json!({"ok": false, "ahead": 2, "pushed": true}));
        let keys: Vec<&str> = merged
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, vec!["ok", "ahead", "pushed"]);
        // The spread wins: `result.ok === false` overwrites, keeping slot 0.
        assert_eq!(merged["ok"], false);
    }
}
