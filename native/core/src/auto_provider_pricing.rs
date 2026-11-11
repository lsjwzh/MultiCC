//! Auto Provider price shaping — the Rust half of `src/chat/auto-provider-pricing.js`.
//!
//! A price-tiered pool (`routing.tiering === 'price'`) has no hand-tagged
//! ladder. Each turn the runtime prices every candidate through the shared
//! price table, expands `autoModel` lines into one variant per model the
//! provider serves, and ranks the distinct prices into at most four tiers,
//! cheapest first.
//!
//! Everything here is pure: the table is an injected [`PriceTable`], the clock
//! is never read, and a missing or broken table degrades to "price unknown",
//! never to a thrown turn. Behaviour is frozen by
//! `native/core/tests/fixtures/auto-provider-pricing.json`, recorded from the
//! Node oracle before the migration (see `scripts/generate-auto-provider-fixtures.js`).
//!
//! One recorded quirk is intentional: once the 24-variant budget is spent,
//! `room` becomes 1 and [`spread`] divides by `limit - 1 == 0`, which produces
//! the `undefined` slot JavaScript pushed. [`expand_candidates`] models that as
//! `None`, and the fixture pins the 25-entry output.

use serde_json::{Map, Value};

use crate::js::js_trim;
use crate::js::serde::{js_string, js_to_number, number_value, truthy};

pub const MAX_PRICE_TIERS: usize = 4;
pub const MAX_VARIANTS: usize = 24;
pub const MAX_VARIANTS_PER_PROVIDER: usize = 6;

const MODEL_ID: &str = r"^[A-Za-z0-9._:/\[\]-]{1,100}$";
const PRICE_TIER_PREFIX: &str = "p";

/// The price table as the kernel needs it: one lookup per model, returning the
/// table's own entry object (`{ blended, input, output, model, source }`).
///
/// The napi edge supplies an implementation backed by
/// `src/pricing/price-table.js`; unit tests use [`MapTable`]. A lookup that
/// throws in JavaScript is the caller's business: the bridge maps it to a
/// missing entry, exactly like the old `try { ... } catch { entry = null }`.
pub trait PriceTable {
    fn lookup(&self, model: &str) -> Option<Value>;
}

/// A price table over a fixed map of blended prices, for tests and for callers
/// that already hold the shared table as JSON.
pub struct MapTable {
    entries: Map<String, Value>,
}

impl MapTable {
    /// `entries` maps model id to either a full entry object or a blended
    /// number (the shape `src/pricing/price-table.js` hands out).
    pub fn new(entries: Map<String, Value>) -> Self {
        Self { entries }
    }

    pub fn from_model_prices(pairs: &[(&str, f64)]) -> Self {
        let mut entries = Map::new();
        for (model, blended) in pairs {
            entries.insert(
                (*model).to_string(),
                Value::Object(blended_entry(*blended, Some(model))),
            );
        }
        Self { entries }
    }
}

impl PriceTable for MapTable {
    fn lookup(&self, model: &str) -> Option<Value> {
        self.entries.get(model).cloned().map(|entry| match entry {
            // A bare number stands for "this model costs this much".
            Value::Number(number) => Value::Object(blended_entry(
                number.as_f64().unwrap_or(f64::NAN),
                Some(model),
            )),
            other => other,
        })
    }
}

fn blended_entry(blended: f64, model: Option<&str>) -> Map<String, Value> {
    let mut entry = Map::new();
    entry.insert("blended".to_string(), number_value(blended));
    entry.insert("input".to_string(), number_value(blended / 2.0));
    entry.insert("output".to_string(), number_value(blended * 2.0));
    match model {
        Some(model) => {
            entry.insert("model".to_string(), Value::String(model.to_string()));
        }
        None => {
            entry.insert("model".to_string(), Value::Null);
        }
    }
    entry.insert("source".to_string(), Value::String("stub".to_string()));
    entry
}

fn member<'a>(entry: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    entry
        .and_then(Value::as_object)
        .and_then(|map| map.get(key))
}

fn number_or_nan(value: Option<&Value>) -> f64 {
    value.map(js_to_number).unwrap_or(f64::NAN)
}

