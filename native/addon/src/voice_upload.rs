use crate::{host_methods::function, route_response::*};
use multicc_core::js::JsString;
use napi_derive::napi;

#[napi]
pub fn voice_upload_mime(input: String) -> bool {
    let mime = multicc_core::js::js_trim(input.split(';').next().unwrap_or("")).to_lowercase();
    mime.starts_with("audio/") || matches!(mime.as_str(), "application/ogg" | "video/webm")
}
#[napi]
pub fn voice_upload_name(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, input);
    let name = p.coerce_string()?;
    let base = name
        .as_units()
        .rsplit(|c| matches!(c, 47 | 92))
        .find(|s| !s.is_empty())
        .unwrap_or_default();
    let name = JsString::from_units(
        base.iter()
            .copied()
            .filter(|c| *c > 31 && *c != 127)
            .take(255)
            .collect(),
    );
    Ok(if name.is_empty() {
        text(p, "upload.bin")?
    } else {
        p.from_value(&V::String(name))?
    }
    .raw())
}
#[napi]
pub fn voice_upload_error(env: Env, code: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, code);
    let key = p.string()?.unwrap_or_default();
    let (status, code, message) = match key.as_str_lossy().as_ref() {
        "LIMIT_FILE_SIZE" => (413, "UPLOAD_FILE_TOO_LARGE", "upload exceeds 25 MiB limit"),
        "LIMIT_FILE_COUNT" | "LIMIT_PART_COUNT" | "LIMIT_FIELD_COUNT" => (
            400,
            "UPLOAD_TOO_MANY_PARTS",
            "exactly one file and no fields are allowed",
        ),
        "LIMIT_UNEXPECTED_FILE" => (
            400,
            "UPLOAD_UNEXPECTED_FIELD",
            "expected one file field named file",
        ),
        "LIMIT_FIELD_KEY" | "LIMIT_FIELD_VALUE" => (
            400,
            "UPLOAD_FIELD_INVALID",
            "multipart field exceeds limits",
        ),
        _ => (500, "UPLOAD_FAILED", "upload failed"),
    };
    Ok(fields(
        p,
        &[
            ("status", num(p, status as f64)?),
            ("code", text(p, code)?),
            ("error", text(p, message)?),
        ],
    )?
    .raw())
}
// V8 retains the gate through the release callback installed on each response.
#[napi]
pub fn voice_upload_gate(env: Env, at_limit: Unknown<'_>) -> Result<sys::napi_value> {
    let test = L::new(&env, at_limit);
    let owner = fields(test, &[("test", test), ("active", num(test, 0.)?)])?;
    Ok(function(owner, "admit", 0, 0, |owner, _| {
        let active = owner.get(c"active")?;
        if owner.get(c"test")?.call_plain(&[active])?.truthy()? {
            return null(owner);
        }
        owner.set(c"active", num(owner, owner.get(c"active")?.number()? + 1.)?)?;
        let lease = fields(
            owner,
            &[("owner", owner), ("released", flag(owner, false)?)],
        )?;
        function(lease, "release", 0, 0, |lease, _| {
            if !lease.get(c"released")?.truthy()? {
                lease.set(c"released", flag(lease, true)?)?;
                let gate = lease.get(c"owner")?;
                gate.set(c"active", num(gate, gate.get(c"active")?.number()? - 1.)?)?;
            }
            lease.from_value(&V::Undefined)
        })
    })?
    .raw())
}

