//! Live session/port adapter for the core finalization executor. Contexts may
//! contain cyclic process handles, so only the immutable plan crosses the value
//! bridge. State, callback receivers and runner identity remain live handles.
use crate::js_live::LiveValue;
use multicc_core::{
    chat_finalize_execution::{self as execution, FinalizationHost},
    js::{JsString, JsValue},
};
use napi::{bindgen_prelude::Unknown, sys, Env, Error, Result};
use napi_derive::napi;
use std::ffi::CStr;

type V<'a> = LiveValue<'a>;
fn text<'a>(anchor: V<'a>, value: &str) -> Result<V<'a>> {
    anchor.from_value(&JsValue::string(value))
}
fn boolean(anchor: V<'_>, value: bool) -> Result<V<'_>> {
    anchor.from_value(&JsValue::Bool(value))
}
fn object<'a>(anchor: V<'a>, fields: &[(&CStr, V<'a>)]) -> Result<V<'a>> {
    let result = anchor.from_value(&JsValue::object(Vec::<(&str, JsValue)>::new()))?;
    for (name, value) in fields {
        result.set(name, *value)?;
    }
    Ok(result)
}
fn read(value: V<'_>) -> Result<JsValue> {
    unsafe { crate::js_bridge::read_value(value.env(), value.raw(), 0, &mut Vec::new()) }
}
fn or<'a>(value: V<'a>, fallback: V<'a>) -> Result<V<'a>> {
    Ok(if value.truthy()? { value } else { fallback })
}
fn caught<'a>(anchor: V<'a>, error: Error) -> Result<V<'a>> {
    if let Some(value) = anchor.exception_value()? {
        return Ok(value);
    }
    anchor
        .global()?
        .get(c"Error")?
        .construct(&[text(anchor, &error.reason)?])
}

struct Host<'a> {
    ports: V<'a>,
    runtime: V<'a>,
    context: V<'a>,
    plan: V<'a>,
    resolved: Option<V<'a>>,
}
impl<'a> Host<'a> {
    fn port(&self, name: &CStr, args: &[V<'a>]) -> Result<V<'a>> {
        self.ports.get(name)?.call(self.ports, args)
    }
    fn runtime(&self, name: &CStr, args: &[V<'a>]) -> Result<V<'a>> {
        self.runtime.get(name)?.call_plain(args)
    }
    fn log_error(&self, name: &str, error: V<'a>) -> Result<()> {
        let detail = object(
            self.context,
            &[
                (c"sessionName", self.context.get(c"sessionName")?),
                (c"error", error),
            ],
        )?;
        self.runtime(c"logError", &[text(self.context, name)?, detail])?;
        Ok(())
    }
    fn broadcast(&self, session: V<'a>, fields: &[(&CStr, V<'a>)]) -> Result<()> {
        self.port(c"broadcast", &[session, object(self.context, fields)?])?;
        Ok(())
    }
    fn resolved_value(&self, resolved: &JsValue) -> Result<V<'a>> {
        let value = self.context.from_value(resolved)?;
        for name in [c"facts", c"append"] {
            let original = self.plan.get(name)?;
            if !original.undefined()?
                && (name == c"facts" || self.plan.get(c"action")?.is_string("finalize")?)
            {
                value.set(name, original)?;
            }
        }
        freeze_plan(value)
    }
    fn apply(&mut self, entry: V<'a>) -> Result<()> {
        let context = self.context;
        let session = context.get(c"sessionName")?;
        let cs = context.get(c"cs")?;
        let null = context.from_value(&JsValue::Null)?;
        let empty = text(context, "")?;
        let kind = entry.get(c"type")?.coerce_string()?.to_string_lossy();
        match kind.as_str() {
            "set-streaming" => cs.assign(c"isStreaming", entry.get(c"value")?)?,
            "cancel-classify" => {
                self.port(c"cancelClassify", &[cs])?;
            }
            "clear-stream-replay" => cs.assign(
                c"streamReplay",
                context.from_value(&JsValue::Array(vec![]))?,
            )?,
            "report-empty-retry-failure" => {
                let tail = or(context.get(c"stderrTail")?, empty)?
                    .clean_text()?
                    .coerce_string()?;
                let pending = context.get(c"pendingTransportError")?;
                let error = if pending.truthy()? {
                    JsString::concat(&[&JsString::from("Codex 出错："), &pending.coerce_string()?])
                } else if !tail.is_empty() {
                    JsString::concat(&[
                        &cs.get(c"cli")?.coerce_string()?,
                        &JsString::from(" 无响应："),
                        &tail,
                    ])
                } else {
                    let cli = cs.get(c"cli")?.coerce_string()?;
                    let code = context.get(c"code")?.coerce_string()?;
                    let signal = context.get(c"signal")?;
                    let suffix = if signal.truthy()? {
                        JsString::concat(&[&JsString::from("/"), &signal.coerce_string()?])
                    } else {
                        JsString::from("")
                    };
                    JsString::concat(&[
                        &cli,
                        &JsString::from(" 无响应（exit "),
                        &code,
                        &suffix,
                        &JsString::from("）"),
                    ])
                };
                self.broadcast(
                    session,
                    &[
                        (c"type", text(context, "error")?),
                        (c"error", context.from_value(&JsValue::String(error))?),
                    ],
                )?;
            }
            "report-handoff-resume-failure" => {
                let error = if context.get(c"runnerKind")?.is_string("stream")? {
                    JsString::from("目标 Claude 原生会话恢复异常；未自动新建或重试。请重新切换并选择“重置目标 CLI 会话”。")
                } else {
                    JsString::concat(&[&JsString::from("目标 "), &cs.get(c"cli")?.coerce_string()?,
                        &JsString::from(" 原生会话恢复失败；未自动创建新会话。请重新切换并选择“重置目标 CLI 会话”。")])
                };
                self.broadcast(
                    session,
                    &[
                        (c"type", text(context, "error")?),
                        (c"error", context.from_value(&JsValue::String(error))?),
                    ],
                )?;
            }
            "clear-active-process" => cs.assign(c"claudeProc", null)?,
            "clear-active-runner" => {
                if cs.get(c"_activeRunner")?.equals(context.get(c"runner")?)? {
                    cs.assign(c"_activeRunner", null)?;
                }
            }
            "clear-incremental-save" => {
                self.port(c"clearIncrementalSave", &[session])?;
            }
            "append-assistant-result" => {}
            "commit-usage" => {
                let turn = context.get(c"turn")?;
                if turn.truthy()? && turn.get(c"resultDurable")?.is_true()? {
                    context.assign(c"usageAttempted", boolean(context, true)?)?;
                    match self
                        .port(c"commitUsage", &[context])
                        .and_then(|value| value.is_true())
                    {
                        Ok(durable) => {
                            context.assign(c"usageDurable", boolean(context, durable)?)?
                        }
                        Err(error) => {
                            let error = caught(context, error)?;
                            context.assign(c"usageDurable", boolean(context, false)?)?;
                            let message = if error.truthy()? && error.get(c"message")?.truthy()? {
                                context
                                    .global()?
                                    .get(c"String")?
                                    .call_plain(&[error.get(c"message")?])?
                            } else {
                                text(context, "usage commit failed")?
                            };
                            context.assign(c"usageError", message)?;
                            self.log_error("usage-commit-failed", error)?;
                        }
                    }
                    if !context.get(c"usageDurable")?.is_true()? {
                        context.assign(c"terminalBlocked", boolean(context, true)?)?;
                    }
                }
            }
            "increment-chat-turn-count" => {
                if context.get(c"appendPersisted")?.truthy()? {
                    cs.assign(
                        c"chatTurnCount",
                        context.from_value(&JsValue::Number(
                            cs.get(c"chatTurnCount")?.number()? + 1.0,
                        ))?,
                    )?;
                }
            }
            "report-result-persistence-failure" => self.broadcast(
                session,
                &[
                    (c"type", text(context, "error")?),
                    (
                        c"error",
                        text(context, "回复已生成但未能持久化，已停止回流和后续动作。")?,
                    ),
                ],
            )?,
            "emit-synthetic-result" => {
                let duration = if cs.get(c"turnStartedAt")?.truthy()? {
                    context.from_value(&JsValue::Number(
                        self.runtime(c"now", &[])?.number()?
                            - cs.get(c"turnStartedAt")?.number()?,
                    ))?
                } else {
                    context.from_value(&JsValue::Undefined)?
                };
                let event = object(
                    context,
                    &[
                        (c"type", text(context, "result")?),
                        (c"total_cost_usd", null),
                        (c"usage", object(context, &[])?),
                        (c"durationMs", duration),
                        (c"num_turns", cs.get(c"chatTurnCount")?),
                    ],
                )?;
                event.spread_from(
                    self.runtime(c"timelineField", &[session, cs, self.runtime(c"now", &[])?])?,
                )?;
                self.port(c"broadcast", &[session, event])?;
            }
            "capture-final-text" => {
                context.assign(c"finalText", cs.get(c"currentAssistantText")?)?
            }
            "reset-turn-output" => {
                cs.assign(c"currentAssistantText", empty)?;
                cs.assign(
                    c"currentToolCalls",
                    context.from_value(&JsValue::Array(vec![]))?,
                )?;
                cs.assign(c"_resultSaved", boolean(context, false)?)?;
                cs.assign(c"_sawApiError", boolean(context, false)?)?;
                if entry.get(c"clearAdapterError")?.truthy()? {
                    cs.assign(c"_adapterError", null)?;
                }
                if entry.get(c"clearTransportState")?.truthy()? {
                    cs.assign(c"_codexRecoveredDisconnect", boolean(context, false)?)?;
                    cs.assign(c"_codexPendingStreamError", empty)?;
                    cs.assign(
                        c"_codexPendingStreamErrorCount",
                        context.from_value(&JsValue::Number(0.0))?,
                    )?;
                    cs.assign(c"_codexTransportError", empty)?;
                    cs.assign(
                        c"_codexStreamContinuationCount",
                        context.from_value(&JsValue::Number(0.0))?,
                    )?;
                }
            }
            "set-status" => {
                self.port(c"setStatus", &[session, entry.get(c"status")?])?;
            }
            "classify-turn-end" => {
                let turn = context.get(c"turn")?;
                let task = turn.optional(c"task")?;
                let task_id = task.optional(c"id")?;
                let mut locked = task_id.truthy()?;
                if locked && task.get(c"start")?.is_true()? {
                    let source = task.get(c"source")?;
                    locked = source.is_string("task-board")?
                        || source.is_string("commander")?
                        || source.is_string("code-reference")?;
                }
                let options = object(
                    context,
                    &[
                        (c"classification", or(entry.get(c"classification")?, null)?),
                        (c"killReason", or(entry.get(c"killReason")?, null)?),
                        (c"turnId", or(turn.optional(c"turnId")?, null)?),
                        (c"taskId", or(task_id, null)?),
                        (c"identityLocked", boolean(context, locked)?),
                    ],
                )?;
                if context.optional(c"autoProviderHandoffPending")?.is_true()? {
                    options.assign(c"handoffPending", boolean(context, true)?)?;
                }
                self.port(c"classifyTurnEnd", &[cs, session, options])?;
            }
            "complete-session-turn" => {
                self.runtime(c"completeSessionTurn", &[session])?;
            }
            "reset-interrupted-resume" => {
                self.port(c"resetInterrupted", &[session])?;
            }
            "emit-turn-outcome" => {
                self.port(
                    c"emitTurnOutcome",
                    &[
                        session,
                        object(
                            context,
                            &[
                                (c"status", entry.get(c"status")?),
                                (c"notifyState", entry.get(c"notifyState")?),
                                (c"message", text(context, "执行成功")?),
                                (c"alert", boolean(context, false)?),
                            ],
                        )?,
                    ],
                )?;
            }
            "try-resume-interrupted" => {
                if self.port(c"resumeInterrupted", &[session])?.truthy()? {
                    self.runtime(
                        c"log",
                        &[
                            text(context, "interrupted-resume")?,
                            object(context, &[(c"sessionName", session)])?,
                        ],
                    )?;
                } else {
                    self.port(c"setStatus", &[session, entry.get(c"fallbackStatus")?])?;
                }
            }
            "freeze-interrupted" => {
                if self.ports.get(c"freezeInterrupted")?.kind()? == sys::ValueType::napi_function {
                    self.port(
                        c"freezeInterrupted",
                        &[
                            session,
                            or(
                                entry.get(c"reason")?,
                                text(context, "unknown_interruption")?,
                            )?,
                        ],
                    )?;
                }
            }
            "stream-end" => self.broadcast(session, &[(c"type", text(context, "stream_end")?)])?,
            "run-post-turn" => {
                if let Err(error) = self.port(c"runPostTurn", &[context, entry]) {
                    self.log_error("post-turn-failed", caught(context, error)?)?;
                }
            }
            _ => {
                return Err(Error::from_reason(format!(
                    "unknown chat finalization effect: {kind}"
                )))
            }
        }
        Ok(())
    }
}

fn freeze_plan(value: V<'_>) -> Result<V<'_>> {
    for name in [c"append", c"facts", c"retry", c"result"] {
        let field = value.get(name)?;
        if field.truthy()? {
            field.freeze()?;
        }
    }
    let effects = value.get(c"effects")?;
    if effects.truthy()? {
        effects.for_each(|entry| {
            entry.freeze()?;
            Ok(())
        })?;
        effects.freeze()?;
    }
    value.freeze()
}

impl FinalizationHost for Host<'_> {
    type Error = Error;
    fn error(&self, message: &str) -> Error {
        Error::from_reason(message)
    }
    fn nonterminal_plan(&mut self, action: &JsValue) -> Result<()> {
        self.runtime(
            c"logError",
            &[
                text(self.context, "nonterminal-finalization-plan")?,
                object(
                    self.context,
                    &[(c"action", self.context.from_value(action)?)],
                )?,
            ],
        )?;
        Ok(())
    }
    fn use_plan(&mut self, plan: &JsValue, replaced: bool) -> Result<()> {
        if replaced {
            self.plan = freeze_plan(self.context.from_value(plan)?)?;
        }
        Ok(())
    }
    fn result_durable(&mut self) -> Result<JsValue> {
        read(self.context.get(c"turn")?.get(c"resultDurable")?)
    }
    fn terminal_blocked(&mut self) -> Result<bool> {
        self.context.get(c"terminalBlocked")?.is_true()
    }
    fn resolved_plan(&mut self, resolved: &JsValue) -> Result<()> {
        self.resolved = Some(self.resolved_value(resolved)?);
        Ok(())
    }
    fn apply_effect(&mut self, index: usize, _: &JsValue) -> Result<()> {
        let resolved = self
            .resolved
            .ok_or_else(|| Error::from_reason("resolved finalization plan missing"))?;
        self.apply(resolved.get(c"effects")?.element(index as u32)?)
    }
    fn persist_assistant(&mut self) -> Result<bool> {
        let persisted = self
            .port(
                c"persistAssistant",
                &[self.context, self.plan.get(c"append")?],
            )?
            .is_true()?;
        self.context
            .assign(c"appendPersisted", boolean(self.context, persisted)?)?;
        Ok(persisted)
    }
    fn record_result(&mut self, _: &JsValue) -> Result<()> {
        let value = self
            .resolved
            .ok_or_else(|| Error::from_reason("resolved finalization plan missing"))?;
        let callback = self.ports.get(c"recordRunResult")?;
        if !callback.nullish()? {
            callback.call(self.ports, &[self.context, value])?;
        }
        self.resolved = Some(value);
        Ok(())
    }
}

fn new_host<'a>(plan: V<'a>, raw_context: V<'a>, ports: V<'a>, runtime: V<'a>) -> Result<Host<'a>> {
    let context = object(
        raw_context,
        &[
            (c"appendPersisted", boolean(raw_context, false)?),
            (c"finalText", text(raw_context, "")?),
            (c"usageAttempted", boolean(raw_context, false)?),
            (c"usageDurable", raw_context.from_value(&JsValue::Null)?),
            (c"terminalBlocked", boolean(raw_context, false)?),
        ],
    )?;
    context.spread_from(raw_context)?;
    Ok(Host {
        context,
        ports,
        runtime,
        plan,
        resolved: None,
    })
}

fn outcome<'a>(
    host: &Host<'a>,
    pending: bool,
    append_persisted: bool,
    source: Option<V<'a>>,
) -> Result<V<'a>> {
    let context = host.context;
    let mut fields = vec![
        (
            c"resolved",
            host.resolved.expect("executor records the resolved plan"),
        ),
        (c"appendPersisted", boolean(context, append_persisted)?),
        (c"finalText", context.get(c"finalText")?),
        (c"usageDurable", context.get(c"usageDurable")?),
        (c"terminalBlocked", context.get(c"terminalBlocked")?),
    ];
    if pending {
        fields.push((c"pending", boolean(context, true)?));
        fields.push((c"plan", host.plan));
        fields.push((c"append", host.plan.get(c"append")?));
        if let Some(source) = source {
            fields.push((c"sourcePlan", source));
        }
    }
    object(context, &fields)?.freeze()
}

