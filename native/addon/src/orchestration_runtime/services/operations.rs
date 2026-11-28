use super::*;

fn running<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let id = a[0];
        let patch = default_object(a[1])?;
        let f = fields(p, &[("p", p), ("id", id), ("patch", patch)])?;
        let action = function(f, "mutate", 1, 1, |f, a| {
            let p = f.get(c"p")?;
            let op = a[0].get(c"operations")?.get_key(f.get(c"id")?)?;
            if !op.truthy()? {
                return missing(f);
            }
            if terminal(p, op.get(c"status")?, c"TERMINAL_OPERATION_STATES")? {
                return status_result(op, true);
            }
            let patch = f.get(c"patch")?;
            let pid = if !read(patch, c"pid")?.nullish()?
                && read(patch, c"pid")?.explicit_number()?.is_finite()
            {
                num(p, read(patch, c"pid")?.explicit_number()?)?
            } else {
                op.get(c"pid")?
            };
            if op.get(c"status")?.is_string("running")?
                && (!read(patch, c"externalId")?.truthy()?
                    || op
                        .get(c"externalId")?
                        .equals(string(read(patch, c"externalId")?)?)?)
                && op.get(c"pid")?.equals(pid)?
            {
                return status_result(op, true);
            }
            let time = at(p)?;
            op.assign(c"status", text(p, "running")?)?;
            let started = op.get(c"startedAt")?;
            op.assign(c"startedAt", if started.truthy()? { started } else { time })?;
            op.assign(c"updatedAt", time)?;
            if read(patch, c"externalId")?.truthy()? {
                op.assign(c"externalId", string(read(patch, c"externalId")?)?)?;
            }
            if !pid.nullish()? {
                op.assign(c"pid", pid)?;
            }
            status_result(op, false)
        })?;
        let store = p.get(c"store")?;
        if callable(store.get(c"markRunningOperation")?)? {
            call(
                store,
                c"markRunningOperation",
                &[id, patch, p.get(c"now")?, action],
            )
        } else {
            call(store, c"mutate", &[action])
        }
    })
}

fn cancel<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let opts = default_object(a[1])?;
        let reason = with_default(read(opts, c"reason")?, text(p, "")?)?;
        let disposition = with_default(read(opts, c"disposition")?, text(p, "")?)?;
        transaction(
            p,
            &[
                ("id", a[0]),
                ("reason", reason),
                ("disposition", disposition),
            ],
            c"mutate",
            |f, a| {
                let p = f.get(c"state")?;
                let op = a[0].get(c"operations")?.get_key(f.get(c"id")?)?;
                if !op.truthy()? || !op.get(c"kind")?.is_string("dispatch")? {
                    return missing(f);
                }
                let raced = terminal(p, op.get(c"status")?, c"TERMINAL_OPERATION_STATES")?;
                if !raced {
                    let time = at(p)?;
                    let reason = slice(
                        fallback(f.get(c"reason")?, "cancelled by dispatcher".into())?,
                        0.,
                        Some(500.),
                    )?;
                    let status = text(f, "cancelled")?;
                    op.assign(c"status", status)?;
                    for k in [c"cancelledAt", c"completedAt", c"updatedAt"] {
                        op.assign(k, time)?;
                    }
                    op.assign(c"lastError", reason)?;
                    let result = normal(fields(
                        f,
                        &[
                            ("status", status),
                            ("reason", reason),
                            (
                                "disposition",
                                slice(fallback(f.get(c"disposition")?, "".into())?, 0., Some(40.))?,
                            ),
                        ],
                    )?)?;
                    op.assign(c"result", result)?;
                    op.assign(
                        c"resultHash",
                        hash(op.get(c"result")?, p.get(c"cryptoImpl")?, false)?,
                    )?;
                }
                fields(
                    f,
                    &[
                        ("ok", flag(f, true)?),
                        ("idempotent", flag(f, raced)?),
                        ("raced", flag(f, raced)?),
                        ("status", op.get(c"status")?),
                        ("operation", public(op, OP_PRIVATE, true)?),
                    ],
                )
            },
        )
    })
}

fn ack_remote_receipt<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(p, || {
        let raw_settle = a[1].number().unwrap_or(1.);
        let settle = if raw_settle.is_finite() {
            raw_settle.max(1.).floor()
        } else {
            1.
        };
        transaction(
            p,
            &[("id", a[0]), ("settle", num(p, settle)?)],
            c"mutate",
            |f, a| {
                let p = f.get(c"state")?;
                let op = a[0].get(c"operations")?.get_key(f.get(c"id")?)?;
                if !op.truthy()? || !op.get(c"kind")?.is_string("dispatch")? {
                    return missing(f);
                }
                let prev_raw = op.optional(c"remoteReceiptAckedSettle")?;
                let prev = if prev_raw.truthy()? {
                    let n = prev_raw.number().unwrap_or(0.);
                    if n.is_finite() {
                        n
                    } else {
                        0.
                    }
                } else {
                    0.
                };
                let next = f.get(c"settle")?.number()?;
                if next > prev {
                    op.assign(c"remoteReceiptAckedSettle", num(f, next)?)?;
                    op.assign(c"updatedAt", at(p)?)?;
                }
                fields(
                    f,
                    &[
                        ("ok", flag(f, true)?),
                        (
                            "ackedSettle",
                            num(f, if next > prev { next } else { prev })?,
                        ),
                        ("operation", public(op, OP_PRIVATE, true)?),
                    ],
                )
            },
        )
    })
}

pub(in crate::orchestration_runtime) fn create<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    api(state(ports, a[0], false)?)
}

pub(in crate::orchestration_runtime) fn api(p: L<'_>) -> Result<L<'_>> {
    defaulted_methods(
        p,
        &[
            ("admitDetached", 0, 1, |p, a| {
                admission::admit(p, a[0], true, undef(p)?)
            }),
            ("admitDispatch", 0, 1, |p, a| {
                admission::admit(p, a[0], false, undef(p)?)
            }),
            ("markRunning", 1, 2, running),
            ("completeDetached", 2, 2, |p, a| {
                completion::complete(p, a, true)
            }),
            ("completeDispatch", 2, 3, |p, a| {
                completion::complete(p, a, false)
            }),
            ("cancelDispatch", 1, 2, cancel),
            ("ackRemoteReceipt", 2, 2, ack_remote_receipt),
            ("observeTask", 0, 1, tasks::observe),
            ("interruptActiveTasks", 0, 0, tasks::interrupt),
            ("get", 1, 1, |p, a| queries::get(p, a[0], false)),
            ("list", 0, 1, |p, a| {
                queries::list(p, a[0], queries::Subject::Operation)
            }),
            ("listReferences", 0, 1, |p, a| {
                queries::list(p, a[0], queries::Subject::Reference)
            }),
            ("listTasks", 0, 1, |p, a| {
                queries::list(p, a[0], queries::Subject::Task)
            }),
            ("taskActivity", 1, 1, |p, a| {
                async_result(p, || call(p.get(c"store")?, c"taskActivity", &[a[0]]))
            }),
        ],
    )?
    .freeze()
}
