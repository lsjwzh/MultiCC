//! Live callers see synchronous cache peeks; an outstanding cold peek warms only once.
use super::*;
fn cache_ttl(entry: L<'_>) -> Result<f64> {
    Ok(if entry.optional(c"models")?.truthy()? {
        600_000.0
    } else {
        30_000.0
    })
}
fn list<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let cb = a[0];
    let opts = default_object(a[1])?;
    let entry = p.get(c"cache")?;
    if !opts.get(c"refresh")?.truthy()? && fresh(entry, cache_ttl(entry)?)? {
        let raw = entry.get(c"models")?;
        let source = if raw.truthy()? {
            "cache"
        } else {
            "unavailable"
        };
        return immediate(
            cb,
            &[null(p)?, truthy_or(raw, array(p)?)?, text(p, source)?],
        );
    }
    let s = fields(p, &[("owner", p), ("cb", cb)])?;
    let result = async_result(p, || {
        let pin = truthy_or(call(p, c"accountEnv", &[])?, fields(p, &[])?)?;
        let cwd = call(p.global()?.get(c"process")?, c"cwd", &[])?;
        call(p, c"read", &[pin, cwd, p.get(c"timeout")?])
    })?;
    // Attach success and failure to the same promise. An exception from a client
    // callback must never be treated as a failed probe and called a second time.
    let success = function(s, "", 1, 1, |s, a| {
        let p = s.get(c"owner")?;
        let rows = json_call(p, c"parse", a[0])?;
        cache(p, rows)?;
        s.get(c"cb")?.call_plain(&[null(p)?, rows, text(p, "cli")?])
    })?;
    let failure = function(s, "", 1, 1, |s, _| {
        let p = s.get(c"owner")?;
        cache(p, null(p)?)?;
        s.get(c"cb")?
            .call_plain(&[null(p)?, array(p)?, text(p, "unavailable")?])
    })?;
    call(result, c"then", &[success, failure])?;
    undef(p)
}
fn peek<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let entry = p.get(c"cache")?;
    if fresh(entry, cache_ttl(entry)?)? {
        return call(truthy_or(entry.get(c"models")?, array(p)?)?, c"slice", &[]);
    }
    if !p.get(c"warming")?.truthy()? {
        p.set(c"warming", flag(p, true)?)?;
        let complete = function(p, "", 0, 0, |p, _| {
            p.set(c"warming", flag(p, false)?)?;
            undef(p)
        })?;
        list(p, &mut [complete, undef(p)?])?;
    }
    array(p)
}
pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    let timeout = truthy_or(
        process_env(p)?.get(c"AGY_MODELS_TIMEOUT_MS")?,
        num(p, 25_000.0)?,
    )?;
    p.set(c"timeout", num(p, timeout.number()?)?)?;
    let out = methods(
        p,
        &[
            ("peekAgyModels", 0, peek),
            ("_modelOptionsForTest", 1, |p, a| {
                from_json(p, &Value::Array(kernel::agy_rows(&live_json(a[0])?)))
            }),
            ("_resetCacheForTest", 0, |p, a| {
                p.set(c"warming", flag(p, false)?)?;
                reset_cache(p, a)
            }),
        ],
    )?;
    reg(out, p, "listAgyModels", 1, 2, list)?;
    Ok(out)
}
