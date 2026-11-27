use super::*;
use std::ffi::CStr;

fn first<'a>(pairs: &[(L<'a>, &[&CStr])]) -> Result<L<'a>> {
    let mut result = undef(pairs[0].0)?;
    for &(obj, keys) in pairs {
        result = props(obj, keys)?;
        if result.truthy()? {
            break;
        }
    }
    Ok(result)
}
fn error_event<'a>(ctx: L<'a>, event: L<'a>, part: L<'a>) -> Result<L<'a>> {
    let err = truthy_or(event.get(c"error")?, || part.get(c"error"))?;
    let detail = if object(err)? { err } else { fields(ctx, &[])? };
    let data = if detail.get(c"data")?.truthy()? && object(detail.get(c"data")?)? {
        detail.get(c"data")?
    } else {
        fields(ctx, &[])?
    };
    let name = ctx.get(c"name")?;
    let msg = truthy_or(err.optional(c"data")?.optional(c"message")?, || {
        truthy_or(err.optional(c"message")?, || {
            if err.kind()? == sys::ValueType::napi_string && err.truthy()? {
                Ok(err)
            } else {
                concat(ctx, &[name, text(ctx, " 出错")?])
            }
        })
    })?;
    let evidence = fields(
        ctx,
        &[
            ("source", concat(ctx, &[name, text(ctx, "_event")?])?),
            ("provider", name),
            ("error", call(host(ctx)?, c"errorFields", &[detail])?),
            (
                "code",
                first(&[
                    (data, &[c"code"]),
                    (detail, &[c"code", c"name"]),
                    (event, &[c"code"]),
                ])?,
            ),
        ],
    )?;
    let names: &[(L<'a>, &[&CStr])] = &[(data, &[c"errorName"]), (detail, &[c"name"])];
    if first(names)?.truthy()? {
        evidence.set(c"errorName", first(names)?)?;
    }
    let cats: &[(L<'a>, &[&CStr])] = &[
        (data, &[c"category"]),
        (detail, &[c"category"]),
        (event, &[c"category"]),
    ];
    if first(cats)?.truthy()? {
        evidence.set(c"category", first(cats)?)?;
    }
    let status: &[&CStr] = &[c"statusCode", c"status"];
    let request: &[&CStr] = &[c"requestID", c"requestId"];
    evidence.set(
        c"httpStatus",
        first(&[(data, status), (detail, status), (event, status)])?,
    )?;
    evidence.set(
        c"headers",
        first(&[
            (data, &[c"headers"]),
            (detail, &[c"headers"]),
            (event, &[c"headers"]),
        ])?,
    )?;
    evidence.set(
        c"requestId",
        first(&[(data, request), (detail, request), (event, request)])?,
    )?;
    evidence.set(c"message", msg)?;
    fields(
        ctx,
        &[
            ("type", text(ctx, "error")?),
            ("label", ctx.get(c"label")?),
            ("message", msg),
            ("kind", text(ctx, "provider")?),
            ("error", evidence),
        ],
    )
}
fn tool<'a>(p: L<'a>, part: L<'a>) -> Result<L<'a>> {
    let state = truthy_or(part.get(c"state")?, || fields(p, &[]))?;
    let id = props(part, &[c"callID", c"id"])?;
    let name = fallback(props(part, &[c"tool", c"name"])?, "tool".into())?;
    let input = if !state.get(c"input")?.nullish()? {
        state.get(c"input")?
    } else {
        truthy_or(part.get(c"args")?, || fields(p, &[]))?
    };
    let file = fallback(state.get(c"title")?, V::Null)?;
    let completed =
        state.get(c"status")?.is_string("completed")? || !state.get(c"output")?.undefined()?;
    let content = if state.get(c"output")?.kind()? == sys::ValueType::napi_string {
        state.get(c"output")?
    } else if state.get(c"output")?.nullish()? {
        text(p, "")?
    } else {
        json_call(p, c"stringify", state.get(c"output")?)?
    };
    fields(
        p,
        &[
            ("type", text(p, "tool_update")?),
            ("id", id),
            ("name", name),
            ("input", input),
            ("currentFile", file),
            ("completed", flag(p, completed)?),
            ("content", content),
            (
                "isError",
                flag(p, state.get(c"status")?.is_string("error")?)?,
            ),
        ],
    )
}
pub(super) fn decode<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let out = array(ctx)?;
    let event = a[0];
    if !object(event)? {
        return Ok(out);
    }
    if event.get(c"sessionID")?.truthy()? {
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
    let part = truthy_or(event.get(c"part")?, || fields(ctx, &[]))?;
    let row = if event.get(c"type")?.is_string("step_start")? {
        fields(
            ctx,
            &[
                ("type", text(ctx, "status")?),
                ("status", text(ctx, "thinking")?),
            ],
        )?
    } else if event.get(c"type")?.is_string("text")? && part.get(c"text")?.truthy()? {
        fields(
            ctx,
            &[
                ("type", text(ctx, "assistant_text")?),
                ("text", part.get(c"text")?),
            ],
        )?
    } else if event.get(c"type")?.is_string("reasoning")?
        && props(part, &[c"text", c"reasoning"])?.truthy()?
    {
        let id = truthy_or(props(part, &[c"id", c"partID"])?, || {
            concat(
                ctx,
                &[
                    text(ctx, "reasoning_")?,
                    fallback(event.get(c"sessionID")?, "current".into())?,
                ],
            )
        })?;
        fields(
            ctx,
            &[
                ("type", text(ctx, "thinking")?),
                ("id", id),
                ("text", props(part, &[c"text", c"reasoning"])?),
            ],
        )?
    } else if event.get(c"type")?.is_string("tool_use")?
        || event.get(c"type")?.is_string("tool_call")?
    {
        tool(ctx, part)?
    } else if event.get(c"type")?.is_string("step_finish")? {
        if part.get(c"reason")?.truthy()? && !part.get(c"reason")?.is_string("stop")? {
            return Ok(out);
        }
        let t = truthy_or(part.get(c"tokens")?, || fields(ctx, &[]))?;
        let cost = if part.get(c"cost")?.nullish()? {
            null(ctx)?
        } else {
            part.get(c"cost")?
        };
        let cache = |key: &CStr| -> Result<L<'a>> {
            let c = t.get(c"cache")?;
            let v = if c.truthy()? {
                t.get(c"cache")?.get(key)?
            } else {
                c
            };
            fallback(v, 0.0.into())
        };
        let usage = fields(
            ctx,
            &[
                ("input_tokens", fallback(t.get(c"input")?, 0.0.into())?),
                ("output_tokens", fallback(t.get(c"output")?, 0.0.into())?),
                ("cache_read_input_tokens", cache(c"read")?),
                ("cache_creation_input_tokens", cache(c"write")?),
            ],
        )?;
        fields(
            ctx,
            &[
                ("type", text(ctx, "complete")?),
                ("cost", cost),
                ("usage", usage),
            ],
        )?
    } else if event.get(c"type")?.is_string("error")? {
        error_event(ctx, event, part)?
    } else {
        return Ok(out);
    };
    push(out, &[row])?;
    Ok(out)
}
