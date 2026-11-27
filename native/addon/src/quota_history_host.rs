//! A failed trend sample is independent of the committed provider limit.
use crate::quota_host::*;
use napi_derive::napi;
fn warn<'a>(p: L<'a>, prefix: &str, err: L<'a>) -> Result<()> {
    if !p.get(c"warned")?.truthy()? {
        p.set(c"warned", flag(p, true)?)?;
        let logger = p.get(c"logger")?;
        if callable(logger.optional(c"warn")?)? {
            call(
                logger,
                c"warn",
                &[text(
                    p,
                    &format!(
                        "[multicc/quota-history] {prefix}：{}",
                        fold_string(err.optional(c"message")?)?
                    ),
                )?],
            )?;
        }
    }
    Ok(())
}
fn ensure(p: L<'_>) -> Result<L<'_>> {
    let handle = p.get(c"handle")?;
    if handle.truthy()? || p.get(c"unavailable")?.truthy()? {
        return Ok(handle);
    }
    let file = p.get(c"file")?;
    let open = || {
        p.get(c"native")?
            .get(c"RustQuotaHistory")?
            .construct(&[file, num(p, p.get(c"retentionMs")?.number()?.trunc())?])
    };
    match open() {
        Ok(handle) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(
                    fold_string(file)?,
                    std::fs::Permissions::from_mode(0o600),
                );
            }
            p.set(c"handle", handle)?;
            Ok(handle)
        }
        Err(error) => {
            let reason = p
                .exception_value()?
                .unwrap_or(error_value(p, &error.reason)?);
            p.set(c"unavailable", flag(p, true)?)?;
            warn(p, "历史库不可用，趋势图将不显示", reason)?;
            null(p)
        }
    }
}
#[napi]
pub fn quota_history_host(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let file = p.get(c"file")?;
    if file.kind()? != sys::ValueType::napi_string || !file.truthy()? {
        return Err(
            p.type_error("[provider-quota-history] createProviderQuotaHistory requires { file }")
        );
    }
    Ok(methods(
        p,
        &[
            ("recordEntry", 1, |p, a| {
                let row = a[0];
                let app = row.optional(c"appType")?;
                if !app.truthy()? {
                    return resolved(null(p)?);
                }
                let id = row.get(c"providerId")?;
                if !id.truthy()? {
                    return resolved(null(p)?);
                }
                let summary = row.get(c"summary")?;
                if !summary.truthy()? || summary.get(c"kind")?.is_string("availability")? {
                    return resolved(null(p)?);
                }
                let at = row.get(c"updatedAt")?;
                let data = fields(
                    p,
                    &[
                        ("appType", app),
                        ("providerId", id),
                        ("sampledAt", if at.truthy()? { at } else { now(p)? }),
                        ("summary", summary),
                    ],
                )?;
                let handle = ensure(p)?;
                if !handle.truthy()? {
                    return resolved(null(p)?);
                }
                let result = async_result(p, || call(p, c"submit", &[handle, data]))?;
                let result = then(result, p, |p, a| {
                    json_call(p, c"parse", a[0].get(c"result")?)
                })?;
                recover(result, p, |p, a| {
                    warn(p, "record 失败，趋势图将暂时缺失", a[0])?;
                    null(p)
                })
            }),
            ("close", 0, |p, _| {
                p.set(c"handle", null(p)?)?;
                undef(p)
            }),
        ],
    )?
    .freeze()?
    .raw())
}
