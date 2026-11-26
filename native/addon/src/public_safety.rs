//! Public error projections keep borrowed JS fields, arrays and exceptions.
//! Text normalization shares the gateway's UTF-16 kernel.
use crate::{host_methods::method, js_iteration::read, route_response::*};
use multicc_core::public_safety as policy;
use napi_derive::napi;

fn valid<'a>(state: L<'a>, value: L<'a>, id: bool) -> Result<L<'a>> {
    if value.kind()? != sys::ValueType::napi_string {
        return flag(state, false);
    }
    let pattern = state.get(if id { c"ID_PATTERN" } else { c"CODE_PATTERN" })?;
    call(pattern, c"test", &[value])
}

fn relative(value: L<'_>) -> Result<L<'_>> {
    let Some(text) = value.string()? else {
        return null(value);
    };
    match policy::safe_relative_js_path(&text) {
        Some(text) => value.from_value(&V::String(text)),
        None => null(value),
    }
}

fn unique_slice<'a>(state: L<'a>, values: L<'a>, limit: f64) -> Result<L<'a>> {
    let set = state.global()?.get(c"Set")?.construct(&[values])?;
    let array = state.from_value(&V::Array(vec![]))?;
    let mut index = 0usize;
    set.for_each(|value| {
        array.define_key(text(array, &index.to_string())?, value)?;
        index += 1;
        Ok(())
    })?;
    call(array, c"slice", &[num(state, 0.0)?, num(state, limit)?])
}

fn ids<'a>(state: L<'a>, value: L<'a>) -> Result<L<'a>> {
    if !value.is_array()? {
        return null(state);
    }
    let filtered = call(value, c"filter", &[state.get(c"validId")?])?;
    unique_slice(state, filtered, 100.0)?.freeze()
}

fn compatibility<'a>(state: L<'a>, source: L<'a>) -> Result<L<'a>> {
    let out = fields(state, &[])?;
    if !source.truthy()? || source.kind()? != sys::ValueType::napi_object || source.is_array()? {
        return out.freeze();
    }
    if source.get(c"blocked")?.kind()? == sys::ValueType::napi_boolean {
        out.assign(c"blocked", source.get(c"blocked")?)?;
    }
    if source.get(c"reasons")?.is_array()? {
        let filtered = call(
            source.get(c"reasons")?,
            c"filter",
            &[state.get(c"validCode")?],
        )?;
        let reasons = unique_slice(state, filtered, 50.0)?;
        if reasons.get(c"length")?.truthy()? {
            out.assign(c"reasons", reasons.freeze()?)?;
        }
    }
    if source.get(c"conflicts")?.is_array()? {
        let mapped = call(
            source.get(c"conflicts")?,
            c"map",
            &[state.get(c"relative")?],
        )?;
        let filter = read(mapped, c"filter")?;
        let filtered = filter.call(mapped, &[state.global()?.get(c"Boolean")?])?;
        let conflicts = unique_slice(state, filtered, 100.0)?;
        if conflicts.get(c"length")?.truthy()? {
            out.assign(c"conflicts", conflicts.freeze()?)?;
        }
    }
    for key in [c"operationId", c"field", c"currentStatus"] {
        if valid(state, source.get(key)?, true)?.truthy()? {
            out.assign(key, source.get(key)?)?;
        }
    }
    for key in [
        c"queueDepth",
        c"retryAfter",
        c"retryAfterSec",
        c"retryAfterMs",
    ] {
        let value = source.get(key)?;
        if value
            .number_value()?
            .is_some_and(|number| number.is_finite() && number >= 0.0)
        {
            out.assign(key, value)?;
        }
    }
    for key in [c"sessions", c"sessionIds"] {
        let values = ids(state, source.get(key)?)?;
        if values.truthy()? && values.get(c"length")?.truthy()? {
            out.assign(key, values)?;
        }
    }
    out.freeze()
}

#[napi]
pub fn public_safety_api(env: Env, anchor: Unknown<'_>) -> Result<sys::napi_value> {
    let anchor = L::new(&env, anchor);
    let regexp = anchor.global()?.get(c"RegExp")?;
    let state = fields(
        anchor,
        &[
            (
                "CODE_PATTERN",
                regexp.construct(&[text(anchor, "^[A-Za-z0-9_.-]{1,40}$")?])?,
            ),
            (
                "ID_PATTERN",
                regexp.construct(&[text(anchor, "^[A-Za-z0-9._:-]{1,128}$")?])?,
            ),
        ],
    )?;
    let valid_code = method(&env, state, "validCode", 1, 1, |state, args| {
        valid(state, args[0], false)
    })?;
    let valid_id = method(&env, state, "validId", 1, 1, |state, args| {
        valid(state, args[0], true)
    })?;
    state.set(c"validCode", valid_code)?;
    state.set(c"validId", valid_id)?;
    state.set(
        c"relative",
        method(&env, state, "safeRelativePath", 1, 1, |_, args| {
            relative(args[0])
        })?,
    )?;
    Ok(fields(
        state,
        &[
            ("CODE_PATTERN", state.get(c"CODE_PATTERN")?),
            ("ID_PATTERN", state.get(c"ID_PATTERN")?),
            (
                "containsSensitiveText",
                method(&env, state, "containsSensitiveText", 1, 1, |state, args| {
                    let value = string(fallback(args[0], "".into())?)?.coerce_string()?;
                    flag(state, policy::contains_sensitive_js_text(&value))
                })?,
            ),
            (
                "safeCode",
                method(&env, state, "safeCode", 1, 2, |state, args| {
                    if valid(state, args[0], false)?.truthy()? {
                        return Ok(args[0]);
                    }
                    if args[1].undefined()? {
                        text(state, "request_error")
                    } else {
                        Ok(args[1])
                    }
                })?,
            ),
            (
                "sanitizeCompatibility",
                method(&env, state, "sanitizeCompatibility", 1, 1, |state, args| {
                    compatibility(state, args[0])
                })?,
            ),
            (
                "sanitizePublicText",
                method(&env, state, "sanitizePublicText", 1, 2, |state, args| {
                    let value = args[0].string()?;
                    let fallback = args[1].string()?;
                    state.from_value(&V::String(policy::sanitize_public_live_text(
                        value.as_ref(),
                        fallback.as_ref(),
                    )))
                })?,
            ),
            ("validCode", valid_code),
            ("validId", valid_id),
        ],
    )?
    .raw())
}
