//! Startup schema decisions and ordering over the existing native storage ports.
//! Borrow live values so Map keys, Aux identity, getters and host exceptions are
//! preserved. This synchronous boot transaction finishes before chat IO starts;
//! it adds no scans, background work or alternate persistence implementation.
use crate::js_live::LiveValue as L;
use multicc_core::js::{JsString, JsValue as V};
use napi::bindgen_prelude::{ToNapiValue, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

fn text<'a>(a: L<'a>, value: &str) -> Result<L<'a>> {
    a.from_value(&V::from(value))
}
fn prop<'a>(value: L<'a>, key: &CStr) -> Result<L<'a>> {
    if value.nullish()? {
        let name = if value.undefined()? {
            "undefined"
        } else {
            "null"
        };
        return Err(value.type_error(&format!(
            "Cannot read properties of {name} (reading '{}')",
            key.to_string_lossy()
        )));
    }
    value.get(key)
}
fn object<'a>(a: L<'a>, fields: &[(&CStr, L<'a>)]) -> Result<L<'a>> {
    let out = a.from_value(&V::Object(vec![]))?;
    for (key, value) in fields {
        out.set(key, *value)?;
    }
    Ok(out)
}
fn array(a: L<'_>) -> Result<L<'_>> {
    a.from_value(&V::Array(vec![]))
}
fn method<'a>(a: L<'a>, key: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    prop(a, key)?.call(a, args)
}
fn or<'a>(value: L<'a>, fallback: impl FnOnce() -> Result<L<'a>>) -> Result<L<'a>> {
    if value.truthy()? {
        Ok(value)
    } else {
        fallback()
    }
}
fn concat<'a>(a: L<'a>, parts: &[L<'a>]) -> Result<L<'a>> {
    let mut out = JsString::new();
    for part in parts {
        out.push(&part.coerce_string()?);
    }
    a.from_value(&V::String(out))
}
fn log<'a>(logger: L<'a>, key: &CStr, message: impl FnOnce() -> Result<L<'a>>) -> Result<()> {
    let writer = prop(logger, key)?;
    writer.call(logger, &[message()?])?;
    Ok(())
}
fn function(value: L<'_>) -> Result<bool> {
    Ok(value.kind()? == sys::ValueType::napi_function)
}

#[derive(Clone, Copy)]
enum Scan {
    New,
    Migratable,
    Aux,
}
fn predicate(record: L<'_>, kind: Scan) -> Result<bool> {
    match kind {
        Scan::New => {
            Ok(!prop(record, c"dirId")?.undefined()? || !prop(record, c"kind")?.undefined()?)
        }
        Scan::Migratable => Ok(!(prop(record, c"id")?.is_string("__aux__")?
            || prop(record, c"type")?.is_string("aux")?)
            && prop(record, c"dirId")?.undefined()?
            && prop(record, c"kind")?.undefined()?),
        Scan::Aux => Ok(prop(record, c"id")?.is_string("__aux__")?
            || prop(record, c"type")?.is_string("aux")?),
    }
}
fn scan<'a>(env: &'a Env, records: L<'a>, key: &CStr, kind: Scan) -> Result<L<'a>> {
    let scan = prop(records, key)?;
    let callback = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "startupSchemaRecord",
        move |ctx| {
            let record = if ctx.length() == 0 {
                ().into_unknown(ctx.env)?
            } else {
                ctx.get::<Unknown<'_>>(0)?
            };
            let record = L::new(ctx.env, record);
            Ok(record.from_value(&V::Bool(predicate(record, kind)?))?.raw())
        },
    )?;
    scan.call(records, &[L::new(env, callback.into_unknown(env)?)])
}

#[napi]
pub fn state_is_new_schema(env: Env, records: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(scan(&env, L::new(&env, records), c"some", Scan::New)?.raw())
}
#[napi]
pub fn state_has_migratable_old_sessions(
    env: Env,
    records: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(scan(&env, L::new(&env, records), c"some", Scan::Migratable)?.raw())
}

fn migrate<'a>(records: L<'a>, random: L<'a>) -> Result<L<'a>> {
    let directories = records.global()?.get(c"Map")?.construct(&[])?;
    let sessions = records.global()?.get(c"Map")?.construct(&[])?;
    let renames = array(records)?;
    records.for_each(|record| {
        if prop(record, c"id")?.is_string("__aux__")? || prop(record, c"type")?.is_string("aux")? {
            let set = prop(sessions, c"set")?;
            set.call(sessions, &[prop(record, c"id")?, record])?;
            return Ok(());
        }
        let dir_id = random.call_plain(&[])?;
        let set = prop(directories, c"set")?;
        let directory = object(
            records,
            &[
                (c"id", dir_id),
                (c"name", prop(record, c"id")?),
                (c"path", prop(record, c"cwd")?),
                (c"createdAt", prop(record, c"createdAt")?),
            ],
        )?;
        set.call(directories, &[dir_id, directory])?;
        let set = prop(sessions, c"set")?;
        let id = prop(record, c"id")?;
        let session = object(
            records,
            &[
                (c"id", prop(record, c"id")?),
                (c"dirId", dir_id),
                (c"cli", text(records, "claude")?),
                (c"kind", text(records, "terminal")?),
                (
                    c"cliSessionId",
                    or(prop(record, c"claudeSessionId")?, || {
                        records.from_value(&V::Null)
                    })?,
                ),
                (c"createdAt", prop(record, c"createdAt")?),
            ],
        )?;
        set.call(sessions, &[id, session])?;
        if prop(record, c"chatClaudeSessionId")?.truthy()? {
            let chat_id = concat(records, &[prop(record, c"id")?, text(records, "-chat")?])?;
            let set = prop(sessions, c"set")?;
            let session = object(
                records,
                &[
                    (c"id", chat_id),
                    (c"dirId", dir_id),
                    (c"cli", text(records, "claude")?),
                    (c"kind", text(records, "chat")?),
                    (c"cliSessionId", prop(record, c"chatClaudeSessionId")?),
                    (c"createdAt", prop(record, c"createdAt")?),
                ],
            )?;
            set.call(sessions, &[chat_id, session])?;
            let push = prop(renames, c"push")?;
            push.call(
                renames,
                &[object(
                    records,
                    &[(c"from", prop(record, c"id")?), (c"to", chat_id)],
                )?],
            )?;
        }
        Ok(())
    })?;
    object(
        records,
        &[
            (c"directories", directories),
            (c"sessions", sessions),
            (c"chatHistoryRenames", renames),
        ],
    )
}

#[napi]
pub fn state_migrate_old_schema(
    env: Env,
    records: Unknown<'_>,
    options: Unknown<'_>,
    crypto: Unknown<'_>,
) -> Result<sys::napi_value> {
    let records = L::new(&env, records);
    let mut options = L::new(&env, options);
    let crypto = L::new(&env, crypto);
    if options.undefined()? {
        options = object(records, &[])?;
    }
    let random = prop(options, c"randomUUID")?;
    let random = if random.undefined()? {
        prop(crypto, c"randomUUID")?
    } else {
        random
    };
    Ok(migrate(records, random)?.raw())
}

fn caught<'a>(anchor: L<'a>, error: napi::Error) -> Result<L<'a>> {
    if let Some(value) = anchor.exception_value()? {
        return Ok(value);
    }
    anchor
        .global()?
        .get(c"Error")?
        .construct(&[text(anchor, &error.reason)?])
}
fn load<'a>(owner: L<'a>, key: &CStr, logger: L<'a>, prefix: &str) -> Result<L<'a>> {
    match method(owner, key, &[]) {
        Ok(value) => Ok(value),
        Err(error) => {
            let error = caught(owner, error)?;
            log(logger, c"error", || {
                concat(owner, &[text(owner, prefix)?, prop(error, c"message")?])
            })?;
            Err(error.throw_error())
        }
    }
}

