//! This owner keeps the current note collection, including replacements after
//! filtering. The existing workspace socket owner remains authoritative for the
//! event ring. JSONL persistence is best effort; broadcasting follows append.
use crate::{host_methods::function, js_iteration::read, route_response::*};
use napi_derive::napi;
fn recent<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let owner = call(p, c"events", &[])?;
    if !call(p, c"has", &[owner, id])?.truthy()? {
        let ring = p.from_value(&V::Array(vec![]))?;
        p.catch(|| -> Result<()> {
            let lines = call(p, c"lines", &[id])?;
            let start = (lines.get(c"length")?.number()? as u32).saturating_sub(200);
            for i in start..lines.get(c"length")?.number()? as u32 {
                ring.catch(|| -> Result<()> {
                    let parsed = call(p, c"parse", &[lines.element(i)?])?;
                    call(ring, c"push", &[parsed])?;
                    Ok(())
                })?;
            }
            Ok(())
        })?;
        call(p, c"hydrate", &[owner, id, ring])?;
    }
    call(p, c"recent", &[owner, id])
}
fn append<'a>(p: L<'a>, a: &[L<'a>]) -> Result<L<'a>> {
    let (id, kind, detail, sid) = (a[0], a[1], a[2], a[3]);
    if id.truthy()? {
        let session = if sid.truthy()? {
            call(p, c"session", &[sid])?
        } else {
            null(p)?
        };
        let at = call(p, c"now", &[])?;
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
        recent(p, id)?;
        call(p, c"append", &[id, event])?;
        p.catch(|| call(p, c"persist", &[id, event]))?;
        let broadcast = call(p, c"broadcast", &[])?;
        if broadcast.kind()? == sys::ValueType::napi_function {
            broadcast.call_plain(&[
                id,
                fields(p, &[("type", text(p, "event")?), ("event", event)])?,
            ])?;
        }
    }
    p.from_value(&V::Undefined)
}
fn filtered<'a>(p: L<'a>, sid: L<'a>, purge: bool) -> Result<L<'a>> {
    let predicate = function(sid, "", 1, 1, move |sid, a| {
        let to = read(a[0], c"toSessionId")?.equals(sid)?;
        let keep = if purge {
            !to && !read(a[0], c"fromSessionId")?.equals(sid)?
        } else {
            to && !read(a[0], c"delivered")?.truthy()?
        };
        flag(sid, keep)
    })?;
    call(p, c"filter", &[p.get(c"notes")?, predicate])
}
#[napi]
pub fn workspace_notes_owner(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    p.set(c"notes", p.from_value(&V::Array(vec![]))?)?;
    Ok(fields(
        p,
        &[
            (
                "loadNotes",
                function(p, "loadNotes", 0, 0, |p, _| {
                    let next = call(p, c"load", &[])?;
                    if !next.undefined()? {
                        p.set(c"notes", next)?;
                    }
                    p.from_value(&V::Undefined)
                })?,
            ),
            (
                "saveNotes",
                function(p, "saveNotes", 0, 0, |p, _| {
                    call(p, c"save", &[p.get(c"notes")?])
                })?,
            ),
            (
                "recentEvents",
                function(p, "recentEvents", 1, 1, |p, a| recent(p, a[0]))?,
            ),
            (
                "appendEvent",
                function(p, "appendEvent", 4, 4, |p, a| append(p, a))?,
            ),
            (
                "pendingNotesFor",
                function(p, "pendingNotesFor", 1, 1, |p, a| filtered(p, a[0], false))?,
            ),
            (
                "purgeNotesForSession",
                function(p, "purgeNotesForSession", 1, 1, |p, a| {
                    let before = read(p.get(c"notes")?, c"length")?;
                    let notes = filtered(p, a[0], true)?;
                    p.set(c"notes", notes)?;
                    if !read(notes, c"length")?.equals(before)? {
                        // Reading length can reenter purge and replace the collection.
                        call(p, c"save", &[p.get(c"notes")?])?;
                    }
                    p.from_value(&V::Undefined)
                })?,
            ),
            (
                "getNotes",
                function(p, "getNotes", 0, 0, |p, _| p.get(c"notes"))?,
            ),
        ],
    )?
    .raw())
}
