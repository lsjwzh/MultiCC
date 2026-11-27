use super::*;

fn identity(target: L<'_>) -> Result<L<'_>> {
    let id = rules::target_identity(
        &string_or_empty(target.get(c"relayUrl")?)?,
        &string_or_empty(target.get(c"apiKey")?)?,
    );
    text(target, &id)
}
fn result<'a>(s: L<'a>, ok: bool, skipped: bool, reason: Option<&str>) -> Result<L<'a>> {
    let out = fields(s, &[("ok", flag(s, ok)?), ("skipped", flag(s, skipped)?)])?;
    if let Some(r) = reason {
        out.set(c"reason", text(s, r)?)?;
    }
    out.set(c"appType", s.get(c"appType")?)?;
    out.set(c"providerId", s.get(c"id")?)?;
    Ok(out)
}
fn clock(ctx: L<'_>) -> Result<L<'_>> {
    ctx.get(c"clock")?.call_plain(&[])
}
fn remember(s: L<'_>, ok: bool) -> Result<()> {
    let ctx = s.get(c"ctx")?;
    let entry = fields(
        s,
        &[
            ("at", clock(ctx)?),
            ("ok", flag(s, ok)?),
            ("targetIdentity", s.get(c"identity")?),
        ],
    )?;
    call(ctx.get(c"attempts")?, c"set", &[s.get(c"key")?, entry])?;
    Ok(())
}
pub(super) fn sync<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(ctx, || {
        let (kind, id, options) = (a[0], a[1], opts(a[2])?);
        let key = text(ctx, &format!("{}:{}", fold_string(kind)?, fold_string(id)?))?;
        let state = fields(
            ctx,
            &[
                ("ctx", ctx),
                ("key", key),
                ("appType", kind),
                ("id", id),
                ("options", options),
            ],
        )?;
        let providers = ctx.get(c"providers")?;
        let target = call(providers, c"getProviderLimitTarget", &[kind, id])?;
        if !target.optional(c"strategy")?.is_string("relay-quota")? {
            return result(state, false, true, Some("not_relay"));
        }
        let hash = identity(target)?;
        state.set(c"identity", hash)?;
        if !options.get(c"force")?.is_true()? {
            let last = call(ctx.get(c"attempts")?, c"get", &[key])?;
            if last.truthy()? && last.get(c"targetIdentity")?.equals(hash)? {
                let interval = if last.get(c"ok")?.truthy()? {
                    c"syncInterval"
                } else {
                    c"retryInterval"
                };
                if !(clock(ctx)?.explicit_number()? - last.get(c"at")?.explicit_number()?
                    >= ctx.get(interval)?.number()?)
                {
                    return result(state, true, true, Some("fresh"));
                }
            }
        }
        let inflight = ctx.get(c"inflight")?;
        let active = call(inflight, c"get", &[key])?;
        if active.truthy()? {
            let promise = active.get(c"promise")?;
            if active.get(c"targetIdentity")?.equals(hash)? {
                return Ok(promise);
            }
            return then(promise, state, |s, _| {
                sync(
                    s.get(c"ctx")?,
                    &mut [s.get(c"appType")?, s.get(c"id")?, s.get(c"options")?],
                )
            });
        }
        let transfer = super::transfer::pull(ctx, target, kind)?;
        let persisted = then(transfer, state, publish)?;
        let handled = recover(persisted, state, failed)?;
        let promise = call(
            handled,
            c"finally",
            &[function(state, "forgetTransfer", 0, 0, |s, _| {
                call(
                    s.get(c"ctx")?.get(c"inflight")?,
                    c"delete",
                    &[s.get(c"key")?],
                )?;
                undef(s)
            })?],
        )?;
        call(
            inflight,
            c"set",
            &[
                key,
                fields(state, &[("targetIdentity", hash), ("promise", promise)])?,
            ],
        )?;
        Ok(promise)
    })
}
fn publish<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let ctx = s.get(c"ctx")?;
    let providers = ctx.get(c"providers")?;
    let (kind, id) = (s.get(c"appType")?, s.get(c"id")?);
    let current = call(providers, c"getProviderLimitTarget", &[kind, id])?;
    if !current.optional(c"strategy")?.is_string("relay-quota")?
        || !identity(current)?.equals(s.get(c"identity")?)?
    {
        return result(s, true, true, Some("relay_changed"));
    }
    let catalog = a[0];
    let updated = call(
        providers,
        c"updateProviderRelayModelCatalog",
        &[kind, id, catalog],
    )?;
    remember(s, true)?;
    let out = result(s, true, false, None)?;
    out.set(c"changed", flag(s, updated.get(c"changed")?.is_true()?)?)?;
    out.set(
        c"model",
        or(updated.get(c"model")?, catalog.get(c"preferredModel")?)?,
    )?;
    out.set(c"models", catalog.get(c"models")?)?;
    out.set(c"revision", catalog.get(c"revision")?)?;
    let at = updated.get(c"syncedAt")?;
    out.set(c"syncedAt", if at.truthy()? { at } else { clock(ctx)? })?;
    Ok(out)
}
fn failed<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    remember(s, false)?;
    let code = string_or_empty(a[0].optional(c"code")?)?;
    let reason = rules::failure_reason(&code);
    let logger = s.get(c"ctx")?.get(c"logger")?;
    if callable(logger.optional(c"warn")?)? {
        let meta = fields(
            s,
            &[
                ("appType", s.get(c"appType")?),
                ("providerId", s.get(c"id")?),
                ("reason", text(s, reason)?),
            ],
        )?;
        call(
            logger,
            c"warn",
            &[text(s, "[multicc] relay model catalog sync failed")?, meta],
        )?;
    }
    result(s, false, false, Some(reason))
}
pub(super) fn refresh<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(ctx, || {
        let filter = opts(a[0])?;
        let kind = filter.get(c"appType")?;
        let kind = if kind.is_string("claude")? || kind.is_string("codex")? {
            kind
        } else {
            undef(ctx)?
        };
        let cli = call(
            string(fallback(filter.get(c"cli")?, V::from(""))?)?,
            c"trim",
            &[],
        )?;
        let providers = ctx.get(c"providers")?;
        let all = call(providers, c"listProviders", &[kind])?;
        let visible = array(ctx)?;
        all.for_each(|p| {
            if !cli.truthy()?
                || !callable(providers.get(c"providerSupportsCli")?)?
                || call(providers, c"providerSupportsCli", &[p, cli])?.truthy()?
            {
                call(visible, c"push", &[p])?;
            }
            Ok(())
        })?;
        let candidates = array(ctx)?;
        visible.for_each(|p| {
            let t = call(
                providers,
                c"getProviderLimitTarget",
                &[p.get(c"appType")?, p.get(c"id")?],
            )?;
            if t.optional(c"strategy")?.is_string("relay-quota")? {
                call(candidates, c"push", &[p])?;
            }
            Ok(())
        })?;
        let pending = array(ctx)?;
        candidates.for_each(|p| {
            let force = fields(p, &[("force", flag(p, filter.get(c"force")?.is_true()?)?)])?;
            let one = sync(ctx, &mut [p.get(c"appType")?, p.get(c"id")?, force])?;
            call(pending, c"push", &[one])?;
            Ok(())
        })?;
        then(
            call(ctx.global()?.get(c"Promise")?, c"all", &[pending])?,
            ctx,
            |ctx, a| {
                let mut updated = 0;
                let mut failed = 0;
                a[0].for_each(|r| {
                    let ok = r.get(c"ok")?.truthy()?;
                    if ok && r.get(c"changed")?.truthy()? {
                        updated += 1;
                    }
                    if !ok && !r.get(c"skipped")?.truthy()? {
                        failed += 1;
                    }
                    Ok(())
                })?;
                fields(
                    ctx,
                    &[
                        ("checked", a[0].get(c"length")?),
                        ("updated", num(ctx, updated as f64)?),
                        ("failed", num(ctx, failed as f64)?),
                        ("results", a[0]),
                    ],
                )
            },
        )
    })
}
