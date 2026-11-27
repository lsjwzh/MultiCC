//! Public diagnostics read live Error objects lazily, including inherited
//! properties. The Web Streams reader stays with its host AbortSignal.
use crate::api_error_text::{js_string, string_or_empty};
use crate::host_api::*;
use multicc_core::js::JsString;
use napi_derive::napi;

const MAX_ERROR_BYTES: usize = 65_536;

fn record(v: L<'_>) -> Result<bool> {
    Ok(object(v)? && !v.is_array()?)
}

fn embedded(v: L<'_>) -> Result<Option<L<'_>>> {
    let raw = string(fallback(v, "".into())?)?;
    let prefix = call(
        raw,
        c"slice",
        &[num(v, 0.)?, num(v, MAX_ERROR_BYTES as f64)?],
    )?;
    let input = prefix.coerce_string()?;
    let units = input.as_units();
    let (mut start, mut depth, mut quoted, mut escaped) = (0, 0, false, false);
    for (i, &unit) in units.iter().take(MAX_ERROR_BYTES).enumerate() {
        if depth == 0 {
            if unit == 123 {
                start = i;
                depth = 1;
            }
        } else if quoted {
            if escaped {
                escaped = false;
            } else if unit == 92 {
                escaped = true;
            } else if unit == 34 {
                quoted = false;
            }
        } else if unit == 34 {
            quoted = true;
        } else if unit == 123 {
            depth += 1;
        } else if unit == 125 {
            depth -= 1;
            if depth == 0 {
                let snippet = v.from_value(&V::String(input.slice_units(start, i + 1)))?;
                if let Some(item) = v.catch(|| json_call(v, c"parse", snippet))? {
                    if item.get(c"error")?.truthy()?
                        || item.get(c"response")?.optional(c"error")?.truthy()?
                    {
                        return Ok(Some(item));
                    }
                }
            }
        }
    }
    Ok(None)
}

fn from_message(v: L<'_>) -> Result<L<'_>> {
    match embedded(v)? {
        Some(item) => Ok(item),
        None => fields(v, &[("message", v)]),
    }
}

fn extract(mut item: L<'_>) -> Result<L<'_>> {
    if item.kind()? == sys::ValueType::napi_string {
        item = from_message(item)?;
    }
    let out = fields(item, &[])?;
    let seen = item.global()?.get(c"Set")?.construct(&[])?;
    for _ in 0..8 {
        if !record(item)? || call(seen, c"has", &[item])?.truthy()? {
            break;
        }
        call(seen, c"add", &[item])?;
        for k in [c"message", c"code", c"type", c"param"] {
            if item.get(k)?.kind()? == sys::ValueType::napi_string && item.get(k)?.truthy()? {
                out.set(k, item.get(k)?)?;
            }
        }
        let mut status = undef(item)?;
        for k in [
            c"httpStatus",
            c"http_status",
            c"statusCode",
            c"status_code",
            c"upstreamStatus",
        ] {
            status = item.get(k)?;
            if !status.nullish()? {
                break;
            }
        }
        if status.explicit_number()? >= 400. && status.explicit_number()? <= 599. {
            out.set(c"httpStatus", num(item, status.explicit_number()?)?)?;
        }
        let mut id = item.get(c"requestId")?;
        if !id.truthy()? {
            id = item.get(c"request_id")?;
        }
        if id.kind()? == sys::ValueType::napi_string {
            out.set(c"requestId", id)?;
        }
        let mut next = item.get(c"response")?.optional(c"error")?;
        if !next.truthy()? {
            next = item.get(c"error")?;
        }
        item = if record(next)? {
            next
        } else if next.kind()? == sys::ValueType::napi_string {
            from_message(next)?
        } else if let Some(nested) = embedded(item.get(c"message")?)? {
            nested
        } else {
            break;
        };
    }
    Ok(out)
}

fn sanitize<'a>(v: L<'a>, secrets: L<'a>, limit: L<'a>) -> Result<L<'a>> {
    let input = string_or_empty(v)?;
    let filter = function(v, "nonemptyString", 1, 1, |p, a| {
        flag(
            p,
            a[0].kind()? == sys::ValueType::napi_string && a[0].truthy()?,
        )
    })?;
    let mut known: Vec<JsString> = Vec::new();
    call(secrets, c"filter", &[filter])?.for_each(|s| {
        if let Some(value) = s.string()? {
            known.push(value);
        }
        Ok(())
    })?;
    let clean = multicc_core::redaction::sanitize_upstream(&input, known);
    let result = v.from_value(&V::String(clean))?;
    call(result, c"slice", &[num(v, 0.)?, limit])
}

fn public<'a>(input: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let opts = default_object(opts)?;
    let secrets = with_default(opts.get(c"secrets")?, array(opts)?)?;
    let fallback = with_default(
        opts.get(c"fallback")?,
        text(opts, "Upstream API request failed")?,
    )?;
    let parsed = extract(input)?;
    let message = parsed.get(c"message")?;
    let safe = sanitize(
        if message.truthy()? { message } else { fallback },
        secrets,
        num(opts, 2048.)?,
    )?;
    let out = fields(
        opts,
        &[("message", if safe.truthy()? { safe } else { fallback })],
    )?;
    for k in [c"code", c"type", c"param", c"requestId"] {
        let v = parsed.get(k)?;
        if v.kind()? == sys::ValueType::napi_string {
            out.set(k, sanitize(v, secrets, num(opts, 200.)?)?)?;
        }
    }
    let status = parsed.get(c"httpStatus")?;
    if status.truthy()? {
        out.set(c"httpStatus", status)?;
    }
    Ok(out)
}

