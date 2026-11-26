//! Session-wide cancellation and indexed read projections.
use super::*;
fn terminal_set<'a>(s: L<'a>, collection: &str) -> Result<L<'a>> {
    if collection == "tasks" {
        s.get(c"TERMINAL_TASK_STATES")
    } else {
        s.get(c"TERMINAL_OPERATION_STATES")
    }
}
fn non_terminal<'a>(s: L<'a>, collection: &str) -> Result<L<'a>> {
    let values = call(
        s.global()?.get(c"Array")?,
        c"from",
        &[terminal_set(s, collection)?],
    )?;
    fields(s, &[("$nin", values)])
}
fn unfinished<'a>(s: L<'a>, collection: &str, row: L<'a>) -> Result<bool> {
    Ok(!call(terminal_set(s, collection)?, c"has", &[row.get(c"status")?])?.truthy()?)
}
fn active_states(s: L<'_>) -> Result<L<'_>> {
    s.from_value(&V::Array(vec!["pending".into(), "leased".into()]))
}
fn deliverable(row: L<'_>) -> Result<bool> {
    let val = row.get(c"state")?;
    Ok(val.is_string("pending")? || val.is_string("leased")?)
}
pub(super) fn list<'a>(s: L<'a>, session: L<'a>) -> Result<L<'a>> {
    let f = fields(
        s,
        &[("sessionId", session), ("status", text(s, "pending")?)],
    )?;
    after(s, service(s, c"waits", c"list", &[f])?, |s, rows| {
        let out = arr(s)?;
        rows.for_each(|w| {
            call(out, c"push", &[public_wait(w)?])?;
            Ok(())
        })?;
        Ok(out)
    })
}
pub(super) fn stats(s: L<'_>) -> Result<L<'_>> {
    let read = callback(s, "", 1, 1, |s, a| {
        let snapshot = a[0];
        let indexed = snapshot.get(c"count")?.kind()? == sys::ValueType::napi_function;
        let out = fields(
            s,
            &[(
                "backend",
                fallback(s.get(c"store")?.get(c"backend")?, "json".into())?,
            )],
        )?;
        for (name, collection, key, value) in [
            ("waits", "waits", "status", "pending"),
            ("resolvedWaits", "waits", "status", "resolved"),
            ("pendingDeliveries", "outbox", "state", ""),
            ("deadLetters", "outbox", "state", "dead-letter"),
        ] {
            let filter = fields(
                s,
                &[(
                    key,
                    if value.is_empty() {
                        active_states(s)?
                    } else {
                        text(s, value)?
                    },
                )],
            )?;
            let count = if indexed {
                call(snapshot, c"count", &[text(s, collection)?, filter])?
            } else {
                let mut count = 0.;
                call(
                    s.global()?.get(c"Object")?,
                    c"values",
                    &[get(snapshot, collection)?],
                )?
                .for_each(|r| {
                    if if value.is_empty() {
                        deliverable(r)?
                    } else {
                        get(r, key)?.is_string(value)?
                    } {
                        count += 1.;
                    }
                    Ok(())
                })?;
                num(s, count)?
            };
            set(out, name, count)?;
        }
        Ok(out)
    })?;
    service(s, c"store", c"read", &[read])
}
pub(super) fn has_activity<'a>(s: L<'a>, session: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let stale = default_object(opts)?.get(c"staleMs")?.explicit_number()?;
    let id = trim(fallback(session, "".into())?)?;
    if !id.truthy()? {
        return flag(s, false);
    }
    let cutoff = if stale > 0. {
        num(s, clock(s)? - stale)?
    } else {
        null(s)?
    };
    let st = state(s, &[("id", id), ("cutoff", cutoff)])?;
    let read = callback(st, "", 1, 1, |st, a| {
        let s = st.get(c"s")?;
        let id = st.get(c"id")?;
        let cutoff = st.get(c"cutoff")?;
        let draft = a[0];
        let fresh = |row: L| -> Result<bool> {
            Ok(cutoff.nullish()?
                || fallback(
                    first_truthy(row, c"updatedAt", c"createdAt")?,
                    V::Number(0.),
                )?
                .explicit_number()?
                    >= cutoff.number()?)
        };
        for collection in ["waits", "outbox", "operations", "tasks"] {
            let filter = match collection {
                "waits" => fields(s, &[("sessionId", id), ("status", text(s, "pending")?)])?,
                "outbox" => fields(s, &[("sessionId", id), ("state", active_states(s)?)])?,
                "tasks" => fields(
                    s,
                    &[
                        ("parentSessionId", id),
                        ("status", non_terminal(s, collection)?),
                    ],
                )?,
                _ => fields(s, &[("status", non_terminal(s, collection)?)])?,
            };
            let mut hit = false;
            candidate(draft, collection, filter)?.for_each_while(|r| {
                hit = match collection {
                    "waits" => {
                        r.get(c"sessionId")?.equals(id)?
                            && r.get(c"status")?.is_string("pending")?
                            && fresh(r)?
                    }
                    "outbox" => r.get(c"sessionId")?.equals(id)? && deliverable(r)? && fresh(r)?,
                    "tasks" => {
                        r.get(c"parentSessionId")?.equals(id)?
                            && unfinished(s, collection, r)?
                            && fresh(r)?
                    }
                    _ => {
                        unfinished(s, collection, r)?
                            && fresh(r)?
                            && (r.get(c"ownerSessionId")?.equals(id)?
                                || r.get(c"spec")?.optional(c"chatId")?.equals(id)?
                                || r.get(c"spec")?.optional(c"targetId")?.equals(id)?)
                    }
                };
                Ok(!hit)
            })?;
            if hit {
                return flag(s, true);
            }
        }
        let schedule = draft.get(c"sessionSchedules")?.get_key(id)?;
        flag(
            s,
            schedule.optional(c"active")?.truthy()?
                && !schedule.get(c"classifyState")?.is_string("W")?
                && !schedule
                    .get(c"freezeReason")?
                    .is_string("awaiting_user_input")?
                && !schedule
                    .get(c"freezeReason")?
                    .is_string("classify_waiting")?
                && fresh(schedule)?,
        )
    })?;
    service(s, c"store", c"read", &[read])
}

pub(super) fn cancel_for_session<'a>(s: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let st = state(s, &[("id", id)])?;
    let filter = fields(
        s,
        &[
            ("kind", text(s, "dispatch")?),
            ("excludeTerminal", flag(s, true)?),
        ],
    )?;
    let listed = service(s, c"operations", c"listReferences", &[filter])?;
    let completed = after(st, listed, |st, rows| {
        let mut chain = fulfilled(undef(st)?)?;
        rows.for_each(|row| {
            let entry = fields(st, &[("state", st), ("operation", row)])?;
            chain = after(entry, chain, |entry, _| {
                let st = entry.get(c"state")?;
                let s = st.get(c"s")?;
                let id = st.get(c"id")?;
                let r = entry.get(c"operation")?;
                if !unfinished(s, "operations", r)? || r.get(c"ownerSessionId")?.equals(id)? {
                    return undef(s);
                }
                let spec = r.get(c"spec")?;
                if !spec.get(c"chatId")?.equals(id)? && !spec.get(c"targetId")?.equals(id)? {
                    return undef(s);
                }
                service(
                    s,
                    c"operations",
                    c"completeDispatch",
                    &[
                        r.get(c"id")?,
                        fields(
                            s,
                            &[
                                ("status", text(s, "interrupted")?),
                                ("error", text(s, "dispatch target session was deleted")?),
                            ],
                        )?,
                    ],
                )
            })?;
            Ok(())
        })?;
        Ok(chain)
    })?;
    let persisted = after(st, completed, |st, _| {
        let mutate = callback(st, "", 1, 1, |st, a| cancel_draft(st, a[0]))?;
        service(st.get(c"s")?, c"store", c"mutate", &[mutate])
    })?;
    after(st, persisted, |st, r| {
        let s = st.get(c"s")?;
        service(s, c"pendingBySession", c"delete", &[st.get(c"id")?])?;
        let adapter = s.get(c"detachedAdapter")?;
        let detached = r.get(c"detachedExternalIds")?;
        let visible = spread(r)?;
        visible.delete(c"detachedExternalIds")?;
        st.set(c"result", visible)?;
        let mut chain = fulfilled(undef(st)?)?;
        if adapter.truthy()? && adapter.get(c"cancel")?.kind()? == sys::ValueType::napi_function {
            detached.for_each(|id| {
                let entry = state(s, &[("id", id)])?;
                chain = after(entry, chain, |entry, _| {
                    let s = entry.get(c"s")?;
                    let id = entry.get(c"id")?;
                    let attempt =
                        async_result(s, || service(s, c"detachedAdapter", c"cancel", &[id]))?;
                    recover(entry, attempt, |entry, e| {
                        let s = entry.get(c"s")?;
                        log_parts(
                            s,
                            &[
                                text(s, "[orchestration] cancel detached ")?,
                                entry.get(c"id")?,
                                text(s, " failed: ")?,
                                e.get(c"message")?,
                            ],
                        )?;
                        undef(s)
                    })
                })?;
                Ok(())
            })?;
        }
        after(st, chain, |st, _| st.get(c"result"))
    })
}
fn cancel_draft<'a>(st: L<'a>, draft: L<'a>) -> Result<L<'a>> {
    let s = st.get(c"s")?;
    let id = st.get(c"id")?;
    let at = num(s, clock(s)?)?;
    let cancelled = text(s, "cancelled")?;
    let detached = arr(s)?;
    let result = fields(
        s,
        &[("ok", flag(s, true)?), ("detachedExternalIds", detached)],
    )?;
    for (collection, result_key) in [
        ("waits", "cancelled"),
        ("outbox", "cancelledDeliveries"),
        ("operations", "cancelledOperations"),
        ("tasks", "cancelledTasks"),
    ] {
        let filter = match collection {
            "waits" => fields(s, &[("sessionId", id), ("status", text(s, "pending")?)])?,
            "outbox" => fields(s, &[("state", active_states(s)?)])?,
            "operations" => fields(
                s,
                &[
                    ("ownerSessionId", id),
                    ("status", non_terminal(s, collection)?),
                ],
            )?,
            _ => fields(
                s,
                &[
                    ("parentSessionId", id),
                    ("status", non_terminal(s, collection)?),
                ],
            )?,
        };
        let mut n = 0.;
        candidate(draft, collection, filter)?.for_each(|r| {
            match collection {
                "waits" => {
                    if !r.get(c"sessionId")?.equals(id)?
                        || !r.get(c"status")?.is_string("pending")?
                    {
                        return Ok(());
                    }
                    r.assign(c"status", cancelled)?;
                    r.assign(c"cancelledAt", at)?;
                }
                "outbox" => {
                    let src = r.get(c"source")?;
                    let owned = src.optional(c"type")?.is_string("operation")?
                        && draft
                            .get(c"operations")?
                            .get_key(src.get(c"operationId")?)?
                            .optional(c"ownerSessionId")?
                            .equals(id)?;
                    if (!r.get(c"sessionId")?.equals(id)? && !owned) || !deliverable(r)? {
                        return Ok(());
                    }
                    r.assign(c"state", cancelled)?;
                    for k in ["leasedAt", "leasedUntil", "leaseOwner", "leaseTokenHash"] {
                        set(r, k, null(s)?)?;
                    }
                }
                "operations" => {
                    if !r.get(c"ownerSessionId")?.equals(id)? || !unfinished(s, collection, r)? {
                        return Ok(());
                    }
                    r.assign(c"status", cancelled)?;
                    r.assign(c"cancelledAt", at)?;
                    if r.get(c"kind")?.is_string("detached")? && r.get(c"externalId")?.truthy()? {
                        call(detached, c"push", &[r.get(c"externalId")?])?;
                    }
                }
                _ => {
                    if !r.get(c"parentSessionId")?.equals(id)? || !unfinished(s, collection, r)? {
                        return Ok(());
                    }
                    r.assign(c"status", cancelled)?;
                    r.assign(c"completedAt", at)?;
                }
            }
            r.assign(c"updatedAt", at)?;
            n += 1.;
            Ok(())
        })?;
        set(result, result_key, num(s, n)?)?;
    }
    let schedules = draft.get(c"sessionSchedules")?;
    if schedules.get_key(id)?.truthy()? {
        call(
            s.global()?.get(c"Reflect")?,
            c"deleteProperty",
            &[schedules, id],
        )?;
    }
    Ok(result)
}
