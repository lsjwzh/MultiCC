use multicc_core::subagent_defaults;
use napi::Result;
use napi_derive::napi;

// 同步的元数据变换：Rust 决定归一化与同步计划，磁盘与会话写入仍归宿主。
#[napi]
pub fn normalize_subagent_defaults(input: String) -> Result<String> {
    subagent_defaults::normalize(&input).map_err(napi::Error::from_reason)
}

#[napi]
pub fn plan_subagent_sync(input: String) -> Result<String> {
    subagent_defaults::plan_sync(&input).map_err(napi::Error::from_reason)
}
