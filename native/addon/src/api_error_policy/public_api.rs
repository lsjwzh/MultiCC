//! Public API over one set of policy ports and one signature cache per module.
use super::runtime;
use crate::{
    host_methods::{arg, default_object, env as environment, function, raw as live, typed},
    route_response::*,
};
use napi_derive::napi;
use std::ffi::CStr;

// Node owns module selection. Re-enter its loader only when the environment
// selects another path (including a worker's private process.env).
pub(super) fn alternate(s: L<'_>) -> Result<Option<L<'_>>> {
    let binding = s.get(c"binding")?;
    if !binding.undefined()? {
        let env = binding.get(c"process")?.get(c"env")?;
        if env
            .get(c"MULTICC_RUST_ADDON")?
            .equals(binding.get(c"addonPath")?)?
            && env
                .get(c"MULTICC_RUST_PREBUILT_DIR")?
                .equals(binding.get(c"prebuiltDir")?)?
        {
            return Ok(None);
        }
    }
    let loaded = s.get(c"loadAddon")?.call_plain(&[])?;
    Ok(if loaded.equals(s.get(c"native")?)? {
        None
    } else {
        Some(loaded)
    })
}

pub(crate) fn quoted(s: L<'_>) -> Result<L<'_>> {
    let cached = s.get(c"quoted")?;
    if !cached.nullish()? {
        return Ok(cached);
    }
    let value = match alternate(s)? {
        Some(native) => call(native, c"apiErrorSignaturesQuoted", &[])?,
        None => text(s, &super::api_error_signatures_quoted()?)?,
    };
    s.set(c"quoted", value)?;
    Ok(value)
}

pub(super) fn decision<'a>(
    s: L<'a>,
    raw: L<'a>,
    context: L<'a>,
    deps: L<'a>,
    normalize: bool,
) -> Result<L<'a>> {
    decision_with_time(s, raw, context, deps, normalize, None)
}

pub(super) fn decision_with_time<'a>(
    s: L<'a>,
    raw: L<'a>,
    context: L<'a>,
    deps: L<'a>,
    normalize: bool,
    timestamp: Option<L<'a>>,
) -> Result<L<'a>> {
    let method = if normalize {
        c"apiPolicyNormalized"
    } else {
        c"apiPolicyDecision"
    };
    let raw = if normalize { default_object(raw)? } else { raw };
    let alternate = alternate(s)?;
    let ports = s.get(c"ports")?;
    let context = default_object(context)?;
    let deps = default_object(deps)?;
    if let Some(native) = alternate {
        if let Some(at) = timestamp {
            deps.set(c"now", function(at, "now", 0, 0, |at, _| Ok(at))?)?;
        }
        return call(native, method, &[ports, raw, context, deps]);
    }
    if let Some(at) = timestamp {
        let at = s.global()?.get(c"Number")?.call_plain(&[at])?;
        return if normalize {
            super::decision::normalized_at(ports, raw, context, at)
        } else {
            super::decision::decide_at(ports, raw, context, deps, at)
        };
    }
    if normalize {
        Ok(live(
            s,
            super::decision::api_policy_normalized(
                environment(s),
                arg(ports)?,
                arg(raw)?,
                arg(context)?,
                arg(deps)?,
            )?,
        ))
    } else {
        super::decision::decide(ports, raw, context, deps)
    }
}

