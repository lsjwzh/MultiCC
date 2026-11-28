//! Public synchronous StateStore contract. The file writer shares the native
//! durability primitive. V8 owns JSON formatting, live errors and callbacks.
mod writer;
use crate::host_api::*;
use napi_derive::napi;

const SCHEMA: &str = "__multiccSchema";
const BACKUPS: f64 = 3.0;

fn exception(p: L<'_>, err: napi::Error) -> Result<L<'_>> {
    match p.exception_value()? {
        Some(error) => Ok(error),
        None => error_value(p, &err.reason),
    }
}

fn message<'a>(p: L<'a>, prefix: &str, parts: &[L<'a>]) -> Result<L<'a>> {
    call(text(p, prefix)?, c"concat", parts)
}

fn report<'a>(p: L<'a>, error: L<'a>, meta: L<'a>) -> Result<()> {
    let callback = p.get(c"reporter")?;
    if callable(callback)? {
        p.catch(|| callback.call_plain(&[error, meta]))?;
    }
    Ok(())
}

fn absent(p: L<'_>) -> Result<L<'_>> {
    fields(p, &[("present", flag(p, false)?)])
}

fn corrupt<'a>(p: L<'a>, file: L<'a>, msg: L<'a>, raw: Option<L<'a>>) -> Result<napi::Error> {
    let meta = fields(p, &[("file", file)])?;
    if let Some(raw) = raw {
        meta.set(c"raw", call(raw, c"slice", &[num(p, 0.)?, num(p, 200.)?])?)?;
    }
    Ok(p.get(c"CorruptedStateError")?
        .construct(&[msg, meta])?
        .throw_error())
}

fn read<'a>(p: L<'a>, file: L<'a>, legacy: L<'a>) -> Result<L<'a>> {
    let fs = p.get(c"fs")?;
    if !call(fs, c"existsSync", &[file])?.truthy()? {
        return absent(p);
    }
    let raw = match call(fs, c"readFileSync", &[file, text(p, "utf8")?]) {
        Ok(raw) => raw,
        Err(e) => {
            let cause = exception(p, e)?;
            let msg = message(
                p,
                "unreadable state file ",
                &[file, text(p, ": ")?, cause.get(c"message")?],
            )?;
            return Err(corrupt(p, file, msg, None)?);
        }
    };
    let parsed = match json_call(p, c"parse", raw) {
        Ok(value) => value,
        Err(e) => {
            let cause = exception(p, e)?;
            let msg = message(
                p,
                "corrupt JSON in ",
                &[file, text(p, ": ")?, cause.get(c"message")?],
            )?;
            return Err(corrupt(p, file, msg, Some(raw))?);
        }
    };
    let (data, envelope) = if parsed.is_array()? {
        if !legacy.truthy()? {
            let msg = message(p, "unexpected bare-array shape in ", &[file])?;
            return Err(corrupt(p, file, msg, None)?);
        }
        (
            parsed,
            fields(
                p,
                &[("kind", text(p, "legacy-array")?), ("version", num(p, 0.)?)],
            )?,
        )
    } else if object(parsed)? && parsed.get(c"__multiccSchema")?.truthy()? && parsed.has(c"data")? {
        (parsed.get(c"data")?, parsed.get(c"__multiccSchema")?)
    } else {
        let msg = message(p, "state envelope missing in ", &[file])?;
        return Err(corrupt(p, file, msg, None)?);
    };
    fields(
        p,
        &[
            ("present", flag(p, true)?),
            ("data", data),
            ("envelope", envelope),
        ],
    )
}

fn backup_name<'a>(file: L<'a>, index: L<'a>) -> Result<L<'a>> {
    message(file, "", &[file, text(file, ".bak")?, index])
}

fn recover_files<'a>(p: L<'a>, file: L<'a>, opts: L<'a>, keep: L<'a>) -> Result<L<'a>> {
    let fs = p.get(c"fs")?;
    let mut index = 1.;
    while index <= keep.explicit_number()? {
        let backup = backup_name(file, num(p, index)?)?;
        if call(fs, c"existsSync", &[backup])?.truthy()? {
            if let Some(result) = p.catch(|| read(p, backup, opts.get(c"legacyIsArray")?))? {
                if result.get(c"present")?.truthy()? {
                    result.set(c"recoveredFrom", backup)?;
                    return Ok(result);
                }
            }
        }
        index += 1.;
    }
    absent(p)
}

