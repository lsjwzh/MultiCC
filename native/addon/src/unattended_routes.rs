use crate::route_response::*;
use napi_derive::napi;
fn snapshot<'a>(res: L<'a>, state: L<'a>, limits: L<'a>) -> Result<L<'a>> {
    fields(
        res,
        &[
            ("ok", flag(res, true)?),
            ("unattended", fallback(state, V::Null)?),
            ("limits", limits),
        ],
    )
}
fn respond<'a>(res: L<'a>, result: L<'a>, limits: L<'a>) -> Result<L<'a>> {
    if result.get(c"ok")?.truthy()? {
        return send(
            res,
            None,
            snapshot(res, result.get(c"unattended")?, limits)?,
        );
    }
    let status = result.get(c"status")?.explicit_number()?;
    let sender = call(
        res,
        c"status",
        &[num(
            res,
            if status == 0.0 || status.is_nan() {
                409.0
            } else {
                status
            },
        )?],
    )?;
    call(
        sender,
        c"json",
        &[fields(
            res,
            &[
                ("ok", flag(res, false)?),
                (
                    "error",
                    fallback(result.get(c"code")?, "unattended_failed".into())?,
                ),
                ("unattended", null(res)?),
                ("limits", limits),
            ],
        )?],
    )
}
#[napi]
pub fn unattended_route_result(
    env: Env,
    res: Unknown<'_>,
    result: Unknown<'_>,
    limits: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(respond(
        L::new(&env, res),
        L::new(&env, result),
        L::new(&env, limits),
    )?
    .raw())
}
#[napi]
pub fn unattended_route_request(
    env: Env,
    ports: Unknown<'_>,
    write: bool,
    req: Unknown<'_>,
    res: Unknown<'_>,
) -> Result<sys::napi_value> {
    let ports = L::new(&env, ports);
    let d = ports.get(c"deps")?;
    let records = ports.get(c"records")?;
    let limits = ports.get(c"limits")?;
    let req = L::new(&env, req);
    let res = L::new(&env, res);
    let host = if d.get(c"getUnattended")?.kind()? == sys::ValueType::napi_function {
        call(d, c"getUnattended", &[])?
    } else {
        null(d)?
    };
    if !host.truthy()? {
        return Ok(error(res, 501, "unattended_unavailable", true)?.raw());
    }
    let id = req.get(c"params")?.get(c"id")?;
    let rec = call(records, c"get", &[id])?;
    if !rec.truthy()? {
        return Ok(error(res, 404, "session_not_found", true)?.raw());
    }
    if !write {
        return Ok(send(
            res,
            None,
            snapshot(res, call(host, c"get", &[id])?, limits)?,
        )?
        .raw());
    }
    if rec.get(c"type")?.is_string("aux")? || rec.get(c"type")?.is_string("gateway")? {
        return Ok(error(res, 400, "not_a_chat_session", true)?.raw());
    }
    let body = if req.get(c"body")?.truthy()?
        && req.get(c"body")?.kind()? == sys::ValueType::napi_object
    {
        req.get(c"body")?
    } else {
        fields(d, &[])?
    };
    let action = body.get(c"action")?;
    let result = if action.is_string("start")? || action.is_string("resume")? {
        let key = if action.is_string("start")? {
            c"start"
        } else {
            c"resume"
        };
        return Ok(ports
            .get(c"settle")?
            .call_plain(&[res, call(host, key, &[id, body])?])?
            .raw());
    } else if action.is_string("update")? {
        call(host, c"update", &[id, body])?
    } else if action.is_string("clear")? {
        call(host, c"clear", &[id])?
    } else if action.is_string("stop")? {
        call(host, c"stop", &[id])?
    } else {
        let sender = call(res, c"status", &[num(d, 400.0)?])?;
        return Ok(call(
            sender,
            c"json",
            &[fields(
                res,
                &[
                    ("ok", flag(res, false)?),
                    ("error", text(res, "bad_action")?),
                    ("unattended", fallback(call(host, c"get", &[id])?, V::Null)?),
                ],
            )?],
        )?
        .raw());
    };
    Ok(respond(res, result, limits)?.raw())
}
