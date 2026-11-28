use super::*;

pub(super) fn start(ctx: L<'_>) -> Result<L<'_>> {
    let p = ctx.get(c"p")?;
    let ts = num(p, time(p)?)?;
    ctx.set(c"started", ts)?;
    p.set(c"lastAttemptAt", ts)?;
    then(read(p)?, ctx, |ctx, a| {
        let p = ctx.get(c"p")?;
        let reason = ctx.get(c"reason")?;
        let ts = ctx.get(c"started")?;
        let before = a[0];
        let d = assess(p, before, ts.number()?)?;
        if !d.get(c"due")?.truthy()? {
            let outcome = d.get(c"outcome")?;
            let detail = d.get(c"detail")?;
            if outcome.is_string("fresh")? {
                cleared(p, "credential-fresh")?;
                p.set(c"consecutiveFailures", num(p, 0.)?)?;
                p.set(c"retryAfter", num(p, 0.)?)?;
            } else {
                log(
                    p,
                    c"warn",
                    "codex_oauth_refresh_skipped",
                    fields(
                        p,
                        &[("outcome", outcome), ("detail", detail), ("reason", reason)],
                    )?,
                )?;
            }
            return remember(
                p,
                fields(
                    p,
                    &[
                        ("outcome", outcome),
                        ("detail", detail),
                        ("at", ts),
                        ("reason", reason),
                    ],
                )?,
            );
        }
        ctx.set(c"before", before)?;
        ctx.set(c"env", command::environment(p)?)?;
        ctx.set(c"steps", array(p)?)?;
        ctx.set(c"dead", flag(p, false)?)?;
        rung(ctx, false)
    })
}
fn rung(ctx: L<'_>, probe: bool) -> Result<L<'_>> {
    let p = ctx.get(c"p")?;
    let before = ctx.get(c"before")?;
    let ts = time(p)?;
    let step = text(
        p,
        if probe {
            "authenticated-probe"
        } else {
            "login-status"
        },
    )?;
    ctx.set(c"step", step)?;
    ctx.set(c"probe", flag(p, probe)?)?;
    if probe && before.get(c"expiresAt")?.number()? - ts > p.get(c"probeThresholdMs")?.number()? {
        call(
            ctx.get(c"steps")?,
            c"push",
            &[fields(
                p,
                &[("step", step), ("skipped", text(p, "not_due_yet")?)],
            )?],
        )?;
        return exhausted(ctx);
    }
    let args = array(p)?;
    let argv: &[&str] = if probe {
        &[
            "exec",
            "--json",
            "--skip-git-repo-check",
            "-c",
            r#"model_reasoning_effort="minimal""#,
            "回复ok",
        ]
    } else {
        &["login", "status"]
    };
    for (i, v) in argv.iter().enumerate() {
        args.set_element(i as u32, text(p, v)?)?;
    }
    let invoked = command::run(p, args, ctx.get(c"env")?)?;
    then(invoked, ctx, |ctx, a| {
        let p = ctx.get(c"p")?;
        let result = a[0];
        let output = call(
            string(result.get(c"stdout")?)?,
            c"concat",
            &[text(p, "\n")?, string(result.get(c"stderr")?)?],
        )?;
        let dead = flag(p, matches(output, true)?)?;
        if dead.truthy()? {
            ctx.set(c"dead", dead)?;
        }
        ctx.set(c"authDead", dead)?;
        ctx.set(c"result", result)?;
        then(read(p)?, ctx, checked)
    })
}
fn checked<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = ctx.get(c"p")?;
    let step = ctx.get(c"step")?;
    let before = ctx.get(c"before")?;
    let after = a[0];
    let ts = time(p)?;
    let result = ctx.get(c"result")?;
    let ok = after.get(c"ok")?.truthy()?
        && (after.get(c"expiresAt")?.number()? > before.get(c"expiresAt")?.number()?
            || after.get(c"expiresAt")?.number()? - ts > p.get(c"bufferMs")?.number()?
            || (after.get(c"accessToken")?.truthy()?
                && !after
                    .get(c"accessToken")?
                    .equals(before.get(c"accessToken")?)?));
    call(
        ctx.get(c"steps")?,
        c"push",
        &[fields(
            p,
            &[
                ("step", step),
                ("code", result.get(c"code")?),
                ("timedOut", flag(p, result.get(c"timedOut")?.truthy()?)?),
                ("refreshed", flag(p, ok)?),
                ("authDead", ctx.get(c"authDead")?),
            ],
        )?],
    )?;
    if !ok {
        return if ctx.get(c"probe")?.truthy()? {
            exhausted(ctx)
        } else {
            rung(ctx, true)
        };
    }
    cleared(p, "refreshed")?;
    let ts = time(p)?;
    p.set(c"lastSuccessAt", num(p, ts)?)?;
    p.set(c"consecutiveFailures", num(p, 0.)?)?;
    p.set(c"retryAfter", num(p, 0.)?)?;
    p.set(
        c"refreshCount",
        num(p, p.get(c"refreshCount")?.number()? + 1.)?,
    )?;
    let reason = ctx.get(c"reason")?;
    let elapsed = num(p, ts - ctx.get(c"started")?.number()?)?;
    let expiry = after.get(c"expiresAt")?;
    let out = remember(
        p,
        fields(
            p,
            &[
                ("outcome", text(p, "refreshed")?),
                ("step", step),
                ("reason", reason),
                ("at", num(p, ts)?),
                ("expiresAt", expiry),
                ("elapsedMs", elapsed),
            ],
        )?,
    )?;
    log(
        p,
        c"info",
        "codex_oauth_refreshed",
        fields(
            p,
            &[
                ("step", step),
                ("reason", reason),
                ("validForMs", num(p, expiry.number()? - ts)?),
                ("elapsedMs", elapsed),
            ],
        )?,
    )?;
    Ok(out)
}
fn exhausted(ctx: L<'_>) -> Result<L<'_>> {
    let p = ctx.get(c"p")?;
    let ts = time(p)?;
    let expires = ctx.get(c"before")?.get(c"expiresAt")?.number()?;
    let reason = ctx.get(c"reason")?;
    let steps = ctx.get(c"steps")?;
    let at = num(p, ts)?;
    if expires > ts {
        let remain = num(p, expires - ts)?;
        let out = remember(
            p,
            fields(
                p,
                &[
                    ("outcome", text(p, "deferred")?),
                    ("reason", reason),
                    ("at", at),
                    ("steps", steps),
                    ("expiresInMs", remain),
                ],
            )?,
        )?;
        p.set(
            c"retryAfter",
            num(p, ts + p.get(c"deferCooldownMs")?.number()?)?,
        )?;
        log(
            p,
            c"info",
            "codex_oauth_refresh_deferred",
            fields(p, &[("reason", reason), ("expiresInMs", remain)])?,
        )?;
        return Ok(out);
    }
    let required = ctx.get(c"dead")?.truthy()? || ctx.get(c"hint")?.truthy()?;
    let n = num(p, p.get(c"consecutiveFailures")?.number()? + 1.)?;
    let out = remember(
        p,
        fields(
            p,
            &[
                (
                    "outcome",
                    text(p, if required { "needs_login" } else { "failed" })?,
                ),
                ("reason", reason),
                ("at", at),
                ("steps", steps),
                ("consecutiveFailures", n),
            ],
        )?,
    )?;
    p.set(c"consecutiveFailures", n)?;
    p.set(c"retryAfter", num(p, ts + p.get(c"cooldownMs")?.number()?)?)?;
    if required && !p.get(c"needsLogin")?.truthy()? {
        p.set(
            c"needsLogin",
            fields(p, &[("since", at), ("reason", reason)])?,
        )?;
        log(
            p,
            c"error",
            "codex_oauth_needs_login",
            fields(p, &[("reason", reason)])?,
        )?;
        notify(p, c"onNeedsLogin")?;
    }
    log(
        p,
        c"error",
        "codex_oauth_refresh_failed",
        fields(
            p,
            &[
                ("reason", reason),
                ("steps", steps),
                ("consecutiveFailures", n),
                ("needsLogin", flag(p, p.get(c"needsLogin")?.truthy()?)?),
            ],
        )?,
    )?;
    Ok(out)
}
