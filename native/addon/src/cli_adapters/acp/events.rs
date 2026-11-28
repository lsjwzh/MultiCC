use super::common::*;
use crate::host_api::*;

pub(super) fn content_text(v: L<'_>) -> Result<L<'_>> {
    if !v.truthy()? {
        return text(v, "");
    }
    if v.kind()? == sys::ValueType::napi_string {
        return Ok(v);
    }
    if v.is_array()? {
        let mapper = function(v, "contentText", 1, 1, |_, a| content_text(a[0]))?;
        let parts = call(v, c"map", &[mapper])?;
        let present = call(parts, c"filter", &[v.global()?.get(c"Boolean")?])?;
        return call(present, c"join", &[text(v, "\n")?]);
    }
    let kind = v.get(c"type")?;
    if kind.is_string("text")? {
        return fallback(v.get(c"text")?, "".into());
    }
    if kind.is_string("content")? {
        return content_text(v.get(c"content")?);
    }
    if kind.is_string("diff")? {
        let path = fallback(v.get(c"path")?, "".into())?;
        let next = v.get(c"newText")?;
        let next = if next.nullish()? {
            text(v, "")?
        } else {
            v.get(c"newText")?
        };
        return call(concat(v, &[path, text(v, "\n")?, next])?, c"trim", &[]);
    }
    if kind.is_string("terminal")? {
        return concat(
            v,
            &[
                text(v, "[terminal ")?,
                fallback(v.get(c"terminalId")?, "".into())?,
                text(v, "]")?,
            ],
        );
    }
    if kind.is_string("resource_link")? {
        return fallback(props(v, &[c"uri", c"name"])?, "".into());
    }
    if kind.is_string("resource")? {
        return truthy_or(v.get(c"resource")?.optional(c"text")?, || {
            fallback(v.get(c"resource")?.optional(c"uri")?, "".into())
        });
    }
    text(v, "")
}

fn tool_name(update: L<'_>) -> Result<L<'_>> {
    if update.get(c"kind")?.truthy()? && !update.get(c"kind")?.is_string("other")? {
        return update.get(c"kind");
    }
    fallback(update.get(c"title")?, "tool".into())
}
fn current_file(update: L<'_>) -> Result<L<'_>> {
    let loc = if update.get(c"locations")?.is_array()? {
        update.get(c"locations")?.element(0)?
    } else {
        null(update)?
    };
    truthy_or(update.get(c"title")?, || {
        fallback(loc.optional(c"path")?, V::Null)
    })
}
fn tool_event<'a>(u: L<'a>, name: L<'a>, input: L<'a>, done: bool) -> Result<L<'a>> {
    fields(
        u,
        &[
            ("type", text(u, "tool_update")?),
            ("id", u.get(c"toolCallId")?),
            ("name", name),
            ("input", input),
            ("currentFile", current_file(u)?),
            ("completed", flag(u, done)?),
        ],
    )
}
fn finished(u: L<'_>) -> Result<bool> {
    Ok(u.get(c"status")?.is_string("completed")? || u.get(c"status")?.is_string("failed")?)
}
fn finish_session<'a>(ctx: L<'a>, sid: L<'a>, forget_tools: bool) -> Result<L<'a>> {
    let out = array(ctx)?;
    let thoughts = ctx.get(c"thoughts")?;
    thoughts.for_each(|pair| {
        let (key, entry) = pair.iterator_pair()?;
        if entry.get(c"sessionId")?.equals(sid)? {
            call(thoughts, c"delete", &[key])?;
            if entry.get(c"text")?.truthy()? {
                push(
                    out,
                    &[fields(
                        ctx,
                        &[
                            ("type", text(ctx, "thinking")?),
                            ("id", entry.get(c"id")?),
                            ("text", entry.get(c"text")?),
                            ("snapshot", flag(ctx, true)?),
                            ("completed", flag(ctx, true)?),
                        ],
                    )?],
                )?;
            }
        }
        Ok(())
    })?;
    if forget_tools {
        let tools = ctx.get(c"tools")?;
        tools.for_each(|pair| {
            let (key, entry) = pair.iterator_pair()?;
            if entry.get(c"sessionId")?.equals(sid)? {
                call(tools, c"delete", &[key])?;
            }
            Ok(())
        })?;
    }
    Ok(out)
}
fn thought<'a>(ctx: L<'a>, sid: L<'a>, u: L<'a>) -> Result<L<'a>> {
    let value = content_text(u.get(c"content")?)?;
    if !value.truthy()? {
        return array(ctx);
    }
    let key = concat(
        ctx,
        &[
            sid,
            text(ctx, ":")?,
            fallback(u.get(c"messageId")?, "thought".into())?,
        ],
    )?;
    let thoughts = ctx.get(c"thoughts")?;
    let entry = truthy_or(call(thoughts, c"get", &[key])?, || {
        let id = truthy_or(u.get(c"messageId")?, || {
            concat(
                ctx,
                &[
                    sid,
                    text(ctx, "_")?,
                    call(ctx.global()?.get(c"Date")?, c"now", &[])?,
                ],
            )
        })?;
        fields(
            ctx,
            &[
                ("sessionId", sid),
                ("id", concat(ctx, &[text(ctx, "thinking_")?, id])?),
                ("text", text(ctx, "")?),
            ],
        )
    })?;
    let cumulative = concat(ctx, &[entry.get(c"text")?, value])?;
    entry.set(c"text", cumulative)?;
    call(thoughts, c"set", &[key, entry])?;
    list(
        ctx,
        &[fields(
            ctx,
            &[
                ("type", text(ctx, "thinking")?),
                ("id", entry.get(c"id")?),
                ("text", cumulative),
                ("snapshot", flag(ctx, true)?),
                ("delta", flag(ctx, true)?),
            ],
        )?],
    )
}
fn tool<'a>(ctx: L<'a>, sid: L<'a>, u: L<'a>, initial: bool) -> Result<L<'a>> {
    let out = if initial {
        finish_session(ctx, sid, false)?
    } else {
        array(ctx)?
    };
    let key = concat(ctx, &[sid, text(ctx, ":")?, u.get(c"toolCallId")?])?;
    let tools = ctx.get(c"tools")?;
    if initial {
        let name = tool_name(u)?;
        let input = if u.get(c"rawInput")?.truthy()? && object(u.get(c"rawInput")?)? {
            u.get(c"rawInput")?
        } else {
            fields(ctx, &[])?
        };
        let record = fields(
            ctx,
            &[
                ("sessionId", sid),
                ("name", name),
                ("input", input),
                ("inputJson", json_call(ctx, c"stringify", input)?),
                ("announced", flag(ctx, true)?),
            ],
        )?;
        call(tools, c"set", &[key, record])?;
        push(out, &[tool_event(u, name, input, false)?])?;
        if finished(u)? {
            let row = tool_event(u, name, input, true)?;
            row.set(
                c"content",
                truthy_or(content_text(u.get(c"content")?)?, || {
                    content_text(u.get(c"rawOutput")?)
                })?,
            )?;
            row.set(
                c"isError",
                flag(ctx, u.get(c"status")?.is_string("failed")?)?,
            )?;
            push(out, &[row])?;
            call(tools, c"delete", &[key])?;
        }
        return Ok(out);
    }
    let record = truthy_or(call(tools, c"get", &[key])?, || {
        fields(
            ctx,
            &[
                ("sessionId", sid),
                ("name", tool_name(u)?),
                ("input", fields(ctx, &[])?),
                ("inputJson", text(ctx, "{}")?),
                ("announced", flag(ctx, false)?),
            ],
        )
    })?;
    let mut changed = false;
    if u.get(c"rawInput")?.truthy()?
        && object(u.get(c"rawInput")?)?
        && call(
            ctx.global()?.get(c"Object")?,
            c"keys",
            &[u.get(c"rawInput")?],
        )?
        .get(c"length")?
        .truthy()?
    {
        let next = json_call(ctx, c"stringify", u.get(c"rawInput")?)?;
        if !next.equals(record.get(c"inputJson")?)? {
            record.set(c"input", u.get(c"rawInput")?)?;
            record.set(c"inputJson", next)?;
            changed = true;
        }
    }
    call(tools, c"set", &[key, record])?;
    let done = finished(u)?;
    if !done && record.get(c"announced")?.truthy()? && !changed {
        return Ok(out);
    }
    if done {
        call(tools, c"delete", &[key])?;
    } else {
        record.set(c"announced", flag(ctx, true)?)?;
    }
    let content = if done {
        let mut t = content_text(u.get(c"content")?)?;
        if !t.truthy()? && !u.get(c"rawOutput")?.nullish()? {
            t = if u.get(c"rawOutput")?.kind()? == sys::ValueType::napi_string {
                u.get(c"rawOutput")?
            } else {
                json_call(ctx, c"stringify", u.get(c"rawOutput")?)?
            };
        }
        Some(t)
    } else {
        None
    };
    let row = tool_event(u, record.get(c"name")?, record.get(c"input")?, done)?;
    if let Some(content) = content {
        row.set(c"content", content)?;
        row.set(
            c"isError",
            flag(ctx, u.get(c"status")?.is_string("failed")?)?,
        )?;
    }
    push(out, &[row])?;
    Ok(out)
}
fn update<'a>(ctx: L<'a>, sid: L<'a>, u: L<'a>) -> Result<L<'a>> {
    let kind = u.get(c"sessionUpdate")?;
    if kind.is_string("agent_message_chunk")? {
        let value = content_text(u.get(c"content")?)?;
        let out = finish_session(ctx, sid, false)?;
        if value.truthy()? {
            push(
                out,
                &[fields(
                    ctx,
                    &[
                        ("type", text(ctx, "assistant_text")?),
                        ("text", value),
                        ("delta", flag(ctx, true)?),
                    ],
                )?],
            )?;
        }
        return Ok(out);
    }
    if kind.is_string("agent_thought_chunk")? {
        return thought(ctx, sid, u);
    }
    if kind.is_string("tool_call")? {
        return tool(ctx, sid, u, true);
    }
    if kind.is_string("tool_call_update")? {
        return tool(ctx, sid, u, false);
    }
    if kind.is_string("plan")? && u.get(c"entries")?.is_array()? {
        let render = function(ctx, "renderEntry", 1, 1, |p, a| {
            let bullet = if a[0].get(c"status")?.is_string("completed")? {
                "✓ "
            } else {
                "• "
            };
            concat(p, &[text(p, bullet)?, a[0].get(c"content")?])
        })?;
        let rows = call(u.get(c"entries")?, c"map", &[render])?;
        let msg = call(rows, c"join", &[text(ctx, "\n")?])?;
        if msg.truthy()? {
            return list(
                ctx,
                &[fields(
                    ctx,
                    &[
                        ("type", text(ctx, "activity")?),
                        ("phase", text(ctx, "plan")?),
                        ("message", msg),
                    ],
                )?],
            );
        }
    }
    array(ctx)
}
pub(super) fn decode<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let method = a[0].optional(c"method")?;
    let params = truthy_or(a[0].optional(c"params")?, || fields(ctx, &[]))?;
    if method.is_string("session/update")? && params.get(c"update")?.truthy()? {
        return update(ctx, params.get(c"sessionId")?, params.get(c"update")?);
    }
    if method.is_string("multicc/session")? && params.get(c"sessionId")?.truthy()? {
        return list(
            ctx,
            &[fields(
                ctx,
                &[
                    ("type", text(ctx, "session_started")?),
                    ("sessionId", params.get(c"sessionId")?),
                ],
            )?],
        );
    }
    if method.is_string("multicc/notice")? {
        return list(
            ctx,
            &[fields(
                ctx,
                &[
                    ("type", text(ctx, "activity")?),
                    ("phase", text(ctx, "warning")?),
                    ("message", fallback(params.get(c"message")?, "".into())?),
                ],
            )?],
        );
    }
    let label = ctx.get(c"label")?;
    let name = ctx.get(c"name")?;
    if method.is_string("multicc/turnEnd")? {
        let out = finish_session(ctx, params.get(c"sessionId")?, true)?;
        let reason = params.get(c"stopReason")?;
        let row = if reason.is_string("end_turn")? {
            fields(
                ctx,
                &[
                    ("type", text(ctx, "complete")?),
                    ("cost", null(ctx)?),
                    (
                        "usage",
                        truthy_or(params.get(c"usage")?, || fields(ctx, &[]))?,
                    ),
                ],
            )?
        } else if reason.is_string("cancelled")? {
            fields(
                ctx,
                &[
                    ("type", text(ctx, "error")?),
                    ("label", label),
                    ("kind", text(ctx, "cancelled")?),
                    (
                        "message",
                        concat(ctx, &[label, text(ctx, " turn cancelled")?])?,
                    ),
                ],
            )?
        } else {
            let tail = if reason.is_string("max_tokens")? {
                text(ctx, " stopped: output token limit reached")?
            } else if reason.is_string("max_turn_requests")? {
                text(ctx, " stopped: model request limit for this turn reached")?
            } else if reason.is_string("refusal")? {
                text(ctx, " refused to continue")?
            } else {
                concat(ctx, &[text(ctx, " stopped: ")?, reason])?
            };
            let msg = concat(ctx, &[label, tail])?;
            let err = fields(
                ctx,
                &[
                    ("source", concat(ctx, &[name, text(ctx, "_event")?])?),
                    ("provider", name),
                    ("code", reason),
                    ("message", msg),
                ],
            )?;
            fields(
                ctx,
                &[
                    ("type", text(ctx, "error")?),
                    ("label", label),
                    ("kind", text(ctx, "provider")?),
                    ("message", msg),
                    ("error", err),
                ],
            )?
        };
        push(out, &[row])?;
        return Ok(out);
    }
    if method.is_string("multicc/error")? {
        let msg = truthy_or(params.get(c"message")?, || {
            concat(ctx, &[label, text(ctx, " error")?])
        })?;
        let err = fields(
            ctx,
            &[
                ("source", concat(ctx, &[name, text(ctx, "_event")?])?),
                ("provider", name),
                (
                    "code",
                    fallback(props(params, &[c"code", c"phase"])?, V::Null)?,
                ),
            ],
        )?;
        if params.get(c"rpcError")?.truthy()? {
            err.set(
                c"rpcError",
                call(host(ctx)?, c"errorFields", &[params.get(c"rpcError")?])?,
            )?;
        }
        for k in [c"errorName", c"category"] {
            if params.get(k)?.truthy()? {
                err.set(k, params.get(k)?)?;
            }
        }
        err.set(c"message", msg)?;
        return list(
            ctx,
            &[fields(
                ctx,
                &[
                    ("type", text(ctx, "error")?),
                    ("label", label),
                    ("kind", text(ctx, "provider")?),
                    ("message", msg),
                    ("error", err),
                ],
            )?],
        );
    }
    array(ctx)
}
