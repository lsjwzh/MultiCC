use super::*;

pub(super) fn lineage(v: L<'_>) -> Result<L<'_>> {
    let s = object_value(v)?;
    let kind = s.get(c"kind")?;
    let kind = if kind.is_string("dispatch")? || kind.is_string("trigger")? {
        kind
    } else {
        text(s, "user")?
    };
    frozen(
        s,
        &[
            ("kind", kind),
            (
                "operationId",
                if kind.is_string("dispatch")? {
                    fallback(s.get(c"operationId")?.clean_text()?, V::Null)?
                } else {
                    null(s)?
                },
            ),
        ],
    )
}
pub(super) fn task(v: L<'_>) -> Result<L<'_>> {
    let s = object_value(v)?;
    frozen(
        s,
        &[
            ("id", fallback(s.get(c"id")?.clean_text()?, V::Null)?),
            ("start", flag(s, s.get(c"start")?.is_true()?)?),
            (
                "source",
                fallback(s.get(c"source")?.clean_text()?, V::Null)?,
            ),
        ],
    )
}
pub(super) fn usage(v: L<'_>) -> Result<L<'_>> {
    let s = object_value(v)?;
    let cli = lower(s.get(c"cli")?)?;
    let id = fallback(s.get(c"providerId")?.clean_text()?, "_default_".into())?;
    let role = fallback(lower(s.get(c"roleKind")?)?, "main".into())?;
    let dec = s.get(c"decisionId")?.clean_text()?;
    let attempt = s.get(c"routeAttemptId")?.clean_text()?;
    let to_number = |k: &CStr| -> Result<L<'_>> {
        let v = s.get(k)?;
        if v.nullish()? {
            null(s)
        } else {
            num(s, v.explicit_number()?)
        }
    };
    let generation = to_number(c"routeGeneration")?;
    let no = to_number(c"attemptNo")?;
    let epoch = s.get(c"runtimeEpoch")?.clean_text()?;
    let rev = s.get(c"providerRevision")?.clean_text()?;
    let has = dec.truthy()?
        || attempt.truthy()?
        || !generation.nullish()?
        || !no.nullish()?
        || epoch.truthy()?
        || rev.truthy()?;
    if has
        && (!dec.truthy()?
            || !attempt.truthy()?
            || !epoch.truthy()?
            || !rev.truthy()?
            || !is_safe(generation)?
            || generation.number()? < 1.
            || !is_safe(no)?
            || no.number()? < 1.)
    {
        return Err(s.type_error("complete provider attempt attribution is required"));
    }
    let protocol = lower(s.get(c"protocol")?)?;
    let protocol = if protocol.truthy()? {
        protocol
    } else if cli.is_string("codex")? || cli.is_string("codex-exp")? {
        text(s, "openai-responses")?
    } else if cli.is_string("claude")? || cli.is_string("claude-exp")? {
        text(s, "anthropic-messages")?
    } else {
        cli
    };
    let out = fields(
        s,
        &[
            ("providerId", id),
            (
                "providerName",
                choose(s.get(c"providerName")?.clean_text()?, id)?,
            ),
            ("cli", cli),
            ("protocol", protocol),
            ("model", s.get(c"model")?.clean_text()?),
            ("roleKind", role),
            ("routeName", choose(lower(s.get(c"routeName")?)?, role)?),
        ],
    )?;
    if has {
        out.spread_from(fields(
            s,
            &[
                ("runtimeEpoch", epoch),
                ("decisionId", dec),
                ("routeAttemptId", attempt),
                ("routeGeneration", generation),
                ("attemptNo", no),
                ("providerRevision", rev),
            ],
        )?)?;
    }
    out.freeze()
}
pub(super) fn bind<'a>(owner: L<'a>, input: L<'a>, runner: bool) -> Result<L<'a>> {
    if !owner.truthy()?
        || !owner
            .get(if runner { c"runnerId" } else { c"turnId" })?
            .truthy()?
    {
        return Err(owner.type_error(if runner {
            "runner ownership is required"
        } else {
            "turn lifecycle is required"
        }));
    }
    let next = usage(input)?;
    if runner && !next.get(c"routeAttemptId")?.truthy()? {
        return Err(owner.type_error("runner provider attempt attribution is required"));
    }
    let prior = owner.get(c"usageAttribution")?;
    if prior.truthy()? && (!runner || prior.get(c"routeAttemptId")?.truthy()?) {
        let mut same = true;
        keys(next)?.for_each_while(|k| {
            same = prior.get_key(k)?.equals(next.get_key(k)?)?;
            Ok(same)
        })?;
        if !same {
            return Err(owner.type_error(if runner {
                "runner usage attribution is already frozen"
            } else {
                "turn usage attribution is already frozen"
            }));
        }
        return Ok(prior);
    }
    owner.assign(c"usageAttribution", next)?;
    Ok(next)
}
pub(super) fn verify<'a>(runner: L<'a>, turn: L<'a>, input: L<'a>) -> Result<()> {
    let attempt = input.get(c"providerAttempt")?;
    let proof = input.get(c"routeProof")?;
    if !attempt.truthy()? {
        if proof.truthy()? {
            return Err(input.type_error("route proof requires provider attempt ownership"));
        }
        return Ok(());
    }
    if !js_frozen(attempt)?
        || !attempt.get(c"turnId")?.equals(turn.get(c"turnId")?)?
        || !attempt.get(c"routeAttemptId")?.clean_text()?.truthy()?
    {
        return Err(input.type_error("frozen provider attempt ownership is required"));
    }
    let route = proof.optional(c"route")?;
    let attribution = runner.get(c"usageAttribution")?;
    let mut ok = proof.truthy()?
        && js_frozen(proof)?
        && js_frozen(route)?
        && proof.get(c"kind")?.is_string("provider-route")?
        && proof.get(c"resolved")?.is_true()?
        && proof.get(c"sessionId")?.equals(turn.get(c"sessionId")?)?
        && proof.get(c"turnId")?.equals(turn.get(c"turnId")?)?
        && proof.get(c"cli")?.equals(attribution.get(c"cli")?)?
        && attempt.get(c"cli")?.equals(attribution.get(c"cli")?)?
        && attempt.get(c"sessionId")?.equals(turn.get(c"sessionId")?)?;
    for k in [
        c"runtimeEpoch",
        c"decisionId",
        c"routeAttemptId",
        c"routeGeneration",
        c"attemptNo",
        c"providerId",
        c"providerName",
        c"protocol",
        c"model",
        c"providerRevision",
    ] {
        if !ok {
            break;
        }
        ok = route.get(k)?.equals(attempt.get(k)?)?
            && attribution.get(k)?.equals(attempt.get(k)?)?;
    }
    if !ok {
        return Err(
            input.type_error("runner provider attempt, route proof, and attribution must match")
        );
    }
    for (k, val) in [("providerAttempt", attempt), ("providerRouteProof", proof)] {
        define(
            runner,
            text(runner, k)?,
            fields(
                runner,
                &[("value", val), ("enumerable", flag(runner, true)?)],
            )?,
        )?;
    }
    Ok(())
}
