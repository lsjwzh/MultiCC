use super::*;
use crate::schedule_claim_live::task_id;

pub(super) fn emit<'a>(owner: L<'a>, kind: &str, fields_in: L<'a>, schedule: L<'a>) -> Result<()> {
    let event = fields(
        owner,
        &[("type", text(owner, kind)?), ("at", clock(owner)?)],
    )?;
    event.spread_from(fields_in)?;
    if schedule.truthy()? {
        event.set(
            c"queueSummary",
            projection::summary(schedule, null(owner)?)?,
        )?;
    }
    owner.catch(|| owner.get(c"onEvent")?.call_plain(&[event]))?;
    owner.catch(|| {
        owner.get(c"log")?.call_plain(&[text(
            owner,
            &format!(
                "[session-scheduler] {kind} {}",
                describe(json(fields_in, c"stringify")?)?
            ),
        )?])
    })?;
    Ok(())
}
fn started<'a>(s: L<'a>, item: L<'a>, schedule: L<'a>) -> Result<()> {
    let queued = schedule.get(c"queued")?;
    let active = schedule.get(c"active")?;
    emit(
        s,
        "started",
        fields(
            s,
            &[
                ("sessionId", item.get(c"sessionId")?),
                ("entryId", active.optional(c"entryId")?),
                ("deliveryId", item.get(c"id")?),
                ("taskId", fallback(active.optional(c"taskId")?, V::Null)?),
                ("queued", queued.get(c"length")?),
                ("queuedItems", queued),
            ],
        )?,
        schedule,
    )
}
fn queued_cancel<'a>(s: L<'a>, id: L<'a>, result: L<'a>) -> Result<()> {
    let schedule = result.get(c"schedule")?;
    let queue = schedule.get(c"queued")?;
    let cancelled = result.get(c"cancelled")?;
    emit(
        s,
        "queued_cancelled",
        fields(
            s,
            &[
                ("sessionId", id),
                ("entryId", cancelled.get(c"entryId")?),
                ("actor", cancelled.get(c"actor")?),
                ("schedulerState", schedule.get(c"state")?),
                ("queued", queue.get(c"length")?),
                ("queuedItems", queue),
                ("freezeReason", schedule.get(c"freezeReason")?),
            ],
        )?,
        schedule,
    )
}
pub(crate) fn publish_withdrawals<'a>(owner: L<'a>, changes: L<'a>) -> Result<()> {
    let session = changes.get(c"sessionId")?;
    let removed = owner.get(c"onWaitCancelled")?;
    if callable(removed)? {
        changes.get(c"pendingWaitIds")?.for_each(|id| {
            removed.call_plain(&[session, id])?;
            Ok(())
        })?;
    }
    let schedule = changes.get(c"schedule")?;
    changes.get(c"cancelled")?.for_each(|entry| {
        queued_cancel(
            owner,
            session,
            fields(owner, &[("schedule", schedule), ("cancelled", entry)])?,
        )
    })
}
pub(super) fn settled<'a>(f: L<'a>, op: Op, r: L<'a>) -> Result<L<'a>> {
    use Op::*;
    let owner = f.get(c"owner")?;
    let a = f.get(c"a")?;
    let id = f.get(c"id")?;
    if op == Handoff {
        let sched = r.get(c"started")?;
        if sched.truthy()? {
            started(owner, a, sched)?;
        }
        return r.get(c"acknowledged");
    }
    if op == Detached {
        let change = r.get(c"queueChange")?;
        let reply = crate::js_live::spread(r)?;
        reply.delete(c"queueChange")?;
        if change.truthy()? {
            queued_cancel(owner, id, change)?;
        }
        if r.get(c"wakeupChanges")?.truthy()? {
            publish_withdrawals(owner, r.get(c"wakeupChanges")?)?;
            reply.delete(c"wakeupChanges")?;
        }
        return Ok(reply);
    }
    if op == Note {
        if !r.truthy()? {
            return code(owner, "entry_not_found");
        }
        return note(owner, r);
    }
    if !r.get(c"ok")?.truthy()? {
        return Ok(r);
    }
    let schedule = r.get(c"schedule")?;
    if op == Cancel {
        queued_cancel(owner, id, r)?;
        return Ok(r);
    }
    if op == Started {
        if !r.get(c"late")?.truthy()? {
            started(owner, a, schedule)?;
        }
        return Ok(r);
    }
    if op == Admit {
        if !r.get(c"shellReplay")?.truthy()? {
            admission(owner, r, schedule)?;
        }
        return Ok(r);
    }
    if op == Reorder && r.get(c"unchanged")?.truthy()? {
        return Ok(r);
    }
    let id = if matches!(op, Claim | Release) {
        a.get(c"sessionId")?
    } else {
        id
    };
    let queue = schedule.get(c"queued")?;
    let active = schedule.get(c"active")?;
    let out = fields(
        owner,
        &[
            ("sessionId", id),
            ("queued", queue.get(c"length")?),
            ("queuedItems", queue),
        ],
    )?;
    let name = match op {
        Claim => {
            out.set(c"entryId", a.get(c"id")?)?;
            out.set(c"taskId", fallback(active.optional(c"taskId")?, V::Null)?)?;
            "claimed"
        }
        Release => {
            out.set(c"entryId", a.get(c"id")?)?;
            out.set(c"taskId", or(active.optional(c"taskId")?, task_id(a)?)?)?;
            out.set(c"reason", f.get(c"reason")?)?;
            out.set(c"freezeReason", schedule.get(c"freezeReason")?)?;
            "claim_released"
        }
        Ended => {
            out.set(c"entryId", fallback(active.optional(c"entryId")?, V::Null)?)?;
            out.set(c"taskId", fallback(active.optional(c"taskId")?, V::Null)?)?;
            out.set(c"schedulerState", text(out, "assessing")?)?;
            "assessing"
        }
        Freeze => {
            out.set(c"entryId", active.optional(c"entryId")?)?;
            out.set(c"taskId", fallback(active.optional(c"taskId")?, V::Null)?)?;
            out.set(c"freezeReason", schedule.get(c"freezeReason")?)?;
            "frozen"
        }
        Complete => {
            let completed = r.get(c"completed")?;
            let superseded = completed.get(c"supersededByEntryId")?;
            let cls = schedule.get(c"classifyState")?;
            let cls_text = cls
                .string()?
                .map(|s| s.to_string_lossy())
                .unwrap_or_default();
            let vocabulary = classify_vocab::catalog_value();
            let outcome = vocabulary["classifyTurnOutcome"][&cls_text]
                .as_str()
                .unwrap_or("waiting_user");
            out.set(c"entryId", completed.get(c"entryId")?)?;
            out.set(c"taskId", fallback(completed.get(c"taskId")?, V::Null)?)?;
            out.set(c"classifyState", fallback(cls, V::Null)?)?;
            out.set(c"turnOutcome", text(out, outcome)?)?;
            out.set(c"reason", f.get(c"reason")?)?;
            out.set(
                c"attemptOutcome",
                if superseded.truthy()? {
                    text(out, "superseded")?
                } else {
                    null(out)?
                },
            )?;
            out.set(c"supersededByEntryId", fallback(superseded, V::Null)?)?;
            "completed"
        }
        Resolve => {
            let resolved = r.get(c"resolved")?;
            out.set(c"entryId", resolved.get(c"entryId")?)?;
            out.set(c"taskId", fallback(resolved.get(c"taskId")?, V::Null)?)?;
            out.set(c"action", f.get(c"action")?)?;
            out.set(c"actor", f.get(c"actor")?)?;
            if f.get(c"action")?.is_string("cancel")? {
                "cancelled"
            } else {
                "skipped"
            }
        }
        Reorder | Edit | Insert => {
            let row = r.get(match op {
                Reorder => c"reordered",
                Edit => c"edited",
                _ => c"inserted",
            })?;
            out.set(c"entryId", row.get(c"entryId")?)?;
            out.set(c"actor", f.get(c"actor")?)?;
            out.set(c"schedulerState", schedule.get(c"state")?)?;
            out.set(c"freezeReason", schedule.get(c"freezeReason")?)?;
            if op == Reorder {
                for k in [c"from".as_ref(), c"to"] {
                    out.set(k, row.get(k)?)?;
                }
            }
            match op {
                Reorder => "queued_reordered",
                Edit => "queued_edited",
                _ => "queued_inserted",
            }
        }
        _ => unreachable!(),
    };
    emit(owner, name, out, schedule)?;
    Ok(r)
}
fn admission<'a>(owner: L<'a>, r: L<'a>, schedule: L<'a>) -> Result<()> {
    let entry = r.get(c"entry")?;
    let payload = entry.get(c"payload")?;
    let id = entry.get(c"id")?;
    let queued = r.get(c"queued")?;
    let queue = schedule.get(c"queued")?;
    let shown = if queued.truthy()? {
        queue
    } else {
        let mut items = Vec::new();
        queue.for_each(|item| {
            if !item.get(c"entryId")?.equals(id)? {
                items.push(item);
            }
            Ok(())
        })?;
        array(owner, &items)?
    };
    emit(
        owner,
        "queued",
        fields(
            owner,
            &[
                ("message", fallback(payload.optional(c"message")?, V::Null)?),
                (
                    "clientMsgId",
                    fallback(
                        payload.optional(c"options")?.optional(c"clientMsgId")?,
                        V::Null,
                    )?,
                ),
                ("sessionId", entry.get(c"sessionId")?),
                ("entryId", id),
                ("taskId", fallback(payload.optional(c"taskId")?, V::Null)?),
                (
                    "source",
                    fallback(payload.optional(c"source")?, V::string("direct"))?,
                ),
                (
                    "workKind",
                    fallback(payload.optional(c"workKind")?, V::string("task"))?,
                ),
                ("duplicate", r.get(c"duplicate")?),
                ("queued", queued),
                (
                    "queuePosition",
                    if queued.truthy()? {
                        fallback(r.get(c"position")?, V::Null)?
                    } else {
                        null(r)?
                    },
                ),
                ("schedulerState", schedule.get(c"state")?),
                ("freezeReason", schedule.get(c"freezeReason")?),
                ("queuedItems", shown),
            ],
        )?,
        schedule,
    )
}
// Only event metadata may escape the draft. A wait's data can be much
// larger than its preview, so do not JSON-clone the full outbox item here.
pub(super) fn note_fields(item: L<'_>) -> Result<L<'_>> {
    let typ = item.optional(c"payload")?.optional(c"type")?;
    let item = if has(
        typ,
        &multicc_core::orchestration_store::queue_preview::WAIT_TYPES,
    )? {
        item
    } else {
        crate::schedule_note_queued_live::clone_item(item)?
    };
    let p = item.get(c"payload")?;
    fields(
        item,
        &[
            ("sessionId", item.get(c"sessionId")?),
            ("entryId", item.get(c"id")?),
            ("taskId", task_id(item)?),
            (
                "source",
                or(
                    p.optional(c"taskSource")?,
                    fallback(
                        item.optional(c"source")?.optional(c"type")?,
                        V::string("dispatch"),
                    )?,
                )?,
            ),
            ("workKind", kind(item)?),
            ("message", queue_text::bounded_text(p)?),
            (
                "clientMsgId",
                fallback(p.optional(c"options")?.optional(c"clientMsgId")?, V::Null)?,
            ),
        ],
    )
}
fn note<'a>(owner: L<'a>, info: L<'a>) -> Result<L<'a>> {
    let event = info.get(c"item")?;
    let sched = info.get(c"schedule")?;
    let position = fallback(info.get(c"position")?, V::Null)?;
    event.set(c"duplicate", flag(owner, false)?)?;
    event.set(c"queued", info.get(c"queued")?)?;
    event.set(c"queuePosition", position)?;
    event.set(c"schedulerState", info.get(c"schedulerState")?)?;
    event.set(c"freezeReason", sched.get(c"freezeReason")?)?;
    event.set(c"queuedItems", sched.get(c"queued")?)?;
    emit(owner, "queued", event, sched)?;
    fields(owner, &[("ok", flag(owner, true)?), ("position", position)])
}
