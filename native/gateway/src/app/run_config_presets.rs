//! `/api/run-config/presets` (was src/routes/run-config-presets.js): the
//! cross-device library of saved Auto candidate pools. Web localStorage and
//! the App's SharedPreferences are caches; `<data>/run-config-presets.json`
//! is the source of truth. Validation and merge are the
//! `multicc_core::run_config_presets` kernel; this file is the request shape,
//! the atomic write and the status codes the Node route had.

use std::path::Path;

use multicc_core::js::serde::js_json_stringify;
use multicc_core::{run_config_presets, state_file};
use serde_json::{json, Value};

use super::express::js_json_value;

/// Normalized there are at most 20 named + 5 recent presets; anything longer
/// is refused instead of truncated.
pub const MAX_BODY_ENTRIES: usize = 100;
pub const FILE_NAME: &str = "run-config-presets.json";

fn unavailable() -> (u16, Value) {
    (
        503,
        json!({
            "error": "运行配置预设接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
    )
}

/// A missing or corrupt file reads as no presets (they are rebuildable).
fn read_stored(file: &Path) -> Value {
    let Ok(bytes) = std::fs::read(file) else {
        return json!([]);
    };
    match js_json_value(&String::from_utf8_lossy(&bytes)) {
        Some(Value::Object(object)) => match object.get("presets") {
            Some(Value::Array(list)) => Value::Array(list.clone()),
            _ => json!([]),
        },
        _ => json!([]),
    }
}

fn preset_list(body: &Value) -> Result<&Vec<Value>, String> {
    let list = match body {
        Value::Object(object) => object.get("presets"),
        _ => None,
    };
    let Some(Value::Array(list)) = list else {
        return Err("presets 必须是数组".into());
    };
    if list.len() > MAX_BODY_ENTRIES {
        return Err(format!("presets 最多 {MAX_BODY_ENTRIES} 条"));
    }
    Ok(list)
}

fn presets_of(output: &str) -> Value {
    match js_json_value(output) {
        Some(Value::Object(object)) => match object.get("presets") {
            Some(Value::Array(list)) => Value::Array(list.clone()),
            _ => json!([]),
        },
        _ => json!([]),
    }
}

fn invalid(error: String) -> (u16, Value) {
    let message = if error.is_empty() {
        "预设格式不正确".to_string()
    } else {
        error
    };
    (400, json!({ "error": message, "code": "invalid_presets" }))
}

fn persist_and_answer(file: &Path, presets: Value) -> (u16, Value) {
    if state_file::write_json_atomic(file, &json!({ "version": 1, "presets": presets })).is_err() {
        return (
            500,
            json!({ "error": "预设保存失败", "code": "preset_store_write_failed" }),
        );
    }
    (200, json!({ "ok": true, "presets": presets }))
}

/// `GET /api/run-config/presets`.
pub fn get(data_root: &Path) -> (u16, Value) {
    let input = js_json_stringify(&json!({ "presets": read_stored(&data_root.join(FILE_NAME)) }));
    match run_config_presets::normalize(&input) {
        Ok(output) => (200, json!({ "ok": true, "presets": presets_of(&output) })),
        Err(_) => unavailable(),
    }
}

/// `PUT /api/run-config/presets`: replace the whole list.
pub fn put(data_root: &Path, body: &Value) -> (u16, Value) {
    let list = match preset_list(body) {
        Ok(list) => list,
        Err(error) => return (400, json!({ "error": error, "code": "invalid_presets" })),
    };
    let input = js_json_stringify(&json!({ "presets": list }));
    match run_config_presets::normalize(&input) {
        Ok(output) => persist_and_answer(&data_root.join(FILE_NAME), presets_of(&output)),
        Err(error) => invalid(error),
    }
}

/// `POST /api/run-config/presets/merge`: fold this device's entries in.
pub fn merge(data_root: &Path, body: &Value) -> (u16, Value) {
    let list = match preset_list(body) {
        Ok(list) => list,
        Err(error) => return (400, json!({ "error": error, "code": "invalid_presets" })),
    };
    let file = data_root.join(FILE_NAME);
    let input = js_json_stringify(&json!({ "stored": read_stored(&file), "incoming": list }));
    match run_config_presets::merge(&input) {
        Ok(output) => persist_and_answer(&file, presets_of(&output)),
        Err(error) => invalid(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "multicc-presets-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn preset(id: &str, saved_at: i64) -> Value {
        json!({
            "id": id, "name": id, "protocol": "anthropic", "savedAt": saved_at,
            "candidates": [{"providerId": "a", "model": "m"}, {"providerId": "b", "model": "m"}],
        })
    }

    #[test]
    fn missing_and_corrupt_files_read_as_empty() {
        let dir = temp("empty");
        assert_eq!(get(&dir), (200, json!({"ok": true, "presets": []})));
        std::fs::write(dir.join(FILE_NAME), "\u{feff}{\"presets\":[1]}").unwrap();
        assert_eq!(get(&dir).1["presets"], json!([]));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn put_then_merge_persist_the_kernel_output() {
        let dir = temp("put");
        let (status, body) = put(&dir, &json!({ "presets": [preset("one", 1)] }));
        assert_eq!(status, 200, "{body}");
        let written = std::fs::read_to_string(dir.join(FILE_NAME)).unwrap();
        assert!(written.starts_with("{\n  \"version\": 1,\n  \"presets\": [\n"));
        assert_eq!(get(&dir).1["presets"], body["presets"]);
        let (status, merged) = merge(&dir, &json!({ "presets": [preset("two", 2)] }));
        assert_eq!(status, 200);
        let ids: Vec<_> = merged["presets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids, ["two", "one"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn bad_bodies_are_refused_without_writing() {
        let dir = temp("bad");
        assert_eq!(
            put(&dir, &json!({})),
            (
                400,
                json!({"error": "presets 必须是数组", "code": "invalid_presets"})
            )
        );
        assert_eq!(put(&dir, &json!([])).0, 400);
        let many: Vec<Value> = (0..101).map(|i| preset(&format!("p{i}"), i)).collect();
        assert_eq!(
            merge(&dir, &json!({ "presets": many })),
            (
                400,
                json!({"error": "presets 最多 100 条", "code": "invalid_presets"})
            )
        );
        assert!(!dir.join(FILE_NAME).exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_unwritable_store_is_a_500() {
        let dir = temp("ro");
        std::fs::create_dir_all(dir.join(FILE_NAME)).unwrap();
        assert_eq!(
            put(&dir, &json!({ "presets": [] })),
            (
                500,
                json!({"error": "预设保存失败", "code": "preset_store_write_failed"})
            )
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
