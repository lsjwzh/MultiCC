//! Native completion evidence and the host's success/persistence boundary.
use crate::js_live::LiveValue;
use multicc_core::cli_completion::{completion_reason, StepCompletion, StepReason};
use multicc_core::js::{JsString, JsValue};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::cell::{Cell, RefCell};

#[derive(Default)]
struct CompletionState {
    ended: bool,
    failed: bool,
    has_output: bool,
    saw_error: bool,
}

/// Callback and evidence handles remain in the host closure. No native strong
/// reference points back into that closure, so even cyclic adapters can be GC'd.
/// Native state is never borrowed across JavaScript calls or getter reads.
#[napi]
pub struct RustCliCompletionTracker {
    state: RefCell<CompletionState>,
}

impl RustCliCompletionTracker {
    fn ended(&self) -> bool {
        self.state.borrow().ended
    }
    fn failed(&self) -> bool {
        self.state.borrow().failed
    }
    fn has_output(&self) -> bool {
        self.state.borrow().has_output
    }
    fn saw_error(&self) -> bool {
        self.state.borrow().saw_error
    }
}

fn read_evidence(port: LiveValue<'_>) -> Result<LiveValue<'_>> {
    port.get(c"read")?.call_plain(&[])
}

fn write_evidence(port: LiveValue<'_>, value: LiveValue<'_>) -> Result<()> {
    port.get(c"write")?.call_plain(&[value])?;
    Ok(())
}

fn host_evidence<'a>(
    port: LiveValue<'a>,
    state: &str,
    reason: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
    completion(
        port,
        state,
        reason,
        port.from_value(&JsValue::string("host"))?,
    )
}

