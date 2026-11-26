//! One latch per running guard. Keep live battery/sleep objects on the owner
//! for reentrant snapshots; timers and pending OS operations stay on the host.
use crate::{host_methods::function, js_iteration::read, js_live::spread, route_response::*};
use napi_derive::napi;

fn copy(value: L<'_>) -> Result<L<'_>> {
    if value.truthy()? {
        spread(value)
    } else {
        null(value)
    }
}
fn snapshot(p: L<'_>) -> Result<L<'_>> {
    Ok(fields(
        p,
        &[
            ("running", call(p, c"running", &[])?),
            ("intervalMs", p.get(c"intervalMs")?),
            ("thresholds", spread(p.get(c"thresholds")?)?),
            ("sleepPrevention", p.get(c"enabled")?),
            ("latched", p.get(c"latched")?),
            ("triggerCount", p.get(c"count")?),
            ("lastCheckTs", p.get(c"at")?),
            ("lastBattery", copy(p.get(c"battery")?)?),
            ("lastSleepResult", copy(p.get(c"result")?)?),
            ("error", p.get(c"error")?),
        ],
    )?)
}
fn observe<'a>(p: L<'a>, battery: L<'a>, lid: L<'a>, at: L<'a>) -> Result<L<'a>> {
    p.set(c"at", at)?;
    p.set(
        c"battery",
        fields(
            p,
            &[
                ("source", read(battery, c"source")?),
                ("percent", read(battery, c"percent")?),
            ],
        )?,
    )?;
    let enabled = read(lid, c"enabled")?.truthy()?;
    p.set(c"enabled", flag(p, enabled)?)?;
    p.set(c"error", null(p)?)?;
    let percent = read(battery, c"percent")?;
    if percent.nullish()? || !read(battery, c"source")?.truthy()? {
        return null(p);
    }
    let thresholds = p.get(c"thresholds")?;
    if p.get(c"latched")?.truthy()?
        && (read(battery, c"source")?.is_string("ac")?
            || call(p, c"ge", &[percent, read(thresholds, c"rearm")?])?.truthy()?
            || !enabled)
    {
        p.set(c"latched", flag(p, false)?)?;
    }
    if !p.get(c"latched")?.truthy()?
        && enabled
        && read(battery, c"source")?.is_string("battery")?
        && call(p, c"le", &[percent, read(thresholds, c"trigger")?])?.truthy()?
    {
        return fields(p, &[("percent", percent)]);
    }
    null(p)
}
#[napi]
pub fn battery_guard_owner(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    for key in [c"checking", c"enabled", c"latched"] {
        p.set(key, flag(p, false)?)?;
    }
    for key in [c"count", c"at"] {
        p.set(key, num(p, 0.)?)?;
    }
    for key in [c"battery", c"result", c"error"] {
        p.set(key, null(p)?)?;
    }
    Ok(fields(
        p,
        &[
            (
                "getStatus",
                function(p, "getStatus", 0, 0, |p, _| snapshot(p))?,
            ),
            (
                "begin",
                function(p, "begin", 0, 0, |p, _| {
                    let start = !p.get(c"checking")?.truthy()?;
                    p.set(c"checking", flag(p, true)?)?;
                    flag(p, start)
                })?,
            ),
            (
                "observe",
                function(p, "observe", 3, 3, |p, a| observe(p, a[0], a[1], a[2]))?,
            ),
            (
                "slept",
                function(p, "slept", 1, 1, |p, a| {
                    p.set(c"result", a[0])?;
                    p.set(c"latched", flag(p, true)?)?;
                    p.set(c"count", num(p, p.get(c"count")?.number()? + 1.)?)?;
                    p.from_value(&V::Undefined)
                })?,
            ),
            (
                "failed",
                function(p, "failed", 1, 1, |p, a| {
                    p.set(c"error", a[0])?;
                    p.from_value(&V::Undefined)
                })?,
            ),
            (
                "finish",
                function(p, "finish", 0, 0, |p, _| {
                    p.set(c"checking", flag(p, false)?)?;
                    p.from_value(&V::Undefined)
                })?,
            ),
        ],
    )?
    .raw())
}
