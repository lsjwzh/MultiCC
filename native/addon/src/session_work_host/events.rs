use super::*;

fn broadcast<'a>(s: L<'a>, id: L<'a>, frame: L<'a>) -> Result<L<'a>> {
    call(s.get(c"deps")?, c"broadcast", &[id, frame])
}
fn on_event<'a>(s: L<'a>, ev: L<'a>) -> Result<L<'a>> {
    let kind = ev.get(c"type")?;
    let state = match kind.string()?.map(|v| v.to_string_lossy()).as_deref() {
        Some("queued") => {
            let old = ev.get(c"schedulerState")?;
            if old.is_string("idle")? {
                text(s, "queued")?
            } else {
                fallback(old, "queued".into())?
            }
        }
        Some("started" | "claimed" | "resumed") => text(s, "running")?,
        Some("queued_cancelled" | "queued_inserted" | "queued_reordered" | "queued_edited") => {
            fallback(ev.get(c"schedulerState")?, "idle".into())?
        }
        _ => kind,
    };
    let frame = fields(
        s,
        &[
            ("type", text(s, "session_queue")?),
            ("event", kind),
            ("state", state),
        ],
    )?;
    for key in [
        c"entryId".as_ref(),
        c"taskId",
        c"queuePosition",
        c"workKind",
        c"message",
        c"clientMsgId",
        c"attemptOutcome",
        c"supersededByEntryId",
    ] {
        frame.set(key, fallback(ev.get(key)?, V::Null)?)?;
    }
    let queued = ev.get(c"queued")?;
    frame.set(c"queued", if queued.nullish()? { null(s)? } else { queued })?;
    let items = ev.get(c"queuedItems")?;
    frame.set(
        c"items",
        if items.is_array()? {
            items
        } else {
            s.global()?.get(c"Array")?.construct(&[])?
        },
    )?;
    frame.set(
        c"active",
        fallback(ev.get(c"schedule")?.optional(c"active")?, V::Null)?,
    )?;
    frame.set(
        c"freezeReason",
        fallback(ev.get(c"freezeReason")?, V::Null)?,
    )?;
    frame.set(c"at", ev.get(c"at")?)?;
    let id = ev.get(c"sessionId")?;
    broadcast(s, id, frame)?;
    let deps = s.get(c"deps")?;
    call(
        deps,
        c"setTaskState",
        &[
            id,
            fields(
                s,
                &[
                    ("queueState", state),
                    (
                        "queueFreezeReason",
                        fallback(ev.get(c"freezeReason")?, V::Null)?,
                    ),
                    ("queueUpdatedAt", ev.get(c"at")?),
                ],
            )?,
        ],
    )?;
    let summary = ev.get(c"queueSummary")?;
    if summary.truthy()? {
        call(deps, c"onWorkspaceQueueStatus", &[id, summary])?;
    }
    call(deps, c"onTaskBoardQueueEvent", &[ev])?;
    undef(s)
}
fn published<'a>(s: L<'a>, signal: L<'a>, recorded: L<'a>) -> Result<L<'a>> {
    if recorded.get(c"ok")?.truthy()? {
        let id = signal.get(c"sessionId")?;
        let input = crate::js_live::spread(signal)?;
        input.set(
            c"taskId",
            call(s.get(c"deps")?, c"getChatSession", &[id])?.optional(c"_currentTaskId")?,
        )?;
        let options = signal.get(c"options")?;
        input.set(
            c"options",
            if options.is_array()? {
                options
            } else {
                s.global()?.get(c"Array")?.construct(&[])?
            },
        )?;
        broadcast(s, id, question("requiredFrame", input)?)?;
    }
    Ok(recorded)
}
fn record<'a>(s: L<'a>, signal: L<'a>, asynchronous: bool) -> Result<L<'a>> {
    let deps = s.get(c"deps")?;
    let host = deps.get(c"userInputSignalHost")?;
    let frame = saved(s, &[("signal", signal)])?;
    if host.optional(c"recordCommitted")?.truthy()? {
        let notify = callback(frame, "", 1, 1, |f, a| {
            broadcast(f.get(c"host")?, f.get(c"signal")?.get(c"sessionId")?, a[0])
        })?;
        return call(
            host,
            if asynchronous {
                c"recordAsync"
            } else {
                c"record"
            },
            &[signal, notify],
        );
    }
    if asynchronous {
        let f = host.optional(c"recordAsync")?;
        let f = if f.truthy()? {
            f
        } else {
            deps.get(c"recordUserInput")?
        };
        return after(frame, f.call_plain(&[signal])?, |f, r| {
            published(f.get(c"host")?, f.get(c"signal")?, r)
        });
    }
    published(s, signal, call(deps, c"recordUserInput", &[signal])?)
}
fn replay_question<'a>(send: L<'a>, pending: L<'a>, last: L<'a>) -> Result<()> {
    let frame = question(
        "replay",
        fields(send, &[("pending", pending), ("last", last)])?,
    )?;
    if frame.truthy()? {
        send.call_plain(&[frame])?;
    }
    Ok(())
}
fn replay_queue<'a>(s: L<'a>, id: L<'a>, send: L<'a>) -> Result<L<'a>> {
    let sch = scheduler(s)?;
    let value = if sch.nullish()? {
        undef(s)?
    } else {
        call(sch, c"status", &[id])?
    };
    let p = after(send, value, |send, q| {
        if q.truthy()? {
            let items = q.get(c"queued")?;
            send.call_plain(&[fields(
                q,
                &[
                    ("type", text(q, "session_queue")?),
                    ("event", text(q, "snapshot")?),
                    ("state", q.get(c"state")?),
                    ("queued", items.get(c"length")?),
                    ("items", items),
                    ("freezeReason", q.get(c"freezeReason")?),
                    ("active", q.get(c"active")?),
                ],
            )?])?;
        }
        undef(send)
    })?;
    call(p, c"catch", &[callback(s, "", 0, 0, |s, _| undef(s))?])?;
    undef(s)
}
fn replay<'a>(s: L<'a>, id: L<'a>, send: L<'a>, asynchronous: bool) -> Result<L<'a>> {
    let deps = s.get(c"deps")?;
    let host = deps.get(c"userInputSignalHost")?;
    if asynchronous && is_function(host.optional(c"snapshotAsync")?)? {
        let f = saved(s, &[("id", id), ("send", send)])?;
        return after(f, call(host, c"snapshotAsync", &[id])?, |f, q| {
            let send = f.get(c"send")?;
            replay_question(
                send,
                q.get(c"pendingQuestion")?,
                q.get(c"category")?.optional(c"lastResolvedUserInput")?,
            )?;
            replay_queue(f.get(c"host")?, f.get(c"id")?, send)
        });
    }
    let pending = call(deps, c"pendingUserInput", &[id])?;
    let last = if is_function(host.optional(c"lastResolved")?)? {
        call(host, c"lastResolved", &[id])?
    } else {
        call(deps, c"getTaskState", &[call(deps, c"getRecord", &[id])?])?
            .optional(c"lastResolvedUserInput")?
    };
    replay_question(send, pending, last)?;
    replay_queue(s, id, send)
}
pub(super) fn install<'a>(s: L<'a>, api: L<'a>) -> Result<()> {
    bind(api, s, c"onSchedulerEvent", 1, 1, |s, a| on_event(s, a[0]))?;
    bind(api, s, c"recordInput", 1, 1, |s, a| record(s, a[0], false))?;
    bind(api, s, c"recordInputAsync", 1, 1, |s, a| {
        async_result(s, || record(s, a[0], true))
    })?;
    bind(api, s, c"replayState", 2, 2, |s, a| {
        replay(s, a[0], a[1], false)
    })?;
    bind(api, s, c"replayStateAsync", 2, 2, |s, a| {
        async_result(s, || replay(s, a[0], a[1], true))
    })
}
