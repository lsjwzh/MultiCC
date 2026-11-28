use super::*;

fn unattended<'a>(p: L<'a>, t: L<'a>) -> Result<L<'a>> {
    let id = event_session(t)?;
    if !id.truthy()? {
        return Ok(t);
    }
    let state = rec(p, id)?.optional(c"unattended")?;
    if !state.truthy()? || !object(state)? {
        return Ok(t);
    }
    let deadline = state.get(c"deadlineAt")?.explicit_number()?;
    let rounds = state.get(c"rounds")?.explicit_number()?.floor().max(0.);
    let status = state.get(c"status")?;
    let compact = fields(
        p,
        &[
            ("status", if status.nullish()? { null(p)? } else { status }),
            ("rounds", num(p, rounds)?),
            (
                "deadlineAt",
                if deadline.is_finite() && deadline > 0. {
                    num(p, deadline)?
                } else {
                    null(p)?
                },
            ),
            ("evaluating", flag(p, state.get(c"evaluating")?.is_true()?)?),
        ],
    )?;
    let out = spread(t)?;
    out.set(c"unattended", compact)?;
    Ok(out)
}
fn directories<'a>(p: L<'a>, prepared: L<'a>) -> Result<L<'a>> {
    let out = array(p)?;
    call(deps(p)?.get(c"directories")?, c"values", &[])?.for_each(|d| {
        let id = d.get(c"id")?;
        let row = pick(d, &[c"id", c"name", c"path"])?;
        row.set(
            c"worktreeCount",
            js_or(prepared.get(c"worktreeCounts")?.get_key(id)?, num(p, 0.)?)?,
        )?;
        let mut life = prepared.get(c"lifecycle")?.get_key(id)?;
        if !life.truthy()? {
            life = fields(p, &[])?;
            for k in [
                c"resident",
                c"retained",
                c"hibernated",
                c"planned",
                c"leased",
                c"onDisk",
                c"total",
            ] {
                life.set(k, num(p, 0.)?)?;
            }
        }
        row.set(c"worktreeLifecycle", life)?;
        append(out, row)
    })?;
    Ok(out)
}
fn terminals(p: L<'_>) -> Result<L<'_>> {
    let d = deps(p)?;
    let out = array(p)?;
    call(d.get(c"records")?, c"values", &[])?.for_each(|s| {
        if !s.get(c"kind")?.is_string("terminal")?
            || s.get(c"type")?.is_string("aux")?
            || s.get(c"type")?.is_string("gateway")?
        {
            return Ok(());
        }
        let id = s.get(c"id")?;
        let runtime = lookup(d.get(c"sessions")?, c"get", &[id])?;
        let provider = if runtime.truthy()? && !runtime.get(c"spawnedProvider")?.undefined()? {
            runtime.get(c"spawnedProvider")?
        } else {
            s.get(c"provider")?
        };
        let state = if provider.truthy()? && !s.get(c"proxyRouteToken")?.truthy()? {
            "route_dead"
        } else if runtime.truthy()? {
            "running"
        } else {
            "stopped"
        };
        append(
            out,
            fields(
                p,
                &[
                    ("id", id),
                    ("dirId", s.get(c"dirId")?),
                    ("label", js_or(s.get(c"label")?, id)?),
                    ("kind", s.get(c"kind")?),
                    ("cli", s.get(c"cli")?),
                    ("state", text(p, state)?),
                    (
                        "lastActivityAt",
                        if runtime.truthy()? {
                            call(runtime.get(c"lastActivity")?, c"getTime", &[])?
                        } else {
                            null(p)?
                        },
                    ),
                    (
                        "createdAt",
                        nullable(call(
                            p.global()?.get(c"Date")?,
                            c"parse",
                            &[s.get(c"createdAt")?],
                        )?)?,
                    ),
                ],
            )?,
        )
    })?;
    Ok(out)
}
pub(super) fn finish<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = ctx.get(c"p")?;
    let result = a[0];
    mark(ctx, "cardHits", result.get(c"hits")?)?;
    mark(ctx, "cardBuilds", result.get(c"builds")?)?;
    mark(
        ctx,
        "cardAudits",
        js_or(result.get(c"audits")?, num(p, 0.)?)?,
    )?;
    let tasks = array(p)?;
    result
        .get(c"cards")?
        .for_each(|t| append(tasks, unattended(p, t)?))?;
    lap(ctx, "cardLoopMs")?;
    let prepared = ctx.get(c"prepared")?;
    let out = fields(
        p,
        &[
            ("ok", flag(p, true)?),
            ("directories", directories(p, prepared)?),
            ("tasks", tasks),
        ],
    )?;
    out.spread_from(lists::snapshot(p, prepared.get(c"tasks")?)?)?;
    out.set(c"budgets", ctx.get(c"admission")?.get(c"budgets")?)?;
    out.set(c"clis", deps(p)?.get(c"clis")?)?;
    out.set(c"migration", ctx.get(c"migration")?)?;
    out.set(c"lastRuntime", ctx.get(c"lastRuntime")?)?;
    out.set(c"worktreePolicy", ctx.get(c"policy")?)?;
    out.set(c"sessions", terminals(p)?)?;
    lap(ctx, "tailMs")?;
    Ok(out)
}
