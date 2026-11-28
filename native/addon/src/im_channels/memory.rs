//! WeChat's session snapshot is deliberately separate from routing/admission.
use super::*;

fn cwd(p: L<'_>) -> Result<L<'_>> {
    keep(p.get(c"worktreePath")?, keep(p.get(c"cwd")?, text(p, "")?)?)
}
fn title(p: L<'_>) -> Result<L<'_>> {
    keep(p.get(c"label")?, keep(p.get(c"id")?, text(p, "")?)?)
}
fn aliases<'a>(p: L<'a>, previous: L<'a>) -> Result<L<'a>> {
    let mut parts = Vec::new();
    for key in [c"id", c"label", c"cli", c"kind"] {
        let v = p.get(key)?;
        if v.truthy()? {
            parts.push(string(v)?.coerce_string()?);
        }
    }
    let directory = string(cwd(p)?)?.coerce_string()?;
    let dirs: Vec<_> = directory
        .as_units()
        .split(|u| *u == 47 || *u == 92)
        .filter(|v| !v.is_empty())
        .collect();
    let tail: Vec<_> = dirs
        .iter()
        .skip(dirs.len().saturating_sub(2))
        .map(|v| JsString::from_units(v.to_vec()))
        .collect();
    parts.push(JsString::join(&tail, &JsString::from_rust_str(" ")));
    let old = previous.get(c"aliases")?;
    if old.truthy()? {
        old.for_each(|v| {
            if v.truthy()? {
                parts.push(string(v)?.coerce_string()?);
            }
            Ok(())
        })?;
    }
    let raw = JsString::join(&parts, &JsString::from_rust_str(" "));
    let mut unique = Vec::new();
    for token in raw
        .as_units()
        .split(|u| is_js_whitespace(*u) || [44, 0xff0c, 47, 92, 58, 95, 45, 35].contains(u))
    {
        if token.is_empty() {
            continue;
        }
        let token = JsString::from_units(token.to_vec()).trim().to_lowercase();
        if !token.is_empty() && !unique.contains(&token) {
            unique.push(token);
        }
    }
    let id = p.get(c"id")?;
    if id.truthy()? {
        let token = string(id)?
            .coerce_string()?
            .truncate_units(8)
            .to_lowercase();
        if !unique.contains(&token) {
            unique.push(token);
        }
    }
    let out = array(p)?;
    for (i, token) in unique.into_iter().take(32).enumerate() {
        out.set_element(i as u32, js(p, token)?)?;
    }
    Ok(out)
}
fn refresh<'a>(s: L<'a>, id: L<'a>) -> Result<()> {
    let record = call(s.get(c"persistedSessions")?, c"get", &[id])?;
    if !record.truthy()?
        || record.get(c"type")?.is_string("aux")?
        || record.get(c"type")?.is_string("gateway")?
    {
        return Ok(());
    }
    let previous = obj(s, call(s.get(c"memory")?, c"get", &[id])?)?;
    let chats = s.get(c"chatSessions")?;
    let chat = if chats.truthy()? {
        call(chats, c"get", &[id])?
    } else {
        undef(s)?
    };
    let kind = keep(record.get(c"kind")?, text(s, "terminal")?)?;
    let status = keep(
        previous.get(c"status")?,
        text(
            s,
            if chat.optional(c"isStreaming")?.truthy()? {
                "thinking"
            } else {
                "idle"
            },
        )?,
    )?;
    let value = fields(
        s,
        &[
            ("id", id),
            ("label", title(record)?),
            ("cli", keep(record.get(c"cli")?, text(s, "claude")?)?),
            ("kind", kind),
            ("cwd", cwd(record)?),
            ("active", flag(s, chat.truthy()?)?),
            ("routable", flag(s, kind.is_string("chat")?)?),
            ("status", status),
            ("aliases", aliases(record, previous)?),
            (
                "lastInput",
                keep(previous.get(c"lastInput")?, text(s, "")?)?,
            ),
            (
                "lastOutput",
                keep(previous.get(c"lastOutput")?, text(s, "")?)?,
            ),
            (
                "lastRouteReason",
                keep(previous.get(c"lastRouteReason")?, text(s, "")?)?,
            ),
            ("updatedAt", clock(s)?),
        ],
    )?;
    call(s.get(c"memory")?, c"set", &[id, value])?;
    Ok(())
}
pub(super) fn routable(s: L<'_>) -> Result<Vec<L<'_>>> {
    let records = s.get(c"persistedSessions")?;
    if records.truthy()? {
        records.for_each(|pair| refresh(s, pair.element(0)?))?;
    }
    let mut snapshot = Vec::new();
    call(s.get(c"memory")?, c"values", &[])?.for_each(|v| {
        snapshot.push((v.get(c"updatedAt")?.number()?, v));
        Ok(())
    })?;
    // Stable sorting preserves Map insertion order for equal timestamps.
    snapshot.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut out = Vec::new();
    for (_, v) in snapshot.into_iter().take(30) {
        if v.get(c"routable")?.truthy()? {
            out.push(v);
        }
    }
    Ok(out)
}
pub(super) fn sessions(s: L<'_>) -> Result<JsString> {
    let visible = routable(s)?;
    if visible.is_empty() {
        return Ok(JsString::from_rust_str("没有可见的 chat session"));
    }
    let mut out = JsString::from_rust_str("📂 Gateway 可见 chat session:");
    for item in visible {
        let id = item.get(c"id")?;
        let label = item.get(c"label")?;
        out.push_str("\n  ");
        out.push(&string(id)?.coerce_string()?);
        if label.truthy()? && !label.equals(id)? {
            out.push_str(" / ");
            out.push(&string(label)?.coerce_string()?);
        }
        out.push_str(" — ");
        out.push(&string(item.get(c"status")?)?.coerce_string()?);
    }
    Ok(out)
}
