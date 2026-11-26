//! 启动前的可等待边界。只有宿主实际执行异步分支时才挂起当前轮次。
//! 消息持久化、消费输入确认、进入活动态都按同一个上下文继续推进。
use super::*;
use crate::turn_engine::runner_context::join;
use std::ffi::CStr;
struct Start<'a> {
    ports: L<'a>,
    ctx: L<'a>,
    session: L<'a>,
    record: L<'a>,
    turn: L<'a>,
    opts: L<'a>,
    request: L<'a>,
    id: L<'a>,
    message: L<'a>,
    preparation: L<'a>,
}
impl<'a> Start<'a> {
    fn new(ports: L<'a>, ctx: L<'a>) -> Result<Self> {
        Ok(Self {
            ports,
            ctx,
            session: ctx.get(c"sessionName")?,
            record: ctx.get(c"persisted")?,
            turn: ctx.get(c"turn")?,
            opts: ctx.get(c"opts")?,
            request: ctx.get(c"turnRequest")?,
            id: ctx.get(c"turnId")?,
            message: ctx.get(c"text")?,
            preparation: ctx.get(c"preparation")?,
        })
    }
    fn call(&self, name: &CStr, a: &[L<'a>]) -> Result<L<'a>> {
        self.ports.get(name)?.call_plain(a)
    }
    fn service(&self, key: &CStr, name: &CStr, a: &[L<'a>]) -> Result<L<'a>> {
        call(self.ports.get(key)?, name, a)
    }
    fn wait(&self, phase: &str, promise: L<'a>) -> Result<L<'a>> {
        self.ctx.set(c"phase", text(self.ctx, phase)?)?;
        fields(
            self.ctx,
            &[("waiting", flag(self.ctx, true)?), ("pending", promise)],
        )
    }
    fn fresh(&self) -> Result<bool> {
        Ok(!self.ctx.get(c"originContinue")?.truthy()?
            || self.ctx.get(c"directUserInput")?.truthy()?)
    }
    fn reset(&self) -> Result<L<'a>> {
        let s = self.ctx;
        if self.fresh()? {
            for op in [
                c"resetAuto",
                c"resetBg",
                c"resetInterrupted",
                c"resetBgResult",
            ] {
                self.service(c"waitInjector", op, &[self.session])?;
            }
        }
        if (self.request.get(c"cli")?.is_string("claude")?
            || self.request.get(c"cli")?.is_string("claude-exp")?)
            && !self.record.get(c"cliSessionId")?.truthy()?
        {
            self.record
                .assign(c"cliSessionId", self.call(c"randomUUID", &[])?)?;
            self.call(
                c"savePersistedSessionsBestEffort",
                &[text(s, "runtime.chat-session-id-allocate")?],
            )?;
        }
        let mut cs = s.get(c"cs")?;
        if !cs.truthy()? {
            let cli = self.record.get(c"cli")?;
            let cwd = self.call(c"cwdForSession", &[self.record])?;
            let history = s.get(c"initialHistory")?;
            let history = if history.truthy()? {
                history
            } else {
                self.call(c"viewChatHistory", &[self.session])?
            };
            cs = self.call(
                c"restoreLiveChatSession",
                &[self.session, cli, cwd, history],
            )?;
            s.assign(c"cs", cs)?;
        }
        if cs.truthy()?
            && self.record.get(c"workspaceState")?.is_string("awake")?
            && self.record.get(c"worktreePath")?.truthy()?
        {
            let cwd = self.call(c"cwdForSession", &[self.record])?;
            cs.assign(c"cwd", if cwd.truthy()? { cwd } else { cs.get(c"cwd")? })?;
        }
        self.call(c"cancelClassify", &[cs])?;
        if self.fresh()? {
            self.service(c"apiErrorHost", c"cancelRetry", &[self.session, cs])?;
            cs.assign(c"_apiRetryAttempt", num(s, 0.)?)?;
            cs.assign(c"_lastApiErrorDecision", null(s)?)?;
            self.call(
                c"setTaskState",
                &[
                    self.session,
                    fields(s, &[("apiError", null(s)?)])?,
                    fields(s, &[("save", flag(s, false)?)])?,
                ],
            )?;
        }
        let bound = bind_task(
            self.ports,
            &mut [
                cs,
                s.get(c"requestedTask")?,
                self.opts,
                self.turn,
                self.message,
                flag(
                    s,
                    !s.get(c"reexecutePersistedDelivery")?.truthy()? && self.fresh()?,
                )?,
            ],
        )?;
        s.set(c"bound", bound)?;
        if s.get(c"reexecutePersistedDelivery")?.truthy()?
            && s.get(c"deliveryPersisted")?.is_true()?
        {
            self.durable(flag(s, true)?)
        } else {
            let msg = user_message(
                self.ports,
                &mut [
                    bound,
                    self.message,
                    self.id,
                    fields(
                        s,
                        &[
                            ("clientMsgId", s.get(c"clientMsgId")?),
                            ("deliveryId", s.get(c"deliveryId")?),
                        ],
                    )?,
                    s.get(c"originDispatchId")?,
                    self.opts,
                    s.get(c"bgTaskIds")?,
                    s.get(c"bgToolUseIds")?,
                ],
            )?;
            self.wait(
                "append",
                self.call(c"appendChatMessage", &[self.session, msg])?,
            )
        }
    }
    fn durable(&self, saved: L<'a>) -> Result<L<'a>> {
        let s = self.ctx;
        let proof = self.call(
            c"createDurableMessageProof",
            &[self.request, fields(s, &[("persisted", saved)])?],
        )?;
        s.set(c"proof", proof)?;
        if !saved.truthy()? {
            self.preparation
                .assign(c"failure", text(s, "message-not-durable")?)?;
            let line = join(
                s,
                &[
                    text(s, "[multicc/chat] [")?,
                    self.session,
                    text(s, "] refusing turn: user message was not persisted")?,
                ],
            )?;
            call(s.global()?.get(c"console")?, c"error", &[line])?;
            self.call(
                c"chatBroadcast",
                &[
                    self.session,
                    fields(
                        s,
                        &[
                            ("type", text(s, "error")?),
                            (
                                "error",
                                text(s, "消息未能持久化，已安全停止本轮；系统稍后会重试。")?,
                            ),
                        ],
                    )?,
                ],
            )?;
            self.status("idle")?;
            return fields(s, &[("accepted", flag(s, false)?)]);
        }
        self.preparation.assign(c"messageDurable", flag(s, true)?)?;
        if self.opts.get(c"userInputRequestId")?.truthy()? {
            let host = self.ports.get(c"userInputSignalHost")?;
            let op = if host.get(c"resolveAsync")?.kind()? == sys::ValueType::napi_function {
                c"resolveAsync"
            } else {
                c"resolve"
            };
            let answer = call(
                host,
                op,
                &[self.session, self.opts.get(c"userInputRequestId")?],
            )?;
            if op == c"resolveAsync" {
                return self.wait("answer", answer);
            }
            self.check(
                answer,
                "user-input-resolution-rejected",
                "pending user input resolution rejected: ",
            )?;
        }
        self.begin()
    }
    fn check(&self, result: L<'a>, default: &str, prefix: &str) -> Result<()> {
        if !crate::js_iteration::read(result, c"ok")?.truthy()? {
            let failure = fallback(result.get(c"code")?, default.into())?;
            self.preparation.assign(c"failure", failure)?;
            let message = join(self.ctx, &[text(self.ctx, prefix)?, failure])?;
            return Err(self
                .ctx
                .global()?
                .get(c"Error")?
                .construct(&[message])?
                .throw_error());
        }
        Ok(())
    }
    fn begin(&self) -> Result<L<'a>> {
        let s = self.ctx;
        let marked = self.service(
            c"chatTurnPreparationRuntime",
            c"markMessageDurable",
            &[self.session, self.id],
        )?;
        self.check(
            marked,
            "message-proof-rejected",
            "turn message proof rejected: ",
        )?;
        let opts = fields(
            s,
            &[
                ("originContinue", flag(s, !self.fresh()?)?),
                ("turnId", self.id),
            ],
        )?;
        let host = self.ports.get(c"userInputSignalHost")?;
        if host.get(c"beginTurnAsync")?.kind()? == sys::ValueType::napi_function {
            return self.wait(
                "begin",
                call(host, c"beginTurnAsync", &[self.session, opts])?,
            );
        }
        call(host, c"beginTurn", &[self.session, opts])?;
        self.activate()
    }
    fn activate(&self) -> Result<L<'a>> {
        let s = self.ctx;
        let cs = s.get(c"cs")?;
        activate(
            self.ports,
            &mut [
                cs,
                self.session,
                self.message,
                s.get(c"bound")?,
                self.id,
                self.record,
            ],
        )?;
        self.preparation.assign(c"activated", flag(s, true)?)?;
        cs.assign(
            c"turnStartedAt",
            call(s.global()?.get(c"Date")?, c"now", &[])?,
        )?;
        self.service(c"turnTimeline", c"startTurn", &[self.session, cs])?;
        cs.assign(c"lastStreamAt", cs.get(c"turnStartedAt")?)?;
        self.service(c"replay", c"clear", &[self.session])?;
        cs.assign(c"_resultSaved", flag(s, false)?)?;
        self.call(
            c"chatBroadcast",
            &[
                self.session,
                fields(
                    s,
                    &[("type", text(s, "stream_start")?), ("turnId", self.id)],
                )?,
            ],
        )?;
        self.call(c"pruneTranscript", &[self.session, self.record])?;
        cs.assign(c"_adapterError", null(s)?)?;
        cs.assign(c"_sawApiError", flag(s, false)?)?;
        cs.assign(c"_activeTurn", self.turn)?;
        cs.assign(c"_activeRunner", null(s)?)?;
        let host = self.ports.get(c"userInputSignalHost")?;
        if host.get(c"activateTurnAsync")?.kind()? == sys::ValueType::napi_function {
            return self.wait(
                "activate",
                call(host, c"activateTurnAsync", &[self.session])?,
            );
        }
        self.finish()
    }
    fn status(&self, status: &str) -> Result<()> {
        self.call(
            c"setSessionStatus",
            &[
                self.session,
                fields(
                    self.ctx,
                    &[
                        ("status", text(self.ctx, status)?),
                        ("currentFile", null(self.ctx)?),
                    ],
                )?,
            ],
        )?;
        Ok(())
    }
    fn finish(&self) -> Result<L<'a>> {
        let s = self.ctx;
        let cs = s.get(c"cs")?;
        cs.assign(
            c"_continuationLineage",
            fields(
                s,
                &[
                    ("turnId", self.turn.get(c"turnId")?),
                    ("lineage", self.turn.get(c"lineage")?),
                ],
            )?,
        )?;
        self.service(
            c"turnProgressHeartbeat",
            c"start",
            &[
                self.session,
                self.turn.get(c"turnId")?,
                fields(s, &[("phase", text(s, "starting")?)])?,
            ],
        )?;
        self.call(c"resetRoleTokenUsage", &[self.session])?;
        cs.assign(c"_codexRecoveredDisconnect", flag(s, false)?)?;
        cs.assign(c"_codexPendingStreamError", text(s, "")?)?;
        cs.assign(c"_codexPendingStreamErrorCount", num(s, 0.)?)?;
        cs.assign(c"_codexTransportError", text(s, "")?)?;
        cs.assign(c"_apiNetworkContinueCount", num(s, 0.)?)?;
        cs.assign(c"_codexStreamContinuationCount", num(s, 0.)?)?;
        self.call(c"cancelClassify", &[cs])?;
        let pending = self
            .call(c"getTaskState", &[self.record])?
            .get(c"taskIdentityPending")?
            .is_true()?;
        let task = cs.get(c"currentTask")?;
        let goal = if task.truthy()? {
            cs.get(c"currentTask")?.get(c"goal")?
        } else {
            task
        };
        let notice = join(
            s,
            &[
                text(
                    s,
                    if pending {
                        "归类中："
                    } else {
                        "处理中："
                    },
                )?,
                fallback(goal, "新任务".into())?,
            ],
        )?;
        self.call(c"emitRunningNotify", &[self.session, notice])?;
        self.status("thinking")?;
        fields(
            s,
            &[("accepted", flag(s, true)?), ("proof", s.get(c"proof")?)],
        )
    }
}
pub(in crate::turn_engine) fn prepare<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let start = Start::new(ports, a[0])?;
    let phase = a[0].get(c"phase")?;
    if phase.undefined()? {
        return start.reset();
    }
    match phase.coerce_string()?.to_string_lossy().as_str() {
        "append" => start.durable(a[1]),
        "answer" => {
            start.check(
                a[1],
                "user-input-resolution-rejected",
                "pending user input resolution rejected: ",
            )?;
            start.begin()
        }
        "begin" => start.activate(),
        "activate" => start.finish(),
        _ => Err(ports.type_error("unknown turn preparation phase")),
    }
}
