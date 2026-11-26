//! 组装消息及物理调用尝试，按持久化证明、路由证明和工作区许可顺序交付运行器。
use super::services::{and_get, error_value, join, port};
use crate::{
    host_methods::method,
    js_iteration::{read, IteratorRecord},
    route_response::*,
};

fn arg(value: L<'_>) -> Unknown<'_> {
    unsafe { Unknown::from_raw_unchecked(value.env(), value.raw()) }
}
type Handler = for<'a> fn(L<'a>, &mut [L<'a>]) -> Result<L<'a>>;
fn callback<'a>(
    owner: L<'a>,
    name: &'static str,
    length: usize,
    count: usize,
    run: Handler,
) -> Result<L<'a>> {
    let env = Env::from_raw(owner.env());
    let value = method(&env, owner, name, length, count, run)?;
    Ok(L::from_raw(owner.env(), value.raw()))
}
fn failed<'a>(c: L<'a>, reason: L<'a>) -> Result<()> {
    c.get(c"preparation")?.assign(c"failure", reason)
}
fn compose<'a>(p: L<'a>, c: L<'a>, first: L<'a>) -> Result<L<'a>> {
    let host = p.get(c"taskContextHost")?;
    let memory = p.get(c"folderMemory")?;
    let s = c.get(c"sessionName")?;
    let persisted = c.get(c"persisted")?;
    let opts = c.get(c"opts")?;
    let managed = call(
        p.get(c"managedContext")?,
        c"prepareManagedContext",
        &[fields(
            p,
            &[
                ("host", host),
                ("memory", memory),
                ("sessionName", s),
                ("persisted", persisted),
                ("turn", c.get(c"turn")?),
                ("opts", opts),
                ("text", c.get(c"text")?),
                ("isFirstTurn", first),
            ],
        )?],
    )?;
    c.set(c"managed", managed)?;
    let mut seed = managed.optional(c"seed")?;
    if seed.nullish()? {
        let fetch = host.optional(c"taskShellContextSeed")?;
        if !fetch.nullish()? {
            seed = fetch.call(host, &[s, read(opts, c"taskContextSeed")?, first])?;
        }
        if seed.nullish()? {
            seed = read(opts, c"taskContextSeed")?;
        }
    }
    let resident = port(
        p,
        c"isResidentSession",
        &[read(c.get(c"cs")?, c"cli")?, persisted],
    )?
    .truthy()?;
    let options = fields(
        c,
        &[
            ("isFirstTurn", first),
            ("taskContextSeed", seed),
            (
                "mode",
                text(p, if resident { "streaming" } else { "per-turn" })?,
            ),
            ("lang", read(opts, c"lang")?),
            ("voice", read(opts, c"voice")?),
        ],
    )?;
    let role = managed.optional(c"rolePrompt")?;
    let deps = fields(
        p,
        &[
            (
                "resolveRolePrompt",
                if role.truthy()? {
                    role
                } else {
                    read(memory, c"resolveRolePrompt")?
                },
            ),
            ("multiccImgHint", p.get(c"MULTICC_IMG_HINT")?),
            (
                "buildSubagentProviderHint",
                p.get(c"buildSubagentProviderHint")?,
            ),
        ],
    )?;
    deps.set(
        c"buildCliHandoffPrompt",
        callback(c, "buildCliHandoffPrompt", 1, 1, |c, a| {
            if c.get(c"managed")?.truthy()? {
                return text(c, "");
            }
            port(
                c.get(c"ports")?,
                c"renderHandoffPrompt",
                &[and_get(a[0], c"pendingCliHandoff")?],
            )
        })?,
    )?;
    for key in [
        c"buildGatewayPrompt",
        c"buildDispatchContextPrompt",
        c"buildPlanPrompt",
        c"pendingNotesFor",
        c"saveNotes",
        c"appendEvent",
        c"workspaceBroadcast",
        c"chatBroadcast",
        c"normalizeEffort",
        c"cliEffortLevel",
    ] {
        deps.set(key, p.get(key)?)?;
    }
    deps.set(
        c"takeBackgroundStopNote",
        callback(p, "takeBackgroundStopNote", 1, 1, |p, a| {
            let rt = port(p, c"getBackgroundTaskRuntime", &[])?;
            let f = rt.optional(c"takeStoppedNote")?;
            if f.nullish()? {
                return text(p, "");
            }
            fallback(f.call(rt, a)?, "".into())
        })?,
    )?;
    let input = fields(
        c,
        &[
            ("text", c.get(c"text")?),
            ("persisted", persisted),
            ("sessionName", s),
            ("opts", options),
            ("deps", deps),
        ],
    )?;
    let raw = crate::message_composer::message_compose(
        Env::from_raw(p.env()),
        arg(input),
        arg(p.get(c"process")?.get(c"env")?),
        arg(p.global()?.get(c"console")?),
    )?;
    Ok(L::from_raw(p.env(), raw))
}
pub(super) fn begin<'a>(p: L<'a>, c: L<'a>) -> Result<L<'a>> {
    c.set(c"ports", p)?;
    let s = c.get(c"sessionName")?;
    let cs = c.get(c"cs")?;
    let provider = port(p, c"providerFor", &[cs])?;
    c.set(c"provider", provider)?;
    let first = read(read(c.get(c"turnRequest")?, c"execution")?, c"isFirstTurn")?;
    c.set(c"first", first)?;
    let envelope = match compose(p, c, first) {
        Ok(value) => value,
        Err(err) => {
            let e = error_value(p, err)?;
            let message = || {
                if e.truthy()? && read(e, c"message")?.truthy()? {
                    read(e, c"message")
                } else {
                    Ok(e)
                }
            };
            call(
                p.global()?.get(c"console")?,
                c"error",
                &[join(
                    p,
                    &[
                        text(p, "[multicc/chat] [")?,
                        s,
                        text(p, "] composeMessage failed, aborting turn: ")?,
                        message()?,
                    ],
                )?],
            )?;
            failed(c, text(p, "message-compose-failed")?)?;
            p.catch(|| {
                port(
                    p,
                    c"chatBroadcast",
                    &[
                        s,
                        fields(
                            p,
                            &[
                                ("type", text(p, "error")?),
                                ("error", join(p, &[text(p, "消息组装失败：")?, message()?])?),
                            ],
                        )?,
                    ],
                )
            })?;
            port(
                p,
                c"setSessionStatus",
                &[
                    s,
                    fields(
                        p,
                        &[("status", text(p, "idle")?), ("currentFile", null(p)?)],
                    )?,
                ],
            )?;
            cs.assign(c"isStreaming", flag(p, false)?)?;
            return null(c);
        }
    };
    c.set(c"envelope", envelope)?;
    let prompt =
        crate::message_composer::message_render_prompt(Env::from_raw(p.env()), arg(envelope))?;
    c.set(c"promptText", L::from_raw(p.env(), prompt))?;
    let factory = port(
        p,
        c"createProviderInvocationFactory",
        &[fields(
            p,
            &[
                ("providerRouterRuntime", p.get(c"providerRouterRuntime")?),
                ("providerAttemptRuntime", p.get(c"attemptRuntime")?),
                ("effectiveSessionModel", p.get(c"effectiveSessionModel")?),
            ],
        )?],
    )?;
    c.set(c"factory", factory)?;
    let asynchronous = p
        .get(c"providerLimitCache")?
        .optional(c"isAsync")?
        .truthy()?;
    let owner = p.get(c"autoProviderRuntime")?;
    let f = read(
        owner,
        if asynchronous {
            c"beginTurnAsync"
        } else {
            c"beginTurn"
        },
    )?;
    let result = f.call(
        owner,
        &[fields(
            c,
            &[
                ("session", c.get(c"persisted")?),
                ("turnId", read(c.get(c"turn")?, c"turnId")?),
                ("promptText", c.get(c"text")?),
            ],
        )?],
    )?;
    fields(
        c,
        &[("asynchronous", flag(c, asynchronous)?), ("value", result)],
    )
}
fn prepare<'a>(c: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = if a[0].undefined()? {
        fields(c, &[])?
    } else {
        a[0]
    };
    let factory = c.get(c"factory")?;
    let f = read(factory, c"prepare")?;
    let envelope = c.get(c"envelope")?;
    let n = c.get(c"attemptNo")?.number()? + 1.0;
    c.set(c"attemptNo", num(c, n)?)?;
    let input = fields(
        c,
        &[
            ("request", c.get(c"turnRequest")?),
            ("turn", c.get(c"turn")?),
            ("session", c.get(c"persisted")?),
            ("provider", c.get(c"provider")?),
            ("envelope", envelope),
            ("attemptNo", num(c, n)?),
        ],
    )?;
    let managed = c.get(c"managed")?;
    input.spread_from(if managed.truthy()? {
        call(managed, c"attempt", &[envelope, opts])?
    } else {
        opts
    })?;
    f.call(factory, &[input])
}
fn reject(c: L<'_>, result: L<'_>, code: &str, msg: &str) -> Result<()> {
    let reason = fallback(read(result, c"code")?, code.into())?;
    failed(c, reason)?;
    let message = join(c, &[text(c, msg)?, reason])?;
    Err(c
        .global()?
        .get(c"Error")?
        .construct(&[message])?
        .throw_error())
}
fn spawn_log<'a>(c: L<'a>, resolution: L<'a>, invocation: L<'a>, relay: L<'a>) -> Result<()> {
    let args = c.from_value(&V::Array(vec![]))?;
    let source = if read(invocation, c"args")?.is_array()? {
        read(invocation, c"args")?
    } else {
        c.from_value(&V::Array(vec![]))?
    };
    let mut index = 0;
    IteratorRecord::open(source, c"args is not iterable", || {
        c.global()?.get(c"Symbol")?.get(c"iterator")
    })?
    .for_each(|item| {
        args.define_key(text(c, &index.to_string())?, item)?;
        index += 1;
        Ok(())
    })?;
    args.define_key(text(c, &index.to_string())?, read(invocation, c"payload")?)?;
    let cs = c.get(c"cs")?;
    let first = join(
        c,
        &[
            text(c, "[multicc/chat] Spawning ")?,
            read(cs, c"cli")?,
            text(c, " (turn ")?,
            read(cs, c"chatTurnCount")?,
            text(c, ", first=")?,
            c.get(c"first")?,
        ],
    )?;
    let provider = if read(resolution, c"providerName")?.truthy()? {
        join(
            c,
            &[text(c, ", provider=")?, read(resolution, c"providerName")?],
        )?
    } else {
        text(c, "")?
    };
    let cmd = join(
        c,
        &[
            first,
            provider,
            text(
                c,
                if relay.truthy()? {
                    ", mode=cli-relay): "
                } else {
                    "): "
                },
            )?,
            read(invocation, c"cmd")?,
            text(c, " ")?,
        ],
    )?;
    let line = call(
        call(args, c"join", &[text(c, " ")?])?,
        c"slice",
        &[num(c, 0.0)?, num(c, 200.0)?],
    )?;
    call(
        c.global()?.get(c"console")?,
        c"log",
        &[join(c, &[cmd, line, text(c, "...")?])?],
    )?;
    Ok(())
}
pub(super) fn route<'a>(p: L<'a>, c: L<'a>, auto: L<'a>) -> Result<L<'a>> {
    let s = c.get(c"sessionName")?;
    let cs = c.get(c"cs")?;
    let persisted = c.get(c"persisted")?;
    let turn = c.get(c"turn")?;
    let id = c.get(c"turnId")?;
    if !call(p.get(c"persistedSessions")?, c"get", &[s])?.equals(persisted)?
        || !call(p.get(c"chatSessions")?, c"get", &[s])?.equals(cs)?
    {
        return Err(p
            .global()?
            .get(c"Error")?
            .construct(&[text(p, "session changed while resolving provider quota")?])?
            .throw_error());
    }
    c.set(c"attemptNo", num(c, 0.0)?)?;
    let prepare_invocation = callback(c, "prepareInvocation", 0, 1, prepare)?;
    let opts = fields(p, &[("reasonCode", text(p, "route_resolved")?)])?;
    opts.spread_from(call(auto, c"initial", &[])?)?;
    let invocation = prepare_invocation.call_plain(&[opts])?;
    c.get(c"preparation")?
        .assign(c"attempt", read(invocation, c"attempt")?)?;
    let resolution = read(invocation, c"resolution")?;
    let _ = read(invocation, c"invocationEnvelope")?;
    let command = read(invocation, c"invocation")?;
    let proof = read(invocation, c"routeProof")?;
    port(
        p,
        c"bindTurnUsageAttribution",
        &[turn, read(invocation, c"baseUsageAttribution")?],
    )?;
    let runtime = p.get(c"chatTurnPreparationRuntime")?;
    let marked = call(
        runtime,
        c"markProviderRouteResolved",
        &[
            s,
            id,
            fields(c, &[("resolved", flag(c, true)?), ("proof", proof)])?,
        ],
    )?;
    if !read(marked, c"ok")?.truthy()? {
        reject(
            c,
            marked,
            "provider-route-proof-rejected",
            "provider route proof rejected: ",
        )?;
    }
    let claim = call(runtime, c"claimProof", &[s, id])?;
    let guard = port(
        p,
        c"evaluateSpawnGuard",
        &[
            c.get(c"turnRequest")?,
            fields(
                c,
                &[
                    ("message", c.get(c"durableMessageProof")?),
                    ("route", proof),
                    ("runtime", claim),
                ],
            )?,
        ],
    )?;
    if !read(guard, c"ok")?.truthy()? {
        failed(
            c,
            fallback(read(guard, c"code")?, "spawn-proof-missing".into())?,
        )?;
        let mut absent = read(guard, c"missing")?;
        if !absent.truthy()? {
            absent = p.from_value(&V::Array(vec![]))?;
        }
        let message = join(
            c,
            &[
                text(c, "turn spawn refused: ")?,
                call(absent, c"join", &[text(c, ", ")?])?,
            ],
        )?;
        return Err(c
            .global()?
            .get(c"Error")?
            .construct(&[message])?
            .throw_error());
    }
    let getter = p.get(c"getWorkspaceAdmission")?;
    if !getter.nullish()? {
        let host = getter.call_plain(&[])?;
        if !host.nullish()? {
            call(
                host,
                c"bindTurn",
                &[
                    s,
                    c.get(c"opts")?,
                    id,
                    read(turn, c"task")?.optional(c"id")?,
                ],
            )?;
        }
    }
    let started = call(runtime, c"start", &[s, id])?;
    if !read(started, c"ok")?.truthy()? {
        reject(
            c,
            started,
            "runtime-start-rejected",
            "turn runtime start rejected: ",
        )?;
    }
    let raw = crate::process_spawn_args::resolve_cli_relay_target(
        Env::from_raw(p.env()),
        arg(p.get(c"providers")?),
        arg(read(cs, c"cli")?),
        arg(read(invocation, c"binding")?.optional(c"providerId")?),
    )?;
    let relay = L::from_raw(p.env(), raw);
    let provider = c.get(c"provider")?;
    if port(p, c"isResidentSession", &[read(cs, c"cli")?, persisted])?.truthy()?
        && !relay.truthy()?
    {
        let accepted = port(
            p,
            c"runChatTurnStreaming",
            &[
                s,
                cs,
                persisted,
                invocation,
                provider,
                turn,
                prepare_invocation,
                auto,
                num(c, 0.0)?,
                c.get(c"opts")?,
            ],
        )?;
        if !accepted.truthy()? {
            failed(c, text(c, "stream-runner-rejected")?)?;
            return flag(c, false);
        }
        return super::preparation::handed_off(
            p,
            &mut [c.get(c"preparation")?, text(c, "claude-stream")?],
        );
    }
    spawn_log(c, resolution, command, relay)?;
    fields(
        c,
        &[
            ("provider", provider),
            ("initialInvocation", invocation),
            ("prepareInvocation", prepare_invocation),
            ("promptText", c.get(c"promptText")?),
        ],
    )
}
