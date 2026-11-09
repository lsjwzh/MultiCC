//! Borrowed Node request adaptation. The common gateway policy is the sole
//! authority; no request/header object or callback survives this invocation.
use crate::{api_error_text::string_or_empty, js_live::LiveValue};
use multicc_core::{http_gate as policy, js::JsValue};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
type V<'a> = LiveValue<'a>;

fn host(request: V<'_>) -> Result<multicc_core::js::JsString> {
    // Preserve req && req.headers && req.headers.host, including a getter's
    // second read; only the host value is read, never other header values.
    let value = if request.truthy()? && request.get(c"headers")?.truthy()? {
        request.get(c"headers")?.get(c"host")?
    } else {
        request.from_value(&JsValue::Undefined)?
    };
    Ok(policy::request_host_utf16(&string_or_empty(value)?))
}
fn peer(request: V<'_>) -> Result<V<'_>> {
    if !request.truthy()? {
        return Ok(request);
    }
    let socket = request.get(c"socket")?;
    if !socket.truthy()? {
        return Ok(socket);
    }
    request.get(c"socket")?.get(c"remoteAddress")
}
fn forwarded(request: V<'_>) -> Result<bool> {
    let headers = if request.truthy()? {
        request.get(c"headers")?
    } else {
        request
    };
    if !headers.truthy()? || headers.kind()? != sys::ValueType::napi_object {
        return Ok(false);
    }
    let object = request.global()?.get(c"Object")?;
    let keys = object.get(c"keys")?.call(object, &[headers])?;
    let length = keys.get(c"length")?.number()? as u32;
    for index in 0..length {
        let key = keys.element(index)?.coerce_string()?.to_string_lossy();
        if policy::has_forwarding_metadata([key.as_str()]) {
            return Ok(true);
        }
    }
    Ok(false)
}
fn external(request: V<'_>) -> Result<bool> {
    let host = host(request)?;
    Ok(forwarded(request)? || !policy::local_host(&host.to_string_lossy()))
}

#[napi]
pub fn request_locality(
    env: Env,
    operation: String,
    input: Unknown<'_>,
) -> Result<sys::napi_value> {
    let input = V::new(&env, input);
    let result = match operation.as_str() {
        "constants" => JsValue::object(vec![
            (
                "loopback",
                JsValue::Array(
                    policy::LOOPBACK_ADDRESSES
                        .iter()
                        .map(|s| JsValue::string(s))
                        .collect(),
                ),
            ),
            (
                "forwarding",
                JsValue::Array(
                    policy::FORWARDING_HEADERS
                        .iter()
                        .map(|s| JsValue::string(s))
                        .collect(),
                ),
            ),
        ]),
        "host" => JsValue::String(host(input)?),
        "forwarded" => JsValue::Bool(forwarded(input)?),
        "external" => JsValue::Bool(external(input)?),
        "local" => {
            let address = string_or_empty(peer(input)?)?;
            JsValue::Bool(
                policy::LOOPBACK_ADDRESSES.contains(&address.to_string_lossy().as_str())
                    && !external(input)?,
            )
        }
        "private-address" => JsValue::Bool(policy::is_private_network_address(
            &string_or_empty(input)?.to_string_lossy(),
        )),
        "private-peer" => JsValue::Bool(policy::is_private_network_address(
            &string_or_empty(peer(input)?)?.to_string_lossy(),
        )),
        _ => return Err(input.type_error("Unknown request locality operation")),
    };
    Ok(input.from_value(&result)?.raw())
}
