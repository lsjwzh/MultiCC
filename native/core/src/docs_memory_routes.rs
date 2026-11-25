//! Rules kernel for the docs / memory / memo / directory-event route cluster
//! retired from four Node modules:
//!
//! * `src/docs-registry.js` — `GET|POST /api/docs-registry`,
//!   `PATCH|DELETE /api/docs-registry/:id`,
//!   `POST /api/docs-registry/:id/start|stop`,
//!   `GET|HEAD /api/docs-registry/:id/log`
//! * `src/routes/memory-browser.js` — `GET|HEAD /api/memory/graph`,
//!   `GET|HEAD /api/memory/tree`, `GET|HEAD|PUT|DELETE /api/memory/file`
//! * `src/memo/router.js` — `GET|PUT /api/directories/:id/memo`,
//!   `POST /api/directories/:id/memo/send`
//! * `src/notes-store.js` — `GET|HEAD /api/directories/:id/events`
//!
//! Everything that is a *rule* lives here: the docs-registry body sanitizer and
//! its idempotent field order, the relative-URL allowlist, `title`/`url`/`kind`
//! validation, the artifact-id and task-id derivations, the retention sort, the
//! view assembly (including the JS spread key positions), the memory store's
//! `rel` rules and traversal verdict, the file/graph/tree DTO envelopes, the
//! UTF-16 length and token estimate, and the memo request validation.
//!
//! Everything that needs the process-local world stays in Node behind one host
//! port, `POST /api/__host/docs-memory` (`src/routes/docs-memory-host.js`): the
//! registry table and its file, the artifact dependency graph and
//! `servedRoots()`, task-shell title/dir lookups, service spawn/kill/log
//! supervision, the memory-store filesystem and its `realpath` ancestors, the
//! graph/tree directory scans (with their markdown front-matter parser), the
//! memo filesystem and its `runTurn`, and the directory event ring + JSONL.
//!
//! `cleanUrl`'s absolute branch is the one WHATWG-normalization rule that is not
//! portable: the host answers `docs-clean-url` for it (and only for it), and
//! every other URL rule stays here. `Math.random`-shaped doc ids are generated
//! here from a caller-supplied sample so the format stays identical; the
//! differential blanks the random part.
//!
//! Byte-for-byte parity is the contract: the front door serializes through the
//! V8-compatible `js_json_stringify`, so every object built here keeps the key
//! order the retired handlers produced.

use serde_json::{Map, Value};

use crate::js::serde::{js_string, js_to_number, truthy, value_or_empty};
use crate::js::string::{js_trim, utf16_len, utf16_prefix};

/// `MAX_ENTRIES` in `src/docs-registry.js`.
pub const MAX_ENTRIES: usize = 500;
/// `MAX_TITLE`.
pub const MAX_TITLE: usize = 200;
/// `MAX_URL`.
pub const MAX_URL: usize = 1024;
/// `MAX_NOTE`.
pub const MAX_NOTE: usize = 500;
/// `MEMORY_FILE_MAX_CHARS` in `src/routes/memory-browser.js`.
pub const MEMORY_FILE_MAX_CHARS: usize = 200_000;
/// `MEM_GRAPH_MAX_NODES`.
pub const MEM_GRAPH_MAX_NODES: usize = 600;
/// `MEM_TREE_MAX_FILES`.
pub const MEM_TREE_MAX_FILES: usize = 2_000;
/// Shared UTF-8 size limit for the memo controller and its HTTP endpoint.
pub const MEMO_MAX_BYTES: usize = 5 * 1024 * 1024;
/// `WORKTREE_SUBDIR` in `src/docs-registry.js`.
pub const WORKTREE_SUBDIR: &str = ".multicc-worktrees";

const KINDS: [&str; 3] = ["page", "file", "service"];
const BASE36: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";

/// `cleanText(value, max)`: control characters stripped, trimmed, then
/// `String.prototype.slice(0, max)` (UTF-16 code units).
pub fn clean_text(value: Option<&Value>, max: usize) -> String {
    let Some(Value::String(text)) = value else {
        return String::new();
    };
    let stripped: String = text
        .chars()
        .filter(|ch| !matches!(ch, '\u{0000}'..='\u{001f}'))
        .collect();
    utf16_prefix(js_trim(&stripped), max)
}

