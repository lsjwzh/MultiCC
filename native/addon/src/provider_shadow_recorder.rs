//! A shadow report is observed synchronously. Metric sinks and structured
//! logging remain host-owned; only the selected diagnostic fields reach them.
use crate::{host_methods::function, js_iteration::read, js_live::invoke, route_response::*};
use napi_derive::napi;
use std::ffi::CStr;

// The legacy report accepts falsy values in addition to the frozen objects
// normally supplied by the router.
fn property<'a>(value: L<'a>, key: &CStr) -> Result<L<'a>> {
    if value.truthy()? {
        read(value, key)
    } else {
        Ok(value)
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

fn difference_paths<'a>(report: L<'a>, mapper: L<'a>) -> Result<L<'a>> {
    if !property(report, c"differences")?.is_array()? {
        return report.from_value(&V::Array(Vec::new()));
    }
    let differences = read(report, c"differences")?;
    let mapped = invoke(
        differences,
        read(differences, c"map")?,
        &[mapper],
        "report.differences.map",
    )?;
    let filter = read(mapped, c"filter")?;
    invoke(
        mapped,
        filter,
        &[report.global()?.get(c"Boolean")?],
        "report.differences.map(...).filter",
    )
}

fn binding(report: L<'_>) -> Result<L<'_>> {
    if !property(report, c"binding")?.truthy()? {
        return null(report);
    }
    let result = fields(report, &[])?;
    for key in [
        c"sessionId",
        c"cli",
        c"providerId",
        c"roleKind",
        c"agentRole",
        c"routeName",
    ] {
        let value = read(read(report, c"binding")?, key)?;
        result.define_key(text(report, key.to_str().expect("static field"))?, value)?;
    }
    Ok(result)
}

fn error_fields(report: L<'_>) -> Result<L<'_>> {
    if !property(report, c"error")?.truthy()? {
        return null(report);
    }
    let code = fallback(read(read(report, c"error")?, c"code")?, V::Null)?;
    fields(
        report,
        &[
            ("code", code),
            ("message", text(report, "CPR shadow evaluation failed")?),
        ],
    )
}

fn record<'a>(host: L<'a>, report: L<'a>) -> Result<L<'a>> {
    let metrics = host.get(c"metrics")?;
    increment(metrics, "multicc_provider_router_shadow_comparisons_total")?;
    if !report.truthy()? || read(report, c"error")?.truthy()? {
        increment(metrics, "multicc_provider_router_shadow_errors_total")?;
    }
    if report.truthy()?
        && !read(report, c"equal")?.truthy()?
        && !read(report, c"error")?.truthy()?
    {
        increment(metrics, "multicc_provider_router_shadow_differences_total")?;
    }
    let paths = difference_paths(report, host.get(c"mapper")?)?;
    let operation = string(fallback(
        property(report, c"operation")?,
        V::from("unknown"),
    )?)?;
    let details = fields(
        report,
        &[
            ("operation", operation),
            (
                "equal",
                flag(report, property(report, c"equal")?.truthy()?)?,
            ),
            ("differenceCount", read(paths, c"length")?),
            (
                "differencePaths",
                call(paths, c"slice", &[num(report, 0.)?, num(report, 100.)?])?,
            ),
            ("binding", binding(report)?),
            ("error", error_fields(report)?),
        ],
    )?;
    let logger = host.get(c"logger")?;
    let equal = property(report, c"equal")?.truthy()?;
    let sink = read(logger, if equal { c"info" } else { c"warn" })?;
    let event = if equal {
        "provider_router_shadow_comparison"
    } else if property(report, c"error")?.truthy()? {
        "provider_router_shadow_error"
    } else {
        "provider_router_shadow_difference"
    };
    invoke(
        logger,
        sink,
        &[text(logger, event)?, details],
        if equal { "logger.info" } else { "logger.warn" },
    )?;
    report.from_value(&V::Undefined)
}

#[napi]
pub fn create_provider_shadow_recorder(
    env: Env,
    metrics: Unknown<'_>,
    logger: Unknown<'_>,
) -> Result<sys::napi_value> {
    let metrics = L::new(&env, metrics);
    let mapper = function(metrics, "", 1, 1, |_, args| {
        string(fallback(property(args[0], c"path")?, V::from(""))?)
    })?;
    let host = fields(
        metrics,
        &[
            ("metrics", metrics),
            ("logger", L::new(&env, logger)),
            ("mapper", mapper),
        ],
    )?;
    Ok(function(
        host,
        "recordProviderRouterShadowComparison",
        1,
        1,
        |host, args| record(host, args[0]),
    )?
    .raw())
}
