//! Worker-based bridge for the new provider-limit SQLite owner. The migration
//! does not yet connect this handle to production: several callers still
//! require synchronous results and need an async admission path first.
use std::{
    collections::HashSet,
    path::Path,
    sync::{Arc, Mutex},
};

use multicc_core::{
    js::{js_to_number, js_to_string, JsValue},
    provider_limit_store::Store,
    quota_guard::prop,
};
use napi::{
    bindgen_prelude::{AsyncTask, JsValue as _, Unknown},
    Env, Result, ScopedTask,
};
use napi_derive::napi;

#[napi]
pub struct RustProviderLimitStore {
    state: Arc<Mutex<Option<Store>>>,
}

impl Default for RustProviderLimitStore {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl RustProviderLimitStore {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(None)),
        }
    }

    #[napi]
    pub fn request_async(
        &self,
        env: Env,
        op: String,
        input: Unknown<'_>,
    ) -> Result<AsyncTask<LimitStoreRequest>> {
        let input =
            unsafe { crate::js_bridge::read_value(env.raw(), input.raw(), 0, &mut Vec::new()) }?;
        Ok(AsyncTask::new(LimitStoreRequest {
            state: Arc::clone(&self.state),
            op,
            input,
        }))
    }
}

pub struct LimitStoreRequest {
    state: Arc<Mutex<Option<Store>>>,
    op: String,
    input: JsValue,
}

impl<'task> ScopedTask<'task> for LimitStoreRequest {
    type Output = JsValue;
    type JsValue = Unknown<'task>;

    fn compute(&mut self) -> Result<JsValue> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| napi::Error::from_reason("provider_limit_store_poisoned"))?;
        if self.op == "openExisting" || self.op == "openWithoutLegacy" || self.op == "open" {
            if state.is_some() {
                return Err(napi::Error::from_reason(
                    "provider_limit_store_already_open",
                ));
            }
            let file = js_to_string(prop(&self.input, "file")).to_string_lossy();
            let store = if self.op == "openExisting" {
                Store::open_existing(Path::new(&file)).map(|store| (store, JsValue::Bool(true)))
            } else {
                let legacy = prop(&self.input, "legacyFile");
                let legacy = if legacy.is_nullish() {
                    None
                } else {
                    Some(js_to_string(legacy).to_string_lossy())
                };
                if self.op == "open" {
                    Store::open(
                        Path::new(&file),
                        legacy.as_deref().map(Path::new),
                        js_to_number(prop(&self.input, "now")),
                    )
                } else {
                    Store::open_without_legacy(
                        Path::new(&file),
                        legacy.as_deref().map(Path::new),
                        js_to_number(prop(&self.input, "now")),
                    )
                    .map(|store| (store, JsValue::Bool(true)))
                }
            };
            let (store, migration) = store.map_err(napi::Error::from_reason)?;
            *state = Some(store);
            return Ok(migration);
        }
        if self.op == "close" {
            state.take();
            return Ok(JsValue::Bool(true));
        }
        let store = state
            .as_mut()
            .ok_or_else(|| napi::Error::from_reason("provider_limit_store_closed"))?;
        let app_type = js_to_string(prop(&self.input, "appType")).to_string_lossy();
        let provider_id = js_to_string(prop(&self.input, "providerId")).to_string_lossy();
        let result = match self.op.as_str() {
            "get" => store
                .get(&app_type, &provider_id)
                .map(|v| v.unwrap_or(JsValue::Null)),
            "snapshot" => store.snapshot(),
            "record" => store.record(
                &app_type,
                &provider_id,
                prop(&self.input, "entry"),
                js_to_number(prop(&self.input, "now")),
            ),
            "recordFailure" => store.record_failure(
                &app_type,
                &provider_id,
                prop(&self.input, "meta"),
                js_to_number(prop(&self.input, "now")),
            ),
            "recordDerived" => {
                let operation = js_to_string(prop(&self.input, "operation")).to_string_lossy();
                store.record_derived(
                    &app_type,
                    &provider_id,
                    &operation,
                    prop(&self.input, "arguments"),
                    js_to_number(prop(&self.input, "now")),
                )
            }
            "transitionAvailability" => store.transition_availability(
                &app_type,
                &provider_id,
                prop(&self.input, "arguments"),
                js_to_number(prop(&self.input, "now")),
            ),
            "recordVirtualFailure" => store.record_virtual_failure(
                &app_type,
                &provider_id,
                prop(&self.input, "arguments"),
                js_to_number(prop(&self.input, "now")),
            ),
            "prune" => {
                let JsValue::Array(keys) = prop(&self.input, "liveKeys") else {
                    return Err(napi::Error::from_reason(
                        "provider_limit_store_invalid_live_keys",
                    ));
                };
                let keys = keys
                    .iter()
                    .map(|key| js_to_string(key).to_string_lossy())
                    .collect::<HashSet<_>>();
                store
                    .prune(&keys)
                    .map(|count| JsValue::Number(count as f64))
            }
            _ => {
                return Err(napi::Error::from_reason(
                    "provider_limit_store_unknown_operation",
                ))
            }
        };
        result.map_err(|error| napi::Error::from_reason(format!("provider_limit_store: {error}")))
    }

    fn resolve(&mut self, env: &'task Env, output: JsValue) -> Result<Unknown<'task>> {
        let raw = unsafe { crate::js_bridge::write_value(env.raw(), &output) }?;
        Ok(unsafe { Unknown::from_raw_unchecked(env.raw(), raw) })
    }
}
