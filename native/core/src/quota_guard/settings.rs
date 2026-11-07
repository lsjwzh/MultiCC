//! The sole writer of quota-guard.json. Both runtime and HTTP use the policy
//! above; settings keep unknown saved fields and the original validation order.
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use super::{
    defaults, env_config, merge, normalize_config, object, reading_age_of, set, PERCENT_KEYS,
};
use crate::js::{js_to_number, js_to_string, json_parse, json_stringify, truthy, JsValue};

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn read_saved(file: &Path) -> JsValue {
    std::fs::read(file)
        .ok()
        .and_then(|bytes| json_parse(&String::from_utf8_lossy(&bytes)).ok())
        .filter(|value| matches!(value, JsValue::Object(_)))
        .unwrap_or_else(|| object(vec![]))
}

pub fn view(file: &Path, env: &JsValue) -> JsValue {
    let saved = read_saved(file);
    let overrides = env_config(env);
    let keys = match &overrides {
        JsValue::Object(entries) => entries
            .iter()
            .map(|(key, _)| JsValue::String(key.clone()))
            .collect(),
        _ => vec![],
    };
    object(vec![
        ("ok", true.into()),
        (
            "config",
            normalize_config(&merge(&merge(&defaults(), &saved), &overrides)),
        ),
        ("saved", saved),
        ("defaults", defaults()),
        ("envOverrides", JsValue::Array(keys)),
        ("filePath", file.to_string_lossy().into_owned().into()),
    ])
}

// JSON.stringify(value, null, 2) for parsed JSON, preserving UTF-16 labels,
// key order, empty containers, JS number spelling, and the final newline.
fn pretty(value: &JsValue, depth: usize) -> String {
    let pad = "  ".repeat(depth + 1);
    let (open, close, parts) = match value {
        JsValue::Object(entries) if !entries.is_empty() => (
            "{",
            "}",
            entries
                .iter()
                .map(|(key, value)| {
                    format!(
                        "{}: {}",
                        crate::js::json_quote(key),
                        pretty(value, depth + 1)
                    )
                })
                .collect::<Vec<_>>(),
        ),
        JsValue::Array(items) if !items.is_empty() => (
            "[",
            "]",
            items.iter().map(|value| pretty(value, depth + 1)).collect(),
        ),
        _ => return json_stringify(value).unwrap_or_else(|| "null".into()),
    };
    format!(
        "{open}\n{pad}{}\n{}{close}",
        parts.join(&format!(",\n{pad}")),
        "  ".repeat(depth)
    )
}

// Preserve libuv's public error shape rather than exposing Rust's OS-specific
// Display formatting. Temporary names are internal and differ per process.
fn fs_error(
    error: std::io::Error,
    syscall: &str,
    path: &Path,
    dest: Option<&Path>,
) -> std::io::Error {
    use std::io::ErrorKind;
    let (code, description) = match error.kind() {
        ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        ErrorKind::NotADirectory => ("ENOTDIR", "not a directory"),
        ErrorKind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        ErrorKind::AlreadyExists => ("EEXIST", "file already exists"),
        ErrorKind::StorageFull => ("ENOSPC", "no space left on device"),
        _ => ("EIO", "i/o error"),
    };
    let destination = dest
        .map(|dest| format!(" -> '{}'", dest.display()))
        .unwrap_or_default();
    std::io::Error::new(
        error.kind(),
        format!(
            "{code}: {description}, {syscall} '{}'{destination}",
            path.display()
        ),
    )
}

pub fn write_atomic(file: &Path, value: &JsValue) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut tmp = file.as_os_str().to_os_string();
    tmp.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let tmp = std::path::PathBuf::from(tmp);
    let mut created = false;
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o644);
        }
        let mut handle = options
            .open(&tmp)
            .map_err(|error| fs_error(error, "open", &tmp, None))?;
        created = true;
        handle
            .write_all(format!("{}\n", pretty(value, 0)).as_bytes())
            .map_err(|error| fs_error(error, "write", &tmp, None))?;
        drop(handle);
        std::fs::rename(&tmp, file).map_err(|error| fs_error(error, "rename", &tmp, Some(file)))
    })();
    if created && result.is_err() {
        let _ = std::fs::remove_file(tmp);
    }
    result
}