/// `path.isAbsolute` for the platform the child runs on (`path` follows
/// `process.platform`, so the kernel must too).
pub fn is_absolute(value: &str) -> bool {
    if cfg!(windows) {
        is_windows_absolute(value)
    } else {
        std::path::Path::new(value).is_absolute()
    }
}

// Node's win32 path.isAbsolute also accepts rooted paths without a drive,
// whereas Rust's Windows Path::is_absolute requires both root and prefix.
fn is_windows_absolute(value: &str) -> bool {
    let bytes = value.as_bytes();
    let separator = |byte| matches!(byte, b'/' | b'\\');
    bytes.first().copied().is_some_and(separator)
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && separator(bytes[2]))
}

/// `path.sep`.
fn separator() -> char {
    std::path::MAIN_SEPARATOR
}

/// `normalizeDir`: absolute only, a `.multicc-worktrees` component collapses
/// the path to the project it belongs to, and trailing separators are dropped.
pub fn normalize_dir(value: Option<&Value>) -> Option<String> {
    let Some(Value::String(text)) = value else {
        return None;
    };
    normalize_dir_text(text)
}

/// The string branch of [`normalize_dir`] (also used after `cleanText`).
pub fn normalize_dir_text(text: &str) -> Option<String> {
    let trimmed = js_trim(text);
    if trimmed.is_empty() || !is_absolute(trimmed) {
        return None;
    }
    let separator = separator();
    let parts: Vec<&str> = trimmed.split(separator).collect();
    let worktree = parts
        .iter()
        .position(|part| *part == WORKTREE_SUBDIR)
        .filter(|index| *index > 0);
    let joined = match worktree {
        Some(index) => parts[..index].join(&separator.to_string()),
        None => trimmed.to_string(),
    };
    // The retired code strips forward slashes only, whatever `path.sep` is.
    let stripped = joined.trim_end_matches('/');
    Some(if stripped.is_empty() {
        separator.to_string()
    } else {
        stripped.to_string()
    })
}

/// `path.basename` for the platform (`path.basename('/') === ''`).
pub fn basename_posix(dir: &str) -> String {
    std::path::Path::new(dir)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `cleanUrl`'s root-relative branch: same-origin paths only, and no dot
/// segment that a browser would normalize out of the stored subtree.
pub fn clean_relative_url(url: &str) -> Option<String> {
    if !url.starts_with('/') {
        return None;
    }
    if url
        .split('/')
        .any(|segment| segment == ".." || segment == ".")
    {
        return None;
    }
    let bytes = url.as_bytes();
    let mut index = 1;
    // `^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*`
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'?' {
            break;
        }
        if !is_path_char(byte) {
            return None;
        }
        index += 1;
    }
    // `(?:\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$`
    if index < bytes.len() {
        index += 1; // the '?'
        while index < bytes.len() {
            if !is_query_char(bytes[index]) {
                return None;
            }
            index += 1;
        }
    }
    Some(url.to_string())
}

fn is_path_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'.' | b'_'
                | b'~'
                | b'!'
                | b'$'
                | b'&'
                | b'\''
                | b'('
                | b')'
                | b'*'
                | b'+'
                | b','
                | b';'
                | b'='
                | b':'
                | b'@'
                | b'%'
                | b'/'
                | b'-'
        )
}

fn is_query_char(byte: u8) -> bool {
    is_path_char(byte) || byte == b'?'
}

/// `cleanUrl`'s cheap checks, shared by the host-delegated branch.
fn url_shape_ok(url: &str) -> bool {
    !url.is_empty() && url.len() <= MAX_URL && !url.contains('\r') && !url.contains('\n')
}

/// When `cleanUrl` would call `new URL(url)` (absolute URLs), the front door
/// asks the host for `parsed.href`. Returns the trimmed URL to hand over.
pub fn url_needs_host(value: Option<&Value>) -> Option<String> {
    let Some(Value::String(text)) = value else {
        return None;
    };
    let trimmed = js_trim(text);
    if !url_shape_ok(trimmed) || trimmed.starts_with('/') {
        return None;
    }
    Some(trimmed.to_string())
}

/// The answer the host gave for [`url_needs_host`], or `None` when the URL was
/// resolved synchronously by [`clean_relative_url`].
pub enum ResolvedUrl {
    /// The URL did not need WHATWG normalization; decide it here.
    Inline,
    /// The host ran `new URL()`: `Some(href)` or `None` for "rejected".
    Host(Option<String>),
}

