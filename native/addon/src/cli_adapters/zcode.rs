//! ZCode's bundled bridges own the transport. Translate its JSONL events into host events.
use crate::{
    codex_adapter::{concat, or, port, push},
    host_api::*,
    js_iteration::read,
};
use std::ffi::CStr;

fn quoted(value: L<'_>) -> Result<L<'_>> {
    // The terminal command uses double quotes on ordinary paths. Escape shell expansions inside them.
    let value = string(value)?;
    let mut quoted = vec![u16::from(b'"')];
    for unit in value.coerce_string()?.as_units() {
        if matches!(*unit, 0x22 | 0x24 | 0x5c | 0x60) {
            quoted.push(u16::from(b'\\'));
        }
        quoted.push(*unit);
    }
    quoted.push(u16::from(b'"'));
    value.from_value(&V::String(multicc_core::js::JsString::from_units(quoted)))
}
fn terminal<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = ctx.get(c"ports")?;
    let process = p.get(c"process")?;
    let engine = or(process.get(c"env")?.get(c"ZCODE_ENGINE")?, || {
        fallback(ctx.get(c"cmd")?, "zcode".into())
    })?;
    let mut command = concat(
        p,
        &[
            quoted(process.get(c"execPath")?)?,
            text(p, " ")?,
            quoted(p.get(c"zcodeTerminalPath")?)?,
            text(p, " --engine ")?,
            quoted(engine)?,
        ],
    )?;
    for (key, flag) in [(c"model", " --model "), (c"cliSessionId", " --resume ")] {
        if a[0].truthy()? && a[0].get(key)?.truthy()? {
            command = concat(p, &[command, text(p, flag)?, quoted(a[0].get(key)?)?])?;
        }
    }
    Ok(command)
}
fn invocation<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = ctx.get(c"ports")?;
    let env = a[0];
    let first = read(read(env, c"historyHandle")?, c"isFirstTurn")?;
    let args = array(p)?;
    if !first.truthy()? && read(env.get(c"historyHandle")?, c"cliSessionId")?.truthy()? {
        push(
            args,
            &[
                text(p, "--session")?,
                read(env.get(c"historyHandle")?, c"cliSessionId")?,
            ],
        )?;
    }
    if read(env.get(c"spawnOpts")?, c"rawModel")?.truthy()? {
        push(
            args,
            &[
                text(p, "--model")?,
                read(env.get(c"spawnOpts")?, c"rawModel")?,
            ],
        )?;
    }
    let prompt = port(p, c"renderPrompt", &[env])?;
    let payload = if first.truthy()? && env.get(c"rolePrompt")?.truthy()? {
        concat(
            p,
            &[
                text(p, "[Role prompt]\n")?,
                env.get(c"rolePrompt")?,
                text(p, "\n[End of role prompt]\n\n")?,
                prompt,
            ],
        )?
    } else {
        prompt
    };
    let stream = array(p)?;
    args.for_each(|v| push(stream, &[v]))?;
    push(stream, &[text(p, "--resident")?])?;
    fields(
        p,
        &[
            ("cmd", p.get(c"zcodeBridgePath")?),
            ("args", args),
            ("payload", payload),
            ("streamArgs", stream),
            ("streamBackend", text(p, "zcode-app-server")?),
            ("nativeKey", text(p, "cliSessionId")?),
            ("clientAllocatesNativeId", flag(p, false)?),
            (
                "turnOptions",
                fields(
                    p,
                    &[(
                        "model",
                        fallback(read(env.get(c"spawnOpts")?, c"rawModel")?, V::Null)?,
                    )],
                )?,
            ),
        ],
    )
}
fn tool(part: L<'_>) -> Result<L<'_>> {
    let state = or(part.get(c"state")?, || fields(part, &[]))?;
    let id = or(part.get(c"callID")?, || part.get(c"id"))?;
    let name = or(part.get(c"tool")?, || {
        fallback(part.get(c"name")?, "tool".into())
    })?;
    let input = if !state.get(c"input")?.nullish()? {
        state.get(c"input")?
    } else {
        or(part.get(c"args")?, || fields(part, &[]))?
    };
    let file = fallback(state.get(c"title")?, V::Null)?;
    let completed =
        state.get(c"status")?.is_string("completed")? || !state.get(c"output")?.undefined()?;
    let content = if state.get(c"output")?.kind()? == sys::ValueType::napi_string {
        state.get(c"output")?
    } else if state.get(c"output")?.nullish()? {
        text(part, "")?
    } else {
        json_call(part, c"stringify", state.get(c"output")?)?
    };
    fields(
        part,
        &[
            ("type", text(part, "tool_update")?),
            ("id", id),
            ("name", name),
            ("input", input),
            ("currentFile", file),
            ("completed", flag(part, completed)?),
            ("content", content),
            (
                "isError",
                flag(part, state.get(c"status")?.is_string("error")?)?,
            ),
        ],
    )
}
fn complete(part: L<'_>) -> Result<L<'_>> {
    let tokens = or(part.get(c"tokens")?, || fields(part, &[]))?;
    let cost = if part.get(c"cost")?.nullish()? {
        null(part)?
    } else {
        part.get(c"cost")?
    };
    let cache = |key| {
        let v = tokens.get(c"cache")?;
        fallback(
            if v.truthy()? {
                tokens.get(c"cache")?.get(key)?
            } else {
                v
            },
            0f64.into(),
        )
    };
    fields(
        part,
        &[
            ("type", text(part, "complete")?),
            ("cost", cost),
            (
                "usage",
                fields(
                    part,
                    &[
                        (
                            "input_tokens",
                            fallback(tokens.get(c"input")?, 0f64.into())?,
                        ),
                        (
                            "output_tokens",
                            fallback(tokens.get(c"output")?, 0f64.into())?,
                        ),
                        ("cache_read_input_tokens", cache(c"read")?),
                        ("cache_creation_input_tokens", cache(c"write")?),
                    ],
                )?,
            ),
        ],
    )
}
// Source order is also getter evaluation order. Preserve the final falsy value
// when none of the vendor fields answered, as JavaScript's || does.
fn first<'a>(parts: &[(L<'a>, &CStr)]) -> Result<L<'a>> {
    let mut last = undef(parts[0].0)?;
    for &(object, key) in parts {
        last = object.get(key)?;
        if last.truthy()? {
            break;
        }
    }
    Ok(last)
}
fn provider_error<'a>(ctx: L<'a>, event: L<'a>, part: L<'a>) -> Result<L<'a>> {
    let err = or(event.get(c"error")?, || part.get(c"error"))?;
    let detail = if object(err)? {
        err
    } else {
        fields(event, &[])?
    };
    let data = if detail.get(c"data")?.truthy()? && object(detail.get(c"data")?)? {
        detail.get(c"data")?
    } else {
        fields(event, &[])?
    };
    let label = ctx.get(c"label")?;
    let message = or(first(&[(data, c"message"), (detail, c"message")])?, || {
        if err.kind()? == sys::ValueType::napi_string && err.truthy()? {
            Ok(err)
        } else {
            concat(ctx, &[label, text(ctx, " 出错")?])
        }
    })?;
    let error = fields(
        ctx,
        &[
            ("source", text(ctx, "zcode_event")?),
            ("provider", text(ctx, "zcode")?),
            (
                "code",
                first(&[
                    (data, c"code"),
                    (detail, c"code"),
                    (detail, c"name"),
                    (event, c"code"),
                ])?,
            ),
            (
                "httpStatus",
                first(&[
                    (data, c"statusCode"),
                    (data, c"status"),
                    (detail, c"statusCode"),
                    (detail, c"status"),
                    (event, c"statusCode"),
                    (event, c"status"),
                ])?,
            ),
            (
                "headers",
                first(&[
                    (data, c"headers"),
                    (detail, c"headers"),
                    (event, c"headers"),
                ])?,
            ),
            (
                "requestId",
                first(&[
                    (data, c"requestID"),
                    (data, c"requestId"),
                    (detail, c"requestID"),
                    (detail, c"requestId"),
                    (event, c"requestID"),
                    (event, c"requestId"),
                ])?,
            ),
            ("message", message),
        ],
    )?;
    fields(
        ctx,
        &[
            ("type", text(ctx, "error")?),
            ("label", label),
            ("message", message),
            ("kind", text(ctx, "provider")?),
            ("error", error),
        ],
    )
}
fn decode<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let event = a[0];
    let out = array(ctx)?;
    if !object(event)? {
        return Ok(out);
    }
    if !event.get(c"type")?.is_string("error")?
        && port(
            ctx.get(c"ports")?,
            c"isZcodeSessionId",
            &[event.get(c"sessionID")?],
        )?
        .truthy()?
    {
        push(
            out,
            &[fields(
                ctx,
                &[
                    ("type", text(ctx, "session_started")?),
                    ("sessionId", event.get(c"sessionID")?),
                ],
            )?],
        )?;
    }
    let part = or(event.get(c"part")?, || fields(ctx, &[]))?;
    let kind = |name| event.get(c"type")?.is_string(name);
    let item = if kind("step_start")? {
        fields(
            ctx,
            &[
                ("type", text(ctx, "status")?),
                ("status", text(ctx, "thinking")?),
            ],
        )?
    } else if kind("text")? && part.get(c"text")?.truthy()? {
        fields(
            ctx,
            &[
                ("type", text(ctx, "assistant_text")?),
                ("text", part.get(c"text")?),
                ("delta", flag(ctx, true)?),
            ],
        )?
    } else if kind("reasoning")? && part.get(c"text")?.truthy()? {
        let id = or(part.get(c"id")?, || {
            or(part.get(c"partID")?, || {
                concat(
                    ctx,
                    &[
                        text(ctx, "reasoning_")?,
                        fallback(event.get(c"sessionID")?, "current".into())?,
                    ],
                )
            })
        })?;
        let msg = fields(
            ctx,
            &[
                ("type", text(ctx, "thinking")?),
                ("id", id),
                ("text", part.get(c"text")?),
                ("snapshot", flag(ctx, true)?),
            ],
        )?;
        msg.set(
            if part.get(c"completed")?.is_true()? {
                c"completed"
            } else {
                c"delta"
            },
            flag(ctx, true)?,
        )?;
        msg
    } else if kind("tool_use")? || kind("tool_call")? {
        tool(part)?
    } else if kind("step_finish")? {
        if part.get(c"reason")?.truthy()? && !part.get(c"reason")?.is_string("stop")? {
            return Ok(out);
        }
        complete(part)?
    } else if kind("error")? {
        provider_error(ctx, event, part)?
    } else {
        return Ok(out);
    };
    push(out, &[item])?;
    Ok(out)
}
pub(super) fn install<'a>(p: L<'a>, out: L<'a>) -> Result<()> {
    let label = port(p, c"displayNameOf", &[text(p, "zcode")?])?;
    let module = fields(p, &[("ports", p), ("label", label)])?;
    out.set(
        c"createZcodeAdapter",
        function(module, "createZcodeAdapter", 0, 1, |m, a| {
            let cmd = read(default_object(a[0])?, c"cmd")?;
            let ctx = fields(
                m,
                &[
                    ("ports", m.get(c"ports")?),
                    ("label", m.get(c"label")?),
                    ("cmd", cmd),
                ],
            )?;
            fields(
                ctx,
                &[
                    ("name", text(ctx, "zcode")?),
                    (
                        "createCompletionTracker",
                        function(ctx, "createCompletionTracker", 0, 0, |ctx, _| {
                            port(
                                ctx.get(c"ports")?,
                                c"createStepCompletionTracker",
                                &[fields(ctx, &[("streamBoundary", flag(ctx, true)?)])?],
                            )
                        })?,
                    ),
                    ("cmd", cmd),
                    (
                        "buildTerminalCmd",
                        function(ctx, "buildTerminalCmd", 1, 1, terminal)?,
                    ),
                    (
                        "buildInvocation",
                        function(ctx, "buildInvocation", 1, 1, invocation)?,
                    ),
                    ("decodeEvent", function(ctx, "decodeEvent", 1, 1, decode)?),
                    ("needsAsyncSessionIdCapture", flag(ctx, false)?),
                ],
            )
        })?,
    )
}
