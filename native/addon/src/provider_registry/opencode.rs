//! OpenCode owns these providers and their credentials. MultiCC projects them
//! into the auto-provider catalog without looking up an account or model list.
use crate::js_live::LiveValue as L;
use multicc_core::{
    js::{JsString, JsValue as V},
    provider_registry::{
        native_opencode_id, NATIVE_OPENCODE_ID_PATTERN, NATIVE_OPENCODE_PREFIX, OPENCODE_CLI,
        OPENCODE_NAMES,
    },
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn open_code_catalog_spec(env: Env) -> Result<sys::napi_value> {
    let names = V::object(
        OPENCODE_NAMES
            .map(|(id, name)| (id, V::string(name)))
            .to_vec(),
    );
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
    Ok(entry(id, models, L::new(&env, names), L::new(&env, ports))?.raw())
}
fn entry<'a>(id: L<'a>, models: L<'a>, names: L<'a>, ports: L<'a>) -> Result<L<'a>> {
    let global = id.global()?;
    let set = global.get(c"Set")?;
    let filtered = ports.get(c"mapModels")?.call_plain(&[models])?;
    let unique = set.construct(&[filtered])?;
    let options = ports.get(c"spread")?.call_plain(&[unique])?;
    let prefix = id.from_value(&V::string(NATIVE_OPENCODE_PREFIX))?;
    let key = ports.get(c"add")?.call_plain(&[prefix, id])?;
    make_entry(id, names, key, options)
}
fn make_entry<'a>(id: L<'a>, names: L<'a>, key: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let entry = id.from_value(&V::Object(vec![]))?;
    entry.set(c"id", key)?;
    entry.set(c"appType", id.from_value(&V::string(OPENCODE_CLI))?)?;
    entry.set(c"name", name(id, names)?)?;
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
    entry.freeze()
}

#[napi]
pub fn open_code_catalog_api(env: Env, anchor: Unknown<'_>) -> Result<sys::napi_value> {
    use crate::{
        host_methods::{call, method},
        js_live::fields,
        route_response::{string, text},
    };
    let anchor = L::new(&env, anchor);
    let names = anchor.from_value(&V::object(
        OPENCODE_NAMES.map(|(id, n)| (id, V::string(n))).to_vec(),
    ))?;
    let clean = method(&env, anchor, "", 1, 1, |s, a| {
        let v = if a[0].nullish()? { text(s, "")? } else { a[0] };
        call(string(v)?, c"trim", &[])
    })?;
    let state = fields(anchor, &[("names", names), ("clean", clean)])?;
    Ok(fields(
        state,
        &[
            (
                "NATIVE_OPENCODE_ID",
                anchor.global()?.get(c"RegExp")?.construct(&[
                    text(anchor, NATIVE_OPENCODE_ID_PATTERN)?,
                    text(anchor, "i")?,
                ])?,
            ),
            (
                "NATIVE_OPENCODE_PREFIX",
                text(anchor, NATIVE_OPENCODE_PREFIX)?,
            ),
            (
                "nativeOpenCodeId",
                method(&env, state, "nativeOpenCodeId", 1, 1, |s, a| {
                    let value = if a[0].nullish()? {
                        text(s, "")?
                    } else {
                        string(a[0])?
                    };
                    s.from_value(
                        &native_opencode_id(&value.coerce_string()?).map_or(V::Null, V::String),
                    )
                })?,
            ),
            (
                "nativeOpenCodeName",
                method(&env, state, "nativeOpenCodeName", 1, 1, |s, a| {
                    name(a[0], s.get(c"names")?)
                })?,
            ),
            (
                "syntheticNativeOpenCodeProvider",
                method(
                    &env,
                    state,
                    "syntheticNativeOpenCodeProvider",
                    1,
                    2,
                    |s, a| {
                        let models = if a[1].undefined()? {
                            s.from_value(&V::Array(vec![]))?
                        } else {
                            a[1]
                        };
                        let models = if models.is_array()? {
                            models
                        } else {
                            s.from_value(&V::Array(vec![]))?
                        };
                        let mapped = call(models, c"map", &[s.get(c"clean")?])?;
                        let filtered = call(mapped, c"filter", &[s.global()?.get(c"Boolean")?])?;
                        let unique = s.global()?.get(c"Set")?.construct(&[filtered])?;
                        let options = s.from_value(&V::Array(vec![]))?;
                        let mut index = 0;
                        unique.for_each(|item| {
                            options.set_element(index, item)?;
                            index += 1;
                            Ok(())
                        })?;
                        let mut key = JsString::from(NATIVE_OPENCODE_PREFIX);
                        key.push(
                            &crate::message_composer::default_primitive(a[0])?.coerce_string()?,
                        );
                        make_entry(
                            a[0],
                            s.get(c"names")?,
                            s.from_value(&V::String(key))?,
                            options,
                        )
                    },
                )?,
            ),
        ],
    )?
    .raw())
}
