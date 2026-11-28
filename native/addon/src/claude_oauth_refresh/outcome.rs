use super::*;

fn backoff(p: L<'_>, failures: f64) -> Result<f64> {
    Ok((p.get(c"cooldownMs")?.number()? * 2f64.powf(failures - 1.))
        .min(p.get(c"maxCooldownMs")?.number()?))
}
fn failure_count(p: L<'_>) -> Result<f64> {
    let failures = p.get(c"consecutiveFailures")?.number()? + 1.;
    p.set(c"consecutiveFailures", num(p, failures)?)?;
    Ok(failures)
}
pub(super) fn harness_error<'a>(ctx: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let p = ctx.get(c"p")?;
    let reason = ctx.get(c"reason")?;
    let failures = failure_count(p)?;
    p.set(c"retryAfter", num(p, time(p)? + backoff(p, failures)?)?)?;
    let class = text(p, "harness_error")?;
    p.set(c"failureClass", class)?;
    let message = args[0].get(c"message")?;
    p.set(
        c"lastFailure",
        fields(
            p,
            &[
                ("at", iso(p, time(p)?)?),
                ("failureClass", class),
                ("reason", reason),
                ("error", message),
            ],
        )?,
    )?;
    log(
        p,
        c"error",
        "claude_oauth_refresh_error",
        fields(p, &[("reason", reason), ("error", message)])?,
    )?;
    state::persist(p, undef(p)?)?;
    fields(
        p,
        &[
            ("outcome", text(p, "failed")?),
            ("reason", reason),
            ("error", message),
        ],
    )
}
pub(super) fn success<'a>(ctx: L<'a>, after: L<'a>, name: L<'a>) -> Result<L<'a>> {
    let p = ctx.get(c"p")?;
    let reason = ctx.get(c"reason")?;
    let ts = now(p)?;
    p.set(c"lastSuccessAt", ts)?;
    for k in [c"consecutiveFailures", c"retryAfter"] {
        p.set(k, num(p, 0.)?)?;
    }
    for k in [
        c"failureClass",
        c"lastFailure",
        c"lastProbeFailure",
        c"parked",
    ] {
        p.set(k, null(p)?)?;
    }
    p.set(
        c"refreshCount",
        num(p, p.get(c"refreshCount")?.number()? + 1.)?,
    )?;
    let elapsed = num(p, ts.number()? - ctx.get(c"started")?.number()?)?;
    let store = after.get(c"store")?;
    let expiry = after.get(c"expiresAt")?;
    let value = remember(
        p,
        fields(
            p,
            &[
                ("outcome", text(p, "refreshed")?),
                ("step", name),
                ("reason", reason),
                ("at", ts),
                ("expiresAt", expiry),
                ("store", store),
                ("elapsedMs", elapsed),
            ],
        )?,
    )?;
    log(
        p,
        c"info",
        "claude_oauth_refreshed",
        fields(
            p,
            &[
                ("step", name),
                ("reason", reason),
                ("store", store),
                ("validForMs", num(p, expiry.number()? - ts.number()?)?),
                ("elapsedMs", elapsed),
            ],
        )?,
    )?;
    state::persist_fingerprint(p, after)?;
    Ok(value)
}
pub(super) fn no_login<'a>(ctx: L<'a>, verdict: L<'a>) -> Result<L<'a>> {
    let p = ctx.get(c"p")?;
    let before = ctx.get(c"before")?;
    let ts = time(p)?;
    let reason = ctx.get(c"reason")?;
    state::park(p, before, ts, reason, "needs-login")?;
    let class = text(p, "needs-login")?;
    let method = verdict.get(c"authMethod")?;
    let steps = ctx.get(c"steps")?;
    let detail = text(p, "cli_reports_not_logged_in")?;
    p.set(c"failureClass", class)?;
    p.set(
        c"lastFailure",
        fields(
            p,
            &[
                ("at", iso(p, ts)?),
                ("failureClass", class),
                ("reason", reason),
                ("detail", detail),
                ("authMethod", method),
                ("steps", steps),
            ],
        )?,
    )?;
    let value = remember(
        p,
        fields(
            p,
            &[
                ("outcome", class),
                ("reason", reason),
                ("at", num(p, ts)?),
                ("detail", detail),
                ("authMethod", method),
                ("steps", steps),
            ],
        )?,
    )?;
    log(p,c"error","claude_oauth_refresh_parked",fields(p,&[("reason",reason),("failureClass",class),("authMethod",method),("steps",steps),("action",text(p,"the CLI reports no login — log in again; retries are suspended until the credential changes")?)])?)?;
    state::persist_fingerprint(p, before)?;
    Ok(value)
}
fn deferred<'a>(ctx: L<'a>, ts: f64, ttl: f64) -> Result<L<'a>> {
    let p = ctx.get(c"p")?;
    let reason = ctx.get(c"reason")?;
    let spend = ctx.get(c"spend")?;
    let declines = spend.get(c"declines")?.number()? + 1.;
    spend.set(c"declines", num(p, declines)?)?;
    let value = fields(
        p,
        &[
            ("outcome", text(p, "deferred")?),
            ("reason", reason),
            ("at", num(p, ts)?),
            ("steps", ctx.get(c"steps")?),
            ("expiresInMs", num(p, ttl)?),
        ],
    )?;
    let info = fields(p, &[("reason", reason), ("expiresInMs", num(p, ttl)?)])?;
    let probe_at =
        ctx.get(c"before")?.get(c"expiresAt")?.number()? - p.get(c"probeThresholdMs")?.number()?;
    if !ctx.get(c"force")?.truthy()?
        && declines >= p.get(c"maxDeclinesPerWindow")?.number()?
        && probe_at > ts
    {
        p.set(c"retryAfter", num(p, probe_at)?)?;
        for obj in [value, info] {
            obj.set(c"nextAttemptInMs", num(p, probe_at - ts)?)?;
            obj.set(c"declines", num(p, declines)?)?;
        }
        info.set(c"waitingForExpiry", flag(p, true)?)?;
    } else {
        p.set(
            c"retryAfter",
            num(p, ts + p.get(c"deferCooldownMs")?.number()?)?,
        )?;
    }
    remember(p, value)?;
    log(p, c"info", "claude_oauth_refresh_deferred", info)?;
    Ok(value)
}
pub(super) fn unchanged(ctx: L<'_>, spent: bool) -> Result<L<'_>> {
    let p = ctx.get(c"p")?;
    let before = ctx.get(c"before")?;
    let expiry = before.get(c"expiresAt")?;
    let ts = time(p)?;
    let ttl = expiry.number()? - ts;
    if ttl > 0. {
        return deferred(ctx, ts, ttl);
    }
    let count = failure_count(p)?;
    let steps = ctx.get(c"steps")?;
    let historical = call(steps, c"slice", &[])?;
    let prev = p.get(c"lastProbeFailure")?;
    if spent && prev.optional(c"credentialExpiresAt")?.equals(expiry)? {
        let step = spread(prev.get(c"step")?)?;
        step.set(c"step", text(p, "previous-authenticated-probe")?)?;
        push(historical, step)?;
    }
    let class = parse::classify(historical)?;
    let kind = text(p, class)?;
    let reason = ctx.get(c"reason")?;
    p.set(c"failureClass", kind)?;
    let filtered = array(p)?;
    historical.for_each(|step| {
        if step.get(c"stderr")?.truthy()?
            || step.get(c"stdout")?.truthy()?
            || step.get(c"timedOut")?.truthy()?
        {
            push(filtered, step)?;
        }
        Ok(())
    })?;
    p.set(
        c"lastFailure",
        fields(
            p,
            &[
                ("at", iso(p, ts)?),
                ("failureClass", kind),
                ("reason", reason),
                ("expiresInMs", num(p, ttl)?),
                ("steps", filtered),
            ],
        )?,
    )?;
    let budget =
        ctx.get(c"spend")?.get(c"probes")?.number()? >= p.get(c"maxProbesPerWindow")?.number()?;
    let park = class == "rejected"
        || count >= p.get(c"parkAfterFailures")?.number()?
        || (budget && class != "network");
    let value = fields(
        p,
        &[
            ("outcome", text(p, if park { "parked" } else { "failed" })?),
            ("reason", reason),
            ("at", num(p, ts)?),
            ("detail", kind),
            ("steps", steps),
            ("consecutiveFailures", num(p, count)?),
        ],
    )?;
    let info = fields(
        p,
        &[
            ("reason", reason),
            ("failureClass", kind),
            ("consecutiveFailures", num(p, count)?),
        ],
    )?;
    if park {
        state::park(p, before, ts, reason, class)?;
        info.set(c"steps", steps)?;
        info.set(c"action",text(p,if class=="rejected" {"credential rejected by the server — log in again; retries are suspended until the credential changes"}else{"repeated refresh failures — retries are parked until the credential changes; run `claude` or log in again"})?)?;
    } else {
        let delay = backoff(p, count)?;
        p.set(c"retryAfter", num(p, ts + delay)?)?;
        for obj in [value, info] {
            obj.set(c"retryInMs", num(p, delay)?)?;
        }
        info.set(c"steps", steps)?;
    }
    remember(p, value)?;
    log(
        p,
        c"error",
        if park {
            "claude_oauth_refresh_parked"
        } else {
            "claude_oauth_refresh_failed"
        },
        info,
    )?;
    state::persist_fingerprint(p, before)?;
    Ok(value)
}
