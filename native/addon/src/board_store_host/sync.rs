use super::*;

fn pending(s: L<'_>) -> Result<bool> {
    if s.get(c"full")?.truthy()? || s.get(c"dates")?.get(c"length")?.truthy()? {
        return Ok(true);
    }
    for k in [c"replaced", c"keyed", c"resort", c"volatile"] {
        if nonempty(s.get(k)?)? {
            return Ok(true);
        }
    }
    for kind in KINDS.into_iter().chain(["root"]) {
        if nonempty(dirty(s, text(s, kind)?)?)? {
            return Ok(true);
        }
    }
    Ok(false)
}
fn orders<'a>(s: L<'a>, all: bool) -> Result<L<'a>> {
    let out = fields(s, &[])?;
    let raw = s.get(c"raw")?;
    let resort = s.get(c"resort")?;
    if all || has(resort, text(s, "tasks")?)? {
        out.set(
            c"tasks",
            call(
                keys(or_empty(raw.get(c"tasks")?)?)?,
                c"sort",
                &[s.get(c"p")?.get(c"compare")?],
            )?,
        )?;
    }
    if all || has(resort, text(s, "taskGroups")?)? {
        out.set(
            c"taskGroups",
            group_order(s.get(c"p")?, raw.get(c"taskGroups")?)?,
        )?;
    }
    Ok(out)
}
fn take_dates(s: L<'_>) -> Result<L<'_>> {
    let dates = s.get(c"dates")?;
    s.set(c"dates", array(s)?)?;
    Ok(dates)
}
fn input(s: L<'_>) -> Result<L<'_>> {
    if !pending(s)? {
        return undef(s);
    }
    call(s.get(c"volatile")?, c"values", &[])?
        .for_each(|owner| add(dirty(s, owner.element(0)?)?, owner.element(1)?))?;
    let raw = s.get(c"raw")?;
    let keyed = s.get(c"keyed")?;
    let resort = s.get(c"resort")?;
    if s.get(c"full")?.truthy()? {
        s.set(c"full", flag(s, false)?)?;
        for k in KINDS.into_iter().chain(["root"]) {
            call(dirty(s, text(s, k)?)?, c"clear", &[])?;
        }
        call(keyed, c"clear", &[])?;
        call(resort, c"clear", &[])?;
        values(or_empty(raw.get(c"tasks")?)?)?.for_each(|t| note_date(s, t))?;
        return fields(
            s,
            &[
                ("full", raw),
                ("orders", orders(s, true)?),
                ("dates", take_dates(s)?),
            ],
        );
    }
    let sync = fields(s, &[])?;
    for k in KINDS {
        let kind = text(s, k)?;
        let holder = raw.get_key(kind)?;
        let ds = dirty(s, kind)?;
        if has(s.get(c"replaced")?, kind)? {
            let val = or_empty(holder)?;
            sync.set_key(kind, fields(s, &[("replace", val)])?)?;
            if k == "tasks" {
                values(val)?.for_each(|t| note_date(s, t))?;
            }
        } else if nonempty(ds)? || has(keyed, kind)? {
            let set = array(s)?;
            let del = array(s)?;
            ds.for_each(|id| {
                if object(holder)? && own(holder, id)? {
                    let v = holder.get_key(id)?;
                    push(set, pair(s, id, v)?)?;
                    if k == "tasks" {
                        note_date(s, v)?;
                    }
                } else {
                    push(del, id)?;
                }
                Ok(())
            })?;
            let order = if has(keyed, kind)? && object(holder)? {
                keys(holder)?
            } else {
                null(s)?
            };
            sync.set_key(
                kind,
                fields(s, &[("set", set), ("del", del), ("order", order)])?,
            )?;
        }
        if k == "taskGroups" && nonempty(ds)? {
            add(resort, kind)?;
        }
        call(ds, c"clear", &[])?;
    }
    call(keyed, c"clear", &[])?;
    let ds = dirty(s, text(s, "root")?)?;
    if nonempty(ds)? {
        let set = fields(s, &[])?;
        let del = array(s)?;
        ds.for_each(|id| {
            if own(raw, id)? {
                set.set_key(id, raw.get_key(id)?)?;
            } else {
                push(del, id)?;
            }
            Ok(())
        })?;
        sync.set(c"root", fields(s, &[("set", set), ("del", del)])?)?;
        call(ds, c"clear", &[])?;
    }
    if nonempty(resort)? {
        sync.set(c"orders", orders(s, false)?)?;
        call(resort, c"clear", &[])?;
    }
    if s.get(c"dates")?.get(c"length")?.truthy()? {
        sync.set(c"dates", take_dates(s)?)?;
    }
    Ok(sync)
}
pub(super) fn send<'a>(s: L<'a>, op: &CStr, payload: L<'a>, retry: bool) -> Result<L<'a>> {
    let sync = input(s)?;
    let envelope = if sync.truthy()? {
        let o = spread(payload)?;
        o.set(c"sync", sync)?;
        o
    } else {
        payload
    };
    let body = json_call(s, c"stringify", envelope)?;
    let result = (|| json_call(s, c"parse", call(s.get(c"native")?, op, &[body])?))();
    match result {
        Ok(v) => Ok(v),
        Err(e) => {
            let why = s.exception_value()?;
            s.set(c"full", flag(s, true)?)?;
            if let Some(reason) = why {
                if retry && fold_string(reason.optional(c"message")?)?.contains("RESYNC_REQUIRED") {
                    return send(s, op, payload, false);
                }
                return Err(s
                    .get(c"p")?
                    .get(c"nativeCode")?
                    .call_plain(&[reason])?
                    .throw_error());
            }
            Err(e)
        }
    }
}
pub(super) fn flush(s: L<'_>) -> Result<()> {
    if pending(s)? {
        send(s, c"apply", fields(s, &[])?, true)?;
    }
    Ok(())
}
fn for_list<'a>(v: L<'a>, f: impl FnMut(L<'a>) -> Result<()>) -> Result<()> {
    if v.truthy()? {
        v.for_each(f)?;
    }
    Ok(())
}
pub(super) fn apply_diff<'a>(s: L<'a>, diff: L<'a>) -> Result<()> {
    if !object(diff)? {
        return Ok(());
    }
    let raw = s.get(c"raw")?;
    for kind in KINDS {
        let k = text(s, kind)?;
        let part = diff.get_key(k)?;
        if !object(part)? {
            continue;
        }
        let mut holder = raw.get_key(k)?;
        if !object(holder)? {
            holder = fields(s, &[])?;
            raw.set_key(k, holder)?;
        }
        let mut changed = false;
        for_list(part.get(c"set")?, |e| {
            let id = e.element(0)?;
            let v = e.element(1)?;
            transaction::capture(s, k, id)?;
            let current = if own(holder, id)? {
                holder.get_key(id)?
            } else {
                undef(s)?
            };
            if current.undefined()? {
                changed = true
            }
            if object(current)? && object(v)? && !current.is_array()? && !v.is_array()? {
                proxy::replace_plain(current, v)?
            } else {
                holder.set_key(id, v)?
            }
            if kind == "tasks" {
                note_date(s, holder.get_key(id)?)?;
            }
            if integer(id)? {
                add(s.get(c"keyed")?, k)?;
            }
            Ok(())
        })?;
        for_list(part.get(c"del")?, |id| {
            transaction::capture(s, k, id)?;
            if own(holder, id)? {
                call(
                    s.global()?.get(c"Reflect")?,
                    c"deleteProperty",
                    &[holder, id],
                )?;
                changed = true;
            }
            Ok(())
        })?;
        let order = part.get(c"order")?;
        if order.is_array()? {
            transaction::reorder(holder, order)?;
        }
        if changed || kind == "taskGroups" {
            add(s.get(c"resort")?, k)?;
        }
    }
    let root = diff.get(c"root")?;
    if object(root)? {
        let k = text(s, "root")?;
        let set = or_empty(root.get(c"set")?)?;
        keys(set)?.for_each(|id| {
            transaction::capture(s, k, id)?;
            raw.set_key(id, set.get_key(id)?)
        })?;
        for_list(root.get(c"del")?, |id| {
            transaction::capture(s, k, id)?;
            call(s.global()?.get(c"Reflect")?, c"deleteProperty", &[raw, id])?;
            Ok(())
        })?;
    }
    Ok(())
}
pub(super) fn restore<'a>(s: L<'a>, drift: L<'a>) -> Result<L<'a>> {
    let messages = array(s)?;
    if !object(drift)? {
        return Ok(messages);
    }
    for k in KINDS {
        let kind = text(s, k)?;
        let part = drift.get_key(kind)?;
        if !object(part)? {
            continue;
        }
        let ids = part.get(c"ids")?;
        for_list(ids, |id| add(dirty(s, kind)?, id))?;
        let changed = part.get(c"order")?.truthy()?;
        if changed {
            add(s.get(c"keyed")?, kind)?;
        }
        let ids = if ids.truthy()? {
            call(ids, c"slice", &[num(s, 0.)?, num(s, 5.)?])?
        } else {
            array(s)?
        };
        push(
            messages,
            text(
                s,
                &format!(
                    "{}:{}{}",
                    k,
                    fold_string(call(ids, c"join", &[text(s, ",")?])?)?,
                    if changed { "+order" } else { "" }
                ),
            )?,
        )?;
    }
    let roots = drift.get(c"root")?;
    for_list(roots, |id| add(dirty(s, text(s, "root")?)?, id))?;
    if roots.optional(c"length")?.truthy()? {
        push(
            messages,
            text(
                s,
                &format!(
                    "root:{}",
                    fold_string(call(roots, c"join", &[text(s, ",")?])?)?
                ),
            )?,
        )?;
    }
    if s.catch(|| {
        flush(s)?;
        undef(s)
    })?
    .is_none()
    {
        s.set(c"full", flag(s, true)?)?;
    }
    Ok(messages)
}
