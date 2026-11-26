//! 所有权归当前 runner 的子进程关闭流程。只有等待最终消息落盘之后，
//! 才能读取转瞬即变的结果、重试和错误状态。
use crate::route_response::*;
use napi_derive::napi;
use std::ffi::CStr;

fn unknown(v: L<'_>) -> Unknown<'_> {
    // 借用同一 N-API 调用作用域内的值，不延长其生命周期。
    unsafe { Unknown::from_raw_unchecked(v.env(), v.raw()) }
}
fn frozen<'a>(op: &str, input: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let raw = crate::chat_finalize::chat_frozen_finalization(
        Env::from_raw(input.env()),
        op.into(),
        unknown(input),
        unknown(options),
    )?;
    Ok(L::from_raw(input.env(), raw))
}
fn either<'a>(left: L<'a>, right: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    if left.truthy()? {
        Ok(left)
    } else {
        right()
    }
}
fn cat<'a>(p: L<'a>, pieces: &[L<'a>]) -> Result<L<'a>> {
    let mut value = multicc_core::js::JsString::new();
    for piece in pieces {
        value.push(&piece.coerce_string()?);
    }
    p.from_value(&V::String(value))
}
struct Close<'a> {
    ports: L<'a>,
    ctx: L<'a>,
    session: L<'a>,
    cs: L<'a>,
    runner: L<'a>,
    turn: L<'a>,
    record: L<'a>,
}
impl<'a> Close<'a> {
    fn new(ports: L<'a>, ctx: L<'a>) -> Result<Self> {
        Ok(Self {
            ports,
            ctx,
            session: ctx.get(c"sessionName")?,
            cs: ctx.get(c"cs")?,
            runner: ctx.get(c"runner")?,
            turn: ctx.get(c"turn")?,
            record: ctx.get(c"persisted")?,
        })
    }
    fn invoke(&self, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
        self.ports.get(key)?.call_plain(args)
    }
    fn warning(&self, message: L<'a>) -> Result<()> {
        let frame = fields(
            self.cs,
            &[
                ("type", text(self.cs, "system")?),
                ("subtype", text(self.cs, "warning")?),
                ("message", message),
            ],
        )?;
        self.invoke(c"chatBroadcast", &[self.session, frame])?;
        Ok(())
    }
    fn bool_prop(&self, target: L<'a>, key: &CStr) -> Result<L<'a>> {
        flag(self.cs, target.get(key)?.truthy()?)
    }
    fn direct_retry_options(&self) -> Result<L<'a>> {
        let v = self.runner.get(c"providerAttempt")?;
        let value = crate::provider_invocation::provider_retry_route_options(
            Env::from_raw(v.env()),
            unknown(v),
        )?;
        Ok(L::from_raw(v.env(), value))
    }
    fn proxy_failure(&self, completion: L<'a>) -> Result<L<'a>> {
        let attempts = self.ports.get(c"attemptRuntime")?;
        let probe = attempts.get(c"proxyFailure")?;
        if probe.nullish()? {
            return null(self.cs);
        }
        let durable = self.turn.get(c"resultDurable")?.is_true()?
            && self
                .turn
                .get(c"resultRunnerId")?
                .equals(self.runner.get(c"runnerId")?)?;
        let facts = fields(
            self.cs,
            &[
                ("resultDurable", flag(self.cs, durable)?),
                ("completion", completion),
            ],
        )?;
        fallback(
            probe.call(attempts, &[self.runner.get(c"providerAttempt")?, facts])?,
            V::Null,
        )
    }
    fn diagnose(&self) -> Result<(L<'a>, L<'a>, L<'a>)> {
        let p = self.cs;
        let c = self.ctx;
        let pending = fallback(p.get(c"_codexPendingStreamError")?, "".into())?;
        let transport = fallback(p.get(c"_codexTransportError")?, "".into())?;
        let count = fallback(p.get(c"_codexPendingStreamErrorCount")?, V::Number(0.0))?;
        let tail = call(
            call(c.get(c"stderrBuf")?, c"slice", &[num(p, -300.0)?])?,
            c"trim",
            &[],
        )?;
        let sanitized = self.invoke(c"sanitizeApiErrorMessage", &[tail, text(p, "")?])?;
        let facts = fields(
            p,
            &[
                ("sessionName", self.session),
                ("pid", c.get(c"proc")?.get(c"pid")?),
                ("code", c.get(c"code")?),
                ("signal", c.get(c"signal")?),
                ("durMs", c.get(c"durMs")?),
                ("killReason", c.get(c"killReason")?),
                ("completionOutcome", c.get(c"completionOutcome")?),
                ("isRetry", c.get(c"isRetry")?),
                ("pendingStreamError", pending),
                ("pendingTransportError", transport),
                ("pendingStreamErrorCount", count),
                ("stderrTail", sanitized),
            ],
        )?;
        let diag = L::from_raw(
            p.env(),
            crate::turn_engine::chat_derive_close_turn_facts(
                Env::from_raw(p.env()),
                unknown(p),
                unknown(self.turn),
                unknown(facts),
            )?,
        );
        if pending.truthy()?
            && !diag.get(c"hasTurnOutput")?.truthy()?
            && !p.get(c"_adapterError")?.truthy()?
        {
            p.assign(c"_adapterError", pending)?;
            self.invoke(
                c"forward",
                &[fields(
                    p,
                    &[
                        ("type", text(p, "error")?),
                        ("error", cat(p, &[text(p, "Codex 出错：")?, pending])?),
                    ],
                )?],
            )?;
        }
        let summary = call(
            p.global()?.get(c"JSON")?,
            c"stringify",
            &[diag.get(c"diag")?],
        )?;
        call(
            p.global()?.get(c"console")?,
            c"log",
            &[cat(
                p,
                &[
                    text(p, "[multicc/chat] [")?,
                    self.session,
                    text(p, "] close kind=")?,
                    diag.get(c"kind")?,
                    text(p, " ")?,
                    summary,
                ],
            )?],
        )?;
        Ok((diag, transport, sanitized))
    }

    fn classify(
        &self,
        has_output: L<'a>,
        transport: L<'a>,
        stderr: L<'a>,
    ) -> Result<(L<'a>, L<'a>, bool)> {
        let c = self.ctx;
        let cs = self.cs;
        let run = self.runner;
        let attempts = self.ports.get(c"attemptRuntime")?;
        let boundary = c.get(c"boundaryErrorEnvelope")?;
        let kill = c.get(c"killReason")?;
        let code = c.get(c"code")?;
        let proxy = self.proxy_failure(c.get(c"completionOutcome")?)?;
        let facts = call(attempts, c"snapshot", &[self.session])?;
        let side_effects = self.invoke(c"turnHasSideEffects", &[cs])?.truthy()?
            || facts.optional(c"toolIntentObserved")?.truthy()?
            || facts.optional(c"sideEffectObserved")?.truthy()?;
        let error_only = boundary.truthy()?
            && boundary.get(c"body")?.nullish()?
            && facts.optional(c"replayFence")?.is_string("none")?
            && !side_effects;
        let partial = !error_only
            && (self.invoke(c"meaningfulTurnOutput", &[cs])?.truthy()?
                || facts.optional(c"visibleOutputObserved")?.truthy()?);
        let succeeded_fields = fields(
            cs,
            &[
                ("code", code),
                ("killReason", kill),
                ("boundaryErrorEnvelope", boundary),
            ],
        )?;
        if crate::chat_turn_effects::chat_clear_succeeded_errors(
            Env::from_raw(cs.env()),
            unknown(self.turn),
            unknown(run),
            unknown(cs),
            unknown(succeeded_fields),
        )? {
            let logger = self.ports.get(c"logger")?;
            let info = logger.get(c"info")?;
            if !info.nullish()? {
                info.call(
                    logger,
                    &[
                        text(cs, "chat_error_flags_cleared_after_success")?,
                        fields(
                            cs,
                            &[("sessionId", self.session), ("provider", cs.get(c"cli")?)],
                        )?,
                    ],
                )?;
            }
        }
        let guarded_facts = fields(
            cs,
            &[
                ("runnerKind", text(cs, "process")?),
                ("cli", cs.get(c"cli")?),
                ("isRetry", self.bool_prop(c, c"isRetry")?),
                ("hasOutput", has_output),
                ("killReason", kill),
                (
                    "retryBlockedByAdapterError",
                    flag(
                        cs,
                        cs.get(c"_adapterError")?.truthy()?
                            || run.get(c"adapterError")?.truthy()?,
                    )?,
                ),
            ],
        )?;
        let handoff = frozen(
            "handoff",
            fields(cs, &[("handoff", self.record.get(c"pendingCliHandoff")?)])?,
            null(cs)?,
        )?;
        let guarded = crate::chat_finalize::chat_is_guarded_handoff_failure(
            Env::from_raw(cs.env()),
            unknown(guarded_facts),
            unknown(handoff),
        )?;
        let classify = (!guarded || error_only)
            && (boundary.truthy()?
                || proxy.truthy()?
                || run.get(c"apiErrorRaw")?.truthy()?
                || run.get(c"sawApiError")?.truthy()?
                || run.get(c"adapterError")?.truthy()?
                || cs.get(c"_codexTransportError")?.truthy()?
                || kill.truthy()?
                || !code.is_number(0.0)?
                || (!self.turn.get(c"resultDurable")?.truthy()? && !has_output.truthy()?));
        let raw = if kill.truthy()? {
            fields(
                cs,
                &[
                    ("source", text(cs, "process_stderr")?),
                    ("provider", cs.get(c"cli")?),
                    ("code", kill),
                    ("message", text(cs, "turn cancelled")?),
                ],
            )?
        } else if run.get(c"modelTimeoutStopping")?.truthy()? && proxy.truthy()? {
            proxy
        } else if boundary.truthy()? {
            boundary
        } else {
            let opencode = self.invoke(
                c"opencodeProcessError",
                &[
                    cs.get(c"cli")?,
                    run.get(c"apiErrorRaw")?,
                    c.get(c"stderrBuf")?,
                ],
            )?;
            either(opencode, || {
                either(run.get(c"apiErrorRaw")?, || {
                    either(proxy, || {
                        fields(
                            cs,
                            &[
                                ("source", text(cs, "process_stderr")?),
                                ("provider", cs.get(c"cli")?),
                                (
                                    "code",
                                    if code.is_number(0.0)? {
                                        text(cs, "empty_exit")?
                                    } else {
                                        cat(cs, &[text(cs, "process_exit_")?, code])?
                                    },
                                ),
                                (
                                    "message",
                                    either(transport, || {
                                        fallback(stderr, "provider returned no result".into())
                                    })?,
                                ),
                            ],
                        )
                    })
                })
            })?
        };
        let decision = if classify {
            self.invoke(
                c"evaluateTurnApiError",
                &[fields(
                    cs,
                    &[
                        ("sessionName", self.session),
                        ("cs", cs),
                        ("persisted", self.record),
                        ("turn", self.turn),
                        ("runner", run),
                        ("raw", raw),
                        (
                            "attempt",
                            fallback(run.get(c"apiRetryAttempt")?, V::Number(0.0))?,
                        ),
                        (
                            "phase",
                            text(
                                cs,
                                if partial || side_effects {
                                    "stream"
                                } else {
                                    "before_first_token"
                                },
                            )?,
                        ),
                        ("partialOutput", flag(cs, partial)?),
                        ("sideEffects", flag(cs, side_effects)?),
                        ("deferNotice", self.ports.get(c"autoTurn")?.get(c"enabled")?),
                    ],
                )?],
            )?
        } else {
            null(cs)?
        };
        Ok((decision, facts, error_only))
    }
    fn auto_route(&self, decision: L<'a>, facts: L<'a>) -> Result<(L<'a>, L<'a>, L<'a>)> {
        let cs = self.cs;
        let auto = self.ports.get(c"autoTurn")?;
        let deferred = cs.get(c"cli")?.is_string("codex")?
            && cs.get(c"_codexPendingStreamError")?.truthy()?
            || cs.get(c"cli")?.is_string("opencode")?
                && decision.truthy()?
                && decision.get(c"action")?.is_string("fail_fast")?
                && (decision.get(c"reason")?.is_string("unsafe_failure_phase")?
                    || decision
                        .get(c"reason")?
                        .is_string("unsafe_replay_boundary")?)
                && (decision
                    .get(c"error")?
                    .optional(c"category")?
                    .is_string("network")?
                    || decision
                        .get(c"error")?
                        .optional(c"category")?
                        .is_string("timeout")?);
        let failover = if decision.truthy()? && !deferred {
            call(auto, c"failover", &[decision, facts])?
        } else {
            null(cs)?
        };
        let handoff = if decision.truthy()?
            && !deferred
            && !failover.optional(c"invocationOptions")?.truthy()?
        {
            let prepare = auto.get(c"prepareHandoff")?;
            if prepare.nullish()? {
                null(cs)?
            } else {
                fallback(prepare.call(auto, &[decision, facts])?, V::Null)?
            }
        } else {
            null(cs)?
        };
        let effective = either(failover.optional(c"decision")?, || Ok(decision))?;
        if failover.optional(c"invocationOptions")?.truthy()? {
            self.warning(cat(
                cs,
                &[
                    text(cs, "Auto Provider：")?,
                    failover.get(c"fromProviderName")?,
                    text(cs, " 不可用，正在切换到 ")?,
                    failover.get(c"toProviderName")?,
                    text(cs, "。")?,
                ],
            )?)?;
        } else if auto.get(c"enabled")?.truthy()? && decision.truthy()? && !deferred {
            let message = crate::api_error_policy::api_error_retry_notice(
                Env::from_raw(cs.env()),
                unknown(effective),
            )?;
            self.warning(L::from_raw(cs.env(), message))?;
        }
        Ok((failover, handoff, effective))
    }

    fn plan(&self) -> Result<L<'a>> {
        let p = self.cs;
        let c = self.ctx;
        let r = self.runner;
        let (diag, transport, stderr) = self.diagnose()?;
        let output = diag.get(c"hasTurnOutput")?;
        let (api, attempt_facts, error_only) = self.classify(output, transport, stderr)?;
        let (failover, handoff, effective) = self.auto_route(api, attempt_facts)?;
        let checkpoint = self.invoke(c"assistantCheckpointKey", &[p])?;
        let same = crate::chat_turn_effects::chat_has_partial_checkpoint(
            Env::from_raw(p.env()),
            unknown(r),
            unknown(checkpoint),
        )?;
        let plan_facts = fields(
            p,
            &[
                ("completion", c.get(c"completionOutcome")?),
                ("current", flag(p, true)?),
                ("runnerKind", text(p, "process")?),
                ("cli", p.get(c"cli")?),
                ("code", c.get(c"code")?),
                ("signal", c.get(c"signal")?),
                ("killReason", c.get(c"killReason")?),
                (
                    "apiError",
                    flag(p, effective.truthy()? || r.get(c"sawApiError")?.truthy()?)?,
                ),
                ("apiErrorDecision", effective),
                ("autoHandoffReserved", flag(p, handoff.truthy()?)?),
                ("replaySafeProviderError", flag(p, error_only)?),
                ("adapterError", self.bool_prop(r, c"adapterError")?),
                (
                    "retryBlockedByAdapterError",
                    self.bool_prop(p, c"_adapterError")?,
                ),
                ("retryPlanned", self.bool_prop(r, c"retryPlanned")?),
                ("resultEvent", self.bool_prop(r, c"resultEvent")?),
                (
                    "resultDurable",
                    self.bool_prop(self.turn, c"resultDurable")?,
                ),
                ("hasOutput", output),
                ("sameDurablePartial", flag(p, same)?),
                ("isRetry", self.bool_prop(c, c"isRetry")?),
                ("recoveredTransport", diag.get(c"recoveredCodexDisconnect")?),
                ("pendingStreamError", p.get(c"_codexPendingStreamError")?),
                (
                    "nativeSession",
                    self.bool_prop(self.record, c"cliSessionId")?,
                ),
                (
                    "codexDisconnectAttempt",
                    fallback(p.get(c"_codexStreamContinuationCount")?, V::Number(0.0))?,
                ),
                (
                    "apiNetworkContinueAttempt",
                    fallback(p.get(c"_apiNetworkContinueCount")?, V::Number(0.0))?,
                ),
                (
                    "freshStartAttempt",
                    num(
                        p,
                        if c.get(c"isRetry")?.truthy()? {
                            1.0
                        } else {
                            0.0
                        },
                    )?,
                ),
                ("handoff", self.record.get(c"pendingCliHandoff")?),
            ],
        )?;
        let plan = frozen(
            "plan",
            plan_facts,
            fields(
                p,
                &[("retry", fields(p, &[("limits", c.get(c"retryLimits")?)])?)],
            )?,
        )?;
        fields(
            p,
            &[
                ("finalizePlan", plan),
                ("apiErrorDecision", api),
                ("autoFailover", failover),
                ("autoHandoffPreparation", handoff),
                ("pendingTransportError", transport),
                ("sanitizedStderrTail", stderr),
            ],
        )
    }
}

