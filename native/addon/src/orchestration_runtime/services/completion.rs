use super::*;

fn or<'a>(v: L<'a>, other: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    if v.truthy()? {
        Ok(v)
    } else {
        other()
    }
}
fn detached_delivery<'a>(op: L<'a>, result: L<'a>, label: L<'a>) -> Result<L<'a>> {
    let exit = result.get(c"exitCode")?;
    let marker = if exit.nullish()? {
        text(op, "")?
    } else {
        join(
            op,
            &[
                text(op, "__MULTICC_DETACHED_DONE__ exit=")?,
                result.get(c"exitCode")?,
                text(op, "\n")?,
            ],
        )?
    };
    let message = or(result.get(c"deliveryText")?, || {
        let prefix = or(op.get(c"spec")?.get(c"injectPrefix")?, || {
            join(op, &[text(op, "[后台任务完成] ")?, label])
        })?;
        join(
            op,
            &[
                prefix,
                text(op, "\n")?,
                marker,
                text(op, "----- output tail -----\n")?,
                fallback(result.get(c"logTail")?, "".into())?,
            ],
        )
    })?;
    fields(
        op,
        &[
            ("type", text(op, "detached.result")?),
            ("operationId", op.get(c"id")?),
            ("deliveryText", message),
            ("result", result),
        ],
    )
}
fn dispatch_delivery<'a>(op: L<'a>, result: L<'a>, opts: L<'a>, status: L<'a>) -> Result<L<'a>> {
    let spec = op.get(c"spec")?;
    let target = spec.get(c"targetId")?;
    let base_label = if spec.get(c"targetLabel")?.truthy()? {
        join(
            op,
            &[
                target,
                text(op, "（")?,
                spec.get(c"targetLabel")?,
                text(op, "）")?,
            ],
        )?
    } else {
        target
    };
    let label = if spec.optional(c"remoteMachineName")?.truthy()? {
        join(
            op,
            &[
                spec.get(c"remoteMachineName")?,
                text(op, " / ")?,
                base_label,
            ],
        )?
    } else {
        base_label
    };
    let body = fallback(
        call(
            string(fallback(result.get(c"text")?, "".into())?)?,
            c"trim",
            &[],
        )?,
        "(this run produced no text output)".into(),
    )?;
    let corrected = read(opts, c"resettle")?.equals(flag(op, true)?)?;
    let text_value = if spec.get(c"resultMode")?.is_string("async")?
        || spec.get(c"resultMode")?.is_string("tool")?
    {
        if status.is_string("completed")? {
            let prefix = if corrected {
                join(
                    op,
                    &[
                        text(op, "📜 dispatch 迟到回执（已校正此前的自动判失败） [")?,
                        label,
                        text(op, "]: ")?,
                    ],
                )?
            } else {
                text(op, "")?
            };
            join(
                op,
                &[
                    prefix,
                    text(op, "📜 dispatch 结果回流 [")?,
                    label,
                    text(op, "]: ")?,
                    body,
                ],
            )?
        } else {
            join(
                op,
                &[
                    text(op, "📜 dispatch 结果回流 [")?,
                    label,
                    text(op, "]: ❌ ")?,
                    or(result.get(c"error")?, || Ok(body))?,
                ],
            )?
        }
    } else if status.is_string("completed")? {
        join(
            op,
            &[text(op, "[Reply from ")?, label, text(op, "]\n")?, body],
        )?
    } else {
        join(op,&[text(op,"🔇【分发任务已中断】发往 ")?,label,text(op," 的任务在 MultiCC 服务重启时未找到可恢复的完成结果。请检查目标会话后决定是否重试。")?])?
    };
    if spec.get(c"oneWay")?.equals(flag(op, true)?)?
        || spec.get(c"resultMode")?.is_string("sync")?
        || spec.optional(c"remoteMasterMachineId")?.truthy()?
    {
        return null(op);
    }
    fields(
        op,
        &[
            ("type", text(op, "dispatch.result")?),
            ("operationId", op.get(c"id")?),
            ("targetId", target),
            (
                "gateway",
                flag(op, spec.get(c"gateway")?.equals(flag(op, true)?)?)?,
            ),
            ("deliveryText", text_value),
            ("result", result),
        ],
    )
}

