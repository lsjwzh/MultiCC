//! Authentication endpoint behavior. Express is only the temporary transport
//! adapter; credential and ticket operations share the RustAuthSecurity owner.
use crate::{
    auth_login_page,
    http_entry::{cookie, host, member, text},
    js_live::LiveValue as V,
};
use multicc_core::js::{JsString, JsValue};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

fn error<'a>(req: V<'a>, res: V<'a>, port: V<'a>, ticket: bool) -> Result<V<'a>> {
    let (status, code, message, category, action, scope) = if ticket {
        (
            400.0,
            "WS_PATH_INVALID",
            "invalid WebSocket path",
            "route",
            "check_route",
            "session",
        )
    } else {
        (
            403.0,
            "AUTH_TOKEN_INVALID",
            "Forbidden: invalid access token",
            "authentication_permission",
            "login",
            "request",
        )
    };
    let response = member(
        res,
        c"status",
        &[port.from_value(&JsValue::Number(status))?],
    )?;
    let send = response.get(c"json")?;
    let dto = port.from_value(&JsValue::object(vec![
        ("code", code.into()),
        ("message", message.into()),
        ("category", category.into()),
        ("detail", message.into()),
        ("retryable", false.into()),
        ("action", action.into()),
        ("scope", scope.into()),
    ]))?;
    dto.set(c"requestId", req.get(c"id")?)?;
    dto.set(c"correlationId", req.get(c"correlationId")?)?;
    send.call(response, &[host(port, c"createErrorDto", &[dto])?])
}

#[napi]
pub fn http_auth_route(
    env: Env,
    stage: String,
    request: Unknown<'_>,
    response: Unknown<'_>,
    port: Unknown<'_>,
) -> Result<sys::napi_value> {
    let (req, res, port) = (
        V::new(&env, request),
        V::new(&env, response),
        V::new(&env, port),
    );
    let undefined = port.from_value(&JsValue::Undefined)?;
    match stage.as_str() {
        "login-page" => {
            let failed = req.get(c"query")?.get(c"error")?.truthy()?;
            let redirect = host(
                port,
                c"normalizeRedirect",
                &[req.get(c"query")?.get(c"redirect")?],
            )?;
            let response = member(res, c"type", &[text(port, "html")?])?;
            let send = response.get(c"send")?;
            let mut page = JsString::from_rust_str(auth_login_page::PARTS[0]);
            if failed {
                page.push_str("<p style=\"color:#f85149;margin-bottom:16px;\">密码错误</p>");
            }
            page.push_str(auth_login_page::PARTS[1]);
            page.push(&host(port, c"escapeHtmlAttribute", &[redirect])?.coerce_string()?);
            page.push_str(auth_login_page::PARTS[2]);
            send.call(response, &[port.from_value(&JsValue::String(page))?])?;
        }
        "login" => {
            let redirect = host(
                port,
                c"normalizeRedirect",
                &[req.get(c"body")?.get(c"redirect")?],
            )?;
            if member(
                port.get(c"authSecurity")?,
                c"verifyAccessToken",
                &[req.get(c"body")?.get(c"password")?],
            )?
            .truthy()?
            {
                let setter = res.get(c"setHeader")?;
                setter.call(
                    res,
                    &[text(port, "Set-Cookie")?, cookie(req, port, undefined)?],
                )?;
                member(res, c"redirect", &[redirect])?;
            } else {
                let send = res.get(c"redirect")?;
                let encoded = port
                    .global()?
                    .get(c"encodeURIComponent")?
                    .call_plain(&[redirect])?
                    .coerce_string()?;
                let mut target = JsString::from_rust_str("/login?error=1&redirect=");
                target.push(&encoded);
                send.call(res, &[port.from_value(&JsValue::String(target))?])?;
            }
        }
        "logout" => {
            member(
                res,
                c"setHeader",
                &[
                    text(port, "Set-Cookie")?,
                    text(port, "multicc_auth=; Path=/; HttpOnly; Max-Age=0")?,
                ],
            )?;
            member(res, c"redirect", &[text(port, "/login")?])?;
        }
        "exchange" => {
            if !host(port, c"getAccessToken", &[])?.truthy()?
                || !member(
                    port.get(c"authSecurity")?,
                    c"verifyAccessToken",
                    &[req.get(c"headers")?.get(c"x-access-token")?],
                )?
                .truthy()?
            {
                return Ok(error(req, res, port, false)?.raw());
            }
            let setter = res.get(c"setHeader")?;
            setter.call(
                res,
                &[text(port, "Set-Cookie")?, cookie(req, port, undefined)?],
            )?;
            let response = member(res, c"status", &[port.from_value(&JsValue::Number(204.0))?])?;
            member(response, c"end", &[])?;
        }
        "ws-ticket" => {
            if port
                .catch(|| {
                    let security = port.get(c"authSecurity")?;
                    let issue = security.get(c"issueWsTicket")?;
                    let mut path = req.get(c"body")?;
                    if path.truthy()? {
                        path = req.get(c"body")?.get(c"path")?;
                    }
                    if !path.truthy()? {
                        path = text(port, "/")?;
                    }
                    let metadata = port.from_value(&JsValue::Object(Vec::new()))?;
                    let grant = req.get(c"machineGrantId")?;
                    metadata.set(
                        c"machineGrantId",
                        if grant.truthy()? { grant } else { undefined },
                    )?;
                    let correlation = req.get(c"correlationId")?;
                    metadata.set(
                        c"correlationId",
                        if correlation.truthy()? {
                            correlation
                        } else {
                            req.get(c"id")?
                        },
                    )?;
                    metadata.set(c"requestId", req.get(c"id")?)?;
                    let issued = issue.call(security, &[path, metadata])?;
                    member(
                        res,
                        c"set",
                        &[text(port, "Cache-Control")?, text(port, "no-store")?],
                    )?;
                    member(res, c"json", &[issued])?;
                    Ok(())
                })?
                .is_none()
            {
                error(req, res, port, true)?;
            }
        }
        _ => return Err(port.type_error("Unknown auth route stage")),
    }
    Ok(undefined.raw())
}
