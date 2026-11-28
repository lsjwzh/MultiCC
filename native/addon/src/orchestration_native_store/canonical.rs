//! Conditions under which the worker may normalize an operation without observing V8 code.
use super::*;
const MEMBERS: &[(&str, bool, &str)] = &[
    ("Object", false, "keys"),
    ("Object", false, "getOwnPropertyDescriptors"),
    ("Object", false, "getOwnPropertyDescriptor"),
    ("Object", false, "getPrototypeOf"),
    ("Object", false, "hasOwn"),
    ("Number", false, "isFinite"),
    ("Array", false, "isArray"),
    ("Array", true, "map"),
    ("Array", true, "sort"),
    ("Array", true, "join"),
    ("JSON", false, "stringify"),
    ("JSON", false, "parse"),
    ("Set", true, "has"),
    ("Set", true, "add"),
    ("Set", true, "delete"),
    ("String", true, "toWellFormed"),
    ("String", true, "isWellFormed"),
    ("String", true, "replace"),
    ("String", true, "slice"),
    ("RegExp", true, "@@replace"),
    ("Array", true, "constructor"),
];
fn member<'a>(g: L<'a>, name: &str, prototype: bool, property: &str) -> Result<(L<'a>, L<'a>)> {
    let object = get(g, name)?;
    let object = if prototype {
        object.get(c"prototype")?
    } else {
        object
    };
    let key = if property == "@@replace" {
        g.get(c"Symbol")?.get(c"replace")?
    } else {
        text(g, property)?
    };
    Ok((object, key))
}
fn desc<'a>(saved: L<'a>, object: L<'a>, key: L<'a>) -> Result<L<'a>> {
    saved.get(c"descriptor")?.call_plain(&[object, key])
}
pub(in crate::orchestration_native_store) fn capture(ports: L<'_>) -> Result<()> {
    let g = ports.global()?;
    let saved = fields(
        g,
        &[
            (
                "descriptor",
                g.get(c"Object")?.get(c"getOwnPropertyDescriptor")?,
            ),
            ("dateNow", g.get(c"Date")?.get(c"now")?),
            ("set", g.get(c"Set")?),
            ("string", g.get(c"String")?),
        ],
    )?;
    let values = array(g, &[])?;
    for (i, (name, proto, k)) in MEMBERS.iter().enumerate() {
        let (o, key) = member(g, name, *proto, k)?;
        values.set_element(i as u32, o.get_key(key)?)?
    }
    let species = desc(saved, g.get(c"Array")?, g.get(c"Symbol")?.get(c"species")?)?;
    saved.set(c"species", species)?;
    saved.set(c"values", values)?;
    let buffer = ports.get(c"Buffer")?;
    let crypto = ports.get(c"crypto")?;
    for (k, o, name) in [
        (c"hash", crypto, "createHash"),
        (c"from", buffer, "from"),
        (c"encode", buffer.get(c"prototype")?, "toString"),
    ] {
        saved.set(k, desc(saved, o, text(g, name)?)?.optional(c"value")?)?;
    }
    ports.set(c"intrinsics", saved)
}
fn native_fn(s: L<'_>, v: L<'_>) -> Result<bool> {
    if !is_func(v)? || proxy(s, v)? {
        return Ok(false);
    }
    let text = call(
        s.global()?
            .get(c"Function")?
            .get(c"prototype")?
            .get(c"toString")?,
        c"call",
        &[v],
    )?;
    Ok(string_value(text)?.contains("[native code]"))
}
fn standard(s: L<'_>, saved: L<'_>) -> Result<bool> {
    let g = s.global()?;
    if !g.get(c"Set")?.equals(saved.get(c"set")?)?
        || !g.get(c"String")?.equals(saved.get(c"string")?)?
    {
        return Ok(false);
    }
    let species = desc(saved, g.get(c"Array")?, g.get(c"Symbol")?.get(c"species")?)?;
    let old = saved.get(c"species")?;
    if !species.optional(c"get")?.equals(old.optional(c"get")?)?
        || !species.optional(c"set")?.equals(old.optional(c"set")?)?
        || !native_fn(s, species.optional(c"get")?)?
    {
        return Ok(false);
    }
    let values = saved.get(c"values")?;
    for (i, (name, is_proto, k)) in MEMBERS.iter().enumerate() {
        let (o, key) = member(g, name, *is_proto, k)?;
        let expected = values.element(i as u32)?;
        if !desc(saved, o, key)?.optional(c"value")?.equals(expected)? || !native_fn(s, expected)? {
            return Ok(false);
        }
    }
    let obj_proto = prototype(s)?;
    for field in [
        "chatId",
        "targetId",
        "message",
        "taskId",
        "taskStart",
        "taskSource",
        "taskText",
        "taskShellReceiptId",
        "clientMsgId",
        "receivedAt",
        "toJSON",
        "kind",
        "ownerSessionId",
        "idempotencyKeyHash",
        "requestHash",
        "id",
        "requestOutboxId",
        "spec",
        "sessionId",
        "payloadHash",
    ] {
        if desc(saved, obj_proto, text(s, field)?)?.truthy()? {
            return Ok(false);
        }
    }
    Ok(!desc(
        saved,
        g.get(c"Array")?.get(c"prototype")?,
        text(s, "toJSON")?,
    )?
    .truthy()?)
}
fn plain<'a>(s: L<'a>, v: L<'a>, ancestors: &mut Vec<L<'a>>, count: &mut usize) -> Result<bool> {
    *count += 1;
    if *count > 1_000_000 || ancestors.len() > 64 {
        return Ok(false);
    }
    match v.kind()? {
        sys::ValueType::napi_null | sys::ValueType::napi_string | sys::ValueType::napi_boolean => {
            return Ok(true)
        }
        sys::ValueType::napi_number => return Ok(v.number()?.is_finite()),
        sys::ValueType::napi_object => {}
        _ => return Ok(false),
    }
    if proxy(s, v)? {
        return Ok(false);
    }
    for a in ancestors.iter() {
        if a.equals(v)? {
            return Ok(false);
        }
    }
    let arr = v.is_array()?;
    let obj = s.global()?.get(c"Object")?;
    let proto = call(obj, c"getPrototypeOf", &[v])?;
    if (arr && !proto.equals(s.global()?.get(c"Array")?.get(c"prototype")?)?)
        || (!arr && !proto.nullish()? && !proto.equals(prototype(s)?)?)
    {
        return Ok(false);
    }
    let descriptors = call(obj, c"getOwnPropertyDescriptors", &[v])?;
    if has(descriptors, "toJSON")? || (arr && has(descriptors, "map")?) {
        return Ok(false);
    }
    ancestors.push(v);
    let result = (|| {
        if arr {
            for i in 0..v.get(c"length")?.number()? as u32 {
                let d = descriptors.element(i)?;
                if !d.truthy()?
                    || !has(d, "value")?
                    || !plain(s, d.get(c"value")?, ancestors, count)?
                {
                    return Ok(false);
                }
            }
        } else {
            let ks = keys(descriptors)?;
            for i in 0..ks.get(c"length")?.number()? as u32 {
                let d = descriptors.get_key(ks.element(i)?)?;
                if d.get(c"enumerable")?.truthy()?
                    && (!has(d, "value")? || !plain(s, d.get(c"value")?, ancestors, count)?)
                {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    })();
    ancestors.pop();
    result
}
fn simple(v: L<'_>, well_formed: bool) -> Result<bool> {
    match v.kind()? {
        sys::ValueType::napi_null | sys::ValueType::napi_boolean | sys::ValueType::napi_symbol => {
            Ok(true)
        }
        sys::ValueType::napi_number => Ok(v.number()?.is_finite()),
        sys::ValueType::napi_string => Ok(!well_formed || call(v, c"isWellFormed", &[])?.truthy()?),
        _ => Ok(false),
    }
}
pub(super) fn eligible<'a>(s: L<'a>, p: L<'a>) -> Result<Option<L<'a>>> {
    let ports = s.get(c"ports")?;
    let saved = ports.get(c"intrinsics")?;
    let clock = p.get(c"now")?;
    let id = p.get(c"id")?;
    let simple_id = simple(id, false)?;
    let id_key = if simple_id {
        saved.get(c"string")?.call_plain(&[id])?
    } else {
        text(s, "")?
    };
    if !clock.equals(saved.get(c"dateNow")?)?
        || !s.get(c"now")?.equals(saved.get(c"dateNow")?)?
        || !clock.equals(s.global()?.get(c"Date")?.get(c"now")?)?
        || !native_fn(s, clock)?
        || p.get(c"customCrypto")?.truthy()?
        || !standard(s, saved)?
    {
        return Ok(None);
    }
    let buf = ports.get(c"Buffer")?;
    for (k, o, name) in [
        (c"hash", ports.get(c"crypto")?, "createHash"),
        (c"from", buf, "from"),
        (c"encode", buf.get(c"prototype")?, "toString"),
    ] {
        if !desc(saved, o, text(s, name)?)?
            .optional(c"value")?
            .equals(saved.get(k)?)?
        {
            return Ok(None);
        }
    }
    if objectish(p.get(c"idempotencyKey")?)?
        || !plain(s, p.get(c"spec")?, &mut Vec::new(), &mut 0)?
        || !simple_id
        || (p.get(c"kind")?.is_string("detached")? && id.kind()? != sys::ValueType::napi_string)
        || !call(id_key, c"isWellFormed", &[])?.truthy()?
        || !p.get(c"ownerSessionId")?.truthy()?
        || !simple(p.get(c"ownerSessionId")?, true)?
        || !simple(p.get(c"resultSessionId")?, true)?
    {
        return Ok(None);
    }
    Ok(Some(id_key))
}
