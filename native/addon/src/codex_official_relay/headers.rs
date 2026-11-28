//! This relay changes HTTP credentials and body representation. End-to-end
//! fields may cross the boundary, hop and credential fields never do.
use super::*;
use std::collections::HashSet;
const DENIED: &[&str] = &[
    "authorization",
    "chatgpt-account-id",
    "cookie",
    "cookie2",
    "set-cookie",
    "api-key",
    "x-api-key",
    "x-access-token",
    "x-auth-token",
    "openai-organization",
    "openai-project",
    "proxy-authenticate",
    "proxy-authorization",
    "host",
    "content-length",
    "content-type",
    "content-encoding",
    "content-md5",
    "content-digest",
    "repr-digest",
    "digest",
    "connection",
    "keep-alive",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "expect",
    "http2-settings",
    "forwarded",
    "via",
    "x-real-ip",
    "true-client-ip",
];
fn token(s: &str) -> bool {
    !s.is_empty()
        && s.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || b"!#$%&'*+.^_`|~-".contains(&b)
        })
}
fn safe(v: L<'_>, max: usize) -> Result<Option<L<'_>>> {
    let mut v = v;
    if v.is_array()? {
        let len = v.get(c"length")?.number()? as u32;
        if len == 0 {
            return Ok(None);
        }
        for i in 0..len {
            if v.element(i)?.kind()? != sys::ValueType::napi_string {
                return Ok(None);
            }
        }
        v = call(v, c"join", &[text(v, ", ")?])?;
    }
    let Some(s) = v.string()? else {
        return Ok(None);
    };
    Ok((!s.is_empty()
        && s.as_units().iter().all(|u| *u != 10 && *u != 13)
        && s.utf8_lossy_bytes().len() <= max)
        .then_some(v))
}
pub(super) fn request(s: L<'_>) -> Result<L<'_>> {
    let source = s.get(c"req")?.get(c"headers")?;
    let incoming = if source.kind()? == sys::ValueType::napi_object {
        source
    } else {
        fields(s, &[])?
    };
    let connection = match safe(incoming.get(c"connection")?, 16384)? {
        Some(v) => word(v)?,
        None => String::new(),
    };
    let named: HashSet<String> = connection
        .split(',')
        .map(|n| n.trim().to_ascii_lowercase())
        .filter(|n| token(n))
        .collect();
    let out = fields(s, &[])?;
    let pairs = call(s.global()?.get(c"Object")?, c"entries", &[incoming])?;
    pairs.for_each(|pair| {
        let key = word(pair.element(0)?)?.to_ascii_lowercase();
        if !token(&key)
            || key == "__proto__"
            || DENIED.contains(&key.as_str())
            || named.contains(&key)
            || key.starts_with("x-forwarded-")
            || key.starts_with("x-multicc-")
        {
            return Ok(());
        }
        let cap = match key.as_str() {
            "originator" => 256,
            "user-agent" => 1024,
            _ => 16384,
        };
        if let Some(value) = safe(pair.element(1)?, cap)? {
            out.define_key(text(s, &key)?, value)?;
        }
        Ok(())
    })?;
    let accept = fallback(out.get(c"accept")?, "text/event-stream".into())?;
    let origin = fallback(out.get(c"originator")?, "codex_cli_rs".into())?;
    let agent = fallback(out.get(c"user-agent")?, "codex_cli_rs/multicc-relay".into())?;
    for k in [c"accept", c"originator", c"user-agent"] {
        out.delete(k)?;
    }
    let cred = s.get(c"credential")?;
    out.set(
        c"Authorization",
        call(text(s, "Bearer ")?, c"concat", &[cred.get(c"accessToken")?])?,
    )?;
    out.set(c"ChatGPT-Account-Id", cred.get(c"accountId")?)?;
    out.set(c"Content-Type", text(s, "application/json")?)?;
    out.set(c"Accept", accept)?;
    out.set(c"originator", origin)?;
    out.set(c"User-Agent", agent)?;
    Ok(out)
}
pub(super) fn value<'a>(up: L<'a>, name: &str) -> Result<L<'a>> {
    let h = up.get(c"headers")?;
    if h.truthy()? && func(h.get(c"get")?)? {
        call(h, c"get", &[text(up, name)?])
    } else {
        text(up, "")
    }
}
pub(super) fn response(s: L<'_>) -> Result<()> {
    let res = s.get(c"res")?;
    let up = s.get(c"upstream")?;
    let status = up.get(c"status")?;
    if func(res.get(c"status")?)? {
        call(res, c"status", &[status])?;
    } else {
        res.assign(c"statusCode", status)?;
    }
    let streaming = s.get(c"streaming")?.truthy()?;
    let content = fallback(
        value(up, "content-type")?,
        if streaming {
            "text/event-stream".into()
        } else {
            "application/json".into()
        },
    )?;
    call(res, c"setHeader", &[text(s, "Content-Type")?, content])?;
    if streaming {
        for (k, v) in [
            ("Cache-Control", "no-cache"),
            ("Connection", "keep-alive"),
            ("X-Accel-Buffering", "no"),
        ] {
            call(res, c"setHeader", &[text(s, k)?, text(s, v)?])?;
        }
    }
    let id = value(up, "x-request-id")?;
    if id.truthy()? {
        call(res, c"setHeader", &[text(s, "X-Request-Id")?, id])?;
    }
    if func(res.get(c"flushHeaders")?)? {
        call(res, c"flushHeaders", &[])?;
    }
    Ok(())
}
