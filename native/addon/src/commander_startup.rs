//! The directory registry and readiness state are host-owned. Keep the live
//! iterator across each seed promise so registrations during startup are visible.
use crate::{
    host_methods::{async_result, function},
    js_iteration::read,
    js_live::invoke,
    route_response::*,
};
use napi_derive::napi;

const FAILED: &str = "commander_migration_startup_failed";

fn mark_directory<'a>(state: L<'a>, dir: L<'a>, failed: bool) -> Result<()> {
    let set = read(state, c"setDirectory")?;
    let id = read(dir, c"id")?;
    let status = if failed {
        [
            ("status", text(state, "failed")?),
            ("code", text(state, FAILED)?),
        ]
    } else {
        [
            ("status", text(state, "ready")?),
            ("action", text(state, "task-first")?),
        ]
    };
    invoke(
        state,
        set,
        &[id, fields(state, &status)?],
        "commanderMigrationState.setDirectory",
    )?;
    Ok(())
}

fn seed<'a>(state: L<'a>, dir: L<'a>) -> Result<L<'a>> {
    async_result(state, || {
        mark_directory(state, dir, false)?;
        fields(
            state,
            &[("ok", flag(state, true)?), ("skipped", flag(state, true)?)],
        )
    })
}

fn values_after_complete<'a>(state: L<'a>, dirs: L<'a>) -> Result<L<'a>> {
    invoke(
        state,
        read(state, c"setPhase")?,
        &[text(state, "complete")?],
        "commanderMigrationState.setPhase",
    )?;
    invoke(dirs, read(dirs, c"values")?, &[], "directories.values")
}

// Settle the one startup promise in the same reaction as the old async loop.
// Returning nested promises here would delay its failure handler by one turn
// per previously visited directory, changing which live directories it marks.
fn checked<'a>(frame: L<'a>, work: impl FnOnce() -> Result<()>) -> Result<L<'a>> {
    if let Err(error) = work() {
        let reason = match frame.exception_value()? {
            Some(reason) => reason,
            None => frame
                .global()?
                .get(c"Error")?
                .construct(&[text(frame, &error.reason)?])?,
        };
        frame.get(c"reject")?.call_plain(&[reason])?;
    }
    frame.from_value(&V::Undefined)
}

fn advance(frame: L<'_>) -> Result<()> {
    let iterator = frame.get(c"iterator")?;
    if let Some(dir) = iterator.iterator_step(frame.get(c"next")?)? {
        let work = seed(frame.get(c"state")?, dir)?;
        let next = function(frame, "", 1, 1, |f, _| checked(f, || advance(f)))?;
        let close = function(frame, "", 1, 1, |f, args| {
            // A failure in a for-of body closes the iterator; the original
            // error takes precedence over a throwing return hook.
            f.catch(|| f.get(c"iterator")?.iterator_close())?;
            f.get(c"reject")?.call_plain(&[args[0]])
        })?;
        call(work, c"then", &[next, close])?;
    } else {
        let host = frame.get(c"host")?;
        let migration = invoke(
            host,
            read(host, c"migrateTaskSessions")?,
            &[],
            "taskShellHost.migrateTaskSessions",
        )?;
        let pending = call(frame.global()?.get(c"Promise")?, c"resolve", &[migration])?;
        let report = function(frame, "", 1, 1, |f, args| {
            checked(f, || {
                let result = args[0];
                if !read(result, c"ok")?.truthy()? {
                    let logger = f.get(c"logger")?;
                    let warn = read(logger, c"warn")?;
                    let details = fields(logger, &[("errors", read(result, c"errors")?)])?;
                    invoke(
                        logger,
                        warn,
                        &[text(logger, "task_first_migration_pending")?, details],
                        "logger.warn",
                    )?;
                }
                f.get(c"resolve")?.call_plain(&[])?;
                Ok(())
            })
        })?;
        call(pending, c"then", &[report, frame.get(c"reject")?])?;
    }
    Ok(())
}

#[napi]
pub fn commander_startup(env: Env, state: Unknown<'_>) -> Result<sys::napi_value> {
    let state = L::new(&env, state);
    let seed_directory = function(state, "seedCommanderSession", 1, 1, |s, a| seed(s, a[0]))?;
    let migrate = function(state, "migrate", 3, 3, |s, a| {
        let frame = call(s.global()?.get(c"Promise")?, c"withResolvers", &[])?;
        checked(frame, || {
            let (iterator, next) = values_after_complete(s, a[0])?.iterator()?;
            frame.set(c"state", s)?;
            frame.set(c"host", a[1])?;
            frame.set(c"logger", a[2])?;
            frame.set(c"iterator", iterator)?;
            frame.set(c"next", next)?;
            advance(frame)
        })?;
        frame.get(c"promise")
    })?;
    let fail = function(state, "fail", 3, 3, |s, a| {
        values_after_complete(s, a[0])?.for_each(|dir| mark_directory(s, dir, true))?;
        let logger = a[1];
        let log = read(logger, c"error")?;
        let error = if a[2].truthy()? {
            read(a[2], c"message")?
        } else {
            a[2]
        };
        invoke(
            logger,
            log,
            &[text(logger, FAILED)?, fields(s, &[("error", error)])?],
            "logger.error",
        )?;
        s.from_value(&V::Undefined)
    })?;
    Ok(fields(
        state,
        &[
            ("seedDirectory", seed_directory),
            ("migrate", migrate),
            ("fail", fail),
        ],
    )?
    .raw())
}
