//! 终态消息和暂存回答的异步落盘回执。每个引擎借用自己的写入端口，按运行器等待回执。
use crate::{
    chat_events::{commit_final_persist, commit_held_answer},
    host_methods::method,
    route_response::*,
};
use napi_derive::napi;

fn callback<'a>(
    s: L<'a>,
    count: usize,
    run: impl for<'b> Fn(L<'b>, &mut [L<'b>]) -> Result<L<'b>> + 'static,
) -> Result<L<'a>> {
    let env = Env::from_raw(s.env());
    let function = method(&env, s, "", count, count, run)?;
    Ok(L::from_raw(s.env(), function.raw()))
}

fn log_error<'a>(s: L<'a>, event: &str, error: L<'a>) -> Result<()> {
    let turn = s.get(c"turn")?;
    let runner = s.get(c"runner")?;
    let message = error.optional(c"message")?;
    let message = if message.truthy()? {
        error.get(c"message")?
    } else {
        string(error)?
    };
    let context = fields(
        s,
        &[
            ("sessionId", s.get(c"session")?),
            (
                "turnId",
                if turn.truthy()? {
                    turn.get(c"turnId")?
                } else {
                    turn
                },
            ),
            (
                "runnerId",
                if runner.truthy()? {
                    runner.get(c"runnerId")?
                } else {
                    runner
                },
            ),
            ("message", message),
        ],
    )?;
    call(
        s.get(c"ports")?.get(c"logger")?,
        c"error",
        &[text(s, event)?, context],
    )?;
    Ok(())
}

fn exception<'a>(s: L<'a>, error: napi::Error) -> Result<L<'a>> {
    s.exception_value()?.map(Ok).unwrap_or_else(|| {
        s.global()?
            .get(c"Error")?
            .construct(&[text(s, &error.reason)?])
    })
}

fn commit_final(s: L<'_>, durable: bool, persisted: bool) -> Result<()> {
    let ports = s.get(c"ports")?;
    if let Err(error) = commit_final_persist(
        ports,
        s.get(c"cs")?,
        s.get(c"session")?,
        s.get(c"event")?,
        s.get(c"message")?,
        s.get(c"forward")?,
        s.get(c"turn")?,
        s.get(c"runner")?,
        durable,
        persisted,
        s.get(c"wasMapped")?.is_true()?,
        ports,
    ) {
        log_error(s, "chat_final_persist_commit_failed", exception(s, error)?)?;
    }
    Ok(())
}

fn final_write<'a>(owner: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let s = fields(
        owner,
        &[
            ("ports", owner.get(c"ports")?),
            ("pending", owner.get(c"pending")?),
            ("session", a[0]),
            ("cs", a[1]),
            ("turn", a[2]),
            ("runner", a[3]),
            ("message", a[4]),
            ("forward", a[6]),
            ("wasMapped", a[7]),
            ("event", a[8]),
            ("persisted", flag(owner, false)?),
        ],
    )?;
    let verdict = callback(s, 1, |s, a| {
        // durable 来自写入 Promise 的返回值，回执里的 persisted 独立记录实际落盘。
        let _ = a[0].get(c"durable")?;
        s.set(c"persisted", flag(s, a[0].get(c"persisted")?.is_true()?)?)?;
        s.from_value(&V::Undefined)
    })?;
    let write = owner
        .get(c"persist")?
        .call_plain(&[a[0], a[1], a[2], a[3], a[4], a[5], verdict]);
    let started = match write {
        Ok(value) if value.nullish()? => return s.from_value(&V::Undefined),
        Ok(value) => value,
        Err(error) => {
            log_error(s, "chat_final_persist_start_failed", exception(s, error)?)?;
            commit_final(s, false, false)?;
            return s.from_value(&V::Undefined);
        }
    };
    let success = callback(s, 1, |s, a| {
        let saved = a[0].is_true()?;
        commit_final(s, saved, s.get(c"persisted")?.is_true()?)?;
        flag(s, saved)
    })?;
    let failure = callback(s, 1, |s, a| {
        log_error(s, "chat_final_persist_failed", a[0])?;
        commit_final(s, false, s.get(c"persisted")?.is_true()?)?;
        flag(s, false)
    })?;
    let promise = call(s.global()?.get(c"Promise")?, c"resolve", &[started])?;
    let settled = call(promise, c"then", &[success, failure])?;
    let pending = s.get(c"pending")?;
    call(pending, c"set", &[a[3], settled])?;
    s.set(c"settled", settled)?;
    let cleanup = callback(s, 0, |s, _| {
        let pending = s.get(c"pending")?;
        let runner = s.get(c"runner")?;
        if call(pending, c"get", &[runner])?.equals(s.get(c"settled")?)? {
            call(pending, c"delete", &[runner])?;
        }
        s.from_value(&V::Undefined)
    })?;
    call(settled, c"then", &[cleanup, cleanup])?;
    s.from_value(&V::Undefined)
}

fn held_write<'a>(owner: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let started = owner.get(c"append")?.call_plain(&[a[0], a[1]])?;
    let s = fields(
        owner,
        &[
            ("ports", owner.get(c"ports")?),
            ("session", a[0]),
            ("row", a[2]),
            ("cs", a[3]),
            ("turn", a[4]),
            ("runner", a[5]),
        ],
    )?;
    let commit = |s: L<'_>, saved| {
        commit_held_answer(
            s.get(c"ports")?,
            s.get(c"cs")?,
            s.get(c"turn")?,
            s.get(c"runner")?,
            s.get(c"row")?,
            saved,
        )
    };
    let success = callback(s, 1, move |s, a| {
        if let Err(error) = commit(s, a[0].is_true()?) {
            log_error(s, "chat_held_answer_commit_failed", exception(s, error)?)?;
        }
        s.from_value(&V::Undefined)
    })?;
    let failure = callback(s, 1, move |s, a| {
        log_error(s, "chat_held_answer_failed", a[0])?;
        s.catch(|| commit(s, false))?;
        s.from_value(&V::Undefined)
    })?;
    let promise = call(s.global()?.get(c"Promise")?, c"resolve", &[started])?;
    call(promise, c"then", &[success, failure])?;
    flag(s, true)
}

#[napi]
pub fn chat_persist_completions(
    env: Env,
    ports: Unknown<'_>,
    persist: Unknown<'_>,
    append: Unknown<'_>,
) -> Result<sys::napi_value> {
    let ports = L::new(&env, ports);
    let owner = fields(
        ports,
        &[
            ("ports", ports),
            ("persist", L::new(&env, persist)),
            ("append", L::new(&env, append)),
            ("pending", ports.global()?.get(c"Map")?.construct(&[])?),
        ],
    )?;
    let wait = method(&env, owner, "awaitPendingFinalPersist", 2, 2, |s, a| {
        let pending = call(s.get(c"pending")?, c"get", &[a[1]])?;
        if pending.truthy()? {
            call(pending, c"catch", &[callback(s, 0, |s, _| flag(s, false))?])
        } else {
            call(s.global()?.get(c"Promise")?, c"resolve", &[flag(s, true)?])
        }
    })?;
    Ok(fields(
        owner,
        &[
            (
                "requestFinalPersist",
                method(&env, owner, "requestFinalPersist", 9, 9, final_write)?,
            ),
            (
                "requestHeldAnswerAppend",
                method(&env, owner, "requestHeldAnswerAppend", 6, 6, held_write)?,
            ),
            ("awaitPendingFinalPersist", wait),
        ],
    )?
    .raw())
}
