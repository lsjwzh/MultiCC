use crate::{host_methods::function, js_iteration::read, route_response::*};
use napi_derive::napi;

fn scan<'a>(p: L<'a>, dir: L<'a>, session: L<'a>) -> Result<L<'a>> {
    let mut stack = vec![dir];
    while let Some(dir) = stack.pop() {
        let Some(entries) = p.catch(|| call(p, c"entries", &[dir]))? else {
            continue;
        };
        let mut found = None;
        entries.for_each_while(|entry| {
            let path = call(p, c"join", &[dir, entry])?;
            if call(entry, c"isDirectory", &[])?.truthy()? {
                stack.push(path);
            } else if call(entry, c"isFile", &[])?.truthy()?
                && call(read(entry, c"name")?, c"includes", &[session])?.truthy()?
                && call(read(entry, c"name")?, c"endsWith", &[text(p, ".jsonl")?])?.truthy()?
            {
                found = Some(path);
                return Ok(false);
            }
            Ok(true)
        })?;
        if let Some(path) = found {
            return Ok(path);
        }
    }
    null(p)
}
fn resolve<'a>(p: L<'a>, record: L<'a>) -> Result<L<'a>> {
    if !record.truthy()? {
        return null(p);
    }
    let cli = read(record, c"cli")?;
    if !(cli.is_string("codex")? || cli.is_string("codex-exp")?)
        || !read(record, c"cliSessionId")?.truthy()?
    {
        return null(p);
    }
    let dir = p.get(c"sessionsDirFor")?.call_plain(&[record])?;
    if !dir.truthy()? {
        return null(p);
    }
    let key = call(p, c"key", &[dir, record])?;
    let cache = p.get(c"cache")?;
    let cached = call(cache, c"get", &[key])?;
    if cached.truthy()? {
        let path = cached.get(c"path")?;
        if path.truthy()? {
            if call(p, c"exists", &[path])?.truthy()? {
                return Ok(path);
            }
        } else if call(p, c"fresh", &[cached.get(c"at")?])?.truthy()? {
            return null(p);
        }
        call(cache, c"delete", &[key])?;
    }
    let path = if call(p, c"exists", &[dir])?.truthy()? {
        scan(p, dir, read(record, c"cliSessionId")?)?
    } else {
        null(p)?
    };
    let entry = fields(
        p,
        &[("path", path), ("at", p.get(c"now")?.call_plain(&[])?)],
    )?;
    call(cache, c"set", &[key, entry])?;
    Ok(path)
}
#[napi]
pub fn rollout_resolver(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    Ok(fields(
        p,
        &[
            (
                "resolve",
                function(p, "resolve", 1, 1, |p, a| {
                    Ok(p.catch(|| resolve(p, a[0]))?.unwrap_or(null(p)?))
                })?,
            ),
            (
                "forget",
                function(p, "forget", 1, 1, |p, a| {
                    let record = a[0];
                    if record.truthy()? && read(record, c"cliSessionId")?.truthy()? {
                        if let Some(dir) =
                            p.catch(|| p.get(c"sessionsDirFor")?.call_plain(&[record]))?
                        {
                            if dir.truthy()? {
                                let key = call(p, c"key", &[dir, record])?;
                                call(p.get(c"cache")?, c"delete", &[key])?;
                            }
                        }
                    }
                    p.from_value(&V::Undefined)
                })?,
            ),
        ],
    )?
    .raw())
}
