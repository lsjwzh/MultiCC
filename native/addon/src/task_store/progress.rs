//! Project the task store's migration journal for the compatibility readiness page.
//! The worker owns the clock and file stat. Read both lazily: after the backup is
//! renamed the journal's completed count takes precedence over the partial file.
use crate::js_live::LiveValue;
use multicc_core::js::JsValue;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn task_store_progress_steps(env: Env) -> Result<sys::napi_value> {
    let phases = [
        ("backup", 0, 15, "backup"),
        ("scan", 15, 20, "migrate"),
        ("rewrite", 20, 75, "migrate"),
        ("compact", 75, 85, "migrate"),
        ("ledger", 85, 90, "migrate"),
        ("vacuum", 90, 99, "vacuum"),
    ];
    let steps = JsValue::object(
        phases
            .into_iter()
            .map(|(phase, from, to, step)| {
                (
                    phase,
                    JsValue::object(vec![
                        ("from", JsValue::Number(from as f64)),
                        ("to", JsValue::Number(to as f64)),
                        ("step", JsValue::string(step)),
                    ]),
                )
            })
            .collect(),
    );
    unsafe { crate::js_bridge::write_value(env.raw(), &steps) }
}

fn number_or_zero(value: LiveValue<'_>) -> Result<f64> {
    let n = value.explicit_number()?;
    Ok(if n.is_nan() || n == 0.0 { 0.0 } else { n })
}

fn fraction(state: LiveValue<'_>, stat: LiveValue<'_>) -> Result<f64> {
    let backup = state.get(c"phase")?.is_string("backup")?;
    let total = number_or_zero(state.get(c"total")?)?;
    let ratio = if total > 0.0 {
        let done = number_or_zero(state.get(c"done")?)?;
        let divisor = if backup {
            state.get(c"total")?.explicit_number()?
        } else {
            total
        };
        done / divisor
    } else if backup {
        let bytes = number_or_zero(state.get(c"dbBytes")?)?;
        if bytes == 0.0 || !state.get(c"backupPartial")?.truthy()? {
            return Ok(0.0);
        }
        stat.call_plain(&[state.get(c"backupPartial")?])?.number()? / bytes
    } else {
        return Ok(0.0);
    };
    // Math.min(1, NaN) is NaN.
    Ok(if ratio > 1.0 { 1.0 } else { ratio })
}

fn failed_view(view: LiveValue<'_>, state: LiveValue<'_>, failure: LiveValue<'_>) -> Result<()> {
    const FALLBACK: &str = "task_store_migration_failed";
    let reason = failure.get(c"error")?;
    let reason = if reason.truthy()? {
        reason
    } else {
        failure.get(c"message")?
    };
    let reason = if reason.truthy()? {
        reason
    } else {
        state.from_value(&JsValue::string(FALLBACK))?
    };
    let message = reason
        .global()?
        .get(c"String")?
        .call_plain(&[reason])?
        .string()?
        .unwrap();
    let colon = message
        .as_units()
        .iter()
        .position(|&u| u == b':' as u16)
        .unwrap_or(message.len());
    let code = message.slice_units(0, colon).trim();
    let error = state.from_value(&JsValue::object(vec![
        (
            "code",
            if code.is_empty() {
                JsValue::string(FALLBACK)
            } else {
                JsValue::String(code)
            },
        ),
        ("message", JsValue::String(message)),
    ]))?;
    for field in [c"needBytes", c"freeBytes"] {
        if state
            .optional(field)?
            .number_value()?
            .is_some_and(f64::is_finite)
        {
            error.set(field, state.get(field)?)?;
        }
    }
    if failure.get(c"retrying")?.truthy()? {
        error.set(c"retrying", state.from_value(&JsValue::Bool(true))?)?;
    }
    let failed = state.from_value(&JsValue::string("failed"))?;
    view.set(c"state", failed)?;
    view.set(c"step", failed)?;
    view.set(c"error", error)
}

