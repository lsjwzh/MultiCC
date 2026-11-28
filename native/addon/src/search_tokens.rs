//! 分词返回有序 Map；字符串规范化沿用当前宿主的 ICU 版本。
use crate::js_live::LiveValue;
use multicc_core::{js::JsValue, search_tokens};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

pub(crate) fn normalized(value: LiveValue<'_>, query: bool) -> Result<LiveValue<'_>> {
    let string = value.global()?.get(c"String")?;
    let input = if value.nullish()? {
        value.from_value(&JsValue::string(""))?
    } else {
        value
    };
    let mut text = string.call_plain(&[input])?;
    if query {
        // 旧 MATCH 协议先按 UTF-16 截取 400 个码元，再折叠全角等兼容字符。
        text = text.get(c"slice")?.call(
            text,
            &[
                text.from_value(&0.0.into())?,
                text.from_value(&400.0.into())?,
            ],
        )?;
    }
    let form = value.from_value(&JsValue::string("NFKC"))?;
    let folded = text.get(c"normalize")?.call(text, &[form])?;
    folded.get(c"toLowerCase")?.call(folded, &[])
}

fn token_input(value: LiveValue<'_>, query: bool) -> Result<String> {
    // 孤立代理项和 U+FFFD 在两套分词字符集中都是分隔符。
    Ok(normalized(value, query)?.coerce_string()?.to_string_lossy())
}

#[napi]
pub fn search_normalize_text(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(normalized(LiveValue::new(&env, value), false)?.raw())
}

#[napi]
pub fn search_tokenize(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    let value = LiveValue::new(&env, value);
    let text = token_input(value, false)?;
    let pairs = search_tokens::weighted_terms(&text)
        .into_iter()
        .map(|(term, count)| JsValue::Array(vec![term.into(), count.into()]))
        .collect();
    let entries = value.from_value(&JsValue::Array(pairs))?;
    Ok(value.global()?.get(c"Map")?.construct(&[entries])?.raw())
}

#[napi]
pub fn search_board_query_terms(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(live_board_query_terms(LiveValue::new(&env, value))?.raw())
}

pub(crate) fn live_board_query_terms(value: LiveValue<'_>) -> Result<LiveValue<'_>> {
    let text = token_input(value, false)?;
    let terms = search_tokens::board_query_terms(&text)
        .into_iter()
        .map(|(term, weight)| JsValue::Array(vec![term.into(), weight.into()]))
        .collect();
    value.from_value(&JsValue::Array(terms))
}

#[napi]
pub fn search_index_tokens(env: Env, value: Unknown<'_>) -> Result<Vec<String>> {
    let text = token_input(LiveValue::new(&env, value), false)?;
    Ok(search_tokens::index_tokens(&text)
        .into_iter()
        .map(str::to_owned)
        .collect())
}

#[napi]
pub fn search_match_groups(env: Env, value: Unknown<'_>) -> Result<Vec<Vec<String>>> {
    let text = token_input(LiveValue::new(&env, value), true)?;
    Ok(search_tokens::match_groups(&text)
        .into_iter()
        .map(|group| group.into_iter().map(str::to_owned).collect())
        .collect())
}

#[napi]
pub fn search_match_expression(env: Env, value: Unknown<'_>) -> Result<Option<String>> {
    let text = token_input(LiveValue::new(&env, value), true)?;
    Ok(search_tokens::match_expression(&text))
}

#[napi]
pub const SEARCH_MAX_MATCH_TERMS: u32 = search_tokens::MAX_MATCH_TERMS as u32;
#[napi]
pub const SEARCH_MAX_PHRASE_BIGRAMS: u32 = search_tokens::MAX_PHRASE_BIGRAMS as u32;
