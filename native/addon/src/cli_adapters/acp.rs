use crate::host_api::*;
use multicc_core::acp_bridge::BRIDGE_COMMAND;
pub(super) mod common;
mod events;
use common::*;

fn completion<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    call(p, c"createProtocolCompletionTracker", &[text(p, "acp")?])
}
fn terminal<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let cb = ctx.get(c"terminalCmd")?;
    if cb.truthy()? {
        cb.call_plain(&[a[0]])
    } else {
        ctx.get(c"cmd")
    }
}
fn invocation<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let env = a[0];
    let first = env.get(c"historyHandle")?.get(c"isFirstTurn")?;
    let payload = invocation_payload(ctx, env, first)?;
    let cmd = call(host(ctx)?, c"gatewayPath", &[])?;
    let so = env.get(c"spawnOpts")?;
    let args = list(
        ctx,
        &[
            ctx.get(c"bridge")?,
            text(ctx, "--agent-bin")?,
            ctx.get(c"cmd")?,
            text(ctx, "--label")?,
            ctx.get(c"label")?,
        ],
    )?;
    let usage = ctx.get(c"nativeUsage")?;
    if usage.truthy()? {
        push(args, &[text(ctx, "--native-usage")?, usage])?;
    }
    let agent = ctx.get(c"agentArgs")?;
    let argv = if callable(agent)? {
        agent.call_plain(&[so])?
    } else {
        agent
    };
    argv.for_each(|v| push(args, &[text(ctx, "--agent-arg")?, v]))?;
    if env.get(c"historyHandle")?.get(c"cliSessionId")?.truthy()? {
        push(
            args,
            &[
                text(ctx, "--session-id")?,
                env.get(c"historyHandle")?.get(c"cliSessionId")?,
            ],
        )?;
    }
    if so.get(c"rawModel")?.truthy()? && !ctx.get(c"modelViaArgv")?.truthy()? {
        push(args, &[text(ctx, "--model")?, so.get(c"rawModel")?])?;
    }
    if so.get(c"rawEffort")?.truthy()?
        && ctx.get(c"effortViaConfig")?.truthy()?
        && !ctx.get(c"effortViaArgv")?.truthy()?
        && (!ctx.get(c"name")?.is_string("opencode")? || supports_effort(ctx, so)?)
    {
        push(args, &[text(ctx, "--effort")?, so.get(c"rawEffort")?])?;
    }
    if so.get(c"rawAgent")?.truthy()? && ctx.get(c"agentViaMode")?.truthy()? {
        push(args, &[text(ctx, "--mode")?, so.get(c"rawAgent")?])?;
    }
    let node = ctx.get(c"routerMcpNode")?;
    let script = ctx.get(c"routerMcpScript")?;
    if node.truthy()? && script.truthy()? {
        push(args, &[text(ctx, "--router-mcp")?, node, script])?;
    }
    push(args, &[text(ctx, "--")?])?;
    fields(ctx, &[("cmd", cmd), ("args", args), ("payload", payload)])
}
pub(in crate::cli_adapters) fn create<'a>(p: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let ctx = fields(p, &[("host", p)])?;
    for key in [
        c"name",
        c"label",
        c"cmd",
        c"agentArgs",
        c"bridge",
        c"modelViaArgv",
        c"effortViaArgv",
        c"effortViaConfig",
        c"agentViaMode",
        c"routerMcpNode",
        c"routerMcpScript",
        c"userInputReminder",
        c"terminalCmd",
        c"nativeUsage",
    ] {
        let mut v = opts.get(key)?;
        if v.undefined()? {
            v = match key.to_bytes() {
                b"agentArgs" => array(p)?,
                b"bridge" => text(p, BRIDGE_COMMAND)?,
                b"effortViaConfig" => flag(p, true)?,
                _ => v,
            };
        }
        ctx.set(key, v)?;
    }
    let map = p.global()?.get(c"Map")?;
    ctx.set(c"thoughts", map.construct(&[])?)?;
    ctx.set(c"tools", map.construct(&[])?)?;
    let out = fields(
        p,
        &[
            ("name", ctx.get(c"name")?),
            ("cmd", ctx.get(c"cmd")?),
            ("protocol", text(p, "acp")?),
            (
                "createCompletionTracker",
                p.get(c"api")?.get(c"createAcpCompletionTracker")?,
            ),
        ],
    )?;
    method(out, ctx, "buildTerminalCmd", 1, terminal)?;
    method(out, ctx, "buildInvocation", 1, invocation)?;
    method(out, ctx, "decodeEvent", 1, events::decode)?;
    out.set(c"needsAsyncSessionIdCapture", flag(p, false)?)?;
    Ok(out)
}
fn launch<'a>(p: L<'a>, name: &str, deps: L<'a>) -> Result<L<'a>> {
    let name = text(p, name)?;
    let cmd = deps.get(c"cmd")?;
    let node = deps.get(c"routerMcpNode")?;
    let script = deps.get(c"routerMcpScript")?;
    let reminder = deps.get(c"userInputReminder")?;
    let ctx = fields(p, &[("host", p), ("name", name), ("cmd", cmd)])?;
    let args = function(ctx, "agentArgs", 1, 1, |ctx, a| {
        let native = call(host(ctx)?, c"getNative", &[])?;
        call(native, c"acpLaunchArgs", &[ctx.get(c"name")?, a[0]])
    })?;
    let tty = function(ctx, "terminalCmd", 1, 1, |ctx, a| {
        let p = host(ctx)?;
        call(
            call(p, c"getNative", &[])?,
            c"acpLaunchTerminal",
            &[ctx.get(c"cmd")?, a[0], p.get(c"appendTerminalArg")?],
        )
    })?;
    create(
        p,
        fields(
            p,
            &[
                ("name", name),
                ("label", call(p, c"displayNameOf", &[name])?),
                ("cmd", cmd),
                ("routerMcpNode", node),
                ("routerMcpScript", script),
                ("userInputReminder", reminder),
                ("modelViaArgv", flag(p, true)?),
                ("effortViaConfig", flag(p, false)?),
                ("agentArgs", args),
                ("terminalCmd", tty),
            ],
        )?,
    )
}
pub(super) fn install<'a>(p: L<'a>, out: L<'a>) -> Result<()> {
    out.set(c"BRIDGE", text(p, BRIDGE_COMMAND)?)?;
    method(out, p, "contentText", 1, |_, a| events::content_text(a[0]))?;
    method(out, p, "createAcpAdapter", 1, |p, a| create(p, a[0]))?;
    method(out, p, "createAcpCompletionTracker", 0, completion)?;
    method(out, p, "createGeminiAdapter", 1, |p, a| {
        launch(p, "gemini", a[0])
    })?;
    method(out, p, "createGrokAdapter", 1, |p, a| {
        launch(p, "grok", a[0])
    })
}
