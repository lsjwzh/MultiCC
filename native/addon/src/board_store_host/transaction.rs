use super::*;

pub(super) fn reorder<'a>(obj: L<'a>, order: L<'a>) -> Result<()> {
    let object = obj.global()?.get(c"Object")?;
    let entries = call(object, c"entries", &[obj])?;
    let left = obj.global()?.get(c"Map")?.construct(&[entries])?;
    let reflect = obj.global()?.get(c"Reflect")?;
    keys(obj)?.for_each(|k| {
        call(reflect, c"deleteProperty", &[obj, k])?;
        Ok(())
    })?;
    order.for_each(|k| {
        if has(left, k)? {
            obj.set_key(k, call(left, c"get", &[k])?)?;
            call(left, c"delete", &[k])?;
        }
        Ok(())
    })?;
    left.for_each(|e| obj.set_key(e.element(0)?, e.element(1)?))
}
pub(super) fn capture<'a>(s: L<'a>, kind: L<'a>, id: L<'a>) -> Result<()> {
    let frame = s.get(c"tx")?;
    if !frame.truthy()? {
        return Ok(());
    }
    let pre = frame.get(c"pre")?;
    let k = call(pair(s, kind, id)?, c"join", &[text(s, "\u{1}")?])?;
    if has(pre, k)? {
        return Ok(());
    }
    let holder = holder(s, kind)?;
    let present = object(holder)? && own(holder, id)?;
    let val = if present {
        holder.get_key(id)?
    } else {
        undef(s)?
    };
    let json = if present {
        json_call(s, c"stringify", val)?
    } else {
        null(s)?
    };
    call(
        pre,
        c"set",
        &[
            k,
            fields(
                s,
                &[
                    ("kind", kind),
                    ("id", id),
                    ("present", flag(s, present)?),
                    ("value", val),
                    ("json", json),
                ],
            )?,
        ],
    )?;
    Ok(())
}
fn rollback<'a>(frame: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    if frame.get(c"done")?.truthy()? {
        return undef(frame);
    }
    frame.set(c"done", flag(frame, true)?)?;
    let s = frame.get(c"s")?;
    let raw = s.get(c"raw")?;
    if frame.equals(s.get(c"tx")?)? {
        s.set(c"tx", null(s)?)?;
    }
    let reflect = s.global()?.get(c"Reflect")?;
    call(frame.get(c"pre")?, c"values", &[])?.for_each(|item| {
        let kind = item.get(c"kind")?;
        let id = item.get(c"id")?;
        let present = item.get(c"present")?.truthy()?;
        let json = item.get(c"json")?;
        if kind.is_string("root")? {
            let collection = KINDS.into_iter().any(|k| id.is_string(k).unwrap_or(false));
            if present && (collection || !json.undefined()?) {
                raw.set_key(id, json_call(s, c"parse", json)?)?;
            } else {
                call(reflect, c"deleteProperty", &[raw, id])?;
            }
            if collection {
                add(s.get(c"replaced")?, id)?;
                mark_order(s, id)?;
            } else {
                add(dirty(s, kind)?, id)?;
            }
        } else {
            let mut obj = holder(s, kind)?;
            if !object(obj)? {
                obj = fields(s, &[])?;
                raw.set_key(kind, obj)?;
            }
            if present {
                let val = item.get(c"value")?;
                let before = json_call(s, c"parse", json)?;
                let result = if object(val)? && object(before)? && !val.is_array()? {
                    proxy::replace_plain(val, before)?;
                    val
                } else {
                    before
                };
                obj.set_key(id, result)?;
            } else {
                call(reflect, c"deleteProperty", &[obj, id])?;
            }
            add(dirty(s, kind)?, id)?;
        }
        Ok(())
    })?;
    let order = frame.get(c"order")?;
    for k in KINDS {
        let kind = text(s, k)?;
        let original = order.get_key(kind)?;
        let current = raw.get_key(kind)?;
        if original.truthy()? && object(current)? {
            let current_keys = keys(current)?;
            let len = original.get(c"length")?.number()? as u32;
            let mut same = current_keys.get(c"length")?.is_number(len as f64)?;
            if same {
                for i in 0..len {
                    if !current_keys.element(i)?.equals(original.element(i)?)? {
                        same = false;
                        break;
                    }
                }
            }
            if !same {
                reorder(current, original)?;
                mark_order(s, kind)?;
            }
        }
    }
    if s.catch(|| {
        sync::flush(s)?;
        undef(s)
    })?
    .is_none()
    {
        s.set(c"full", flag(s, true)?)?;
    }
    undef(s)
}
pub(super) fn run<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let existing = s.get(c"tx")?;
    if existing.truthy()? {
        return a[0].call_plain(&[function(s, "rollback", 0, 0, |s, a| {
            rollback(s.get(c"tx")?, a)
        })?]);
    }
    let order = fields(s, &[])?;
    for k in KINDS {
        let key = text(s, k)?;
        let v = s.get(c"raw")?.get_key(key)?;
        order.set_key(key, if object(v)? { keys(v)? } else { null(s)? })?;
    }
    let own = fields(
        s,
        &[
            ("s", s),
            ("order", order),
            ("done", flag(s, false)?),
            ("pre", js(s, c"Map")?),
        ],
    )?;
    s.set(c"tx", own)?;
    let result = a[0].call_plain(&[function(own, "rollback", 0, 0, rollback)?]);
    let error = if result.is_err() {
        let error = s.exception_value()?;
        rollback(own, &mut [])?;
        error
    } else {
        None
    };
    if own.equals(s.get(c"tx")?)? {
        s.set(c"tx", null(s)?)?;
    }
    if let Some(e) = error {
        Err(e.throw_error())
    } else {
        result
    }
}
