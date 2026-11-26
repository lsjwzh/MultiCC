//! The durable owner commits questions before delivering notifications. A
//! temporary snapshot is visible only during the synchronous part of fn().
use super::*;

fn read<'a>(s: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let context = s.get(c"context")?;
    if context.optional(c"sessionId")?.equals(id)? && !context.nullish()? {
        context.get(c"snapshot")
    } else {
        call(s.get(c"owner")?, c"read", &[id])
    }
}
fn project<'a>(data: L<'a>, key: &CStr) -> Result<L<'a>> {
    if key == c"pending" {
        return fallback(data.get(c"pendingQuestion")?, V::Null);
    }
    fallback(
        data.get(c"category")?.optional(if key == c"turnId" {
            c"userInputSignalTurnId"
        } else {
            c"lastResolvedUserInput"
        })?,
        V::Null,
    )
}
fn notify<'a>(s: L<'a>, id: L<'a>, frame: L<'a>) -> Result<()> {
    if !frame.optional(c"type")?.is_string("user_input_resolved")? {
        return Ok(());
    }
    let extra = crate::js_live::spread(frame)?;
    for key in [c"type".as_ref(), c"requestId", c"taskId"] {
        extra.delete(key)?;
    }
    let keys = call(s.global()?.get(c"Object")?, c"keys", &[extra])?;
    let task = frame.get(c"taskId")?;
    s.get(c"onResolved")?.call_plain(&[
        id,
        frame.get(c"requestId")?,
        if task.nullish()? { null(s)? } else { task },
        if keys.get(c"length")?.truthy()? {
            extra
        } else {
            undef(s)?
        },
    ])?;
    Ok(())
}
fn display(v: L<'_>) -> Result<String> {
    Ok(v.coerce_string()?.to_string_lossy())
}
fn on_write<'a>(f: L<'a>, response: L<'a>, op: &CStr) -> Result<L<'a>> {
    let s = f.get(c"host")?;
    let first = f.get(c"first")?;
    let second = f.get(c"second")?;
    if op == c"record" {
        let result = response.get(c"result")?;
        if result.optional(c"ok")?.truthy()? && !result.get(c"duplicate")?.truthy()? {
            s.get(c"log")?.call_plain(&[text(
                s,
                &format!(
                    "[multicc/classify] {} request_user_input recorded request={} turn={}",
                    display(first.get(c"sessionId")?)?,
                    display(first.get(c"requestId")?)?,
                    display(first.get(c"turnId")?)?
                ),
            )?])?;
            let frame = response.get(c"notification")?;
            if frame.truthy()? && !second.nullish()? {
                second.call_plain(&[frame])?;
            }
        }
        return Ok(result);
    }
    if op == c"move" && !response.get(c"result")?.optional(c"ok")?.truthy()? {
        return response.get(c"result");
    }
    notify(s, first, response.get(c"notification")?)?;
    if op == c"beginTurn" {
        return s.get(c"setState")?.call_plain(&[
            first,
            fields(
                s,
                &[("classifyState", text(s, "P")?), ("goalState", null(s)?)],
            )?,
        ]);
    }
    if op == c"move" {
        s.get(c"setState")?
            .call_plain(&[second, fields(s, &[("classifyState", text(s, "W")?)])?])?;
        let q = response.get(c"question")?;
        return fields(
            s,
            &[
                ("ok", flag(s, true)?),
                ("requestId", q.optional(c"requestId")?),
                ("question", q),
            ],
        );
    }
    let result = response.get(c"result")?;
    if result.optional(c"ok")?.truthy()? && !result.get(c"duplicate")?.truthy()? {
        s.get(c"log")?.call_plain(&[text(
            s,
            &format!(
                "[multicc/classify] {} request_user_input resolved request={}",
                display(first)?,
                display(second)?
            ),
        )?])?;
    }
    Ok(result)
}
pub(super) fn owned(options: L<'_>) -> Result<L<'_>> {
    let owner = options.get(c"owner")?;
    for key in [
        c"read".as_ref(),
        c"record",
        c"beginTurn",
        c"resolve",
        c"move",
    ] {
        if !is_function(owner.optional(key)?)? {
            return Err(options.type_error("[user-input-signal] Rust question owner is required"));
        }
    }
    for key in [c"getState".as_ref(), c"setState"] {
        if !is_function(options.get(key)?)? {
            return Err(options.type_error("[user-input-signal] state ports are required"));
        }
    }
    let s = fields(
        options,
        &[
            ("owner", owner),
            ("context", null(owner)?),
            ("getState", options.get(c"getState")?),
            ("setState", options.get(c"setState")?),
        ],
    )?;
    for key in [c"log".as_ref(), c"onResolved"] {
        let value = options.get(key)?;
        s.set(
            key,
            if value.undefined()? {
                callback(s, "", 0, 0, |s, _| undef(s))?
            } else {
                value
            },
        )?;
    }
    let api = fields(s, &[("recordCommitted", flag(s, true)?)])?;
    let projections = [
        (c"pending".as_ref(), c"pendingAsync".as_ref()),
        (c"lastResolved", c"lastResolvedAsync"),
        (c"turnId", c"turnIdAsync"),
    ];
    for (sync, _) in projections {
        bind(api, s, sync, 1, 1, move |s, a| {
            project(read(s, a[0])?, sync)
        })?;
    }
    for (sync, asynchronous) in projections {
        bind(api, s, asynchronous, 1, 1, move |s, a| {
            async_result(s, || {
                after(
                    s,
                    call(s.get(c"owner")?, c"readAsync", &[a[0]])?,
                    move |_, r| project(r, sync),
                )
            })
        })?;
    }
    bind(api, s, c"snapshotAsync", 1, 1, |s, a| {
        async_result(s, || call(s.get(c"owner")?, c"readAsync", &[a[0]]))
    })?;
    bind(api, s, c"withSnapshotAsync", 2, 2, |s, a| {
        async_result(s, || {
            let f = saved(s, &[("sessionId", a[0]), ("fn", a[1])])?;
            after(
                f,
                call(s.get(c"owner")?, c"readAsync", &[a[0]])?,
                |f, snapshot| {
                    let s = f.get(c"host")?;
                    let prior = s.get(c"context")?;
                    s.set(
                        c"context",
                        fields(
                            s,
                            &[("sessionId", f.get(c"sessionId")?), ("snapshot", snapshot)],
                        )?,
                    )?;
                    let result = f.get(c"fn")?.call_plain(&[]);
                    // Clear a pending exception before restoring the scope, then rethrow
                    // the exact value the callback supplied.
                    let thrown = if result.is_err() {
                        s.exception_value()?
                    } else {
                        None
                    };
                    s.set(c"context", prior)?;
                    if let Some(err) = thrown {
                        return Err(err.throw_error());
                    }
                    result
                },
            )
        })
    })?;
    let writes = [
        (c"record".as_ref(), c"recordAsync".as_ref(), 0, 2),
        (c"beginTurn", c"beginTurnAsync", 1, 2),
        (c"resolve", c"resolveAsync", 2, 3),
        (c"move", c"moveAsync", 2, 3),
    ];
    for wait in [false, true] {
        for (op, async_op, length, count) in writes {
            let name = if wait { async_op } else { op };
            bind(api, s, name, length, count, move |s, a| {
                let mut run = || {
                    let option_index = if op == c"record" { 0 } else { count - 1 };
                    a[option_index] = default_object(a[option_index])?;
                    let f = saved(s, &[("first", a[0]), ("second", a[1])])?;
                    let args = if op == c"record" { &a[..1] } else { &a[..] };
                    let result = call(s.get(c"owner")?, name, args)?;
                    if wait {
                        after(f, result, move |f, r| on_write(f, r, op))
                    } else {
                        on_write(f, result, op)
                    }
                };
                if wait {
                    async_result(s, run)
                } else {
                    run()
                }
            })?;
        }
    }
    bind(api, s, c"apply", 2, 2, |s, a| {
        let q = project(read(s, a[0])?, c"pending")?;
        if !q.truthy()? || q.get(c"resolved")?.is_true()? {
            return Ok(a[1]);
        }
        protocol(
            "applyUserInputEvidence",
            fields(s, &[("result", a[1]), ("pendingUserInput", q)])?,
            true,
        )
    })?;
    bind(api, s, c"degradedResult", 2, 2, |s, a| {
        let q = project(read(s, a[0])?, c"pending")?;
        if !q.truthy()? || q.get(c"resolved")?.is_true()? {
            return null(s);
        }
        let state = s.get(c"getState")?.call_plain(&[a[0]])?;
        fn shape(v: L<'_>) -> Result<L<'_>> {
            fields(
                v,
                &[
                    ("goal", v.optional(c"goal")?),
                    ("phase", v.optional(c"phase")?),
                ],
            )
        }
        protocol(
            "userInputDegraded",
            fields(
                s,
                &[
                    ("pendingUserInput", q),
                    ("state", shape(state)?),
                    ("currentTask", shape(a[1])?),
                ],
            )?,
            true,
        )
    })?;
    api.freeze()
}
fn live_turn<'a>(s: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let cs = s.get(c"getSession")?.call_plain(&[id])?;
    if !cs.truthy()? {
        return null(s);
    }
    let turn = cs.get(c"_activeTurn")?;
    fields(
        s,
        &[
            (
                "_activeTurn",
                if turn.truthy()? {
                    fields(s, &[("turnId", turn.get(c"turnId")?)])?
                } else {
                    null(s)?
                },
            ),
            ("isStreaming", flag(s, cs.get(c"isStreaming")?.is_true()?)?),
            (
                "_currentTaskId",
                fallback(cs.get(c"_currentTaskId")?, V::Null)?,
            ),
        ],
    )
}
pub(super) fn production<'a>(ports: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let s = fields(ports, &[])?;
    for k in [
        c"getSession".as_ref(),
        c"getState",
        c"getRecord",
        c"getStore",
        c"setState",
        c"onResolved",
        c"log",
    ] {
        s.set(k, opts.get(k)?)?;
    }
    if s.get(c"getRecord")?.undefined()? {
        s.set(c"getRecord", callback(s, "", 0, 0, |s, _| null(s))?)?;
    }
    let cfg = fields(
        s,
        &[
            ("getStore", s.get(c"getStore")?),
            (
                "liveTurn",
                callback(s, "liveTurn", 1, 1, |s, a| live_turn(s, a[0]))?,
            ),
        ],
    )?;
    if opts.get(c"now")?.truthy()? {
        cfg.set(c"now", opts.get(c"now")?)?
    }
    bind(cfg, s, c"initialState", 1, 1, |s, a| {
        let state = s.get(c"getState")?.call_plain(&[a[0]])?;
        let pending = state.optional(c"pendingUserInput")?;
        let category = crate::js_live::spread(state)?;
        category.delete(c"pendingUserInput")?;
        let record = s.get(c"getRecord")?.call_plain(&[a[0]])?;
        let active = live_turn(s, a[0])?;
        category.set(
            c"unattended",
            fallback(record.optional(c"unattended")?, V::Null)?,
        )?;
        let kind = record.optional(c"type")?;
        category.set(
            c"recoveryRecordType",
            if kind.kind()? == sys::ValueType::napi_string {
                kind
            } else {
                null(s)?
            },
        )?;
        fields(
            s,
            &[
                (
                    "pendingQuestion",
                    if pending.undefined()? {
                        null(s)?
                    } else {
                        pending
                    },
                ),
                ("activeTurn", active),
                ("category", category),
            ],
        )
    })?;
    let owner = ports.get(c"createQuestionOwner")?.call_plain(&[cfg])?;
    s.set(c"owner", owner)?;
    let host = crate::js_live::spread(owned(s)?)?;
    for (name, refresh, turn) in [
        (
            c"activateTurnAsync".as_ref(),
            c"refreshTurnAsync".as_ref(),
            true,
        ),
        (
            c"refreshAdmissionFactsAsync",
            c"refreshUnattendedAsync",
            false,
        ),
    ] {
        bind(host, s, name, 1, 1, move |s, a| {
            let f = saved(s, &[("id", a[0])])?;
            let read = callback(f, "", 0, 0, move |f, _| {
                let s = f.get(c"host")?;
                let id = f.get(c"id")?;
                if turn {
                    live_turn(s, id)
                } else {
                    s.get(c"getRecord")?
                        .call_plain(&[id])?
                        .optional(c"unattended")
                }
            })?;
            call(s.get(c"owner")?, refresh, &[a[0], read])
        })?;
    }
    fields(s, &[("owner", owner), ("host", host.freeze()?)])
}
