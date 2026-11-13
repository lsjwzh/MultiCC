//! Pre-resume size guards for native CLI sessions (`codex`, `codex-exp`,
//! `zcode`, `kimi`, `codebuddy`, `qoder`, `dsh`).
//!
//! This is the Rust owner of what used to be `src/chat/codex-rollout-guard.js`
//! and `src/chat/native-session-guard.js`. Both modules were pure filesystem
//! readers: a native session store is append-only and grows without bound while
//! the vendor's own compaction only governs the request payload, never the file,
//! so an oversized rollout makes `resume <id>` wedge before the first upstream
//! request. The guards locate the file(s) backing a persisted native session id,
//! and when the total exceeds a budget they move them into a sibling archive
//! directory (never delete) so the caller can drop the native id and rebuild.
//!
//! The JS facades only adapt host-owned inputs (the injectable per-session home
//! callbacks, the `prepareCodexSessionHome` migration hook, the environment and
//! the logger); every path derivation, walk, size check, archive move, TTL
//! sweep and return shape lives here.
//!
//! Two behaviours are deliberately frozen exactly as the Node code had them:
//!
//! 1. Vendor matching uses Node/libuv's filename order with a LIFO directory
//!    stack. Raw filesystem order must not change bounded scan results or the
//!    winner of an archive-name collision. Cleanup arrays retain walk order.
//! 2. Legacy edge cases are reproduced, not fixed: the codex sweep skips
//!    directories and symlinks while the vendor sweep deletes archived
//!    directories and counts a symlink's target size; a failed vendor unlink
//!    still adds `freedBytes`; the `STORES[cli]` prototype lookup lets names
//!    such as `constructor` through to `not_found`; and the vendor archive name
//!    is UTF-16-sliced at 32 code units, which may split a surrogate pair.
use crate::js::{coerce, contains_units, JsString, JsValue};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(any(windows, test))]
#[path = "native_session_guard/windows_path.rs"]
mod windows_path;

pub const CODEX_DEFAULT_MAX_BYTES: f64 = 10.0 * 1024.0 * 1024.0;
pub const NATIVE_DEFAULT_MAX_BYTES: f64 = 10.0 * 1024.0 * 1024.0;
pub const CODEX_ARCHIVE_DIRNAME: &str = "multicc-archived-rollouts";
pub const NATIVE_ARCHIVE_DIRNAME: &str = "multicc-archived-sessions";
pub const DEFAULT_ARCHIVE_TTL_DAYS: f64 = 30.0;
const SWEEP_INTERVAL_MS: f64 = 6.0 * 60.0 * 60.0 * 1000.0;
const MAX_SCAN_ENTRIES: f64 = 100_000.0;
const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// Own enumerable-looking members of `Object.prototype`. `STORES[cli]` is a
/// plain property read, so these names return a truthy value even though they
/// are not guarded stores; the legacy guard then walked no roots and answered
/// `not_found` instead of `skipped`.
const OBJECT_PROTO_NAMES: [&str; 12] = [
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
];

#[derive(Clone, Debug)]
pub struct LogRecord {
    pub level: &'static str,
    pub name: &'static str,
    pub fields: JsValue,
}

/// One guard call: the JavaScript result plus the logger calls it would have
/// made. The facade replays `logs` through the injected logger so observability
/// stays identical to the Node implementation without making the kernel
/// dependent on a host logger object.
#[derive(Clone, Debug)]
pub struct Outcome {
    pub value: JsValue,
    pub logs: Vec<LogRecord>,
}

impl Outcome {
    fn plain(value: JsValue) -> Self {
        Self {
            value,
            logs: Vec::new(),
        }
    }
}

enum Enforced {
    Value(JsValue),
    Archived(JsValue),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum StoreKind {
    Files,
    Dirs,
}

enum StoreLookup {
    Real(StoreKind),
    /// `STORES[cli]` resolved to an `Object.prototype` member: truthy, no store.
    Phantom,
    Missing,
}

// ── JavaScript value helpers ────────────────────────────────────────────────

fn field<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    value.get(name)
}

fn truthy_field(value: &JsValue, name: &str) -> bool {
    field(value, name).is_some_and(coerce::truthy)
}

fn text_field(value: &JsValue, name: &str) -> Option<String> {
    field(value, name).map(|item| coerce::js_to_string(item).to_string_lossy())
}

fn number_field(value: &JsValue, name: &str, default: f64) -> f64 {
    match field(value, name) {
        None | Some(JsValue::Undefined) => default,
        Some(item) => coerce::js_to_number(item),
    }
}

fn positive_bytes(value: f64, fallback: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        fallback
    }
}

fn archive_ttl_ms(value: f64, fallback_days: f64) -> f64 {
    if !value.is_finite() {
        fallback_days * DAY_MS
    } else if value <= 0.0 {
        0.0
    } else {
        value * DAY_MS
    }
}

