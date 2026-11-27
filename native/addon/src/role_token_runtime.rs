//! Persistence and host-facing methods for a role-token owner. The JS bridge
//! normalizes usage events and supplies V8's legacy '+' coercion.
use crate::{
    host_methods::{arg, default_object, env as scope, function, raw},
    role_token_tracker::{role_ledger_update, RustRoleTokenTracker},
    route_response::*,
};
use multicc_core::state_file;
use napi_derive::napi;
use std::{path::PathBuf, rc::Rc};

fn day_key<'a>(date: L<'a>, add: L<'a>) -> Result<L<'a>> {
    let year = call(date, c"getFullYear", &[])?;
    let prefix = add.call_plain(&[year, text(date, "-")?])?;
    let month = add.call_plain(&[call(date, c"getMonth", &[])?, num(date, 1.)?])?;
    let month = call(
        string(month)?,
        c"padStart",
        &[num(date, 2.)?, text(date, "0")?],
    )?;
    let prefix = add.call_plain(&[prefix, month])?;
    let prefix = add.call_plain(&[prefix, text(date, "-")?])?;
    let day = call(
        string(call(date, c"getDate", &[])?)?,
        c"padStart",
        &[num(date, 2.)?, text(date, "0")?],
    )?;
    add.call_plain(&[prefix, day])
}

#[napi]
pub fn role_local_day(env: Env, date: Unknown<'_>, add: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(day_key(L::new(&env, date), L::new(&env, add))?.raw())
}