#[napi]
impl RustCliCompletionTracker {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            state: RefCell::new(CompletionState::default()),
        }
    }

    #[napi]
    pub fn accepts_raw(&self, env: Env, raw: Unknown<'_>) -> Result<bool> {
        if self.ended() {
            return Ok(false);
        }
        let raw = LiveValue::new(&env, raw);
        Ok(raw.truthy()? && raw.kind()? == sys::ValueType::napi_object)
    }

    #[napi]
    pub fn observe_decoded(&self, env: Env, event: Unknown<'_>, tools: Unknown<'_>) -> Result<()> {
        let event = LiveValue::new(&env, event);
        let tools = LiveValue::new(&env, tools);
        if !event.truthy()? {
            return Ok(());
        }
        if event.get(c"type")?.is_string("assistant_text")? && event.get(c"text")?.truthy()? {
            self.state.borrow_mut().has_output = true;
        }
        if event.get(c"type")?.is_string("error")? {
            self.state.borrow_mut().saw_error = true;
        }
        if event.get(c"type")?.is_string("tool_start")?
            || (event.get(c"type")?.is_string("tool_update")?
                && !event.get(c"completed")?.truthy()?)
        {
            let add = tools.get(c"add")?;
            add.call(tools, &[event.get(c"id")?])?;
        }
        if event.get(c"type")?.is_string("tool_result")?
            || (event.get(c"type")?.is_string("tool_update")?
                && event.get(c"completed")?.truthy()?)
        {
            let delete = tools.get(c"delete")?;
            delete.call(tools, &[event.get(c"id")?])?;
        }
        Ok(())
    }

    #[napi]
    pub fn observe_protocol(
        &self,
        env: Env,
        raw: Unknown<'_>,
        decoded: Unknown<'_>,
        port: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let port = LiveValue::new(&env, port);
        let observe = port.get(c"observe")?;
        let next = if observe.nullish()? {
            port.from_value(&JsValue::Undefined)?
        } else {
            observe.call_plain(&[LiveValue::new(&env, raw), LiveValue::new(&env, decoded)])?
        };
        if next.truthy()? && !self.failed() {
            write_evidence(port, next)?;
            let failed = next.get(c"state")?.is_string("failed")?
                || next.get(c"state")?.is_string("cancelled")?;
            self.state.borrow_mut().failed = failed;
            if next.get(c"state")?.is_string("completed")? {
                self.state.borrow_mut().saw_error = false;
            }
        }
        Ok(read_evidence(port)?.raw())
    }

    #[napi]
    pub fn finish(
        &self,
        env: Env,
        boundary: Unknown<'_>,
        port: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let port = LiveValue::new(&env, port);
        if self.ended() {
            return Ok(read_evidence(port)?.raw());
        }
        self.state.borrow_mut().ended = true;
        let boundary = LiveValue::new(&env, boundary);
        if boundary.get(c"killReason")?.truthy()? {
            write_evidence(
                port,
                host_evidence(port, "cancelled", boundary.get(c"killReason")?)?,
            )?;
        } else if self.failed() {
            // Native protocol failure/cancellation cannot be erased by exit 0.
        } else if boundary.get(c"rejected")?.truthy()? {
            write_evidence(
                port,
                host_evidence(
                    port,
                    "failed",
                    port.from_value(&JsValue::string("stream_rejected"))?,
                )?,
            )?;
        } else if boundary.get(c"signal")?.truthy()? {
            write_evidence(
                port,
                host_evidence(
                    port,
                    "failed",
                    port.from_value(&JsValue::string("process_signaled"))?,
                )?,
            )?;
        } else if boundary.get(c"kind")?.is_string("process")?
            && !boundary.get(c"code")?.is_number(0.0)?
        {
            write_evidence(
                port,
                host_evidence(
                    port,
                    "failed",
                    port.from_value(&JsValue::string("nonzero_exit"))?,
                )?,
            )?;
        } else if boundary.get(c"kind")?.is_string("stream")?
            && !boundary.get(c"resolved")?.is_true()?
        {
            write_evidence(
                port,
                host_evidence(
                    port,
                    "unknown",
                    port.from_value(&JsValue::string("missing_stream_settlement"))?,
                )?,
            )?;
        } else {
            let kind = boundary.get(c"kind")?;
            if !kind.is_string("process")? && !kind.is_string("stream")? {
                write_evidence(
                    port,
                    host_evidence(
                        port,
                        "unknown",
                        port.from_value(&JsValue::string("missing_execution_boundary"))?,
                    )?,
                )?;
            } else if !self.failed() {
                let has_output = self.has_output();
                let saw_error = self.saw_error();
                let facts = port.from_value(&JsValue::object(vec![
                    ("hasOutput", has_output.into()),
                    ("sawError", saw_error.into()),
                ]))?;
                facts.set(c"pendingTools", port.get(c"tools")?.get(c"size")?)?;
                let close = port.get(c"close")?;
                if !close.nullish()? {
                    let next = close.call_plain(&[boundary, read_evidence(port)?, facts])?;
                    if next.truthy()? {
                        write_evidence(port, next)?;
                    }
                }
                if port.get(c"fallback")?.truthy()?
                    && read_evidence(port)?.get(c"state")?.is_string("unknown")?
                    && boundary.get(c"kind")?.is_string("process")?
                    && boundary.get(c"code")?.is_number(0.0)?
                    && self.has_output()
                    && !self.saw_error()
                    && port.get(c"tools")?.get(c"size")?.is_number(0.0)?
                {
                    let next = completion(
                        port,
                        "completed",
                        port.from_value(&JsValue::string("clean_exit_with_output"))?,
                        port.from_value(&JsValue::string("exit_fallback"))?,
                    )?;
                    write_evidence(port, next)?;
                }
            }
        }
        Ok(port.get(c"settle")?.call_plain(&[])?.raw())
    }
}

fn completion<'a>(
    anchor: LiveValue<'a>,
    state: &str,
    reason: LiveValue<'a>,
    source: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
    let reason = JsValue::String(completion_reason(reason.string()?));
    let result = anchor.from_value(&JsValue::object(vec![
        ("version", JsValue::Number(1.0)),
        ("state", JsValue::string(state)),
        ("reason", reason),
    ]))?;
    result.set(c"source", source)?;
    result.freeze()
}

#[napi]
pub struct RustStepCompletionTracker {
    state: RefCell<StepCompletion>,
    stream_boundary: bool,
}

