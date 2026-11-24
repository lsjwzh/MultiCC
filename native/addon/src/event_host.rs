//! Adapt live event-engine inputs to the shared rules, including lazy task-state
//! reads and the two factories that run only after a rule has been accepted.
use crate::js_live::LiveValue as L;
use multicc_core::js::JsValue as J;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

fn object(anchor: L<'_>) -> Result<L<'_>> {
    anchor.from_value(&J::Object(vec![]))
}

fn request<'a>(op: &str, input: L<'a>) -> Result<L<'a>> {
    let json = input.global()?.get(c"JSON")?;
    let raw = json
        .get(c"stringify")?
        .call(json, &[input])?
        .coerce_string()?
        .to_string_lossy();
    let result = super::events::events_request(op.to_owned(), raw)?;
    json.get(c"parse")?
        .call(json, &[input.from_value(&J::string(&result))?])
}

fn string_or_null(value: L<'_>) -> Result<L<'_>> {
    if value.kind()? == sys::ValueType::napi_string {
        Ok(value)
    } else {
        value.from_value(&J::Null)
    }
}

fn pattern_request<'a>(op: &str, first: L<'a>, second: L<'a>, mapper: L<'a>) -> Result<L<'a>> {
    let input = object(first)?;
    if op == "matchesAny" {
        let patterns = if first.is_array()? {
            let array = first.global()?.get(c"Array")?;
            array.get(c"from")?.call(array, &[first, mapper])?
        } else {
            first.from_value(&J::Null)?
        };
        input.set(c"patterns", patterns)?;
    } else {
        input.set(c"pattern", string_or_null(first)?)?;
    }
    if op != "isKnownPattern" {
        input.set(c"type", string_or_null(second)?)?;
    }
    request(op, input)
}

#[napi]
pub fn event_pattern_string(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(string_or_null(L::new(&env, value))?.raw())
}

