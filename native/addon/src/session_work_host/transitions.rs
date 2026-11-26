//! Per-session admission, turn closure and classification. The scheduler persists
//! active entries. This host retains only the in-flight promises and retry timers.
use super::*;
use std::ffi::CStr;
mod admission;
mod classification;
mod questions;
mod recovery;
pub(super) use classification::transition as classify_transition;

fn dep<'a>(s: L<'a>, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    call(s.get(c"deps")?, name, args)
}
fn runtime(s: L<'_>) -> Result<L<'_>> {
    dep(s, c"runtime", &[])
}
fn signal(s: L<'_>) -> Result<L<'_>> {
    s.get(c"deps")?.get(c"userInputSignalHost")
}
fn callable(receiver: L<'_>, key: &CStr) -> Result<bool> {
    Ok(receiver.optional(key)?.kind()? == sys::ValueType::napi_function)
}
fn or<'a>(v: L<'a>, default: L<'a>) -> Result<L<'a>> {
    if v.truthy()? {
        Ok(v)
    } else {
        Ok(default)
    }
}
fn n(v: L<'_>) -> Result<L<'_>> {
    fallback(v, V::Null)
}
fn fail<'a>(s: L<'a>, code: &str) -> Result<L<'a>> {
    fields(s, &[("ok", flag(s, false)?), ("code", text(s, code)?)])
}
fn logger<'a>(s: L<'a>, level: &CStr, event: &str, payload: L<'a>) -> Result<()> {
    let log = s.get(c"log")?;
    if !log.get(level)?.nullish()? {
        call(log, level, &[text(s, event)?, payload])?;
    }
    Ok(())
}
fn map_get<'a>(s: L<'a>, key: &CStr, id: L<'a>) -> Result<L<'a>> {
    call(s.get(key)?, c"get", &[id])
}
fn maybe_call<'a>(obj: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    if obj.optional(key)?.nullish()? {
        undef(obj)
    } else {
        call(obj, key, args)
    }
}
fn pending_input<'a>(s: L<'a>, id: L<'a>) -> Result<L<'a>> {
    async_result(s, || {
        let q = signal(s)?;
        if callable(q, c"pendingAsync")? {
            call(q, c"pendingAsync", &[id])
        } else {
            dep(s, c"pendingUserInput", &[id])
        }
    })
}
fn track<'a>(s: L<'a>, key: &'static CStr, id: L<'a>, promise: L<'a>) -> Result<L<'a>> {
    let map = s.get(key)?;
    call(map, c"set", &[id, promise])?;
    let f = fields(s, &[("map", map), ("id", id), ("promise", promise)])?;
    let clear = callback(f, "", 0, 0, |f, _| {
        let map = f.get(c"map")?;
        let id = f.get(c"id")?;
        if call(map, c"get", &[id])?.equals(f.get(c"promise")?)? {
            call(map, c"delete", &[id])?;
        }
        undef(f)
    })?;
    call(promise, c"then", &[clear, clear])?;
    Ok(promise)
}
pub(super) fn close_turn<'a>(s: L<'a>, id: L<'a>, reason: L<'a>) -> Result<L<'a>> {
    let promise = async_result(s, || {
        let target = scheduler(s)?;
        if !target.truthy()? || !id.truthy()? {
            return fail(s, "scheduler_not_ready");
        }
        if reason.truthy()? {
            logger(
                s,
                c"warn",
                "session_scheduler_turn_failed_awaiting_classify",
                fields(s, &[("sessionId", id), ("reason", reason)])?,
            )?;
        }
        let f = fields(s, &[("target", target), ("id", id)])?;
        after(f, call(target, c"status", &[id])?, |f, current| {
            if !current.optional(c"active")?.truthy()? {
                return fail(f, "no_active_task");
            }
            call(f.get(c"target")?, c"turnEnded", &[f.get(c"id")?])
        })
    })?;
    track(s, c"turnClosures", id, promise)
}
fn turn<'a>(s: L<'a>, id: L<'a>, reason: L<'a>, failed: bool) -> Result<L<'a>> {
    let msg = fields(
        s,
        &[(
            "status",
            text(s, if failed { "failed" } else { "completed" })?,
        )],
    )?;
    if failed {
        msg.set(c"reason", reason)?;
    }
    s.catch(|| maybe_call(s.get(c"deps")?, c"onTerminalWork", &[id, msg]))?;
    close_turn(s, id, reason)
}
pub(super) fn install<'a>(s: L<'a>, api: L<'a>) -> Result<()> {
    macro_rules! bind {
        ($name:literal,$length:expr,$count:expr,$f:expr) => {
            api.set(
                &std::ffi::CString::new($name).unwrap(),
                callback(s, $name, $length, $count, $f)?,
            )?;
        };
    }
    bind!("admit", 2, 3, |s, a| async_result(s, || admission::admit(
        s,
        a[0],
        a[1],
        crate::host_methods::default_object(a[2])?
    )));
    bind!("moveInput", 2, 3, |s, a| async_result(s, || {
        questions::move_input(s, a[0], a[1], crate::host_methods::default_object(a[2])?)
    }));
    bind!("dismissUserInput", 2, 2, |s, a| async_result(s, || {
        questions::dismiss(s, a[0], a[1])
    }));
    bind!("settleRecoveredQuestion", 1, 1, |s, a| async_result(
        s,
        || questions::settle(s, a[0])
    ));
    bind!("resolveTask", 2, 2, |s, a| async_result(s, || {
        admission::resolve_task(s, a[0], a[1])
    }));
    bind!("getRunState", 1, 1, |s, a| recovery::run_state(s, a[0]));
    bind!("isRunActive", 1, 1, |s, a| flag(
        s,
        recovery::run_active(s, a[0])?
    ));
    bind!("hasQueuedDeliveries", 1, 1, |s, a| async_result(s, || {
        let target = scheduler(s)?;
        let q = if target.nullish()? {
            undef(s)?
        } else {
            call(target, c"status", &[a[0]])?
        };
        after(s, q, |s, q| {
            let items = q.optional(c"queued")?;
            flag(s, items.is_array()? && items.get(c"length")?.positive()?)
        })
    }));
    bind!("turnFailed", 1, 2, |s, a| turn(
        s,
        a[0],
        if a[1].undefined()? {
            text(s, "unknown_interruption")?
        } else {
            a[1]
        },
        true
    ));
    bind!("turnSucceeded", 1, 1, |s, a| turn(s, a[0], null(s)?, false));
    bind!("classifyTransition", 2, 4, |s, a| {
        classification::transition(
            s,
            a[0],
            a[1],
            crate::host_methods::default_object(a[2])?,
            crate::host_methods::default_object(a[3])?,
        )
    });
    bind!("classifyUnavailable", 3, 3, |s, a| async_result(s, || {
        logger(
            s,
            c"warn",
            "session_scheduler_classification_unavailable",
            fields(s, &[("sessionId", a[0]), ("reason", a[2])])?,
        )?;
        fields(
            s,
            &[
                ("ok", flag(s, true)?),
                ("deferred", flag(s, true)?),
                ("code", text(s, "classification_deferred")?),
                ("taskId", n(a[1])?),
            ],
        )
    }));
    bind!("recoveryFacts", 1, 3, |s, a| recovery::facts(
        s, a[0], a[1], a[2]
    ));
    bind!("recoveryState", 1, 1, |s, a| recovery::state(s, a[0]));
    bind!("recoveryStateAsync", 1, 1, |s, a| async_result(s, || {
        recovery::state_async(s, a[0])
    }));
    Ok(())
}
