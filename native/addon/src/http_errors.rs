//! Express request IDs, access logging, rejection forwarding and terminal error responses.
use crate::api_contract::{error_dto, install_error_patterns};
use crate::host_api::*;
use crate::js_iteration::read;
use napi_derive::napi;
use std::ffi::CStr;

fn and_read<'a>(object: L<'a>, key: &CStr) -> Result<L<'a>> {
    if object.truthy()? {
        read(object, key)
    } else {
        Ok(object)
    }
}

// Respect separate property reads in JS short-circuit expressions, including getters.
fn guarded_member<'a>(object: L<'a>, guard: &CStr, member: &CStr) -> Result<L<'a>> {
    let checked = read(object, guard)?;
    if checked.truthy()? {
        read(read(object, guard)?, member)
    } else {
        Ok(checked)
    }
}

fn request_field<'a>(
    req: L<'a>,
    res: L<'a>,
    local: &CStr,
    key: &CStr,
    default: L<'a>,
) -> Result<L<'a>> {
    let value = guarded_member(res, c"locals", local)?;
    if value.truthy()? {
        return Ok(value);
    }
    let value = and_read(req, key)?;
    if value.truthy()? {
        Ok(value)
    } else {
        Ok(default)
    }
}

fn access_finished<'a>(ctx: L<'a>, aborted: bool) -> Result<L<'a>> {
    let res = ctx.get(c"res")?;
    if ctx.get(c"logged")?.truthy()? || (aborted && read(res, c"writableFinished")?.truthy()?) {
        return undef(ctx);
    }
    ctx.set(c"logged", flag(ctx, true)?)?;
    let req = ctx.get(c"req")?;
    let app = read(req, c"app")?;
    if !app.truthy()? || !read(read(req, c"app")?, c"locals")?.truthy()? {
        return undef(ctx);
    }
    let obs = read(read(read(req, c"app")?, c"locals")?, c"observability")?;
    if !obs.truthy()? || !read(obs, c"logger")?.truthy()? {
        return undef(ctx);
    }
    let ms = ctx.get(c"elapsedMs")?.call_plain(&[ctx.get(c"start")?])?;
    let logger = read(obs, c"logger")?;
    let info = read(logger, c"info")?;
    let method = read(req, c"method")?;
    let path = read(req, c"path")?;
    let status = read(res, c"statusCode")?;
    let rounded = call(
        ctx.global()?.get(c"Math")?,
        c"round",
        &[num(ctx, ms.number()? * 1000.)?],
    )?;
    let record = fields(
        ctx,
        &[
            ("requestId", ctx.get(c"id")?),
            ("correlationId", ctx.get(c"correlationId")?),
            ("method", method),
            ("path", path),
            ("status", status),
            ("durationMs", num(ctx, rounded.number()? / 1000.)?),
        ],
    )?;
    if aborted {
        record.set(c"aborted", flag(ctx, true)?)?;
    }
    info.call(logger, &[text(ctx, "http_request")?, record])?;
    undef(ctx)
}

fn request_id_middleware<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (req, res) = (a[0], a[1]);
    let headers = read(req, c"headers")?;
    let ids = crate::http_entry::request_ids(if headers.truthy()? {
        headers
    } else {
        fields(req, &[])?
    })?;
    let id = ids.get(c"id")?;
    let corr = ids.get(c"correlationId")?;
    let clock = read(ports.get(c"process")?, c"hrtime")?;
    let start = call(clock, c"bigint", &[])?;
    req.assign(c"id", id)?;
    req.assign(c"correlationId", corr)?;
    let locals = read(res, c"locals")?;
    res.assign(
        c"locals",
        if locals.truthy()? {
            locals
        } else {
            fields(res, &[])?
        },
    )?;
    read(res, c"locals")?.assign(c"requestId", id)?;
    read(res, c"locals")?.assign(c"correlationId", corr)?;
    for (header, value) in [
        ("X-Multicc-Request-Id", id),
        ("X-Correlation-Id", corr),
        ("X-Multicc-API-Version", ports.get(c"API_VERSION")?),
    ] {
        call(res, c"setHeader", &[text(req, header)?, value])?;
    }
    let ctx = fields(
        ports,
        &[
            ("req", req),
            ("res", res),
            ("id", id),
            ("correlationId", corr),
            ("start", start),
            ("elapsedMs", ports.get(c"elapsedMs")?),
            ("logged", flag(req, false)?),
        ],
    )?;
    for (register, event, aborted) in [(c"once", "finish", false), (c"on", "close", true)] {
        if callable(read(res, register)?)? {
            let cb = function(ctx, "", 0, 0, move |ctx, _| access_finished(ctx, aborted))?;
            call(res, register, &[text(req, event)?, cb])?;
        }
    }
    a[2].call_plain(&[])?;
    undef(req)
}

