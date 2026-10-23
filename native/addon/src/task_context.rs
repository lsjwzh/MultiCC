use multicc_core::task_context;
use napi::Result;
use napi_derive::napi;

// Synchronous metadata transforms only; history I/O remains in the host.
#[napi]
pub fn plan_task_context_read(input: String) -> Result<String> {
    task_context::plan_read(&input).map_err(napi::Error::from_reason)
}

#[napi]
pub fn select_task_context_records(input: String) -> Result<String> {
    task_context::select_records(&input).map_err(napi::Error::from_reason)
}

#[napi]
pub fn rank_task_context_candidates(input: String) -> Result<String> {
    task_context::rank_candidates(&input).map_err(napi::Error::from_reason)
}
