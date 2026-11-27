use super::print_common::*;

pub(super) fn install<'a>(p: L<'a>, out: L<'a>) -> Result<()> {
    let label = port(p, c"displayNameOf", &[text(p, "kimi")?])?;
    let factory = fields(p, &[("ports", p), ("label", label)])?;
    out.set(
        c"createKimiAdapter",
        function(factory, "createKimiAdapter", 0, 1, create)?,
    )?;
    out.set(c"LABEL", label)
}

fn create<'a>(factory: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = factory.get(c"ports")?;
    let opts = default_object(a[0])?;
    let cmd = opts.get(c"cmd")?;
    let node = opts.get(c"routerMcpNode")?;
    let script = opts.get(c"routerMcpScript")?;
    let router = port(p, c"claudeLikeMcpArgs", &[node, script])?;
    let state = fields(
        p,
        &[
            ("ports", p),
            ("cmd", cmd),
            ("router", router),
            ("label", factory.get(c"label")?),
        ],
    )?;
    fields(
        p,
        &[
            ("name", text(p, "kimi")?),
            (
                "createCompletionTracker",
                function(p, "createCompletionTracker", 0, 0, |p, _| {
                    tracker(
                        p,
                        c"RustKimiCompletionTracker",
                        p,
                        |s, a| call(s.get(c"native")?, c"observe", &[a[0]]),
                        |s, a| call(s.get(c"native")?, c"close", a),
                    )
                })?,
            ),
            ("cmd", cmd),
            ("routerMcpNode", node),
            ("routerMcpScript", script),
            (
                "buildTerminalCmd",
                function(state, "buildTerminalCmd", 1, 1, terminal)?,
            ),
            (
                "buildInvocation",
                function(state, "buildInvocation", 1, 1, invocation)?,
            ),
            ("decodeEvent", function(state, "decodeEvent", 1, 1, decode)?),
            ("needsAsyncSessionIdCapture", flag(p, false)?),
        ],
    )
}

fn terminal<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let mut cmd = s.get(c"cmd")?;
    for (key, prefix) in [(c"model", " --model "), (c"cliSessionId", " --session ")] {
        let value = a[0].optional(key)?;
        if value.truthy()? {
            cmd = call(text(s, "")?, c"concat", &[cmd, text(s, prefix)?, value])?;
        }
    }
    Ok(cmd)
}

fn invocation<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let env = a[0];
    let first = env.get(c"historyHandle")?.get(c"isFirstTurn")?;
    let args = strings(s, &["--output-format", "stream-json"])?;
    s.get(c"router")?.for_each(|v| push(args, &[v]))?;
    option(args, "--model", env.get(c"spawnOpts")?.get(c"rawModel")?)?;
    if !first.truthy()? {
        option(
            args,
            "--session",
            env.get(c"historyHandle")?.get(c"cliSessionId")?,
        )?;
    }
    let payload = prompt(s.get(c"ports")?, env, first)?;
    push(args, &[text(s, "-p")?])?;
    command(s, args, payload)
}

