//! Gateway identities, live Commander binding, and public projections.
use super::*;

pub(super) fn gateway_id(id: L<'_>) -> Result<L<'_>> {
    let v = clean(id)?;
    if !v.truthy()? {
        return Err(id.type_error("voice gateway requires directoryId"));
    }
    text(
        id,
        &multicc_core::voice_gateway_routes::directory_gateway_id(&fold_string(v)?),
    )
}
pub(super) fn global(r: L<'_>) -> Result<bool> {
    Ok(r.truthy()?
        && r.get(c"id")?.is_string(GLOBAL)?
        && r.get(c"type")?.is_string("gateway")?
        && r.get(c"gatewayKind")?.is_string("qwen-audio")?)
}
pub(super) fn fleet<'a>(r: L<'a>, dir: L<'a>) -> Result<bool> {
    if !r.truthy()?
        || !r.get(c"type")?.is_string("gateway")?
        || !r.get(c"gatewayKind")?.is_string("qwen-audio")?
        || global(r)?
    {
        return Ok(false);
    }
    let dir = clean(dir)?;
    Ok(!dir.truthy()? || r.get(c"dirId")?.equals(dir)?)
}
/// Preserve the deployed JS locale's ordering for operator-chosen names.
pub(super) fn sorted<'a>(records: L<'a>, dir: Option<L<'a>>) -> Result<L<'a>> {
    let out = array(records)?;
    let filter = match dir {
        Some(id) => {
            let id = clean(id)?;
            if !id.truthy()? {
                return Ok(out);
            }
            id
        }
        None => undef(records)?,
    };
    if records.truthy()? {
        call(records, c"values", &[])?.for_each(|r| {
            if fleet(r, filter)? {
                call(out, c"push", &[r])?;
            }
            Ok(())
        })?;
    }
    let key = text(records, if dir.is_some() { "id" } else { "dirId" })?;
    let cmp = function(key, "", 2, 2, |k, a| {
        let l = string(a[0].get_key(k)?)?;
        call(l, c"localeCompare", &[string(a[1].get_key(k)?)?])
    })?;
    call(out, c"sort", &[cmp])
}
pub(super) fn ambiguous(matches: L<'_>) -> Result<L<'_>> {
    let ids = array(matches)?;
    matches.for_each(|r| {
        call(ids, c"push", &[r.get(c"id")?])?;
        Ok(())
    })?;
    let err = failure(matches, "voice_gateway_ambiguous")?;
    err.set(c"gatewayIds", ids)?;
    Ok(err)
}
pub(super) fn resolve<'a>(records: L<'a>, dir: L<'a>) -> Result<L<'a>> {
    let id = clean(dir)?;
    if !id.truthy()? {
        return failure(records, "directory_required");
    }
    let matches = sorted(records, Some(id))?;
    match matches.get(c"length")?.number()? as usize {
        0 => failure(records, "voice_gateway_not_found"),
        1 => fields(
            records,
            &[
                ("ok", flag(records, true)?),
                ("record", matches.element(0)?),
            ],
        ),
        _ => ambiguous(matches),
    }
}
fn binding<'a>(p: L<'a>, records: L<'a>, r: L<'a>) -> Result<L<'a>> {
    let state = |ready: bool, code: L<'a>, cmd: L<'a>| {
        fields(
            p,
            &[
                ("ready", flag(p, ready)?),
                ("code", code),
                ("commanderSessionId", cmd),
            ],
        )
    };
    let none = null(p)?;
    if !fleet(r, none)? {
        return state(false, text(p, "voice_gateway_not_found")?, none);
    }
    let unique = resolve(records, r.get(c"dirId")?)?;
    if !ok(unique)? {
        return state(false, unique.get(c"code")?, none);
    }
    let cmd = p
        .get(c"resolveDirectoryCommander")?
        .call_plain(&[records, r.get(c"dirId")?])?;
    if !ok(cmd)? {
        return state(false, cmd.get(c"code")?, none);
    }
    let id = cmd.get(c"sessionId")?;
    if !r.get(c"commanderSessionId")?.equals(id)? {
        return state(false, text(p, "commander_binding_stale")?, id);
    }
    if !r.get(c"enabled")?.is_true()? {
        return state(false, text(p, "voice_gateway_disabled")?, id);
    }
    state(true, none, id)
}
pub(super) fn dto<'a>(p: L<'a>, records: L<'a>, r: L<'a>) -> Result<L<'a>> {
    let b = binding(p, records, r)?;
    let id = b.get(c"commanderSessionId")?;
    let commander = if id.truthy()? {
        map_get(records, id)?
    } else {
        null(p)?
    };
    fields(
        p,
        &[
            ("id", r.get(c"id")?),
            ("directoryId", r.get(c"dirId")?),
            ("type", text(p, "voice_gateway")?),
            ("provider", text(p, PROVIDER)?),
            ("enabled", flag(p, r.get(c"enabled")?.is_true()?)?),
            (
                "commanderSessionId",
                or(r.get(c"commanderSessionId")?, null(p)?)?,
            ),
            (
                "commanderLabel",
                or(commander.optional(c"label")?, null(p)?)?,
            ),
            (
                "binding",
                fields(
                    p,
                    &[
                        ("ready", b.get(c"ready")?),
                        ("code", b.get(c"code")?),
                        ("canonicalCommanderSessionId", id),
                    ],
                )?,
            ),
            ("createdAt", stamp(p, Some(r.get(c"createdAt")?))?),
            ("updatedAt", stamp(p, Some(r.get(c"updatedAt")?))?),
        ],
    )
}
pub(super) fn global_dto(r: L<'_>) -> Result<L<'_>> {
    let configured = r.truthy()?;
    let (enabled, created, updated) = if configured {
        (
            r.get(c"enabled")?.is_true()?,
            stamp(r, Some(r.get(c"createdAt")?))?,
            stamp(r, Some(r.get(c"updatedAt")?))?,
        )
    } else {
        (false, null(r)?, null(r)?)
    };
    fields(
        r,
        &[
            ("id", text(r, GLOBAL)?),
            ("scope", text(r, "global")?),
            ("type", text(r, "voice_gateway")?),
            ("provider", text(r, PROVIDER)?),
            ("configured", flag(r, configured)?),
            ("enabled", flag(r, enabled)?),
            ("createdAt", created),
            ("updatedAt", updated),
        ],
    )
}
pub(super) fn legacy(records: L<'_>) -> Result<L<'_>> {
    let out = array(records)?;
    sorted(records, None)?.for_each(|r| {
        let row = fields(
            r,
            &[
                ("id", r.get(c"id")?),
                ("directoryId", r.get(c"dirId")?),
                ("enabled", flag(r, r.get(c"enabled")?.is_true()?)?),
                ("legacy", flag(r, true)?),
                ("active", flag(r, false)?),
                ("supersededBy", text(r, GLOBAL)?),
            ],
        )?;
        call(out, c"push", &[row])?;
        Ok(())
    })?;
    Ok(out)
}
pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    let out = methods(
        p,
        &[
            ("bindingState", 2, |p, a| binding(p, a[0], a[1])),
            ("gatewayDto", 2, |p, a| dto(p, a[0], a[1])),
            ("globalGatewayDto", 1, |_, a| global_dto(a[0])),
            ("isGlobalVoiceGatewayRecord", 1, |p, a| {
                flag(p, global(a[0])?)
            }),
            ("legacyGatewayProjection", 1, |_, a| legacy(a[0])),
            ("recordsForDirectory", 2, |_, a| sorted(a[0], Some(a[1]))),
            ("resolveVoiceGateway", 2, |_, a| resolve(a[0], a[1])),
            ("voiceGatewayId", 1, |_, a| gateway_id(a[0])),
        ],
    )?;
    default_method(out, p, "createVoiceGatewayService", 0, |p, a| {
        service::create(p, a[0])
    })?;
    default_method(out, p, "isVoiceGatewayRecord", 1, |p, a| {
        flag(p, fleet(a[0], a[1])?)
    })?;
    for (k, v) in [
        (c"GATEWAY_KIND", "qwen-audio"),
        (c"GATEWAY_PROVIDER", PROVIDER),
        (c"GATEWAY_RECORD_TYPE", "gateway"),
        (c"GATEWAY_SCOPE_GLOBAL", "global"),
        (c"GLOBAL_VOICE_GATEWAY_ID", GLOBAL),
    ] {
        out.set(k, text(p, v)?)?;
    }
    Ok(out)
}
