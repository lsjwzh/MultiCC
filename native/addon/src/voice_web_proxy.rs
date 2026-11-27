use crate::{js_live::spread, route_response::*};
use multicc_core::js::JsString as S;
use napi_derive::napi;
#[napi]
pub fn voice_proxy_target(env: Env, runtime: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, runtime);
    let status = call(p, c"statusGlobal", &[])?;
    let raw = if status.truthy()? {
        status.get(c"url")?
    } else {
        status
    };
    if !raw.truthy()? {
        return Ok(null(p)?.raw());
    }
    let result = p.catch(|| {
        let url = p.global()?.get(c"URL")?.construct(&[raw])?;
        if !url.get(c"protocol")?.is_string("http:")? {
            return null(p);
        }
        fields(
            p,
            &[
                ("hostname", url.get(c"hostname")?),
                ("port", num(p, url.get(c"port")?.explicit_number()?)?),
            ],
        )
    })?;
    Ok(result.unwrap_or(null(p)?).raw())
}
#[napi]
pub fn voice_proxy_path(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, value);
    let s = string(fallback(p, "".into())?)?.coerce_string()?;
    let path = s.slice_units("/voice-gateway/web".len().min(s.len()), s.len());
    let path = if path.code_unit_at(0) == Some(47) {
        path
    } else {
        S::concat(&[&"/".into(), &path])
    };
    Ok(p.from_value(&V::String(path))?.raw())
}
#[napi]
pub fn voice_proxy_headers(
    env: Env,
    req: Unknown<'_>,
    target: Unknown<'_>,
) -> Result<sys::napi_value> {
    let r = L::new(&env, req);
    let t = L::new(&env, target);
    let h = spread(r.get(c"headers")?)?;
    h.delete(c"origin")?;
    h.delete(c"referer")?;
    let host = S::concat(&[
        &t.get(c"hostname")?.coerce_string()?,
        &":".into(),
        &t.get(c"port")?.coerce_string()?,
    ]);
    h.assign(c"host", h.from_value(&V::String(host))?)?;
    Ok(h.raw())
}
#[napi]
pub fn voice_upgrade_head(
    env: Env,
    response: Unknown<'_>,
    refused: bool,
) -> Result<sys::napi_value> {
    let r = L::new(&env, response);
    let mut head = S::concat(&[
        &"HTTP/1.1 ".into(),
        &r.get(c"statusCode")?.coerce_string()?,
        &" ".into(),
        &r.get(c"statusMessage")?.coerce_string()?,
        &"\r\n".into(),
    ]);
    call(
        r.global()?.get(c"Object")?,
        c"entries",
        &[r.get(c"headers")?],
    )?
    .for_each(|pair| {
        let (k, v) = pair.iterator_pair()?;
        let name = k.coerce_string()?;
        if refused && name.to_lowercase() == "transfer-encoding" {
            return Ok(());
        }
        let mut line = |v: L<'_>| {
            head.push(&name);
            head.push_str(": ");
            head.push(&v.coerce_string()?);
            head.push_str("\r\n");
            Ok(())
        };
        if v.is_array()? {
            v.for_each(line)
        } else {
            line(v)
        }
    })?;
    head.push_str(if refused {
        "connection: close\r\n\r\n"
    } else {
        "\r\n"
    });
    Ok(r.from_value(&V::String(head))?.raw())
}