/// `priceOf(priceTable, model)`.
///
/// A falsy model or a missing table yields no price. The table's `blended` must
/// be a finite, non-negative number; `input`/`output` are optional halves that
/// drop independently.
pub fn price_of(table: Option<&dyn PriceTable>, model: Option<&Value>) -> Option<Value> {
    let model = model.filter(|value| truthy(value))?;
    let table = table?;
    let text = js_string(model);
    price_of_entry(table.lookup(&text).as_ref())
}

/// `priceOf` once the table lookup has happened.
///
/// The napi edge performs the lookup in JavaScript (the table is the live
/// `src/pricing/price-table.js` index, and a throwing lookup is a miss), so the
/// entry crosses on its own. Everything the answer is made of is right here.
pub fn price_of_entry(entry: Option<&Value>) -> Option<Value> {
    let blended = number_or_nan(member(entry, "blended"));
    if !blended.is_finite() || blended < 0.0 {
        return None;
    }
    let half = |key: &str| {
        let value = number_or_nan(member(entry, key));
        if value.is_finite() {
            number_value(value)
        } else {
            Value::Null
        }
    };
    let or_null = |key: &str| match member(entry, key) {
        Some(value) if truthy(value) => value.clone(),
        _ => Value::Null,
    };
    let mut out = Map::new();
    out.insert("blended".to_string(), number_value(blended));
    out.insert("input".to_string(), half("input"));
    out.insert("output".to_string(), half("output"));
    out.insert("matched".to_string(), or_null("model"));
    out.insert("source".to_string(), or_null("source"));
    Some(Value::Object(out))
}

/// `modelChoices(provider)`: the provider's default model, its visible list and
/// the models behind its tier aliases, in the provider's own order, trimmed,
/// de-duplicated and restricted to plausible model ids.
///
/// Spreading `modelOptions` follows JavaScript: an array spreads its items and
/// a string spreads its UTF-16 code units. Any other non-nullish value is not
/// iterable and throws there, so it is an error here.
pub fn model_choices(provider: Option<&Value>) -> Result<Vec<String>, String> {
    let Some(provider) = provider.filter(|value| truthy(value)) else {
        return Ok(Vec::new());
    };
    if !provider.is_object() {
        return Ok(Vec::new());
    }
    let pattern = regex::Regex::new(MODEL_ID).map_err(|error| error.to_string())?;
    // `Object.values(aliasMap).map(entry => entry && entry.model)`: a falsy
    // entry is itself, so `''`/`0`/`false` still reach the trim below.
    let alias_models: Vec<Value> = match member(Some(provider), "aliasMap") {
        Some(Value::Object(aliases)) => aliases
            .values()
            .map(|alias| {
                if truthy(alias) {
                    member(Some(alias), "model").cloned().unwrap_or(Value::Null)
                } else {
                    alias.clone()
                }
            })
            .collect(),
        _ => Vec::new(),
    };
    let mut models: Vec<Value> = Vec::new();
    models.push(
        member(Some(provider), "model")
            .cloned()
            .unwrap_or(Value::Null),
    );
    match member(Some(provider), "modelOptions") {
        None | Some(Value::Null) => {}
        Some(Value::Array(items)) => models.extend(items.iter().cloned()),
        Some(Value::String(text)) => models.extend(
            text.encode_utf16()
                .map(|unit| Value::String(String::from_utf16_lossy(&[unit]))),
        ),
        Some(_) => return Err("provider.modelOptions is not iterable".to_string()),
    }
    models.extend(alias_models);
    let mut out: Vec<String> = Vec::new();
    for raw in models {
        let text = if raw.is_null() {
            String::new()
        } else {
            js_string(&raw)
        };
        let model = js_trim(&text).to_string();
        if !model.is_empty() && pattern.is_match(&model) && !out.contains(&model) {
            out.push(model);
        }
    }
    Ok(out)
}

