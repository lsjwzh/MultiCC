//! Bounded, fail-closed storage for the legacy provider JSON format.
//! Revisions belong to each read, not a process-global "last read".
use fs2::FileExt;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};
const LIMIT: u64 = 16 * 1024 * 1024;
static SERIAL: AtomicU64 = AtomicU64::new(0);

pub fn read(file: &Path) -> Result<Option<Value>, String> {
    let mut handle = match File::open(file) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("PROVIDER_STORE_READ_FAILED".into()),
    };
    if handle
        .metadata()
        .map_err(|_| "PROVIDER_STORE_READ_FAILED")?
        .len()
        > LIMIT
    {
        return Err("PROVIDER_STORE_TOO_LARGE".into());
    }
    let mut bytes = Vec::new();
    (&mut handle)
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "PROVIDER_STORE_READ_FAILED")?;
    if bytes.len() as u64 > LIMIT {
        return Err("PROVIDER_STORE_TOO_LARGE".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "PROVIDER_STORE_INVALID_JSON".into())
}
fn revision(v: &Option<Value>) -> String {
    format!(
        "{:x}",
        Sha1::digest(serde_json::to_vec(v).unwrap_or_default())
    )
}
fn records(v: &Option<Value>) -> Result<Vec<Value>, String> {
    match v {
        None => Ok(vec![]),
        Some(v) => v
            .as_array()
            .or_else(|| v.get("providers").and_then(Value::as_array))
            .cloned()
            .ok_or("PROVIDER_STORE_INVALID_SCHEMA".into()),
    }
}
fn private_options() -> OpenOptions {
    let mut opts = OpenOptions::new();
    opts.write(true).read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts
}
pub fn lock(file: &Path) -> Result<File, String> {
    let parent = file.parent().ok_or("PROVIDER_STORE_INVALID_PATH")?;
    if !parent.exists() {
        fs::create_dir_all(parent).map_err(|_| "PROVIDER_STORE_WRITE_FAILED")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                .map_err(|_| "PROVIDER_STORE_WRITE_FAILED")?;
        }
    }
    let mut name = file.as_os_str().to_os_string();
    name.push(".lock");
    let handle = private_options()
        .create(true)
        .truncate(false)
        .open(name)
        .map_err(|_| "PROVIDER_STORE_LOCK_FAILED")?;
    handle
        .try_lock_exclusive()
        .map_err(|_| "PROVIDER_STORE_BUSY")?;
    Ok(handle)
}
pub fn atomic_write(file: &Path, v: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(v).map_err(|_| "PROVIDER_STORE_INVALID_JSON")?;
    if bytes.len() as u64 > LIMIT {
        return Err("PROVIDER_STORE_TOO_LARGE".into());
    }
    let mut name = file.as_os_str().to_os_string();
    name.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    let temp = std::path::PathBuf::from(name);
    let result = (|| {
        let mut handle = private_options()
            .create_new(true)
            .open(&temp)
            .map_err(|_| "PROVIDER_STORE_WRITE_FAILED")?;
        handle
            .write_all(&bytes)
            .and_then(|_| handle.write_all(b"\n"))
            .and_then(|_| handle.sync_all())
            .map_err(|_| "PROVIDER_STORE_WRITE_FAILED")?;
        fs::rename(&temp, file).map_err(|_| "PROVIDER_STORE_WRITE_FAILED")?;
        #[cfg(unix)]
        File::open(file.parent().unwrap())
            .and_then(|d| d.sync_all())
            .map_err(|_| "PROVIDER_STORE_SYNC_FAILED")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
pub fn access(file: &str, input: &str) -> Result<String, String> {
    let op: Value = serde_json::from_str(input).map_err(|_| "PROVIDER_STORE_INVALID_REQUEST")?;
    let file = Path::new(file);
    // Advisory lock is never held across N-API calls. A conflicting writer fails
    // explicitly; a stale editor cannot overwrite the winning revision.
    let _guard = if op["operation"] != "read" {
        Some(lock(file)?)
    } else {
        None
    };
    let previous = read(file)?;
    let current = revision(&previous);
    if op["operation"] == "read" {
        return Ok(json!({"records": records(&previous)?, "revision":current}).to_string());
    }
    if op["operation"] != "write" || !op["records"].is_array() {
        return Err("PROVIDER_STORE_INVALID_REQUEST".into());
    }
    records(&previous)?;
    if op["revision"].as_str() != Some(&current) {
        return Err("PROVIDER_STORE_CONFLICT".into());
    }
    let mut next = previous.unwrap_or_else(|| json!([]));
    if next.is_object() {
        next["providers"] = op["records"].clone();
    } else {
        next = op["records"].clone();
    }
    atomic_write(file, &next)?;
    Ok(json!({"revision": revision(&Some(next))}).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_envelope_rejects_stale_writes_and_corruption() {
        let dir =
            std::env::temp_dir().join(format!("multicc-provider-store-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("providers.json");
        fs::write(&file, r#"{"version":3,"other":"keep","providers":[]}"#).unwrap();
        let p = file.to_str().unwrap();
        let snapshot: Value =
            serde_json::from_str(&access(p, r#"{"operation":"read"}"#).unwrap()).unwrap();
        let write =
            json!({"operation":"write","revision":snapshot["revision"],"records":[{"id":"one"}]})
                .to_string();
        access(p, &write).unwrap();
        assert_eq!(read(&file).unwrap().unwrap()["other"], "keep");
        assert_eq!(access(p, &write).unwrap_err(), "PROVIDER_STORE_CONFLICT");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::write(&file, b"broken-secret-value").unwrap();
        assert_eq!(
            access(p, r#"{"operation":"read"}"#).unwrap_err(),
            "PROVIDER_STORE_INVALID_JSON"
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "broken-secret-value");
        fs::remove_dir_all(dir).unwrap();
    }
}
