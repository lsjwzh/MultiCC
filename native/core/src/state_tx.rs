//! The cross-file state journal (`src/state/tx.js` before this module).
//!
//! One JSON entry per transaction captures the intended final payload of every
//! state file involved. Writing it first and deleting it only after every file
//! is durable is what makes a directory delete (directories.json + sessions.json)
//! recoverable from a crash between the two writes. The entry and the applied
//! files use the normal StateStore envelope; the entry itself never rotates
//! backups because each journal name is single-use.
use crate::{
    durable_state,
    js::{self, JsString, JsValue},
};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

/// `crypto.randomBytes(8).toString('hex')`.
pub fn new_tx_id() -> Result<String, String> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(|_| "STATE_TX_ENTROPY: random source unavailable")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// `Date.now()` (milliseconds). The host `now` port can override it.
pub fn now_millis() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as f64)
        .unwrap_or(0.0)
}

/// `path.join(journalDir, `tx-${id}.json`)`.
pub fn journal_file(journal_dir: &Path, id: &str) -> PathBuf {
    journal_dir.join(format!("tx-{id}.json"))
}

/// `^tx-.+\.json$`.
pub fn is_journal_name(name: &str) -> bool {
    name.strip_prefix("tx-")
        .and_then(|rest| rest.strip_suffix(".json"))
        .is_some_and(|middle| !middle.is_empty())
}

pub struct JournalFile {
    pub path: PathBuf,
    /// Serialized payload. `None` is a journal file entry without `payload`
    /// (`JSON.stringify` would drop the key).
    pub payload: Option<String>,
    pub kind: String,
    pub version: u32,
    pub rotate: usize,
}

pub struct JournalEntry {
    pub id: String,
    pub kind: String,
    /// Already in `String(ts)` form so the entry documents JS number
    /// formatting without another JSON bridge.
    pub ts: String,
    pub files: Vec<JournalFile>,
}

/// The compact `{ id, kind, ts, files }` document stored in the journal
/// envelope. Keys are emitted in the same order the Node literal used.
pub fn encode(entry: &JournalEntry) -> String {
    let mut out = String::with_capacity(256 + entry.files.len() * 128);
    out.push_str("{\"id\":");
    out.push_str(&js::json_quote_str(&entry.id));
    out.push_str(",\"kind\":");
    out.push_str(&js::json_quote_str(&entry.kind));
    out.push_str(",\"ts\":");
    out.push_str(&entry.ts);
    out.push_str(",\"files\":[");
    for (index, file) in entry.files.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str("{\"path\":");
        out.push_str(&js::json_quote_str(&file.path.to_string_lossy()));
        if let Some(payload) = &file.payload {
            out.push_str(",\"payload\":");
            out.push_str(payload);
        }
        out.push_str(",\"kind\":");
        out.push_str(&js::json_quote_str(&file.kind));
        out.push_str(",\"schemaVersion\":");
        out.push_str(&file.version.to_string());
        out.push('}');
    }
    out.push_str("]}");
    out
}

fn string_field(value: &JsValue, key: &str) -> Option<String> {
    match value.get(key) {
        Some(JsValue::String(text)) => Some(text.to_string_lossy()),
        _ => None,
    }
}

fn number_field(value: &JsValue, key: &str) -> Option<f64> {
    match value.get(key) {
        Some(JsValue::Number(number)) if number.is_finite() => Some(*number),
        _ => None,
    }
}

/// Decode one parsed journal envelope payload. Every failure is an apply
/// failure, which the boot replayer moves aside (same as the Node code).
pub fn decode(value: &JsValue) -> Result<JournalEntry, String> {
    let files = match value.get("files") {
        Some(JsValue::Array(files)) => files,
        _ => return Err(malformed(value)),
    };
    let mut decoded = Vec::with_capacity(files.len());
    for file in files {
        let Some(path) = string_field(file, "path") else {
            return Err("[state-tx] journal file entry missing path".into());
        };
        let payload = file.get("payload").and_then(js::json_stringify);
        let kind = string_field(file, "kind")
            .filter(|kind| !kind.is_empty())
            .unwrap_or_else(|| "unknown".into());
        let version = number_field(file, "schemaVersion")
            .map(|value| value.max(0.0) as u32)
            .unwrap_or(1);
        let rotate = number_field(file, "rotate")
            .map(|value| value.max(0.0) as usize)
            .unwrap_or(3);
        decoded.push(JournalFile {
            path: PathBuf::from(path),
            payload,
            kind,
            version,
            rotate,
        });
    }
    Ok(JournalEntry {
        id: string_field(value, "id").unwrap_or_default(),
        kind: string_field(value, "kind").unwrap_or_default(),
        ts: "0".into(),
        files: decoded,
    })
}

fn malformed(value: &JsValue) -> String {
    let text = js::json_stringify(value).unwrap_or_default();
    let excerpt: String = text.chars().take(200).collect();
    format!("[state-tx] malformed journal entry: {excerpt}")
}

/// Write one journal file entry atomically with its recorded rotation and
/// schema version.
pub fn apply_file(file: &JournalFile) -> Result<(), String> {
    durable_state::save_compact_with(
        &file.path,
        &file.kind,
        file.version,
        file.rotate,
        file.payload.as_deref(),
    )
}

/// Best-effort `broken/<name>.<Date.now()>` move for an unusable journal.
pub fn move_aside(file: &Path) {
    let Some(parent) = file.parent() else {
        return;
    };
    let broken = parent.join("broken");
    if fs::create_dir_all(&broken).is_err() {
        return;
    }
    let Some(name) = file.file_name() else {
        return;
    };
    let mut destination = broken.join(name);
    let suffix = format!(".{}", now_millis() as u64);
    let mut name = destination.as_os_str().to_os_string();
    name.push(suffix);
    destination = PathBuf::from(name);
    let _ = fs::rename(file, destination);
}

/// `JsString` helper kept here so callers do not re-implement the comparison.
pub fn same_name(name: &JsString, expected: &str) -> bool {
    name == expected
}
