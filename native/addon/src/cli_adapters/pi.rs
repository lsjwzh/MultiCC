use super::print_common::*;

pub(super) fn install<'a>(p: L<'a>, out: L<'a>) -> Result<()> {
    let status_re = p.global()?.get(c"RegExp")?.construct(&[
        text(p, r"(?:status(?: code)?|HTTP)\s*:?\s*([45]\d\d)\b")?,
        text(p, "i")?,
    ])?;
    let shared = fields(
        p,
        &[
            ("ports", p),
            ("statusRe", status_re),
            (
                "lastAssistant",
                function(p, "lastAssistant", 1, 1, last_assistant)?,
            ),
        ],
    )?;
    out.set(
        c"createPiAdapter",
        function(shared, "createPiAdapter", 0, 1, create)?,
    )?;
    let get = function(p, "get PI_THINKING_LEVELS", 0, 0, |p, _| {
        let effort = port(p, c"effortOf", &[text(p, "pi")?])?;
        call(
            effort.get(c"levels")?,
            c"filter",
            &[p.global()?.get(c"Boolean")?],
        )
    })?;
    let descriptor = fields(
        p,
        &[
            ("get", get),
            ("enumerable", flag(p, true)?),
            ("configurable", flag(p, true)?),
        ],
    )?;
    call(
        p.global()?.get(c"Object")?,
        c"defineProperty",
        &[out, text(p, "PI_THINKING_LEVELS")?, descriptor],
    )?;
    Ok(())
}

fn create<'a>(shared: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = shared.get(c"ports")?;
    let options = default_object(a[0])?;
    let cmd = with_default(options.get(c"cmd")?, text(p, "pi")?)?;
    let state = fields(
        p,
        &[
            ("ports", p),
            ("cmd", cmd),
            ("node", options.get(c"routerMcpNode")?),
            ("script", options.get(c"routerMcpScript")?),
        ],
    )?;
    fields(
        p,
        &[
            ("name", text(p, "pi")?),
            ("cmd", cmd),
            ("needsAsyncSessionIdCapture", flag(p, false)?),
            (
                "buildTerminalCmd",
                function(state, "buildTerminalCmd", 0, 1, terminal)?,
            ),
            (
                "buildInvocation",
                function(state, "buildInvocation", 1, 1, invocation)?,
            ),
            (
                "createCompletionTracker",
                function(shared, "createCompletionTracker", 0, 0, |s, _| {
                    tracker(
                        s.get(c"ports")?,
                        c"RustPiCompletionTracker",
                        s.get(c"lastAssistant")?,
                        |owner, a| {
                            call(
                                owner.get(c"native")?,
                                c"observe",
                                &[a[0], owner.get(c"context")?],
                            )
                        },
                        |owner, a| call(owner.get(c"native")?, c"close", &[a[2]]),
                    )
                })?,
            ),
            (
                "decodeEvent",
                function(shared, "decodeEvent", 1, 1, decode)?,
            ),
        ],
    )
}

fn effort<'a>(p: L<'a>, model: L<'a>, value: L<'a>) -> Result<bool> {
    port(p, c"supportsEffort", &[text(p, "pi")?, model, value])?.truthy()
}

fn terminal<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let session = default_object(a[0])?;
    let args = single(quote(s.get(c"cmd")?)?)?;
    let model = session.get(c"model")?;
    if model.truthy()? {
        push(args, &[text(s, "--model")?, quote(model)?])?;
    }
    let thinking = session.get(c"effort")?;
    if thinking.truthy()? && effort(s.get(c"ports")?, session.get(c"model")?, thinking)? {
        push(args, &[text(s, "--thinking")?, thinking])?;
    }
    let id = session.get(c"cliSessionId")?;
    if id.truthy()? {
        push(args, &[text(s, "--session")?, quote(id)?])?;
    }
    call(args, c"join", &[text(s, " ")?])
}

