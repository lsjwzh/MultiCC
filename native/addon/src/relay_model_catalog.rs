//! Account snapshots and cache coordination around the host's live provider store.
use crate::host_api::*;
use multicc_core::relay_model_catalog as rules;
use napi_derive::napi;
use std::ffi::CStr;
mod sync;
mod transfer;

fn or<'a>(v: L<'a>, fallback: L<'a>) -> Result<L<'a>> {
    Ok(if v.truthy()? { v } else { fallback })
}
fn string_or_empty(v: L<'_>) -> Result<String> {
    fold_string(fallback(v, V::from(""))?)
}
fn opts(v: L<'_>) -> Result<L<'_>> {
    default_object(v)
}
fn normalize(v: L<'_>) -> Result<L<'_>> {
    let mut models = Vec::new();
    if v.is_array()? {
        v.for_each_while(|raw| {
            rules::push_model(&mut models, &string_or_empty(raw)?);
            Ok(models.len() < rules::MAX_MODELS)
        })?;
    }
    v.from_value(&V::Array(models.into_iter().map(V::from).collect()))
}
fn revision<'a>(preferred: L<'a>, models: L<'a>) -> Result<L<'a>> {
    let obj = fields(
        preferred,
        &[
            ("preferredModel", string(fallback(preferred, V::from(""))?)?),
            ("models", models),
        ],
    )?;
    let json = fold_string(json_call(obj, c"stringify", obj)?)?;
    text(obj, &rules::revision(json.as_bytes()))
}
fn coded<'a>(p: L<'a>, code: &str) -> Result<L<'a>> {
    let e = error_value(p, code)?;
    e.set(c"code", text(p, code)?)?;
    Ok(e)
}
fn duration<'a>(o: L<'a>, name: &CStr, default: u32) -> Result<L<'a>> {
    fallback(
        num(o, o.get(name)?.explicit_number()?)?,
        V::Number(default as f64),
    )
}
fn create<'a>(ports: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let o = opts(args[0])?;
    let providers = o.get(c"providers")?;
    for k in [
        c"getProviderSummary",
        c"getProviderLimitTarget",
        c"listProviders",
        c"updateProviderRelayModelCatalog",
    ] {
        if !callable(providers.optional(k)?)? {
            return Err(
                o.type_error("relay model catalog runtime requires provider catalog operations")
            );
        }
    }
    let global = o.global()?;
    let clock = o.get(c"now")?;
    let map = global.get(c"Map")?;
    let ctx = fields(
        o,
        &[
            ("providers", providers),
            ("ports", ports),
            (
                "clock",
                if callable(clock)? {
                    clock
                } else {
                    global.get(c"Date")?.get(c"now")?
                },
            ),
            ("fetch", or(o.get(c"fetch")?, ports.get(c"outboundFetch")?)?),
            ("logger", or(o.get(c"logger")?, global.get(c"console")?)?),
            ("codex", o.get(c"codexModelsRuntime")?),
            (
                "syncInterval",
                duration(o, c"syncIntervalMs", rules::SYNC_INTERVAL)?,
            ),
            (
                "retryInterval",
                duration(o, c"retryIntervalMs", rules::RETRY_INTERVAL)?,
            ),
            ("timeout", duration(o, c"timeoutMs", rules::TIMEOUT)?),
            ("attempts", map.construct(&[])?),
            ("inflight", map.construct(&[])?),
        ],
    )?;
    fields(
        ctx,
        &[
            (
                "sourceCatalogFacts",
                function(ctx, "sourceCatalogFacts", 2, 3, facts)?,
            ),
            (
                "syncProvider",
                function(ctx, "syncProvider", 2, 3, sync::sync)?,
            ),
            (
                "refreshDue",
                function(ctx, "refreshDue", 0, 1, sync::refresh)?,
            ),
        ],
    )?
    .freeze()
}
fn facts<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(ctx, || {
        let (kind, id, options) = (a[0], a[1], opts(a[2])?);
        let providers = ctx.get(c"providers")?;
        let summary = call(providers, c"getProviderSummary", &[kind, id])?;
        let out = fields(
            ctx,
            &[
                ("summary", or(summary, null(ctx)?)?),
                ("catalog", null(ctx)?),
            ],
        )?;
        let runtime = ctx.get(c"codex")?;
        if !kind.is_string("codex")?
            || !summary.optional(c"isOfficial")?.is_true()?
            || !runtime.truthy()?
        {
            return Ok(out);
        }
        // Snapshot failures on the account runtime are intentionally isolated.
        let load = ctx.catch(|| {
            let record = if callable(providers.get(c"getProvider")?)? {
                call(providers, c"getProvider", &[kind, id])?
            } else {
                summary
            };
            let account = record.optional(c"activeAccountId")?;
            let managed = record.truthy()?
                && ((account.truthy()? && !account.is_string("global")?)
                    || ctx
                        .get(c"ports")?
                        .get(c"officialAccountId")?
                        .call_plain(&[record])?
                        .truthy()?);
            let state = fields(
                ctx,
                &[
                    ("record", record),
                    ("runtime", runtime),
                    ("out", out),
                    ("managed", flag(ctx, managed)?),
                ],
            )?;
            if options.get(c"refresh")?.is_true()? && callable(runtime.get(c"refreshProvider")?)? {
                let result = async_result(ctx, || {
                    call(
                        runtime,
                        c"refreshProvider",
                        &[record, fields(ctx, &[("refresh", flag(ctx, true)?)])?],
                    )
                })?;
                let complete = recover(result, ctx, |ctx, _| undef(ctx))?;
                then(complete, state, |s, _| peek(s))
            } else {
                peek(state)
            }
        })?;
        Ok(load.unwrap_or(out))
    })
}
fn peek(state: L<'_>) -> Result<L<'_>> {
    let out = state.get(c"out")?;
    state.catch(|| {
        let rt = state.get(c"runtime")?;
        let catalog = if callable(rt.get(c"peekProvider")?)? {
            call(rt, c"peekProvider", &[state.get(c"record")?])?
        } else if !state.get(c"managed")?.truthy()? && callable(rt.get(c"peek")?)? {
            call(rt, c"peek", &[])?
        } else {
            null(state)?
        };
        out.assign(c"catalog", catalog)
    })?;
    Ok(out)
}

#[napi]
pub fn relay_model_catalog_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = methods(
        p,
        &[
            ("normalizeModels", 1, |_, a| normalize(a[0])),
            ("catalogRevision", 2, |_, a| revision(a[0], a[1])),
        ],
    )?;
    api.set(
        c"createProviderRelayModelCatalogRuntime",
        function(p, "createProviderRelayModelCatalogRuntime", 0, 1, create)?,
    )?;
    for (name, value) in [
        (c"MAX_MODELS", rules::MAX_MODELS as u32),
        (c"DEFAULT_SYNC_INTERVAL_MS", rules::SYNC_INTERVAL),
        (c"DEFAULT_RETRY_INTERVAL_MS", rules::RETRY_INTERVAL),
        (c"DEFAULT_TIMEOUT_MS", rules::TIMEOUT),
    ] {
        api.set(name, num(p, value.into())?)?;
    }
    let routes = array(p)?;
    for (kind, path) in [
        ("claude", "/claude-proxy/:id/remote/models"),
        ("codex", "/codex-proxy/:id/models"),
    ] {
        call(
            routes,
            c"push",
            &[fields(
                p,
                &[("appType", text(p, kind)?), ("path", text(p, path)?)],
            )?],
        )?;
    }
    api.set(c"RELAY_MODEL_ROUTES", routes.freeze()?)?;
    Ok(api.raw())
}
