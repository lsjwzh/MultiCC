use super::*;

#[derive(Clone, Copy, PartialEq)]
enum Level {
    Root,
    Collection,
    Value,
}
fn active(v: L<'_>) -> Result<()> {
    if !v.get(c"active")?.truthy()? {
        return Err(v.type_error("orchestration snapshot is no longer active"));
    }
    Ok(())
}
fn read<'a>(v: L<'a>, op: &str, input: L<'a>) -> Result<L<'a>> {
    let s = v.get(c"s")?;
    if v.get(c"detached")?.truthy()? {
        request(
            s,
            "readTrackedDraft",
            fields(
                s,
                &[
                    ("token", v.get(c"token")?),
                    ("operation", text(s, op)?),
                    ("input", input),
                ],
            )?,
        )
    } else {
        request(s, op, input)
    }
}
fn collections(v: L<'_>) -> Result<L<'_>> {
    v.get(c"s")?.get(c"deps")?.get(c"COLLECTIONS")
}
fn query<'a>(
    v: L<'a>,
    op: &str,
    collection: L<'a>,
    options: L<'a>,
    overrides: L<'a>,
) -> Result<L<'a>> {
    if !call(collections(v)?, c"includes", &[collection])?.truthy()? {
        return Err(v.type_error(&format!(
            "unknown orchestration collection {}",
            string_value(collection)?
        )));
    }
    read(
        v,
        op,
        fields(
            v,
            &[
                ("collection", collection),
                ("options", default_object(options)?),
                (
                    "overrides",
                    if overrides.undefined()? {
                        array(v, &[])?
                    } else {
                        overrides
                    },
                ),
            ],
        )?,
    )
}
fn materialize<'a>(v: L<'a>, collection: L<'a>, id: L<'a>) -> Result<L<'a>> {
    active(v)?;
    let r = read(
        v,
        "materialize",
        fields(v, &[("collection", collection), ("key", id)])?,
    )?;
    if r.get(c"found")?.truthy()? {
        r.get(c"value")
    } else {
        undefined(v)
    }
}
fn inspect<'a>(v: L<'a>, coll: L<'a>, id: L<'a>, path: L<'a>) -> Result<L<'a>> {
    active(v)?;
    let rows = v.get(c"rows")?;
    if coll.is_string("outbox")? && call(rows, c"has", &[id])?.truthy()? {
        let n = path.get(c"length")?.number()?;
        if n == 0. {
            return fields(v, &[("kind", text(v, "object")?)]);
        }
        if n == 1. {
            let k = path.element(0)?;
            if [
                "id",
                "sessionId",
                "state",
                "sequence",
                "availableAt",
                "leasedUntil",
                "attempts",
            ]
            .iter()
            .any(|x| k.is_string(x).unwrap_or(false))
            {
                let row = call(rows, c"get", &[id])?;
                if !own(row, k)? {
                    return fields(v, &[("kind", text(v, "missing")?)]);
                }
                let val = row.get_key(k)?;
                if val.is_array()? {
                    return fields(
                        v,
                        &[("kind", text(v, "array")?), ("length", val.get(c"length")?)],
                    );
                }
                if val.kind()? == sys::ValueType::napi_object {
                    return fields(v, &[("kind", text(v, "object")?)]);
                }
                return fields(v, &[("kind", text(v, "value")?), ("value", val)]);
            }
        }
    }
    read(
        v,
        "inspect",
        fields(v, &[("collection", coll), ("key", id), ("path", path)])?,
    )
}
fn node<'a>(
    v: L<'a>,
    level: Level,
    coll: L<'a>,
    id: L<'a>,
    path: L<'a>,
    info: L<'a>,
) -> Result<L<'a>> {
    let cache = v.get(match level {
        Level::Value => c"paths",
        _ => c"collections",
    })?;
    let cache_key = if level == Level::Value {
        json(array(v, &[coll, id, path])?)?
    } else {
        coll
    };
    if level == Level::Value {
        let kind = info.get(c"kind")?;
        if kind.is_string("missing")? {
            return undefined(v);
        }
        if kind.is_string("value")? {
            return info.get(c"value");
        }
    }
    if level != Level::Root && call(cache, c"has", &[cache_key])?.truthy()? {
        return call(cache, c"get", &[cache_key]);
    }
    let is_array = level == Level::Value && info.get(c"kind")?.is_string("array")?;
    let target = if is_array {
        v.global()?
            .get(c"Array")?
            .construct(&[info.get(c"length")?])?
    } else {
        fields(v, &[])?
    };
    let f = fields(
        v,
        &[
            ("v", v),
            ("collection", coll),
            ("id", id),
            ("path", path),
            ("array", flag(v, is_array)?),
            ("target", target),
        ],
    )?;
    let traps = fields(v, &[])?;
    for (name, count) in [
        ("get", 3),
        ("has", 2),
        ("getOwnPropertyDescriptor", 2),
        ("ownKeys", 1),
        ("set", 3),
        ("deleteProperty", 2),
        ("defineProperty", 3),
    ] {
        set(
            traps,
            name,
            cb(f, count, move |f, a| trap(level, name, f, a))?,
        )?;
    }
    let proxy = v.global()?.get(c"Proxy")?.construct(&[target, traps])?;
    if level != Level::Root {
        call(cache, c"set", &[cache_key, proxy])?;
    }
    Ok(proxy)
}
fn child_path<'a>(f: L<'a>, prop: L<'a>) -> Result<L<'a>> {
    let path = call(f.get(c"path")?, c"slice", &[])?;
    let part = if f.get(c"array")?.truthy()? && prop.kind()? == sys::ValueType::napi_string {
        let name = string_value(prop)?;
        if name == "0"
            || (!name.starts_with('0')
                && !name.is_empty()
                && name.bytes().all(|b| b.is_ascii_digit()))
        {
            num(f, prop.explicit_number()?)?
        } else {
            prop
        }
    } else {
        prop
    };
    path.set_element(path.get(c"length")?.number()? as u32, part)?;
    Ok(path)
}
fn trap<'a>(level: Level, op: &str, f: L<'a>, a: &[L<'a>]) -> Result<L<'a>> {
    let v = f.get(c"v")?;
    active(v)?;
    if matches!(op, "set" | "deleteProperty" | "defineProperty") {
        return Err(v.type_error("orchestration read snapshot is immutable"));
    }
    let coll = f.get(c"collection")?;
    let id = f.get(c"id")?;
    let path = f.get(c"path")?;
    let arr = f.get(c"array")?.truthy()?;
    let target = a[0];
    let reflect = v.global()?.get(c"Reflect")?;
    if op == "ownKeys" {
        return match level {
            Level::Value => {
                let list = read(
                    v,
                    "keys",
                    fields(v, &[("collection", coll), ("key", id), ("path", path)])?,
                )?;
                if arr {
                    list.set_element(list.get(c"length")?.number()? as u32, text(v, "length")?)?;
                }
                Ok(list)
            }
            Level::Collection => read(v, "keys", fields(v, &[("collection", coll)])?),
            Level::Root => {
                let list = call(
                    keys(v.get(c"header")?)?,
                    c"concat",
                    &[
                        collections(v)?,
                        read(v, "keys", fields(v, &[("collection", text(v, "extras")?)])?)?,
                    ],
                )?;
                let unique = v.global()?.get(c"Set")?.construct(&[list])?;
                call(v.global()?.get(c"Array")?, c"from", &[unique])
            }
        };
    }
    let prop = a[1];
    let desc = op == "getOwnPropertyDescriptor";
    let has_op = op == "has";
    if level == Level::Value && arr && prop.is_string("length")? {
        if desc {
            return call(
                v.global()?.get(c"Object")?,
                c"getOwnPropertyDescriptor",
                &[target, prop],
            );
        }
        if has_op {
            return flag(v, true);
        }
        return target.get(c"length");
    }
    let mut found = None;
    if level == Level::Root {
        let methods = v.get(c"methods")?;
        let header = v.get(c"header")?;
        if op == "get" && own(methods, prop)? {
            return methods.get_key(prop);
        }
        if own(header, prop)? {
            if has_op {
                return flag(v, true);
            }
            if v.get(c"token")?.truthy()? && v.get(c"track")?.truthy()? {
                request(
                    v.get(c"s")?,
                    "draftTrackHeader",
                    fields(v, &[("token", v.get(c"token")?), ("field", prop)])?,
                )?;
            }
            found = Some(header.get_key(prop)?)
        } else if call(collections(v)?, c"includes", &[prop])?.truthy()? {
            if has_op {
                return flag(v, true);
            }
            found = Some(node(
                v,
                Level::Collection,
                prop,
                undefined(v)?,
                array(v, &[])?,
                undefined(v)?,
            )?)
        }
    }
    if has_op && level == Level::Value && call(reflect, c"has", &[target, prop])?.truthy()? {
        return flag(v, true);
    }
    if found.is_none() && prop.kind()? == sys::ValueType::napi_string {
        let (c, k, p) = match level {
            Level::Root => (text(v, "extras")?, prop, array(v, &[])?),
            Level::Collection => (coll, prop, array(v, &[])?),
            Level::Value => (coll, id, child_path(f, prop)?),
        };
        let i = inspect(v, c, k, p)?;
        if !i.get(c"kind")?.is_string("missing")? {
            if has_op {
                return flag(v, true);
            }
            found = Some(node(v, Level::Value, c, k, p, i)?)
        }
    }
    if has_op {
        return flag(v, found.is_some());
    }
    match found {
        Some(value) if desc => fields(
            v,
            &[
                ("configurable", flag(v, true)?),
                ("enumerable", flag(v, true)?),
                ("writable", flag(v, false)?),
                ("value", value),
            ],
        ),
        Some(value) => Ok(value),
        None if desc => undefined(v),
        None => call(reflect, c"get", &[target, prop, a[2]]),
    }
}
pub(super) fn create<'a>(s: L<'a>, header: L<'a>, claim: L<'a>, token: L<'a>) -> Result<L<'a>> {
    let map = || s.global()?.get(c"Map")?.construct(&[]);
    let v = frame(
        s,
        &[
            ("header", header),
            ("token", token),
            ("claim", claim),
            ("rows", map()?),
            ("paths", map()?),
            ("collections", map()?),
            ("active", flag(s, true)?),
            ("detached", flag(s, false)?),
            ("track", flag(s, true)?),
        ],
    )?;
    if claim.truthy()? {
        let vals = claim.get(c"rows")?;
        let ids = claim.get(c"keys")?;
        for i in 0..ids.get(c"length")?.number()? as u32 {
            let r = vals.element(i)?;
            if r.kind()? == sys::ValueType::napi_object && keys(r)?.get(c"length")?.truthy()? {
                call(v.get(c"rows")?, c"set", &[ids.element(i)?, r])?;
            }
        }
    }
    let methods = fields(s, &[])?;
    methods.set(
        c"select",
        cb(v, 2, |v, a| {
            active(v)?;
            query(v, "select", a[0], a[1], undefined(v)?)
        })?,
    )?;
    methods.set(
        c"count",
        cb(v, 2, |v, a| {
            active(v)?;
            query(
                v,
                "count",
                a[0],
                fields(v, &[("where", default_object(a[1])?)])?,
                undefined(v)?,
            )
        })?,
    )?;
    methods.set(
        c"claimSelect",
        cb(v, 1, |v, a| {
            active(v)?;
            let claim = v.get(c"claim")?;
            if !claim.truthy()? || !a[0].truthy()? {
                return null(v);
            }
            let out = array(v, &[])?;
            let ids = claim.get(c"leasedKeys")?;
            let rows = v.get(c"rows")?;
            for i in 0..ids.get(c"length")?.number()? as u32 {
                let id = ids.element(i)?;
                let r = call(rows, c"get", &[id])?;
                out.set_element(
                    i,
                    if r.truthy()? {
                        r
                    } else {
                        materialize(v, text(v, "outbox")?, id)?
                    },
                )?
            }
            Ok(out)
        })?,
    )?;
    v.set(c"methods", methods)?;
    v.set(
        c"root",
        node(
            v,
            Level::Root,
            undefined(s)?,
            undefined(s)?,
            array(s, &[])?,
            undefined(s)?,
        )?,
    )?;
    v.set(c"materialize", cb(v, 2, |v, a| materialize(v, a[0], a[1]))?)?;
    v.set(
        c"query",
        cb(v, 4, |v, a| {
            query(v, &string_value(a[0])?, a[1], a[2], a[3])
        })?,
    )?;
    Ok(v)
}
pub(super) fn detach(v: L<'_>) -> Result<()> {
    read(
        v,
        "detachDraftSnapshot",
        fields(v, &[("token", v.get(c"token")?)])?,
    )?;
    v.set(c"detached", flag(v, true)?)
}
pub(super) fn revoke(v: L<'_>) -> Result<()> {
    v.set(c"active", flag(v, false)?)?;
    call(v.get(c"paths")?, c"clear", &[])?;
    call(v.get(c"collections")?, c"clear", &[])?;
    Ok(())
}