#[napi]
pub fn state_bootstrap(
    env: Env,
    options: Unknown<'_>,
    default_fs: Unknown<'_>,
    crypto: Unknown<'_>,
) -> Result<sys::napi_value> {
    let options = L::new(&env, options);
    let default_fs = L::new(&env, default_fs);
    let crypto = L::new(&env, crypto);
    if !options.truthy()? || options.kind()? != sys::ValueType::napi_object {
        return Err(options.type_error("[state-bootstrap] options are required"));
    }
    let owner = prop(options, c"stateOwner")?;
    let paths = prop(options, c"paths")?;
    let history = prop(options, c"chatHistoryRepository")?;
    if !owner.truthy()?
        || !function(prop(owner, c"replayJournals")?)?
        || !function(prop(owner, c"loadSessions")?)?
        || !function(prop(owner, c"loadDirectories")?)?
        || !function(prop(owner, c"initDirectories")?)?
    {
        return Err(options.type_error("[state-bootstrap] stateOwner is required"));
    }
    if !paths.truthy()?
        || !prop(paths, c"sessionsFile")?.truthy()?
        || !prop(paths, c"directoriesFile")?.truthy()?
        || !prop(paths, c"journalDir")?.truthy()?
    {
        return Err(options.type_error("[state-bootstrap] paths are required"));
    }
    if !history.truthy()? || !function(prop(history, c"renameSession")?)? {
        return Err(
            options.type_error("[state-bootstrap] chatHistoryRepository.renameSession is required")
        );
    }
    let fs = or(prop(options, c"fs")?, || Ok(default_fs))?;
    let random = or(prop(options, c"randomUUID")?, || {
        prop(crypto, c"randomUUID")
    })?;
    let logger = or(prop(options, c"logger")?, || {
        options.global()?.get(c"console")
    })?;
    let replay = method(owner, c"replayJournals", &[])?;
    let messages = if replay.truthy()? {
        prop(replay, c"messages")?
    } else {
        replay
    };
    or(messages, || array(options))?.for_each(|message| {
        method(logger, c"log", &[message])?;
        Ok(())
    })?;
    if prop(replay, c"replayed")?.truthy()? || prop(replay, c"skipped")?.truthy()? {
        log(logger, c"log", || {
            let mut message = JsString::from_rust_str("[multicc] state-tx journal: ");
            message.push(&prop(replay, c"replayed")?.coerce_string()?);
            message.push_str(" replayed, ");
            message.push(&prop(replay, c"skipped")?.coerce_string()?);
            message.push_str(" skipped");
            options.from_value(&V::String(message))
        })?;
    }
    let sessions_result = load(
        owner,
        c"loadSessions",
        logger,
        "[multicc] sessions.json unreadable and no backup usable: ",
    )?;
    let directories_result = load(
        owner,
        c"loadDirectories",
        logger,
        "[multicc] directories.json unreadable and no backup usable: ",
    )?;
    if prop(directories_result, c"recovered")?.truthy()? {
        log(logger, c"warn", || {
            concat(
                options,
                &[
                    text(options, "[multicc] directories.json recovered from backup ")?,
                    prop(directories_result, c"recoveredFrom")?,
                ],
            )
        })?;
    }
    let records = if prop(sessions_result, c"present")?.truthy()? {
        prop(sessions_result, c"data")?
    } else {
        array(options)?
    };
    if prop(sessions_result, c"present")?.truthy()?
        && prop(sessions_result, c"recovered")?.truthy()?
    {
        log(logger, c"warn", || {
            concat(
                options,
                &[
                    text(options, "[multicc] sessions.json recovered from backup ")?,
                    prop(sessions_result, c"recoveredFrom")?,
                ],
            )
        })?;
    }
    let state = if prop(records, c"length")?.positive()?
        && !scan(&env, records, c"some", Scan::New)?.truthy()?
        && scan(&env, records, c"some", Scan::Migratable)?.truthy()?
    {
        method(
            logger,
            c"log",
            &[text(
                options,
                "[multicc] Migrating sessions.json to directory-based schema...",
            )?],
        )?;
        let migrated = migrate(records, random)?;
        prop(migrated, c"chatHistoryRenames")?.for_each(|rename| {
            let from = prop(rename, c"from")?;
            let to = prop(rename, c"to")?;
            match method(history, c"renameSession", &[from, to]) {
                Ok(_) => (),
                Err(error) => {
                    let error = caught(options, error)?;
                    log(logger, c"warn", || {
                        let mut message =
                            JsString::from_rust_str("[multicc] chat_history rename failed ");
                        message.push(&from.coerce_string()?);
                        message.push_str(" → ");
                        message.push(&to.coerce_string()?);
                        message.push_str(": ");
                        message.push(&prop(error, c"message")?.coerce_string()?);
                        options.from_value(&V::String(message))
                    })?;
                }
            }
            Ok(())
        })?;
        options.catch(|| {
            let copy = prop(fs, c"copyFileSync")?;
            let source = prop(paths, c"sessionsFile")?;
            let backup = concat(
                options,
                &[
                    prop(paths, c"sessionsFile")?,
                    text(options, ".pre-directory.bak")?,
                ],
            )?;
            copy.call(fs, &[source, backup])
        })?;
        let initialize = prop(owner, c"initDirectories")?;
        let directories = prop(migrated, c"directories")?;
        let entries = method(directories, c"entries", &[])?;
        initialize.call(owner, &[entries])?;
        object(
            options,
            &[
                (c"persistedSessions", prop(migrated, c"sessions")?),
                (c"needsSave", options.from_value(&V::Bool(true))?),
                (
                    c"needsDefaultDirectory",
                    options.from_value(&V::Bool(false))?,
                ),
            ],
        )?
    } else {
        let map = options.global()?.get(c"Map")?;
        let map_records = prop(records, c"map")?;
        let callback = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
            "persistedStartupSession",
            |ctx| {
                let value = if ctx.length() == 0 {
                    ().into_unknown(ctx.env)?
                } else {
                    ctx.get::<Unknown<'_>>(0)?
                };
                let session = L::new(ctx.env, value);
                let pair = array(session)?;
                pair.set_element(0, prop(session, c"id")?)?;
                pair.set_element(1, session)?;
                Ok(pair.raw())
            },
        )?;
        let mapped = map_records.call(records, &[L::new(&env, callback.into_unknown(&env)?)])?;
        let persisted = map.construct(&[mapped])?;
        log(logger, c"log", || {
            let mut message = JsString::from_rust_str("[multicc] Loaded ");
            message.push(&prop(directories_result, c"size")?.coerce_string()?);
            message.push_str(" directories, ");
            message.push(&prop(persisted, c"size")?.coerce_string()?);
            message.push_str(" session(s)");
            options.from_value(&V::String(message))
        })?;
        let only_aux = scan(&env, records, c"every", Scan::Aux)?;
        let needs_default = if !prop(directories_result, c"present")?.truthy()? {
            only_aux
        } else {
            options.from_value(&V::Bool(false))?
        };
        object(
            options,
            &[
                (c"persistedSessions", persisted),
                (c"needsSave", options.from_value(&V::Bool(false))?),
                (c"needsDefaultDirectory", needs_default),
            ],
        )?
    };
    Ok(object(options, &[(c"state", state)])?.freeze()?.raw())
}
