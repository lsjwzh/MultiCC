//! 聊天回合的适配器事件。宿主提供实时 provider 目录、脱敏入口和私有的错误标记。
use crate::{
    api_error_policy::detect_envelope,
    host_methods::method,
    js_iteration::{read, IteratorRecord},
    js_live::spread,
    route_response::*,
};
use napi_derive::napi;

fn settings<'a>(ports: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let (invocation, options, binding, cli) = (args[0], args[1], args[2], args[3]);
    let extra = fields(ports, &[])?;
    if invocation.truthy()? && read(invocation, c"settings")?.truthy()? {
        let kind = read(invocation, c"settings")?.kind()?;
        if matches!(
            kind,
            sys::ValueType::napi_object | sys::ValueType::napi_null
        ) {
            extra.spread_from(read(invocation, c"settings")?)?;
        }
    }
    if !cli.is_string("claude")? && !cli.is_string("claude-exp")? {
        return Ok(extra);
    }
    let provider = if binding.truthy()? {
        read(binding, c"providerId")?
    } else {
        binding
    };
    if provider.truthy()? && !provider.is_string("_default_")? {
        let catalog = ports.get(c"providers")?;
        let official =
            catalog
                .catch(|| {
                    Ok(read(catalog, c"isOfficialProviderId")?.kind()?
                        == sys::ValueType::napi_function
                        && call(
                            catalog,
                            c"isOfficialProviderId",
                            &[text(ports, "claude")?, provider],
                        )?
                        .truthy()?)
                })?
                .unwrap_or(false);
        if !official {
            return Ok(extra);
        }
    }
    if options.truthy()? {
        let raw = read(options, c"rawModel")?;
        let model = if raw.truthy()? {
            raw
        } else {
            read(options, c"effectiveModel")?
        };
        if model.truthy()? {
            extra.assign(c"model", model)?;
        }
    }
    Ok(extra)
}

fn append_text<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let prior = string(fallback(a[0], "".into())?)?;
    let next = string(fallback(a[1], "".into())?)?;
    let delta = !a[2].undefined()? && read(a[2], c"delta")?.is_true()?;
    if !prior.truthy()? {
        return Ok(next);
    }
    let mut out = prior.coerce_string()?;
    if !delta {
        out.push_str("\n\n");
    }
    out.push(&next.coerce_string()?);
    s.from_value(&V::String(out))
}

fn reasoning<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let event = a[0];
    if !event.truthy()?
        || read(event, c"text")?.kind()? != sys::ValueType::napi_string
        || !read(event, c"text")?.truthy()?
    {
        return null(s);
    }
    let id = if read(event, c"id")?.kind()? == sys::ValueType::napi_string {
        read(event, c"id")?
    } else {
        null(s)?
    };
    fields(
        s,
        &[
            ("type", text(s, "reasoning")?),
            ("id", id),
            ("text", read(event, c"text")?),
            ("snapshot", flag(s, true)?),
        ],
    )
}

fn for_items<'a>(
    items: L<'a>,
    error: &std::ffi::CStr,
    visit: impl FnMut(L<'a>) -> Result<()>,
) -> Result<()> {
    IteratorRecord::open(items, error, || {
        items.global()?.get(c"Symbol")?.get(c"iterator")
    })?
    .for_each(visit)
}

fn text_block<'a>(value: L<'a>) -> Result<L<'a>> {
    fields(value, &[("type", text(value, "text")?), ("text", value)])
}

fn content_blocks<'a>(s: L<'a>, prefix: Option<L<'a>>, other: L<'a>) -> Result<L<'a>> {
    let array = s.from_value(&V::Array(vec![]))?;
    let mut index = 0;
    if let Some(value) = prefix {
        array.define_key(text(s, "0")?, text_block(value)?)?;
        index += 1;
    }
    for_items(other, c"nonText is not iterable", |item| {
        array.define_key(text(s, &index.to_string())?, item)?;
        index += 1;
        Ok(())
    })?;
    Ok(array)
}

