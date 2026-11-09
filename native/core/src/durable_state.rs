//! Existing StateStore envelope, legacy arrays and rolling-backup recovery.
//! Callers run this on an I/O worker and publish memory only after save succeeds.
use crate::js::{self, JsValue};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

fn backup(file: &Path, index: usize) -> PathBuf {
    let mut name = file.as_os_str().to_os_string();
    name.push(format!(".bak{index}"));
    name.into()
}

/// Why a state file could not be read as payload. The caller owns the user
/// facing message because it knows the target path; this keeps the same
/// information the Node `CorruptedStateError` carried (`file`, `raw`).
#[derive(Clone, Debug)]
pub enum LoadFailure {
    Unreadable,
    Corrupt { raw: String },
    MissingEnvelope,
}

impl LoadFailure {
    pub fn kind(&self) -> &'static str {
        match self {
            LoadFailure::Unreadable => "unreadable",
            LoadFailure::Corrupt { .. } => "corrupt",
            LoadFailure::MissingEnvelope => "envelope",
        }
    }
    /// `raw.slice(0, 200)` for a parse failure.
    pub fn raw_excerpt(&self) -> Option<&str> {
        match self {
            LoadFailure::Corrupt { raw } => Some(raw),
            _ => None,
        }
    }
    pub fn code(&self) -> &'static str {
        match self {
            LoadFailure::Unreadable => "STATE_UNREADABLE: unreadable state file",
            LoadFailure::Corrupt { .. } => "STATE_CORRUPTED: corrupt state JSON",
            LoadFailure::MissingEnvelope => "STATE_CORRUPTED: state envelope missing",
        }
    }
}

/// One successful primary/backup read.
pub struct Loaded {
    pub value: Option<JsValue>,
    /// The backup path that supplied the value, when the primary was damaged.
    pub recovered_from: Option<PathBuf>,
}

/// The body of one state file: a legacy bare array or the `data` field of the
/// `{ "__multiccSchema": …, data }` envelope.
pub fn read(file: &Path) -> Result<Option<JsValue>, LoadFailure> {
    let bytes = match fs::read(file) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(LoadFailure::Unreadable),
    };
    let text = String::from_utf8_lossy(&bytes);
    let value = match js::json_parse(&text) {
        Ok(value) => value,
        Err(_) => {
            return Err(LoadFailure::Corrupt {
                raw: text.chars().take(200).collect(),
            })
        }
    };
    if matches!(value, JsValue::Array(_)) {
        return Ok(Some(value));
    }
    if value.get("__multiccSchema").is_some_and(js::truthy) {
        if let Some(data) = value.get("data") {
            return Ok(Some(data.clone()));
        }
    }
    Err(LoadFailure::MissingEnvelope)
}

/// Missing primary is empty, as in StateStore. Backup recovery occurs only
/// when the primary exists but is unreadable/corrupt, in most-recent order.
pub fn load_or_recover_report(file: &Path) -> Result<Loaded, LoadFailure> {
    match read(file) {
        Ok(value) => Ok(Loaded {
            value,
            recovered_from: None,
        }),
        Err(failure) => {
            for index in 1..=3 {
                let path = backup(file, index);
                if let Ok(Some(value)) = read(&path) {
                    return Ok(Loaded {
                        value: Some(value),
                        recovered_from: Some(path),
                    });
                }
            }
            Err(failure)
        }
    }
}

pub fn load_or_recover(file: &Path) -> Result<Option<JsValue>, String> {
    load_or_recover_report(file)
        .map(|loaded| loaded.value)
        .map_err(|failure| failure.code().to_string())
}

// Pretty-print the canonical lossless JSON without decoding strings/numbers
// through serde_json. Lone UTF-16 surrogates and unknown fields survive saves.
pub(crate) fn pretty(value: &JsValue) -> String {
    pretty_compact(&js::json_stringify(value).expect("JSON payload"))
}

