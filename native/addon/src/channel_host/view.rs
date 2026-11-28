use super::*;

fn describe(rec: L<'_>) -> Result<L<'_>> {
    let spec = rec.get(c"spec")?;
    let id = rec.get(c"id")?;
    let ui = spec.get(c"ui")?;
    let ui = if ui.truthy()? {
        let encoded = rec
            .global()?
            .get(c"encodeURIComponent")?
            .call_plain(&[id])?;
        let prefix = rec
            .global()?
            .get(c"RegExp")?
            .construct(&[text(rec, "^/+")?])?;
        let page = call(string(ui)?, c"replace", &[prefix, text(rec, "")?])?;
        call(
            text(rec, "/plugins/")?,
            c"concat",
            &[encoded, text(rec, "/")?, page],
        )?
    } else {
        null(rec)?
    };
    let child = rec.get(c"child")?;
    let ready = rec.get(c"ready")?;
    fields(
        rec,
        &[
            ("id", id),
            ("name", value_or(spec.get(c"name")?, id)?),
            ("nameEn", fallback(spec.get(c"nameEn")?, V::Null)?),
            (
                "version",
                value_or(
                    rec.get(c"reportedVersion")?,
                    fallback(spec.get(c"version")?, V::Null)?,
                )?,
            ),
            ("channel", fallback(spec.get(c"channel")?, V::Null)?),
            ("ui", ui),
            ("running", flag(rec, child.truthy()?)?),
            ("ready", ready),
            (
                "pid",
                if child.truthy()? {
                    child.get(c"pid")?
                } else {
                    null(rec)?
                },
            ),
            ("startedAt", rec.get(c"startedAt")?),
            (
                "readyAt",
                if ready.truthy()? {
                    rec.get(c"readyAt")?
                } else {
                    null(rec)?
                },
            ),
            ("restarts", rec.get(c"failures")?),
            ("lastExit", rec.get(c"lastExit")?),
            (
                "alerts",
                to_array(call(rec.get(c"alerts")?, c"values", &[])?)?,
            ),
        ],
    )
}
pub(super) fn status(s: L<'_>) -> Result<L<'_>> {
    let out = array(s)?;
    call(s.get(c"records")?, c"values", &[])?.for_each(|r| {
        call(out, c"push", &[describe(r)?])?;
        Ok(())
    })?;
    s.get(c"skipped")?.for_each(|pair| {
        let id = pair.element(0)?;
        let v = pair.element(1)?;
        let spec = v.get(c"spec")?;
        let row = fields(
            s,
            &[
                ("id", id),
                ("name", value_or(spec.get(c"name")?, id)?),
                ("nameEn", fallback(spec.get(c"nameEn")?, V::Null)?),
                ("version", fallback(spec.get(c"version")?, V::Null)?),
                ("channel", fallback(spec.get(c"channel")?, V::Null)?),
                ("ui", null(s)?),
                ("running", flag(s, false)?),
                ("ready", flag(s, false)?),
                ("unsupported", v.get(c"reason")?),
                ("alerts", array(s)?),
            ],
        )?;
        call(out, c"push", &[row])?;
        Ok(())
    })?;
    let cmp = function(s, "", 2, 2, |_, a| {
        call(a[0].get(c"id")?, c"localeCompare", &[a[1].get(c"id")?])
    })?;
    call(out, c"sort", &[cmp])
}
fn brief(list: L<'_>) -> Result<L<'_>> {
    let out = array(list)?;
    if list.is_array()? {
        list.for_each(|v| {
            if !v.truthy()? {
                return Ok(());
            }
            let id = v.get(c"id")?;
            if id.string()?.is_none() {
                return Ok(());
            }
            let item = fields(
                v,
                &[
                    ("id", cap(id, 64.)?),
                    ("name", value_or(cap(v.get(c"name")?, 80.)?, id)?),
                    ("status", fallback(cap(v.get(c"status")?, 32.)?, V::Null)?),
                ],
            )?;
            call(out, c"push", &[item])?;
            Ok(())
        })?;
    }
    Ok(out)
}
pub(super) fn refresh(rec: L<'_>) -> Result<L<'_>> {
    async_result(rec, || {
        let read = protocol::request(rec, "targets", fields(rec, &[])?, num(rec, 3000.)?)?;
        then(read, rec, |rec, a| {
            let reply = a[0];
            if reply.get(c"ok")?.truthy()? {
                rec.set(
                    c"knownTargets",
                    brief(reply.get(c"data")?.optional(c"targets")?)?,
                )?;
            }
            Ok(reply)
        })
    })
}
pub(super) fn check_target<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let rec = get(s.get(c"records")?, a[0])?;
    if !rec.truthy()? {
        let skip = get(s.get(c"skipped")?, a[0])?;
        if skip.truthy()? && skip.get(c"spec")?.get(c"channel")?.truthy()? {
            return text(s, "channel plugin not running");
        }
        return text(s, "unknown channel plugin");
    }
    if !rec.get(c"spec")?.get(c"channel")?.truthy()? {
        return text(s, "unknown channel plugin");
    }
    let targets = rec.get(c"knownTargets")?;
    if !rec.get(c"ready")?.truthy()? || !targets.truthy()? {
        return text(s, "channel plugin not running");
    }
    let mut found = false;
    targets.for_each_while(|v| {
        found = v.get(c"id")?.equals(a[1])?;
        Ok(!found)
    })?;
    if found {
        null(s)
    } else {
        text(s, "unknown channel target")
    }
}
pub(super) fn targets<'a>(s: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(s, || {
        let promises = array(s)?;
        status(s)?.for_each(|v| {
            let channel = v.get(c"channel")?;
            if !channel.truthy()? {
                return Ok(());
            }
            let result = async_result(s, || {
                let id = v.get(c"id")?;
                let ready = v.get(c"ready")?;
                let base = fields(
                    s,
                    &[
                        ("plugin", id),
                        ("name", v.get(c"name")?),
                        ("label", channel.get(c"label")?),
                        ("labelEn", channel.get(c"labelEn")?),
                        ("ready", ready),
                    ],
                )?;
                if !ready.truthy()? {
                    let unsupported = v.get(c"unsupported")?;
                    let msg = if unsupported.truthy()? {
                        format!("本机不支持（{}）", fold_string(unsupported)?)
                    } else {
                        "插件没有运行".into()
                    };
                    base.set(c"targets", array(s)?)?;
                    base.set(c"error", text(s, &msg)?)?;
                    return Ok(base);
                }
                let rec = get(s.get(c"records")?, id)?;
                let ctx = fields(s, &[("rec", rec), ("base", base)])?;
                then(refresh(rec)?, ctx, |c, a| {
                    let base = c.get(c"base")?;
                    let reply = a[0];
                    if reply.get(c"ok")?.truthy()? {
                        base.set(
                            c"targets",
                            value_or(c.get(c"rec")?.get(c"knownTargets")?, array(c)?)?,
                        )?;
                    } else {
                        base.set(c"targets", array(c)?)?;
                        base.set(c"error", reply.get(c"error")?)?;
                    }
                    Ok(base)
                })
            })?;
            call(promises, c"push", &[result])?;
            Ok(())
        })?;
        call(s.global()?.get(c"Promise")?, c"all", &[promises])
    })
}
