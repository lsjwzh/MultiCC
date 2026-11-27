use super::*;
use crate::{air_task_list as lists, air_todo_ignore as ignores};
use std::rc::Rc;

fn kinds(p: L<'_>) -> Result<L<'_>> {
    let existing = p.get(c"ignoreKinds")?;
    if existing.truthy()? {
        return Ok(existing);
    }
    let values = ignores::air_todo_ignore_kinds()
        .into_iter()
        .map(|k| V::string(&k))
        .collect();
    let set = p
        .global()?
        .get(c"Set")?
        .construct(&[p.from_value(&V::Array(values))?])?;
    p.set(c"ignoreKinds", set)?;
    Ok(set)
}
fn normalize<'a>(p: L<'a>, items: L<'a>, cap: L<'a>, set: L<'a>) -> Result<L<'a>> {
    let limit = if cap.undefined()? {
        num(p, ignores::AIR_TODO_IGNORE_LIMIT.into())?
    } else {
        cap
    };
    Ok(raw(
        p,
        ignores::air_normalize_ignores(env(p), arg(items)?, arg(limit)?, arg(set)?)?,
    ))
}
fn views(p: L<'_>) -> Result<L<'_>> {
    let output = p.global()?.get(c"Map")?.construct(&[])?;
    let tasks = call(p.get(c"deps")?, c"listTasks", &[])?;
    if tasks.truthy()? {
        tasks.for_each(|task| {
            if task.truthy()? && task.get(c"id")?.truthy()? {
                let stamp = task.get(c"updatedAt")?.explicit_number()?;
                let id = task.get(c"id")?;
                let view = fields(
                    p,
                    &[
                        ("task", task),
                        ("updatedAt", num(p, stamp)?),
                        ("problem", null(p)?),
                    ],
                )?;
                call(output, c"set", &[id, view])?;
            }
            Ok(())
        })?;
    }
    Ok(output)
}
fn load(p: L<'_>, ignore: bool) -> Result<L<'_>> {
    let read = || {
        let loaded = call(p.get(c"store")?, c"loadOrRecover", &[])?;
        let value = if loaded.get(c"present")?.truthy()? {
            loaded
                .get(c"data")?
                .optional(if ignore { c"items" } else { c"taskIds" })?
        } else {
            null(p)?
        };
        if ignore {
            normalize(p, value, undef(p)?, p.get(c"kinds")?)
        } else {
            Ok(value)
        }
    };
    match read() {
        Ok(value) => Ok(value),
        Err(failure) => {
            let exception = error_value(p, failure)?;
            let kind = p.get(c"kind")?;
            let prefix = text(p, "[multicc/")?;
            let description = if ignore {
                text(p, "] unreadable file, starting empty: ")?
            } else {
                call(
                    text(p, "] unreadable ")?,
                    c"concat",
                    &[kind, text(p, " file, starting empty: ")?],
                )?
            };
            let message = call(
                prefix,
                c"concat",
                &[kind, description, exception.get(c"message")?],
            )?;
            call(p.get(c"logger")?, c"warn", &[message])?;
            if ignore {
                p.from_value(&V::Array(vec![]))
            } else {
                null(p)
            }
        }
    }
}
fn save<'a>(p: L<'a>, items: L<'a>, ignore: bool) -> Result<L<'a>> {
    let payload = fields(p, &[(if ignore { "items" } else { "taskIds" }, items)])?;
    if let Err(failure) = call(p.get(c"store")?, c"save", &[payload]) {
        let exception = error_value(p, failure)?;
        let message = call(
            text(p, "[multicc/")?,
            c"concat",
            &[
                p.get(c"kind")?,
                text(p, "] save failed: ")?,
                exception.get(c"message")?,
            ],
        )?;
        call(p.get(c"logger")?, c"warn", &[message])?;
        let (user, code) = if ignore {
            (
                text(p, "忽略状态无法保存")?,
                text(p, "todo_ignore_save_failed")?,
            )
        } else {
            let spec = p.get(c"spec")?;
            let title = call(spec.get(c"label")?, c"trim", &[])?;
            (
                call(title, c"concat", &[text(p, " state could not be saved")?])?,
                spec.get(c"codes")?.get(c"saveFailed")?,
            )
        };
        let error = p.global()?.get(c"Error")?.construct(&[user])?;
        error.assign(c"code", code)?;
        error.assign(c"status", num(p, 500.)?)?;
        return Err(error.throw_error());
    }
    undef(p)
}
fn runtime<'a>(
    p: L<'a>,
    arg_deps: L<'a>,
    spec: L<'a>,
    ignore: bool,
    builtin: bool,
) -> Result<L<'a>> {
    let deps = if arg_deps.truthy()? {
        arg_deps
    } else {
        fields(p, &[])?
    };
    let kind = spec.get(c"kind")?;
    let route = spec.get(c"route")?;
    let limit = spec.get(c"limit")?;
    let codes = spec.get(c"codes")?;
    let label = spec.get(c"label")?;
    let mut file = deps.get(c"file")?;
    if !file.truthy()? {
        file = if builtin {
            call(p, c"defaultFile", &[spec.get(c"fileKey")?])?
        } else {
            call(spec, c"defaultFile", &[])?
        };
    }
    let callback = if ignore { c"listTasks" } else { c"listTaskIds" };
    if deps.get(callback)?.kind()? != sys::ValueType::napi_function {
        let msg = call(
            text(p, "[")?,
            c"concat",
            &[
                kind,
                text(
                    p,
                    if ignore {
                        "] listTasks() is required"
                    } else {
                        "] listTaskIds() is required"
                    },
                )?,
            ],
        )?;
        return Err(p
            .global()?
            .get(c"TypeError")?
            .construct(&[msg])?
            .throw_error());
    }
    let logger = deps.get(c"logger")?;
    let logger = if logger.truthy()? {
        logger
    } else {
        p.global()?.get(c"console")?
    };
    let store = call(
        p,
        c"createStore",
        &[fields(
            p,
            &[
                ("file", file),
                ("kind", kind),
                ("schemaVersion", num(p, 1.)?),
                ("legacyIsArray", flag(p, false)?),
            ],
        )?],
    )?;
    let policy = fields(p, &[("limit", limit), ("codes", codes), ("label", label)])?;
    let ports = fields(
        p,
        &[
            ("deps", deps),
            ("kind", kind),
            ("spec", policy),
            ("store", store),
            ("logger", logger),
            ("route", route),
        ],
    )?;
    let api = fields(p, &[("file", file), ("limit", limit)])?;
    expose(ports, ports, "load", 0, 0, move |p, _| load(p, ignore))?;
    expose(ports, ports, "save", 1, 1, move |p, a| {
        save(p, a[0], ignore)
    })?;
    if ignore {
        ports.set(c"kinds", kinds(p)?)?;
        ports.set(c"items", null(p)?)?;
        expose(ports, ports, "taskViews", 0, 0, |p, _| views(p))?;
        for (op, count) in [("read", 0), ("toggle", 1)] {
            expose(ports, api, op, count, 1, move |p, a| {
                Ok(raw(
                    p,
                    ignores::air_todo_ignore_run(env(p), arg(p)?, op.into(), arg(a[0])?)?,
                ))
            })?;
        }
    } else {
        expose(ports, ports, "listTaskIds", 0, 0, |p, _| {
            call(p.get(c"deps")?, c"listTaskIds", &[])
        })?;
        let owner = Rc::new(lists::RustAirTaskList::new());
        for (op, count) in [("read", 0), ("replace", 1), ("toggle", 1)] {
            let state = owner.clone();
            expose(ports, api, op, count, 1, move |p, a| {
                Ok(raw(p, state.run(env(p), op.into(), arg(p)?, arg(a[0])?)?))
            })?;
        }
    }
    // Route handlers capture the operation functions when the owner is made.
    let routes = fields(
        p,
        &[
            ("route", route),
            ("codes", codes),
            ("read", api.get(c"read")?),
            ("replace", api.get(c"replace")?),
            ("toggle", api.get(c"toggle")?),
        ],
    )?;
    expose(routes, api, "mountRoutes", 1, 1, move |r, a| {
        super::air_routes::mount(r, a[0], ignore)
    })?;
    Ok(api)
}
pub(super) fn install<'a>(p: L<'a>, out: L<'a>) -> Result<()> {
    expose(p, out, "normalizePins", 2, 2, |p, a| {
        Ok(raw(
            p,
            lists::air_normalize_task_ids(env(p), arg(a[0])?, arg(a[1])?)?,
        ))
    })?;
    expose(p, out, "readStoredPinIds", 1, 1, |p, a| {
        let read = || {
            call(
                p.global()?.get(c"JSON")?,
                c"parse",
                &[call(p, c"readText", a)?],
            )
        };
        let value = match read() {
            Ok(value) => value,
            Err(e) => {
                let cause = error_value(p, e)?;
                if cause.get(c"code")?.is_string("ENOENT")? {
                    return p.from_value(&V::Array(vec![]));
                }
                return Err(cause.throw_error());
            }
        };
        Ok(raw(p, lists::air_stored_pins(env(p), arg(value)?)?))
    })?;
    expose(p, out, "createTaskIdListRuntime", 2, 2, |p, a| {
        runtime(p, a[0], a[1], false, false)
    })?;
    for (name, constant, todo) in [
        ("createAirPinRuntime", "PIN_LIMIT", false),
        ("createAirTodoRuntime", "TODO_LIMIT", true),
    ] {
        expose(p, out, name, 1, 1, move |p, a| {
            runtime(
                p,
                a[0],
                raw(p, lists::air_task_list_spec(env(p), todo)?),
                false,
                true,
            )
        })?;
        getter(p, out, constant, move |p, _| {
            raw(p, lists::air_task_list_spec(env(p), todo)?).get(c"limit")
        })?;
    }
    getter(p, out, "IGNORE_KINDS", |p, _| kinds(p))?;
    getter(p, out, "TODO_IGNORE_LIMIT", |p, _| {
        num(p, ignores::AIR_TODO_IGNORE_LIMIT.into())
    })?;
    expose(p, out, "normalizeIgnores", 1, 2, |p, a| {
        normalize(p, a[0], a[1], kinds(p)?)
    })?;
    expose(p, out, "createAirTodoIgnoreRuntime", 1, 1, |p, a| {
        let spec = fields(
            p,
            &[
                ("kind", text(p, "air-todo-ignores")?),
                ("route", text(p, "/api/air/todos/ignore")?),
                ("fileKey", text(p, "airTodoIgnoresFile")?),
                ("limit", num(p, ignores::AIR_TODO_IGNORE_LIMIT.into())?),
            ],
        )?;
        runtime(p, a[0], spec, true, true)
    })?;
    Ok(())
}
