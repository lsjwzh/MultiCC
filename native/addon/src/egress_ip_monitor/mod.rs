//! Isolate-local egress-IP health and synchronous cache. Only Node's HTTPS
//! streams, timers, injected clock/fetcher and factory inputs are live ports.
use crate::{host_api::*, js_iteration::read};
use napi_derive::napi;
mod detector;
mod fetch;

fn option<'a>(
    opts: L<'a>,
    key: &std::ffi::CStr,
    default: impl FnOnce() -> Result<L<'a>>,
) -> Result<L<'a>> {
    let v = read(opts, key)?;
    if v.undefined()? {
        default()
    } else {
        Ok(v)
    }
}
fn date_now(p: L<'_>) -> Result<L<'_>> {
    p.global()?.get(c"Date")?.get(c"now")?.call_plain(&[])
}
fn cache_success<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let ip = read(a[0], c"ip")?;
    let source = read(a[0], c"source")?;
    let next = fields(
        p,
        &[
            ("ip", ip),
            ("checkedAt", date_now(p)?),
            ("error", null(p)?),
            ("source", source),
        ],
    )?;
    p.set(c"cache", next)?;
    Ok(next)
}
fn cache_failure<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let previous = p.get(c"cache")?;
    let err = a[0];
    let message = read(err, c"message")?;
    let next = fields(
        p,
        &[
            ("ip", previous.get(c"ip")?),
            ("checkedAt", previous.get(c"checkedAt")?),
            (
                "error",
                if message.truthy()? {
                    message
                } else {
                    string(err)?
                },
            ),
            ("source", previous.get(c"source")?),
        ],
    )?;
    p.set(c"cache", next)?;
    Ok(next)
}
fn refresh(p: L<'_>) -> Result<L<'_>> {
    let pending = p.get(c"inFlight")?;
    if pending.truthy()? {
        return Ok(pending);
    }
    let result = call(p.get(c"detector")?, c"detect", &[])?;
    let result = then(result, p, cache_success)?;
    let result = recover(result, p, cache_failure)?;
    let cleanup = function(p, "", 0, 0, |p, _| {
        p.set(c"inFlight", null(p)?)?;
        undef(p)
    })?;
    let result = call(result, c"finally", &[cleanup])?;
    p.set(c"inFlight", result)?;
    Ok(result)
}
fn tick<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    ignored(p, || refresh(p))?;
    undef(p)
}
fn start<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if p.get(c"timer")?.truthy()? {
        return undef(p);
    }
    let opts = default_object(a[0])?;
    let ms = if read(opts, c"intervalMs")?.explicit_number()? > 0. {
        read(opts, c"intervalMs")?.explicit_number()?
    } else {
        2000.
    };
    tick(p, &mut [])?;
    let timer = p
        .global()?
        .get(c"setInterval")?
        .call_plain(&[function(p, "", 0, 0, tick)?, num(p, ms)?])?;
    p.set(c"timer", timer)?;
    if timer.get(c"unref")?.truthy()? {
        call(timer, c"unref", &[])?;
    }
    undef(p)
}
fn stop<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let timer = p.get(c"timer")?;
    if timer.truthy()? {
        p.global()?.get(c"clearInterval")?.call_plain(&[timer])?;
        p.set(c"timer", null(p)?)?;
    }
    undef(p)
}
#[napi]
pub fn egress_ip_monitor_api(env: Env, https: Unknown<'_>) -> Result<sys::napi_value> {
    let https = L::new(&env, https);
    let candidates = fetch::candidates(https)?;
    let empty = null(https)?;
    let cache = fields(
        https,
        &[
            ("ip", empty),
            ("checkedAt", empty),
            ("error", empty),
            ("source", empty),
        ],
    )?;
    let state = fields(
        https,
        &[
            ("candidates", candidates),
            (
                "fetch",
                function(https, "fetchCandidate", 1, 2, fetch::candidate)?,
            ),
            ("cache", cache),
            ("inFlight", empty),
            ("timer", empty),
        ],
    )?;
    state.set(c"detector", detector::create(state, fields(state, &[])?)?)?;
    let out = fields(state, &[("CANDIDATES", candidates)])?;
    out.spread_from(defaulted_methods(
        state,
        &[
            ("createDetector", 0, 1, |p, a| {
                detector::create(p, default_object(a[0])?)
            }),
            ("getEgressIpSources", 0, 0, |p, _| {
                call(p.get(c"detector")?, c"snapshot", &[])
            }),
            ("isValidIp", 1, 1, |p, a| flag(p, fetch::valid(a[0])?)),
            ("getCachedEgressIp", 0, 0, |p, _| spread(p.get(c"cache")?)),
            ("refreshEgressIpNow", 0, 0, |p, _| refresh(p)),
            ("ensureMonitorStarted", 0, 1, start),
            ("stopEgressIpMonitor", 0, 0, stop),
        ],
    )?)?;
    Ok(out.raw())
}
