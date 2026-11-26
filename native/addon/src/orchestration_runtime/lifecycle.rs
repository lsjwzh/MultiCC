use super::*;

fn ignore(s: L<'_>, promise: L<'_>) -> Result<()> {
    let noop = callback(s, "", 0, 0, |s, _| undef(s))?;
    call(promise, c"catch", &[noop])?;
    Ok(())
}
fn clear_wakeup(s: L<'_>) -> Result<()> {
    let timer = s.get(c"admissionWakeup")?;
    if !timer.nullish()? {
        port(s, c"clearTimeoutFn", &[timer])?;
    }
    s.set(c"admissionWakeup", null(s)?)
}
fn unref(timer: L<'_>) -> Result<()> {
    if timer.truthy()? && timer.get(c"unref")?.kind()? == sys::ValueType::napi_function {
        call(timer, c"unref", &[])?;
    }
    Ok(())
}
pub(super) fn wake_after_admission(s: L<'_>) -> Result<()> {
    if s.get(c"stopped")?.truthy()? || !s.get(c"admissionWakeup")?.nullish()? {
        return Ok(());
    }
    let wake = callback(s, "", 0, 0, |s, _| {
        s.set(c"admissionWakeup", null(s)?)?;
        if !s.get(c"stopped")?.truthy()? {
            ignore(s, tick(s)?)?;
        }
        undef(s)
    })?;
    let timer = port(s, c"setTimeoutFn", &[wake, num(s, 0.)?])?;
    s.set(c"admissionWakeup", timer)?;
    unref(timer)
}
fn retention(s: L<'_>) -> Result<()> {
    if s.get(c"stopped")?.truthy()?
        || s.get(c"retentionWork")?.truthy()?
        || s.get(c"store")?.get(c"pruneRetained")?.kind()? != sys::ValueType::napi_function
    {
        return Ok(());
    }
    let work = after(s, undef(s)?, |s, _| {
        let at = num(s, port(s, c"now", &[])?.explicit_number()?)?;
        service(s, c"store", c"pruneRetained", &[fields(s, &[("now", at)])?])
    })?;
    let handled = recover(s, work, |s, e| {
        log(
            s,
            &format!(
                "[orchestration] retained-record maintenance failed: {}",
                error_message(e)?
            ),
        )?;
        undef(s)
    })?;
    let release = callback(s, "", 0, 0, |s, _| {
        s.set(c"retentionWork", null(s)?)?;
        undef(s)
    })?;
    s.set(c"retentionWork", call(handled, c"finally", &[release])?)
}
fn run_tick(s: L<'_>) -> Result<L<'_>> {
    let reconciled = async_result(s, || operations::reconcile_detached(s))?;
    let polled = after(s, reconciled, |s, _| waits::process_polls(s))?;
    let delivered = after(s, polled, |s, _| delivery::process_outbox(s))?;
    let cleanup = callback(s, "", 0, 0, |s, _| {
        retention(s)?;
        undef(s)
    })?;
    call(delivered, c"finally", &[cleanup])
}
// A tick requested from its own unsettled delivery would otherwise await
// itself. Exit that AsyncLocalStorage scope before scheduling a single followup.
fn request_after_delivery(s: L<'_>) -> Result<()> {
    if s.get(c"tickRequested")?.truthy()? {
        return Ok(());
    }
    s.set(c"tickRequested", flag(s, true)?)?;
    let outside = callback(s, "", 0, 0, |s, _| {
        let follow = after(s, s.get(c"tickTail")?, |s, _| {
            s.set(c"tickRequested", flag(s, false)?)?;
            if s.get(c"stopped")?.truthy()? {
                null(s)
            } else {
                tick(s)
            }
        })?;
        recover(s, follow, |s, e| {
            s.set(c"tickRequested", flag(s, false)?)?;
            log(
                s,
                &format!(
                    "[orchestration] follow-up worker tick failed: {}",
                    error_message(e)?
                ),
            )?;
            undef(s)
        })?;
        undef(s)
    })?;
    service(s, c"deliveryScope", c"exit", &[outside])?;
    Ok(())
}
pub(super) fn tick(s: L<'_>) -> Result<L<'_>> {
    clear_wakeup(s)?;
    let scope = service(s, c"deliveryScope", c"getStore", &[])?;
    if scope.truthy()?
        && service(s, c"inFlightDeliveries", c"has", &[scope.get(c"itemId")?])?.truthy()?
    {
        request_after_delivery(s)?;
        return fulfilled(num(s, 0.)?);
    }
    let run = callback(s, "", 0, 0, |s, _| run_tick(s))?;
    let work = call(s.get(c"tickTail")?, c"then", &[run, run])?;
    let tail = recover(s, work, |s, e| {
        log(
            s,
            &format!("[orchestration] worker tick failed: {}", error_message(e)?),
        )?;
        undef(s)
    })?;
    s.set(c"tickTail", tail)?;
    Ok(work)
}
fn start(s: L<'_>) -> Result<L<'_>> {
    if s.get(c"started")?.truthy()? {
        return undef(s);
    }
    if s.get(c"stopped")?.truthy()? {
        return Err(fail(
            s,
            "[orchestration-runtime] cannot restart a stopped runtime",
        ));
    }
    s.set(c"started", flag(s, true)?)?;
    let work = service(s, c"outbox", c"recoverExpired", &[])?;
    let work = after(s, work, |s, _| waits::refresh_pending(s))?;
    let work = after(s, work, |s, _| {
        service(s, c"operations", c"interruptActiveTasks", &[])
    })?;
    let work = after(s, work, |s, _| {
        service(
            s,
            c"sessionScheduler",
            c"recover",
            &[fields(
                s,
                &[("stateForSession", s.get(c"getSessionRecoveryFacts")?)],
            )?],
        )
    })?;
    let work = after(s, work, |s, _| {
        port(
            s,
            c"beforeFirstTick",
            &[fields(
                s,
                &[
                    ("sessionScheduler", s.get(c"sessionScheduler")?),
                    ("operations", s.get(c"operations")?),
                    ("outbox", s.get(c"outbox")?),
                ],
            )?],
        )
    })?;
    let work = after(s, work, |s, _| operations::reconcile_dispatches(s))?;
    let work = after(s, work, |s, _| operations::reconcile_detached(s))?;
    let work = after(s, work, |s, _| tick(s))?;
    after(s, work, |s, _| {
        let timer = port(
            s,
            c"setIntervalFn",
            &[
                callback(s, "", 0, 0, |s, _| {
                    ignore(s, tick(s)?)?;
                    undef(s)
                })?,
                s.get(c"workerIntervalMs")?,
            ],
        )?;
        s.set(c"timer", timer)?;
        unref(timer)?;
        undef(s)
    })
}
fn stop(s: L<'_>) -> Result<L<'_>> {
    if s.get(c"stopped")?.truthy()? {
        return undef(s);
    }
    s.set(c"stopped", flag(s, true)?)?;
    clear_wakeup(s)?;
    let timer = s.get(c"timer")?;
    if timer.truthy()? {
        port(s, c"clearIntervalFn", &[timer])?;
    }
    s.set(c"timer", null(s)?)?;
    let work = service(s, c"operations", c"interruptActiveTasks", &[])?;
    let work = after(s, work, |s, _| s.get(c"tickTail"))?;
    let work = after(s, work, |s, _| {
        let running = s.get(c"pendingDeliveries")?;
        if running.get(c"size")?.truthy()? {
            let group = call(s.global()?.get(c"Array")?, c"from", &[running])?;
            return call(s.global()?.get(c"Promise")?, c"allSettled", &[group]);
        }
        undef(s)
    })?;
    let work = after(s, work, |s, _| s.get(c"retentionWork"))?;
    let work = after(s, work, |s, _| service(s, c"store", c"flush", &[]))?;
    let work = after(s, work, |s, _| {
        if s.get(c"store")?.get(c"exportLegacy")?.kind()? == sys::ValueType::napi_function {
            service(s, c"store", c"exportLegacy", &[])
        } else {
            undef(s)
        }
    })?;
    after(s, work, |s, _| undef(s))
}
fn dispose(s: L<'_>) -> Result<L<'_>> {
    let work = after(s, stop(s)?, |s, _| {
        if s.get(c"store")?.get(c"close")?.kind()? == sys::ValueType::napi_function {
            service(
                s,
                c"store",
                c"close",
                &[fields(s, &[("exportRollback", flag(s, false)?)])?],
            )
        } else {
            undef(s)
        }
    })?;
    after(s, work, |s, _| undef(s))
}
pub(super) fn install(s: L<'_>, api: L<'_>) -> Result<()> {
    async_method(s, api, c"start", 0, 0, |s, _| start(s))?;
    async_method(s, api, c"stop", 0, 0, |s, _| stop(s))?;
    async_method(s, api, c"dispose", 0, 0, |s, _| dispose(s))?;
    api.set(c"tick", callback(s, "tick", 0, 0, |s, _| tick(s))?)
}
