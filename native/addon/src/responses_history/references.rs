use super::*;

fn keys_only(item: L<'_>, allowed: &[&str]) -> Result<bool> {
    let keys = call(item.global()?.get(c"Object")?, c"keys", &[item])?;
    for i in 0..keys.get(c"length")?.number()? as u32 {
        let key = keys.element(i)?.coerce_string()?;
        if !allowed.iter().any(|k| key == *k) {
            return Ok(false);
        }
    }
    Ok(true)
}
fn nonempty_array(item: L<'_>, key: &CStr) -> Result<bool> {
    Ok(read(item, key)?.is_array()? && has_items(read(item, key)?)?)
}
fn visit_reference<'a>(state: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let item = args[0];
    let index = args[1];
    let input = state.get(c"input")?;
    let changes = state.get(c"changes")?;
    let keep = |v| push(input, v);
    let drop = |field| record(changes, index, item, field, "omit", "store_false_reference");
    if !object(item)? {
        keep(item)?;
    } else if read(item, c"type")?.is_string("item_reference")?
        || (is_string(read(item, c"id")?)?
            && read(item, c"id")?.truthy()?
            && keys_only(item, &["id", "type", "status"])?)
    {
        drop("")?;
    } else if !is_string(read(item, c"id")?)? || !read(item, c"id")?.truthy()? {
        keep(item)?;
    } else if has(state.get(c"unresolved")?, read(item, c"id")?)? {
        let copy = spread(item)?;
        copy.delete(c"id")?;
        if read(item, c"type")?.is_string("reasoning")?
            && is_string(read(copy, c"encrypted_content")?)?
        {
            copy.delete(c"encrypted_content")?;
        }
        let context = nonempty_array(copy, c"summary")? || nonempty_array(copy, c"content")?;
        if !keys_only(copy, &["type", "status"])?
            && !(read(item, c"type")?.is_string("reasoning")? && !context)
        {
            drop("id")?;
            keep(copy)?;
        } else {
            drop("")?;
        }
    } else if read(item, c"type")?.is_string("reasoning")?
        && !read(item, c"encrypted_content")?.truthy()?
    {
        let summary = nonempty_array(item, c"summary")?;
        let content = nonempty_array(item, c"content")?;
        if !summary && !content {
            drop("")?;
        } else {
            drop("id")?;
            let copy = spread(item)?;
            copy.delete(c"id")?;
            keep(copy)?;
        }
    } else {
        keep(item)?;
    }
    item.from_value(&V::Undefined)
}
pub(super) fn run<'a>(body: L<'a>, extra_ids: L<'a>) -> Result<L<'a>> {
    let changes = array(body, &[])?;
    if !object(body)? {
        return result(body, changes);
    }
    let filter = read(extra_ids, c"filter")?;
    let predicate = function(body, "", 1, 1, |_, a| {
        if is_string(a[0])? {
            Ok(a[0])
        } else {
            a[0].from_value(&V::Bool(false))
        }
    })?;
    let unresolved = group(
        body,
        c"Set",
        &[invoke(extra_ids, filter, &[predicate], "extraIds.filter")?],
    )?;
    let mut next = body;
    if is_string(read(body, c"previous_response_id")?)?
        && read(body, c"previous_response_id")?.truthy()?
    {
        next = spread(body)?;
        next.delete(c"previous_response_id")?;
        push(
            changes,
            fields(
                body,
                &[
                    ("path", text(body, "previous_response_id")?),
                    ("action", text(body, "omit")?),
                    ("rule", text(body, "store_false_reference")?),
                ],
            )?,
        )?;
    }
    if read(body, c"input")?.is_array()? {
        let before = changes.get(c"length")?.number()?;
        let input = array(body, &[])?;
        let state = fields(
            body,
            &[
                ("unresolved", unresolved),
                ("input", input),
                ("changes", changes),
            ],
        )?;
        visit(
            read(body, c"input")?,
            c"forEach",
            state,
            visit_reference,
            "body.input.forEach",
        )?;
        if changes.get(c"length")?.number()? > before {
            next = with(next, c"input", input)?;
        }
    }
    result(next, changes)
}
