//! Idempotent composer messages retain a durable payload through wait resolution.
use super::*;

fn scheduled_view(w: L<'_>) -> Result<L<'_>> {
    let m = metadata(w)?;
    fields(
        w,
        &[
            ("id", crate::js_iteration::read(w, c"id")?),
            ("sessionId", w.get(c"sessionId")?),
            (
                "message",
                fallback(
                    first_truthy(m, c"scheduledMessageText", c"scheduledMessagePreview")?,
                    "".into(),
                )?,
            ),
            ("dueAt", fallback(m.get(c"dueAt")?, V::Null)?),
            ("delaySeconds", fallback(m.get(c"delaySec")?, V::Null)?),
            ("status", w.get(c"status")?),
            ("createdAt", w.get(c"createdAt")?),
            ("resolvedAt", fallback(w.get(c"resolvedAt")?, V::Null)?),
            ("cancelledAt", fallback(w.get(c"cancelledAt")?, V::Null)?),
        ],
    )
}
fn digest<'a>(s: L<'a>, parts: &[L<'a>]) -> Result<L<'a>> {
    let hash = service(s, c"crypto", c"createHash", &[text(s, "sha256")?])?;
    let values = arr(s)?;
    for &p in parts {
        call(values, c"push", &[p])?;
    }
    let bytes = call(values, c"join", &[text(s, "\0")?])?;
    call(hash, c"update", &[bytes, text(s, "utf8")?])?;
    call(hash, c"digest", &[text(s, "hex")?])
}
pub(super) fn schedule_message<'a>(s: L<'a>, spec: L<'a>) -> Result<L<'a>> {
    let spec = default_object(spec)?;
    let session = trim(fallback(
        first_truthy(spec, c"sessionId", c"session")?,
        "".into(),
    )?)?;
    let msg = trim(fallback(spec.get(c"message")?, "".into())?)?;
    let delay = first_present(spec, c"delaySeconds", c"delaySec")?.explicit_number()?;
    if !session.truthy()? {
        return fail(s, c"TypeError", "sessionId is required");
    }
    if !msg.truthy()? {
        return fail(s, c"TypeError", "message is required");
    }
    if crate::js_iteration::read(msg, c"length")?.number()? > MAX_MESSAGE_LEN as f64 {
        return fail(s, c"RangeError", "message is too long (max 262144 chars)");
    }
    if !(MIN_DELAY..=MAX_DELAY).contains(&delay) || delay.trunc() != delay {
        return fail(
            s,
            c"RangeError",
            "delaySeconds must be an integer between 1 and 604800",
        );
    }
    let client = spec.get(c"clientScheduleId")?;
    let client = clipped(
        trim(if client.truthy()? {
            client
        } else {
            service(s, c"crypto", c"randomUUID", &[])?
        })?,
        128,
    )?;
    if !client.truthy()? {
        return fail(s, c"TypeError", "clientScheduleId is required");
    }
    let id = message(
        s,
        &[
            text(s, "scheduled:")?,
            clipped(digest(s, &[session, client])?, 40)?,
        ],
    )?;
    let delay = num(s, delay)?;
    let fingerprint = digest(s, &[session, msg, delay])?;
    let st = state(s, &[("id", id), ("fingerprint", fingerprint)])?;
    let spec = fields(
        s,
        &[
            ("id", id),
            ("session", session),
            ("mode", text(s, "delay")?),
            ("delaySec", delay),
            ("source", text(s, "chat-composer")?),
            ("scheduledMessageText", msg),
            ("scheduledMessageFingerprint", fingerprint),
            ("clientScheduleId", client),
        ],
    )?;
    let promise = async_result(s, || register(s, spec))?;
    let registered = after(st, promise, |st, r| {
        after(
            st,
            service(st.get(c"s")?, c"waits", c"get", &[r.get(c"id")?])?,
            |_, w| {
                let view = scheduled_view(w)?;
                view.set(c"duplicate", flag(w, false)?)?;
                Ok(view)
            },
        )
    })?;
    recover(st, registered, |st, e| {
        if !e.optional(c"code")?.is_string("WAIT_ALREADY_EXISTS")? {
            return Err(e.throw_error());
        }
        after(
            st,
            service(st.get(c"s")?, c"waits", c"get", &[st.get(c"id")?])?,
            |st, w| {
                if !scheduled_wait(w)?
                    || !metadata(w)?
                        .get(c"scheduledMessageFingerprint")?
                        .equals(st.get(c"fingerprint")?)?
                {
                    let err = st.global()?.get(c"Error")?.construct(&[text(
                        st,
                        "clientScheduleId already belongs to another scheduled message",
                    )?])?;
                    err.set(c"code", text(st, "SCHEDULED_MESSAGE_CONFLICT")?)?;
                    err.set(c"statusCode", num(st, 409.)?)?;
                    return Err(err.throw_error());
                }
                let view = scheduled_view(w)?;
                view.set(c"duplicate", flag(w, true)?)?;
                Ok(view)
            },
        )
    })
}
pub(super) fn list<'a>(s: L<'a>, session: L<'a>) -> Result<L<'a>> {
    let filter = fields(
        s,
        &[
            ("sessionId", trim(fallback(session, "".into())?)?),
            ("status", text(s, "pending")?),
        ],
    )?;
    after(s, service(s, c"waits", c"list", &[filter])?, |s, list| {
        let sorted = arr(s)?;
        list.for_each(|w| {
            if scheduled_wait(w)? {
                call(sorted, c"push", &[w])?;
            }
            Ok(())
        })?;
        let cmp = callback(s, "", 2, 2, |s, a| {
            num(
                s,
                metadata(a[0])?.get(c"dueAt")?.explicit_number()?
                    - metadata(a[1])?.get(c"dueAt")?.explicit_number()?,
            )
        })?;
        call(sorted, c"sort", &[cmp])?;
        let views = arr(s)?;
        sorted.for_each(|w| {
            call(views, c"push", &[scheduled_view(w)?])?;
            Ok(())
        })?;
        Ok(views)
    })
}
pub(super) fn cancel_one<'a>(s: L<'a>, session: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let st = state(s, &[("session", session)])?;
    after(
        st,
        service(s, c"waits", c"get", &[trim(fallback(id, "".into())?)?])?,
        |st, w| {
            if !w.truthy()?
                || !w
                    .get(c"sessionId")?
                    .equals(trim(fallback(st.get(c"session")?, "".into())?)?)?
                || !scheduled_wait(w)?
            {
                return fields(
                    st,
                    &[("ok", flag(st, false)?), ("code", text(st, "not_found")?)],
                );
            }
            cancel(st.get(c"s")?, w.get(c"id")?)
        },
    )
}
