//! 兼容宿主的聊天连接。在同一个 V8 调用内处理可借用的会话与消息，
//! 重放顺序、消息授权和控制命令使用与网关共用的 Rust 规则。
use crate::{
    chat_ws_control::seed_live, host_methods::method, js_iteration::read,
    message_composer::normalize_voice, route_response::*,
};
use multicc_core::{
    chat_connect_replay::{self, Facts, Step},
    chat_ws_control::{self, Action, Command},
};
use napi_derive::napi;
use std::ffi::CStr;

fn plain<'a>(ports: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    ports.get(key)?.call_plain(args)
}

fn optional_call<'a>(obj: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    let function = obj.optional(key)?;
    if function.nullish()? {
        obj.from_value(&V::Undefined)
    } else {
        function.call(obj, args)
    }
}

#[napi]
pub fn chat_restore_live_session(
    env: Env,
    ports: Unknown<'_>,
    session: Unknown<'_>,
    cli: Unknown<'_>,
    cwd: Unknown<'_>,
    history: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let session = L::new(&env, session);
    let history = L::new(&env, history);
    let assistant = method(&env, p, "", 1, 1, |p, a| {
        flag(p, read(a[0], c"role")?.is_string("assistant")?)
    })?;
    let count = call(history, c"filter", &[assistant])?
        .get(c"length")?
        .number()? as usize;
    let clients = call(p.get(c"replay")?, c"clientsOf", &[session])?;
    let task = call(p.get(c"taskContextHost")?, c"restore", &[history])?;
    let state = fields(p, &[("clients", clients)])?;
    state.spread_from(seed_live(
        count,
        L::new(&env, cli),
        L::new(&env, cwd),
        task,
    )?)?;
    call(p.get(c"chatSessions")?, c"set", &[session, state])?;
    Ok(state.raw())
}

#[napi]
pub fn chat_apply_connect_replay(
    env: Env,
    ports: Unknown<'_>,
    ws: Unknown<'_>,
    session: Unknown<'_>,
    cs: Unknown<'_>,
    page: Unknown<'_>,
    usage: Unknown<'_>,
) -> Result<()> {
    let p = L::new(&env, ports);
    let ws = L::new(&env, ws);
    let session = L::new(&env, session);
    let page = L::new(&env, page);
    let usage = L::new(&env, usage);
    let messages = page.get(c"messages")?;
    let replay = p.get(c"replay")?;
    let buffered = call(replay, c"size", &[session])?.number()? as usize;
    let length = messages.get(c"length")?.number()? as u32;
    let facts = Facts {
        replay_messages: length as usize,
        last_message_is_assistant: length > 0
            && read(messages.element(length - 1)?, c"role")?.is_string("assistant")?,
        is_streaming: L::new(&env, cs).get(c"isStreaming")?.truthy()?,
        buffered_events: buffered,
        has_token_usage: usage.truthy()?,
        // 到达对应步骤才读取任务、分配其短码。读取失败不影响重放。
        has_task_state_seed: true,
    };
    for step in chat_connect_replay::plan(&facts) {
        match step {
            Step::ChatHistory => {
                let frame = fields(
                    p,
                    &[
                        ("type", text(p, "chat_history")?),
                        ("messages", messages),
                        ("tokenUsage", usage),
                        ("hasMore", page.get(c"hasMore")?),
                    ],
                )?;
                plain(p, c"sendWs", &[ws, frame])?;
            }
            Step::TaskStateSeed => {
                p.catch(|| {
                    let persisted = call(p.get(c"persistedSessions")?, c"get", &[session])?;
                    let task = plain(p, c"getTaskState", &[persisted])?;
                    let seed = plain(p, c"taskStateSeed", &[task])?;
                    if seed.truthy()? {
                        plain(p, c"sendWs", &[ws, seed])?;
                    }
                    Ok(())
                })?;
            }
            Step::ClearBuffer => {
                call(replay, c"clear", &[session])?;
            }
            Step::ReplayBurst { .. } => {
                if ws
                    .get(c"_multiccConnId")?
                    .number_value()?
                    .is_some_and(|n| n.is_finite() && n.fract() == 0.0)
                {
                    call(replay, c"burst", &[ws.get(c"_multiccConnId")?, session])?;
                }
            }
        }
    }
    Ok(())
}

