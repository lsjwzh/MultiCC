//! The process has closed and both output streams have drained. Replay the
//! original prepared invocation only if no work from this launch was visible.
use super::*;
use multicc_core::agy_stream::effort;

pub(super) fn retry(h: &Close<'_>, st: L<'_>) -> Result<bool> {
    if !st.get(c"agyEffortFlag")?.truthy()? {
        return Ok(false);
    }
    let pending = st.get(c"agyRejection")?;
    let diagnostic = pending.truthy()?
        || st.get(c"agyPlainRejection")?.truthy()?
        || (!h.ctx.get(c"code")?.is_number(0.)?
            && effort::unsupported(&st.get(c"stderrBuf")?.coerce_string()?.to_string_lossy()));
    if !diagnostic {
        return Ok(false);
    }

    let invocation = st.get(c"invocation")?;
    let mut args = Vec::new();
    invocation.get(c"args")?.for_each(|arg| {
        args.push(arg.coerce_string()?.to_string_lossy());
        Ok(())
    })?;
    let prepared = st.get(c"prepared")?;
    let opts = prepared.get(c"invocationEnvelope")?.get(c"spawnOpts")?;
    let key = opts
        .get(c"agyAccountKey")?
        .string()?
        .map(|s| s.to_string_lossy())
        .unwrap_or_else(|| multicc_core::agy_models::account_key(None));
    let effective = opts
        .get(c"effectiveModel")?
        .string()?
        .map(|s| s.to_string_lossy())
        .unwrap_or_default();
    let facts = call(h.ports.get(c"attemptRuntime")?, c"snapshot", &[h.session])?;
    let blocked = st.get(c"agyOutputObserved")?.truthy()?
        || h.ctx.get(c"signal")?.truthy()?
        || h.runner.get(c"killReason")?.truthy()?
        || h.turn.get(c"resultDurable")?.truthy()?
        || h.invoke(c"meaningfulTurnOutput", &[h.cs])?.truthy()?
        || h.invoke(c"turnHasSideEffects", &[h.cs])?.truthy()?
        || facts.optional(c"visibleOutputObserved")?.truthy()?
        || facts.optional(c"toolIntentObserved")?.truthy()?
        || facts.optional(c"sideEffectObserved")?.truthy()?;
    if let Some(args) = effort::recover(
        &args,
        &key,
        &effective,
        h.turn.get(c"agyEffortRetried")?.truthy()?,
        blocked,
    ) {
        let next = fields(st, &[])?;
        next.spread_from(prepared)?;
        let inv = fields(st, &[])?;
        inv.spread_from(invocation)?;
        let model = effort::flag_value(&args, "--model").unwrap_or("默认模型");
        let warning = text(
            st,
            &format!("该模型当前不接受思考强度参数，已自动改用 {model} 重试"),
        )?;
        inv.set(
            c"args",
            st.from_value(&V::Array(args.into_iter().map(V::from).collect()))?,
        )?;
        next.set(c"invocation", inv)?;
        h.turn.assign(c"agyEffortRetried", flag(st, true)?)?;
        if st
            .catch(|| {
                h.invoke(
                    c"spawnChat",
                    &[next, flag(st, true)?, h.runner.get(c"apiRetryAttempt")?],
                )
            })?
            .is_some()
        {
            h.warning(warning)?;
            return Ok(true);
        }
    }
    // A later step, a cancellation, or a failed respawn leaves the ordinary
    // failure path responsible for delivering the deferred diagnostic.
    h.runner.assign(c"adapterError", flag(st, true)?)?;
    if pending.truthy()? {
        st.get(c"applyAgyRejection")?.call_plain(&[pending])?;
    }
    Ok(false)
}
