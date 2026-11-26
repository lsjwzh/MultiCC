use napi::bindgen_prelude::{JsValue as _, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;

/// `USAGE_OBSERVED_VERSION` (and future constants) as one JSON document.
#[napi]
pub fn usage_observed_catalog() -> Result<String> {
    Ok(multicc_core::usage_observed::catalog())
}

/// op dispatch: `create` (normalize/validate an observation) and
/// `stableEventId`. Errors travel inside the envelope so the bridge can
/// rethrow `UsageObservedError` with the original code. The payload crosses
/// napi directly, keeping nested `NaN`/`Infinity`, explicit `undefined`
/// properties and `-0` that a JSON boundary would rewrite.
#[napi]
pub fn usage_observed_request_value(
    env: Env,
    op: String,
    input: Unknown<'_>,
) -> Result<sys::napi_value> {
    let raw = env.raw();
    let value = unsafe { crate::js_bridge::read_value(raw, input.raw(), 0, &mut Vec::new()) }?;
    let result = multicc_core::usage_observed::request_value(&op, &value)
        .map_err(napi::Error::from_reason)?;
    unsafe { crate::js_bridge::write_value(raw, &result) }
}

fn token_count(value: crate::js_live::LiveValue<'_>) -> Result<Option<f64>> {
    use multicc_core::usage_observed::{token_count_number, token_count_text};
    if let Some(number) = value.number_value()? {
        return Ok(token_count_number(number));
    }
    Ok(value
        .string()?
        .and_then(|text| token_count_text(&text.as_str_lossy())))
}

#[napi]
pub fn normalized_usage_token_count(env: Env, value: Unknown<'_>) -> Result<Option<f64>> {
    token_count(crate::js_live::LiveValue::new(&env, value))
}

#[napi(object)]
pub struct UsageTokenComponents {
    pub fresh_input_tokens: f64,
    pub cache_read_tokens: f64,
    pub cache_write_tokens: f64,
    pub consumed_input_tokens: f64,
    pub output_tokens: f64,
}

#[napi]
pub fn usage_token_components(
    env: Env,
    input: Unknown<'_>,
    read: Unknown<'_>,
    write: Unknown<'_>,
    output: Unknown<'_>,
) -> Result<UsageTokenComponents> {
    let count = |value| {
        token_count(crate::js_live::LiveValue::new(&env, value)).map(Option::unwrap_or_default)
    };
    let fresh_input_tokens = count(input)?;
    let cache_read_tokens = count(read)?;
    let cache_write_tokens = count(write)?;
    Ok(UsageTokenComponents {
        fresh_input_tokens,
        cache_read_tokens,
        cache_write_tokens,
        consumed_input_tokens: fresh_input_tokens + cache_read_tokens + cache_write_tokens,
        output_tokens: count(output)?,
    })
}

#[napi(object)]
pub struct CodexCumulativeUsage {
    pub fresh: f64,
    pub cached: f64,
    pub cache_write: f64,
    pub output: f64,
    pub reasoning: f64,
}

#[napi]
pub fn codex_cumulative_usage(env: Env, value: Unknown<'_>) -> Result<CodexCumulativeUsage> {
    let usage = crate::js_live::LiveValue::new(&env, value);
    let count = |key| token_count(usage.get(key)?).map(Option::unwrap_or_default);
    let cache_read = c"cache_read_input_tokens";
    let cached = count(if usage.get(cache_read)?.nullish()? {
        c"cached_input_tokens"
    } else {
        cache_read
    })?;
    let input = count(c"input_tokens")?;
    // Legacy input includes cached reads. Re-read the live field after input
    // so accessor order and errors match the original host projection.
    let fresh = if usage.get(cache_read)?.nullish()? {
        if input > cached {
            input - cached
        } else {
            0.0
        }
    } else {
        input
    };
    Ok(CodexCumulativeUsage {
        fresh,
        cached,
        cache_write: count(c"cache_creation_input_tokens")?,
        output: count(c"output_tokens")?,
        reasoning: count(c"reasoning_output_tokens")?,
    })
}

/// Normalized numeric columns shared by session, provider and daily ledgers.
/// Callers keep unknown columns and the commit sequence at the storage edge.
#[napi(object)]
pub struct UsageLedgerBucket {
    pub input_tokens: f64,
    pub consumed_input_tokens: f64,
    pub fresh_input_tokens: f64,
    pub cache_read_tokens: f64,
    pub cache_write_tokens: f64,
    pub breakdown_known: bool,
    pub output_tokens: f64,
    pub turn_count: f64,
}

#[napi]
pub fn advance_usage_bucket(
    mut bucket: UsageLedgerBucket,
    parts: UsageTokenComponents,
) -> UsageLedgerBucket {
    bucket.input_tokens += parts.consumed_input_tokens;
    bucket.consumed_input_tokens = bucket.input_tokens;
    bucket.fresh_input_tokens += parts.fresh_input_tokens;
    bucket.cache_read_tokens += parts.cache_read_tokens;
    bucket.cache_write_tokens += parts.cache_write_tokens;
    bucket.breakdown_known = true;
    bucket.output_tokens += parts.output_tokens;
    bucket.turn_count += 1.0;
    bucket
}
