//! SQLite remains the only owner of orchestration records. Only requested rows
//! and transaction-local patches cross the direct NAPI value bridge.
use crate::guard::guard;
use multicc_core::{
    js::{from_serde, to_serde, JsString, JsValue},
    orchestration_retention::RetentionPolicy,
    orchestration_store::Store,
};
use napi::{
    bindgen_prelude::{AsyncTask, JsValue as _, Unknown},
    sys, Env, Result, ScopedTask,
};
use napi_derive::napi;
use serde_json::Value;
use std::sync::{Arc, Mutex, MutexGuard};

fn read(env: Env, value: Unknown<'_>, op: &str) -> Result<Value> {
    let mut value =
        unsafe { crate::js_bridge::read_value(env.raw(), value.raw(), 0, &mut Vec::new()) }?;
    fn pack(
        object: &mut Vec<(multicc_core::js::JsString, JsValue)>,
        field: &str,
        encoded: &str,
    ) -> Result<()> {
        if let Some(index) = object
            .iter()
            .position(|(key, _)| key == &JsString::from(field))
        {
            let (_, value) = object.remove(index);
            let raw = multicc_core::js::json_stringify(&value).ok_or_else(|| {
                napi::Error::from_reason(
                    "ORCHESTRATION_SQLITE_ERROR:record is not JSON serializable",
                )
            })?;
            object.push((encoded.into(), JsValue::string(&raw)));
        }
        Ok(())
    }
    if let JsValue::Object(root) = &mut value {
        if matches!(op, "prepare" | "select" | "selectKeys" | "count") {
            let name = if op == "prepare" {
                "changes"
            } else {
                "overrides"
            };
            if let Some((_, JsValue::Array(entries))) = root
                .iter_mut()
                .find(|(key, _)| key == &JsString::from(name))
            {
                for entry in entries {
                    if let JsValue::Object(record) = entry {
                        // A deleted entry has an undefined value and needs no body.
                        if record.iter().any(|(key, v)| {
                            key == &JsString::from("deleted") && *v == JsValue::Bool(true)
                        }) {
                            record.retain(|(key, _)| key != &JsString::from("value"));
                        } else {
                            pack(record, "value", "valueJson")?;
                        }
                    }
                }
            }
        }
        if matches!(op, "inspect" | "keys") {
            pack(root, "path", "pathJson")?;
        }
        if op == "taskActivity"
            && root.iter().any(|(key, value)| {
                key == &JsString::from("taskIds") && matches!(value, JsValue::Array(_))
            })
        {
            pack(root, "taskIds", "taskIds")?;
        }
        if let Some((_, JsValue::Object(options))) = root
            .iter_mut()
            .find(|(key, _)| key == &JsString::from("options"))
        {
            pack(options, "where", "whereJson")?;
        }
    }
    // Only identifiers/options remain here. Domain strings, including sliced
    // surrogate pairs and nested property names, are lossless raw JSON above.
    fn well_formed(value: &JsValue) -> bool {
        match value {
            JsValue::String(text) => text.is_well_formed(),
            JsValue::Array(values) => values.iter().all(well_formed),
            JsValue::Object(values) => values
                .iter()
                .all(|(key, value)| key.is_well_formed() && well_formed(value)),
            _ => true,
        }
    }
    if !well_formed(&value) {
        return Err(napi::Error::from_reason("ORCHESTRATION_SQLITE_ERROR:record identifiers and query field names must be valid Unicode"));
    }
    Ok(to_serde(&value))
}

fn write(env: Env, value: &Value) -> Result<sys::napi_value> {
    unsafe { crate::js_bridge::write_value(env.raw(), &from_serde(value)) }
}
fn lock(inner: &Mutex<Store>) -> MutexGuard<'_, Store> {
    match inner.lock() {
        Ok(store) => store,
        Err(poisoned) => {
            let mut store = poisoned.into_inner();
            let _ = store.end();
            inner.clear_poison();
            store
        }
    }
}

#[napi]
pub struct RustOrchestrationStore {
    inner: Arc<Mutex<Store>>,
}
#[napi]
impl RustOrchestrationStore {
    #[napi(constructor)]
    pub fn new(
        env: Env,
        file: String,
        legacy_file: Option<String>,
        now: f64,
        options: Unknown<'_>,
    ) -> Result<Self> {
        guard("ORCHESTRATION_STORE_PANIC", || {
            let options = read(env, options, "open")?;
            let policy = if options.get("env").is_some() {
                let mut value = serde_json::to_value(
                    RetentionPolicy::from_env_values(&options["env"])
                        .map_err(napi::Error::from_reason)?,
                )
                .map_err(|e| napi::Error::from_reason(e.to_string()))?;
                if let Some(overrides) = options["policy"].as_object() {
                    for (key, item) in overrides {
                        value[key] = item.clone();
                    }
                }
                serde_json::from_value(value)
            } else {
                serde_json::from_value(options)
            }
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
            Ok(Self {
                inner: Arc::new(Mutex::new(
                    Store::open(&file, legacy_file.as_deref(), now as i64, policy)
                        .map_err(napi::Error::from_reason)?,
                )),
            })
        })
    }
    #[napi]
    pub fn request(&self, env: Env, op: String, input: Unknown<'_>) -> Result<sys::napi_value> {
        guard("ORCHESTRATION_STORE_PANIC", || {
            let input = read(env, input, &op)?;
            let result = lock(&self.inner)
                .request(&op, &input)
                .map_err(napi::Error::from_reason)?;
            write(env, &result)
        })
    }
    #[napi]
    pub fn request_async(
        &self,
        env: Env,
        op: String,
        input: Unknown<'_>,
    ) -> Result<AsyncTask<StoreRequest>> {
        let input = read(env, input, &op)?;
        Ok(AsyncTask::new(StoreRequest {
            inner: Arc::clone(&self.inner),
            op,
            input,
        }))
    }
}

pub struct StoreRequest {
    inner: Arc<Mutex<Store>>,
    op: String,
    input: Value,
}
impl<'task> ScopedTask<'task> for StoreRequest {
    type Output = Value;
    type JsValue = Unknown<'task>;
    fn compute(&mut self) -> Result<Value> {
        guard("ORCHESTRATION_STORE_PANIC", || {
            lock(&self.inner)
                .request(&self.op, &self.input)
                .map_err(napi::Error::from_reason)
        })
    }
    fn resolve(&mut self, env: &'task Env, value: Value) -> Result<Unknown<'task>> {
        // Only the owned Rust result crossed the worker boundary. Construct the
        // JS object on the event loop, with its lifetime bound to this Env.
        let raw = unsafe { crate::js_bridge::write_value(env.raw(), &from_serde(&value)) }?;
        Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
    }
}

/// Explicit offline rollback command. Opening this source does not mutate it.
#[napi]
pub fn orchestration_store_export(
    env: Env,
    file: String,
    target: String,
) -> Result<sys::napi_value> {
    guard("ORCHESTRATION_STORE_PANIC", || {
        let value = multicc_core::orchestration_store::export_snapshot(&file, &target)
            .map_err(napi::Error::from_reason)?;
        write(env, &value)
    })
}

#[napi]
pub fn orchestration_store_protocol() -> u32 {
    2
}
