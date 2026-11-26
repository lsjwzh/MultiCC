//! Retry composition and scheduling over live clock, random and classifier ports.
use crate::{host_methods::method, js_iteration::read, js_live::invoke, route_response::*};
use multicc_core::js::JsString;
use napi::bindgen_prelude::JsValue as _;
use napi_derive::napi;

#[napi]
pub fn retry_policy_value(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let raw = env.raw();
    let input = unsafe { crate::js_bridge::read_value(raw, input.raw(), 0, &mut Vec::new()) }?;
    let result = multicc_core::retry_policy::decide(&input);
    unsafe { crate::js_bridge::write_value(raw, &result) }
}

fn retry_options(value: L<'_>) -> Result<L<'_>> {
    if value.undefined()? {
        fields(value, &[])
    } else {
        Ok(value)
    }
}
fn retry_count(value: L<'_>) -> Result<L<'_>> {
    let number = value
        .global()?
        .get(c"Number")?
        .call_plain(&[fallback(value, V::Number(0.0))?])?;
    if call(value.global()?.get(c"Number")?, c"isInteger", &[number])?.truthy()?
        && number.number()? >= 0.0
    {
        Ok(number)
    } else {
        num(value, 0.0)
    }
}
fn retry_primitive(value: L<'_>) -> Result<L<'_>> {
    let primitive = |v: L<'_>| -> Result<bool> {
        Ok(!matches!(
            v.kind()?,
            sys::ValueType::napi_object | sys::ValueType::napi_function
        ))
    };
    if primitive(value)? {
        return Ok(value);
    }
    let exotic = value.get_key(value.global()?.get(c"Symbol")?.get(c"toPrimitive")?)?;
    if !exotic.nullish()? {
        let result = invoke(
            value,
            exotic,
            &[text(value, "default")?],
            "Symbol.toPrimitive",
        )?;
        if primitive(result)? {
            return Ok(result);
        }
        return Err(value.type_error("Cannot convert object to primitive value"));
    }
    for key in [c"valueOf", c"toString"] {
        let f = read(value, key)?;
        if f.kind()? == sys::ValueType::napi_function {
            let result = f.call(value, &[])?;
            if primitive(result)? {
                return Ok(result);
            }
        }
    }
    Err(value.type_error("Cannot convert object to primitive value"))
}
fn retry_add<'a>(left: L<'a>, right: L<'a>) -> Result<L<'a>> {
    let left = retry_primitive(left)?;
    let right = retry_primitive(right)?;
    if left.kind()? == sys::ValueType::napi_string || right.kind()? == sys::ValueType::napi_string {
        let mut units = left.coerce_string()?.into_units();
        units.extend_from_slice(right.coerce_string()?.as_units());
        return left.from_value(&V::String(JsString::from_units(units)));
    }
    if left.kind()? == sys::ValueType::napi_bigint || right.kind()? == sys::ValueType::napi_bigint {
        return Err(left.type_error("Cannot mix BigInt and other types, use explicit conversions"));
    }
    num(left, left.number()? + right.number()?)
}
fn retry_schedule<'a>(
    action: L<'a>,
    classification: L<'a>,
    attempt: L<'a>,
    base: L<'a>,
    deps: L<'a>,
    extra: L<'a>,
) -> Result<L<'a>> {
    let now = if read(deps, c"now")?.kind()? == sys::ValueType::napi_function {
        let number = deps.global()?.get(c"Number")?;
        number.call_plain(&[invoke(deps, read(deps, c"now")?, &[], "deps.now")?])?
    } else {
        call(deps.global()?.get(c"Date")?, c"now", &[])?
    };
    let random = if read(deps, c"random")?.kind()? == sys::ValueType::napi_function {
        read(deps, c"random")?
    } else {
        read(deps.global()?.get(c"Math")?, c"random")?
    };
    let math = deps.global()?.get(c"Math")?;
    let max = read(math, c"max")?;
    let number = deps.global()?.get(c"Number")?;
    let jitter_ms = max.call(
        math,
        &[
            num(deps, 0.0)?,
            number.call_plain(&[fallback(read(deps, c"jitterMs")?, V::Number(0.0))?])?,
        ],
    )?;
    let sampled = if jitter_ms.truthy()? {
        let number = deps.global()?.get(c"Number")?;
        number.call_plain(&[invoke(
            deps.from_value(&V::Undefined)?,
            random,
            &[],
            "random",
        )?])?
    } else {
        num(deps, 0.0)?
    };
    let unit = if call(deps.global()?.get(c"Number")?, c"isFinite", &[sampled])?.truthy()? {
        let math = deps.global()?.get(c"Math")?;
        let max = read(math, c"max")?;
        let min = call(
            deps.global()?.get(c"Math")?,
            c"min",
            &[num(deps, 0.999999)?, sampled],
        )?;
        max.call(math, &[num(deps, 0.0)?, min])?
    } else {
        num(deps, 0.0)?
    };
    let jitter = if jitter_ms.truthy()? {
        call(
            deps.global()?.get(c"Math")?,
            c"floor",
            &[num(deps, unit.number()? * jitter_ms.number()?)?],
        )?
    } else {
        num(deps, 0.0)?
    };
    let math = deps.global()?.get(c"Math")?;
    let max = read(math, c"max")?;
    let number = deps
        .global()?
        .get(c"Number")?
        .call_plain(&[fallback(base, V::Number(0.0))?])?;
    let delay = retry_add(max.call(math, &[num(deps, 0.0)?, number])?, jitter)?;
    let result = fields(
        deps,
        &[
            ("action", action),
            ("classification", classification),
            ("attempt", attempt),
            ("delayMs", delay),
            ("scheduledAt", retry_add(now, delay)?),
        ],
    )?;
    result.spread_from(extra)?;
    result.freeze()
}
fn retry_terminal<'a>(api: L<'a>, decision: L<'a>) -> Result<L<'a>> {
    fields(
        api,
        &[
            ("action", text(api, "fail")?),
            ("classification", text(api, "api-error")?),
            ("reason", read(decision, c"reason")?),
            ("cleanup", flag(api, true)?),
            ("decision", decision),
        ],
    )?
    .freeze()
}
fn retry_decide<'a>(api: L<'a>, input: L<'a>, deps: L<'a>) -> Result<L<'a>> {
    let input = retry_options(input)?;
    let deps = retry_options(deps)?;
    let limits = fields(api, &[])?;
    limits.spread_from(api.get(c"limits")?)?;
    limits.spread_from(fallback(read(deps, c"limits")?, V::Object(vec![]))?)?;
    let delays = fields(api, &[])?;
    delays.spread_from(api.get(c"delays")?)?;
    delays.spread_from(fallback(read(deps, c"delays")?, V::Object(vec![]))?)?;
    let stringify = api.global()?.get(c"String")?;
    let cli = call(
        stringify.call_plain(&[fallback(read(input, c"cli")?, "claude".into())?])?,
        c"toLowerCase",
        &[],
    )?;
    let stringify = api.global()?.get(c"String")?;
    let event = stringify.call_plain(&[fallback(read(input, c"event")?, "completed".into())?])?;
    let attempts = fallback(read(input, c"attempts")?, V::Object(vec![]))?;
    if event.equals(text(api, "api-error")?)? {
        let classify = api.get(c"classify")?;
        let error = fallback(read(input, c"error")?, V::Object(vec![]))?;
        let context = fields(api, &[])?;
        context.spread_from(fallback(read(input, c"context")?, V::Object(vec![]))?)?;
        context.define_key(
            text(api, "attempt")?,
            retry_count(read(attempts, c"apiError")?)?,
        )?;
        let explicit = if read(deps, c"limits")?.truthy()? {
            let has = read(
                read(api.global()?.get(c"Object")?, c"prototype")?,
                c"hasOwnProperty",
            )?;
            let caller = read(has, c"call")?;
            caller
                .call(has, &[read(deps, c"limits")?, text(api, "apiError")?])?
                .truthy()?
        } else {
            false
        };
        let maximum = if explicit {
            read(limits, c"apiError")?
        } else {
            api.from_value(&V::Undefined)?
        };
        context.define_key(text(api, "maxAttempts")?, maximum)?;
        let decision = classify.call_plain(&[error, context, deps])?;
        if !read(decision, c"action")?.equals(text(api, "retry")?)? {
            return retry_terminal(api, decision);
        }
        let attempt = read(decision, c"attempt")?;
        let base = read(decision, c"delayMs")?;
        let base = if base.nullish()? {
            read(delays, c"apiError")?
        } else {
            base
        };
        let ports = fields(api, &[])?;
        ports.spread_from(deps)?;
        ports.define_key(text(api, "jitterMs")?, num(api, 0.0)?)?;
        let extra = fields(
            api,
            &[
                ("capped", flag(api, true)?),
                ("cap", read(read(decision, c"error")?, c"maxAttempts")?),
                ("decision", decision),
            ],
        )?;
        return retry_schedule(
            text(api, "retry-api")?,
            text(api, "api-error")?,
            attempt,
            base,
            ports,
            extra,
        );
    }
    let native = api.get(c"native")?;
    let decide = read(native, c"retryPolicyValue")?;
    let request = fields(
        api,
        &[
            ("event", event),
            ("cli", cli),
            (
                "attempts",
                fields(
                    api,
                    &[
                        ("freshStart", read(attempts, c"freshStart")?),
                        ("codexDisconnect", read(attempts, c"codexDisconnect")?),
                        ("interruptedResume", read(attempts, c"interruptedResume")?),
                    ],
                )?,
            ),
            (
                "limits",
                fields(
                    api,
                    &[
                        ("freshStart", read(limits, c"freshStart")?),
                        ("codexDisconnect", read(limits, c"codexDisconnect")?),
                        ("interruptedResume", read(limits, c"interruptedResume")?),
                    ],
                )?,
            ),
        ],
    )?;
    for (key, strict) in [
        (c"killReason", false),
        (c"userStopped", true),
        (c"hasExplicitWait", true),
        (c"hasOutput", false),
        (c"resultSaved", false),
        (c"hasNativeSession", false),
        (c"adapterError", false),
        (c"guardedHandoff", false),
        (c"isRetry", true),
    ] {
        let value = read(input, key)?;
        request.define_key(
            text(api, key.to_str().expect("static key"))?,
            flag(
                api,
                if strict {
                    value.equals(flag(api, true)?)?
                } else {
                    value.truthy()?
                },
            )?,
        )?;
    }
    let plan = decide.call(native, &[request])?;
    if !read(plan, c"delayKey")?.truthy()? {
        return plan.freeze();
    }
    let action = read(plan, c"action")?;
    let classification = read(plan, c"classification")?;
    let attempt = read(plan, c"attempt")?;
    let delay = delays.get_key(read(plan, c"delayKey")?)?;
    let extra = fields(api, &[("cap", read(plan, c"cap")?)])?;
    retry_schedule(action, classification, attempt, delay, deps, extra)
}