fn num(value: f64) -> JsValue {
    JsValue::Number(value)
}

fn text(value: &str) -> JsValue {
    JsValue::string(value)
}

#[cfg(test)]
fn undefined() -> JsValue {
    JsValue::Undefined
}

fn object(entries: Vec<(&str, JsValue)>) -> JsValue {
    JsValue::object(entries)
}

fn skipped() -> JsValue {
    object(vec![("action", text("skipped"))])
}

fn not_found(max_bytes: f64) -> JsValue {
    object(vec![
        ("action", text("not_found")),
        ("maxBytes", num(max_bytes)),
    ])
}

fn within_budget(max_bytes: f64, total_bytes: f64, files: usize) -> JsValue {
    object(vec![
        ("action", text("ok")),
        ("maxBytes", num(max_bytes)),
        ("totalBytes", num(total_bytes)),
        ("files", num(files as f64)),
    ])
}

fn archived_value(
    max_bytes: f64,
    total_bytes: f64,
    files: usize,
    cli_session_id: JsValue,
    archived: Vec<JsValue>,
) -> JsValue {
    object(vec![
        ("action", text("archived")),
        ("maxBytes", num(max_bytes)),
        ("totalBytes", num(total_bytes)),
        ("files", num(files as f64)),
        ("cliSessionId", cli_session_id),
        ("archived", JsValue::Array(archived)),
    ])
}

fn sweep_value(deleted: Vec<JsValue>, freed_bytes: f64) -> JsValue {
    object(vec![
        ("deleted", JsValue::Array(deleted)),
        ("freedBytes", num(freed_bytes)),
    ])
}

fn skipped_sweep(reason: &str) -> JsValue {
    object(vec![
        ("deleted", JsValue::Array(Vec::new())),
        ("freedBytes", num(0.0)),
        (reason, JsValue::Bool(true)),
    ])
}

struct RecordView<'a> {
    cli: Option<&'a JsValue>,
    cli_session_id: Option<&'a JsValue>,
    provider: Option<&'a JsValue>,
    id: Option<&'a JsValue>,
}

impl<'a> RecordView<'a> {
    fn new(value: &'a JsValue) -> Self {
        if matches!(value, JsValue::Object(_)) {
            Self {
                cli: value.get("cli"),
                cli_session_id: value.get("cliSessionId"),
                provider: value.get("provider"),
                id: value.get("id"),
            }
        } else {
            Self {
                cli: None,
                cli_session_id: None,
                provider: None,
                id: None,
            }
        }
    }

    fn id_value(&self) -> JsValue {
        self.id.cloned().unwrap_or(JsValue::Undefined)
    }

    fn cli_value(&self) -> JsValue {
        self.cli.cloned().unwrap_or(JsValue::Undefined)
    }

    fn provider_truthy(&self) -> bool {
        self.provider.is_some_and(coerce::truthy)
    }

    fn session_id_truthy(&self) -> bool {
        self.cli_session_id.is_some_and(coerce::truthy)
    }
}

// ── Node `path` compatibility ────────────────────────────────────────────────
//
// The legacy guards built every path with `path.join`, which normalizes `.`,
// `..` and repeated separators. Inputs such as an arbitrary provider id reach
// these joins, so the normalization is part of the observable behavior.

fn normalize_posix(path: &str) -> String {
    let is_absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut out: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => match out.last().copied() {
                Some("..") => {
                    if !is_absolute {
                        out.push("..");
                    }
                }
                Some(_) => {
                    out.pop();
                }
                None => {
                    if !is_absolute {
                        out.push("..");
                    }
                }
            },
            other => out.push(other),
        }
    }
    let mut result = out.join("/");
    if is_absolute {
        result = format!("/{result}");
    }
    if result.is_empty() {
        return if is_absolute {
            "/".to_string()
        } else if trailing {
            "./".to_string()
        } else {
            ".".to_string()
        };
    }
    if trailing && !result.ends_with('/') {
        result.push('/');
    }
    result
}

fn node_join(parts: &[&str]) -> String {
    let present: Vec<&str> = parts
        .iter()
        .copied()
        .filter(|part| !part.is_empty())
        .collect();
    if present.is_empty() {
        return ".".to_string();
    }
    normalize_posix(&present.join("/"))
}

#[cfg(windows)]
fn path_dirname(path: &str) -> String {
    windows_path::dirname(path)
}

#[cfg(not(windows))]
fn path_dirname(path: &str) -> String {
    path_dirname_posix(path)
}

