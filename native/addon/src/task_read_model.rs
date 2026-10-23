use crate::NativeResult;
use multicc_core::task_read_model::ReadModel;
use napi::{bindgen_prelude::AsyncTask, Env, Result, Task};
use napi_derive::napi;
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

#[napi]
pub struct RustTaskReadModel {
    state: Arc<Mutex<ReadModel>>,
}
pub struct ReadJob {
    state: Arc<Mutex<ReadModel>>,
    input: String,
}
impl Task for ReadJob {
    type Output = NativeResult;
    type JsValue = NativeResult;
    fn compute(&mut self) -> Result<NativeResult> {
        let start = Instant::now();
        let result = self
            .state
            .lock()
            .map_err(|_| napi::Error::from_reason("read_model_unavailable"))?
            .run(&self.input)
            .map_err(napi::Error::from_reason)?;
        Ok(NativeResult {
            result,
            compute_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    }
    fn resolve(&mut self, _: Env, result: NativeResult) -> Result<NativeResult> {
        Ok(result)
    }
}
#[napi]
impl RustTaskReadModel {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(ReadModel::default())),
        }
    }
    #[napi]
    pub fn run(&self, input: String) -> AsyncTask<ReadJob> {
        AsyncTask::new(ReadJob {
            state: self.state.clone(),
            input,
        })
    }
}
impl Default for RustTaskReadModel {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
pub fn task_read_model_protocol_version() -> u32 {
    1
}