/// First phase: run up to the append boundary. When the plan needs a durable
/// append the result carries `pending: true`, the effective `plan` and its
/// `append` facts, and no effect after the boundary has run yet.
fn run<'a>(plan: V<'a>, raw_context: V<'a>, ports: V<'a>, runtime: V<'a>) -> Result<V<'a>> {
    let mut host = new_host(plan, raw_context, ports, runtime)?;
    match execution::prepare(&read(plan)?, &mut host)? {
        execution::Prepared::Completed(result) => {
            outcome(&host, false, result.append_persisted, None)
        }
        execution::Prepared::Pending { source, .. } => {
            outcome(&host, true, false, Some(raw_context.from_value(&source)?))
        }
    }
}

/// Second phase: the host awaited the append and reports its verdict. Re-resolve
/// with `appendPersisted`, run every effect after the boundary and record.
fn run_commit<'a>(
    plan: V<'a>,
    raw_context: V<'a>,
    ports: V<'a>,
    runtime: V<'a>,
    persisted: bool,
    fault: V<'a>,
    source_plan: V<'a>,
) -> Result<V<'a>> {
    if fault.truthy()? {
        // The host port failed to finish, which is a host fault rather than a
        // store verdict. Keep the pre-existing containment contract: freeze the
        // turn through the same best-effort failure path as a synchronous throw,
        // reporting the caller's original plan facts.
        let facts_plan = if source_plan.truthy()? {
            source_plan
        } else {
            plan
        };
        return failed(facts_plan, raw_context, ports, runtime, fault);
    }
    let mut host = new_host(plan, raw_context, ports, runtime)?;
    host.context
        .assign(c"appendPersisted", boolean(host.context, persisted)?)?;
    let result = execution::complete(&read(plan)?, &mut host, persisted)?;
    outcome(&host, false, result.append_persisted, None)
}

