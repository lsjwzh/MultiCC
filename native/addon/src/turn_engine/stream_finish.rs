//! 回合收尾持有当前调用的宿主句柄；所有持久化、用户问题和提供商尝试仍沿用原所有者。
use crate::{host_methods::method, js_iteration::read, route_response::*};
use napi::bindgen_prelude::Unknown as JsUnknown;
use napi_derive::napi;
use std::ffi::CStr;
mod execution;
mod ports;

fn arg(value: L<'_>) -> JsUnknown<'_> {
    // 仅向本次同步调用中的原生入口借出 N-API 句柄。
    unsafe { JsUnknown::from_raw_unchecked(value.env(), value.raw()) }
}
fn prop<'a>(obj: L<'a>, key: &CStr) -> Result<L<'a>> {
    read(obj, key)
}
fn port<'a>(ports: L<'a>, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    ports.get(name)?.call_plain(args)
}
fn optional_call<'a>(owner: L<'a>, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    let f = prop(owner, name)?;
    if f.nullish()? {
        return owner.from_value(&V::Undefined);
    }
    f.call(owner, args)
}
fn cli(record: L<'_>) -> Result<L<'_>> {
    fallback(prop(record, c"cli")?, "claude".into())
}
fn current_output(cs: L<'_>) -> Result<bool> {
    Ok(prop(cs, c"currentAssistantText")?.truthy()?
        || prop(prop(cs, c"currentToolCalls")?, c"length")?.truthy()?)
}

fn pending_inputs(runner: L<'_>) -> Result<L<'_>> {
    if prop(runner, c"pendingUserInputRecords")?
        .optional(c"length")?
        .truthy()?
    {
        let promise = runner.global()?.get(c"Promise")?;
        let all = promise.get(c"all")?;
        let records = prop(runner, c"pendingUserInputRecords")?;
        return all.call(promise, &[call(records, c"splice", &[num(runner, 0.0)?])?]);
    }
    null(runner)
}
fn buffered<'a>(p: L<'a>, c: L<'a>) -> Result<L<'a>> {
    let r = c.get(c"runner")?;
    let result = prop(r, c"pendingClaudeResult")?;
    c.set(c"nativeResult", result)?;
    if result.truthy()? {
        port(
            p,
            c"applyClaudeChatEvent",
            &[
                c.get(c"cs")?,
                c.get(c"sessionName")?,
                result,
                c.get(c"forward")?,
                c.get(c"turn")?,
                r,
                prop(c.get(c"provider")?, c"name")?,
            ],
        )?;
        r.assign(c"pendingClaudeResult", null(r)?)?;
    }
    port(p, c"awaitPendingFinalPersist", &[c.get(c"turn")?, r])
}
fn commit<'a>(p: L<'a>, c: L<'a>) -> Result<L<'a>> {
    let runner = c.get(c"runner")?;
    let outcome = prop(runner, c"completionOutcome")?;
    let failure = optional_call(
        p.get(c"attemptRuntime")?,
        c"proxyFailure",
        &[prop(runner, c"providerAttempt")?],
    )?;
    let absent = c.from_value(&V::Undefined)?;
    if !crate::cli_completion::cli_can_persist_completion(
        Env::from_raw(c.env()),
        arg(outcome),
        arg(failure),
        arg(c.get(c"envelope")?),
    )? {
        return Ok(absent);
    }
    let session = c.get(c"sessionName")?;
    let cs = c.get(c"cs")?;
    let turn = c.get(c"turn")?;
    port(
        p,
        c"recordApiSuccess",
        &[
            prop(c.get(c"provider")?, c"name")?,
            fields(
                c,
                &[
                    (
                        "retryAttempt",
                        fallback(prop(runner, c"apiRetryAttempt")?, V::Number(0.0))?,
                    ),
                    ("runner", runner),
                ],
            )?,
        ],
    )?;
    port(p, c"clearSessionApiErrorState", &[session, cs])?;
    if c.get(c"nativeResult")?.truthy()? || prop(turn, c"resultDurable")?.truthy()? {
        return Ok(absent);
    }
    let host = p.get(c"codexUsageHost")?;
    let complete = prop(host, c"complete")?;
    let mut event = prop(runner, c"pendingCompletionEvent")?;
    if !event.truthy()? {
        let mut usage = prop(runner, c"pendingUsage")?;
        if !usage.truthy()? {
            usage = fields(c, &[])?
        };
        event = fields(c, &[("usage", usage)])?;
    }
    let trace = port(p, c"contextTraceFor", &[session, cs])?;
    let pending = complete.call(
        host,
        &[fields(
            c,
            &[
                ("evt", event),
                ("cs", cs),
                ("persisted", c.get(c"persisted")?),
                ("sessionName", session),
                ("turn", turn),
                ("runner", runner),
                ("forward", c.get(c"forward")?),
                ("contextTrace", trace),
            ],
        )?],
    )?;
    fields(c, &[("pending", pending)])
}

fn proxy_failure<'a>(p: L<'a>, turn: L<'a>, runner: L<'a>) -> Result<L<'a>> {
    let rt = p.get(c"attemptRuntime")?;
    let f = prop(rt, c"proxyFailure")?;
    if f.nullish()? {
        return null(p);
    }
    let attempt = prop(runner, c"providerAttempt")?;
    let durable = prop(turn, c"resultDurable")?.is_true()?
        && prop(turn, c"resultRunnerId")?.equals(prop(runner, c"runnerId")?)?;
    fallback(
        f.call(
            rt,
            &[
                attempt,
                fields(
                    p,
                    &[
                        ("resultDurable", flag(p, durable)?),
                        ("completion", prop(runner, c"completionOutcome")?),
                    ],
                )?,
            ],
        )?,
        V::Null,
    )
}
fn frozen<'a>(p: L<'a>, operation: &str, input: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let raw = crate::chat_finalize::chat_frozen_finalization(
        Env::from_raw(p.env()),
        operation.to_owned(),
        arg(input),
        arg(options),
    )?;
    Ok(L::from_raw(p.env(), raw))
}
fn raw_failure<'a>(runner: L<'a>, record: L<'a>, failure: L<'a>, envelope: L<'a>) -> Result<L<'a>> {
    if prop(runner, c"killReason")?.truthy()? {
        return fields(
            runner,
            &[
                ("source", text(runner, "anthropic_event")?),
                ("provider", cli(record)?),
                ("code", prop(runner, c"killReason")?),
                ("message", text(runner, "turn cancelled")?),
            ],
        );
    }
    if prop(runner, c"modelTimeoutStopping")?.truthy()? && failure.truthy()? {
        return Ok(failure);
    }
    if envelope.truthy()? {
        return Ok(envelope);
    }
    let raw = prop(runner, c"apiErrorRaw")?;
    if raw.truthy()? {
        return Ok(raw);
    }
    if failure.truthy()? {
        return Ok(failure);
    }
    fields(
        runner,
        &[
            ("source", text(runner, "host_interruption")?),
            ("provider", cli(record)?),
            ("code", text(runner, "stream_ended_without_result")?),
            (
                "message",
                text(runner, "stream ended without a result event")?,
            ),
        ],
    )
}

