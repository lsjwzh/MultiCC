use super::*;

pub(super) fn admission_index<'a>(p: L<'a>, snap: L<'a>) -> Result<L<'a>> {
    let owners = map(p)?;
    let leases = map(p)?;
    for (items, key, index) in [
        (c"workspaces", c"ownerId", owners),
        (c"leases", c"workspaceId", leases),
    ] {
        js_or(snap.get(items)?, array(p)?)?.for_each(|v| {
            let id = v.get(key)?;
            if id.truthy()? && !call(index, c"has", &[id])?.truthy()? {
                call(index, c"set", &[id, v])?;
            }
            Ok(())
        })?;
    }
    fields(p, &[("owners", owners), ("leases", leases)])
}
pub(super) fn links<'a>(index: L<'a>, id: L<'a>, record: L<'a>) -> Result<(L<'a>, L<'a>)> {
    let ws = nullable(get(
        index.get(c"owners")?,
        js_or(record.optional(c"workspaceOwnerSessionId")?, id)?,
    )?)?;
    let lease = if ws.truthy()? {
        nullable(get(index.get(c"leases")?, ws.get(c"id")?)?)?
    } else {
        null(ws)?
    };
    Ok((ws, lease))
}
pub(super) fn residency<'a>(ws: L<'a>, record: L<'a>) -> Result<L<'a>> {
    let v = ws.optional(c"residency")?;
    if v.truthy()? {
        return Ok(v);
    }
    text(
        ws,
        if record.truthy()? && !record.optional(c"workspaceState")?.is_string("planned")? {
            "retained"
        } else {
            "planned"
        },
    )
}
fn resource<'a>(p: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let admission = deps(p)?.get(c"admission")?;
    let index = admission_index(p, call(admission, c"snapshot", &[])?)?;
    let record = rec(p, id)?;
    let (ws, lease) = links(index, id, record)?;
    let capacity = if ws.truthy()? && !lease.truthy()? {
        call(admission, c"capacityReason", &[ws.get(c"id")?])?
    } else {
        null(p)?
    };
    fields(
        p,
        &[
            ("id", nullable(ws.optional(c"id")?)?),
            ("residency", residency(ws, record)?),
            ("lease", js_or(lease.optional(c"state")?, text(p, "idle")?)?),
            ("capacityReason", capacity),
            ("reason", nullable(lease.optional(c"reason")?)?),
            ("pins", js_or(ws.optional(c"pins")?, array(p)?)?),
            (
                "path",
                nullable(js_or(
                    ws.optional(c"path")?,
                    record.optional(c"worktreePath")?,
                )?)?,
            ),
            (
                "branch",
                nullable(js_or(ws.optional(c"branch")?, record.optional(c"branch")?)?)?,
            ),
        ],
    )
}
fn pending<'a>(p: L<'a>, r: L<'a>) -> Result<L<'a>> {
    let old = r.optional(c"pendingConfiguration")?;
    if !old.truthy()? {
        return null(p);
    }
    let arg = fields(
        p,
        &[
            ("cli", js_or(old.get(c"cli")?, r.optional(c"cli")?)?),
            (
                "provider",
                nullable(old.get(c"profile")?.optional(c"provider")?)?,
            ),
        ],
    )?;
    let label = nullable(lookup(deps(p)?, c"providerName", &[arg])?)?;
    let out = spread(old)?;
    out.set(c"providerName", label)?;
    Ok(out)
}
fn config<'a>(p: L<'a>, r: L<'a>, open: bool) -> Result<L<'a>> {
    let d = deps(p)?;
    let out = fields(p, &[])?;
    if !open {
        out.set(c"pendingConfiguration", pending(p, r)?)?;
    }
    for k in [c"cli", c"model"] {
        out.set(k, r.optional(k)?)?;
    }
    let mut model = null(p)?;
    if r.optional(c"providerSelection")?
        .optional(c"mode")?
        .is_string("auto")?
    {
        model = r.optional(c"autoProviderLastRoute")?.optional(c"model")?;
    }
    if !model.truthy()? {
        model = lookup(d, c"effectiveModel", &[r])?;
    }
    out.set(
        c"effectiveModel",
        nullable(js_or(model, r.optional(c"model")?)?)?,
    )?;
    for k in [c"claudeWorkflow", c"preferSubtasks", c"effort"] {
        out.set(k, r.optional(k)?)?;
    }
    if !open {
        out.set(
            c"effectiveEffort",
            nullable(js_or(
                lookup(d, c"effectiveEffort", &[r])?,
                r.optional(c"effort")?,
            )?)?,
        )?;
    }
    out.set(c"provider", nullable(r.optional(c"provider")?)?)?;
    out.set(
        c"providerName",
        nullable(js_or(
            lookup(d, c"providerName", &[r])?,
            r.optional(c"provider")?,
        )?)?,
    )?;
    out.set(
        c"providerSelection",
        nullable(r.optional(c"providerSelection")?)?,
    )?;
    out.set(
        c"subagent",
        nullable(lookup(
            d,
            c"serializeSubagent",
            &[r.optional(c"subagent")?],
        )?)?,
    )?;
    if open {
        out.set(c"pendingConfiguration", pending(p, r)?)?;
    } else {
        out.set(c"rolePresetId", r.optional(c"rolePresetId")?)?;
    }
    Ok(out)
}
fn roles<'a>(p: L<'a>, task: L<'a>) -> Result<L<'a>> {
    Ok(p.catch(|| call(shell(p)?, c"roleBindings", &[task]))?
        .unwrap_or(null(p)?))
}
fn dir<'a>(p: L<'a>, r: L<'a>) -> Result<L<'a>> {
    get(deps(p)?.get(c"directories")?, r.optional(c"dirId")?)
}
fn detail_ready<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = ctx.get(c"p")?;
    let task = ctx.get(c"id")?;
    let e = a[0];
    let id = e.get(c"sessionId")?;
    let r = rec(p, id)?;
    let s = shell(p)?;
    let opts = fields(
        p,
        &[
            ("sessionId", id),
            ("taskId", task),
            ("candidate", call(s, c"attributionCandidate", &[task])?),
            (
                "separation",
                nullable(lookup(s, c"taskSeparation", &[task])?)?,
            ),
            ("admission", deps(p)?.get(c"admission")?),
            ("cwd", dir(p, r)?.optional(c"path")?),
        ],
    )?;
    ctx.set(c"entry", e)?;
    ctx.set(c"record", r)?;
    then(
        ports(p)?.get(c"deliveryView")?.call_plain(&[opts])?,
        ctx,
        |ctx, a| {
            let p = ctx.get(c"p")?;
            let e = ctx.get(c"entry")?;
            let bindings = roles(p, ctx.get(c"id")?)?;
            let out = spread(e)?;
            out.set(c"resource", resource(p, e.get(c"sessionId")?)?)?;
            out.set(c"configuration", config(p, ctx.get(c"record")?, false)?)?;
            out.set(c"roleBindings", bindings)?;
            out.set(c"attribution", a[0])?;
            Ok(out)
        },
    )
}
fn open_ready<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = ctx.get(c"p")?;
    let task = ctx.get(c"id")?;
    let e = a[0];
    let d = deps(p)?;
    p.catch(|| lookup(d, c"markTaskSeen", &[task]))?;
    let id = e.get(if e.get(c"readOnly")?.truthy()? {
        c"sourceSessionId"
    } else {
        c"sessionId"
    })?;
    let r = rec(p, id)?;
    let allowed = r.optional(c"kind")?.is_string("chat")?
        && !r.get(c"taskExecutionSlot")?.truthy()?
        && !r.get(c"type")?.is_string("aux")?
        && !r.get(c"type")?.is_string("gateway")?;
    let bindings = roles(p, task)?;
    let configuration = if allowed {
        config(p, r, true)?
    } else {
        null(p)?
    };
    let session = if allowed {
        let path = r.get(c"worktreePath")?;
        let cwd = if path.truthy()? {
            path
        } else {
            js_or(dir(p, r)?.optional(c"path")?, text(p, "")?)?
        };
        fields(
            p,
            &[
                ("id", r.get(c"id")?),
                ("kind", text(p, "chat")?),
                ("dirId", r.get(c"dirId")?),
                ("label", r.get(c"label")?),
                ("cli", r.get(c"cli")?),
                ("cwd", cwd),
                ("createdAt", r.get(c"createdAt")?),
                ("taskBoundTaskId", nullable(r.get(c"taskBoundTaskId")?)?),
                ("autoCommit", flag(p, !r.get(c"autoCommit")?.is_false()?)?),
            ],
        )?
    } else {
        null(p)?
    };
    fields(
        p,
        &[
            ("ok", flag(p, true)?),
            ("taskId", task),
            ("readOnly", e.get(c"readOnly")?),
            ("sessionId", e.get(c"sessionId")?),
            ("sourceSessionId", e.get(c"sourceSessionId")?),
            ("configuration", configuration),
            ("roleBindings", bindings),
            ("session", session),
        ],
    )
}
pub(super) fn task<'a>(p: L<'a>, id: L<'a>, open: bool) -> Result<L<'a>> {
    let ctx = fields(p, &[("p", p), ("id", id)])?;
    if open {
        then(
            call(
                shell(p)?,
                c"taskEntry",
                &[id, fields(p, &[("includeMessages", flag(p, false)?)])?],
            )?,
            ctx,
            open_ready,
        )
    } else {
        let options = fields(
            p,
            &[
                ("includeMessages", flag(p, false)?),
                ("messageScope", flag(p, true)?),
            ],
        )?;
        then(
            call(shell(p)?, c"taskEntry", &[id, options])?,
            ctx,
            detail_ready,
        )
    }
}
pub(super) fn resolve<'a>(p: L<'a>, b: L<'a>) -> Result<L<'a>> {
    let ctx = fields(p, &[("p", p), ("body", b)])?;
    then(
        call(shell(p)?, c"migrateTaskSessions", &[])?,
        ctx,
        |ctx, _| {
            let p = ctx.get(c"p")?;
            let b = ctx.get(c"body")?;
            let s = shell(p)?;
            let mut id = b.get(c"task")?;
            if !id.truthy()? && b.get(c"session")?.truthy()? {
                id = call(s, c"stateTarget", &[b.get(c"session")?])?.get(c"taskId")?;
                if !id.truthy()? {
                    id = call(s, c"artifactTaskId", &[b.get(c"session")?])?;
                }
            }
            if !id.truthy()? && b.get(c"shell")?.truthy()? {
                id = call(s, c"chatScope", &[b.get(c"shell")?])?.get(c"taskId")?;
            }
            if !id.truthy()? {
                return fields(p, &[("taskId", null(p)?), ("dirId", null(p)?)]);
            }
            ctx.set(c"id", id)?;
            then(
                call(
                    s,
                    c"taskEntry",
                    &[id, fields(p, &[("includeMessages", flag(p, false)?)])?],
                )?,
                ctx,
                |c, a| {
                    let p = c.get(c"p")?;
                    fields(
                        p,
                        &[
                            ("taskId", c.get(c"id")?),
                            (
                                "dirId",
                                value_or_null(
                                    rec(p, a[0].get(c"sessionId")?)?.optional(c"dirId")?,
                                )?,
                            ),
                        ],
                    )
                },
            )
        },
    )
}
pub(super) fn reclaim<'a>(p: L<'a>, b: L<'a>) -> Result<L<'a>> {
    let h = lookup(deps(p)?, c"hibernation", &[])?;
    if !h.truthy()? || !callable(h.get(c"reclaim")?)? {
        return fields(p, &[("kind", text(p, "unavailable")?)]);
    }
    let v = b.get(c"dirId")?;
    let id = if v.nullish()? { null(p)? } else { string(v)? };
    if id.truthy()? && !get(deps(p)?.get(c"directories")?, id)?.truthy()? {
        return refuse(p, "directory not found", 404., "directory_not_found");
    }
    let ctx = fields(p, &[("p", p), ("id", id)])?;
    then(
        call(
            h,
            c"reclaim",
            &[fields(
                p,
                &[
                    ("dirId", id),
                    ("force", flag(p, b.get(c"force")?.is_true()?)?),
                ],
            )?],
        )?,
        ctx,
        |ctx, a| {
            let p = ctx.get(c"p")?;
            invalidate(p, true)?;
            fields(
                p,
                &[
                    ("kind", text(p, "reclaimed")?),
                    ("dirId", ctx.get(c"id")?),
                    ("result", value_or_null(a[0])?),
                ],
            )
        },
    )
}
