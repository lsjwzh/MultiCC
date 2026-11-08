//! Identity policy owns validation and hashing. JS retains only its public
//! Error constructor and live values needed for getter/JSON behavior.
use crate::js_live::LiveValue;
use multicc_core::{
    js::{JsString, JsValue},
    provider_attempt_identity as policy,
};
use napi::{bindgen_prelude::Unknown, sys, Env, Error, Result};
use napi_derive::napi;

fn identity_error(constructor: LiveValue<'_>, message: &str) -> Result<Error> {
    provider_error(constructor, message, "PROVIDER_ATTEMPT_IDENTITY_INVALID")
}

fn provider_error(constructor: LiveValue<'_>, message: &str, code: &str) -> Result<Error> {
    Ok(constructor
        .construct(&[
            constructor.from_value(&JsValue::string(message))?,
            constructor.from_value(&JsValue::string(code))?,
        ])?
        .throw_error())
}

#[napi]
pub fn provider_validate_attempt_transition(
    env: Env,
    previous: Unknown<'_>,
    previous_fence: Unknown<'_>,
    facts: Unknown<'_>,
    constructor: Unknown<'_>,
) -> Result<()> {
    let previous = LiveValue::new(&env, previous);
    let fence = LiveValue::new(&env, previous_fence);
    let facts = LiveValue::new(&env, facts);
    let constructor = LiveValue::new(&env, constructor);
    if previous.truthy()?
        && previous.get(c"turnId")?.equals(facts.get(c"turnId")?)?
        && !fence.get(c"replayFence")?.is_string("none")?
        && !facts.get(c"continuation")?.truthy()?
    {
        return Err(provider_error(
            constructor,
            "provider attempt cannot be replayed after observable output or tool intent",
            "PROVIDER_REPLAY_FENCE_CLOSED",
        )?);
    }
    if previous.truthy()? {
        let lifecycle = previous.get(c"lifecycle")?;
        if lifecycle.get(c"running")?.call(lifecycle, &[])?.truthy()? {
            return Err(provider_error(
                constructor,
                "provider attempt is still running",
                "PROVIDER_ATTEMPT_IN_FLIGHT",
            )?);
        }
    }
    if previous.truthy()? && previous.get(c"turnId")?.equals(facts.get(c"turnId")?)? {
        let lifecycle = previous.get(c"lifecycle")?;
        if lifecycle
            .get(c"succeeded")?
            .call(lifecycle, &[])?
            .truthy()?
        {
            return Err(provider_error(
                constructor,
                "a succeeded turn cannot start another provider attempt",
                "PROVIDER_TURN_ALREADY_SUCCEEDED",
            )?);
        }
        if facts.get(c"continuation")?.truthy()?
            && (!previous
                .get(c"providerId")?
                .equals(facts.get(c"providerId")?)?
                || !previous.get(c"model")?.equals(facts.get(c"model")?)?
                || !previous.get(c"protocol")?.equals(facts.get(c"protocol")?)?)
        {
            return Err(provider_error(
                constructor,
                "a continuation must retain the concrete provider route",
                "PROVIDER_CONTINUATION_ROUTE_CHANGED",
            )?);
        }
        // Both attempt numbers were validated at admission; the left side is
        // always a safe positive Number, so numeric comparison is sufficient.
        let next = facts.get(c"attemptNo")?.number()?;
        if next <= number(previous.get(c"attemptNo")?)?.number()? {
            return Err(provider_error(
                constructor,
                "attemptNo must increase within one turn",
                "PROVIDER_ATTEMPT_SEQUENCE_INVALID",
            )?);
        }
    }
    Ok(())
}

fn required<'a>(
    value: LiveValue<'a>,
    label: &str,
    constructor: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
    let text = value.clean_text()?;
    if !text.string()?.as_ref().is_some_and(policy::valid_identity) {
        return Err(identity_error(
            constructor,
            &format!("{label} is required"),
        )?);
    }
    Ok(text)
}

fn number(value: LiveValue<'_>) -> Result<LiveValue<'_>> {
    // Number() accepts BigInt; ECMAScript ToNumber does not.
    value.global()?.get(c"Number")?.call_plain(&[value])
}

fn integer<'a>(
    value: LiveValue<'a>,
    label: &str,
    constructor: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
    let number = number(value)?;
    if !policy::positive_integer(number.number_value()?) {
        return Err(identity_error(
            constructor,
            &format!("{label} must be a positive integer"),
        )?);
    }
    Ok(number)
}

#[napi]
pub fn provider_required_identity(
    env: Env,
    value: Unknown<'_>,
    label: String,
    constructor: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(required(
        LiveValue::new(&env, value),
        &label,
        LiveValue::new(&env, constructor),
    )?
    .raw())
}

#[napi]
pub fn provider_positive_integer(
    env: Env,
    value: Unknown<'_>,
    label: String,
    constructor: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(integer(
        LiveValue::new(&env, value),
        &label,
        LiveValue::new(&env, constructor),
    )?
    .raw())
}

