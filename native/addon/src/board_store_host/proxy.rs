use super::*;

#[derive(Clone, Copy, PartialEq)]
enum Level {
    Root,
    Collection,
    Value,
}
fn is_kind(k: L<'_>) -> Result<bool> {
    for kind in KINDS {
        if k.is_string(kind)? {
            return Ok(true);
        }
    }
    Ok(false)
}
fn owner_key<'a>(kind: L<'a>, id: L<'a>) -> Result<L<'a>> {
    call(pair(kind, kind, id)?, c"join", &[text(kind, "\u{1}")?])
}
fn adopted<'a>(s: L<'a>, value: L<'a>, kind: L<'a>, id: L<'a>) -> Result<L<'a>> {
    if !object(value)? {
        return Ok(value);
    }
    let meta = call(s.get(c"metas")?, c"get", &[value])?;
    let same = meta.truthy()?
        && !meta.get(c"container")?.truthy()?
        && meta.get(c"kind")?.equals(kind)?
        && meta.get(c"id")?.equals(id)?;
    if !same {
        call(
            s.get(c"volatile")?,
            c"set",
            &[owner_key(kind, id)?, pair(s, kind, id)?],
        )?;
    }
    if meta.truthy()? {
        meta.get(c"target")
    } else {
        Ok(value)
    }
}
fn touch<'a>(s: L<'a>, kind: L<'a>, id: L<'a>) -> Result<()> {
    transaction::capture(s, kind, id)?;
    add(dirty(s, kind)?, id)
}
fn replace_kind<'a>(s: L<'a>, kind: L<'a>, val: L<'a>) -> Result<()> {
    transaction::capture(s, text(s, "root")?, kind)?;
    let meta = if object(val)? {
        call(s.get(c"metas")?, c"get", &[val])?
    } else {
        undef(s)?
    };
    s.get(c"raw")?.set_key(
        kind,
        if meta.truthy()? {
            meta.get(c"target")?
        } else {
            val
        },
    )?;
    add(s.get(c"replaced")?, kind)?;
    mark_order(s, kind)?;
    call(dirty(s, kind)?, c"clear", &[])?;
    Ok(())
}
fn get<'a>(level: Level, f: L<'a>, args: &[L<'a>]) -> Result<L<'a>> {
    let s = f.get(c"s")?;
    let t = args[0];
    let k = args[1];
    if level == Level::Root && is_kind(k)? {
        let target = t.get_key(k)?;
        if !object(target)? {
            return Ok(target);
        }
        let m = s.get(c"containers")?;
        let cached = call(m, c"get", &[k])?;
        if cached.truthy()? && cached.get(c"target")?.equals(target)? {
            return cached.get(c"proxy");
        }
        let proxy = make(s, Level::Collection, target, k, k)?;
        call(
            m,
            c"set",
            &[k, fields(s, &[("target", target), ("proxy", proxy)])?],
        )?;
        return Ok(proxy);
    }
    let value = call(s.global()?.get(c"Reflect")?, c"get", args)?;
    if k.kind()? != sys::ValueType::napi_string || !own(t, k)? || !object(value)? {
        return Ok(value);
    }
    let kind = if level == Level::Root {
        text(s, "root")?
    } else {
        f.get(c"kind")?
    };
    let id = if level == Level::Value {
        f.get(c"id")?
    } else {
        k
    };
    let meta = call(s.get(c"metas")?, c"get", &[value])?;
    let target = if meta.truthy()? {
        meta.get(c"target")?
    } else {
        value
    };
    let cache = s.get(c"cache")?;
    let mut map = call(cache, c"get", &[target])?;
    if !map.truthy()? {
        map = js(s, c"Map")?;
        call(cache, c"set", &[target, map])?;
    }
    let owner = owner_key(kind, id)?;
    let cached = call(map, c"get", &[owner])?;
    if cached.truthy()? {
        return Ok(cached);
    }
    let proxy = make(s, Level::Value, target, kind, id)?;
    call(map, c"set", &[owner, proxy])?;
    Ok(proxy)
}
fn write<'a>(level: Level, op: &CStr, f: L<'a>, a: &[L<'a>]) -> Result<L<'a>> {
    let s = f.get(c"s")?;
    let t = a[0];
    let k = a[1];
    let setting = op == c"set";
    let removing = op == c"deleteProperty";
    let is_string = k.kind()? == sys::ValueType::napi_string;
    if level == Level::Root && is_kind(k)? {
        if setting || own(t, k)? {
            replace_kind(s, k, if setting { a[2] } else { undef(s)? })?;
        }
        if setting {
            return flag(s, true);
        }
    } else if is_string || level == Level::Value {
        let owned = own(t, k)?;
        let kind = if level == Level::Root {
            text(s, "root")?
        } else {
            f.get(c"kind")?
        };
        let id = if level == Level::Value {
            f.get(c"id")?
        } else {
            k
        };
        if level == Level::Collection
            && ((!owned && setting) || (owned && removing) || (!setting && !removing))
        {
            mark_order(s, kind)?;
        }
        if !removing || owned {
            touch(s, kind, id)?;
        }
        if setting {
            t.set_key(k, adopted(s, a[2], kind, id)?)?;
            return flag(s, true);
        }
    }
    if setting {
        t.set_key(k, a[2])?;
        return flag(s, true);
    }
    call(s.global()?.get(c"Reflect")?, op, a)
}
fn make<'a>(s: L<'a>, level: Level, t: L<'a>, kind: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let ctx = fields(s, &[("s", s), ("kind", kind), ("id", id)])?;
    let traps = fields(
        s,
        &[(
            "get",
            function(ctx, "get", 3, 3, move |f, a| get(level, f, a))?,
        )],
    )?;
    for (name, op, n) in [
        ("set", c"set", 3),
        ("deleteProperty", c"deleteProperty", 2),
        ("defineProperty", c"defineProperty", 3),
    ] {
        if level == Level::Root && op == c"defineProperty" {
            continue;
        }
        traps.set(
            op,
            function(ctx, name, n, n, move |f, a| write(level, op, f, a))?,
        )?;
    }
    let proxy = s.global()?.get(c"Proxy")?.construct(&[t, traps])?;
    if level != Level::Root {
        let meta = fields(
            s,
            &[
                ("target", t),
                (
                    "kind",
                    if level == Level::Collection {
                        text(s, "root")?
                    } else {
                        kind
                    },
                ),
                ("id", id),
                ("container", flag(s, level == Level::Collection)?),
            ],
        )?;
        call(s.get(c"metas")?, c"set", &[proxy, meta])?;
        call(
            s.get(c"p")?.get(c"domain")?.get(c"trackedProxies")?,
            c"set",
            &[proxy, s.get(c"store")?],
        )?;
    }
    Ok(proxy)
}
pub(super) fn root(s: L<'_>) -> Result<L<'_>> {
    make(s, Level::Root, s.get(c"raw")?, text(s, "root")?, undef(s)?)
}
pub(super) fn replace_plain<'a>(dest: L<'a>, v: L<'a>) -> Result<()> {
    keys(dest)?.for_each(|k| {
        if !own(v, k)? {
            call(
                dest.global()?.get(c"Reflect")?,
                c"deleteProperty",
                &[dest, k],
            )?;
        }
        Ok(())
    })?;
    call(dest.global()?.get(c"Object")?, c"assign", &[dest, v])?;
    Ok(())
}
pub(super) fn replace_tracked<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let meta = call(s.get(c"metas")?, c"get", &[a[0]])?;
    if !meta.truthy()? || meta.get(c"container")?.truthy()? {
        return flag(s, false);
    }
    touch(s, meta.get(c"kind")?, meta.get(c"id")?)?;
    replace_plain(meta.get(c"target")?, a[1])?;
    flag(s, true)
}
