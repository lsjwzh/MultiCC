//! Battery probing for the host and value conversion for legacy injected readers.
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

#[napi(object)]
pub struct HostBatteryReading {
    pub available: bool,
    pub percent: f64,
    pub charging: bool,
    pub plugged_in: bool,
    pub remaining_minutes: napi::bindgen_prelude::Either<f64, napi::bindgen_prelude::Null>,
}

#[napi(object)]
pub struct HostBatterySample {
    pub generation: u32,
    pub reading: Option<HostBatteryReading>,
}

#[napi]
#[derive(Default)]
pub struct HostBatteryReader(host_battery::HostReader);

#[napi]
impl HostBatteryReader {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    #[napi]
    pub async fn read(&self) -> Result<HostBatterySample> {
        use napi::bindgen_prelude::{Either, Null};
        let (generation, battery) = self.0.read().await;
        Ok(HostBatterySample {
            generation,
            reading: battery.map(|b| HostBatteryReading {
                available: true,
                percent: b.percent,
                charging: b.charging,
                plugged_in: b.plugged_in,
                remaining_minutes: b.remaining_minutes.map_or(Either::B(Null), Either::A),
            }),
        })
    }
}
