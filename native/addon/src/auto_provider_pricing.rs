//! 自动供应商定价直接调用 `multicc_core::auto_provider_pricing`。
//! 查价回调读取宿主持有的实时价格表。旧版 JSON 接口与价格阶梯类仍供兼容调用方使用。

use multicc_core::auto_provider_pricing as kernel;
use multicc_core::js::serde::{from_serde, to_serde, truthy};
use multicc_core::js::JsValue as V;
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
    Env, Result,
};
use napi_derive::napi;
use serde_json::Value;

/// 和兼容接口共用同一套 V8 输入转换，保留 getter 的读取顺序。
fn data(value: L<'_>) -> Result<Value> {
    let value =
        unsafe { crate::js_bridge::read_value(value.env(), value.raw(), 0, &mut Vec::new()) }?;
    Ok(to_serde(&value))
}

fn reason(error: String) -> napi::Error {
    napi::Error::from_reason(error)
}

fn json(value: &Value) -> Result<String> {
    serde_json::to_string(value).map_err(|error| reason(error.to_string()))
}

fn list(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}

/// The shaping constants, so JavaScript never restates them.
#[napi]
pub fn auto_provider_pricing_defaults() -> Result<String> {
    Ok(format!(
        "{{\"maxPriceTiers\":{},\"maxVariants\":{},\"maxVariantsPerProvider\":{}}}",
        kernel::MAX_PRICE_TIERS,
        kernel::MAX_VARIANTS,
        kernel::MAX_VARIANTS_PER_PROVIDER
    ))
}

/// `priceOf` after the table lookup: the entry in, the price (or `null`) out.
#[napi]
pub fn auto_provider_price_of(env: Env, entry: Unknown<'_>) -> Result<String> {
    let entry = data(L::new(&env, entry))?;
    match kernel::price_of_entry(Some(&entry)) {
        Some(price) => json(&price),
        None => Ok("null".to_string()),
    }
}

#[napi]
pub fn auto_provider_model_choices(env: Env, provider: Unknown<'_>) -> Result<String> {
    let provider = data(L::new(&env, provider))?;
    let choices = kernel::model_choices(Some(&provider)).map_err(reason)?;
    json(&Value::Array(
        choices.into_iter().map(Value::String).collect(),
    ))
}

/// The models the napi edge must price for this pool, in visit order.
#[napi]
pub fn auto_provider_pricing_models(env: Env, candidates: Unknown<'_>) -> Result<String> {
    let candidates = data(L::new(&env, candidates))?;
    let models = kernel::pricing_models(list(&candidates)).map_err(reason)?;
    json(&Value::Array(
        models.into_iter().map(Value::String).collect(),
    ))
}

/// `expandCandidates(candidates, { priceTable: entries, requirePrice })`.
///
/// `entries` maps each model from [`auto_provider_pricing_models`] to its price
/// table entry. The `null` slots a spread can leave behind become `undefined`
/// on the JavaScript side.
#[napi]
pub fn auto_provider_expand_candidates(env: Env, request: Unknown<'_>) -> Result<String> {
    let request = data(L::new(&env, request))?;
    let expanded = expand_request(&request)?;
    json(&Value::Array(
        expanded
            .into_iter()
            .map(Option::unwrap_or_default)
            .collect(),
    ))
}

fn expand_request(request: &Value) -> Result<Vec<Option<Value>>> {
    let candidates = request.get("candidates").map(list).unwrap_or_default();
    let entries = request
        .get("entries")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let table = kernel::MapTable::new(entries);
    kernel::expand_candidates(
        candidates,
        Some(&table),
        request.get("requirePrice").is_none_or(truthy),
    )
    .map_err(reason)
}

/// One turn's ladder: `tiers` plus `tierOf(candidate)`, over the price order
/// computed once in the kernel.
#[napi]
pub struct RustPriceLadder {
    state: kernel::Ladder,
}

#[napi]
impl RustPriceLadder {
    #[napi(constructor)]
    pub fn new(env: Env, candidates: Unknown<'_>) -> Result<Self> {
        let candidates = data(L::new(&env, candidates))?;
        Ok(Self {
            state: kernel::price_ladder(list(&candidates)),
        })
    }

    #[napi(getter)]
    pub fn tiers(&self) -> Vec<String> {
        self.state.tiers.clone()
    }

    #[napi]
    pub fn tier_of(&self, env: Env, candidate: Unknown<'_>) -> Result<Option<String>> {
        let candidate = data(L::new(&env, candidate))?;
        Ok(self.state.tier_of(Some(&candidate)))
    }
}

// Live facade for the compatibility host. The table stays in V8; traversal,
// lookup failure policy, non-finite encoding and result ownership live here.
use crate::{host_methods::method, js_iteration::read as property, route_response::*};

fn pricing_wire<'a>(value: L<'a>, api: L<'a>) -> Result<L<'a>> {
    if value.kind()? == sys::ValueType::napi_number {
        return if call(value.global()?.get(c"Number")?, c"isFinite", &[value])?.truthy()? {
            Ok(value)
        } else {
            string(value)
        };
    }
    if !value.truthy()? || value.kind()? != sys::ValueType::napi_object {
        return Ok(value);
    }
    if call(value.global()?.get(c"Array")?, c"isArray", &[value])?.truthy()? {
        return call(value, c"map", &[api.get(c"wire")?]);
    }
    let out = fields(api, &[])?;
    call(value.global()?.get(c"Object")?, c"keys", &[value])?
        .for_each(|key| out.set_key(key, pricing_wire(value.get_key(key)?, api)?))?;
    Ok(out)
}

