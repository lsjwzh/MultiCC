// napi wrappers for the Auto Provider contract. The rules live in
// `multicc_core::auto_provider_config`; this file only marshals JSON strings.
// Every function is synchronous and pure (it may drive the caller's deferred
// probe protocol, but performs no I/O itself).

use napi::Result;
use napi_derive::napi;

fn reason(error: String) -> napi::Error {
    napi::Error::from_reason(error)
}

#[napi]
pub fn auto_provider_facts(request: String) -> Result<String> {
    multicc_core::auto_provider_config::facts(&request).map_err(reason)
}

#[napi]
pub fn validate_provider_selection(request: String) -> Result<String> {
    multicc_core::auto_provider_config::validate_provider_selection(&request).map_err(reason)
}

#[napi]
pub fn normalize_stored_provider_selection(request: String) -> Result<String> {
    multicc_core::auto_provider_config::normalize_stored_provider_selection(&request)
        .map_err(reason)
}

#[napi]
pub fn provider_selection_dto(request: String) -> Result<String> {
    multicc_core::auto_provider_config::provider_selection_dto(&request).map_err(reason)
}

#[napi]
pub fn primary_provider_candidate(request: String) -> Result<String> {
    multicc_core::auto_provider_config::primary_provider_candidate(&request).map_err(reason)
}

#[napi]
pub fn selection_clis(request: String) -> Result<String> {
    multicc_core::auto_provider_config::selection_clis(&request).map_err(reason)
}

#[napi]
pub fn catalog_app_types(request: String) -> Result<String> {
    multicc_core::auto_provider_config::catalog_app_types(&request).map_err(reason)
}

#[napi]
pub fn protocol_of(request: String) -> Result<String> {
    multicc_core::auto_provider_config::protocol_of(&request).map_err(reason)
}

#[napi]
pub fn trust_domain_of(request: String) -> Result<String> {
    multicc_core::auto_provider_config::trust_domain_of(&request).map_err(reason)
}

#[napi]
pub fn custom_endpoint_error(request: String) -> Result<String> {
    multicc_core::auto_provider_config::custom_endpoint_error(&request).map_err(reason)
}

#[napi]
pub fn validate_routing_target(request: String) -> Result<String> {
    multicc_core::auto_provider_config::validate_routing_target(&request).map_err(reason)
}

#[napi]
pub fn jev_target(request: String) -> Result<String> {
    multicc_core::auto_provider_config::jev_target(&request).map_err(reason)
}
