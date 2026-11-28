use super::*;

pub(super) fn clear<'a>(s: L<'a>, timer: L<'a>) -> Result<()> {
    s.global()?.get(c"clearTimeout")?.call_plain(&[timer])?;
    Ok(())
}
pub(super) fn schedule(s: L<'_>, requested: f64) -> Result<()> {
    let delay = requested.max(as_number(s, c"retryAt")? - clock(s)?);
    if stopped(s)? || (s.get(c"timer")?.truthy()? && as_number(s, c"dueAt")? <= clock(s)? + delay) {
        return Ok(());
    }
    clear(s, s.get(c"timer")?)?;
    s.set(c"dueAt", num(s, clock(s)? + delay)?)?;
    let tick = function(s, "", 0, 0, |s, _| {
        s.set(c"timer", null(s)?)?;
        s.set(c"dueAt", num(s, f64::INFINITY)?)?;
        flush(s)?;
        undef(s)
    })?;
    let timer = s
        .global()?
        .get(c"setTimeout")?
        .call_plain(&[tick, num(s, delay)?])?;
    s.set(c"timer", timer)?;
    let unref = timer.get(c"unref")?;
    if !unref.nullish()? {
        unref.call(timer, &[])?;
    }
    Ok(())
}
fn published<'a>(f: L<'a>, event: L<'a>, stats: L<'a>) -> Result<L<'a>> {
    let s = f.get(c"s")?;
    if stopped(s)? {
        return undef(s);
    }
    s.set(c"checkedAt", num(s, clock(s)?)?)?;
    s.set(c"lastError", null(s)?)?;
    s.set(c"retryAt", num(s, 0.)?)?;
    if !event.truthy()? {
        return undef(s);
    }
    s.get(c"clients")?.for_each(|pair| {
        let socket = pair.element(0)?;
        let day = pair.element(1)?;
        if socket.get(c"readyState")?.is_number(1.)? {
            let sent = s.catch(|| {
                let data = spread(event)?;
                data.set(c"taskStats", call(stats, c"get", &[day])?)?;
                s.get(c"send")?.call_plain(&[socket, data])
            })?;
            if sent.is_none() {
                clients::try_close(s, socket, &[])?;
            }
        }
        Ok(())
    })?;
    undef(s)
}
fn legacy_stats(f: L<'_>) -> Result<L<'_>> {
    let i = as_number(f, c"i")? as u32;
    let days = f.get(c"days")?;
    if i >= days.get(c"length")?.number()? as u32 {
        return published(f, f.get(c"event")?, f.get(c"stats")?);
    }
    let day = days.element(i)?;
    f.set(c"day", day)?;
    f.set(c"i", num(f, i as f64 + 1.)?)?;
    let r = call(f.get(c"s")?.get(c"index")?, c"stats", &[day])?;
    then(r, f, |f, a| {
        call(f.get(c"stats")?, c"set", &[f.get(c"day")?, a[0]])?;
        legacy_stats(f)
    })
}
fn publish<'a>(f: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let s = f.get(c"s")?;
    let index = s.get(c"index")?;

    let distinct =
        s.global()?
            .get(c"Set")?
            .construct(&[call(s.get(c"clients")?, c"values", &[])?])?;
    let days = list(s, distinct)?;
    let snap = f.get(c"snapshot")?;
    let options = f.get(c"options")?;
    let publish = index.get(c"publish")?;
    if publish.truthy()? {
        return then(publish.call(index, &[snap, options, days])?, f, |f, a| {
            let row = a[0];
            let event = row.get(c"event")?;
            let stats = f.global()?.get(c"Map")?.construct(&[row.get(c"stats")?])?;
            published(f, event, stats)
        });
    }
    f.set(c"days", days)?;
    then(call(index, c"apply", &[snap, options])?, f, |f, a| {
        f.set(c"event", a[0])?;
        f.set(c"i", num(f, 0.)?)?;
        f.set(c"stats", f.global()?.get(c"Map")?.construct(&[])?)?;
        legacy_stats(f)
    })
}
fn built<'a>(f: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let s = f.get(c"s")?;
    if stopped(s)? {
        return undef(s);
    }
    let snapshot = a[0];
    let present = s.global()?.get(c"Set")?.construct(&[])?;
    snapshot.get(c"tasks")?.for_each(|t| {
        call(present, c"add", &[t.get(c"id")?])?;
        Ok(())
    })?;
    let all = f.get(c"full")?.truthy()?;
    let removed = array(f)?;
    if !all {
        f.get(c"ids")?.for_each(|id| {
            if !call(present, c"has", &[id])?.truthy()? {
                call(removed, c"push", &[id])?;
            }
            Ok(())
        })?;
    }
    f.set(
        c"options",
        fields(s, &[("partial", flag(s, !all)?), ("removed", removed)])?,
    )?;
    f.set(c"snapshot", snapshot)?;
    then(serial(s, f, publish, true)?, f, |f, _| {
        let s = f.get(c"s")?;
        s.set(
            c"publishedMetadataVersion",
            num(
                s,
                as_number(s, c"publishedMetadataVersion")?.max(as_number(f, c"version")?),
            )?,
        )?;
        s.set(c"checkedAt", num(s, clock(s)?)?)?;
        s.set(c"lastError", null(s)?)?;
        s.set(c"retryAt", num(s, 0.)?)?;
        s.set(c"failures", num(s, 0.)?)?;
        undef(s)
    })
}
fn failed<'a>(f: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let s = f.get(c"s")?;
    let error = a[0];
    let all = f.get(c"full")?.truthy()?;
    let issue = s.get(c"ports")?.get(c"describe")?.call_plain(&[error])?;
    s.set(c"lastError", issue)?;
    let failures = as_number(s, c"failures")? + 1.;
    s.set(c"failures", num(s, failures)?)?;
    let retry = (s.get(c"retryBaseMs")?.explicit_number()? * 2_f64.powf((failures - 1.).min(4.)))
        .min(s.get(c"retryMaxMs")?.explicit_number()?);
    let retry_at = clock(s)? + retry;
    s.set(c"retryAt", num(s, retry_at)?)?;
    if all {
        s.set(c"full", flag(s, true)?)?;
    } else if f.get(c"metaOnly")?.truthy()? {
        s.set(c"metaDirty", flag(s, true)?)?;
    } else {
        let dirty = s.get(c"dirty")?;
        f.get(c"ids")?.for_each(|id| {
            call(dirty, c"add", &[id])?;
            Ok(())
        })?;
    }
    let logger = s.get(c"logger")?;
    let warn = logger.get(c"warn")?;
    if !warn.nullish()? {
        let code = fallback(error.optional(c"code")?, "refresh_failed".into())?;
        let message = error.optional(c"message")?;
        let reason = if message.truthy()? {
            message
        } else {
            fallback(error, "unknown".into())?
        };
        let details = fields(
            f,
            &[
                ("code", code),
                (
                    "reason",
                    call(string(reason)?, c"slice", &[num(s, 0.)?, num(s, 500.)?])?,
                ),
                ("failures", num(s, failures)?),
                ("retryInMs", num(s, (retry_at - clock(s)?).max(0.))?),
                ("full", flag(s, all)?),
            ],
        )?;
        warn.call(logger, &[text(s, "air_sync_refresh_failed")?, details])?;
    }
    undef(s)
}
pub(super) fn flush(s: L<'_>) -> Result<L<'_>> {
    if stopped(s)? {
        return resolved(undef(s)?);
    }
    let in_flight = s.get(c"inFlight")?;
    if in_flight.truthy()? {
        return Ok(in_flight);
    }
    clear(s, s.get(c"timer")?)?;
    s.set(c"timer", null(s)?)?;
    s.set(c"dueAt", num(s, f64::INFINITY)?)?;
    let dirty = s.get(c"dirty")?;
    let all = s.get(c"full")?.truthy()?
        || !call(s.get(c"index")?, c"isReady", &[])?.truthy()?
        || (!dirty.get(c"size")?.truthy()? && !s.get(c"metaDirty")?.truthy()?);
    let ids = list(s, dirty)?;
    let meta_only = !all && !ids.get(c"length")?.truthy()?;
    let frame = fields(
        s,
        &[
            ("s", s),
            ("ids", ids),
            ("full", flag(s, all)?),
            ("metaOnly", flag(s, meta_only)?),
            ("version", s.get(c"metadataVersion")?),
        ],
    )?;
    s.set(c"full", flag(s, false)?)?;
    call(dirty, c"clear", &[])?;
    s.set(c"metaDirty", flag(s, false)?)?;
    let built_result = async_result(s, || {
        s.get(c"build")?
            .call_plain(&[if all { null(s)? } else { ids }])
    })?;
    let commit = then(built_result, frame, built)?;
    let done = recover(commit, frame, failed)?;
    let finally = function(s, "", 0, 0, |s, _| {
        s.set(c"inFlight", null(s)?)?;
        clients::publish_status(s)?;
        let delay = if s.get(c"lastError")?.truthy()? {
            (as_number(s, c"retryAt")? - clock(s)?).max(0.)
        } else if s.get(c"full")?.truthy()?
            || s.get(c"dirty")?.get(c"size")?.truthy()?
            || s.get(c"metaDirty")?.truthy()?
        {
            s.get(c"debounceMs")?.explicit_number()?
        } else {
            s.get(c"reconcileMs")?.explicit_number()?
        };
        schedule(s, delay)?;
        undef(s)
    })?;
    let result = call(done, c"finally", &[finally])?;
    s.set(c"inFlight", result)?;
    Ok(result)
}
