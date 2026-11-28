use super::*;

fn transition<'a>(s: L<'a>, session: L<'a>, status: &str) -> Result<()> {
    let value = fields(
        s,
        &[("status", text(s, status)?), ("currentFile", null(s)?)],
    )?;
    port(s, c"setSessionStatus", &[session, value])?;
    Ok(())
}

fn fire<'a>(frame: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let s = frame.get(c"host")?;
    let session = frame.get(c"sessionName")?;
    let cs = frame.get(c"cs")?;
    cs.assign(c"_apiRetryTimer", null(s)?)?;
    let deleted = !call(s.get(c"persistedSessions")?, c"has", &[session])?.truthy()?;
    let cancelled = port(s, c"isShuttingDown", &[])?.truthy()?
        || deleted
        || !port(
            s,
            c"isCurrentTurnRunner",
            &[cs, frame.get(c"turn")?, frame.get(c"runner")?],
        )?
        .truthy()?;
    let info = || {
        fields(
            s,
            &[
                ("sessionId", session),
                ("provider", frame.get(c"provider")?),
                ("attempt", frame.get(c"decision")?.get(c"attempt")?),
            ],
        )
    };
    if cancelled {
        let data = info()?;
        let reason = if port(s, c"isShuttingDown", &[])?.truthy()? {
            "shutdown"
        } else if deleted {
            "session_deleted"
        } else {
            "superseded"
        };
        data.set(c"reason", text(s, reason)?)?;
        call(
            s.get(c"logger")?,
            c"info",
            &[text(s, "api_error_retry_cancelled")?, data],
        )?;
    } else {
        cs.assign(c"currentAssistantText", text(s, "")?)?;
        cs.assign(c"currentToolCalls", array(s)?)?;
        cs.assign(c"_resultSaved", flag(s, false)?)?;
        cs.assign(c"_adapterError", null(s)?)?;
        cs.assign(c"_sawApiError", flag(s, false)?)?;
        cs.assign(c"_codexTransportError", text(s, "")?)?;
        call(s.get(c"replay")?, c"clear", &[session])?;
        transition(s, session, "thinking")?;
        call(
            s.get(c"logger")?,
            c"info",
            &[text(s, "api_error_retry_started")?, info()?],
        )?;
        frame.get(c"start")?.call_plain(&[])?;
    }
    undef(s)
}
pub(super) fn schedule<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let frame = pick(
        a[0],
        &[
            c"sessionName",
            c"cs",
            c"persisted",
            c"turn",
            c"runner",
            c"decision",
            c"provider",
            c"start",
        ],
    )?;
    frame.set(c"host", s)?;
    let cs = frame.get(c"cs")?;
    let session = frame.get(c"sessionName")?;
    let decision = frame.get(c"decision")?;
    let delay = decision.get(c"delayMs")?.explicit_number()?.max(0.);
    frame
        .get(c"runner")?
        .assign(c"retryPlanned", flag(s, true)?)?;
    cs.assign(c"_apiRetryAttempt", decision.get(c"attempt")?)?;
    cs.assign(c"isStreaming", flag(s, true)?)?;
    port(s, c"clearIncrementalSave", &[session])?;
    transition(s, session, "waiting")?;
    let timer = port(
        s,
        c"setTimeout",
        &[function(frame, "", 0, 0, fire)?, num(s, delay)?],
    )?;
    cs.assign(c"_apiRetryTimer", timer)?;
    if cs.get(c"_apiRetryTimer")?.truthy()? && callable(cs.get(c"_apiRetryTimer")?.get(c"unref")?)?
    {
        call(cs.get(c"_apiRetryTimer")?, c"unref", &[])?;
    }
    undef(s)
}
pub(super) fn cancel<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let cs = a[1];
    if !cs.optional(c"_apiRetryTimer")?.truthy()? {
        return flag(s, false);
    }
    port(s, c"clearTimeout", &[cs.get(c"_apiRetryTimer")?])?;
    cs.assign(c"_apiRetryTimer", null(s)?)?;
    flag(s, true)
}
