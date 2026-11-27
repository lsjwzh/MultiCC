//! This owner keeps the current note collection, including replacements after
//! filtering. The existing workspace socket owner remains authoritative for the
//! event ring. JSONL persistence is best effort; broadcasting follows append.
use crate::{host_methods::function, js_iteration::read, route_response::*};
use napi_derive::napi;
type Port = for<'a> fn(L<'a>, &std::ffi::CStr, &[L<'a>]) -> Result<L<'a>>;

fn recent<'a>(port: Port, p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let owner = port(p, c"events", &[])?;
    if !port(p, c"has", &[owner, id])?.truthy()? {
        let ring = p.from_value(&V::Array(vec![]))?;
        p.catch(|| -> Result<()> {
            let lines = port(p, c"lines", &[id])?;
            let start = (lines.get(c"length")?.number()? as u32).saturating_sub(200);
            for i in start..lines.get(c"length")?.number()? as u32 {
                ring.catch(|| -> Result<()> {
                    let parsed = port(p, c"parse", &[lines.element(i)?])?;
                    call(ring, c"push", &[parsed])?;
                    Ok(())
                })?;
            }
            Ok(())
        })?;
        port(p, c"hydrate", &[owner, id, ring])?;
    }
    port(p, c"recent", &[owner, id])
}
fn append<'a>(port: Port, p: L<'a>, a: &[L<'a>]) -> Result<L<'a>> {
    let (id, kind, detail, sid) = (a[0], a[1], a[2], a[3]);
    if id.truthy()? {
        let session = if sid.truthy()? {
            port(p, c"session", &[sid])?
        } else {
            null(p)?
        };
        let at = port(p, c"now", &[])?;
        let label = if session.truthy()? {
            let label = read(session, c"label")?;
            if label.truthy()? {
                label
            } else {
                read(session, c"id")?
            }
        } else {
            fallback(sid, V::Null)?
        };
        let event = fields(
            p,
            &[
                ("ts", at),
                ("type", kind),
                ("sessionId", fallback(sid, V::Null)?),
                ("sessionLabel", label),
                ("detail", fallback(detail, V::Null)?),
            ],
        )?;
        recent(port, p, id)?;
        port(p, c"append", &[id, event])?;
        p.catch(|| port(p, c"persist", &[id, event]))?;
        let broadcast = port(p, c"broadcast", &[])?;
        if broadcast.kind()? == sys::ValueType::napi_function {
            broadcast.call_plain(&[
                id,
                fields(p, &[("type", text(p, "event")?), ("event", event)])?,
            ])?;
        }
    }
    p.from_value(&V::Undefined)
}
fn filtered<'a>(port: Port, p: L<'a>, sid: L<'a>, purge: bool) -> Result<L<'a>> {
    let predicate = function(sid, "", 1, 1, move |sid, a| {
        let to = read(a[0], c"toSessionId")?.equals(sid)?;
        let keep = if purge {
            !to && !read(a[0], c"fromSessionId")?.equals(sid)?
        } else {
            to && !read(a[0], c"delivered")?.truthy()?
        };
        flag(sid, keep)
    })?;
    port(p, c"filter", &[p.get(c"notes")?, predicate])
}
#[napi]
pub fn workspace_notes_owner(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    Ok(owner(p, call)?.raw())
}
pub(super) fn owner(p: L<'_>, port: Port) -> Result<L<'_>> {
    p.set(c"notes", p.from_value(&V::Array(vec![]))?)?;
    fields(
        p,
        &[
            (
                "loadNotes",
                function(p, "loadNotes", 0, 0, move |p, _| {
                    let next = port(p, c"load", &[])?;
                    if !next.undefined()? {
                        p.set(c"notes", next)?;
                    }
                    p.from_value(&V::Undefined)
                })?,
            ),
            (
                "saveNotes",
                function(p, "saveNotes", 0, 0, move |p, _| {
                    port(p, c"save", &[p.get(c"notes")?])
                })?,
            ),
            (
                "recentEvents",
                function(p, "recentEvents", 1, 1, move |p, a| recent(port, p, a[0]))?,
            ),
            (
                "appendEvent",
                function(p, "appendEvent", 4, 4, move |p, a| append(port, p, a))?,
            ),
            (
                "pendingNotesFor",
                function(p, "pendingNotesFor", 1, 1, move |p, a| {
                    filtered(port, p, a[0], false)
                })?,
            ),
            (
                "purgeNotesForSession",
                function(p, "purgeNotesForSession", 1, 1, move |p, a| {
                    let before = read(p.get(c"notes")?, c"length")?;
                    let notes = filtered(port, p, a[0], true)?;
                    p.set(c"notes", notes)?;
                    if !read(notes, c"length")?.equals(before)? {
                        // Reading length can reenter purge and replace the collection.
                        port(p, c"save", &[p.get(c"notes")?])?;
                    }
                    p.from_value(&V::Undefined)
                })?,
            ),
            (
                "getNotes",
                function(p, "getNotes", 0, 0, |p, _| p.get(c"notes"))?,
            ),
        ],
    )
}