fn invalid(message: String) -> (u16, JsValue) {
    (
        400,
        object(vec![("ok", false.into()), ("error", message.into())]),
    )
}

pub fn put(file: &Path, env: &JsValue, body: &JsValue) -> (u16, JsValue) {
    let mut next = read_saved(file);
    for key in PERCENT_KEYS {
        let Some(value) = body.get(key) else {
            continue;
        };
        let number = js_to_number(value);
        if value.is_nullish()
            || matches!(value, JsValue::String(text) if text.is_empty())
            || !number.is_finite()
        {
            return invalid(format!("{key}: 必须是 1–100 的数字"));
        }
        if !(1.0..=100.0).contains(&number) {
            return invalid(format!("{key}: 必须在 1–100 之间"));
        }
        set(&mut next, key, number.into());
    }
    if let Some(value) = body.get("enabled") {
        if !matches!(value, JsValue::Bool(_)) {
            return invalid("enabled: 必须是布尔值".into());
        }
        set(&mut next, "enabled", value.clone());
    }
    if let Some(value) = body.get("scope") {
        let scope = if truthy(value) {
            js_to_string(value).trim().to_lowercase().to_string_lossy()
        } else {
            String::new()
        };
        if !matches!(scope.as_str(), "official" | "all") {
            return invalid("scope: 只能是 official 或 all".into());
        }
        set(&mut next, "scope", scope.into());
    }
    if let Some(value) = body.get("maxReadingAgeMs") {
        let Some(number) = reading_age_of(value) else {
            return invalid("maxReadingAgeMs: 必须是 60000–604800000 之间的毫秒数".into());
        };
        set(&mut next, "maxReadingAgeMs", number.into());
    }
    if !PERCENT_KEYS
        .into_iter()
        .chain(["enabled", "scope", "maxReadingAgeMs"])
        .any(|key| body.get(key).is_some())
    {
        return invalid("没有可保存的设置".into());
    }
    if let Err(error) = write_atomic(file, &next) {
        return (
            500,
            object(vec![
                ("ok", false.into()),
                ("error", format!("写入失败：{error}").into()),
            ]),
        );
    }
    (200, view(file, env))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quota_guard::{prop, Guard};

    #[test]
    fn saved_utf16_unknown_fields_and_runtime_cache_survive_a_partial_write() {
        let root = std::env::temp_dir().join(format!(
            "quota-settings-{}-{}",
            std::process::id(),
            super::COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("quota-guard.json");
        std::fs::write(&file, r#"{"unknown":"\ud800","weeklyPercent":90}"#).unwrap();
        let env = object(vec![]);
        let mut guard = Guard::new(Some(file.clone()));
        assert_eq!(
            prop(&guard.config(&env, 10_000.0), "weeklyPercent"),
            &90.0.into()
        );
        let (status, result) = put(&file, &env, &object(vec![("weeklyPercent", 80.0.into())]));
        assert_eq!(status, 200);
        assert_eq!(
            prop(prop(&result, "saved"), "unknown"),
            &JsValue::String(crate::js::JsString::from_units(vec![0xd800]))
        );
        assert!(std::fs::read_to_string(&file)
            .unwrap()
            .contains(r#""unknown": "\ud800""#));
        assert_eq!(
            prop(&guard.config(&env, 14_999.0), "weeklyPercent"),
            &90.0.into()
        );
        assert_eq!(
            prop(&guard.config(&env, 15_000.0), "weeklyPercent"),
            &80.0.into()
        );
        std::fs::write(&file, "{broken").unwrap();
        assert_eq!(
            prop(&guard.config(&env, 20_000.0), "weeklyPercent"),
            &98.0.into()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
