use super::*;

pub(super) fn later<'a>(ctx: L<'a>, action: Action) -> Result<L<'a>> {
    let wait = ctx
        .global()?
        .get(c"Promise")?
        .construct(&[function(ctx, "", 1, 1, |p, a| {
            p.global()?.get(c"setImmediate")?.call_plain(&[a[0]])
        })?])?;
    then(wait, ctx, action)
}
pub(super) fn records(ctx: L<'_>) -> Result<L<'_>> {
    let d = deps(ctx.get(c"p")?)?;
    ctx.set(
        c"recordRows",
        call(ctx.global()?.get(c"Array")?, c"from", &[d.get(c"records")?])?,
    )?;
    ctx.set(c"names", map(ctx)?)?;
    ctx.set(c"records", fields(ctx, &[])?)?;
    ctx.set(c"recordCursor", num(ctx, 0.)?)?;
    record_chunk(ctx, &mut [])
}
fn record_chunk<'a>(ctx: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let p = ctx.get(c"p")?;
    let d = deps(p)?;
    let rows = ctx.get(c"recordRows")?;
    let end = rows.get(c"length")?.number()? as u32;
    let mut i = ctx.get(c"recordCursor")?.number()? as u32;
    let (out, names) = (ctx.get(c"records")?, ctx.get(c"names")?);
    let at = Instant::now();
    while i < end {
        let pair = rows.element(i)?;
        let record = pair.element(1)?;
        note_runtime(ctx, record)?;
        record_one(p, d, out, names, pair.element(0)?, record)?;
        i += 1;
        if at.elapsed().as_millis() >= 4 && i < end {
            ctx.set(c"recordCursor", num(ctx, i as f64)?)?;
            return later(ctx, record_chunk);
        }
    }
    records_ready(ctx)
}
fn record_one<'a>(p: L<'a>, d: L<'a>, out: L<'a>, names: L<'a>, id: L<'a>, r: L<'a>) -> Result<()> {
    let projection = fields(p, &[])?;
    for key in [
        c"id",
        c"dirId",
        c"kind",
        c"type",
        c"cli",
        c"provider",
        c"worktreePath",
        c"branch",
        c"workspaceOwnerSessionId",
        c"workspaceState",
        c"taskBoundTaskId",
        c"taskExecutionSlot",
        c"experimentalMode",
    ] {
        let value = r.get(key)?;
        if !value.undefined()? {
            projection.set(key, value)?;
        }
    }
    let key = call(
        text(p, "")?,
        c"concat",
        &[r.get(c"cli")?, text(p, "\u{0}")?, r.get(c"provider")?],
    )?;
    if r.get(c"provider")?.truthy()? && !call(names, c"has", &[key])?.truthy()? {
        call(
            names,
            c"set",
            &[key, nullable(lookup(d, c"providerName", &[r])?)?],
        )?;
    }
    projection.set(c"providerName", nullable(get(names, key)?)?)?;
    projection.set(
        c"taskState",
        fields(
            p,
            &[("goalState", r.get(c"taskState")?.optional(c"goalState")?)],
        )?,
    )?;
    out.define_key(id, projection)
}

pub(super) fn access<'a>(ctx: L<'a>) -> Result<L<'a>> {
    let at = Instant::now();
    ctx.set(c"accessMap", map(ctx)?)?;
    ctx.set(c"accessCursor", num(ctx, 0.)?)?;
    let done = function(ctx, "accessComplete", 1, 1, move |ctx, _| {
        mark(
            ctx,
            "accessMs",
            num(ctx, at.elapsed().as_secs_f64() * 1000.)?,
        )?;
        begin_cards(ctx, ctx.get(c"accessMap")?)
    })?;
    call(resolved(access_chunk(ctx, &mut [])?)?, c"then", &[done])
}
fn access_chunk<'a>(ctx: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let cards = ctx.get(c"cards")?;
    let i = ctx.get(c"accessCursor")?.number()?;
    if i >= cards.get(c"length")?.number()? {
        return undef(ctx);
    }
    let batch = call(cards, c"slice", &[num(ctx, i)?, num(ctx, i + 32.)?])?;
    let s = shell(ctx.get(c"p")?)?;
    then(
        call(s, c"taskAccessBatchAsync", &[batch])?,
        ctx,
        |ctx, a| {
            if a[0].nullish()? {
                return later(ctx, access_chunk);
            }
            let out = ctx.get(c"accessMap")?;
            a[0].for_each(|pair| {
                let (k, v) = pair.iterator_pair()?;
                call(out, c"set", &[k, v])?;
                Ok(())
            })?;
            ctx.set(
                c"accessCursor",
                num(ctx, ctx.get(c"accessCursor")?.number()? + 32.)?,
            )?;
            access_chunk(ctx, &mut [])
        },
    )
}
