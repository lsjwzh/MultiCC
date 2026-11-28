use super::*;

pub(super) fn run<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let (id, state, persisted, turn, runner, final_text) = (a[0], a[1], a[2], a[3], a[4], a[5]);
    let facts = default_object(a[6])?;
    let c = context(s, id, state, turn, runner)?;
    let i = input(c)?;
    for k in [
        c"interrupted",
        c"apiError",
        c"retryPlanned",
        c"handoffResumeFailure",
    ] {
        i.set(k, flag(s, facts.get(k)?.is_true()?)?)?;
    }
    i.set(c"sessionType", persisted.optional(c"type")?)?;
    i.set(c"finalText", final_text)?;
    let plan = call(s.get(c"coordinator")?, c"claimPostTurnPlan", &[i])?;
    let ports = s.get(c"ports")?;
    if !plan.get(c"ok")?.truthy()? {
        call(
            ports,
            c"logSuppressed",
            &[fields(
                s,
                &[
                    ("sessionId", id),
                    ("turnId", turn.optional(c"turnId")?),
                    ("runnerId", runner.optional(c"runnerId")?),
                    ("reason", plan.get(c"code")?),
                ],
            )?],
        )?;
        return flag(s, false);
    }
    c.set(c"owns", flag(s, true)?)?;
    let mut error = None;
    plan.get(c"effects")?.for_each(|effect| {
        let still_owns = c.get(c"owns")?.is_true()? && owns(c)?;
        c.set(c"owns", flag(s, still_owns)?)?;
        let kind = effect.get(c"type")?;
        if !still_owns
            && (kind.is_string("consume-cli-handoff")? || kind.is_string("turn-complete")?)
        {
            return Ok(());
        }
        let execute = || -> Result<L<'a>> {
            if kind.is_string("consume-cli-handoff")? {
                return call(ports, c"consumeHandoff", &[effect.get(c"sessionId")?]);
            }
            if kind.is_string("turn-complete")? {
                let completion = pick(effect, &[c"turnId", c"lineage", c"resultDurable"])?;
                let check = function(c, "isCurrentRunner", 0, 0, |c, _| {
                    flag(c, c.get(c"owns")?.is_true()? && owns(c)?)
                })?;
                define(
                    completion,
                    text(c, "isCurrentRunner")?,
                    fields(c, &[("value", check)])?,
                )?;
                return call(
                    ports,
                    c"emitTurnComplete",
                    &[effect.get(c"sessionId")?, state, completion],
                );
            }
            if kind.is_string("complete-dispatch")? {
                return call(
                    ports,
                    c"emitDispatchComplete",
                    &[
                        effect.get(c"operationId")?,
                        effect.get(c"sessionId")?,
                        effect.get(c"finalText")?,
                    ],
                );
            }
            if kind.is_string("gateway-turn-complete")? {
                return call(
                    ports,
                    c"emitGatewayComplete",
                    &[
                        effect.get(c"finalText")?,
                        effect.get(c"sessionId")?,
                        effect.get(c"turnId")?,
                        effect.get(c"requestId")?,
                    ],
                );
            }
            Err(napi::Error::from_reason(format!(
                "unsupported chat post-turn effect: {}",
                fold_string(kind)?
            )))
        };
        if let Err(e) = execute() {
            let cause = exception(c, e)?;
            if error.is_none() {
                error = Some(cause);
            }
        }
        Ok(())
    })?;
    if let Some(error) = error {
        return Err(error.throw_error());
    }
    if !c.get(c"owns")?.is_true()? || !owns(c)? {
        return flag(s, false);
    }
    if state.truthy()?
        && state.get(c"_continuationLineage")?.truthy()?
        && state
            .get(c"_continuationLineage")?
            .get(c"turnId")?
            .equals(turn.optional(c"turnId")?)?
    {
        state.assign(c"_continuationLineage", null(s)?)?;
    }
    flag(s, true)
}
