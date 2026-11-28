//! Own the remaining hold lifecycle in Rust. Node only supplies its native
//! class, process environment and the CLI's main-result predicate. Timers are
//! looked up live so fake clocks and unref semantics match the old host.
use crate::{host_api::*, js_iteration::read};
use napi_derive::napi;
use std::{cell::Cell, rc::Rc};

fn max_ms<'a>(ports: L<'a>, env: L<'a>) -> Result<L<'a>> {
    let env = if env.undefined()? {
        ports.get(c"process")?.get(c"env")?
    } else {
        env
    };
    call(
        ports.get(c"native")?,
        c"backgroundHoldMaxMs",
        &[env.get(c"MULTICC_BACKGROUND_HOLD_MAX_MS")?],
    )
}
fn active(p: L<'_>) -> Result<L<'_>> {
    let result = p.catch(|| {
        let callback = p.get(c"hasBackground")?;
        if callback.nullish()? {
            flag(p, false)
        } else {
            flag(p, callback.call_plain(&[])?.truthy()?)
        }
    })?;
    match result {
        Some(value) => Ok(value),
        None => flag(p, false),
    }
}
fn boundaries(p: L<'_>) -> Result<()> {
    let callback = p.get(c"onBoundary")?;
    if !callback.truthy()? {
        return Ok(());
    }
    let owner = p.get(c"owner")?;
    call(owner, c"pendingBoundaries", &[])?.for_each(|event| {
        p.catch(|| {
            let context = fields(p, &[("owner", owner), ("event", event)])?;
            let acknowledge = function(context, "acknowledge", 0, 0, |c, _| {
                call(
                    c.get(c"owner")?,
                    c"acknowledgeAnswer",
                    &[c.get(c"event")?.get(c"held_result_id")?],
                )
            })?;
            let value = spread(event)?;
            value.set(c"acknowledge", acknowledge)?;
            callback.call_plain(&[value])
        })?;
        Ok(())
    })
}
fn clear(p: L<'_>) -> Result<()> {
    let global = p.global()?;
    call(global, c"clearInterval", &[p.get(c"ticker")?])?;
    call(global, c"clearTimeout", &[p.get(c"capTimer")?])?;
    p.set(c"ticker", null(p)?)?;
    p.set(c"capTimer", null(p)?)?;
    Ok(())
}
fn finish<'a>(p: L<'a>, done: &Cell<bool>) -> Result<L<'a>> {
    if done.get() {
        return null(p);
    }
    let result = call(p.get(c"owner")?, c"flush", &[])?;
    if !result.truthy()? {
        return null(p);
    }
    done.set(true);
    clear(p)?;
    p.get(c"release")?.call_plain(&[result])?;
    Ok(result)
}
fn tick<'a>(p: L<'a>, done: &Cell<bool>) -> Result<L<'a>> {
    boundaries(p)?;
    let facts = fields(
        p,
        &[
            ("now", call(p.global()?.get(c"Date")?, c"now", &[])?),
            ("backgroundActive", active(p)?),
        ],
    )?;
    let result = call(p.get(c"owner")?, c"tick", &[facts])?;
    if result.truthy()? {
        done.set(true);
        clear(p)?;
        p.get(c"release")?.call_plain(&[result])?;
    }
    undef(p)
}
fn cap<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let owner = p.get(c"owner")?;
    if call(owner, c"capReached", &[active(p)?])?.truthy()? {
        p.catch(|| {
            let callback = p.get(c"onCapReached")?;
            if callback.nullish()? {
                undef(p)
            } else {
                callback.call_plain(&[owner.get(c"maxMs")?])
            }
        })?;
    }
    undef(p)
}
fn unref(handle: L<'_>) -> Result<()> {
    let callback = handle.optional(c"unref")?;
    if !callback.nullish()? {
        callback.call(handle, &[])?;
    }
    Ok(())
}
fn default<'a>(
    options: L<'a>,
    key: &std::ffi::CStr,
    other: impl FnOnce() -> Result<L<'a>>,
) -> Result<L<'a>> {
    let value = read(options, key)?;
    if value.undefined()? {
        other()
    } else {
        Ok(value)
    }
}
fn identity(value: L<'_>) -> Result<L<'_>> {
    string(if value.nullish()? {
        text(value, "")?
    } else {
        value
    })
}
fn create<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let options = default_object(a[0])?;
    let has_background = read(options, c"hasBackground")?;
    let release = read(options, c"release")?;
    let quiet = default(options, c"quietMs", || num(ports, 5000.0))?;
    let interval = default(options, c"tickMs", || num(ports, 1000.0))?;
    let max = default(options, c"maxMs", || max_ms(ports, undef(ports)?))?;
    let on_cap = default(options, c"onCapReached", || null(ports))?;
    let on_boundary = default(options, c"onBoundary", || null(ports))?;
    let owner = ports
        .get(c"native")?
        .get(c"RustBackgroundHold")?
        .construct(&[fields(
            ports,
            &[("quietMs", quiet), ("tickMs", interval), ("maxMs", max)],
        )?])?;
    let p = fields(
        ports,
        &[
            ("ports", ports),
            ("owner", owner),
            ("hasBackground", has_background),
            ("release", release),
            ("tickMs", interval),
            ("maxMs", max),
            ("onCapReached", on_cap),
            ("onBoundary", on_boundary),
            ("ticker", null(ports)?),
            ("capTimer", null(ports)?),
        ],
    )?;
    let done = Rc::new(Cell::new(false));
    if on_boundary.truthy()? {
        call(owner, c"requireAnswerHistory", &[])?;
    }
    let api = fields(p, &[])?;
    for (key, native, name) in [
        ("held", c"held", "get held"),
        (
            "injectionsInFlight",
            c"injections",
            "get injectionsInFlight",
        ),
    ] {
        let getter = function(p, name, 0, 0, move |p, _| p.get(c"owner")?.get(native))?;
        call(
            p.global()?.get(c"Object")?,
            c"defineProperty",
            &[
                api,
                text(p, key)?,
                fields(
                    p,
                    &[
                        ("get", getter),
                        ("enumerable", flag(p, true)?),
                        ("configurable", flag(p, true)?),
                    ],
                )?,
            ],
        )?;
    }
    let start_done = done.clone();
    api.set(
        c"start",
        function(p, "start", 1, 1, move |p, a| {
            if start_done.get() {
                return flag(p, false);
            }
            let facts = fields(
                p,
                &[
                    (
                        "mainResult",
                        p.get(c"ports")?.get(c"isMainResult")?.call_plain(&[a[0]])?,
                    ),
                    ("backgroundActive", active(p)?),
                ],
            )?;
            if !call(p.get(c"owner")?, c"start", &[a[0], facts])?.truthy()? {
                return flag(p, false);
            }
            boundaries(p)?;
            let timer_done = start_done.clone();
            let callback = function(p, "tick", 0, 0, move |p, _| tick(p, &timer_done))?;
            let ticker = call(p.global()?, c"setInterval", &[callback, p.get(c"tickMs")?])?;
            p.set(c"ticker", ticker)?;
            unref(ticker)?;
            if p.get(c"maxMs")?
                .number_value()?
                .is_some_and(|n| n.is_finite() && n > 0.0)
            {
                let cap_timer = call(
                    p.global()?,
                    c"setTimeout",
                    &[function(p, "noteCap", 0, 0, cap)?, p.get(c"maxMs")?],
                )?;
                p.set(c"capTimer", cap_timer)?;
                unref(cap_timer)?;
            }
            flag(p, true)
        })?,
    )?;
    api.set(
        c"observe",
        function(p, "observe", 1, 1, |p, a| {
            let swallowed = call(p.get(c"owner")?, c"observe", &[a[0]])?;
            boundaries(p)?;
            Ok(swallowed)
        })?,
    )?;
    api.set(
        c"beginInjection",
        function(p, "beginInjection", 2, 2, |p, a| {
            call(
                p.get(c"owner")?,
                c"beginInjection",
                &[identity(a[0])?, identity(a[1])?],
            )
        })?,
    )?;
    for (name, key, length) in [
        ("confirmInjection", c"confirmInjection", 2),
        ("acknowledgeHistory", c"acknowledgeHistory", 2),
        ("historyWritten", c"historyWritten", 1),
        ("historyPending", c"historyPending", 1),
    ] {
        api.set_key(
            text(p, name)?,
            function(p, name, length, length, move |p, a| {
                call(p.get(c"owner")?, key, a)
            })?,
        )?;
    }
    api.set(
        c"interruptInjections",
        function(p, "interruptInjections", 0, 0, |p, _| {
            call(p.get(c"owner")?, c"interruptInjections", &[])?;
            boundaries(p)?;
            undef(p)
        })?,
    )?;
    api.set(
        c"abortInjection",
        function(p, "abortInjection", 1, 1, |p, a| {
            let id = string(if a[0].nullish()? { text(p, "")? } else { a[0] })?;
            call(p.get(c"owner")?, c"abortInjection", &[id])?;
            undef(p)
        })?,
    )?;
    let finish_done = done.clone();
    api.set(
        c"flush",
        function(p, "finish", 0, 0, move |p, _| finish(p, &finish_done))?,
    )?;
    api.set(
        c"dispose",
        function(p, "dispose", 0, 0, move |p, _| {
            done.set(true);
            call(p.get(c"owner")?, c"dispose", &[])?;
            clear(p)?;
            undef(p)
        })?,
    )?;
    Ok(api)
}

