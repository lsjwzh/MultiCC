//! Classifier transcript reads retain JS message IDs and original UTF-16 text.
use super::*;

pub(super) fn last_user(history: L<'_>) -> Result<L<'_>> {
    if history.is_array()? {
        for index in (0..history.get(c"length")?.number()? as u32).rev() {
            let message = history.element(index)?;
            if !message.optional(c"role")?.is_string("user")? {
                continue;
            }
            let content = message.get(c"content")?;
            if content.kind()? != sys::ValueType::napi_string {
                continue;
            }
            let body = trimmed(message.get(c"content")?)?;
            if !body.is_empty() && !system_message(&trimmed(message.get(c"content")?)?) {
                return message.get(c"content");
            }
        }
    }
    text(history, "")
}
pub(super) fn first_user(history: L<'_>) -> Result<bool> {
    let mut users = 0;
    if history.is_array()? {
        history.for_each_while(|m| {
            if m.optional(c"role")?.is_string("user")?
                && !m.get(c"displayOnly")?.truthy()?
                && m.get(c"content")?.kind()? == sys::ValueType::napi_string
                && !trimmed(m.get(c"content")?)?.is_empty()
            {
                users += 1;
            }
            Ok(users < 2)
        })?;
    }
    Ok(users == 1)
}
pub(super) fn anchor<'a>(p: L<'a>, name: L<'a>) -> Result<L<'a>> {
    let id = p.catch(|| {
        let history = p.get(c"viewChatHistory")?.call_plain(&[name])?;
        for i in (0..history.get(c"length")?.number()? as u32).rev() {
            let m = history.element(i)?;
            if !m.truthy()? || !m.get(c"content")?.truthy()? {
                continue;
            }
            if !m.get(c"role")?.is_string("user")? && !m.get(c"role")?.is_string("assistant")? {
                continue;
            }
            if !system_message(&trimmed(m.get(c"content")?)?) {
                return fallback(m.get(c"id")?, V::Null);
            }
        }
        null(p)
    })?;
    id.map_or_else(|| null(p), Ok)
}
pub(super) fn status<'a>(p: L<'a>, name: L<'a>, expected: L<'a>) -> Result<L<'a>> {
    let id = anchor(p, name)?;
    fields(
        p,
        &[
            ("observedAnchorMessageId", id),
            ("changed", flag(p, !id.equals(expected)?)?),
        ],
    )
}
