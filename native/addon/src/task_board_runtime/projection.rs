//! Synchronous projections over the live board. Keep references to the host's
//! records and messages: the board store observes writes to these same objects.
use crate::{
    host_methods::{default_object, function, method},
    js_iteration::read,
    route_response::*,
};
use napi_derive::napi;
use std::ffi::CStr;

mod events;
mod transcript;
mod view;

fn undef(p: L<'_>) -> Result<L<'_>> {
    p.from_value(&V::Undefined)
}

fn or<'a>(v: L<'a>, next: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    if v.truthy()? {
        Ok(v)
    } else {
        next()
    }
}

fn defined<'a>(v: L<'a>, next: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    if v.undefined()? {
        next()
    } else {
        Ok(v)
    }
}

fn plain<'a>(p: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    p.get(key)?.call_plain(args)
}

fn core<'a>(p: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    call(p.get(c"core")?, key, args)
}

fn now(p: L<'_>) -> Result<L<'_>> {
    call(p.global()?.get(c"Date")?, c"now", &[])
}

fn array<'a>(p: L<'a>, values: &[L<'a>]) -> Result<L<'a>> {
    let array = p.global()?.get(c"Array")?.construct(&[])?;
    for (i, v) in values.iter().enumerate() {
        array.set_element(i as u32, *v)?;
    }
    Ok(array)
}

fn spread_array(v: L<'_>) -> Result<L<'_>> {
    let out = array(v, &[])?;
    v.for_each(|el| {
        call(out, c"push", &[el])?;
        Ok(())
    })?;
    Ok(out)
}

fn record<'a>(p: L<'a>, key: L<'a>) -> Result<L<'a>> {
    call(p.get(c"records")?, c"get", &[key])
}

fn board_task<'a>(p: L<'a>, key: L<'a>) -> Result<L<'a>> {
    p.get(c"board")?.get(c"tasks")?.get_key(key)
}

fn worker_record(rec: L<'_>) -> Result<bool> {
    Ok(rec.truthy()?
        && !rec.get(c"type")?.is_string("aux")?
        && !rec.get(c"type")?.is_string("gateway")?
        && !rec.get(c"type")?.is_string("commander")?)
}

fn changed_notice<'a>(p: L<'a>, dir: L<'a>, id: L<'a>, created: bool) -> Result<()> {
    plain(
        p,
        c"notify",
        &[
            fallback(dir, V::Null)?,
            array(p, &[id])?,
            if created {
                text(p, "created")?
            } else {
                undef(p)?
            },
        ],
    )?;
    Ok(())
}

fn log_projection<'a>(p: L<'a>, prefix: &str, result: Result<L<'a>>) -> Result<L<'a>> {
    match result {
        Ok(v) => Ok(v),
        Err(e) => {
            let reason = match p.exception_value()? {
                Some(err) => or(err.optional(c"message")?, || Ok(err))?,
                None => text(p, &e.reason)?,
            };
            let reason = reason.coerce_string()?.to_string_lossy();
            call(
                p.get(c"logger")?,
                c"log",
                &[text(p, &format!("[multicc/taskboard] {prefix}: {reason}"))?],
            )?;
            flag(p, false)
        }
    }
}

#[napi]
pub fn task_board_projection_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let out = fields(p, &[])?;
    for (name, length, count) in [
        ("canonicalMessages", 1, 2),
        ("canonicalTaskBody", 1, 1),
        ("ensureTaskIndex", 1, 1),
        ("onMessagePersisted", 2, 2),
        ("recordRouterAdmission", 0, 1),
        ("reassignTurnTask", 3, 5),
        ("onQueueEvent", 0, 1),
        ("reconcileRunState", 1, 2),
        ("taskDto", 1, 1),
        ("attachBoundWorkspace", 1, 1),
        ("sessionHasTurn", 1, 1),
    ] {
        let f = method(&env, p, name, length, count, move |p, a| match name {
            "canonicalMessages" => transcript::canonical(p, a[0], a[1], false),
            "canonicalTaskBody" => transcript::canonical(p, a[0], undef(p)?, true),
            "ensureTaskIndex" => transcript::ensure(p, a[0]),
            "onMessagePersisted" => log_projection(
                p,
                "canonical projection failed",
                transcript::persisted(p, a[0], a[1]),
            ),
            "recordRouterAdmission" => events::admission(p, default_object(a[0])?),
            "reassignTurnTask" => {
                log_projection(p, "reassignTurnTask error", transcript::reassign(p, a))
            }
            "onQueueEvent" => events::queue(p, default_object(a[0])?),
            "reconcileRunState" => events::reconcile(p, a[0], default_object(a[1])?),
            "taskDto" => view::dto(p, a[0]),
            "attachBoundWorkspace" => view::attach(p, a[0]),
            "sessionHasTurn" => core(p, c"sessionHasTurn", &[record(p, a[0])?]),
            _ => unreachable!(),
        })?;
        out.set_key(text(p, name)?, f)?;
    }
    Ok(out.raw())
}
