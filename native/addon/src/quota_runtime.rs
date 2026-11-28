//! Wire the quota owners once and expose the same live handles to all host
//! consumers. In particular, the history callback precedes cache creation.
use crate::{
    host_methods::{async_result, default_object, function},
    route_response::*,
};
use napi_derive::napi;

#[napi]
pub fn provider_quota_runtime(
    env: Env,
    opts: Unknown<'_>,
    ports: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let opts = L::new(&env, opts);
    let paths = opts.get(c"paths")?;
    let sessions = opts.get(c"persistedSessions")?;
    let providers = opts.get(c"providers")?;
    let db = paths.get(c"providerLimitDbFile")?;
    let history = call(
        p,
        c"history",
        &[fields(
            p,
            &[("file", paths.get(c"providerQuotaHistoryDbFile")?)],
        )?],
    )?;
    let on_record = function(history, "onRecord", 1, 1, |h, a| call(h, c"recordEntry", a))?;
    let cache = call(
        p,
        c"limitCache",
        &[fields(
            p,
            &[
                ("file", db),
                ("legacyJsonFile", paths.get(c"providerLimitCacheFile")?),
                ("onRecord", on_record),
            ],
        )?],
    )?;
    let args = fields(
        p,
        &[
            ("cache", cache),
            ("persistedSessions", sessions),
            ("providers", providers),
        ],
    )?;
    let recorder = call(p, c"recorder", &[args])?;
    let sync = crate::js_live::spread(args)?;
    sync.set(c"broadcast", opts.get(c"broadcast")?)?;
    call(p, c"connect", &[sync])?;
    let bars = call(
        p,
        c"barCache",
        &[fields(p, &[("file", paths.get(c"quotaBarCacheFile")?)])?],
    )?;
    let guard = call(
        p,
        c"guard",
        &[fields(
            p,
            &[
                ("cache", cache),
                ("configFile", paths.get(c"quotaGuardFile")?),
                ("logger", opts.get(c"logger")?),
            ],
        )?],
    )?;
    call(p, c"subscriptions", &[fields(p, &[("file", db)])?])?;
    call(
        p,
        c"virtualProvider",
        &[fields(
            p,
            &[
                ("cache", cache),
                ("guard", guard),
                ("recordDto", recorder.get(c"recordDto")?),
            ],
        )?],
    )?;
    Ok(fields(
        p,
        &[
            ("providerQuotaHistory", history),
            ("providerLimitCache", cache),
            ("limitRecorder", recorder),
            ("quotaBarCache", bars),
            ("quotaGuard", guard),
        ],
    )?
    .raw())
}
fn wire_auth<'a>(p: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let state = fields(p, &[("opts", opts), ("ports", p)])?;
    let handler = function(state, "refresh", 0, 1, |s, a| {
        let opts = s.get(c"opts")?;
        let request = default_object(a[0])?;
        let attempt = async_result(s, || {
            let auth = request.get(c"authFile")?;
            let refresher = if !auth.truthy()?
                || auth.equals(call(s.get(c"ports")?, c"defaultCodexAuth", &[])?)?
            {
                opts.get(c"codexOAuthRefresh")?
            } else {
                let supervisor = opts.get(c"codexAccountRefresh")?;
                call(supervisor, c"sync", &[])?;
                let accounts = opts.get(c"officialAccounts")?;
                let list = call(accounts, c"listCodexAccounts", &[])?;
                let mut selected = None;
                if list.truthy()? {
                    list.for_each_while(|account| {
                        if call(accounts, c"codexAuthFile", &[account.get(c"id")?])?.equals(auth)? {
                            selected = Some(account);
                            Ok(false)
                        } else {
                            Ok(true)
                        }
                    })?;
                }
                let Some(account) = selected else {
                    return flag(s, false);
                };
                if account.get(c"cliCopy")?.truthy()? {
                    return flag(s, false);
                }
                call(
                    supervisor.get(c"refreshers")?,
                    c"get",
                    &[account.get(c"id")?],
                )?
            };
            if !refresher.truthy()? {
                return flag(s, false);
            }
            let output = call(
                refresher,
                c"refresh",
                &[fields(
                    s,
                    &[
                        ("reason", text(s, "codex-quota-401")?),
                        ("force", flag(s, true)?),
                    ],
                )?],
            )?;
            let promise = call(s.global()?.get(c"Promise")?, c"resolve", &[output])?;
            call(
                promise,
                c"then",
                &[function(s, "refreshed", 1, 1, |s, a| {
                    let outcome = a[0].optional(c"outcome")?;
                    flag(
                        s,
                        outcome.is_string("fresh")? || outcome.is_string("refreshed")?,
                    )
                })?],
            )
        })?;
        call(
            attempt,
            c"catch",
            &[function(s, "failed", 0, 0, |s, _| flag(s, false))?],
        )
    })?;
    call(p, c"setCodexAuthRefresher", &[handler])?;
    p.from_value(&V::Undefined)
}
#[napi]
pub fn quota_self_heal_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    Ok(fields(
        p,
        &[
            (
                "wireCodexAuthRefresher",
                function(p, "wireCodexAuthRefresher", 1, 1, |p, a| wire_auth(p, a[0]))?,
            ),
            (
                "wireQuotaSelfHeal",
                function(p, "wireQuotaSelfHeal", 1, 1, |p, a| {
                    let opts = a[0];
                    let cache = opts.get(c"providerLimitCache")?;
                    let recorder = opts.get(c"limitRecorder")?;
                    let args = crate::js_live::spread(opts.get(c"providers")?)?;
                    args.set(c"getPort", opts.get(c"getPort")?)?;
                    args.set(c"onResult", recorder.get(c"recordProvider")?)?;
                    args.set(
                        c"asyncLimitCache",
                        flag(p, cache.get(c"isAsync")?.is_true()?)?,
                    )?;
                    args.set(
                        c"lookupCached",
                        function(cache, "lookupCached", 2, 2, |c, a| call(c, c"get", a))?,
                    )?;
                    let mounted = opts
                        .get(c"mountProviderBalanceRoutes")?
                        .call_plain(&[opts.get(c"app")?, args])?;
                    let refresh = fallback(mounted.optional(c"refreshOne")?, V::Null)?;
                    call(
                        recorder,
                        c"setRefresher",
                        &[call(p, c"setVirtualRefresher", &[refresh])?],
                    )?;
                    let stale = if refresh.truthy()? {
                        function(refresh, "staleRefresh", 2, 2, |f, a| f.call_plain(a))?
                    } else {
                        null(p)?
                    };
                    call(opts.get(c"quotaGuard")?, c"setStaleRefresher", &[stale])?;
                    wire_auth(p, opts)
                })?,
            ),
        ],
    )?
    .raw())
}
