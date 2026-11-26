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
    Ok(select_value(
        &operation,
        first,
        second,
        L::new(&env, header),
        L::new(&env, footer),
    )?
    .raw())
}
fn select_value<'a>(
    operation: &str,
    first: L<'a>,
    second: L<'a>,
    header: L<'a>,
    footer: L<'a>,
) -> Result<L<'a>> {
    let input = first.from_value(&J::Object(Vec::new()))?;
    let kernel: fn(&str) -> std::result::Result<String, String> = match operation {
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
        return Ok(first);
    }
    if operation == "selectContext" && result.get(c"budgetInfinite")?.truthy()? {
        result
            .get(c"budget")?
            .set(c"limit", first.from_value(&J::Number(f64::INFINITY))?)?;
        result.delete(c"budgetInfinite")?;
    }
    Ok(result)
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

#[napi]
pub fn context_selection_api(env: Env, subtract: Unknown<'_>) -> Result<sys::napi_value> {
    use crate::{
        host_methods::{call, method},
        js_iteration::read,
        route_response::{fallback, fields, string, text},
    };
    let subtract = L::new(&env, subtract);
    let comparator = method(&env, subtract, "", 2, 2, |subtract, a| {
        // ECMAScript subtraction preserves mixed-BigInt errors and conversion order.
        let right = fallback(read(a[1], c"priority")?, 0.0.into())?;
        let left = fallback(read(a[0], c"priority")?, 0.0.into())?;
        let order = subtract.call_plain(&[right, left])?;
        if order.truthy()? {
            return Ok(order);
        }
        let left = string(read(a[0], c"id")?)?;
        let right = string(read(a[1], c"id")?)?;
        call(left, c"localeCompare", &[right])
    })?;
    let api = fields(subtract, &[])?;
    for (name, arity) in [
        ("terms", 1),
        ("relevance", 2),
        ("minRelevance", 1),
        ("clipTokens", 2),
        ("selectContext", 1),
    ] {
        let function = method(&env, comparator, name, arity, 2, move |cmp, args| {
            let mut first = args[0];
            let mut second = args[1];
            let mut header = cmp.from_value(&J::Undefined)?;
            let mut footer = header;
            if name == "selectContext" {
                let options = if second.undefined()? {
                    fields(cmp, &[])?
                } else {
                    second
                };
                second = read(options, c"budget")?;
                header = read(options, c"header")?;
                footer = read(options, c"footer")?;
                let rows = cmp.from_value(&J::Array(vec![]))?;
                let mut i = 0;
                first.for_each(|item| {
                    rows.set_element(i, item)?;
                    i += 1;
                    Ok(())
                })?;
                first = call(rows, c"sort", &[cmp])?;
            }
            match select_value(name, first, second, header, footer) {
                Ok(value) => Ok(value),
                Err(error) => {
                    const PREFIX: &str = "context_selection_type_error: ";
                    if let Some(cause) = cmp.exception_value()? {
                        if let Some(message) = cause.optional(c"message")?.string()? {
                            if let Some(detail) = message.as_str_lossy().strip_prefix(PREFIX) {
                                return Err(cmp.type_error(detail));
                            }
                        }
                        return Err(cause.throw_error());
                    }
                    if let Some(detail) = error.reason.strip_prefix(PREFIX) {
                        return Err(cmp.type_error(detail));
                    }
                    Err(error)
                }
            }
        })?;
        api.set_key(text(api, name)?, function)?;
    }
    Ok(api.raw())
}