/// Best-effort cleanup must not let a failed port terminate the server. Each
/// failed callback clears the pending engine exception before the next cleanup.
fn failed<'a>(
    plan: V<'a>,
    context: V<'a>,
    ports: V<'a>,
    runtime: V<'a>,
    error: V<'a>,
) -> Result<V<'a>> {
    let host = Host {
        context,
        ports,
        runtime,
        plan,
        resolved: None,
    };
    let session = context.get(c"sessionName")?;
    let cs = context.get(c"cs")?;
    context.catch(|| host.log_error("turn-finalization-execution-failed", error))?;
    if cs.truthy()? {
        context.catch(|| cs.assign(c"isStreaming", boolean(context, false)?))?;
        context.catch(|| {
            if context.get(c"runnerKind")?.is_string("process")? {
                cs.assign(c"claudeProc", context.from_value(&JsValue::Null)?)?;
            }
            Ok(())
        })?;
        context.catch(|| {
            if cs.get(c"_activeRunner")?.equals(context.get(c"runner")?)? {
                cs.assign(c"_activeRunner", context.from_value(&JsValue::Null)?)?;
            }
            Ok(())
        })?;
    }
    context.catch(|| host.port(c"clearIncrementalSave", &[session]))?;
    context.catch(|| host.port(c"setStatus", &[session, text(context, "waiting")?]))?;
    context.catch(|| {
        let callback = ports.get(c"freezeInterrupted")?;
        if !callback.nullish()? {
            callback.call(ports, &[session, text(context, "finalization_failed")?])?;
        }
        Ok(())
    })?;
    context.catch(|| {
        host.broadcast(
            session,
            &[
                (c"type", text(context, "error")?),
                (
                    c"error",
                    text(context, "本轮收尾失败，已安全停止；请检查日志。")?,
                ),
            ],
        )
    })?;
    context.catch(|| host.broadcast(session, &[(c"type", text(context, "stream_end")?)]))?;
    let facts = or(plan.optional(c"facts")?, object(context, &[])?)?;
    let resolved = object(
        context,
        &[
            (c"action", text(context, "finalize")?),
            (c"code", text(context, "finalization_execution_failed")?),
            (c"facts", facts),
            (
                c"effects",
                context.from_value(&JsValue::Array(vec![]))?.freeze()?,
            ),
        ],
    )?
    .freeze()?;
    object(
        context,
        &[
            (c"resolved", resolved),
            (c"appendPersisted", boolean(context, false)?),
            (c"finalText", text(context, "")?),
            (c"usageDurable", context.from_value(&JsValue::Null)?),
            (c"terminalBlocked", boolean(context, true)?),
        ],
    )?
    .freeze()
}

