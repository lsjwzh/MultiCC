use crate::route_response::*;
use napi_derive::napi;

#[napi]
pub fn system_host_facts(
    env: Env,
    ports: Unknown<'_>,
    version: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let uptime = p.get(c"uptimeSeconds")?.call_plain(&[])?.number()? * 1000.0;
    let math = p.global()?.get(c"Math")?;
    let ms = call(
        math,
        c"max",
        &[num(p, 0.0)?, call(math, c"round", &[num(p, uptime)?])?],
    )?;
    let interfaces = p.get(c"networkInterfaces")?.call_plain(&[])?;
    let bind = p.get(c"getBindHost")?;
    let bind = if bind.kind()? == sys::ValueType::napi_function {
        bind.call_plain(&[])?
    } else {
        text(p, "0.0.0.0")?
    };
    let port = p.get(c"getPort")?.call_plain(&[])?;
    let auth = p.get(c"authRequired")?.call_plain(&[])?.truthy()?;
    let date = p.global()?.get(c"Date")?.construct(&[num(
        p,
        p.get(c"now")?.call_plain(&[])?.number()? - ms.number()?,
    )?])?;
    Ok(fields(
        p,
        &[
            ("interfaces", interfaces),
            ("bindHost", bind),
            ("port", port),
            ("authRequired", flag(p, auth)?),
            ("version", L::new(&env, version)),
            ("startedAt", call(date, c"toISOString", &[])?),
            ("uptimeMs", ms),
        ],
    )?
    .raw())
}

#[napi]
pub fn system_host_operation(
    env: Env,
    body: Unknown<'_>,
    res: Unknown<'_>,
    facts: Unknown<'_>,
    remote: Unknown<'_>,
    trace: Unknown<'_>,
) -> Result<sys::napi_value> {
    let (body, res) = (L::new(&env, body), L::new(&env, res));
    let result = if body.get(c"op")?.is_string("server-info")? {
        res.get(c"json")?
            .call(res, &[L::new(&env, facts).call_plain(&[])?])?
    } else if body.get(c"op")?.is_string("ls-remote")? {
        L::new(&env, remote).call_plain(&[res])?
    } else if body.get(c"op")?.is_string("trace")? {
        let value = body.get(c"limit")?;
        let safe = value
            .number_value()?
            .is_some_and(|n| n.fract() == 0.0 && n.abs() <= 9007199254740991.0);
        let limit = if safe && body.get(c"limit")?.number()? > 0.0 {
            call(
                body.global()?.get(c"Math")?,
                c"min",
                &[body.get(c"limit")?, num(body, 200.0)?],
            )?
        } else {
            num(body, 100.0)?
        };
        let sender = res.get(c"json")?;
        let entries = L::new(&env, trace).call_plain(&[limit])?;
        sender.call(res, &[fields(res, &[("entries", entries)])?])?
    } else {
        error(res, 400, "unknown host operation", false)?
    };
    Ok(result.raw())
}

// Request objects stay live: Express's query parser is supplied by the caller
// and both socket properties must point at the same object during admission.
#[napi]
pub fn relay_host_operation(
    env: Env,
    app: Unknown<'_>,
    body: Unknown<'_>,
    auth: Unknown<'_>,
    catalog: Unknown<'_>,
    respond: Unknown<'_>,
    response: Unknown<'_>,
) -> Result<sys::napi_value> {
    let (app, body, auth, catalog) = (
        L::new(&env, app),
        L::new(&env, body),
        L::new(&env, auth),
        L::new(&env, catalog),
    );
    let res = L::new(&env, response);
    let (json, value) = if body.get(c"op")?.is_string("admission")? {
        let wire = fallback(body.get(c"request")?, V::Object(vec![]))?;
        let url = if wire.get(c"originalUrl")?.kind()? == sys::ValueType::napi_string {
            wire.get(c"originalUrl")?
        } else {
            text(body, "")?
        };
        let query_at = url
            .get(c"indexOf")?
            .call(url, &[text(body, "?")?])?
            .number()?;
        let parser = call(app, c"get", &[text(body, "query parser fn")?])?;
        let socket = fields(body, &[("remoteAddress", wire.get(c"peer")?)])?;
        let request = fields(
            body,
            &[
                ("method", wire.get(c"method")?),
                ("path", wire.get(c"path")?),
                ("url", url),
                ("originalUrl", url),
                (
                    "headers",
                    fallback(wire.get(c"headers")?, V::Object(vec![]))?,
                ),
            ],
        )?;
        let query = if query_at >= 0.0 && parser.kind()? == sys::ValueType::napi_function {
            parser.call_plain(&[url
                .get(c"slice")?
                .call(url, &[num(body, query_at + 1.0)?])?])?
        } else {
            fields(body, &[])?
        };
        for (key, val) in [
            (c"query", query),
            (c"socket", socket),
            (c"connection", socket),
            (c"ip", wire.get(c"peer")?),
            (c"secure", flag(body, false)?),
            (c"id", wire.get(c"id")?),
            (c"correlationId", wire.get(c"correlationId")?),
        ] {
            request.set(key, val)?
        }
        (
            res.get(c"json")?,
            call(auth, c"admitGatewayRequest", &[request])?,
        )
    } else if body.get(c"op")?.is_string("catalogFacts")? {
        (
            res.get(c"json")?,
            catalog.get(c"sourceCatalogFacts")?.call(
                catalog,
                &[
                    body.get(c"appType")?,
                    body.get(c"id")?,
                    fields(
                        body,
                        &[("refresh", flag(body, body.get(c"refresh")?.is_true()?)?)],
                    )?,
                ],
            )?,
        )
    } else {
        return Ok(error(res, 400, "unknown host operation", false)?.raw());
    };
    Ok(L::new(&env, respond).call_plain(&[json, value])?.raw())
}
