use crate::js_live::LiveValue as L;
use multicc_core::{js::JsValue as J, selection};
use napi::{
    bindgen_prelude::{FromNapiValue, ToNapiValue, Unknown},
    sys, Env, Result,
};
use napi_derive::napi;

// Project only the top-level arguments. JSON.stringify must still run inside
// V8 so application-owned getters, toJSON and exceptions keep their semantics.
fn json_number(value: L<'_>, spell_nan: bool) -> Result<L<'_>> {
    let Some(n) = value.number_value()? else {
        return Ok(value);
    };
    let spelling = if n == f64::INFINITY {
        "Infinity"
    } else if n == f64::NEG_INFINITY {
        "-Infinity"
    } else if spell_nan && n.is_nan() {
        "NaN"
    } else {
        return Ok(value);
    };
    value.from_value(&J::string(spelling))
}

#[napi]
pub fn context_selection_value(
    env: Env,
    operation: String,
    first: Unknown<'_>,
    second: Unknown<'_>,
    header: Unknown<'_>,
    footer: Unknown<'_>,
) -> Result<sys::napi_value> {
    let first = L::new(&env, first);
    let second = L::new(&env, second);
    let input = first.from_value(&J::Object(Vec::new()))?;
    let kernel: fn(&str) -> std::result::Result<String, String> = match operation.as_str() {
        "terms" => {
            input.set(c"value", json_number(first, false)?)?;
            selection::terms_json
        }
        "relevance" => {
            input.set(c"query", json_number(first, false)?)?;
            input.set(c"text", json_number(second, false)?)?;
            selection::relevance_json
        }
        "minRelevance" => {
            input.set(c"query", json_number(first, false)?)?;
            selection::min_relevance_json
        }
        "clipTokens" => {
            input.set(c"text", json_number(first, false)?)?;
            let budget = if second.undefined()? {
                second.from_value(&J::string("undefined"))?
            } else {
                json_number(second, true)?
            };
            input.set(c"budget", budget)?;
            input.set(
                c"textUndefined",
                first.from_value(&J::Bool(first.undefined()?))?,
            )?;
            selection::clip_tokens_json
        }
        "selectContext" => {
            input.set(c"candidates", first)?;
            let header = L::new(&env, header);
            let footer = L::new(&env, footer);
            input.set(
                c"budget",
                if second.undefined()? {
                    second.from_value(&J::Number(8000.0))?
                } else {
                    json_number(second, true)?
                },
            )?;
            let empty = first.from_value(&J::string(""))?;
            input.set(
                c"header",
                if header.undefined()? {
                    empty
                } else {
                    json_number(header, true)?
                },
            )?;
            input.set(
                c"footer",
                if footer.undefined()? {
                    empty
                } else {
                    json_number(footer, true)?
                },
            )?;
            selection::select_context_json
        }
        _ => {
            return Err(napi::Error::from_reason(
                "unknown context selection operation",
            ))
        }
    };
    let json = first.global()?.get(c"JSON")?;
    let parse = json.get(c"parse")?;
    let encoded = json.get(c"stringify")?.call(json, &[input])?;
    let input = unsafe { String::from_napi_value(encoded.env(), encoded.raw()) }?;
    let output = kernel(&input).map_err(napi::Error::from_reason)?;
    let text = L::from_raw(first.env(), unsafe {
        String::to_napi_value(first.env(), output)?
    });
    let result = parse.call(json, &[text])?;
    if operation == "clipTokens" && first.undefined()? && result.nullish()? {
        return Ok(first.raw());
    }
    if operation == "selectContext" && result.get(c"budgetInfinite")?.truthy()? {
        result
            .get(c"budget")?
            .set(c"limit", first.from_value(&J::Number(f64::INFINITY))?)?;
        result.delete(c"budgetInfinite")?;
    }
    Ok(result.raw())
}

/// JSON entry point for callers with an already serialized request.
#[napi]
pub fn context_selection_terms(input: String) -> Result<String> {
    multicc_core::selection::terms_json(&input).map_err(napi::Error::from_reason)
}

/// `relevance(query, text)`.
#[napi]
pub fn context_selection_relevance(input: String) -> Result<String> {
    multicc_core::selection::relevance_json(&input).map_err(napi::Error::from_reason)
}

/// `minRelevance(query)`.
#[napi]
pub fn context_selection_min_relevance(input: String) -> Result<String> {
    multicc_core::selection::min_relevance_json(&input).map_err(napi::Error::from_reason)
}

/// `clipTokens(text, budget)`.
#[napi]
pub fn context_selection_clip_tokens(input: String) -> Result<String> {
    multicc_core::selection::clip_tokens_json(&input).map_err(napi::Error::from_reason)
}

/// `selectContext(candidates, options)`; candidates arrive pre-sorted by the
/// bridge because localeCompare is an ICU decision.
#[napi]
pub fn context_selection_select(input: String) -> Result<String> {
    multicc_core::selection::select_context_json(&input).map_err(napi::Error::from_reason)
}

/// Host prompt policies (execution efficiency, sub-agent delegation, slimmed
/// host hint, turn-plan wording) owned by `multicc_core::host_prompts`.
#[napi]
pub fn host_prompts_request(op: String, input: String) -> Result<String> {
    multicc_core::host_prompts::request(&op, &input).map_err(napi::Error::from_reason)
}

/// Memory retrieval ranking, header-only rule pinning, scope selection,
/// query-hit capping, and 1-hop wikilink expansion.
#[napi]
pub fn memory_retrieval_select(input: String) -> Result<String> {
    multicc_core::memory_retrieval::select_entries_json(&input).map_err(napi::Error::from_reason)
}
