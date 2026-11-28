use super::*;

fn verify_ready<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    if stopped(s)? {
        return Err(issue(s, "air_closed")?.throw_error());
    }
    if call(s.get(c"index")?, c"isReady", &[])?.truthy()? {
        return undef(s);
    }
    let problem = current_issue(s)?;
    if !problem.truthy()? {
        return Err(issue(s, "air_warming")?.throw_error());
    }
    let e = s
        .global()?
        .get(c"Error")?
        .construct(&[problem.get(c"message")?])?;
    let code = problem.get(c"code")?;
    e.set(c"code", code)?;
    let disk_full = code.is_string("ENOSPC")? || code.is_string("SQLITE_FULL")?;
    e.set(c"status", num(s, if disk_full { 507. } else { 503. })?)?;
    Err(e.throw_error())
}
pub(super) fn ensure_ready<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(s, || {
        if stopped(s)? {
            return Err(issue(s, "air_closed")?.throw_error());
        }
        if !call(s.get(c"index")?, c"isReady", &[])?.truthy()? {
            let active = s.get(c"inFlight")?;
            if active.truthy()? || clock(s)? >= as_number(s, c"retryAt")? {
                let pending = if active.truthy()? {
                    active
                } else {
                    producer::flush(s)?
                };
                return then(pending, s, verify_ready);
            }
        }
        verify_ready(s, &mut [])
    })
}
fn await_metadata(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"s")?;
    let required = as_number(f, c"required")?;
    if as_number(s, c"publishedMetadataVersion")? >= required {
        return undef(s);
    }
    let end = as_number(f, c"deadline")?;
    if stopped(s)? || s.get(c"lastError")?.truthy()? || clock(s)? >= end {
        return Err(issue(s, "air_refresh_pending")?.throw_error());
    }
    let done = then(producer::flush(s)?, s, |s, _| flag(s, true))?;
    let executor = function(f, "", 2, 2, |f, a| {
        let finish = function(a[0], "", 0, 0, |resolve, _| {
            resolve.call_plain(&[flag(resolve, false)?])
        })?;
        let ms = (as_number(f, c"deadline")? - clock(f)?).max(1.);
        let timer = f
            .global()?
            .get(c"setTimeout")?
            .call_plain(&[finish, num(f, ms)?])?;
        f.set(c"timer", timer)?;
        undef(f)
    })?;
    let promise = s.global()?.get(c"Promise")?;
    let timeout = promise.construct(&[executor])?;
    let items = array(s)?;
    items.set_element(0, done)?;
    items.set_element(1, timeout)?;
    let race = call(promise, c"race", &[items])?;
    let clear = function(f, "", 0, 0, |f, _| {
        producer::clear(f, f.get(c"timer")?)?;
        undef(f)
    })?;
    then(call(race, c"finally", &[clear])?, f, |f, a| {
        let s = f.get(c"s")?;
        if !a[0].truthy()?
            || stopped(s)?
            || (s.get(c"lastError")?.truthy()?
                && as_number(s, c"publishedMetadataVersion")? < as_number(f, c"required")?)
        {
            return Err(issue(s, "air_refresh_pending")?.throw_error());
        }
        await_metadata(f)
    })
}
fn metadata<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let f = fields(
        s,
        &[
            ("s", s),
            ("required", s.get(c"metadataVersion")?),
            ("deadline", num(s, clock(s)? + 2000.)?),
        ],
    )?;
    await_metadata(f)
}
pub(super) fn ready(s: L<'_>) -> Result<L<'_>> {
    then(ensure_ready(s, &mut [])?, s, metadata)
}
pub(super) fn read_sync<'a>(s: L<'a>, since: L<'a>, day: L<'a>) -> Result<L<'a>> {
    let index = s.get(c"index")?;
    let sync = index.get(c"sync")?;
    if sync.truthy()? {
        return sync.call(index, &[since, day]);
    }
    let f = fields(s, &[("index", index), ("day", day)])?;
    then(call(index, c"changes", &[since])?, f, |f, a| {
        let data = spread(a[0])?;
        let result = call(f.get(c"index")?, c"stats", &[f.get(c"day")?])?;
        then(result, data, |data, a| {
            data.set(c"taskStats", a[0])?;
            Ok(data)
        })
    })
}
pub(super) fn day_value(v: L<'_>) -> Result<L<'_>> {
    let d = num(v, v.explicit_number()?)?;
    fallback(d, V::Number(0.))
}
fn csv(v: L<'_>) -> Result<L<'_>> {
    let parts = call(string(v)?, c"split", &[text(v, ",")?])?;
    call(parts, c"filter", &[v.global()?.get(c"Boolean")?])
}
pub(super) fn query<'a>(s: L<'a>, arguments: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(s, || {
        let args = array(s)?;
        for (i, arg) in arguments.iter().skip(1).enumerate() {
            args.set_element(i as u32, *arg)?;
        }
        let f = fields(
            s,
            &[
                ("s", s),
                ("method", arguments.first().copied().unwrap_or(undef(s)?)),
                ("args", args),
            ],
        )?;
        then(ready(s)?, f, |f, _| {
            serial(
                f.get(c"s")?,
                f,
                |f, _| {
                    let index = f.get(c"s")?.get(c"index")?;
                    call(
                        f.global()?.get(c"Reflect")?,
                        c"apply",
                        &[index.get_key(f.get(c"method")?)?, index, f.get(c"args")?],
                    )
                },
                false,
            )
        })
    })
}
pub(super) fn sync_http<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(s, || {
        let f = fields(s, &[("s", s), ("q", default_object(a[0])?)])?;
        then(ready(s)?, f, |f, _| {
            let s = f.get(c"s")?;
            f.set(c"day", day_value(f.get(c"q")?.get(c"dayStart")?)?)?;
            serial(
                s,
                f,
                |f, _| {
                    let s = f.get(c"s")?;
                    let q = f.get(c"q")?;
                    let day = f.get(c"day")?;
                    let result = if q.get(c"cursor")?.truthy()? {
                        read_sync(s, q.get(c"cursor")?, day)?
                    } else {
                        let options = fields(
                            f,
                            &[
                                ("include", csv(fallback(q.get(c"include")?, "".into())?)?),
                                ("dayStart", day),
                            ],
                        )?;
                        call(s.get(c"index")?, c"bootstrap", &[options])?
                    };
                    then(result, s, |s, a| {
                        let data = spread(a[0])?;
                        data.set(c"checkedAt", s.get(c"checkedAt")?)?;
                        data.spread_from(status(s)?)?;
                        Ok(data)
                    })
                },
                false,
            )
        })
    })
}
pub(super) fn page_http<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(s, || {
        let q = default_object(a[0])?;
        let visits = s
            .catch(|| {
                let raw = string(fallback(q.get(c"visits")?, "{}".into())?)?;
                json_call(
                    s,
                    c"parse",
                    call(raw, c"slice", &[num(s, 0.)?, num(s, 10000.)?])?,
                )
            })?
            .unwrap_or(fields(s, &[])?);
        let opts = spread(q)?;
        opts.set(c"visits", visits)?;
        opts.set(
            c"ids",
            if q.get(c"ids")?.undefined()? {
                null(s)?
            } else {
                csv(q.get(c"ids")?)?
            },
        )?;
        query(s, &mut [text(s, "page")?, opts])
    })
}