fn transport<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let mut error = args[0];
    let seen = p.global()?.get(c"Set")?.construct(&[])?;
    let mut parts = Vec::new();
    let mut code = undef(p)?;
    for _ in 0..5 {
        if !error.truthy()? || call(seen, c"has", &[error])?.truthy()? {
            break;
        }
        call(seen, c"add", &[error])?;
        for k in [c"message", c"code"] {
            if error.get(k)?.truthy()? {
                let value = js_string(error.get(k)?)?;
                if k == c"code" {
                    code = p.from_value(&V::String(value.clone()))?;
                }
                if !parts.contains(&value) {
                    parts.push(value);
                }
            }
        }
        error = error.get(c"cause")?;
    }
    let pieces: Vec<_> = parts.iter().map(JsString::as_units).collect();
    let message = p.from_value(&V::String(JsString::from_units(
        pieces.join(&[58u16, 32][..]),
    )))?;
    public(fields(p, &[("message", message), ("code", code)])?, args[1])
}

fn status_text(response: L<'_>) -> Result<L<'_>> {
    let value = response.get(c"statusText")?;
    if value.truthy()? {
        return Ok(value);
    }
    let mut units = vec![72, 84, 84, 80, 32];
    units.extend(response.get(c"status")?.coerce_string()?.into_units());
    response.from_value(&V::String(JsString::from_units(units)))
}

#[napi]
pub fn upstream_diagnostics_api(env: Env, read_body: Unknown<'_>) -> Result<sys::napi_value> {
    let port = L::new(&env, read_body);
    Ok(defaulted_methods(
        port,
        &[
            ("extractUpstreamError", 1, 1, |_, a| extract(a[0])),
            ("publicTransportError", 1, 2, transport),
            ("publicUpstreamError", 1, 2, |_, a| public(a[0], a[1])),
            ("readUpstreamError", 1, 2, |port, a| {
                async_result(port, || {
                    let response = a[0];
                    let opts = default_object(a[1])?;
                    let signal = opts.get(c"signal")?;
                    let timeout = with_default(opts.get(c"timeoutMs")?, num(port, 2000.)?)?;
                    if !response.get(c"body")?.truthy()? {
                        return fields(port, &[("message", status_text(response)?)]);
                    }
                    let bytes = port.call_plain(&[
                        response.get(c"body")?,
                        signal,
                        timeout,
                        num(port, MAX_ERROR_BYTES as f64)?,
                    ])?;
                    then(bytes, response, |response, a| {
                        extract(if a[0].truthy()? {
                            a[0]
                        } else {
                            status_text(response)?
                        })
                    })
                })
            }),
            ("sanitizeUpstreamText", 1, 3, |p, a| {
                sanitize(
                    a[0],
                    with_default(a[1], array(p)?)?,
                    with_default(a[2], num(p, 2048.)?)?,
                )
            }),
        ],
    )?
    .raw())
}
