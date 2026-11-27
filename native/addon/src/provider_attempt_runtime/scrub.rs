use super::*;
use crate::exact_secret::RustExactSecretStreamRedactor;
use crate::observability_host::maybe_route;
use multicc_core::js::JsString;

pub(super) fn route(value: L<'_>) -> Result<L<'_>> {
    if value.kind()? == sys::ValueType::napi_string || (object(value)? && maybe_route(value)?) {
        multicc_core::provider_scrub::route_redact(value, &mut Vec::new(), 0)
    } else {
        Ok(value)
    }
}

fn secrets(record: L<'_>) -> Result<L<'_>> {
    let values = array(record)?;
    values.set_element(
        0,
        proxy::encode(record.get(c"sessionId")?, record.get(c"proxyRouteToken")?)?,
    )?;
    values.set_element(1, record.get(c"proxyRouteToken")?)?;
    Ok(values)
}

pub(super) fn structure<'a>(p: L<'a>, reference: L<'a>, event: L<'a>) -> Result<L<'a>> {
    let record = current(p, member(reference, c"sessionId")?.clean_text()?)?;
    if !matching(record, reference)? {
        return route(event);
    }
    let secrets = secrets(record)?;
    if !object(event)? {
        return route(event);
    }
    let kind = event.get(c"type")?.string()?;
    let semantic = kind.as_ref().is_some_and(|s| {
        matches!(
            s.to_string_lossy().as_str(),
            "assistant" | "user" | "tool_start" | "tool_update" | "tool_result"
        )
    });
    if !semantic && !maybe_route(event)? {
        return Ok(event);
    }
    Ok(raw(
        p,
        crate::provider_scrub::provider_scrub_semantic_structure(
            environment(p),
            arg(event)?,
            arg(secrets)?,
        )?,
    ))
}

fn channel<'a>(id: L<'a>, prefix: &str, suffix: &str) -> Result<L<'a>> {
    let mut key = JsString::from_rust_str(prefix);
    key.push(&id.coerce_string()?);
    key.push_str(suffix);
    id.from_value(&V::String(key))
}

fn push<'a>(p: L<'a>, r: L<'a>, channel: L<'a>, value: L<'a>) -> Result<L<'a>> {
    if value.kind()? != sys::ValueType::napi_string {
        return Ok(value);
    }
    let streams = p.get(c"streamRedactors")?;
    let mut channels = call(streams, c"get", &[r.get(c"routeAttemptId")?])?;
    if !channels.truthy()? {
        channels = p.global()?.get(c"Map")?.construct(&[])?;
        call(streams, c"set", &[r.get(c"routeAttemptId")?, channels])?;
    }
    let mut state = call(channels, c"get", &[channel])?;
    if !state.truthy()? {
        state = new_slot(
            p,
            RustExactSecretStreamRedactor::new(environment(p), arg(secrets(r)?)?)?,
        )?;
        call(channels, c"set", &[channel, state])?;
    }
    // The map only contains our own redactors. The string check above ensures
    // there is no arbitrary JS conversion while this class is mutably borrowed.
    let mut redactor: ClassInstance<'_, RustExactSecretStreamRedactor> =
        unsafe { ClassInstance::from_napi_value(p.env(), state.raw())? };
    Ok(raw(p, redactor.push(environment(p), arg(value)?)?))
}

fn either<'a>(value: L<'a>, other: L<'a>) -> Result<L<'a>> {
    Ok(if value.truthy()? { value } else { other })
}

fn stream<'a>(p: L<'a>, r: L<'a>, safe: L<'a>, nested: L<'a>) -> Result<L<'a>> {
    let raw_delta = nested.get(c"delta")?;
    if !object(raw_delta)? {
        return Ok(safe);
    }
    let safe_nested = either(safe.get(c"event")?, nested)?;
    let safe_delta = either(safe_nested.get(c"delta")?, raw_delta)?;
    let index = if nested.get(c"index")?.nullish()? {
        text(p, "unknown")?
    } else {
        string(nested.get(c"index")?)?
    };
    for (kind, key, suffix) in [
        ("text_delta", c"text", ":text"),
        ("thinking_delta", c"thinking", ":thinking"),
        ("input_json_delta", c"partial_json", ":tool-json"),
    ] {
        if raw_delta.get(c"type")?.is_string(kind)?
            && raw_delta.get(key)?.kind()? == sys::ValueType::napi_string
        {
            let out = spread(safe)?;
            let event = spread(safe_nested)?;
            let delta = spread(safe_delta)?;
            delta.set(
                key,
                push(
                    p,
                    r,
                    channel(index, "stream:", suffix)?,
                    raw_delta.get(key)?,
                )?,
            )?;
            event.set(c"delta", delta)?;
            out.set(c"event", event)?;
            return Ok(out);
        }
    }
    Ok(safe)
}

fn part<'a>(p: L<'a>, r: L<'a>, safe: L<'a>, raw_delta: L<'a>) -> Result<L<'a>> {
    if !raw_delta.truthy()? {
        return Ok(safe);
    }
    let safe_delta = either(safe.get(c"delta")?, raw_delta)?;
    let mut id = raw_delta.get(c"toolId")?;
    if !id.truthy()? {
        id = raw_delta.get(c"id")?;
    }
    if !id.truthy()? {
        id = raw_delta.get(c"type")?;
    }
    let id = fallback(id.clean_text()?, "unknown".into())?;
    if raw_delta.get(c"text")?.kind()? == sys::ValueType::napi_string {
        let out = spread(safe)?;
        let delta = spread(safe_delta)?;
        delta.set(
            c"text",
            push(
                p,
                r,
                channel(id, "part:", ":text")?,
                raw_delta.get(c"text")?,
            )?,
        )?;
        out.set(c"delta", delta)?;
        return Ok(out);
    }
    if raw_delta.get(c"tool")?.truthy()?
        && object(raw_delta.get(c"tool")?)?
        && raw_delta.get(c"tool")?.get(c"arguments")?.kind()? == sys::ValueType::napi_string
    {
        let out = spread(safe)?;
        let delta = spread(safe_delta)?;
        let mut inner = safe_delta.get(c"tool")?;
        if !inner.truthy()? {
            inner = raw_delta.get(c"tool")?;
        }
        let tool = spread(inner)?;
        tool.set(
            c"arguments",
            push(
                p,
                r,
                channel(id, "part:", ":tool-json")?,
                raw_delta.get(c"tool")?.get(c"arguments")?,
            )?,
        )?;
        delta.set(c"tool", tool)?;
        out.set(c"delta", delta)?;
        return Ok(out);
    }
    Ok(safe)
}

pub(super) fn event<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let event = a[1];
    let safe = structure(p, a[0], event)?;
    let record = current(p, member(a[0], c"sessionId")?.clean_text()?)?;
    if !object(safe)? || !matching(record, a[0])? {
        return Ok(safe);
    }
    if event.get(c"type")?.is_string("stream_event")?
        && event.get(c"event")?.truthy()?
        && object(event.get(c"event")?)?
    {
        return stream(p, record, safe, event.get(c"event")?);
    }
    if event.get(c"type")?.is_string("part_delta")?
        && event.get(c"delta")?.truthy()?
        && object(event.get(c"delta")?)?
    {
        return part(p, record, safe, event.get(c"delta")?);
    }
    Ok(safe)
}
