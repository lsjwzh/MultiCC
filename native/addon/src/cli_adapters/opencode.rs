use super::acp::{self, common::*};
use crate::host_api::*;
use multicc_core::acp_bridge::MODEL_ERROR_COMMAND;
mod legacy;

fn terminal<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let session = a[0];
    let mut cmd = ctx.get(c"cmd")?;
    let append = host(ctx)?.get(c"appendTerminalArg")?;
    let variant = ctx.get(c"supportsAgentVariant")?.truthy()?;
    if session.get(c"model")?.truthy()? {
        cmd = append.call_plain(&[cmd, text(ctx, "--model")?, session.get(c"model")?])?;
    }
    if variant
        && session.get(c"effort")?.truthy()?
        && call(
            host(ctx)?,
            c"supportsEffort",
            &[
                ctx.get(c"name")?,
                session.get(c"model")?,
                session.get(c"effort")?,
            ],
        )?
        .truthy()?
    {
        cmd = append.call_plain(&[cmd, text(ctx, "--variant")?, session.get(c"effort")?])?;
    }
    if variant && session.get(c"agent")?.truthy()? {
        cmd = append.call_plain(&[cmd, text(ctx, "--agent")?, session.get(c"agent")?])?;
    }
    if session.get(c"cliSessionId")?.truthy()? {
        cmd = append.call_plain(&[cmd, text(ctx, "--session")?, session.get(c"cliSessionId")?])?;
    }
    Ok(cmd)
}
fn invocation<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let env = a[0];
    let so = env.get(c"spawnOpts")?;
    let first = env.get(c"historyHandle")?.get(c"isFirstTurn")?;
    let args = list(
        ctx,
        &[
            text(ctx, "run")?,
            text(ctx, "--format")?,
            text(ctx, "json")?,
            text(ctx, "--auto")?,
        ],
    )?;
    if ctx.get(c"includeThinking")?.truthy()? {
        push(args, &[text(ctx, "--thinking")?])?;
    }
    if so.get(c"rawModel")?.truthy()? {
        push(args, &[text(ctx, "--model")?, so.get(c"rawModel")?])?;
    }
    let variant = ctx.get(c"supportsAgentVariant")?.truthy()?;
    if variant && so.get(c"rawEffort")?.truthy()? && supports_effort(ctx, so)? {
        push(args, &[text(ctx, "--variant")?, so.get(c"rawEffort")?])?;
    }
    if variant && so.get(c"rawAgent")?.truthy()? {
        push(args, &[text(ctx, "--agent")?, so.get(c"rawAgent")?])?;
    }
    if !first.truthy()? {
        if env.get(c"historyHandle")?.get(c"cliSessionId")?.truthy()? {
            push(
                args,
                &[
                    text(ctx, "--session")?,
                    env.get(c"historyHandle")?.get(c"cliSessionId")?,
                ],
            )?;
        } else {
            push(args, &[text(ctx, "--continue")?])?;
        }
    }
    fields(
        ctx,
        &[
            ("cmd", ctx.get(c"cmd")?),
            ("args", args),
            ("payload", invocation_payload(ctx, env, first)?),
        ],
    )
}
fn like<'a>(p: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let ctx = fields(p, &[("host", p)])?;
    for k in [
        c"name",
        c"label",
        c"cmd",
        c"supportsAgentVariant",
        c"includeThinking",
        c"userInputReminder",
    ] {
        ctx.set(k, opts.get(k)?)?;
    }
    let out = fields(
        p,
        &[
            ("name", ctx.get(c"name")?),
            (
                "createCompletionTracker",
                p.get(c"createStepCompletionTracker")?,
            ),
            ("cmd", ctx.get(c"cmd")?),
        ],
    )?;
    method(out, ctx, "buildTerminalCmd", 1, terminal)?;
    method(out, ctx, "buildInvocation", 1, invocation)?;
    method(out, ctx, "decodeEvent", 1, legacy::decode)?;
    out.set(c"needsAsyncSessionIdCapture", flag(p, false)?)?;
    Ok(out)
}
fn guard<'a>(p: L<'a>, adapter: L<'a>, lane: &str) -> Result<L<'a>> {
    let ctx = fields(
        p,
        &[
            ("host", p),
            ("adapter", adapter),
            ("lane", text(p, lane)?),
            ("build", adapter.get(c"buildInvocation")?),
        ],
    )?;
    let out = spread(adapter)?;
    method(out, ctx, "decodeEvent", 1, |ctx, a| {
        let decoded = call(ctx.get(c"adapter")?, c"decodeEvent", &[a[0]])?;
        let present = function(ctx, "presentError", 1, 1, |ctx, args| {
            let event = args[0];
            if !event.get(c"type")?.is_string("error")? {
                return Ok(event);
            }
            let failure = call(
                host(ctx)?,
                c"classifyProviderError",
                &[
                    event.get(c"error")?,
                    fields(
                        ctx,
                        &[
                            ("provider", text(ctx, "opencode")?),
                            ("source", text(ctx, "opencode_event")?),
                        ],
                    )?,
                ],
            )?;
            let detail = failure.optional(c"presentation")?;
            if !detail.truthy()? {
                return Ok(event);
            }
            let result = spread(event)?;
            result.set(
                c"message",
                concat(ctx, &[detail.get(c"message")?, detail.get(c"userAction")?])?,
            )?;
            Ok(result)
        })?;
        call(decoded, c"map", &[present])
    })?;
    method(out, ctx, "buildInvocation", 1, |ctx, a| {
        let env = a[0];
        let model = if env.truthy()? && env.get(c"spawnOpts")?.truthy()? {
            env.get(c"spawnOpts")?.get(c"rawModel")?
        } else {
            null(ctx)?
        };
        let verdict = call(host(ctx)?, c"validateOpenCodeModel", &[model])?;
        if verdict.truthy()? && verdict.get(c"valid")?.is_false()? {
            let selected = call(string(model)?, c"trim", &[])?;
            let suggestion = verdict.get(c"suggestion")?;
            return fields(
                ctx,
                &[
                    ("cmd", call(host(ctx)?, c"gatewayPath", &[])?),
                    (
                        "args",
                        list(
                            ctx,
                            &[
                                text(ctx, MODEL_ERROR_COMMAND)?,
                                ctx.get(c"lane")?,
                                selected,
                                fallback(suggestion, "".into())?,
                            ],
                        )?,
                    ),
                    ("payload", text(ctx, "")?),
                ],
            );
        }
        ctx.get(c"build")?.call(ctx.get(c"adapter")?, &[env])
    })?;
    Ok(out)
}
fn create<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = a[0];
    let cmd = opts.get(c"cmd")?;
    let reminder = opts.get(c"userInputReminder")?;
    let node = opts.get(c"routerMcpNode")?;
    let script = opts.get(c"routerMcpScript")?;
    let default_env = opts.get(c"env")?;
    let env = if default_env.undefined()? {
        p.get(c"process")?.get(c"env")?
    } else {
        default_env
    };
    let legacy = env.get(c"MULTICC_OPENCODE_LEGACY_JSON")?.is_string("1")?;
    let name = text(p, "opencode")?;
    let label = p.get(c"opencodeLabel")?;
    let config = fields(
        p,
        &[
            ("name", name),
            ("label", label),
            ("cmd", cmd),
            ("userInputReminder", reminder),
            ("supportsAgentVariant", flag(p, true)?),
        ],
    )?;
    if legacy {
        config.set(c"includeThinking", flag(p, true)?)?;
        return guard(p, like(p, config)?, "legacy");
    }
    config.set(c"agentArgs", list(p, &[text(p, "acp")?])?)?;
    config.set(c"nativeUsage", name)?;
    config.set(c"agentViaMode", flag(p, true)?)?;
    config.set(c"routerMcpNode", node)?;
    config.set(c"routerMcpScript", script)?;
    config.set(c"host", p)?;
    config.set(
        c"terminalCmd",
        function(config, "terminalCmd", 1, 1, terminal)?,
    )?;
    guard(p, acp::create(p, config)?, "acp")
}
pub(super) fn install<'a>(p: L<'a>, out: L<'a>) -> Result<()> {
    p.set(
        c"opencodeLabel",
        call(p, c"displayNameOf", &[text(p, "opencode")?])?,
    )?;
    method(out, p, "createOpencodeLikeAdapter", 1, |p, a| like(p, a[0]))?;
    method(out, p, "createOpencodeAdapter", 1, create)
}
