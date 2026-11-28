use super::*;

fn entry<'a>(owner: L<'a>, candidate: L<'a>) -> Result<L<'a>> {
    call(owner.get(c"health")?, c"get", &[read(candidate, c"id")?])
}
fn plan(owner: L<'_>) -> Result<L<'_>> {
    let candidates = owner.get(c"candidates")?;
    let cursor = owner.get(c"cursor")?.number()?;
    let len = read(candidates, c"length")?.number()?;
    let start = num(owner, cursor % len)?;
    owner.set(
        c"cursor",
        num(
            owner,
            (cursor + 1.) % read(candidates, c"length")?.number()?,
        )?,
    )?;
    let tail = call(candidates, c"slice", &[start])?;
    let head = call(candidates, c"slice", &[num(owner, 0.)?, start])?;
    let rotated = call(tail, c"concat", &[head])?;
    let available = function(owner, "", 1, 1, |p, a| {
        let until = read(entry(p, a[0])?, c"until")?.number()?;
        flag(p, until <= p.get(c"now")?.call_plain(&[])?.number()?)
    })?;
    let ready = call(rotated, c"filter", &[available])?;
    if read(ready, c"length")?.truthy()? {
        return Ok(ready);
    }
    let by_time = function(owner, "", 2, 2, |p, a| {
        num(
            p,
            read(entry(p, a[0])?, c"until")?.number()?
                - read(entry(p, a[1])?, c"until")?.number()?,
        )
    })?;
    let sorted = call(call(rotated, c"slice", &[])?, c"sort", &[by_time])?;
    call(sorted, c"slice", &[num(owner, 0.)?, num(owner, 2.)?])
}
fn punish<'a>(owner: L<'a>, candidate: L<'a>, err: L<'a>) -> Result<()> {
    let health = entry(owner, candidate)?;
    let failures = health.get(c"failures")?.number()? + 1.;
    health.set(c"failures", num(owner, failures)?)?;
    let message = if err.truthy()? && read(err, c"message")?.truthy()? {
        read(err, c"message")?
    } else {
        string(err)?
    };
    health.set(c"lastError", message)?;
    let mut refused = false;
    if err.truthy()? {
        for code in [429., 403., 402., 451.] {
            if read(err, c"status")?.is_number(code)? {
                refused = true;
                break;
            }
        }
    }
    let wait = if refused {
        900_000.
    } else {
        (30_000. * 2.0f64.powf(failures - 1.)).min(600_000.)
    };
    let now = crate::message_composer::default_primitive(owner.get(c"now")?.call_plain(&[])?)?;
    let until = if now.kind()? == sys::ValueType::napi_string {
        call(now, c"concat", &[num(owner, wait)?])?
    } else {
        num(owner, now.number()? + wait)?
    };
    health.set(c"until", until)
}
fn error_from<'a>(p: L<'a>, err: napi::Error) -> Result<L<'a>> {
    if let Some(thrown) = p.exception_value()? {
        Ok(thrown)
    } else {
        error_value(p, &err.reason)
    }
}
fn success<'a>(step: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let owner = step.get(c"owner")?;
    let candidate = step.get(c"current")?;
    let health = entry(owner, candidate)?;
    health.set(c"failures", num(step, 0.)?)?;
    health.set(c"until", num(step, 0.)?)?;
    health.set(c"lastError", null(step)?)?;
    fields(step, &[("ip", a[0]), ("source", read(candidate, c"id")?)])
}
fn failed<'a>(step: L<'a>, reason: L<'a>) -> Result<()> {
    step.set(c"lastError", reason)?;
    if step.get(c"record")?.truthy()? {
        punish(step.get(c"owner")?, step.get(c"current")?, reason)?;
    }
    Ok(())
}
fn advance(step: L<'_>) -> Result<L<'_>> {
    let owner = step.get(c"owner")?;
    let order = step.get(c"order")?;
    loop {
        let index = step.get(c"index")?.number()? as u32;
        if index as f64 >= read(order, c"length")?.number()? {
            let last = step.get(c"lastError")?;
            let failure = if last.truthy()? {
                last
            } else {
                error_value(step, "no candidates")?
            };
            return Err(failure.throw_error());
        }
        let candidate = order.element(index)?;
        step.set(c"index", num(step, f64::from(index) + 1.)?)?;
        step.set(c"current", candidate)?;
        // A synchronously throwing fetcher stays inside the pass's try/catch.
        // A returned thenable is awaited before advancing to the next service.
        match owner
            .get(c"fetcher")?
            .call_plain(&[candidate, step.get(c"family")?])
        {
            Ok(result) => {
                let committed = then(result, step, success)?;
                return recover(committed, step, |step, a| {
                    failed(step, a[0])?;
                    advance(step)
                });
            }
            Err(error) => {
                let reason = error_from(step, error)?;
                failed(step, reason)?;
            }
        }
    }
}
fn pass<'a>(owner: L<'a>, order: L<'a>, family: u8, record: bool) -> Result<L<'a>> {
    async_result(owner, || {
        let order = call(
            order,
            c"slice",
            &[num(owner, 0.)?, owner.get(c"maxAttempts")?],
        )?;
        let state = fields(
            owner,
            &[
                ("owner", owner),
                ("order", order),
                ("index", num(owner, 0.)?),
                ("family", num(owner, family.into())?),
                ("record", flag(owner, record)?),
                ("lastError", null(owner)?),
            ],
        )?;
        advance(state)
    })
}
fn retry<'a>(retry: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let owner = retry.get(c"owner")?;
    retry.set(c"firstError", args[0])?;
    let order = call(
        retry.get(c"order")?,
        c"slice",
        &[num(owner, 0.)?, num(owner, 2.)?],
    )?;
    recover(pass(owner, order, 0, false)?, retry, |retry, a| {
        let last = if a[0].truthy()? {
            a[0]
        } else {
            retry.get(c"firstError")?
        };
        let why = if last.truthy()? {
            read(last, c"message")?
        } else {
            text(retry, "unknown")?
        };
        let message = call(
            text(retry, "all egress-ip candidates failed (")?,
            c"concat",
            &[why, text(retry, ")")?],
        )?;
        let err = retry.global()?.get(c"Error")?.construct(&[message])?;
        err.set(c"code", text(retry, "EGRESS_IP_DETECT_FAILED")?)?;
        Err(err.throw_error())
    })
}
fn detect<'a>(owner: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(owner, || {
        let order = plan(owner)?;
        let context = fields(owner, &[("owner", owner), ("order", order)])?;
        recover(pass(owner, order, 4, true)?, context, retry)
    })
}
fn snapshot<'a>(owner: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let at = owner.get(c"now")?.call_plain(&[])?;
    let ctx = fields(owner, &[("owner", owner), ("at", at)])?;
    let read_health = function(ctx, "", 1, 1, |ctx, a| {
        let candidate = a[0];
        let health = entry(ctx.get(c"owner")?, candidate)?;
        let until = health.get(c"until")?.number()?;
        let at = ctx.get(c"at")?.number()?;
        let delta = until - at;
        fields(
            ctx,
            &[
                ("id", read(candidate, c"id")?),
                ("failures", health.get(c"failures")?),
                ("coolingDown", flag(ctx, until > at)?),
                (
                    "retryInMs",
                    num(ctx, if delta.is_nan() { delta } else { delta.max(0.) })?,
                ),
                ("lastError", health.get(c"lastError")?),
            ],
        )
    })?;
    call(owner.get(c"candidates")?, c"map", &[read_health])
}
pub(super) fn create<'a>(module: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let candidates = option(opts, c"candidates", || module.get(c"candidates"))?;
    let fetcher = option(opts, c"fetcher", || module.get(c"fetch"))?;
    let clock = option(opts, c"now", || module.global()?.get(c"Date")?.get(c"now"))?;
    let max = option(opts, c"maxAttempts", || num(module, 4.))?;
    let init = function(module, "", 1, 1, |p, a| {
        let pair = array(p)?;
        pair.set_element(0, read(a[0], c"id")?)?;
        pair.set_element(
            1,
            fields(
                p,
                &[
                    ("failures", num(p, 0.)?),
                    ("until", num(p, 0.)?),
                    ("lastError", null(p)?),
                ],
            )?,
        )?;
        Ok(pair)
    })?;
    let entries = call(candidates, c"map", &[init])?;
    let health = module.global()?.get(c"Map")?.construct(&[entries])?;
    let owner = fields(
        module,
        &[
            ("candidates", candidates),
            ("fetcher", fetcher),
            ("now", clock),
            ("maxAttempts", max),
            ("health", health),
            ("cursor", num(module, 0.)?),
        ],
    )?;
    methods(owner, &[("detect", 0, detect), ("snapshot", 0, snapshot)])
}
