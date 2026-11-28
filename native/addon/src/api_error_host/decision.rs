//! Keep attempt-specific correlation on the live event and stable fields in task state.
use super::*;
use crate::host_methods::{arg, env, raw};
mod notices;

fn proxy_failure<'a>(s: L<'a>, runner: L<'a>) -> Result<L<'a>> {
    let result = s.catch(|| {
        let attempt = runner.optional(c"providerAttempt")?;
        let lookup = s.get(c"proxyFailureForAttempt")?;
        if attempt.truthy()? && !lookup.nullish()? {
            lookup.call_plain(&[runner.get(c"providerAttempt")?])
        } else {
            null(s)
        }
    })?;
    otherwise(result.unwrap_or(null(s)?), null(s)?)
}

fn with_rejection<'a>(raw: L<'a>, failure: L<'a>) -> Result<L<'a>> {
    if !object(raw)?
        || !raw.get(c"rejection")?.nullish()?
        || !failure.truthy()?
        || !failure.get(c"httpStatus")?.is_number(429.)?
    {
        return Ok(raw);
    }
    let rejection = crate::api_error_text::normalize_rejection(failure.get(c"rejection")?)?;
    if !rejection.truthy()? {
        return Ok(raw);
    }
    let nested = if raw.get(c"error")?.truthy()? && object(raw.get(c"error")?)? {
        raw.get(c"error")?
    } else {
        fields(raw, &[])?
    };
    let mut has_status = false;
    for source in [raw, nested] {
        for key in [c"httpStatus", c"statusCode", c"status"] {
            has_status |= !source.get(key)?.nullish()?;
        }
    }
    let out = spread(raw)?;
    out.set(c"rejection", rejection)?;
    if !has_status {
        out.set(c"httpStatus", num(raw, 429.)?)?;
    }
    freeze(out)
}
fn policy_context<'a>(ctx: L<'a>, id: L<'a>, failure: L<'a>, elapsed: L<'a>) -> Result<L<'a>> {
    let raw = ctx.get(c"raw")?;
    let out = fields(ctx, &[("provider", id.get(c"cli")?)])?;
    for key in [
        c"cli",
        c"providerId",
        c"providerName",
        c"decisionId",
        c"runtimeEpoch",
        c"routeAttemptId",
        c"routeGeneration",
        c"attemptNo",
        c"providerRevision",
    ] {
        out.set(key, id.get(key)?)?;
    }
    out.set(
        c"providerRouteScope",
        if identity::complete(id)? {
            text(ctx, "attempt")?
        } else {
            null(ctx)?
        },
    )?;
    out.set(
        c"source",
        otherwise(raw.optional(c"source")?, text(ctx, "process_stderr")?)?,
    )?;
    out.set(c"proxyFailure", failure)?;
    out.set(c"sessionId", ctx.get(c"sessionName")?)?;
    out.set(c"turnId", ctx.get(c"turn")?.optional(c"turnId")?)?;
    for k in [c"attempt", c"phase"] {
        out.set(k, ctx.get(k)?)?;
    }
    let partial = ctx.get(c"partialOutput")?;
    out.set(
        c"partialOutput",
        if partial.truthy()? {
            partial
        } else {
            flag(ctx, raw.optional(c"partialOutput")?.is_true()?)?
        },
    )?;
    out.set(c"sideEffects", ctx.get(c"sideEffects")?)?;
    out.set(c"turnElapsedMs", elapsed)?;
    out.set(c"idempotencyKey", identity::idempotency(ctx, id)?)?;
    Ok(out)
}
fn safe_event<'a>(
    ctx: L<'a>,
    id: L<'a>,
    decision: L<'a>,
    elapsed: L<'a>,
    at: L<'a>,
) -> Result<L<'a>> {
    let e = decision.get(c"error")?;
    let out = pick(e, &[c"category", c"provider"])?;
    for k in [c"providerId", c"providerName"] {
        out.set(k, otherwise(e.get(k)?, id.get(k)?)?)?;
    }
    if identity::complete(id)? {
        out.set(c"providerRouteScope", text(ctx, "attempt")?)?;
        for k in identity::ROUTE_KEYS {
            let value = e.get(k)?;
            let present = if k == c"routeGeneration" || k == c"attemptNo" {
                !value.nullish()?
            } else {
                value.truthy()?
            };
            let mut v = if present { value } else { id.get(k)? };
            if k == c"turnId" && !v.truthy()? {
                v = ctx.get(c"turn")?.optional(k)?;
            }
            out.set(k, v)?;
        }
    }
    for k in [
        c"code",
        c"httpStatus",
        c"retryable",
        c"safeToRetry",
        c"retryAfterMs",
        c"phase",
        c"partialOutput",
    ] {
        out.set(k, e.get(k)?)?;
    }
    out.set(
        c"attempt",
        otherwise(decision.get(c"attempt")?, ctx.get(c"attempt")?)?,
    )?;
    out.set(c"maxAttempts", e.get(c"maxAttempts")?)?;
    for key in [c"action", c"reason"] {
        out.set(key, decision.get(key)?)?;
    }
    out.set(
        c"retryAt",
        otherwise(decision.get(c"retryAt")?, null(ctx)?)?,
    )?;
    out.set(c"userAction", e.get(c"userAction")?)?;
    let cause = e.get(c"rootCause")?;
    let cause = if cause.truthy()? {
        cause
    } else {
        otherwise(e.get(c"sanitizedMessage")?, null(ctx)?)?
    };
    out.set(c"rootCause", cause)?;
    out.set(c"param", otherwise(e.get(c"param")?, null(ctx)?)?)?;
    out.set(c"turnElapsedMs", elapsed)?;
    out.set(
        c"budgetExhaustedBy",
        otherwise(decision.get(c"budgetExhaustedBy")?, null(ctx)?)?,
    )?;
    out.set(c"at", at)?;
    Ok(out)
}
pub(super) fn evaluate<'a>(s: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let ctx = pick(
        args[0],
        &[
            c"sessionName",
            c"cs",
            c"persisted",
            c"turn",
            c"runner",
            c"raw",
            c"attempt",
            c"phase",
            c"partialOutput",
            c"sideEffects",
            c"deferNotice",
        ],
    )?;
    if ctx.get(c"attempt")?.undefined()? {
        ctx.set(c"attempt", num(s, 0.)?)?;
    }
    let at = now(s)?;
    let cs = ctx.get(c"cs")?;
    let start = cs.optional(c"turnStartedAt")?.explicit_number()?;
    let elapsed = if start.is_finite() {
        let difference = at.explicit_number()? - cs.get(c"turnStartedAt")?.explicit_number()?;
        if difference.is_nan() {
            difference
        } else {
            difference.max(0.)
        }
    } else {
        0.
    };
    let elapsed = num(s, elapsed)?;
    let id = identity::of(ctx)?;
    let runner = ctx.get(c"runner")?;
    let failure = proxy_failure(s, runner)?;
    let effective = with_rejection(ctx.get(c"raw")?, failure)?;
    let context = policy_context(ctx, id, failure, elapsed)?;
    let decision = call(s.get(c"policy")?, c"evaluate", &[effective, context])?;
    if runner.truthy()? {
        runner.assign(c"apiErrorDecision", decision)?;
        runner.assign(c"apiErrorRaw", effective)?;
    }
    if cs.truthy()? {
        cs.assign(c"_lastApiErrorDecision", decision)?;
    }
    let safe = safe_event(ctx, id, decision, elapsed, at)?;
    let durable = spread(safe)?;
    durable.delete(c"providerRouteScope")?;
    for key in identity::ROUTE_KEYS {
        durable.delete(key)?;
    }
    set_task(s, ctx.get(c"sessionName")?, durable, true)?;
    if !decision.get(c"duplicate")?.truthy()? {
        notices::publish(s, ctx, id, decision, safe)?;
    }
    Ok(decision)
}