#[napi]
impl RustStepCompletionTracker {
    #[napi(constructor)]
    pub fn new(stream_boundary: bool) -> Self {
        Self {
            state: RefCell::new(StepCompletion::default()),
            stream_boundary,
        }
    }
    #[napi]
    pub fn observe(&self, env: Env, event: Unknown<'_>) -> Result<sys::napi_value> {
        let event = LiveValue::new(&env, event);
        if event.get(c"type")?.is_string("step_start")? {
            self.state.borrow_mut().begin_step();
        } else if event.get(c"type")?.is_string("tool_use")?
            || event.get(c"type")?.is_string("tool_call")?
        {
            self.state.borrow_mut().tool_started();
        } else if event.get(c"type")?.is_string("step_finish")? {
            let reason = event.get(c"part")?.optional(c"reason")?;
            let reason = if !reason.truthy()? {
                StepReason::Missing
            } else if let Some(text) = reason.string()? {
                StepReason::Text(text)
            } else {
                StepReason::OtherTruthy
            };
            self.state.borrow_mut().finish_step(reason);
        } else if event.get(c"type")?.is_string("error")? {
            return Ok(completion(
                event,
                "failed",
                event.from_value(&JsValue::string("session_error"))?,
                event.from_value(&JsValue::string("protocol"))?,
            )?
            .raw());
        }
        Ok(event.from_value(&JsValue::Null)?.raw())
    }
    #[napi]
    pub fn close(
        &self,
        env: Env,
        boundary: Unknown<'_>,
        evidence: Unknown<'_>,
        facts: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let boundary = LiveValue::new(&env, boundary);
        let facts = LiveValue::new(&env, facts);
        if !boundary.get(c"kind")?.is_string("process")?
            && !(self.stream_boundary && boundary.get(c"kind")?.is_string("stream")?)
        {
            return Ok(LiveValue::new(&env, evidence).raw());
        }
        let stopped = self.state.borrow().stop_without_tools();
        if stopped
            && !facts.get(c"sawError")?.truthy()?
            && facts.get(c"pendingTools")?.is_number(0.0)?
        {
            return Ok(completion(
                boundary,
                "completed",
                boundary.from_value(&JsValue::string("final_step_stop"))?,
                boundary.from_value(&JsValue::string("protocol_and_exit"))?,
            )?
            .raw());
        }
        let reason = self.state.borrow().unknown_reason();
        Ok(completion(
            boundary,
            "unknown",
            boundary.from_value(&JsValue::String(reason))?,
            boundary.from_value(&JsValue::string("protocol"))?,
        )?
        .raw())
    }
}

#[napi]
pub fn cli_completion(
    env: Env,
    state: Unknown<'_>,
    reason: Unknown<'_>,
    source: Unknown<'_>,
) -> Result<sys::napi_value> {
    let state = LiveValue::new(&env, state);
    let mut recognized = None;
    for candidate in ["completed", "failed", "cancelled", "unknown"] {
        if state.is_string(candidate)? {
            recognized = Some(candidate);
            break;
        }
    }
    let Some(name) = recognized else {
        return Err(state.type_error("invalid CLI completion state"));
    };
    Ok(completion(
        state,
        name,
        LiveValue::new(&env, reason),
        LiveValue::new(&env, source),
    )?
    .raw())
}

pub(crate) fn completed(outcome: LiveValue<'_>) -> Result<bool> {
    Ok(outcome.optional(c"version")?.is_number(1.0)?
        && outcome.get(c"state")?.is_string("completed")?
        && outcome.get(c"settled")?.is_true()?)
}

#[napi]
pub fn cli_is_completed(env: Env, outcome: Unknown<'_>) -> Result<bool> {
    completed(LiveValue::new(&env, outcome))
}

fn main_result(event: LiveValue<'_>) -> Result<bool> {
    Ok(event.optional(c"type")?.is_string("result")?
        && event.get(c"parent_tool_use_id")?.nullish()?
        && !event
            .get(c"origin")?
            .optional(c"kind")?
            .is_string("task-notification")?)
}