#[cfg(any(not(windows), test))]
fn path_dirname_posix(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let has_root = path.starts_with('/');
    let bytes = path.as_bytes();
    let mut end: isize = -1;
    let mut matched_slash = true;
    let mut index = bytes.len() as isize - 1;
    while index >= 1 {
        if bytes[index as usize] == b'/' {
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
        return if has_root {
            "/".to_string()
        } else {
            ".".to_string()
        };
    }
    if has_root && end == 1 {
        return "//".to_string();
    }
    path[..end as usize].to_string()
}

fn path_basename(path: &str) -> String {
    if path.is_empty() {
        return String::new();
    }
    let bytes = path.as_bytes();
    let mut start = 0usize;
    let mut end: isize = -1;
    let mut matched_slash = true;
    for index in (0..bytes.len()).rev() {
        if bytes[index] == b'/' {
            if !matched_slash {
                start = index + 1;
                break;
            }
        } else if end == -1 {
            matched_slash = false;
            end = index as isize + 1;
        }
    }
    if end == -1 {
        return String::new();
    }
    path[start..end as usize].to_string()
}

fn split_units(units: &[u16], separator: u16) -> Vec<&[u16]> {
    let mut parts = Vec::new();
    let mut start = 0usize;
    for (index, unit) in units.iter().enumerate() {
        if *unit == separator {
            parts.push(&units[start..index]);
            start = index + 1;
        }
    }
    parts.push(&units[start..]);
    parts
}

fn normalize_posix_units(units: &[u16]) -> JsString {
    let is_absolute = units.first() == Some(&47);
    let trailing = units.last() == Some(&47);
    let mut out: Vec<Vec<u16>> = Vec::new();
    for segment in split_units(units, 47) {
        if segment.is_empty() || segment == [46] {
            continue;
        }
        if segment == [46, 46] {
            match out.last() {
                Some(last) if last.as_slice() == [46, 46] => {
                    if !is_absolute {
                        out.push(segment.to_vec());
                    }
                }
                Some(_) => {
                    out.pop();
                }
                None => {
                    if !is_absolute {
                        out.push(segment.to_vec());
                    }
                }
            }
            continue;
        }
        out.push(segment.to_vec());
    }
    let mut flat: Vec<u16> = Vec::new();
    for (index, segment) in out.iter().enumerate() {
        if index > 0 {
            flat.push(47);
        }
        flat.extend_from_slice(segment);
    }
    if is_absolute {
        let mut rooted = vec![47u16];
        rooted.extend(flat);
        flat = rooted;
    }
    if flat.is_empty() {
        return JsString::from_rust_str(if is_absolute {
            "/"
        } else if trailing {
            "./"
        } else {
            "."
        });
    }
    if trailing && flat.last() != Some(&47) {
        flat.push(47);
    }
    JsString::from_units(flat)
}

fn node_join_units(parts: &[JsString]) -> JsString {
    let present: Vec<&JsString> = parts.iter().filter(|part| !part.is_empty()).collect();
    if present.is_empty() {
        return JsString::from_rust_str(".");
    }
    let mut joined: Vec<u16> = Vec::new();
    for (index, part) in present.iter().enumerate() {
        if index > 0 {
            joined.push(47);
        }
        joined.extend_from_slice(part.as_units());
    }
    normalize_posix_units(&joined)
}

// ── filesystem helpers ──────────────────────────────────────────────────────

fn exists(path: &str) -> bool {
    Path::new(path).exists()
}

fn mtime_ms(metadata: &fs::Metadata) -> f64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

pub fn system_now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn size_of(path: &str, is_dir: bool) -> f64 {
    if !is_dir {
        return fs::metadata(path)
            .map(|metadata| metadata.len() as f64)
            .unwrap_or(0.0);
    }
    let mut total = 0.0;
    let mut stack = vec![path.to_string()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            let full = node_join(&[&dir, &name]);
            if file_type.is_dir() {
                stack.push(full);
            } else {
                total += fs::metadata(&full)
                    .map(|metadata| metadata.len() as f64)
                    .unwrap_or(0.0);
            }
        }
    }
    total
}

fn list_subdirs(dir: &str) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            let name = entry.file_name().to_string_lossy().into_owned();
            dirs.push(node_join(&[dir, &name]));
        }
    }
    dirs
}

fn move_tree(from: &str, to: &str) -> Result<(), String> {
    let parent = path_dirname(to);
    fs::create_dir_all(&parent).map_err(|error| error.to_string())?;
    fs::rename(from, to).map_err(|error| error.to_string())
}

// ── option decoding ─────────────────────────────────────────────────────────

pub struct CodexOptions {
    pub home_dir: String,
    pub codex_homes_dir: String,
    pub codex_session_homes_dir: String,
    pub max_bytes: f64,
    pub archive_ttl_ms: f64,
}

