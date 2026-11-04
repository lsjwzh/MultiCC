use napi::{bindgen_prelude::AsyncTask, Env, Result, Task};
use napi_derive::napi;

pub struct ReadContext {
    input: String,
}
impl Task for ReadContext {
    type Output = String;
    type JsValue = String;
    fn compute(&mut self) -> Result<String> {
        multicc_core::opencode_context::read(&self.input).map_err(napi::Error::from_reason)
    }
    fn resolve(&mut self, _: Env, value: String) -> Result<String> {
        Ok(value)
    }
}

#[napi]
pub fn read_opencode_context(input: String) -> AsyncTask<ReadContext> {
    AsyncTask::new(ReadContext { input })
}

#[napi]
pub fn plan_opencode_context(input: String) -> Result<String> {
    multicc_core::opencode_context::plan(&input).map_err(napi::Error::from_reason)
}