#[napi]
pub fn chat_execute_turn_finalization(
    env: Env,
    plan: Unknown<'_>,
    context: Unknown<'_>,
    ports: Unknown<'_>,
    runtime: Unknown<'_>,
) -> Result<sys::napi_value> {
    let plan = V::new(&env, plan);
    let raw_context = V::new(&env, context);
    let context = if raw_context.truthy()? && raw_context.kind()? == sys::ValueType::napi_object {
        raw_context
    } else {
        object(raw_context, &[])?
    };
    let ports = V::new(&env, ports);
    let runtime = V::new(&env, runtime);
    let value = match run(plan, context, ports, runtime) {
        Ok(value) => value,
        Err(error) => failed(plan, context, ports, runtime, caught(context, error)?)?,
    };
    Ok(value.raw())
}

// JS calls this export positionally; its arity is the napi ABI, not an API we
// can reshape from Rust.
#[allow(clippy::too_many_arguments)]
#[napi]
pub fn chat_commit_turn_finalization(
    env: Env,
    plan: Unknown<'_>,
    context: Unknown<'_>,
    ports: Unknown<'_>,
    runtime: Unknown<'_>,
    persisted: bool,
    fault: Option<Unknown<'_>>,
    source_plan: Option<Unknown<'_>>,
) -> Result<sys::napi_value> {
    let plan = V::new(&env, plan);
    let raw_context = V::new(&env, context);
    let context = if raw_context.truthy()? && raw_context.kind()? == sys::ValueType::napi_object {
        raw_context
    } else {
        object(raw_context, &[])?
    };
    let ports = V::new(&env, ports);
    let runtime = V::new(&env, runtime);
    let fault = match fault {
        Some(fault) => V::new(&env, fault),
        None => context.from_value(&JsValue::Undefined)?,
    };
    let source_plan = match source_plan {
        Some(source) => V::new(&env, source),
        None => context.from_value(&JsValue::Undefined)?,
    };
    let value = match run_commit(plan, context, ports, runtime, persisted, fault, source_plan) {
        Ok(value) => value,
        Err(error) => failed(plan, context, ports, runtime, caught(context, error)?)?,
    };
    Ok(value.raw())
}