impl CodexOptions {
    pub fn from_js(value: &JsValue) -> Self {
        let home_dir = text_field(value, "homeDir").unwrap_or_default();
        let codex_homes_dir = if truthy_field(value, "codexHomesDir") {
            text_field(value, "codexHomesDir").unwrap_or_default()
        } else {
            node_join(&[&home_dir, ".multicc", "codex-homes"])
        };
        let codex_session_homes_dir = if truthy_field(value, "codexSessionHomesDir") {
            text_field(value, "codexSessionHomesDir").unwrap_or_default()
        } else {
            node_join(&[&home_dir, ".multicc", "codex-session-homes"])
        };
        let max_bytes = positive_bytes(
            number_field(value, "maxBytes", CODEX_DEFAULT_MAX_BYTES),
            CODEX_DEFAULT_MAX_BYTES,
        );
        let archive_ttl_ms = archive_ttl_ms(
            number_field(value, "archiveTtlDays", DEFAULT_ARCHIVE_TTL_DAYS),
            DEFAULT_ARCHIVE_TTL_DAYS,
        );
        Self {
            home_dir,
            codex_homes_dir,
            codex_session_homes_dir,
            max_bytes,
            archive_ttl_ms,
        }
    }
}

pub struct NativeOptions {
    pub home_dir: String,
    pub kimi_code_home: String,
    pub zcode_homes_dir: String,
    pub kimi_homes_dir: String,
    pub max_bytes: f64,
    pub archive_ttl_ms: f64,
}

impl NativeOptions {
    pub fn from_js(value: &JsValue) -> Self {
        let home_dir = text_field(value, "homeDir").unwrap_or_default();
        let kimi_code_home = if truthy_field(value, "kimiCodeHome") {
            text_field(value, "kimiCodeHome").unwrap_or_default()
        } else {
            node_join(&[&home_dir, ".kimi-code"])
        };
        let zcode_homes_dir = if truthy_field(value, "zcodeHomesDir") {
            text_field(value, "zcodeHomesDir").unwrap_or_default()
        } else {
            node_join(&[&home_dir, ".multicc", "zcode-homes"])
        };
        let kimi_homes_dir = if truthy_field(value, "kimiHomesDir") {
            text_field(value, "kimiHomesDir").unwrap_or_default()
        } else {
            node_join(&[&home_dir, ".multicc", "kimi-homes"])
        };
        let max_bytes = positive_bytes(
            number_field(value, "maxBytes", NATIVE_DEFAULT_MAX_BYTES),
            NATIVE_DEFAULT_MAX_BYTES,
        );
        let archive_ttl_ms = archive_ttl_ms(
            number_field(value, "archiveTtlDays", DEFAULT_ARCHIVE_TTL_DAYS),
            DEFAULT_ARCHIVE_TTL_DAYS,
        );
        Self {
            home_dir,
            kimi_code_home,
            zcode_homes_dir,
            kimi_homes_dir,
            max_bytes,
            archive_ttl_ms,
        }
    }
}

// ── codex rollout guard ─────────────────────────────────────────────────────

pub struct CodexRolloutGuard {
    options: CodexOptions,
    last_sweep_at: f64,
}

fn find_rollouts(sessions_dir: &str, id: &JsString) -> Result<Vec<String>, String> {
    if !exists(sessions_dir) {
        return Ok(Vec::new());
    }
    let mut found = Vec::new();
    let mut stack = vec![sessions_dir.to_string()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            let full = node_join(&[&dir, &name]);
            if file_type.is_dir() {
                stack.push(full);
            } else if file_type.is_file()
                && contains_units(JsString::from_rust_str(&name).as_units(), id.as_units())
                && name.ends_with(".jsonl")
            {
                found.push(full);
            }
        }
    }
    Ok(found)
}

fn archive_rollout(file: &str, sessions_dir: &str) -> Result<String, String> {
    let archive_dir = node_join(&[&path_dirname(sessions_dir), CODEX_ARCHIVE_DIRNAME]);
    fs::create_dir_all(&archive_dir).map_err(|error| error.to_string())?;
    let target = node_join(&[&archive_dir, &path_basename(file)]);
    fs::rename(file, &target).map_err(|error| error.to_string())?;
    Ok(target)
}

impl CodexRolloutGuard {
    pub fn new(options: CodexOptions) -> Self {
        Self {
            options,
            last_sweep_at: 0.0,
        }
    }

    pub fn max_bytes(&self) -> f64 {
        self.options.max_bytes
    }

    pub fn archive_ttl_ms(&self) -> f64 {
        self.options.archive_ttl_ms
    }

    fn candidate_archive_dirs(&self) -> Vec<String> {
        let mut homes = vec![node_join(&[&self.options.home_dir, ".codex"])];
        homes.extend(list_subdirs(&self.options.codex_homes_dir));
        homes.extend(list_subdirs(&self.options.codex_session_homes_dir));
        homes
            .iter()
            .map(|home| node_join(&[home, CODEX_ARCHIVE_DIRNAME]))
            .collect()
    }