/// The exact `cleanUrl` decision for values that stay in Rust.
fn clean_url_inline(value: Option<&Value>) -> Option<String> {
    let Some(Value::String(text)) = value else {
        return None;
    };
    let trimmed = js_trim(text);
    if !url_shape_ok(trimmed) {
        return None;
    }
    if trimmed.starts_with('/') {
        return clean_relative_url(trimmed);
    }
    None
}

/// `sanitizeIncoming(body, existing)`: start from the stored entry, then set
/// the listed fields in exactly the order the retired function did. Idempotent,
/// so the host never has to sanitize a front-door-built entry again.
pub fn sanitize_incoming(body: &Value, existing: &Value, host_url: ResolvedUrl) -> Value {
    let mut out = match existing {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    let Some(body) = body.as_object() else {
        return Value::Object(out);
    };

    if let Some(kind) = body.get("kind") {
        let chosen = kind
            .as_str()
            .filter(|text| KINDS.contains(text))
            .unwrap_or("page");
        out.insert("kind".into(), Value::String(chosen.to_string()));
    }
    if let Some(title) = body.get("title") {
        out.insert(
            "title".into(),
            Value::String(clean_text(Some(title), MAX_TITLE)),
        );
    }
    if let Some(url_value) = body.get("url") {
        // Only an absolute URL consults the host; a root-relative one is
        // decided here even when the caller supplied a host answer.
        let resolved = match &host_url {
            ResolvedUrl::Host(href) if url_needs_host(Some(url_value)).is_some() => href.clone(),
            _ => clean_url_inline(Some(url_value)),
        };
        if let Some(url) = resolved {
            out.insert("url".into(), Value::String(url));
        }
    }
    if let Some(note) = body.get("note") {
        out.insert(
            "note".into(),
            Value::String(clean_text(Some(note), MAX_NOTE)),
        );
    }
    if let Some(session) = body.get("sessionId") {
        out.insert(
            "sessionId".into(),
            Value::String(clean_text(Some(session), 128)),
        );
    }
    if let Some(Value::Array(items)) = body.get("relatedArtifactIds") {
        let mut seen: Vec<String> = Vec::new();
        for item in items {
            let Some(text) = item.as_str() else { continue };
            if !valid_artifact_id(text) {
                continue;
            }
            if !seen.iter().any(|kept| kept == text) {
                seen.push(text.to_string());
            }
        }
        out.insert(
            "relatedArtifactIds".into(),
            Value::Array(seen.into_iter().map(Value::String).collect()),
        );
    }
    if let Some(task) = body.get("taskId") {
        out.insert("taskId".into(), Value::String(clean_text(Some(task), 160)));
    }
    if let Some(source) = body.get("source") {
        let text = clean_text(Some(source), 32);
        out.insert(
            "source".into(),
            Value::String(if text.is_empty() {
                "agent".to_string()
            } else {
                text
            }),
        );
    }
    if let Some(pinned) = body.get("pinned") {
        out.insert("pinned".into(), Value::Bool(pinned == &Value::Bool(true)));
    }
    if let Some(permanent) = body.get("permanent") {
        out.insert(
            "permanent".into(),
            Value::Bool(permanent == &Value::Bool(true)),
        );
    }
    if let Some(dir) = body.get("dir") {
        if let Some(normalized) = normalize_dir_text(&clean_text(Some(dir), 500)) {
            out.insert("dir".into(), Value::String(normalized));
        }
    }
    if let Some(port) = body.get("port") {
        let number = js_to_number(port);
        if number.fract() == 0.0 && (1.0..=65535.0).contains(&number) {
            out.insert("port".into(), Value::from(number as i64));
        }
    }
    if let Some(command) = body.get("startCmd") {
        out.insert(
            "startCmd".into(),
            Value::String(clean_text(Some(command), 500)),
        );
    }
    if let Some(cwd) = body.get("cwd") {
        let text = clean_text(Some(cwd), 500);
        if is_absolute(&text) {
            out.insert("cwd".into(), Value::String(text));
        }
    }
    Value::Object(out)
}

/// `validate(entry)`: the refusal strings are the retired route bodies.
pub fn validate_entry(entry: &Value) -> Option<String> {
    if !truthy(entry.get("title").unwrap_or(&Value::Null)) {
        return Some("title is required".to_string());
    }
    if !truthy(entry.get("url").unwrap_or(&Value::Null)) {
        return Some("a valid http(s) or root-relative url is required".to_string());
    }
    let kind = entry.get("kind").and_then(Value::as_str).unwrap_or("");
    if !KINDS.contains(&kind) {
        return Some(format!("kind must be one of {}", KINDS.join("/")));
    }
    None
}

/// `isArtifactId`, shared with `crate::artifact_reference::is_artifact_id`.
pub fn valid_artifact_id(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 128
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// `artifactIdFromUrl`: `^/artifacts/([A-Za-z0-9_-]+)(?:[/?#]|$)`.
pub fn artifact_id_from_url(url: Option<&str>) -> Option<String> {
    let url = url?;
    let rest = url.strip_prefix("/artifacts/")?;
    let end = rest
        .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'))
        .unwrap_or(rest.len());
    let id = &rest[..end];
    if !valid_artifact_id(id) {
        return None;
    }
    let tail = &rest[end..];
    if tail.is_empty() {
        return Some(id.to_string());
    }
    let next = tail.as_bytes()[0];
    if next == b'/' || next == b'?' || next == b'#' {
        Some(id.to_string())
    } else {
        None
    }
}

/// `entry.taskId || (/^task-([a-f0-9]{32})$/.test(entry.sessionId) ? ... : null)`.
pub fn task_id_for(entry: &Value) -> Option<Value> {
    if let Some(task) = entry.get("taskId") {
        if truthy(task) {
            return Some(task.clone());
        }
    }
    let session = entry.get("sessionId").and_then(Value::as_str).unwrap_or("");
    let rest = session.strip_prefix("task-")?;
    if rest.len() == 32
        && rest
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Some(Value::String(format!("tsk_{rest}")));
    }
    None
}

/// The host facts a view needs: `dirOf`'s Map lookup, the task title, whether
/// the artifact is still served, and permanent-retention membership.
#[derive(Clone, Debug)]
pub struct ViewFacts {
    /// `normalizeDir(resolveDir(entry.sessionId))` from the host.
    pub session_dir: Option<String>,
    /// `resolveTaskTitle(taskId)`.
    pub task_title: Value,
    /// `artifactExists(artifactId)`, when an artifact id exists.
    pub exists: Option<bool>,
    /// `retained.has(artifactId)`.
    pub retained: bool,
}

impl Default for ViewFacts {
    fn default() -> Self {
        Self {
            session_dir: None,
            task_title: Value::Null,
            exists: None,
            retained: false,
        }
    }
}

/// `toView(entry, artifactExists, dirOf, retained, taskTitle)`, including the
/// JS spread/key-order behavior: a key the entry already carried keeps its
/// position instead of moving to the end.
pub fn view(entry: &Value, facts: &ViewFacts) -> Value {
    let mut out = match entry {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    // `entry.artifactId || artifactIdFromUrl(entry.url)` keeps a truthy stored
    // value as-is (legacy rows may hold a non-string).
    let artifact_id = entry
        .get("artifactId")
        .filter(|value| truthy(value))
        .cloned()
        .or_else(|| {
            artifact_id_from_url(entry.get("url").and_then(Value::as_str)).map(Value::String)
        });
    let dir = normalize_dir(entry.get("dir"))
        .or_else(|| normalize_dir(entry.get("cwd")))
        .or_else(|| facts.session_dir.clone());
    let task_id = task_id_for(entry);
    out.insert(
        "artifactId".into(),
        artifact_id.clone().unwrap_or(Value::Null),
    );
    out.insert("taskId".into(), task_id.clone().unwrap_or(Value::Null));
    out.insert(
        "taskTitle".into(),
        if task_id.is_some() {
            facts.task_title.clone()
        } else {
            Value::Null
        },
    );
    out.insert("retained".into(), Value::Bool(facts.retained));
    out.insert(
        "permanent".into(),
        Value::Bool(entry.get("permanent") == Some(&Value::Bool(true))),
    );
    out.insert(
        "dir".into(),
        dir.clone().map(Value::String).unwrap_or(Value::Null),
    );
    out.insert(
        "dirName".into(),
        Value::String(dir.as_deref().map(basename_posix).unwrap_or_default()),
    );
    if artifact_id.is_some() {
        if let Some(exists) = facts.exists {
            out.insert("expired".into(), Value::Bool(!exists));
        }
    }
    Value::Object(out)
}

fn rank(entry: &Value) -> i64 {
    if entry.get("permanent") == Some(&Value::Bool(true)) {
        2
    } else if entry.get("pinned") == Some(&Value::Bool(true)) {
        1
    } else {
        0
    }
}

/// `byRetention`: rank descending, then `String(b.createdAt).localeCompare(...)`.
pub fn sort_views(views: &mut [Value]) {
    views.sort_by(|left, right| {
        let rank_order = rank(right).cmp(&rank(left));
        if rank_order != std::cmp::Ordering::Equal {
            return rank_order;
        }
        let left_at = js_string(left.get("createdAt").unwrap_or(&Value::Null));
        let right_at = js_string(right.get("createdAt").unwrap_or(&Value::Null));
        right_at.cmp(&left_at)
    });
}

/// `uid()`: `'doc_' + Math.random().toString(36).slice(2, 10) +
/// Date.now().toString(36).slice(-4)`. `sample` is the `Math.random()` draw.
pub fn doc_id(now_ms: i64, sample: f64) -> String {
    let mut fraction = sample.abs().fract();
    let mut out = String::from("doc_");
    for _ in 0..8 {
        fraction *= 36.0;
        let digit = fraction.floor();
        let index = (digit as i64).clamp(0, 35) as usize;
        out.push(BASE36[index] as char);
        fraction -= digit;
    }
    let stamp = base36(now_ms.max(0) as u64);
    let tail: String = stamp
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<char>>()
        .into_iter()
        .rev()
        .collect();
    out.push_str(&tail);
    out
}

fn base36(mut value: u64) -> String {
    if value == 0 {
        return "0".to_string();
    }
    let mut digits = Vec::new();
    while value > 0 {
        digits.push(BASE36[(value % 36) as usize] as char);
        value /= 36;
    }
    digits.into_iter().rev().collect()
}

/// `new Date(now).toISOString()`.
pub fn iso_time(now_ms: i64) -> String {
    crate::js::date_to_iso_string(now_ms as f64).unwrap_or_default()
}

/// `estimateMemTokens` in `src/routes/memory-browser.js`.
pub fn estimate_mem_tokens(text: &str) -> i64 {
    if text.is_empty() {
        return 0;
    }
    let mut cjk = 0i64;
    for ch in text.chars() {
        let code = ch as u32;
        if (0x3400..=0x4DBF).contains(&code)
            || (0x4E00..=0x9FFF).contains(&code)
            || (0xF900..=0xFAFF).contains(&code)
            || (0x3040..=0x309F).contains(&code)
            || (0x30A0..=0x30FF).contains(&code)
            || (0xAC00..=0xD7AF).contains(&code)
        {
            cjk += 1;
        }
    }
    let total = utf16_len(text) as i64;
    let other = total - cjk;
    let value = (cjk as f64) * 1.5 + (other as f64) / 4.0;
    (value.round() as i64).max(1)
}

/// `resolveMemoryFilePath`'s lexical half: the shape `rel` must have before any
/// filesystem call. `%2e%2e` arrives decoded as `..` and is rejected here.
pub fn memory_rel_valid(rel: &str) -> bool {
    if rel.is_empty() {
        return false;
    }
    let lower = rel.to_ascii_lowercase();
    if !lower.ends_with(".md") {
        return false;
    }
    rel.split('/').all(|segment| {
        !segment.is_empty()
            && segment != "."
            && segment != ".."
            && !segment.contains('\\')
            && !segment.contains('\0')
    })
}

/// `isInside(base, candidate)`: equality or a real child (`base + path.sep`).
pub fn is_inside(base: &str, candidate: &str) -> bool {
    candidate == base || candidate.starts_with(&format!("{base}{}", separator()))
}

/// `storeRealRoot && isInside(storeRealRoot, realpath(cursor))`.
pub fn ancestor_inside_root(store_real_root: Option<&str>, ancestor_real: Option<&str>) -> bool {
    match (store_real_root, ancestor_real) {
        (Some(root), Some(ancestor)) => is_inside(root, ancestor),
        _ => false,
    }
}

/// The filesystem facts `resolveMemoryFilePath` needs from the host. The
/// lexical shape is decided by [`memory_rel_valid`]; the containment verdict
/// and the realpath ancestor check stay here.
#[derive(Clone, Debug, Default)]
pub struct MemoryPathFacts {
    /// `path.resolve(deps.memoryStoreRoot)`.
    pub root: String,
    /// `path.resolve(root, rel)`.
    pub resolved: String,
    /// `realpathSync(root)`, or `None` when the store root does not exist.
    pub real_root: Option<String>,
    /// `realpathSync(cursor)` for the first existing ancestor of `resolved`;
    /// `None` when the walk left the store root or realpath threw.
    pub existing_ancestor_real: Option<String>,
    /// `fs.existsSync(resolved)`.
    pub exists: bool,
    /// `fs.existsSync(path.dirname(resolved))`.
    pub parent_exists: bool,
    /// `path.basename(resolved)`.
    pub name: String,
}

/// `resolveMemoryFilePath(rel)` — the security verdict, byte for byte.
pub fn memory_path_valid(rel: &str, facts: &MemoryPathFacts) -> bool {
    if !memory_rel_valid(rel) {
        return false;
    }
    if !is_inside(&facts.root, &facts.resolved) || facts.resolved == facts.root {
        return false;
    }
    ancestor_inside_root(
        facts.real_root.as_deref(),
        facts.existing_ancestor_real.as_deref(),
    )
}

/// `GET /api/memory/graph`'s envelope over the host's scan result.
pub fn graph_envelope(dir_id: &str, data: &Value, duration_ms: i64, max_nodes: usize) -> Value {
    let nodes = data
        .get("nodes")
        .cloned()
        .unwrap_or(Value::Array(Vec::new()));
    let edges = data
        .get("edges")
        .cloned()
        .unwrap_or(Value::Array(Vec::new()));
    let projects = data
        .get("projects")
        .cloned()
        .unwrap_or(Value::Array(Vec::new()));
    let node_count = nodes.as_array().map(Vec::len).unwrap_or(0);
    let edge_count = edges.as_array().map(Vec::len).unwrap_or(0);
    let mut meta = Map::new();
    meta.insert("dirId".into(), Value::String(dir_id.to_string()));
    meta.insert("projects".into(), projects);
    meta.insert("nodeCount".into(), Value::from(node_count));
    meta.insert("edgeCount".into(), Value::from(edge_count));
    meta.insert(
        "truncated".into(),
        Value::Bool(data.get("truncated") == Some(&Value::Bool(true))),
    );
    meta.insert("maxNodes".into(), Value::from(max_nodes));
    meta.insert("durationMs".into(), Value::from(duration_ms));
    let mut body = Map::new();
    body.insert("nodes".into(), nodes);
    body.insert("edges".into(), edges);
    body.insert("meta".into(), Value::Object(meta));
    Value::Object(body)
}

/// `GET /api/memory/tree`: `data.meta.durationMs = deps.now() - startedAt`
/// runs after the host built the object, so the key is appended last.
pub fn tree_with_duration(mut data: Value, duration_ms: i64) -> Value {
    if let Value::Object(ref mut object) = data {
        let meta = object
            .entry("meta")
            .or_insert_with(|| Value::Object(Map::new()));
        if let Value::Object(ref mut meta_object) = meta {
            meta_object.insert("durationMs".into(), Value::from(duration_ms));
        }
    }
    data
}

/// `GET /api/memory/file`'s 200 body.
pub fn memory_file_dto(rel: &str, abs: &str, content: &str, mtime: Value) -> Value {
    let mut body = Map::new();
    body.insert("rel".into(), Value::String(rel.to_string()));
    body.insert("path".into(), Value::String(abs.to_string()));
    body.insert("name".into(), Value::String(basename_posix(abs)));
    body.insert("content".into(), Value::String(content.to_string()));
    body.insert("size".into(), Value::from(content.len()));
    body.insert("tokens".into(), Value::from(estimate_mem_tokens(content)));
    body.insert("mtime".into(), mtime);
    Value::Object(body)
}

/// `PUT /api/memory/file`'s 200 body.
pub fn memory_write_dto(rel: &str, abs: &str, content: &str, mtime: Value) -> Value {
    let mut body = Map::new();
    body.insert("ok".into(), Value::Bool(true));
    body.insert("rel".into(), Value::String(rel.to_string()));
    body.insert("path".into(), Value::String(abs.to_string()));
    body.insert("size".into(), Value::from(content.len()));
    body.insert("tokens".into(), Value::from(estimate_mem_tokens(content)));
    body.insert("mtime".into(), mtime);
    Value::Object(body)
}

/// `String.prototype.slice(0, max)` on a JS string value (memo bodies).
pub fn body_text(value: Option<&Value>) -> String {
    value_or_empty(value)
}

/// `String(rawText || '').trim()`.
pub fn trimmed_text(value: Option<&Value>) -> String {
    let text = body_text(value);
    js_trim(&text).to_string()
}

#[cfg(test)]
mod tests;