fn invocation<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = s.get(c"ports")?;
    let env = a[0];
    let so = or(env.get(c"spawnOpts")?, || fields(p, &[]))?;
    let args = strings(s, &["--mode", "json", "--print"])?;
    option(args, "--model", so.get(c"rawModel")?)?;
    let thinking = so.get(c"rawEffort")?;
    if thinking.truthy()?
        && effort(
            p,
            or(so.get(c"rawModel")?, || so.get(c"effectiveModel"))?,
            thinking,
        )?
    {
        push(args, &[text(p, "--thinking")?, thinking])?;
    }
    let history = env.get(c"historyHandle")?;
    if !history.get(c"isFirstTurn")?.truthy()? {
        option(args, "--session", history.get(c"cliSessionId")?)?;
    }
    option(args, "--append-system-prompt", env.get(c"systemPrompt")?)?;
    let node = s.get(c"node")?;
    let script = s.get(c"script")?;
    if node.truthy()? && script.truthy()? {
        push(
            args,
            &[
                text(p, "--extension")?,
                p.get(c"piExtensionPath")?,
                text(p, "--multicc-router-node")?,
                node,
                text(p, "--multicc-router-script")?,
                script,
            ],
        )?;
    }
    let prompt = port(p, c"renderPrompt", &[env])?;
    let first = prompt.coerce_string()?.code_unit_at(0);
    let payload = if matches!(first, Some(45 | 64)) {
        call(text(p, "\n")?, c"concat", &[prompt])?
    } else {
        prompt
    };
    command(s, args, payload)
}

fn assistants(event: L<'_>) -> Result<L<'_>> {
    let messages = or(event.get(c"messages")?, || array(event))?;
    call(
        messages,
        c"filter",
        &[function(event, "isAssistant", 1, 1, |p, a| {
            flag(p, a[0].get(c"role")?.is_string("assistant")?)
        })?],
    )
}
fn last_assistant<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    call(assistants(a[0])?, c"at", &[num(p, -1.)?])
}

fn error_event<'a>(s: L<'a>, message: L<'a>, code: L<'a>) -> Result<L<'a>> {
    let p = s.get(c"ports")?;
    let upstream = port(p, c"extractUpstreamError", &[message])?;
    let detail = or(upstream.get(c"message")?, || Ok(message))?;
    let code = or(upstream.get(c"code")?, || {
        or(upstream.get(c"type")?, || Ok(code))
    })?;
    let http = or(upstream.get(c"httpStatus")?, || {
        let m = call(s.get(c"statusRe")?, c"exec", &[message])?;
        if m.nullish()? {
            undef(p)
        } else {
            num(p, m.element(1)?.explicit_number()?)
        }
    })?;
    let error = fields(
        p,
        &[
            ("source", text(p, "pi_event")?),
            ("provider", text(p, "pi")?),
            ("code", code),
            ("message", detail),
            ("httpStatus", http),
            ("requestId", upstream.get(c"requestId")?),
        ],
    )?;
    let param = upstream.get(c"param")?;
    if param.truthy()? {
        error.set(c"param", param)?;
    }
    row(
        p,
        "error",
        &[
            ("label", text(p, "Pi")?),
            ("message", detail),
            ("error", error),
        ],
    )
}

