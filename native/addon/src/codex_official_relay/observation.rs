//! Observe the injected stream without rewriting any output bytes. The legacy
//! SDK accepts individual SSE data lines and a final unterminated event.
use super::*;
use multicc_core::js::JsString;

fn routing(s: L<'_>) -> Result<L<'_>> {
    fields(
        s,
        &[
            ("sessionId", s.get(c"sessionId")?),
            ("role", s.get(c"roleKind")?),
            ("roleKind", s.get(c"roleKind")?),
            ("agentRole", s.get(c"agentRole")?),
            ("routeName", s.get(c"routeName")?),
            ("providerId", s.get(c"providerId")?),
        ],
    )
}
pub(super) fn activity<'a>(s: L<'a>, phase: &str, extra: Option<L<'a>>) -> Result<()> {
    if !func(s.get(c"onActivity")?)? || !s.get(c"sessionId")?.truthy()? {
        return Ok(());
    }
    let marker = match phase {
        "first_byte" => Some(c"firstByteReported"),
        "end" => Some(c"endReported"),
        _ => None,
    };
    if let Some(k) = marker {
        if s.get(k)?.truthy()? {
            return Ok(());
        }
        s.set(k, flag(s, true)?)?;
    }
    s.catch(|| {
        let ev = routing(s)?;
        ev.set(c"providerName", s.get(c"providerName")?)?;
        ev.set(c"phase", text(s, phase)?)?;
        ev.set(c"at", now(s)?)?;
        if let Some(extra) = extra {
            ev.spread_from(extra)?;
        }
        call(s, c"onActivity", &[ev])
    })?;
    Ok(())
}
pub(super) fn terminal<'a>(s: L<'a>, usage: L<'a>, error_code: Option<L<'a>>) -> Result<()> {
    if s.get(c"terminalReported")?.truthy()? {
        return Ok(());
    }
    s.set(c"terminalReported", flag(s, true)?)?;
    let status = text(
        s,
        if error_code.is_some() {
            "error"
        } else {
            "success"
        },
    )?;
    activity(s, "end", Some(fields(s, &[("status", status)])?))?;
    if !s.get(c"sessionId")?.truthy()? {
        return Ok(());
    }
    let e = routing(s)?;
    e.set(c"providerName", s.get(c"providerName")?)?;
    e.set(c"model", s.get(c"model")?)?;
    e.set(c"isStream", s.get(c"streaming")?)?;
    e.set(c"usage", usage)?;
    e.set(c"eventId", api(s, c"uuid")?.call_plain(&[])?)?;
    e.set(c"protocol", text(s, "openai-responses")?)?;
    e.set(
        c"latencyMs",
        num(s, now(s)?.number()? - s.get(c"startedAt")?.number()?)?,
    )?;
    e.set(c"status", status)?;
    e.set(c"statusCode", s.get(c"statusCode")?)?;
    e.set(
        c"coverage",
        text(
            s,
            if usage.truthy()? {
                "observed"
            } else {
                "unobservable"
            },
        )?,
    )?;
    e.set(c"source", text(s, "exact")?)?;
    e.set(c"errorCode", error_code.unwrap_or(und(s)?))?;
    s.catch(|| {
        if usage.truthy()? && func(s.get(c"onUsage")?)? {
            call(s, c"onUsage", &[e])?;
        }
        if func(s.get(c"onUsageEvent")?)? {
            call(s, c"onUsageEvent", &[e])?;
        }
        Ok(())
    })?;
    Ok(())
}
fn delta<'a>(s: L<'a>, d: L<'a>) -> Result<()> {
    if !s.get(c"sessionId")?.truthy()? || !func(s.get(c"onDelta")?)? {
        return Ok(());
    }
    s.catch(|| {
        let r = routing(s)?;
        r.set(c"model", s.get(c"model")?)?;
        call(s, c"onDelta", &[d, r])
    })?;
    Ok(())
}
fn usage(v: L<'_>) -> Result<L<'_>> {
    if v.kind()? != sys::ValueType::napi_object {
        return null(v);
    }
    let n = |k1: &CStr, k2: &CStr| -> Result<f64> {
        let v1 = v.get(k1)?;
        let chosen = if v1.truthy()? {
            v1
        } else {
            fallback(v.get(k2)?, V::Number(0.))?
        };
        chosen.explicit_number()
    };
    let total = n(c"input_tokens", c"prompt_tokens")?;
    let mut cache = v.get(c"input_tokens_details")?.optional(c"cached_tokens")?;
    if !cache.truthy()? {
        cache = v
            .get(c"prompt_tokens_details")?
            .optional(c"cached_tokens")?;
    }
    if !cache.truthy()? {
        cache = fallback(v.get(c"cached_input_tokens")?, V::Number(0.))?;
    }
    let cached = cache.explicit_number()?;
    let positive = |n: f64| if n.is_nan() { n } else { n.max(0.) };
    let input = positive(total - cached);
    let cached = positive(cached);
    let output = n(c"output_tokens", c"completion_tokens")?;
    if input + cached + output > 0. {
        fields(
            v,
            &[
                ("inputTokens", num(v, input)?),
                ("outputTokens", num(v, output)?),
                ("cacheWrite", num(v, 0.)?),
                ("cacheRead", num(v, cached)?),
            ],
        )
    } else {
        null(v)
    }
}
fn observe<'a>(s: L<'a>, v: L<'a>) -> Result<()> {
    if v.kind()? != sys::ValueType::napi_object {
        return Ok(());
    }
    let t = word(s_or(v.get(c"type")?, "")?)?;
    if t == "response.failed" || t == "error" {
        s.set(
            c"observedError",
            call(
                api(s, c"errors")?,
                c"publicUpstreamError",
                &[v, s.get(c"errorOptions")?],
            )?,
        )?;
    }
    let mut counters = v.get(c"response")?.optional(c"usage")?;
    if !counters.truthy()? {
        counters = v.get(c"usage")?;
    }
    let measured = usage(counters)?;
    if measured.truthy()? {
        s.set(c"usage", measured)?;
    }
    let kind = match t.as_str() {
        "response.output_item.added" => {
            let item = v.get(c"item")?;
            if !item.truthy()? || !item.get(c"id")?.truthy()? {
                return Ok(());
            }
            let typ = item.get(c"type")?;
            if [
                "function_call",
                "custom_tool_call",
                "apply_patch_call",
                "code_interpreter_call",
            ]
            .iter()
            .any(|name| typ.is_string(name).unwrap_or(false))
            {
                let name = item.get(c"name")?;
                s.get(c"tools")?
                    .set_key(item.get(c"id")?, if name.truthy()? { name } else { typ })?;
            }
            return Ok(());
        }
        "response.output_text.delta" => "text",
        "response.reasoning_summary_text.delta" => "reasoning",
        "response.function_call_arguments.delta"
        | "response.custom_tool_call_input.delta"
        | "response.apply_patch_call_operation_diff.delta"
        | "response.code_interpreter_call_code.delta" => "tool",
        "response.output_text.annotation.added" if v.get(c"annotation")?.truthy()? => {
            return delta(
                s,
                fields(
                    s,
                    &[
                        ("type", text(s, "source")?),
                        ("source", v.get(c"annotation")?),
                        ("itemId", fallback(v.get(c"item_id")?, "".into())?),
                        ("outputIndex", v.get(c"output_index")?),
                    ],
                )?,
            );
        }
        _ => return Ok(()),
    };
    let part = v.get(c"delta")?;
    if part.kind()? != sys::ValueType::napi_string {
        return Ok(());
    }
    let event = fields(s, &[("type", text(s, kind)?)])?;
    if kind == "tool" {
        let id = v.get(c"item_id")?;
        if !id.truthy()? {
            return Ok(());
        }
        let name = fallback(
            s.get(c"tools")?.get_key(id)?,
            if t == "response.custom_tool_call_input.delta" {
                "custom_tool_call".into()
            } else {
                "".into()
            },
        )?;
        event.set(c"tool", fields(s, &[("name", name), ("arguments", part)])?)?;
        event.set(c"toolId", id)?;
    } else {
        event.set(c"text", part)?;
    }
    delta(s, event)
}
fn parse(s: L<'_>, data: &JsString) -> Result<()> {
    if !data.is_empty() && data != "[DONE]" {
        s.catch(|| {
            let v = call(
                s.global()?.get(c"JSON")?,
                c"parse",
                &[s.from_value(&V::String(data.clone()))?],
            )?;
            observe(s, v)
        })?;
    }
    Ok(())
}
fn payload(v: &JsString) -> Option<JsString> {
    let units = v.as_units();
    if !units.starts_with(&[100, 97, 116, 97, 58]) {
        return None;
    }
    Some(v.slice_units(5, v.len()).trim())
}
pub(super) fn init(s: L<'_>, sse: bool) -> Result<()> {
    s.set(c"sse", flag(s, sse)?)?;
    s.set(c"buffer", text(s, "")?)?;
    s.set(c"tools", fields(s, &[])?)?;
    s.set(c"usage", null(s)?)?;
    Ok(())
}
pub(super) fn chunk<'a>(s: L<'a>, chunk: L<'a>) -> Result<()> {
    activity(
        s,
        "first_byte",
        Some(fields(
            s,
            &[(
                "latencyMs",
                num(s, now(s)?.number()? - s.get(c"startedAt")?.number()?)?,
            )],
        )?),
    )?;
    let decoded = if chunk.kind()? == sys::ValueType::napi_string {
        chunk
    } else if chunk.truthy()? {
        call(
            call(s.global()?.get(c"Buffer")?, c"from", &[chunk])?,
            c"toString",
            &[text(s, "utf8")?],
        )?
    } else {
        text(s, "")?
    };
    let joined = call(s.get(c"buffer")?, c"concat", &[decoded])?;
    if !s.get(c"sse")?.truthy()? {
        s.set(c"buffer", joined)?;
    } else {
        let input = joined.coerce_string()?;
        let mut start = 0;
        for (i, u) in input.as_units().iter().enumerate() {
            if *u == 10 {
                let line = input.slice_units(start, i);
                if let Some(data) = payload(&line) {
                    parse(s, &data)?;
                }
                start = i + 1;
            }
        }
        s.set(
            c"buffer",
            s.from_value(&V::String(input.slice_units(start, input.len())))?,
        )?;
    }
    call(s.get(c"res")?, c"write", &[chunk])?;
    Ok(())
}
pub(super) fn finish(s: L<'_>) -> Result<()> {
    let tail = s.get(c"buffer")?.coerce_string()?.trim();
    if s.get(c"sse")?.truthy()? {
        parse(s, &payload(&tail).unwrap_or(tail))?;
    } else {
        parse(s, &tail)?;
    }
    let err = s.get(c"observedError")?;
    let code = if err.truthy()? {
        Some(fallback(
            err.get(c"code")?,
            "UPSTREAM_RESPONSE_FAILED".into(),
        )?)
    } else {
        None
    };
    terminal(s, s.get(c"usage")?, code)
}
