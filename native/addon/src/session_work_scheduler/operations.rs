use super::*;
use crate::{
    schedule_claim_live, schedule_insert_queued_live, schedule_lifecycle_live as life,
    schedule_note_queued_live, schedule_settle_live,
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Op {
    Admit,
    Claim,
    Started,
    Handoff,
    Release,
    Ended,
    Freeze,
    Complete,
    Resolve,
    Settle,
    Cancel,
    Detached,
    Insert,
    Reorder,
    Edit,
    Status,
    Summaries,
    Note,
    List,
    Recover,
    Persisted,
}
use Op::*;
pub(super) const METHODS: &[(&str, usize, usize, Op)] = &[
    ("admit", 1, 0, Admit),
    ("claim", 1, 1, Claim),
    ("started", 1, 1, Started),
    ("confirmHandoff", 1, 1, Handoff),
    ("releaseClaim", 2, 1, Release),
    ("turnEnded", 1, 1, Ended),
    ("freeze", 3, 2, Freeze),
    ("complete", 2, 1, Complete),
    ("resolve", 2, 1, Resolve),
    ("settleUserInput", 2, 2, Settle),
    ("cancelQueued", 3, 2, Cancel),
    ("detachedResult", 3, 3, Detached),
    ("insertQueued", 3, 2, Insert),
    ("reorderQueued", 3, 2, Reorder),
    ("editQueued", 3, 2, Edit),
    ("status", 1, 1, Status),
    ("queueSummaries", 1, 0, Summaries),
    ("noteQueued", 1, 1, Note),
    ("list", 0, 0, List),
    ("recover", 1, 0, Recover),
    ("settlePersistedDelivery", 2, 1, Persisted),
];
pub(super) fn run<'a>(owner: L<'a>, op: Op, args: &[L<'a>]) -> Result<L<'a>> {
    let empty = undef(owner)?;
    let get = |n: usize| args.get(n).copied().unwrap_or(empty);
    let a = get(0);
    let b = get(1);
    let c = get(2);
    let frame = fields(owner, &[("owner", owner), ("a", a), ("b", b), ("c", c)])?;
    let id = if op == Persisted {
        a.get(c"sessionId")?
    } else {
        a
    };
    frame.set(c"id", id)?;
    let options = match op {
        Freeze | Cancel | Insert | Reorder | Edit => c,
        Complete | Resolve | Persisted => b,
        Recover => a,
        _ => empty,
    };
    let opts = default_object(options)?;
    frame.set(c"opts", opts)?;
    let init = |k: &CStr, key: &CStr, val: L<'a>| frame.set(key, default(opts.get(k)?, val)?);
    match op {
        Release => frame.set(c"reason", default(b, text(owner, "prelaunch_deferred")?)?)?,
        Freeze => {
            for k in [c"requestId".as_ref(), c"expectedTaskId", c"classifyState"] {
                init(k, k, null(owner)?)?;
            }
        }
        Complete => {
            init(c"reason", c"reason", text(owner, "successful")?)?;
            init(c"classifyState", c"classifyState", text(owner, "D")?)?;
            for k in [c"expectedTaskId".as_ref(), c"awaitingRequestId"] {
                init(k, k, null(owner)?)?;
            }
        }
        Resolve => {
            frame.set(c"action", opts.get(c"action")?)?;
            init(c"reason", c"reason", text(owner, "")?)?;
            init(c"actor", c"actor", text(owner, "user")?)?;
            init(c"text", c"text", text(owner, "")?)?;
            init(c"idempotencyKey", c"idempotencyKey", null(owner)?)?;
        }
        Cancel | Insert | Reorder | Edit => {
            init(c"actor", c"actor", text(owner, "user")?)?;
            if op == Cancel {
                init(c"reason", c"reason", text(owner, "cancelled before start")?)?;
            }
            if op == Reorder {
                for k in [c"toIndex".as_ref(), c"direction"] {
                    init(k, k, null(owner)?)?;
                }
            }
            let clean = string(fallback(b, V::string(""))?)?.clean_text()?;
            if !clean.truthy()? {
                let label = match op {
                    Cancel => "cancellation",
                    Insert => "insertion",
                    Reorder => "reorder",
                    _ => "edit",
                };
                return Err(owner.type_error(&format!("queued {label} requires entryId")));
            }
            frame.set(c"entry", clean)?;
            if op == Edit {
                let clean = string(fallback(opts.get(c"text")?, V::string(""))?)?.clean_text()?;
                if !clean.truthy()? {
                    return code(owner, "queued_entry_text_required");
                }
                frame.set(c"text", clean)?;
            }
        }
        Summaries => frame.set(c"requested", projection::requested(a)?)?,
        _ => {}
    }
    if matches!(op, Admit | Claim) {
        let ensure = owner.get(c"ensureSessionWorkState")?;
        if ensure.truthy()? {
            let input = if op == Admit { default_object(a)? } else { a };
            let session = input.get(c"sessionId")?;
            return then(frame, ensure.call_plain(&[session])?, move |f, _| {
                execute(f, op)
            });
        }
    }
    execute(frame, op)
}
fn execute(f: L<'_>, op: Op) -> Result<L<'_>> {
    let s = f.get(c"owner")?;
    let store = s.get(c"store")?;
    let now = s.get(c"now")?;
    let a = f.get(c"a")?;
    let b = f.get(c"b")?;
    let c = f.get(c"c")?;
    let id = f.get(c"id")?;
    let mutate = || function(f, "", 1, 1, move |f, args| draft_operation(f, op, args[0]));
    let result = match op {
        Admit | Complete => {
            let name = if op == Admit {
                c"executeScheduleAdmit".as_ref()
            } else {
                c"executeScheduleComplete".as_ref()
            };
            if !callable(store.get(name)?)? {
                let error = if op == Admit {
                    "session_work_admission_owner_unavailable"
                } else {
                    "session_work_completion_owner_unavailable"
                };
                return Err(s
                    .global()?
                    .get(c"Error")?
                    .construct(&[text(s, error)?])?
                    .throw_error());
            }
            if op == Admit {
                call(store, name, &[default_object(a)?, clock(s)?])?
            } else {
                let input = fields(s, &[("sessionId", id), ("clock", now)])?;
                for key in [
                    c"expectedTaskId".as_ref(),
                    c"reason",
                    c"classifyState",
                    c"awaitingRequestId",
                ] {
                    input.set(key, f.get(key)?)?;
                }
                call(store, name, &[input])?
            }
        }
        Claim if callable(store.get(c"executeScheduleClaim")?)? => {
            call(store, c"executeScheduleClaim", &[a, now])?
        }
        Handoff => {
            if !a
                .optional(c"payload")?
                .optional(c"type")?
                .is_string("session.work")?
                || !callable(store.get(c"executeScheduleHandoff")?)?
            {
                return null(f);
            }
            call(store, c"executeScheduleHandoff", &[a, now])?
        }
        Settle => {
            return if callable(store.get(c"settleScheduleInput")?)? {
                call(store, c"settleScheduleInput", &[id, b, now, mutate()?])
            } else {
                call(store, c"mutate", &[mutate()?])
            }
        }
        Reorder => {
            let opts = fields(
                f,
                &[
                    ("sessionId", id),
                    ("entryId", f.get(c"entry")?),
                    ("now", now),
                ],
            )?;
            for k in [c"toIndex".as_ref(), c"direction", c"actor"] {
                opts.set(k, f.get(k)?)?;
            }
            call(store, c"mutateSync", &[text(s, "scheduleReorder")?, opts])?
        }
        Status | List | Summaries => return call(store, c"read", &[mutate()?]),
        Detached if c.nullish()? => return call(store, c"read", &[mutate()?]),
        Persisted => return then(f, run(s, Status, &[id])?, persistent_verdict),
        Resolve => {
            let action = f.get(c"action")?;
            if has(action, &["retry", "resume"])? {
                return then(f, run(s, Status, &[id])?, retry);
            }
            if !has(action, &["skip", "cancel", "resolve"])? {
                let mut message: Vec<u16> = "invalid resolution action: ".encode_utf16().collect();
                message.extend(action.coerce_string()?.into_units());
                return Err(crate::js_iteration::type_error(f.env(), &message));
            }
            call(store, c"mutate", &[mutate()?])?
        }
        Recover => return recovery::recover(f),
        _ => call(store, c"mutate", &[mutate()?])?,
    };
    then(f, result, move |f, r| events::settled(f, op, r))
}

fn persistent_verdict<'a>(f: L<'a>, current: L<'a>) -> Result<L<'a>> {
    let a = f.get(c"a")?;
    let s = f.get(c"owner")?;
    let recovered = f.get(c"opts")?;
    let id = f.get(c"id")?;
    let active = current.optional(c"active")?;
    if !active.truthy()? || !active.get(c"deliveryId")?.equals(a.get(c"id")?)? {
        return code(s, "active_delivery_mismatch");
    }
    let start = or(active.get(c"startedAt")?, active.get(c"claimedAt")?)?.explicit_number()?;
    let end = recovered.get(c"endedAt")?.explicit_number()?;
    let cls = recovered.get(c"classifyState")?;
    let task = active.get(c"taskId")?;
    let other = recovered.get(c"taskId")?;
    let proven = cls.is_string("D")?
        && start.is_finite()
        && start > 0.
        && end.is_finite()
        && end >= start
        && (!task.truthy()? || !other.truthy()? || task.equals(other)?);
    if proven || has(cls, &classify_vocab::CLASSIFY_STATES)? {
        let options = fields(
            f,
            &[
                ("expectedTaskId", schedule_claim_live::task_id(a)?),
                (
                    "reason",
                    text(
                        f,
                        &if proven {
                            "recovered-success".into()
                        } else {
                            format!("recovered_{}", describe(cls)?)
                        },
                    )?,
                ),
                ("classifyState", cls),
            ],
        )?;
        run(s, Complete, &[id, options])
    } else {
        run(s, Ended, &[id])
    }
}
fn retry<'a>(f: L<'a>, current: L<'a>) -> Result<L<'a>> {
    let s = f.get(c"owner")?;
    let id = f.get(c"id")?;
    let action = f.get(c"action")?;
    if !current.get(c"classifyState")?.is_string("E")? {
        return code(s, "active_task_not_retryable");
    }
    let active = current.get(c"active")?;
    let lineage = or(active, current.get(c"lastDecision")?)?;
    let key = f.get(c"idempotencyKey")?;
    let effective = if key.truthy()? {
        key
    } else {
        let at = call(s.global()?.get(c"Date")?, c"now", &[])?;
        text(
            s,
            &format!(
                "{}:{}:{}",
                describe(action)?,
                describe(or(lineage.optional(c"entryId")?, id)?)?,
                describe(at)?
            ),
        )?
    };
    let opts = fields(
        s,
        &[
            ("originContinue", flag(s, true)?),
            (
                "taskId",
                fallback(lineage.optional(c"taskId")?, V::Undefined)?,
            ),
            (
                "originDispatchId",
                fallback(lineage.optional(c"originDispatchId")?, V::Undefined)?,
            ),
            ("clientMsgId", fallback(key, V::Undefined)?),
        ],
    )?;
    let input = fields(
        s,
        &[
            ("sessionId", id),
            ("source", text(s, "manual-resolution")?),
            ("workKind", action),
            (
                "text",
                fallback(
                    string(fallback(f.get(c"text")?, V::string(""))?)?.clean_text()?,
                    V::string("请继续刚才未完成的任务。"),
                )?,
            ),
            (
                "activeEntryId",
                fallback(active.optional(c"entryId")?, V::Null)?,
            ),
            ("idempotencyKey", effective),
            ("options", opts),
        ],
    )?;
    run(s, Admit, &[input])
}

fn draft_operation<'a>(f: L<'a>, op: Op, d: L<'a>) -> Result<L<'a>> {
    let owner = f.get(c"owner")?;
    let id = f.get(c"id")?;
    let a = f.get(c"a")?;
    match op {
        Status => return projection::status(owner, d, id),
        List => return projection::list(d),
        Summaries => return projection::summaries(owner, d, f.get(c"requested")?),
        _ => {}
    }
    let ctx = fields(d, &[("draft", d), ("id", id), ("owner", owner)])?;
    let project = || {
        function(ctx, "", 1, 2, move |ctx, v| {
            let d = ctx.get(c"draft")?;
            let rows = if v[1].undefined()? {
                let key = ctx.get(c"id")?;
                let session = if matches!(op, Claim | Started | Release) {
                    key.get(c"sessionId")?
                } else {
                    key
                };
                projection::queue(d, session)?
            } else {
                v[1]
            };
            projection::project(d, v[0], rows)
        })
    };
    let queue_fn = || {
        function(ctx, "", 1, 1, |ctx, v| {
            projection::queue(ctx.get(c"draft")?, default(v[0], ctx.get(c"id")?)?)
        })
    };
    let clock = arg(owner.get(c"now")?)?;
    let result = match op {
        Claim => schedule_claim_live::schedule_claim_live(
            env(d),
            arg(d)?,
            arg(a)?,
            clock,
            arg(project()?)?,
        )?,
        Started | Release | Ended => life::schedule_lifecycle_live(
            env(d),
            arg(d)?,
            match op {
                Started => "started",
                Release => "releaseClaim",
                _ => "turnEnded",
            }
            .into(),
            arg(a)?,
            clock,
            arg(project()?)?,
        )?,
        Freeze => life::schedule_freeze_live(
            env(d),
            arg(d)?,
            arg(id)?,
            arg(f.get(c"b")?)?,
            arg(f.get(c"requestId")?)?,
            arg(f.get(c"expectedTaskId")?)?,
            arg(f.get(c"classifyState")?)?,
            clock,
            arg(project()?)?,
        )?,
        Resolve => life::schedule_resolve_live(
            env(d),
            arg(d)?,
            arg(id)?,
            arg(f.get(c"action")?)?,
            arg(f.get(c"reason")?)?,
            arg(f.get(c"actor")?)?,
            clock,
            arg(project()?)?,
        )?,
        Settle => schedule_settle_live::schedule_settle_live(
            env(d),
            arg(d)?,
            arg(id)?,
            arg(f.get(c"b")?)?,
            clock,
        )?,
        Cancel => life::schedule_cancel_queued_live(
            env(d),
            arg(d)?,
            arg(id)?,
            arg(f.get(c"entry")?)?,
            arg(f.get(c"actor")?)?,
            arg(f.get(c"reason")?)?,
            clock,
            arg(project()?)?,
        )?,
        Detached => crate::detached_result::detached_result_live(
            env(d),
            arg(d)?,
            arg(id)?,
            arg(f.get(c"b")?)?,
            arg(f.get(c"c")?)?,
            clock,
            arg(project()?)?,
        )?,
        Insert => schedule_insert_queued_live::schedule_insert_queued_live(
            env(d),
            arg(d)?,
            arg(id)?,
            arg(f.get(c"entry")?)?,
            arg(f.get(c"actor")?)?,
            clock,
            arg(function(ctx, "", 0, 0, |c, _| {
                pending(c.get(c"owner")?, c.get(c"id")?)
            })?)?,
            arg(project()?)?,
        )?,
        Edit => life::schedule_edit_queued_live(
            env(d),
            arg(d)?,
            arg(id)?,
            arg(f.get(c"entry")?)?,
            arg(f.get(c"text")?)?,
            arg(f.get(c"actor")?)?,
            clock,
            arg(queue_fn()?)?,
            arg(project()?)?,
        )?,
        Note => schedule_note_queued_live::schedule_note_queued_live(
            env(d),
            arg(d)?,
            arg(a)?,
            clock,
            arg(queue_fn()?)?,
            arg(function(ctx, "", 2, 2, |c, v| {
                select(c.get(c"owner")?, v[0], c.get(c"draft")?, v[1])
            })?)?,
            arg(project()?)?,
        )?,
        _ => unreachable!(),
    };
    Ok(raw(d, result))
}
