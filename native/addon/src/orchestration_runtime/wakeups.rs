//! An admission can replace only older wake-ups. Observe external completion
//! before admission, then recheck generation, ownership and FIFO state in the
//! same store transaction that creates the replacement. Reads never advance it.
use super::waits::candidate;
use super::*;
use crate::host_api::array;
use crate::schedule_lifecycle_live::cancel_pending_entry;
use multicc_core::orchestration_store::{
    wakeup::{wait_withdrawal, WaitWithdrawal},
    TERMINAL_TASK_STATES,
};

fn active_entry<'a>(draft: L<'a>, session: L<'a>) -> Result<L<'a>> {
    let id = draft
        .get(c"sessionSchedules")?
        .get_key(session)?
        .optional(c"active")?
        .optional(c"entryId")?;
    if id.kind()? == sys::ValueType::napi_string && id.truthy()? {
        Ok(id)
    } else {
        null(draft)
    }
}

fn generation(row: L<'_>) -> Result<L<'_>> {
    row.optional(c"metadata")?.optional(c"createdInEntryId")
}

fn turn_operations<'a>(
    draft: L<'a>,
    session: L<'a>,
    entry: L<'a>,
    active: bool,
    mut visit: impl FnMut(L<'a>) -> Result<()>,
) -> Result<()> {
    let states: &[&str] = if active {
        &["admitted", "running"]
    } else {
        &TERMINAL_TASK_STATES
    };
    let filter = fields(
        draft,
        &[
            ("ownerSessionId", session),
            ("kind", text(draft, "detached")?),
            ("metadata.createdInEntryId", entry),
            (
                "status",
                draft.from_value(&V::Array(states.iter().copied().map(V::string).collect()))?,
            ),
        ],
    )?;
    candidate(draft, "operations", filter)?.for_each(|op| {
        if op.get(c"kind")?.is_string("detached")?
            && op.get(c"ownerSessionId")?.equals(session)?
            && generation(op)?.equals(entry)?
            && states.contains(&describe(op.get(c"status")?)?.as_str())
        {
            visit(op)?;
        }
        Ok(())
    })
}

fn plan<'a>(f: L<'a>, draft: L<'a>) -> Result<L<'a>> {
    let session = f.get(c"session")?;
    let entry = active_entry(draft, session)?;
    let ops = array(draft)?;
    if entry.truthy()? {
        turn_operations(draft, session, entry, true, |op| {
            call(
                ops,
                c"push",
                &[crate::host_api::pick(op, &[c"id", c"externalId"])?],
            )?;
            Ok(())
        })?;
    }
    fields(draft, &[("entry", entry), ("operations", ops)])
}

pub(super) fn admit<'a>(s: L<'a>, input: L<'a>, detached: bool) -> Result<L<'a>> {
    let f = saved(
        s,
        &[("input", input), ("session", input.get(c"sessionId")?)],
    )?;
    let read = callback(f, "", 1, 1, |f, a| plan(f, a[0]))?;
    let prepared = after(f, service(s, c"store", c"read", &[read])?, |f, plan| {
        let s = f.get(c"runtime")?;
        f.set(c"plan", plan)?;
        let mut work = fulfilled(undef(f)?)?;
        plan.get(c"operations")?.for_each(|op| {
            if s.get(c"detachedAdapter")?.truthy()? {
                let st = saved(s, &[("operation", op)])?;
                work = after(st, work, |st, _| {
                    let s = st.get(c"runtime")?;
                    let status = async_result(s, || {
                        service(
                            s,
                            c"detachedAdapter",
                            c"status",
                            &[st.get(c"operation")?.get(c"externalId")?],
                        )
                    })?;
                    // A failed observation cannot prove completion.
                    let observed = recover(st, status, |st, error| {
                        log(
                            st.get(c"runtime")?,
                            &format!("[orchestration] detached status: {}", error_message(error)?),
                        )?;
                        null(st)
                    })?;
                    after(st, observed, |st, state| {
                        if state.optional(c"done")?.is_true()? {
                            operations::update_detached(st, state)
                        } else {
                            undef(st)
                        }
                    })
                })?;
            }
            Ok(())
        })?;
        Ok(work)
    })?;
    let created = after(f, prepared, move |f, _| {
        let s = f.get(c"runtime")?;
        let input = f.get(c"input")?;
        if detached {
            let p = s.get(c"operationServiceState")?;
            if p.undefined()? {
                return service(s, c"operations", c"admitDetached", &[input]);
            }
            services::admission::admit(p, input, true, f)
        } else {
            let p = s.get(c"waitServiceState")?;
            if p.undefined()? {
                return service(s, c"waits", c"register", &[input]);
            }
            services::waits::register(p, input, f)
        }
    })?;
    after(f, created, |f, result| {
        let changes = result.get(c"wakeupChanges")?;
        if changes.truthy()? {
            crate::session_work_scheduler::publish_withdrawals(
                f.get(c"runtime")?.get(c"schedulerEvents")?,
                changes,
            )?;
            result.delete(c"wakeupChanges")?;
        }
        Ok(result)
    })
}

pub(crate) struct Withdrawals<'a> {
    draft: L<'a>,
    session: L<'a>,
    clock: L<'a>,
    cancelled: L<'a>,
    pending: L<'a>,
    // Project the final queue once after all withdrawals in the transaction.
    defer_projection: L<'a>,
}
impl<'a> Withdrawals<'a> {
    pub(crate) fn new(draft: L<'a>, session: L<'a>, clock: L<'a>) -> Result<Self> {
        Ok(Self {
            draft,
            session,
            clock,
            cancelled: array(draft)?,
            pending: array(draft)?,
            defer_projection: callback(draft, "", 1, 1, |d, _| null(d))?,
        })
    }

