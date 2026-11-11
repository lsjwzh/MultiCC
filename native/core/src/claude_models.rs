//! `GET /api/claude/models` (was src/routes/claude-models.js): the model ids
//! embedded in the installed Claude CLI bundle.
//!
//! This is the file-scanning half of the route: the regex-equivalent matcher,
//! canonical ids, the per-family curation, cache validity and the bundle
//! lookup. The gateway owns the HTTP shape and the cross-process cache file.
//!
//! The JavaScript regex had a lookbehind, which the `regex` crate cannot
//! express (and no dependency may be added), so [`next_match`] is a hand
//! written equivalent: at every byte it repeats what the backtracking engine
//! does for
//! `/(?<![\w-])claude-(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d{1,2}))?(?:-(\d{8}))?(\[1m\])?(?![\w-])/g`.
//! Only ASCII `\w` participates, so a byte >= 0x80 is a boundary exactly like
//! the U+FFFD that `buf.toString('utf8')` produces for a broken sequence.

use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::http_gate::QueryValue;
use crate::js::number::number_to_string;
use crate::js::serde::js_string_to_number;

pub const CACHE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
pub const CHUNK_SIZE: usize = 4 * 1024 * 1024;
pub const CHUNK_OVERLAP: usize = 64;
pub const MAX_SCAN_BYTES: u64 = 400 * 1024 * 1024;
pub const MAX_IDS: usize = 500;
pub const CACHE_FILE_NAME: &str = "claude-models-cache.json";
const FAMILY_WINDOW: usize = 2;
const FAMILIES: [&str; 4] = ["opus", "sonnet", "fable", "haiku"];
const FALLBACK: [(&str, &str); 9] = [
    ("claude-opus-5[1m]", "Opus 5 (1M context)"),
    ("claude-opus-5", "Opus 5"),
    ("claude-opus-4-8[1m]", "Opus 4.8 (1M context)"),
    ("claude-opus-4-8", "Opus 4.8"),
    ("claude-sonnet-5", "Sonnet 5"),
    ("claude-sonnet-4-6[1m]", "Sonnet 4.6 (1M context)"),
    ("claude-sonnet-4-6", "Sonnet 4.6"),
    ("claude-fable-5", "Fable 5"),
    ("claude-haiku-4-5", "Haiku 4.5"),
];

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Model {
    pub model: String,
    pub label: String,
}

impl Model {
    fn new(model: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            label: label.into(),
        }
    }
}

/// The static list (`CLAUDE_MODELS_FALLBACK`). Never cached.
pub fn fallback_models() -> Vec<Model> {
    FALLBACK
        .iter()
        .map(|(model, label)| Model::new(*model, *label))
        .collect()
}

/// The fallback ids, in order (the cross-process sync reader in Node has the
/// same constant; a golden fixture keeps the two from drifting).
pub fn fallback_ids() -> Vec<&'static str> {
    FALLBACK.iter().map(|(model, _)| *model).collect()
}

fn is_word_or_dash(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

fn boundary(bytes: &[u8], end: usize) -> bool {
    bytes.get(end).is_none_or(|byte| !is_word_or_dash(*byte))
}

fn digits(bytes: &[u8], start: usize) -> usize {
    let mut end = start;
    while bytes.get(end).is_some_and(u8::is_ascii_digit) {
        end += 1;
    }
    end - start
}

/// An eight digit date stamp starting with `-`; returns the end offset.
fn date_end(bytes: &[u8], start: usize) -> Option<usize> {
    if bytes.get(start) != Some(&b'-') || digits(bytes, start + 1) < 8 {
        return None;
    }
    Some(start + 9)
}

fn one_m_end(bytes: &[u8], start: usize) -> Option<usize> {
    bytes[start..].starts_with(b"[1m]").then_some(start + 4)
}

/// One regex match. `family` indexes [`FAMILIES`]; slices point into the
/// scanned window.
#[derive(Debug, Clone, Copy)]
pub struct Match {
    family: usize,
    major: (usize, usize),
    minor: Option<(usize, usize)>,
    one_m: bool,
    end: usize,
}

impl Match {
    pub fn family(&self) -> &'static str {
        FAMILIES[self.family]
    }
    pub fn end(&self) -> usize {
        self.end
    }
    pub fn has_one_m(&self) -> bool {
        self.one_m
    }
    pub fn major<'a>(&self, bytes: &'a [u8]) -> &'a [u8] {
        &bytes[self.major.0..self.major.1]
    }
    pub fn minor<'a>(&self, bytes: &'a [u8]) -> Option<&'a [u8]> {
        self.minor.map(|(start, end)| &bytes[start..end])
    }
    /// `canonicalKey`: drop the date and use the dash minor separator.
    pub fn canonical(&self, bytes: &[u8]) -> String {
        let mut id = format!(
            "claude-{}-{}",
            self.family(),
            String::from_utf8_lossy(self.major(bytes))
        );
        if let Some(minor) = self.minor(bytes) {
            id.push('-');
            id.push_str(&String::from_utf8_lossy(minor));
        }
        id
    }
}