/// Every model [`expand_candidates`] may price for this pool, in visit order
/// and de-duplicated: each line's own model plus, for an `autoModel` line,
/// every model its provider serves.
///
/// The napi edge prices exactly this list and hands the entries back, so the
/// decision of *what* to price stays here while the table access stays in
/// JavaScript. Missing, falsy and unpriced models are simply absent: `price_of`
/// answers `None` for them without a lookup.
pub fn pricing_models(candidates: &[Value]) -> Result<Vec<String>, String> {
    fn push_unique(out: &mut Vec<String>, model: String) {
        if !out.contains(&model) {
            out.push(model);
        }
    }
    let mut out: Vec<String> = Vec::new();
    for candidate in candidates {
        // Only a truthy model is ever priced (see `price_of`).
        if let Some(model) = member(Some(candidate), "model").filter(|value| truthy(value)) {
            push_unique(&mut out, js_string(model));
        }
        let auto_model = member(Some(candidate), "autoModel").is_some_and(truthy);
        let provider = member(Some(candidate), "provider").filter(|value| truthy(value));
        if auto_model && provider.is_some() {
            for model in model_choices(provider)? {
                push_unique(&mut out, model);
            }
        }
    }
    Ok(out)
}

/// Evenly spaced picks over a price-ordered list, keeping both ends: a ladder
/// built only from six near-free models cannot answer a hard request.
///
/// JavaScript's `Math.round(slot * (len - 1) / (limit - 1))` is reproduced
/// exactly, including the `0 / 0 = NaN` slot that `limit == 1` produces and the
/// `undefined` it indexes. A picked hole is only pushed once (`includes`).
pub fn spread(list: &[Option<Value>], limit: usize) -> Vec<Option<Value>> {
    if list.len() <= limit {
        return list.to_vec();
    }
    let mut picked: Vec<Option<Value>> = Vec::new();
    for slot in 0..limit {
        let numerator = slot as f64 * (list.len() as f64 - 1.0);
        let denominator = limit as f64 - 1.0;
        let at = js_round(numerator / denominator);
        let item = if at.is_nan() || at < 0.0 || at as usize >= list.len() {
            None
        } else {
            list[at as usize].clone()
        };
        // SameValueZero: two `undefined`s are the same pick.
        let already = match &item {
            None => picked.iter().any(Option::is_none),
            Some(value) => picked
                .iter()
                .any(|other| other.as_ref().is_some_and(|hit| hit == value)),
        };
        if !already {
            picked.push(item);
        }
    }
    picked
}

/// `Math.round`, which rounds halves toward positive infinity.
fn js_round(number: f64) -> f64 {
    if !number.is_finite() {
        return number;
    }
    (number + 0.5).floor()
}

fn blended_of(candidate: Option<&Value>) -> f64 {
    match candidate {
        Some(value) if truthy(value) => match member(Some(value), "price") {
            Some(price) if truthy(price) => number_or_nan(member(Some(price), "blended")),
            _ => f64::INFINITY,
        },
        _ => f64::INFINITY,
    }
}

fn by_js_number(left: f64, right: f64) -> std::cmp::Ordering {
    let difference = left - right;
    if difference.is_nan() || difference == 0.0 {
        std::cmp::Ordering::Equal
    } else if difference < 0.0 {
        std::cmp::Ordering::Less
    } else {
        std::cmp::Ordering::Greater
    }
}

fn by_price(left: &Option<Value>, right: &Option<Value>) -> std::cmp::Ordering {
    by_js_number(blended_of(left.as_ref()), blended_of(right.as_ref()))
}

fn with_price(candidate: &Value, price: Option<Value>) -> Result<Value, String> {
    let Value::Object(map) = candidate else {
        return Err("candidate must be an object".to_string());
    };
    let mut out = map.clone();
    out.insert("price".to_string(), price.unwrap_or(Value::Null));
    Ok(Value::Object(out))
}

