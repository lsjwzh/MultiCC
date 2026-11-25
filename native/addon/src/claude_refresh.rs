use napi::Result;
use napi_derive::napi;

/// 固定大小的纯决策，无文件或网络操作，可同步供 Node 兼容层调用。
#[napi]
pub fn plan_claude_expired_refresh(input_json: String) -> Result<String> {
    multicc_core::claude_refresh::plan(&input_json).map_err(napi::Error::from_reason)
}

/// The planner's unsigned budget and boolean decisions are already validated.
#[napi(object)]
pub struct RefreshDecision {
    pub recover_parked: bool,
    pub allow_probe: bool,
    pub reserve_post_expiry: bool,
    pub budget_floor: u32,
}
#[napi]
pub fn claude_refresh_decision(input: String) -> Result<RefreshDecision> {
    let plan = multicc_core::claude_refresh::decision(&input).map_err(napi::Error::from_reason)?;
    Ok(RefreshDecision {
        recover_parked: plan.recover_parked,
        allow_probe: plan.allow_probe,
        reserve_post_expiry: plan.reserve_post_expiry,
        budget_floor: plan.budget_floor,
    })
}
