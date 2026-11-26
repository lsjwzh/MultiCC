//! 配置应用后的二次许可检查、原生历史守护和请求构造。
//! OpenCode 的归档可能异步，只在它结束后读取继承的任务与恢复事实。
use crate::{host_methods::method, js_iteration::read, route_response::*};
use std::ffi::CStr;

fn plain<'a>(p: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    p.get(key)?.call_plain(args)
}
fn optional_getter<'a>(p: L<'a>, key: &CStr) -> Result<L<'a>> {
    let getter = p.get(key)?;
    if getter.nullish()? {
        p.from_value(&V::Undefined)
    } else {
        getter.call_plain(&[])
    }
}
fn permit<'a>(p: L<'a>, s: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let workspace = optional_getter(p, c"getWorkspaceAdmission")?;
    if workspace.nullish()? {
        p.from_value(&V::Undefined)
    } else {
        call(workspace, c"assertPermit", &[s, opts])
    }
}
fn admission<'a>(state: L<'a>) -> Result<L<'a>> {
    let p = state.get(c"ports")?;
    let s = state.get(c"sessionName")?;
    let opts = state.get(c"opts")?;
    let cs = state.get(c"existingCs")?;
    let record = state.get(c"persisted")?;
    let lineage = if opts.get(c"originContinue")?.is_true()?
        && cs.truthy()?
        && cs.get(c"_continuationLineage")?.truthy()?
    {
        cs.get(c"_continuationLineage")?.get(c"lineage")?
    } else {
        null(p)?
    };
    let request = (|| -> Result<L<'a>> {
        let input = fields(
            p,
            &[
                ("sessionId", s),
                ("text", state.get(c"text")?),
                ("cli", state.get(c"turnCli")?),
                ("turnCount", state.get(c"turnCount")?),
                (
                    "hasNativeSession",
                    plain(p, c"hasNativeHistory", &[record])?,
                ),
                ("requestId", opts.get(c"requestId")?),
                ("clientMsgId", opts.get(c"clientMsgId")?),
                ("deliveryId", opts.get(c"deliveryId")?),
            ],
        )?;
        let dispatch = opts.get(c"originDispatchId")?;
        input.assign(
            c"originDispatchId",
            if dispatch.truthy()? {
                dispatch
            } else if lineage.truthy()? && lineage.get(c"kind")?.is_string("dispatch")? {
                lineage.get(c"operationId")?
            } else {
                null(p)?
            },
        )?;
        let trigger = opts.get(c"originTrigger")?.is_true()?
            || !opts.get(c"originDispatchId")?.truthy()?
                && lineage.truthy()?
                && lineage.get(c"kind")?.is_string("trigger")?;
        input.assign(c"originTrigger", flag(p, trigger)?)?;
        for key in [c"originContinue", c"bgTaskIds", c"bgToolUseIds"] {
            input.assign(key, opts.get(key)?)?;
        }
        input.spread_from(call(p.get(c"taskContextHost")?, c"turnOptions", &[opts])?)?;
        plain(p, c"normalizeTurnRequest", &[input])
    })();
    let request = match request {
        Ok(value) => value,
        Err(error) => {
            let err = if let Some(err) = p.exception_value()? {
                err
            } else {
                p.global()?
                    .get(c"Error")?
                    .construct(&[text(p, &error.reason)?])?
            };
            let code = if err.instance_of(p.get(c"TurnRequestError")?)? {
                err.get(c"code")?
            } else {
                text(p, "invalid_request")?
            };
            call(
                p.get(c"logger")?,
                c"warn",
                &[
                    text(p, "chat_turn_rejected_invalid_request")?,
                    fields(
                        p,
                        &[
                            ("sessionId", s),
                            ("code", code),
                            ("message", fallback(err.optional(c"message")?, V::Null)?),
                        ],
                    )?,
                ],
            )?;
            return fields(p, &[("blocked", flag(p, true)?)]);
        }
    };
    fields(
        p,
        &[
            ("persisted", record),
            ("existingCs", cs),
            ("initialHistory", state.get(c"initialHistory")?),
            ("turnRequest", request),
            ("deliveryPersisted", state.get(c"replay")?),
        ],
    )
}

