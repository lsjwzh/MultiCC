use super::print_common::*;

pub(super) fn install<'a>(p: L<'a>, out: L<'a>) -> Result<()> {
    out.set(
        c"createCommandCodeAdapter",
        function(p, "createCommandCodeAdapter", 1, 1, create)?,
    )
}

fn create<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let options = a[0];
    let cmd = options.get(c"cmd")?;
    let env = options.get(c"env")?;
    let env = if env.undefined()? {
        p.get(c"process")?.get(c"env")?
    } else {
        env
    };
    let model = call(
        text(p, "deepseek/")?,
        c"concat",
        &[fallback(
            env.get(c"DEEPSEEK_FLASH_MODEL")?,
            "deepseek-flash".into(),
        )?],
    )?;
    let label = port(p, c"displayNameOf", &[text(p, "commandcode")?])?;
    let state = fields(
        p,
        &[
            ("ports", p),
            ("cmd", cmd),
            ("model", model),
            ("label", label),
            ("sequence", num(p, 0.)?),
        ],
    )?;
    let out = fields(
        p,
        &[
            ("name", text(p, "commandcode")?),
            ("cmd", cmd),
            ("needsAsyncSessionIdCapture", flag(p, false)?),
        ],
    )?;
    out.set(
        c"buildTerminalCmd",
        function(state, "buildTerminalCmd", 1, 1, terminal)?,
    )?;
    out.set(
        c"buildInvocation",
        function(state, "buildInvocation", 1, 1, invocation)?,
    )?;
    out.set(
        c"createCompletionTracker",
        function(p, "createCompletionTracker", 0, 0, |p, _| {
            port(
                p,
                c"createProtocolCompletionTracker",
                &[text(p, "commandcode")?],
            )
        })?,
    )?;
    out.set(
        c"decodeEvent",
        function(state, "decodeEvent", 1, 1, decode)?,
    )?;
    Ok(out)
}

fn terminal<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let session = a[0];
    let cmd = quote(s.get(c"cmd")?)?;
    let model = quote(or(session.get(c"model")?, || s.get(c"model"))?)?;
    let start = call(cmd, c"concat", &[text(s, " --model ")?, model])?;
    let id = session.get(c"cliSessionId")?;
    if id.truthy()? {
        call(start, c"concat", &[text(s, " --resume ")?, quote(id)?])
    } else {
        Ok(start)
    }
}

fn invocation<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let env = a[0];
    let args = strings(s, &["--output-format", "json", "--model"])?;
    let model = or(env.get(c"spawnOpts")?.get(c"rawModel")?, || s.get(c"model"))?;
    push(
        args,
        &[
            model,
            text(s, "--skip-onboarding")?,
            text(s, "--no-auto-update")?,
            text(s, "--yolo")?,
        ],
    )?;
    let first = env.get(c"historyHandle")?.get(c"isFirstTurn")?;
    if !first.truthy()? {
        option(
            args,
            "--resume",
            env.get(c"historyHandle")?.get(c"cliSessionId")?,
        )?;
    }
    push(args, &[text(s, "-p")?])?;
    command(s, args, prompt(s.get(c"ports")?, env, first)?)
}

fn failure<'a>(s: L<'a>, e: L<'a>) -> Result<L<'a>> {
    let message = or(e.get(c"message")?, || {
        let detail = e.get(c"error")?;
        or(detail.optional(c"message")?, || {
            if detail.kind()? == sys::ValueType::napi_string {
                fallback(detail, "Command Code 执行失败".into())
            } else {
                text(s, "Command Code 执行失败")
            }
        })
    })?;
    let detail = fields(
        s,
        &[
            ("source", text(s, "commandcode_event")?),
            ("provider", text(s, "commandcode")?),
            ("message", message),
            (
                "code",
                or(e.get(c"code")?, || e.get(c"error")?.optional(c"code"))?,
            ),
            (
                "httpStatus",
                or(e.get(c"status")?, || e.get(c"error")?.optional(c"status"))?,
            ),
        ],
    )?;
    row(
        s,
        "error",
        &[
            ("label", s.get(c"label")?),
            ("message", message),
            ("kind", text(s, "provider")?),
            ("error", detail),
        ],
    )
}

