//! Classification over the live session maps. Each factory owns its own scan
//! history. The queue and transcript belong to the host and are read on demand.
mod attribution;
mod dispatch;
mod outcome;
mod ports;
mod task;
mod transcript;
mod turn;
mod verdict;
use crate::{host_methods::method, route_response::*};
use multicc_core::{js::JsString, session_delivery::SYSTEM_PREFIX};
use napi_derive::napi;

const MAX_QUEUE: usize = 20;
const INTERVAL: usize = 60_000;
const RETHROTTLE: usize = 2 * INTERVAL;
const MAX_PASSES: usize = 100;
const MAX_DECISIONS: usize = 400;

fn trimmed(value: L<'_>) -> Result<JsString> {
    Ok(string(fallback(value, "".into())?)?.coerce_string()?.trim())
}
fn system_message(value: &JsString) -> bool {
    value
        .as_units()
        .iter()
        .copied()
        .take(SYSTEM_PREFIX.encode_utf16().count())
        .eq(SYSTEM_PREFIX.encode_utf16())
}
fn junk(goal: &JsString) -> bool {
    let units = goal.as_units();
    goal.is_empty()
        || system_message(goal)
        || units.starts_with(&[60])
        || units.starts_with(&[34, 60])
}
fn resolved(value: L<'_>) -> Result<bool> {
    let goal = trimmed(value)?;
    Ok(!junk(&goal) && goal != JsString::from("新任务"))
}
fn voice<'a>(code: L<'a>, goal: L<'a>) -> Result<L<'a>> {
    let out = code;
    let (code, goal) = (trimmed(code)?, trimmed(goal)?);
    let mut message = JsString::new();
    if !code.is_empty() {
        message.push_str("任务 ");
        message.push(&code);
        message.push_str("，");
    }
    if !goal.is_empty() {
        message.push(&goal);
        message.push_str("，");
    }
    message.push_str("本轮执行成功");
    out.from_value(&V::String(message))
}

