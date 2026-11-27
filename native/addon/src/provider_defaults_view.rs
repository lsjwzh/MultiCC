//! Retain one owner per resolved defaults path. Proxy symbol properties
//! remain local JavaScript properties, while string keys use durable storage.
use crate::{host_methods::function, route_response::*};
use napi_derive::napi;
fn view(owner: L<'_>) -> Result<L<'_>> {
    let target = fields(owner, &[])?;
    let traps = fields(owner, &[])?;
    for (name, count) in [
        ("get", 3),
        ("set", 4),
        ("deleteProperty", 2),
        ("getOwnPropertyDescriptor", 2),
    ] {
        let trap = function(owner, name, count, count, move |o, a| {
            let key = a[1];
            if key.kind()? == sys::ValueType::napi_string {
                match name {
                    "set" => {
                        call(o, c"set", &[key, a[2]])?;
                        return flag(o, true);
                    }
                    "deleteProperty" => {
                        call(o, c"delete", &[key])?;
                        return flag(o, true);
                    }
                    _ => {
                        let snapshot = call(o, c"snapshot", &[])?;
                        if call(o.global()?.get(c"Object")?, c"hasOwn", &[snapshot, key])?
                            .truthy()?
                        {
                            return if name == "get" {
                                call(o, c"get", &[key])
                            } else {
                                let yes = flag(o, true)?;
                                fields(
                                    o,
                                    &[
                                        ("value", snapshot.get_key(key)?),
                                        ("writable", yes),
                                        ("enumerable", yes),
                                        ("configurable", yes),
                                    ],
                                )
                            };
                        }
                    }
                }
            }
            let reflect = o.global()?.get(c"Reflect")?;
            reflect.get_key(text(o, name)?)?.call(reflect, a)
        })?;
        traps.set_key(text(owner, name)?, trap)?;
    }
    traps.set(
        c"ownKeys",
        function(owner, "ownKeys", 1, 1, |o, a| {
            let reflect = o.global()?.get(c"Reflect")?;
            let keys = call(reflect, c"ownKeys", &[call(o, c"snapshot", &[])?])?;
            call(keys, c"concat", &[call(reflect, c"ownKeys", a)?])
        })?,
    )?;
    owner.global()?.get(c"Proxy")?.construct(&[target, traps])
}
#[napi]
pub fn provider_defaults_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    p.set(c"owners", p.global()?.get(c"Map")?.construct(&[])?)?;
    Ok(fields(
        p,
        &[
            (
                "getProviderDefaultsOwner",
                function(p, "getProviderDefaultsOwner", 1, 1, |p, a| {
                    let key = call(p.get(c"path")?, c"resolve", a)?;
                    let owners = p.get(c"owners")?;
                    if !call(owners, c"has", &[key])?.truthy()? {
                        let owner = p.get(c"Owner")?.construct(&[key])?;
                        call(owners, c"set", &[key, owner])?;
                    }
                    call(owners, c"get", &[key])
                })?,
            ),
            (
                "providerDefaultsView",
                function(p, "providerDefaultsView", 1, 1, |_, a| view(a[0]))?,
            ),
        ],
    )?
    .raw())
}
