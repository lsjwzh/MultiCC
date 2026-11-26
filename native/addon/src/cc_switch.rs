//! CC-Switch compatibility probes also accept host-supplied database constructors.
use crate::{host_methods::method, route_response::*};
use multicc_core::cc_switch;
use napi_derive::napi;
use std::path::Path;

const UNAVAILABLE: &str = "SQLite 不可用，需要与当前平台和架构匹配的 Rust SQLite 模块；请安装完整 MultiCC 包，源码运行先执行 npm run build:rust 并配置 MULTICC_RUST_PREBUILT_DIR。";
const OPEN_FAILED: &str =
    "Could not open the CC-Switch database. Check that the file is readable, then retry.";

fn error<'a>(
    p: L<'a>,
    message: L<'a>,
    code: &str,
    reason: &str,
    cause: Option<L<'a>>,
) -> Result<L<'a>> {
    let e = p.global()?.get(c"Error")?.construct(&[message])?;
    e.assign(c"code", text(p, code)?)?;
    e.assign(c"reason", text(p, reason)?)?;
    if let Some(cause) = cause {
        if cause.truthy()? {
            e.assign(c"cause", cause)?;
        }
    }
    Ok(e)
}
fn probe(p: L<'_>) -> Result<L<'_>> {
    let mut db = None;
    let result = (|| {
        let ctor = p.get(c"loadDatabase")?.call_plain(&[])?;
        let open = ctor.construct(&[text(p, ":memory:")?])?;
        db = Some(open);
        call(open, c"close", &[])?;
        fields(
            p,
            &[
                ("available", flag(p, true)?),
                ("reason", null(p)?),
                ("Database", ctor),
            ],
        )
    })();
    match result {
        Ok(status) => Ok(status),
        Err(e) => {
            let cause = p.exception_value()?.unwrap_or(text(p, &e.reason)?);
            if let Some(open) = db {
                p.catch(|| call(open, c"close", &[]))?;
            }
            fields(
                p,
                &[
                    ("available", flag(p, false)?),
                    ("reason", text(p, "native-runtime-unavailable")?),
                    ("cause", cause),
                ],
            )
        }
    }
}
fn status<'a>(p: L<'a>, path: L<'a>) -> Result<L<'a>> {
    let path = string(fallback(path, "".into())?)?;
    let found = path.truthy()? && p.get(c"existsSync")?.call_plain(&[path])?.truthy()?;
    let available = if !found {
        false
    } else if p.get(c"loadDatabase")?.undefined()? {
        cc_switch::available()
    } else {
        probe(p)?.get(c"available")?.truthy()?
    };
    let (reason, message) = if !found {
        (
            text(p, "database-not-found")?,
            text(
                p,
                &format!(
                    "CC-Switch database was not found at {}.",
                    path.coerce_string()?.to_string_lossy()
                ),
            )?,
        )
    } else if !available {
        (
            text(p, "native-runtime-unavailable")?,
            text(p, UNAVAILABLE)?,
        )
    } else {
        (null(p)?, text(p, "")?)
    };
    fields(
        p,
        &[
            ("available", flag(p, available)?),
            ("dbFound", flag(p, found)?),
            ("dbPath", path),
            ("reason", reason),
            ("message", message),
        ],
    )
}
fn open<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let s = status(p, a[0])?;
    if !s.get(c"available")?.truthy()? {
        let missing = !s.get(c"dbFound")?.truthy()?;
        return Err(error(
            p,
            s.get(c"message")?,
            if missing {
                "CC_SWITCH_DB_NOT_FOUND"
            } else {
                "SQLITE_NATIVE_RUNTIME_UNAVAILABLE"
            },
            if missing {
                "database-not-found"
            } else {
                "native-runtime-unavailable"
            },
            None,
        )?
        .throw_error());
    }
    let health = probe(p)?;
    if !health.get(c"available")?.truthy()? {
        return Err(error(
            p,
            text(p, UNAVAILABLE)?,
            "SQLITE_NATIVE_RUNTIME_UNAVAILABLE",
            "native-runtime-unavailable",
            Some(health.get(c"cause")?),
        )?
        .throw_error());
    }
    let opts = fields(
        p,
        &[
            ("readonly", flag(p, true)?),
            ("fileMustExist", flag(p, true)?),
            ("timeout", num(p, 4000.)?),
        ],
    )?;
    opts.spread_from(a[1])?;
    health
        .get(c"Database")?
        .construct(&[a[0], opts])
        .or_else(|failure| {
            let cause = p.exception_value()?.unwrap_or(text(p, &failure.reason)?);
            Err(error(
                p,
                text(p, OPEN_FAILED)?,
                "CC_SWITCH_DB_OPEN_FAILED",
                "database-open-failed",
                Some(cause),
            )?
            .throw_error())
        })
}
#[napi]
pub fn cc_switch_database_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    Ok(fields(
        p,
        &[
            ("probe", method(&env, p, "probe", 0, 0, |p, _| probe(p))?),
            (
                "getStatus",
                method(&env, p, "getStatus", 1, 1, |p, a| status(p, a[0]))?,
            ),
            ("openReadonly", method(&env, p, "openReadonly", 1, 2, open)?),
        ],
    )?
    .raw())
}
pub(crate) fn read_rows(p: L<'_>, path: &str) -> Result<Vec<serde_json::Value>> {
    let file = Path::new(path);
    match cc_switch::read(file) {
        Ok(rows) => Ok(rows),
        Err(e) => {
            let thrown = match e {
                cc_switch::ReadError::Missing => error(
                    p,
                    text(p, &format!("CC-Switch database was not found at {path}."))?,
                    "CC_SWITCH_DB_NOT_FOUND",
                    "database-not-found",
                    None,
                )?,
                cc_switch::ReadError::Open(cause) => error(
                    p,
                    text(p, OPEN_FAILED)?,
                    "CC_SWITCH_DB_OPEN_FAILED",
                    "database-open-failed",
                    Some(
                        p.global()?
                            .get(c"Error")?
                            .construct(&[text(p, &cause.to_string())?])?,
                    ),
                )?,
                cc_switch::ReadError::Query(e) => {
                    return Err(napi::Error::from_reason(e.to_string()))
                }
            };
            Err(thrown.throw_error())
        }
    }
}
