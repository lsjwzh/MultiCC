//! Await the durable history acknowledgement between the two native execution phases.
//! A separate V8 frame owns the live ports, plan and callbacks for each execute call.
use crate::{
    chat_finalize_execution::{
        chat_commit_turn_finalization, chat_execute_turn_finalization,
        chat_validate_finalization_ports,
    },
    host_api::*,
    host_methods::{arg, env, raw},
};
use napi_derive::napi;
use std::ffi::CStr;

fn synchronize(frame: L<'_>) -> Result<()> {
    let ports = frame.get(c"ports")?;
    if callable(ports.get(c"syncQuestionTurn")?)? {
        let callback = ports.get(c"syncQuestionTurn")?;
        let sync = callback.call(ports, &[frame.get(c"context")?.get(c"sessionName")?])?;
        frame.set(c"syncTurn", sync)?;
    }
    Ok(())
}

fn prepare<'a>(frame: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let result = raw(
        frame,
        chat_execute_turn_finalization(
            env(frame),
            arg(frame.get(c"plan")?)?,
            arg(frame.get(c"context")?)?,
            arg(frame.get(c"ports")?)?,
            arg(frame.get(c"runtime")?)?,
        )?,
    );
    if !result.optional(c"pending")?.is_true()? {
        synchronize(frame)?;
    }
    Ok(result)
}

fn commit<'a>(frame: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let prepared = frame.get(c"prepared")?;
    let result = raw(
        frame,
        chat_commit_turn_finalization(
            env(frame),
            arg(prepared.get(c"plan")?)?,
            arg(frame.get(c"context")?)?,
            arg(frame.get(c"ports")?)?,
            arg(frame.get(c"runtime")?)?,
            frame.get(c"persisted")?.is_true()?,
            Some(arg(frame.get(c"fault")?)?),
            Some(arg(prepared.get(c"sourcePlan")?)?),
        )?,
    );
    synchronize(frame)?;
    Ok(result)
}

fn finish<'a>(frame: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let sync = frame.get(c"syncTurn")?;
    if sync.truthy()? {
        then(sync, a[0], constant)
    } else {
        Ok(a[0])
    }
}

fn in_snapshot<'a>(
    frame: L<'a>,
    name: &'static str,
    phase: Action,
    after: Action,
) -> Result<L<'a>> {
    let ports = frame.get(c"ports")?;
    if callable(ports.get(c"withQuestionSnapshot")?)? {
        let snapshot = ports.get(c"withQuestionSnapshot")?;
        let session = frame.get(c"context")?.get(c"sessionName")?;
        let value = snapshot.call(ports, &[session, function(frame, name, 0, 0, phase)?])?;
        then(value, frame, after)
    } else {
        let value = phase(frame, &mut [])?;
        after(frame, &mut [value])
    }
}

fn persisted<'a>(frame: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    frame.set(c"persisted", flag(frame, a[0].is_true()?)?)?;
    in_snapshot(frame, "commit", commit, finish)
}

fn write_failed<'a>(frame: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    frame.set(c"fault", a[0])?;
    in_snapshot(frame, "commit", commit, finish)
}

fn after_prepare<'a>(frame: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let prepared = a[0];
    if !prepared.truthy()? || !prepared.get(c"pending")?.is_true()? {
        return finish(frame, a);
    }
    frame.set(c"prepared", prepared)?;
    let write = (|| {
        let ports = frame.get(c"ports")?;
        let persist = ports.get(c"persistAssistant")?;
        resolved(persist.call(ports, &[frame.get(c"context")?, prepared.get(c"append")?])?)
    })();
    match write {
        Ok(promise) => call(
            promise,
            c"then",
            &[
                function(frame, "persisted", 1, 1, persisted)?,
                function(frame, "writeFailed", 1, 1, write_failed)?,
            ],
        ),
        Err(error) => {
            let reason = frame.exception_value()?.ok_or(error)?;
            write_failed(frame, &mut [reason])
        }
    }
}

fn execute<'a>(owner: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(owner, || {
        let frame = fields(
            owner,
            &[
                ("ports", owner.get(c"ports")?),
                ("runtime", owner.get(c"runtime")?),
                ("plan", a[0]),
                ("context", default_object(a[1])?),
            ],
        )?;
        in_snapshot(frame, "prepare", prepare, after_prepare)
    })
}

fn complete_session<'a>(owner: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let result = call(owner.get(c"ports")?, c"completeSessionTurn", &[a[0]])?;
    let scope = fields(
        owner,
        &[("sessionName", a[0]), ("logError", owner.get(c"logError")?)],
    )?;
    recover(result, scope, |scope, errors| {
        let detail = fields(
            scope,
            &[
                ("sessionName", scope.get(c"sessionName")?),
                ("error", errors[0]),
            ],
        )?;
        scope
            .get(c"logError")?
            .call_plain(&[text(scope, "complete-session-turn-failed")?, detail])?;
        undef(scope)
    })?;
    undef(owner)
}

fn override_or<'a>(
    ports: L<'a>,
    key: &CStr,
    fallback: impl FnOnce() -> Result<L<'a>>,
) -> Result<L<'a>> {
    if callable(ports.get(key)?)? {
        ports.get(key)
    } else {
        fallback()
    }
}

fn validate<'a>(_: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    Ok(raw(
        a[0],
        chat_validate_finalization_ports(env(a[0]), arg(a[0])?)?,
    ))
}

fn create<'a>(get_progress: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let ports = validate(get_progress, a)?;
    let now = override_or(ports, c"now", || ports.global()?.get(c"Date")?.get(c"now"))?;
    let field = override_or(ports, c"timelineField", || {
        get_progress.call_plain(&[])?.get(c"field")
    })?;
    let noop = || function(ports, "", 0, 0, |p, _| undef(p));
    let log = override_or(ports, c"log", noop)?;
    let log_error = override_or(ports, c"logError", noop)?;
    let completion = fields(ports, &[("ports", ports), ("logError", log_error)])?;
    let runtime = fields(
        ports,
        &[
            ("now", now),
            ("timelineField", field),
            ("log", log),
            ("logError", log_error),
            (
                "completeSessionTurn",
                function(completion, "completeSessionTurn", 1, 1, complete_session)?,
            ),
        ],
    )?;
    let owner = fields(ports, &[("ports", ports), ("runtime", runtime)])?;
    defaulted_methods(owner, &[("execute", 1, 2, execute)])?.freeze()
}

#[napi]
pub fn turn_finalization_executor_api(
    env: Env,
    get_progress: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, get_progress);
    Ok(methods(
        p,
        &[
            ("assertFinalizeHostPorts", 1, validate),
            ("createTurnFinalizationExecutor", 1, create),
        ],
    )?
    .raw())
}
