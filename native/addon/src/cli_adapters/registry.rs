//! Keep the command map live. A changed command replaces the registry on the
//! next lookup, while adapters already held by an active turn remain usable.
use super::print_common::or;
use crate::host_api::*;
use std::ffi::CStr;

fn project(target: L<'_>, source: L<'_>, entries: &[(&CStr, &CStr)]) -> Result<()> {
    for &(key, from) in entries {
        target.set(key, source.get(from)?)?;
    }
    Ok(())
}

fn codex_exp_option<'a>(deps: L<'a>, name: &'static CStr) -> Result<L<'a>> {
    if !callable(deps.get(name)?)? {
        return undef(deps);
    }
    function(deps, "", 1, 1, move |deps, a| {
        let session = spread(a[0])?;
        session.set(c"cli", text(deps, "codex-exp")?)?;
        call(deps, name, &[session])
    })
}

fn build(p: L<'_>) -> Result<L<'_>> {
    let host = p.get(c"host")?;
    let api = host.get(c"api")?;
    let commands = p.get(c"commands")?;
    let deps = p.get(c"deps")?;
    let adapters = array(p)?;
    for (cli, factory, factory_owner) in [
        (c"claude", c"createClaudeAdapter", host),
        (c"codex", c"createCodexAdapter", host),
        (c"codex-exp", c"createCodexExpAdapter", host),
        (c"opencode", c"createOpencodeAdapter", api),
        (c"zcode", c"createZcodeAdapter", api),
        (c"qoder", c"createQoderAdapter", api),
        (c"kimi", c"createKimiAdapter", api),
        (c"codebuddy", c"createCodebuddyAdapter", api),
        (c"dsh", c"createDshAdapter", host),
        (c"gemini", c"createGeminiAdapter", api),
        (c"commandcode", c"createCommandCodeAdapter", api),
        (c"grok", c"createGrokAdapter", api),
        (c"agy", c"createAgyAdapter", api),
        (c"pi", c"createPiAdapter", api),
    ] {
        let cmd = commands.get(cli)?;
        let opts = fields(p, &[])?;
        opts.set(
            if cli == c"codex-exp" {
                c"codexCmd"
            } else {
                c"cmd"
            },
            cmd,
        )?;
        if cli == c"claude" {
            project(
                opts,
                deps,
                &[
                    (c"args", c"claudeArgs"),
                    (c"chatDisallowedTools", c"claudeChatDisallowedTools"),
                    (c"resolveSessionWireModel", c"resolveSessionWireModel"),
                    (c"cliEffortLevel", c"cliEffortLevel"),
                    (c"normalizeEffort", c"normalizeEffort"),
                    (c"debugLogClaudeInvoke", c"debugLogClaudeInvoke"),
                    (c"logClaudeInvocations", c"logClaudeInvocations"),
                ],
            )?;
        } else if cli == c"codex" {
            project(
                opts,
                deps,
                &[
                    (c"args", c"codexArgs"),
                    (c"codexReasoningConfigArg", c"codexReasoningConfigArg"),
                    (c"codexModelConfigArg", c"codexModelConfigArg"),
                    (c"envConstraint", c"codexEnvConstraint"),
                    (c"stayAlivePrompt", c"codexStayAlivePrompt"),
                    (c"multiccImgHint", c"multiccImgHint"),
                ],
            )?;
        } else if cli == c"codex-exp" {
            opts.set(
                c"codexReasoningConfigArg",
                codex_exp_option(deps, c"codexReasoningConfigArg")?,
            )?;
            opts.set(c"codexModelConfigArg", deps.get(c"codexModelConfigArg")?)?;
            opts.set(
                c"codexReasoningLevel",
                codex_exp_option(deps, c"codexReasoningLevel")?,
            )?;
            project(
                opts,
                deps,
                &[
                    (c"envConstraint", c"codexEnvConstraint"),
                    (c"multiccImgHint", c"multiccImgHint"),
                ],
            )?;
        } else if cli == c"opencode" {
            opts.set(c"userInputReminder", deps.get(c"userInputReminder")?)?;
        }
        if cli != c"zcode" && cli != c"dsh" {
            opts.set(c"routerMcpNode", p.get(c"routerMcpNode")?)?;
            opts.set(c"routerMcpScript", p.get(c"routerMcpScript")?)?;
        }
        if cli == c"codex" {
            project(
                opts,
                deps,
                &[
                    (
                        c"isResponseCompletedDisconnect",
                        c"isCodexResponseCompletedDisconnect",
                    ),
                    (c"isTransportDisconnect", c"isCodexTransportDisconnect"),
                ],
            )?;
        }
        let adapter = factory_owner.get(factory)?.call_plain(&[opts])?;
        call(adapters, c"push", &[adapter])?;
    }
    host.get(c"createCliProviderRegistry")?
        .call_plain(&[adapters])
}

fn latest(p: L<'_>) -> Result<L<'_>> {
    p.get(c"commandsNow")?.call_plain(&[])?;
    let next = json_call(p, c"stringify", p.get(c"commands")?)?;
    if !next.equals(p.get(c"signature")?)? {
        p.set(c"registry", build(p)?)?;
        p.set(c"signature", next)?;
    }
    p.get(c"registry")
}

pub(super) fn create<'a>(host: L<'a>, deps: L<'a>) -> Result<L<'a>> {
    let resolve = or(deps.get(c"resolveCliCommands")?, || {
        host.get(c"resolveCliCommands")
    })?;
    let commands =
        resolve.call_plain(&[fields(host, &[("isWindows", deps.get(c"isWindows")?)])?])?;
    let options = fields(
        host,
        &[("isWindows", deps.get(c"isWindows")?), ("seed", commands)],
    )?;
    for (key, from) in [
        (c"environment", c"commandEnvironment"),
        (c"resolve", c"resolveCliCommands"),
    ] {
        if deps.get(from)?.truthy()? {
            options.set(key, deps.get(from)?)?;
        }
    }
    let commands_now = host.get(c"createCommandResolver")?.call_plain(&[options])?;
    let node = or(deps.get(c"routerMcpNode")?, || {
        host.get(c"process")?.get(c"execPath")
    })?;
    let script = or(deps.get(c"routerMcpScript")?, || host.get(c"routerScript"))?;
    let p = fields(
        host,
        &[
            ("host", host),
            ("deps", deps),
            ("commands", commands),
            ("commandsNow", commands_now),
            ("routerMcpNode", node),
            ("routerMcpScript", script),
        ],
    )?;
    for cli in [
        c"claude",
        c"codex",
        c"qoder",
        c"kimi",
        c"codebuddy",
        c"dsh",
        c"agy",
    ] {
        let prefix = text(p, &format!("[multicc] Using {}: ", cli.to_str().unwrap()))?;
        let msg = call(prefix, c"concat", &[commands.get(cli)?])?;
        call(p.global()?.get(c"console")?, c"log", &[msg])?;
    }
    p.set(c"registry", build(p)?)?;
    p.set(c"signature", json_call(p, c"stringify", commands)?)?;
    let registry = methods(p, &[("get", 1, |p, a| call(latest(p)?, c"get", &[a[0]]))])?;
    let getter = function(p, "get providers", 0, 0, |p, _| {
        latest(p)?.get(c"providers")
    })?;
    let desc = fields(
        p,
        &[
            ("get", getter),
            ("enumerable", flag(p, true)?),
            ("configurable", flag(p, true)?),
        ],
    )?;
    call(
        p.global()?.get(c"Object")?,
        c"defineProperty",
        &[registry, text(p, "providers")?, desc],
    )?;
    fields(p, &[("commands", commands), ("registry", registry)])
}