#[napi]
pub fn retry_policy_api(
    env: Env,
    native: Unknown<'_>,
    classify: Unknown<'_>,
) -> Result<sys::napi_value> {
    let native = L::new(&env, native);
    let limits = fields(
        native,
        &[
            ("freshStart", num(native, 1.0)?),
            ("codexDisconnect", num(native, 2.0)?),
            ("interruptedResume", num(native, 10.0)?),
        ],
    )?
    .freeze()?;
    let delays = fields(
        native,
        &[
            ("freshStart", num(native, 0.0)?),
            ("codexDisconnect", num(native, 0.0)?),
            ("interruptedResume", num(native, 0.0)?),
            ("apiError", num(native, 0.0)?),
        ],
    )?
    .freeze()?;
    let api = fields(
        native,
        &[
            ("native", native),
            ("classify", L::new(&env, classify)),
            ("limits", limits),
            ("delays", delays),
        ],
    )?;
    Ok(fields(
        api,
        &[
            ("DEFAULT_LIMITS", limits),
            ("DEFAULT_DELAYS", delays),
            (
                "decideRetry",
                method(&env, api, "decideRetry", 0, 2, |s, a| {
                    retry_decide(s, a[0], a[1])
                })?,
            ),
        ],
    )?
    .raw())
}
