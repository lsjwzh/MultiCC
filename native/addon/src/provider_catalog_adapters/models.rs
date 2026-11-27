use super::*;
const TTL: f64 = 3_600_000.;
const FAILURE_TTL: f64 = 60_000.;
const TIMEOUT: f64 = 3_000.;
const MAX_MODELS: f64 = 1000.;

fn regex_replace<'a>(v: L<'a>, pattern: &str) -> Result<L<'a>> {
    let rx = v
        .global()?
        .get(c"RegExp")?
        .construct(&[text(v, pattern)?])?;
    call(v, c"replace", &[rx, text(v, "")?])
}
fn endpoint(v: L<'_>) -> Result<L<'_>> {
    if v.kind()? != sys::ValueType::napi_string {
        return null(v);
    }
    let base = regex_replace(call(v, c"trim", &[])?, r"/+$")?;
    if !base.truthy()? {
        return null(v);
    }
    let suffix = call(base, c"slice", &[num(v, -7.)?])?;
    if call(suffix, c"toLowerCase", &[])?.is_string("/models")? {
        return Ok(base);
    }
    concat(base, &[base, text(base, "/models")?])
}
fn last_of<'a>(v: L<'a>, keys: &[&CStr]) -> Result<L<'a>> {
    let mut val = undef(v)?;
    for key in keys {
        val = v.get(key)?;
        if val.truthy()? {
            break;
        }
    }
    Ok(val)
}
fn push<'a>(out: L<'a>, seen: L<'a>, model: L<'a>, label: L<'a>) -> Result<()> {
    let id = model.clean_text()?;
    let raw = id.coerce_string()?;
    let units = raw.as_units();
    if units.is_empty()
        || units.len() > 200
        || units.iter().any(|&c| c <= 0x1f || c == 0x7f)
        || call(seen, c"has", &[id])?.truthy()?
    {
        return Ok(());
    }
    call(seen, c"add", &[id])?;
    let label = label.clean_text()?;
    let label = if label.truthy()? && !label.equals(id)? {
        label
    } else {
        id
    };
    let row = fields(out, &[("model", id), ("label", label)])?.freeze()?;
    call(out, c"push", &[row])?;
    Ok(())
}
fn payload(p: L<'_>) -> Result<L<'_>> {
    let rows = if p.is_array()? {
        p
    } else if p.truthy()? && p.get(c"data")?.is_array()? {
        p.get(c"data")?
    } else if p.truthy()? && p.get(c"models")?.is_array()? {
        p.get(c"models")?
    } else {
        array(p)?
    };
    let out = array(p)?;
    let seen = set_new(p)?;
    rows.for_each_while(|row| {
        if row.kind()? == sys::ValueType::napi_string {
            push(out, seen, row, row)?;
        } else if row.truthy()? && object(row)? {
            let model = last_of(row, &[c"model", c"id", c"slug"])?;
            let label = last_of(row, &[c"display_name", c"displayName", c"name", c"label"])?;
            push(out, seen, model, label)?;
        }
        Ok(out.get(c"length")?.number()? < MAX_MODELS)
    })?;
    Ok(out)
}
fn static_models(summary: L<'_>) -> Result<L<'_>> {
    let first = if summary.truthy()? {
        summary.get(c"model")?
    } else {
        summary
    };
    let all = array(summary)?;
    all.set_element(0, first)?;
    if summary.truthy()? && summary.get(c"modelOptions")?.is_array()? {
        summary.get(c"modelOptions")?.for_each(|v| {
            call(all, c"push", &[v])?;
            Ok(())
        })?;
    }
    let out = array(summary)?;
    let seen = set_new(summary)?;
    all.for_each_while(|v| {
        push(out, seen, v, v)?;
        Ok(out.get(c"length")?.number()? < MAX_MODELS)
    })?;
    Ok(out)
}
fn result(body: L<'_>, code: f64) -> Result<L<'_>> {
    fields(body, &[("status", num(body, code)?), ("body", body)])
}
fn fallback_result(summary: L<'_>) -> Result<L<'_>> {
    let body = fields(
        summary,
        &[
            ("models", static_models(summary)?.freeze()?),
            ("source", text(summary, "fallback")?),
        ],
    )?
    .freeze()?;
    result(body, 200.)
}
fn live(models: L<'_>, cached: bool) -> Result<L<'_>> {
    result(
        fields(
            models,
            &[
                ("models", models),
                ("source", text(models, "live")?),
                ("cached", flag(models, cached)?),
            ],
        )?,
        200.,
    )
}
fn headers<'a>(summary: L<'a>, key: L<'a>) -> Result<L<'a>> {
    let p = summary;
    let format = truthy_field(summary, &[c"apiFormat", c"protocol"], text(p, "")?)?;
    let format = call(string(format)?, c"toLowerCase", &[])?;
    let anthropic = format.is_string("anthropic")?
        || format.is_string("anthropic_messages")?
        || format.is_string("messages")?;
    let out = fields(p, &[("accept", text(p, "application/json")?)])?;
    if key.truthy()? {
        if anthropic {
            out.set(c"x-api-key", key)?;
        }
        out.set(c"authorization", concat(p, &[text(p, "Bearer ")?, key])?)?;
    }
    if anthropic {
        out.set(c"anthropic-version", text(p, "2023-06-01")?)?;
    }
    Ok(out)
}
fn request<'a>(op: L<'a>, key: L<'a>) -> Result<L<'a>> {
    let global = op.global()?;
    let headers = headers(op.get(c"summary")?, key)?;
    let ctor = global.get(c"AbortController")?;
    let c = if callable(ctor)? {
        ctor.construct(&[])?
    } else {
        null(op)?
    };
    let timer = if c.truthy()? {
        let abort = function(c, "", 0, 0, |c, _| call(c, c"abort", &[]))?;
        let timer = global
            .get(c"setTimeout")?
            .call_plain(&[abort, op.get(c"timeout")?])?;
        if timer.truthy()? && callable(timer.get(c"unref")?)? {
            call(timer, c"unref", &[])?;
        }
        timer
    } else {
        null(op)?
    };
    let job = async_result(op, || {
        let opts = fields(
            op,
            &[
                ("method", text(op, "GET")?),
                ("headers", headers),
                ("signal", c.optional(c"signal")?),
            ],
        )?;
        op.get(c"owner")?
            .get(c"fetch")?
            .call_plain(&[op.get(c"endpoint")?, opts])
    })?;
    let received = then(job, op, |_, a| {
        // Preserve the numeric status probe even for responses with an injected getter.
        if a[0].truthy()? {
            a[0].get(c"status")?.explicit_number()?;
        }
        Ok(a[0])
    })?;
    if timer.truthy()? {
        return call(
            received,
            c"finally",
            &[function(timer, "", 0, 0, |timer, _| {
                timer.global()?.get(c"clearTimeout")?.call_plain(&[timer])
            })?],
        );
    }
    Ok(received)
}
fn fetch(op: L<'_>) -> Result<L<'_>> {
    let summary = op.get(c"summary")?;
    let mut dest = endpoint(summary.get(c"baseUrl")?)?;
    if dest.truthy()? && op.get(c"relay")?.truthy()? {
        dest = concat(op, &[dest, text(op, "?refresh=1")?])?;
    }
    let owner = op.get(c"owner")?;
    if !dest.truthy()? || !callable(owner.get(c"fetch")?)? {
        return array(op);
    }
    op.set(c"endpoint", dest)?;
    let response = then(request(op, op.get(c"key")?)?, op, |op, a| {
        let res = a[0];
        if op.get(c"key")?.truthy()?
            && res.truthy()?
            && (res.get(c"status")?.explicit_number()? == 401.
                || res.get(c"status")?.explicit_number()? == 403.)
        {
            return request(op, text(op, "")?);
        }
        Ok(res)
    })?;
    then(response, op, |op, a| {
        let res = a[0];
        if !res.truthy()? || !res.get(c"ok")?.truthy()? {
            return array(op);
        }
        then(call(res, c"json", &[])?, op, |_, a| payload(a[0]))
    })
}
fn list<'a>(p: L<'a>, id: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let id = id.clean_text()?;
    let providers = p.get(c"providers")?;
    let provider = if id.truthy()? {
        p.catch(|| call(providers, c"getProvider", &[undef(p)?, id]))?
            .unwrap_or(null(p)?)
    } else {
        null(p)?
    };
    if !provider.truthy()? {
        return result(
            fields(p, &[("error", text(p, "provider not found")?)])?,
            404.,
        );
    }
    let summary = p
        .catch(|| call(providers, c"summarize", &[provider]))?
        .unwrap_or(null(p)?);
    if !summary.truthy()? {
        return fallback_result(null(p)?);
    }
    if !summary.get(c"baseUrl")?.truthy()?
        || summary.get(c"isOfficial")?.is_true()?
        || provider.get(c"virtual")?.truthy()?
    {
        return fallback_result(summary);
    }
    let refresh = default_object(opts)?.get(c"refresh")?.is_true()?;
    let cache = p.get(c"cache")?;
    let failures = p.get(c"failures")?;
    let cached = call(cache, c"get", &[id])?;
    if !refresh
        && cached.truthy()?
        && cached.get(c"baseUrl")?.equals(summary.get(c"baseUrl")?)?
        && now(p)?.number()? - cached.get(c"at")?.number()? < p.get(c"ttl")?.number()?
        && cached.get(c"models")?.get(c"length")?.truthy()?
    {
        return live(cached.get(c"models")?, true);
    }
    let last = call(failures, c"get", &[id])?;
    if !refresh
        && last.truthy()?
        && now(p)?.number()? - last.number()? < p.get(c"failureTtl")?.number()?
    {
        return fallback_result(summary);
    }
    let mut relay = false;
    if refresh && provider.get(c"appType")?.is_string("codex")? {
        relay = p
            .catch(|| {
                let target = call(
                    providers,
                    c"getProviderLimitTarget",
                    &[provider.get(c"appType")?, provider.get(c"id")?],
                )?;
                if !target.optional(c"strategy")?.is_string("relay-quota")? {
                    return Ok(false);
                }
                let trim = |v| regex_replace(string(fallback(v, V::from(""))?)?, r"/+$");
                trim(target.get(c"relayUrl")?)?.equals(trim(summary.get(c"baseUrl")?)?)
            })?
            .unwrap_or(false);
    }
    let key = p
        .catch(|| {
            fallback(
                call(
                    providers,
                    c"getRelayImportToken",
                    &[provider.get(c"appType")?, provider.get(c"id")?],
                )?,
                V::from(""),
            )
        })?
        .unwrap_or(text(p, "")?);
    let op = fields(
        p,
        &[
            ("owner", p),
            ("summary", summary),
            ("id", id),
            ("key", key),
            ("relay", flag(p, relay)?),
            (
                "timeout",
                if relay {
                    num(p, 18_000.)?
                } else {
                    p.get(c"timeout")?
                },
            ),
        ],
    )?;
    let pulled = async_result(op, || fetch(op))?;
    let models = recover(pulled, op, |p, _| array(p))?;
    then(models, op, |op, a| {
        let p = op.get(c"owner")?;
        let id = op.get(c"id")?;
        let summary = op.get(c"summary")?;
        let models = a[0];
        if models.get(c"length")?.truthy()? {
            let cached = fields(
                p,
                &[
                    ("at", now(p)?),
                    ("baseUrl", summary.get(c"baseUrl")?),
                    ("models", models),
                ],
            )?;
            call(p.get(c"cache")?, c"set", &[id, cached])?;
            call(p.get(c"failures")?, c"delete", &[id])?;
            live(models, false)
        } else {
            call(p.get(c"failures")?, c"set", &[id, now(p)?])?;
            fallback_result(summary)
        }
    })
}
fn numopt<'a>(options: L<'a>, key: &CStr, value: f64) -> Result<L<'a>> {
    let n = options.get(key)?.explicit_number()?;
    num(options, if n == 0. || n.is_nan() { value } else { n })
}
fn runtime<'a>(ports: L<'a>, opt: L<'a>) -> Result<L<'a>> {
    let opt = default_object(opt)?;
    let providers = opt.get(c"providers")?;
    let providers = if providers.truthy()? {
        providers
    } else {
        call(ports, c"providers", &[])?
    };
    let fetch = if opt.has(c"fetch")? {
        opt.get(c"fetch")?
    } else {
        opt.global()?.get(c"fetch")?
    };
    let clock = if callable(opt.get(c"now")?)? {
        opt.get(c"now")?
    } else {
        opt.global()?.get(c"Date")?.get(c"now")?
    };
    let map = opt.global()?.get(c"Map")?;
    let p = fields(
        opt,
        &[
            ("providers", providers),
            ("fetch", fetch),
            ("now", clock),
            ("ttl", numopt(opt, c"ttlMs", TTL)?),
            ("failureTtl", numopt(opt, c"failureTtlMs", FAILURE_TTL)?),
            ("timeout", numopt(opt, c"timeoutMs", TIMEOUT)?),
            ("cache", map.construct(&[])?),
            ("failures", map.construct(&[])?),
        ],
    )?;
    fields(
        p,
        &[
            (
                "listProviderModels",
                function(p, "listProviderModels", 1, 2, |p, a| {
                    async_result(p, || list(p, a[0], a[1]))
                })?,
            ),
            (
                "_resetForTest",
                function(p, "_resetForTest", 0, 0, |p, _| {
                    call(p.get(c"cache")?, c"clear", &[])?;
                    call(p.get(c"failures")?, c"clear", &[])?;
                    undef(p)
                })?,
            ),
        ],
    )?
    .freeze()
}
pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    fields(
        p,
        &[
            (
                "createProviderModelsRuntime",
                function(p, "createProviderModelsRuntime", 0, 1, |p, a| {
                    runtime(p, a[0])
                })?,
            ),
            (
                "getSharedProviderModelsRuntime",
                function(p, "getSharedProviderModelsRuntime", 0, 0, |p, _| {
                    let active = p.get(c"shared")?;
                    if active.truthy()? {
                        return Ok(active);
                    }
                    let v = runtime(p, undef(p)?)?;
                    p.set(c"shared", v)?;
                    Ok(v)
                })?,
            ),
            (
                "modelsEndpointFor",
                function(p, "modelsEndpointFor", 1, 1, |_, a| endpoint(a[0]))?,
            ),
            (
                "modelsFromPayload",
                function(p, "modelsFromPayload", 1, 1, |_, a| payload(a[0]))?,
            ),
            (
                "staticModels",
                function(p, "staticModels", 1, 1, |_, a| static_models(a[0]))?,
            ),
            ("PROVIDER_MODELS_TTL_MS", num(p, TTL)?),
        ],
    )
}
