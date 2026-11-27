//! Qoder and CodeBuddy share the result stream and differ in effort flags and error frames.
use crate::{
    codex_adapter::{concat, or, port, push, row},
    host_api::*,
    js_iteration::read,
};

// Keep ordinary CLI identifiers bare. Terminal launches run under tmux's shell,
// while buildInvocation below passes the original values as separate argv.
fn terminal_arg(value: L<'_>) -> Result<L<'_>> {
    let units = value.coerce_string()?;
    let plain = !units.as_units().is_empty()
        && units.as_units().iter().all(|&u| {
            u <= 127 && ((u as u8).is_ascii_alphanumeric() || b"_./:@%+=,-".contains(&(u as u8)))
        });
    if plain {
        return value.from_value(&V::String(units));
    }
    let mut quoted = vec![u16::from(b'\'')];
    for unit in units.as_units() {
        if *unit == u16::from(b'\'') {
            quoted.extend("'\\''".encode_utf16());
        } else {
            quoted.push(*unit);
        }
    }
    quoted.push(u16::from(b'\''));
    value.from_value(&V::String(multicc_core::js::JsString::from_units(quoted)))
}

fn effort<'a>(ctx: L<'a>, raw: L<'a>, model: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    let value = call(
        call(string(fallback(raw, "".into())?)?, c"trim", &[])?,
        c"toLowerCase",
        &[],
    )?;
    if value.truthy()?
        && port(
            ctx.get(c"ports")?,
            c"supportsEffort",
            &[ctx.get(c"name")?, model()?, value],
        )?
        .truthy()?
    {
        Ok(value)
    } else {
        null(ctx)
    }
}
fn terminal<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let session = a[0];
    let mut cmd = ctx.get(c"cmd")?;
    if read(session, c"model")?.truthy()? {
        cmd = concat(
            ctx,
            &[
                cmd,
                text(ctx, " --model ")?,
                terminal_arg(session.get(c"model")?)?,
            ],
        )?;
    }
    let level = effort(ctx, session.optional(c"effort")?, || {
        session.optional(c"model")
    })?;
    if level.truthy()? {
        cmd = concat(
            ctx,
            &[
                cmd,
                text(ctx, " ")?,
                ctx.get(c"flag")?,
                text(ctx, " ")?,
                terminal_arg(level)?,
            ],
        )?;
    }
    for (key, flag) in [(c"agent", " --agent "), (c"cliSessionId", " --resume ")] {
        if session.get(key)?.truthy()? {
            cmd = concat(
                ctx,
                &[cmd, text(ctx, flag)?, terminal_arg(session.get(key)?)?],
            )?;
        }
    }
    Ok(cmd)
}
fn invocation<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let env = a[0];
    let so = read(env, c"spawnOpts")?;
    let args = array(ctx)?;
    push(args, &[text(ctx, "-p")?])?;
    ctx.get(c"router")?.for_each(|arg| push(args, &[arg]))?;
    push(
        args,
        &[
            text(ctx, "--output-format")?,
            text(ctx, "stream-json")?,
            text(ctx, "--dangerously-skip-permissions")?,
            text(ctx, "--append-system-prompt")?,
            env.get(c"systemPrompt")?,
        ],
    )?;
    if read(so, c"rawModel")?.truthy()? {
        push(args, &[text(ctx, "--model")?, so.get(c"rawModel")?])?;
    }
    let raw = so.get(c"rawEffort")?;
    let model = or(so.get(c"rawModel")?, || so.get(c"effectiveModel"))?;
    let level = effort(ctx, raw, || Ok(model))?;
    if level.truthy()? {
        push(args, &[ctx.get(c"flag")?, level])?;
    }
    if so.get(c"rawAgent")?.truthy()? {
        push(args, &[text(ctx, "--agent")?, so.get(c"rawAgent")?])?;
    }
    if !read(env.get(c"historyHandle")?, c"isFirstTurn")?.truthy()?
        && read(env.get(c"historyHandle")?, c"cliSessionId")?.truthy()?
    {
        push(
            args,
            &[
                text(ctx, "--resume")?,
                read(env.get(c"historyHandle")?, c"cliSessionId")?,
            ],
        )?;
    }
    fields(
        ctx,
        &[
            ("cmd", ctx.get(c"cmd")?),
            ("args", args),
            (
                "payload",
                port(ctx.get(c"ports")?, c"renderPrompt", &[env])?,
            ),
        ],
    )
}
fn status(value: L<'_>) -> Result<Option<f64>> {
    let n = value.explicit_number()?;
    Ok((n.fract() == 0. && (400.0..=599.0).contains(&n)).then_some(n))
}
fn nonblank(value: L<'_>) -> Result<bool> {
    Ok(value.kind()? == sys::ValueType::napi_string && call(value, c"trim", &[])?.truthy()?)
}
fn first_error_message(event: L<'_>) -> Result<L<'_>> {
    if !event.get(c"errors")?.is_array()? {
        return undef(event);
    }
    call(
        event.get(c"errors")?,
        c"find",
        &[function(event, "", 1, 1, |p, a| flag(p, nonblank(a[0])?))?],
    )
}
fn status_of_event(event: L<'_>) -> Result<Option<f64>> {
    for key in [c"http_status", c"status_code"] {
        let value = event.get(key)?;
        if !value.nullish()? {
            return status(value);
        }
    }
    status(event.get(c"status")?)
}
fn error_fields<'a>(ctx: L<'a>, event: L<'a>) -> Result<L<'a>> {
    if !port(ctx.get(c"ports")?, c"resultCompletion", &[event])?
        .optional(c"state")?
        .is_string("failed")?
    {
        return null(ctx);
    }
    let (http, message) = if ctx.get(c"name")?.is_string("qoder")? {
        let http = match status(event.get(c"error_code")?)? {
            Some(n) => Some(n),
            None => status_of_event(event)?,
        };
        let primary = event.get(c"error_message")?;
        let other = first_error_message(event)?;
        (
            http,
            if nonblank(primary)? {
                primary
            } else if nonblank(other)? {
                other
            } else {
                undef(ctx)?
            },
        )
    } else {
        let info = if event.get(c"errors_info")?.is_array()? {
            call(
                event.get(c"errors_info")?,
                c"find",
                &[function(ctx, "", 1, 1, |p, a| flag(p, object(a[0])?))?],
            )?
        } else {
            null(ctx)?
        };
        let detail = if info.truthy()?
            && info.get(c"details")?.kind()? == sys::ValueType::napi_string
            && call(info.get(c"details")?, c"trim", &[])?.truthy()?
        {
            info.get(c"details")?
        } else {
            undef(ctx)?
        };
        let other = first_error_message(event)?;
        let value = info.optional(c"status")?;
        let value = if value.nullish()? {
            info.optional(c"statusCode")?
        } else {
            value
        };
        let http = match status(value)? {
            Some(n) => Some(n),
            None => status_of_event(event)?,
        };
        (http, if detail.truthy()? { detail } else { other })
    };
    if http.is_none() && message.undefined()? {
        return null(ctx);
    }
    let out = fields(ctx, &[])?;
    if let Some(n) = http {
        out.set(c"http_status", num(ctx, n)?)?;
    }
    if !message.undefined()? {
        out.set(c"message", message)?;
    }
    Ok(out)
}
fn decode<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let event = a[0];
    if event.optional(c"type")?.is_string("result")?
        && !port(ctx.get(c"ports")?, c"isMainResult", &[event])?.truthy()?
    {
        return array(ctx);
    }
    if !object(event)? {
        return array(ctx);
    }
    if event.get(c"type")?.is_string("system")? && event.get(c"subtype")?.is_string("init")? {
        let out = row(fields(
            ctx,
            &[
                ("type", text(ctx, "session_init")?),
                ("model", event.get(c"model")?),
                ("raw", event),
            ],
        )?)?;
        if event.get(c"session_id")?.truthy()? {
            push(
                out,
                &[fields(
                    ctx,
                    &[
                        ("type", text(ctx, "session_started")?),
                        ("sessionId", event.get(c"session_id")?),
                    ],
                )?],
            )?;
        }
        return Ok(out);
    }
    let mut raw = event;
    if event.get(c"type")?.is_string("result")? {
        if !(event.get(c"error")?.truthy()? && object(event.get(c"error")?)?) {
            let error = error_fields(ctx, event)?;
            if error.truthy()? {
                raw = spread(event)?;
                raw.set(c"error", error)?;
            }
        }
    } else if ctx.get(c"name")?.is_string("qoder")?
        && event.get(c"type")?.is_string("assistant")?
        && event.get(c"isApiErrorMessage")?.is_true()?
        && event.get(c"api_error_status")?.nullish()?
        && event.get(c"apiErrorStatus")?.nullish()?
    {
        if let Some(n) = status(event.get(c"displayErrorCode")?)? {
            raw = spread(event)?;
            raw.set(c"api_error_status", num(ctx, n)?)?;
        }
    }
    row(fields(
        ctx,
        &[("type", text(ctx, "claude_event")?), ("raw", raw)],
    )?)
}
fn create<'a>(p: L<'a>, options: L<'a>, name: &str, flag_name: &str) -> Result<L<'a>> {
    let cmd = read(options, c"cmd")?;
    let router = port(
        p,
        c"claudeLikeMcpArgs",
        &[
            options.get(c"routerMcpNode")?,
            options.get(c"routerMcpScript")?,
        ],
    )?;
    let name = text(p, name)?;
    let ctx = fields(
        p,
        &[
            ("ports", p),
            ("cmd", cmd),
            ("name", name),
            ("flag", text(p, flag_name)?),
            ("router", router),
        ],
    )?;
    fields(
        ctx,
        &[
            ("name", name),
            (
                "createCompletionTracker",
                p.get(c"createResultCompletionTracker")?,
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
}
pub(super) fn install<'a>(p: L<'a>, out: L<'a>) -> Result<()> {
    for (key, name, flag_name) in [
        ("createQoderAdapter", "qoder", "--reasoning-effort"),
        ("createCodebuddyAdapter", "codebuddy", "--effort"),
    ] {
        out.set_key(
            text(p, key)?,
            function(p, key, 1, 1, move |p, a| create(p, a[0], name, flag_name))?,
        )?;
    }
    let getter = function(p, "get CODEBUDDY_REASONING_LEVELS", 0, 0, |p, _| {
        let levels = port(p, c"effortOf", &[text(p, "codebuddy")?])?.get(c"levels")?;
        let filtered = call(levels, c"filter", &[p.global()?.get(c"Boolean")?])?;
        p.global()?.get(c"Set")?.construct(&[filtered])
    })?;
    call(
        p.global()?.get(c"Object")?,
        c"defineProperty",
        &[
            out,
            text(p, "CODEBUDDY_REASONING_LEVELS")?,
            fields(
                p,
                &[
                    ("enumerable", flag(p, true)?),
                    ("configurable", flag(p, true)?),
                    ("get", getter),
                ],
            )?,
        ],
    )?;
    Ok(())
}
