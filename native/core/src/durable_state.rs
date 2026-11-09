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
fn read(file: &Path) -> Result<Option<JsValue>, String> {
    let bytes = match fs::read(file) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("STATE_UNREADABLE: unreadable state file".into()),
    };
    let value = js::json_parse(&String::from_utf8_lossy(&bytes))
        .map_err(|_| "STATE_CORRUPTED: corrupt state JSON")?;
    if matches!(value, JsValue::Array(_)) {
        return Ok(Some(value));
    }
    if value.get("__multiccSchema").is_some_and(js::truthy) {
        if let Some(data) = value.get("data") {
            return Ok(Some(data.clone()));
        }
    }
    Err("STATE_CORRUPTED: state envelope missing".into())
}
/// Missing primary is empty, as in StateStore. Backup recovery occurs only
/// when the primary exists but is unreadable/corrupt, in most-recent order.
pub fn load_or_recover(file: &Path) -> Result<Option<JsValue>, String> {
    match read(file) {
        Ok(value) => Ok(value),
        Err(error) => {
            for index in 1..=3 {
                if let Ok(Some(value)) = read(&backup(file, index)) {
                    return Ok(Some(value));
                }
            }
            Err(error)
        }
    }
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

pub fn save(file: &Path, kind: &str, data: &JsValue) -> Result<(), String> {
    save_compact(file, kind, &js::json_stringify(data).expect("JSON payload"))
}

/// Same file and envelope as [`save`], but the `data` document is already
/// serialized by the host engine. This keeps every JS formatting decision
/// (`-0`, lone surrogates, key order) byte-exact while Rust still owns the
/// envelope, rollback rotation and fsync.
pub fn save_compact(file: &Path, kind: &str, data: &str) -> Result<(), String> {
    let timestamp = js::json_quote_str(&crate::session_records::iso_timestamp_now());
    let compact = format!(
        "{{\"__multiccSchema\":{{\"kind\":{},\"version\":1,\"writtenAt\":{}}},\"data\":{data}}}",
        js::json_quote_str(kind),
        timestamp,
    );
    crate::state_file::write_text_atomic_before_rename(
        file,
        &pretty_compact(&compact),
        0o600,
        0o700,
        || {
            for index in (1..=3).rev() {
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
