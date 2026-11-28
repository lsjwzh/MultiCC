use super::*;

pub(super) fn clean(v: L<'_>) -> Result<L<'_>> {
    if v.nullish()? {
        text(v, "")
    } else {
        call(string(v)?, c"trim", &[])
    }
}
fn first<'a>(base: L<'a>, candidates: &[(L<'a>, &CStr)], default: L<'a>) -> Result<L<'a>> {
    let mut value = undef(base)?;
    for &(owner, key) in candidates {
        value = owner.optional(key)?;
        if value.truthy()? {
            return clean(value);
        }
    }
    if default.undefined()? {
        clean(value)
    } else {
        clean(default)
    }
}
pub(super) fn of(ctx: L<'_>) -> Result<L<'_>> {
    let runner = ctx.get(c"runner")?;
    let persisted = ctx.get(c"persisted")?;
    let raw = ctx.get(c"raw")?;
    let cs = ctx.get(c"cs")?;
    let snapshot = |key: &CStr| -> Result<L<'_>> {
        if runner.optional(key)?.truthy()? && object(runner.get(key)?)? {
            runner.get(key)
        } else {
            fields(ctx, &[])
        }
    };
    let pa = snapshot(c"providerAttempt")?;
    let usage = snapshot(c"usageAttribution")?;
    let cli = first(
        ctx,
        &[
            (pa, c"cli"),
            (usage, c"cli"),
            (persisted, c"cli"),
            (cs, c"cli"),
            (raw, c"provider"),
        ],
        text(ctx, "unknown")?,
    )?;
    let cli = otherwise(call(cli, c"toLowerCase", &[])?, text(ctx, "unknown")?)?;
    let provider = otherwise(
        first(
            ctx,
            &[
                (pa, c"providerId"),
                (usage, c"providerId"),
                (persisted, c"provider"),
                (raw, c"providerId"),
            ],
            text(ctx, "_default_")?,
        )?,
        text(ctx, "_default_")?,
    )?;
    let name = first(
        ctx,
        &[
            (pa, c"providerName"),
            (usage, c"providerName"),
            (persisted, c"providerName"),
            (raw, c"providerName"),
        ],
        undef(ctx)?,
    )?;
    let id = fields(
        ctx,
        &[
            ("cli", cli),
            ("providerId", provider),
            (
                "providerName",
                otherwise(
                    name,
                    if provider.is_string("_default_")? {
                        cli
                    } else {
                        provider
                    },
                )?,
            ),
        ],
    )?;
    let string_id = |key: &CStr| -> Result<L<'_>> {
        otherwise(
            first(ctx, &[(pa, key), (usage, key), (raw, key)], undef(ctx)?)?,
            null(ctx)?,
        )
    };
    for key in [c"turnId", c"decisionId", c"runtimeEpoch", c"routeAttemptId"] {
        id.set(key, string_id(key)?)?;
    }
    for key in [c"routeGeneration", c"attemptNo"] {
        let mut value = pa.optional(key)?;
        if value.nullish()? {
            value = usage.optional(key)?;
        }
        if value.nullish()? {
            value = raw.optional(key)?;
        }
        let n = value.explicit_number()?;
        id.set(
            key,
            if n > 0. && n <= 9_007_199_254_740_991. && n.fract() == 0. {
                num(ctx, n)?
            } else {
                null(ctx)?
            },
        )?;
    }
    id.set(c"providerRevision", string_id(c"providerRevision")?)?;
    freeze(id)
}
pub(super) const ROUTE_KEYS: [&CStr; 7] = [
    c"runtimeEpoch",
    c"turnId",
    c"decisionId",
    c"routeAttemptId",
    c"routeGeneration",
    c"attemptNo",
    c"providerRevision",
];
pub(super) fn complete(id: L<'_>) -> Result<bool> {
    for key in ROUTE_KEYS {
        if key != c"turnId" && !id.get(key)?.truthy()? {
            return Ok(false);
        }
    }
    Ok(true)
}
pub(super) fn idempotency<'a>(ctx: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let turn = otherwise(
        ctx.get(c"turn")?.optional(c"turnId")?,
        ctx.get(c"sessionName")?,
    )?;
    let colon = text(ctx, ":")?;
    let mut key = call(
        string(turn)?,
        c"concat",
        &[colon, string(ctx.get(c"attempt")?)?, colon, id.get(c"cli")?],
    )?;
    let route = id.get(c"routeAttemptId")?;
    if route.truthy()? {
        key = call(
            key,
            c"concat",
            &[
                colon,
                otherwise(id.get(c"runtimeEpoch")?, text(ctx, "_runtime_")?)?,
                colon,
                route,
            ],
        )?;
    }
    Ok(key)
}
