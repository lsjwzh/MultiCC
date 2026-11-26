use super::*;

type Handler = for<'a> fn(L<'a>, &mut [L<'a>]) -> Result<L<'a>>;

fn callback<'a>(c: L<'a>, name: &'static str, count: usize, run: Handler) -> Result<L<'a>> {
    let env = Env::from_raw(c.env());
    let f = method(&env, c, name, count, count, run)?;
    Ok(L::from_raw(c.env(), f.raw()))
}

fn provider_name<'a>(provider: L<'a>, record: L<'a>) -> Result<L<'a>> {
    let name = provider.optional(c"name")?;
    if name.truthy()? {
        Ok(name)
    } else {
        cli(record)
    }
}

fn start<'a>(p: L<'a>, c: L<'a>) -> Result<L<'a>> {
    let cs = c.get(c"cs")?;
    let turn = c.get(c"turn")?;
    let runner = c.get(c"runner")?;
    let seq = c.get(c"seq")?;
    if (!seq.undefined()? && !prop(cs, c"_streamTurnSeq")?.equals(seq)?)
        || !port(p, c"isCurrentTurnRunner", &[cs, turn, runner])?.truthy()?
    {
        return null(c);
    }
    let rt = p.get(c"attemptRuntime")?;
    let attempt = prop(runner, c"providerAttempt")?;
    let provider = c.get(c"provider")?;
    let record = c.get(c"persisted")?;
    let name = provider_name(provider, record)?;
    let raw = crate::chat_events::chat_claude_boundary_envelope(
        Env::from_raw(c.env()),
        arg(runner),
        arg(provider_name(provider, record)?),
        arg(cs),
    )?;
    let envelope = super::super::events::reconcile(
        p,
        &mut [rt, attempt, name, cs, L::from_raw(c.env(), raw)],
    )?;
    c.set(c"envelope", envelope)?;
    c.set(c"ports", p)?;
    c.set(
        c"forward",
        callback(c, "", 1, |c, a| {
            port(
                c.get(c"ports")?,
                c"forwardProviderEvent",
                &[
                    c.get(c"sessionName")?,
                    c.get(c"cs")?,
                    c.get(c"turn")?,
                    c.get(c"runner")?,
                    a[0],
                ],
            )
        })?,
    )?;
    Ok(c)
}

fn stop_heartbeat<'a>(p: L<'a>, c: L<'a>) -> Result<()> {
    call(
        p.get(c"turnProgressHeartbeat")?,
        c"stop",
        &[c.get(c"sessionName")?, prop(c.get(c"turn")?, c"turnId")?],
    )?;
    Ok(())
}

fn executor_context(c: L<'_>) -> Result<L<'_>> {
    fields(
        c,
        &[
            ("runnerKind", text(c, "stream")?),
            ("sessionName", c.get(c"sessionName")?),
            ("cs", c.get(c"cs")?),
            ("persisted", c.get(c"persisted")?),
            ("turn", c.get(c"turn")?),
            ("runner", c.get(c"runner")?),
        ],
    )
}

fn execute_plan<'a>(p: L<'a>, plan: L<'a>, context: L<'a>) -> Result<L<'a>> {
    call(p.get(c"executor")?, c"execute", &[plan, context])
}

fn error_category<'a>(c: L<'a>, default: V) -> Result<L<'a>> {
    let decision = c.get(c"result")?.get(c"apiErrorDecision")?;
    fallback(decision.optional(c"error")?.optional(c"category")?, default)
}

fn finish_attempt<'a>(
    p: L<'a>,
    c: L<'a>,
    status: &str,
    category: L<'a>,
    reason: L<'a>,
) -> Result<()> {
    port(
        p,
        c"finishProviderAttempt",
        &[
            c.get(c"runner")?,
            text(c, status)?,
            fields(c, &[("errorCategory", category), ("reasonCode", reason)])?,
        ],
    )?;
    Ok(())
}

