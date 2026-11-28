use super::*;

pub(super) fn begin<'a>(ctx: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let p = ctx.get(c"p")?;
    let before = args[0];
    let reason = ctx.get(c"reason")?;
    let start = ctx.get(c"started")?;
    ctx.set(c"before", before)?;
    let parked = p.get(c"parked")?;
    if parked.truthy()? {
        let fp = parse::fingerprint(before)?;
        if fp.truthy()? && !fp.equals(parked.get(c"credentialFingerprint")?)? {
            state::unpark(p, before, "credential_replaced")?;
        } else if let Some(plan) =
            state::plan(p, before, ctx.get(c"force")?.truthy()?)?.filter(|v| v.recover_parked)
        {
            let win = state::window(p, before.get(c"expiresAt")?)?;
            win.set(
                c"probes",
                num(
                    p,
                    win.get(c"probes")?.number()?.max(plan.budget_floor as f64),
                )?,
            )?;
        } else {
            let class = parked.get(c"failureClass")?;
            return remember(
                p,
                fields(
                    p,
                    &[
                        (
                            "outcome",
                            text(
                                p,
                                if class.is_string("needs-login")? {
                                    "needs-login"
                                } else {
                                    "parked"
                                },
                            )?,
                        ),
                        ("detail", class),
                        ("parkedAt", parked.get(c"at")?),
                        ("reason", reason),
                        ("at", start),
                    ],
                )?,
            );
        }
    }
    let assessment = assessed(p, before, start.number()?)?;
    if !assessment.get(c"due")?.truthy()? {
        let info = pick(assessment, &[c"outcome", c"detail"])?;
        info.set(c"reason", reason)?;
        if info.get(c"outcome")?.is_string("fresh")? {
            p.set(c"consecutiveFailures", num(p, 0.)?)?;
            p.set(c"retryAfter", num(p, 0.)?)?;
        } else {
            log(p, c"warn", "claude_oauth_refresh_skipped", info)?;
        }
        let value = pick(assessment, &[c"outcome", c"detail"])?;
        value.set(c"at", start)?;
        value.set(c"reason", reason)?;
        return remember(p, value);
    }
    ctx.set(c"env", command::environment(p)?)?;
    ctx.set(c"steps", array(p)?)?;
    ctx.set(c"spend", state::window(p, before.get(c"expiresAt")?)?)?;
    time(p)?; // The first rung also observes the injected clock.
    start_rung(ctx, false)
}
fn start_rung(ctx: L<'_>, probe: bool) -> Result<L<'_>> {
    ctx.set(c"probe", flag(ctx, probe)?)?;
    let result = command::run(ctx, probe)?;
    then(result, ctx, |ctx, a| {
        ctx.set(c"result", a[0])?;
        then(command::read(ctx.get(c"p")?)?, ctx, verify)
    })
}
fn verify<'a>(ctx: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let p = ctx.get(c"p")?;
    let after = args[0];
    let before = ctx.get(c"before")?;
    let ts = time(p)?;
    let refreshed = after.get(c"ok")?.truthy()? && {
        let expiry = after.get(c"expiresAt")?.number()?;
        expiry > before.get(c"expiresAt")?.number()?
            || expiry - ts > p.get(c"bufferMs")?.number()?
    };
    let probe = ctx.get(c"probe")?.truthy()?;
    let name = text(
        p,
        if probe {
            "authenticated-probe"
        } else {
            "auth-status"
        },
    )?;
    let result = ctx.get(c"result")?;
    let code = result.get(c"code")?;
    let timed_out = result.get(c"timedOut")?.truthy()?;
    let step = fields(
        p,
        &[
            ("step", name),
            ("code", code),
            ("timedOut", flag(p, timed_out)?),
            ("refreshed", flag(p, refreshed)?),
        ],
    )?;
    if !refreshed && (result.get(c"stderr")?.truthy()? || result.get(c"stdout")?.truthy()?) {
        let err = parse::redact(result.get(c"stderr")?, undef(p)?)?;
        step.set(c"stderr", err)?;
        if !err.truthy()? && result.get(c"stdout")?.truthy()? {
            step.set(c"stdout", parse::redact(result.get(c"stdout")?, undef(p)?)?)?;
        }
    }
    push(ctx.get(c"steps")?, step)?;
    if probe && !refreshed && (timed_out || !code.is_number(0.)?) {
        p.set(
            c"lastProbeFailure",
            fields(
                p,
                &[
                    ("credentialExpiresAt", before.get(c"expiresAt")?),
                    ("step", spread(step)?),
                ],
            )?,
        )?;
        state::persist(p, undef(p)?)?;
    }
    if refreshed {
        return outcome::success(ctx, after, name);
    }
    if probe {
        return outcome::unchanged(ctx, false);
    }
    let verdict = parse::auth(result)?;
    if verdict.truthy()? && !verdict.get(c"loggedIn")?.truthy()? {
        return outcome::no_login(ctx, verdict);
    }
    probe_or_finish(ctx)
}
fn probe_or_finish(ctx: L<'_>) -> Result<L<'_>> {
    let p = ctx.get(c"p")?;
    let before = ctx.get(c"before")?;
    let expiry = before.get(c"expiresAt")?;
    let steps = ctx.get(c"steps")?;
    let skipped = |why: &str| {
        push(
            steps,
            fields(
                p,
                &[
                    ("step", text(p, "authenticated-probe")?),
                    ("skipped", text(p, why)?),
                ],
            )?,
        )
    };
    if expiry.number()? - time(p)? > p.get(c"probeThresholdMs")?.number()? {
        skipped("not_due_yet")?;
        return outcome::unchanged(ctx, false);
    }
    let spend = ctx.get(c"spend")?;
    let previous = spread(spend)?;
    let receipt = p.get(c"postExpiryAttempt")?;
    let plan = state::plan(p, before, ctx.get(c"force")?.truthy()?)?;
    if let Some(plan) = &plan {
        spend.set(
            c"probes",
            num(
                p,
                spend
                    .get(c"probes")?
                    .number()?
                    .max(plan.budget_floor as f64),
            )?,
        )?;
    }
    let Some(plan) = plan.filter(|v| v.allow_probe) else {
        skipped("budget_spent")?;
        return outcome::unchanged(ctx, true);
    };
    if plan.reserve_post_expiry {
        p.set(
            c"postExpiryAttempt",
            fields(
                p,
                &[("credentialExpiresAt", expiry), ("reservedAt", now(p)?)],
            )?,
        )?;
    }
    spend.set(c"probes", num(p, spend.get(c"probes")?.number()? + 1.)?)?;
    if !state::persist(p, undef(p)?)? {
        call(p.global()?.get(c"Object")?, c"assign", &[spend, previous])?;
        p.set(c"postExpiryAttempt", receipt)?;
        let reason = ctx.get(c"reason")?;
        let value = remember(
            p,
            fields(
                p,
                &[
                    ("outcome", text(p, "failed")?),
                    ("detail", text(p, "refresh_health_write_failed")?),
                    ("reason", reason),
                    ("at", now(p)?),
                    ("steps", steps),
                ],
            )?,
        )?;
        log(
            p,
            c"warn",
            "claude_oauth_refresh_reservation_failed",
            fields(
                p,
                &[
                    ("reason", reason),
                    ("action", text(p, "CLI probe was not started")?),
                ],
            )?,
        )?;
        return Ok(value);
    }
    if plan.recover_parked {
        state::unpark(p, before, "post_expiry_retry")?;
    }
    start_rung(ctx, true)
}
