use crate::{host_methods::function, route_response::*};
use napi_derive::napi;

// The two JS regexes were independent per newline. Dot excludes four line
// terminators and the port's trailing word boundary uses ASCII word characters.
#[napi]
pub fn probe_established(output: String) -> bool {
    output.split('\n').any(|line| {
        line.contains("ESTABLISHED")
            && line.split(['\r', '\u{2028}', '\u{2029}']).any(|part| {
                let Some((_, tail)) = part.split_once("->") else {
                    return false;
                };
                tail.match_indices(':').any(|(i, _)| {
                    let port = &tail[i + 1..];
                    ["443", "80"].iter().any(|s| {
                        port.strip_prefix(s).is_some_and(|rest| {
                            !rest.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')
                        })
                    })
                })
            })
    })
}
fn outbound<'a>(p: L<'a>, pid: L<'a>) -> Result<L<'a>> {
    if !pid
        .number_value()?
        .is_some_and(|n| n > 0. && n.fract() == 0.)
    {
        return call(p, c"inactive", &[]);
    }
    let now = p.get(c"now")?.call_plain(&[])?;
    let cache = p.get(c"outbound")?;
    let entry = call(cache, c"get", &[pid])?;
    if entry.truthy()? && call(p, c"fresh", &[now, entry.get(c"at")?])?.truthy()? {
        return entry.get(c"promise");
    }
    cache.for_each(|pair| {
        let (key, entry) = pair.iterator_pair()?;
        if call(p, c"expired", &[now, entry.get(c"at")?])?.truthy()? {
            call(cache, c"delete", &[key])?;
        }
        Ok(())
    })?;
    let promise = call(p, c"runLsof", &[pid])?;
    call(
        cache,
        c"set",
        &[pid, fields(p, &[("at", now), ("promise", promise)])?],
    )?;
    Ok(promise)
}
fn grew<'a>(p: L<'a>, path: L<'a>) -> Result<L<'a>> {
    if !path.truthy()? {
        return flag(p, false);
    }
    let Some(mtime) = p.catch(|| p.get(c"statMtimeMs")?.call_plain(&[path]))? else {
        return flag(p, false);
    };
    if mtime.nullish()? {
        return flag(p, false);
    }
    let cache = p.get(c"mtimes")?;
    let prev = call(cache, c"get", &[path])?;
    call(cache, c"set", &[path, mtime])?;
    if prev.nullish()? {
        call(p, c"recent", &[mtime])
    } else {
        call(p, c"advanced", &[mtime, prev])
    }
}
#[napi]
pub fn process_probe_signals(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    Ok(fields(
        p,
        &[
            (
                "outboundHttps",
                function(p, "outboundHttps", 1, 1, |p, a| outbound(p, a[0]))?,
            ),
            (
                "rolloutGrew",
                function(p, "rolloutGrew", 1, 1, |p, a| grew(p, a[0]))?,
            ),
        ],
    )?
    .raw())
}
