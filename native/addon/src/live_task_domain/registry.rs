use super::*;
use crate::task_short_code as codes;
use multicc_core::task_short_code::{ALPHABET, CODE_LEN};

fn indexes<'a>(p: L<'a>, input: L<'a>) -> Result<L<'a>> {
    let opts = default_object(input)?;
    let file = opts.get(c"file")?;
    let candidate = opts.get(c"candidate")?;
    let map = p.global()?.get(c"Map")?;
    let ids = map.construct(&[])?;
    let owners = map.construct(&[])?;
    let save = if file.truthy()? {
        let options = fields(
            p,
            &[
                ("file", file),
                ("kind", text(p, "task-short-codes")?),
                ("schemaVersion", num(p, 1.)?),
                ("legacyIsArray", flag(p, false)?),
            ],
        )?;
        let store = call(p, c"createStore", &[options])?;
        let loaded = match call(store, c"loadOrRecover", &[]) {
            Ok(loaded) => loaded,
            Err(e) => {
                let cause = error_value(p, e)?;
                let message = call(
                    text(p, "[task-short-code] registry state unusable at ")?,
                    c"concat",
                    &[file, text(p, ": ")?, cause.get(c"message")?],
                )?;
                return Err(p
                    .global()?
                    .get(c"Error")?
                    .construct(&[message])?
                    .throw_error());
            }
        };
        if loaded.get(c"present")?.truthy()? {
            let data = loaded.get(c"data")?;
            let entries = if data.truthy()? {
                data.get(c"byTaskId")?
            } else {
                data
            };
            codes::task_code_restore(env(p), arg(ids)?, arg(owners)?, arg(entries)?, arg(file)?)?;
        }
        let ports = fields(p, &[("store", store), ("ids", ids)])?;
        function(ports, "save", 0, 0, |p, _| {
            let by_id = call(
                p.global()?.get(c"Object")?,
                c"fromEntries",
                &[p.get(c"ids")?],
            )?;
            call(
                p.get(c"store")?,
                c"save",
                &[fields(p, &[("byTaskId", by_id)])?],
            )
        })?
    } else {
        undef(p)?
    };
    fields(
        p,
        &[
            ("ids", ids),
            ("owners", owners),
            ("candidate", candidate),
            ("save", save),
        ],
    )
}
fn methods(index: L<'_>) -> Result<L<'_>> {
    // Capture values as in destructuring; callers can inspect state.current later.
    let p = crate::js_live::spread(index)?;
    let api = fields(p, &[])?;
    expose(p, api, "codeFor", 1, 1, |p, a| {
        Ok(raw(
            p,
            codes::task_code_mint(
                env(p),
                arg(p.get(c"ids")?)?,
                arg(p.get(c"owners")?)?,
                arg(p.get(c"candidate")?)?,
                arg(p.get(c"save")?)?,
                arg(a[0])?,
            )?,
        ))
    })?;
    expose(p, api, "has", 1, 1, |p, a| {
        call(p.get(c"ids")?, c"has", &[a[0].clean_text()?])
    })?;
    expose(p, api, "ownerOf", 1, 1, |p, a| {
        let id = call(p.get(c"owners")?, c"get", a)?;
        if id.truthy()? {
            Ok(id)
        } else {
            null(p)
        }
    })?;
    expose(p, api, "size", 0, 0, |p, _| p.get(c"ids")?.get(c"size"))?;
    Ok(api)
}
pub(super) fn install<'a>(p: L<'a>, out: L<'a>) -> Result<()> {
    let idx = indexes(p, undef(p)?)?;
    let state = fields(p, &[("current", idx)])?;
    p.set(c"state", state)?;
    p.set(c"registry", methods(idx)?)?;
    p.set(
        c"getRegistry",
        function(p, "registry", 0, 0, |p, _| p.get(c"registry"))?,
    )?;
    getter(p, out, "taskCodeRegistryState", |p, _| p.get(c"state"))?;
    out.set(c"CODE_LEN", num(p, CODE_LEN as f64)?)?;
    out.set(
        c"CODE_ALPHABET",
        text(p, std::str::from_utf8(ALPHABET).expect("ASCII alphabet"))?,
    )?;
    expose(p, out, "createTaskShortCodeRegistry", 1, 1, |p, a| {
        methods(indexes(p, a[0])?)
    })?;
    expose(p, out, "initTaskShortCodeRegistry", 1, 1, |p, a| {
        let idx = indexes(p, a[0])?;
        p.get(c"state")?.set(c"current", idx)?;
        let registry = methods(idx)?;
        p.set(c"registry", registry)?;
        Ok(registry)
    })?;
    expose(p, out, "taskShortCode", 1, 1, |p, a| {
        call(p.get(c"registry")?, c"codeFor", a)
    })?;
    expose(p, out, "taskIdForShortCode", 1, 1, |p, a| {
        Ok(raw(
            p,
            codes::task_code_lookup(env(p), arg(a[0])?, arg(p.get(c"getRegistry")?)?)?,
        ))
    })?;
    expose(p, out, "labelWithCode", 2, 2, |p, a| {
        Ok(raw(
            p,
            codes::task_code_label(env(p), arg(a[0])?, arg(a[1])?, arg(p.get(c"state")?)?)?,
        ))
    })?;
    Ok(())
}
