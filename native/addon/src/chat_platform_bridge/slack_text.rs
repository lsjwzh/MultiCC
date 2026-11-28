use super::*;
use multicc_core::js::JsString;
use std::ffi::CStr;

fn property(el: L<'_>, key: &CStr) -> Result<JsString> {
    fallback(el.optional(key)?, "".into())?.coerce_string()
}

fn kind(el: L<'_>) -> Result<String> {
    Ok(el
        .optional(c"type")?
        .string()?
        .unwrap_or_default()
        .to_string_lossy())
}

fn children(el: L<'_>) -> Result<Vec<L<'_>>> {
    let list = el.optional(c"elements")?;
    if !list.truthy()? {
        return Ok(vec![]);
    }
    if !list.is_array()? {
        // The original for-of can walk a string. None of its characters has
        // an element type. Lists specifically use Array.prototype.entries.
        if list.kind()? == sys::ValueType::napi_string
            && !el.optional(c"type")?.is_string("rich_text_list")?
        {
            return Ok(vec![]);
        }
        return Err(error_value(el, "elements is not iterable")?.throw_error());
    }
    (0..list.get(c"length")?.number()? as u32)
        .map(|i| list.element(i))
        .collect()
}

fn inline(section: L<'_>) -> Result<JsString> {
    let mut pending = children(section)?;
    pending.reverse();
    let mut line = JsString::new();
    while let Some(el) = pending.pop() {
        match kind(el)?.as_str() {
            "text" => line.push(&property(el, c"text")?),
            "link" => {
                let caption = el.get(c"text")?;
                line.push(&if caption.truthy()? {
                    caption.coerce_string()?
                } else {
                    property(el, c"url")?
                });
            }
            "user" => {
                line.push_str("<@");
                line.push(&property(el, c"user_id")?);
                line.push_str(">");
            }
            "channel" => {
                line.push_str("<#");
                line.push(&property(el, c"channel_id")?);
                line.push_str(">");
            }
            "emoji" => {
                line.push_str(":");
                line.push(&property(el, c"name")?);
                line.push_str(":");
            }
            "date" => line.push(&property(el, c"fallback")?),
            _ => pending.extend(children(el)?.into_iter().rev()),
        }
    }
    Ok(line.trim())
}

fn blocks_text(blocks: L<'_>) -> Result<JsString> {
    let mut lines = Vec::new();
    if blocks.is_array()? {
        for i in 0..blocks.get(c"length")?.number()? as u32 {
            let block = blocks.element(i)?;
            if !block.optional(c"type")?.is_string("rich_text")? {
                continue;
            }
            let mut stack: Vec<_> = children(block)?
                .into_iter()
                .rev()
                .map(|el| (el, 0usize, String::new()))
                .collect();
            while let Some((el, depth, bullet)) = stack.pop() {
                let kind = kind(el)?;
                if kind == "rich_text_section" || kind == "rich_text_preformatted" {
                    let content = inline(el)?;
                    if content.is_empty() {
                        continue;
                    }
                    let mut line = JsString::new();
                    if kind == "rich_text_preformatted" {
                        line.push_str("```\n");
                        line.push(&content);
                        line.push_str("\n```");
                    } else {
                        if depth > 0 {
                            line.push_str(&">".repeat(depth));
                            line.push_str(" ");
                        }
                        line.push_str(&bullet);
                        line.push(&content);
                    }
                    lines.push(line);
                } else {
                    let depth = depth + usize::from(kind == "rich_text_quote");
                    let ordered =
                        kind == "rich_text_list" && el.get(c"style")?.is_string("ordered")?;
                    for (index, child) in children(el)?.into_iter().enumerate().rev() {
                        let marker = if kind != "rich_text_list" {
                            bullet.clone()
                        } else if ordered {
                            format!("{}. ", index + 1)
                        } else {
                            "• ".into()
                        };
                        stack.push((child, depth, marker));
                    }
                }
            }
        }
    }
    Ok(JsString::join(&lines, &JsString::from_rust_str("\n")).trim())
}

pub(super) fn extract<'a>(s: L<'a>, event: L<'a>) -> Result<Option<L<'a>>> {
    if !event.truthy()? || event.get(c"bot_id")?.truthy()? {
        return Ok(None);
    }
    let bot = s.get(c"botUserId")?;
    let user = event.get(c"user")?;
    if user.truthy()? && bot.truthy()? && user.equals(bot)? {
        return Ok(None);
    }
    let subtype = event.get(c"subtype")?;
    for excluded in ["bot_message", "message_changed", "message_deleted"] {
        if subtype.is_string(excluded)? {
            return Ok(None);
        }
    }
    let mut value = call(
        string(fallback(event.get(c"text")?, "".into())?)?,
        c"trim",
        &[],
    )?;
    let blocks = s.from_value(&V::String(blocks_text(event.get(c"blocks")?)?))?;
    if blocks.truthy()? && !call(value, c"includes", &[blocks])?.truthy()? {
        value = call(value, c"concat", &[text(s, "\n")?, blocks])?;
        value = call(value, c"trim", &[])?;
    }
    if bot.truthy()? {
        let pattern = call(concat(s, "<@", bot)?, c"concat", &[text(s, ">")?])?;
        let regex = s
            .global()?
            .get(c"RegExp")?
            .construct(&[pattern, text(s, "g")?])?;
        value = call(
            call(value, c"replace", &[regex, text(s, "")?])?,
            c"trim",
            &[],
        )?;
    }
    Ok(Some(value))
}