#[napi]
pub fn cli_is_main_result(env: Env, event: Unknown<'_>) -> Result<bool> {
    main_result(LiveValue::new(&env, event))
}

#[napi]
pub fn cli_result_completion(env: Env, event: Unknown<'_>) -> Result<sys::napi_value> {
    let event = LiveValue::new(&env, event);
    if !main_result(event)? {
        return Ok(event.from_value(&JsValue::Null)?.raw());
    }
    let reason = event.get(c"terminal_reason")?;
    let protocol = event.from_value(&JsValue::string("protocol"))?;
    for cancel in ["cancelled", "aborted", "interrupted"] {
        if reason.is_string(cancel)? {
            return Ok(completion(event, "cancelled", reason, protocol)?.raw());
        }
    }
    let is_error = if event.get(c"is_error")?.is_true()? {
        true
    } else {
        let subtype = event.get(c"subtype")?;
        let subtype = if subtype.truthy()? {
            subtype
        } else {
            event.from_value(&JsValue::string(""))?
        };
        let text = subtype.coerce_string()?;
        let units = text.as_units();
        (units.starts_with(&[101, 114, 114, 111, 114])
            && (units.len() == 5 || units.get(5) == Some(&95)))
            || reason.is_string("api_error")?
    };
    if is_error {
        let reason = if reason.truthy()? {
            reason
        } else {
            let subtype = event.get(c"subtype")?;
            if subtype.truthy()? {
                subtype
            } else {
                event.from_value(&JsValue::string("error_result"))?
            }
        };
        return Ok(completion(event, "failed", reason, protocol)?.raw());
    }
    let (state, reason) = if !reason.undefined()? && !reason.is_string("completed")? {
        (
            "unknown",
            event.from_value(&JsValue::string("unrecognized_terminal_reason"))?,
        )
    } else if event.get(c"subtype")?.is_string("success")? && event.get(c"is_error")?.is_false()? {
        (
            "completed",
            if reason.truthy()? {
                reason
            } else {
                event.from_value(&JsValue::string("success_result"))?
            },
        )
    } else {
        (
            "unknown",
            event.from_value(&JsValue::string("unrecognized_result"))?,
        )
    };
    Ok(completion(event, state, reason, protocol)?.raw())
}

fn prefixed<'a>(
    anchor: LiveValue<'a>,
    prefix: &str,
    value: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
    let mut text = JsString::from_rust_str(prefix);
    text.push(&value.coerce_string()?);
    anchor.from_value(&JsValue::String(text))
}

fn or_text<'a>(value: LiveValue<'a>, fallback: &str) -> Result<LiveValue<'a>> {
    if value.truthy()? {
        Ok(value)
    } else {
        value.from_value(&JsValue::string(fallback))
    }
}

#[napi]
pub struct RustKimiCompletionTracker {
    resume_hint: Cell<bool>,
}

#[napi]
impl RustKimiCompletionTracker {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            resume_hint: Cell::new(false),
        }
    }

    #[napi]
    pub fn observe(&self, env: Env, event: Unknown<'_>) -> Result<sys::napi_value> {
        let event = LiveValue::new(&env, event);
        if event.get(c"role")?.is_string("meta")?
            && event.get(c"type")?.is_string("session.resume_hint")?
            && event.get(c"session_id")?.kind()? == sys::ValueType::napi_string
        {
            // Keep the second property read and its method receiver: an accessor
            // may return a different value or throw between type check and trim.
            let id = event.get(c"session_id")?;
            if id.get(c"trim")?.call(id, &[])?.truthy()? {
                self.resume_hint.set(true);
            }
        }
        Ok(event.from_value(&JsValue::Null)?.raw())
    }
    #[napi]
    pub fn close(
        &self,
        env: Env,
        boundary: Unknown<'_>,
        evidence: Unknown<'_>,
        facts: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let boundary = LiveValue::new(&env, boundary);
        let facts = LiveValue::new(&env, facts);
        if boundary.get(c"kind")?.is_string("process")?
            && self.resume_hint.get()
            && !facts.get(c"sawError")?.truthy()?
            && !facts.get(c"pendingTools")?.truthy()?
        {
            return Ok(completion(
                boundary,
                "completed",
                boundary.from_value(&JsValue::string("print_resume_hint"))?,
                boundary.from_value(&JsValue::string("protocol_and_exit"))?,
            )?
            .raw());
        }
        Ok(LiveValue::new(&env, evidence).raw())
    }
}

