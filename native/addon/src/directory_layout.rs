//! The optional UI-layout hint is cached per directory module. Detached methods
//! retain their store through a V8-owned binding, including across reentrant calls.
use crate::{host_methods::method, route_response::*};
use napi_derive::napi;

fn snapshot<'a>(present: L<'a>, corrupt: bool, data: L<'a>) -> Result<L<'a>> {
    fields(
        data,
        &[
            ("present", present),
            ("corrupt", flag(data, corrupt)?),
            ("data", data),
        ],
    )
}

fn warn(owner: L<'_>, prefix: &str, cause: napi::Error) -> Result<()> {
    let error = owner.exception_value()?.ok_or(cause)?;
    let logger = owner.get(c"logger")?;
    let receiver = logger.get(c"warn")?;
    let message = text(owner, prefix)?;
    let detail = error.get(c"message")?.coerce_string()?;
    receiver.call(
        logger,
        &[call(
            message,
            c"concat",
            &[owner.from_value(&V::String(detail))?],
        )?],
    )?;
    Ok(())
}

fn load(owner: L<'_>) -> Result<L<'_>> {
    let cached = owner.get(c"cached")?;
    if cached.truthy()? {
        return Ok(cached);
    }
    let read = (|| {
        let record = call(owner.get(c"store")?, c"loadOrRecover", &[])?;
        let present = flag(owner, record.get(c"present")?.is_true()?)?;
        let data = if record.get(c"present")?.truthy()? {
            record.get(c"data")?
        } else {
            null(owner)?
        };
        snapshot(present, false, data)
    })();
    let value = match read {
        Ok(value) => value,
        Err(e) => {
            warn(
                owner,
                "[multicc/ui-layout] unreadable layout file, starting empty: ",
                e,
            )?;
            snapshot(flag(owner, false)?, true, null(owner)?)?
        }
    };
    owner.set(c"cached", value)?;
    Ok(value)
}

fn save<'a>(owner: L<'a>, doc: L<'a>) -> Result<L<'a>> {
    owner.set(c"cached", snapshot(flag(owner, true)?, false, doc)?)?;
    if let Err(e) = call(owner.get(c"store")?, c"save", &[doc]) {
        warn(owner, "[multicc/ui-layout] save failed: ", e)?;
    }
    owner.from_value(&V::Undefined)
}

fn collect(value: L<'_>) -> Result<L<'_>> {
    let list = value.from_value(&V::Array(Vec::new()))?;
    let mut i = 0;
    value.for_each(|entry| {
        list.set_element(i, entry)?;
        i += 1;
        Ok(())
    })?;
    Ok(list)
}

fn known(deps: L<'_>) -> Result<L<'_>> {
    let dirs = collect(call(deps, c"listDirIds", &[])?)?;
    let sessions = fields(deps, &[])?;
    dirs.for_each(|id| sessions.set_key(id, collect(call(deps, c"listSessionIds", &[id])?)?))?;
    fields(deps, &[("dirIds", dirs), ("sessionIds", sessions)])
}

pub(super) fn layout_store<'a>(env: &'a Env, deps: L<'a>, state: L<'a>) -> Result<L<'a>> {
    let deps = fallback(deps, V::Object(Vec::new()))?;
    let file = deps.get(c"file")?;
    if !file.truthy()? {
        return Err(deps.type_error("[ui-layout] file path is required"));
    }
    for (key, message) in [
        (c"listDirIds", "[ui-layout] listDirIds() is required"),
        (
            c"listSessionIds",
            "[ui-layout] listSessionIds() is required",
        ),
    ] {
        if deps.get(key)?.kind()? != sys::ValueType::napi_function {
            return Err(deps.type_error(message));
        }
    }
    let mut logger = deps.get(c"logger")?;
    if !logger.truthy()? {
        logger = deps.global()?.get(c"console")?;
    }
    let config = fields(
        deps,
        &[
            ("file", file),
            ("kind", text(deps, "ui-layout")?),
            ("schemaVersion", num(deps, 1.0)?),
            ("legacyIsArray", flag(deps, false)?),
        ],
    )?;
    let store = call(state, c"createStore", &[config])?;
    let owner = fields(
        deps,
        &[
            ("store", store),
            ("cached", null(deps)?),
            ("logger", logger),
        ],
    )?;
    fields(
        deps,
        &[
            ("load", method(env, owner, "load", 0, 0, |o, _| load(o))?),
            (
                "save",
                method(env, owner, "save", 1, 1, |o, args| save(o, args[0]))?,
            ),
            ("known", method(env, deps, "known", 0, 0, |d, _| known(d))?),
        ],
    )
}

#[napi]
pub fn directory_layout_store(
    env: Env,
    deps: Unknown<'_>,
    state: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(layout_store(&env, L::new(&env, deps), L::new(&env, state))?.raw())
}
