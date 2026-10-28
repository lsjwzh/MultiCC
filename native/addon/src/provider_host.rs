use napi::Result;
use napi_derive::napi;
#[napi]
pub fn provider_store(file: String, input: String) -> Result<String> {
    multicc_core::provider_store::access(&file, &input).map_err(napi::Error::from_reason)
}

#[napi]
pub fn provider_credential(input: String) -> Result<String> {
    let v = serde_json::from_str(&input)
        .map_err(|_| napi::Error::from_reason("CREDENTIAL_INVALID_REQUEST"))?;
    multicc_core::provider_credentials::run(&v)
        .map(|v| v.to_string())
        .map_err(napi::Error::from_reason)
}
#[napi]
pub async fn read_provider_cli_credential(input: String) -> Result<String> {
    multicc_cpr::provider_host::read_cli(&input)
        .await
        .map(|v| v.to_string())
        .map_err(napi::Error::from_reason)
}

#[napi]
pub async fn account_subscription_plan(input: String) -> Result<String> {
    let v = serde_json::from_str(&input)
        .map_err(|_| napi::Error::from_reason("SUBSCRIPTION_INVALID_REQUEST"))?;
    multicc_cpr::provider_host::subscription_plan(v)
        .await
        .map(|v| v.to_string())
        .map_err(napi::Error::from_reason)
}
#[napi]
pub fn account_subscription_result(input: String) -> Result<String> {
    let v = serde_json::from_str(&input)
        .map_err(|_| napi::Error::from_reason("SUBSCRIPTION_INVALID_REQUEST"))?;
    Ok(multicc_cpr::provider_host::subscription_result(&v).to_string())
}
#[napi]
pub async fn query_account_subscription(input: String) -> Result<String> {
    let v = serde_json::from_str(&input)
        .map_err(|_| napi::Error::from_reason("SUBSCRIPTION_INVALID_REQUEST"))?;
    Ok(multicc_cpr::provider_host::subscription_query(v)
        .await
        .to_string())
}

#[napi]
pub struct RustProviderRequest {
    inner: multicc_core::provider_request::Request,
}
#[napi]
impl RustProviderRequest {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Default::default(),
        }
    }
    #[napi]
    pub fn choose(&mut self, input: String) -> Result<String> {
        let v = serde_json::from_str(&input)
            .map_err(|_| napi::Error::from_reason("PROVIDER_REQUEST_INVALID_INPUT"))?;
        self.inner
            .choose(v)
            .map(|v| v.to_string())
            .map_err(napi::Error::from_reason)
    }
    #[napi]
    pub fn outcome(&mut self, input: String) -> Result<String> {
        let v = serde_json::from_str(&input)
            .map_err(|_| napi::Error::from_reason("PROVIDER_REQUEST_INVALID_INPUT"))?;
        self.inner
            .outcome(v)
            .map(|v| v.to_string())
            .map_err(napi::Error::from_reason)
    }
    #[napi]
    pub fn commit(&mut self) {
        self.inner.commit();
    }
    #[napi]
    pub fn cancel(&mut self) {
        self.inner.cancel();
    }
}
impl Default for RustProviderRequest {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
pub async fn authorize_provider_request(input: String) -> Result<String> {
    tokio::task::spawn_blocking(move || {
        let v = serde_json::from_str(&input)
            .map_err(|_| "HOP_CREDENTIAL_INVALID_REQUEST".to_owned())?;
        multicc_core::provider_authorization::authorize(&v).map(|v| v.to_string())
    })
    .await
    .map_err(|_| napi::Error::from_reason("HOP_CREDENTIAL_READ_FAILED"))?
    .map_err(napi::Error::from_reason)
}

#[napi]
pub fn codex_official_error(input: String) -> Result<String> {
    let v = serde_json::from_str(&input)
        .map_err(|_| napi::Error::from_reason("PROVIDER_REQUEST_INVALID_INPUT"))?;
    Ok(multicc_cpr::codex_official::public_error(&v).to_string())
}