fn tool_content<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let content = a[0];
    let redact = s.get(c"redact")?;
    if !content.is_array()? {
        let source = if content.kind()? == sys::ValueType::napi_string {
            content
        } else {
            let json = s.global()?.get(c"JSON")?;
            call(
                json,
                c"stringify",
                &[if content.nullish()? {
                    text(s, "")?
                } else {
                    content
                }],
            )?
        };
        let safe = redact.call_plain(&[source])?;
        return fields(s, &[("text", safe), ("content", safe)]);
    }
    let parts = call(content, c"map", &[s.get(c"toolText")?])?;
    let joined = call(parts, c"join", &[text(s, "")?])?;
    let safe = redact.call_plain(&[joined])?;
    let other = call(content, c"filter", &[s.get(c"nonTextItem")?])?;
    let other = call(other, c"map", &[s.get(c"redactItem")?])?;
    fields(
        s,
        &[
            ("text", safe),
            (
                "content",
                content_blocks(s, safe.truthy()?.then_some(safe), other)?,
            ),
        ],
    )
}

fn has_assistant_blocks(event: L<'_>) -> Result<bool> {
    Ok(event.truthy()?
        && read(event, c"type")?.is_string("assistant")?
        && read(event, c"message")?.optional(c"content")?.is_array()?)
}

fn assistant_snapshot<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let event = a[0];
    if !has_assistant_blocks(event)? {
        return Ok(event);
    }
    let blocks = read(read(event, c"message")?, c"content")?;
    let nontext = call(blocks, c"filter", &[s.get(c"nonTextBlock")?])?;
    let out = spread(event)?;
    let message = spread(read(event, c"message")?)?;
    message.set(c"textSnapshot", flag(s, true)?)?;
    let prefix = if a[1].truthy()? {
        Some(s.get(c"redact")?.call_plain(&[a[1]])?)
    } else {
        None
    };
    message.set(c"content", content_blocks(s, prefix, nontext)?)?;
    out.set(c"message", message)?;
    Ok(out)
}

fn close_thinking<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let tools = if a[0].truthy()? && read(a[0], c"currentToolCalls")?.is_array()? {
        read(a[0], c"currentToolCalls")?
    } else {
        s.from_value(&V::Array(vec![]))?
    };
    let at = call(s.global()?.get(c"Date")?, c"now", &[])?;
    for_items(tools, c"tools is not iterable", |tool| {
        if tool.truthy()?
            && read(tool, c"name")?.is_string("Thinking")?
            && call(
                s.global()?.get(c"Number")?,
                c"isFinite",
                &[read(tool, c"startedAt")?],
            )?
            .truthy()?
            && !call(
                s.global()?.get(c"Number")?,
                c"isFinite",
                &[read(tool, c"endedAt")?],
            )?
            .truthy()?
        {
            tool.assign(c"endedAt", at)?;
        }
        Ok(())
    })?;
    s.from_value(&V::Undefined)
}

fn frozen_envelope<'a>(provider: L<'a>, value: L<'a>) -> Result<L<'a>> {
    let envelope = detect_envelope(provider, value)?;
    if envelope.truthy()? {
        envelope.freeze()
    } else {
        null(provider)
    }
}

fn mark_replay<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let event = a[0];
    if !has_assistant_blocks(event)? {
        return Ok(event);
    }
    let blocks = read(read(event, c"message")?, c"content")?;
    if !read(blocks, c"length")?.truthy()?
        || !call(blocks, c"every", &[s.get(c"isTextBlock")?])?.truthy()?
    {
        return Ok(event);
    }
    let texts = call(blocks, c"map", &[s.get(c"blockText")?])?;
    let envelope = frozen_envelope(a[1], call(texts, c"join", &[text(s, "")?])?)?;
    if envelope.truthy()? && read(envelope, c"body")?.nullish()? {
        s.get(c"mark")?.call_plain(&[event])
    } else {
        Ok(event)
    }
}

