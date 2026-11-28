use super::*;
use crate::host_methods::{arg, env};

fn issue_fields<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let cause = a[0];
    let out = array(s)?;
    out.set_element(0, string(fallback(cause.get(c"code")?, "".into())?)?)?;
    let msg = string(fallback(cause.get(c"message")?, "".into())?)?;
    out.set_element(1, call(msg, c"slice", &[num(s, 0.)?, num(s, 1024.)?])?)?;
    Ok(out)
}
pub(super) fn describe<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if let Some(v) = p.catch(|| {
        let addon = p.get(c"getAddon")?.call_plain(&[])?;
        let f = addon.get(c"airDescribeIssue")?;
        let read = function(p, "issueFields", 1, 1, issue_fields)?;
        if f.equals(p.get(c"describe")?)? {
            let r = crate::air_storage_notice::air_describe_issue(env(p), arg(a[0])?, arg(read)?)?;
            return fields(
                p,
                &[
                    ("code", text(p, &r.code)?),
                    ("message", text(p, &r.message)?),
                ],
            );
        }
        f.call(addon, &[a[0], read])
    })? {
        return Ok(v);
    }
    fields(
        p,
        &[
            ("code", text(p, "rust_backend_unavailable")?),
            (
                "message",
                text(
                    p,
                    "无法加载当前版本的 Rust 诊断接口，请检查模块版本并重启 MultiCC。",
                )?,
            ),
        ],
    )
}
fn record<'a>(s: L<'a>, error: L<'a>) -> Result<L<'a>> {
    let p = s.get(c"p")?;
    let Some(addon) = p.catch(|| p.get(c"getAddon")?.call_plain(&[]))? else {
        return flag(s, false);
    };
    let method = addon.get(c"airRecordStorageNotice")?;
    if !method.truthy()? {
        return flag(s, false);
    }
    let read = function(s, "issueFields", 1, 1, issue_fields)?;
    let remember = function(s, "remember", 2, 2, |s, a| {
        s.set(c"recent", a[0])?;
        s.set(c"lifetime", a[1])?;
        undef(s)
    })?;
    let publish = s.get(c"publish")?;
    if method.equals(p.get(c"record")?)? {
        return flag(
            s,
            crate::air_storage_notice::air_record_storage_notice(
                env(s),
                arg(error)?,
                arg(read)?,
                arg(remember)?,
                arg(publish)?,
            )?,
        );
    }
    method.call(addon, &[error, read, remember, publish])
}
fn current<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let r = s.get(c"recent")?;
    if r.truthy()? {
        let now = call(s.global()?.get(c"Date")?, c"now", &[])?.explicit_number()?;
        if now - r.get(c"at")?.explicit_number()? < s.get(c"lifetime")?.explicit_number()? {
            return Ok(r);
        }
    }
    null(s)
}
pub(super) fn standalone(p: L<'_>) -> Result<L<'_>> {
    let s = fields(p, &[("p", p), ("recent", null(p)?)])?;
    methods(
        s,
        &[
            ("record", 1, |s, a| record(s, a[0])),
            ("current", 0, current),
        ],
    )
}
pub(super) fn shared(p: L<'_>) -> Result<L<'_>> {
    let s = fields(p, &[("p", p), ("recent", null(p)?)])?;
    let notify = function(s, "publish", 0, 0, |s, _| {
        let f = s.get(c"publisher")?;
        if f.nullish()? {
            undef(s)
        } else {
            f.call_plain(&[])
        }
    })?;
    s.set(c"publish", notify)?;
    methods(
        s,
        &[
            ("report", 1, |s, a| {
                record(s, a[0])?;
                undef(s)
            }),
            ("storageNotice", 0, current),
            ("bindPublisher", 1, |s, a| {
                s.set(c"publisher", a[0])?;
                undef(s)
            }),
            ("installStateStoreReporter", 2, |s, a| {
                let f = pick(a[1], &[c"metrics", c"logger"])?;
                f.set(c"s", s)?;
                let reporter = function(f, "", 2, 2, |f, a| {
                    record(f.get(c"s")?, a[0])?;
                    call(
                        f.get(c"metrics")?,
                        c"inc",
                        &[text(f, "multicc_persistence_failures_total")?],
                    )?;
                    let data = spread(a[1])?;
                    let error = if a[0].truthy()? {
                        a[0].get(c"message")?
                    } else {
                        a[0]
                    };
                    data.set(c"error", error)?;
                    call(
                        f.get(c"logger")?,
                        c"error",
                        &[text(f, "persistence_failure")?, data],
                    )?;
                    undef(f)
                })?;
                call(a[0], c"setFailureReporter", &[reporter])?;
                undef(s)
            }),
            ("sessionPersistenceOnFailure", 1, |s, a| {
                let f = pick(a[0], &[c"metrics", c"logger"])?;
                f.set(c"s", s)?;
                function(f, "", 1, 1, |f, a| {
                    let error = a[0].get(c"error")?;
                    let data = pick(a[0], &[c"mode", c"source", c"attempt", c"dirty"])?;
                    record(f.get(c"s")?, error)?;
                    call(
                        f.get(c"metrics")?,
                        c"inc",
                        &[text(f, "multicc_session_persistence_failures_total")?],
                    )?;
                    data.set(
                        c"error",
                        if error.truthy()? {
                            error.get(c"message")?
                        } else {
                            error
                        },
                    )?;
                    call(
                        f.get(c"logger")?,
                        c"error",
                        &[text(f, "session_persistence_failure")?, data],
                    )?;
                    undef(f)
                })
            }),
        ],
    )
}