fn thinking<'a>(s: L<'a>, e: L<'a>) -> Result<L<'a>> {
    let content = or(e.get(c"content")?, || array(e))?;
    let filter = function(s, "isThinking", 1, 1, |s, a| {
        if a[0].get(c"type")?.is_string("thinking")? {
            a[0].get(c"thinking")
        } else {
            flag(s, false)
        }
    })?;
    let map = function(s, "thinkingPart", 1, 1, |s, a| {
        let next = num(s, s.get(c"sequence")?.number()? + 1.)?;
        s.set(c"sequence", next)?;
        let id = call(text(s, "commandcode-thinking-")?, c"concat", &[next])?;
        row(
            s,
            "thinking",
            &[
                ("id", id),
                ("text", a[0].get(c"thinking")?),
                ("completed", flag(s, true)?),
            ],
        )
    })?;
    call(call(content, c"filter", &[filter])?, c"map", &[map])
}

fn decode<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let raw = a[0];
    if !object(raw)? {
        return array(s);
    }
    let e = or(raw.get(c"event")?, || Ok(raw))?;
    let kind = e.get(c"type")?;
    let out = if kind.is_string("run_start")? && e.get(c"sessionId")?.truthy()? {
        row(s, "session_started", &[("sessionId", e.get(c"sessionId")?)])?
    } else if kind.is_string("turn_start")? {
        row(s, "status", &[("status", text(s, "thinking")?)])?
    } else if kind.is_string("text_delta")? && e.get(c"delta")?.truthy()? {
        row(
            s,
            "assistant_text",
            &[("text", e.get(c"delta")?), ("delta", flag(s, true)?)],
        )?
    } else if kind.is_string("message_end")? {
        return thinking(s, e);
    } else if kind.is_string("tool_queued")? {
        row(
            s,
            "tool_update",
            &[
                ("id", e.get(c"toolCallId")?),
                ("name", e.get(c"toolName")?),
                ("input", or(e.get(c"input")?, || fields(s, &[]))?),
                ("completed", flag(s, false)?),
            ],
        )?
    } else if kind.string()?.is_some_and(|s| {
        matches!(
            s.as_str_lossy().as_ref(),
            "tool_completed" | "tool_failed" | "tool_errored" | "tool_error" | "tool_denied"
        )
    }) {
        let result = e.get(c"result")?;
        let content = if result.kind()? == sys::ValueType::napi_string {
            result
        } else {
            json_call(
                s,
                c"stringify",
                or(result, || fallback(e.get(c"error")?, "".into()))?,
            )?
        };
        row(
            s,
            "tool_update",
            &[
                ("id", e.get(c"toolCallId")?),
                ("name", e.get(c"toolName")?),
                ("completed", flag(s, true)?),
                ("isError", flag(s, !kind.is_string("tool_completed")?)?),
                ("content", content),
            ],
        )?
    } else if kind.is_string("error")? {
        failure(s, e)?
    } else if raw.get(c"type")?.is_string("result")? {
        if !raw.get(c"subtype")?.is_string("success")?
            || !raw.get(c"stopReason")?.is_string("end_turn")?
        {
            failure(s, raw)?
        } else {
            let u = raw.get(c"usage")?;
            let usage = fields(s, &[])?;
            for (key, source) in [
                (c"input_tokens", c"inputTokens"),
                (c"output_tokens", c"outputTokens"),
                (c"cache_read_input_tokens", c"cacheReadTokens"),
                (c"cache_creation_input_tokens", c"cacheWriteTokens"),
            ] {
                usage.set(key, fallback(u.optional(source)?, 0.0.into())?)?;
            }
            row(s, "complete", &[("cost", null(s)?), ("usage", usage)])?
        }
    } else {
        return array(s);
    };
    single(out)
}