    fn enforce_files(
        &self,
        record: &RecordView<'_>,
        prepared: &JsValue,
        force: bool,
    ) -> Result<Enforced, String> {
        let id = coerce::js_to_string(record.cli_session_id.unwrap());
        let sessions_dir = match field(prepared, "sessionsDir")
            .filter(|value| coerce::truthy(value))
        {
            Some(value) => coerce::js_to_string(value).to_string_lossy(),
            None => {
                let codex_home = match field(prepared, "codexHome")
                    .filter(|value| coerce::truthy(value))
                {
                    Some(value) => coerce::js_to_string(value).to_string_lossy(),
                    None => {
                        if record.provider_truthy() {
                            let provider = coerce::js_to_string(record.provider.unwrap());
                            node_join(&[&self.options.codex_homes_dir, &provider.to_string_lossy()])
                        } else {
                            node_join(&[&self.options.home_dir, ".codex"])
                        }
                    }
                };
                node_join(&[&codex_home, "sessions"])
            }
        };
        let files = find_rollouts(&sessions_dir, &id)?;
        if files.is_empty() {
            return Ok(Enforced::Value(not_found(self.options.max_bytes)));
        }
        let mut archived = Vec::new();
        let mut total_bytes = 0.0;
        for file in &files {
            let size_bytes = fs::metadata(file)
                .map(|metadata| metadata.len() as f64)
                .unwrap_or(0.0);
            total_bytes += size_bytes;
            if force || size_bytes > self.options.max_bytes {
                let target = archive_rollout(file, &sessions_dir)?;
                archived.push(object(vec![
                    ("file", text(file)),
                    ("sizeBytes", num(size_bytes)),
                    ("archivedTo", text(&target)),
                ]));
            }
        }
        if archived.is_empty() {
            return Ok(Enforced::Value(within_budget(
                self.options.max_bytes,
                total_bytes,
                files.len(),
            )));
        }
        Ok(Enforced::Archived(archived_value(
            self.options.max_bytes,
            total_bytes,
            files.len(),
            JsValue::String(id),
            archived,
        )))
    }

    pub fn enforce(
        &mut self,
        record: &JsValue,
        force: bool,
        prepared: &JsValue,
        now_ms: f64,
    ) -> Outcome {
        let view = RecordView::new(record);
        let is_codex = match view.cli {
            Some(JsValue::String(value)) => {
                let text = value.to_string_lossy();
                text == "codex" || text == "codex-exp"
            }
            _ => false,
        };
        if !is_codex || !view.session_id_truthy() {
            return Outcome::plain(skipped());
        }
        if let Some(JsValue::String(code)) = field(prepared, "errorCode") {
            let code = code.to_string_lossy();
            let message = text_field(prepared, "errorMessage").unwrap_or_default();
            if code == "CODEX_SESSION_ROLLOUT_NOT_FOUND" {
                return Outcome::plain(not_found(self.options.max_bytes));
            }
            if code.starts_with("CODEX_SESSION_") {
                let fields = object(vec![("sessionId", view.id_value()), ("code", text(&code))]);
                let value = object(vec![
                    ("action", text("blocked")),
                    ("code", text(&code)),
                    ("error", text(&message)),
                ]);
                return Outcome {
                    value,
                    logs: vec![LogRecord {
                        level: "warn",
                        name: "codex_rollout_guard_blocked",
                        fields,
                    }],
                };
            }
            let fields = object(vec![
                ("sessionId", view.id_value()),
                ("error", text(&message)),
            ]);
            let value = object(vec![("action", text("error")), ("error", text(&message))]);
            return Outcome {
                value,
                logs: vec![LogRecord {
                    level: "warn",
                    name: "codex_rollout_guard_error",
                    fields,
                }],
            };
        }
        match self.enforce_files(&view, prepared, force) {
            Ok(Enforced::Value(value)) => Outcome::plain(value),
            Ok(Enforced::Archived(value)) => {
                let sweep = self.sweep(false, now_ms);
                Outcome {
                    value,
                    logs: sweep.logs,
                }
            }
            Err(message) => {
                let fields = object(vec![
                    ("sessionId", view.id_value()),
                    ("error", text(&message)),
                ]);
                let value = object(vec![("action", text("error")), ("error", text(&message))]);
                Outcome {
                    value,
                    logs: vec![LogRecord {
                        level: "warn",
                        name: "codex_rollout_guard_error",
                        fields,
                    }],
                }
            }
        }
    }

