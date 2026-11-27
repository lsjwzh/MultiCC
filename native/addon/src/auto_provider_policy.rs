//! Live host projection and identity encoding for the shared Auto policy.
use crate::{host_methods::method, js_iteration::read, js_live::invoke, route_response::*};
use multicc_core::auto_provider_policy as policy;
use napi_derive::napi;
use std::ffi::CStr;

/// How one provider-limit cache entry reads now: `{ state, reason, usedPercent }`.
#[napi]
pub fn auto_provider_limit_state(input: String) -> napi::Result<String> {
    policy::limit_state(&input).map_err(napi::Error::from_reason)
}

/// Which line of an Auto pool to try next: `{ candidate, skipped }`.
#[napi]
pub fn auto_provider_choose_candidate(input: String) -> napi::Result<String> {
    policy::choose_candidate(&input).map_err(napi::Error::from_reason)
}

/// Whether a failed attempt may move to another line: `{ ok, reason }`.
#[napi]
pub fn auto_provider_failover_safety(input: String) -> napi::Result<String> {
    policy::failover_safety(&input).map_err(napi::Error::from_reason)
}

/// The policy's exported constants.
#[napi]
pub fn auto_provider_policy_facts() -> String {
    policy::facts()
}

const ENTRY: &[&CStr] = &[c"fetchedAt", c"status", c"summaryText"];
const SUMMARY: &[&CStr] = &[
    c"kind",
    c"revoked",
    c"blockedUntilMs",
    c"status",
    c"scope",
    c"model",
    c"usedPercentage",
    c"resetsAtMs",
    c"available",
    c"total",
];
const WINDOW: &[&CStr] = &[c"usedPercent", c"resetMs"];
const CANDIDATE: &[&CStr] = &[
    c"enabled",
    c"providerId",
    c"limitState",
    c"limitReason",
    c"tier",
    c"cli",
    c"model",
    c"priority",
    c"index",
    c"usedPercent",
    c"trustDomain",
];
const PIN: &[&CStr] = &[c"providerId", c"cli", c"model"];
const ERROR: &[&CStr] = &[
    c"retryBudgetExhausted",
    c"httpStatus",
    c"category",
    c"phase",
    c"partialOutput",
    c"sideEffects",
];
const ATTEMPT: &[&CStr] = &[
    c"replayFence",
    c"visibleOutputObserved",
    c"toolIntentObserved",
    c"sideEffectObserved",
];

