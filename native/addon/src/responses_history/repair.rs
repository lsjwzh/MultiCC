//! One rejection-driven repair, in upstream precedence order. All regular
//! expressions use ECMAScript semantics (UTF-16, word boundaries and case).
use super::*;
use multicc_core::responses_history::optional_item_field;

fn regex<'a>(a: L<'a>, pattern: &str, flags: &str) -> Result<L<'a>> {
    group(a, c"RegExp", &[text(a, pattern)?, text(a, flags)?])
}
fn captures<'a>(v: L<'a>, pattern: &str, flags: &str) -> Result<L<'a>> {
    call(regex(v, pattern, flags)?, c"exec", &[v])
}
fn matches(v: L<'_>, pattern: &str) -> Result<bool> {
    call(regex(v, pattern, "i")?, c"test", &[v])?.truthy()
}
fn message(value: L<'_>) -> Result<L<'_>> {
    let value = if value.truthy()? {
        value
    } else {
        text(value, "")?
    };
    value.global()?.get(c"String")?.call_plain(&[value])
}
fn parameter(error: L<'_>) -> Result<L<'_>> {
    if is_string(error.optional(c"param")?)? && error.optional(c"param")?.truthy()? {
        return error.optional(c"param");
    }
    let m = captures(
        message(error.optional(c"message")?)?,
        r#"(?:Invalid|Unknown parameter|Unsupported parameter|Unrecognized parameter)\s*:?\s*['"]([^'"]+)['"]"#,
        "i",
    )?;
    if m.truthy()? {
        m.element(1)
    } else {
        text(error, "")
    }
}
fn omit_optional<'a>(
    rules: L<'a>,
    body: L<'a>,
    m: L<'a>,
    unsupported: bool,
    invalid_optional: bool,
    invalid_id: bool,
) -> Result<Option<L<'a>>> {
    if !m.truthy()? || !body.optional(c"input")?.is_array()? {
        return Ok(None);
    }
    let index = m.from_value(&V::Number(m.element(1)?.number()?))?;
    let field = m.element(2)?;
    let field_name = field.coerce_string()?.to_string_lossy();
    let item = read(body, c"input")?.get_key(index)?;
    let kind = item.optional(c"type")?;
    if !own(rules, kind)?
        || !rules.get_key(kind)?.truthy()?
        || !optional_item_field(&field_name)
        || !own(item, field)?
        || !(unsupported || invalid_optional || (field_name == "id" && invalid_id))
    {
        return Ok(None);
    }
    if field_name == "id" {
        let items = read(body, c"input")?;
        let method = read(items, c"some")?;
        let predicate = function(item, "", 1, 1, |item, args| {
            let other = args[0];
            item.from_value(&V::Bool(
                other.optional(c"type")?.is_string("item_reference")?
                    && read(other, c"id")?.equals(read(item, c"id")?)?,
            ))
        })?;
        if invoke(items, method, &[predicate], "body.input.some")?.truthy()? {
            return Ok(None);
        }
    }
    let copy = spread(item)?;
    let key = match field_name.as_str() {
        "id" => c"id",
        "status" => c"status",
        _ => c"internal_chat_message_metadata_passthrough",
    };
    copy.delete(key)?;
    let source = read(body, c"input")?;
    let input = invoke(source, read(source, c"slice")?, &[], "body.input.slice")?;
    input.set_key(index, copy)?;
    let next = with(body, c"input", input)?;
    let changes = array(body, &[])?;
    record(
        changes,
        index,
        item,
        &field_name,
        "omit",
        "upstream_rejected_optional_field",
    )?;
    Ok(Some(result(next, changes)?))
}

pub(super) fn run<'a>(rules: L<'a>, body: L<'a>, error: L<'a>) -> Result<L<'a>> {
    let param = parameter(error)?;
    let msg = message(error.optional(c"message")?)?;
    let unsupported = matches(
        msg,
        r"unknown parameter|unsupported parameter|unrecognized parameter|extra inputs? (?:are )?not permitted",
    )?;
    let invalid_id = matches(
        msg,
        r"expected an? id.*(?:begin|start)|invalid.*\bid\b.*(?:prefix|format)",
    )?;
    let code = error.optional(c"code")?;
    let invalid_optional = (code.is_string("invalid_type")? || code.is_string("invalid_value")?)
        && matches(msg, r"invalid\b")?;
    let m = captures(param, r"^input\[(\d+)\]\.(\w+)$", "")?;
    if let Some(repaired) =
        omit_optional(rules, body, m, unsupported, invalid_optional, invalid_id)?
    {
        return Ok(repaired);
    }
    let mut param_and_message = param.coerce_string()?;
    param_and_message.push_str(" ");
    param_and_message.push(&msg.coerce_string()?);
    if matches(
        body.from_value(&V::String(param_and_message))?,
        r"input\[\d+\]\.content",
    )? && (matches(msg, "array too long")?
        || matches(message(error.optional(c"code")?)?, "array_above_max_length")?)
    {
        let stripped = item_pass(body, ItemPass::Content)?;
        if has_items(stripped.get(c"changes")?)? {
            return Ok(stripped);
        }
    }
    const ENCRYPTION_ERROR: &str =
        "encrypted content .{0,120}(?:could not be verified|could not be decrypted|could not be parsed)";
    if matches(msg, ENCRYPTION_ERROR)? {
        let stripped = item_pass(body, ItemPass::Encrypted)?;
        let refs = references::run(stripped.get(c"body")?, array(body, &[])?)?;
        let repaired = combined(refs.get(c"body")?, &[stripped, refs])?;
        if has_items(repaired.get(c"changes")?)? {
            return Ok(repaired);
        }
    }
    let id = captures(msg, r#"item with id ['"]([^'"]+)['"] not found"#, "i")?;
    if id.truthy()? {
        let stripped = references::run(body, array(body, &[id.element(1)?])?)?;
        if has_items(stripped.get(c"changes")?)? {
            return Ok(stripped);
        }
    }
    let tool_match = captures(
        param,
        r"^tools\[(\d+)\]\.(strict|defer_loading|cache_control)$",
        "",
    )?;
    let null = body.from_value(&V::Null)?;
    if !unsupported || !tool_match.truthy()? || !body.optional(c"tools")?.is_array()? {
        return Ok(null);
    }
    let index = body.from_value(&V::Number(tool_match.element(1)?.number()?))?;
    let field = tool_match.element(2)?;
    let tool = read(body, c"tools")?.get_key(index)?;
    if !tool.optional(c"type")?.is_string("function")? || !own(tool, field)? {
        return Ok(null);
    }
    let copy = spread(tool)?;
    copy.delete(match field.coerce_string()?.to_string_lossy().as_str() {
        "strict" => c"strict",
        "defer_loading" => c"defer_loading",
        _ => c"cache_control",
    })?;
    let source = read(body, c"tools")?;
    let tools = invoke(source, read(source, c"slice")?, &[], "body.tools.slice")?;
    tools.set_key(index, copy)?;
    let next = with(body, c"tools", tools)?;
    let change = fields(
        body,
        &[
            ("path", param),
            ("itemType", text(body, "function")?),
            ("action", text(body, "omit")?),
            ("rule", text(body, "upstream_rejected_optional_field")?),
        ],
    )?;
    result(next, array(body, &[change])?)
}
