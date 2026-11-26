//! 一个已规划的关闭动作只执行一次。延迟重试的回调持有该次 runner 的
//! V8 上下文，准备或启动失败时走同一份受阻收尾计划。
use super::*;
use crate::host_methods::method;

struct Execution<'a> {
    close: Close<'a>,
    outcome: L<'a>,
    plan: L<'a>,
}
impl<'a> Execution<'a> {
    fn new(ports: L<'a>, ctx: L<'a>, outcome: L<'a>) -> Result<Self> {
        Ok(Self {
            close: Close::new(ports, ctx)?,
            outcome,
            plan: outcome.get(c"finalizePlan")?,
        })
    }
    fn from_owner(owner: L<'a>) -> Result<Self> {
        Self::new(
            owner.get(c"ports")?,
            owner.get(c"ctx")?,
            owner.get(c"outcome")?,
        )
    }
    fn stop(&self) -> Result<()> {
        let h = &self.close;
        call(
            h.ports.get(c"turnProgressHeartbeat")?,
            c"stop",
            &[h.session, h.turn.get(c"turnId")?],
        )?;
        Ok(())
    }
    fn finish_attempt(&self, outcome: &str, default: V, reason: L<'a>) -> Result<()> {
        let h = &self.close;
        let category = self
            .outcome
            .get(c"apiErrorDecision")?
            .optional(c"error")?
            .optional(c"category")?;
        h.invoke(
            c"finishProviderAttempt",
            &[
                h.runner,
                text(h.cs, outcome)?,
                fields(
                    h.cs,
                    &[
                        ("errorCategory", fallback(category, default)?),
                        ("reasonCode", reason),
                    ],
                )?,
            ],
        )?;
        Ok(())
    }
    fn final_context(&self, supervised: Option<bool>) -> Result<L<'a>> {
        let h = &self.close;
        let c = fields(
            h.cs,
            &[
                ("runnerKind", text(h.cs, "process")?),
                ("sessionName", h.session),
                ("cs", h.cs),
                ("persisted", h.record),
                ("turn", h.turn),
                ("runner", h.runner),
            ],
        )?;
        if let Some(supervised) = supervised {
            c.assign(c"autoProviderHandoffPending", flag(c, supervised)?)?;
        }
        for (key, value) in [
            (c"code", h.ctx.get(c"code")?),
            (c"signal", h.ctx.get(c"signal")?),
            (c"stderrTail", self.outcome.get(c"sanitizedStderrTail")?),
            (
                c"pendingTransportError",
                self.outcome.get(c"pendingTransportError")?,
            ),
        ] {
            c.assign(key, value)?;
        }
        Ok(c)
    }
    fn blocked(&self, error: napi::Error) -> Result<()> {
        let h = &self.close;
        let p = h.cs;
        let error = if let Some(original) = p.exception_value()? {
            original
        } else {
            p.global()?
                .get(c"Error")?
                .construct(&[text(p, &error.reason)?])?
        };
        h.runner.assign(c"retryPlanned", flag(p, false)?)?;
        let attempt = h.runner.get(c"providerAttempt")?;
        let code = fallback(error.optional(c"code")?, "attempt_prepare_failed".into())?;
        call(
            h.ports.get(c"logger")?,
            c"warn",
            &[
                text(p, "provider_attempt_retry_blocked")?,
                fields(
                    p,
                    &[
                        ("sessionId", h.session),
                        (
                            "providerId",
                            if attempt.truthy()? {
                                attempt.get(c"providerId")?
                            } else {
                                attempt
                            },
                        ),
                        (
                            "routeAttemptId",
                            if attempt.truthy()? {
                                attempt.get(c"routeAttemptId")?
                            } else {
                                attempt
                            },
                        ),
                        ("code", code),
                    ],
                )?,
            ],
        )?;
        let blocked = frozen(
            "retryBlocked",
            self.plan,
            fields(
                p,
                &[
                    ("retryUnavailableReason", code),
                    ("handoff", h.record.get(c"pendingCliHandoff")?),
                ],
            )?,
        )?;
        self.stop()?;
        let result = call(
            h.ports.get(c"turnFinalizationExecutor")?,
            c"execute",
            &[blocked, self.final_context(None)?],
        )?;
        let env = Env::from_raw(p.env());
        let owner = fields(
            p,
            &[
                ("logger", h.ports.get(c"logger")?),
                ("session", h.session),
                ("turn", h.turn),
            ],
        )?;
        let failed = method(&env, owner, "", 1, 1, |o, a| {
            let message = fallback(a[0].optional(c"message")?, "finalization failed".into())?;
            call(
                o.get(c"logger")?,
                c"error",
                &[
                    text(o, "chat_stream_finalize_failed")?,
                    fields(
                        o,
                        &[
                            ("sessionId", o.get(c"session")?),
                            ("turnId", o.get(c"turn")?.get(c"turnId")?),
                            ("message", message),
                        ],
                    )?,
                ],
            )
        })?;
        call(
            call(p.global()?.get(c"Promise")?, c"resolve", &[result])?,
            c"catch",
            &[failed],
        )?;
        Ok(())
    }
    fn spawn(
        &self,
        options: L<'a>,
        attempt: Option<L<'a>>,
        announce: impl FnOnce() -> Result<()>,
    ) -> Result<L<'a>> {
        let h = &self.close;
        let prepared = match h.invoke(c"prepareInvocation", &[options]) {
            Ok(value) => value,
            Err(error) => {
                self.blocked(error)?;
                return null(h.cs);
            }
        };
        if attempt.is_none() && !prepared.truthy()? {
            return null(h.cs);
        }
        announce()?;
        let mut args = vec![prepared, flag(h.cs, true)?];
        if let Some(attempt) = attempt {
            args.push(attempt);
        }
        match h.invoke(c"spawnChat", &args) {
            Ok(proc) => {
                if attempt.is_none() {
                    h.cs.assign(c"claudeProc", proc)?;
                }
                Ok(proc)
            }
            Err(error) => {
                self.blocked(error)?;
                null(h.cs)
            }
        }
    }
    fn reset_stream(&self) -> Result<()> {
        let cs = self.close.cs;
        cs.assign(c"isStreaming", flag(cs, true)?)?;
        cs.assign(
            c"lastStreamAt",
            call(cs.global()?.get(c"Date")?, c"now", &[])?,
        )?;
        Ok(())
    }
    fn continuation(&self, codex: bool) -> Result<()> {
        let h = &self.close;
        let cs = h.cs;
        let (counter, key, reason) = if codex {
            (
                c"_codexStreamContinuationCount",
                c"codexStreamDisconnectContinuePrompt",
                "codex_transport_continuation",
            )
        } else {
            (
                c"_apiNetworkContinueCount",
                c"apiNetworkContinuePrompt",
                "api_network_continuation",
            )
        };
        cs.assign(counter, self.plan.get(c"retry")?.get(c"attempt")?)?;
        if codex {
            cs.assign(c"_codexRecoveredDisconnect", flag(cs, false)?)?;
            cs.assign(c"_codexPendingStreamError", text(cs, "")?)?;
            cs.assign(c"_codexPendingStreamErrorCount", num(cs, 0.0)?)?;
        }
        self.reset_stream()?;
        let options = fields(
            cs,
            &[
                ("bareText", h.invoke(key, &[])?),
                ("firstTurn", flag(cs, false)?),
                ("continuation", flag(cs, true)?),
                ("reasonCode", text(cs, reason)?),
            ],
        )?;
        options.spread_from(h.direct_retry_options()?)?;
        self.finish_attempt("failed", "retry".into(), options.get(c"reasonCode")?)?;
        self.spawn(options, None, || {
            let (prefix, limit, log) = if codex {
                (
                    if h.invoke(c"isGlm52Session", &[h.record])?.truthy()? {
                        "正在使用 GLM-5.2 最高档：检测到连接中断，正在自动续跑剩余任务（"
                    } else {
                        "检测到 Codex 连接中断，正在自动续跑剩余任务（"
                    },
                    c"codexDisconnect",
                    "] auto-continuing codex after response.completed disconnect #",
                )
            } else {
                (
                    "网络中断，正在原线路续跑剩余任务（",
                    c"apiNetworkContinue",
                    "] network api error, continuing #",
                )
            };
            h.warning(cat(
                cs,
                &[
                    text(cs, prefix)?,
                    cs.get(counter)?,
                    text(cs, "/")?,
                    h.ctx.get(c"retryLimits")?.get(limit)?,
                    text(cs, "）。")?,
                ],
            )?)?;
            h.invoke(
                c"setSessionStatus",
                &[
                    h.session,
                    fields(
                        cs,
                        &[("status", text(cs, "running")?), ("currentFile", null(cs)?)],
                    )?,
                ],
            )?;
            call(
                cs.global()?.get(c"console")?,
                c"warn",
                &[cat(
                    cs,
                    &[
                        text(cs, "[multicc/chat] [")?,
                        h.session,
                        text(cs, log)?,
                        cs.get(counter)?,
                    ],
                )?],
            )?;
            h.runner.assign(c"retryPlanned", flag(cs, true)?)
        })?;
        Ok(())
    }
    fn fresh(&self) -> Result<()> {
        let h = &self.close;
        let p = h.cs;
        let tail = call(
            call(h.ctx.get(c"stderrBuf")?, c"slice", &[num(p, -300.0)?])?,
            c"trim",
            &[],
        )?;
        let tail_text = tail.coerce_string()?.to_string_lossy();
        let reason = if self.outcome.get(c"pendingTransportError")?.truthy()? {
            text(p, "codex transport disconnected")?
        } else if tail_text.contains("already in use") {
            text(p, "session-id conflict")?
        } else if tail_text.contains("No conversation found")
            || tail_text.contains("session not found")
        {
            text(p, "resume target missing")?
        } else {
            let signal = h.ctx.get(c"signal")?;
            let mut pieces = vec![text(p, "exit ")?, h.ctx.get(c"code")?];
            if signal.truthy()? {
                pieces.extend([text(p, "/")?, signal]);
            }
            cat(p, &pieces)?
        };
        call(
            h.ports.get(c"logger")?,
            c"warn",
            &[
                text(p, "chat_empty_exit_fresh_retry")?,
                fields(
                    p,
                    &[
                        ("sessionId", h.session),
                        ("provider", p.get(c"cli")?),
                        ("reason", reason),
                        ("stderr", h.invoke(c"sanitizeApiErrorMessage", &[tail])?),
                    ],
                )?,
            ],
        )?;
        h.record.assign(
            c"cliSessionId",
            if p.get(c"cli")?.is_string("claude")? || p.get(c"cli")?.is_string("claude-exp")? {
                h.invoke(c"randomUUID", &[])?
            } else {
                null(p)?
            },
        )?;
        h.invoke(c"rememberActiveCliState", &[h.record])?;
        h.invoke(
            c"savePersistedSessionsBestEffort",
            &[text(p, "runtime.chat-session-retry-reset")?],
        )?;
        p.assign(c"chatTurnCount", num(p, 0.0)?)?;
        self.reset_stream()?;
        call(h.ports.get(c"replay")?, c"clear", &[h.session])?;
        p.assign(c"_codexTransportError", text(p, "")?)?;
        let options = fields(
            p,
            &[
                ("bareText", h.ctx.get(c"promptText")?),
                ("firstTurn", flag(p, true)?),
                ("reasonCode", text(p, "fresh_retry")?),
            ],
        )?;
        options.spread_from(h.direct_retry_options()?)?;
        self.finish_attempt("failed", "retry".into(), options.get(c"reasonCode")?)?;
        self.spawn(options, None, || {
            h.warning(cat(
                p,
                &[
                    p.get(c"cli")?,
                    text(p, " 启动失败（")?,
                    reason,
                    text(p, "），已用新会话重试")?,
                ],
            )?)?;
            h.runner.assign(c"retryPlanned", flag(p, true)?)
        })?;
        Ok(())
    }
    fn retry_api(&self) -> Result<()> {
        let h = &self.close;
        let p = h.cs;
        let env = Env::from_raw(p.env());
        p.assign(c"claudeProc", null(p)?)?;
        self.finish_attempt(
            "failed",
            "api_error".into(),
            text(p, "api_retry_scheduled")?,
        )?;
        let retry = self.plan.get(c"retry")?;
        if retry.optional(c"poolExhausted")?.is_true()? {
            h.warning(text(p, "Auto 候选池已耗尽，仍在原线路重试。")?)?;
        }
        let state = fields(
            p,
            &[
                ("ports", h.ports),
                ("ctx", h.ctx),
                ("outcome", self.outcome),
            ],
        )?;
        let start = method(&env, state, "start", 0, 0, |o, _| {
            let exec = Execution::from_owner(o)?;
            let h = &exec.close;
            let options = exec
                .outcome
                .get(c"autoFailover")?
                .optional(c"invocationOptions")?;
            let options = if options.truthy()? {
                options
            } else {
                let options = fields(h.cs, &[("reasonCode", text(h.cs, "same_provider_retry")?)])?;
                options.spread_from(h.direct_retry_options()?)?;
                options
            };
            exec.spawn(
                options,
                Some(exec.plan.get(c"retry")?.get(c"attempt")?),
                || Ok(()),
            )
        })?;
        h.invoke(
            c"scheduleOwnedRetry",
            &[fields(
                p,
                &[
                    ("sessionName", h.session),
                    ("cs", p),
                    ("persisted", h.record),
                    ("turn", h.turn),
                    ("runner", h.runner),
                    ("decision", retry),
                    ("provider", p.get(c"cli")?),
                    ("start", start),
                ],
            )?],
        )?;
        Ok(())
    }
    fn run(&self) -> Result<L<'a>> {
        let h = &self.close;
        let p = h.cs;
        let action = self.plan.get(c"action")?;
        match action.coerce_string()?.to_string_lossy().as_str() {
            "continue-codex" => self.continuation(true)?,
            "continue-opencode" => self.continuation(false)?,
            "retry-fresh" => self.fresh()?,
            "retry-api" => self.retry_api()?,
            _ => {
                let code = h.ctx.get(c"code")?;
                let signal = h.ctx.get(c"signal")?;
                let mut pieces = vec![text(p, "closed_before_first_byte:code=")?, code];
                if signal.truthy()? {
                    pieces.extend([text(p, ":signal=")?, signal]);
                }
                call(
                    h.ports.get(c"turnTiming")?,
                    c"abort",
                    &[h.session, h.turn.get(c"turnId")?, cat(p, &pieces)?],
                )?;
                let success = crate::cli_completion::completed(h.ctx.get(c"completionOutcome")?)?
                    && h.turn.get(c"resultDurable")?.truthy()?
                    && !self.outcome.get(c"apiErrorDecision")?.truthy()?;
                if success {
                    call(
                        h.ports.get(c"autoTurn")?,
                        c"recordSuccess",
                        &[h.runner.get(c"providerAttempt")?],
                    )?;
                }
                self.finish_attempt(
                    if success { "succeeded" } else { "failed" },
                    V::Null,
                    action,
                )?;
                self.stop()?;
                let prep = self.outcome.get(c"autoHandoffPreparation")?;
                let supervised = prep.truthy()?
                    && h.invoke(c"getUnattendedState", &[h.session])?
                        .optional(c"status")?
                        .is_string("active")?;
                let pending = call(
                    h.ports.get(c"turnFinalizationExecutor")?,
                    c"execute",
                    &[self.plan, self.final_context(Some(supervised))?],
                )?;
                return fields(
                    p,
                    &[
                        ("pending", pending),
                        ("handoff", prep),
                        ("supervised", flag(p, supervised)?),
                    ],
                );
            }
        }
        null(p)
    }
}

#[napi]
pub fn chat_execute_process_close(
    env: Env,
    ports: Unknown<'_>,
    ctx: Unknown<'_>,
    outcome: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(Execution::new(
        L::new(&env, ports),
        L::new(&env, ctx),
        L::new(&env, outcome),
    )?
    .run()?
    .raw())
}

/// 生产进程在一次原生调用内规划并执行关闭；中间决策只在 Rust 内传递。
#[napi]
pub fn chat_finish_process_close(
    env: Env,
    ports: Unknown<'_>,
    ctx: Unknown<'_>,
) -> Result<sys::napi_value> {
    let ports = L::new(&env, ports);
    let ctx = L::new(&env, ctx);
    let close = Close::new(ports, ctx)?;
    let outcome = close.plan()?;
    let exec = Execution {
        close,
        outcome,
        plan: outcome.get(c"finalizePlan")?,
    };
    Ok(exec.run()?.raw())
}