#[napi]
pub fn background_hold_api(e: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&e, ports);
    Ok(defaulted_methods(
        p,
        &[
            ("createBackgroundHold", 0, 1, create),
            ("holdMaxMs", 0, 1, |p, a| max_ms(p, a[0])),
            ("mayInjectIntoHeldTurn", 1, 1, |p, a| {
                call(p.get(c"native")?, c"backgroundHoldMayInject", a)
            }),
            ("isDirectUserTyped", 2, 2, |p, a| {
                let item = if a[0].nullish()? { null(p)? } else { a[0] };
                let opts = if a[1].nullish()? { null(p)? } else { a[1] };
                flag(
                    p,
                    call(p.get(c"native")?, c"backgroundHoldUserTyped", &[item, opts])?
                        .is_true()?,
                )
            }),
            ("processStale", 2, 2, |p, a| {
                let running = if a[0].truthy()? {
                    a[0]
                } else {
                    fields(p, &[])?
                };
                let wanted = if a[1].truthy()? {
                    a[1]
                } else {
                    fields(p, &[])?
                };
                call(
                    p.get(c"native")?,
                    c"backgroundHoldProcessStale",
                    &[running, wanted],
                )
            }),
            ("spawnContract", 1, 1, |p, a| {
                call(p.get(c"native")?, c"backgroundHoldSpawnContract", a)
            }),
        ],
    )?
    .raw())
}