struct PiEvidence {
    state: &'static str,
    reason: JsString,
}

#[napi]
pub struct RustPiCompletionTracker {
    latest: RefCell<PiEvidence>,
}

#[napi]
impl RustPiCompletionTracker {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            latest: RefCell::new(PiEvidence {
                state: "unknown",
                reason: "pi_missing_agent_end".into(),
            }),
        }
    }
    #[napi]
    pub fn observe(
        &self,
        env: Env,
        event: Unknown<'_>,
        last_assistant: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let event = LiveValue::new(&env, event);
        let next = if event.get(c"type")?.is_string("agent_start")?
            || event.get(c"type")?.is_string("auto_retry_start")?
        {
            Some(PiEvidence {
                state: "unknown",
                reason: "pi_agent_running".into(),
            })
        } else if event.get(c"type")?.is_string("agent_end")? {
            let reason = LiveValue::new(&env, last_assistant)
                .call_plain(&[event])?
                .optional(c"stopReason")?;
            let state = if reason.is_string("stop")? {
                "completed"
            } else if reason.is_string("aborted")? {
                "cancelled"
            } else {
                "failed"
            };
            let reason = prefixed(event, "pi_", or_text(reason, "missing_assistant")?)?.string()?;
            Some(PiEvidence {
                state,
                reason: completion_reason(reason),
            })
        } else if event.get(c"type")?.is_string("auto_retry_end")?
            && !event.get(c"success")?.truthy()?
        {
            Some(PiEvidence {
                state: "failed",
                reason: "pi_retry_exhausted".into(),
            })
        } else {
            None
        };
        if let Some(next) = next {
            *self.latest.borrow_mut() = next;
        }
        Ok(event.from_value(&JsValue::Null)?.raw())
    }
    #[napi]
    pub fn close(&self, env: Env, facts: Unknown<'_>) -> Result<sys::napi_value> {
        let facts = LiveValue::new(&env, facts);
        let completed = self.latest.borrow().state == "completed";
        if completed && facts.get(c"pendingTools")?.truthy()? {
            return Ok(completion(
                facts,
                "failed",
                facts.from_value(&JsValue::string("pi_pending_tools"))?,
                facts.from_value(&JsValue::string("protocol"))?,
            )?
            .raw());
        }
        let (state, reason) = {
            let latest = self.latest.borrow();
            (latest.state, latest.reason.clone())
        };
        Ok(completion(
            facts,
            state,
            facts.from_value(&JsValue::String(reason))?,
            facts.from_value(&JsValue::string("protocol"))?,
        )?
        .raw())
    }
}

