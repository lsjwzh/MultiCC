//! All validation and writes remain in one synchronous store mutation.
use super::domain::*;
use super::*;
fn dir<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let id = clean(id)?;
    if !id.truthy()? {
        return failure(p, "directory_required");
    }
    if !call(p.get(c"directories")?, c"has", &[id])?.truthy()? {
        return failure(p, "directory_not_found");
    }
    fields(p, &[("ok", flag(p, true)?), ("dirId", id)])
}
fn inspect<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let d = dir(p, a[0])?;
    if !ok(d)? {
        return Ok(d);
    }
    let records = p.get(c"records")?;
    let result = resolve(records, d.get(c"dirId")?)?;
    if ok(result)? {
        result.set(c"gateway", dto(p, records, result.get(c"record")?)?)?;
    }
    Ok(result)
}
fn list<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let out = array(p)?;
    let records = p.get(c"records")?;
    sorted(records, None)?.for_each(|r| {
        call(out, c"push", &[dto(p, records, r)?])?;
        Ok(())
    })?;
    Ok(out)
}
fn collision(p: L<'_>) -> Result<napi::Error> {
    let e = error_value(p, "voice gateway id collision")?;
    e.set(c"code", text(p, "voice_gateway_id_conflict")?)?;
    Ok(e.throw_error())
}
fn now_stamp(p: L<'_>) -> Result<L<'_>> {
    let f = p.get(c"now")?;
    if f.undefined()? {
        stamp(p, None)
    } else {
        f.call_plain(&[])
    }
}
fn validate(o: L<'_>) -> Result<Option<&'static str>> {
    if !o.get(c"commanderSessionId")?.undefined()? {
        return Ok(Some("commander_binding_is_host_owned"));
    }
    let provider = o.get(c"provider")?;
    if !provider.undefined()? && !provider.is_string(PROVIDER)? {
        return Ok(Some("voice_gateway_provider_invalid"));
    }
    let enabled = o.get(c"enabled")?;
    if !enabled.undefined()? && enabled.kind()? != sys::ValueType::napi_boolean {
        return Ok(Some("voice_gateway_enabled_invalid"));
    }
    Ok(None)
}
fn transaction<'a>(p: L<'a>, source: &str, ctx: L<'a>, f: Action) -> Result<()> {
    let op = function(ctx, "", 1, 1, f)?;
    p.get(c"mutate")?.call_plain(&[text(p, source)?, op])?;
    Ok(())
}
fn put_fleet<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let draft = a[0];
    let r = s.get(c"existing")?;
    let enabled = s.get(c"options")?.get(c"enabled")?;
    let cmd = s.get(c"commander")?.get(c"sessionId")?;
    let stamp = s.get(c"stamp")?;
    if !r.truthy()? {
        let dir = s.get(c"dirId")?;
        let id = gateway_id(dir)?;
        let other = map_get(draft, id)?;
        if other.truthy()? && !fleet(other, dir)? {
            return Err(collision(s)?);
        }
        let new = fields(
            s,
            &[
                ("id", id),
                ("dirId", dir),
                ("type", text(s, "gateway")?),
                ("kind", text(s, "voice")?),
                ("gatewayKind", text(s, "qwen-audio")?),
                ("label", text(s, "Qwen Audio Voice Gateway")?),
                ("enabled", flag(s, !enabled.is_false()?)?),
                ("commanderSessionId", cmd),
                ("createdAt", stamp),
                ("updatedAt", stamp),
            ],
        )?;
        call(draft, c"set", &[id, new])?;
        s.set(c"created", flag(s, true)?)?;
        s.set(c"record", new)?;
    } else {
        r.assign(c"commanderSessionId", cmd)?;
        r.assign(c"kind", text(s, "voice")?)?;
        r.assign(
            c"enabled",
            if enabled.undefined()? {
                flag(s, r.get(c"enabled")?.is_true()?)?
            } else {
                enabled
            },
        )?;
        r.assign(c"updatedAt", stamp)?;
        s.set(c"record", r)?;
    }
    undef(s)
}
fn ensure<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let o = default_object(a[1])?;
    let d = dir(p, a[0])?;
    if !ok(d)? {
        return Ok(d);
    }
    let records = p.get(c"records")?;
    let id = d.get(c"dirId")?;
    let matches = sorted(records, Some(id))?;
    if matches.get(c"length")?.number()? > 1.0 {
        return ambiguous(matches);
    }
    let cmd = p
        .get(c"resolveDirectoryCommander")?
        .call_plain(&[records, id])?;
    if !ok(cmd)? {
        return Ok(cmd);
    }
    if let Some(code) = validate(o)? {
        return failure(p, code);
    }
    let s = fields(
        p,
        &[
            ("options", o),
            ("existing", matches.element(0)?),
            ("commander", cmd),
            ("dirId", id),
            ("created", flag(p, false)?),
            ("stamp", now_stamp(p)?),
        ],
    )?;
    transaction(p, "http.voice-gateway-put", s, put_fleet)?;
    let record = s.get(c"record")?;
    fields(
        p,
        &[
            ("ok", flag(p, true)?),
            ("created", s.get(c"created")?),
            ("record", record),
            ("gateway", dto(p, records, record)?),
        ],
    )
}
fn remove_id<'a>(p: L<'a>, source: &str, id: L<'a>) -> Result<()> {
    transaction(p, source, id, |id, a| call(a[0], c"delete", &[id]))
}
fn remove<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let d = dir(p, a[0])?;
    if !ok(d)? {
        return Ok(d);
    }
    let dir = d.get(c"dirId")?;
    let g = resolve(p.get(c"records")?, dir)?;
    if !ok(g)? {
        return Ok(g);
    }
    let id = g.get(c"record")?.get(c"id")?;
    remove_id(p, "http.voice-gateway-delete", id)?;
    fields(
        p,
        &[("ok", flag(p, true)?), ("id", id), ("directoryId", dir)],
    )
}
fn global_record(p: L<'_>) -> Result<L<'_>> {
    let r = map_get(p.get(c"records")?, text(p, GLOBAL)?)?;
    if global(r)? {
        Ok(r)
    } else {
        null(p)
    }
}
fn inspect_global<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    fields(
        p,
        &[
            ("ok", flag(p, true)?),
            ("record", global_record(p)?),
            ("gateway", global_dto(global_record(p)?)?),
            ("legacy", legacy(p.get(c"records")?)?),
        ],
    )
}
fn put_global<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let draft = a[0];
    let id = text(s, GLOBAL)?;
    let r = map_get(draft, id)?;
    if r.truthy()? && !global(r)? {
        return Err(collision(s)?);
    }
    let enabled = s.get(c"options")?.get(c"enabled")?;
    let stamp = s.get(c"stamp")?;
    if !r.truthy()? {
        let legacy = legacy(s.get(c"records")?)?;
        let mut inherited = false;
        legacy.for_each_while(|row| {
            inherited = row.get(c"enabled")?.truthy()?;
            Ok(!inherited)
        })?;
        let record = fields(
            s,
            &[
                ("id", id),
                ("dirId", null(s)?),
                ("type", text(s, "gateway")?),
                ("kind", text(s, "voice")?),
                ("gatewayKind", text(s, "qwen-audio")?),
                ("scope", text(s, "global")?),
                ("label", text(s, "Qwen Realtime Voice Gateway")?),
                ("enabled", with_default(enabled, flag(s, inherited)?)?),
                ("createdAt", stamp),
                ("updatedAt", stamp),
            ],
        )?;
        call(draft, c"set", &[id, record])?;
        s.set(c"created", flag(s, true)?)?;
        s.set(c"record", record)?;
    } else {
        r.assign(c"scope", text(s, "global")?)?;
        r.assign(c"kind", text(s, "voice")?)?;
        r.assign(c"dirId", null(s)?)?;
        if !enabled.undefined()? {
            r.assign(c"enabled", enabled)?;
        }
        r.assign(c"updatedAt", stamp)?;
        s.set(c"record", r)?;
    }
    undef(s)
}
fn ensure_global<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(a[0])?;
    if let Some(code) = validate(opts)? {
        return failure(p, code);
    }
    let s = fields(
        p,
        &[
            ("records", p.get(c"records")?),
            ("options", opts),
            ("created", flag(p, false)?),
            ("record", null(p)?),
            ("stamp", now_stamp(p)?),
        ],
    )?;
    transaction(p, "http.voice-gateway-global-put", s, put_global)?;
    let r = s.get(c"record")?;
    fields(
        p,
        &[
            ("ok", flag(p, true)?),
            ("created", s.get(c"created")?),
            ("record", r),
            ("gateway", global_dto(r)?),
        ],
    )
}
fn remove_global<'a>(p: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    if !global_record(p)?.truthy()? {
        return failure(p, "voice_gateway_not_found");
    }
    let id = text(p, GLOBAL)?;
    remove_id(p, "http.voice-gateway-global-delete", id)?;
    fields(p, &[("ok", flag(p, true)?), ("id", id)])
}
pub(super) fn create<'a>(ports: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let s = pick(
        default_object(opts)?,
        &[c"records", c"directories", c"mutate", c"now"],
    )?;
    check_map(s.get(c"records")?, "voice gateway records Map is required")?;
    check_map(
        s.get(c"directories")?,
        "voice gateway directories Map is required",
    )?;
    if !callable(s.get(c"mutate")?)? {
        return Err(s.type_error("voice gateway mutate port is required"));
    }
    s.set(
        c"resolveDirectoryCommander",
        ports.get(c"resolveDirectoryCommander")?,
    )?;
    let out = methods(
        s,
        &[
            ("inspect", 1, inspect),
            ("inspectGlobal", 0, inspect_global),
            ("list", 0, list),
            ("remove", 1, remove),
            ("removeGlobal", 0, remove_global),
        ],
    )?;
    default_method(out, s, "ensure", 1, ensure)?;
    default_method(out, s, "ensureGlobal", 0, ensure_global)?;
    out.freeze()
}
