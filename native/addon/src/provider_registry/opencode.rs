//! OpenCode owns these providers and their credentials. MultiCC projects them
//! into the auto-provider catalog without looking up an account or model list.
use crate::js_live::LiveValue as L;
use multicc_core::{
    js::{JsString, JsValue as V},
    provider_registry::{native_opencode_id, NATIVE_OPENCODE_ID_PATTERN, NATIVE_OPENCODE_PREFIX},
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn open_code_catalog_spec(env: Env) -> Result<sys::napi_value> {
    let names = V::object(vec![
        ("opencode", V::string("OpenCode Zen")),
        ("opencodego", V::string("OpenCode Go")),
        ("opencode-go", V::string("OpenCode Go")),
    ]);
    let spec = V::object(vec![
        ("prefix", V::string(NATIVE_OPENCODE_PREFIX)),
        ("pattern", V::string(NATIVE_OPENCODE_ID_PATTERN)),
        ("names", names),
    ]);
    unsafe { crate::js_bridge::write_value(env.raw(), &spec) }
}

#[napi]
pub fn open_code_catalog_id(env: Env, text: Unknown<'_>) -> Result<sys::napi_value> {
    let text = L::new(&env, text);
    let id = native_opencode_id(&text.coerce_string()?).map_or(V::Null, V::String);
    Ok(text.from_value(&id)?.raw())
}

fn name<'a>(id: L<'a>, names: L<'a>) -> Result<L<'a>> {
    // Property-key conversion and template interpolation are distinct reads.
    // Ordinary objects also expose inherited names such as "constructor".
    let known = names.get_key(id)?;
    if known.truthy()? {
        return Ok(known);
    }
    let mut label = JsString::from("OpenCode · ");
    label.push(&id.coerce_string()?);
    id.from_value(&V::String(label))
}

#[napi]
pub fn open_code_catalog_name(
    env: Env,
    id: Unknown<'_>,
    names: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(name(L::new(&env, id), L::new(&env, names))?.raw())
}

#[napi]
pub fn open_code_catalog_entry(
    env: Env,
    id: Unknown<'_>,
    models: Unknown<'_>,
    names: Unknown<'_>,
    ports: Unknown<'_>,
) -> Result<sys::napi_value> {
    let id = L::new(&env, id);
    let models = L::new(&env, models);
    let ports = L::new(&env, ports);
    let global = id.global()?;
    let set = global.get(c"Set")?;
    let filtered = ports.get(c"mapModels")?.call_plain(&[models])?;
    let unique = set.construct(&[filtered])?;
    let options = ports.get(c"spread")?.call_plain(&[unique])?;
    let prefix = id.from_value(&V::string(NATIVE_OPENCODE_PREFIX))?;
    let key = ports.get(c"add")?.call_plain(&[prefix, id])?;
    let entry = id.from_value(&V::Object(vec![]))?;
    entry.set(c"id", key)?;
    entry.set(c"name", name(id, L::new(&env, names))?)?;
    entry.set(c"nativeOpenCode", id.from_value(&V::Bool(true))?)?;
    entry.set(c"nativeProvider", id)?;
    let first = options.element(0)?;
    entry.set(
        c"model",
        if first.truthy()? {
            first
        } else {
            id.from_value(&V::Null)?
        },
    )?;
    entry.set(c"modelOptions", options.freeze()?)?;
    Ok(entry.freeze()?.raw())
}
