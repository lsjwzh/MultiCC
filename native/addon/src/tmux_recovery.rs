//! Startup recovery is best effort. The host owns all three session tables;
//! the cursor retains only the iterator and the id being recovered across await.
use crate::{host_methods::function, route_response::*};
use napi_derive::napi;

fn undefined(p: L<'_>) -> Result<L<'_>> {
    p.from_value(&V::Undefined)
}

fn message<'a>(p: L<'a>, prefix: &str, parts: &[L<'a>]) -> Result<L<'a>> {
    call(text(p, prefix)?, c"concat", parts)
}

fn creation_failed<'a>(ports: L<'a>, id: L<'a>, error: L<'a>) -> Result<()> {
    let label = message(
        ports,
        "[multicc] Failed to recover session ",
        &[id, text(ports, ":")?],
    )?;
    call(
        ports.get(c"logger")?,
        c"error",
        &[label, error.get(c"message")?],
    )?;
    Ok(())
}

fn close(cursor: L<'_>) -> Result<L<'_>> {
    // A failure in the loop body closes the iterator (for-of IteratorClose).
    // Like the original startup boundary, recovery then completes normally.
    cursor.catch(|| cursor.get(c"iterator")?.iterator_close())?;
    undefined(cursor)
}

fn visit<'a>(cursor: L<'a>, name: L<'a>) -> Result<Option<L<'a>>> {
    let p = cursor.get(c"ports")?;
    let prefix = p.get(c"prefix")?;
    if !name.truthy()? || !call(name, c"startsWith", &[prefix])?.truthy()? {
        return Ok(None);
    }
    let id = call(name, c"slice", &[prefix.get(c"length")?])?;
    if call(p.get(c"sessions")?, c"has", &[id])?.truthy()? {
        return Ok(None);
    }
    let record = call(p.get(c"persistedSessions")?, c"get", &[id])?;
    if !record.truthy()? || !record.get(c"kind")?.is_string("terminal")? {
        return Ok(None);
    }
    let invalid = p.get(c"invalidSessions")?;
    if call(invalid, c"has", &[id])?.truthy()? {
        let label = message(
            p,
            "[multicc] skipping recovery of ",
            &[id, text(p, ": ")?, call(invalid, c"get", &[id])?],
        )?;
        call(p.get(c"logger")?, c"warn", &[label])?;
        return Ok(None);
    }
    let label = message(
        p,
        "[multicc] Recovering tmux session: ",
        &[id, text(p, " (")?, record.get(c"cli")?, text(p, ")")?],
    )?;
    call(p.get(c"logger")?, c"log", &[label])?;
    let created = match p.get(c"createSession")?.call_plain(&[id]) {
        Ok(value) => value,
        Err(e) => {
            if let Some(cause) = p.exception_value()? {
                creation_failed(p, id, cause)?;
            } else {
                return Err(e);
            }
            return Ok(None);
        }
    };
    let pending = call(p.global()?.get(c"Promise")?, c"resolve", &[created])?;
    cursor.set(c"id", id)?;
    let success = function(cursor, "", 1, 1, |cursor, _| advance(cursor))?;
    let failure = function(cursor, "", 1, 1, |cursor, args| {
        if cursor
            .catch(|| creation_failed(cursor.get(c"ports")?, cursor.get(c"id")?, args[0]))?
            .is_none()
        {
            return close(cursor);
        }
        advance(cursor)
    })?;
    Ok(Some(call(pending, c"then", &[success, failure])?))
}

fn advance(cursor: L<'_>) -> Result<L<'_>> {
    let iterator = cursor.get(c"iterator")?;
    let next = cursor.get(c"next")?;
    while let Some(name) = iterator.iterator_step(next)? {
        match cursor.catch(|| visit(cursor, name))? {
            Some(Some(pending)) => return Ok(pending),
            Some(None) => continue,
            None => return close(cursor),
        }
    }
    undefined(cursor)
}

#[napi]
pub fn recover_tmux_sessions(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let ports = L::new(&env, ports);
    let promise = ports.global()?.get(c"Promise")?;
    let Some(names) = ports.catch(|| ports.get(c"list")?.call_plain(&[]))? else {
        return Ok(call(promise, c"resolve", &[undefined(ports)?])?.raw());
    };
    let listed = call(promise, c"resolve", &[names])?;
    let begin = function(ports, "", 1, 1, |p, args| {
        let (iterator, next) = args[0].iterator()?;
        advance(fields(
            p,
            &[("ports", p), ("iterator", iterator), ("next", next)],
        )?)
    })?;
    let recovery = call(listed, c"then", &[begin])?;
    let finish = function(ports, "", 1, 1, |p, _| undefined(p))?;
    Ok(call(recovery, c"catch", &[finish])?.raw())
}
