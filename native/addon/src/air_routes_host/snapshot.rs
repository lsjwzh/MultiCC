//! Snapshot preparation and card overlays. V8 objects stay on their owning thread; the card cache runs the Rust read model asynchronously.
use super::*;
use std::time::Instant;
mod capture;
mod tail;
pub(super) fn lap(c: L<'_>, name: &str) -> Result<()> {
    let t = c.get(c"timing")?;
    if !t.nullish()? {
        call(t, c"lap", &[text(t, name)?])?;
    }
    Ok(())
}
pub(super) fn mark<'a>(c: L<'a>, name: &str, v: L<'a>) -> Result<()> {
    let t = c.get(c"timing")?;
    if !t.nullish()? {
        call(t, c"set", &[text(t, name)?, v])?;
    }
    Ok(())
}
fn measured<'a>(ctx: L<'a>, name: &str, work: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    let timer = ctx.get(c"timing")?;
    if timer.nullish()? {
        return work();
    }
    let at = Instant::now();
    let v = work()?;
    call(
        timer,
        c"sum",
        &[
            text(ctx, name)?,
            num(ctx, at.elapsed().as_secs_f64() * 1000.)?,
        ],
    )?;
    Ok(v)
}
pub(super) fn start<'a>(p: L<'a>, timing: L<'a>, options: L<'a>) -> Result<L<'a>> {
    async_result(p, || {
        let ctx = fields(p, &[("p", p), ("timing", timing), ("options", options)])?;
        then(
            lookup(shell(p)?, c"migrateTaskSessions", &[])?,
            ctx,
            prepare,
        )
    })
}
fn note_runtime<'a>(ctx: L<'a>, r: L<'a>) -> Result<()> {
    let p = ctx.get(c"p")?;
    let cron = ctx.get(c"cronIds")?;
    if !r.get(c"kind")?.is_string("chat")?
        || !r.get(c"cli")?.truthy()?
        || call(cron, c"has", &[r.get(c"id")?])?.truthy()?
        || ports(p)?
            .get(c"abnormal")?
            .call_plain(&[r.get(c"taskState")?.optional(c"classifyState")?])?
            .truthy()?
    {
        return Ok(());
    }
    let worked = r.get(c"lastWorkAt")?;
    let at = if worked.truthy()? {
        worked
    } else {
        js_or(r.get(c"createdAt")?, text(p, "")?)?
    };
    let date = ctx.get(c"lastDate")?;
    if date.undefined()?
        || string(at)?.coerce_string()?.into_units() > string(date)?.coerce_string()?.into_units()
    {
        ctx.set(c"lastDate", at)?;
        ctx.set(c"lastRecord", r)?;
    }
    Ok(())
}
fn last_runtime<'a>(p: L<'a>, last: L<'a>) -> Result<L<'a>> {
    let d = deps(p)?;
    if last.nullish()? {
        return Ok(last);
    }
    fields(
        p,
        &[
            ("cli", last.get(c"cli")?),
            ("provider", nullable(last.get(c"provider")?)?),
            ("providerName", {
                let name = lookup(d, c"providerName", &[last])?;
                if name.truthy()? {
                    name
                } else {
                    nullable(last.get(c"provider")?)?
                }
            }),
            (
                "providerSelection",
                nullable(last.get(c"providerSelection")?)?,
            ),
            ("model", nullable(last.get(c"model")?)?),
            ("claudeWorkflow", last.get(c"claudeWorkflow")?),
            ("preferSubtasks", last.get(c"preferSubtasks")?),
            ("effort", nullable(last.get(c"effort")?)?),
            (
                "subagent",
                nullable(lookup(d, c"serializeSubagent", &[last.get(c"subagent")?])?)?,
            ),
        ],
    )
}
fn prepare<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = ctx.get(c"p")?;
    let d = deps(p)?;
    let mut migration = a[0];
    if migration.truthy()? && object(migration)? {
        migration = spread(migration)?;
        migration.delete(c"tasks")?;
    }
    ctx.set(c"migration", migration)?;
    lap(ctx, "migrateMs")?;
    let cron = p
        .global()?
        .get(c"Set")?
        .construct(&[js_or(lookup(d, c"cronSessionIds", &[])?, array(p)?)?])?;
    ctx.set(c"cronIds", cron)?;
    ctx.set(c"lastRecord", null(p)?)?;
    let board = call(d, c"getBoard", &[])?;
    lap(ctx, "boardMs")?;
    ctx.set(c"now", now_ms(p)?)?;
    let admission = call(d.get(c"admission")?, c"snapshot", &[])?;
    ctx.set(c"admission", admission)?;
    lap(ctx, "admissionMs")?;

    ctx.set(c"board", board)?;
    capture::records(ctx)
}
fn records_ready(ctx: L<'_>) -> Result<L<'_>> {
    let p = ctx.get(c"p")?;
    let board = ctx.get(c"board")?;
    let admission = ctx.get(c"admission")?;
    let records = ctx.get(c"records")?;
    ctx.set(c"lastRuntime", last_runtime(p, ctx.get(c"lastRecord")?)?)?;
    lap(ctx, "recordsMs")?;
    let shell_tasks = array(p)?;
    js_or(lookup(shell(p)?, c"listTasks", &[])?, array(p)?)?.for_each(|t| {
        if t.get(c"embedded")?.truthy()?
            || (t.get(c"separatedFromTaskId")?.truthy()? && !t.get(c"ready")?.truthy()?)
        {
            append(
                shell_tasks,
                pick(t, &[c"id", c"embedded", c"separatedFromTaskId", c"ready"])?,
            )?;
        }
        Ok(())
    })?;
    let cache = p.get(c"cache")?;
    let input = fields(
        p,
        &[
            ("op", text(p, "airInputs")?),
            ("ids", ctx.get(c"options")?.get(c"ids")?),
            ("resourceIndex", flag(p, true)?),
            ("board", board),
            ("records", records),
            ("admission", admission),
            ("shellTasks", shell_tasks),
            (
                "cacheable",
                flag(p, !cache.get(c"mode")?.is_string("off")?)?,
            ),
        ],
    )?;
    then(
        cache.get(c"prepareAsync")?.call_plain(&[input])?,
        ctx,
        prepared,
    )
}
fn prepared<'a>(ctx: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let p = ctx.get(c"p")?;
    let d = deps(p)?;
    let prepared = a[0];
    ctx.set(c"prepared", prepared)?;
    mark(ctx, "signatureBuilds", prepared.get(c"signatureBuilds")?)?;
    let policy = p
        .catch(|| lookup(lookup(d, c"hibernation", &[])?, c"policy", &[]))?
        .unwrap_or(null(p)?);
    ctx.set(c"policy", nullable(policy)?)?;
    lap(ctx, "admissionIndexMs")?;
    let ids = ctx.get(c"options")?.get(c"ids")?;
    let selected = if ids.truthy()? {
        p.global()?.get(c"Set")?.construct(&[ids])?
    } else {
        ids
    };
    let cards = if prepared.get(c"resourceIndex")?.truthy()? {
        prepared.get(c"tasks")?
    } else {
        ctx.set(
            c"index",
            detail::admission_index(p, ctx.get(c"admission")?)?,
        )?;
        let cards = array(p)?;
        prepared.get(c"tasks")?.for_each(|t| {
            if !selected.truthy()? || call(selected, c"has", &[t.get(c"id")?])?.truthy()? {
                append(cards, t)?;
            }
            Ok(())
        })?;
        cards
    };
    ctx.set(c"prune", flag(p, !selected.truthy()?)?)?;
    ctx.set(c"cards", cards)?;
    mark(ctx, "cardCount", cards.get(c"length")?)?;
    lap(ctx, "cardListMs")?;
    let shell = shell(p)?;
    if callable(shell.get(c"taskAccessBatchAsync")?)? {
        return capture::access(ctx);
    }
    let access = measured(ctx, "accessMs", || {
        if callable(shell.get(c"taskAccessBatch")?)? {
            return call(shell, c"taskAccessBatch", &[cards]);
        }
        let map = map(p)?;
        cards.for_each(|t| {
            call(
                map,
                c"set",
                &[t.get(c"id")?, call(shell, c"taskAccess", &[t])?],
            )?;
            Ok(())
        })?;
        Ok(map)
    })?;
    begin_cards(ctx, access)
}
fn begin_cards<'a>(ctx: L<'a>, access: L<'a>) -> Result<L<'a>> {
    let p = ctx.get(c"p")?;
    ctx.set(c"access", access)?;
    lap(ctx, "cardSignatureMs")?;
    let h = ports(p)?;
    let mut keys = h.get(c"factKeys")?;
    if !keys.truthy()? {
        keys = domain(p, &[("op", text(p, "runStateFactKeys")?)])?;
        if !keys.is_array()? || !keys.get(c"length")?.truthy()? {
            return Err(p.type_error("[air] runStateFactKeys unavailable"));
        }
        h.set(c"factKeys", keys)?;
    }
    for k in [c"facts", c"merges", c"capacityReasons"] {
        ctx.set(k, fields(p, &[])?)?;
    }
    ctx.set(c"capacityMemo", map(p)?)?;
    ctx.set(c"items", array(p)?)?;
    ctx.set(c"cursor", num(p, 0.)?)?;
    card_loop(ctx)
}
fn links<'a>(ctx: L<'a>, id: L<'a>, session: L<'a>, record: L<'a>) -> Result<(L<'a>, L<'a>)> {
    let index = ctx.get(c"prepared")?.get(c"resourceIndex")?;
    if !index.truthy()? {
        return detail::links(ctx.get(c"index")?, session, record);
    }
    let pair = index.get_key(id)?;
    let row = |key, i| {
        let idx = pair.element(i)?;
        if idx.nullish()? {
            null(ctx)
        } else {
            ctx.get(c"admission")?.get(key)?.get_key(idx)
        }
    };
    Ok((row(c"workspaces", 0)?, row(c"leases", 1)?))
}
fn card_inputs<'a>(ctx: L<'a>, t: L<'a>) -> Result<()> {
    let p = ctx.get(c"p")?;
    let d = deps(p)?;
    let id = t.get(c"id")?;
    let session = event_session(t)?;
    let r = ctx.get(c"records")?.get_key(session)?;
    let (ws, lease) = links(ctx, id, session, r)?;
    let sig = ctx.get(c"prepared")?.get(c"signatures")?.get_key(id)?;
    append(
        ctx.get(c"items")?,
        fields(
            p,
            &[
                ("key", id),
                ("signature", sig),
                ("access", nullable(get(ctx.get(c"access")?, id)?)?),
            ],
        )?,
    )?;
    lists::facts_for(p, t, ctx.get(c"facts")?, Some(ports(p)?.get(c"factKeys")?))?;
    let residency = detail::residency(ws, r)?;
    let merge = if r.truthy()?
        && (residency.is_string("resident")? || residency.is_string("retained")?)
        && callable(d.get(c"mergeStateCached")?)?
    {
        measured(ctx, "mergeStateMs", || {
            call(
                d,
                c"mergeStateCached",
                &[get(d.get(c"directories")?, r.get(c"dirId")?)?, r],
            )
        })?
    } else {
        null(p)?
    };
    ctx.get(c"merges")?.define_key(id, merge)?;
    let capacity = if ws.truthy()? && !lease.truthy()? {
        measured(ctx, "capacityMs", || {
            let memo = ctx.get(c"capacityMemo")?;
            let key = if ws.get(c"residency")?.is_string("resident")? {
                text(p, "resident")?
            } else {
                call(text(p, "other\u{0}")?, c"concat", &[ws.get(c"dirId")?])?
            };
            if !call(memo, c"has", &[key])?.truthy()? {
                call(
                    memo,
                    c"set",
                    &[
                        key,
                        call(d.get(c"admission")?, c"capacityReason", &[ws.get(c"id")?])?,
                    ],
                )?;
            }
            get(memo, key)
        })?
    } else {
        null(p)?
    };
    ctx.get(c"capacityReasons")?.define_key(id, capacity)
}
fn card_loop(ctx: L<'_>) -> Result<L<'_>> {
    let p = ctx.get(c"p")?;
    let cards = ctx.get(c"cards")?;
    let limit = cards.get(c"length")?.number()? as u32;
    let mut i = ctx.get(c"cursor")?.number()? as u32;
    let at = Instant::now();
    while i < limit {
        card_inputs(ctx, cards.element(i)?)?;
        i += 1;
        if at.elapsed().as_millis() >= 4 && i < limit {
            ctx.set(c"cursor", num(p, i as f64)?)?;
            let wait =
                p.global()?
                    .get(c"Promise")?
                    .construct(&[function(p, "", 1, 1, |p, a| {
                        p.global()?.get(c"setImmediate")?.call_plain(&[a[0]])
                    })?])?;
            return then(wait, ctx, |ctx, _| card_loop(ctx));
        }
    }
    let prepared = ctx.get(c"prepared")?;
    let args = fields(
        ctx,
        &[
            ("now", ctx.get(c"now")?),
            ("globalSignature", prepared.get(c"globalSignature")?),
            ("prune", ctx.get(c"prune")?),
            ("items", ctx.get(c"items")?),
            ("facts", ctx.get(c"facts")?),
            ("merges", ctx.get(c"merges")?),
            ("capacityReasons", ctx.get(c"capacityReasons")?),
        ],
    )?;
    let bases = function(ctx, "", 1, 1, |ctx, a| {
        ctx.set(c"needed", a[0])?;
        ctx.set(c"baseRows", array(ctx)?)?;
        ctx.set(c"baseCursor", num(ctx, 0.)?)?;
        base_chunk(ctx, &mut [])
    })?;
    then(
        call(p.get(c"cache")?, c"snapshotAsync", &[args, bases])?,
        ctx,
        tail::finish,
    )
}

fn base_chunk<'a>(ctx: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let indices = ctx.get(c"needed")?;
    let out = ctx.get(c"baseRows")?;
    let end = indices.get(c"length")?.number()? as u32;
    let mut i = ctx.get(c"baseCursor")?.number()? as u32;
    let at = Instant::now();
    while i < end {
        let t = ctx.get(c"cards")?.get_key(indices.element(i)?)?;
        let id = t.get(c"id")?;
        let sid = event_session(t)?;
        let record = ctx.get(c"records")?.get_key(sid)?;
        let (ws, lease) = links(ctx, id, sid, record)?;
        let base = fields(
            ctx,
            &[
                ("task", t),
                ("record", nullable(record)?),
                ("workspace", ws),
                ("lease", lease),
                (
                    "dirId",
                    ctx.get(c"prepared")?.get(c"taskDirs")?.get_key(id)?,
                ),
                ("access", get(ctx.get(c"access")?, id)?),
                (
                    "providerName",
                    if record.optional(c"provider")?.truthy()? {
                        record.get(c"providerName")?
                    } else {
                        null(ctx)?
                    },
                ),
            ],
        )?;
        append(out, fields(ctx, &[("key", id), ("base", base)])?)?;

        i += 1;
        if at.elapsed().as_millis() >= 4 && i < end {
            ctx.set(c"baseCursor", num(ctx, i as f64)?)?;
            return capture::later(ctx, base_chunk);
        }
    }
    Ok(out)
}
