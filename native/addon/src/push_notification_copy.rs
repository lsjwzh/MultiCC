//! Lock-screen notification labels for the compatibility push host.
use crate::js_live::LiveValue;
use multicc_core::{classify_vocab, js::JsValue};
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
    sys, Env, Result,
};
use napi_derive::napi;

fn text<'a>(anchor: LiveValue<'a>, value: &str) -> Result<LiveValue<'a>> {
    anchor.from_value(&JsValue::string(value))
}

fn labels<'a>(anchor: LiveValue<'a>, zh: &str, en: &str) -> Result<LiveValue<'a>> {
    let row = anchor.from_value(&JsValue::Object(vec![]))?;
    row.set(c"zh", text(row, zh)?)?;
    row.set(c"en", text(row, en)?)?;
    row.freeze()
}

#[napi]
pub fn push_notification_tables(env: Env) -> Result<sys::napi_value> {
    let anchor = LiveValue::new(&env, ().into_unknown(&env)?);
    let empty = JsValue::Object(vec![]);
    let tables = anchor.from_value(&empty)?;
    let copy = anchor.from_value(&empty)?;
    let keys = anchor.from_value(&empty)?;
    let goals = anchor.from_value(&empty)?;
    let vocab = classify_vocab::catalog_value();
    for (key, letter, field, en) in [
        ("succeeded", "D", "pushTitle", "Execution succeeded"),
        ("waiting", "W", "pushTitle", "Action Required"),
        (
            "waiting_background",
            "B",
            "pushTitle",
            "Waiting in background",
        ),
        ("error", "E", "pushTitle", "Error"),
        ("running", "P", "label", "Processing"),
    ] {
        let zh = vocab["classifyDisplay"][letter][field]
            .as_str()
            .ok_or_else(|| napi::Error::from_reason("missing classify notification title"))?;
        copy.set_key(text(copy, key)?, labels(copy, zh, en)?)?;
    }
    for (key, aliases) in [
        ("succeeded", &["d", "succeeded", "completed"][..]),
        ("waiting", &["w", "waiting", "c"][..]),
        ("waiting_background", &["b", "waiting_background"][..]),
        ("error", &["e", "error"][..]),
        ("running", &["p", "running", "processing"][..]),
    ] {
        for name in aliases {
            keys.set_key(text(keys, name)?, text(keys, key)?)?;
        }
    }
    goals.set(c"achieved", labels(goals, "达成目标", "Goal achieved")?)?;
    goals.set(c"interact", labels(goals, "需要交互", "Needs input")?)?;
    tables.set(c"COPY", copy.freeze()?)?;
    tables.set(c"KEY_OF", keys.freeze()?)?;
    tables.set(c"goals", goals.freeze()?)?;
    Ok(tables.freeze()?.raw())
}

fn string_or_empty(value: LiveValue<'_>) -> Result<LiveValue<'_>> {
    if value.nullish()? {
        text(value, "")
    } else {
        value.global()?.get(c"String")?.call_plain(&[value])
    }
}

fn copy_key<'a>(spec: LiveValue<'a>, keys: LiveValue<'a>) -> Result<LiveValue<'a>> {
    let value = string_or_empty(spec)?;
    let raw = value.get(c"trim")?.call(value, &[])?;
    if raw.is_string("")? {
        return text(raw, "succeeded");
    }
    let folded = raw.get(c"toLowerCase")?.call(raw, &[])?;
    let key = keys.get_key(folded)?;
    if key.truthy()? {
        return Ok(key);
    }
    // length is measured in UTF-16 units at the JS boundary.
    text(
        raw,
        if raw.get(c"length")?.is_number(1.0)? {
            "waiting"
        } else {
            "succeeded"
        },
    )
}

#[napi]
pub fn push_notification_key(
    env: Env,
    spec: Unknown<'_>,
    keys: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(copy_key(LiveValue::new(&env, spec), LiveValue::new(&env, keys))?.raw())
}

#[napi]
pub fn push_notification_copy(
    env: Env,
    spec: Unknown<'_>,
    locale: Unknown<'_>,
    goal: Unknown<'_>,
    tables: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(notification(
        LiveValue::new(&env, tables),
        LiveValue::new(&env, spec),
        LiveValue::new(&env, locale),
        LiveValue::new(&env, goal),
    )?
    .raw())
}
fn notification<'a>(
    tables: LiveValue<'a>,
    spec: LiveValue<'a>,
    locale: LiveValue<'a>,
    goal: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
    let key = copy_key(spec, tables.get(c"KEY_OF")?)?;
    let lang = if locale.is_string("en")? { "en" } else { "zh" };
    let locale = text(tables, lang)?;
    let mut title = tables.from_value(&JsValue::Undefined)?;
    if key.is_string("succeeded")? {
        let goal = string_or_empty(goal)?;
        let folded = goal.get(c"toLowerCase")?.call(goal, &[])?;
        let sub = tables.get(c"goals")?.get_key(folded)?;
        if sub.truthy()? {
            title = sub.get_key(locale)?;
        }
    }
    if !title.truthy()? {
        let row = tables.get(c"COPY")?.get_key(key)?;
        if row.undefined()? {
            return Err(row.type_error(&format!(
                "Cannot read properties of undefined (reading '{lang}')"
            )));
        }
        title = row.get_key(locale)?;
    }
    let result = tables.from_value(&JsValue::Object(vec![]))?;
    result.set(c"key", key)?;
    result.set(c"locale", locale)?;
    result.set(c"title", title)?;
    Ok(result)
}

#[napi]
pub fn push_notification_api(env: Env) -> Result<sys::napi_value> {
    use crate::{host_methods::method, js_live::fields};
    let tables = LiveValue::from_raw(env.raw(), push_notification_tables(env)?);
    let keys = tables.get(c"KEY_OF")?;
    Ok(fields(
        tables,
        &[
            ("COPY", tables.get(c"COPY")?),
            ("KEY_OF", keys),
            (
                "copyKeyFor",
                method(&env, keys, "copyKeyFor", 1, 1, |keys, a| {
                    copy_key(a[0], keys)
                })?,
            ),
            (
                "notificationCopy",
                method(&env, tables, "notificationCopy", 3, 3, |tables, a| {
                    notification(tables, a[0], a[1], a[2])
                })?,
            ),
        ],
    )?
    .raw())
}