fn plan<'a>(p: L<'a>, c: L<'a>) -> Result<L<'a>> {
    let cs = c.get(c"cs")?;
    let runner = c.get(c"runner")?;
    let turn = c.get(c"turn")?;
    let session = c.get(c"sessionName")?;
    let record = c.get(c"persisted")?;
    let auto = c.get(c"autoTurn")?;
    let envelope = c.get(c"envelope")?;
    let failure = proxy_failure(p, turn, runner)?;
    let facts = call(p.get(c"attemptRuntime")?, c"snapshot", &[session])?;
    let effects = port(p, c"turnHasSideEffects", &[cs])?.truthy()?
        || facts.optional(c"toolIntentObserved")?.truthy()?
        || facts.optional(c"sideEffectObserved")?.truthy()?;
    let error_only = envelope.truthy()?
        && prop(envelope, c"body")?.nullish()?
        && facts.optional(c"replayFence")?.is_string("none")?
        && !effects;
    let partial = !error_only
        && (port(p, c"meaningfulTurnOutput", &[cs])?.truthy()?
            || facts.optional(c"visibleOutputObserved")?.truthy()?);
    let flags = fields(
        c,
        &[
            ("killReason", prop(runner, c"killReason")?),
            ("boundaryErrorEnvelope", envelope),
        ],
    )?;
    crate::chat_turn_effects::chat_clear_succeeded_errors(
        Env::from_raw(c.env()),
        arg(turn),
        arg(runner),
        arg(cs),
        arg(flags),
    )?;
    let stream = text(c, "stream")?;
    let guard_facts = fields(
        c,
        &[
            ("runnerKind", stream),
            ("cli", cli(record)?),
            (
                "resultDurable",
                flag(c, prop(turn, c"resultDurable")?.is_true()?)?,
            ),
            (
                "hasOutput",
                flag(
                    c,
                    current_output(cs)?
                        || facts.optional(c"visibleOutputObserved")?.truthy()?
                        || effects,
                )?,
            ),
            (
                "killReason",
                fallback(prop(runner, c"killReason")?, "".into())?,
            ),
        ],
    )?;
    let handoff = frozen(
        c,
        "handoff",
        fields(c, &[("handoff", prop(record, c"pendingCliHandoff")?)])?,
        fields(c, &[])?,
    )?;
    let guarded = crate::chat_finalize::chat_is_guarded_handoff_failure(
        Env::from_raw(c.env()),
        arg(guard_facts),
        arg(handoff),
    )?;
    let raw = raw_failure(runner, record, failure, envelope)?;
    let safe = error_only
        || crate::chat_finalize::chat_replay_safe_handoff_provider_error(
            Env::from_raw(c.env()),
            arg(fields(
                c,
                &[
                    ("attempt", facts),
                    ("raw", prop(runner, c"apiErrorRaw")?),
                    ("proxyFailure", failure),
                    ("partialOutput", flag(c, partial)?),
                    ("sideEffects", flag(c, effects)?),
                    ("killReason", prop(runner, c"killReason")?),
                ],
            )?),
        )?;
    let classify = (!guarded || safe)
        && (envelope.truthy()?
            || failure.truthy()?
            || prop(runner, c"apiErrorRaw")?.truthy()?
            || prop(runner, c"sawApiError")?.truthy()?
            || prop(runner, c"adapterError")?.truthy()?
            || prop(runner, c"killReason")?.truthy()?
            || (!prop(runner, c"resultEvent")?.truthy()?
                && !prop(turn, c"resultDurable")?.truthy()?));
    let decision = if classify {
        port(
            p,
            c"evaluateTurnApiError",
            &[fields(
                c,
                &[
                    ("sessionName", session),
                    ("cs", cs),
                    ("persisted", record),
                    ("turn", turn),
                    ("runner", runner),
                    (
                        "raw",
                        if safe && failure.optional(c"source")?.is_string("proxy_response")? {
                            failure
                        } else {
                            raw
                        },
                    ),
                    (
                        "attempt",
                        fallback(prop(runner, c"apiRetryAttempt")?, V::Number(0.0))?,
                    ),
                    (
                        "phase",
                        text(
                            c,
                            if partial || effects {
                                "stream"
                            } else {
                                "before_first_token"
                            },
                        )?,
                    ),
                    ("partialOutput", flag(c, partial)?),
                    ("sideEffects", flag(c, effects)?),
                    ("deferNotice", prop(auto, c"enabled")?),
                ],
            )?],
        )?
    } else {
        null(c)?
    };
    let failover = if decision.truthy()? {
        call(auto, c"failover", &[decision, facts])?
    } else {
        null(c)?
    };
    let preparation = if decision.truthy()? && !failover.optional(c"invocationOptions")?.truthy()? {
        fallback(
            optional_call(auto, c"prepareHandoff", &[decision, facts])?,
            V::Null,
        )?
    } else {
        null(c)?
    };
    let auto_decision = failover.optional(c"decision")?;
    let effective = if auto_decision.truthy()? {
        auto_decision
    } else {
        decision
    };
    let warning = if failover.optional(c"invocationOptions")?.truthy()? {
        let mut message = multicc_core::js::JsString::from("Auto Provider：");
        message.push(&prop(failover, c"fromProviderName")?.coerce_string()?);
        message.push_str(" 不可用，正在切换到 ");
        message.push(&prop(failover, c"toProviderName")?.coerce_string()?);
        message.push_str("。");
        Some(c.from_value(&V::String(message))?)
    } else if prop(auto, c"enabled")?.truthy()? && decision.truthy()? {
        Some(L::from_raw(
            p.env(),
            crate::api_error_policy::api_error_retry_notice(
                Env::from_raw(p.env()),
                arg(effective),
            )?,
        ))
    } else {
        None
    };
    if let Some(msg) = warning {
        port(
            p,
            c"chatBroadcast",
            &[
                session,
                fields(
                    c,
                    &[
                        ("type", text(c, "system")?),
                        ("subtype", text(c, "warning")?),
                        ("message", msg),
                    ],
                )?,
            ],
        )?;
    }
    let checkpoint = port(p, c"assistantCheckpointKey", &[cs])?;
    let input = fields(
        c,
        &[
            ("completion", prop(runner, c"completionOutcome")?),
            ("current", flag(c, true)?),
            ("runnerKind", stream),
            ("cli", cli(record)?),
            (
                "killReason",
                fallback(prop(runner, c"killReason")?, V::Null)?,
            ),
            (
                "apiError",
                flag(
                    c,
                    effective.truthy()? || prop(runner, c"sawApiError")?.truthy()?,
                )?,
            ),
            ("apiErrorDecision", effective),
            ("autoHandoffReserved", flag(c, preparation.truthy()?)?),
            ("replaySafeProviderError", flag(c, safe)?),
            (
                "adapterError",
                flag(c, prop(runner, c"adapterError")?.truthy()?)?,
            ),
            (
                "retryPlanned",
                flag(c, prop(runner, c"retryPlanned")?.truthy()?)?,
            ),
            (
                "resultEvent",
                flag(c, prop(runner, c"resultEvent")?.truthy()?)?,
            ),
            (
                "resultDurable",
                flag(c, prop(turn, c"resultDurable")?.truthy()?)?,
            ),
            ("hasOutput", flag(c, current_output(cs)?)?),
            (
                "sameDurablePartial",
                flag(
                    c,
                    crate::chat_turn_effects::chat_has_partial_checkpoint(
                        Env::from_raw(c.env()),
                        arg(runner),
                        arg(checkpoint),
                    )?,
                )?,
            ),
            ("handoff", prop(record, c"pendingCliHandoff")?),
        ],
    )?;
    fields(
        c,
        &[
            ("plan", frozen(c, "plan", input, fields(c, &[])?)?),
            ("apiErrorDecision", decision),
            ("autoFailover", failover),
            ("autoHandoffPreparation", preparation),
        ],
    )
}

#[napi]
pub fn chat_stream_finish_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    type Handler = for<'a> fn(L<'a>, &mut [L<'a>]) -> Result<L<'a>>;
    let api = fields(p, &[])?;
    for (name, run) in [
        (
            "pendingInputs",
            (|_, a: &mut [L<'_>]| pending_inputs(a[0])) as Handler,
        ),
        ("buffered", |p, a| buffered(p, a[0])),
        ("commit", |p, a| commit(p, a[0])),
    ] {
        api.define_key(text(p, name)?, method(&env, p, name, 1, 1, run)?)?;
    }
    execution::install(&env, p, api)?;
    api.set(c"executorPorts", ports::executor_ports(&env, p)?)?;
    Ok(api.raw())
}
