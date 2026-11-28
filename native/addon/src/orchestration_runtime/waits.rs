//! Durable wait registration and the event-loop-local projection of blocking waits.
use super::*;
use crate::host_methods::default_object;
use crate::js_live::spread;
use std::ffi::CStr;
mod poll;
mod scheduled;
mod session;
pub(super) use poll::process_polls;

const SCHEDULED: &str = "scheduled_message";
const MAX_MESSAGE_LEN: usize = 256 * 1024;
const POLL_INTERVAL: f64 = 15.;
const POLL_CHECKS: f64 = 40.;
const CALLBACK_TIMEOUT: f64 = 1800.;
const MIN_POLL_INTERVAL: f64 = 3.;
const MIN_DELAY: f64 = 1.;
const MAX_DELAY: f64 = 604800.;

pub(super) fn defaults(s: L<'_>) -> Result<L<'_>> {
    fields(
        s,
        &[
            ("intervalSec", num(s, POLL_INTERVAL)?),
            ("maxChecks", num(s, POLL_CHECKS)?),
            ("timeoutSec", num(s, CALLBACK_TIMEOUT)?),
            ("minIntervalSec", num(s, MIN_POLL_INTERVAL)?),
            ("minDelaySec", num(s, MIN_DELAY)?),
            ("maxDelaySec", num(s, MAX_DELAY)?),
        ],
    )
}

fn object(v: L<'_>) -> Result<L<'_>> {
    fields(v, &[])
}
fn arr(v: L<'_>) -> Result<L<'_>> {
    v.from_value(&V::Array(vec![]))
}
fn get<'a>(v: L<'a>, key: &str) -> Result<L<'a>> {
    v.get_key(text(v, key)?)
}
fn set<'a>(v: L<'a>, key: &str, val: L<'a>) -> Result<()> {
    v.set_key(text(v, key)?, val)
}
fn service<'a>(s: L<'a>, port: &CStr, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    call(s.get(port)?, key, args)
}
fn or_value<'a>(a: L<'a>, b: L<'a>) -> Result<L<'a>> {
    Ok(if a.truthy()? { a } else { b })
}
fn first_truthy<'a>(obj: L<'a>, first: &CStr, second: &CStr) -> Result<L<'a>> {
    let v = obj.get(first)?;
    if v.truthy()? {
        Ok(v)
    } else {
        obj.get(second)
    }
}
fn first_present<'a>(obj: L<'a>, first: &CStr, second: &CStr) -> Result<L<'a>> {
    let v = obj.get(first)?;
    if v.nullish()? {
        obj.get(second)
    } else {
        Ok(v)
    }
}
fn trim(v: L<'_>) -> Result<L<'_>> {
    call(string(v)?, c"trim", &[])
}
fn clipped(v: L<'_>, len: usize) -> Result<L<'_>> {
    call(string(v)?, c"slice", &[num(v, 0.)?, num(v, len as f64)?])
}
fn clock(s: L<'_>) -> Result<f64> {
    s.get(c"now")?.call_plain(&[])?.explicit_number()
}
fn finite(v: L<'_>, default: f64) -> Result<f64> {
    let n = v.explicit_number()?;
    Ok(if n.is_finite() { n } else { default })
}
fn metadata(wait: L<'_>) -> Result<L<'_>> {
    or_value(wait.optional(c"metadata")?, object(wait)?)
}
fn scheduled_wait(wait: L<'_>) -> Result<bool> {
    metadata(wait)?.get(c"kind")?.is_string(SCHEDULED)
}
fn state<'a>(s: L<'a>, args: &[(&str, L<'a>)]) -> Result<L<'a>> {
    let st = fields(s, args)?;
    st.set(c"s", s)?;
    Ok(st)
}
fn fail<'a>(s: L<'a>, kind: &CStr, msg: &str) -> Result<L<'a>> {
    Err(s
        .global()?
        .get(kind)?
        .construct(&[text(s, msg)?])?
        .throw_error())
}
fn message<'a>(s: L<'a>, parts: &[L<'a>]) -> Result<L<'a>> {
    let values = arr(s)?;
    for &p in parts {
        call(values, c"push", &[string(p)?])?;
    }
    call(values, c"join", &[text(s, "")?])
}
fn log_parts<'a>(s: L<'a>, parts: &[L<'a>]) -> Result<()> {
    s.get(c"log")?.call_plain(&[message(s, parts)?])?;
    Ok(())
}
pub(super) fn candidate<'a>(draft: L<'a>, collection: &str, filter: L<'a>) -> Result<L<'a>> {
    if draft.get(c"select")?.kind()? == sys::ValueType::napi_function {
        call(
            draft,
            c"select",
            &[
                text(draft, collection)?,
                fields(draft, &[("where", filter)])?,
            ],
        )
    } else {
        call(
            draft.global()?.get(c"Object")?,
            c"values",
            &[get(draft, collection)?],
        )
    }
}
fn add_pending<'a>(s: L<'a>, session: L<'a>, id: L<'a>) -> Result<()> {
    let map = s.get(c"pendingBySession")?;
    let current = call(map, c"get", &[session])?;
    let ids = if current.truthy()? {
        current
    } else {
        s.global()?.get(c"Set")?.construct(&[])?
    };
    call(ids, c"add", &[id])?;
    call(map, c"set", &[session, ids])?;
    Ok(())
}
pub(super) fn remove_pending<'a>(s: L<'a>, session: L<'a>, id: L<'a>) -> Result<()> {
    let map = s.get(c"pendingBySession")?;
    let ids = call(map, c"get", &[session])?;
    if ids.truthy()? {
        call(ids, c"delete", &[id])?;
        if ids.get(c"size")?.is_number(0.)? {
            call(map, c"delete", &[session])?;
        }
    }
    Ok(())
}
pub(super) fn refresh_pending(s: L<'_>) -> Result<L<'_>> {
    let pending = service(
        s,
        c"waits",
        c"list",
        &[fields(s, &[("status", text(s, "pending")?)])?],
    )?;
    after(s, pending, |s, list| {
        call(s.get(c"pendingBySession")?, c"clear", &[])?;
        list.for_each(|w| {
            if !scheduled_wait(w)? {
                add_pending(s, w.get(c"sessionId")?, w.get(c"id")?)?;
            }
            Ok(())
        })?;
        Ok(list)
    })
}
fn has_pending<'a>(s: L<'a>, session: L<'a>) -> Result<L<'a>> {
    flag(
        s,
        service(s, c"pendingBySession", c"get", &[session])?
            .optional(c"size")?
            .truthy()?,
    )
}
fn pending_count(s: L<'_>) -> Result<L<'_>> {
    let mut n = 0.;
    service(s, c"pendingBySession", c"values", &[])?.for_each(|set| {
        n += set.get(c"size")?.number()?;
        Ok(())
    })?;
    num(s, n)
}
pub(super) fn public_wait(w: L<'_>) -> Result<L<'_>> {
    let m = or_value(crate::js_iteration::read(w, c"metadata")?, object(w)?)?;
    let out = fields(
        w,
        &[
            ("id", w.get(c"id")?),
            ("session", w.get(c"sessionId")?),
            ("sessionId", w.get(c"sessionId")?),
            ("mode", w.get(c"mode")?),
            ("status", w.get(c"status")?),
            ("checks", fallback(m.get(c"checks")?, V::Number(0.))?),
            ("maxChecks", m.get(c"maxChecks")?),
            ("intervalSec", m.get(c"intervalSec")?),
            ("pollCmd", m.get(c"pollCmd")?),
            ("pollUrl", m.get(c"pollUrl")?),
            ("untilContains", m.get(c"untilContains")?),
            ("untilRegex", m.get(c"untilRegex")?),
            ("dueAt", m.get(c"dueAt")?),
            ("reason", m.get(c"reason")?),
            ("createdAt", w.get(c"createdAt")?),
            ("resolvedAt", w.get(c"resolvedAt")?),
            ("cancelledAt", w.get(c"cancelledAt")?),
        ],
    )?;
    if m.get(c"dedupeKey")?.truthy()? {
        out.set(c"dedupeKey", m.get(c"dedupeKey")?)?;
    }
    Ok(out)
}
pub(super) fn detached_target(m: L<'_>) -> Result<L<'_>> {
    let field = |key| -> Result<Option<String>> {
        Ok(m.optional(key)?.string()?.map(|s| s.to_string_lossy()))
    };
    match multicc_core::orchestration_store::wakeup::detached_target(
        field(c"pollUrl")?.as_deref(),
        field(c"pollCmd")?.as_deref(),
    ) {
        Some(id) => text(m, id),
        None => null(m),
    }
}
fn register<'a>(s: L<'a>, spec: L<'a>) -> Result<L<'a>> {
    let spec = default_object(spec)?;
    let requested = crate::js_iteration::read(spec, c"mode")?;
    let mode = if requested.is_string("callback")?
        || requested.is_string("delay")?
        || requested.is_string("poll")?
    {
        spec.get(c"mode")?
    } else {
        text(spec, "poll")?
    };
    let at = clock(s)?;
    let details = object(s)?;
    for (k, limit) in [
        ("source", 64),
        ("reason", 4096),
        ("registrationFingerprint", 128),
        ("taskId", 128),
        ("originDispatchId", 128),
    ] {
        let v = get(spec, k)?;
        if v.truthy()? {
            set(details, k, clipped(get(spec, k)?, limit)?)?;
        }
    }
    let scheduled = spec.get(c"scheduledMessageText")?;
    if scheduled.truthy()? {
        details.set(c"kind", text(s, SCHEDULED)?)?;
        details.set(
            c"scheduledMessageText",
            clipped(spec.get(c"scheduledMessageText")?, MAX_MESSAGE_LEN)?,
        )?;
        details.set(
            c"scheduledMessagePreview",
            clipped(spec.get(c"scheduledMessageText")?, 240)?,
        )?;
        for (k, len) in [
            ("scheduledMessageFingerprint", 64),
            ("clientScheduleId", 128),
        ] {
            set(
                details,
                k,
                clipped(fallback(get(spec, k)?, "".into())?, len)?,
            )?;
        }
    }
    let m = object(s)?;
    if mode.is_string("poll")? {
        if !spec.get(c"pollCmd")?.truthy()? && !spec.get(c"pollUrl")?.truthy()? {
            return fail(s, c"Error", "poll mode needs pollCmd or pollUrl");
        }
        if !spec.get(c"untilContains")?.truthy()? && !spec.get(c"untilRegex")?.truthy()? {
            return fail(s, c"Error", "poll mode needs untilContains or untilRegex");
        }
        let interval = finite(spec.get(c"intervalSec")?, POLL_INTERVAL)?.max(MIN_POLL_INTERVAL);
        let cwd = spec.get(c"cwd")?;
        m.set(
            c"cwd",
            if cwd.truthy()? {
                cwd
            } else {
                service(s, c"process", c"cwd", &[])?
            },
        )?;
        for k in ["pollCmd", "pollUrl", "untilContains", "untilRegex"] {
            set(m, k, fallback(get(spec, k)?, V::Null)?)?;
        }
        m.set(c"intervalSec", num(s, interval)?)?;
        m.set(
            c"maxChecks",
            num(
                s,
                finite(spec.get(c"maxChecks")?, POLL_CHECKS)?
                    .floor()
                    .max(1.),
            )?,
        )?;
        m.set(c"checks", num(s, 0.)?)?;
        m.set(c"nextAt", num(s, at + interval * 1000.)?)?;
        m.set(c"pollLeaseId", null(s)?)?;
        m.set(c"pollLeasedUntil", null(s)?)?;
    } else if mode.is_string("callback")? {
        let timeout = finite(spec.get(c"timeoutSec")?, CALLBACK_TIMEOUT)?.max(10.);
        m.set(c"timeoutSec", num(s, timeout)?)?;
        m.set(c"expireAt", num(s, at + timeout * 1000.)?)?;
    } else {
        let delay = finite(first_present(spec, c"delaySec", c"delaySeconds")?, 1.)?
            .clamp(MIN_DELAY, MAX_DELAY);
        m.set(c"delaySec", num(s, delay)?)?;
        m.set(c"dueAt", num(s, at + delay * 1000.)?)?;
        m.set(c"delayLeaseId", null(s)?)?;
        m.set(c"delayLeasedUntil", null(s)?)?;
    }
    m.spread_from(details)?;
    let key = spec.get(c"dedupeKey")?;
    if key.kind()? == sys::ValueType::napi_string {
        let key = trim(key)?;
        if key
            .string()?
            .is_some_and(|v| std::char::decode_utf16(v.as_units().iter().copied()).count() > 256)
        {
            return fail(s, c"Error", "dedupeKey exceeds 256 characters");
        }
        if key.truthy()? {
            m.set(c"dedupeKey", key)?;
        }
    }
    if mode.is_string("poll")? {
        let target = detached_target(m)?;
        if target.truthy()? {
            m.set(c"detachedTaskId", target)?;
        }
    }
    let registration = fields(
        s,
        &[
            ("id", spec.get(c"id")?),
            ("sessionId", first_truthy(spec, c"session", c"sessionId")?),
            ("mode", mode),
            (
                "injectPrefix",
                fallback(spec.get(c"injectPrefix")?, "".into())?,
            ),
            ("metadata", m),
        ],
    )?;
    let promise = wakeups::admit(s, registration, false)?;
    after(state(s, &[("m", m)])?, promise, |st, r| {
        let s = st.get(c"s")?;
        let m = st.get(c"m")?;
        if !m.get(c"kind")?.is_string(SCHEDULED)? {
            add_pending(s, r.get(c"sessionId")?, r.get(c"id")?)?;
        }
        let out = spread(r)?;
        for k in ["token", "callbackUrl"] {
            set(out, k, fallback(get(r, k)?, V::Null)?)?;
        }
        out.set(c"session", r.get(c"sessionId")?)?;
        if m.get(c"dedupeKey")?.truthy()? {
            out.set(c"dedupeKey", m.get(c"dedupeKey")?)?;
        }
        out.set(c"status", text(s, "pending")?)?;
        out.set(c"dueAt", fallback(m.get(c"dueAt")?, V::Null)?)?;
        Ok(out)
    })
}
fn with_status<'a>(result: L<'a>, ok: &str) -> Result<L<'a>> {
    let out = spread(result)?;
    out.set(
        c"status",
        if result.get(c"ok")?.truthy()? {
            text(result, ok)?
        } else {
            result.get(c"status")?
        },
    )?;
    Ok(out)
}
// The outbox commit is authoritative. Broadcast each new admission once;
// a notification failure must not turn a committed resolve into an error.
fn notify_queued<'a>(s: L<'a>, resolved: L<'a>) -> Result<L<'a>> {
    if !resolved.get(c"ok")?.truthy()? || resolved.get(c"idempotent")?.truthy()? {
        return Ok(resolved);
    }
    let st = state(s, &[("resolved", resolved)])?;
    let notice = async_result(s, || {
        service(
            s,
            c"sessionScheduler",
            c"noteQueued",
            &[resolved.get(c"outboxId")?],
        )
    })?;
    let result = after(st, notice, |st, notice| {
        if !notice.optional(c"ok")?.truthy()? {
            log_parts(
                st.get(c"s")?,
                &[
                    text(st, "[orchestration] wait queue notice failed: ")?,
                    fallback(notice.optional(c"code")?, "unknown".into())?,
                ],
            )?;
        }
        st.get(c"resolved")
    })?;
    recover(st, result, |st, e| {
        log_parts(
            st.get(c"s")?,
            &[
                text(st, "[orchestration] wait queue notice failed: ")?,
                e.optional(c"message")?,
            ],
        )?;
        st.get(c"resolved")
    })
}
fn resolve_callback<'a>(s: L<'a>, args: &[L<'a>]) -> Result<L<'a>> {
    let st = state(s, &[("id", args[0])])?;
    after(
        st,
        service(s, c"waits", c"resolveCallback", args)?,
        |st, r| {
            if !r.get(c"ok")?.truthy()? {
                return with_status(r, "resolved");
            }
            let s = st.get(c"s")?;
            st.set(c"result", r)?;
            after(
                st,
                service(s, c"waits", c"get", &[st.get(c"id")?])?,
                |st, w| {
                    if w.truthy()? {
                        remove_pending(st.get(c"s")?, w.get(c"sessionId")?, st.get(c"id")?)?;
                    }
                    after(
                        st,
                        notify_queued(st.get(c"s")?, st.get(c"result")?)?,
                        |_, r| with_status(r, "resolved"),
                    )
                },
            )
        },
    )
}
fn cancel<'a>(s: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let st = state(s, &[("id", id)])?;
    after(st, service(s, c"waits", c"get", &[id])?, |st, w| {
        if w.optional(c"status")?.is_string("resolved")? {
            return wakeups::withdraw_resolved(st.get(c"s")?, st.get(c"id")?);
        }
        st.set(c"before", w)?;
        after(
            st,
            service(st.get(c"s")?, c"waits", c"cancel", &[st.get(c"id")?])?,
            |st, r| {
                if r.get(c"code")?.is_string("not_pending")?
                    && r.get(c"status")?.is_string("resolved")?
                {
                    return wakeups::withdraw_resolved(st.get(c"s")?, st.get(c"id")?);
                }
                let w = st.get(c"before")?;
                if r.get(c"ok")?.truthy()? && w.truthy()? {
                    remove_pending(st.get(c"s")?, w.get(c"sessionId")?, st.get(c"id")?)?;
                }
                with_status(r, "cancelled")
            },
        )
    })
}

pub(super) fn install<'a>(s: L<'a>, api: L<'a>) -> Result<()> {
    type Handler = for<'b> fn(L<'b>, &mut [L<'b>]) -> Result<L<'b>>;
    let methods: &[(&str, usize, usize, Handler)] = &[
        ("register", 0, 1, |s, a| register(s, a[0])),
        ("resolveCallback", 3, 3, |s, a| resolve_callback(s, a)),
        ("cancel", 1, 1, |s, a| cancel(s, a[0])),
        ("scheduleMessage", 0, 1, |s, a| {
            scheduled::schedule_message(s, a[0])
        }),
        ("listScheduledMessages", 1, 1, |s, a| {
            scheduled::list(s, a[0])
        }),
        ("cancelScheduledMessage", 2, 2, |s, a| {
            scheduled::cancel_one(s, a[0], a[1])
        }),
        ("cancelForSession", 1, 1, |s, a| {
            session::cancel_for_session(s, a[0])
        }),
        ("listForSession", 1, 1, |s, a| session::list(s, a[0])),
        ("stats", 0, 0, |s, _| session::stats(s)),
        ("hasSessionActivity", 1, 2, |s, a| {
            session::has_activity(s, a[0], a[1])
        }),
        ("hasPending", 1, 1, |s, a| has_pending(s, a[0])),
        ("pendingCount", 0, 0, |s, _| pending_count(s)),
        ("refreshPending", 0, 0, |s, _| refresh_pending(s)),
    ];
    for &(name, length, count, run) in methods {
        let f = callback(s, name, length, count, run)?;
        set(api, name, f)?;
    }
    Ok(())
}
