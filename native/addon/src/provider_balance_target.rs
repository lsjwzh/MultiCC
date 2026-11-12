//! Balance strategy classification for a provider's upstream base URL.
use napi_derive::napi;

#[napi]
pub fn provider_balance_strategy(base_url: String) -> Option<String> {
    multicc_core::provider_balance_target::strategy_for_base_url(&base_url).map(str::to_string)
}