fn message_options<'a>(msg: L<'a>) -> Result<L<'a>> {
    let out = fields(msg, &[])?;
    let unattended = msg.get(c"unattended")?;
    if unattended.truthy()? && unattended.kind()? == sys::ValueType::napi_object {
        out.assign(c"unattended", unattended)?;
    } else if msg.get(c"goal")?.truthy()? {
        out.assign(c"unattended", fields(msg, &[])?)?;
    }
    for (key, trim) in [(c"clientMsgId", false), (c"userInputRequestId", true)] {
        let value = msg.get(key)?;
        if value.kind()? == sys::ValueType::napi_string {
            let cleaned = call(value, c"trim", &[])?;
            if cleaned.truthy()? {
                out.assign(key, if trim { cleaned } else { value })?;
            }
        }
    }
    let lang = msg.get(c"lang")?;
    if lang.is_string("zh")? || lang.is_string("en")? {
        out.assign(c"lang", lang)?;
    }
    let voice = normalize_voice(msg)?;
    if voice.truthy()? {
        out.assign(c"voice", voice)?;
    }
    Ok(out)
}

#[napi]
pub fn chat_handle_socket_message(
    env: Env,
    ports: Unknown<'_>,
    ws: Unknown<'_>,
    session: Unknown<'_>,
    shell: Unknown<'_>,
    persisted: Unknown<'_>,
    cs: Unknown<'_>,
    msg: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let ws = L::new(&env, ws);
    let session = L::new(&env, session);
    let shell = L::new(&env, shell);
    let cs = L::new(&env, cs);
    let msg = L::new(&env, msg);
    let done = p.from_value(&V::Undefined)?;
    let ty = read(msg, c"type")?
        .string()?
        .unwrap_or_default()
        .to_string_lossy();
    let perm = ws
        .get(c"_sharePerm")?
        .string()?
        .unwrap_or_default()
        .to_string_lossy();
    match chat_ws_control::action(&ty, &perm) {
        Action::Pong => {
            p.catch(|| {
                plain(
                    p,
                    c"sendWs",
                    &[ws, fields(p, &[("type", text(p, "pong")?)])?],
                )
            })?;
            return Ok(done.raw());
        }
        Action::Ignore => return Ok(done.raw()),
        Action::Continue => {}
    }
    let ctx = p.get(c"taskContextHost")?;
    let shell_scope = optional_call(ctx, c"requiresTaskShell", &[session])?.truthy()?
        || optional_call(ctx, c"ownsTaskShell", &[session])?.truthy()?;
    let command = chat_ws_control::command(
        &ty,
        &perm,
        shell_scope,
        shell.truthy()?,
        msg.get(c"taskShell")?.is_true()?,
        msg.get(c"text")?.truthy()?,
    );
    let result = match command {
        Command::Ignore => done,
        Command::Typing => {
            plain(p, c"cancelClassify", &[cs])?;
            done
        }
        Command::RouteShellInput => shell::effect(p, ws, session, msg, shell, false)?,
        Command::RequireShellRoute => {
            let escaped = p
                .global()?
                .get(c"encodeURIComponent")?
                .call_plain(&[session])?
                .coerce_string()?;
            let frame = fields(
                p,
                &[
                    ("type", text(p, "error")?),
                    ("code", text(p, "task_shell_route_required")?),
                    ("error", text(p, "请从任务会话入口发送消息或操作任务。")?),
                    (
                        "url",
                        text(
                            p,
                            &format!("/chat.html?session={}", escaped.to_string_lossy()),
                        )?,
                    ),
                ],
            )?;
            plain(p, c"sendWs", &[ws, frame])?;
            done
        }
        Command::ClearShellHistory if !msg.get(c"preserveHistory")?.is_true()? => {
            shell::effect(p, ws, session, msg, shell, true)?
        }
        Command::ClearHistory | Command::ClearShellHistory => call(
            plain(p, c"getChatHistoryRuntime", &[])?,
            c"clearHistory",
            &[session, msg, cs],
        )?,
        Command::Cancel => {
            let id = msg.get(c"operationId")?;
            let opts = fields(
                p,
                &[
                    ("source", text(p, "manual_cancel")?),
                    (
                        "operationId",
                        if id.kind()? == sys::ValueType::napi_string {
                            id
                        } else {
                            null(p)?
                        },
                    ),
                ],
            )?;
            call(
                plain(p, c"getSessionWorkHost", &[])?,
                c"cancelActiveTurn",
                &[session, opts],
            )?
        }
        Command::Message => {
            let value = msg.get(c"text")?;
            if L::new(&env, persisted).get(c"type")?.is_string("gateway")?
                && plain(p, c"handleGatewayControl", &[value, session])?.truthy()?
            {
                return Ok(done.raw());
            }
            if chat_ws_control::is_legacy_cancel(&string(value)?.coerce_string()?.to_string_lossy())
            {
                let opts = fields(p, &[("source", text(p, "manual_cancel")?)])?;
                call(
                    plain(p, c"getSessionWorkHost", &[])?,
                    c"cancelActiveTurn",
                    &[session, opts],
                )?
            } else {
                call(
                    ctx,
                    c"deliverSessionMessage",
                    &[session, value, message_options(msg)?],
                )?
            }
        }
    };
    Ok(result.raw())
}