fn number_or_undefined(v: L<'_>) -> Result<L<'_>> {
    let n = v.explicit_number()?;
    if !v.nullish()? && !v.is_string("")? && n.is_finite() {
        num(v, n)
    } else {
        undef(v)
    }
}

fn tool_args(raw: L<'_>) -> Result<L<'_>> {
    if object(raw)? {
        return Ok(raw);
    }
    if !raw.nullish()? {
        if let Some(parsed) = raw.catch(|| json_call(raw, c"parse", string(raw)?))? {
            if object(parsed)? {
                return Ok(parsed);
            }
        }
    }
    fields(raw, &[])
}

fn assistant<'a>(s: L<'a>, e: L<'a>, out: L<'a>) -> Result<()> {
    let content = e.get(c"content")?;
    if content.kind()? == sys::ValueType::napi_string && content.truthy()? {
        push(out, &[row(s, "assistant_text", &[("text", content)])?])?;
    }
    let calls = e.get(c"tool_calls")?;
    if calls.is_array()? {
        calls.for_each(|item| {
            let f = item.optional(c"function")?;
            let id = if item.truthy()? {
                item.get(c"id")?
            } else {
                item
            };
            let update = row(
                s,
                "tool_update",
                &[
                    ("id", id),
                    ("name", fallback(f.optional(c"name")?, "tool".into())?),
                    ("input", tool_args(f.optional(c"arguments")?)?),
                    ("currentFile", null(s)?),
                    ("completed", flag(s, false)?),
                    ("content", text(s, "")?),
                    ("isError", flag(s, false)?),
                ],
            )?;
            push(out, &[update])
        })?;
    }
    Ok(())
}

fn retry<'a>(s: L<'a>, e: L<'a>) -> Result<L<'a>> {
    let facts = fields(s, &[])?;
    let mut has_facts = false;
    for (src, dest) in [
        (c"failed_attempt", c"failedAttempt"),
        (c"next_attempt", c"nextAttempt"),
        (c"max_attempts", c"maxAttempts"),
        (c"delay_ms", c"delayMs"),
        (c"status_code", c"httpStatus"),
    ] {
        let value = number_or_undefined(e.get(src)?)?;
        if !value.undefined()? {
            facts.set(dest, value)?;
            has_facts = true;
        }
    }
    for (src, dest) in [(c"error_name", c"code"), (c"error_message", c"message")] {
        let value = e.get(src)?;
        if value.kind()? == sys::ValueType::napi_string && value.truthy()? {
            facts.set(dest, value)?;
            has_facts = true;
        }
    }
    let result = row(s, "status", &[("status", text(s, "thinking")?)])?;
    if has_facts {
        result.set(c"retry", facts)?;
    }
    Ok(result)
}

fn failure<'a>(s: L<'a>, e: L<'a>) -> Result<L<'a>> {
    let detail = e.get(c"details")?;
    let detail = if object(detail)? {
        detail
    } else {
        fields(s, &[])?
    };
    let label = s.get(c"label")?;
    let message = or(e.get(c"message")?, || {
        or(detail.get(c"message")?, || {
            call(text(s, "")?, c"concat", &[label, text(s, " 出错")?])
        })
    })?;
    let code = or(e.get(c"code")?, || {
        or(detail.get(c"code")?, || detail.get(c"name"))
    })?;
    let mut status = detail.get(c"statusCode")?;
    if status.nullish()? {
        status = detail.get(c"status")?;
    }
    if status.nullish()? {
        status = e.get(c"status_code")?;
    }
    if status.nullish()? {
        status = e.get(c"statusCode")?;
    }
    let http = number_or_undefined(status)?;
    let request = or(detail.get(c"requestId")?, || {
        or(detail.get(c"requestID")?, || e.get(c"requestId"))
    })?;
    let error = fields(
        s,
        &[
            ("source", text(s, "kimi_event")?),
            ("provider", text(s, "kimi")?),
            ("code", code),
            ("httpStatus", http),
            ("requestId", request),
            ("message", message),
        ],
    )?;
    row(
        s,
        "error",
        &[
            ("label", label),
            ("message", message),
            ("kind", text(s, "provider")?),
            ("error", error),
        ],
    )
}

fn decode<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let event = a[0];
    let decoded = array(s)?;
    if !object(event)? {
        return Ok(decoded);
    }
    let role = event.get(c"role")?;
    if role.is_string("assistant")? {
        assistant(s, event, decoded)?;
    } else if role.is_string("tool")? {
        let content = event.get(c"content")?;
        let content = if content.kind()? == sys::ValueType::napi_string {
            content
        } else {
            json_call(
                s,
                c"stringify",
                if content.nullish()? {
                    text(s, "")?
                } else {
                    content
                },
            )?
        };
        push(
            decoded,
            &[row(
                s,
                "tool_update",
                &[
                    ("id", event.get(c"tool_call_id")?),
                    ("name", text(s, "tool")?),
                    ("input", fields(s, &[])?),
                    ("currentFile", null(s)?),
                    ("completed", flag(s, true)?),
                    ("content", content),
                    ("isError", flag(s, false)?),
                ],
            )?],
        )?;
    } else if role.is_string("meta")? {
        let kind = event.get(c"type")?;
        if kind.is_string("session.resume_hint")? && event.get(c"session_id")?.truthy()? {
            push(
                decoded,
                &[row(
                    s,
                    "session_started",
                    &[("sessionId", event.get(c"session_id")?)],
                )?],
            )?;
        } else if kind.is_string("turn.step.retrying")? {
            push(decoded, &[retry(s, event)?])?;
        }
    } else if event.get(c"type")?.is_string("error")? {
        push(decoded, &[failure(s, event)?])?;
    }
    Ok(decoded)
}
