use super::*;
use multicc_core::responses_history::converted_id;

fn replacement<'a>(
    rules: L<'a>,
    kind: L<'a>,
    id: L<'a>,
    index: L<'a>,
    occupied: L<'a>,
) -> Result<L<'a>> {
    let prefix = read(rules.get_key(kind)?, c"prefix")?
        .coerce_string()?
        .to_string_lossy();
    let mut salt = 0u64;
    loop {
        let tuple = array(
            id,
            &[kind, id, index, id.from_value(&V::Number(salt as f64))?],
        )?;
        let candidate = text(id, &converted_id(&prefix, &json(tuple)?.coerce_string()?))?;
        if !has(occupied, candidate)? {
            call(occupied, c"add", &[candidate])?;
            return Ok(candidate);
        }
        salt += 1;
    }
}
fn convert<'a>(state: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let item = args[0];
    let index = args[1];
    if !object(item)? {
        return Ok(item);
    }
    let mut result = item;
    let rules = state.get(c"rules")?;
    let kind = read(item, c"type")?;
    if own(rules, kind)? {
        let rule = rules.get_key(kind)?;
        if rule.truthy()? && is_string(read(item, c"id")?)? {
            let id = read(item, c"id")?;
            let starts = read(id, c"startsWith")?;
            let prefix = format!(
                "{}_",
                read(rule, c"prefix")?.coerce_string()?.to_string_lossy()
            );
            if !invoke(id, starts, &[text(id, &prefix)?], "item.id.startsWith")?.truthy()? {
                let referenced = state.get(c"referenced")?;
                if !has(referenced, read(item, c"id")?)?
                    || call(state.get(c"ids")?, c"get", &[read(item, c"id")?])?.is_number(1.0)?
                {
                    let id = replacement(
                        rules,
                        read(item, c"type")?,
                        read(item, c"id")?,
                        index,
                        state.get(c"occupied")?,
                    )?;
                    result = with(result, c"id", id)?;
                    if has(referenced, read(item, c"id")?)? {
                        call(state.get(c"remapped")?, c"set", &[read(item, c"id")?, id])?;
                    }
                    record(
                        state.get(c"changes")?,
                        index,
                        item,
                        "id",
                        "convert",
                        "responses_item_id",
                    )?;
                }
            }
        }
    }
    if read(item, c"type")?.is_string("function_call")? && object(read(item, c"arguments")?)? {
        result = spread(result)?;
        result.set(c"arguments", json(read(item, c"arguments")?)?)?;
        record(
            state.get(c"changes")?,
            index,
            item,
            "arguments",
            "convert",
            "json_function_arguments",
        )?;
    }
    Ok(result)
}
fn reference<'a>(state: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let item = args[0];
    let remapped = state.get(c"remapped")?;
    if !item.optional(c"type")?.is_string("item_reference")? || !has(remapped, read(item, c"id")?)?
    {
        return Ok(item);
    }
    record(
        state.get(c"changes")?,
        args[1],
        item,
        "id",
        "convert",
        "responses_item_reference",
    )?;
    let copy = spread(item)?;
    copy.set(c"id", call(remapped, c"get", &[read(item, c"id")?])?)?;
    Ok(copy)
}
pub(super) fn run<'a>(rules: L<'a>, body: L<'a>) -> Result<L<'a>> {
    let changes = array(body, &[])?;
    if !body.optional(c"input")?.is_array()? {
        return result(body, changes);
    }
    let ids = group(body, c"Map", &[])?;
    let referenced = group(body, c"Set", &[])?;
    let items = read(body, c"input")?;
    let records =
        crate::js_iteration::IteratorRecord::open(items, c"body.input is not iterable", || {
            items.global()?.get(c"Symbol")?.get(c"iterator")
        })?;
    records.for_each(|item| {
        if !is_string(item.optional(c"id")?)? {
            return Ok(());
        }
        if read(item, c"type")?.is_string("item_reference")? {
            call(referenced, c"add", &[read(item, c"id")?])?;
        } else {
            let id = read(item, c"id")?;
            let prev = call(ids, c"get", &[read(item, c"id")?])?
                .number_value()?
                .unwrap_or(0.0);
            call(ids, c"set", &[id, id.from_value(&V::Number(prev + 1.0))?])?;
        }
        Ok(())
    })?;
    let occupied = group(body, c"Set", &[call(ids, c"keys", &[])?])?;
    referenced.for_each(|id| {
        call(occupied, c"add", &[id])?;
        Ok(())
    })?;
    let state = fields(
        body,
        &[
            ("rules", rules),
            ("ids", ids),
            ("referenced", referenced),
            ("occupied", occupied),
            ("remapped", group(body, c"Map", &[])?),
            ("changes", changes),
        ],
    )?;
    let records = visit(
        read(body, c"input")?,
        c"map",
        state,
        convert,
        "body.input.map",
    )?;
    let input = visit(records, c"map", state, reference, "body.input.map(...).map")?;
    result(
        if has_items(changes)? {
            with(body, c"input", input)?
        } else {
            body
        },
        changes,
    )
}