#[napi]
pub fn chat_socket_init_frame(
    env: Env,
    ports: Unknown<'_>,
    session: Unknown<'_>,
    cs: Unknown<'_>,
    persisted: Unknown<'_>,
    gate: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let session = L::new(&env, session);
    let cs = L::new(&env, cs);
    let record = L::new(&env, persisted);
    let token = plain(p, c"providerTokenWindows", &[session])?;
    let provider_id = read(token, c"providerId")?;
    let windows = read(token, c"windows")?;
    let name = if provider_id.truthy()? {
        p.catch(|| {
            let provider = call(
                p.get(c"providers")?,
                c"getProvider",
                &[p.from_value(&V::Undefined)?, provider_id],
            )?;
            fallback(provider.optional(c"name")?, V::Null)
        })?
        .unwrap_or(null(p)?)
    } else {
        null(p)?
    };
    let active = call(p.get(c"attemptRuntime")?, c"snapshot", &[session])?;
    let auto = if record
        .get(c"providerSelection")?
        .optional(c"mode")?
        .is_string("auto")?
    {
        let snapshot = call(p.get(c"autoProviderRuntime")?, c"snapshot", &[session])?;
        if snapshot.truthy()? {
            snapshot
        } else {
            fallback(record.get(c"autoProviderLastRoute")?, V::Null)?
        }
    } else {
        null(p)?
    };
    let route = if active.truthy()? && active.get(c"outcome")?.is_string("running")? {
        plain(p, c"providerAttemptFields", &[active])?
    } else {
        null(p)?
    };
    let frame = fields(
        p,
        &[
            ("type", text(p, "system")?),
            ("subtype", text(p, "init")?),
            ("cwd", cs.get(c"cwd")?),
            ("session", session),
            ("session_id", session),
            ("cli", cs.get(c"cli")?),
            ("is_streaming", cs.get(c"isStreaming")?),
            (
                "taskShell",
                flag(
                    p,
                    optional_call(p.get(c"taskContextHost")?, c"requiresTaskShell", &[session])?
                        .is_true()?,
                )?,
            ),
            ("turnId", L::new(&env, gate).get(c"turnId")?),
            ("model", fallback(record.get(c"model")?, V::Null)?),
            (
                "effectiveModel",
                plain(p, c"effectiveSessionModel", &[record])?,
            ),
            ("effort", fallback(record.get(c"effort")?, V::Null)?),
            (
                "effectiveEffort",
                plain(p, c"effectiveSessionEffort", &[record])?,
            ),
            ("agent", fallback(record.get(c"agent")?, V::Null)?),
            ("providerRouteProtocolVersion", num(p, 1.0)?),
            ("providerRoute", route),
            (
                "providerId",
                if route.truthy()? {
                    route.get(c"providerId")?
                } else {
                    let id = auto.optional(c"providerId")?;
                    if id.truthy()? {
                        id
                    } else {
                        provider_id
                    }
                },
            ),
            (
                "providerName",
                if route.truthy()? {
                    active.get(c"providerName")?
                } else {
                    let n = auto.optional(c"providerName")?;
                    if n.truthy()? {
                        n
                    } else {
                        name
                    }
                },
            ),
            (
                "providerSelection",
                plain(
                    p,
                    c"providerSelectionDto",
                    &[record.get(c"providerSelection")?],
                )?,
            ),
            ("autoProvider", auto),
            ("providerTokenWindows", windows),
            ("cliStates", plain(p, c"cliStateSummary", &[record])?),
            ("cliAvailability", plain(p, c"cliAvailabilitySummary", &[])?),
            (
                "pendingCliHandoff",
                plain(p, c"cliHandoffSummary", &[record])?,
            ),
        ],
    )?;
    Ok(frame.raw())
}
mod connection;
mod shell;