/// `JSON.stringify(value, null, 2)` applied to an already-serialized compact
/// document. Only whitespace outside string literals changes, so a payload that
/// was serialized by the host engine stays byte-identical while the envelope
/// stays native.
pub(crate) fn pretty_compact(compact: &str) -> String {
    let bytes = compact.as_bytes();
    let mut output = String::with_capacity(compact.len() + compact.len() / 4);
    let (mut depth, mut quoted, mut escaped) = (0, false, false);
    for (offset, ch) in compact.char_indices() {
        if quoted {
            output.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                quoted = false;
            }
            continue;
        }
        match ch {
            '"' => {
                quoted = true;
                output.push(ch);
            }
            '{' | '[' => {
                output.push(ch);
                depth += 1;
                if !matches!(bytes.get(offset + 1), Some(b'}' | b']')) {
                    output.push('\n');
                    output.push_str(&"  ".repeat(depth));
                }
            }
            '}' | ']' => {
                depth -= 1;
                if offset > 0 && !matches!(bytes.get(offset - 1), Some(b'{' | b'[')) {
                    output.push('\n');
                    output.push_str(&"  ".repeat(depth));
                }
                output.push(ch);
            }
            ',' => {
                output.push_str(",\n");
                output.push_str(&"  ".repeat(depth));
            }
            ':' => output.push_str(": "),
            _ => output.push(ch),
        }
    }
    output
}

fn envelope(kind: &str, version: u32, data: Option<&str>) -> String {
    let timestamp = js::json_quote_str(&crate::session_records::iso_timestamp_now());
    let head = format!(
        "{{\"__multiccSchema\":{{\"kind\":{},\"version\":{version},\"writtenAt\":{}}}}}",
        js::json_quote_str(kind),
        timestamp,
    );
    match data {
        // `JSON.stringify({ …, data: undefined })` drops the key entirely.
        None => head,
        Some(data) => {
            let mut out = head;
            out.pop(); // trailing `}`
            out.push_str(",\"data\":");
            out.push_str(data);
            out.push('}');
            out
        }
    }
}

pub fn save(file: &Path, kind: &str, data: &JsValue) -> Result<(), String> {
    save_compact(file, kind, &js::json_stringify(data).expect("JSON payload"))
}

/// Same file and envelope as [`save`], but the `data` document is already
/// serialized by the host engine. This keeps every JS formatting decision
/// (`-0`, lone surrogates, key order) byte-exact while Rust still owns the
/// envelope, rollback rotation and fsync.
pub fn save_compact(file: &Path, kind: &str, data: &str) -> Result<(), String> {
    save_compact_with(file, kind, 1, 3, Some(data))
}

/// General form used by the cross-file journal: the transaction journal keeps
/// no rolling backups (each name is single-use) and may describe a payload that
/// is absent (a journal file entry without `payload`).
pub fn save_compact_with(
    file: &Path,
    kind: &str,
    version: u32,
    rotate: usize,
    data: Option<&str>,
) -> Result<(), String> {
    let compact = envelope(kind, version, data);
    crate::state_file::write_text_atomic_before_rename(
        file,
        &pretty_compact(&compact),
        0o600,
        0o700,
        || {
            for index in (1..=rotate).rev() {
                let source = if index == 1 {
                    file.to_path_buf()
                } else {
                    backup(file, index - 1)
                };
                let destination = backup(file, index);
                if source.exists() {
                    // Match StateStore: failed backup rotation does not suppress a
                    // successful primary write. Never include payloads in warnings.
                    if fs::rename(&source, &destination).is_err() {
                        eprintln!("[multicc/state-store] backup rotation failed");
                        continue;
                    }
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        if fs::set_permissions(&destination, fs::Permissions::from_mode(0o600))
                            .is_err()
                        {
                            eprintln!("[multicc/state-store] backup permission update failed");
                        }
                    }
                }
            }
            Ok(())
        },
    )
    .map_err(|_| "STATE_WRITE_FAILED: state write failed".into())
}
