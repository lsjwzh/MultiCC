//! The Node reader owns the in-flight Promise and supplies the shared fallback.
use crate::js_live::{fields, LiveValue};
use multicc_core::{
    host_battery::{self, Battery},
    js::JsValue,
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

fn reading(value: LiveValue<'_>, b: Battery) -> Result<sys::napi_value> {
    Ok(fields(
        value,
        &[
            ("available", value.from_value(&true.into())?),
            ("percent", value.from_value(&JsValue::Number(b.percent))?),
            ("charging", value.from_value(&b.charging.into())?),
            ("pluggedIn", value.from_value(&b.plugged_in.into())?),
            (
                "remainingMinutes",
                value.from_value(&b.remaining_minutes.map_or(JsValue::Null, JsValue::Number))?,
            ),
        ],
    )?
    .raw())
}

#[napi]
pub fn host_pmset_reading(
    env: Env,
    source: String,
    unavailable: Unknown<'_>,
) -> Result<sys::napi_value> {
    let fallback = LiveValue::new(&env, unavailable);
    match host_battery::pmset(&source) {
        Some(b) => reading(fallback, b),
        None => Ok(fallback.raw()),
    }
}
#[napi]
pub fn host_battery_capacity(percent: f64) -> bool {
    host_battery::valid_percent(percent)
}
#[napi]
pub fn host_linux_reading(
    env: Env,
    percent: Unknown<'_>,
    status: String,
) -> Result<sys::napi_value> {
    let anchor = LiveValue::new(&env, percent);
    reading(anchor, host_battery::linux(anchor.number()?, &status))
}
