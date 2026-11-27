use crate::{
    host_methods::{default_object, function},
    route_response::*,
};
use napi_derive::napi;

fn outcome<'a>(p: L<'a>, event: L<'a>) -> Result<L<'a>> {
    let event = default_object(event)?;
    call(
        p.get(c"state")?,
        c"outcome",
        &[
            p.get(c"id")?,
            p.get(c"kind")?,
            num(p, event.get(c"statusCode")?.explicit_number()?)?,
            event,
        ],
    )
}
fn settle<'a>(p: L<'a>, event: L<'a>) -> Result<L<'a>> {
    let result = outcome(p, event)?;
    if call(p.get(c"state")?, c"claimTerminal", &[])?.truthy()? {
        p.catch(|| p.get(c"onTerminal")?.call_plain(&[result, event]))?;
    }
    Ok(result)
}
fn once<'a>(obj: L<'a>, name: &str, handler: L<'a>) -> Result<()> {
    let once = obj.optional(c"once")?;
    if !once.nullish()? {
        once.call(obj, &[text(obj, name)?, handler])?;
    }
    Ok(())
}
#[napi]
pub fn observe_proxy_response(
    env: Env,
    ports: Unknown<'_>,
    req: Unknown<'_>,
    res: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let res = L::new(&env, res);
    p.set(c"res", res)?;
    let close = function(p, "closed", 0, 0, |p, _| {
        let res = p.get(c"res")?;
        if !res.optional(c"writableEnded")?.truthy()? {
            let expired = p
                .catch(|| p.get(c"beforeDisconnect")?.call_plain(&[])?.is_true())?
                .unwrap_or(false);
            if !expired {
                call(p.get(c"state")?, c"disconnect", &[])?;
                settle(
                    p,
                    fields(
                        p,
                        &[
                            ("status", text(p, "error")?),
                            ("statusCode", res.optional(c"statusCode")?),
                            ("errorCode", text(p, "DOWNSTREAM_DISCONNECT")?),
                        ],
                    )?,
                )?;
            }
        }
        p.from_value(&V::Undefined)
    })?;
    once(L::new(&env, req), "aborted", close)?;
    once(res, "close", close)?;
    once(
        res,
        "finish",
        function(p, "finished", 0, 0, |p, _| {
            let status = p.get(c"res")?.get(c"statusCode")?;
            if status.number()? >= 400. {
                settle(
                    p,
                    fields(p, &[("status", text(p, "error")?), ("statusCode", status)])?,
                )?;
            }
            p.from_value(&V::Undefined)
        })?,
    )?;
    Ok(fields(
        p,
        &[
            (
                "outcome",
                function(p, "outcome", 0, 1, |p, a| outcome(p, a[0]))?,
            ),
            (
                "settle",
                function(p, "settle", 1, 1, |p, a| settle(p, a[0]))?,
            ),
        ],
    )?
    .freeze()?
    .raw())
}
