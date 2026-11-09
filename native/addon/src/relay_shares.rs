//! The addon owns only a thread-safe handle; all authority and persistence
//! remain in core. Expensive crypto and every mutation run off the JS thread.
use multicc_core::{js, relay_shares::Store};
use napi::{bindgen_prelude::AsyncTask, Env, Result, Task};
use napi_derive::napi;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[napi]
pub struct RustRelayShares {
    inner: Arc<Mutex<Store>>,
}
#[napi]
impl RustRelayShares {
    #[napi(constructor)]
    pub fn new(file: String, key_file: Option<String>) -> Result<Self> {
        // Startup-only small-state load, preserving fail-closed construction.
        let store = Store::open(PathBuf::from(file), key_file.map(PathBuf::from))
            .map_err(napi::Error::from_reason)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(store)),
        })
    }
    #[napi]
    pub fn run(&self, operation: String, input: String, now: Option<f64>) -> AsyncTask<RelayTask> {
        AsyncTask::new(RelayTask {
            inner: self.inner.clone(),
            operation,
            input,
            now,
        })
    }
}
pub struct RelayTask {
    inner: Arc<Mutex<Store>>,
    operation: String,
    input: String,
    now: Option<f64>,
}
impl Task for RelayTask {
    type Output = String;
    type JsValue = String;
    fn compute(&mut self) -> Result<String> {
        let input = js::json_parse(&self.input)
            .map_err(|_| napi::Error::from_reason("RELAY_INPUT_INVALID: invalid relay input"))?;
        let mut store = self.inner.lock().map_err(|_| {
            napi::Error::from_reason("RELAY_STORE_UNAVAILABLE: relay owner unavailable")
        })?;
        let now = self.now.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as f64)
                .unwrap_or(0.0)
        });
        let result = store
            .run(&self.operation, &input, now)
            .map_err(napi::Error::from_reason)?;
        Ok(js::json_stringify(&result).unwrap_or_else(|| "null".into()))
    }
    fn resolve(&mut self, _env: Env, result: String) -> Result<String> {
        Ok(result)
    }
}
#[napi]
pub fn relay_share_parse(kind: String, input: String) -> Result<String> {
    let value =
        js::json_parse(&input).map_err(|_| napi::Error::from_reason("RELAY_INPUT_INVALID"))?;
    let result = match kind.as_str() {
        "credential" => multicc_core::relay_shares::parse_credential(&value).map(|(id, secret)| {
            js::JsValue::object(vec![
                ("id", js::JsValue::string(&id)),
                ("secret", js::JsValue::string(&secret)),
            ])
        }),
        "target" => multicc_core::relay_shares::route_target(&value),
        "baseUrl" => multicc_core::relay_shares::relay_route(&value),
        _ => return Err(napi::Error::from_reason("RELAY_OPERATION_INVALID")),
    }
    .unwrap_or(js::JsValue::Null);
    Ok(js::json_stringify(&result).unwrap())
}