pub(super) fn complete<'a>(p: L<'a>, a: &mut [L<'a>], detached: bool) -> Result<L<'a>> {
    async_result(p, || {
        let opts = if detached {
            undef(p)?
        } else {
            default_object(a[2])?
        };
        transaction(
            p,
            &[
                ("id", a[0]),
                ("result", a[1]),
                ("opts", opts),
                (
                    "kind",
                    text(p, if detached { "detached" } else { "dispatch" })?,
                ),
            ],
            c"mutate",
            |f, a| {
                let p = f.get(c"state")?;
                let draft = a[0];
                let op = draft.get(c"operations")?.get_key(f.get(c"id")?)?;
                let kind = f.get(c"kind")?;
                if !op.truthy()? || !op.get(c"kind")?.equals(kind)? {
                    return missing(f);
                }
                let result = f.get(c"result")?;
                let opts = f.get(c"opts")?;
                let detached = kind.is_string("detached")?;
                let label = if detached {
                    let spec = op.get(c"spec")?;
                    or(spec.get(c"label")?, || {
                        call(
                            spec.get(c"command")?,
                            c"slice",
                            &[num(f, 0.)?, num(f, 60.)?],
                        )
                    })?
                } else {
                    undef(f)?
                };
                let status = or(result.get(c"status")?, || {
                    text(
                        f,
                        if !detached || result.get(c"exitCode")?.is_number(0.)? {
                            "completed"
                        } else {
                            "failed"
                        },
                    )
                })?;
                if !terminal(p, status, c"TERMINAL_OPERATION_STATES")? {
                    let msg = join(
                        f,
                        &[
                            text(f, "invalid ")?,
                            kind,
                            text(f, " completion status: ")?,
                            status,
                        ],
                    )?;
                    return Err(f
                        .global()?
                        .get(c"TypeError")?
                        .construct(&[msg])?
                        .throw_error());
                }
                let payload = if detached {
                    detached_delivery(op, result, label)?
                } else {
                    dispatch_delivery(op, result, opts, status)?
                };
                let resettle = !detached && read(opts, c"resettle")?.equals(flag(f, true)?)?;
                let normalized = normal(result)?;
                let digest = hash(normalized, p.get(c"cryptoImpl")?, false)?;
                if terminal(p, op.get(c"status")?, c"TERMINAL_OPERATION_STATES")? {
                    if op.get(c"resultHash")?.equals(digest)? {
                        return status_result(op, true);
                    }
                    if !resettle {
                        let msg = join(
                            f,
                            &[
                                text(f, "operation ")?,
                                op.get(c"id")?,
                                text(f, " already completed with different result")?,
                            ],
                        )?;
                        return Err(p
                            .get(c"OperationConflictError")?
                            .construct(&[msg, op.get(c"id")?])?
                            .throw_error());
                    }
                }
                let settles = fallback(
                    num(f, op.get(c"resultSettles")?.explicit_number()?)?,
                    V::Number(0.),
                )?
                .explicit_number()?;
                let time = at(p)?;
                let out = if payload.truthy()? {
                    let base = join(
                        f,
                        &[text(f, "operation:")?, op.get(c"id")?, text(f, ":result")?],
                    )?;
                    let out = if settles == 0. {
                        base
                    } else {
                        join(f, &[base, text(f, ":")?, num(f, settles + 1.)?])?
                    };
                    let source = fields(
                        f,
                        &[
                            ("type", text(f, "operation")?),
                            ("kind", op.get(c"kind")?),
                            ("operationId", op.get(c"id")?),
                        ],
                    )?;
                    result_outbox(
                        p,
                        draft,
                        out,
                        op.get(c"resultSessionId")?,
                        payload,
                        source,
                        time,
                    )?;
                    out
                } else {
                    null(f)?
                };
                for (key, value) in [
                    (c"status", status),
                    (c"resultHash", digest),
                    (c"result", normalized),
                    (c"resultOutboxId", out),
                    (c"resultSettles", num(f, settles + 1.)?),
                    (c"completedAt", time),
                    (c"updatedAt", time),
                ] {
                    op.assign(key, value)?;
                }
                let last = if status.is_string("failed")? || status.is_string("interrupted")? {
                    slice(
                        or(result.get(c"error")?, || {
                            or(result.get(c"message")?, || Ok(status))
                        })?,
                        0.,
                        Some(2000.),
                    )?
                } else {
                    null(f)?
                };
                op.assign(c"lastError", last)?;
                status_result(op, false)
            },
        )
    })
}