#[napi]
pub fn chat_plan_process_close(
    env: Env,
    ports: Unknown<'_>,
    ctx: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(Close::new(L::new(&env, ports), L::new(&env, ctx))?
        .plan()?
        .raw())
}

mod execute;

/// 只处理仍归属当前回合的进程。剩余的标准输出行与完成证据必须先冲刷，
/// 交给历史写入端口后，调用者才可以运行 plan。
#[napi]
pub fn chat_observe_process_exit(
    env: Env,
    ports: Unknown<'_>,
    ctx: Unknown<'_>,
    state: Unknown<'_>,
) -> Result<bool> {
    let c = L::new(&env, ctx);
    let h = Close::new(L::new(&env, ports), c)?;
    let p = h.cs;
    let st = L::new(&env, state);
    call(
        h.ports.get(c"providers")?,
        c"releaseCodexProxyConfig",
        &[st.get(c"childEnv")?],
    )?;
    let signal = c.get(c"signal")?;
    let code = c.get(c"code")?;
    if !st.get(c"isActiveProc")?.call_plain(&[])?.truthy()? {
        let msg = cat(
            p,
            &[
                text(p, "[multicc/chat] [")?,
                h.session,
                text(p, "] stale proc pid=")?,
                st.get(c"proc")?.get(c"pid")?,
                text(p, " closed after replacement (code=")?,
                code,
                text(p, ", signal=")?,
                fallback(signal, "".into())?,
                text(p, ")")?,
            ],
        )?;
        call(p.global()?.get(c"console")?, c"log", &[msg])?;
        return Ok(false);
    }
    if call(p.get(c"lineBuf")?, c"trim", &[])?.truthy()? {
        p.catch(|| st.get(c"handleLine")?.call_plain(&[p.get(c"lineBuf")?]))?;
    }
    p.assign(c"lineBuf", text(p, "")?)?;
    let tail = st.get(c"stderrPending")?;
    if call(tail, c"trim", &[])?.truthy()?
        && !crate::api_error_policy::api_error_is_known_harmless_stderr_line(
            Env::from_raw(p.env()),
            unknown(tail),
        )?
    {
        st.assign(
            c"stderrBuf",
            cat(
                p,
                &[
                    st.get(c"stderrBuf")?,
                    st.get(c"stderrPending")?,
                    text(p, "\n")?,
                ],
            )?,
        )?;
    }
    st.assign(c"stderrPending", text(p, "")?)?;
    let duration =
        call(p.global()?.get(c"Date")?, c"now", &[])?.number()? - st.get(c"spawnTs")?.number()?;
    c.assign(c"durMs", num(p, duration)?)?;
    let kill = fallback(h.runner.get(c"killReason")?, V::Null)?;
    c.assign(c"killReason", kill)?;
    let boundary = fields(
        p,
        &[
            ("kind", text(p, "process")?),
            ("code", code),
            ("signal", signal),
            ("killReason", kill),
        ],
    )?;
    let completion = crate::cli_completion::adapter::cli_settle_adapter_completion(
        Env::from_raw(p.env()),
        unknown(h.runner),
        unknown(boundary),
        unknown(h.ports.get(c"logger")?),
        unknown(h.ports.get(c"assignHostProperty")?),
    )?;
    c.assign(c"completionOutcome", L::from_raw(p.env(), completion))?;
    let provider = || {
        either(h.ports.get(c"provider")?.optional(c"name")?, || {
            p.get(c"cli")
        })
    };
    let attempt = h.runner.get(c"providerAttempt")?;
    let name = provider()?;
    let parsed = crate::chat_events::chat_claude_boundary_envelope(
        Env::from_raw(p.env()),
        unknown(h.runner),
        unknown(provider()?),
        unknown(p),
    )?;
    let envelope = crate::turn_engine::events::reconcile(
        h.ports,
        &mut [
            h.ports.get(c"attemptRuntime")?,
            attempt,
            name,
            p,
            L::from_raw(p.env(), parsed),
        ],
    )?;
    c.assign(c"boundaryErrorEnvelope", envelope)?;
    Ok(true)
}