/// Protocol-only adapters share the runner tracker; native terminal frames
/// still differ and are interpreted here without cloning the event graph.
#[napi]
pub fn cli_protocol_completion(
    env: Env,
    protocol: String,
    event: Unknown<'_>,
) -> Result<sys::napi_value> {
    let event = LiveValue::new(&env, event);
    let text = |value: &str| event.from_value(&JsValue::string(value));
    let result = match protocol.as_str() {
        "codex" => {
            if event.get(c"type")?.is_string("turn.completed")? {
                if !event.get(c"error")?.nullish()? {
                    Some(("failed", text("terminal_error")?))
                } else {
                    Some(("completed", text("turn.completed")?))
                }
            } else if event.get(c"type")?.is_string("turn.failed")? {
                Some(("failed", text("turn.failed")?))
            } else if event.get(c"type")?.is_string("turn.aborted")? {
                Some(("cancelled", text("turn.aborted")?))
            } else {
                None
            }
        }
        "codex-exp" => {
            if !event.optional(c"method")?.is_string("turn/completed")? {
                None
            } else {
                let status = event
                    .get(c"params")?
                    .optional(c"turn")?
                    .optional(c"status")?;
                if status.is_string("completed")? {
                    Some(("completed", text("turn/completed")?))
                } else if status.is_string("interrupted")? {
                    Some(("cancelled", text("turn/interrupted")?))
                } else {
                    Some((
                        "failed",
                        prefixed(event, "turn/", or_text(status, "failed")?)?,
                    ))
                }
            }
        }
        "dsh" => {
            if event.get(c"type")?.is_string("complete")? {
                Some(("completed", text("turn_end_completed")?))
            } else if event.get(c"type")?.is_string("error")? {
                let state = if event.get(c"reason")?.is_string("aborted")? {
                    "cancelled"
                } else {
                    "failed"
                };
                Some((state, or_text(event.get(c"reason")?, "turn_error")?))
            } else {
                None
            }
        }
        "acp" => {
            if event.optional(c"method")?.is_string("multicc/error")? {
                Some((
                    "failed",
                    prefixed(
                        event,
                        "acp_",
                        or_text(event.get(c"params")?.optional(c"phase")?, "error")?,
                    )?,
                ))
            } else if !event.optional(c"method")?.is_string("multicc/turnEnd")? {
                None
            } else {
                let reason = or_text(event.get(c"params")?.optional(c"stopReason")?, "unknown")?;
                if reason.is_string("end_turn")? {
                    Some(("completed", text("acp/end_turn")?))
                } else if reason.is_string("cancelled")? {
                    Some(("cancelled", text("acp/cancelled")?))
                } else {
                    Some(("failed", prefixed(event, "acp/", reason)?))
                }
            }
        }
        "commandcode" => {
            let nested = event.get(c"event")?;
            let nested = if nested.truthy()? { nested } else { event };
            if nested.get(c"type")?.is_string("error")? {
                Some(("failed", text("commandcode/error")?))
            } else if !event.get(c"type")?.is_string("result")? {
                None
            } else {
                let state = if event.get(c"subtype")?.is_string("success")?
                    && event.get(c"stopReason")?.is_string("end_turn")?
                {
                    "completed"
                } else {
                    "failed"
                };
                let reason = event.get(c"stopReason")?;
                let reason = if reason.truthy()? {
                    reason
                } else {
                    or_text(event.get(c"subtype")?, "unknown")?
                };
                Some((state, prefixed(event, "commandcode/", reason)?))
            }
        }
        _ => return Err(event.type_error("invalid CLI completion protocol")),
    };
    match result {
        Some((state, reason)) => Ok(completion(event, state, reason, text("protocol")?)?.raw()),
        None => Ok(event.from_value(&JsValue::Null)?.raw()),
    }
}

fn compatible(failure: LiveValue<'_>, outcome: LiveValue<'_>) -> Result<bool> {
    if !failure.truthy()? || !completed(outcome)? {
        return Ok(false);
    }
    if outcome.get(c"source")?.is_string("protocol")?
        || outcome.get(c"source")?.is_string("protocol_and_exit")?
    {
        return Ok(true);
    }
    Ok(failure.get(c"httpStatus")?.nullish()?
        && failure
            .get(c"proxyOutcome")?
            .optional(c"termination")?
            .is_string("downstream_disconnect")?)
}

#[napi]
pub fn cli_proxy_failure_compatible(
    env: Env,
    failure: Unknown<'_>,
    outcome: Unknown<'_>,
) -> Result<bool> {
    compatible(LiveValue::new(&env, failure), LiveValue::new(&env, outcome))
}

#[napi]
pub fn cli_can_persist_completion(
    env: Env,
    outcome: Unknown<'_>,
    failure: Unknown<'_>,
    error_envelope: Unknown<'_>,
) -> Result<bool> {
    let outcome = LiveValue::new(&env, outcome);
    let failure = LiveValue::new(&env, failure);
    Ok(completed(outcome)?
        && !LiveValue::new(&env, error_envelope).truthy()?
        && (!failure.truthy()? || compatible(failure, outcome)?))
}
