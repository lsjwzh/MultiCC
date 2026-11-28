use super::*;
use multicc_core::js::{string::is_js_whitespace, JsString};

#[derive(Clone, Copy)]
enum Body {
    Text,
    Json,
    Trace,
}
const SERVICES: &[(&str, &str, Body)] = &[
    (
        "cloudflare",
        "https://www.cloudflare.com/cdn-cgi/trace",
        Body::Trace,
    ),
    (
        "cloudflare-1111",
        "https://1.1.1.1/cdn-cgi/trace",
        Body::Trace,
    ),
    ("aws", "https://checkip.amazonaws.com", Body::Text),
    ("ipify", "https://api.ipify.org?format=json", Body::Json),
    ("icanhazip", "https://icanhazip.com", Body::Text),
    ("ifconfig-me", "https://ifconfig.me/ip", Body::Text),
    ("ifconfig-co", "https://ifconfig.co/ip", Body::Text),
    ("ip-sb", "https://api.ip.sb/ip", Body::Text),
    ("ident-me", "https://ident.me", Body::Text),
    ("seeip", "https://api.seeip.org/jsonip", Body::Json),
    ("ipecho", "https://ipecho.net/plain", Body::Text),
    ("wtfismyip", "https://wtfismyip.com/text", Body::Text),
    ("ipwho", "https://ipwho.is/", Body::Json),
    ("ipinfo", "https://ipinfo.io/json", Body::Json),
    ("ipapi", "https://ipapi.co/ip/", Body::Text),
];
fn parse_text(value: L<'_>) -> Result<L<'_>> {
    let raw = string(value)?.coerce_string()?.trim();
    let word = raw
        .as_units()
        .split(|u| is_js_whitespace(*u))
        .next()
        .unwrap_or_default();
    if word.is_empty() {
        null(value)
    } else {
        value.from_value(&V::String(JsString::from_units(word.into())))
    }
}
fn parse_json(value: L<'_>) -> Result<L<'_>> {
    let parsed = json_call(value, c"parse", value)?;
    if read(parsed, c"ip")?.kind()? == sys::ValueType::napi_string {
        call(read(parsed, c"ip")?, c"trim", &[])
    } else {
        null(value)
    }
}
fn parse_trace(value: L<'_>) -> Result<L<'_>> {
    let raw = string(value)?.coerce_string()?;
    for line in raw
        .as_units()
        .split(|u| matches!(*u, 10 | 13 | 0x2028 | 0x2029))
    {
        if let Some(ip) = line.strip_prefix(&[105, 112, 61]) {
            if !ip.is_empty() {
                return value.from_value(&V::String(JsString::from_units(ip.into()).trim()));
            }
        }
    }
    null(value)
}
pub(super) fn candidates(p: L<'_>) -> Result<L<'_>> {
    let parsers = [
        function(p, "asText", 1, 1, |_, a| parse_text(a[0]))?,
        function(p, "asJson", 1, 1, |_, a| parse_json(a[0]))?,
        function(p, "asTrace", 1, 1, |_, a| parse_trace(a[0]))?,
    ];
    let out = array(p)?;
    for (i, &(id, url, kind)) in SERVICES.iter().enumerate() {
        let parser = parsers[match kind {
            Body::Text => 0,
            Body::Json => 1,
            Body::Trace => 2,
        }];
        out.set_element(
            i as u32,
            fields(
                p,
                &[
                    ("id", text(p, id)?),
                    ("url", text(p, url)?),
                    ("parse", parser),
                ],
            )?,
        )?;
    }
    out.freeze()
}
pub(super) fn valid(value: L<'_>) -> Result<bool> {
    let Some(s) = value.string()? else {
        return Ok(false);
    };
    let s = s.trim().to_string_lossy();
    if s.contains(':') {
        return Ok(s.bytes().all(|b| b == b':' || b.is_ascii_hexdigit()));
    }
    let mut parts = s.split('.');
    for _ in 0..4 {
        let Some(part) = parts.next() else {
            return Ok(false);
        };
        if part.is_empty()
            || part.len() > 3
            || !part.bytes().all(|b| b.is_ascii_digit())
            || part.parse::<u8>().is_err()
        {
            return Ok(false);
        }
    }
    Ok(parts.next().is_none())
}
fn settle<'a>(s: L<'a>, key: &std::ffi::CStr, value: L<'a>) -> Result<L<'a>> {
    if s.get(c"settled")?.truthy()? {
        return undef(s);
    }
    s.set(c"settled", flag(s, true)?)?;
    s.get(key)?.call_plain(&[value])
}
fn reject<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    settle(s, c"reject", a[0])
}
fn chunk<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let size = s.get(c"bytes")?.number()? + read(a[0], c"length")?.number()?;
    s.set(c"bytes", num(s, size)?)?;
    if size > 8192. {
        call(s.get(c"request")?, c"destroy", &[])?;
        return settle(s, c"reject", error_value(s, "response_too_large")?);
    }
    let decoded = call(a[0], c"toString", &[text(s, "utf8")?])?;
    s.set(c"body", call(s.get(c"body")?, c"concat", &[decoded])?)?;
    undef(s)
}
fn finish<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let result = (|| {
        let ip = call(s.get(c"candidate")?, c"parse", &[s.get(c"body")?])?;
        if valid(ip)? {
            settle(s, c"resolve", ip)
        } else {
            settle(s, c"reject", error_value(s, "invalid_ip")?)
        }
    })();
    match result {
        Err(e) => {
            let reason = if let Some(thrown) = s.exception_value()? {
                thrown
            } else {
                error_value(s, &e.reason)?
            };
            settle(s, c"reject", reason)
        }
        value => value,
    }
}
fn response<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let res = a[0];
    if read(res, c"statusCode")?.number()? < 200. || read(res, c"statusCode")?.number()? >= 300. {
        call(res, c"resume", &[])?;
        let code = read(res, c"statusCode")?;
        let msg = call(text(s, "http_")?, c"concat", &[code])?;
        let err = s.global()?.get(c"Error")?.construct(&[msg])?;
        err.set(c"status", read(res, c"statusCode")?)?;
        return settle(s, c"reject", err);
    }
    for (event, arity, run) in [
        ("data", 1, chunk as Action),
        ("end", 0, finish),
        ("error", 1, reject),
    ] {
        call(
            res,
            c"on",
            &[text(s, event)?, function(s, "", arity, arity, run)?],
        )?;
    }
    undef(s)
}
pub(super) fn candidate<'a>(https: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let family = with_default(a[1], num(https, 0.)?)?;
    let s = fields(
        https,
        &[
            ("https", https),
            ("candidate", a[0]),
            ("family", family),
            ("settled", flag(https, false)?),
            ("bytes", num(https, 0.)?),
            ("body", text(https, "")?),
        ],
    )?;
    let executor = function(s, "", 2, 2, |s, a| {
        s.set(c"resolve", a[0])?;
        s.set(c"reject", a[1])?;
        let headers = fields(s, &[("User-Agent", text(s, "multicc-egress-ip-check")?)])?;
        let opts = fields(s, &[("timeout", num(s, 4000.)?), ("headers", headers)])?;
        if s.get(c"family")?.truthy()? {
            opts.set(c"family", s.get(c"family")?)?
        }
        let req = call(
            s.get(c"https")?,
            c"get",
            &[
                read(s.get(c"candidate")?, c"url")?,
                opts,
                function(s, "", 1, 1, response)?,
            ],
        )?;
        s.set(c"request", req)?;
        let timed_out = function(s, "", 0, 0, |s, _| {
            call(s.get(c"request")?, c"destroy", &[])?;
            settle(s, c"reject", error_value(s, "timeout")?)
        })?;
        call(req, c"on", &[text(s, "timeout")?, timed_out])?;
        call(
            req,
            c"on",
            &[text(s, "error")?, function(s, "", 1, 1, reject)?],
        )
    })?;
    https.global()?.get(c"Promise")?.construct(&[executor])
}