pub(crate) fn reconcile<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (runtime, attempt, provider, cs, structured) = (a[0], a[1], a[2], a[3], a[4]);
    let value = if cs.kind()? == sys::ValueType::napi_string {
        cs
    } else {
        cs.optional(c"currentAssistantText")?
    };
    let envelope = if structured.truthy()? {
        structured
    } else {
        frozen_envelope(provider, value)?
    };
    if envelope.truthy()?
        && !read(envelope, c"body")?.nullish()?
        && cs.truthy()?
        && cs.kind()? == sys::ValueType::napi_object
    {
        cs.assign(c"currentAssistantText", read(envelope, c"body")?)?;
    }
    if !envelope.truthy()? || !read(envelope, c"body")?.nullish()? {
        return Ok(envelope);
    }
    if runtime.truthy()?
        && read(runtime, c"observeEvent")?.kind()? == sys::ValueType::napi_function
        && attempt.truthy()?
    {
        let observe = read(runtime, c"observeEvent")?;
        let message = read(envelope, c"message")?;
        let body = string(if message.truthy()? {
            message
        } else {
            fallback(value, "".into())?
        })?;
        let content = s.from_value(&V::Array(vec![]))?;
        content.set_element(0, text_block(body)?)?;
        let event = fields(
            s,
            &[
                ("type", text(s, "assistant")?),
                ("message", fields(s, &[("content", content)])?),
            ],
        )?;
        observe.call(runtime, &[attempt, s.get(c"mark")?.call_plain(&[event])?])?;
    }
    Ok(envelope)
}

#[napi]
pub fn chat_turn_event_helpers(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let owner = L::new(&env, ports);
    let state = fields(
        owner,
        &[
            ("providers", owner.get(c"providers")?),
            ("mark", owner.get(c"markHostErrorEnvelope")?),
            ("redact", owner.get(c"redactProviderRouteCapability")?),
        ],
    )?;
    type Handler = for<'a> fn(L<'a>, &mut [L<'a>]) -> Result<L<'a>>;
    for (key, handler) in [
        (
            c"toolText",
            (|s, a: &mut [L<'_>]| {
                let item = a[0];
                if item.truthy()? && read(item, c"text")?.kind()? == sys::ValueType::napi_string {
                    read(item, c"text")
                } else {
                    text(s, "")
                }
            }) as Handler,
        ),
        (c"nonTextItem", |s, a| {
            flag(
                s,
                !a[0].truthy()? || read(a[0], c"text")?.kind()? != sys::ValueType::napi_string,
            )
        }),
        (c"redactItem", |s, a| s.get(c"redact")?.call_plain(&[a[0]])),
        (c"nonTextBlock", |s, a| {
            flag(s, !a[0].optional(c"type")?.is_string("text")?)
        }),
        (c"isTextBlock", |s, a| {
            if a[0].truthy()? {
                flag(s, read(a[0], c"type")?.is_string("text")?)
            } else {
                Ok(a[0])
            }
        }),
        (c"blockText", |_, a| {
            string(fallback(read(a[0], c"text")?, "".into())?)
        }),
    ] {
        state.set(key, method(&env, state, "", 1, 1, handler)?)?;
    }
    let api = fields(state, &[])?;
    for (name, length, count, run) in [
        ("claudeSettingsExtra", 4, 4, settings as Handler),
        ("appendAdapterAssistantText", 2, 3, append_text),
        ("adapterReasoningProgressEvent", 1, 1, reasoning),
        ("normalizeClaudeToolResultContent", 1, 1, tool_content),
        ("normalizeClaudeAssistantSnapshot", 2, 2, assistant_snapshot),
        ("closeOpenThinkingTool", 1, 1, close_thinking),
        ("markReplaySafeAssistantEnvelope", 2, 2, mark_replay),
        ("reconcileBoundaryErrorEnvelope", 5, 5, reconcile),
    ] {
        api.define_key(
            text(state, name)?,
            method(&env, state, name, length, count, run)?,
        )?;
    }
    Ok(api.raw())
}
