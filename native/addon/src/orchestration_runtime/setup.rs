use super::*;

// Destructuring defaults apply only to undefined, including for a caller's
// explicit null timer or recovery port.
fn options<'a>(h: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let s = fields(h, &[])?;
    let noop = callback(h, "", 0, 0, |s, _| undef(s))?;
    let no = callback(h, "", 0, 0, |s, _| flag(s, false))?;
    let none = callback(h, "", 0, 0, |s, _| null(s))?;
    let identity = callback(h, "", 1, 1, |_, a| Ok(a[0]))?;
    let global = h.global()?;
    for key in [
        c"file".as_ref(),
        c"databaseFile",
        c"runChatTurn",
        c"isBusy",
        c"busyReasons",
        c"noteBlockedDelivery",
        c"heldTurnInjectable",
        c"isDeliveryLocked",
        c"deliveryGroup",
        c"hasPersistedDelivery",
        c"runnerDeliveryProbe",
        c"beforeDeliver",
        c"tryInjectHeldTurn",
        c"deliverOutbox",
        c"notifyLostMessage",
        c"notifyStuckDelivery",
        c"heldForBackground",
        c"stuckDeliveryNoticeMs",
        c"probe",
        c"detachedAdapter",
        c"recoverDispatchResult",
        c"replayRecoveredDispatchEffects",
        c"getSessionRecoveryState",
        c"getSessionRecoveryFacts",
        c"getSessionRecoveryStateAsync",
        c"ensureSessionWorkState",
        c"rustQuestionOwner",
        c"beforeFirstTick",
        c"onSchedulerEvent",
        c"now",
        c"setIntervalFn",
        c"clearIntervalFn",
        c"setTimeoutFn",
        c"clearTimeoutFn",
        c"workerIntervalMs",
        c"deliveryWatchdogMs",
        c"deliveryTickGraceMs",
        c"pollLeaseMs",
        c"claimLimit",
        c"workerId",
        c"log",
        c"storeOptions",
        c"outboxOptions",
        c"waitOptions",
    ] {
        let input = crate::js_iteration::read(opts, key)?;
        let value = if !input.undefined()? {
            input
        } else {
            match key.to_bytes() {
                b"file" | b"runChatTurn" => undef(h)?,
                b"isBusy" | b"isDeliveryLocked" | b"hasPersistedDelivery" => no,
                b"beforeDeliver"
                | b"replayRecoveredDispatchEffects"
                | b"beforeFirstTick"
                | b"onSchedulerEvent"
                | b"log" => noop,
                b"deliveryGroup" => identity,
                b"recoverDispatchResult" | b"getSessionRecoveryState" => none,
                b"getSessionRecoveryStateAsync" | b"getSessionRecoveryFacts" => {
                    s.get(c"getSessionRecoveryState")?
                }
                b"stuckDeliveryNoticeMs" => num(h, 60_000.)?,
                b"probe" => callback(h, "probe", 0, 0, |s, _| {
                    Err(fail(s, "poll probe is not configured"))
                })?,
                b"rustQuestionOwner" => flag(h, false)?,
                b"now" => global.get(c"Date")?.get(c"now")?,
                b"setIntervalFn" => global.get(c"setInterval")?,
                b"clearIntervalFn" => global.get(c"clearInterval")?,
                b"setTimeoutFn" => global.get(c"setTimeout")?,
                b"clearTimeoutFn" => global.get(c"clearTimeout")?,
                b"deliveryTickGraceMs" | b"workerIntervalMs" => num(h, 1000.)?,
                b"deliveryWatchdogMs" => num(h, 120_000.)?,
                b"pollLeaseMs" => num(h, 30_000.)?,
                b"claimLimit" => num(h, 8.)?,
                b"workerId" => {
                    let bytes = call(h.get(c"crypto")?, c"randomBytes", &[num(h, 6.)?])?;
                    let hex = call(bytes, c"toString", &[text(h, "hex")?])?;
                    text(
                        h,
                        &format!(
                            "multicc-{}-{}",
                            describe(h.get(c"process")?.get(c"pid")?)?,
                            describe(hex)?
                        ),
                    )?
                }
                b"storeOptions" | b"outboxOptions" | b"waitOptions" => fields(h, &[])?,
                _ => null(h)?,
            }
        };
        s.set(key, value)?;
    }
    for k in [
        c"crypto".as_ref(),
        c"process",
        c"TERMINAL_OPERATION_STATES",
        c"TERMINAL_TASK_STATES",
    ] {
        s.set(k, h.get(k)?)?;
    }
    Ok(s)
}
fn build_services<'a>(h: L<'a>, s: L<'a>) -> Result<()> {
    let file = s.get(c"file")?;
    let db = s.get(c"databaseFile")?;
    if !(file.kind()? == sys::ValueType::napi_string && file.truthy()?)
        && !(db.kind()? == sys::ValueType::napi_string && db.truthy()?)
    {
        return Err(s.type_error("[orchestration-runtime] file or databaseFile is required"));
    }
    for k in [
        c"runChatTurn".as_ref(),
        c"hasPersistedDelivery",
        c"beforeDeliver",
        c"isDeliveryLocked",
        c"beforeFirstTick",
    ] {
        if s.get(k)?.kind()? != sys::ValueType::napi_function {
            return Err(s.type_error(&format!(
                "[orchestration-runtime] {} {}",
                k.to_string_lossy(),
                if k == c"runChatTurn" {
                    "is required"
                } else {
                    "must be a function"
                }
            )));
        }
    }
    let clock = s.get(c"now")?;
    let cfg = fields(s, &[])?;
    let factory = if db.truthy()? {
        cfg.set(c"file", db)?;
        cfg.set(c"legacyFile", fallback(file, V::Null)?)?;
        c"createOrchestrationSqliteStore".as_ref()
    } else {
        cfg.set(c"file", file)?;
        c"createOrchestrationStore".as_ref()
    };
    cfg.set(c"now", clock)?;
    cfg.spread_from(s.get(c"storeOptions")?)?;
    let json_ports = h.get(c"jsonStorePorts")?;
    let (store, public_store) = if !db.truthy()? && json_ports.truthy()? {
        let store = crate::orchestration_json::create(json_ports, cfg)?;
        (store, port(json_ports, c"publicStore", &[store])?)
    } else {
        let store = port(h, factory, &[cfg])?;
        (store, store)
    };
    s.set(c"store", store)?;
    s.set(c"publicStore", public_store)?;
    if store
        .optional(c"migration")?
        .optional(c"migrated")?
        .truthy()?
    {
        log(
            s,
            &format!(
                "[orchestration] migrated legacy JSON to SQLite ({})",
                describe(store.get(c"file")?)?
            ),
        )?;
    }
    // Host service factories observe the same store object as runtime.store.
    let base = || fields(s, &[("store", public_store), ("now", clock)]);
    let ob = base()?;
    for (key, v) in [
        (c"leaseMs".as_ref(), 30_000.),
        (c"maxAttempts", 20.),
        (c"baseBackoffMs", 1000.),
        (c"maxBackoffMs", 60_000.),
    ] {
        ob.set(key, num(s, v)?)?;
    }
    ob.spread_from(s.get(c"outboxOptions")?)?;
    s.set(c"outbox", port(h, c"createOutbox", &[ob])?)?;
    let w = base()?;
    w.spread_from(s.get(c"waitOptions")?)?;
    let ports = h.get(c"servicePorts")?;
    if ports.undefined()? {
        s.set(c"waits", port(h, c"createWaitService", &[w])?)?;
        s.set(
            c"operations",
            port(h, c"createOperationService", &[base()?])?,
        )?;
    } else {
        s.set(c"waits", services::waits::create(ports, &mut [w])?)?;
        s.set(
            c"operations",
            services::operations::create(ports, &mut [base()?])?,
        )?;
    }
    let sch = base()?;
    for (to, from) in [
        (c"rustQuestionOwner".as_ref(), c"rustQuestionOwner".as_ref()),
        (c"ensureSessionWorkState", c"ensureSessionWorkState"),
        (c"onEvent", c"onSchedulerEvent"),
        (c"log", c"log"),
    ] {
        sch.set(to, s.get(from)?)?;
    }
    for (key, reader, field) in [
        (
            c"getClassifyState".as_ref(),
            c"getSessionRecoveryFacts".as_ref(),
            c"classifyState".as_ref(),
        ),
        (
            c"getPendingUserInput",
            c"getSessionRecoveryState",
            c"pendingUserInput",
        ),
        (c"getTurnId", c"getSessionRecoveryState", c"turnId"),
        (
            c"getUnattendedState",
            c"getSessionRecoveryFacts",
            c"unattended",
        ),
        (c"getRunActive", c"getSessionRecoveryFacts", c"runActive"),
    ] {
        sch.set(
            key,
            callback(s, "", 1, 1, move |s, a| {
                let v = port(s, reader, &[a[0]])?.optional(field)?;
                if field == c"runActive" {
                    if v.nullish()? {
                        null(s)
                    } else {
                        Ok(v)
                    }
                } else {
                    fallback(v, V::Null)
                }
            })?,
        )?;
    }
    s.set(
        c"sessionScheduler",
        crate::session_work_scheduler::create(sch)?,
    )
}
pub(super) fn create<'a>(host: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let opts = crate::host_methods::default_object(opts)?;
    let s = options(host, opts)?;
    build_services(host, s)?;
    for k in [c"admissionWakeup".as_ref(), c"retentionWork", c"timer"] {
        s.set(k, null(s)?)?;
    }
    for k in [c"started".as_ref(), c"stopped", c"tickRequested"] {
        s.set(k, flag(s, false)?)?;
    }
    for (key, ctor) in [
        (c"pendingBySession".as_ref(), c"Map".as_ref()),
        (c"inFlightDeliveries", c"Set"),
        (c"pendingDeliveries", c"Set"),
        (c"inFlightDeliveryGroups", c"Map"),
        (c"deliverySkipLogAt", c"Map"),
        (c"blockedDelivery", c"Map"),
    ] {
        s.set(key, s.global()?.get(ctor)?.construct(&[])?)?;
    }
    s.set(
        c"deliveryScope",
        host.get(c"AsyncLocalStorage")?.construct(&[])?,
    )?;
    s.set(c"tickTail", fulfilled(undef(s)?)?)?;
    let api = fields(s, &[])?;
    for key in [
        c"store".as_ref(),
        c"outbox",
        c"waits",
        c"operations",
        c"sessionScheduler",
    ] {
        api.set(key, s.get(key)?)?;
    }
    lifecycle::install(s, api)?;
    waits::install(s, api)?;
    operations::install(s, api)?;
    // Keep the enumeration order and the V8 async calling convention exposed
    // by the original runtime. Native-to-native calls use the modules directly.
    let public = fields(s, &[])?;
    for key in [
        c"store".as_ref(),
        c"outbox",
        c"waits",
        c"operations",
        c"sessionScheduler",
        c"start",
        c"stop",
        c"dispose",
        c"tick",
        c"register",
        c"scheduleMessage",
        c"listScheduledMessages",
        c"cancelScheduledMessage",
        c"resolveCallback",
        c"cancel",
        c"cancelForSession",
        c"listForSession",
        c"hasSessionActivity",
        c"stats",
        c"hasPending",
        c"pendingCount",
        c"refreshPending",
        c"startDetached",
        c"admitDispatch",
        c"admitSessionWork",
        c"completeDispatch",
        c"interruptDispatch",
        c"observeTask",
    ] {
        let value = api.get(key)?;
        let exposed = match key.to_bytes() {
            b"store" => s.get(c"publicStore")?,
            b"outbox" | b"waits" | b"operations" | b"sessionScheduler" | b"tick"
            | b"hasPending" | b"pendingCount" => value,
            _ => port(host, c"asyncMethod", &[value])?,
        };
        public.set(key, exposed)?;
    }
    public.freeze()
}
