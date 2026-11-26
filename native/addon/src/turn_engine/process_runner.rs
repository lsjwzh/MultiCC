//! 短进程型 CLI 的环境、启动、写租约及运行器归属。
use super::runner_context::{caught, join, undefined, RunnerContext};
use crate::{
    host_methods::{arg, env as napi_env, raw},
    js_iteration::read,
    process_spawn_args,
    route_response::*,
};
use napi_derive::napi;
mod io;

fn failed(st: RunnerContext<'_>, category: &str, reason: &str) -> Result<()> {
    let s = st.state;
    st.service(
        c"attemptRuntime",
        c"finishAttempt",
        &[
            s.get(c"attempt")?,
            fields(
                s,
                &[
                    ("outcome", text(s, "failed")?),
                    ("errorCategory", text(s, category)?),
                    ("reasonCode", text(s, reason)?),
                ],
            )?,
        ],
    )?;
    Ok(())
}
fn proxy(st: RunnerContext<'_>) -> Result<()> {
    let s = st.state;
    let rec = st.record;
    let binding = s.get(c"binding")?;
    let prepared = s.get(c"prepared")?;
    let env = s.get(c"childEnv")?;
    if rec.get(c"cli")?.is_string("claude")? || rec.get(c"cli")?.is_string("claude-exp")? {
        let opts = fields(
            s,
            &[
                ("providerId", binding.get(c"providerId")?),
                ("sessionId", s.get(c"proxySessionId")?),
                ("subagent", rec.get(c"subagent")?),
                ("port", st.port(c"getPort", &[])?),
                ("officialOAuth", st.port(c"getClaudeOfficialViaProxy", &[])?),
            ],
        )?;
        st.service(c"providers", c"applyClaudeProxyEnv", &[env, opts])?;
    }
    if rec.get(c"cli")?.is_string("codex")? || rec.get(c"cli")?.is_string("codex-exp")? {
        let opts = fields(
            s,
            &[
                ("providerId", binding.get(c"providerId")?),
                ("subagent", rec.get(c"subagent")?),
            ],
        )?;
        let required = st.service(c"providers", c"codexProxyConfigRequired", &[opts])?;
        let opts = fields(
            s,
            &[
                ("providerId", binding.get(c"providerId")?),
                ("sessionId", s.get(c"proxySessionId")?),
                ("subagent", rec.get(c"subagent")?),
                ("port", st.port(c"getPort", &[])?),
                (
                    "inheritModel",
                    prepared
                        .get(c"invocationEnvelope")?
                        .optional(c"spawnOpts")?
                        .optional(c"effectiveModel")?,
                ),
                ("logicalSessionId", st.session),
                ("nativeSessionId", rec.get(c"cliSessionId")?),
                (
                    "allowMissingNativeSession",
                    flag(
                        s,
                        prepared
                            .get(c"invocationEnvelope")?
                            .get(c"historyHandle")?
                            .get(c"isFirstTurn")?
                            .is_true()?,
                    )?,
                ),
            ],
        )?;
        let applied = st.service(c"providers", c"applyCodexProxyConfig", &[env, opts])?;
        st.service(
            c"providers",
            c"assertCodexProxyConfigApplied",
            &[fields(s, &[("required", required), ("applied", applied)])?],
        )?;
    }
    Ok(())
}
fn spawn_args<'a>(st: RunnerContext<'a>, settings: Option<L<'a>>) -> Result<L<'a>> {
    let custom = st.ports.get(c"processSpawnArgs")?;
    if !custom.undefined()? {
        return match settings {
            Some(file) => custom.call_plain(&[st.invocation, file]),
            None => custom.call_plain(&[st.invocation]),
        };
    }
    let settings = settings.unwrap_or(undefined(st.state)?);
    Ok(raw(
        st.state,
        process_spawn_args::process_spawn_args(
            napi_env(st.state),
            arg(st.invocation)?,
            arg(settings)?,
        )?,
    ))
}
fn invocation<'a>(st: RunnerContext<'a>) -> Result<(L<'a>, L<'a>)> {
    let s = st.state;
    let binding = s.get(c"binding")?;
    let prepared = s.get(c"prepared")?;
    let custom = st.ports.get(c"resolveCliRelayTarget")?;
    let providers = st.ports.get(c"providers")?;
    let cli = st.record.get(c"cli")?;
    let id = binding.optional(c"providerId")?;
    let relay = if custom.undefined()? {
        raw(
            s,
            process_spawn_args::resolve_cli_relay_target(
                napi_env(s),
                arg(providers)?,
                arg(cli)?,
                arg(id)?,
            )?,
        )
    } else {
        custom.call_plain(&[providers, cli, id])?
    };
    let mut args = if relay.truthy()? {
        s.from_value(&V::Array(vec![]))?
    } else {
        spawn_args(st, None)?
    };
    let env = caught(
        s,
        || {
            let built = st.service(
                c"providerRouterRuntime",
                c"buildChildEnv",
                &[
                    st.ports.get(c"env")?,
                    st.record,
                    fields(
                        s,
                        &[
                            ("TERM", text(s, "dumb")?),
                            ("NO_COLOR", text(s, "1")?),
                            ("MULTICC_SESSION_ID", st.session),
                            (
                                "MULTICC_DIR_ID",
                                fallback(st.record.get(c"dirId")?, "".into())?,
                            ),
                            ("MULTICC_BASE_URL", st.base_url()?),
                        ],
                    )?,
                    s.get(c"routeOverrides")?,
                ],
            )?;
            read(built, c"env")
        },
        |e| {
            failed(st, "spawn_env", "child_env_failed")?;
            Err(e.throw_error())
        },
    )?;
    s.set(c"childEnv", env)?;
    if !relay.truthy()? {
        caught(
            s,
            || proxy(st),
            |e| {
                st.service(c"providers", c"releaseCodexProxyConfig", &[env])?;
                failed(st, "proxy_config", "proxy_config_failed")?;
                Err(e.throw_error())
            },
        )?;
        if st.record.get(c"cli")?.is_string("claude")?
            || st.record.get(c"cli")?.is_string("claude-exp")?
        {
            let envelope = prepared.get(c"invocationEnvelope")?;
            let spawn = if envelope.truthy()? {
                prepared.get(c"invocationEnvelope")?.get(c"spawnOpts")?
            } else {
                envelope
            };
            let settings = st.port(
                c"claudeSettingsExtra",
                &[st.invocation, spawn, binding, st.record.get(c"cli")?],
            )?;
            let file = st.service(
                c"providers",
                c"settingsOverrideFor",
                &[st.session, env, settings],
            )?;
            if file.truthy()? {
                args = spawn_args(st, Some(file))?;
            }
        }
    }
    let mut cmd = st.invocation.get(c"cmd")?;
    if relay.truthy()? {
        let custom = st.ports.get(c"applyCliRelaySpawn")?;
        let options = fields(
            s,
            &[
                ("target", relay),
                ("childEnv", env),
                ("cwd", st.cs.get(c"cwd")?),
                ("persisted", st.record),
                ("prepared", prepared),
                ("gatewayBin", st.port(c"gatewayPath", &[])?),
                (
                    "rememberActiveCliState",
                    st.ports.get(c"rememberActiveCliState")?,
                ),
                (
                    "savePersistedSessionsBestEffort",
                    st.ports.get(c"savePersistedSessionsBestEffort")?,
                ),
            ],
        )?;
        let target = if custom.undefined()? {
            raw(
                s,
                process_spawn_args::apply_prepared_cli_relay(
                    napi_env(s),
                    arg(options)?,
                    arg(st.ports.get(c"assignHostProperty")?)?,
                )?,
            )
        } else {
            custom.call_plain(&[options])?
        };
        cmd = read(target, c"spawnCmd")?;
        args = read(target, c"finalSpawnArgs")?;
    } else {
        let remote = st.record.get(c"cli")?.is_string("agy")?
            && env.get(c"MULTICC_AGY_REMOTE_ACCOUNT_JSON")?.truthy()?;
        let egress = !remote
            && st.record.get(c"cli")?.is_string("agy")?
            && env.get(c"MULTICC_AGY_EGRESS_JSON")?.truthy()?;
        if remote || egress {
            cmd = st.port(c"gatewayPath", &[])?;
            let pref = if remote {
                vec![
                    text(s, "agy-remote-bridge")?,
                    text(s, "--local-cwd")?,
                    st.cs.get(c"cwd")?,
                    text(s, "--")?,
                ]
            } else {
                // 与已有 gateway 包装命令的 argv 保持一致。
                vec![
                    text(s, "agy-egress-exec")?,
                    text(s, "--bin")?,
                    cmd,
                    text(s, "--")?,
                ]
            };
            let out = s.from_value(&V::Array(vec![]))?;
            let mut i = 0;
            for v in pref {
                out.define_key(text(s, &i.to_string())?, v)?;
                i += 1;
            }
            args.for_each(|v| {
                out.define_key(text(s, &i.to_string())?, v)?;
                i += 1;
                Ok(())
            })?;
            args = out;
        }
    }
    Ok((cmd, args))
}
fn writer_method<'a>(st: RunnerContext<'a>, key: &std::ffi::CStr, args: &[L<'a>]) -> Result<L<'a>> {
    let admission = st.state.get(c"writerAdmission")?;
    let cb = admission.optional(key)?;
    if cb.nullish()? {
        undefined(st.state)
    } else {
        cb.call(admission, args)
    }
}
fn fence(st: RunnerContext<'_>) -> Result<()> {
    let s = st.state;
    let proc = s.get(c"proc")?;
    if !s.get(c"writerLease")?.truthy()?
        || proc.optional(c"once")?.kind()? != sys::ValueType::napi_function
    {
        return Ok(());
    }
    let closed = st.callback("", 0, |st, _| {
        let end = st.callback("finishWriterLease", 0, |st, _| {
            writer_method(
                st,
                c"finishProcessWriter",
                &[st.session, st.state.get(c"writerLease")?],
            )
        })?;
        call(
            st.port(c"getWriterGroup", &[])?,
            c"whenGroupEmpty",
            &[st.state.get(c"proc")?.get(c"pid")?, end],
        )
    })?;
    call(proc, c"once", &[text(s, "close")?, closed])?;
    if proc.get(c"pid")?.truthy()? {
        let annotate = st.callback("", 0, |st, _| {
            writer_method(
                st,
                c"annotateWriterPid",
                &[
                    st.session,
                    st.state.get(c"writerLease")?,
                    st.state.get(c"proc")?.get(c"pid")?,
                ],
            )
        })?;
        s.global()?.get(c"setImmediate")?.call_plain(&[annotate])?;
    }
    Ok(())
}
fn spawn<'a>(st: RunnerContext<'a>, cmd: L<'a>, args: L<'a>, params: L<'a>) -> Result<L<'a>> {
    let s = st.state;
    let admission = s.get(c"writerAdmission")?;
    if !admission.nullish()? {
        call(
            admission,
            c"starting",
            &[
                st.session,
                params.get(c"opts")?,
                s.get(c"attempt")?.get(c"routeAttemptId")?,
            ],
        )?;
    }
    s.set(
        c"writerLease",
        writer_method(st, c"acquireProcessWriter", &[st.session])?,
    )?;
    let port = st.callback("spawn", 3, |st, a| {
        let child = st.port(c"spawn", a)?;
        st.state.set(c"proc", child)?;
        Ok(child)
    })?;
    let req = fields(
        s,
        &[
            ("cli", st.record.get(c"cli")?),
            ("spawn", port),
            ("command", cmd),
            ("args", args),
            ("cwd", st.cs.get(c"cwd")?),
            ("env", s.get(c"childEnv")?),
            ("sessionId", st.session),
            ("turnId", st.turn.get(c"turnId")?),
            ("originDispatchId", params.get(c"originDispatchId")?),
            (
                "requestId",
                fallback(st.turn.get(c"requestId")?, "".into())?,
            ),
            ("userText", st.turn.get(c"userText")?),
            ("taskId", st.turn.get(c"task")?.optional(c"id")?),
            ("taskStart", st.turn.get(c"task")?.optional(c"start")?),
            ("taskSource", st.turn.get(c"task")?.optional(c"source")?),
            ("baseUrl", st.base_url()?),
        ],
    )?;
    st.service(c"routerToolHost", c"spawnProcess", &[req])
}
#[napi]
pub fn chat_spawn_process(
    env: Env,
    ports: Unknown<'_>,
    params: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, params);
    let ports = L::new(&env, ports);
    let prepared = p.get(c"prepared")?;
    let state = fields(
        p,
        &[
            ("ports", ports),
            ("session", p.get(c"sessionName")?),
            ("cs", p.get(c"cs")?),
            ("record", p.get(c"persisted")?),
            ("provider", p.get(c"provider")?),
            ("turn", p.get(c"turn")?),
            ("prepared", prepared),
            ("invocation", read(prepared, c"invocation")?),
            ("attempt", read(prepared, c"attempt")?),
            ("routeOverrides", read(prepared, c"routeOverrides")?),
            ("binding", read(prepared, c"binding")?),
            ("proxySessionId", read(prepared, c"proxySessionId")?),
        ],
    )?;
    let st = RunnerContext::load(state)?;
    let s = state;
    let (cmd, args) = invocation(st)?;
    let completion = st.port(c"createAdapterCompletion", &[st.provider])?;
    let random = st.service(c"crypto", c"randomBytes", &[num(s, 8.)?])?;
    let runner = st.port(
        c"createRunnerOwnership",
        &[
            st.turn,
            fields(
                s,
                &[
                    ("completion", completion),
                    (
                        "runnerId",
                        join(
                            s,
                            &[
                                text(s, "proc_")?,
                                call(random, c"toString", &[text(s, "hex")?])?,
                            ],
                        )?,
                    ),
                    ("kind", text(s, "process")?),
                    ("providerAttempt", s.get(c"attempt")?),
                    ("routeProof", prepared.get(c"routeProof")?),
                    ("usageAttribution", prepared.get(c"usageAttribution")?),
                ],
            )?,
        ],
    )?;
    runner.assign(
        c"freshNativeSession",
        flag(
            s,
            prepared
                .get(c"invocationEnvelope")?
                .get(c"historyHandle")?
                .get(c"isFirstTurn")?
                .is_true()?,
        )?,
    )?;
    s.set(c"runner", runner)?;
    s.set(c"writerAdmission", st.workspace()?)?;
    let proc = caught(
        s,
        || spawn(st, cmd, args, p),
        |e| {
            fence(st)?;
            st.service(
                c"providers",
                c"releaseCodexProxyConfig",
                &[s.get(c"childEnv")?],
            )?;
            st.port(
                c"finishProviderAttempt",
                &[
                    runner,
                    text(s, "failed")?,
                    fields(
                        s,
                        &[
                            ("errorCategory", text(s, "spawn_failed")?),
                            ("reasonCode", text(s, "process_spawn_failed")?),
                        ],
                    )?,
                ],
            )?;
            Err(e.throw_error())
        },
    )?;
    s.set(c"proc", proc)?;
    fence(st)?;
    runner.assign(
        c"apiRetryAttempt",
        num(s, p.get(c"apiRetryAttempt")?.explicit_number()?.max(0.))?,
    )?;
    st.cs.assign(c"_activeTurn", st.turn)?;
    st.cs.assign(c"_activeRunner", runner)?;
    st.cs.assign(c"claudeProc", proc)?;
    let ws = st.workspace()?;
    if !ws.nullish()? {
        call(ws, c"spawned", &[st.session, proc])?;
    }
    let ts = call(s.global()?.get(c"Date")?, c"now", &[])?;
    s.set(c"spawnTs", ts)?;
    st.console(&[
        text(s, "[multicc/chat] [")?,
        st.session,
        text(s, "] ")?,
        st.cs.get(c"cli")?,
        text(s, " spawned pid=")?,
        proc.get(c"pid")?,
        text(s, " turn=")?,
        st.cs.get(c"chatTurnCount")?,
        text(s, " isRetry=")?,
        flag(s, p.get(c"isRetry")?.truthy()?)?,
        text(s, " clients=")?,
        st.cs.get(c"clients")?.get(c"size")?,
    ])?;
    st.service(
        c"turnTiming",
        c"markSpawned",
        &[st.session, st.turn.get(c"turnId")?, ts],
    )?;
    st.service(
        c"turnTiming",
        c"markSent",
        &[st.session, st.turn.get(c"turnId")?, ts],
    )?;
    if proc.get(c"pid")?.truthy()? {
        st.service(c"managedContext", c"contextSent", &[st.turn])?;
    }
    io::listen(st)?;
    Ok(s.raw())
}
