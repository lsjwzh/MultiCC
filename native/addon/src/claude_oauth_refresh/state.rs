use super::*;

pub(super) fn window<'a>(p: L<'a>, expiry: L<'a>) -> Result<L<'a>> {
    let old = p.get(c"window")?;
    if old.truthy()? && old.get(c"expiresAt")?.equals(expiry)? {
        return Ok(old);
    }
    let next = fields(
        p,
        &[
            ("expiresAt", expiry),
            ("declines", num(p, 0.)?),
            ("probes", num(p, 0.)?),
        ],
    )?;
    p.set(c"window", next)?;
    Ok(next)
}
pub(super) fn persist<'a>(p: L<'a>, extra: L<'a>) -> Result<bool> {
    let health = p.get(c"health")?;
    let key = p.get(c"healthKey")?;
    if !health.truthy()? || !key.truthy()? {
        return Ok(true);
    }
    let record = pick(
        p,
        &[
            c"consecutiveFailures",
            c"refreshCount",
            c"failureClass",
            c"lastFailure",
            c"lastSuccessAt",
            c"parked",
            c"postExpiryAttempt",
            c"lastProbeFailure",
        ],
    )?;
    let win = p.get(c"window")?;
    record.set(
        c"probeWindow",
        if win.truthy()? {
            spread(win)?
        } else {
            null(p)?
        },
    )?;
    call(p.global()?.get(c"Object")?, c"assign", &[record, extra])?;
    call(health, c"write", &[key, record])?.is_true()
}
fn number_or<'a>(v: L<'a>, default: L<'a>) -> Result<L<'a>> {
    let n = num(v, v.explicit_number()?)?;
    Ok(if n.truthy()? { n } else { default })
}
pub(super) fn restore(p: L<'_>) -> Result<()> {
    let health = p.get(c"health")?;
    let key = p.get(c"healthKey")?;
    if !health.truthy()? || !key.truthy()? {
        return Ok(());
    }
    let old = call(health, c"read", &[key])?;
    if !old.truthy()? || !object(old)? {
        return Ok(());
    }
    for k in [c"consecutiveFailures", c"refreshCount"] {
        p.set(k, number_or(old.get(k)?, num(p, 0.)?)?)?;
    }
    p.set(
        c"lastSuccessAt",
        number_or(old.get(c"lastSuccessAt")?, null(p)?)?,
    )?;
    for k in [c"failureClass", c"lastFailure"] {
        p.set(k, fallback(old.get(k)?, V::Null)?)?;
    }
    let previous = old.get(c"postExpiryAttempt")?;
    if previous.truthy()? && object(previous)? {
        p.set(
            c"postExpiryAttempt",
            fields(
                p,
                &[
                    (
                        "credentialExpiresAt",
                        number_or(previous.get(c"credentialExpiresAt")?, null(p)?)?,
                    ),
                    (
                        "reservedAt",
                        number_or(previous.get(c"reservedAt")?, null(p)?)?,
                    ),
                ],
            )?,
        )?;
    }
    let failure = old.get(c"lastProbeFailure")?;
    if failure.truthy()? && object(failure)? {
        let expiry = failure.get(c"credentialExpiresAt")?.explicit_number()?;
        let step = failure.get(c"step")?;
        if expiry.is_finite() && step.truthy()? && object(step)? {
            p.set(
                c"lastProbeFailure",
                fields(
                    p,
                    &[
                        ("credentialExpiresAt", num(p, expiry)?),
                        (
                            "step",
                            fields(
                                p,
                                &[
                                    ("step", text(p, "authenticated-probe")?),
                                    ("code", step.get(c"code")?),
                                    ("timedOut", flag(p, step.get(c"timedOut")?.is_true()?)?),
                                    ("refreshed", flag(p, false)?),
                                    ("stderr", parse::redact(step.get(c"stderr")?, undef(p)?)?),
                                    ("stdout", parse::redact(step.get(c"stdout")?, undef(p)?)?),
                                ],
                            )?,
                        ),
                    ],
                )?,
            )?;
        }
    }
    let win = old.get(c"probeWindow")?;
    if win.truthy()? && object(win)? {
        let expiry = win.get(c"expiresAt")?.explicit_number()?;
        if expiry.is_finite() {
            let out = fields(p, &[("expiresAt", num(p, expiry)?)])?;
            for k in [c"declines", c"probes"] {
                let n = number_or(win.get(k)?, num(p, 0.)?)?.number()?;
                out.set(k, num(p, n.max(0.))?)?;
            }
            p.set(c"window", out)?;
        }
    }
    let park = old.get(c"parked")?;
    if park.truthy()? && object(park)? {
        p.set(
            c"parked",
            fields(
                p,
                &[
                    ("at", number_or(park.get(c"at")?, null(p)?)?),
                    (
                        "reason",
                        fallback(park.get(c"reason")?, "persisted".into())?,
                    ),
                    (
                        "failureClass",
                        if park.get(c"failureClass")?.truthy()? {
                            park.get(c"failureClass")?
                        } else {
                            p.get(c"failureClass")?
                        },
                    ),
                    (
                        "consecutiveFailures",
                        number_or(
                            park.get(c"consecutiveFailures")?,
                            p.get(c"consecutiveFailures")?,
                        )?,
                    ),
                    (
                        "credentialFingerprint",
                        fallback(park.get(c"credentialFingerprint")?, V::Null)?,
                    ),
                    (
                        "credentialExpiresAt",
                        number_or(park.get(c"credentialExpiresAt")?, null(p)?)?,
                    ),
                ],
            )?,
        )?;
    }
    Ok(())
}
pub(super) fn plan(
    p: L<'_>,
    cred: L<'_>,
    force: bool,
) -> Result<Option<multicc_core::claude_refresh::Plan>> {
    let failure = p.get(c"lastProbeFailure")?;
    let previous = if failure.truthy()?
        && failure
            .get(c"credentialExpiresAt")?
            .equals(cred.get(c"expiresAt")?)?
    {
        let steps = array(p)?;
        call(steps, c"push", &[failure.get(c"step")?])?;
        text(p, parse::classify(steps)?)?
    } else {
        null(p)?
    };
    let park = p.get(c"parked")?;
    let win = p.get(c"window")?;
    let input = fields(
        p,
        &[
            ("now", num(p, time(p)?)?),
            ("expiresAt", cred.get(c"expiresAt")?),
            (
                "hasRefreshToken",
                flag(p, cred.get(c"hasRefreshToken")?.is_true()?)?,
            ),
            (
                "refreshExpiresAt",
                fallback(cred.get(c"refreshExpiresAt")?, V::Null)?,
            ),
            (
                "postExpiryAttemptedFor",
                fallback(
                    p.get(c"postExpiryAttempt")?
                        .optional(c"credentialExpiresAt")?,
                    V::Null,
                )?,
            ),
            ("parked", flag(p, park.truthy()?)?),
            (
                "parkedFailureClass",
                if park.truthy()? {
                    fallback(park.get(c"failureClass")?, V::Null)?
                } else {
                    previous
                },
            ),
            (
                "probes",
                if win.truthy()? && win.get(c"expiresAt")?.equals(cred.get(c"expiresAt")?)? {
                    win.get(c"probes")?
                } else {
                    num(p, 0.)?
                },
            ),
            ("maxProbes", p.get(c"maxProbesPerWindow")?),
            ("force", flag(p, force)?),
        ],
    )?;
    match multicc_core::claude_refresh::decision(&fold_string(json_call(p, c"stringify", input)?)?)
    {
        Ok(plan) => Ok(Some(plan)),
        Err(_) => {
            if !p.get(c"warnedPlan")?.truthy()? {
                p.set(c"warnedPlan", flag(p, true)?)?;
                log(p, c"warn", "claude_expired_refresh_policy_unavailable", fields(p, &[("action", text(p, "build the current Rust addon; Claude CLI probes stay disabled until it is available")?)])?)?;
            }
            Ok(None)
        }
    }
}
pub(super) fn unpark(p: L<'_>, cred: L<'_>, why: &str) -> Result<()> {
    let old = p.get(c"parked")?;
    if !old.truthy()? {
        return Ok(());
    }
    p.set(c"parked", null(p)?)?;
    p.set(c"retryAfter", num(p, 0.)?)?;
    log(
        p,
        c"info",
        "claude_oauth_refresh_unparked",
        fields(
            p,
            &[
                ("reason", text(p, why)?),
                ("failureClass", old.get(c"failureClass")?),
                ("credentialFingerprint", parse::fingerprint(cred)?),
            ],
        )?,
    )?;
    persist(p, fields(p, &[("unparkedAt", iso(p, time(p)?)?)])?)?;
    Ok(())
}
pub(super) fn park<'a>(p: L<'a>, cred: L<'a>, ts: f64, reason: L<'a>, class: &str) -> Result<()> {
    p.set(
        c"parked",
        fields(
            p,
            &[
                ("at", num(p, ts)?),
                ("reason", reason),
                ("failureClass", text(p, class)?),
                ("consecutiveFailures", p.get(c"consecutiveFailures")?),
                ("credentialFingerprint", parse::fingerprint(cred)?),
                (
                    "credentialExpiresAt",
                    if cred.get(c"ok")?.truthy()? {
                        cred.get(c"expiresAt")?
                    } else {
                        null(p)?
                    },
                ),
            ],
        )?,
    )?;
    p.set(c"retryAfter", num(p, 0.)?)?;
    Ok(())
}
pub(super) fn persist_fingerprint(p: L<'_>, cred: L<'_>) -> Result<()> {
    persist(
        p,
        fields(p, &[("credentialFingerprint", parse::fingerprint(cred)?)])?,
    )?;
    Ok(())
}