type Operation = for<'a> fn(L<'a>, &[L<'a>]) -> Result<L<'a>>;

fn forward<'a>(
    s: L<'a>,
    name: &'static str,
    native: &'static CStr,
    arity: usize,
    freeze: bool,
    direct: Operation,
) -> Result<L<'a>> {
    function(s, name, arity, arity, move |s, a| {
        let value = match alternate(s)? {
            Some(loaded) => call(loaded, native, a)?,
            None => direct(s, a)?,
        };
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
    binding: Unknown<'_>,
) -> Result<sys::napi_value> {
    let load = L::new(&env, loader);
    let native = load.call_plain(&[])?;
    let global = native.global()?;
    let facts = call(
        global.get(c"JSON")?,
        c"parse",
        &[text(native, &super::api_error_facts()?)?],
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
            ("native", native),
            ("binding", L::new(&env, binding)),
            ("loadAddon", load),
            ("ports", ports),
            ("quoted", null(native)?),
        ],
    )?;
    let binding = L::new(&env, binding);
    if !binding.undefined()? {
        binding.set(c"policy", s)?;
    }
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
    for (name, method, parse) in [
        (
            "parseRetryAfter",
            c"apiErrorParseRetryAfter",
            super::api_error_parse_retry_after
                as for<'v> fn(Env, Unknown<'v>, f64) -> Result<sys::napi_value>,
        ),
        (
            "resetAfterFromText",
            c"apiErrorResetAfterFromText",
            super::api_error_reset_after_from_text,
        ),
    ] {
        api.set_key(
            text(s, name)?,
            function(s, name, 1, 2, move |s, a| {
                if a[1].undefined()? {
                    a[1] = call(s.global()?.get(c"Date")?, c"now", &[])?;
                }
                match alternate(s)? {
                    Some(native) => call(native, method, a),
                    None => Ok(live(s, parse(environment(s), arg(a[0])?, typed(a[1])?)?)),
                }
            })?,
        )?;
    }
    let methods: [(&str, &CStr, usize, Operation); 3] = [
        ("retryNotice", c"apiErrorRetryNotice", 1, |s, a| {
            Ok(live(
                s,
                super::api_error_retry_notice(environment(s), arg(a[0])?)?,
            ))
        }),
        ("sanitizeMessage", c"apiSanitizeMessage", 3, |_, a| {
            crate::api_error_text::sanitize(a[0], a[1], a[2])
        }),
        ("isErrorOnlyText", c"apiErrorIsErrorOnlyText", 1, |s, a| {
            flag(
                s,
                super::api_error_is_error_only_text(environment(s), arg(a[0])?)?,
            )
        }),
    ];
    for (name, method, arity, direct) in methods {
        api.set_key(
            text(s, name)?,
            forward(s, name, method, arity, false, direct)?,
        )?;
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
    let envelopes: [(&str, &CStr, usize, bool, Operation); 6] = [
        (
            "splitTrailingErrorEnvelope",
            c"apiErrorSplitTrailingEnvelope",
            1,
            true,
            |s, a| {
                Ok(live(
                    s,
                    super::api_error_split_trailing_envelope(environment(s), arg(a[0])?)?,
                ))
            },
        ),
        (
            "detectErrorEnvelope",
            c"apiErrorDetectEnvelope",
            2,
            true,
            |_, a| super::detect_envelope(a[0], a[1]),
        ),
        (
            "claudeErrorEnvelope",
            c"apiErrorClaudeEnvelope",
            2,
            true,
            |s, a| {
                Ok(live(
                    s,
                    super::api_error_claude_envelope(environment(s), arg(a[0])?, arg(a[1])?)?,
                ))
            },
        ),
        (
            "envelopeSourceFor",
            c"apiErrorEnvelopeSourceFor",
            1,
            false,
            |s, a| {
                text(
                    s,
                    &super::api_error_envelope_source_for(environment(s), arg(a[0])?)?,
                )
            },
        ),
        (
            "normalizeRejection",
            c"apiNormalizeRejection",
            1,
            false,
            |_, a| crate::api_error_text::normalize_rejection(a[0]),
        ),
        (
            "isKnownHarmlessStderrLine",
            c"apiErrorIsKnownHarmlessStderrLine",
            1,
            false,
            |s, a| {
                flag(
                    s,
                    super::api_error_is_known_harmless_stderr_line(environment(s), arg(a[0])?)?,
                )
            },
        ),
    ];
    for (name, method, arity, freeze, direct) in envelopes {
        api.set_key(
            text(s, name)?,
            forward(s, name, method, arity, freeze, direct)?,
        )?;
    }
    api.set(c"API_ERROR_SIGNATURES", signatures)?;
    api.set(
        c"apiErrorSignaturesQuoted",
        function(s, "apiErrorSignaturesQuoted", 0, 0, |s, _| quoted(s))?,
    )?;
    Ok(api.raw())
}
