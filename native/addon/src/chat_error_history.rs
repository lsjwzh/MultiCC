//! A delayed save failure can only release its own claim. The live payload,
//! original append exception and any thenable stay in the JS callback scope.
use crate::{host_methods::function, js_iteration::read, js_live::spread, route_response::*};
use multicc_core::{chat_error_history::reconnect, js::JsString};
use napi_derive::napi;

#[napi]
pub fn chat_recoverable_reconnect(text: String) -> bool {
    reconnect(&text)
}
fn release(ctx: L<'_>) -> Result<()> {
    let map = ctx.get(c"owner")?.get(c"recent")?;
    let key = ctx.get(c"key")?;
    if call(map, c"get", &[key])?.equals(ctx)? {
        call(map, c"delete", &[key])?;
    }
    Ok(())
}
fn annotated<'a>(payload: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let copy = spread(payload)?;
    copy.define_key(text(copy, "errorClientMsgId")?, id)?;
    Ok(copy)
}
fn annotate<'a>(p: L<'a>, sid: L<'a>, payload: L<'a>) -> Result<L<'a>> {
    if !sid.truthy()?
        || !payload.optional(c"type")?.is_string("error")?
        || p.get(c"append")?.kind()? != sys::ValueType::napi_function
    {
        return Ok(payload);
    }
    let msg = call(p, c"message", &[payload])?
        .string()?
        .unwrap_or_default()
        .trim()
        .truncate_units(4000);
    if msg.is_empty() || reconnect(&msg.to_string_lossy()) {
        return Ok(payload);
    }
    let message = p.from_value(&V::String(msg.clone()))?;
    let recent = p.get(c"recent")?;
    let mut claim = None;
    let result = (|| {
        let at = call(p, c"now", &[])?;
        recent.for_each(|pair| {
            let (key, old) = pair.iterator_pair()?;
            if call(p, c"expired", &[at, old.get(c"at")?])?.truthy()? {
                call(recent, c"delete", &[key])?;
            }
            Ok(())
        })?;
        let key = call(p, c"key", &[sid, message])?;
        let seen = call(recent, c"get", &[key])?;
        if seen.truthy()? {
            return annotated(payload, seen.get(c"id")?);
        }
        let id = call(p, c"id", &[key, at])?;
        let ctx = fields(
            p,
            &[
                ("owner", p),
                ("sid", sid),
                ("id", id),
                ("key", key),
                ("at", at),
            ],
        )?;
        call(recent, c"set", &[key, ctx])?;
        claim = Some(ctx);
        let failed = function(ctx, "onFailure", 1, 1, |ctx, a| {
            release(ctx)?;
            call(ctx.get(c"owner")?, c"warn", &[ctx.get(c"sid")?, a[0]])?;
            ctx.from_value(&V::Undefined)
        })?;
        let code = if read(payload, c"code")?.kind()? == sys::ValueType::napi_string {
            read(payload, c"code")?
        } else {
            p.from_value(&V::Undefined)?
        };
        let content = JsString::concat(&[&JsString::from("Error: "), &msg]);
        let record = fields(
            p,
            &[
                ("role", text(p, "system")?),
                ("content", p.from_value(&V::String(content))?),
                ("ts", at),
                ("clientMsgId", id),
                ("errorEvent", flag(p, true)?),
                ("errorCode", code),
            ],
        )?;
        let saved = p.get(c"append")?.call_plain(&[sid, record])?;
        call(p, c"observe", &[saved, failed])?;
        annotated(payload, id)
    })();
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            let cause = p.exception_value()?.ok_or(error)?;
            if let Some(ctx) = claim {
                release(ctx)?;
            }
            call(p, c"warn", &[sid, cause])?;
            Ok(payload)
        }
    }
}
#[napi]
pub fn chat_error_persister(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    Ok(fields(
        p,
        &[(
            "annotate",
            function(p, "annotate", 2, 2, |p, a| annotate(p, a[0], a[1]))?,
        )],
    )?
    .raw())
}
