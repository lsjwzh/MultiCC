use napi::Result;
use napi_derive::napi;

/// 固定大小的纯决策，无文件或网络操作，可同步供 Node 兼容层调用。
#[napi]
pub fn plan_claude_expired_refresh(input_json: String) -> Result<String> {
    multicc_core::claude_refresh::plan(&input_json).map_err(napi::Error::from_reason)
}
