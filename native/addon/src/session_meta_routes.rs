//! Session notes share the host's live records and notes array. Keep their JS
//! identity and read the current store through its port on every request.
use crate::{host_methods::method, js_iteration::read, js_live::invoke, route_response::*};
use napi_derive::napi;
use std::ffi::CStr;

#[napi]
pub fn session_meta_validate(env: Env, ports: Unknown<'_>) -> Result<()> {
    let p = L::new(&env, ports);
    let sessions = p.get(c"persistedSessions")?;
    if !sessions.truthy()? || sessions.get(c"get")?.kind()? != sys::ValueType::napi_function {
        return Err(p.type_error("[session-meta] persistedSessions map is required"));
    }
    for name in [
        c"asyncHandler",
        c"appendEvent",
        c"workspaceBroadcast",
        c"saveNotes",
        c"pendingNotesFor",
        c"getNotes",
        c"getLivenessRuntime",
    ] {
        if p.get(name)?.kind()? != sys::ValueType::napi_function {
            return Err(p.type_error(&format!(
                "[session-meta] {} must be a function",
                name.to_string_lossy()
            )));
        }
    }
    Ok(())
}

fn request_id<'a>(req: L<'a>) -> Result<L<'a>> {
    read(read(req, c"params")?, c"id")
}

fn session<'a>(p: L<'a>, req: L<'a>) -> Result<L<'a>> {
    let records = p.get(c"persistedSessions")?;
    records.get(c"get")?.call(records, &[request_id(req)?])
}

fn trimmed<'a>(req: L<'a>, key: &CStr, site: &str) -> Result<L<'a>> {
    let value = fallback(read(read(req, c"body")?, key)?, "".into())?;
    invoke(value, value.get(c"trim")?, &[], site)
}

fn label(record: L<'_>) -> Result<L<'_>> {
    let label = record.get(c"label")?;
    if label.truthy()? {
        Ok(label)
    } else {
        record.get(c"id")
    }
}

#[napi]
pub fn session_meta_post_note(
    env: Env,
    ports: Unknown<'_>,
    req: Unknown<'_>,
    res: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let req = L::new(&env, req);
    let res = L::new(&env, res);
    let from = session(p, req)?;
    if !from.truthy()? {
        return Ok(error(res, 404, "session not found", false)?.raw());
    }
    let to_id = trimmed(req, c"toSessionId", "(req.body.toSessionId || \"\").trim")?;
    let body = trimmed(req, c"body", "(req.body.body || \"\").trim")?;
    if !to_id.truthy()? || !body.truthy()? {
        return Ok(error(res, 400, "toSessionId 和 body 必填", false)?.raw());
    }
    let to = call(p.get(c"persistedSessions")?, c"get", &[to_id])?;
    if !to.truthy()? {
        return Ok(error(res, 404, "target session not found", false)?.raw());
    }
    if !to.get(c"dirId")?.equals(from.get(c"dirId")?)? {
        return Ok(error(res, 400, "只能给同一目录下的会话留言", false)?.raw());
    }
    let note = fields(
        p,
        &[
            ("id", call(p.get(c"crypto")?, c"randomUUID", &[])?),
            ("dirId", from.get(c"dirId")?),
            ("fromSessionId", from.get(c"id")?),
            ("fromLabel", label(from)?),
            ("toSessionId", to.get(c"id")?),
            (
                "body",
                call(body, c"slice", &[num(p, 0.0)?, num(p, 4000.0)?])?,
            ),
            ("ts", call(p.global()?.get(c"Date")?, c"now", &[])?),
            ("delivered", flag(p, false)?),
            ("deliveredAt", null(p)?),
        ],
    )?;
    let notes = p.get(c"getNotes")?.call_plain(&[])?;
    call(notes, c"push", &[note])?;
    p.get(c"saveNotes")?.call_plain(&[])?;
    p.get(c"appendEvent")?.call_plain(&[
        from.get(c"dirId")?,
        text(p, "note")?,
        call(text(p, "→ ")?, c"concat", &[label(to)?])?,
        from.get(c"id")?,
    ])?;
    let dir = from.get(c"dirId")?;
    let session_id = to.get(c"id")?;
    let pending = p.get(c"pendingNotesFor")?.call_plain(&[to.get(c"id")?])?;
    let event = fields(
        p,
        &[
            ("type", text(p, "note_pending")?),
            ("sessionId", session_id),
            ("count", read(pending, c"length")?),
        ],
    )?;
    p.get(c"workspaceBroadcast")?.call_plain(&[dir, event])?;
    call(res, c"json", &[note])?;
    Ok(p.from_value(&V::Undefined)?.raw())
}

#[napi]
pub fn session_meta_list_notes(
    env: Env,
    ports: Unknown<'_>,
    req: Unknown<'_>,
    res: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let res = L::new(&env, res);
    let record = session(p, L::new(&env, req))?;
    if !record.truthy()? {
        return Ok(error(res, 404, "session not found", false)?.raw());
    }
    let json = res.get(c"json")?;
    let notes = p.get(c"getNotes")?.call_plain(&[])?;
    let filter = read(notes, c"filter")?;
    // Call the original collection's filter to preserve holes, species and row identity.
    let matches = method(&env, record, "", 1, 1, |record, args| {
        let note = args[0];
        flag(
            record,
            read(note, c"toSessionId")?.equals(record.get(c"id")?)?
                || read(note, c"fromSessionId")?.equals(record.get(c"id")?)?,
        )
    })?;
    json.call(res, &[filter.call(notes, &[matches])?])?;
    Ok(p.from_value(&V::Undefined)?.raw())
}

#[napi]
pub fn session_meta_assessment(
    env: Env,
    ports: Unknown<'_>,
    req: Unknown<'_>,
    res: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let req = L::new(&env, req);
    let res = L::new(&env, res);
    let found = session(p, req)?.truthy()?;
    let value = if found {
        let probe = !read(read(req, c"query")?, c"probe")?.is_string("0")?;
        let runtime = p.get(c"getLivenessRuntime")?.call_plain(&[])?;
        read(runtime, c"assess")?.call(
            runtime,
            &[request_id(req)?, fields(p, &[("probe", flag(p, probe)?)])?],
        )?
    } else {
        error(res, 404, "session not found", false)?
    };
    Ok(fields(p, &[("found", flag(p, found)?), ("value", value)])?.raw())
}
