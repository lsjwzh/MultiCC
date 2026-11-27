//! Tickets re-resolve the original target against live maps on every utterance.
use super::*;

pub(super) const TTL: f64 = 30.0 * 60.0 * 1000.0;
pub(super) const CAPACITY: f64 = 64.0;
fn clock(p: L<'_>) -> Result<f64> {
    let cb = p.get(c"now")?;
    if cb.undefined()? {
        call(p.global()?.get(c"Date")?, c"now", &[])?.number()
    } else {
        cb.call_plain(&[])?.number()
    }
}
fn sweep(p: L<'_>) -> Result<L<'_>> {
    let cutoff = clock(p)?;
    let tickets = p.get(c"tickets")?;
    tickets.for_each(|entry| {
        let (id, t) = entry.iterator_pair()?;
        if t.get(c"expiresAt")?.number()? <= cutoff {
            call(tickets, c"delete", &[id])?;
        }
        Ok(())
    })?;
    while tickets.get(c"size")?.number()? > p.get(c"capacity")?.number()? {
        let first = call(call(tickets, c"keys", &[])?, c"next", &[])?;
        if first.get(c"done")?.truthy()? {
            break;
        }
        call(tickets, c"delete", &[first.get(c"value")?])?;
    }
    undef(p)
}
fn first<'a>(v: L<'a>, keys: &[&CStr], default: L<'a>) -> Result<L<'a>> {
    for &k in keys {
        let x = v.get(k)?;
        if x.truthy()? {
            return Ok(x);
        }
    }
    Ok(default)
}
fn context<'a>(p: L<'a>, scope: L<'a>, source: L<'a>) -> Result<L<'a>> {
    let records = p.get(c"records")?;
    let empty = text(p, "")?;
    let none = null(p)?;
    let (source, target, dir, label, cwd, display) = if scope.is_string("chat")? {
        let id = clean(source)?;
        if !id.truthy()? {
            return failure(p, "voice_launch_source_required");
        }
        let rec = map_get(records, id)?;
        if !rec.truthy()? {
            return failure(p, "voice_launch_source_not_found");
        }
        let ty = rec.get(c"type")?;
        if ty.is_string("aux")? || ty.is_string("gateway")? {
            return failure(p, "voice_launch_source_not_addressable");
        }
        if !rec.get(c"kind")?.is_string("chat")? {
            return failure(p, "voice_launch_source_not_chat");
        }
        let dir = rec.get(c"dirId")?;
        let directory = if dir.truthy()? {
            map_get(p.get(c"directories")?, dir)?
        } else {
            none
        };
        if !directory.truthy()? {
            return failure(p, "voice_launch_directory_not_found");
        }
        (
            id,
            id,
            dir,
            first(directory, &[c"label", c"name"], empty)?,
            first(directory, &[c"path", c"cwd"], empty)?,
            or(rec.get(c"label")?, id)?,
        )
    } else {
        let id = text(p, ROUTER)?;
        let r = map_get(records, id)?;
        if !r.truthy()? {
            return failure(p, "voice_router_not_provisioned");
        }
        if !p.get(c"isVoiceRouterRecord")?.call_plain(&[r])?.truthy()? {
            return failure(p, "voice_router_id_conflict");
        }
        (
            none,
            id,
            or(r.get(c"dirId")?, none)?,
            empty,
            empty,
            text(p, "全局语音")?,
        )
    };
    let ctx = fields(
        p,
        &[
            ("scope", scope),
            ("sourceSessionId", source),
            ("targetSessionId", target),
            ("directoryId", dir),
            ("directoryLabel", label),
            ("cwd", cwd),
            ("commanderSessionId", none),
            ("display", display),
        ],
    )?;
    if dir.truthy()? {
        let cmd = p.get(c"resolveCommander")?.call_plain(&[records, dir])?;
        let valid = ok(cmd)?;
        ctx.set(
            c"commanderSessionId",
            if valid { cmd.get(c"sessionId")? } else { none },
        )?;
        ctx.set(
            c"commanderCode",
            if valid { none } else { cmd.get(c"code")? },
        )?;
    }
    fields(p, &[("ok", flag(p, true)?), ("context", ctx)])
}
fn expiry(p: L<'_>) -> Result<L<'_>> {
    num(p, clock(p)? + p.get(c"ttl")?.number()?)
}
fn iso(v: L<'_>) -> Result<L<'_>> {
    call(
        v.global()?.get(c"Date")?.construct(&[v])?,
        c"toISOString",
        &[],
    )
}
fn issue<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let o = default_object(a[0])?;
    let raw = o.get(c"scope")?;
    let source = o.get(c"sourceSessionId")?;
    sweep(p)?;
    let scope = if clean(source)?.truthy()? {
        text(p, "chat")?
    } else {
        or(clean(raw)?, text(p, "global")?)?
    };
    if !scope.is_string("global")? && !scope.is_string("chat")? {
        return failure(p, "voice_launch_scope_invalid");
    }
    let result = context(p, scope, source)?;
    if !ok(result)? {
        return Ok(result);
    }
    let ctx = result.get(c"context")?;
    let random = p.get(c"randomId")?;
    let id = if random.undefined()? {
        text(
            p,
            &multicc_core::voice_gateway_routes::launch_token()
                .map_err(|e| napi::Error::from_reason(e.to_string()))?,
        )?
    } else {
        clean(random.call_plain(&[])?)?
    };
    if !id.truthy()? {
        return failure(p, "voice_launch_id_unavailable");
    }
    let until = expiry(p)?;
    let source = ctx.get(c"sourceSessionId")?;
    let ticket = fields(
        p,
        &[
            ("id", id),
            ("scope", scope),
            ("sourceSessionId", source),
            ("issuedAt", num(p, clock(p)?)?),
            ("expiresAt", until),
        ],
    )?;
    call(p.get(c"tickets")?, c"set", &[id, ticket])?;
    let launch = fields(
        p,
        &[
            ("id", id),
            ("scope", scope),
            ("sourceSessionId", source),
            ("expiresAt", iso(until)?),
            ("display", ctx.get(c"display")?),
        ],
    )?;
    fields(
        p,
        &[("ok", flag(p, true)?), ("launch", launch), ("context", ctx)],
    )
}
fn resolve<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    sweep(p)?;
    let id = clean(a[0])?;
    if !id.truthy()? {
        return failure(p, "voice_launch_required");
    }
    let tickets = p.get(c"tickets")?;
    let t = map_get(tickets, id)?;
    if !t.truthy()? {
        return failure(p, "voice_launch_unknown");
    }
    if t.get(c"expiresAt")?.number()? <= clock(p)? {
        call(tickets, c"delete", &[id])?;
        return failure(p, "voice_launch_expired");
    }
    let result = context(p, t.get(c"scope")?, t.get(c"sourceSessionId")?)?;
    if !ok(result)? {
        return Ok(result);
    }
    let until = expiry(p)?;
    t.set(c"expiresAt", until)?;
    let ctx = result.get(c"context")?;
    ctx.set(c"launchId", id)?;
    ctx.set(c"expiresAt", iso(until)?)?;
    fields(
        p,
        &[("ok", flag(p, true)?), ("launchId", id), ("context", ctx)],
    )
}
fn revoke<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let id = clean(a[0])?;
    if !id.truthy()? {
        return failure(p, "voice_launch_required");
    }
    fields(p, &[("ok", call(p.get(c"tickets")?, c"delete", &[id])?)])
}
fn revoke_session<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let id = clean(a[0])?;
    let mut n = 0.0;
    if id.truthy()? {
        let tickets = p.get(c"tickets")?;
        tickets.for_each(|entry| {
            let (key, t) = entry.iterator_pair()?;
            if id.equals(t.get(c"sourceSessionId")?)? {
                call(tickets, c"delete", &[key])?;
                n += 1.0;
            }
            Ok(())
        })?;
    }
    num(p, n)
}
pub(super) fn create<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(a[0])?;
    let p = pick(
        opts,
        &[
            c"records",
            c"directories",
            c"resolveCommander",
            c"now",
            c"randomId",
        ],
    )?;
    check_map(
        p.get(c"records")?,
        "voice launch registry requires records Map",
    )?;
    check_map(
        p.get(c"directories")?,
        "voice launch registry requires directories Map",
    )?;
    if !callable(p.get(c"resolveCommander")?)? {
        return Err(p.type_error("voice launch registry requires resolveCommander"));
    }
    let ttl = opts
        .get(c"ttlMs")?
        .number_value()?
        .filter(|x| x.is_finite() && *x > 0.0)
        .map(f64::floor)
        .unwrap_or(TTL);
    let cap = opts
        .get(c"maxTickets")?
        .number_value()?
        .filter(|x| x.is_finite() && *x > 0.0 && x.fract() == 0.0)
        .unwrap_or(CAPACITY);
    p.set(c"ttl", num(p, ttl)?)?;
    p.set(c"capacity", num(p, cap)?)?;
    p.set(c"tickets", p.global()?.get(c"Map")?.construct(&[])?)?;
    p.set(c"isVoiceRouterRecord", ports.get(c"isVoiceRouterRecord")?)?;
    let out = methods(
        p,
        &[
            ("resolve", 1, resolve),
            ("revoke", 1, revoke),
            ("revokeForSession", 1, revoke_session),
            ("sweep", 0, |p, _| sweep(p)),
            ("size", 0, |p, _| p.get(c"tickets")?.get(c"size")),
        ],
    )?;
    default_method(out, p, "issue", 0, issue)?;
    out.freeze()
}
