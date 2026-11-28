//! One native transition owner per upstream turn/segment. Live maps below are
//! GC-visible handle storage, not a second implementation of the protocol.
use crate::{
    codex_adapter::{concat, or, push},
    host_api::*,
};
use std::{cell::Cell, rc::Rc};

#[derive(Default)]
struct Turn {
    seen: Cell<bool>,
    step: Cell<bool>,
    tools: Cell<bool>,
    text: Cell<bool>,
    separator: Cell<bool>,
}
fn get<'a>(p: L<'a>, map: &std::ffi::CStr, id: L<'a>) -> Result<L<'a>> {
    call(p.get(map)?, c"get", &[id])
}
fn set<'a>(p: L<'a>, map: &std::ffi::CStr, id: L<'a>, value: L<'a>) -> Result<()> {
    call(p.get(map)?, c"set", &[id, value])?;
    Ok(())
}
fn event<'a>(p: L<'a>, events: L<'a>, kind: &str, part: L<'a>) -> Result<()> {
    push(
        events,
        &[fields(
            p,
            &[
                ("sessionID", p.get(c"sessionId")?),
                ("type", text(p, kind)?),
                ("part", part),
            ],
        )?],
    )
}
fn nonempty(value: L<'_>) -> Result<bool> {
    Ok(value.kind()? == sys::ValueType::napi_string && value.truthy()?)
}
fn nonempty_field(value: L<'_>, key: &std::ffi::CStr) -> Result<bool> {
    // These are two distinct reads in the source (typeof field && field).
    Ok(value.get(key)?.kind()? == sys::ValueType::napi_string && value.get(key)?.truthy()?)
}
fn tool_id(payload: L<'_>) -> Result<L<'_>> {
    let id = or(payload.get(c"toolCallId")?, || payload.get(c"callID"))?;
    if nonempty(id)? {
        Ok(id)
    } else {
        null(payload)
    }
}
fn error_message(error: L<'_>) -> Result<L<'_>> {
    if error.kind()? == sys::ValueType::napi_string {
        return Ok(error);
    }
    if error.truthy()? && object(error)? {
        if error.get(c"message")?.kind()? == sys::ValueType::napi_string
            && error.get(c"message")?.truthy()?
        {
            return error.get(c"message");
        }
        if error.get(c"type")?.kind()? == sys::ValueType::napi_string {
            return error.get(c"type");
        }
    }
    text(error, "")
}
fn flush<'a>(p: L<'a>, events: L<'a>) -> Result<()> {
    let open = p.get(c"open")?;
    let snapshot = call(p.global()?.get(c"Array")?, c"from", &[open])?;
    snapshot.for_each(|id| {
        let text_value = fallback(get(p, c"reasoning", id)?, "".into())?;
        call(open, c"delete", &[id])?;
        call(p.get(c"reasoning")?, c"delete", &[id])?;
        call(p.get(c"emits")?, c"delete", &[id])?;
        if text_value.truthy()? {
            event(
                p,
                events,
                "reasoning",
                fields(
                    p,
                    &[
                        ("id", id),
                        ("text", text_value),
                        ("completed", flag(p, true)?),
                    ],
                )?,
            )?;
        }
        Ok(())
    })
}
fn step<'a>(state: &Turn, p: L<'a>, events: L<'a>) -> Result<()> {
    state.step.set(true);
    state.tools.set(false);
    flush(p, events)?;
    event(p, events, "step_start", fields(p, &[])?)
}
fn append<'a>(state: &Turn, p: L<'a>, events: L<'a>, delta: L<'a>) -> Result<()> {
    if !nonempty(delta)? {
        return Ok(());
    }
    if state.separator.replace(false) {
        event(p, events, "text", fields(p, &[("text", text(p, "\n\n")?)])?)?;
    }
    state.text.set(true);
    event(p, events, "text", fields(p, &[("text", delta)])?)
}
fn mark<'a>(
    state: &Turn,
    p: L<'a>,
    events: L<'a>,
    id: L<'a>,
    name: L<'a>,
    input: L<'a>,
    status: &str,
    output: L<'a>,
) -> Result<()> {
    state.tools.set(true);
    if id.truthy()? {
        set(p, c"names", id, name)?;
        if !input.undefined()? {
            set(p, c"inputs", id, input)?;
        }
    }
    let value = fields(p, &[])?;
    if !input.undefined()? {
        value.set(c"input", input)?;
    }
    value.set(c"status", text(p, status)?)?;
    if !output.undefined()? {
        value.set(
            c"output",
            if output.nullish()? {
                text(p, "")?
            } else {
                output
            },
        )?;
    }
    event(
        p,
        events,
        "tool_call",
        fields(p, &[("callID", id), ("tool", name), ("state", value)])?,
    )
}
fn streaming<'a>(state: &Turn, p: L<'a>, payload: L<'a>, events: L<'a>) -> Result<()> {
    let mid = if nonempty_field(payload, c"assistantMessageId")? {
        payload.get(c"assistantMessageId")?
    } else {
        null(p)?
    };
    if mid.truthy()? && !mid.equals(p.get(c"currentMessageId")?)? {
        if !p.get(c"currentMessageId")?.nullish()? || !state.step.get() {
            step(state, p, events)?;
            if state.text.get() {
                state.separator.set(true);
            }
        }
        p.set(c"currentMessageId", mid)?;
    }
    let kind = payload.get(c"kind")?;
    if kind.is_string("text_delta")? {
        return append(state, p, events, payload.get(c"delta")?);
    }
    if kind.is_string("reasoning_delta")? {
        if nonempty_field(payload, c"delta")? {
            let id = if nonempty_field(payload, c"assistantMessageId")? {
                payload.get(c"assistantMessageId")?
            } else {
                concat(p, &[p.get(c"sessionId")?, text(p, "_reasoning")?])?
            };
            let value = concat(
                p,
                &[
                    fallback(get(p, c"reasoning", id)?, "".into())?,
                    payload.get(c"delta")?,
                ],
            )?;
            set(p, c"reasoning", id, value)?;
            call(p.get(c"open")?, c"add", &[id])?;
            let last = get(p, c"emits", id)?;
            let at = p.get(c"now")?.call_plain(&[])?;
            let length = value.get(c"length")?;
            if !last.truthy()?
                || at.number()? - last.get(c"at")?.number()? >= 200.0
                || length.number()? - last.get(c"length")?.number()? >= 4000.0
            {
                set(
                    p,
                    c"emits",
                    id,
                    fields(p, &[("at", at), ("length", length)])?,
                )?;
                event(
                    p,
                    events,
                    "reasoning",
                    fields(p, &[("id", id), ("text", value)])?,
                )?;
            }
        }
        return Ok(());
    }
    let id = tool_id(payload)?;
    if kind.is_string("tool_input_start")? {
        if id.truthy()? {
            set(
                p,
                c"names",
                id,
                or(payload.get(c"toolName")?, || {
                    fallback(get(p, c"names", id)?, "tool".into())
                })?,
            )?;
            set(p, c"buffers", id, text(p, "")?)?;
        }
    } else if kind.is_string("tool_input_delta")? {
        if id.truthy()? {
            let delta = if payload.get(c"delta")?.kind()? == sys::ValueType::napi_string {
                payload.get(c"delta")?
            } else {
                text(p, "")?
            };
            set(
                p,
                c"buffers",
                id,
                concat(p, &[fallback(get(p, c"buffers", id)?, "".into())?, delta])?,
            )?;
        }
    } else if kind.is_string("tool_call")? {
        let name = or(payload.get(c"toolName")?, || {
            if id.truthy()? {
                fallback(get(p, c"names", id)?, "tool".into())
            } else {
                text(p, "tool")
            }
        })?;
        let mut input = payload.get(c"input")?;
        if input.undefined()? && id.truthy()? {
            let buffered = get(p, c"buffers", id)?;
            call(p.get(c"buffers")?, c"delete", &[id])?;
            if buffered.truthy()? {
                input = p
                    .catch(|| json_call(p, c"parse", buffered))?
                    .unwrap_or(buffered);
            }
        }
        if input.undefined()? {
            input = fields(p, &[])?;
        }
        mark(state, p, events, id, name, input, "running", undef(p)?)?;
    }
    Ok(())
}
fn updated<'a>(state: &Turn, p: L<'a>, payload: L<'a>, events: L<'a>) -> Result<()> {
    let id = tool_id(payload)?;
    let name = or(payload.get(c"toolName")?, || {
        if id.truthy()? {
            fallback(get(p, c"names", id)?, "tool".into())
        } else {
            text(p, "tool")
        }
    })?;
    if payload.get(c"kind")?.is_string("result")? {
        let result = if payload.get(c"result")?.truthy()? && object(payload.get(c"result")?)? {
            payload.get(c"result")?
        } else {
            fields(p, &[])?
        };
        let input = get(p, c"inputs", id)?;
        let status = if result.get(c"success")?.is_false()? {
            "error"
        } else {
            "completed"
        };
        mark(
            state,
            p,
            events,
            id,
            name,
            input,
            status,
            result.get(c"content")?,
        )?;
    } else if payload.get(c"kind")?.is_string("error")? {
        mark(
            state,
            p,
            events,
            id,
            name,
            get(p, c"inputs", id)?,
            "error",
            error_message(payload.get(c"error")?)?,
        )?;
    }
    Ok(())
}
fn terminal_error<'a>(p: L<'a>, events: L<'a>, message: L<'a>) -> Result<L<'a>> {
    push(
        events,
        &[fields(
            p,
            &[
                ("sessionID", p.get(c"sessionId")?),
                ("type", text(p, "error")?),
                (
                    "error",
                    fields(
                        p,
                        &[
                            ("code", text(p, "zcode_terminal_error")?),
                            ("message", message),
                        ],
                    )?,
                ),
            ],
        )?],
    )?;
    text(p, "failed")
}
fn complete<'a>(state: &Turn, p: L<'a>, payload: L<'a>, events: L<'a>) -> Result<L<'a>> {
    flush(p, events)?;
    let result = payload.get(c"resultType")?;
    if result.is_string("success")? || result.is_string("cancelled")? {
        if !state.text.get() && nonempty_field(payload, c"response")? {
            append(state, p, events, payload.get(c"response")?)?;
        }
        let success = result.is_string("success")?;
        if success && state.step.get() && state.tools.get() {
            step(state, p, events)?;
        }
        let part = fields(
            p,
            &[
                (
                    "reason",
                    text(p, if success { "stop" } else { "cancelled" })?,
                ),
                ("tokens", super::model::tokens(payload.get(c"usage")?)?),
            ],
        )?;
        event(p, events, "step_finish", part)?;
        return text(p, if success { "success" } else { "cancelled" });
    }
    let label = if nonempty(result)? {
        result
    } else {
        text(p, "error")?
    };
    terminal_error(p, events, concat(p, &[text(p, "ZCode ended: ")?, label])?)
}
fn map<'a>(state: &Turn, p: L<'a>, params: L<'a>) -> Result<L<'a>> {
    let events = array(p)?;
    let mut done = null(p)?;
    if params.truthy()? && object(params)? {
        let payload = if params.get(c"payload")?.truthy()? && object(params.get(c"payload")?)? {
            params.get(c"payload")?
        } else {
            fields(p, &[])?
        };
        let kind = params.get(c"type")?;
        if kind.is_string("turn.started")? {
            state.seen.set(true);
            step(state, p, events)?;
        } else if kind.is_string("model.streaming")? {
            streaming(state, p, payload, events)?;
        } else if kind.is_string("tool.updated")? {
            updated(state, p, payload, events)?;
        } else if kind.is_string("turn.completed")? && state.seen.get() {
            done = complete(state, p, payload, events)?;
        } else if kind.is_string("turn.failed")? && state.seen.get() {
            flush(p, events)?;
            let detail = fallback(error_message(payload.get(c"error")?)?, "error".into())?;
            let code = if payload.get(c"error")?.truthy()?
                && object(payload.get(c"error")?)?
                && payload.get(c"error")?.get(c"code")?.truthy()?
            {
                concat(
                    p,
                    &[
                        text(p, " (")?,
                        payload.get(c"error")?.get(c"code")?,
                        text(p, ")")?,
                    ],
                )?
            } else {
                text(p, "")?
            };
            done = terminal_error(
                p,
                events,
                concat(p, &[text(p, "ZCode ended: ")?, detail, code])?,
            )?;
        }
    }
    fields(p, &[("events", events), ("done", done)])
}
pub(super) fn create(options: L<'_>) -> Result<L<'_>> {
    let options = default_object(options)?;
    let read = |key| crate::js_iteration::read(options, key);
    let session = read(c"sessionId")?;
    let clock = read(c"now")?;
    let clock = if clock.undefined()? {
        function(options, "now", 0, 0, |p, _| {
            call(p.global()?.get(c"Date")?, c"now", &[])
        })?
    } else {
        clock
    };
    let separator = read(c"separateFirstText")?.truthy()?;
    let p = fields(
        options,
        &[
            ("sessionId", session),
            ("now", clock),
            ("currentMessageId", null(options)?),
        ],
    )?;
    for key in [c"names", c"inputs", c"buffers", c"reasoning", c"emits"] {
        p.set(key, p.global()?.get(c"Map")?.construct(&[])?)?;
    }
    p.set(c"open", p.global()?.get(c"Set")?.construct(&[])?)?;
    let state = Rc::new(Turn::default());
    state.separator.set(separator);
    fields(
        p,
        &[(
            "map",
            function(p, "map", 1, 1, move |p, a| map(&state, p, a[0]))?,
        )],
    )
}
