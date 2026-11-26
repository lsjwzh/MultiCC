//! napi wrappers for Auto Provider price shaping.
//!
//! The shaping decisions and the price ladder live in
//! `multicc_core::auto_provider_pricing`. The one thing that cannot move is the
//! table storage itself: the table is `src/pricing/price-table.js`, a live
//! in-memory index that hands out frozen entry objects. The native facade
//! invokes its lookup method while retaining V8 exceptions and getter order.
//! The shared JSON interfaces remain available:
//!
//!   1. [`auto_provider_pricing_models`] says which models this pool's
//!      expansion will price;
//!   2. the native facade looks those models up and encodes the entries;
//!   3. [`auto_provider_expand_candidates`] prices, expands, orders and caps.
//!
//! [`auto_provider_price_of`] is the same post-processing for a single model,
//! and [`RustPriceLadder`] owns one turn's ladder so `tierOf` never has to
//! restate the price list in JavaScript.

use multicc_core::auto_provider_pricing as kernel;
use multicc_core::js::serde::{to_serde, truthy};
use multicc_core::js::JsValue as V;
use napi::{
    bindgen_prelude::{JsValue as _, Unknown},
    Env, Result,
};
use napi_derive::napi;
use serde_json::Value;

fn read(env: Env, value: Unknown<'_>) -> Result<V> {
    unsafe { crate::js_bridge::read_value(env.raw(), value.raw(), 0, &mut Vec::new()) }
}

/// The JS value as ordinary JSON data. `undefined` arrives as `null`, which is
/// what every field read here treats it as.
fn data(env: Env, value: Unknown<'_>) -> Result<Value> {
    Ok(to_serde(&read(env, value)?))
}

fn reason(error: String) -> napi::Error {
    napi::Error::from_reason(error)
}

fn json(value: &Value) -> Result<String> {
    serde_json::to_string(value).map_err(|error| reason(error.to_string()))
}

fn list(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
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
    let entry = data(env, entry)?;
    match kernel::price_of_entry(Some(&entry)) {
        Some(price) => json(&price),
        None => Ok("null".to_string()),
    }
}

#[napi]
pub fn auto_provider_model_choices(env: Env, provider: Unknown<'_>) -> Result<String> {
    let provider = data(env, provider)?;
    let choices = kernel::model_choices(Some(&provider)).map_err(reason)?;
    json(&Value::Array(
        choices.into_iter().map(Value::String).collect(),
    ))
}

/// The models the napi edge must price for this pool, in visit order.
#[napi]
pub fn auto_provider_pricing_models(env: Env, candidates: Unknown<'_>) -> Result<String> {
    let candidates = data(env, candidates)?;
    let models = kernel::pricing_models(&list(&candidates)).map_err(reason)?;
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
    let request = data(env, request)?;
    let candidates = request.get("candidates").map(list).unwrap_or_default();
    let entries = request
        .get("entries")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let require_price = request.get("requirePrice").is_none_or(truthy);
    let table = kernel::MapTable::new(entries);
    let expanded =
        kernel::expand_candidates(&candidates, Some(&table), require_price).map_err(reason)?;
    let expanded: Vec<Value> = expanded
        .into_iter()
        .map(|item| item.unwrap_or(Value::Null))
        .collect();
    json(&Value::Array(expanded))
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
        let candidates = data(env, candidates)?;
        Ok(Self {
            state: kernel::price_ladder(&list(&candidates)),
        })
    }

    #[napi(getter)]
    pub fn tiers(&self) -> Vec<String> {
        self.state.tiers.clone()
    }

    #[napi]
    pub fn tier_of(&self, env: Env, candidate: Unknown<'_>) -> Result<Option<String>> {
        let candidate = data(env, candidate)?;
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

fn pricing_json<'a>(api: L<'a>, name: &std::ffi::CStr, args: &[L<'a>]) -> Result<L<'a>> {
    let result = call(api.get(c"native")?, name, args)?;
    call(api.global()?.get(c"JSON")?, c"parse", &[result])
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
pub fn auto_provider_pricing_api(env: Env, native: Unknown<'_>) -> Result<sys::napi_value> {
    let native = L::new(&env, native);
    let api = fields(native, &[("native", native)])?;
    api.set(
        c"wire",
        method(&env, api, "wire", 1, 1, |s, a| pricing_wire(a[0], s))?,
    )?;
    api.set(
        c"expandedItem",
        method(&env, api, "", 1, 1, |s, a| {
            if a[0].kind()? == sys::ValueType::napi_null {
                s.from_value(&V::Undefined)
            } else {
                a[0].freeze()
            }
        })?,
    )?;
    let defaults = pricing_json(api, c"autoProviderPricingDefaults", &[])?;
    let out = fields(
        api,
        &[
            ("MAX_PRICE_TIERS", property(defaults, c"maxPriceTiers")?),
            ("MAX_VARIANTS", property(defaults, c"maxVariants")?),
            (
                "MAX_VARIANTS_PER_PROVIDER",
                property(defaults, c"maxVariantsPerProvider")?,
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
            let entry = if entry.nullish()? { null(s)? } else { entry };
            let answer = pricing_json(s, c"autoProviderPriceOf", &[entry])?;
            if answer.nullish()? {
                null(s)
            } else {
                answer.freeze()
            }
        })?,
    )?;
    out.set(
        c"modelChoices",
        method(&env, api, "modelChoices", 1, 1, |s, a| {
            let value = if a[0].nullish()? { null(s)? } else { a[0] };
            pricing_json(s, c"autoProviderModelChoices", &[value])
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
            let models = pricing_json(s, c"autoProviderPricingModels", &[candidates])?;
            let entries = fields(s, &[])?;
            if table.truthy()?
                && property(table, c"lookup")?.kind()? == sys::ValueType::napi_function
            {
                models.for_each(|model| {
                    let entry = pricing_lookup(table, model)?;
                    if entry.truthy()? {
                        entries.set_key(model, pricing_wire(entry, s)?)?;
                    }
                    Ok(())
                })?;
            }
            let request = fields(
                s,
                &[
                    ("candidates", candidates),
                    ("entries", entries),
                    ("requirePrice", required),
                ],
            )?;
            let expanded = pricing_json(s, c"autoProviderExpandCandidates", &[request])?;
            call(expanded, c"map", &[s.get(c"expandedItem")?])
        })?,
    )?;
    out.set(
        c"priceLadder",
        method(&env, api, "priceLadder", 1, 1, |s, a| {
            if !call(s.global()?.get(c"Array")?, c"isArray", &[a[0]])?.truthy()? {
                return Err(s.type_error("candidates is not iterable"));
            }
            let ladder = property(s.get(c"native")?, c"RustPriceLadder")?.construct(&[a[0]])?;
            let tiers = property(ladder, c"tiers")?.freeze()?;
            let owner = fields(s, &[("ladder", ladder)])?;
            let env = Env::from_raw(s.env());
            let tier = method(&env, owner, "tierOf", 1, 1, |owner, a| {
                let candidate = if a[0].nullish()? { null(owner)? } else { a[0] };
                call(owner.get(c"ladder")?, c"tierOf", &[candidate])
            })?;
            let tier = L::from_raw(s.env(), tier.raw());
            fields(s, &[("tiers", tiers), ("tierOf", tier)])?.freeze()
        })?,
    )?;
    Ok(out.raw())
}
