//! Replay evidence is evaluated against live host events. The host-only Symbol
//! is passed as an opaque key; JSON frames cannot manufacture that authority.
use crate::js_live::LiveValue;
use multicc_core::js::JsValue;
use multicc_core::provider_attempt_lifecycle::{Fence, StreamObservation};
use napi::bindgen_prelude::{ToNapiValue, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

fn clean(value: LiveValue<'_>) -> Result<LiveValue<'_>> {
    // String(Symbol) is legal here, unlike the ToString used by interpolation.
    value.clean_text()
}

fn blocks(event: LiveValue<'_>) -> Result<LiveValue<'_>> {
    let mut content = event;
    if content.truthy()? {
        content = event.get(c"message")?;
    }
    if content.truthy()? {
        content = event.get(c"message")?.get(c"content")?;
    }
    if content.is_array()? {
        Ok(content)
    } else {
        event.from_value(&JsValue::Array(vec![]))
    }
}

#[derive(Clone, Copy)]
enum BlockKind {
    Text,
    ToolUse,
    ThinkingOutput,
    TextOutput,
    ToolResult,
}

fn block_matches(block: LiveValue<'_>, kind: BlockKind) -> Result<LiveValue<'_>> {
    if !block.truthy()? {
        return Ok(block);
    }
    let expected = match kind {
        BlockKind::Text | BlockKind::TextOutput => "text",
        BlockKind::ToolUse => "tool_use",
        BlockKind::ThinkingOutput => "thinking",
        BlockKind::ToolResult => "tool_result",
    };
    if !block.get(c"type")?.is_string(expected)? {
        return block.from_value(&JsValue::Bool(false));
    }
    match kind {
        BlockKind::TextOutput => clean(block.get(c"text")?),
        BlockKind::ThinkingOutput => {
            let thinking = block.get(c"thinking")?;
            clean(if thinking.truthy()? {
                thinking
            } else {
                block.get(c"text")?
            })
        }
        _ => block.from_value(&JsValue::Bool(true)),
    }
}

fn matches(env: &Env, blocks: LiveValue<'_>, method: &CStr, kind: BlockKind) -> Result<bool> {
    // Call the real array method so holes, mutation during iteration, accessors,
    // proxies and overridden methods keep their host semantics. The callback
    // captures only a Rust enum and is safe even if a host method retains it.
    let method = blocks.get(method)?;
    let callback = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "replayBlock",
        move |ctx| {
            let value = if ctx.length() == 0 {
                ().into_unknown(ctx.env)?
            } else {
                ctx.get::<Unknown<'_>>(0)?
            };
            Ok(block_matches(LiveValue::new(ctx.env, value), kind)?.raw())
        },
    )?;
    method
        .call(blocks, &[LiveValue::new(env, callback.into_unknown(env)?)])?
        .truthy()
}

#[napi]
pub fn provider_host_text_envelope(
    env: Env,
    event: Unknown<'_>,
    marker: Unknown<'_>,
) -> Result<bool> {
    let event = LiveValue::new(&env, event);
    Ok(event.get_key(LiveValue::new(&env, marker))?.is_true()?
        && blocks(event)?.get(c"length")?.positive()?
        && matches(&env, blocks(event)?, c"every", BlockKind::Text)?)
}

#[napi]
pub fn provider_event_fence(env: Env, event: Unknown<'_>, marker: Unknown<'_>) -> Result<String> {
    let event = LiveValue::new(&env, event);
    Ok(
        event_fence(&env, event, LiveValue::new(&env, marker), None)?
            .as_str()
            .to_owned(),
    )
}

pub(crate) fn event_fence<'a>(
    env: &'a Env,
    event: LiveValue<'a>,
    marker: LiveValue<'a>,
    mut evidence: Option<&mut StreamObservation>,
) -> Result<Fence> {
    if !event.truthy()? || event.kind()? != sys::ValueType::napi_object {
        return Ok(Fence::None);
    }
    if event.get(c"type")?.is_string("stream_event")?
        && event.get(c"event")?.truthy()?
        && event.get(c"event")?.kind()? == sys::ValueType::napi_object
    {
        let nested = event.get(c"event")?;
        let block = nested.get(c"content_block")?;
        let delta = nested.get(c"delta")?;
        if nested.get(c"type")?.is_string("content_block_start")?
            && block.truthy()?
            && block.get(c"type")?.is_string("tool_use")?
        {
            return Ok(Fence::ToolIntent);
        }
        if nested.get(c"type")?.is_string("content_block_delta")? && delta.truthy()? {
            if delta.get(c"type")?.is_string("input_json_delta")? {
                return Ok(Fence::ToolIntent);
            }
            let is_text = delta.get(c"type")?.is_string("text_delta")?;
            if is_text || delta.get(c"type")?.is_string("thinking_delta")? {
                let text = delta.get(c"text")?;
                let output = if text.truthy()? {
                    text
                } else {
                    delta.get(c"thinking")?
                };
                let visible = clean(output)?.truthy()?;
                if let Some(evidence) = evidence.as_deref_mut() {
                    if is_text {
                        if let Some(text) = text.string()? {
                            *evidence = StreamObservation::CliText(text);
                        } else if visible {
                            *evidence = StreamObservation::OtherOutput;
                        }
                    } else if visible {
                        *evidence = StreamObservation::OtherOutput;
                    }
                }
                if visible {
                    return Ok(Fence::VisibleOutput);
                }
            }
        }
    }
    if event.get(c"type")?.is_string("part_delta")? {
        let delta = if event.get(c"delta")?.truthy()?
            && event.get(c"delta")?.kind()? == sys::ValueType::napi_object
        {
            event.get(c"delta")?
        } else {
            event
        };
        if delta.get(c"type")?.is_string("tool")?
            || delta.get(c"tool")?.truthy()?
            || delta.get(c"toolId")?.truthy()?
        {
            return Ok(Fence::ToolIntent);
        }
        let is_text = delta.get(c"type")?.is_string("text")?;
        if is_text
            || delta.get(c"type")?.is_string("reasoning")?
            || delta.get(c"type")?.is_string("source")?
        {
            if let Some(evidence) = evidence {
                *evidence = if is_text {
                    delta
                        .get(c"text")?
                        .string()?
                        .map_or(StreamObservation::OtherOutput, StreamObservation::ProxyText)
                } else {
                    StreamObservation::OtherOutput
                };
            }
            return Ok(Fence::VisibleOutput);
        }
        return Ok(Fence::None);
    }
    if event.get(c"type")?.is_string("reasoning")? && clean(event.get(c"text")?)?.truthy()? {
        if let Some(evidence) = evidence {
            *evidence = StreamObservation::OtherOutput;
        }
        return Ok(Fence::VisibleOutput);
    }
    if event.get(c"type")?.is_string("assistant_text")? && clean(event.get(c"text")?)?.truthy()? {
        return Ok(Fence::VisibleOutput);
    }
    if event.get(c"type")?.is_string("tool_start")?
        || event.get(c"type")?.is_string("tool_update")?
    {
        return Ok(Fence::ToolIntent);
    }
    if event.get(c"type")?.is_string("tool_result")? {
        return Ok(Fence::SideEffect);
    }
    if event.get(c"type")?.is_string("assistant")? {
        let blocks = blocks(event)?;
        if blocks.get(c"length")?.positive()?
            && matches(env, blocks, c"every", BlockKind::Text)?
            && event.get_key(marker)?.is_true()?
        {
            return Ok(Fence::None);
        }
        if matches(env, blocks, c"some", BlockKind::ToolUse)? {
            return Ok(Fence::ToolIntent);
        }
        if matches(env, blocks, c"some", BlockKind::ThinkingOutput)? {
            if let Some(evidence) = evidence {
                *evidence = StreamObservation::OtherOutput;
            }
            return Ok(Fence::VisibleOutput);
        }
        if matches(env, blocks, c"some", BlockKind::TextOutput)? {
            return Ok(Fence::VisibleOutput);
        }
    }
    if event.get(c"type")?.is_string("user")?
        && matches(env, blocks(event)?, c"some", BlockKind::ToolResult)?
    {
        return Ok(Fence::SideEffect);
    }
    Ok(Fence::None)
}
