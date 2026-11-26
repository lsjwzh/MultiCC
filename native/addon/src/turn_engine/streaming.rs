//! 常驻进程只持有 SDK 配置所需的状态；每次发送独立捕获回合、运行器和序号。
use crate::{js_iteration::read, route_response::*};
use napi_derive::napi;
mod backend;
mod delivery;

use super::runner_context::{caught, join, undefined, RunnerContext as Stream};
impl<'a> Stream<'a> {
    fn set_session_id(&self, id: L<'a>, reason: &str) -> Result<()> {
        self.record.set_key(self.state.get(c"nativeKey")?, id)?;
        self.port(c"rememberActiveCliState", &[self.record])?;
        self.port(
            c"savePersistedSessionsBestEffort",
            &[text(self.state, reason)?],
        )?;
        Ok(())
    }
}
#[napi]
pub fn chat_run_streaming(env: Env, ports: Unknown<'_>, params: Unknown<'_>) -> Result<bool> {
    let p = L::new(&env, params);
    let ports = L::new(&env, ports);
    let session = p.get(c"sessionName")?;
    let turn = p.get(c"turn")?;
    let prepared = p.get(c"prepared")?;
    let getter = ports.get(c"getWorkspaceAdmission")?;
    if !getter.nullish()? {
        let ws = getter.call_plain(&[])?;
        if !ws.nullish()? {
            let start = read(ws, c"starting")?;
            let opts = p.get(c"workspaceOpts")?;
            let opts = if opts.truthy()? {
                opts
            } else {
                let ws = getter.call_plain(&[])?;
                if ws.nullish()? {
                    undefined(p)?
                } else {
                    call(ws, c"optionsForTurn", &[session, turn])?
                }
            };
            start.call(
                ws,
                &[
                    session,
                    opts,
                    prepared.get(c"attempt")?.get(c"routeAttemptId")?,
                ],
            )?;
        }
    }
    let invocation = read(prepared, c"invocation")?;
    let attempt = read(prepared, c"attempt")?;
    let overrides = read(prepared, c"routeOverrides")?;
    let binding = read(prepared, c"binding")?;
    let proxy = read(prepared, c"proxySessionId")?;
    let state = fields(
        p,
        &[
            ("ports", ports),
            ("session", session),
            ("cs", p.get(c"cs")?),
            ("record", p.get(c"persisted")?),
            ("provider", p.get(c"provider")?),
            ("turn", turn),
            ("invocation", invocation),
        ],
    )?;
    let stream = Stream::load(state)?;
    let session_env = fields(
        state,
        &[
            ("TERM", text(state, "dumb")?),
            ("NO_COLOR", text(state, "1")?),
            ("MULTICC_SESSION_ID", session),
            (
                "MULTICC_DIR_ID",
                fallback(stream.record.get(c"dirId")?, "".into())?,
            ),
            ("MULTICC_BASE_URL", stream.base_url()?),
        ],
    )?;
    let child_env = stream
        .service(
            c"providerRouterRuntime",
            c"buildChildEnv",
            &[ports.get(c"env")?, stream.record, session_env, overrides],
        )?
        .get(c"env")?;
    state.set(c"childEnv", child_env)?;
    let opts = fields(
        state,
        &[
            ("cli", stream.record.get(c"cli")?),
            ("providerId", binding.get(c"providerId")?),
            ("sessionId", proxy),
            ("subagent", stream.record.get(c"subagent")?),
            ("port", stream.port(c"getPort", &[])?),
            ("logicalSessionId", session),
            (
                "inheritModel",
                prepared
                    .get(c"invocationEnvelope")?
                    .optional(c"spawnOpts")?
                    .optional(c"effectiveModel")?,
            ),
            ("nativeSessionId", stream.record.get(c"cliSessionId")?),
            (
                "allowMissingNativeSession",
                flag(state, !stream.record.get(c"cliSessionId")?.truthy()?)?,
            ),
            (
                "officialOAuth",
                stream.port(c"getClaudeOfficialViaProxy", &[])?,
            ),
        ],
    )?;
    stream.service(c"providers", c"prepareResidentChildEnv", &[child_env, opts])?;
    stream.service(
        c"secretsVault",
        c"applyEnvOverlay",
        &[
            child_env,
            fields(
                state,
                &[
                    ("source", text(state, "resident_turn")?),
                    ("sessionId", session),
                    ("turnId", turn.get(c"turnId")?),
                    ("taskId", stream.record.get(c"taskBoundTaskId")?),
                ],
            )?,
        ],
    )?;
    let envelope = prepared.get(c"invocationEnvelope")?;
    let spawn_opts = if envelope.truthy()? {
        prepared.get(c"invocationEnvelope")?.get(c"spawnOpts")?
    } else {
        envelope
    };
    let settings = stream.port(
        c"claudeSettingsExtra",
        &[invocation, spawn_opts, binding, stream.record.get(c"cli")?],
    )?;
    let file = stream.service(
        c"providers",
        c"settingsOverrideFor",
        &[session, child_env, settings],
    )?;
    let args = invocation.get(c"streamArgs")?;
    let args = if args.truthy()? {
        args
    } else {
        invocation.get(c"args")?
    };
    let args = if file.truthy()? {
        let out = state.from_value(&V::Array(vec![]))?;
        let mut i = 0;
        args.for_each(|v| {
            out.define_key(text(state, &i.to_string())?, v)?;
            i += 1;
            Ok(())
        })?;
        out.define_key(text(state, &i.to_string())?, text(state, "--settings")?)?;
        out.define_key(text(state, &(i + 1).to_string())?, file)?;
        out
    } else {
        args
    };
    let key = invocation.get(c"nativeKey")?;
    let key = if key.truthy()? {
        key
    } else if invocation.get(c"sdkOptions")?.truthy()? {
        text(state, "cliSessionId")?
    } else {
        text(state, "_streamSessionId")?
    };
    state.set(c"nativeKey", key)?;
    let has_id = stream.record.get_key(key)?.truthy()?;
    let resume = has_id
        && (!invocation.get(c"sdkOptions")?.truthy()?
            || !prepared
                .get(c"invocationEnvelope")?
                .get(c"historyHandle")?
                .get(c"isFirstTurn")?
                .truthy()?);
    if !invocation.get(c"clientAllocatesNativeId")?.is_false()? && !has_id {
        let id = stream.service(c"crypto", c"randomUUID", &[])?;
        stream.set_session_id(id, "runtime.streaming-session-id-allocate")?;
    }
    backend::ensure(stream, args, file, resume)?;
    // 常驻配置的闭包不持有本次发送的运行器，避免此前轮次的状态留在池中。
    let sending = crate::js_live::spread(state)?;
    delivery::send(Stream::load(sending)?, p, prepared, attempt)?;
    Ok(true)
}
