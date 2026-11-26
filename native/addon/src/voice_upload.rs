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
