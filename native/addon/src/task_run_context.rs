use multicc_core::task_run_context;
use napi::Result;
use napi_derive::napi;

// Pure transform: board record + turn refs in, context wall out.
#[napi]
pub fn build_task_run_context(input: String) -> Result<String> {
    task_run_context::build(&input).map_err(napi::Error::from_reason)
}