    pub fn sweep(&mut self, force: bool, now_ms: f64) -> Outcome {
        if self.options.archive_ttl_ms <= 0.0 {
            return Outcome::plain(skipped_sweep("disabled"));
        }
        if !force && now_ms - self.last_sweep_at < SWEEP_INTERVAL_MS {
            return Outcome::plain(skipped_sweep("throttled"));
        }
        self.last_sweep_at = now_ms;
        let mut deleted = Vec::new();
        let mut freed_bytes = 0.0;
        for archive_dir in self.candidate_archive_dirs() {
            let Ok(entries) = fs::read_dir(&archive_dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                if !file_type.is_file() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                let full = node_join(&[&archive_dir, &name]);
                let Ok(metadata) = fs::metadata(&full) else {
                    continue;
                };
                if now_ms - mtime_ms(&metadata) <= self.options.archive_ttl_ms {
                    continue;
                }
                if fs::remove_file(&full).is_err() {
                    continue;
                }
                deleted.push(text(&full));
                freed_bytes += metadata.len() as f64;
            }
        }
        let mut outcome = Outcome::plain(sweep_value(deleted.clone(), freed_bytes));
        if !deleted.is_empty() {
            outcome.logs.push(LogRecord {
                level: "info",
                name: "codex_rollout_archive_cleanup",
                fields: object(vec![
                    ("deleted", num(deleted.len() as f64)),
                    ("freedBytes", num(freed_bytes)),
                    ("ttlDays", num(self.options.archive_ttl_ms / DAY_MS)),
                ]),
            });
        }
        outcome
    }
}

// ── vendor-native session guard ─────────────────────────────────────────────

pub struct NativeSessionGuard {
    options: NativeOptions,
    last_sweep_at: f64,
}

fn store_lookup(cli: &str) -> StoreLookup {
    match cli {
        "zcode" | "kimi" | "codebuddy" | "qoder" => StoreLookup::Real(StoreKind::Files),
        "dsh" => StoreLookup::Real(StoreKind::Dirs),
        _ if OBJECT_PROTO_NAMES.contains(&cli) => StoreLookup::Phantom,
        _ => StoreLookup::Missing,
    }
}

fn walk_matches(root: &str, id: &JsString, kind: StoreKind, max_entries: f64) -> Vec<String> {
    let mut found = Vec::new();
    let mut inspected = 0.0;
    let mut stack = vec![root.to_string()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        // Node readdirSync uses libuv scandir's filename sort. Preserve that
        // order before applying the scan bound and pushing LIFO directories.
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_cached_key(|entry| entry.file_name().to_string_lossy().into_owned());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            inspected += 1.0;
            if inspected > max_entries {
                return found;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let full = node_join(&[&dir, &name]);
            if file_type.is_dir() {
                if kind == StoreKind::Dirs
                    && JsString::from_rust_str(&name).as_units() == id.as_units()
                {
                    found.push(full);
                } else if name != NATIVE_ARCHIVE_DIRNAME {
                    stack.push(full);
                }
            } else if kind == StoreKind::Files
                && file_type.is_file()
                && contains_units(JsString::from_rust_str(&name).as_units(), id.as_units())
                && name.ends_with(".jsonl")
            {
                found.push(full);
            }
        }
    }
    found
}

fn native_target_name(id: Option<&JsValue>, file: &str) -> JsString {
    let base = match id {
        Some(value) if coerce::truthy(value) => coerce::js_to_string(value),
        _ => JsString::from_rust_str("session"),
    };
    let truncated = base.truncate_units(32);
    let basename = JsString::from_rust_str(&path_basename(file));
    JsString::concat(&[&truncated, &JsString::from_rust_str("-"), &basename])
}

impl NativeSessionGuard {
    pub fn new(options: NativeOptions) -> Self {
        Self {
            options,
            last_sweep_at: 0.0,
        }
    }

    pub fn max_bytes(&self) -> f64 {
        self.options.max_bytes
    }

    pub fn archive_ttl_ms(&self) -> f64 {
        self.options.archive_ttl_ms
    }

    fn roots_for(
        &self,
        cli: &str,
        zcode_home: Option<&str>,
        kimi_home: Option<&str>,
    ) -> Vec<String> {
        match cli {
            "zcode" => zcode_home
                .map(|home| vec![node_join(&[home, ".zcode"])])
                .unwrap_or_default(),
            "kimi" => vec![kimi_home
                .map(str::to_string)
                .unwrap_or_else(|| self.options.kimi_code_home.clone())],
            "codebuddy" => vec![node_join(&[&self.options.home_dir, ".codebuddy"])],
            "qoder" => vec![node_join(&[&self.options.home_dir, ".qoder"])],
            "dsh" => vec![node_join(&[&self.options.home_dir, ".dsh", "sessions"])],
            _ => Vec::new(),
        }
    }

