//! Commit the notice, durable state and unattended handoff in their original order.
use super::*;
impl<'a> Transition<'a> {
    fn chat_text(&self, message: L<'a>) -> Result<L<'a>> {
        if self.ctx.get(c"isTerminal")?.truthy()? {
            Ok(message)
        } else {
            joined(self.p, &[text(self.p, "[Chat] ")?, message])
        }
    }
    fn notify(&self, notice: L<'a>) -> Result<()> {
        let p = self.p;
        if self.ctx.get(c"isTerminal")?.truthy()? {
            port(p, c"terminalBroadcast", &[self.id, notice])?;
        } else {
            port(p, c"chatBroadcast", &[self.name, notice])?;
        }
        let dir = call(p.get(c"persistedSessions")?, c"get", &[self.name])?.optional(c"dirId")?;
        if dir.truthy()? {
            let copy = crate::js_live::spread(notice)?;
            copy.set(c"sessionId", self.id)?;
            port(p, c"workspaceBroadcast", &[dir, copy])?;
        }
        Ok(())
    }
    fn push(
        &self,
        kind: L<'a>,
        msg: L<'a>,
        options: L<'a>,
        can_hold: bool,
        assistant: L<'a>,
    ) -> Result<L<'a>> {
        let p = self.p;
        let hold = can_hold
            && p.catch(|| {
                let host = port(p, c"getUnattendedHost", &[])?;
                if !host.truthy()?
                    || host.get(c"shouldHoldPush")?.kind()? != sys::ValueType::napi_function
                {
                    return Ok(false);
                }
                call(
                    host,
                    c"shouldHoldPush",
                    &[self.name, fields(p, &[("assistantText", assistant)])?],
                )?
                .truthy()
            })?
            .unwrap_or(false);
        let msg = self.chat_text(msg)?;
        let f = p.get(c"triggerPush")?;
        if hold {
            call(f, c"bind", &[undef(p)?, self.id, kind, msg, options])
        } else {
            f.call_plain(&[self.id, kind, msg, options])?;
            null(p)
        }
    }
    fn unattended(&self, details: L<'a>) -> Result<()> {
        let p = self.p;
        p.catch(|| {
            let host = port(p, c"getUnattendedHost", &[])?;
            if !host.nullish()? && !host.get(c"onTurnEnd")?.nullish()? {
                call(host, c"onTurnEnd", &[self.name, details])?;
            }
            Ok(())
        })?;
        Ok(())
    }
    pub(super) fn success(&self, substate: L<'a>, task: L<'a>) -> Result<()> {
        let p = self.p;
        let dismissed = self
            .result
            .get(c"evidence")?
            .is_string("user_dismissed_question")?;
        let msg = if dismissed {
            text(p, "待回答问题已标记为已处理")?
        } else if self.goal.truthy()? {
            joined(p, &[text(p, "执行成功：")?, self.goal])?
        } else {
            text(p, "执行成功")?
        };
        let code = crate::task_short_code::current_code(p.get(c"shortCodes")?, task)?;
        let state = text(p, "succeeded")?;
        let notice = fields(
            p,
            &[
                ("type", text(p, "notify")?),
                ("state", state),
                ("classifyState", self.state),
                ("message", msg),
                ("goalState", substate),
                ("taskShortCode", code),
                ("taskGoal", empty(self.goal)?),
                (
                    "voiceMessage",
                    if dismissed {
                        msg
                    } else {
                        voice(code, self.goal)?
                    },
                ),
            ],
        )?;
        let assistant = empty(self.cs.optional(c"currentAssistantText")?)?;
        let later = if dismissed {
            null(p)?
        } else {
            self.push(
                state,
                msg,
                fields(p, &[("classifyState", self.state), ("goalState", substate)])?,
                true,
                assistant,
            )?
        };
        self.notify(notice)?;
        port(
            p,
            c"setSessionStatus",
            &[self.name, fields(p, &[("status", state)])?],
        )?;
        persist(
            p,
            self.name,
            fields(
                p,
                &[
                    ("classifyState", self.state),
                    ("goalState", substate),
                    ("endedAt", now(p)?),
                    ("activeTurnId", null(p)?),
                ],
            )?,
        )?;
        call(
            port(p, c"getWaitInjector", &[])?,
            c"resetAuto",
            &[self.name],
        )?;
        call(
            port(p, c"getWaitInjector", &[])?,
            c"resetInterrupted",
            &[self.name],
        )?;
        self.unattended(fields(
            p,
            &[
                ("kind", text(p, "settle")?),
                ("settle", self.state),
                ("turnId", self.turn),
                ("assistantText", assistant),
                ("fallbackPush", later),
            ],
        )?)
    }
    fn fault(&self) -> Result<()> {
        let p = self.p;
        let decision = || self.cs.optional(c"_lastApiErrorDecision");
        if !decision()?.truthy()? {
            let reason = self.ctx.get(c"killReason")?;
            let (source, code, msg) = if reason.truthy()? {
                (
                    "host_interruption",
                    reason,
                    joined(
                        p,
                        &[text(p, "本轮被主机侧中断（原因：")?, reason, text(p, "）")?],
                    )?,
                )
            } else {
                (
                    "classifier_legacy",
                    null(p)?,
                    text(
                        p,
                        "本轮结束时未取得结构化错误证据（无提供方错误文本，也无主机侧中断原因）",
                    )?,
                )
            };
            let raw = fields(
                p,
                &[
                    ("source", text(p, source)?),
                    (
                        "provider",
                        fallback(self.record.optional(c"cli")?, "unknown".into())?,
                    ),
                    ("code", code),
                    ("message", msg),
                ],
            )?;
            let facts = fields(
                p,
                &[
                    ("sessionName", self.name),
                    ("cs", self.cs),
                    ("persisted", self.record),
                    ("turn", self.cs.optional(c"_activeTurn")?),
                    ("runner", self.cs.optional(c"_activeRunner")?),
                    ("raw", raw),
                    (
                        "attempt",
                        fallback(self.cs.optional(c"_apiRetryAttempt")?, 0.0.into())?,
                    ),
                    ("phase", text(p, "stream")?),
                    ("partialOutput", flag(p, true)?),
                    ("sideEffects", port(p, c"turnHasSideEffects", &[self.cs])?),
                ],
            )?;
            port(p, c"evaluateTurnApiError", &[facts])?;
        }
        self.observation("api_error_classifier_observed")?;
        self.unattended(fields(
            p,
            &[
                ("kind", text(p, "fault")?),
                ("settle", self.state),
                ("turnId", self.turn),
                ("killReason", empty(self.ctx.get(c"killReason")?)?),
                (
                    "retryScheduled",
                    flag(p, decision()?.optional(c"action")?.is_string("retry")?)?,
                ),
                (
                    "handoffPending",
                    flag(p, self.ctx.get(c"handoffPending")?.is_true()?)?,
                ),
                ("faultCategory", empty(decision()?.optional(c"category")?)?),
            ],
        )?)
    }
    pub(super) fn waiting(&self, processing: bool) -> Result<()> {
        let p = self.p;
        let err = self.state.is_string("E")?;
        let cancelled = self.cancel.truthy()?;
        if err && !cancelled {
            self.fault()?;
        }
        let cls = if processing {
            text(p, "W")?
        } else {
            self.state
        };
        let table = p.get(c"display")?;
        let display = or(table.get_key(cls)?, || table.get(c"W"))?;
        let kind = fallback(display.get(c"pushType")?, "waiting".into())?;
        let decision = self.cs.optional(c"_lastApiErrorDecision")?;
        let retry = if err && decision.truthy()? {
            port(p, c"retryNotice", &[decision])?
        } else {
            text(p, "")?
        };
        let msg = if cancelled {
            if self.cancel.get(c"runnerStopped")?.is_false()? {
                text(p, "取消失败：任务未能停止")?
            } else if self.cancel.get(c"superseded")?.is_true()? {
                text(p, "已切换到立即发送的消息")?
            } else if self.goal.truthy()? {
                joined(p, &[text(p, "已取消：")?, self.goal])?
            } else {
                text(p, "任务已取消")?
            }
        } else if err {
            fallback(retry, "API 异常，未自动重试".into())?
        } else if self.goal.truthy()? {
            let label = if self.state.is_string("B")? {
                display.get(c"label")?
            } else {
                text(p, "等待")?
            };
            joined(p, &[label, text(p, "：")?, self.goal])?
        } else if self.state.is_string("B")? {
            display.get(c"label")?
        } else {
            text(p, "等待交互")?
        };
        let options = fields(p, &[("classifyState", cls)])?;
        if err {
            let category = decision.optional(c"category")?;
            if category.truthy()? {
                options.set(c"errorCategory", category)?;
            }
        }
        let assistant = empty(self.cs.optional(c"currentAssistantText")?)?;
        let wait = self.state.is_string("W")?;
        let later = if cancelled {
            null(p)?
        } else {
            self.push(kind, msg, options, wait, assistant)?
        };
        self.notify(fields(
            p,
            &[
                ("type", text(p, "notify")?),
                ("state", kind),
                ("classifyState", cls),
                ("message", msg),
            ],
        )?)?;
        port(
            p,
            c"setSessionStatus",
            &[
                self.name,
                fields(p, &[("status", display.get(c"cardStatus")?)])?,
            ],
        )?;
        let patch = fields(
            p,
            &[
                ("classifyState", cls),
                ("goalState", null(p)?),
                ("endedAt", now(p)?),
                ("turnId", nil(self.turn)?),
                ("activeTurnId", null(p)?),
            ],
        )?;
        if cancelled {
            patch.set(c"cancelledAt", or(self.cancel.get(c"at")?, || now(p))?)?;
            patch.set(
                c"cancelReason",
                fallback(self.cancel.get(c"reason")?, "user_cancelled".into())?,
            )?;
            patch.set(
                c"cancelSource",
                fallback(self.cancel.get(c"source")?, "manual_cancel".into())?,
            )?;
            patch.set(c"cancelOperationId", nil(self.cancel.get(c"operationId")?)?)?;
            patch.set(
                c"cancelSuperseded",
                flag(p, self.cancel.get(c"superseded")?.is_true()?)?,
            )?;
            patch.set(
                c"supersededByEntryId",
                nil(self.cancel.get(c"supersededByEntryId")?)?,
            )?;
        }
        persist(p, self.name, patch)?;
        if wait {
            call(
                port(p, c"getWaitInjector", &[])?,
                c"resetAuto",
                &[self.name],
            )?;
        }
        if cancelled {
            let source = self.cancel.get(c"source")?;
            let reason = self.cancel.get(c"reason")?;
            let fault = if source.is_string("preparation_failed")?
                || reason.is_string("preparation_failed")?
            {
                "preparation_failed"
            } else {
                ""
            };
            self.unattended(fields(
                p,
                &[
                    ("kind", text(p, "cancel")?),
                    ("settle", cls),
                    ("turnId", self.turn),
                    ("cancelSource", fallback(source, "manual_cancel".into())?),
                    ("killReason", empty(reason)?),
                    ("faultCategory", text(p, fault)?),
                ],
            )?)?;
        } else if wait {
            self.unattended(fields(
                p,
                &[
                    ("kind", text(p, "settle")?),
                    ("settle", cls),
                    ("turnId", self.turn),
                    ("assistantText", assistant),
                    ("fallbackPush", later),
                ],
            )?)?;
        }
        Ok(())
    }
}