#[napi]
pub fn provider_timeout_budget(env: Env, value: Unknown<'_>) -> Result<f64> {
    let number = number(LiveValue::new(&env, value))?.number_value()?;
    Ok(if policy::positive_integer(number) {
        number.unwrap()
    } else {
        0.0
    })
}

#[napi]
pub fn provider_attempt_fields(
    env: Env,
    reference: Unknown<'_>,
    constructor: Unknown<'_>,
) -> Result<sys::napi_value> {
    let reference = LiveValue::new(&env, reference);
    let constructor = LiveValue::new(&env, constructor);
    if !reference.truthy()? || reference.kind()? != sys::ValueType::napi_object {
        return Err(identity_error(constructor, "provider attempt is required")?);
    }
    let fields = reference.from_value(&JsValue::object(vec![
        ("providerRouteProtocolVersion", 1.0.into()),
        ("providerRouteScope", JsValue::string("attempt")),
    ]))?;
    for (key, label) in [
        (c"cli", "cli"),
        (c"runtimeEpoch", "runtimeEpoch"),
        (c"turnId", "turnId"),
        (c"decisionId", "decisionId"),
        (c"routeAttemptId", "routeAttemptId"),
    ] {
        fields.set(key, required(reference.get(key)?, label, constructor)?)?;
    }
    for (key, label) in [
        (c"routeGeneration", "routeGeneration"),
        (c"attemptNo", "attemptNo"),
    ] {
        fields.set(key, integer(reference.get(key)?, label, constructor)?)?;
    }
    for (key, label) in [
        (c"providerId", "providerId"),
        (c"providerRevision", "providerRevision"),
    ] {
        fields.set(key, required(reference.get(key)?, label, constructor)?)?;
    }
    Ok(fields.freeze()?.raw())
}

#[napi]
pub fn provider_revision(env: Env, input: Unknown<'_>, constructor: Unknown<'_>) -> Result<String> {
    let input = LiveValue::new(&env, input);
    let constructor = LiveValue::new(&env, constructor);
    let summary = if input.get(c"summary")?.truthy()?
        && input.get(c"summary")?.kind()? == sys::ValueType::napi_object
    {
        input.get(c"summary")?
    } else {
        input.from_value(&JsValue::Object(vec![]))?
    };
    let aliases = input.from_value(&JsValue::Object(vec![]))?;
    if summary.get(c"aliasMap")?.truthy()?
        && summary.get(c"aliasMap")?.kind()? == sys::ValueType::napi_object
    {
        let object = input.global()?.get(c"Object")?;
        let keys = object
            .get(c"keys")?
            .call(object, &[summary.get(c"aliasMap")?])?;
        let keys = keys.get(c"sort")?.call(keys, &[])?;
        let length = keys.get(c"length")?.number()? as u32;
        for index in 0..length {
            let key = keys.element(index)?;
            aliases.define_key(key, summary.get(c"aliasMap")?.get_key(key)?)?;
        }
    }
    let route = input.from_value(&JsValue::Object(vec![]))?;
    let cli = required(input.get(c"cli")?, "cli", constructor)?;
    route.set(c"cli", cli.get(c"toLowerCase")?.call(cli, &[])?)?;
    for (key, label) in [
        (c"providerId", "providerId"),
        (c"protocol", "protocol"),
        (c"model", "model"),
    ] {
        route.set(key, required(input.get(key)?, label, constructor)?)?;
    }
    for key in [c"appType", c"baseUrl", c"source", c"apiFormat", c"wireApi"] {
        let text = summary.get(key)?.clean_text()?;
        route.set(
            key,
            if text.truthy()? {
                text
            } else {
                input.from_value(&JsValue::Null)?
            },
        )?;
    }
    route.set(c"aliasMap", aliases)?;
    route.set(
        c"isOfficial",
        input.from_value(&JsValue::Bool(summary.get(c"isOfficial")?.is_true()?))?,
    )?;
    let json = input.global()?.get(c"JSON")?;
    let serialized = json.get(c"stringify")?.call(json, &[route])?;
    let serialized = serialized
        .string()?
        .ok_or_else(|| input.type_error("provider revision must serialize to a string"))?;
    Ok(policy::provider_revision(&serialized))
}

fn string(value: LiveValue<'_>) -> Result<JsString> {
    let value = value.global()?.get(c"String")?.call_plain(&[value])?;
    value
        .string()?
        .ok_or_else(|| value.type_error("String conversion did not return a string"))
}

#[napi]
pub fn provider_encode_proxy_session(
    env: Env,
    session: Unknown<'_>,
    token: Unknown<'_>,
) -> Result<String> {
    let session = string(LiveValue::new(&env, session))?;
    let token = string(LiveValue::new(&env, token))?;
    Ok(policy::encode_proxy_session(&session, &token))
}

#[napi]
pub fn provider_decode_proxy_session(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    let value = LiveValue::new(&env, value);
    let raw = value
        .clean_text()?
        .string()?
        .ok_or_else(|| value.type_error("session id must be a string"))?;
    Ok(value.from_value(&policy::decode_proxy_session(raw))?.raw())
}