pub(super) fn finish<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (s, message, opts, record, replay) = (a[0], a[1], a[2], a[3], a[4]);
    permit(p, s, opts)?;
    let experimental = optional_getter(p, c"getExperimentalTuiChatRuntime")?;
    if !experimental.nullish()? && call(experimental, c"owns", &[record])?.truthy()? {
        return fields(
            p,
            &[(
                "delegated",
                call(experimental, c"admit", &[s, message, opts])?,
            )],
        );
    }
    let env = Env::from_raw(p.env());
    let cs = call(p.get(c"chatSessions")?, c"get", &[s])?;
    let (initial, count) = if cs.truthy()? {
        (null(p)?, cs.get(c"chatTurnCount")?)
    } else {
        let initial = plain(p, c"viewChatHistory", &[s])?;
        let assistant = method(&env, p, "", 1, 1, |p, a| {
            flag(p, read(a[0], c"role")?.is_string("assistant")?)
        })?;
        (
            initial,
            call(initial, c"filter", &[assistant])?.get(c"length")?,
        )
    };
    let live_cli = if cs.truthy()? { cs.get(c"cli")? } else { cs };
    let cli = if live_cli.truthy()? {
        live_cli
    } else {
        fallback(record.get(c"cli")?, "claude".into())?
    };
    let guard_ports = |guard: L<'a>| {
        fields(
            p,
            &[
                ("guard", guard),
                ("persisted", record),
                ("sessionName", s),
                ("logger", p.get(c"logger")?),
                ("rememberActiveCliState", p.get(c"rememberActiveCliState")?),
                (
                    "savePersistedSessionsBestEffort",
                    p.get(c"savePersistedSessionsBestEffort")?,
                ),
                ("chatBroadcast", p.get(c"chatBroadcast")?),
                ("appendEvent", p.get(c"appendEvent")?),
            ],
        )
    };
    if (cli.is_string("codex")? || cli.is_string("codex-exp")?)
        && record.get(c"cliSessionId")?.truthy()?
    {
        let result = plain(
            p,
            c"enforceCodexRolloutForTurn",
            &[guard_ports(p.get(c"codexRolloutGuard")?)?],
        )?;
        if result.get(c"action")?.is_string("blocked")? {
            return fields(
                p,
                &[("blocked", flag(p, true)?), ("code", result.get(c"code")?)],
            );
        }
    }
    let guard = p.get(c"nativeSessionGuard")?;
    if call(guard, c"handles", &[cli])?.truthy()? && record.get(c"cliSessionId")?.truthy()? {
        let result = call(guard, c"enforce", &[record])?;
        if result.get(c"action")?.is_string("archived")? {
            record.assign(c"cliSessionId", null(p)?)?;
            record.assign(c"_streamSessionId", null(p)?)?;
            plain(p, c"savePersistedSessionsBestEffort", &[])?;
            let archived = method(&env, p, "", 1, 1, |p, a| {
                fields(
                    p,
                    &[
                        ("file", a[0].get(c"file")?),
                        ("sizeBytes", a[0].get(c"sizeBytes")?),
                        ("archivedTo", a[0].get(c"archivedTo")?),
                    ],
                )
            })?;
            let details = fields(
                p,
                &[
                    ("sessionId", s),
                    ("cli", cli),
                    ("archivedCliSessionId", result.get(c"cliSessionId")?),
                    ("maxBytes", result.get(c"maxBytes")?),
                    (
                        "archived",
                        call(result.get(c"archived")?, c"map", &[archived])?,
                    ),
                ],
            )?;
            call(
                p.get(c"logger")?,
                c"warn",
                &[text(p, "native_session_archived")?, details],
            )?;
            let mb = || -> Result<String> {
                Ok(call(
                    p.global()?.get(c"Math")?,
                    c"round",
                    &[num(p, result.get(c"maxBytes")?.number()? / 1048576.0)?],
                )?
                .coerce_string()?
                .to_string_lossy())
            };
            let lane = cli.coerce_string()?.to_string_lossy();
            plain(
                p,
                c"appendEvent",
                &[
                    record.get(c"dirId")?,
                    text(p, "native_session_archived")?,
                    text(
                        p,
                        &format!(
                            "{lane} 原生会话历史超过 {}MB 已归档，本轮将重建上下文",
                            mb()?
                        ),
                    )?,
                    s,
                ],
            )?;
            plain(p,c"chatBroadcast",&[s,fields(p,&[("type",text(p,"system")?),("subtype",text(p,"rollout_archived")?),("message",text(p,&format!("{lane} 原生会话历史过大（>{}MB），已归档并重建上下文；旧历史文件保留在归档目录，未删除。",mb()?))?)])?])?;
        }
    }
    let state = fields(
        p,
        &[
            ("ports", p),
            ("sessionName", s),
            ("text", message),
            ("opts", opts),
            ("persisted", record),
            ("existingCs", cs),
            ("initialHistory", initial),
            ("replay", replay),
            ("turnCli", cli),
            ("turnCount", count),
        ],
    )?;
    if cli.is_string("opencode")?
        && (record.get(c"_streamSessionId")?.truthy()? || record.get(c"cliSessionId")?.truthy()?)
    {
        let options = guard_ports(p.get(c"opencodeContextGuard")?)?;
        options.assign(
            c"history",
            method(&env, state, "history", 0, 0, |s, _| {
                let history = s.get(c"initialHistory")?;
                if history.truthy()? {
                    Ok(history)
                } else {
                    plain(
                        s.get(c"ports")?,
                        c"viewChatHistory",
                        &[s.get(c"sessionName")?],
                    )
                }
            })?,
        )?;
        options.assign(
            c"assertCurrent",
            method(&env, state, "assertCurrent", 0, 0, |s, _| {
                permit(s.get(c"ports")?, s.get(c"sessionName")?, s.get(c"opts")?)
            })?,
        )?;
        let pending = plain(p, c"enforceOpencodeContextForTurn", &[options])?;
        let complete = method(&env, state, "finishAdmission", 0, 0, |s, _| admission(s))?;
        return call(pending, c"then", &[complete]).map(|value| L::from_raw(p.env(), value.raw()));
    }
    admission(L::from_raw(p.env(), state.raw()))
}