/// `expandCandidates(candidates, { priceTable, requirePrice })`.
///
/// A priced variant keeps the candidate's `providerId` and `index`: attempts are
/// counted per route, so a quota failure retires every model of that route.
///
/// `require_price` is the difference between the two ladders. A price-tiered
/// pool can only route over models it can price, so an unpriceable variant is
/// dropped (and a route with none keeps its own default model). A manual pool
/// already has its hand-tagged tiers and wants every model, with an unknown
/// price ranking last through the same order.
///
/// The output mirrors JavaScript exactly, including the `None` slot the known
/// `room == 1` spread bug pushes.
pub fn expand_candidates(
    candidates: &[Value],
    table: Option<&dyn PriceTable>,
    require_price: bool,
) -> Result<Vec<Option<Value>>, String> {
    let mut out: Vec<Option<Value>> = Vec::new();
    let mut variants = 0usize;
    for candidate in candidates {
        let auto_model = member(Some(candidate), "autoModel").is_some_and(truthy);
        let provider = member(Some(candidate), "provider").filter(|value| truthy(value));
        if !auto_model || provider.is_none() {
            out.push(Some(with_price(
                candidate,
                price_of(table, member(Some(candidate), "model")),
            )?));
            continue;
        }
        let mut priced: Vec<Option<Value>> = Vec::new();
        for model in model_choices(provider)? {
            let variant_model = Value::String(model);
            let price = price_of(table, Some(&variant_model));
            if require_price && price.is_none() {
                continue;
            }
            let mut variant = with_price(candidate, price)?;
            if let Value::Object(map) = &mut variant {
                map.insert("model".to_string(), variant_model);
            }
            priced.push(Some(variant));
        }
        if priced.is_empty() {
            // Nothing to choose from: keep the route itself on its default
            // model rather than dropping a line the user put in the pool.
            out.push(Some(with_price(
                candidate,
                price_of(table, member(Some(candidate), "model")),
            )?));
            continue;
        }
        priced.sort_by(by_price);
        // `Math.max(1, Math.min(6, 24 - variants))`.
        let room = MAX_VARIANTS
            .saturating_sub(variants)
            .clamp(1, MAX_VARIANTS_PER_PROVIDER);
        for variant in spread(&priced, room) {
            out.push(variant);
            variants += 1;
        }
    }
    Ok(out)
}

/// The ladder of one turn. Unknown prices rank as the most expensive: a line we
/// cannot price is not assumed to be cheap enough for trivial work.
pub struct Ladder {
    pub tiers: Vec<String>,
    prices: Vec<f64>,
}

impl Ladder {
    /// The tier a candidate falls in, or `None` when the ladder has fewer than
    /// two distinct prices (or the candidate's price is not on it).
    pub fn tier_of(&self, candidate: Option<&Value>) -> Option<String> {
        if self.tiers.is_empty() {
            return None;
        }
        let blended = blended_of(candidate);
        // `indexOf` is strict equality: a NaN price sits on no tier.
        let at = self.prices.iter().position(|price| *price == blended)?;
        let index = (at * self.tiers.len()) / self.prices.len();
        self.tiers.get(index).cloned()
    }

    pub fn tier_count(&self) -> usize {
        self.tiers.len()
    }
}

/// `priceLadder(candidates)`: distinct prices of enabled candidates, cheapest
/// first, at most four tiers named `p1`..`p4`.
pub fn price_ladder(candidates: &[Value]) -> Ladder {
    let mut prices: Vec<f64> = Vec::new();
    for candidate in candidates {
        if member(Some(candidate), "enabled") == Some(&Value::Bool(false)) {
            continue;
        }
        let blended = blended_of(Some(candidate));
        // `new Set` is SameValueZero: NaN would collapse to one entry.
        let duplicate = prices.iter().any(|price| same_value_zero(*price, blended));
        if !duplicate {
            prices.push(blended);
        }
    }
    // `sort((left, right) => left - right)`: a NaN comparison is +0, so the
    // sort stays stable and a NaN keeps its place.
    prices.sort_by(|left, right| by_js_number(*left, *right));
    let count = MAX_PRICE_TIERS.min(prices.len());
    if count < 2 {
        return Ladder {
            tiers: Vec::new(),
            prices,
        };
    }
    let tiers = (0..count)
        .map(|at| format!("{PRICE_TIER_PREFIX}{}", at + 1))
        .collect();
    Ladder { tiers, prices }
}