fn strings(values: Vec<String>) -> V {
    V::Array(values.into_iter().map(V::from).collect())
}

fn pricing_lookup<'a>(table: L<'a>, model: L<'a>) -> Result<L<'a>> {
    Ok(table
        .catch(|| {
            // The method is read before String(model), just like table.lookup(...).
            let lookup = property(table, c"lookup")?;
            crate::js_iteration::call(lookup, table, &[string(model)?])
        })?
        .unwrap_or(null(table)?))
}

#[napi]
pub fn auto_provider_pricing_api(env: Env) -> Result<sys::napi_value> {
    let api = fields(L::new(&env, ().into_unknown(&env)?), &[])?;
    api.set(
        c"wire",
        method(&env, api, "wire", 1, 1, |s, a| pricing_wire(a[0], s))?,
    )?;
    let out = fields(
        api,
        &[
            ("MAX_PRICE_TIERS", num(api, kernel::MAX_PRICE_TIERS as f64)?),
            ("MAX_VARIANTS", num(api, kernel::MAX_VARIANTS as f64)?),
            (
                "MAX_VARIANTS_PER_PROVIDER",
                num(api, kernel::MAX_VARIANTS_PER_PROVIDER as f64)?,
            ),
            ("expandCandidates", api.from_value(&V::Undefined)?),
            ("modelChoices", api.from_value(&V::Undefined)?),
            ("priceLadder", api.from_value(&V::Undefined)?),
            ("priceOf", api.from_value(&V::Undefined)?),
        ],
    )?;
    out.set(
        c"priceOf",
        method(&env, api, "priceOf", 2, 2, |s, a| {
            let table = a[0];
            let model = a[1];
            if !table.truthy()?
                || property(table, c"lookup")?.kind()? != sys::ValueType::napi_function
                || !model.truthy()?
            {
                return null(s);
            }
            let entry = pricing_wire(pricing_lookup(table, model)?, s)?;
            match kernel::price_of_entry(Some(&data(entry)?)) {
                Some(price) => s.from_value(&from_serde(&price))?.freeze(),
                None => null(s),
            }
        })?,
    )?;
    out.set(
        c"modelChoices",
        method(&env, api, "modelChoices", 1, 1, |s, a| {
            let choices = kernel::model_choices(Some(&data(a[0])?)).map_err(reason)?;
            s.from_value(&strings(choices))
        })?,
    )?;
    out.set(
        c"expandCandidates",
        method(&env, api, "expandCandidates", 1, 2, |s, a| {
            let options = if a[1].undefined()? {
                fields(s, &[])?
            } else {
                a[1]
            };
            let table = property(options, c"priceTable")?;
            let table = if table.undefined()? { null(s)? } else { table };
            let required = property(options, c"requirePrice")?;
            let required = if required.undefined()? {
                flag(s, true)?
            } else {
                required
            };
            let candidates = a[0];
            if !call(s.global()?.get(c"Array")?, c"isArray", &[candidates])?.truthy()? {
                return Err(s.type_error("candidates is not iterable"));
            }
            let models = kernel::pricing_models(list(&data(candidates)?)).map_err(reason)?;
            let entries = fields(s, &[])?;
            if table.truthy()?
                && property(table, c"lookup")?.kind()? == sys::ValueType::napi_function
            {
                for model in models {
                    let model = text(s, &model)?;
                    let entry = pricing_lookup(table, model)?;
                    if entry.truthy()? {
                        entries.set_key(model, pricing_wire(entry, s)?)?;
                    }
                }
            }
            // lookup 可以修改候选项；展开前按原顺序重新读取。
            let request = fields(
                s,
                &[
                    ("candidates", candidates),
                    ("entries", entries),
                    ("requirePrice", required),
                ],
            )?;
            let expanded = expand_request(&data(request)?)?;
            let out = s.from_value(&V::Array(vec![]))?;
            for (i, item) in expanded.iter().enumerate() {
                let item = match item {
                    Some(value) => s.from_value(&from_serde(value))?.freeze()?,
                    None => s.from_value(&V::Undefined)?,
                };
                out.define_key(text(s, &i.to_string())?, item)?;
            }
            Ok(out)
        })?,
    )?;
    out.set(
        c"priceLadder",
        method(&env, api, "priceLadder", 1, 1, |s, a| {
            if !call(s.global()?.get(c"Array")?, c"isArray", &[a[0]])?.truthy()? {
                return Err(s.type_error("candidates is not iterable"));
            }
            let ladder = kernel::price_ladder(list(&data(a[0])?));
            let tiers = s.from_value(&strings(ladder.tiers.clone()))?.freeze()?;
            let env = Env::from_raw(s.env());
            let tier = method(&env, s, "tierOf", 1, 1, move |s, a| {
                match ladder.tier_of(Some(&data(a[0])?)) {
                    Some(tier) => text(s, &tier),
                    None => null(s),
                }
            })?;
            let tier = L::from_raw(s.env(), tier.raw());
            fields(s, &[("tiers", tiers), ("tierOf", tier)])?.freeze()
        })?,
    )?;
    Ok(out.raw())
}
