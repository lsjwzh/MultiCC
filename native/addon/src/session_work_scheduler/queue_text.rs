use super::*;
use multicc_core::js::JsString;
use multicc_core::orchestration_store::queue_preview::{
    default_wait_prefix, WaitPreview, LIMIT, WAIT_TYPES,
};

fn head(value: L<'_>, length: usize) -> Result<L<'_>> {
    call(
        value,
        c"slice",
        &[num(value, 0.)?, num(value, length as f64)?],
    )
}

fn units(value: L<'_>, length: usize) -> Result<JsString> {
    head(value, length)?.coerce_string()
}

// Wait results have already passed durable JSON normalization. Read strings
// and container members lazily, including arrays behind SQLite draft proxies.
fn append(out: &mut WaitPreview, value: L<'_>, quoted: bool) -> Result<()> {
    if out.remaining() == 0 {
        return Ok(());
    }
    if value.kind()? == sys::ValueType::napi_string {
        out.string(&units(value, out.remaining() + 1)?, quoted);
    } else if value.is_array()? {
        out.literal("[");
        let len = value.get(c"length")?.number()? as u32;
        for i in 0..len {
            if out.remaining() == 0 {
                break;
            }
            if i > 0 {
                out.literal(",");
            }
            append(out, value.element(i)?, true)?;
        }
        out.literal("]");
    } else if value.kind()? == sys::ValueType::napi_object && !value.nullish()? {
        out.literal("{");
        let keys = call(value.global()?.get(c"Object")?, c"keys", &[value])?;
        let len = keys.get(c"length")?.number()? as u32;
        for i in 0..len {
            if out.remaining() == 0 {
                break;
            }
            if i > 0 {
                out.literal(",");
            }
            let key = keys.element(i)?;
            out.string(&units(key, out.remaining() + 1)?, true);
            out.literal(":");
            if out.remaining() > 0 {
                append(out, value.get_key(key)?, true)?;
            }
        }
        out.literal("}");
    } else {
        out.string(&string(json(value, c"stringify")?)?.coerce_string()?, false);
    }
    Ok(())
}

pub(super) fn bounded_text(payload: L<'_>) -> Result<L<'_>> {
    for key in [c"message", c"taskText", c"deliveryText"] {
        let value = payload.optional(key)?;
        if value.truthy()? {
            return head(string(value)?, LIMIT);
        }
    }
    if !has(payload.optional(c"type")?, &WAIT_TYPES)? {
        return text(payload, "");
    }
    let prefix = payload.get(c"injectPrefix")?;
    let prefix = if prefix.kind()? == sys::ValueType::napi_string && prefix.truthy()? {
        units(prefix, LIMIT)?
    } else {
        default_wait_prefix(payload.get(c"mode")?.string()?.as_ref()).into()
    };
    let mut out = WaitPreview::new(&prefix);
    if out.remaining() > 0 {
        append(&mut out, payload.get(c"data")?, false)?;
    }
    payload.from_value(&out.finish_wait())
}
