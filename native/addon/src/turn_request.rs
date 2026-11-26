use crate::route_response::{call, fields, text, L, V};
use multicc_core::turn_request;
use napi::bindgen_prelude::Unknown;
use napi::{sys, Env, Result};
use napi_derive::napi;

/// Constant tables (request kind, forbidden fields, task sources...).
#[napi]
pub fn turn_request_catalog() -> Result<String> {
    turn_request::catalog().map_err(napi::Error::from_reason)
}

/// One value-in/value-out entry for normalize/admission/proof/spawn-guard. The
/// payload crosses napi directly, so `undefined`, `NaN`, the infinities and
/// `-0` survive a JSON boundary that would have folded them into null/0.
#[napi]
pub fn turn_request_request_value(
    env: Env,
    op: String,
    input: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(request(&op, L::new(&env, input))?.raw())
}

fn request<'a>(op: &str, input: L<'a>) -> Result<L<'a>> {
    let raw = input.env();
    let value = unsafe { crate::js_bridge::read_value(raw, input.raw(), 0, &mut Vec::new()) }?;
    let result = turn_request::request_value(op, &value).map_err(napi::Error::from_reason)?;
    Ok(L::from_raw(raw, unsafe {
        crate::js_bridge::write_value(raw, &result)
    }?))
}

fn deep_freeze(value: L<'_>) -> Result<L<'_>> {
    if !value.truthy()? || value.kind()? != sys::ValueType::napi_object {
        return Ok(value);
    }
    let object = value.global()?.get(c"Object")?;
    if !call(object, c"isFrozen", &[value])?.truthy()? {
        value.freeze()?;
        call(object, c"values", &[value])?.for_each(|child| deep_freeze(child).map(|_| ()))?;
    }
    Ok(value)
}

#[napi]
pub fn provider_route_proof(
    env: Env,
    request: Unknown<'_>,
    evidence: Unknown<'_>,
    check_binding: Unknown<'_>,
    error_class: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(route_proof(
        L::new(&env, request),
        L::new(&env, evidence),
        L::new(&env, check_binding),
        L::new(&env, error_class),
    )?
    .raw())
}

// The JS host owns the Symbol brand and the public error constructor. Both
// entry points enforce the same proof shape and seal the same core result.
pub(crate) fn route_proof<'a>(
    req: L<'a>,
    evidence: L<'a>,
    check_binding: L<'a>,
    error_class: L<'a>,
) -> Result<L<'a>> {
    let reject = |code: &str, message: L<'a>| -> Result<napi::Error> {
        Ok(error_class
            .construct(&[text(req, code)?, message])?
            .throw_error())
    };
    if !req.truthy()? || !req.get(c"kind")?.is_string(turn_request::REQUEST_KIND)? {
        return Err(reject(
            "invalid_request",
            text(req, "normalizeTurnRequest must be called first")?,
        )?);
    }
    let keys = call(req.global()?.get(c"Object")?, c"keys", &[evidence])?;
    let unexpected = req.from_value(&V::Array(vec![]))?;
    keys.for_each(|key| {
        let name = key.coerce_string()?;
        if !turn_request::PROVIDER_ROUTE_EVIDENCE_KEYS.contains(&name.as_str_lossy().as_ref()) {
            call(unexpected, c"push", &[key])?;
        }
        Ok(())
    })?;
    if unexpected.get(c"length")?.truthy()? {
        let sorted = call(unexpected, c"sort", &[])?;
        let mut message =
            multicc_core::js::JsString::from("provider route evidence is too broad: ");
        message.push(&call(sorted, c"join", &[text(req, ", ")?])?.coerce_string()?);
        return Err(reject(
            "invalid_provider_route",
            req.from_value(&V::String(message))?,
        )?);
    }
    let binding = match req.catch(|| check_binding.call_plain(&[evidence.get(c"binding")?]))? {
        Some(value) => value,
        None => {
            return Err(reject(
                "invalid_provider_route",
                text(req, "concrete provider route binding is required")?,
            )?)
        }
    };
    let request_ref = fields(
        req,
        &[
            ("kind", req.get(c"kind")?),
            ("sessionId", req.get(c"sessionId")?),
            ("cli", req.get(c"cli")?),
            ("transport", req.get(c"execution")?.get(c"transport")?),
        ],
    )?;
    let route = fields(req, &[])?;
    for key in [
        c"resolved",
        c"providerName",
        c"protocol",
        c"runtimeEpoch",
        c"turnId",
        c"decisionId",
        c"routeAttemptId",
        c"routeGeneration",
        c"attemptNo",
        c"providerRevision",
    ] {
        route.set(key, evidence.get(key)?)?;
    }
    let binding_ref = fields(req, &[])?;
    for key in [
        c"sessionId",
        c"cli",
        c"providerId",
        c"model",
        c"roleKind",
        c"routeName",
    ] {
        binding_ref.set(key, binding.get(key)?)?;
    }
    let payload = fields(
        req,
        &[
            ("request", request_ref),
            ("evidence", route),
            ("binding", binding_ref),
        ],
    )?;
    let answer = request("routeProof", payload)?;
    if !answer.get(c"ok")?.truthy()? {
        let error = answer.get(c"error")?;
        return Err(error_class
            .construct(&[error.get(c"code")?, error.get(c"message")?])?
            .throw_error());
    }
    deep_freeze(answer.get(c"value")?)
}
