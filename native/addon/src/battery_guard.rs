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
fn snapshot<'a>(p: L<'a>, running: L<'a>) -> Result<L<'a>> {
    Ok(fields(
        p,
        &[
            ("running", running),
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
fn record_attempt<'a>(p: L<'a>, result: L<'a>) -> Result<()> {
    p.set(c"result", result)?;
    p.set(c"latched", flag(p, true)?)?;
    p.set(c"count", num(p, p.get(c"count")?.number()? + 1.)?)
}

fn initialize_state(p: L<'_>) -> Result<()> {
    for key in [c"checking", c"enabled", c"latched"] {
        p.set(key, flag(p, false)?)?;
    }
    for key in [c"count", c"at"] {
        p.set(key, num(p, 0.)?)?;
    }
    for key in [c"battery", c"result", c"error"] {
        p.set(key, null(p)?)?;
    }
    Ok(())
}

#[napi]
pub fn battery_guard_owner(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    initialize_state(p)?;
    Ok(fields(
        p,
        &[
            (
                "getStatus",
                function(p, "getStatus", 0, 0, |p, _| {
                    snapshot(p, call(p, c"running", &[])?)
                })?,
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
                    record_attempt(p, a[0])?;
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

fn running(p: L<'_>) -> Result<bool> {
    Ok(!crate::js_iteration::is_null(p.get(c"timer")?)?)
}

fn status(p: L<'_>) -> Result<L<'_>> {
    snapshot(p, flag(p, running(p)?)?)
}

fn sleep_complete<'a>(s: L<'a>, result: L<'a>) -> Result<L<'a>> {
    let p = s.get(c"guard")?;
    record_attempt(p, result)?;
    let logger = p.get(c"logger")?;
    if result.truthy()? && result.get(c"ok")?.truthy()? {
        let percent = s.get(c"percent")?.coerce_string()?.to_string_lossy();
        let trigger = p
            .get(c"thresholds")?
            .get(c"trigger")?
            .coerce_string()?
            .to_string_lossy();
        let method = result.get(c"method")?.coerce_string()?.to_string_lossy();
        call(logger, c"log", &[text(p, &format!(
            "[multicc/battery-guard] battery {percent}% <= {trigger}% while sleep prevention is on -> slept via {method}"
        ))?])?;
    } else {
        call(
            logger,
            c"warn",
            &[
                text(
                    p,
                    "[multicc/battery-guard] battery trigger reached but every sleep method failed",
                )?,
                result,
            ],
        )?;
    }
    complete(p)
}

fn sampled<'a>(p: L<'a>, samples: L<'a>) -> Result<L<'a>> {
    let at = call(p.global()?.get(c"Date")?, c"now", &[])?;
    let decision = observe(p, samples.element(0)?, samples.element(1)?, at)?;
    if !decision.truthy()? {
        return complete(p);
    }
    let sleep_context = fields(p, &[("guard", p), ("percent", decision.get(c"percent")?)])?;
    let power = p.get(c"macosPower")?;
    let result = if power.undefined()? {
        crate::macos_power::sleep_now(p.get(c"host")?, power)?
    } else {
        call(power, c"sleepNow", &[])?
    };
    let pending = call(p.global()?.get(c"Promise")?, c"resolve", &[result])?;
    call(
        pending,
        c"then",
        &[
            function(sleep_context, "", 1, 1, |s, a| {
                let owner = s.get(c"guard")?;
                recover(owner, sleep_complete(s, a[0]))
            })?,
            rejection(p)?,
        ],
    )
}

fn sample(p: L<'_>) -> Result<L<'_>> {
    let power = p.get(c"macosPower")?;
    let (battery, lid) = if power.undefined()? {
        let host = p.get(c"host")?;
        (
            crate::macos_power::read_battery(host, power)?,
            crate::macos_power::lid_prevention(host, power, false)?,
        )
    } else {
        (
            call(power, c"readBattery", &[])?,
            call(power, c"getLidSleepPrevention", &[])?,
        )
    };
    let pair = p.from_value(&V::Array(vec![]))?;
    pair.set_element(0, battery)?;
    pair.set_element(1, lid)?;
    let samples = call(p.global()?.get(c"Promise")?, c"all", &[pair])?;
    call(
        samples,
        c"then",
        &[
            function(p, "", 1, 1, |p, a| recover(p, sampled(p, a[0])))?,
            rejection(p)?,
        ],
    )
}

fn on_failure<'a>(p: L<'a>, error: L<'a>) -> Result<L<'a>> {
    let message = if error.truthy()? && error.get(c"message")?.truthy()? {
        error.get(c"message")?
    } else {
        string(error)?
    };
    p.set(c"error", message)?;
    status(p)
}

fn finish_with_failure<'a>(p: L<'a>, error: L<'a>) -> Result<L<'a>> {
    let status = on_failure(p, error);
    // Preserve the finally clause even when an injected error has a throwing getter.
    if status.is_err() {
        if let Some(exception) = p.exception_value()? {
            p.set(c"checking", flag(p, false)?)?;
            return Err(exception.throw_error());
        }
    }
    p.set(c"checking", flag(p, false)?)?;
    status
}

fn complete(p: L<'_>) -> Result<L<'_>> {
    let state = status(p)?;
    p.set(c"checking", flag(p, false)?)?;
    Ok(state)
}

fn rejection(p: L<'_>) -> Result<L<'_>> {
    function(p, "", 1, 1, |p, a| finish_with_failure(p, a[0]))
}

fn recover<'a>(p: L<'a>, result: Result<L<'a>>) -> Result<L<'a>> {
    let Err(error) = result else {
        return result;
    };
    let cause = match p.exception_value()? {
        Some(cause) => cause,
        None => p
            .global()?
            .get(c"Error")?
            .construct(&[text(p, &error.reason)?])?,
    };
    finish_with_failure(p, cause)
}

fn check(p: L<'_>) -> Result<L<'_>> {
    crate::host_methods::async_result(p, || {
        if p.get(c"checking")?.truthy()? {
            return status(p);
        }
        p.set(c"checking", flag(p, true)?)?;
        recover(p, sample(p))
    })
}

fn start(p: L<'_>) -> Result<L<'_>> {
    let undef = p.from_value(&V::Undefined)?;
    if running(p)? {
        return Ok(undef);
    }
    let tick = function(p, "", 0, 0, |p, _| {
        check(p)?;
        p.from_value(&V::Undefined)
    })?;
    let timer = p
        .get(c"setIntervalFn")?
        .call_plain(&[tick, p.get(c"intervalMs")?])?;
    p.set(c"timer", timer)?;
    check(p)?;
    p.get(c"runtime")
}

fn stop(p: L<'_>) -> Result<L<'_>> {
    if running(p)? {
        p.get(c"clearIntervalFn")?.call_plain(&[p.get(c"timer")?])?;
        p.set(c"timer", null(p)?)?;
    }
    p.from_value(&V::Undefined)
}

fn threshold_pair(p: L<'_>, trigger: f64, rearm: f64) -> Result<L<'_>> {
    fields(
        p,
        &[("trigger", num(p, trigger)?), ("rearm", num(p, rearm)?)],
    )
}

fn runtime<'a>(host: L<'a>, deps: L<'a>, system: bool) -> Result<L<'a>> {
    let deps = if system {
        crate::host_methods::default_object(deps)?
    } else {
        deps
    };
    if deps.kind()? != sys::ValueType::napi_object {
        return Err(host.type_error("battery guard dependencies are required"));
    }
    let power = if system {
        host.from_value(&V::Undefined)?
    } else {
        let power = deps.get(c"macosPower")?;
        if power.kind()? != sys::ValueType::napi_object {
            return Err(host.type_error("battery guard dependency missing: macosPower"));
        }
        for property in [c"readBattery", c"getLidSleepPrevention", c"sleepNow"] {
            if power.get(property)?.kind()? != sys::ValueType::napi_function {
                return Err(host.type_error(&format!(
                    "battery guard dependency missing: macosPower.{}",
                    property.to_string_lossy()
                )));
            }
        }
        power
    };
    let global = host.global()?;
    let default_global = |key, fallback| -> Result<L<'a>> {
        let value = deps.get(key)?;
        if value.undefined()? {
            global.get(fallback)
        } else {
            Ok(value)
        }
    };
    let logger = default_global(c"logger", c"console")?;
    let register = default_global(c"setIntervalFn", c"setInterval")?;
    let cancel = default_global(c"clearIntervalFn", c"clearInterval")?;
    let interval = deps.get(c"intervalMs")?;
    let interval = if interval.undefined()? {
        num(host, 60_000.)?
    } else {
        interval
    };
    let thresholds = deps.get(c"thresholds")?;
    let thresholds = if thresholds.undefined()? {
        threshold_pair(host, 5., 8.)?
    } else {
        thresholds
    };
    if !call(
        host,
        c"ge",
        &[read(thresholds, c"trigger")?, num(host, 1.)?],
    )?
    .truthy()?
        || !call(
            host,
            c"gt",
            &[thresholds.get(c"rearm")?, thresholds.get(c"trigger")?],
        )?
        .truthy()?
    {
        return Err(host.type_error("battery guard thresholds require rearm > trigger >= 1"));
    }
    let p = fields(
        host,
        &[
            ("host", host),
            ("macosPower", power),
            ("logger", logger),
            ("setIntervalFn", register),
            ("clearIntervalFn", cancel),
            ("intervalMs", interval),
            ("thresholds", thresholds),
            ("timer", null(host)?),
            ("ge", host.get(c"ge")?),
            ("le", host.get(c"le")?),
        ],
    )?;
    initialize_state(p)?;
    let api = fields(
        p,
        &[
            ("start", function(p, "start", 0, 0, |p, _| start(p))?),
            ("stop", function(p, "stop", 0, 0, |p, _| stop(p))?),
            ("check", function(p, "check", 0, 0, |p, _| check(p))?),
            (
                "getStatus",
                function(p, "getStatus", 0, 0, |p, _| status(p))?,
            ),
        ],
    )?;
    p.set(c"runtime", api)?;
    Ok(api)
}

#[napi]
pub fn battery_guard_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let host = L::new(&env, ports);
    let never = fields(
        host,
        &[
            ("intervalMs", num(host, 0.)?),
            ("thresholds", threshold_pair(host, 0., 0.)?),
        ],
    )?;
    initialize_state(never)?;
    Ok(fields(
        host,
        &[
            (
                "NEVER_GUARDED_STATUS",
                snapshot(never, flag(never, false)?)?.freeze()?,
            ),
            (
                "createBatteryGuardRuntime",
                function(host, "createBatteryGuardRuntime", 1, 1, |host, args| {
                    runtime(host, args[0], false)
                })?,
            ),
            (
                "createSystemBatteryGuardRuntime",
                function(
                    host,
                    "createSystemBatteryGuardRuntime",
                    0,
                    1,
                    |host, args| runtime(host, args[0], true),
                )?,
            ),
        ],
    )?
    .raw())
}
