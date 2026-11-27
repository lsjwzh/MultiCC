//! A runtime owns its decision Map; user callbacks and their exceptions stay live.
use super::public_api::{decision, load_addon};
use crate::js_live::invoke;
use crate::{
    host_methods::{default_object, function},
    js_iteration::read,
    route_response::*,
};
use std::ffi::CStr;

fn clock_port<'a>(opts: L<'a>, key: &CStr, global: &CStr) -> Result<L<'a>> {
    if read(opts, key)?.kind()? == sys::ValueType::napi_function {
        read(opts, key)
    } else {
        opts.global()?.get(global)?.get(key)
    }
}

fn increment(metrics: L<'_>, name: &str) -> Result<()> {
    invoke(
        metrics,
        read(metrics, c"inc")?,
        &[text(metrics, name)?],
        "metrics.inc",
    )?;
    Ok(())
}

fn log_decision(s: L<'_>, d: L<'_>, ctx: L<'_>) -> Result<()> {
    let error = d.get(c"error")?;
    let record = fields(s, &[])?;
    for key in [
        c"category",
        c"provider",
        c"providerId",
        c"providerName",
        c"providerRouteScope",
        c"runtimeEpoch",
        c"decisionId",
        c"routeAttemptId",
        c"routeGeneration",
        c"attemptNo",
        c"providerRevision",
        c"code",
        c"httpStatus",
        c"phase",
        c"partialOutput",
        c"sideEffects",
        c"safeToRetry",
        c"retryable",
    ] {
        record.set(key, error.get(key)?)?;
    }
    for key in [c"action", c"reason"] {
        record.set(key, d.get(key)?)?;
    }
    for key in [c"delayMs", c"attempt"] {
        record.set(key, fallback(d.get(key)?, V::Number(0.0))?)?;
    }
    for key in [c"maxAttempts", c"rootCause"] {
        record.set(key, error.get(key)?)?;
    }
    let number = s.global()?.get(c"Number")?;
    let elapsed = number
        .call_plain(&[fallback(read(ctx, c"turnElapsedMs")?, V::Number(0.0))?])?
        .number()?;
    record.set(c"turnElapsedMs", num(s, elapsed.max(0.0))?)?;
    record.set(
        c"budgetExhaustedBy",
        fallback(d.get(c"budgetExhaustedBy")?, V::Null)?,
    )?;
    for key in [c"sessionId", c"turnId"] {
        record.set(key, fallback(read(ctx, key)?, V::Null)?)?;
    }
    record.set(c"requestId", error.get(c"requestId")?)?;
    let retry = d.get(c"action")?.is_string("retry")?;
    let logger = s.get(c"logger")?;
    invoke(
        logger,
        read(logger, if retry { c"warn" } else { c"info" })?,
        &[text(s, "api_error_policy_decision")?, record],
        "logger[method]",
    )?;
    let metrics = s.get(c"metrics")?;
    let api = s.get(c"api")?;
    for (prefix, source, key) in [
        ("", error, c"category"),
        ("provider_", error, c"provider"),
        ("decision_", d, c"action"),
    ] {
        let inc = read(metrics, c"inc")?;
        let value = source.get(key)?;
        let token = call(load_addon(api)?, c"apiErrorMetricToken", &[value])?
            .coerce_string()?
            .to_string_lossy();
        invoke(
            metrics,
            inc,
            &[text(
                s,
                &format!("multicc_api_error_{prefix}{token}_total"),
            )?],
            "metrics.inc",
        )?;
    }
    if retry {
        increment(metrics, "multicc_api_error_retry_attempted_total")?;
    }
    if d.get(c"action")?.is_string("fail_fast")? {
        increment(metrics, "multicc_api_error_fail_fast_total")?;
    }
    if d.get(c"reason")?.is_string("retry_budget_exhausted")? {
        increment(metrics, "multicc_api_error_retry_exhausted_total")?;
    }
    Ok(())
}

fn evaluate<'a>(s: L<'a>, raw: L<'a>, ctx: L<'a>) -> Result<L<'a>> {
    let key = if read(ctx, c"idempotencyKey")?.truthy()? {
        string(read(ctx, c"idempotencyKey")?)?
    } else {
        text(s, "")?
    };
    let map = s.get(c"decisions")?;
    if key.truthy()? && call(map, c"has", &[key])?.truthy()? {
        let copy = fields(s, &[])?;
        copy.spread_from(call(map, c"get", &[key])?)?;
        copy.set(c"duplicate", flag(s, true)?)?;
        return copy.freeze();
    }
    let at = s
        .global()?
        .get(c"Number")?
        .call_plain(&[s.get(c"now")?.call_plain(&[])?])?;
    let clock = function(fields(s, &[("at", at)])?, "now", 0, 0, |s, _| s.get(c"at"))?;
    let deps = fields(s, &[("now", clock)])?;
    let api = s.get(c"api")?;
    let normalized = decision(api, raw, ctx, deps, true)?;
    deps.set(c"random", s.get(c"random")?)?;
    let result = decision(api, normalized, ctx, deps, false)?;
    if key.truthy()? {
        call(map, c"set", &[key, result])?;
        if map.get(c"size")?.number()? > 1000.0 {
            let oldest = call(call(map, c"keys", &[])?, c"next", &[])?.get(c"value")?;
            call(map, c"delete", &[oldest])?;
        }
    }
    log_decision(s, result, ctx)?;
    Ok(result)
}

pub(super) fn create<'a>(api: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let now = clock_port(opts, c"now", c"Date")?;
    let random = clock_port(opts, c"random", c"Math")?;
    let noop = function(api, "noop", 0, 0, |s, _| s.from_value(&V::Undefined))?;
    let logger = read(opts, c"logger")?;
    let logger = if logger.truthy()? {
        logger
    } else {
        fields(api, &[("info", noop), ("warn", noop), ("error", noop)])?
    };
    let metrics = read(opts, c"metrics")?;
    let metrics = if metrics.truthy()? {
        metrics
    } else {
        fields(api, &[("inc", noop), ("set", noop)])?
    };
    let map = api.global()?.get(c"Map")?.construct(&[])?;
    let s = fields(
        api,
        &[
            ("api", api),
            ("now", now),
            ("random", random),
            ("decisions", map),
            ("logger", logger),
            ("metrics", metrics),
        ],
    )?;
    fields(
        s,
        &[
            (
                "evaluate",
                function(s, "evaluate", 1, 2, |s, a| {
                    evaluate(s, a[0], default_object(a[1])?)
                })?,
            ),
            (
                "recordSuccess",
                function(s, "recordSuccess", 1, 2, |s, a| {
                    if read(default_object(a[1])?, c"retryAttempt")?.truthy()? {
                        increment(
                            s.get(c"metrics")?,
                            "multicc_api_error_retry_succeeded_total",
                        )?;
                    }
                    s.from_value(&V::Undefined)
                })?,
            ),
            (
                "snapshot",
                function(s, "snapshot", 0, 0, |s, _| {
                    fields(
                        s,
                        &[
                            ("circuits", s.from_value(&V::Array(vec![]))?),
                            ("idempotencyEntries", s.get(c"decisions")?.get(c"size")?),
                        ],
                    )
                })?,
            ),
        ],
    )?
    .freeze()
}
