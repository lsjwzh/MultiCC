//! Public API over one set of policy ports and one signature cache per module.
use super::runtime;
use crate::{
    host_methods::{default_object, function},
    route_response::*,
};
use napi_derive::napi;
use std::ffi::CStr;

pub(super) fn load_addon(s: L<'_>) -> Result<L<'_>> {
    s.get(c"loadAddon")?.call_plain(&[])
}

pub(super) fn decision<'a>(
    s: L<'a>,
    raw: L<'a>,
    context: L<'a>,
    deps: L<'a>,
    normalize: bool,
) -> Result<L<'a>> {
    let method = if normalize {
        c"apiPolicyNormalized"
    } else {
        c"apiPolicyDecision"
    };
    let raw = if normalize { default_object(raw)? } else { raw };
    call(
        load_addon(s)?,
        method,
        &[
            s.get(c"ports")?,
            raw,
            default_object(context)?,
            default_object(deps)?,
        ],
    )
}

fn forward<'a>(
    s: L<'a>,
    name: &'static str,
    native: &'static CStr,
    arity: usize,
    freeze: bool,
) -> Result<L<'a>> {
    function(s, name, arity, arity, move |s, a| {
        let value = call(load_addon(s)?, native, a)?;
        if freeze {
            if value.truthy()? {
                value.freeze()
            } else {
                null(s)
            }
        } else {
            Ok(value)
        }
    })
}

#[napi]
pub fn api_error_policy_api(
    env: Env,
    loader: Unknown<'_>,
    extract: Unknown<'_>,
    error_fields: Unknown<'_>,
) -> Result<sys::napi_value> {
    let load = L::new(&env, loader);
    let native = load.call_plain(&[])?;
    let global = native.global()?;
    let facts = call(
        global.get(c"JSON")?,
        c"parse",
        &[call(native, c"apiErrorFacts", &[])?],
    )?;
    let categories = facts.get(c"categories")?.freeze()?;
    let signatures = facts.get(c"apiErrorSignatures")?.freeze()?;
    let set = global.get(c"Set")?;
    let ports = fields(
        native,
        &[
            ("categories", set.construct(&[categories])?),
            (
                "trusted",
                set.construct(&[facts.get(c"trustedTextSources")?])?,
            ),
            ("shared", null(native)?),
            ("errorFields", L::new(&env, error_fields)),
            ("extract", L::new(&env, extract)),
        ],
    )?;
    let s = fields(
        native,
        &[
            ("loadAddon", load),
            ("ports", ports),
            ("quoted", null(native)?),
        ],
    )?;
    let api = fields(s, &[("policyPorts", ports), ("CATEGORIES", categories)])?;
    api.set(
        c"normalizeApiError",
        function(s, "normalizeApiError", 0, 3, |s, a| {
            decision(s, a[0], a[1], a[2], true)
        })?,
    )?;
    api.set(
        c"decideApiErrorPolicy",
        function(s, "decideApiErrorPolicy", 1, 3, |s, a| {
            decision(s, a[0], a[1], a[2], false)
        })?,
    )?;
    api.set(
        c"createApiErrorPolicyRuntime",
        function(s, "createApiErrorPolicyRuntime", 0, 1, |s, a| {
            runtime::create(s, default_object(a[0])?)
        })?,
    )?;
    for (name, method) in [
        ("parseRetryAfter", c"apiErrorParseRetryAfter"),
        ("resetAfterFromText", c"apiErrorResetAfterFromText"),
    ] {
        api.set_key(
            text(s, name)?,
            function(s, name, 1, 2, move |s, a| {
                if a[1].undefined()? {
                    a[1] = call(s.global()?.get(c"Date")?, c"now", &[])?;
                }
                call(load_addon(s)?, method, a)
            })?,
        )?;
    }
    for (name, method, arity) in [
        ("retryNotice", c"apiErrorRetryNotice", 1),
        ("sanitizeMessage", c"apiSanitizeMessage", 3),
        ("isErrorOnlyText", c"apiErrorIsErrorOnlyText", 1),
    ] {
        api.set_key(text(s, name)?, forward(s, name, method, arity, false)?)?;
    }
    let regexp = global.get(c"RegExp")?;
    for (name, source) in [
        (c"ERROR_ONLY_PREFIX_RE", c"errorOnlyPrefixSource"),
        (
            c"TRAILING_ERROR_ENVELOPE_RE",
            c"trailingErrorEnvelopeSource",
        ),
    ] {
        api.set(
            name,
            regexp.construct(&[facts.get(source)?, text(s, "i")?])?,
        )?;
    }
    for (name, method, arity, freeze) in [
        (
            "splitTrailingErrorEnvelope",
            c"apiErrorSplitTrailingEnvelope",
            1,
            true,
        ),
        ("detectErrorEnvelope", c"apiErrorDetectEnvelope", 2, true),
        ("claudeErrorEnvelope", c"apiErrorClaudeEnvelope", 2, true),
        ("envelopeSourceFor", c"apiErrorEnvelopeSourceFor", 1, false),
        ("normalizeRejection", c"apiNormalizeRejection", 1, false),
        (
            "isKnownHarmlessStderrLine",
            c"apiErrorIsKnownHarmlessStderrLine",
            1,
            false,
        ),
    ] {
        api.set_key(text(s, name)?, forward(s, name, method, arity, freeze)?)?;
    }
    api.set(c"API_ERROR_SIGNATURES", signatures)?;
    api.set(
        c"apiErrorSignaturesQuoted",
        function(s, "apiErrorSignaturesQuoted", 0, 0, |s, _| {
            let quoted = s.get(c"quoted")?;
            if !quoted.nullish()? {
                return Ok(quoted);
            }
            let value = call(load_addon(s)?, c"apiErrorSignaturesQuoted", &[])?;
            s.set(c"quoted", value)?;
            Ok(value)
        })?,
    )?;
    Ok(api.raw())
}
