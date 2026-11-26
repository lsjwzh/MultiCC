//! The immediate turn outcome updates display and timestamps. Classification
//! retains ownership of the verdict and emits the eventual completion notice.
use super::*;

fn timestamps(p: L<'_>) -> Result<L<'_>> {
    fields(p, &[("lastTurnEndedAt", now(p)?), ("endedAt", now(p)?)])
}
pub(super) fn emit<'a>(p: L<'a>, name: L<'a>, outcome: L<'a>) -> Result<L<'a>> {
    let status = outcome.get(c"status")?;
    let notification = outcome.get(c"notifyState")?;
    let mut msg = outcome.get(c"message")?;
    let alert = outcome.get(c"alert")?;
    let row = call(p.get(c"persistedSessions")?, c"get", &[name])?;
    let done = || p.from_value(&V::Undefined);
    if !row.truthy()? {
        return done();
    }
    let id = row.get(c"id")?;
    let id = if id.truthy()? { id } else { name };
    let update = p.get(c"setTaskState")?;
    let signals = p.get(c"getUserInputSignalHost")?.call_plain(&[])?;
    if call(signals, c"pending", &[name])?.truthy()? {
        update.call_plain(&[name, timestamps(p)?])?;
        return done();
    }
    if status.is_string("succeeded")? {
        let cs = call(p.get(c"chatSessions")?, c"get", &[name])?;
        let task = cs.optional(c"currentTask")?;
        let goal = task.optional(c"goal")?;
        let goal = if goal.truthy()? {
            goal
        } else {
            fallback(cs.optional(c"currentTaskName")?, "".into())?
        };
        if task.truthy()? {
            task.assign(c"phase", text(p, "done")?)?;
        }
        let mut label = trimmed(msg)?;
        if label.is_empty() {
            label.push_str("执行成功");
        }
        let subject = if goal.truthy()? {
            goal
        } else {
            let summaries = p.get(c"getSessionSummaries")?.call_plain(&[])?;
            let raw = fallback(
                call(summaries, c"get", &[id])?.optional(c"summary")?,
                "".into(),
            )?;
            let re = p.global()?.get(c"RegExp")?;
            let strip = |v: L<'a>, pattern: &str| {
                call(
                    v,
                    c"replace",
                    &[re.construct(&[text(p, pattern)?])?, text(p, "")?],
                )
            };
            let subject = strip(
                raw,
                r"^(正在处理：|处理中：|执行成功：|任务完成：|已完成：)",
            )?;
            call(strip(subject, r"\s*[·—]\s*.+$")?, c"trim", &[])?
        };
        if subject.truthy()? {
            label.push_str("：");
            label.push(&subject.coerce_string()?);
            msg = p.from_value(&V::String(label))?;
        }
    }
    p.get(c"setSessionStatus")?.call_plain(&[
        name,
        fields(p, &[("status", status), ("currentFile", null(p)?)])?,
    ])?;
    update.call_plain(&[
        name,
        timestamps(p)?,
        fields(p, &[("save", flag(p, false)?)])?,
    ])?;
    p.get(c"setSessionSummary")?.call_plain(&[id, msg])?;
    if alert.truthy()? {
        let mut push = JsString::from("[Chat] ");
        push.push(&msg.coerce_string()?);
        p.get(c"triggerPush")?
            .call_plain(&[id, notification, p.from_value(&V::String(push))?])?;
        let notice = || {
            fields(
                p,
                &[
                    ("type", text(p, "notify")?),
                    ("state", notification),
                    ("message", msg),
                ],
            )
        };
        p.get(c"chatBroadcast")?.call_plain(&[name, notice()?])?;
        if row.get(c"dirId")?.truthy()? {
            let event = notice()?;
            event.set(c"sessionId", id)?;
            p.get(c"workspaceBroadcast")?
                .call_plain(&[row.get(c"dirId")?, event])?;
        }
    }
    done()
}