fn project_state(value: L<'_>) -> Result<L<'_>> {
    if value.kind()? != sys::ValueType::napi_object {
        return Ok(value);
    }
    let slim = object(value)?;
    for key in [
        c"classifyState",
        c"goalState",
        c"taskId",
        c"goal",
        c"phase",
        c"startedAt",
        c"cancelledAt",
        c"cancelReason",
        c"goalStateManualAt",
    ] {
        // The host checks for presence before reading a selected property again.
        if !value.get(key)?.undefined()? {
            slim.set(key, value.get(key)?)?;
        }
    }
    let error = value.get(c"apiError")?;
    if !error.undefined()? {
        let selected = if error.kind()? == sys::ValueType::napi_object {
            let category = object(error)?;
            category.set(c"category", error.get(c"category")?)?;
            category
        } else {
            error
        };
        slim.set(c"apiError", selected)?;
    }
    Ok(slim)
}

fn scalar(value: L<'_>) -> Result<L<'_>> {
    match value.kind()? {
        sys::ValueType::napi_null
        | sys::ValueType::napi_undefined
        | sys::ValueType::napi_boolean
        | sys::ValueType::napi_number
        | sys::ValueType::napi_string => Ok(value),
        _ => object(value),
    }
}

fn filter<'a>(rule: L<'a>, event: L<'a>) -> Result<L<'a>> {
    let data = event.optional(c"data")?;
    let input = object(rule)?;
    let rule = if rule.nullish()? {
        rule
    } else {
        let slim = object(rule)?;
        slim.set(c"filter", rule.get(c"filter")?)?;
        slim
    };
    input.set(c"rule", rule)?;
    let event = if event.nullish()? {
        event
    } else {
        let slim = object(event)?;
        for key in [c"sessionId", c"dirId"] {
            slim.set(key, scalar(event.get(key)?)?)?;
        }
        let data = if data.nullish()? {
            data
        } else {
            let fields = object(data)?;
            fields.set(c"goalState", scalar(data.get(c"goalState")?)?)?;
            fields.set(
                c"cancelled",
                data.from_value(&J::Bool(data.get(c"cancelled")?.truthy()?))?,
            )?;
            fields
        };
        slim.set(c"data", data)?;
        slim
    };
    input.set(c"event", event)?;
    request("matchesFilter", input)
}

fn channel_actions(rule: L<'_>) -> Result<L<'_>> {
    let input = object(rule)?;
    let slim = if rule.kind()? == sys::ValueType::napi_object {
        let slim = object(rule)?;
        for key in [c"action", c"then"] {
            slim.set(key, rule.get(key)?)?;
        }
        slim
    } else {
        rule.from_value(&J::Null)?
    };
    input.set(c"rule", slim)?;
    request("channelActions", input)
}

fn channel_problem<'a>(rule: L<'a>, check: L<'a>) -> Result<L<'a>> {
    let actions = channel_actions(rule)?;
    for i in 0..actions.get(c"length")?.number()? as u32 {
        let action = actions.element(i)?;
        let args = [action.get(c"plugin")?, action.get(c"target")?];
        if check.kind()? != sys::ValueType::napi_function {
            return Err(check.type_error("check is not a function"));
        }
        let problem = check.call_plain(&args)?;
        if problem.truthy()? {
            return Ok(problem);
        }
    }
    rule.from_value(&J::Null)
}

fn validate_rule<'a>(body: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let input = object(body)?;
    input.set(c"body", body)?;
    input.set(c"scope", options.get(c"scope")?)?;
    let out = request("validateEventRule", input)?;
    let rule = out.get(c"rule")?;
    let result = object(body)?;
    if !rule.truthy()? {
        result.set(c"error", out.get(c"error")?)?;
        return Ok(result);
    }
    for (flag, factory, field) in [
        (c"needsId", c"idFactory", c"id"),
        (c"needsCreatedAt", c"nowIso", c"createdAt"),
    ] {
        if out.get(flag)?.truthy()? {
            let make = options.get(factory)?;
            if make.kind()? != sys::ValueType::napi_function {
                return Err(
                    make.type_error(&format!("{} is not a function", factory.to_string_lossy()))
                );
            }
            rule.set(field, make.call_plain(&[])?)?;
        }
    }
    result.set(c"rule", rule)?;
    Ok(result)
}

fn text_request<'a>(op: &str, value: L<'a>, maximum: L<'a>, os: L<'a>) -> Result<L<'a>> {
    let input = object(value)?;
    let string = value.global()?.get(c"String")?;
    let text = if op == "summaryOf" && value.truthy()? {
        value.get(c"lastSummary")?
    } else {
        value
    };
    let text = if text.nullish()? || (op == "summaryOf" && !text.truthy()?) {
        value.from_value(&J::string(""))?
    } else {
        string.call_plain(&[text])?
    };
    input.set(c"text", text)?;
    if op != "redactText" {
        let number = value.global()?.get(c"Number")?.call_plain(&[maximum])?;
        input.set(c"max", string.call_plain(&[number])?)?;
    }
    input.set(c"home", os.get(c"homedir")?.call(os, &[])?)?;
    request(if op == "summaryOf" { "clipText" } else { op }, input)
}

#[napi]
pub fn event_host_request(
    env: Env,
    op: String,
    first: Unknown<'_>,
    second: Unknown<'_>,
    port: Unknown<'_>,
) -> Result<sys::napi_value> {
    let first = L::new(&env, first);
    let second = L::new(&env, second);
    let port = L::new(&env, port);
    let result = match op.as_str() {
        "isKnownPattern" | "matchesPattern" | "matchesAny" => {
            pattern_request(&op, first, second, port)?
        }
        "matchesFilter" => filter(first, second)?,
        "channelActions" => channel_actions(first)?,
        "channelProblem" => channel_problem(first, second)?,
        "validateEventRule" => validate_rule(first, second)?,
        "redactText" | "clipText" | "summaryOf" => text_request(&op, first, second, port)?,
        _ => {
            let input = object(first)?;
            match op.as_str() {
                "validateAction" | "validateWebhookUrl" => input.set(c"raw", first)?,
                "letterOf" | "goalOf" | "segmentKey" => {
                    input.set(c"state", project_state(first)?)?
                }
                "deriveTaskEvents" => {
                    input.set(c"prev", project_state(first)?)?;
                    input.set(c"next", project_state(second)?)?;
                }
                "renderInjection" => {
                    input.set(c"event", first)?;
                    input.set(c"instruction", second)?;
                }
                _ => return Err(napi::Error::from_reason(format!("events_unknown_op: {op}"))),
            }
            request(&op, input)?
        }
    };
    Ok(result.raw())
}