/// The first match at or after `from`, or `None`. Mirrors `regex.exec`:
/// non-overlapping scans advance to the end of a match.
pub fn next_match(bytes: &[u8], from: usize) -> Option<Match> {
    let mut index = from;
    while index < bytes.len() {
        if let Some(found) = match_at(bytes, index) {
            return Some(found);
        }
        index += 1;
    }
    None
}

fn match_at(bytes: &[u8], index: usize) -> Option<Match> {
    // `(?<![\w-])`: the start of the window counts as a boundary.
    if index > 0 && is_word_or_dash(bytes[index - 1]) {
        return None;
    }
    if !bytes[index..].starts_with(b"claude-") {
        return None;
    }
    let family_start = index + 7;
    let (family, after_family) = FAMILIES.iter().enumerate().find_map(|(family, name)| {
        let end = family_start + name.len();
        (bytes.get(family_start..end)? == name.as_bytes()).then_some((family, end))
    })?;
    if bytes.get(after_family) != Some(&b'-') {
        return None;
    }
    let major_start = after_family + 1;
    let major_len = digits(bytes, major_start);
    if major_len == 0 {
        return None;
    }
    // `\d+` is greedy; shortening it only moves a digit in front of a group
    // that needs `.`/`-`, and the lookahead rejects that digit, so the maximal
    // run is the only one that can succeed.
    let major_end = major_start + major_len;
    let major = (major_start, major_end);

    // Optional `(?:[.-](\d{1,2}))?` then `(?:-(\d{8}))?` then `(\[1m\])?`.
    // Backtracking order: minor 2 digits, minor 1 digit, minor absent. For
    // each: date present, date absent; and within each, `[1m]` present before
    // absent (a present `[1m]` that fails the lookahead is skipped, which the
    // engine allows because `[` is itself a boundary).
    let separator = bytes.get(major_end).copied();
    if separator.is_some_and(|byte| byte == b'.' || byte == b'-') {
        let available = digits(bytes, major_end + 1);
        for minor_len in [2usize, 1] {
            if available < minor_len {
                continue;
            }
            let minor = (major_end + 1, major_end + 1 + minor_len);
            let after_minor = minor.1;
            if let Some(end) = date_end(bytes, after_minor) {
                if let Some(found) = finish(bytes, family, major, Some(minor), end, true) {
                    return Some(found);
                }
                if let Some(found) = finish(bytes, family, major, Some(minor), end, false) {
                    return Some(found);
                }
            }
            if let Some(found) = finish(bytes, family, major, Some(minor), after_minor, true) {
                return Some(found);
            }
            if let Some(found) = finish(bytes, family, major, Some(minor), after_minor, false) {
                return Some(found);
            }
        }
    }
    if let Some(end) = date_end(bytes, major_end) {
        if let Some(found) = finish(bytes, family, major, None, end, true) {
            return Some(found);
        }
        if let Some(found) = finish(bytes, family, major, None, end, false) {
            return Some(found);
        }
    }
    if let Some(found) = finish(bytes, family, major, None, major_end, true) {
        return Some(found);
    }
    finish(bytes, family, major, None, major_end, false)
}