fn auto_object(value: L<'_>) -> Result<bool> {
    Ok(value.truthy()? && value.kind()? == sys::ValueType::napi_object)
}
fn auto_options(value: L<'_>) -> Result<L<'_>> {
    if value.undefined()? {
        fields(value, &[])
    } else {
        Ok(value)
    }
}
fn auto_default<'a>(options: L<'a>, key: &CStr, default: V) -> Result<L<'a>> {
    let value = read(options, key)?;
    if value.undefined()? {
        options.from_value(&default)
    } else {
        Ok(value)
    }
}
fn auto_encoder(api: L<'_>) -> Result<L<'_>> {
    fields(
        api,
        &[
            ("api", api),
            ("ids", api.global()?.get(c"Map")?.construct(&[])?),
        ],
    )
}
fn auto_number(value: L<'_>) -> Result<L<'_>> {
    if call(value.global()?.get(c"Number")?, c"isFinite", &[value])?.truthy()? {
        Ok(value)
    } else {
        fields(value, &[("$num", string(value)?)])
    }
}
fn auto_wire<'a>(encoder: L<'a>, value: L<'a>) -> Result<L<'a>> {
    match value.kind()? {
        sys::ValueType::napi_undefined => return fields(encoder, &[("$u", num(encoder, 1.0)?)]),
        sys::ValueType::napi_null | sys::ValueType::napi_string | sys::ValueType::napi_boolean => {
            return Ok(value)
        }
        sys::ValueType::napi_number => return auto_number(value),
        _ => {}
    }
    let ids = encoder.get(c"ids")?;
    if !call(ids, c"has", &[value])?.truthy()? {
        let set = read(ids, c"set")?;
        set.call(ids, &[value, read(ids, c"size")?])?;
    }
    // Conversion failures are independent: a failed String must not suppress
    // Number, and the live identity is reused even when both conversions fail.
    let printable = match encoder.catch(|| string(value))? {
        Some(value) => value,
        None => text(encoder, "")?,
    };
    let numeric = match encoder.catch(|| value.global()?.get(c"Number")?.call_plain(&[value]))? {
        Some(value) => value,
        None => num(encoder, f64::NAN)?,
    };
    fields(
        encoder,
        &[
            ("$js", call(ids, c"get", &[value])?),
            ("text", printable),
            ("num", auto_number(numeric)?),
        ],
    )
}
fn auto_fields<'a>(encoder: L<'a>, value: L<'a>, keys: &[&CStr]) -> Result<L<'a>> {
    let out = fields(encoder, &[])?;
    for key in keys {
        let value = read(value, key)?;
        if !value.undefined()? {
            out.assign(key, auto_wire(encoder, value)?)?;
        }
    }
    Ok(out)
}
fn auto_callback<'a>(encoder: L<'a>, key: &CStr) -> Result<L<'a>> {
    let template = encoder.get(c"api")?.get(key)?;
    let bound = call(
        template,
        c"bind",
        &[encoder.from_value(&V::Undefined)?, encoder],
    )?;
    call(
        encoder.global()?.get(c"Object")?,
        c"defineProperty",
        &[
            bound,
            text(encoder, "name")?,
            fields(encoder, &[("value", text(encoder, "")?)])?,
        ],
    )?;
    Ok(bound)
}
fn auto_from<'a>(encoder: L<'a>, value: L<'a>, callback: &CStr) -> Result<L<'a>> {
    let array = encoder.global()?.get(c"Array")?;
    let from = read(array, c"from")?;
    invoke(
        array,
        from,
        &[value, auto_callback(encoder, callback)?],
        "Array.from",
    )
}
fn auto_answer<'a>(
    api: L<'a>,
    policy: fn(String) -> Result<String>,
    request: L<'a>,
) -> Result<L<'a>> {
    let json = api.global()?.get(c"JSON")?;
    let parse = read(json, c"parse")?;
    let payload = call(api.global()?.get(c"JSON")?, c"stringify", &[request])?;
    parse.call(
        json,
        &[text(api, &policy(crate::host_methods::typed(payload)?)?)?],
    )
}
fn auto_limit<'a>(api: L<'a>, entry: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let options = auto_options(options)?;
    let now = read(options, c"now")?;
    let now = if now.undefined()? {
        call(api.global()?.get(c"Date")?, c"now", &[])?
    } else {
        now
    };
    let stale = read(options, c"staleAfterMs")?;
    let model = read(options, c"model")?;
    let encoder = auto_encoder(api)?;
    let projected = if auto_object(entry)? {
        let projected = auto_fields(encoder, entry, ENTRY)?;
        let summary = read(entry, c"summary")?;
        if auto_object(summary)? {
            projected.assign(c"summary", auto_fields(encoder, summary, SUMMARY)?)?;
            if read(summary, c"windows")?.is_array()? {
                let windows = auto_from(encoder, read(summary, c"windows")?, c"window")?;
                projected.get(c"summary")?.assign(c"windows", windows)?;
            }
        }
        projected
    } else {
        null(api)?
    };
    let request = fields(
        api,
        &[("entry", projected), ("now", auto_wire(encoder, now)?)],
    )?;
    if !stale.undefined()? {
        request.assign(c"staleAfterMs", auto_wire(encoder, stale)?)?;
    }
    if !model.undefined()? {
        request.assign(c"model", auto_wire(encoder, model)?)?;
    }
    auto_answer(api, auto_provider_limit_state, request)?.freeze()
}
fn auto_choose<'a>(api: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let options = auto_options(options)?;
    if options.nullish()? {
        return Err(options.type_error("Cannot destructure property 'candidates' of '(intermediate value)(intermediate value)(intermediate value)' as it is null."));
    }
    let candidates = read(options, c"candidates")?;
    let attempted = read(options, c"attempted")?;
    let attempted = if attempted.undefined()? {
        api.global()?.get(c"Set")?.construct(&[])?
    } else {
        attempted
    };
    let sticky = auto_default(options, c"stickyProviderId", V::Null)?;
    let tier = auto_default(options, c"preferredTier", V::Null)?;
    let ladder = auto_default(options, c"ladder", V::Null)?;
    let pinned = auto_default(options, c"pinned", V::Null)?;
    let cli = auto_default(options, c"preferCli", V::Null)?;
    let price = auto_default(options, c"byPrice", V::Bool(false))?;
    let quota = auto_default(options, c"byQuota", V::Bool(false))?;
    let list = if candidates.is_array()? {
        candidates
    } else {
        api.from_value(&V::Array(vec![]))?
    };
    let encoder = auto_encoder(api)?;
    encoder.set(c"list", list)?;
    encoder.set(c"ladder", ladder)?;
    let request = fields(
        api,
        &[
            ("candidates", auto_from(encoder, list, c"candidate")?),
            ("attempted", auto_from(encoder, attempted, c"wire")?),
            ("stickyProviderId", auto_wire(encoder, sticky)?),
            ("preferredTier", auto_wire(encoder, tier)?),
        ],
    )?;
    let ladder = if ladder.is_array()? {
        auto_from(
            encoder,
            fields(api, &[("length", read(ladder, c"length")?)])?,
            c"ladder",
        )?
    } else {
        null(api)?
    };
    request.assign(c"ladder", ladder)?;
    request.assign(
        c"pinned",
        if pinned.truthy()? {
            auto_fields(encoder, pinned, PIN)?
        } else {
            null(api)?
        },
    )?;
    request.assign(c"preferCli", auto_wire(encoder, cli)?)?;
    request.assign(c"byPrice", auto_wire(encoder, price)?)?;
    request.assign(c"byQuota", auto_wire(encoder, quota)?)?;
    let answer = auto_answer(api, auto_provider_choose_candidate, request)?;
    let candidate = if read(answer, c"candidate")?.nullish()? {
        null(api)?
    } else {
        list.get_key(read(answer, c"candidate")?)?
    };
    let skipped = read(answer, c"skipped")?;
    let map = read(skipped, c"map")?;
    let skipped = invoke(
        skipped,
        map,
        &[auto_callback(encoder, c"skipped")?],
        "answer.skipped.map",
    )?
    .freeze()?;
    fields(api, &[("candidate", candidate), ("skipped", skipped)])?.freeze()
}
fn auto_failover<'a>(api: L<'a>, decision: L<'a>, attempt: L<'a>) -> Result<L<'a>> {
    let encoder = auto_encoder(api)?;
    let request = fields(
        api,
        &[
            ("decision", null(api)?),
            (
                "attempt",
                if attempt.truthy()? {
                    auto_fields(encoder, attempt, ATTEMPT)?
                } else {
                    null(api)?
                },
            ),
        ],
    )?;
    if decision.truthy()? {
        request.assign(c"decision", auto_fields(encoder, decision, &[c"reason"])?)?;
        if read(decision, c"error")?.truthy()? {
            request.get(c"decision")?.assign(
                c"error",
                auto_fields(encoder, read(decision, c"error")?, ERROR)?,
            )?;
        }
    }
    auto_answer(api, auto_provider_failover_safety, request)?.freeze()
}

