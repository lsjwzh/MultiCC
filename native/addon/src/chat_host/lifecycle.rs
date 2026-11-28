use super::*;
use crate::chat_turn_effects as effects;
use crate::host_methods::{arg, args_default, env, raw};

fn opaque(v: L<'_>) -> Result<bool> {
    Ok(matches!(
        v.kind()?,
        sys::ValueType::napi_object
            | sys::ValueType::napi_function
            | sys::ValueType::napi_symbol
            | sys::ValueType::napi_bigint
    ))
}
fn turn_state<'a>(p: L<'a>, t: L<'a>) -> Result<L<'a>> {
    let state = call(p.get(c"turns")?, c"get", &[t])?;
    if state.truthy()? {
        Ok(state)
    } else {
        owned(p, c"RustChatTurnLifecycle", c"legacy", t)
    }
}
fn runner_state<'a>(p: L<'a>, r: L<'a>) -> Result<L<'a>> {
    owned(p, c"RustChatRunnerLifecycle", c"runners", r)
}
fn accessor<'a>(
    state: L<'a>,
    owner: L<'a>,
    key: &'static str,
    get: &'static CStr,
    set: &'static CStr,
) -> Result<L<'a>> {
    let k = text(owner, key)?;
    let c = fields(
        owner,
        &[
            ("state", state),
            ("owner", owner),
            ("opaque", flag(owner, false)?),
        ],
    )?;
    let read = function(c, key, 0, 0, move |c, _| {
        if c.get(c"opaque")?.is_true()? {
            c.get(c"value")
        } else {
            call(c.get(c"state")?.get(c"native")?, get, &[])
        }
    })?;
    let write = function(c, key, 1, 1, move |c, a| {
        if js_frozen(c.get(c"owner")?)? {
            return Err(c.type_error(&format!("Cannot assign to read only property '{key}'")));
        }
        let value = a[0];
        let special = if key == "usageRecorded" {
            !value.is_true()? && !value.is_false()?
        } else {
            opaque(value)?
        };
        let native_value = if key == "usageRecorded" {
            flag(c, value.is_true()?)?
        } else if special {
            if key == "resultRunnerId" {
                null(c)?
            } else {
                flag(c, value.truthy()?)?
            }
        } else {
            value
        };
        call(c.get(c"state")?.get(c"native")?, set, &[native_value])?;
        c.set(c"opaque", flag(c, special)?)?;
        c.set(c"value", if special { value } else { undef(c)? })?;
        undef(c)
    })?;
    define(
        owner,
        k,
        fields(
            owner,
            &[
                ("set", write),
                ("get", read),
                ("configurable", flag(owner, true)?),
                ("enumerable", flag(owner, true)?),
            ],
        )?,
    )?;
    c.set(c"setter", write)?;
    Ok(c)
}
fn turn<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let r = a[0];
    let input = default_object(a[1])?;
    if !r.truthy()?
        || !r.get(c"sessionId")?.truthy()?
        || !r.get(c"origin")?.truthy()?
        || !r.get(c"launch")?.truthy()?
    {
        return Err(p.type_error("normalized turn request is required"));
    }
    let id = input.get(c"turnId")?.clean_text()?;
    if !id.truthy()? {
        return Err(p.type_error("turnId is required"));
    }
    let t = fields(
        p,
        &[
            ("turnId", id),
            ("requestId", r.get(c"requestId")?.clean_text()?),
            ("sessionId", r.get(c"sessionId")?),
            ("userText", r.get(c"text")?.clean_text()?),
            ("lineage", attribution::lineage(r.get(c"origin")?)?),
            ("task", attribution::task(r.get(c"task")?)?),
            (
                "launchReason",
                text(
                    p,
                    if r.get(c"launch")?.get(c"reason")?.is_string("continue")? {
                        "continue"
                    } else {
                        "request"
                    },
                )?,
            ),
        ],
    )?;
    let state = owned(p, c"RustChatTurnLifecycle", c"turns", t)?;
    accessor(
        state,
        t,
        "resultDurable",
        c"resultDurable",
        c"setResultDurable",
    )?;
    accessor(
        state,
        t,
        "resultRunnerId",
        c"resultRunnerId",
        c"setResultRunnerId",
    )?;
    state.set(
        c"claim",
        accessor(
            state,
            t,
            "postTurnClaimed",
            c"postTurnClaimed",
            c"setPostTurnClaimed",
        )?,
    )?;
    Ok(t)
}
fn runner<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let turn = a[0];
    let i = default_object(a[1])?;
    if !turn.truthy()? || !turn.get(c"turnId")?.truthy()? {
        return Err(p.type_error("turn lifecycle is required"));
    }
    let id = i.get(c"runnerId")?.clean_text()?;
    if !id.truthy()? {
        return Err(p.type_error("runnerId is required"));
    }
    let seq = i.get(c"sequence")?;
    let r = fields(
        p,
        &[
            ("runnerId", id),
            ("turnId", turn.get(c"turnId")?),
            (
                "kind",
                fallback(i.get(c"kind")?.clean_text()?, "process".into())?,
            ),
            (
                "sequence",
                if seq.nullish()? {
                    null(p)?
                } else {
                    num(p, seq.explicit_number()?)?
                },
            ),
            ("killReason", null(p)?),
            ("retryPlanned", flag(p, false)?),
            ("resultEvent", flag(p, false)?),
        ],
    )?;
    if i.get(c"completion")?.truthy()? {
        r.set(c"completion", i.get(c"completion")?)?
    }
    r.set(c"partialCheckpointKey", null(p)?)?;
    if i.get(c"usageAttribution")?.truthy()? {
        r.set(
            c"usageAttribution",
            attribution::usage(i.get(c"usageAttribution")?)?,
        )?
    } else if turn.get(c"usageAttribution")?.truthy()? {
        r.set(c"usageAttribution", turn.get(c"usageAttribution")?)?
    }
    attribution::verify(r, turn, i)?;
    runner_state(p, r)?;
    Ok(r)
}
fn bind_task<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let t = a[0];
    if !t.truthy()? || !t.get(c"turnId")?.truthy()? {
        return Err(p.type_error("turn lifecycle is required"));
    }
    let next = attribution::task(a[1])?;
    if t.get(c"task")?.optional(c"id")?.truthy()? {
        if next.get(c"id")?.truthy()? && !t.get(c"task")?.get(c"id")?.equals(next.get(c"id")?)? {
            return Err(p.type_error("turn task identity is already frozen"));
        }
        return t.get(c"task");
    }
    t.assign(c"task", next)?;
    Ok(next)
}
fn confirm<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let state = turn_state(p, a[0])?;
    let special = opaque(a[2])?;
    let ok = call(
        state.get(c"native")?,
        c"recordConfirmedResult",
        &[if special { null(p)? } else { a[2] }],
    )?;
    if ok.is_true()? {
        state.set(c"receiptRunner", a[1])?;
        state.set(c"receiptOpaque", flag(p, special)?)?;
        state.set(c"receiptOwner", if special { a[2] } else { undef(p)? })?
    }
    Ok(ok)
}
fn receipt<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let state = turn_state(p, a[0])?;
    let n = state.get(c"native")?;
    if !call(n, c"hasConfirmedResult", &[])?.is_true()? {
        return null(p);
    }
    fields(
        p,
        &[
            ("runner", state.get(c"receiptRunner")?),
            (
                "runnerId",
                if state.get(c"receiptOpaque")?.is_true()? {
                    state.get(c"receiptOwner")?
                } else {
                    call(n, c"confirmedResultOwner", &[])?
                },
            ),
        ],
    )
}
fn claim_usage<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let r = a[0];
    if !r.truthy()? {
        return decision(p, Some("runner_required"));
    }
    if !default_object(a[1])?.get(c"resultDurable")?.is_true()? {
        return decision(p, Some("result_not_durable"));
    }
    if r.get(c"usageRecorded")?.is_true()? {
        return decision(p, Some("usage_already_recorded"));
    }
    let state = call(p.get(c"runners")?, c"get", &[r])?;
    let key = text(p, "usageRecorded")?;
    if state.truthy()? && !descriptor(r, key)?.truthy()? && !r.has(c"usageRecorded")? {
        state.set(
            c"claim",
            accessor(
                state,
                r,
                "usageRecorded",
                c"usageRecorded",
                c"setUsageRecorded",
            )?,
        )?;
        call(
            state.get(c"native")?,
            c"setUsageRecorded",
            &[flag(p, false)?],
        )?;
    }
    let own = state.optional(c"claim")?;
    if own.truthy()?
        && descriptor(r, key)?
            .optional(c"set")?
            .equals(own.get(c"setter")?)?
        && !js_frozen(r)?
    {
        if !call(state.get(c"native")?, c"claimUsage", &[])?.is_true()? {
            return decision(p, Some("usage_already_recorded"));
        }
        own.set(c"opaque", flag(p, false)?)?;
    } else {
        r.assign(c"usageRecorded", flag(p, true)?)?
    }
    decision(p, None)
}
fn evaluate<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let code = crate::chat_turn_lifecycle::evaluate_chat_post_turn(
        env(p),
        arg(a[0])?,
        arg(a[1])?,
        args_default(a[2])?,
    )?;
    decision(p, code.as_deref())
}
fn claim_post<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let verdict = evaluate(p, a)?;
    if !verdict.get(c"ok")?.is_true()? {
        return Ok(verdict);
    }
    let t = a[0];
    let state = call(p.get(c"turns")?, c"get", &[t])?;
    let own = state.optional(c"claim")?;
    if own.truthy()?
        && descriptor(t, text(p, "postTurnClaimed")?)?
            .optional(c"set")?
            .equals(own.get(c"setter")?)?
        && !js_frozen(t)?
    {
        if !call(state.get(c"native")?, c"claimPostTurn", &[])?.is_true()? {
            return decision(p, Some("post_turn_already_claimed"));
        }
        own.set(c"opaque", flag(p, false)?)?;
    } else {
        t.assign(c"postTurnClaimed", flag(p, true)?)?
    }
    frozen(
        p,
        &[
            ("ok", flag(p, true)?),
            ("code", null(p)?),
            ("lineage", t.get(c"lineage")?),
        ],
    )
}
pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    defaulted_methods(
        p,
        &[
            ("freezeLineage", 1, 1, |_, a| attribution::lineage(a[0])),
            ("freezeTask", 1, 1, |_, a| attribution::task(a[0])),
            ("freezeUsageAttribution", 1, 1, |_, a| {
                attribution::usage(a[0])
            }),
            ("bindTurnTask", 2, 2, bind_task),
            ("bindTurnUsageAttribution", 2, 2, |_, a| {
                attribution::bind(a[0], a[1], false)
            }),
            ("bindRunnerUsageAttribution", 2, 2, |_, a| {
                attribution::bind(a[0], a[1], true)
            }),
            ("createTurnLifecycle", 1, 2, turn),
            ("createRunnerOwnership", 1, 2, runner),
            ("ownsCurrentRunner", 4, 4, |p, a| {
                flag(
                    p,
                    effects::chat_owns_current_runner(
                        env(p),
                        arg(a[0])?,
                        arg(a[1])?,
                        arg(a[2])?,
                        arg(a[3])?,
                    )?,
                )
            }),
            ("assignKillReason", 2, 2, |p, a| {
                flag(p, effects::assign_kill_reason(a[0], a[1])?)
            }),
            ("clearErrorFlagsForSucceededTurn", 3, 4, |p, a| {
                flag(
                    p,
                    effects::chat_clear_succeeded_errors(
                        env(p),
                        arg(a[0])?,
                        arg(a[1])?,
                        arg(a[2])?,
                        args_default(a[3])?,
                    )?,
                )
            }),
            ("recordResultEvent", 2, 3, |p, a| {
                Ok(raw(
                    p,
                    effects::chat_record_result_event(
                        env(p),
                        arg(a[0])?,
                        arg(a[1])?,
                        args_default(a[2])?,
                    )?,
                ))
            }),
            ("recordCloseResult", 2, 3, |p, a| {
                Ok(raw(
                    p,
                    effects::chat_record_close_result(
                        env(p),
                        arg(a[0])?,
                        arg(a[1])?,
                        args_default(a[2])?,
                    )?,
                ))
            }),
            ("recordPartialCheckpoint", 2, 3, |p, a| {
                Ok(raw(
                    p,
                    effects::chat_record_partial_checkpoint(
                        env(p),
                        arg(a[0])?,
                        arg(a[1])?,
                        args_default(a[2])?,
                    )?,
                ))
            }),
            ("hasMatchingPartialCheckpoint", 2, 2, |p, a| {
                flag(
                    p,
                    effects::chat_has_partial_checkpoint(env(p), arg(a[0])?, arg(a[1])?)?,
                )
            }),
            ("claimDurableUsage", 1, 2, claim_usage),
            ("recordConfirmedResult", 3, 3, confirm),
            ("confirmedResult", 1, 1, receipt),
            ("reserveResultAppend", 1, 1, |p, a| {
                call(
                    turn_state(p, a[0])?.get(c"native")?,
                    c"beginResultAppend",
                    &[],
                )
            }),
            ("releaseResultAppend", 1, 1, |p, a| {
                call(
                    turn_state(p, a[0])?.get(c"native")?,
                    c"endResultAppend",
                    &[],
                )?;
                undef(p)
            }),
            ("reserveUsageWrite", 1, 1, |p, a| {
                call(runner_state(p, a[0])?.get(c"native")?, c"beginUsage", &[])
            }),
            ("releaseUsageWrite", 1, 1, |p, a| {
                call(runner_state(p, a[0])?.get(c"native")?, c"endUsage", &[])?;
                undef(p)
            }),
            ("evaluatePostTurn", 2, 3, evaluate),
            ("claimPostTurn", 2, 3, claim_post),
        ],
    )
}