fn same_value_zero(left: f64, right: f64) -> bool {
    if left.is_nan() || right.is_nan() {
        left.is_nan() && right.is_nan()
    } else {
        left == right
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/auto-provider-pricing.json"))
            .expect("pricing fixture")
    }

    /// The fixture records a few requests descriptively (`"null"`, `"{}"`),
    /// because JSON has no hole for a literal `null` argument.
    fn decode_provider(request: &Value) -> Option<Value> {
        match &request["provider"] {
            Value::String(text) if text == "null" => None,
            Value::String(text) if text == "{}" => Some(Value::Object(Map::new())),
            other => Some(other.clone()),
        }
    }

    #[test]
    fn model_choices_replays_the_frozen_fixture() {
        for case in fixture()["cases"].as_array().unwrap() {
            if case["op"] != json!("modelChoices") {
                continue;
            }
            let provider = decode_provider(&case["request"]);
            let got = model_choices(provider.as_ref())
                .unwrap_or_else(|error| panic!("{}: {error}", case["name"]));
            assert_eq!(
                serde_json::to_value(&got).unwrap(),
                case["expect"]["value"],
                "{}",
                case["name"]
            );
        }
    }

    /// `{ providerId, model, index, price }`, with a missing `model` kept as
    /// `undefined` the way the generator's `candidateView` does.
    fn candidate_view(item: &Option<Value>) -> Value {
        let Some(candidate) = item else {
            return serde_json::json!({ "$undefined": true });
        };
        let field = |key: &str| -> Value {
            match member(Some(candidate), key) {
                None => serde_json::json!({ "$undefined": true }),
                Some(value) => value.clone(),
            }
        };
        let price = match member(Some(candidate), "price") {
            Some(price) if truthy(price) => price.clone(),
            _ => Value::Null,
        };
        serde_json::json!({
            "providerId": field("providerId"),
            "model": field("model"),
            "index": match member(Some(candidate), "index") {
                None => Value::Null,
                Some(value) => value.clone(),
            },
            "price": price,
        })
    }

    #[test]
    fn price_of_replays_the_frozen_fixture() {
        for case in fixture()["cases"].as_array().unwrap() {
            if case["op"] != json!("priceOf") {
                continue;
            }
            let request = &case["request"];
            let model = request["model"].clone();
            let got = match &request["priceTable"] {
                // No table at all.
                Value::String(text) if text == "null" => price_of(None, Some(&model)),
                // `{}` and a throwing `lookup` are both a miss: the napi edge
                // turns a thrown lookup into "no entry".
                Value::String(_) => price_of(Some(&MapTable::new(Map::new())), Some(&model)),
                _ => {
                    let table = match (&request["lookup"], &request["entry"], &request["prices"]) {
                        (Value::String(_), _, _) => MapTable::new(Map::new()),
                        (_, Value::Object(_), _) => MapTable::new(Map::from_iter([(
                            js_string(&model),
                            request["entry"].clone(),
                        )])),
                        (_, _, Value::Object(prices)) => MapTable::new(prices.clone()),
                        _ => panic!("{}: undecodable priceOf request", case["name"]),
                    };
                    price_of(Some(&table), Some(&model))
                }
            };
            let got = match got {
                Some(price) => price,
                None => Value::Null,
            };
            assert_eq!(got, case["expect"]["value"], "{}", case["name"]);
        }
    }

    /// Rebuilds the generator's executed input from the descriptive request.
    fn decode_candidates(request: &Value) -> (Vec<Value>, MapTable, bool) {
        let require_price = request["requirePrice"] == json!(true);
        let prices = |models: &[String]| -> MapTable {
            let mut pairs: Vec<(String, f64)> = Vec::new();
            for (at, model) in models.iter().enumerate() {
                pairs.push((model.clone(), at as f64 + 1.0));
            }
            let pairs: Vec<(&str, f64)> = pairs
                .iter()
                .map(|(model, price)| (model.as_str(), *price))
                .collect();
            MapTable::from_model_prices(&pairs)
        };
        let models = |key: &str| -> Vec<String> {
            request[key]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .map(|item| item.as_str().unwrap().to_string())
                        .collect()
                })
                .unwrap_or_default()
        };
        if let Some(list) = request["candidates"].as_array() {
            let table = match request["prices"].as_object() {
                Some(map) => MapTable::new(map.clone()),
                None => MapTable::new(Map::new()),
            };
            return (list.clone(), table, require_price);
        }
        let mut candidates = Vec::new();
        let table;
        if let Some(count) = request["providerCount"].as_u64() {
            let per = request["modelsPerProvider"].as_u64().unwrap_or(0);
            let mut pairs: Vec<(String, f64)> = Vec::new();
            for provider in 0..count {
                let id = format!("p{provider}");
                let models: Vec<String> = (0..per).map(|at| format!("{id}-m{at}")).collect();
                for (at, model) in models.iter().enumerate() {
                    pairs.push((model.clone(), (provider * 100 + at as u64) as f64));
                }
                candidates.push(serde_json::json!({
                    "providerId": id,
                    "autoModel": true,
                    "provider": { "id": id, "model": models[0], "modelOptions": models },
                }));
            }
            let pairs: Vec<(&str, f64)> = pairs
                .iter()
                .map(|(model, price)| (model.as_str(), *price))
                .collect();
            table = MapTable::from_model_prices(&pairs);
        } else {
            let list = if request.get("providerModels").is_some() {
                models("providerModels")
            } else {
                models("autoModels")
            };
            let id = "p";
            candidates.push(serde_json::json!({
                "providerId": id,
                "autoModel": true,
                "provider": { "id": id, "model": list[0], "modelOptions": list },
            }));
            // `priced` is the autoModels spelling, `prices` the providerModels one.
            let given = request
                .get("prices")
                .or_else(|| request.get("priced"))
                .and_then(Value::as_object);
            table = match given {
                Some(map) => MapTable::new(map.clone()),
                None => prices(&list),
            };
        }
        (candidates, table, require_price)
    }

    #[test]
    fn expand_candidates_replays_the_frozen_fixture() {
        for case in fixture()["cases"].as_array().unwrap() {
            if case["op"] != json!("expandCandidates") {
                continue;
            }
            let request = &case["request"];
            let (candidates, table, require_price) = decode_candidates(request);
            let out = expand_candidates(&candidates, Some(&table), require_price)
                .unwrap_or_else(|error| panic!("{}: {error}", case["name"]));
            let expect = &case["expect"]["value"];
            let variants: Vec<Value> = out.iter().map(candidate_view).collect();
            if expect.get("length").is_some() {
                assert_eq!(out.len() as u64, expect["length"], "{}", case["name"]);
                assert_eq!(
                    Value::Array(variants),
                    expect["variants"],
                    "{}",
                    case["name"]
                );
            } else {
                assert_eq!(Value::Array(variants), *expect, "{}", case["name"]);
            }
        }
    }

    #[test]
    fn price_ladder_replays_the_frozen_fixture() {
        for case in fixture()["cases"].as_array().unwrap() {
            if case["op"] != json!("priceLadder") {
                continue;
            }
            let candidates = case["request"]["candidates"].as_array().unwrap().clone();
            let ladder = price_ladder(&candidates);
            let expect = &case["expect"]["value"];
            assert_eq!(
                serde_json::to_value(&ladder.tiers).unwrap(),
                expect["tiers"],
                "{}",
                case["name"]
            );
            if let Some(probes) = expect["tierOf"].as_array() {
                let got: Vec<Value> = candidates
                    .iter()
                    .map(|candidate| match ladder.tier_of(Some(candidate)) {
                        Some(tier) => Value::String(tier),
                        None => Value::Null,
                    })
                    .collect();
                assert_eq!(
                    Value::Array(got),
                    Value::Array(probes.clone()),
                    "{}",
                    case["name"]
                );
            }
            for key in ["tierOfNull", "tierOfUndefined"] {
                if expect.get(key).is_some() {
                    assert_eq!(
                        ladder.tier_of(None).map(Value::String),
                        Some(expect[key].clone()),
                        "{} ({key})",
                        case["name"]
                    );
                }
            }
        }
    }

    #[test]
    fn exported_constants_match_the_oracle() {
        for case in fixture()["cases"].as_array().unwrap() {
            if case["op"] != json!("exports") {
                continue;
            }
            let mut out = Map::new();
            out.insert("MAX_PRICE_TIERS".into(), json!(MAX_PRICE_TIERS));
            out.insert("MAX_VARIANTS".into(), json!(MAX_VARIANTS));
            out.insert(
                "MAX_VARIANTS_PER_PROVIDER".into(),
                json!(MAX_VARIANTS_PER_PROVIDER),
            );
            assert_eq!(Value::Object(out), case["expect"]["value"]);
        }
    }

    #[test]
    fn price_of_rejects_missing_tables_models_and_unusable_blends() {
        let table = MapTable::from_model_prices(&[("m", 3.0)]);
        assert!(price_of(None, Some(&json!("m"))).is_none());
        assert!(price_of(Some(&table), None).is_none());
        assert!(price_of(Some(&table), Some(&json!(""))).is_none());
        assert!(price_of(Some(&table), Some(&json!("missing"))).is_none());
        let negative = MapTable::new(Map::from_iter([("m".into(), json!({ "blended": -1 }))]));
        assert!(price_of(Some(&negative), Some(&json!("m"))).is_none());
        let free = MapTable::new(Map::from_iter([("m".into(), json!({ "blended": "free" }))]));
        assert!(price_of(Some(&free), Some(&json!("m"))).is_none());
    }

    #[test]
    fn price_of_keeps_the_entry_shape_and_key_order() {
        let table = MapTable::from_model_prices(&[("a/b", 3.0)]);
        let price = price_of(Some(&table), Some(&json!("a/b"))).unwrap();
        let keys: Vec<String> = price.as_object().unwrap().keys().cloned().collect();
        assert_eq!(
            keys,
            vec!["blended", "input", "output", "matched", "source"]
        );
        assert_eq!(
            price,
            json!({ "blended": 3, "input": 1.5, "output": 6, "matched": "a/b", "source": "stub" })
        );
        let partial = MapTable::new(Map::from_iter([(
            "m".into(),
            json!({ "blended": 2, "input": "x" }),
        )]));
        assert_eq!(
            price_of(Some(&partial), Some(&json!("m"))).unwrap(),
            json!({ "blended": 2, "input": null, "output": null, "matched": null, "source": null })
        );
        // Number('3') is a price; a numeric string blended is accepted.
        let text = MapTable::new(Map::from_iter([("m".into(), json!({ "blended": "3" }))]));
        assert_eq!(
            price_of(Some(&text), Some(&json!("m"))).unwrap()["blended"],
            json!(3)
        );
        // Zero is a price.
        let zero = MapTable::from_model_prices(&[("m", 0.0)]);
        assert!(price_of(Some(&zero), Some(&json!("m"))).is_some());
    }

    #[test]
    fn price_of_entry_answers_what_the_lookup_form_answers() {
        let table = MapTable::from_model_prices(&[("m", 3.0)]);
        assert_eq!(
            price_of_entry(table.lookup("m").as_ref()),
            price_of(Some(&table), Some(&json!("m")))
        );
        assert!(price_of_entry(None).is_none());
        assert!(price_of_entry(Some(&json!({}))).is_none());
        assert!(price_of_entry(Some(&json!({ "blended": "free" }))).is_none());
    }

    #[test]
    fn pricing_models_lists_exactly_what_expansion_prices() {
        let candidates = vec![
            json!({ "providerId": "p", "model": "plain" }),
            json!({
                "providerId": "r",
                "autoModel": true,
                "model": "r-m0",
                "provider": { "id": "r", "model": "r-m0", "modelOptions": ["r-m0", "r-m1", "plain"] },
            }),
            // No provider: the line is priced on its own model, which is absent.
            json!({ "providerId": "n", "autoModel": true }),
            // Nothing to choose from: no model is priced for this line either.
            json!({
                "providerId": "e",
                "autoModel": true,
                "provider": { "id": "e", "model": null, "modelOptions": [] },
            }),
            json!({ "providerId": "z", "model": "" }),
        ];
        assert_eq!(
            pricing_models(&candidates).unwrap(),
            vec!["plain", "r-m0", "r-m1"]
        );
        assert!(pricing_models(&[]).unwrap().is_empty());
        // The same input is rejected by both halves of the pair.
        let broken = vec![json!({ "autoModel": true, "provider": { "modelOptions": 5 } })];
        assert!(pricing_models(&broken).is_err());
        assert!(expand_candidates(&broken, None, true).is_err());
    }

    #[test]
    fn expand_candidates_caps_variants_and_spreads_evenly() {
        let models: Vec<String> = (1..=10).map(|at| format!("m{at}")).collect();
        let pairs: Vec<(&str, f64)> = models
            .iter()
            .enumerate()
            .map(|(at, model)| (model.as_str(), at as f64 + 1.0))
            .collect();
        let table = MapTable::from_model_prices(&pairs);
        let candidate = json!({
            "providerId": "p",
            "autoModel": true,
            "provider": { "id": "p", "model": "m1", "modelOptions": models },
        });
        let out = expand_candidates(&[candidate], Some(&table), true).unwrap();
        let picked: Vec<&str> = out
            .iter()
            .map(|item| item.as_ref().unwrap()["model"].as_str().unwrap())
            .collect();
        assert_eq!(picked, vec!["m1", "m3", "m5", "m6", "m8", "m10"]);
    }

    #[test]
    fn expand_candidates_drops_unpriced_variants_then_keeps_the_default() {
        let table = MapTable::from_model_prices(&[("m2", 5.0)]);
        let candidate = json!({
            "providerId": "p",
            "autoModel": true,
            "model": "m1",
            "provider": { "id": "p", "model": "m1", "modelOptions": ["m1", "m2", "m3"] },
        });
        let out = expand_candidates(std::slice::from_ref(&candidate), Some(&table), true).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].as_ref().unwrap()["model"], json!("m2"));

        // requirePrice=false keeps every model, unknown prices last.
        let out = expand_candidates(&[candidate], Some(&table), false).unwrap();
        let picked: Vec<&str> = out
            .iter()
            .map(|item| item.as_ref().unwrap()["model"].as_str().unwrap())
            .collect();
        assert_eq!(picked, vec!["m2", "m1", "m3"]);
    }

    #[test]
    fn expand_candidates_keeps_plain_routes_and_reproduces_the_room_one_bug() {
        let table = MapTable::from_model_prices(&[("m1", 2.0)]);
        let out = expand_candidates(
            &[json!({ "providerId": "p", "model": "m1" })],
            Some(&table),
            true,
        )
        .unwrap();
        assert_eq!(
            out,
            vec![Some(json!({
                "providerId": "p",
                "model": "m1",
                "price": { "blended": 2, "input": 1, "output": 4, "matched": "m1", "source": "stub" },
            }))]
        );

        // Five providers of six priced models each: the 24-variant budget is
        // spent before the fifth line, so room == 1 and the recorded bug adds
        // one `undefined` entry.
        let mut candidates = Vec::new();
        let mut pairs: Vec<(String, f64)> = Vec::new();
        for provider in 0..5 {
            let id = format!("p{provider}");
            let models: Vec<String> = (0..6).map(|at| format!("{id}-m{at}")).collect();
            for (at, model) in models.iter().enumerate() {
                pairs.push((model.clone(), (provider * 100 + at) as f64));
            }
            candidates.push(json!({
                "providerId": id,
                "autoModel": true,
                "provider": { "id": id, "model": models[0], "modelOptions": models },
            }));
        }
        let pairs: Vec<(&str, f64)> = pairs
            .iter()
            .map(|(model, price)| (model.as_str(), *price))
            .collect();
        let table = MapTable::from_model_prices(&pairs);
        let out = expand_candidates(&candidates, Some(&table), true).unwrap();
        assert_eq!(out.len(), 25);
        assert!(
            out[24].is_none(),
            "the recorded room=1 bug must survive the port"
        );
    }

    #[test]
    fn ladder_names_tiers_and_reports_positions() {
        let ladder = price_ladder(&[
            json!({ "price": { "blended": 5 } }),
            json!({}),
            json!({ "price": { "blended": 1 } }),
        ]);
        // Unknown prices rank last, so `{}`, `null` and `undefined` all share
        // the top tier when the ladder has room for it.
        assert_eq!(ladder.tiers, vec!["p1", "p2", "p3"]);
        assert_eq!(
            ladder.tier_of(Some(&json!({ "price": { "blended": 1 } }))),
            Some("p1".to_string())
        );
        assert_eq!(
            ladder.tier_of(Some(&json!({ "price": { "blended": 5 } }))),
            Some("p2".to_string())
        );
        assert_eq!(ladder.tier_of(Some(&json!({}))), Some("p3".to_string()));
        assert_eq!(ladder.tier_of(None), Some("p3".to_string()));
        let single = price_ladder(&[json!({ "price": { "blended": 1 } })]);
        assert!(single.tiers.is_empty());
        assert_eq!(
            single.tier_of(Some(&json!({ "price": { "blended": 1 } }))),
            None
        );
    }
}