fn finish(
    bytes: &[u8],
    family: usize,
    major: (usize, usize),
    minor: Option<(usize, usize)>,
    after_groups: usize,
    one_m: bool,
) -> Option<Match> {
    let end = if one_m {
        one_m_end(bytes, after_groups)?
    } else {
        after_groups
    };
    boundary(bytes, end).then_some(Match {
        family,
        major,
        minor,
        one_m,
        end,
    })
}

/// Insertion-ordered distinct ids plus the subset with a literal `[1m]`
/// variant. `ids` and `seen` move together.
#[derive(Default, Debug)]
pub struct Extraction {
    ids: Vec<String>,
    seen: HashSet<String>,
    one_m: HashSet<String>,
}

impl Extraction {
    pub fn ids(&self) -> &[String] {
        &self.ids
    }
    pub fn has_one_m(&self, id: &str) -> bool {
        self.one_m.contains(id)
    }
    fn add(&mut self, match_: &Match, bytes: &[u8]) -> bool {
        let id = match_.canonical(bytes);
        if self.seen.insert(id.clone()) {
            self.ids.push(id.clone());
        }
        if match_.has_one_m() {
            self.one_m.insert(id);
        }
        self.ids.len() >= MAX_IDS
    }
}

/// Scan `bytes` and return the extraction. Stops as soon as the 500th
/// distinct id is added, exactly like the Node loop.
pub fn extract_bytes(bytes: &[u8]) -> Extraction {
    let mut extraction = Extraction::default();
    let mut offset = 0;
    while let Some(found) = next_match(bytes, offset) {
        let stop = extraction.add(&found, bytes);
        if stop {
            break;
        }
        offset = found.end();
    }
    extraction
}

pub fn extract_models(path: &Path) -> std::io::Result<Extraction> {
    extract_models_with_chunk(path, CHUNK_SIZE)
}

/// Sliding `[offset, offset + chunk + 64)` windows that advance by `chunk`:
/// a match is reported by every window that contains it whole, and a window
/// ending right after an id accepts it without seeing the following byte.
pub fn extract_models_with_chunk(path: &Path, chunk: usize) -> std::io::Result<Extraction> {
    let chunk = chunk.max(1);
    let mut file = File::open(path)?;
    let size = std::cmp::min(file.metadata()?.len(), MAX_SCAN_BYTES);
    let mut extraction = Extraction::default();
    let mut offset = 0u64;
    while offset < size {
        let want = std::cmp::min(chunk as u64 + CHUNK_OVERLAP as u64, size - offset) as usize;
        file.seek(SeekFrom::Start(offset))?;
        let mut window = vec![0u8; want];
        let mut read = 0;
        while read < want {
            let got = file.read(&mut window[read..])?;
            if got == 0 {
                break;
            }
            read += got;
        }
        window.truncate(read);
        let found = extract_bytes(&window);
        for id in found.ids {
            let has_one_m = found.one_m.contains(&id);
            if extraction.seen.insert(id.clone()) {
                extraction.ids.push(id.clone());
            }
            if has_one_m {
                extraction.one_m.insert(id);
            }
            // The Node loop returns at the 500th id of the *whole* scan, in
            // the middle of a window when earlier windows already contributed.
            if extraction.ids.len() >= MAX_IDS {
                return Ok(extraction);
            }
        }
        offset += chunk as u64;
    }
    Ok(extraction)
}

/// `versionKey`: `[Number(major) || 0, Number(minor) || 0]`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VersionKey {
    pub major: f64,
    pub minor: f64,
}

pub fn version_key(id: &str) -> VersionKey {
    let bytes = id.as_bytes();
    let mut at = b"claude-".len();
    while bytes.get(at).is_some_and(u8::is_ascii_lowercase) {
        at += 1;
    }
    if at == b"claude-".len() || bytes.get(at) != Some(&b'-') {
        return VersionKey {
            major: 0.0,
            minor: 0.0,
        };
    }
    let major_start = at + 1;
    let major_len = digits(bytes, major_start);
    if major_len == 0 {
        return VersionKey {
            major: 0.0,
            minor: 0.0,
        };
    }
    let major = js_string_to_number(&id[major_start..major_start + major_len]);
    let mut minor = 0.0;
    let separator = major_start + major_len;
    if matches!(bytes.get(separator), Some(b'.') | Some(b'-')) {
        let available = digits(bytes, separator + 1);
        let take = available.min(2);
        if take > 0 {
            minor = js_string_to_number(&id[separator + 1..separator + 1 + take]);
        }
    }
    VersionKey { major, minor }
}