fn text_content(content: L<'_>) -> Result<L<'_>> {
    if !content.is_array()? {
        return text(content, "");
    }
    let filter = function(content, "isText", 1, 1, |p, a| {
        flag(p, a[0].get(c"type")?.is_string("text")?)
    })?;
    let map = function(content, "getText", 1, 1, |_, a| {
        fallback(a[0].get(c"text")?, "".into())
    })?;
    call(
        call(call(content, c"filter", &[filter])?, c"map", &[map])?,
        c"join",
        &[text(content, "\n")?],
    )
}

fn message_update<'a>(s: L<'a>, e: L<'a>) -> Result<L<'a>> {
    let update = or(e.get(c"assistantMessageEvent")?, || fields(s, &[]))?;
    let kind = update.get(c"type")?;
    if kind.is_string("text_delta")? && update.get(c"delta")?.truthy()? {
        return single(row(
            s,
            "assistant_text",
            &[("text", update.get(c"delta")?), ("delta", flag(s, true)?)],
        )?);
    }
    let end = kind.is_string("thinking_end")?;
    if !end && !kind.is_string("thinking_delta")? {
        return array(s);
    }
    let message = e.get(c"message")?;
    let content = message.optional(c"content")?;
    let note = if content.nullish()? {
        undef(s)?
    } else {
        content
            .get_key(update.get(c"contentIndex")?)?
            .optional(c"thinking")?
    };
    let thought = or(note, || {
        or(update.get(c"content")?, || {
            fallback(update.get(c"delta")?, "".into())
        })
    })?;
    let id = call(
        text(s, "pi_thinking_")?,
        c"concat",
        &[
            fallback(message.optional(c"timestamp")?, 0.0.into())?,
            text(s, "_")?,
            fallback(update.get(c"contentIndex")?, 0.0.into())?,
        ],
    )?;
    single(row(
        s,
        "thinking",
        &[
            ("id", id),
            ("text", thought),
            ("snapshot", flag(s, true)?),
            ("delta", flag(s, !end)?),
            ("completed", flag(s, end)?),
        ],
    )?)
}

fn agent_end<'a>(s: L<'a>, e: L<'a>) -> Result<L<'a>> {
    let messages = assistants(e)?;
    let keys = [
        (c"input", c"input_tokens"),
        (c"output", c"output_tokens"),
        (c"cacheRead", c"cache_read_input_tokens"),
        (c"cacheWrite", c"cache_creation_input_tokens"),
    ];
    let mut sums = [0.; 4];
    let mut cost = 0.;
    messages.for_each(|msg| {
        let u = msg.get(c"usage")?;
        for (i, (key, _)) in keys.iter().enumerate() {
            sums[i] += fallback(u.optional(key)?, 0.0.into())?.explicit_number()?;
        }
        cost +=
            fallback(u.optional(c"cost")?.optional(c"total")?, 0.0.into())?.explicit_number()?;
        Ok(())
    })?;
    let usage = fields(s, &[])?;
    for (i, (_, key)) in keys.iter().enumerate() {
        usage.set(key, num(s, sums[i])?)?;
    }
    let results = array(s)?;
    let last = call(messages, c"at", &[num(s, -1.)?])?;
    if e.get(c"willRetry")?.is_false()? {
        let reason = last.optional(c"stopReason")?;
        let length = reason.is_string("length")?;
        if length || reason.is_string("error")? {
            let message = fallback(
                last.get(c"errorMessage")?,
                (if length {
                    "Pi 达到模型输出长度限制，回复未完成"
                } else {
                    "Pi 请求失败"
                })
                .into(),
            )?;
            let code = call(text(s, "pi_")?, c"concat", &[reason])?;
            push(results, &[error_event(s, message, code)?])?;
        }
    }
    push(
        results,
        &[row(
            s,
            "complete",
            &[("usage", usage), ("cost", num(s, cost)?)],
        )?],
    )?;
    Ok(results)
}

fn decode<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let e = a[0];
    if !object(e)? {
        return array(s);
    }
    let kind = e.get(c"type")?;
    let out = if kind.is_string("session")? && e.get(c"id")?.truthy()? {
        row(s, "session_started", &[("sessionId", e.get(c"id")?)])?
    } else if kind.is_string("agent_start")? || kind.is_string("auto_retry_start")? {
        row(s, "status", &[("status", text(s, "thinking")?)])?
    } else if kind.is_string("message_update")? {
        return message_update(s, e);
    } else if kind.is_string("tool_execution_start")? {
        row(
            s,
            "tool_start",
            &[
                ("id", e.get(c"toolCallId")?),
                ("name", e.get(c"toolName")?),
                ("input", or(e.get(c"args")?, || fields(s, &[]))?),
                (
                    "currentFile",
                    fallback(e.get(c"args")?.optional(c"path")?, V::Null)?,
                ),
            ],
        )?
    } else if kind.is_string("tool_execution_end")? {
        row(
            s,
            "tool_result",
            &[
                ("id", e.get(c"toolCallId")?),
                (
                    "content",
                    text_content(e.get(c"result")?.optional(c"content")?)?,
                ),
                ("isError", flag(s, e.get(c"isError")?.truthy()?)?),
            ],
        )?
    } else if kind.is_string("auto_retry_end")? && e.get(c"success")?.is_false()? {
        error_event(
            s,
            fallback(e.get(c"finalError")?, "Pi 自动重试失败".into())?,
            text(s, "pi_retry_exhausted")?,
        )?
    } else if kind.is_string("agent_end")? {
        return agent_end(s, e);
    } else {
        return array(s);
    };
    single(out)
}