    fn archive_root_for(
        &self,
        cli: &str,
        provider: bool,
        matched: &str,
        zcode_home: Option<&str>,
        kimi_home: Option<&str>,
    ) -> String {
        if cli == "zcode" || (cli == "kimi" && provider) {
            let roots = self.roots_for(cli, zcode_home, kimi_home);
            if let Some(root) = roots.first() {
                if matched.starts_with(&format!("{root}/")) {
                    return root.clone();
                }
            }
        }
        match cli {
            "kimi" => self.options.kimi_code_home.clone(),
            "dsh" => node_join(&[&self.options.home_dir, ".dsh"]),
            _ => node_join(&[&self.options.home_dir, &format!(".{cli}")]),
        }
    }

    fn all_archive_dirs(&self) -> Vec<String> {
        let mut dirs = Vec::new();
        for cli in ["codebuddy", "qoder", "dsh"] {
            let root = self.archive_root_for(cli, false, "", None, None);
            dirs.push(node_join(&[&root, NATIVE_ARCHIVE_DIRNAME]));
        }
        dirs.push(node_join(&[
            &self.options.kimi_code_home,
            NATIVE_ARCHIVE_DIRNAME,
        ]));
        for home in list_subdirs(&self.options.zcode_homes_dir) {
            dirs.push(node_join(&[&home, ".zcode", NATIVE_ARCHIVE_DIRNAME]));
        }
        for home in list_subdirs(&self.options.kimi_homes_dir) {
            dirs.push(node_join(&[&home, NATIVE_ARCHIVE_DIRNAME]));
        }
        dirs
    }

    #[allow(clippy::too_many_arguments)]
    fn enforce_files(
        &self,
        cli: &str,
        kind: StoreKind,
        record: &RecordView<'_>,
        zcode_home: Option<&str>,
        kimi_home: Option<&str>,
        force: bool,
    ) -> Result<Enforced, String> {
        let id = coerce::js_to_string(record.cli_session_id.unwrap());
        let mut matches = Vec::new();
        for root in self.roots_for(cli, zcode_home, kimi_home) {
            if !exists(&root) {
                continue;
            }
            matches.extend(walk_matches(&root, &id, kind, MAX_SCAN_ENTRIES));
        }
        if matches.is_empty() {
            return Ok(Enforced::Value(not_found(self.options.max_bytes)));
        }
        let is_dir = kind == StoreKind::Dirs;
        let sized: Vec<(String, f64)> = matches
            .iter()
            .map(|file| (file.clone(), size_of(file, is_dir)))
            .collect();
        let total_bytes: f64 = sized.iter().map(|(_, size)| *size).sum();
        if !force && total_bytes <= self.options.max_bytes {
            return Ok(Enforced::Value(within_budget(
                self.options.max_bytes,
                total_bytes,
                matches.len(),
            )));
        }
        let mut archived = Vec::new();
        for (file, size_bytes) in &sized {
            let root =
                self.archive_root_for(cli, record.provider_truthy(), file, zcode_home, kimi_home);
            let name = native_target_name(record.id, file);
            let target = node_join_units(&[
                JsString::from_rust_str(&root),
                JsString::from_rust_str(NATIVE_ARCHIVE_DIRNAME),
                name,
            ]);
            let target_path = target.to_string_lossy();
            move_tree(file, &target_path)?;
            archived.push(object(vec![
                ("file", text(file)),
                ("sizeBytes", num(*size_bytes)),
                ("archivedTo", JsValue::String(target)),
            ]));
        }
        Ok(Enforced::Archived(archived_value(
            self.options.max_bytes,
            total_bytes,
            matches.len(),
            JsValue::String(id),
            archived,
        )))
    }

    pub fn enforce(
        &mut self,
        record: &JsValue,
        force: bool,
        homes: &JsValue,
        now_ms: f64,
    ) -> Outcome {
        let view = RecordView::new(record);
        let cli = view
            .cli
            .map(coerce::js_to_string)
            .unwrap_or_else(|| JsString::from_rust_str("undefined"))
            .to_string_lossy();
        let lookup = store_lookup(&cli);
        if matches!(lookup, StoreLookup::Missing) || !view.session_id_truthy() {
            return Outcome::plain(skipped());
        }
        let zcode_home = field(homes, "zcodeSessionHome")
            .filter(|value| coerce::truthy(value))
            .map(|value| coerce::js_to_string(value).to_string_lossy());
        let kimi_home = field(homes, "kimiSessionHome")
            .filter(|value| coerce::truthy(value))
            .map(|value| coerce::js_to_string(value).to_string_lossy());
        let kind = match lookup {
            StoreLookup::Real(kind) => kind,
            StoreLookup::Phantom => {
                return Outcome::plain(not_found(self.options.max_bytes));
            }
            StoreLookup::Missing => unreachable!(),
        };
        match self.enforce_files(
            &cli,
            kind,
            &view,
            zcode_home.as_deref(),
            kimi_home.as_deref(),
            force,
        ) {
            Ok(Enforced::Value(value)) => Outcome::plain(value),
            Ok(Enforced::Archived(value)) => {
                let sweep = self.sweep(false, now_ms);
                Outcome {
                    value,
                    logs: sweep.logs,
                }
            }
            Err(message) => {
                let fields = object(vec![
                    ("sessionId", view.id_value()),
                    ("cli", view.cli_value()),
                    ("error", text(&message)),
                ]);
                let value = object(vec![("action", text("error")), ("error", text(&message))]);
                Outcome {
                    value,
                    logs: vec![LogRecord {
                        level: "warn",
                        name: "native_session_guard_error",
                        fields,
                    }],
                }
            }
        }
    }

