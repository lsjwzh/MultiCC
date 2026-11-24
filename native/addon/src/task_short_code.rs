//! Keep the original candidate as the Map key. Coercing it for validation
//! does not give the resulting string ownership of its display code.
use crate::js_live::LiveValue as L;
use multicc_core::{
    js::{JsString, JsValue as J},
    task_short_code::{candidate, valid, MAX_ATTEMPTS},
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

fn failure<T>(anchor: L<'_>, detail: JsString) -> Result<T> {
    let mut message = JsString::from_rust_str("[task-short-code] ");
    message.push(&detail);
    let error = anchor
        .global()?
        .get(c"Error")?
        .construct(&[anchor.from_value(&J::String(message))?])?;
    Err(error.throw_error())
}

struct Indexes<'a> {
    ids: L<'a>,
    owners: L<'a>,
}

impl<'a> Indexes<'a> {
    fn occupied(&self, code: L<'a>) -> Result<bool> {
        self.owners
            .get(c"has")?
            .call(self.owners, &[code])?
            .truthy()
    }

    fn insert(&self, id: L<'a>, code: L<'a>) -> Result<()> {
        self.ids.get(c"set")?.call(self.ids, &[id, code])?;
        self.owners.get(c"set")?.call(self.owners, &[code, id])?;
        Ok(())
    }
}

#[napi]
pub fn task_code_restore(
    env: Env,
    ids: Unknown<'_>,
    owners: Unknown<'_>,
    entries: Unknown<'_>,
    file: Unknown<'_>,
) -> Result<()> {
    let entries = L::new(&env, entries);
    if entries.kind()? != sys::ValueType::napi_object || entries.is_array()? {
        let mut detail = JsString::from_rust_str("registry payload in ");
        detail.push(&L::new(&env, file).coerce_string()?);
        detail.push_str(" has no byTaskId object");
        return failure(entries, detail);
    }
    let indexes = Indexes {
        ids: L::new(&env, ids),
        owners: L::new(&env, owners),
    };
    let object = entries.global()?.get(c"Object")?;
    let rows = object.get(c"entries")?.call(object, &[entries])?;
    rows.for_each(|row| {
        let id = row.element(0)?;
        let code = row.element(1)?;
        if id.truthy()? && valid(&code.coerce_string()?) && !indexes.occupied(code)? {
            indexes.insert(id, code)?;
        }
        Ok(())
    })
}

#[napi]
pub fn task_code_mint(
    env: Env,
    ids: Unknown<'_>,
    owners: Unknown<'_>,
    custom: Unknown<'_>,
    save: Unknown<'_>,
    id: Unknown<'_>,
) -> Result<sys::napi_value> {
    let id = L::new(&env, id).clean_text()?;
    if !id.truthy()? {
        return Ok(id.raw());
    }
    let indexes = Indexes {
        ids: L::new(&env, ids),
        owners: L::new(&env, owners),
    };
    let cached = indexes.ids.get(c"get")?.call(indexes.ids, &[id])?;
    if cached.truthy()? {
        return Ok(cached.raw());
    }
    let custom = L::new(&env, custom);
    let save = L::new(&env, save);
    let default_id = if custom.undefined()? {
        Some(id.coerce_string()?.to_string_lossy())
    } else if custom.kind()? == sys::ValueType::napi_function {
        None
    } else {
        return Err(custom.type_error("candidate is not a function"));
    };
    for salt in 0..MAX_ATTEMPTS {
        let code = if let Some(text) = &default_id {
            id.from_value(&J::string(&candidate(text, salt)))?
        } else {
            let code = custom.call_plain(&[id, id.from_value(&J::Number(salt.into()))?])?;
            if !valid(&code.coerce_string()?) {
                let mut detail = JsString::from_rust_str("candidate fn returned invalid code \"");
                detail.push(&code.coerce_string()?);
                detail.push_str(&format!("\" (salt {salt})"));
                return failure(id, detail);
            }
            code
        };
        if !indexes.occupied(code)? {
            indexes.insert(id, code)?;
            // The legacy registry makes the mint visible even when save throws.
            if !save.undefined()? {
                save.call_plain(&[])?;
            }
            return Ok(code.raw());
        }
    }
    let size = indexes.owners.get(c"size")?.number()?;
    failure(
        id,
        JsString::from_rust_str(&format!(
            "exhausted {MAX_ATTEMPTS} mint attempts ({size} codes registered)"
        )),
    )
}

#[napi]
pub fn task_code_lookup(
    env: Env,
    input: Unknown<'_>,
    registry: Unknown<'_>,
) -> Result<sys::napi_value> {
    let text = L::new(&env, input).clean_text()?;
    let code = text.get(c"toUpperCase")?.call(text, &[])?;
    if !valid(&code.coerce_string()?) {
        return Ok(text.from_value(&J::Null)?.raw());
    }
    let registry = L::new(&env, registry).call_plain(&[])?;
    Ok(registry.get(c"ownerOf")?.call(registry, &[code])?.raw())
}

#[napi]
pub fn task_code_label(
    env: Env,
    id: Unknown<'_>,
    text: Unknown<'_>,
    mint: Unknown<'_>,
) -> Result<sys::napi_value> {
    let body = L::new(&env, text).clean_text()?;
    let code = L::new(&env, mint).call_plain(&[L::new(&env, id)])?;
    if !code.truthy()? {
        return Ok(body.raw());
    }
    let mut label = JsString::from_rust_str("#");
    label.push(&code.coerce_string()?);
    if body.truthy()? {
        label.push_str(" · ");
        label.push(&body.coerce_string()?);
    }
    Ok(body.from_value(&J::String(label))?.raw())
}
