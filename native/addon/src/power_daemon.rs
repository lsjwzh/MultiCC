//! Filesystem calls use the injected host, including the caller's error object.
use crate::{host_methods::function, route_response::*};
use napi_derive::napi;

fn installed(p: L<'_>) -> Result<bool> {
    Ok(p.get(c"platform")?.is_string("darwin")?
        && p.catch(|| call(p, c"checkAccess", &[]))?.is_some())
}
fn intent(p: L<'_>) -> Result<L<'_>> {
    if let Some(word) = p.catch(|| call(p, c"readWord", &[]))? {
        if word.is_string("on")? || word.is_string("off")? {
            return Ok(word);
        }
    }
    text(p, "none")
}
fn status_file(p: L<'_>) -> Result<L<'_>> {
    Ok(p.catch(|| call(p, c"readJson", &[]))?.unwrap_or(null(p)?))
}
#[napi]
pub fn power_daemon(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    Ok(fields(
        p,
        &[
            (
                "installed",
                function(p, "installed", 0, 0, |p, _| flag(p, installed(p)?))?,
            ),
            (
                "setIntent",
                function(p, "setIntent", 1, 1, |p, a| {
                    if !installed(p)? {
                        return flag(p, false);
                    }
                    call(
                        p,
                        c"write",
                        &[text(p, if a[0].truthy()? { "on\n" } else { "off\n" })?],
                    )?;
                    flag(p, true)
                })?,
            ),
            (
                "status",
                function(p, "status", 0, 0, |p, _| {
                    fields(
                        p,
                        &[
                            (
                                "applicable",
                                flag(p, p.get(c"platform")?.is_string("darwin")?)?,
                            ),
                            ("installed", flag(p, installed(p)?)?),
                            ("intent", intent(p)?),
                            ("daemon", status_file(p)?),
                        ],
                    )
                })?,
            ),
            (
                "readIntent",
                function(p, "readIntent", 0, 0, |p, _| intent(p))?,
            ),
            (
                "readStatus",
                function(p, "readStatus", 0, 0, |p, _| status_file(p))?,
            ),
            ("intentPath", p.get(c"intentPath")?),
            ("statusPath", p.get(c"statusPath")?),
        ],
    )?
    .raw())
}