    fn cancel_entry(&self, id: L<'a>, reason: &str) -> Result<bool> {
        let change = cancel_pending_entry(
            self.draft,
            self.session,
            id,
            text(id, "system")?,
            text(id, reason)?,
            self.clock,
            self.defer_projection,
        )?;
        if change.get(c"ok")?.is_true()? {
            call(self.cancelled, c"push", &[change.get(c"cancelled")?])?;
            return Ok(true);
        }
        Ok(false)
    }

    fn withdraw_wait(&self, w: L<'a>, reason: &str) -> Result<L<'a>> {
        let id = w.get(c"id")?;
        let status = w.get(c"status")?;
        if status.is_string("pending")? {
            let result = crate::wait_cancel_live::cancel(self.draft, id, self.clock)?;
            if result.get(c"ok")?.is_true()? {
                call(self.pending, c"push", &[id])?;
            }
            return Ok(result);
        }
        let refused = || {
            fields(
                w,
                &[
                    ("ok", flag(w, false)?),
                    ("code", text(w, "not_pending")?),
                    ("status", status),
                ],
            )
        };
        if !status.is_string("resolved")? {
            return refused();
        }
        let stored = w.get(c"outboxId")?;
        let canonical = call(text(w, "wait:")?, c"concat", &[id])?;
        let entry = if stored.kind()? == sys::ValueType::napi_string && stored.truthy()? {
            stored
        } else {
            canonical
        };
        let row = self.draft.get(c"outbox")?.get_key(entry)?;
        if !row.truthy()? || !row.get(c"sessionId")?.equals(self.session)? {
            return refused();
        }
        let owner = row.optional(c"source")?.optional(c"waitId")?;
        if !(owner.equals(id)? || (owner.nullish()? && entry.equals(canonical)?)) {
            return refused();
        }
        let state = row.get(c"state")?.string()?.map(|v| v.to_string_lossy());
        let duplicate = match wait_withdrawal(state.as_deref()) {
            WaitWithdrawal::AlreadyCancelled => true,
            WaitWithdrawal::CancelPending if self.cancel_entry(entry, reason)? => false,
            _ => return refused(),
        };
        fields(
            w,
            &[
                ("ok", flag(w, true)?),
                ("idempotent", flag(w, duplicate)?),
                ("withdrawnFromQueue", flag(w, true)?),
                ("status", text(w, "cancelled")?),
            ],
        )
    }

    pub(crate) fn matching_waits(
        &self,
        tasks: &[L<'a>],
        generation_id: Option<L<'a>>,
        slot: Option<L<'a>>,
        exclude: L<'a>,
        reason: &str,
    ) -> Result<()> {
        if tasks.is_empty() && slot.is_none() {
            return Ok(());
        }
        let filter = fields(
            self.draft,
            &[
                ("sessionId", self.session),
                (
                    "status",
                    self.draft
                        .from_value(&V::Array(vec!["pending".into(), "resolved".into()]))?,
                ),
            ],
        )?;
        if tasks.is_empty() {
            if let Some(slot) = slot {
                filter.set(c"metadata.dedupeKey", slot)?;
            }
        } else if slot.is_none() {
            filter.set(c"mode", text(self.draft, "poll")?)?;
            if let Some(entry) = generation_id {
                filter.set(c"metadata.createdInEntryId", entry)?;
            }
        }
        candidate(self.draft, "waits", filter)?.for_each(|w| {
            if !w.get(c"sessionId")?.equals(self.session)? || w.get(c"id")?.equals(exclude)? {
                return Ok(());
            }
            let m = w.get(c"metadata")?;
            if let Some(slot) = slot {
                if m.optional(c"dedupeKey")?.equals(slot)? {
                    self.withdraw_wait(w, "superseded_by_dedupe_key")?;
                    return Ok(());
                }
            }
            if let Some(entry) = generation_id {
                if !generation(w)?.equals(entry)? {
                    return Ok(());
                }
            }
            let mut target = m.optional(c"detachedTaskId")?;
            // Older rows predate the binding. A versioned ACK can still identify
            // their poll target, but admission never guesses a missing generation.
            if generation_id.is_none() && target.nullish()? && w.get(c"mode")?.is_string("poll")? {
                target = waits::detached_target(m)?;
            }
            for task in tasks {
                if target.equals(*task)? {
                    self.withdraw_wait(w, reason)?;
                    break;
                }
            }
            Ok(())
        })
    }

    pub(crate) fn finish(self) -> Result<L<'a>> {
        let schedule = if self.cancelled.get(c"length")?.truthy()? {
            crate::session_work_scheduler::project_queue(self.draft, self.session)?
        } else {
            null(self.draft)?
        };
        fields(
            self.draft,
            &[
                ("sessionId", self.session),
                ("pendingWaitIds", self.pending),
                ("cancelled", self.cancelled),
                ("schedule", schedule),
            ],
        )
    }
}

pub(super) fn on_admission<'a>(
    f: L<'a>,
    draft: L<'a>,
    row: L<'a>,
    detached: bool,
) -> Result<L<'a>> {
    let s = f.get(c"runtime")?;
    let session = f.get(c"session")?;
    let current = active_entry(draft, session)?;
    let metadata = if detached {
        fields(row, &[])?
    } else {
        row.get(c"metadata")?
    };
    let plan = f.get(c"plan")?;
    // If the turn changed while probing, the request belongs to the original turn.
    metadata.assign(c"createdInEntryId", plan.get(c"entry")?)?;
    if detached {
        row.assign(c"metadata", metadata)?;
    }
    let changes = Withdrawals::new(draft, session, s.get(c"now")?)?;
    let mut tasks = Vec::new();
    if current.truthy()? && current.equals(plan.get(c"entry")?)? {
        turn_operations(draft, session, current, false, |op| {
            let id = op.get(c"externalId")?;
            if id.kind()? != sys::ValueType::napi_string || !id.truthy()? {
                return Ok(());
            }
            tasks.push(id);
            let result = op.get(c"resultOutboxId")?;
            if result.truthy()? {
                let r = draft.get(c"outbox")?.get_key(result)?;
                let p = r.optional(c"payload")?;
                if r.optional(c"state")?.is_string("pending")?
                    && p.optional(c"type")?.is_string("detached.result")?
                    && p.optional(c"operationId")?.equals(op.get(c"id")?)?
                {
                    changes.cancel_entry(result, "superseded_in_same_turn")?;
                }
            }
            Ok(())
        })?;
    }
    let slot = metadata.optional(c"dedupeKey")?;
    changes.matching_waits(
        &tasks,
        Some(current),
        slot.truthy()?.then_some(slot),
        if detached {
            undef(draft)?
        } else {
            row.get(c"id")?
        },
        "superseded_in_same_turn",
    )?;
    changes.finish()
}

// Re-read within the writer transaction: resolution, lease acquisition and
// withdrawal cannot all win even when separate runtime instances race.
pub(super) fn withdraw_resolved<'a>(s: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let f = saved(s, &[("id", id)])?;
    let mutate = callback(f, "", 1, 1, |f, a| {
        let d = a[0];
        let w = d.get(c"waits")?.get_key(f.get(c"id")?)?;
        if !w.truthy()? {
            return fields(
                d,
                &[("ok", flag(d, false)?), ("code", text(d, "not_found")?)],
            );
        }
        let changes = Withdrawals::new(d, w.get(c"sessionId")?, f.get(c"runtime")?.get(c"now")?)?;
        let result = changes.withdraw_wait(w, "wait_cancelled")?;
        result.set(c"wakeupChanges", changes.finish()?)?;
        Ok(result)
    })?;
    after(s, service(s, c"store", c"mutate", &[mutate])?, |s, r| {
        let changes = r.get(c"wakeupChanges")?;
        if changes.truthy()? {
            crate::session_work_scheduler::publish_withdrawals(
                s.get(c"schedulerEvents")?,
                changes,
            )?;
            r.delete(c"wakeupChanges")?;
        }
        Ok(r)
    })
}
