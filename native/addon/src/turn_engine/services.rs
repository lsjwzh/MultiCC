//! 回合侧提供商事件、上下文回执、编排投递与历史裁剪。宿主持有实际存储和进程。
use crate::{
    host_methods::method,
    js_iteration::{read, IteratorRecord},
    route_response::*,
};
use napi::bindgen_prelude::Unknown as JsUnknown;
use napi_derive::napi;
use std::ffi::CStr;

pub(super) fn port<'a>(p: L<'a>, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    p.get(name)?.call_plain(args)
}
fn clock(s: L<'_>) -> Result<L<'_>> {
    call(s.global()?.get(c"Date")?, c"now", &[])
}
pub(super) fn join<'a>(s: L<'a>, parts: &[L<'a>]) -> Result<L<'a>> {
    let mut result = multicc_core::js::JsString::new();
    for part in parts {
        result.push(&part.coerce_string()?);
    }
    s.from_value(&V::String(result))
}
pub(super) fn error_value<'a>(p: L<'a>, err: napi::Error) -> Result<L<'a>> {
    match p.exception_value()? {
        Some(value) => Ok(value),
        None => p
            .global()?
            .get(c"Error")?
            .construct(&[text(p, &err.reason)?]),
    }
}
fn cause(e: L<'_>) -> Result<L<'_>> {
    let msg = e.optional(c"message")?;
    if msg.truthy()? {
        Ok(msg)
    } else {
        string(e)
    }
}
fn prepare<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let record = call(p.get(c"persistedSessions")?, c"get", &[a[0]])?;
    if !record.truthy()? {
        return null(p);
    }
    let method = if p
        .get(c"providerLimitCache")?
        .optional(c"isAsync")?
        .truthy()?
    {
        c"prepareAdmissionAsync"
    } else {
        c"prepareAdmission"
    };
    let f = read(p.get(c"autoProviderRuntime")?, method)?;
    f.call_plain(&[fields(
        p,
        &[
            ("session", record),
            ("text", a[1]),
            ("providers", p.get(c"providers")?),
            ("sessionId", a[0]),
            ("clientMsgId", a[2]),
        ],
    )?])
}
fn begin_handoff<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if !a[2].truthy()? {
        return null(p);
    }
    let owner = p.get(c"autoProviderHandoff")?;
    let f = read(owner, c"schedule")?;
    let pending = f.call(
        owner,
        &[fields(
            p,
            &[
                ("sessionId", a[0]),
                ("turnId", read(a[1], c"turnId")?),
                ("preparation", a[2]),
                ("lineage", read(a[1], c"lineage")?),
            ],
        )?],
    )?;
    fields(p, &[("pending", pending)])
}
fn end_handoff<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (s, turn, preparation, supervised, result) = (a[0], a[1], a[2], a[3], a[4]);
    if supervised.truthy()? {
        let get = p.get(c"getUnattendedHost")?;
        let host = if get.nullish()? {
            p.from_value(&V::Undefined)?
        } else {
            get.call_plain(&[])?
        };
        if read(result, c"scheduled")?.truthy()? {
            let f = host.optional(c"handoffAccepted")?;
            if !f.nullish()? {
                f.call(host, &[s, read(turn, c"turnId")?])?;
            }
        } else if !read(result, c"reason")?.is_string("duplicate")? {
            let f = host.optional(c"onTurnEnd")?;
            if !f.nullish()? {
                f.call(
                    host,
                    &[
                        s,
                        fields(
                            p,
                            &[
                                ("kind", text(p, "fault")?),
                                ("settle", text(p, "E")?),
                                ("turnId", read(turn, c"turnId")?),
                                ("retryScheduled", flag(p, false)?),
                            ],
                        )?,
                    ],
                )?;
            }
        }
    }
    if read(result, c"scheduled")?.truthy()? {
        let from = read(preparation, c"fromProviderName")?.coerce_string()?;
        let to = read(preparation, c"providerName")?.coerce_string()?;
        let mut message = multicc_core::js::JsString::from("Auto Provider：");
        message.push(&from);
        message.push_str(" 已中断，将由 ");
        message.push(&to);
        if read(preparation, c"cli")?.truthy()? {
            message.push_str("（");
            message.push(&read(preparation, c"cli")?.coerce_string()?);
            message.push_str(" CLI）")
        }
        message.push_str(" 在新回合中安全接续。");
        port(
            p,
            c"chatBroadcast",
            &[
                s,
                fields(
                    p,
                    &[
                        ("type", text(p, "system")?),
                        ("subtype", text(p, "warning")?),
                        ("message", p.from_value(&V::String(message))?),
                    ],
                )?,
            ],
        )?;
    }
    Ok(result)
}
pub(super) fn and_get<'a>(obj: L<'a>, key: &CStr) -> Result<L<'a>> {
    if obj.truthy()? {
        read(obj, key)
    } else {
        Ok(obj)
    }
}
fn forward<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (s, cs, turn, runner, event) = (a[0], a[1], a[2], a[3], a[4]);
    let rt = p.get(c"attemptRuntime")?;
    let observed = call(
        rt,
        c"observeEvent",
        &[and_get(runner, c"providerAttempt")?, event],
    )?;
    if !observed.truthy()? || !read(observed, c"accepted")?.is_true()? {
        let log = p.get(c"logger")?;
        let warn = read(log, c"warn")?;
        if !warn.nullish()? {
            let id = and_get(turn, c"turnId")?;
            let mut route = and_get(runner, c"providerAttempt")?;
            if route.truthy()? {
                route = read(read(runner, c"providerAttempt")?, c"routeAttemptId")?;
            }
            warn.call(
                log,
                &[
                    text(p, "provider_attempt_event_suppressed")?,
                    fields(
                        p,
                        &[
                            ("sessionId", s),
                            ("turnId", id),
                            ("routeAttemptId", route),
                            (
                                "code",
                                fallback(
                                    and_get(observed, c"code")?,
                                    "attempt_unavailable".into(),
                                )?,
                            ),
                        ],
                    )?,
                ],
            )?;
        }
        return flag(p, false);
    }
    let scrubbed = call(rt, c"scrubAttemptEvent", &[observed, event])?;
    let tagged = port(p, c"tagProviderAttemptEvent", &[scrubbed, observed])?;
    cs.assign(c"lastStreamAt", clock(p)?)?;
    call(
        p.get(c"turnProgressHeartbeat")?,
        c"touchVisible",
        &[s, read(turn, c"turnId")?],
    )?;
    call(p.get(c"replay")?, c"push", &[s, tagged])?;
    port(p, c"chatBroadcast", &[s, tagged])?;
    flag(p, true)
}
fn finish<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if !and_get(a[0], c"providerAttempt")?.truthy()? {
        return null(p);
    }
    let rt = p.get(c"attemptRuntime")?;
    let f = read(rt, c"finishAttempt")?;
    let attempt = read(a[0], c"providerAttempt")?;
    let facts = fields(p, &[("outcome", a[1])])?;
    facts.spread_from(a[2])?;
    f.call(rt, &[attempt, facts])
}
fn trace<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if !a[1].optional(c"_taskShellReceiptId")?.truthy()? {
        return null(p);
    }
    let traced = (|| {
        let host = p.get(c"taskContextHost")?;
        let f = host.optional(c"taskShellContextTrace")?;
        if f.nullish()? {
            return null(p);
        }
        fallback(
            f.call(
                host,
                &[
                    a[0],
                    read(a[1], c"_taskShellReceiptId")?,
                    fields(p, &[("summary", flag(p, true)?)])?,
                ],
            )?,
            V::Null,
        )
    })();
    match traced {
        Ok(trace) => Ok(trace),
        Err(err) => {
            let e = error_value(p, err)?;
            let log = p.get(c"logger")?;
            call(
                log,
                c"warn",
                &[
                    text(p, "task_shell_context_trace_failed")?,
                    fields(
                        p,
                        &[
                            ("sessionId", a[0]),
                            ("receiptId", read(a[1], c"_taskShellReceiptId")?),
                            ("error", cause(e)?),
                        ],
                    )?,
                ],
            )?;
            null(p)
        }
    }
}
fn iter<'a>(value: L<'a>, mut visit: impl FnMut(L<'a>) -> Result<()>) -> Result<()> {
    if value.truthy()? {
        IteratorRecord::open(value, c"value is not iterable", || {
            value.global()?.get(c"Symbol")?.get(c"iterator")
        })?
        .for_each(&mut visit)?;
    }
    Ok(())
}
fn mb(value: L<'_>) -> Result<L<'_>> {
    let fixed = call(
        num(value, value.number()? / 1048576.0)?,
        c"toFixed",
        &[num(value, 2.0)?],
    )?;
    join(value, &[fixed, text(value, "MB")?])
}
fn prune<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (s, record) = (a[0], a[1]);
    let log = p.get(c"logger")?;
    let outcome = (|| {
        let pruning = port(p, c"getTranscriptPruning", &[])?;
        let run = read(pruning, c"pruneSessionClaude")?;
        run.call(pruning, &[port(p, c"cwdForSession", &[record])?, record])
    })();
    let outcome = match outcome {
        Ok(value) => value,
        Err(err) => {
            let e = error_value(p, err)?;
            let message = if e.truthy()? && read(e, c"message")?.truthy()? {
                read(e, c"message")?
            } else {
                string(e)?
            };
            call(
                log,
                c"warn",
                &[
                    text(p, "transcript_prune_failed")?,
                    fields(p, &[("sessionId", s), ("error", message)])?,
                ],
            )?;
            return null(p);
        }
    };
    iter(read(outcome, c"errors")?, |item| {
        call(
            log,
            c"warn",
            &[
                text(p, "transcript_prune_failed")?,
                fields(
                    p,
                    &[
                        ("sessionId", s),
                        ("cliSessionId", read(item, c"cliSessionId")?),
                        ("error", read(item, c"error")?),
                    ],
                )?,
            ],
        )?;
        Ok(())
    })?;
    let mut last = null(p)?;
    iter(read(outcome, c"pruned")?, |item| {
        let id = read(item, c"cliSessionId")?;
        let report = read(item, c"report")?;
        let info = fields(p, &[("sessionId", s), ("cliSessionId", id)])?;
        for key in [
            c"strategy",
            c"beforeBytes",
            c"afterBytes",
            c"droppedLines",
            c"elidedEntries",
            c"lostTurns",
            c"keptSummary",
            c"contextAffected",
        ] {
            info.set(key, read(report, key)?)?;
        }
        call(log, c"info", &[text(p, "transcript_pruned")?, info])?;
        p.catch(|| {
            let dir = read(record, c"dirId")?;
            let msg = join(
                p,
                &[
                    text(p, "上下文整理 ")?,
                    mb(read(report, c"beforeBytes")?)?,
                    text(p, " → ")?,
                    mb(read(report, c"afterBytes")?)?,
                    text(p, "（")?,
                    read(report, c"strategy")?,
                    text(p, "）")?,
                ],
            )?;
            port(
                p,
                c"appendEvent",
                &[dir, text(p, "context_pruned")?, msg, s],
            )
        })?;
        if read(report, c"contextAffected")?.truthy()? {
            let detail = if read(report, c"lostTurns")?.number()? > 0.0 {
                join(
                    p,
                    &[
                        text(p, "已丢弃 ")?,
                        read(report, c"lostTurns")?,
                        text(p, " 轮最早的对话")?,
                    ],
                )?
            } else {
                join(
                    p,
                    &[
                        text(p, "已压缩 ")?,
                        read(report, c"elidedEntries")?,
                        text(p, " 条过大的工具输出")?,
                    ],
                )?
            };
            let prefix = if read(outcome, c"activeClaude")?.truthy()? {
                "上下文已自动整理："
            } else {
                "Claude 历史上下文已自动整理："
            };
            let msg = join(
                p,
                &[
                    text(p, prefix)?,
                    mb(read(report, c"beforeBytes")?)?,
                    text(p, " → ")?,
                    mb(read(report, c"afterBytes")?)?,
                    text(p, "，")?,
                    detail,
                    text(p, "。")?,
                ],
            )?;
            port(
                p,
                c"chatBroadcast",
                &[
                    s,
                    fields(
                        p,
                        &[
                            ("type", text(p, "system")?),
                            ("subtype", text(p, "context_pruned")?),
                            ("message", msg),
                        ],
                    )?,
                ],
            )?;
        }
        last = report;
        Ok(())
    })?;
    if read(outcome, c"activeClaude")?.truthy()?
        && read(outcome, c"anyContextAffected")?.truthy()?
    {
        p.catch(|| {
            call(
                p.get(c"chatStream")?,
                c"recycle",
                &[s, text(p, "transcript-pruned")?],
            )
        })?;
        let reset = p.get(c"markPlanContextReset")?;
        if !reset.nullish()? {
            reset.call_plain(&[s])?;
        }
    }
    Ok(last)
}
fn delivery<'a>(p: L<'a>, c: L<'a>) -> Result<L<'a>> {
    let (item, s, message, opts) = (
        read(c, c"item")?,
        read(c, c"sessionId")?,
        read(c, c"text")?,
        read(c, c"opts")?,
    );
    let mut class = opts.optional(c"deliveryClass")?;
    if !class.truthy()? {
        class = port(p, c"deliveryClassForItem", &[item])?
    }
    let notice = class.is_string("notice")?;
    if !notice
        && !(read(item, c"payload")?
            .optional(c"type")?
            .is_string("dispatch.result")?
            && read(read(item, c"payload")?, c"gateway")?.truthy()?)
    {
        return fields(
            p,
            &[
                ("turn", flag(p, true)?),
                ("pending", port(p, c"runChatTurn", &[s, message, opts])?),
            ],
        );
    }
    let dest = if notice || s.truthy()? {
        s
    } else {
        p.get(c"GATEWAY_ID")?
    };
    let role = if notice { "system" } else { "assistant" };
    let ts = clock(p)?;
    let ids = |key| {
        if notice {
            opts.optional(key)
        } else {
            read(opts, key)
        }
    };
    let row = fields(
        p,
        &[
            ("role", text(p, role)?),
            ("content", message),
            ("ts", ts),
            ("clientMsgId", ids(c"clientMsgId")?),
            ("deliveryId", ids(c"deliveryId")?),
        ],
    )?;
    fields(
        p,
        &[
            ("notice", flag(p, notice)?),
            ("session", dest),
            ("message", message),
            ("pending", port(p, c"appendChatMessage", &[dest, row])?),
        ],
    )
}
fn notify<'a>(p: L<'a>, step: L<'a>, saved: L<'a>) -> Result<L<'a>> {
    if saved.truthy()? {
        let s = step.get(c"session")?;
        let message = step.get(c"message")?;
        if step.get(c"notice")?.truthy()? {
            port(
                p,
                c"chatBroadcast",
                &[
                    s,
                    fields(
                        p,
                        &[
                            ("type", text(p, "system")?),
                            ("subtype", text(p, "notice")?),
                            ("message", message),
                        ],
                    )?,
                ],
            )?;
        } else {
            port(
                p,
                c"pushToGateway",
                &[
                    message,
                    fields(p, &[("persist", flag(p, false)?), ("sessionId", s)])?,
                ],
            )?;
        }
    }
    Ok(saved)
}
#[napi]
pub fn chat_turn_services(env: Env, ports: JsUnknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = fields(p, &[])?;
    type Handler = for<'a> fn(L<'a>, &mut [L<'a>]) -> Result<L<'a>>;
    for (name, length, count, run) in [
        ("prepareAutoProviderAdmission", 3, 3, prepare as Handler),
        ("beginHandoff", 3, 3, begin_handoff),
        ("endHandoff", 5, 5, end_handoff),
        ("forwardProviderEvent", 5, 5, forward),
        ("finishProviderAttempt", 2, 3, finish),
        ("contextTraceFor", 2, 2, trace),
        ("pruneTranscript", 2, 2, prune),
        ("turnTimingsField", 2, 2, |p, a| {
            call(p.get(c"turnTiming")?, c"field", a)
        }),
        ("orchestrationChatBusy", 1, 1, |p, a| {
            let cs = call(p.get(c"chatSessions")?, c"get", a)?;
            if and_get(cs, c"claudeProc")?.truthy()? {
                return flag(p, true);
            }
            let st = call(p.get(c"chatStream")?, c"status", a)?;
            flag(p, and_get(st, c"busy")?.truthy()?)
        }),
        ("persistedOrchestrationDelivery", 2, 2, |p, a| {
            let promise = p.global()?.get(c"Promise")?;
            let no = flag(p, false)?;
            if a[1].truthy()? {
                if let Some(v) = p.catch(|| {
                    let owner = port(p, c"getChatHistoryService", &[])?;
                    let pending = call(owner, c"hasPersistedDelivery", a)?;
                    let settled = call(promise, c"resolve", &[pending])?;
                    let env = Env::from_raw(p.env());
                    let on_error = method(&env, p, "", 0, 0, |p, _| flag(p, false))?;
                    call(settled, c"catch", &[L::from_raw(p.env(), on_error.raw())])
                })? {
                    return Ok(v);
                }
            }
            call(promise, c"resolve", &[no])
        }),
        ("recoverDispatchOperation", 1, 1, |p, a| {
            let history = port(
                p,
                c"viewChatHistory",
                &[read(read(a[0], c"spec")?, c"chatId")?],
            )?;
            let env = Env::from_raw(p.env());
            let raw = super::chat_recover_dispatch_from_history(
                env,
                unsafe { JsUnknown::from_raw_unchecked(p.env(), history.raw()) },
                unsafe { JsUnknown::from_raw_unchecked(p.env(), a[0].raw()) },
            )?;
            Ok(L::from_raw(p.env(), raw))
        }),
        ("delivery", 1, 1, |p, a| delivery(p, a[0])),
        ("notifyDelivery", 2, 2, |p, a| notify(p, a[0], a[1])),
    ] {
        api.define_key(text(p, name)?, method(&env, p, name, length, count, run)?)?;
    }
    Ok(api.raw())
}