pub fn display_label(family: &str, id: &str) -> String {
    let key = version_key(id);
    let mut chars = family.chars();
    let name = match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    };
    if key.minor != 0.0 && !key.minor.is_nan() {
        format!(
            "{} {}.{}",
            name,
            number_to_string(key.major),
            number_to_string(key.minor)
        )
    } else {
        format!("{} {}", name, number_to_string(key.major))
    }
}

/// `curateModels`: newest two versions per family, families in
/// opus/sonnet/fable/haiku order, `[1m]` rows only for ids the bundle carries.
pub fn curate(extraction: &Extraction) -> Vec<Model> {
    let mut by_family: Vec<Vec<&String>> = vec![Vec::new(); FAMILIES.len()];
    for id in &extraction.ids {
        let Some(family) = family_of(id) else {
            continue;
        };
        let Some(index) = FAMILIES.iter().position(|name| *name == family) else {
            continue;
        };
        by_family[index].push(id);
    }
    let mut models = Vec::new();
    for (index, family) in FAMILIES.iter().enumerate() {
        let mut ids = by_family[index].clone();
        ids.sort_by(|a, b| compare_ids(a, b));
        for id in ids.into_iter().take(FAMILY_WINDOW) {
            let label = display_label(family, id);
            if extraction.has_one_m(id) {
                models.push(Model::new(
                    format!("{id}[1m]"),
                    format!("{label} (1M context)"),
                ));
            }
            models.push(Model::new(id, label));
        }
    }
    models
}

fn family_of(id: &str) -> Option<&str> {
    let rest = id.strip_prefix("claude-")?;
    let end = rest.find('-')?;
    Some(&rest[..end])
}

/// The JS comparator `vb[0]-va[0] || vb[1]-va[1] || a.length-b.length`.
fn compare_ids(a: &str, b: &str) -> std::cmp::Ordering {
    let va = version_key(a);
    let vb = version_key(b);
    let primary = vb.major - va.major;
    if primary != 0.0 && !primary.is_nan() {
        return if primary < 0.0 {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        };
    }
    let secondary = vb.minor - va.minor;
    if secondary != 0.0 && !secondary.is_nan() {
        return if secondary < 0.0 {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        };
    }
    // ASCII ids only: byte length is the JS UTF-16 length.
    a.len().cmp(&b.len())
}

/// `{ at, models, bundleKey }`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Cache {
    #[serde(rename = "at")]
    pub at_ms: i64,
    pub models: Vec<Model>,
    #[serde(rename = "bundleKey", skip_serializing_if = "Option::is_none")]
    pub bundle_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Cache,
    Cli,
    Fallback,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Cache => "cache",
            Source::Cli => "cli",
            Source::Fallback => "fallback",
        }
    }
}

#[derive(Debug)]
pub struct Answer {
    pub models: Vec<Model>,
    pub source: Source,
    /// The new cache entry when the scan produced a list.
    pub stored: Option<Cache>,
}

/// Resolve a bundle path the way `resolveClaudeBundle(home)` does: the shim's
/// realpath when it is a file, else the newest file under
/// `~/.local/share/claude/versions`, else an empty path.
pub fn resolve_bundle(home: &Path) -> PathBuf {
    let shim = home.join(".local").join("bin").join("claude");
    if let Ok(real) = std::fs::canonicalize(&shim) {
        if std::fs::metadata(&real).is_ok_and(|meta| meta.is_file()) {
            return real;
        }
    }
    let versions = home
        .join(".local")
        .join("share")
        .join("claude")
        .join("versions");
    let Ok(entries) = std::fs::read_dir(&versions) else {
        return PathBuf::new();
    };
    let mut files: Vec<(Vec<u8>, f64, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        files.push((name_bytes(&entry.file_name()), mtime_ms(&meta), path));
    }
    sort_version_files(&mut files);
    files
        .into_iter()
        .next()
        .map(|(_, _, path)| path)
        .unwrap_or_default()
}

