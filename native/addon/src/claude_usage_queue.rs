//! One cache per CommonJS module instance. The same live Promise is returned
//! to joiners; eviction uses the reading's timestamp, not insertion time.
use crate::{host_methods::function, js_iteration::read, route_response::*};
use napi_derive::napi;
const DEFAULT: &str = "claude:default";
fn key(v: L<'_>) -> Result<L<'_>> {
    fallback(v, DEFAULT.into())
}
fn finish<'a>(p: L<'a>, name: L<'a>, result: L<'a>) -> Result<L<'a>> {
    call(p.get(c"inflight")?, c"delete", &[name])?;
    let map = p.get(c"entries")?;
    let result = if result.kind()? == sys::ValueType::napi_object {
        result
    } else {
        null(p)?
    };
    let entry = fields(p, &[("result", result), ("at", call(p, c"now", &[])?)])?;
    call(map, c"set", &[name, entry])?;
    if map.get(c"size")?.number()? > 50. {
        let mut oldest = null(p)?;
        let mut at = num(p, f64::INFINITY)?;
        map.for_each(|pair| {
            let (key, entry) = pair.iterator_pair()?;
            if call(p, c"before", &[read(entry, c"at")?, at])?.truthy()? {
                at = read(entry, c"at")?;
                oldest = key;
            }
            Ok(())
        })?;
        if !oldest.nullish()? {
            call(map, c"delete", &[oldest])?;
        }
    }
    Ok(entry)
}
fn enqueue<'a>(p: L<'a>, name: L<'a>) -> Result<L<'a>> {
    let flights = p.get(c"inflight")?;
    let open = call(flights, c"get", &[name])?;
    if open.truthy()? {
        return Ok(open);
    }
    let cached = call(p.get(c"entries")?, c"get", &[name])?;
    let fresh = cached.truthy()?
        && read(cached, c"result")?.truthy()?
        && read(read(cached, c"result")?, c"status")?.is_string("ok")?
        && call(p, c"fresh", &[cached])?.truthy()?;
    if fresh || !p.get(c"configured")?.truthy()? {
        return call(p, c"resolved", &[fallback(cached, V::Null)?]);
    }
    let id = if name.is_string(DEFAULT)? {
        text(p, "")?
    } else {
        call(p, c"account", &[name])?
    };
    let promise = call(p, c"fetch", &[name, id])?;
    call(flights, c"set", &[name, promise])?;
    Ok(promise)
}
#[napi]
pub fn claude_usage_cache(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    Ok(fields(
        p,
        &[
            (
                "read",
                function(p, "readClaudeUsage", 1, 1, |p, a| {
                    fallback(call(p.get(c"entries")?, c"get", &[key(a[0])?])?, V::Null)
                })?,
            ),
            (
                "enqueue",
                function(p, "enqueueClaudeUsage", 1, 1, |p, a| enqueue(p, key(a[0])?))?,
            ),
            (
                "finish",
                function(p, "finish", 2, 2, |p, a| finish(p, a[0], a[1]))?,
            ),
        ],
    )?
    .raw())
}
