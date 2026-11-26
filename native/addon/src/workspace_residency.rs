//! One registry per stream router. Live Map keys and callbacks retain JS
//! identity. Each claim snapshots entries before the first asynchronous close.
use crate::{host_methods::function, js_iteration::read, route_response::*};
use napi_derive::napi;

fn entry<'a>(p: L<'a>, name: L<'a>) -> Result<L<'a>> {
    call(p.get(c"entries")?, c"get", &[name])
}
fn busy(p: L<'_>) -> Result<napi::Error> {
    Ok(call(p, c"busy", &[])?.throw_error())
}
fn assert_send<'a>(p: L<'a>, name: L<'a>) -> Result<()> {
    if entry(p, name)?.optional(c"parked")?.truthy()? {
        return Err(busy(p)?);
    }
    Ok(())
}
fn idle<'a>(p: L<'a>, name: L<'a>) -> Result<bool> {
    let s = call(p, c"status", &[name])?;
    Ok(!call(p, c"pending", &[name])?.truthy()?
        && !s.optional(c"busy")?.truthy()?
        && !s.optional(c"queued")?.truthy()?
        && !s.optional(c"recycling")?.truthy()?)
}
fn store<'a>(
    p: L<'a>,
    name: L<'a>,
    path: L<'a>,
    workspace: L<'a>,
    parked: L<'a>,
    activity: L<'a>,
) -> Result<()> {
    let record = fields(
        p,
        &[
            ("path", path),
            ("workspaceId", workspace),
            ("parked", parked),
            ("onActivity", activity),
        ],
    )?;
    call(p.get(c"entries")?, c"set", &[name, record])?;
    Ok(())
}
#[napi]
pub fn workspace_residency(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    Ok(fields(
        p,
        &[
            (
                "assertSend",
                function(p, "assertSend", 1, 1, |p, a| {
                    assert_send(p, a[0])?;
                    p.from_value(&V::Undefined)
                })?,
            ),
            (
                "track",
                function(p, "track", 3, 3, |p, a| {
                    assert_send(p, a[0])?;
                    let old = entry(p, a[0])?;
                    if old.truthy()? {
                        if !old.get(c"path")?.equals(call(p, c"location", &[a[1]])?)? {
                            return Err(busy(p)?);
                        }
                        if !a[2].undefined()? {
                            call(p, c"setActivity", &[old, a[2]])?;
                        }
                    } else {
                        store(
                            p,
                            a[0],
                            call(p, c"location", &[a[1]])?,
                            null(p)?,
                            flag(p, false)?,
                            a[2],
                        )?;
                    }
                    p.from_value(&V::Undefined)
                })?,
            ),
            (
                "park",
                function(p, "park", 2, 2, |p, a| {
                    let (name, w) = (a[0], a[1]);
                    let mut parked = false;
                    if w.optional(c"path")?.truthy()?
                        && idle(p, name)?
                        && !call(p, c"status", &[name])?
                            .optional(c"backgroundActive")?
                            .truthy()?
                    {
                        let old = entry(p, name)?;
                        if !old.truthy()?
                            || old.get(c"path")?.equals(call(
                                p,
                                c"location",
                                &[read(w, c"path")?],
                            )?)?
                        {
                            store(
                                p,
                                name,
                                call(p, c"location", &[read(w, c"path")?])?,
                                read(w, c"id")?,
                                flag(p, true)?,
                                old.optional(c"onActivity")?,
                            )?;
                            parked = true;
                        }
                    }
                    fields(p, &[("parked", flag(p, parked)?)])
                })?,
            ),
            (
                "prepareClose",
                function(p, "prepareClose", 6, 6, |p, a| {
                    let (name, w, target, exclusive, id, old) =
                        (a[0], a[1], a[2], a[3], a[4], a[5]);
                    if !id.equals(name)?
                        && !old.get(c"path")?.equals(target)?
                        && !(read(w, c"id")?.truthy()?
                            && old.get(c"workspaceId")?.equals(read(w, c"id")?)?)
                    {
                        return flag(p, false);
                    }
                    if !idle(p, id)? {
                        return Err(busy(p)?);
                    }
                    if id.equals(name)?
                        && old.get(c"path")?.equals(target)?
                        && !exclusive.truthy()?
                    {
                        return flag(p, false);
                    }
                    if call(p, c"status", &[id])?
                        .optional(c"backgroundActive")?
                        .truthy()?
                    {
                        return Err(busy(p)?);
                    }
                    call(p, c"setParked", &[old])?;
                    flag(p, true)
                })?,
            ),
            (
                "finish",
                function(p, "finish", 4, 4, |p, a| {
                    store(
                        p,
                        a[0],
                        a[2],
                        read(a[1], c"id")?,
                        a[3],
                        entry(p, a[0])?.optional(c"onActivity")?,
                    )?;
                    fields(p, &[("claimed", flag(p, true)?)])
                })?,
            ),
        ],
    )?
    .raw())
}
