//! Directory table facade. The host supplies the live Map, the filesystem
//! resolver, and the existing save/log port; lookup retains row identity.
use crate::{
    host_methods::{call, method},
    js_iteration::read,
    js_live::{fields, LiveValue as L},
};
use multicc_core::js::JsValue as V;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub fn directory_repository(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let ports = L::new(&env, ports);
    if !ports.get(c"file")?.truthy()? {
        return Err(ports.type_error("[directory] repository needs a file path"));
    }
    let map = ports.get(c"map")?;
    if !map.instance_of(map.global()?.get(c"Map")?)? {
        return Err(ports.type_error("[directory] repository needs the directory table"));
    }
    let owner = ports.get(c"owner")?;
    if !owner.truthy()? || read(owner, c"saveDirectories")?.kind()? != sys::ValueType::napi_function
    {
        return Err(ports.type_error("[directory] repository needs the native state owner"));
    }
    let get = method(&env, map, "get", 1, 1, |map, a| call(map, c"get", a))?;
    let list = method(&env, map, "list", 0, 0, |map, _| {
        let rows = map.from_value(&V::Array(vec![]))?;
        let mut index = 0;
        call(map, c"values", &[])?.for_each(|row| {
            rows.set_element(index, row)?;
            index += 1;
            Ok(())
        })?;
        Ok(rows)
    })?;
    let add = method(&env, map, "add", 1, 1, |map, a| {
        let row = a[0];
        read(map, c"set")?.call(map, &[read(row, c"id")?, row])?;
        Ok(row)
    })?;
    let remove = method(&env, map, "remove", 1, 1, |map, a| call(map, c"delete", a))?;
    let find = method(&env, ports, "findByPath", 2, 2, |ports, a| {
        let resolve = ports.get(c"realPathOf")?;
        if resolve.kind()? != sys::ValueType::napi_function {
            return Err(ports.type_error("realPathOf is not a function"));
        }
        let target = resolve.call_plain(&[a[0]])?;
        let mut result = ports.from_value(&V::Null)?;
        call(ports.get(c"map")?, c"values", &[])?.for_each_while(|row| {
            if a[1].truthy()? && read(row, c"id")?.equals(a[1])? {
                return Ok(true);
            }
            if resolve.call_plain(&[read(row, c"path")?])?.equals(target)? {
                result = row;
                return Ok(false);
            }
            Ok(true)
        })?;
        Ok(result)
    })?;
    let persist = method(&env, owner, "save", 0, 0, |owner, _| {
        match call(owner, c"saveDirectories", &[]) {
            Ok(_) => owner.from_value(&V::Undefined),
            Err(error) => {
                let reason = match owner.exception_value()? {
                    Some(cause) => cause,
                    None => owner
                        .global()?
                        .get(c"Error")?
                        .construct(&[owner.from_value(&error.reason.into())?])?,
                };
                call(
                    owner.global()?.get(c"console")?,
                    c"error",
                    &[
                        owner.from_value(&"[multicc] Failed to save directories.json:".into())?,
                        read(reason, c"message")?,
                    ],
                )?;
                Err(reason.throw_error())
            }
        }
    })?;
    let table = method(&env, map, "mapRef", 0, 0, |map, _| Ok(map))?;
    Ok(fields(
        map,
        &[
            ("get", get),
            ("list", list),
            ("add", add),
            ("remove", remove),
            ("findByPath", find),
            ("save", persist),
            ("map", table),
        ],
    )?
    .raw())
}
