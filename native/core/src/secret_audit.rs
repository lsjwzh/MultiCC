//! Append-only vault audit. Only typed metadata can reach the journal; request
//! bodies, commands, URLs, values and error messages are never accepted.
use chrono::{SecondsFormat, Utc};
use fs2::FileExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static SERIAL: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Operation {
    ListSecrets,
    RequestSecretInput,
    RunWithSecrets,
    HttpRequestWithSecret,
    List,
    Upsert,
    Remove,
    Rename,
    Reveal,
    EnvOverlay,
    EnvInject,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Input {
    operation: Operation,
    phase: String,
    #[serde(default)]
    call_id: Option<String>,
    #[serde(default)]
    parent_call_id: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    turn_id: Option<String>,
    #[serde(default)]
    task_id: Option<String>,
    #[serde(default)]
    names: Vec<String>,
    #[serde(default)]
    failed: bool,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    exit_code: Option<i32>,
    #[serde(default)]
    status: Option<u16>,
    #[serde(default)]
    timed_out: bool,
    #[serde(default)]
    aborted: bool,
    #[serde(default)]
    signaled: bool,
    #[serde(default)]
    duration_ms: Option<u64>,
}

fn identifier(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}

fn optional_id(s: Option<String>) -> Option<String> {
    s.filter(|s| identifier(s, 160))
}

pub fn record(file: &str, input: &str) -> Result<String, String> {
    let mut v: Input = serde_json::from_str(input).map_err(|_| "secret_audit_invalid_input")?;
    if !matches!(v.phase.as_str(), "started" | "completed") {
        return Err("secret_audit_invalid_input".into());
    }
    let call_id = match v.call_id {
        Some(id) if identifier(&id, 160) => id,
        None if v.phase == "started" => format!(
            "sa-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ),
        _ => return Err("secret_audit_invalid_input".into()),
    };
    v.names.retain(|s| identifier(s, 64) && !s.contains(':'));
    v.names.sort();
    v.names.dedup();
    v.names.truncate(500);
    // Codes are an explicit vocabulary: never persist arbitrary Error.code.
    let code = v.code.filter(|s| {
        matches!(
            s.as_str(),
            "invalid_arguments"
                | "unknown_secret"
                | "cwd_unavailable"
                | "spawn_failed"
                | "no_secret_placeholder"
                | "http_timeout"
                | "http_request_failed"
                | "secret_tools_unavailable"
                | "user_input_signal_rejected"
                | "secret_audit_unavailable"
        )
    });
    let outcome = if v.phase == "started" {
        "started"
    } else if v.timed_out {
        "timed_out"
    } else if v.aborted {
        "aborted"
    } else if v.failed
        || v.signaled
        || v.exit_code.is_some_and(|c| c != 0)
        || v.status.is_some_and(|s| s >= 400)
    {
        "failed"
    } else {
        "succeeded"
    };
    let operation = match v.operation {
        Operation::ListSecrets => "list_secrets",
        Operation::RequestSecretInput => "request_secret_input",
        Operation::RunWithSecrets => "run_with_secrets",
        Operation::HttpRequestWithSecret => "http_request_with_secret",
        Operation::List => "list",
        Operation::Upsert => "upsert",
        Operation::Remove => "remove",
        Operation::Rename => "rename",
        Operation::Reveal => "reveal",
        Operation::EnvOverlay => "env_overlay",
        Operation::EnvInject => "env_inject",
    };
    let event: Value = json!({
        "version": 1, "timestamp": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        "callId": call_id, "parentCallId": optional_id(v.parent_call_id),
        "operation": operation, "phase": v.phase, "outcome": outcome,
        "source": optional_id(v.source).unwrap_or_else(|| "internal".into()),
        "sessionId": optional_id(v.session_id), "turnId": optional_id(v.turn_id), "taskId": optional_id(v.task_id),
        "names": v.names, "code": code, "exitCode": v.exit_code, "status": v.status,
        "durationMs": v.duration_ms,
    });
    append(Path::new(file), &event).map_err(|_| "secret_audit_unavailable")?;
    Ok(json!({ "callId": call_id }).to_string())
}

fn append(path: &Path, event: &Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.lock_exclusive()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    let mut bytes = serde_json::to_vec(event)?;
    bytes.push(b'\n');
    file.write_all(&bytes)?;
    file.sync_data()?;
    Ok(()) // closing releases the cross-process lock
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "multicc-secret-audit-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ))
    }
    #[test]
    fn typed_projection_and_outcomes() {
        let file = temp();
        let start: Value = serde_json::from_str(&record(file.to_str().unwrap(), r#"{"operation":"reveal","phase":"started","names":["KEY","KEY","bad\nline"],"sessionId":"session-1"}"#).unwrap()).unwrap();
        record(file.to_str().unwrap(), &json!({"operation":"reveal","phase":"completed","callId":start["callId"],"failed":true,"code":"sk-do-not-log"}).to_string()).unwrap();
        let rows: Vec<Value> = fs::read_to_string(&file)
            .unwrap()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect();
        assert_eq!(rows[0]["names"], json!(["KEY"]));
        assert_eq!(rows[0]["outcome"], "started");
        assert_eq!(rows[1]["outcome"], "failed");
        assert!(rows[1]["code"].is_null());
        assert_eq!(rows[0]["callId"], rows[1]["callId"]);
        assert!(record(
            file.to_str().unwrap(),
            r#"{"operation":"reveal","phase":"started","value":"sk-never"}"#
        )
        .is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_file(file).unwrap();
    }
    #[test]
    fn concurrent_writers_preserve_every_line() {
        let file = temp();
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let file = file.clone();
                std::thread::spawn(move || {
                    for _ in 0..10 {
                        record(
                            file.to_str().unwrap(),
                            r#"{"operation":"env_inject","phase":"started"}"#,
                        )
                        .unwrap();
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let raw = fs::read_to_string(&file).unwrap();
        assert_eq!(raw.lines().count(), 80);
        for line in raw.lines() {
            serde_json::from_str::<Value>(line).unwrap();
        }
        fs::remove_file(file).unwrap();
    }
    #[test]
    fn unavailable_sink_is_an_error_without_a_path() {
        let file = temp();
        fs::create_dir(&file).unwrap();
        assert_eq!(
            record(
                file.to_str().unwrap(),
                r#"{"operation":"reveal","phase":"started"}"#
            )
            .unwrap_err(),
            "secret_audit_unavailable"
        );
        fs::remove_dir(file).unwrap();
    }
}