use crate::host_methods::{arg, env as host_env, raw};
fn mapped<'a>(p: L<'a>, err: L<'a>) -> Result<L<'a>> {
    if err.instance_of(p.get(c"ErrorType")?)? {
        return fields(
            p,
            &[
                ("status", err.get(c"status")?),
                ("code", err.get(c"code")?),
                ("error", err.get(c"message")?),
            ],
        );
    }
    let code = if err.truthy()? {
        err.get(c"code")?
    } else {
        err
    };
    Ok(raw(p, voice_upload_error(host_env(p), arg(code)?)?))
}
fn send_mapped<'a>(r: L<'a>, mapped: L<'a>) -> Result<L<'a>> {
    let target = call(r, c"status", &[mapped.get(c"status")?])?;
    call(
        target,
        c"json",
        &[fields(
            r,
            &[
                ("error", mapped.get(c"error")?),
                ("code", mapped.get(c"code")?),
            ],
        )?],
    )?;
    r.from_value(&V::Undefined)
}
fn wrap<'a>(ports: L<'a>, admit: L<'a>, parser: L<'a>) -> Result<L<'a>> {
    let ctx = fields(
        ports,
        &[("ports", ports), ("admit", admit), ("parser", parser)],
    )?;
    function(ctx, "", 3, 3, |ctx, a| {
        let p = ctx.get(c"ports")?;
        let r = a[1];
        let release = ctx.get(c"admit")?.call_plain(&[])?;
        if !release.truthy()? {
            call(
                r,
                c"setHeader",
                &[text(p, "Connection")?, text(p, "close")?],
            )?;
            return send_mapped(
                r,
                fields(
                    p,
                    &[
                        ("status", num(p, 429.)?),
                        ("code", text(p, "UPLOAD_BUSY")?),
                        ("error", text(p, "too many concurrent uploads")?),
                    ],
                )?,
            );
        }
        for key in ["finish", "close"] {
            call(r, c"once", &[text(p, key)?, release])?;
        }
        let state = fields(
            p,
            &[("p", p), ("res", r), ("next", a[2]), ("release", release)],
        )?;
        let done = function(state, "", 1, 1, |s, a| {
            if a[0].truthy()? {
                s.get(c"release")?.call_plain(&[])?;
                return send_mapped(s.get(c"res")?, mapped(s.get(c"p")?, a[0])?);
            }
            s.get(c"next")?.call_plain(&[])?;
            s.from_value(&V::Undefined)
        })?;
        ctx.get(c"parser")?.call_plain(&[a[0], r, done])?;
        p.from_value(&V::Undefined)
    })
}
#[napi]
pub fn voice_upload_wrapper(
    env: Env,
    ports: Unknown<'_>,
    at_limit: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let admit = raw(p, voice_upload_gate(env, at_limit)?);
    let ctx = fields(p, &[("p", p), ("admit", admit)])?;
    Ok(function(ctx, "wrap", 1, 1, |s, a| {
        wrap(s.get(c"p")?, s.get(c"admit")?, a[0])
    })?
    .raw())
}
#[napi]
pub fn voice_upload_suite(
    env: Env,
    ports: Unknown<'_>,
    multer: Unknown<'_>,
    file_size: Unknown<'_>,
    at_limit: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let m = L::new(&env, multer);
    let size = L::new(&env, file_size);
    let wrapper = raw(p, voice_upload_wrapper(host_env(p), arg(p)?, at_limit)?);
    let storage = call(m, c"memoryStorage", &[])?;
    let limits = fields(
        p,
        &[
            ("fileSize", size),
            ("files", num(p, 1.)?),
            ("fields", num(p, 0.)?),
            ("parts", num(p, 2.)?),
            ("fieldNameSize", num(p, 64.)?),
            ("headerPairs", num(p, 100.)?),
        ],
    )?;
    let filter = function(p, "", 3, 3, |p, a| {
        let f = a[1];
        let cb = a[2];
        let reject = |msg: &str, code: &str, status: f64| {
            cb.call_plain(&[p.get(c"ErrorType")?.construct(&[
                text(p, msg)?,
                text(p, code)?,
                num(p, status)?,
            ])?])
        };
        if !f.get(c"fieldname")?.is_string("file")? {
            return reject("unexpected upload field", "UPLOAD_UNEXPECTED_FIELD", 400.);
        }
        let name = string(fallback(f.get(c"originalname")?, "upload.bin".into())?)?;
        let name = raw(p, voice_upload_name(host_env(p), arg(name)?)?);
        p.get(c"assign")?
            .call_plain(&[f, text(p, "originalname")?, name])?;
        let mime = string(fallback(
            f.get(c"mimetype")?,
            "application/octet-stream".into(),
        )?)?
        .coerce_string()?;
        if !voice_upload_mime(mime.to_string_lossy()) {
            return reject(
                "unsupported upload media type",
                "UPLOAD_UNSUPPORTED_MEDIA_TYPE",
                415.,
            );
        }
        cb.call_plain(&[null(p)?, flag(p, true)?])?;
        p.from_value(&V::Undefined)
    })?;
    let parser = call(
        m.call_plain(&[fields(
            p,
            &[
                ("storage", storage),
                ("limits", limits),
                ("fileFilter", filter),
            ],
        )?])?,
        c"single",
        &[text(p, "file")?],
    )?;
    Ok(fields(p, &[("voice", wrapper.call_plain(&[parser])?)])?
        .freeze()?
        .raw())
}