#[napi]
pub fn auto_provider_policy_api(env: Env, native: Unknown<'_>) -> Result<sys::napi_value> {
    let native = L::new(&env, native);
    let facts = call(
        native.global()?.get(c"JSON")?,
        c"parse",
        &[text(native, &auto_provider_policy_facts())?],
    )?;
    let api = fields(
        native,
        &[(
            "hole",
            fields(native, &[("$hole", num(native, 1.0)?)])?.freeze()?,
        )],
    )?;
    api.set(
        c"wire",
        method(&env, api, "", 2, 2, |_, a| auto_wire(a[0], a[1]))?,
    )?;
    api.set(
        c"window",
        method(&env, api, "", 2, 2, |_, a| {
            if a[1].truthy()? {
                auto_fields(a[0], a[1], WINDOW)
            } else {
                null(a[0])
            }
        })?,
    )?;
    api.set(
        c"candidate",
        method(&env, api, "", 2, 2, |_, a| {
            if !a[1].truthy()? {
                return null(a[0]);
            }
            let projected = auto_fields(a[0], a[1], CANDIDATE)?;
            if read(a[1], c"price")?.truthy()? {
                projected.assign(c"priced", flag(a[0], true)?)?;
                if !read(read(a[1], c"price")?, c"blended")?.undefined()? {
                    projected.assign(
                        c"blended",
                        auto_wire(a[0], read(read(a[1], c"price")?, c"blended")?)?,
                    )?;
                }
            }
            Ok(projected)
        })?,
    )?;
    api.set(
        c"ladder",
        method(&env, api, "", 3, 3, |s, a| {
            let ladder = a[0].get(c"ladder")?;
            if call(s.global()?.get(c"Reflect")?, c"has", &[ladder, a[2]])?.truthy()? {
                auto_wire(a[0], ladder.get_key(a[2])?)
            } else {
                s.get(c"hole")
            }
        })?,
    )?;
    api.set(
        c"skipped",
        method(&env, api, "", 2, 2, |_, a| {
            let index = read(a[1], c"index")?;
            let reason = read(a[1], c"reason")?;
            let list = a[0].get(c"list")?;
            let provider = read(list.get_key(index)?, c"providerId")?;
            let reason = if reason.nullish()? {
                read(list.get_key(index)?, c"limitReason")?
            } else {
                reason
            };
            fields(a[0], &[("providerId", provider), ("reason", reason)])
        })?,
    )?;
    let set = native.global()?.get(c"Set")?;
    Ok(fields(
        api,
        &[
            (
                "NON_FAILOVER_CATEGORIES",
                set.construct(&[read(facts, c"nonFailoverCategories")?])?,
            ),
            ("NEAR_LIMIT_PERCENT", read(facts, c"nearLimitPercent")?),
            (
                "SAFE_PHASES",
                set.construct(&[read(facts, c"safePhases")?])?,
            ),
            (
                "chooseCandidate",
                method(&env, api, "chooseCandidate", 0, 1, |s, a| {
                    auto_choose(s, a[0])
                })?,
            ),
            (
                "failoverSafety",
                method(&env, api, "failoverSafety", 2, 2, |s, a| {
                    auto_failover(s, a[0], a[1])
                })?,
            ),
            (
                "limitState",
                method(&env, api, "limitState", 1, 2, |s, a| {
                    auto_limit(s, a[0], a[1])
                })?,
            ),
        ],
    )?
    .raw())
}