fn nonnegative(n: f64) -> f64 {
    if n <= 0.0 {
        0.0
    } else {
        n
    }
}

#[napi]
pub fn describe_task_store_migration(
    env: Env,
    state: Unknown<'_>,
    now: Unknown<'_>,
    stat_size: Unknown<'_>,
    failure: Unknown<'_>,
    steps: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(describe(
        LiveValue::new(&env, state),
        LiveValue::new(&env, now),
        LiveValue::new(&env, stat_size),
        LiveValue::new(&env, failure),
        LiveValue::new(&env, steps),
    )?
    .raw())
}
fn describe<'a>(
    state: LiveValue<'a>,
    now: LiveValue<'a>,
    stat_size: LiveValue<'a>,
    failure: LiveValue<'a>,
    steps: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
    let started = number_or_zero(state.optional(c"startedAt")?)?;
    let elapsed = if started == 0.0 {
        0.0
    } else {
        nonnegative(now.number()? - started)
    };
    let view = state.from_value(&JsValue::object(vec![
        ("state", JsValue::string("running")),
        ("step", JsValue::string("starting")),
        ("percent", JsValue::Number(0.0)),
        (
            "startedAt",
            if started == 0.0 {
                JsValue::Null
            } else {
                JsValue::Number(started)
            },
        ),
        ("elapsedMs", JsValue::Number(elapsed)),
    ]))?;
    if failure.truthy()? {
        failed_view(view, state, failure)?;
    } else if state.optional(c"phase")?.is_string("failed")? {
        let failure = state.from_value(&JsValue::Object(vec![]))?;
        failure.set(c"error", state.get(c"error")?)?;
        failed_view(view, state, failure)?;
    } else {
        let weight = steps.get_key(state.optional(c"phase")?)?;
        if !weight.truthy()? {
            return Ok(view);
        }
        let mut part = fraction(state, stat_size)?;
        if state.get(c"phase")?.is_string("vacuum")? {
            let updated = number_or_zero(state.get(c"updatedAt")?)?;
            let since = nonnegative(
                now.number()?
                    - if updated == 0.0 {
                        now.number()?
                    } else {
                        updated
                    },
            );
            part = 1.0 - (-since / 8000.0).exp();
        }
        let start = weight.get(c"from")?.number()?;
        let span = weight.get(c"to")?.number()? - weight.get(c"from")?.number()?;
        view.set(c"step", weight.get(c"step")?)?;
        view.set(c"phase", state.get(c"phase")?)?;
        view.set(
            c"percent",
            state.from_value(&JsValue::Number((start + span * part).floor()))?,
        )?;
        if state.get(c"total")?.truthy()? {
            view.set(c"done", state.get(c"done")?)?;
            view.set(c"total", state.get(c"total")?)?;
        }
    }
    Ok(view)
}

#[napi]
pub fn task_store_progress_api(env: Env) -> Result<sys::napi_value> {
    use crate::{host_methods::method, route_response::*};
    let steps = L::from_raw(env.raw(), task_store_progress_steps(env)?);
    let zero = method(&env, steps, "statSize", 0, 0, |s, _| num(s, 0.))?;
    let owner = fields(steps, &[("steps", steps), ("zero", zero)])?;
    let describe = method(&env, owner, "describeMigration", 1, 2, |s, a| {
        let opts = if a[1].undefined()? {
            fields(s, &[])?
        } else {
            a[1]
        };
        let now = opts.get(c"now")?;
        let now = if now.undefined()? {
            call(s.global()?.get(c"Date")?, c"now", &[])?
        } else {
            now
        };
        let stat = opts.get(c"statSize")?;
        let stat = if stat.undefined()? {
            s.get(c"zero")?
        } else {
            stat
        };
        let failure = opts.get(c"failure")?;
        describe(
            a[0],
            now,
            stat,
            if failure.undefined()? {
                null(s)?
            } else {
                failure
            },
            s.get(c"steps")?,
        )
    })?;
    Ok(fields(steps, &[("STEPS", steps), ("describeMigration", describe)])?.raw())
}