fn load_store(s: L<'_>, recovery: bool) -> Result<L<'_>> {
    let p = s.get(c"owner")?;
    let file = s.get(c"file")?;
    let legacy = s.get(c"legacyIsArray")?;
    match read(p, file, legacy) {
        Err(err) if recovery => {
            let error = exception(p, err)?;
            if error.instance_of(p.get(c"CorruptedStateError")?)? {
                let result = recover_files(p, file, s, s.get(c"rotate")?)?;
                if result.get(c"present")?.truthy()? {
                    result.set(c"recovered", flag(p, true)?)?;
                    return Ok(result);
                }
            }
            Err(error.throw_error())
        }
        result => result,
    }
}

fn create<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(args[0])?;
    let file = opts.get(c"file")?;
    let kind = opts.get(c"kind")?;
    let version = with_default(opts.get(c"schemaVersion")?, num(p, 1.)?)?;
    let legacy = with_default(opts.get(c"legacyIsArray")?, flag(p, true)?)?;
    let rotate = with_default(opts.get(c"rotate")?, num(p, BACKUPS)?)?;
    if !file.truthy()? {
        return Err(p.type_error("[state-store] createStore requires { file }"));
    }
    let write_options = fields(
        p,
        &[
            ("rotate", rotate),
            ("kind", kind),
            ("schemaVersion", version),
        ],
    )?;
    let store = fields(
        p,
        &[
            ("owner", p),
            ("file", file),
            ("legacyIsArray", legacy),
            ("rotate", rotate),
            ("options", write_options),
        ],
    )?;
    let api = fields(p, &[("file", file)])?;
    api.spread_from(defaulted_methods(
        store,
        &[
            ("load", 0, 0, |s, _| load_store(s, false)),
            ("loadOrRecover", 0, 0, |s, _| load_store(s, true)),
            ("save", 1, 1, |s, a| {
                writer::json(s.get(c"owner")?, s.get(c"file")?, a[0], s.get(c"options")?)
            }),
            ("_writeAtomic", 2, 2, |s, a| {
                let opts = spread(s.get(c"options")?)?;
                if !a[1].nullish()? {
                    opts.spread_from(a[1])?;
                }
                writer::json(s.get(c"owner")?, s.get(c"file")?, a[0], opts)
            }),
        ],
    )?)?;
    Ok(api)
}

#[napi]
pub fn state_store_host(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    writer::capture_fs(p)?;
    let api = fields(
        p,
        &[("CorruptedStateError", p.get(c"CorruptedStateError")?)],
    )?;
    api.spread_from(defaulted_methods(
        p,
        &[
            ("writeTextAtomic", 2, 3, |p, a| {
                writer::text_atomic(p, a[0], a[1], default_object(a[2])?)
            }),
            ("writeJsonAtomic", 2, 3, |p, a| {
                writer::json(p, a[0], a[1], default_object(a[2])?)
            }),
            ("readJson", 1, 2, |p, a| {
                read(p, a[0], default_object(a[1])?.get(c"legacyIsArray")?)
            }),
            ("recoverFromBackup", 1, 3, |p, a| {
                recover_files(
                    p,
                    a[0],
                    default_object(a[1])?,
                    with_default(a[2], num(p, BACKUPS)?)?,
                )
            }),
            ("createStore", 0, 1, create),
        ],
    )?)?;
    api.set(c"SCHEMA_KEY", text(p, SCHEMA)?)?;
    api.spread_from(methods(
        p,
        &[
            ("reportFailure", 2, |p, a| {
                report(p, a[0], a[1])?;
                undef(p)
            }),
            ("setFailureReporter", 1, |p, a| {
                p.set(c"reporter", a[0])?;
                undef(p)
            }),
        ],
    )?)?;
    Ok(api.raw())
}
