//! Live task-board operations. A pending host call retains its V8 frame until
//! the matching continuation settles; board records are read again after waits.
use crate::{
    host_methods::{async_result, default_object, function},
    route_response::*,
};
use napi_derive::napi;
use std::ffi::CStr;

mod binding;
mod commander;
mod status;

fn undef(p: L<'_>) -> Result<L<'_>> {
    p.from_value(&V::Undefined)
}
fn p(f: L<'_>) -> Result<L<'_>> {
    f.get(c"ports")
}
fn array(p: L<'_>) -> Result<L<'_>> {
    p.global()?.get(c"Array")?.construct(&[])
}
fn either<'a>(a: L<'a>, b: L<'a>) -> Result<L<'a>> {
    Ok(if a.truthy()? { a } else { b })
}
fn local<'a>(p: L<'a>, name: &CStr, a: &[L<'a>]) -> Result<L<'a>> {
    p.get(name)?.call_plain(a)
}
fn after<'a>(
    frame: L<'a>,
    pending: L<'a>,
    step: for<'b> fn(L<'b>, L<'b>) -> Result<L<'b>>,
) -> Result<L<'a>> {
    let promise = call(frame.global()?.get(c"Promise")?, c"resolve", &[pending])?;
    call(
        promise,
        c"then",
        &[function(frame, "", 1, 1, move |f, a| step(f, a[0]))?],
    )
}
fn held<'a>(p: L<'a>, id: L<'a>, run: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    let release = local(p, c"holdTaskOperation", &[id])?;
    call(async_result(p, run)?, c"finally", &[release])
}
fn ok(p: L<'_>) -> Result<L<'_>> {
    fields(p, &[("ok", flag(p, true)?)])
}
fn failure<'a>(p: L<'a>, code: L<'a>) -> Result<L<'a>> {
    fields(p, &[("ok", flag(p, false)?), ("code", code)])
}

#[napi]
pub fn task_board_lifecycle_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = fields(p, &[])?;
    for (name, length, count) in [
        ("routeCommanderInput", 2, 3),
        ("routeCommanderFollowup", 3, 4),
        ("resolveLegacySessionQueues", 2, 2),
        ("ensureBoundChatSession", 1, 2),
        ("handleStatus", 2, 2),
        ("handleChatSession", 2, 2),
        ("rejectShellOperation", 2, 2),
        ("sessionTranscriptHoldsTask", 2, 2),
    ] {
        let f = function(p, name, length, count, move |p, a| {
            match name {
                "rejectShellOperation" => return flag(p, status::reject(p, a[0], a[1])?),
                "sessionTranscriptHoldsTask" => return flag(p, binding::holds(p, a[0], a[1])?),
                _ => {}
            }
            async_result(p, || match name {
                "routeCommanderInput" => commander::input(p, a),
                "routeCommanderFollowup" => commander::followup(p, a),
                "resolveLegacySessionQueues" => status::resolve_queues(p, a[0], a[1]),
                "ensureBoundChatSession" => binding::ensure(p, a[0], default_object(a[1])?),
                "handleStatus" => status::handle(p, a[0], a[1]),
                "handleChatSession" => binding::chat(p, a[0], a[1]),
                _ => unreachable!(),
            })
        })?;
        api.set_key(text(p, name)?, f)?;
    }
    Ok(api.raw())
}
