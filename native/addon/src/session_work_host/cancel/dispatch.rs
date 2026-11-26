//! The sequence follows the durable turn boundary: capture identity, stop, close,
//! dispatch the verdict, await its scheduler transition, and settle any interrupted dispatch.
use super::*;
use multicc_core::chat_runtime::{cancel_turn_identity, CancelTurnIdentity};

pub(super) fn capture<'a>(f: L<'a>, snapshot: L<'a>) -> Result<L<'a>> {
    let active = normalize(snapshot.optional(c"active")?)?;
    let cs = chat(f)?;
    f.set(c"previousChat", cs)?;
    f.set(c"previousRunner", cs.optional(c"_activeRunner")?)?;
    let ts = task_state(f)?;
    let turn = normalize(cs.optional(c"_activeTurn")?)?;
    let state = ts.get(c"classifyState")?;
    let marker = state
        .string()?
        .map(|s| s.to_string_lossy())
        .unwrap_or_default();
    let turn_id = match cancel_turn_identity(
        turn.truthy()?,
        turn.optional(c"turnId")?.truthy()?,
        active.truthy()?,
        ts.get(c"activeTurnId")?.truthy()?,
        &marker,
    ) {
        CancelTurnIdentity::Live => turn.get(c"turnId")?,
        CancelTurnIdentity::PersistedActive => ts.get(c"activeTurnId")?,
        CancelTurnIdentity::Recovery => {
            let uuid = call(h(f)?.get(c"crypto")?, c"randomUUID", &[])?;
            let turn_id = interpolate(f, "turn_recovery_", &[(uuid, "")])?;
            warn(
                f,
                "session_cancel_turn_identity_generated",
                &[
                    ("source", f.get(c"source")?),
                    ("classifyState", normalize(state)?),
                ],
            )?;
            turn_id
        }
        CancelTurnIdentity::Idle => null(f)?,
    };
    f.set(c"turnId", turn_id)?;
    let lineage = normalize(turn.optional(c"lineage")?)?;
    let mut origin = active.optional(c"originDispatchId")?;
    if !origin.truthy()? && lineage.optional(c"kind")?.is_string("dispatch")? {
        origin = lineage.get(c"operationId")?;
    }
    f.set(c"origin", normalize(origin)?)?;
    let replacement = normalize(active.optional(c"supersededByEntryId")?)?;
    f.set(c"replacement", replacement)?;
    let superseded = replacement.truthy()?;
    f.set(
        c"retains",
        flag(
            f,
            superseded
                && active
                    .optional(c"supersededLineageTransferred")?
                    .is_true()?
                && origin.truthy()?,
        )?,
    )?;
    f.set(
        c"effectiveReason",
        if superseded {
            text(f, "superseded_by_immediate_insert")?
        } else {
            f.get(c"reason")?
        },
    )?;
    f.set(
        c"effectiveKill",
        if superseded {
            text(f, "new_user_message")?
        } else {
            f.get(c"killReason")?
        },
    )?;
    let source = f.get(c"source")?;
    if (superseded || source.is_string("insert_queued")? || source.is_string("force_insert")?)
        && has_dep(f, c"stopBackgroundForInsert")?
    {
        warn_error(
            f,
            "session_insert_background_stop_failed",
            d(f, c"stopBackgroundForInsert", &[id(f)?]),
        )?;
    }
    schedule_step(f, runners::stop(f)?, release, None)
}
fn release<'a>(f: L<'a>, _: L<'a>) -> Result<L<'a>> {
    if has_dep(f, c"releaseProviderProducers")? {
        f.catch(|| {
            d(
                f,
                c"releaseProviderProducers",
                &[
                    id(f)?,
                    interpolate(f, "cancel:", &[(f.get(c"effectiveReason")?, "")])?,
                ],
            )
        })?;
    }
    schedule_step(f, runners::await_stop(f)?, close, None)
}
fn close_failed<'a>(f: L<'a>, _: L<'a>) -> Result<L<'a>> {
    response(f, "turn_close_failed")
}
fn close<'a>(f: L<'a>, stopped: L<'a>) -> Result<L<'a>> {
    f.set(c"stopped", stopped)?;
    let original = f.get(c"previousChat")?;
    if !stopped.truthy()? {
        warn(
            f,
            "session_cancel_runner_stop_timeout",
            &[
                ("source", f.get(c"source")?),
                ("operationId", f.get(c"operationId")?),
            ],
        )?;
    } else if chat(f)?.equals(original)? && original.truthy()? {
        if original
            .get(c"_activeRunner")?
            .equals(f.get(c"previousRunner")?)?
        {
            original.assign(c"_activeRunner", null(f)?)?;
        }
        if !runners::process_alive(original.get(c"_cancelledProc")?)? {
            original.assign(c"_cancelledProc", null(f)?)?;
        }
    }
    if scheduler(h(f)?)?.truthy()? {
        let p = async_result(f, || {
            super::super::transitions::close_turn(h(f)?, id(f)?, f.get(c"effectiveReason")?)
        })?;
        return schedule_step(f, rejected_catch(f, p, close_failed)?, classify, None);
    }
    classify(f, response(f, "no_active_task")?)
}
fn classify<'a>(f: L<'a>, closed: L<'a>) -> Result<L<'a>> {
    f.set(c"closed", closed)?;
    let cs = chat(f)?;
    let ts = task_state(f)?;
    let task = normalize(cs.optional(c"_currentTaskId")?)?;
    f.set(c"taskId", task)?;
    let stopped = f.get(c"stopped")?;
    let replacement = f.get(c"replacement")?;
    let cancel = fields(
        f,
        &[
            ("source", f.get(c"source")?),
            ("operationId", f.get(c"operationId")?),
            ("requestedAt", f.get(c"requestedAt")?),
            ("at", now(f)?),
            ("taskId", task),
            (
                "reason",
                if stopped.truthy()? {
                    f.get(c"effectiveReason")?
                } else {
                    text(f, "cancel_stop_timeout")?
                },
            ),
            ("runnerStopped", stopped),
            ("superseded", flag(f, replacement.truthy()?)?),
            ("supersededByEntryId", replacement),
            ("originDispatchId", f.get(c"origin")?),
            ("successorRetainsDispatch", f.get(c"retains")?),
        ],
    )?;
    let result = fields(
        f,
        &[
            ("state", text(f, "E")?),
            ("goal", fallback(ts.get(c"goal")?, "".into())?),
            ("phase", fallback(ts.get(c"phase")?, "".into())?),
            ("cancel", cancel),
        ],
    )?;
    f.set(c"result", result)?;
    let session = id(f)?;
    let rid = d(f, c"getRecord", &[session])?.optional(c"id")?;
    let is_terminal = !d(f, c"getRecord", &[session])?
        .optional(c"kind")?
        .is_string("chat")?;
    let options = fields(
        f,
        &[
            ("sessionName", session),
            ("sessionId", if rid.truthy()? { rid } else { session }),
            ("cs", normalize(cs)?),
            ("turnId", f.get(c"turnId")?),
            ("isTerminal", flag(f, is_terminal)?),
        ],
    )?;
    d(f, c"dispatchStateAction", &[result, options])?;
    let p = async_result(f, || wait_transition(f))?;
    schedule_step(f, p, reconcile, Some(reconcile))
}
fn interrupt_failed<'a>(f: L<'a>, err: L<'a>) -> Result<L<'a>> {
    warn(
        f,
        "session_cancel_dispatch_settlement_failed",
        &[
            ("operationId", f.get(c"origin")?),
            ("error", err.get(c"message")?),
        ],
    )?;
    finish(f, null(f)?)
}
fn reconcile<'a>(f: L<'a>, _: L<'a>) -> Result<L<'a>> {
    let task = f.get(c"taskId")?;
    if task.truthy()? && has_dep(f, c"reconcileTaskProjection")? {
        let options = fields(
            f,
            &[
                ("classifyState", text(f, "E")?),
                ("reason", f.get(c"result")?.get(c"cancel")?.get(c"reason")?),
            ],
        )?;
        warn_error(
            f,
            "session_cancel_reconcile_failed",
            d(f, c"reconcileTaskProjection", &[task, options]),
        )?;
    }
    let origin = f.get(c"origin")?;
    if f.get(c"stopped")?.truthy()? && origin.truthy()? && !f.get(c"retains")?.truthy()? {
        let rt = d(f, c"runtime", &[])?;
        if callable(rt.optional(c"interruptDispatch")?)? {
            let p = async_result(f, || {
                let msg = if f.get(c"replacement")?.truthy()? {
                    text(
                        f,
                        "dispatch target switched to an unrelated immediate message",
                    )?
                } else {
                    interpolate(
                        f,
                        "dispatch target turn interrupted: ",
                        &[(f.get(c"effectiveReason")?, "")],
                    )?
                };
                call(
                    rt,
                    c"interruptDispatch",
                    &[
                        origin,
                        fields(f, &[("reason", msg), ("source", f.get(c"source")?)])?,
                    ],
                )
            })?;
            return schedule_step(f, p, finish, Some(interrupt_failed));
        }
    }
    finish(f, null(f)?)
}
fn finish<'a>(f: L<'a>, settled: L<'a>) -> Result<L<'a>> {
    let stopped = f.get(c"stopped")?.truthy()?;
    f.catch(|| {
        let fun = deps(f)?.get(c"onTerminalWork")?;
        if fun.nullish()? {
            return empty(f);
        }
        let (status, reason) = if stopped {
            ("cancelled", f.get(c"effectiveReason")?)
        } else {
            ("failed", text(f, "cancel_stop_timeout")?)
        };
        fun.call(
            deps(f)?,
            &[
                id(f)?,
                fields(f, &[("status", text(f, status)?), ("reason", reason)])?,
            ],
        )
    })?;
    let op = f.get(c"operationId")?;
    let origin = f.get(c"origin")?;
    if !stopped {
        return fields(
            f,
            &[
                ("ok", flag(f, false)?),
                ("code", text(f, "runner_stop_timeout")?),
                ("classifyState", text(f, "E")?),
                ("operationId", op),
                (
                    "cancelReason",
                    f.get(c"result")?.get(c"cancel")?.get(c"reason")?,
                ),
                ("originDispatchId", origin),
                ("dispatchSettlement", settled),
            ],
        );
    }
    let closed = f.get(c"closed")?;
    let replacement = f.get(c"replacement")?;
    fields(
        f,
        &[
            ("ok", flag(f, true)?),
            ("classifyState", text(f, "E")?),
            ("operationId", op),
            (
                "alreadyIdle",
                flag(
                    f,
                    !closed.get(c"ok")?.truthy()?
                        && closed.get(c"code")?.is_string("no_active_task")?,
                )?,
            ),
            ("superseded", flag(f, replacement.truthy()?)?),
            ("supersededByEntryId", replacement),
            ("originDispatchId", origin),
            ("successorRetainsDispatch", f.get(c"retains")?),
            ("dispatchSettlement", settled),
        ],
    )
}
