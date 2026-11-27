//! Jev's SDK surface uses live V8 strings and objects so injected transports,
//! callbacks and UTF-16 request text stay in the caller's isolate.
use crate::host_api::*;
use multicc_core::provider_misc as routing;
use napi_derive::napi;
use std::ffi::CStr;

mod answers;
mod transport;

const DEFAULT_TIMEOUT: f64 = 2500.;
const MIN_TIMEOUT: f64 = 250.;
const MAX_TIMEOUT: f64 = 10000.;
const MAX_TIERS: usize = 6;

fn slice(v: L<'_>, limit: f64) -> Result<L<'_>> {
    call(v, c"slice", &[num(v, 0.)?, num(v, limit)?])
}
fn coalesce<'a>(v: L<'a>, fallback: L<'a>) -> Result<L<'a>> {
    Ok(if v.nullish()? { fallback } else { v })
}
fn option_num(p: L<'_>, n: Option<f64>) -> Result<L<'_>> {
    match n {
        Some(n) => num(p, n),
        None => null(p),
    }
}
fn first<'a>(p: L<'a>, values: &[L<'a>]) -> Result<L<'a>> {
    for &v in values {
        if !v.nullish()? && !v.is_string("")? {
            return Ok(v);
        }
    }
    null(p)
}
fn number_or_none(v: L<'_>) -> Result<Option<f64>> {
    if v.nullish()? || v.is_string("")? {
        return Ok(None);
    }
    let n = v.explicit_number()?;
    Ok(n.is_finite().then_some(n))
}
fn ratio(v: L<'_>) -> Result<Option<f64>> {
    Ok(number_or_none(v)?.map(|n| n.clamp(0., 1.).max(0.)))
}
fn normalize(raw: L<'_>) -> Result<L<'_>> {
    let out = array(raw)?;
    let mut keys = std::collections::HashSet::new();
    if raw.is_array()? {
        raw.for_each_while(|item| {
            let is_object = object(item)?;
            let source = if is_object {
                item.get(c"key")?
            } else {
                fallback(item, "".into())?
            };
            let key = call(string(source)?, c"trim", &[])?;
            let name = key.coerce_string()?.to_string_lossy();
            if name.is_empty()
                || name.len() > 24
                || !name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
                || !keys.insert(name)
            {
                return Ok(true);
            }
            let label = if is_object && item.get(c"label")?.truthy()? {
                item.get(c"label")?
            } else {
                key
            };
            let row = fields(raw, &[("key", key), ("label", slice(string(label)?, 48.)?)])?;
            call(out, c"push", &[row.freeze()?])?;
            Ok(keys.len() < MAX_TIERS)
        })?;
    }
    out.freeze()
}

fn tier_index(tiers: L<'_>, key: L<'_>) -> Result<Option<usize>> {
    let clean = call(
        call(string(fallback(key, "".into())?)?, c"trim", &[])?,
        c"toLowerCase",
        &[],
    )?;
    if !clean.truthy()? {
        return Ok(None);
    }
    let mut i = 0;
    while (i as f64) < tiers.get(c"length")?.explicit_number()? {
        if call(tiers.element(i as u32)?.get(c"key")?, c"toLowerCase", &[])?.equals(clean)? {
            return Ok(Some(i));
        }
        i += 1;
    }
    Ok(None)
}
fn band<'a>(index: L<'a>, count: L<'a>) -> Result<L<'a>> {
    if count.explicit_number()? <= 1. {
        return num(index, 0.);
    }
    let top = (routing::TIER_BANDS.len() - 1) as f64;
    let denominator = count.number()? - 1.;
    let scaled = index.number()? / denominator * top;
    let math = index.global()?.get(c"Math")?;
    call(
        math,
        c"min",
        &[
            num(index, top)?,
            call(math, c"round", &[num(index, scaled)?])?,
        ],
    )
}
fn questions<'a>(p: L<'a>, tiers: L<'a>) -> Result<L<'a>> {
    let criteria = fields(p, &[])?;
    let levels = array(p)?;
    let state = fields(
        p,
        &[
            ("criteria", criteria),
            ("levels", levels),
            ("tiers", tiers),
            ("bands", p.get(c"bands")?),
        ],
    )?;
    let append = function(state, "addLevel", 2, 2, |s, a| {
        let index = band(a[1], s.get(c"tiers")?.get(c"length")?)?;
        let level = s.get(c"bands")?.get_key(index)?;
        s.get(c"criteria")?.set_key(a[0].get(c"key")?, level)?;
        call(s.get(c"levels")?, c"push", &[level])?;
        undef(s)
    })?;
    call(tiers, c"forEach", &[append])?;
    let question = |kind, instructions, entries| {
        fields(
            p,
            &[
                ("type", text(p, kind)?),
                ("instructions", text(p, instructions)?),
                ("criteria", entries),
            ],
        )
    };
    fields(
        p,
        &[
            (
                "tier",
                question("choice", routing::CHOICE_INSTRUCTIONS, criteria)?,
            ),
            (
                "complexity",
                question("score", routing::SCORE_INSTRUCTIONS, levels)?,
            ),
        ],
    )
}

#[napi]
pub fn jev_client_api(env: Env, fetch: Unknown<'_>) -> Result<sys::napi_value> {
    let fetch = L::new(&env, fetch);
    let facts = routing::routing_facts();
    let fact = |key: &str| text(fetch, facts[key].as_str().expect("routing string"));
    let gateways = fields(fetch, &[])?;
    let names = array(fetch)?;
    for row in facts["gateways"].as_array().expect("routing gateways") {
        let value = |k: &str| text(fetch, row[k].as_str().expect("gateway value"));
        let name = value("name")?;
        let gateway = fields(
            fetch,
            &[
                ("endpoint", value("endpoint")?),
                ("model", value("model")?),
                ("apiKeyName", value("apiKeyName")?),
            ],
        )?
        .freeze()?;
        gateways.define_key(name, gateway)?;
        call(names, c"push", &[name])?;
    }
    let default_gateway = fact("defaultGateway")?;
    let gateway = gateways.get_key(default_gateway)?;
    let bands = array(fetch)?;
    for label in routing::TIER_BANDS {
        call(bands, c"push", &[text(fetch, label)?])?;
    }
    bands.freeze()?;
    let max_endpoint = num(
        fetch,
        facts["maxEndpointChars"].as_f64().expect("endpoint limit"),
    )?;
    let defaults = fields(
        fetch,
        &[
            ("minConfidence", num(fetch, 0.5)?),
            ("minTierProbability", num(fetch, 0.5)?),
        ],
    )?
    .freeze()?;
    let owner = fields(
        fetch,
        &[
            ("fetch", fetch),
            ("endpoint", gateway.get(c"endpoint")?),
            ("model", gateway.get(c"model")?),
            ("bands", bands),
            ("maxEndpoint", max_endpoint),
            ("escalation", defaults),
        ],
    )?;
    let api = fields(
        fetch,
        &[
            ("CUSTOM_API_KEY_NAME", fact("customApiKeyName")?),
            ("CUSTOM_GATEWAY", fact("customGateway")?),
            ("CUSTOM_MODEL", fact("customModel")?),
            ("DEFAULT_ENDPOINT", owner.get(c"endpoint")?),
            ("DEFAULT_ESCALATION", defaults),
            ("DEFAULT_GATEWAY", default_gateway),
            ("DEFAULT_MODEL", owner.get(c"model")?),
            ("DEFAULT_TIMEOUT_MS", num(fetch, DEFAULT_TIMEOUT)?),
            ("GATEWAY_NAMES", names.freeze()?),
            ("JEV_GATEWAYS", gateways.freeze()?),
            ("MAX_ENDPOINT_CHARS", max_endpoint),
            ("MAX_TIMEOUT_MS", num(fetch, MAX_TIMEOUT)?),
            ("MIN_TIMEOUT_MS", num(fetch, MIN_TIMEOUT)?),
            ("MAX_TIERS", num(fetch, MAX_TIERS as f64)?),
            ("TIER_BANDS", bands),
        ],
    )?;
    api.spread_from(defaulted_methods(
        owner,
        &[
            ("bandForTier", 2, 2, |_, a| band(a[0], a[1])),
            ("buildQuestions", 1, 1, |p, a| questions(p, a[0])),
            ("createJevClient", 0, 1, transport::create),
            ("escalationPolicy", 3, 3, |_, a| {
                answers::verdict(a[0].get(c"tiers")?, a[0].get(c"escalation")?, a[1], a[2])
            }),
            ("normalizeTiers", 1, 1, |_, a| normalize(a[0])),
            ("readAnswers", 1, 1, |_, a| answers::read(a[0])),
            ("readConfidence", 2, 2, |p, a| {
                option_num(p, answers::confidence(a[0], a[1])?)
            }),
            ("tierIndex", 2, 2, |p, a| {
                num(p, tier_index(a[0], a[1])?.map_or(-1., |i| i as f64))
            }),
        ],
    )?)?;
    Ok(api.raw())
}
