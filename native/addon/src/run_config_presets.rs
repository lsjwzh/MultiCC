use multicc_core::run_config_presets;
use napi::Result;
use napi_derive::napi;

// 同步的纯 JSON 变换：Rust 决定校验、归一化与合并，文件读写仍归宿主的 Node 路由。
#[napi]
pub fn normalize_run_config_presets(input: String) -> Result<String> {
    run_config_presets::normalize(&input).map_err(napi::Error::from_reason)
}

#[napi]
pub fn merge_run_config_presets(input: String) -> Result<String> {
    run_config_presets::merge(&input).map_err(napi::Error::from_reason)
}