fn now(v: L<'_>) -> Result<L<'_>> {
    call(v.global()?.get(c"Date")?, c"now", &[])
}
fn array(v: L<'_>) -> Result<L<'_>> {
    v.from_value(&V::Array(Vec::new()))
}
fn new_task(goal: L<'_>) -> Result<L<'_>> {
    fields(
        goal,
        &[
            ("goal", fallback(goal, "新任务".into())?),
            ("startedAt", now(goal)?),
            ("phase", text(goal, "planning")?),
            ("steps", array(goal)?),
            ("pendingDispatches", array(goal)?),
            ("turnSeq", num(goal, 0.0)?),
        ],
    )
}
fn note<'a>(
    record: L<'a>,
    sid: L<'a>,
    cls: L<'a>,
    decision: &str,
    reason: Option<L<'a>>,
) -> Result<()> {
    let cls = if cls.nullish()? { null(cls)? } else { cls };
    let item = fields(
        record,
        &[
            ("sid", sid),
            ("classifyState", cls),
            ("decision", text(record, decision)?),
        ],
    )?;
    if let Some(reason) = reason {
        if reason.truthy()? {
            item.set(c"reason", reason)?;
        }
    }
    call(record.get(c"decisions")?, c"push", &[item])?;
    Ok(())
}
fn append_pass<'a>(history: L<'a>, record: L<'a>) -> Result<()> {
    let seq = num(history, history.get(c"seq")?.number()? + 1.)?;
    history.set(c"seq", seq)?;
    record.set(c"pass", seq)?;
    let decisions = record.get(c"decisions")?;
    if decisions.truthy()? && decisions.get(c"length")?.number()? > MAX_DECISIONS as f64 {
        record.set(
            c"decisions",
            call(
                decisions,
                c"slice",
                &[num(record, 0.)?, num(record, MAX_DECISIONS as f64)?],
            )?,
        )?;
        record.set(c"decisionsTruncated", flag(record, true)?)?;
    }
    let passes = history.get(c"passes")?;
    call(passes, c"unshift", &[record])?;
    if passes.get(c"length")?.number()? > MAX_PASSES as f64 {
        call(passes, c"pop", &[])?;
    }
    Ok(())
}
fn queue(p: L<'_>) -> Result<L<'_>> {
    p.get(c"getAuxQueue")?.call_plain(&[])
}
fn queue_length(p: L<'_>) -> Result<L<'_>> {
    queue(p)?.get(c"queue")?.get(c"length")
}
fn latest_reply<'a>(p: L<'a>, sid: L<'a>) -> Result<L<'a>> {
    let result = p.catch(|| {
        let rows = p.get(c"viewChatHistory")?.call_plain(&[sid])?;
        for i in (0..rows.get(c"length")?.number()? as u32).rev() {
            let m = rows.element(i)?;
            if m.get(c"role")?.is_string("assistant")?
                && m.get(c"content")?.kind()? == sys::ValueType::napi_string
                && m.get(c"content")?.get(c"length")?.number()? >= 20.
            {
                return m.get(c"content");
            }
        }
        text(p, "")
    })?;
    result.map_or_else(|| text(p, ""), Ok)
}
fn candidate<'a>(
    p: L<'a>,
    record: L<'a>,
    sid: L<'a>,
    session: L<'a>,
    time: f64,
) -> Result<Option<L<'a>>> {
    if !session.truthy()?
        || session.get(c"type")?.is_string("aux")?
        || session.get(c"type")?.is_string("gateway")?
        || !session.get(c"kind")?.is_string("chat")?
    {
        return Ok(None);
    }
    let state = p.get(c"getTaskState")?.call_plain(&[session])?;
    let skip = |key: &str, reason: L<'a>| {
        note(record, sid, state.get(c"classifyState")?, key, Some(reason))?;
        Ok(None)
    };
    if state.get(c"classifyState")?.is_string("E")? && state.get(c"cancelledAt")?.truthy()? {
        return skip(
            "skipped-cancelled",
            text(
                p,
                "explicit cancellation remains authoritative until next user turn",
            )?,
        );
    }
    call(p.get(c"chatSessions")?, c"get", &[sid])?;
    let live = turn::liveness(p, sid)?;
    if live.get(c"state")?.is_string("unknown")? {
        return skip("skipped-unknown-liveness", live.get(c"reason")?);
    }
    if live.get(c"state")?.is_string("active")?
        && resolved(state.get(c"goal")?)?
        && !state.get(c"taskIdentityPending")?.is_true()?
    {
        return skip(
            "skipped-live-runner",
            text(p, "owned provider turn + goal already resolved")?,
        );
    }
    let history = state.get(c"classifyHistory")?;
    let last_at = if history.is_array()? && history.get(c"length")?.truthy()? {
        history
            .element(history.get(c"length")?.number()? as u32 - 1)?
            .get(c"at")?
    } else {
        num(p, 0.)?
    };
    if last_at.truthy()? {
        let elapsed = time - last_at.number()?;
        if elapsed < RETHROTTLE as f64
            && last_at.number()? >= fallback(state.get(c"startedAt")?, 0.0.into())?.number()?
        {
            let seconds =
                call(num(p, elapsed / 1000.)?, c"toFixed", &[num(p, 0.)?])?.coerce_string()?;
            return skip(
                "skipped-throttle",
                text(
                    p,
                    &format!(
                        "judged {}s ago (< {}s)",
                        seconds.as_str_lossy(),
                        RETHROTTLE / 1000
                    ),
                )?,
            );
        }
    }
    if call(queue(p)?, c"hasPendingFor", &[sid])?.truthy()? {
        return skip("skipped-dedup", text(p, "already queued or in-flight")?);
    }
    let reply = latest_reply(p, sid)?;
    if reply.get(c"length")?.number()? < 20. {
        return skip(
            "skipped-no-reply",
            text(p, "no assistant reply ≥ 20 chars")?,
        );
    }
    let mut reference = state.get(c"lastTurnEndedAt")?;
    if !reference.truthy()? {
        reference = state.get(c"lastSummaryAt")?;
    }
    if !reference.truthy()? && session.get(c"lastActivity")?.truthy()? {
        let date = p
            .global()?
            .get(c"Date")?
            .construct(&[session.get(c"lastActivity")?])?;
        reference = call(date, c"getTime", &[])?;
    }
    if !reference.truthy()? {
        reference = fallback(last_at, 0.0.into())?;
    }
    if resolved(state.get(c"goal")?)? && !state.get(c"taskIdentityPending")?.is_true()? {
        return skip(
            "skipped-goal-resolved",
            text(p, "task identity already resolved")?,
        );
    }
    Ok(Some(fields(
        p,
        &[
            ("sid", sid),
            ("reply", reply),
            ("ref", reference),
            ("classifyState", state.get(c"classifyState")?),
        ],
    )?))
}