fn retry_start<'a>(c: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let p = c.get(c"ports")?;
    let result = c.get(c"result")?;
    let runner = c.get(c"runner")?;
    let record = c.get(c"persisted")?;
    let session = c.get(c"sessionName")?;
    let turn = c.get(c"turn")?;
    let plan = result.get(c"plan")?;
    let prepare = c.get(c"prepareInvocation")?;
    let mut invocation = c.from_value(&V::Undefined)?;
    let started = (|| {
        let mut options = result
            .get(c"autoFailover")?
            .optional(c"invocationOptions")?;
        if !options.truthy()? {
            options = fields(c, &[("reasonCode", text(c, "same_provider_retry")?)])?;
            let route = crate::provider_invocation::provider_retry_route_options(
                Env::from_raw(p.env()),
                arg(prop(runner, c"providerAttempt")?),
            )?;
            options.spread_from(L::from_raw(p.env(), route))?;
        }
        invocation = prepare.call_plain(&[options])?;
        let accepted = port(
            p,
            c"runChatTurnStreaming",
            &[
                session,
                c.get(c"cs")?,
                record,
                invocation,
                c.get(c"provider")?,
                turn,
                prepare,
                c.get(c"autoTurn")?,
                prop(prop(plan, c"retry")?, c"attempt")?,
            ],
        )?;
        if !accepted.truthy()? {
            return Err(c
                .global()?
                .get(c"Error")?
                .construct(&[text(c, "stream retry was not accepted")?])?
                .throw_error());
        }
        Ok(accepted)
    })();
    let error = match started {
        Ok(value) => return Ok(value),
        Err(err) => match c.exception_value()? {
            Some(error) => error,
            None => c
                .global()?
                .get(c"Error")?
                .construct(&[text(c, &err.reason)?])?,
        },
    };
    if invocation.truthy()? {
        call(
            p.get(c"attemptRuntime")?,
            c"finishAttempt",
            &[
                prop(invocation, c"attempt")?,
                fields(
                    c,
                    &[
                        ("outcome", text(c, "failed")?),
                        ("errorCategory", text(c, "spawn_failed")?),
                        ("reasonCode", text(c, "stream_retry_failed")?),
                    ],
                )?,
            ],
        )?;
    }
    let id = |key| -> Result<L<'_>> {
        let attempt = prop(runner, c"providerAttempt")?;
        if !attempt.truthy()? {
            Ok(attempt)
        } else {
            prop(prop(runner, c"providerAttempt")?, key)
        }
    };
    let reason = || -> Result<L<'_>> {
        if error.truthy()? {
            fallback(prop(error, c"code")?, "attempt_prepare_failed".into())
        } else {
            text(c, "attempt_prepare_failed")
        }
    };
    call(
        p.get(c"logger")?,
        c"warn",
        &[
            text(c, "provider_attempt_retry_blocked")?,
            fields(
                c,
                &[
                    ("sessionId", session),
                    ("providerId", id(c"providerId")?),
                    ("routeAttemptId", id(c"routeAttemptId")?),
                    ("code", reason()?),
                ],
            )?,
        ],
    )?;
    runner.assign(c"retryPlanned", flag(c, false)?)?;
    let blocked = frozen(
        c,
        "retryBlocked",
        plan,
        fields(
            c,
            &[
                ("retryUnavailableReason", reason()?),
                ("handoff", prop(record, c"pendingCliHandoff")?),
            ],
        )?,
    )?;
    stop_heartbeat(p, c)?;
    let promise = c.global()?.get(c"Promise")?;
    let finished = execute_plan(p, blocked, executor_context(c)?)?;
    let settled = call(promise, c"resolve", &[finished])?;
    let report = callback(c, "", 1, |c, a| {
        let message = if a[0].truthy()? && prop(a[0], c"message")?.truthy()? {
            prop(a[0], c"message")?
        } else {
            text(c, "finalization failed")?
        };
        call(
            c.get(c"ports")?.get(c"logger")?,
            c"error",
            &[
                text(c, "chat_stream_finalize_failed")?,
                fields(
                    c,
                    &[
                        ("sessionId", c.get(c"sessionName")?),
                        ("turnId", prop(c.get(c"turn")?, c"turnId")?),
                        ("message", message),
                    ],
                )?,
            ],
        )
    })?;
    call(settled, c"catch", &[report])?;
    null(c)
}

fn execute<'a>(p: L<'a>, c: L<'a>) -> Result<L<'a>> {
    let result = plan(p, c)?;
    c.set(c"result", result)?;
    let plan = result.get(c"plan")?;
    let runner = c.get(c"runner")?;
    let session = c.get(c"sessionName")?;
    let turn = c.get(c"turn")?;
    if prop(plan, c"action")?.is_string("retry-api")? {
        finish_attempt(
            p,
            c,
            "failed",
            error_category(c, "api_error".into())?,
            text(c, "api_retry_scheduled")?,
        )?;
        port(
            p,
            c"scheduleOwnedRetry",
            &[fields(
                c,
                &[
                    ("sessionName", session),
                    ("cs", c.get(c"cs")?),
                    ("persisted", c.get(c"persisted")?),
                    ("turn", turn),
                    ("runner", runner),
                    ("decision", prop(plan, c"retry")?),
                    ("provider", cli(c.get(c"persisted")?)?),
                    ("start", callback(c, "start", 0, retry_start)?),
                ],
            )?],
        )?;
        return null(c);
    }
    stop_heartbeat(p, c)?;
    let succeeded = crate::cli_completion::cli_is_completed(
        Env::from_raw(c.env()),
        arg(prop(runner, c"completionOutcome")?),
    )? && prop(turn, c"resultDurable")?.truthy()?
        && !result.get(c"apiErrorDecision")?.truthy()?;
    if succeeded {
        call(
            c.get(c"autoTurn")?,
            c"recordSuccess",
            &[prop(runner, c"providerAttempt")?],
        )?;
    }
    finish_attempt(
        p,
        c,
        if succeeded { "succeeded" } else { "failed" },
        error_category(c, V::Null)?,
        prop(plan, c"action")?,
    )?;
    let supervised = result.get(c"autoHandoffPreparation")?.truthy()?
        && port(p, c"getUnattendedState", &[session])?
            .optional(c"status")?
            .is_string("active")?;
    c.set(c"supervised", flag(c, supervised)?)?;
    let context = executor_context(c)?;
    context.set(c"autoProviderHandoffPending", flag(c, supervised)?)?;
    fields(c, &[("pending", execute_plan(p, plan, context)?)])
}

pub(super) fn install<'a>(env: &'a Env, p: L<'a>, api: L<'a>) -> Result<()> {
    for (name, count, run) in [
        ("start", 1, (|p, a: &mut [L<'_>]| start(p, a[0])) as Handler),
        ("execute", 1, |p, a| execute(p, a[0])),
        ("handoff", 2, |p, a| {
            let c = a[0];
            let finalization = a[1];
            if finalization.truthy()? && !prop(finalization, c"terminalBlocked")?.truthy()? {
                fields(
                    c,
                    &[(
                        "pending",
                        port(
                            p,
                            c"scheduleAutoProviderHandoff",
                            &[
                                c.get(c"sessionName")?,
                                c.get(c"turn")?,
                                c.get(c"result")?.get(c"autoHandoffPreparation")?,
                                c.get(c"supervised")?,
                            ],
                        )?,
                    )],
                )
            } else {
                null(c)
            }
        }),
    ] {
        api.define_key(text(p, name)?, method(env, p, name, count, count, run)?)?;
    }
    Ok(())
}
