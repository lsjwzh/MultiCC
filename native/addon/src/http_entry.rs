//! HTTP admission owner. Host ports retain live credentials, scoped grants,
//! metrics and Express effects; Rust owns ordering and all admission branches.
//! No request/response/callback is retained beyond this synchronous invocation.
use crate::{api_error_text::string_or_empty, js_live::LiveValue};
use multicc_core::{
    http_entry,
    js::{JsString, JsValue},
};
use napi::{bindgen_prelude::Unknown, check_status, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

type V<'a> = LiveValue<'a>;
pub(crate) fn text<'a>(anchor: V<'a>, value: &str) -> Result<V<'a>> {
    anchor.from_value(&JsValue::string(value))
}
pub(crate) fn member<'a>(object: V<'a>, name: &CStr, args: &[V<'a>]) -> Result<V<'a>> {
    object.get(name)?.call(object, args)
}
pub(crate) fn host<'a>(port: V<'a>, name: &CStr, args: &[V<'a>]) -> Result<V<'a>> {
    port.get(name)?.call_plain(args)
}
fn metric(port: V<'_>, name: &str) -> Result<()> {
    member(port.get(c"metrics")?, c"inc", &[text(port, name)?])?;
    Ok(())
}
fn header<'a>(request: V<'a>, name: &CStr) -> Result<V<'a>> {
    request.get(c"headers")?.get(name)
}
fn required_string(value: V<'_>) -> Result<JsString> {
    value
        .string()?
        .ok_or_else(|| value.type_error("HTTP request field must be a string"))
}
fn audit_query(request: V<'_>, port: V<'_>, name: &str) -> Result<()> {
    let event = port.from_value(&JsValue::Object(Vec::new()))?;
    event.set(c"requestId", request.get(c"id")?)?;
    event.set(c"path", request.get(c"path")?)?;
    member(port.get(c"logger")?, c"warn", &[text(port, name)?, event])?;
    Ok(())
}
fn authenticated<'a>(request: V<'a>, port: V<'a>) -> Result<V<'a>> {
    let token = host(port, c"getAccessToken", &[])?;
    if !token.truthy()? {
        return host(port, c"isLocalRequest", &[request]);
    }
    if host(port, c"isLocalRequest", &[request])?.truthy()? {
        return port.from_value(&true.into());
    }
    let security = port.get(c"authSecurity")?;
    let cookies = host(port, c"parseCookies", &[header(request, c"cookie")?])?;
    if cookies.get(c"multicc_auth")?.truthy()?
        && member(security, c"verifyCookie", &[cookies.get(c"multicc_auth")?])?.truthy()?
    {
        return port.from_value(&true.into());
    }
    if member(
        security,
        c"verifyAccessToken",
        &[header(request, c"x-access-token")?],
    )?
    .truthy()?
    {
        return port.from_value(&true.into());
    }
    if port.get(c"allowLegacyTokenQuery")?.truthy()?
        && member(
            security,
            c"verifyAccessToken",
            &[request.get(c"query")?.get(c"token")?],
        )?
        .truthy()?
    {
        metric(port, "multicc_auth_legacy_query_total")?;
        audit_query(request, port, "legacy_token_query")?;
        return port.from_value(&true.into());
    }
    port.from_value(&false.into())
}
pub(crate) fn cookie<'a>(request: V<'a>, port: V<'a>, mut value: V<'a>) -> Result<V<'a>> {
    if value.undefined()? {
        value = member(port.get(c"authSecurity")?, c"createCookie", &[])?;
    }
    let secure = if request.get(c"secure")?.truthy()? {
        true
    } else {
        let protocol = string_or_empty(header(request, c"x-forwarded-proto")?)?;
        let first = protocol
            .as_units()
            .split(|unit| *unit == b',' as u16)
            .next()
            .unwrap_or(&[]);
        JsString::from_units(first.to_vec()).trim() == "https"
    };
    let mut out = JsString::from_rust_str("multicc_auth=");
    // Template-literal ToString, which throws on Symbol just like the old host.
    out.push(&value.coerce_string()?);
    out.push_str("; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000");
    if secure {
        out.push_str("; Secure");
    }
    port.from_value(&JsValue::String(out))
}
fn relay(request: V<'_>, port: V<'_>) -> Result<bool> {
    if !http_entry::relay_path(&required_string(request.get(c"path")?)?) {
        return Ok(false);
    }
    let bearer = http_entry::bearer(&string_or_empty(header(request, c"authorization")?)?);
    let api_key = header(request, c"x-api-key")?;
    let credential = if api_key.truthy()? {
        string_or_empty(api_key)?
    } else {
        bearer.unwrap_or_default()
    }
    .trim();
    if credential.is_empty() {
        return Ok(false);
    }
    let scoped = (|| {
        let input = port.from_value(&JsValue::Object(Vec::new()))?;
        input.set(
            c"credential",
            port.from_value(&JsValue::String(credential))?,
        )?;
        input.set(c"method", request.get(c"method")?)?;
        input.set(c"pathname", request.get(c"path")?)?;
        host(port, c"authorizeProviderRelayRequest", &[input])
    })();
    let scoped = match scoped {
        Ok(value) => value,
        Err(_) => {
            let mut pending = false;
            check_status!(unsafe { sys::napi_is_exception_pending(port.env(), &mut pending) })?;
            let exception = if pending {
                let mut raw = std::ptr::null_mut();
                check_status!(unsafe {
                    sys::napi_get_and_clear_last_exception(port.env(), &mut raw)
                })?;
                V::from_raw(port.env(), raw)
            } else {
                port.from_value(&JsValue::Undefined)?
            };
            let event = port.from_value(&JsValue::Object(Vec::new()))?;
            event.set(c"requestId", request.get(c"id")?)?;
            let code = if exception.optional(c"code")?.kind()? == sys::ValueType::napi_string {
                exception.get(c"code")?
            } else {
                text(port, "PERSISTENCE_FAILED")?
            };
            event.set(c"code", code)?;
            member(
                port.get(c"logger")?,
                c"warn",
                &[text(port, "provider_relay_share_auth_failed")?, event],
            )?;
            return Ok(false);
        }
    };
    if scoped.truthy()? && scoped.get(c"ok")?.is_true()? {
        let id = scoped.get(c"shareId")?;
        request.assign(
            c"providerRelayShareId",
            if id.truthy()? {
                id
            } else {
                port.from_value(&JsValue::Null)?
            },
        )?;
        return Ok(true);
    }
    Ok(false)
}
fn refusal<'a>(
    request: V<'a>,
    response: V<'a>,
    port: V<'a>,
    shutdown: bool,
    peer: bool,
) -> Result<V<'a>> {
    let (code, message, action, scope) = if shutdown {
        ("SERVER_SHUTTING_DOWN", "server is shutting down", "", "")
    } else if peer {
        (
            "DIRECT_PUBLIC_ACCESS_DISABLED",
            "Forbidden: direct public access is disabled; use Tailscale or an explicit remote bind",
            "open_settings",
            "host",
        )
    } else {
        (
            "AUTH_REQUIRED",
            "Forbidden: not authenticated",
            "login",
            "request",
        )
    };
    let status = port.from_value(&JsValue::Number(if shutdown { 503.0 } else { 403.0 }))?;
    let response = member(response, c"status", &[status])?;
    let json = response.get(c"json")?;
    let dto = port.from_value(&JsValue::object(vec![
        ("code", code.into()),
        ("message", message.into()),
    ]))?;
    if !shutdown {
        dto.set(c"category", text(port, "authentication_permission")?)?;
        dto.set(c"detail", text(port, message)?)?;
        dto.set(c"retryable", port.from_value(&false.into())?)?;
        dto.set(c"action", text(port, action)?)?;
        dto.set(c"scope", text(port, scope)?)?;
    }
    dto.set(c"requestId", request.get(c"id")?)?;
    dto.set(c"correlationId", request.get(c"correlationId")?)?;
    let dto = host(port, c"createErrorDto", &[dto])?;
    json.call(response, &[dto])
}

