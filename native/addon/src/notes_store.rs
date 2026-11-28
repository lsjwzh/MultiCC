//! File operations for the existing workspace notes owner. Dependency ports are
//! captured at construction. Ring and broadcast owners remain late-bound.
use crate::{host_methods::function, route_response::*};
use napi_derive::napi;
use std::{
    ffi::CStr,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

fn word(p: L<'_>) -> Result<String> {
    Ok(p.coerce_string()?.to_string_lossy())
}
fn file(p: L<'_>, id: L<'_>) -> Result<PathBuf> {
    // path.join appends every component, including leading slashes in the id.
    Ok(PathBuf::from(format!(
        "{}{}{}.jsonl",
        word(p.get(c"eventsDir")?)?,
        std::path::MAIN_SEPARATOR,
        word(id)?
    )))
}
fn parse<'a>(p: L<'a>, line: L<'a>) -> Result<L<'a>> {
    call(p.global()?.get(c"JSON")?, c"parse", &[line])
}
fn report(p: L<'_>, message: &str, e: napi::Error) -> Result<()> {
    let reason = match p.exception_value()? {
        Some(error) => error.get(c"message")?,
        None => text(p, &e.reason)?,
    };
    call(
        p.global()?.get(c"console")?,
        c"error",
        &[text(p, message)?, reason],
    )?;
    Ok(())
}
fn load(p: L<'_>) -> Result<L<'_>> {
    let name = word(p.get(c"notesFile")?)?;
    if !Path::new(&name).exists() {
        return p.from_value(&V::Undefined);
    }
    let result = (|| {
        let bytes = fs::read(&name).map_err(|e| {
            crate::node_fs_error::throw(p, &e, "read", Some(Path::new(&name)), None)
        })?;
        parse(p, text(p, &String::from_utf8_lossy(&bytes))?)
    })();
    match result {
        Ok(value) => Ok(value),
        Err(e) => {
            report(p, "[multicc] load notes.json failed:", e)?;
            p.from_value(&V::Array(vec![]))
        }
    }
}
pub(super) fn operation<'a>(p: L<'a>, key: &CStr, a: &[L<'a>]) -> Result<L<'a>> {
    match key.to_bytes() {
        b"load" => load(p),
        b"save" => {
            if let Err(e) = p
                .get(c"atomicWriteJson")?
                .call_plain(&[p.get(c"notesFile")?, a[0]])
            {
                report(p, "[multicc] save notes.json failed:", e)?;
            }
            p.from_value(&V::Undefined)
        }
        b"filter" => call(a[0], c"filter", &[a[1]]),
        b"events" => p.get(c"getWorkspaceEvents")?.call_plain(&[]),
        b"session" => call(p.get(c"persistedSessions")?, c"get", &[a[0]]),
        b"has" => call(a[0], c"has", &[a[1]]),
        b"recent" => call(a[0], c"recent", &[a[1]]),
        b"hydrate" => call(a[0], c"hydrate", &[a[1], a[2]]),
        b"lines" => {
            let file = file(p, a[0])?;
            if !file.exists() {
                return p.from_value(&V::Array(vec![]));
            }
            let bytes = fs::read(&file)
                .map_err(|e| crate::node_fs_error::throw(p, &e, "read", Some(&file), None))?;
            let source = String::from_utf8_lossy(&bytes);
            let trimmed = multicc_core::js::js_trim(&source);
            // Only the final 200 physical lines can seed the ring.
            let mut lines: Vec<_> = trimmed.rsplit('\n').take(200).map(V::from).collect();
            lines.reverse();
            p.from_value(&V::Array(lines))
        }
        b"parse" => parse(p, a[0]),
        b"now" => call(p.global()?.get(c"Date")?, c"now", &[]),
        b"append" => call(p.get(c"getWorkspaceEvents")?.call_plain(&[])?, c"append", a),
        b"persist" => {
            let path = file(p, a[0])?;
            let value = call(p.global()?.get(c"JSON")?, c"stringify", &[a[1]])?;
            let mut bytes = word(value)?.into_bytes();
            bytes.push(b'\n');
            let mut options = OpenOptions::new();
            options.create(true).append(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options
                .open(&path)
                .and_then(|mut f| f.write_all(&bytes))
                .map_err(|e| crate::node_fs_error::throw(p, &e, "write", Some(&path), None))?;
            p.from_value(&V::Undefined)
        }
        b"broadcast" => p.get(c"getWorkspaceBroadcast")?.call_plain(&[]),
        _ => Err(napi::Error::from_reason("unknown notes operation")),
    }
}
fn store(raw: L<'_>) -> Result<L<'_>> {
    let raw = if raw.truthy()? {
        raw
    } else {
        fields(raw, &[])?
    };
    let p = fields(raw, &[])?;
    let keys = [
        c"eventsDir",
        c"notesFile",
        c"persistedSessions",
        c"directories",
        c"atomicWriteJson",
        c"ensurePrivateDir",
        c"getWorkspaceBroadcast",
        c"getWorkspaceEvents",
    ];
    for key in keys {
        p.set(key, raw.get(key)?)?;
    }
    for (i, key) in keys.into_iter().enumerate() {
        let v = p.get(key)?;
        let error = match i {
            0 | 1 if v.kind()? != sys::ValueType::napi_string || !v.truthy()? => {
                Some("is required")
            }
            2 | 3 if !v.truthy()? || v.get(c"get")?.kind()? != sys::ValueType::napi_function => {
                Some("map is required")
            }
            4.. if v.kind()? != sys::ValueType::napi_function => Some("must be a function"),
            _ => None,
        };
        if let Some(msg) = error {
            return Err(p.type_error(&format!("[notes-store] {} {msg}", key.to_str().unwrap())));
        }
    }
    p.catch(|| {
        p.get(c"ensurePrivateDir")?
            .call_plain(&[p.get(c"eventsDir")?])
    })?;
    crate::workspace_notes::owner(p, operation)
}
#[napi]
pub fn workspace_notes_api(env: Env) -> Result<sys::napi_value> {
    use napi::bindgen_prelude::ToNapiValue;
    let p = L::new(&env, ().into_unknown(&env)?);
    Ok(fields(
        p,
        &[(
            "createNotesStore",
            function(p, "createNotesStore", 1, 1, |_, a| store(a[0]))?,
        )],
    )?
    .raw())
}
