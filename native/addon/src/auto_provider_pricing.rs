//! napi wrappers for Auto Provider price shaping.
//!
//! The shaping decisions and the price ladder live in
//! `multicc_core::auto_provider_pricing`. The one thing that cannot move is the
//! table lookup itself: the table is `src/pricing/price-table.js`, a live
//! in-memory index that hands out frozen entry objects. So the split is
//!
//!   1. [`auto_provider_pricing_models`] says which models this pool's
//!      expansion will price;
//!   2. JavaScript looks those models up and passes the entries back;
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
