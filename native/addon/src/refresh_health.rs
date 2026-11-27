//! One read-through cache per official-accounts root. The hot value is
//! updated before persistence so a failed disk write never un-parks a login.
use crate::{
    host_methods::{default_object, function},
    route_response::*,
    runtime_security::{atomic, private_dir},
};
use napi_derive::napi;
use std::{fs, io::ErrorKind, path::PathBuf};

fn file(p: L<'_>, key: L<'_>) -> Result<Option<PathBuf>> {
    let key = string(fallback(key, "".into())?)?
        .coerce_string()?
        .to_string_lossy();
    if key.is_empty()
        || key.len() > 64
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return Ok(None);
    }
    Ok(Some(
        PathBuf::from(p.get(c"dir")?.coerce_string()?.to_string_lossy())
            .join(format!("{key}.json")),
    ))
}
fn read<'a>(p: L<'a>, key: L<'a>) -> Result<L<'a>> {
    let Some(file) = file(p, key)? else {
        return null(p);
    };
    let cache = p.get(c"cache")?;
    if call(cache, c"has", &[key])?.truthy()? {
        return call(cache, c"get", &[key]);
    }
    let mut value = null(p)?;
    if let Ok(bytes) = fs::read(file) {
        if let Some(parsed) = p.catch(|| {
            call(
                p.global()?.get(c"JSON")?,
                c"parse",
                &[text(p, &String::from_utf8_lossy(&bytes))?],
            )
        })? {
            if parsed.kind()? == sys::ValueType::napi_object && !parsed.is_array()? {
                value = parsed;
            }
        }
    }
    call(cache, c"set", &[key, value])?;
    Ok(value)
}
fn write<'a>(p: L<'a>, key: L<'a>, value: L<'a>) -> Result<L<'a>> {
    let Some(file) = file(p, key)? else {
        return flag(p, false);
    };
    if value.kind()? != sys::ValueType::napi_object {
        return flag(p, false);
    }
    let now = p.global()?.get(c"Date")?.construct(&[])?;
    let record = fields(
        p,
        &[
            ("version", num(p, 1.)?),
            ("updatedAt", call(now, c"toISOString", &[])?),
        ],
    )?;
    record.spread_from(value)?;
    call(p.get(c"cache")?, c"set", &[key, record])?;
    let persist = (|| {
        private_dir(p, file.parent().expect("health file has a parent"))?;
        let json = call(
            p.global()?.get(c"JSON")?,
            c"stringify",
            &[record, null(p)?, num(p, 2.)?],
        )?;
        atomic(
            p,
            text(p, &file.to_string_lossy())?,
            &json.coerce_string()?.to_string_lossy(),
            0o600,
            0o700,
            p.get(c"reportFailure")?,
        )
    })();
    if let Err(error) = persist {
        let thrown = p.exception_value()?;
        let logger = p.get(c"logger")?;
        if logger.optional(c"warn")?.kind()? == sys::ValueType::napi_function {
            let msg = match thrown {
                Some(e) => e.get(c"message")?,
                None => text(p, &error.reason)?,
            };
            call(
                logger,
                c"warn",
                &[
                    text(p, "claude_refresh_health_write_failed")?,
                    fields(p, &[("key", key), ("error", msg)])?,
                ],
            )?;
        }
        return flag(p, false);
    }
    flag(p, true)
}
#[napi]
pub fn refresh_health_store(
    env: Env,
    options: Unknown<'_>,
    ports: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let options = default_object(L::new(&env, options))?;
    let root = options.get(c"root")?;
    if !root.truthy()? {
        return Err(p.type_error("[claude-refresh-health] root is required"));
    }
    let dir = call(
        p.get(c"path")?,
        c"join",
        &[root, text(p, "refresh-health")?],
    )?;
    let state = fields(
        p,
        &[
            ("dir", dir),
            ("logger", options.get(c"logger")?),
            ("reportFailure", p.get(c"reportFailure")?),
            ("cache", p.global()?.get(c"Map")?.construct(&[])?),
        ],
    )?;
    Ok(fields(
        p,
        &[
            ("dir", dir),
            ("read", function(state, "read", 1, 1, |p, a| read(p, a[0]))?),
            (
                "write",
                function(state, "write", 2, 2, |p, a| write(p, a[0], a[1]))?,
            ),
            (
                "clear",
                function(state, "clear", 1, 1, |p, a| {
                    let Some(file) = file(p, a[0])? else {
                        return flag(p, false);
                    };
                    call(p.get(c"cache")?, c"delete", &[a[0]])?;
                    flag(
                        p,
                        fs::remove_file(file)
                            .map_or_else(|e| e.kind() == ErrorKind::NotFound, |_| true),
                    )
                })?,
            ),
        ],
    )?
    .freeze()?
    .raw())
}
