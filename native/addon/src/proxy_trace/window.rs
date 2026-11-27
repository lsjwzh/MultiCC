//! Request entries and callbacks live in the current V8 isolate. Each response
//! retains its own entry until settlement, even after eviction from the window.
use super::{parts, route, settle};
use crate::host_api::*;
use napi::bindgen_prelude::ToNapiValue;
use napi_derive::napi;

fn or<'a>(a: L<'a>, b: L<'a>) -> Result<L<'a>> {
    Ok(if a.truthy()? { a } else { b })
}

fn url_string(v: L<'_>) -> Result<L<'_>> {
    string(fallback(v, V::from(""))?)
}

fn valid_logger(logger: L<'_>) -> Result<L<'_>> {
    if logger.truthy()? && callable(logger.get(c"warn")?)? {
        Ok(logger)
    } else {
        null(logger)
    }
}

fn model(req: L<'_>) -> Result<L<'_>> {
    let body = req.optional(c"body")?;
    if object(body)? && !body.is_array()? {
        let buffer = body.global()?.get(c"Buffer")?;
        if !call(buffer, c"isBuffer", &[body])?.truthy()? {
            if let Some(s) = body.get(c"model")?.string()? {
                return body.from_value(&V::String(s.truncate_units(80)));
            }
        }
    }
    null(req)
}

pub(crate) fn mark<'a>(res: L<'a>, stage: L<'a>) -> Result<L<'a>> {
    if !res.truthy()? || !stage.truthy()? {
        return undef(res);
    }
    let locals = res.get(c"locals")?;
    let locals = if object(locals)? {
        locals
    } else {
        fields(res, &[])?
    };
    res.set(c"locals", locals)?;
    res.get(c"locals")?
        .set(c"multiccProxyStage", string(stage)?)?;
    res.get(c"locals")?.get(c"multiccProxyStage")
}

fn next(f: L<'_>) -> Result<L<'_>> {
    if callable(f)? {
        f.call_plain(&[])
    } else {
        undef(f)
    }
}

fn finish<'a>(request: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let state = request.get(c"state")?;
    let entry = request.get(c"entry")?;
    let warn = settle(entry, request.get(c"res")?, || {
        let elapsed = now(state)?.number()? - entry.get(c"startedAt")?.number()?;
        num(entry, if elapsed < 0. { 0. } else { elapsed })
    })?;
    let logger = state.get(c"logger")?;
    if warn && logger.truthy()? {
        state.catch(|| {
            let detail = pick(
                entry,
                &[
                    c"requestId",
                    c"method",
                    c"route",
                    c"providerId",
                    c"role",
                    c"model",
                    c"status",
                    c"stage",
                    c"aborted",
                    c"durationMs",
                ],
            )?;
            call(
                logger,
                c"warn",
                &[text(entry, "codex_proxy_trace")?, detail],
            )
        })?;
    }
    undef(state)
}

fn middleware<'a>(state: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let (req, res) = (args[0], args[1]);
    let original = req.optional(c"originalUrl")?;
    let raw = if original.truthy()? {
        original
    } else {
        req.optional(c"url")?
    };
    let parsed = parts(url_string(raw)?)?;
    let seq = num(state, state.get(c"seq")?.number()? + 1.)?;
    state.set(c"seq", seq)?;
    let date = state.global()?.get(c"Date")?.construct(&[now(state)?])?;
    let at = call(date, c"toISOString", &[])?;
    let started = now(state)?;
    let response_id = res.optional(c"locals")?.optional(c"requestId")?;
    let id = if response_id.truthy()? {
        response_id
    } else {
        fallback(req.optional(c"id")?, V::Null)?
    };
    let method = url_string(req.optional(c"method")?)?
        .coerce_string()?
        .to_uppercase();
    let empty = null(state)?;
    let entry = fields(
        state,
        &[
            ("seq", seq),
            ("at", at),
            ("startedAt", started),
            ("requestId", id),
            ("method", state.from_value(&V::String(method))?),
            ("route", route(url_string(raw)?)?),
            ("providerId", parsed.get(c"providerId")?),
            ("session", parsed.get(c"session")?),
            ("role", parsed.get(c"role")?),
            ("model", model(req)?),
            ("stage", empty),
            ("status", empty),
            ("durationMs", empty),
            ("ended", flag(state, false)?),
            ("aborted", flag(state, false)?),
            ("expressResponded", empty),
        ],
    )?;
    let entries = state.get(c"entries")?;
    let length = call(entries, c"push", &[entry])?.number()?;
    if length > state.get(c"capacity")?.number()? {
        call(entries, c"shift", &[])?;
    }
    if callable(res.optional(c"once")?)? {
        let request = fields(state, &[("state", state), ("entry", entry), ("res", res)])?;
        for event in ["finish", "close"] {
            call(
                res,
                c"once",
                &[
                    text(state, event)?,
                    function(request, "settle", 0, 0, finish)?,
                ],
            )?;
        }
    }
    next(args[2])
}

fn positive_integer(n: f64) -> bool {
    n > 0. && n.is_finite() && n.fract() == 0.
}

fn snapshot<'a>(state: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let entries = state.get(c"entries")?;
    let len = entries.get(c"length")?.number()? as u32;
    let limit = args[0]
        .number_value()?
        .filter(|n| positive_integer(*n))
        .unwrap_or(state.get(c"capacity")?.number()?);
    let result = array(state)?;
    for n in 0..len.min(limit as u32) {
        let entry = spread(entries.element(len - 1 - n)?)?;
        entry.delete(c"startedAt")?;
        result.set_element(n, entry)?;
    }
    Ok(result)
}

fn create<'a>(_: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let options = default_object(args[0])?;
    let clock = options.get(c"now")?;
    let clock = if callable(clock)? {
        clock
    } else {
        options.global()?.get(c"Date")?.get(c"now")?
    };
    let size = options.get(c"capacity")?.explicit_number()?;
    let state = fields(
        options,
        &[
            ("now", clock),
            (
                "capacity",
                num(options, if positive_integer(size) { size } else { 200. })?,
            ),
            ("logger", valid_logger(options.get(c"logger")?)?),
            ("entries", array(options)?),
            ("seq", num(options, 0.)?),
        ],
    )?;
    defaulted_methods(
        state,
        &[
            ("middleware", 3, 3, middleware),
            ("unmatched", 3, 3, |s, a| {
                mark(a[1], text(s, "unmatched")?)?;
                next(a[2])
            }),
            ("snapshot", 0, 1, snapshot),
            ("attachLogger", 1, 1, |s, a| {
                let logger = valid_logger(a[0])?;
                s.set(c"logger", logger)?;
                Ok(logger)
            }),
        ],
    )?
    .freeze()
}

#[napi]
pub fn codex_proxy_trace_api(env: Env) -> Result<sys::napi_value> {
    let anchor = L::new(&env, ().into_unknown(&env)?);
    let owner = fields(anchor, &[("shared", null(anchor)?)])?;
    Ok(defaulted_methods(
        owner,
        &[
            ("createCodexProxyTrace", 0, 1, create),
            ("codexProxyTrace", 0, 1, |o, a| {
                let shared = o.get(c"shared")?;
                if !shared.truthy()? {
                    o.set(c"shared", create(o, a)?)?;
                } else {
                    let logger = default_object(a[0])?.get(c"logger")?;
                    if logger.truthy()? {
                        call(shared, c"attachLogger", &[logger])?;
                    }
                }
                o.get(c"shared")
            }),
            ("markStage", 2, 2, |_, a| mark(a[0], a[1])),
            ("setSharedCodexProxyTrace", 1, 1, |o, a| {
                let value = or(a[0], null(o)?)?;
                o.set(c"shared", value)?;
                Ok(value)
            }),
            ("traceParts", 1, 1, |_, a| parts(url_string(a[0])?)),
            ("traceRoute", 1, 1, |_, a| route(url_string(a[0])?)),
        ],
    )?
    .raw())
}
