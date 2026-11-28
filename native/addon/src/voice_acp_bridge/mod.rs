//! Rust owns the voice bridge, including its private session table and Promise
//! continuations. Node supplies SDK/stream, fetch, ws, timer and UUID ports only.
//! Those ports can move once Rust ACP interoperability is independently verified.
use crate::host_api::*;
use crate::host_methods::{arg, env};
use multicc_core::{js::JsString, voice_acp as kernel};
use napi_derive::napi;
mod session;
mod transport;

fn clean(v: L<'_>) -> Result<JsString> {
    Ok(v.string()?.unwrap_or_default().trim())
}
fn js<'a>(p: L<'a>, v: JsString) -> Result<L<'a>> {
    p.from_value(&V::String(v))
}
fn clean_value(v: L<'_>) -> Result<L<'_>> {
    js(v, clean(v)?)
}
fn or<'a>(v: L<'a>, fallback: L<'a>) -> Result<L<'a>> {
    Ok(if v.truthy()? { v } else { fallback })
}
fn str_or_empty(v: L<'_>) -> Result<L<'_>> {
    string(or(v, text(v, "")?)?)
}
fn error<'a>(p: L<'a>, code: &str, message: &str) -> Result<L<'a>> {
    let e = error_value(p, message)?;
    e.set(c"code", text(p, code)?)?;
    Ok(e)
}
fn fail<'a>(p: L<'a>, code: &str, message: &str) -> Result<L<'a>> {
    Err(error(p, code, message)?.throw_error())
}
fn public_error<'a>(body: L<'a>, status: L<'a>) -> Result<L<'a>> {
    let value = or(body.optional(c"error")?, body.optional(c"code")?)?;
    let mut code = clean(value)?;
    if code.is_empty() {
        code = JsString::from(format!("http_{}", fold_string(status)?).as_str());
    }
    let e = error_value(body, &code.to_string_lossy())?;
    e.set(c"code", js(body, code)?)?;
    e.set(c"status", status)?;
    Ok(e)
}
fn http_error<'a>(p: L<'a>, code: &str, status: f64) -> Result<L<'a>> {
    public_error(fields(p, &[("error", text(p, code)?)])?, num(p, status)?)
}
fn freeze(v: L<'_>) -> Result<L<'_>> {
    call(v.global()?.get(c"Object")?, c"freeze", &[v])
}
fn noop<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    undef(p)
}
fn finish_with<'a>(promise: L<'a>, p: L<'a>, f: Action) -> Result<L<'a>> {
    call(
        resolved(promise)?,
        c"finally",
        &[function(p, "cleanup", 0, 0, f)?],
    )
}
fn unref(v: L<'_>) -> Result<()> {
    if !v.nullish()? {
        let f = v.get(c"unref")?;
        if !f.nullish()? {
            f.call(v, &[])?;
        }
    }
    Ok(())
}
fn default<'a>(o: L<'a>, k: &std::ffi::CStr, v: L<'a>) -> Result<L<'a>> {
    with_default(o.get(k)?, v)
}
fn bounded<'a>(value: L<'a>, fallback: L<'a>, min: f64, max: f64) -> Result<L<'a>> {
    Ok(match value.number_value()? {
        Some(n) if n.is_finite() && n > 0. => num(value, n.floor().clamp(min, max))?,
        _ => fallback,
    })
}
fn normalize<'a>(p: L<'a>, value: L<'a>, token: Option<L<'a>>) -> Result<L<'a>> {
    // Keep WHATWG normalization in the host URL intrinsic; policy stays here.
    let input = clean(value)?;
    let url = p.global()?.get(c"URL")?.construct(&[if input.is_empty() {
        text(p, "http://127.0.0.1:3000")?
    } else {
        js(p, input)?
    }])?;
    let protocol = url.get(c"protocol")?;
    if !protocol.is_string("http:")? && !protocol.is_string("https:")? {
        return Err(p.type_error("MultiCC base URL must use http or https"));
    }
    if url.get(c"username")?.truthy()? || url.get(c"password")?.truthy()? {
        return Err(p.type_error("MultiCC base URL must not contain credentials"));
    }
    if !url.get(c"pathname")?.is_string("/")?
        || url.get(c"search")?.truthy()?
        || url.get(c"hash")?.truthy()?
    {
        return Err(p.type_error("MultiCC base URL must not contain a path, query, or fragment"));
    }
    let host = fold_string(url.get(c"hostname")?)?;
    let parts: Vec<_> = host.split('.').collect();
    let loopback = matches!(host.as_str(), "localhost" | "::1" | "[::1]")
        || (parts.len() == 4
            && parts[0] == "127"
            && parts[1..]
                .iter()
                .all(|v| !v.is_empty() && v.len() <= 3 && v.bytes().all(|c| c.is_ascii_digit())));
    if let Some(token) = token {
        if !loopback && !token.truthy()? {
            return Err(
                error_value(p, "remote MultiCC ACP bridge requires MULTICC_ACCESS_TOKEN")?
                    .throw_error(),
            );
        }
        if !loopback && !protocol.is_string("https:")? {
            return Err(error_value(p, "remote MultiCC ACP bridge requires HTTPS")?.throw_error());
        }
    }
    fields(p, &[("url", url), ("loopback", flag(p, loopback)?)])
}
fn sanitize<'a>(raw: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let e = env(raw);
    Ok(L::from_raw(
        raw.env(),
        crate::voice_speech::voice_speech_value(e, arg(raw)?, arg(options)?, true)?,
    ))
}
fn speech<'a>(outcome: L<'a>, admission: L<'a>, buffer: L<'a>, private: L<'a>) -> Result<L<'a>> {
    let options = fields(buffer, &[("privateValues", private)])?;
    let hosted = sanitize(admission.optional(c"speechText")?, options)?;
    let spoken = or(hosted, sanitize(buffer, options)?)?;
    if outcome.is_string("unknown")? {
        return text(buffer, kernel::UNCERTAIN);
    }
    if outcome.is_string("rejected")? || outcome.is_string("failed")? {
        return or(
            sanitize(
                admission.optional(c"error")?.optional(c"publicMessage")?,
                options,
            )?,
            text(buffer, "这条语音任务没有提交成功。")?,
        );
    }
    if outcome.is_string("admitted")? {
        return or(
            hosted,
            text(buffer, "任务已提交到 MultiCC；后续状态以任务板为准。")?,
        );
    }
    or(spoken, text(buffer, kernel::HANDLED)?)
}
fn delta<'a>(p: L<'a>, prior: L<'a>, next: L<'a>, snapshot: L<'a>) -> Result<L<'a>> {
    let (d, s) = kernel::assistant_delta(
        &str_or_empty(prior)?.coerce_string()?,
        &str_or_empty(next)?.coerce_string()?,
        snapshot.truthy()?,
    );
    fields(p, &[("text", js(p, d)?), ("snapshot", js(p, s)?)])
}
fn prompt_parts(blocks: L<'_>) -> Result<L<'_>> {
    let mut values = Vec::new();
    if blocks.is_array()? {
        blocks.for_each(|block| {
            let kind = block.optional(c"type")?;
            if kind.is_string("text")? {
                values.push(str_or_empty(block.get(c"text")?)?.coerce_string()?);
            } else if kind.is_string("resource_link")? {
                let uri = str_or_empty(block.get(c"uri")?)?.coerce_string()?;
                let name = string(or(
                    block.get(c"name")?,
                    if uri.is_empty() {
                        text(block, "resource")?
                    } else {
                        js(block, uri.clone())?
                    },
                )?)?
                .coerce_string()?;
                if !uri.is_empty() {
                    let mut v = JsString::from("[");
                    v.push(&name);
                    v.push_str("](");
                    v.push(&uri);
                    v.push_str(")");
                    values.push(v);
                }
            }
            Ok(())
        })?;
    }
    let raw = JsString::join(&values, &"\n".into());
    let (envelopes, legacy) = kernel::envelopes(&raw);
    let mut launch = JsString::new();
    let mut request = JsString::new();
    if envelopes.len() == 1 {
        if let Some(envelope) =
            blocks.catch(|| json_call(blocks, c"parse", js(blocks, envelopes[0].clone())?))?
        {
            launch = clean(envelope.optional(c"voice_session_id")?)?.truncate_units(200);
            let input = envelope.optional(c"input")?;
            request = kernel::request_text(
                clean(input.optional(c"final_asr")?)?,
                clean(input.optional(c"objective")?)?,
            );
        }
    }
    fields(
        blocks,
        &[
            ("launchId", js(blocks, launch)?),
            (
                "text",
                js(
                    blocks,
                    if envelopes.is_empty() {
                        legacy
                    } else {
                        request
                    },
                )?,
            ),
        ],
    )
}
fn create<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let o = default_object(a[0])?;
    let fetch = default(o, c"fetchImpl", o.global()?.get(c"fetch")?)?;
    if !callable(fetch)? {
        return Err(o.type_error("MultiCC ACP bridge requires fetch"));
    }
    let token = default(o, c"accessToken", text(o, "")?)?;
    let security = normalize(o, o.get(c"baseUrl")?, Some(token))?;
    let root = call(security.get(c"url")?, c"toString", &[])?.coerce_string()?;
    let directory = clean_value(o.get(c"directoryId")?)?;
    let max = o.get(c"maxSessions")?.number_value()?;
    let limit = match max {
        Some(n) if n.is_finite() && n > 0. && n.fract() == 0. => n.min(256.),
        _ => 32.,
    };
    let timers = default(o, c"admissionTimers", ports)?;
    let p = fields(
        o,
        &[
            ("ports", ports),
            ("directory", directory),
            ("launchMode", flag(o, !directory.truthy()?)?),
            (
                "root",
                js(
                    o,
                    if root.code_unit_at(root.len().saturating_sub(1)) == Some(47) {
                        root.slice_units(0, root.len() - 1)
                    } else {
                        root
                    },
                )?,
            ),
            ("token", token),
            ("fetch", fetch),
            (
                "WebSocket",
                default(o, c"WebSocketImpl", ports.get(c"WebSocket")?)?,
            ),
            (
                "randomUUID",
                default(o, c"randomUUID", ports.get(c"randomUUID")?)?,
            ),
            ("timers", timers),
            ("log", default(o, c"log", function(o, "log", 0, 0, noop)?)?),
            ("sessions", o.global()?.get(c"Map")?.construct(&[])?),
            ("sessionLimit", num(o, limit)?),
            (
                "httpTimeout",
                bounded(o.get(c"requestTimeoutMs")?, num(o, 10_000.)?, 10., 120_000.)?,
            ),
            (
                "socketTimeout",
                bounded(o.get(c"connectTimeoutMs")?, num(o, 10_000.)?, 10., 120_000.)?,
            ),
            (
                "admissionTimeout",
                bounded(
                    o.get(c"admissionTimeoutMs")?,
                    num(o, kernel::ADMISSION_DEFAULT)?,
                    kernel::ADMISSION_MIN,
                    kernel::ADMISSION_MAX,
                )?,
            ),
        ],
    )?;
    freeze(defaulted_methods(
        p,
        &[
            ("createSession", 0, 1, session::create),
            ("resumeSession", 0, 1, session::resume),
            ("prompt", 0, 3, session::prompt),
            ("cancel", 0, 1, session::cancel),
            ("closeSession", 0, 1, session::close),
            ("stop", 0, 0, session::stop),
            ("gateway", 0, 0, transport::gateway_method),
            ("sessionCount", 0, 0, |p, _| {
                p.get(c"sessions")?.get(c"size")
            }),
        ],
    )?)
}
#[napi]
pub fn voice_acp_bridge_api(e: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&e, ports);
    let out = defaulted_methods(
        p,
        &[
            ("createVoiceAcpBridge", 0, 1, create),
            ("normalizeBaseUrl", 1, 1, |p, a| normalize(p, a[0], None)),
            ("validateTransportSecurity", 2, 2, |p, a| {
                normalize(p, a[0], Some(a[1]))
            }),
            ("boundedTimeout", 2, 2, |_, a| {
                bounded(a[0], a[1], 10., 120_000.)
            }),
            ("boundedAdmissionTimeout", 1, 1, |p, a| {
                bounded(
                    a[0],
                    num(p, kernel::ADMISSION_DEFAULT)?,
                    kernel::ADMISSION_MIN,
                    kernel::ADMISSION_MAX,
                )
            }),
            ("textFromPrompt", 1, 1, |_, a| {
                prompt_parts(a[0])?.get(c"text")
            }),
            ("stableQueueEntryId", 2, 2, |p, a| {
                text(
                    p,
                    &kernel::queue_entry(&a[0].coerce_string()?, &a[1].coerce_string()?),
                )
            }),
            ("assistantDelta", 3, 3, |p, a| delta(p, a[0], a[1], a[2])),
            ("speakableFromBuffer", 1, 1, |p, a| {
                sanitize(a[0], undef(p)?)
            }),
            ("admissionSpeech", 3, 4, |p, a| {
                speech(a[0], a[1], a[2], with_default(a[3], array(p)?)?)
            }),
        ],
    )?;
    out.set(c"ADMISSION_TIMEOUT_MIN_MS", num(p, kernel::ADMISSION_MIN)?)?;
    out.set(c"ADMISSION_TIMEOUT_MAX_MS", num(p, kernel::ADMISSION_MAX)?)?;
    out.set(
        c"QWEN_INSTRUCTION_BLOCK",
        p.global()?
            .get(c"RegExp")?
            .construct(&[text(p, kernel::INSTRUCTIONS_PATTERN)?, text(p, "gi")?])?,
    )?;
    Ok(out.raw())
}