fn scan(p: L<'_>) -> Result<L<'_>> {
    let ports = p.get(c"ports")?;
    let record = fields(
        p,
        &[
            ("ts", now(p)?),
            ("queueLen", queue_length(ports)?),
            ("maxQueue", num(p, MAX_QUEUE as f64)?),
            ("fullSkip", flag(p, false)?),
            ("considered", num(p, 0.)?),
            ("enqueued", num(p, 0.)?),
            ("decisions", array(p)?),
        ],
    )?;
    let history = p.get(c"history")?;
    let log = |message: String| call(p.global()?.get(c"console")?, c"log", &[text(p, &message)?]);
    if queue_length(ports)?.number()? >= MAX_QUEUE as f64 {
        record.set(c"fullSkip", flag(p, true)?)?;
        append_pass(history, record)?;
        log(format!(
            "[multicc/scan] queue backed up ({}) - skip this round",
            queue_length(ports)?.coerce_string()?.as_str_lossy()
        ))?;
    } else {
        let time = now(p)?.number()?;
        let candidates = array(p)?;
        ports.get(c"persistedSessions")?.for_each(|pair| {
            if let Some(row) = candidate(ports, record, pair.element(0)?, pair.element(1)?, time)? {
                call(candidates, c"push", &[row])?;
            }
            Ok(())
        })?;
        // V8's stable sort preserves the existing NaN, coercion and tie semantics.
        call(candidates, c"sort", &[p.get(c"byActivity")?])?;
        let count = candidates.get(c"length")?;
        record.set(c"considered", count)?;
        let mut enqueued = 0;
        for i in 0..count.number()? as u32 {
            let row = candidates.element(i)?;
            let sid = row.get(c"sid")?;
            let cls = row.get(c"classifyState")?;
            if queue_length(ports)?.number()? >= MAX_QUEUE as f64 {
                note(
                    record,
                    sid,
                    cls,
                    "skipped-queue-full",
                    Some(text(
                        p,
                        &format!("SCAN_MAX_QUEUE ({MAX_QUEUE}) reached mid-loop"),
                    )?),
                )?;
            } else {
                attribution::enqueue_scan(ports, sid, row.get(c"reply")?)?;
                note(record, sid, cls, "enqueued", None)?;
                enqueued += 1;
            }
        }
        record.set(c"enqueued", num(p, enqueued as f64)?)?;
        append_pass(history, record)?;
        if enqueued > 0 {
            log(format!(
                "[multicc/scan] enqueued {enqueued} session(s) for task attribution (newest first)"
            ))?;
        }
    }
    p.from_value(&V::Undefined)
}
#[napi]
pub fn create_classify_state_machine(
    env: Env,
    deps: Unknown<'_>,
    host: Unknown<'_>,
) -> Result<sys::napi_value> {
    let ports = ports::prepare(&env, L::new(&env, deps), L::new(&env, host))?;
    let history = fields(
        ports,
        &[("seq", num(ports, 0.)?), ("passes", array(ports)?)],
    )?;
    let push = method(&env, history, "push", 1, 1, |h, args| {
        append_pass(h, args[0])?;
        h.from_value(&V::Undefined)
    })?;
    history.set(c"push", push)?;
    let by_activity = method(&env, history, "byActivity", 2, 2, |p, a| {
        let right = fallback(a[1].get(c"ref")?, 0.0.into())?;
        let left = fallback(a[0].get(c"ref")?, 0.0.into())?;
        num(p, right.number()? - left.number()?)
    })?;
    let owner = fields(
        ports,
        &[
            ("ports", ports),
            ("history", history),
            ("byActivity", by_activity),
        ],
    )?;
    Ok(fields(
        ports,
        &[
            ("scanHistory", history),
            (
                "dispatchStateAction",
                method(&env, ports, "dispatchStateAction", 2, 2, |p, a| {
                    dispatch::dispatch(p, a[0], a[1])
                })?,
            ),
            (
                "emitTurnOutcome",
                method(&env, ports, "emitTurnOutcome", 2, 2, |p, a| {
                    outcome::emit(p, a[0], a[1])
                })?,
            ),
            (
                "ensureCurrentTask",
                method(&env, ports, "ensureCurrentTask", 3, 5, |p, a| {
                    task::ensure(p, a[0], a[1], a[2], a[3], a[4])
                })?,
            ),
            (
                "applyTaskAttributionResult",
                method(&env, ports, "applyTaskAttributionResult", 3, 4, |p, a| {
                    attribution::apply(p, a[0], a[1], a[2], a[3])
                })?,
            ),
            (
                "buildClassifyConversation",
                method(&env, ports, "buildClassifyConversation", 2, 2, |p, a| {
                    attribution::conversation(p, a[0], a[1])
                })?,
            ),
            (
                "runClassifyNow",
                method(&env, ports, "runClassifyNow", 2, 3, |p, a| {
                    attribution::run(p, a[0], a[1], a[2])
                })?,
            ),
            ("STUCK_STREAM_MS", null(ports)?),
            (
                "applyClassifyResult",
                method(&env, ports, "applyClassifyResult", 4, 5, |p, a| {
                    verdict::apply(p, a[0], a[1], a[2], a[3], a[4])
                })?,
            ),
            (
                "recordTaskBoardGoal",
                method(&env, ports, "recordTaskBoardGoal", 4, 5, |p, a| {
                    verdict::board_goal(p, a[0], a[1], a[2], a[3], a[4])
                })?,
            ),
            (
                "emitRunningNotify",
                method(&env, ports, "emitRunningNotify", 2, 2, |p, a| {
                    verdict::running(p, a[0], a[1])
                })?,
            ),
            (
                "classifyTurnEnd",
                method(&env, ports, "classifyTurnEnd", 2, 3, |p, a| {
                    turn::end(p, a[0], a[1], a[2])
                })?,
            ),
            (
                "cancelClassify",
                method(&env, ports, "cancelClassify", 1, 1, |_, a| {
                    turn::cancel(a[0])
                })?,
            ),
            ("SCAN_INTERVAL_MS", num(ports, INTERVAL as f64)?),
            ("SCAN_MAX_QUEUE", num(ports, MAX_QUEUE as f64)?),
            ("SCAN_RETHROTTLE_MS", num(ports, RETHROTTLE as f64)?),
            ("SCAN_HISTORY_MAX_PASSES", num(ports, MAX_PASSES as f64)?),
            (
                "SCAN_HISTORY_MAX_DECISIONS",
                num(ports, MAX_DECISIONS as f64)?,
            ),
            (
                "scanAndReclassify",
                method(&env, owner, "scanAndReclassify", 0, 0, |p, _| scan(p))?,
            ),
            (
                "newCurrentTask",
                method(&env, owner, "newCurrentTask", 1, 1, |_, a| new_task(a[0]))?,
            ),
            (
                "isSystemInjectedMsg",
                method(&env, owner, "isSystemInjectedMsg", 1, 1, |p, a| {
                    flag(p, system_message(&trimmed(a[0])?))
                })?,
            ),
            (
                "isGoalResolved",
                method(&env, owner, "isGoalResolved", 1, 1, |p, a| {
                    flag(p, resolved(a[0])?)
                })?,
            ),
            (
                "isInjectedOrJunkGoal",
                method(&env, owner, "isInjectedOrJunkGoal", 1, 1, |p, a| {
                    flag(p, junk(&trimmed(a[0])?))
                })?,
            ),
        ],
    )?
    .raw())
}