    pub fn sweep(&mut self, force: bool, now_ms: f64) -> Outcome {
        if self.options.archive_ttl_ms <= 0.0 {
            return Outcome::plain(skipped_sweep("disabled"));
        }
        if !force && now_ms - self.last_sweep_at < SWEEP_INTERVAL_MS {
            return Outcome::plain(skipped_sweep("throttled"));
        }
        self.last_sweep_at = now_ms;
        let mut deleted = Vec::new();
        let mut freed_bytes = 0.0;
        for archive_dir in self.all_archive_dirs() {
            let Ok(entries) = fs::read_dir(&archive_dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                let name = entry.file_name().to_string_lossy().into_owned();
                let full = node_join(&[&archive_dir, &name]);
                let Ok(metadata) = fs::metadata(&full) else {
                    continue;
                };
                if now_ms - mtime_ms(&metadata) <= self.options.archive_ttl_ms {
                    continue;
                }
                // Matches the legacy ordering: bytes are added before the removal
                // attempt, so a failed unlink still inflates `freedBytes`.
                if file_type.is_dir() {
                    freed_bytes += size_of(&full, true);
                    if fs::remove_dir_all(&full).is_err() {
                        continue;
                    }
                } else {
                    freed_bytes += metadata.len() as f64;
                    if fs::remove_file(&full).is_err() {
                        continue;
                    }
                }
                deleted.push(text(&full));
            }
        }
        let mut outcome = Outcome::plain(sweep_value(deleted.clone(), freed_bytes));
        if !deleted.is_empty() {
            outcome.logs.push(LogRecord {
                level: "info",
                name: "native_session_archive_cleanup",
                fields: object(vec![
                    ("deleted", num(deleted.len() as f64)),
                    ("freedBytes", num(freed_bytes)),
                    ("ttlDays", num(self.options.archive_ttl_ms / DAY_MS)),
                ]),
            });
        }
        outcome
    }

    pub fn handles(&self, value: &JsValue) -> bool {
        let cli = coerce::js_to_string(value).to_string_lossy();
        matches!(
            cli.as_str(),
            "zcode" | "kimi" | "codebuddy" | "qoder" | "dsh"
        )
    }

    /// `Boolean(STORES[cli])`: own stores and `Object.prototype` members are
    /// truthy, everything else is `undefined`. The facade needs this to preserve
    /// whether `enforce(record, null)` throws before the try block.
    pub fn store_truthy(&self, value: &JsValue) -> bool {
        let cli = coerce::js_to_string(value).to_string_lossy();
        !matches!(store_lookup(&cli), StoreLookup::Missing)
    }
}

// ── boundary encoding ───────────────────────────────────────────────────────

pub fn outcome_value(outcome: &Outcome) -> JsValue {
    let logs = outcome
        .logs
        .iter()
        .map(|log| {
            object(vec![
                ("level", text(log.level)),
                ("name", text(log.name)),
                ("fields", log.fields.clone()),
            ])
        })
        .collect();
    object(vec![
        ("result", outcome.value.clone()),
        ("logs", JsValue::Array(logs)),
    ])
}

pub fn codex_defaults_value() -> JsValue {
    object(vec![
        ("maxBytes", num(CODEX_DEFAULT_MAX_BYTES)),
        ("archiveTtlDays", num(DEFAULT_ARCHIVE_TTL_DAYS)),
        ("archiveDirname", text(CODEX_ARCHIVE_DIRNAME)),
    ])
}

pub fn native_defaults_value() -> JsValue {
    object(vec![
        ("maxBytes", num(NATIVE_DEFAULT_MAX_BYTES)),
        ("archiveTtlDays", num(DEFAULT_ARCHIVE_TTL_DAYS)),
        ("archiveDirname", text(NATIVE_ARCHIVE_DIRNAME)),
    ])
}

#[cfg(test)]
mod tests;
