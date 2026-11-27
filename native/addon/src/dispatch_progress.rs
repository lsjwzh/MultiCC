use crate::{host_methods::function, route_response::*};
use multicc_core::js::JsString as S;
use napi_derive::napi;
fn clean(v: L<'_>) -> Result<S> {
    Ok(v.string()?.unwrap_or_default().truncate_units(4000))
}
fn part(v: L<'_>, reason: bool) -> Result<S> {
    if v.kind()? != sys::ValueType::napi_object {
        return Ok(S::new());
    }
    let kind = string(fallback(v.get(c"type")?, "".into())?)?.coerce_string()?;
    let field = match (kind.as_str_lossy().as_ref(), reason) {
        ("text" | "text_delta", false) | ("reasoning", true) => c"text",
        ("thinking_delta", true) => c"thinking",
        ("response.output_text.delta" | "output_text_delta", false)
        | ("response.reasoning_summary_text.delta" | "response.reasoning_text.delta", true) => {
            c"delta"
        }
        ("content_block_delta", _) => {
            let inner = v.get(c"delta")?;
            if !inner.optional(c"type")?.is_string(if reason {
                "thinking_delta"
            } else {
                "text_delta"
            })? {
                return Ok(S::new());
            }
            return clean(
                v.get(c"delta")?
                    .get(if reason { c"thinking" } else { c"text" })?,
            );
        }
        _ => return Ok(S::new()),
    };
    clean(v.get(field)?)
}
#[napi]
pub fn dispatch_part(env: Env, delta: Unknown<'_>, reason: bool) -> Result<sys::napi_value> {
    let v = L::new(&env, delta);
    Ok(v.from_value(&V::String(part(v, reason)?))?.raw())
}
fn emit(p: L<'_>, kind: &str, message: &S) -> Result<()> {
    let message = message.truncate_units(4000);
    if message.is_empty() {
        return Ok(());
    }
    let key = p.from_value(&V::String(S::concat(&[
        &kind.into(),
        &"\0".into(),
        &message,
    ])))?;
    let seen = p.get(c"seen")?;
    if call(seen, c"has", &[key])?.truthy()? {
        return Ok(());
    }
    if seen.get(c"size")?.number()? >= 128. {
        let oldest = call(call(seen, c"values", &[])?, c"next", &[])?.get(c"value")?;
        call(seen, c"delete", &[oldest])?;
    }
    call(seen, c"add", &[key])?;
    p.catch(|| {
        p.get(c"notify")?.call_plain(&[fields(
            p,
            &[
                ("kind", text(p, kind)?),
                ("message", p.from_value(&V::String(message))?),
            ],
        )?])
    })?;
    Ok(())
}
fn reasoning(p: L<'_>, value: S, snapshot: bool) -> Result<()> {
    let value = value.truncate_units(4000);
    if value.is_empty() {
        return Ok(());
    }
    let s = p.from_value(&V::String(value.clone()))?;
    if snapshot && call(p.get(c"memory")?, c"includes", &[s])?.truthy()? {
        return Ok(());
    }
    emit(p, "reasoning", &value)?;
    let joined = S::concat(&[&p.get(c"memory")?.coerce_string()?, &value]);
    p.set(
        c"memory",
        p.from_value(&V::String(
            joined.slice_units(joined.len().saturating_sub(16000), joined.len()),
        ))?,
    )
}
fn blocks<'a>(p: L<'a>, e: L<'a>, kind: &'static str) -> Result<L<'a>> {
    let content = e.get(c"message")?.get(c"content")?;
    let filter = function(p, "", 1, 1, move |p, a| {
        let v = a[0];
        flag(
            p,
            v.optional(c"type")?.is_string(kind)?
                && (kind != "tool_use"
                    || (v.get(c"name")?.kind()? == sys::ValueType::napi_string
                        && !v.get(c"name")?.is_string("Thinking")?)),
        )
    })?;
    let map = function(p, "", 1, 1, move |p, a| {
        if kind == "tool_use" {
            return call(a[0].get(c"name")?, c"slice", &[num(p, 0.)?, num(p, 120.)?]);
        }
        p.from_value(&V::String(clean(a[0].get(if kind == "text" {
            c"text"
        } else {
            c"thinking"
        })?)?))
    })?;
    call(call(content, c"filter", &[filter])?, c"map", &[map])
}
fn push(p: L<'_>, e: L<'_>) -> Result<()> {
    if e.kind()? != sys::ValueType::napi_object {
        return Ok(());
    }
    let part_value = if e.get(c"type")?.is_string("part_delta")? {
        if p.get(c"cli")?.is_string("claude")? {
            return Ok(());
        }
        Some(e.get(c"delta")?)
    } else if e.get(c"type")?.is_string("stream_event")? {
        Some(e.get(c"event")?)
    } else {
        None
    };
    if let Some(v) = part_value {
        let r = part(v, true)?;
        return if !r.is_empty() {
            reasoning(p, r, false)
        } else {
            emit(p, "text", &part(v, false)?)
        };
    }
    if e.get(c"type")?.is_string("reasoning")? || e.get(c"type")?.is_string("thinking")? {
        let v = e.get(c"text")?;
        let snapshot = !e.get(c"snapshot")?.is_false()?;
        return reasoning(p, clean(v)?, snapshot);
    }
    if e.get(c"type")?.is_string("assistant")?
        && e.get(c"message")?.optional(c"content")?.is_array()?
    {
        let value = call(blocks(p, e, "text")?, c"join", &[text(p, "")?])?.coerce_string()?;
        let is_snapshot = e.get(c"message")?.get(c"textSnapshot")?.is_true()?;
        let old = p.get(c"snapshot")?.coerce_string()?;
        if is_snapshot {
            let delta = if value.as_units().starts_with(old.as_units()) {
                value.slice_units(old.len(), value.len())
            } else {
                value.clone()
            };
            p.set(c"snapshot", p.from_value(&V::String(value))?)?;
            emit(p, "text", &delta)?;
        } else {
            p.set(
                c"snapshot",
                p.from_value(&V::String(S::concat(&[&old, &value])))?,
            )?;
            emit(p, "text", &value)?;
        }
        reasoning(
            p,
            call(blocks(p, e, "thinking")?, c"join", &[text(p, "")?])?.coerce_string()?,
            true,
        )?;
        return blocks(p, e, "tool_use")?.for_each(|name| {
            emit(
                p,
                "tool",
                &S::concat(&[&"正在执行：".into(), &name.coerce_string()?]),
            )
        });
    }
    if e.get(c"type")?.is_string("progress_heartbeat")? {
        let phase = string(fallback(e.get(c"phase")?, "".into())?)?
            .coerce_string()?
            .trim();
        let tool = string(fallback(e.get(c"safeToolKind")?, "".into())?)?
            .coerce_string()?
            .trim();
        let msg = if tool.is_empty() {
            phase
        } else {
            S::concat(&[
                &if phase.is_empty() {
                    "working".into()
                } else {
                    phase
                },
                &" · ".into(),
                &tool,
            ])
        };
        return emit(p, "status", &msg);
    }
    if e.get(c"type")?.is_string("error")? {
        let v = e.get(c"error")?;
        let v = if v.truthy()? {
            v
        } else {
            fallback(e.get(c"message")?, "worker error".into())?
        };
        emit(p, "error", &clean(v)?)?;
    }
    Ok(())
}
#[napi]
pub fn dispatch_reducer(
    env: Env,
    notify: Unknown<'_>,
    options: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, notify);
    let options = L::new(&env, options);
    if p.kind()? != sys::ValueType::napi_function {
        return Err(p.type_error("dispatch progress callback is required"));
    }
    let cli = if crate::js_iteration::read(options, c"cli")?.kind()? == sys::ValueType::napi_string
    {
        crate::js_iteration::read(options, c"cli")?
    } else {
        text(p, "")?
    };
    let owner = fields(
        p,
        &[
            ("notify", p),
            ("cli", cli),
            ("snapshot", text(p, "")?),
            ("memory", text(p, "")?),
            ("seen", p.global()?.get(c"Set")?.construct(&[])?),
        ],
    )?;
    Ok(fields(
        p,
        &[(
            "push",
            function(owner, "push", 1, 1, |p, a| {
                push(p, a[0])?;
                p.from_value(&V::Undefined)
            })?,
        )],
    )?
    .freeze()?
    .raw())
}
