use multicc_core::virtual_provider;
use napi::{bindgen_prelude::AsyncTask, Env, Result, Task};
use napi_derive::napi;
#[napi]
pub fn validate_virtual_provider(input: String) -> Result<String> {
    virtual_provider::validate(&input).map_err(napi::Error::from_reason)
}
#[napi]
pub fn select_virtual_provider(input: String) -> Result<String> {
    virtual_provider::select(&input).map_err(napi::Error::from_reason)
}
#[napi]
pub fn virtual_provider_failure(input: String) -> Result<String> {
    virtual_provider::failure(&input).map_err(napi::Error::from_reason)
}
#[napi]
pub fn parse_account_subscription(input: String) -> Result<String> {
    multicc_core::subscription::parse(&input).map_err(napi::Error::from_reason)
}

#[napi]
pub fn project_account_subscriptions(input: String) -> Result<String> {
    multicc_core::subscription_cache::project(&input).map_err(napi::Error::from_reason)
}

pub struct SubscriptionJob {
    file: String,
    input: String,
}
impl Task for SubscriptionJob {
    type Output = String;
    type JsValue = String;
    fn compute(&mut self) -> Result<String> {
        multicc_core::subscription_cache::access(&self.file, &self.input)
            .map_err(napi::Error::from_reason)
    }
    fn resolve(&mut self, _: Env, value: String) -> Result<String> {
        Ok(value)
    }
}
#[napi]
pub fn account_subscription_cache(file: String, input: String) -> AsyncTask<SubscriptionJob> {
    AsyncTask::new(SubscriptionJob { file, input })
}
