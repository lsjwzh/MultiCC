use napi::{bindgen_prelude::AsyncTask, Env, Result, Task};
use napi_derive::napi;

pub struct Discover {
    input: String,
}
impl Task for Discover {
    type Output = String;
    type JsValue = String;
    fn compute(&mut self) -> Result<String> {
        multicc_core::windows_tools::scan(&self.input).map_err(napi::Error::from_reason)
    }
    fn resolve(&mut self, _: Env, output: String) -> Result<String> {
        Ok(output)
    }
}
#[napi]
pub fn windows_tools_discover(input: String) -> AsyncTask<Discover> {
    AsyncTask::new(Discover { input })
}