fn observed_info(event: L<'_>) -> Result<L<'_>> {
    if !event.get(c"coverage")?.is_string("observed")? {
        return null(event);
    }
    let tokens = event.get(c"tokens")?;
    if !tokens.truthy()? {
        return null(event);
    }
    let usage = fields(
        event,
        &[
            ("inputTokens", tokens.get(c"input")?),
            ("outputTokens", tokens.get(c"output")?),
            ("cacheWrite", tokens.get(c"cacheWrite")?),
            ("cacheRead", tokens.get(c"cacheRead")?),
        ],
    )?
    .freeze()?;
    fields(
        event,
        &[
            ("sessionId", event.get(c"sessionId")?),
            ("role", event.get(c"roleKind")?),
            ("providerId", event.get(c"providerId")?),
            ("providerName", event.get(c"providerName")?),
            ("model", event.get(c"model")?),
            ("usage", usage),
        ],
    )?
    .freeze()
}

#[napi]
pub fn role_observed_info(env: Env, event: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(observed_info(L::new(&env, event))?.raw())
}

fn read_ledger(p: L<'_>) -> Result<L<'_>> {
    let value = p.catch(|| {
        let file = p.get(c"file")?;
        let fs = p.get(c"fs")?;
        let source = if fs.undefined()? && file.kind()? == sys::ValueType::napi_string {
            let path = file.coerce_string()?.to_string_lossy();
            let Ok(bytes) = std::fs::read(path) else {
                return fields(p, &[]);
            };
            text(p, &String::from_utf8_lossy(&bytes))?
        } else {
            let fs = if fs.undefined()? {
                p.get(c"hostFs")?
            } else {
                fs
            };
            call(fs, c"readFileSync", &[file, text(p, "utf8")?])?
        };
        call(p.global()?.get(c"JSON")?, c"parse", &[source])
    })?;
    if let Some(value) = value {
        if value.kind()? == sys::ValueType::napi_object && !value.is_array()? {
            return Ok(value);
        }
    }
    fields(p, &[])
}

fn encode(value: L<'_>) -> Result<L<'_>> {
    call(
        value.global()?.get(c"JSON")?,
        c"stringify",
        &[value, null(value)?, num(value, 2.)?],
    )
}

fn write_ledger(p: L<'_>, ledger: L<'_>) -> Result<()> {
    let fs = p.get(c"fs")?;
    let file = p.get(c"file")?;
    let path = p.get(c"path")?;
    if fs.undefined()? {
        let bytes = encode(ledger)?.coerce_string()?.to_string_lossy();
        let resolved = call(path, c"resolve", &[file])?
            .coerce_string()?
            .to_string_lossy();
        if let Err(failure) = state_file::write_bytes_atomic_traced(
            &PathBuf::from(resolved),
            bytes.as_bytes(),
            0o600,
            0o700,
        ) {
            let (thrown, reported, op) = crate::node_fs_error::atomic_write_failure(p, &failure)?;
            let meta = fields(p, &[("operation", text(p, op)?), ("target", file)])?;
            p.catch(|| p.get(c"reportFailure")?.call_plain(&[reported, meta]))?;
            return Err(thrown.throw_error());
        }
        return Ok(());
    }
    let dir = call(path, c"dirname", &[file])?;
    call(
        fs,
        c"mkdirSync",
        &[dir, fields(p, &[("recursive", flag(p, true)?)])?],
    )?;
    let ms = call(p.global()?.get(c"Date")?, c"now", &[])?
        .coerce_string()?
        .to_string_lossy();
    let tmp = text(
        p,
        &format!(
            "{}.{}.{ms}.tmp",
            file.coerce_string()?.to_string_lossy(),
            std::process::id()
        ),
    )?;
    let written = (|| {
        call(fs, c"writeFileSync", &[tmp, encode(ledger)?])?;
        call(fs, c"renameSync", &[tmp, file])
    })();
    let thrown = if written.is_err() {
        p.exception_value()?
    } else {
        None
    };
    p.catch(|| call(fs, c"unlinkSync", &[tmp]))?;
    if let Some(error) = thrown {
        return Err(error.throw_error());
    }
    written.map(|_| ())
}

pub(crate) fn persist<'a>(p: L<'a>, info: L<'a>, role: L<'a>, usage: L<'a>) -> Result<()> {
    let update = (|| {
        let ledger = read_ledger(p)?;
        let add = p.get(c"add")?;
        let date = p.get(c"now")?.call_plain(&[])?;
        role_ledger_update(
            scope(p),
            arg(ledger)?,
            arg(day_key(date, add)?)?,
            arg(role)?,
            arg(info)?,
            arg(usage)?,
            arg(add)?,
        )?;
        write_ledger(p, ledger)
    })();
    if let Err(error) = update {
        let value = match p.exception_value()? {
            Some(value) => value,
            None => p
                .global()?
                .get(c"Error")?
                .construct(&[text(p, &error.reason)?])?,
        };
        p.get(c"onError")?.call_plain(&[value])?;
    }
    Ok(())
}

#[napi]
pub fn create_role_token_runtime(
    env: Env,
    opts: Unknown<'_>,
    ports: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let opts = default_object(L::new(&env, opts))?;
    let file = opts.get(c"filePath")?;
    if !file.truthy()? {
        return Err(p
            .global()?
            .get(c"Error")?
            .construct(&[text(p, "role token tracker requires filePath")?])?
            .throw_error());
    }
    let mut now = opts.get(c"now")?;
    if now.undefined()? {
        now = p.get(c"now")?;
    }
    let mut on_error = opts.get(c"onError")?;
    if on_error.undefined()? {
        on_error = p.get(c"onError")?;
    }
    let mut fs = opts.get(c"fsImpl")?;
    let default_fs = p.get(c"fs")?;
    if fs.equals(default_fs)? {
        fs = p.from_value(&V::Undefined)?;
    }
    let anchor = fields(
        p,
        &[
            ("file", file),
            ("fs", fs),
            ("hostFs", default_fs),
            ("now", now),
            ("onError", on_error),
            ("path", p.get(c"path")?),
            ("reportFailure", p.get(c"reportFailure")?),
            ("add", p.get(c"add")?),
        ],
    )?;
    let mut tracker = RustRoleTokenTracker::new(scope(p), arg(anchor)?)?;
    tracker.use_native_ledger();
    let tracker = Rc::new(tracker);
    let acc = tracker.clone();
    let accumulate = function(anchor, "accumulate", 1, 1, move |p, a| {
        flag(p, acc.accumulate(scope(p), arg(a[0])?)?)
    })?;
    let observed = tracker.clone();
    let accumulate_observed = function(anchor, "accumulateObserved", 1, 1, move |p, a| {
        let event = a[0];
        let id = event.get(c"eventId")?;
        if observed.seen(scope(p), arg(id)?)? {
            return flag(p, false);
        }
        let info = observed_info(event)?;
        if info.nullish()? || !observed.accumulate(scope(p), arg(info)?)? {
            return flag(p, false);
        }
        observed.remember(scope(p), arg(id)?)?;
        flag(p, true)
    })?;
    let snapshot = tracker.clone();
    Ok(fields(
        anchor,
        &[
            ("accumulate", accumulate),
            ("accumulateObserved", accumulate_observed),
            (
                "snapshot",
                function(anchor, "snapshot", 1, 1, move |p, a| {
                    Ok(raw(p, snapshot.snapshot(scope(p), arg(a[0])?)?))
                })?,
            ),
            (
                "reset",
                function(anchor, "reset", 1, 1, move |p, a| {
                    tracker.reset(scope(p), arg(a[0])?)?;
                    p.from_value(&V::Undefined)
                })?,
            ),
            (
                "readLedger",
                function(anchor, "readLedger", 0, 0, |p, _| read_ledger(p))?,
            ),
        ],
    )?
    .raw())
}
