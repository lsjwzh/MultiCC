//! Quota protection settings, answered without entering Node. Blocking file
//! access is run on the front door's store worker, like the presets routes.
use std::path::Path;

use multicc_core::js::{from_serde, JsValue};
use multicc_core::quota_guard::settings;
use serde_json::Value;

pub const FILE_NAME: &str = "quota-guard.json";

fn environment() -> JsValue {
    JsValue::object(
        std::env::vars()
            .map(|(key, value)| (key, value.into()))
            .collect(),
    )
}

pub fn get(root: &Path) -> (u16, JsValue) {
    (200, settings::view(&root.join(FILE_NAME), &environment()))
}

pub fn put(root: &Path, body: &Value) -> (u16, JsValue) {
    settings::put(&root.join(FILE_NAME), &environment(), &from_serde(body))
}
