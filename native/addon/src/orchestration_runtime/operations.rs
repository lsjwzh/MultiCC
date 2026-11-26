//! Detached process ownership and dispatch recovery. A durable admission is the
//! commit point: a later projection failure is reported without re-submission.
use super::*;

fn terminal(s: L<'_>, status: L<'_>) -> Result<bool> {
    call(s.get(c"TERMINAL_OPERATION_STATES")?, c"has", &[status])?.truthy()
}
fn complete<'a>(s: L<'a>, id: L<'a>, result: L<'a>) -> Result<L<'a>> {
    let done = service(s, c"operations", c"completeDispatch", &[id, result])?;
    after(s, done, |s, out| {
        if !out.optional(c"ok")?.truthy()? {
            return Ok(out);
        }
        after(out, lifecycle::tick(s)?, |out, _| Ok(out))
    })
}
fn update_detached<'a>(frame: L<'a>, state: L<'a>) -> Result<L<'a>> {
    let s = frame.get(c"runtime")?;
    let op = frame.get(c"operation")?;
    let id = op.get(c"id")?;
    if !state.truthy()? {
        return Ok(state);
    }
    let work = if state.get(c"done")?.truthy()? {
        let exit = state.get(c"exitCode")?;
        let result = fields(
            state,
            &[
                (
                    "status",
                    text(
                        state,
                        if exit.is_number(0.)? {
                            "completed"
                        } else {
                            "failed"
                        },
                    )?,
                ),
                ("exitCode", exit),
                ("logTail", fallback(state.get(c"logTail")?, "".into())?),
            ],
        )?;
        service(s, c"operations", c"completeDetached", &[id, result])?
    } else if state.get(c"running")?.truthy()? {
        service(
            s,
            c"operations",
            c"markRunning",
            &[
                id,
                fields(
                    state,
                    &[
                        ("externalId", op.get(c"externalId")?),
                        ("pid", state.get(c"pid")?),
                    ],
                )?,
            ],
        )?
    } else if state.get(c"started")?.truthy()? {
        let spec = op.get(c"spec")?;
        let mut label = spec.get(c"label")?;
        if !label.truthy()? {
            label = call(
                spec.get(c"command")?,
                c"slice",
                &[num(s, 0.)?, num(s, 60.)?],
            )?;
        }
        let message = call(
            text(s, "🔇【后台任务已中断】")?,
            c"concat",
            &[
                label,
                text(
                    s,
                    " 的进程已不存在，且没有完成标记；系统未自动重跑，以避免重复外部副作用。",
                )?,
            ],
        )?;
        let result = fields(
            s,
            &[
                ("status", text(s, "interrupted")?),
                (
                    "error",
                    text(
                        s,
                        "detached process is no longer alive and no completion marker exists",
                    )?,
                ),
                ("exitCode", null(s)?),
                ("logTail", fallback(state.get(c"logTail")?, "".into())?),
                ("deliveryText", message),
            ],
        )?;
        service(s, c"operations", c"completeDetached", &[id, result])?
    } else {
        return Ok(state);
    };
    after(state, work, |state, _| Ok(state))
}
fn ensure_detached<'a>(s: L<'a>, op: L<'a>) -> Result<L<'a>> {
    let adapter = s.get(c"detachedAdapter")?;
    if !adapter.truthy()? {
        return null(s);
    }
    let frame = saved(s, &[("operation", op)])?;
    let status = call(adapter, c"status", &[op.get(c"externalId")?])?;
    after(frame, status, |f, state| {
        if state.truthy()? && !state.get(c"started")?.is_false()? {
            return update_detached(f, state);
        }
        let op = f.get(c"operation")?;
        let s = f.get(c"runtime")?;
        let spec = op.get(c"spec")?;
        let launch = service(
            s,
            c"detachedAdapter",
            c"launch",
            &[fields(
                s,
                &[
                    ("id", op.get(c"externalId")?),
                    ("command", spec.get(c"command")?),
                    ("cwd", spec.get(c"cwd")?),
                    ("label", spec.get(c"label")?),
                ],
            )?],
        )?;
        let status = after(f, launch, |f, _| {
            service(
                f.get(c"runtime")?,
                c"detachedAdapter",
                c"status",
                &[f.get(c"operation")?.get(c"externalId")?],
            )
        })?;
        after(f, status, update_detached)
    })
}
type Visit = for<'a> fn(L<'a>, L<'a>) -> Result<L<'a>>;
fn next_reference(frame: L<'_>, visit: Visit) -> Result<L<'_>> {
    let iterator = frame.get(c"iterator")?;
    let Some(item) = iterator.iterator_step(frame.get(c"next")?)? else {
        return undef(frame);
    };
    let work = async_result(frame, || visit(frame.get(c"runtime")?, item))?;
    let work = recover(frame, work, |f, error| {
        // IteratorClose preserves the original body error.
        f.catch(|| f.get(c"iterator")?.iterator_close())?;
        Err(error.throw_error())
    })?;
    after(frame, work, move |f, _| next_reference(f, visit))
}
fn reconcile<'a>(s: L<'a>, kind: &'static str, visit: Visit) -> Result<L<'a>> {
    let statuses = s.from_value(&V::Array(vec!["admitted".into(), "running".into()]))?;
    let refs = service(
        s,
        c"operations",
        c"listReferences",
        &[fields(
            s,
            &[("kind", text(s, kind)?), ("statuses", statuses)],
        )?],
    )?;
    after(s, refs, move |s, list| {
        let (iter, next) = list.iterator()?;
        next_reference(saved(s, &[("iterator", iter), ("next", next)])?, visit)
    })
}
pub(super) fn reconcile_detached(s: L<'_>) -> Result<L<'_>> {
    if !s.get(c"detachedAdapter")?.truthy()? {
        return undef(s);
    }
    reconcile(s, "detached", |s, r| {
        let current = service(s, c"operations", c"get", &[r.get(c"id")?])?;
        after(s, current, |s, op| {
            if !op.truthy()? || !active_status(op.get(c"status")?)? {
                return undef(s);
            }
            let p = async_result(s, || ensure_detached(s, op))?;
            recover(saved(s, &[("id", op.get(c"id")?)])?, p, |f, e| {
                log(
                    f.get(c"runtime")?,
                    &format!(
                        "[orchestration] detached {} reconcile failed: {}",
                        describe(f.get(c"id")?)?,
                        error_message(e)?
                    ),
                )?;
                undef(f)
            })
        })
    })
}
fn recover_dispatch<'a>(s: L<'a>, op: L<'a>) -> Result<L<'a>> {
    if !op.truthy()? || !active_status(op.get(c"status")?)? {
        return undef(s);
    }
    let frame = saved(s, &[("operation", op)])?;
    let history = async_result(s, || port(s, c"recoverDispatchResult", &[op]))?;
    let history = recover(frame, history, |f, e| {
        log(
            f.get(c"runtime")?,
            &format!(
                "[orchestration] dispatch {} history recovery failed: {}",
                describe(f.get(c"operation")?.get(c"id")?)?,
                error_message(e)?
            ),
        )?;
        null(f)
    })?;
    after(frame, history, |f, r| {
        let op = f.get(c"operation")?;
        let s = f.get(c"runtime")?;
        if r.optional(c"completed")?.truthy()? {
            f.set(c"recovered", r)?;
            let replay = port(s, c"replayRecoveredDispatchEffects", &[op, r])?;
            return after(f, replay, |f, _| {
                let s = f.get(c"runtime")?;
                let result = fields(
                    s,
                    &[
                        ("status", text(s, "completed")?),
                        (
                            "text",
                            fallback(f.get(c"recovered")?.get(c"text")?, "".into())?,
                        ),
                        ("recovered", flag(s, true)?),
                    ],
                )?;
                service(
                    s,
                    c"operations",
                    c"completeDispatch",
                    &[f.get(c"operation")?.get(c"id")?, result],
                )
            });
        }
        service(s,c"operations",c"completeDispatch",&[op.get(c"id")?,fields(s,&[("status",text(s,"interrupted")?),
            ("error",text(s,"service restarted before a recoverable dispatch result was persisted")?),
            ("lastOutput",fallback(r.optional(c"lastOutput")?,"".into())?)])?])
    })
}
pub(super) fn reconcile_dispatches(s: L<'_>) -> Result<L<'_>> {
    reconcile(s, "dispatch", |s, r| {
        let frame = saved(s, &[("id", r.get(c"id")?)])?;
        let req = r.get(c"requestOutboxId")?;
        let request = if req.truthy()? {
            service(s, c"outbox", c"getDeliveryState", &[req])?
        } else {
            null(s)?
        };
        after(frame, request, |f, req| {
            let s = f.get(c"runtime")?;
            let state = req.optional(c"state")?;
            let pending = state.is_string("pending")? || state.is_string("leased")?;
            if state.is_string("dead-letter")? {
                return service(
                    s,
                    c"operations",
                    c"completeDispatch",
                    &[
                        f.get(c"id")?,
                        fields(
                            s,
                            &[
                                ("status", text(s, "interrupted")?),
                                (
                                    "error",
                                    text(s, "dispatch request delivery exhausted retries")?,
                                ),
                            ],
                        )?,
                    ],
                );
            }
            if !pending && !state.is_string("delivered")? {
                return undef(s);
            }
            let proof = if pending {
                port(
                    s,
                    c"hasPersistedDelivery",
                    &[req.get(c"sessionId")?, req.get(c"id")?],
                )?
            } else {
                flag(s, true)?
            };
            after(f, proof, |f, ok| {
                let s = f.get(c"runtime")?;
                if !ok.truthy()? {
                    return undef(s);
                }
                let op = service(s, c"operations", c"get", &[f.get(c"id")?])?;
                after(s, op, recover_dispatch)
            })
        })
    })
}
fn start_detached<'a>(s: L<'a>, spec: L<'a>) -> Result<L<'a>> {
    if !s.get(c"detachedAdapter")?.truthy()? {
        return Err(fail(s, "detached adapter is not configured"));
    }
    let op = service(
        s,
        c"operations",
        c"admitDetached",
        &[crate::host_methods::default_object(spec)?],
    )?;
    after(s, op, |s, op| {
        let f = saved(s, &[("operation", op)])?;
        let ready = if terminal(s, op.get(c"status")?)? {
            undef(s)?
        } else {
            ensure_detached(s, op)?
        };
        let current = after(f, ready, |f, _| {
            service(
                f.get(c"runtime")?,
                c"operations",
                c"get",
                &[f.get(c"operation")?.get(c"id")?],
            )
        })?;
        after(f, current, |f, cur| {
            f.set(c"current", cur)?;
            let status = service(
                f.get(c"runtime")?,
                c"detachedAdapter",
                c"status",
                &[f.get(c"operation")?.get(c"externalId")?],
            )?;
            after(f, status, |f, state| {
                fields(
                    f,
                    &[
                        ("operation", f.get(c"current")?),
                        ("state", state),
                        ("idempotent", f.get(c"operation")?.get(c"idempotent")?),
                    ],
                )
            })
        })
    })
}
fn degraded<'a>(f: L<'a>, message: L<'a>) -> Result<L<'a>> {
    let s = f.get(c"runtime")?;
    let op = f.get(c"admitted")?;
    let spec = f.get(c"spec")?;
    let mut session = spec.optional(c"spec")?.optional(c"chatId")?;
    if !session.truthy()? {
        session = fallback(spec.optional(c"ownerSessionId")?, V::Null)?;
    }
    let detail = fields(
        s,
        &[
            ("operationId", op.get(c"id")?),
            ("entryId", op.get(c"requestOutboxId")?),
            ("sessionId", session),
            ("error", message),
        ],
    )?;
    let wire = call(s.global()?.get(c"JSON")?, c"stringify", &[detail])?;
    log(
        s,
        &format!(
            "[orchestration] admission_queue_projection_degraded {}",
            describe(wire)?
        ),
    )?;
    let out = crate::js_live::spread(op)?;
    out.set(c"wakeupError", message)?;
    Ok(out)
}
fn admit_dispatch<'a>(s: L<'a>, spec: L<'a>) -> Result<L<'a>> {
    let admitted = service(s, c"operations", c"admitDispatch", &[spec])?;
    after(saved(s, &[("spec", spec)])?, admitted, |f, op| {
        let s = f.get(c"runtime")?;
        if !op.get(c"requestOutboxId")?.truthy()? || op.get(c"idempotent")?.truthy()? {
            return Ok(op);
        }
        f.set(c"admitted", op)?;
        let notice = async_result(s, || {
            service(
                s,
                c"sessionScheduler",
                c"noteQueued",
                &[op.get(c"requestOutboxId")?],
            )
        })?;
        let result = after(f, notice, |f, notice| {
            if notice.optional(c"ok")?.truthy()? {
                return f.get(c"admitted");
            }
            let code = fallback(notice.optional(c"code")?, "unknown".into())?;
            degraded(
                f,
                call(text(f, "queue notice failed: ")?, c"concat", &[code])?,
            )
        })?;
        recover(f, result, |f, e| {
            let message = e.optional(c"message")?;
            degraded(
                f,
                if message.truthy()? {
                    message
                } else {
                    string(e)?
                },
            )
        })
    })
}
fn interrupt<'a>(s: L<'a>, id: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let o = crate::host_methods::default_object(options)?;
    let mut reason = crate::js_iteration::read(o, c"reason")?;
    if reason.undefined()? {
        reason = text(
            s,
            "dispatch target turn was interrupted without a successor",
        )?;
    }
    let mut source = crate::js_iteration::read(o, c"source")?;
    if source.undefined()? {
        source = text(s, "session_cancel")?;
    }
    let f = saved(s, &[("id", id), ("reason", reason), ("source", source)])?;
    after(f, service(s, c"operations", c"get", &[id])?, |f, op| {
        let s = f.get(c"runtime")?;
        if !op.optional(c"kind")?.is_string("dispatch")? {
            return fields(
                s,
                &[("ok", flag(s, false)?), ("code", text(s, "not_found")?)],
            );
        }
        let status = op.get(c"status")?;
        if terminal(s, status)? {
            return fields(
                s,
                &[
                    ("ok", flag(s, true)?),
                    ("idempotent", flag(s, true)?),
                    ("status", status),
                    ("operation", op),
                ],
            );
        }
        let bounded = |key: &CStr, fallback_text: &str, length: f64| {
            let value = string(fallback(f.get(key)?, fallback_text.into())?)?;
            call(value, c"slice", &[num(s, 0.)?, num(s, length)?])
        };
        let result = fields(
            s,
            &[
                ("status", text(s, "interrupted")?),
                ("error", bounded(c"reason", "dispatch interrupted", 2000.)?),
                ("source", bounded(c"source", "session_cancel", 80.)?),
            ],
        )?;
        complete(s, f.get(c"id")?, result)
    })
}
pub(super) fn install(s: L<'_>, api: L<'_>) -> Result<()> {
    async_method(s, api, c"startDetached", 1, 0, |s, a| {
        start_detached(s, a[0])
    })?;
    async_method(s, api, c"admitDispatch", 1, 1, |s, a| {
        admit_dispatch(s, a[0])
    })?;
    async_method(s, api, c"admitSessionWork", 1, 1, |s, a| {
        let p = service(s, c"sessionScheduler", c"admit", &[a[0]])?;
        after(s, p, |s, admitted| {
            if admitted.get(c"ok")?.truthy()? {
                lifecycle::wake_after_admission(s)?;
            }
            let current = admitted.get(c"schedule")?;
            let v = crate::js_live::spread(admitted)?;
            v.set(c"status", fallback(current.optional(c"state")?, V::Null)?)?;
            v.set(
                c"queued",
                if admitted.get(c"ok")?.truthy()? {
                    admitted.get(c"queued")?
                } else {
                    flag(s, false)?
                },
            )?;
            v.set(c"schedule", current)?;
            Ok(v)
        })
    })?;
    async_method(s, api, c"completeDispatch", 2, 2, |s, a| {
        complete(s, a[0], a[1])
    })?;
    async_method(s, api, c"interruptDispatch", 2, 1, |s, a| {
        interrupt(s, a[0], a[1])
    })?;
    async_method(s, api, c"observeTask", 1, 1, |s, a| {
        service(s, c"operations", c"observeTask", &[a[0]])
    })?;
    Ok(())
}
