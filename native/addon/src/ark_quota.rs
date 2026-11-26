use crate::route_response::*;
use multicc_core::{ark_quota as core, js::JsString};
use napi_derive::napi;

fn parse(p: L<'_>) -> Result<L<'_>> {
    let s = p.coerce_string()?;
    if let Some(range) = core::object_range(s.as_units()) {
        let data = p.from_value(&V::String(s.slice_units(range.start, range.end)))?;
        if let Some(parsed) = p.catch(|| call(p.global()?.get(c"JSON")?, c"parse", &[data]))? {
            return Ok(parsed);
        }
    }
    null(p)
}
#[napi]
pub fn arkcli_json(env: Env, source: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(parse(L::new(&env, source))?.raw())
}
fn finite(p: L<'_>, n: f64) -> Result<L<'_>> {
    if n.is_finite() {
        num(p, n)
    } else {
        null(p)
    }
}
fn period(p: L<'_>) -> Result<L<'_>> {
    let reset = p.get(c"reset_at")?;
    let n = if reset.kind()? == sys::ValueType::napi_string {
        call(p.global()?.get(c"Date")?, c"parse", &[reset])?.number()?
    } else {
        reset.explicit_number()?
    };
    fields(
        p,
        &[
            ("label", string(fallback(p.get(c"label")?, "".into())?)?),
            ("used", finite(p, p.get(c"used")?.explicit_number()?)?),
            ("total", finite(p, p.get(c"total")?.explicit_number()?)?),
            ("percent", finite(p, p.get(c"percent")?.explicit_number()?)?),
            ("resetAt", finite(p, n)?),
        ],
    )
}
fn map_objects<'a>(p: L<'a>, f: fn(L<'a>) -> Result<L<'a>>) -> Result<L<'a>> {
    let out = p.from_value(&V::Array(vec![]))?;
    if p.is_array()? {
        p.for_each(|v| {
            if v.kind()? == sys::ValueType::napi_object {
                call(out, c"push", &[f(v)?])?;
            }
            Ok(())
        })?;
    }
    Ok(out)
}
fn item(p: L<'_>) -> Result<L<'_>> {
    let optional = |k| {
        let v = p.get(k)?;
        if v.truthy()? {
            string(v)
        } else {
            null(p)
        }
    };
    fields(
        p,
        &[
            ("product", string(fallback(p.get(c"product")?, "".into())?)?),
            ("edition", string(fallback(p.get(c"edition")?, "".into())?)?),
            ("tier", optional(c"tier")?),
            ("seatId", optional(c"seat_id")?),
            ("subscribed", flag(p, p.get(c"subscribed")?.is_true()?)?),
            ("error", optional(c"error")?),
            ("periods", map_objects(p.get(c"periods")?, period)?),
        ],
    )
}
fn failure<'a>(p: L<'a>, status: &str, message: L<'a>) -> Result<L<'a>> {
    fields(p, &[("status", text(p, status)?), ("error", message)])
}
#[napi]
pub fn ark_quota_result(env: Env, rs: Unknown<'_>, at: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, rs);
    let err = p.get(c"err")?;
    let stderr = p.get(c"stderr")?;
    let mut parsed = parse(p.get(c"stdout")?)?;
    if parsed.nullish()? {
        parsed = parse(stderr)?;
    }
    let result = if parsed.nullish()? {
        if err.optional(c"code")?.is_string("ENOENT")? {
            failure(p, "needs_install", text(p, "arkcli not found on PATH")?)?
        } else {
            let msg = if stderr.truthy()? {
                stderr
            } else {
                fallback(err.optional(c"message")?, "no output".into())?
            };
            failure(
                p,
                "unavailable",
                call(msg, c"slice", &[num(p, 0.)?, num(p, 300.)?])?,
            )?
        }
    } else if parsed.get(c"ok")?.is_false()? {
        let msg = fallback(
            parsed.get(c"error")?.optional(c"message")?,
            "unknown error".into(),
        )?;
        let s = msg.coerce_string()?;
        if core::needs_auth(&s.as_str_lossy())
            || core::needs_auth(&stderr.coerce_string()?.as_str_lossy())
        {
            let msg = JsString::concat(&[
                &JsString::from("需要先运行 arkcli auth login 登录火山账号后再查询（"),
                &s,
                &JsString::from("）"),
            ]);
            failure(p, "needs_auth", p.from_value(&V::String(msg))?)?
        } else {
            failure(p, "unavailable", msg)?
        }
    } else if !parsed.get(c"items")?.is_array()? {
        failure(p, "unavailable", text(p, "items missing")?)?
    } else {
        let viewer = parsed.get(c"viewer")?;
        fields(
            p,
            &[
                ("status", text(p, "ok")?),
                ("fetchedAt", L::new(&env, at)),
                (
                    "viewer",
                    if viewer.kind()? == sys::ValueType::napi_object {
                        viewer
                    } else {
                        null(p)?
                    },
                ),
                ("items", map_objects(parsed.get(c"items")?, item)?),
            ],
        )?
    };
    Ok(result.raw())
}
