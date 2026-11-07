// napi wrappers for the bind/port policy. The rules live in
// `multicc_core::network_policy`; this file only marshals strings and numbers.
// `src/network-policy.js` is a thin bridge onto these functions.

use multicc_core::network_policy as policy;
use napi_derive::napi;
use serde_json::Value;

fn reason(message: String) -> napi::Error {
    napi::Error::from_reason(message)
}

/// `resolveNetworkPolicy(env)` — the answer is the JSON object the JS caller
/// expects, and the error text is the JS error message unchanged.
#[napi]
pub fn network_policy_resolve(env_json: String) -> napi::Result<String> {
    let request: Value = serde_json::from_str(&env_json)
        .map_err(|error| reason(format!("invalid_network_policy_request: {error}")))?;
    let Value::Object(env) = request else {
        return Err(reason(
            "invalid_network_policy_request: env must be an object".into(),
        ));
    };
    let resolved = policy::resolve_network_policy(&env).map_err(reason)?;
    serde_json::to_string(&resolved).map_err(|error| reason(error.to_string()))
}

/// `envEnabled(value)`; the caller has already applied `String(value || '')`.
#[napi]
pub fn network_policy_env_enabled(value: String) -> bool {
    policy::env_enabled(&value)
}

/// `isLoopbackHost(host)`; the caller has already applied `String(host || '')`.
#[napi]
pub fn network_policy_is_loopback_host(host: String) -> bool {
    policy::is_loopback_host(&host)
}

/// `findAvailablePort(startPort, host, { maxTries })`, synchronously.
#[napi]
pub fn network_policy_find_available_port(
    start: f64,
    host: String,
    max_tries: Option<f64>,
) -> napi::Result<u32> {
    if !start.is_finite() || start.fract() != 0.0 {
        return Err(reason(format!(
            "No available port from {} on {host}",
            serde_json::Number::from_f64(start)
                .map(|number| number.to_string())
                .unwrap_or_else(|| "NaN".into())
        )));
    }
    let max_tries = max_tries.unwrap_or(100.0);
    let max_tries = if max_tries.is_finite() {
        max_tries.trunc() as i64
    } else {
        0
    };
    policy::find_available_port(start as i64, &host, max_tries)
        .map(u32::from)
        .map_err(reason)
}
