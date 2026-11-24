//! Quota display values, including the mutability contract of each public view.
use crate::js_live::LiveValue;
use multicc_core::js::JsValue;
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
    sys, Env, Result,
};
use napi_derive::napi;
use std::ffi::CStr;

fn render<'a>(op: &str, input: LiveValue<'a>) -> Result<LiveValue<'a>> {
    let request =
        unsafe { crate::js_bridge::read_value(input.env(), input.raw(), 0, &mut Vec::new()) }?;
    input.from_value(&multicc_core::quota_bar_view::request(op, &request))
}

#[napi]
pub fn quota_bar_view_request(env: Env, op: String, input: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(render(&op, LiveValue::new(&env, input))?.raw())
}

fn values(value: LiveValue<'_>) -> Result<LiveValue<'_>> {
    let object = value.global()?.get(c"Object")?;
    object.get(c"values")?.call(object, &[value])
}

fn freeze_bar(bar: LiveValue<'_>) -> Result<()> {
    if bar.kind()? != sys::ValueType::napi_object {
        return Ok(());
    }
    for name in [c"textParts", c"titleParts"] {
        let parts = bar.get(name)?;
        if parts.is_array()? {
            parts.freeze()?;
        }
    }
    let states = bar.get(c"states")?;
    if states.truthy()? {
        values(states)?.for_each(freeze_bar)?;
        states.freeze()?;
    }
    bar.freeze()?;
    Ok(())
}

pub(crate) fn view<'a>(op: &str, input: LiveValue<'a>) -> Result<LiveValue<'a>> {
    let value = render(op, input)?;
    if op == "idleQuotaBars" {
        values(value)?.for_each(freeze_bar)?;
        return Ok(value);
    }
    if op == "normalizeWindowEvent" && value.truthy()? {
        let info = input.get(c"info")?;
        if info.optional(c"provider")?.truthy()? && !info.get(c"provider")?.is_string("claude")? {
            let windows = value.get(c"windows")?;
            if windows.is_array()? {
                windows.for_each(|row| {
                    row.freeze()?;
                    Ok(())
                })?;
                windows.freeze()?;
            }
        }
    }
    freeze_bar(value)?;
    Ok(value)
}

#[napi]
pub fn quota_bar_view_api(env: Env) -> Result<sys::napi_value> {
    let anchor = LiveValue::new(&env, ().into_unknown(&env)?);
    let api = anchor.from_value(&JsValue::Object(vec![]))?;
    // Each entry preserves its positional arguments and its JS function length
    // (arguments after the first default do not contribute to length).
    let methods: &[(&str, &[&CStr], usize)] = &[
        ("renderQuotaBar", &[c"kind", c"value", c"opts"], 2),
        ("idleQuotaBars", &[], 0),
        ("balanceBar", &[c"value"], 1),
        ("normalizeBalance", &[c"info"], 1),
        ("windowEventBar", &[c"info", c"nowMs"], 1),
        ("normalizeWindowEvent", &[c"info", c"nowMs"], 2),
        ("claudeBar", &[c"usage", c"live", c"nowMs"], 2),
        ("labelRoutedProvider", &[c"bar", c"provider"], 2),
        ("labelRoutedBalance", &[c"bar"], 1),
        ("arkPlanFromBaseUrl", &[c"baseUrl"], 1),
        ("arkWindowLabel", &[c"label"], 1),
        ("compactBarText", &[c"text"], 1),
        ("providerLimitBar", &[c"entry", c"nowMs"], 1),
        (
            "providerBalanceBar",
            &[c"strategy", c"dto", c"fetchedAt"],
            3,
        ),
    ];
    for &(op, keys, arity) in methods {
        let f =
            env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(op, move |ctx| {
                let env: &Env = ctx.env;
                let undefined = LiveValue::new(env, ().into_unknown(env)?);
                let input = undefined.from_value(&JsValue::Object(vec![]))?;
                for (i, &key) in keys.iter().enumerate() {
                    let mut v = if i < ctx.length() {
                        LiveValue::new(env, ctx.get::<Unknown<'_>>(i)?)
                    } else {
                        undefined
                    };
                    if i >= arity && v.undefined()? {
                        v = if key == c"opts" {
                            undefined.from_value(&JsValue::Object(vec![]))?
                        } else {
                            let date = undefined.global()?.get(c"Date")?;
                            date.get(c"now")?.call(date, &[])?
                        };
                    }
                    input.set(key, v)?;
                }
                Ok(view(op, input)?.raw())
            })?;
        let f = LiveValue::new(&env, f.into_unknown(&env)?);
        let descriptor = anchor.from_value(&JsValue::object(vec![(
            "value",
            JsValue::Number(arity as f64),
        )]))?;
        let object = anchor.global()?.get(c"Object")?;
        object.get(c"defineProperty")?.call(
            object,
            &[
                f,
                anchor.from_value(&JsValue::string("length"))?,
                descriptor,
            ],
        )?;
        api.set_key(anchor.from_value(&JsValue::string(op))?, f)?;
    }
    api.set(
        c"COLOR",
        view("colors", api.from_value(&JsValue::Object(vec![]))?)?,
    )?;
    Ok(api.raw())
}