fn log_error<'a>(logger: L<'a>, err: L<'a>, req: L<'a>, rid: L<'a>, status: L<'a>) -> Result<()> {
    let mut detail = if err.truthy()? {
        let stack = read(err, c"stack")?;
        if stack.truthy()? {
            stack
        } else {
            read(err, c"message")?
        }
    } else {
        err
    };
    if !detail.truthy()? {
        detail = string(err)?;
    }
    let structured = logger.truthy()?
        && read(logger, c"error")?.truthy()?
        && read(read(logger, c"error")?, c"length")?.number()? >= 2.0;
    let write = read(logger, c"error")?;
    if structured {
        let fields = fields(
            req,
            &[
                ("requestId", rid),
                ("correlationId", and_read(req, c"correlationId")?),
                ("method", and_read(req, c"method")?),
                ("path", and_read(req, c"path")?),
                ("status", status),
                ("detail", detail),
            ],
        )?;
        write.call(logger, &[text(rid, "http_error")?, fields])?;
    } else {
        // concat performs ToString in V8, preserving lone surrogates and thrown coercions.
        let message = call(text(rid, "[http:")?, c"concat", &[rid, text(rid, "] ")?])?;
        let message = call(
            message,
            c"concat",
            &[and_read(req, c"method")?, text(rid, " ")?],
        )?;
        let message = call(
            message,
            c"concat",
            &[
                and_read(req, c"path")?,
                text(rid, " → ")?,
                status,
                text(rid, ": ")?,
                detail,
            ],
        )?;
        write.call(logger, &[message])?;
    }
    Ok(())
}

fn terminal<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (err, req, res) = (a[0], a[1], a[2]);
    if read(res, c"headersSent")?.truthy()? {
        return a[3].call_plain(&[err]);
    }
    let rid = request_field(req, res, c"requestId", c"id", text(ctx, "no-req-id")?)?;
    let first = and_read(err, c"status")?;
    let status = if first.number_value()?.is_some_and(|n| n.fract() == 0.0)
        && read(err, c"status")?.number()? >= 400.0
        && read(err, c"status")?.number()? < 600.0
    {
        read(err, c"status")?
    } else {
        num(ctx, 500.)?
    };
    ctx.catch(|| log_error(ctx.get(c"logger")?, err, req, rid, status))?;
    let corr = request_field(req, res, c"correlationId", c"correlationId", rid)?;
    let safe = if err.truthy()?
        && read(err, c"safe")?.truthy()?
        && read(err, c"message")?.kind()? == sys::ValueType::napi_string
    {
        read(err, c"message")?
    } else {
        null(ctx)?
    };
    let message = if status.number()? >= 500.0 {
        text(ctx, "internal_error")?
    } else if safe.truthy()? {
        safe
    } else {
        text(ctx, "request_error")?
    };
    let raw_code = and_read(err, c"code")?;
    let code = if raw_code.truthy()? {
        raw_code
    } else if status.number()? >= 500.0 {
        text(ctx, "internal_error")?
    } else {
        text(ctx, "request_error")?
    };
    let body = error_dto(
        ctx.get(c"patternsOwner")?,
        fields(
            ctx,
            &[
                ("message", message),
                ("code", code),
                ("requestId", rid),
                ("correlationId", corr),
            ],
        )?,
    )?;
    let response = call(res, c"status", &[status])?;
    call(response, c"json", &[body])?;
    undef(ctx)
}

fn error_handler<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let logger = if a[0].undefined()? {
        p.global()?.get(c"console")?
    } else {
        a[0]
    };
    let ctx = fields(p, &[("logger", logger), ("patternsOwner", p)])?;
    function(ctx, "safeErrorHandlerMiddleware", 4, 4, terminal)
}

fn async_handler<'a>(_: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    function(a[0], "wrapped", 3, 3, |handler, args| {
        let promise = handler.global()?.get(c"Promise")?;
        let resolve = read(promise, c"resolve")?;
        let result = handler.call_plain(args)?;
        let promise = resolve.call(promise, &[result])?;
        call(promise, c"catch", &[args[2]])?;
        undef(handler)
    })
}

fn safe_error<'a>(anchor: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let error = anchor.global()?.get(c"Error")?.construct(&[a[1]])?;
    error.assign(c"status", a[0])?;
    error.assign(c"safe", flag(error, true)?)?;
    if a[2].truthy()? {
        error.assign(c"code", a[2])?;
    }
    Ok(error)
}

#[napi]
pub fn http_errors_middleware(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let ports = L::new(&env, ports);
    install_error_patterns(ports)?;
    Ok(defaulted_methods(
        ports,
        &[
            ("requestIdMiddleware", 3, 3, request_id_middleware),
            ("safeErrorHandler", 0, 1, error_handler),
            ("asyncHandler", 1, 1, async_handler),
            ("safeError", 3, 3, safe_error),
        ],
    )?
    .raw())
}