#[napi]
pub fn http_entry_authenticated(
    env: Env,
    request: Unknown<'_>,
    port: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(authenticated(V::new(&env, request), V::new(&env, port))?.raw())
}
#[napi]
pub fn http_entry_cookie(
    env: Env,
    request: Unknown<'_>,
    port: Unknown<'_>,
    value: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(cookie(
        V::new(&env, request),
        V::new(&env, port),
        V::new(&env, value),
    )?
    .raw())
}

/// Stages remain mounted at their original Express positions: /api shutdown,
/// transport-peer gate before login, then general auth after login routes.
#[napi]
pub fn http_entry_gate(
    env: Env,
    stage: String,
    request: Unknown<'_>,
    response: Unknown<'_>,
    next: Unknown<'_>,
    port: Unknown<'_>,
) -> Result<sys::napi_value> {
    let (request, response, next, port) = (
        V::new(&env, request),
        V::new(&env, response),
        V::new(&env, next),
        V::new(&env, port),
    );
    let undefined = port.from_value(&JsValue::Undefined)?;
    if stage == "shutdown" {
        return Ok(if host(port, c"getShuttingDown", &[])?.truthy()? {
            member(
                response,
                c"set",
                &[text(port, "Retry-After")?, text(port, "1")?],
            )?;
            refusal(request, response, port, true, false)?
        } else {
            next.call_plain(&[])?
        }
        .raw());
    }
    if stage == "peer" {
        return Ok(
            if host(port, c"isRequestPeerAllowed", &[request])?.truthy()? {
                next.call_plain(&[])?
            } else {
                metric(port, "multicc_auth_public_peer_rejected_total")?;
                refusal(request, response, port, false, true)?
            }
            .raw(),
        );
    }
    if stage != "auth" {
        return Err(port.type_error("Unknown HTTP entry stage"));
    }
    if host(port, c"handleServiceRequest", &[request, response])?.truthy()? {
        return Ok(undefined.raw());
    }
    let path = required_string(request.get(c"path")?)?;
    let method = required_string(request.get(c"method")?)?;
    let method = method.as_str_lossy();
    if http_entry::public_path(&method, &path)
        || (http_entry::udid_callback_path(&method, &path)
            && http_entry::udid_content_type(&{
                let content = header(request, c"content-type")?;
                if content.truthy()? {
                    content.coerce_string()?
                } else {
                    JsString::new()
                }
            }))
    {
        return Ok(next.call_plain(&[])?.raw());
    }
    let api = path.as_units().starts_with(&[47, 97, 112, 105, 47]);
    if method == "GET"
        && !api
        && member(
            port.get(c"authSecurity")?,
            c"verifyAccessToken",
            &[request.get(c"query")?.get(c"token")?],
        )?
        .truthy()?
    {
        metric(port, "multicc_auth_bootstrap_query_total")?;
        audit_query(request, port, "bootstrap_token_query")?;
        let setter = response.get(c"setHeader")?;
        let cookie = cookie(request, port, undefined)?;
        setter.call(response, &[text(port, "Set-Cookie")?, cookie])?;
        return Ok(next.call_plain(&[])?.raw());
    }
    if relay(request, port)? {
        metric(port, "multicc_auth_proxy_relay_total")?;
        if request.get(c"providerRelayShareId")?.truthy()? {
            metric(port, "multicc_auth_provider_relay_share_total")?;
        }
        return Ok(next.call_plain(&[])?.raw());
    }
    // The old JS try/catch includes metric and next() exceptions as well.
    if let Some(Some(result)) = port.catch(|| {
        if host(port, c"authorizeScopedRequest", &[request])?.truthy()? {
            metric(port, "multicc_auth_fleet_scope_total")?;
            return Ok(Some(next.call_plain(&[])?));
        }
        Ok(None)
    })? {
        return Ok(result.raw());
    }
    if !header(request, c"x-multicc-machine-grant")?.truthy()?
        && authenticated(request, port)?.truthy()?
    {
        return Ok(next.call_plain(&[])?.raw());
    }
    let accept = header(request, c"accept")?;
    let html =
        !accept.nullish()? && member(accept, c"includes", &[text(port, "text/html")?])?.truthy()?;
    // A scoped authorizer may mutate the request or reenter the host. Read
    // the final redirect inputs after that callback, as the original gate did.
    let document = if html {
        true
    } else {
        let path = required_string(request.get(c"path")?)?;
        !path.as_units().starts_with(&[47, 97, 112, 105, 47])
            && request.get(c"method")?.is_string("GET")?
    };
    if document {
        let redirect = response.get(c"redirect")?;
        let encoded = port
            .global()?
            .get(c"encodeURIComponent")?
            .call_plain(&[request.get(c"originalUrl")?])?
            .coerce_string()?;
        let mut location = JsString::from_rust_str("/login?redirect=");
        location.push(&encoded);
        redirect.call(response, &[port.from_value(&JsValue::String(location))?])?;
    } else {
        refusal(request, response, port, false, false)?;
    }
    Ok(undefined.raw())
}

#[napi]
pub fn http_entry_make_request_id() -> String {
    multicc_core::http_gate::make_request_id()
}

fn clean_id(value: V<'_>) -> Result<Option<JsString>> {
    Ok(value.string()?.filter(|text| {
        multicc_core::http_gate::clean_incoming_id(Some(&text.as_str_lossy())).is_some()
    }))
}
#[napi]
pub fn http_entry_clean_id(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    let value = V::new(&env, value);
    Ok(if clean_id(value)?.is_some() {
        value
    } else {
        value.from_value(&JsValue::Null)?
    }
    .raw())
}
#[napi]
pub fn http_entry_request_ids(env: Env, headers: Unknown<'_>) -> Result<sys::napi_value> {
    let headers = V::new(&env, headers);
    let id = clean_id(headers.get(c"x-request-id")?)?
        .unwrap_or_else(|| multicc_core::http_gate::make_request_id().into());
    let correlation = clean_id(headers.get(c"x-correlation-id")?)?.unwrap_or_else(|| id.clone());
    Ok(headers
        .from_value(&JsValue::object(vec![
            ("id", JsValue::String(id)),
            ("correlationId", JsValue::String(correlation)),
        ]))?
        .raw())
}