/// Restore the order `readdirSync` hands to the mtime sort: libuv's scandir
/// sorts names with strcmp, and V8's Array.prototype.sort is stable, so an
/// mtime tie keeps the byte-wise earlier name. `read_dir` is OS order, hence
/// the name pass first, then a stable newest-first pass.
fn sort_version_files(files: &mut [(Vec<u8>, f64, PathBuf)]) {
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
}

#[cfg(unix)]
fn name_bytes(name: &std::ffi::OsStr) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    name.as_bytes().to_vec()
}

#[cfg(not(unix))]
fn name_bytes(name: &std::ffi::OsStr) -> Vec<u8> {
    name.to_string_lossy().into_owned().into_bytes()
}

/// `statSync().mtimeMs` as Node fills it: the whole milliseconds plus the
/// sub-millisecond fraction (`nsec / 1e6`, split so the fraction is not
/// truncated). A file rewritten inside the same millisecond is still a
/// different bundle, exactly like Node.
#[cfg(unix)]
fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    use std::os::unix::fs::MetadataExt;
    let seconds = meta.mtime() as f64;
    let nanos = meta.mtime_nsec();
    seconds * 1000.0 + (nanos / 1_000_000) as f64 + (nanos % 1_000_000) as f64 / 1_000_000.0
}

#[cfg(not(unix))]
fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_nanos() as f64 / 1_000_000.0)
        .unwrap_or(0.0)
}

/// `bundleKey(file)`: the path, mtime and size; empty when missing. Node keys
/// on its fractional `mtimeMs`; this key stays at nanosecond precision, which
/// is strictly finer, so it never treats "mtime or size changed" as the same
/// bundle. The text is internal (only two keys from this process are compared).
pub fn bundle_key(file: &Path) -> String {
    if file.as_os_str().is_empty() {
        return String::new();
    }
    let Ok(meta) = std::fs::metadata(file) else {
        return String::new();
    };
    let nanos = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    format!("{}:{}:{}", file.to_string_lossy(), nanos, meta.len())
}

/// `!force && cache && sameBundle && (now - at) < 1 day`.
///
/// `now_ms` is a clock, not a stamp: Node reads `Date.now()` at request start
/// for the TTL test and again after the scan for `at`, so a long first scan
/// does not age the cache by its own duration.
pub fn answer(
    cache: &mut Option<Cache>,
    bundle: &Path,
    force: bool,
    mut now_ms: impl FnMut() -> i64,
) -> Answer {
    let key = bundle_key(bundle);
    let same_bundle = cache.as_ref().is_some_and(|entry| {
        entry.bundle_key.is_none() || key.is_empty() || entry.bundle_key.as_deref() == Some(&key)
    });
    if !force {
        if let Some(entry) = cache.as_ref() {
            if same_bundle && now_ms() - entry.at_ms < CACHE_TTL_MS {
                return Answer {
                    models: entry.models.clone(),
                    source: Source::Cache,
                    stored: None,
                };
            }
        }
    }
    let models = if bundle.as_os_str().is_empty() {
        Vec::new()
    } else {
        extract_models(bundle)
            .map(|found| curate(&found))
            .unwrap_or_default()
    };
    if models.is_empty() {
        return Answer {
            models: fallback_models(),
            source: Source::Fallback,
            stored: None,
        };
    }
    let stored = Cache {
        at_ms: now_ms(),
        models: models.clone(),
        bundle_key: Some(key),
    };
    *cache = Some(stored.clone());
    Answer {
        models,
        source: Source::Cli,
        stored: Some(stored),
    }
}

pub use crate::http_gate::query_string;

pub fn force_refresh(value: &QueryValue) -> bool {
    let text = query_string(value);
    text.eq_ignore_ascii_case("1") || text.eq_ignore_ascii_case("true")
}

/// The document the gateway publishes for `listClaudeModelsSync`.
pub fn cache_document(cache: &Cache) -> Value {
    json!({
        "at": cache.at_ms,
        "bundleKey": cache.bundle_key,
        "models": cache.models,
    })
}

#[cfg(test)]
mod tests;
