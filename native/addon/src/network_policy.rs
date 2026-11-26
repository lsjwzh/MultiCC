//! Bind policy, borrowed host coercion and asynchronous listen-port selection.
//! The core owns bind rules; this facade preserves the live host boundary.

use crate::{host_methods::method, js_iteration::read, js_live::invoke, route_response::*};
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

fn predicate<'a>(state: L<'a>, value: L<'a>, key: &std::ffi::CStr) -> Result<L<'a>> {
    let native = state.get(c"native")?;
    let f = read(native, key)?;
    let value = string(fallback(value, "".into())?)?;
    f.call(native, &[value])
}

fn resolve<'a>(state: L<'a>, value: L<'a>) -> Result<L<'a>> {
    let value = if value.undefined()? {
        read(state.get(c"process")?, c"env")?
    } else {
        value
    };
    // Preserve lookup and call order, including toJSON getters and the native
    // error when stringify returns undefined.
    let json = state.global()?.get(c"JSON")?;
    let parse = read(json, c"parse")?;
    let native = state.get(c"native")?;
    let resolver = read(native, c"networkPolicyResolve")?;
    let serialized = call(state.global()?.get(c"JSON")?, c"stringify", &[value])?;
    let result = resolver.call(native, &[serialized])?;
    parse.call(json, &[result])
}

fn find<'a>(state: L<'a>, start: L<'a>, host: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let options = if options.undefined()? {
        fields(state, &[])?
    } else {
        options
    };
    let tries = read(options, c"maxTries")?;
    let tries = if tries.undefined()? {
        num(state, 100.0)?
    } else {
        tries
    };
    let promise = call(state.global()?.get(c"Promise")?, c"resolve", &[])?;
    let then = read(promise, c"then")?;
    let probe = call(
        state.get(c"probe")?,
        c"bind",
        &[state.from_value(&V::Undefined)?, start, host, tries],
    )?;
    call(
        state.global()?.get(c"Object")?,
        c"defineProperty",
        &[
            probe,
            text(state, "name")?,
            fields(state, &[("value", text(state, "")?)])?,
        ],
    )?;
    // The callback reads the live native method only when the microtask runs.
    // Binding errors reject this Promise; option getter errors above stay sync.
    then.call(promise, &[probe])
}

fn select<'a>(state: L<'a>, policy: L<'a>, finder: L<'a>) -> Result<L<'a>> {
    let finder = if finder.undefined()? {
        state.get(c"find")?
    } else {
        finder
    };
    if !policy.truthy()? || !read(policy, c"development")?.truthy()? {
        return read(policy, c"port");
    }
    invoke(
        state.from_value(&V::Undefined)?,
        finder,
        &[read(policy, c"port")?, read(policy, c"host")?],
        "finder",
    )
}

/// Node supplies its process object and a trivial async-function adapter. All
/// defaults, field reads, branches, probe scheduling and calls are owned here.
#[napi]
pub fn network_policy_api(
    env: Env,
    native: Unknown<'_>,
    process: Unknown<'_>,
) -> Result<sys::napi_value> {
    let native = L::new(&env, native);
    let state = fields(
        native,
        &[("native", native), ("process", L::new(&env, process))],
    )?;
    state.set(
        c"probe",
        method(&env, state, "", 0, 3, |s, a| {
            call(s.get(c"native")?, c"networkPolicyFindAvailablePort", a)
        })?,
    )?;
    let find = method(&env, state, "findAvailablePort", 2, 3, |s, a| {
        find(s, a[0], a[1], a[2])
    })?;
    state.set(c"find", find)?;
    let select = method(&env, state, "selectListenPort", 1, 2, |s, a| {
        crate::host_methods::async_result(s, || select(s, a[0], a[1]))
    })?;
    Ok(fields(
        state,
        &[
            (
                "envEnabled",
                method(&env, state, "envEnabled", 1, 1, |s, a| {
                    predicate(s, a[0], c"networkPolicyEnvEnabled")
                })?,
            ),
            (
                "isLoopbackHost",
                method(&env, state, "isLoopbackHost", 1, 1, |s, a| {
                    predicate(s, a[0], c"networkPolicyIsLoopbackHost")
                })?,
            ),
            (
                "resolveNetworkPolicy",
                method(&env, state, "resolveNetworkPolicy", 0, 1, |s, a| {
                    resolve(s, a[0])
                })?,
            ),
            ("findAvailablePort", find),
            ("selectListenPort", select),
        ],
    )?
    .raw())
}
