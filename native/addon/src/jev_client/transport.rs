use super::*;

fn truth_or<'a>(value: L<'a>, base: L<'a>) -> Result<L<'a>> {
    Ok(if value.truthy()? { value } else { base })
}
fn string_override<'a>(v: L<'a>, base: L<'a>, limit: f64) -> Result<L<'a>> {
    if v.kind()? == sys::ValueType::napi_string {
        let trimmed = call(v, c"trim", &[])?;
        if trimmed.truthy()? {
            return slice(trimmed, limit);
        }
    }
    Ok(base)
}
fn threshold<'a>(options: L<'a>, base: L<'a>, key: &CStr) -> Result<L<'a>> {
    match ratio(options.optional(key)?)? {
        Some(n) => num(options, n),
        None => base.get(key),
    }
}
fn escalation<'a>(value: L<'a>, base: L<'a>) -> Result<L<'a>> {
    if !object(value)? {
        return Ok(base);
    }
    fields(
        base,
        &[
            ("minConfidence", threshold(value, base, c"minConfidence")?),
            (
                "minTierProbability",
                threshold(value, base, c"minTierProbability")?,
            ),
        ],
    )?
    .freeze()
}
fn elapsed(s: L<'_>) -> Result<L<'_>> {
    let n = now(s.get(c"client")?)?.explicit_number()? - s.get(c"startedAt")?.number()?;
    num(s, if n.is_nan() { n } else { n.max(0.) })
}
fn log<'a>(
    client: L<'a>,
    level: &CStr,
    event: &str,
    data: impl FnOnce() -> Result<L<'a>>,
) -> Result<()> {
    let logger = client.get(c"logger")?;
    let method = logger.get(level)?;
    if !method.nullish()? {
        method.call(logger, &[text(client, event)?, data()?])?;
    }
    Ok(())
}
fn cause(p: L<'_>, err: napi::Error) -> Result<L<'_>> {
    match p.exception_value()? {
        Some(e) => Ok(e),
        None => error_value(p, &err.reason),
    }
}
fn read_key<'a>(client: L<'a>, name: L<'a>) -> Result<L<'a>> {
    let resolve = client.get(c"resolve")?;
    if !resolve.truthy()? {
        return null(client);
    }
    let read = || -> Result<L<'a>> {
        let value = resolve.call_plain(&[name])?;
        if value.kind()? == sys::ValueType::napi_string && call(value, c"trim", &[])?.truthy()? {
            call(value, c"trim", &[])
        } else {
            null(client)
        }
    };
    match read() {
        Ok(v) => Ok(v),
        Err(e) => {
            let error = cause(client, e)?;
            log(client, c"warn", "jev_api_key_unavailable", || {
                let code = if error.truthy()? {
                    error.get(c"code")?
                } else {
                    error
                };
                fields(
                    client,
                    &[("code", fallback(code, "key_read_failed".into())?)],
                )
            })?;
            null(client)
        }
    }
}

fn delayed_failure<'a>(s: L<'a>, code: L<'a>) -> Result<L<'a>> {
    fields(
        s,
        &[
            ("ok", flag(s, false)?),
            ("code", code),
            ("latencyMs", elapsed(s)?),
        ],
    )?
    .freeze()
}
fn clear_timer(s: L<'_>) -> Result<L<'_>> {
    let timer = s.get(c"timer")?;
    if timer.truthy()? {
        s.global()?.get(c"clearTimeout")?.call_plain(&[timer])?;
    }
    undef(s)
}
fn request_failure<'a>(s: L<'a>, reason: L<'a>) -> Result<L<'a>> {
    clear_timer(s)?;
    let aborted = reason.truthy()?
        && (reason.get(c"name")?.is_string("AbortError")?
            || reason.get(c"code")?.is_string("ABORT_ERR")?);
    let code = text(
        s,
        if aborted {
            "jev_timeout"
        } else {
            "jev_network"
        },
    )?;
    log(s.get(c"client")?, c"warn", "jev_request_failed", || {
        fields(s, &[("code", code), ("latencyMs", elapsed(s)?)])
    })?;
    delayed_failure(s, code)
}
fn request_state<'a>(s: L<'a>, context: L<'a>) -> Result<L<'a>> {
    let input = coalesce(s.get(c"text")?, text(s, "")?)?;
    let state = fields(s, &[("request", slice(string(input)?, 8000.)?)])?;
    if object(context)? {
        let entries = call(s.global()?.get(c"Object")?, c"entries", &[context])?;
        entries.for_each(|entry| {
            let key = entry.element(0)?;
            let value = entry.element(1)?;
            if !key.is_string("request")? {
                match value.kind()? {
                    sys::ValueType::napi_string => state.set_key(key, slice(value, 500.)?)?,
                    sys::ValueType::napi_number | sys::ValueType::napi_boolean => {
                        state.set_key(key, value)?
                    }
                    _ => {}
                }
            }
            Ok(())
        })?;
    }
    Ok(state)
}
fn send<'a>(s: L<'a>, key: L<'a>, endpoint: L<'a>, controller: L<'a>) -> Result<L<'a>> {
    let client = s.get(c"client")?;
    let headers = fields(
        s,
        &[
            (
                "Authorization",
                call(text(s, "Bearer ")?, c"concat", &[key])?,
            ),
            ("Content-Type", text(s, "application/json")?),
            ("Accept", text(s, "application/json")?),
        ],
    )?;
    let body = fields(
        s,
        &[
            ("model", s.get(c"model")?),
            ("state", request_state(s, s.get(c"context")?)?),
            (
                "questions",
                questions(client.get(c"owner")?, s.get(c"ladder")?)?,
            ),
        ],
    )?;
    let init = fields(
        s,
        &[
            ("method", text(s, "POST")?),
            ("headers", headers),
            ("body", json_call(s, c"stringify", body)?),
            ("signal", controller.optional(c"signal")?),
        ],
    )?;
    client.get(c"fetch")?.call_plain(&[endpoint, init])
}
fn rejected_status(response: L<'_>) -> Result<L<'_>> {
    let n = response.get(c"status")?.explicit_number()?;
    num(response, if n.is_nan() || n == 0. { 0. } else { n })
}
fn finish<'a>(s: L<'a>, raw: L<'a>) -> Result<L<'a>> {
    let client = s.get(c"client")?;
    let payload = if raw.truthy()? {
        s.catch(|| json_call(s, c"parse", raw))?.unwrap_or(null(s)?)
    } else {
        null(s)?
    };
    let response = s.get(c"response")?;
    if !response.get(c"ok")?.truthy()? {
        let code = call(
            text(s, "jev_http_")?,
            c"concat",
            &[rejected_status(response)?],
        )?;
        let details = || {
            fields(
                s,
                &[
                    ("code", code),
                    ("status", rejected_status(response)?),
                    ("detail", answers::detail(payload)?),
                    ("latencyMs", elapsed(s)?),
                ],
            )
        };
        log(client, c"warn", "jev_request_rejected", details)?;
        let result = fields(s, &[("ok", flag(s, false)?)])?;
        result.spread_from(details()?)?;
        return result.freeze();
    }
    let answers = answers::read(payload)?;
    if answers.nullish()? {
        log(client, c"warn", "jev_bad_payload", || {
            fields(s, &[("latencyMs", elapsed(s)?)])
        })?;
        return delayed_failure(s, text(s, "jev_bad_payload")?);
    }
    let verdict = answers::verdict(
        s.get(c"ladder")?,
        s.get(c"effectiveEscalation")?,
        answers,
        payload,
    )?;
    if !verdict.get(c"ok")?.truthy()? {
        let code = verdict.get(c"code")?;
        log(client, c"warn", "jev_unreadable_answers", || {
            fields(s, &[("code", code), ("latencyMs", elapsed(s)?)])
        })?;
        return delayed_failure(s, code);
    }
    let result = spread(verdict)?;
    result.set(c"source", text(s, "jev")?)?;
    result.set(c"model", s.get(c"model")?)?;
    result.set(c"latencyMs", elapsed(s)?)?;
    result.freeze()?;
    log(client, c"info", "jev_verdict", || {
        pick(
            result,
            &[
                c"tier",
                c"reasonCode",
                c"escalated",
                c"confidence",
                c"complexityScore",
                c"latencyMs",
            ],
        )
    })?;
    Ok(result)
}
fn response<'a>(s: L<'a>, response: L<'a>) -> Result<L<'a>> {
    s.set(c"response", response)?;
    let body = match call(response, c"text", &[]) {
        Ok(v) => v,
        Err(e) => {
            let reason = cause(s, e)?;
            clear_timer(s)?;
            return Err(reason.throw_error());
        }
    };
    let parsed = then(body, s, |s, a| finish(s, a[0]))?;
    call(
        parsed,
        c"finally",
        &[function(s, "clearJevTimer", 0, 0, |s, _| clear_timer(s))?],
    )
}
fn classify<'a>(client: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(client, || {
        let input = default_object(args[0])?;
        let s = fields(client, &[("client", client)])?;
        for key in [
            c"text",
            c"tiers",
            c"apiKeyName",
            c"context",
            c"escalation",
            c"timeoutMs",
            c"model",
            c"endpoint",
        ] {
            s.set(key, input.get(key)?)?;
        }
        s.set(c"startedAt", now(client)?)?;
        let ladder = normalize(s.get(c"tiers")?)?;
        if !ladder.get(c"length")?.truthy()? {
            return delayed_failure(s, text(s, "jev_no_tiers")?);
        }
        let key = read_key(client, s.get(c"apiKeyName")?)?;
        if !key.truthy()? {
            return delayed_failure(s, text(s, "jev_key_missing")?);
        }
        let budget = match number_or_none(s.get(c"timeoutMs")?)? {
            Some(n) => num(
                s,
                call(s.global()?.get(c"Math")?, c"round", &[num(s, n)?])?
                    .number()?
                    .clamp(MIN_TIMEOUT, MAX_TIMEOUT),
            )?,
            None => client.get(c"timeoutMs")?,
        };
        let effective = escalation(s.get(c"escalation")?, client.get(c"escalation")?)?;
        let model = string_override(s.get(c"model")?, client.get(c"model")?, 100.)?;
        let endpoint = string_override(
            s.get(c"endpoint")?,
            client.get(c"endpoint")?,
            client.get(c"owner")?.get(c"maxEndpoint")?.number()?,
        )?;
        s.set(c"model", model)?;
        s.set(c"ladder", ladder)?;
        s.set(c"effectiveEscalation", effective)?;
        let ctor = s.global()?.get(c"AbortController")?;
        let (timer, controller) = if callable(ctor)? {
            let ctrl = ctor.construct(&[])?;
            let abort = function(ctrl, "abort", 0, 0, |ctrl, _| call(ctrl, c"abort", &[]))?;
            (
                s.global()?
                    .get(c"setTimeout")?
                    .call_plain(&[abort, budget])?,
                ctrl,
            )
        } else {
            (null(s)?, null(s)?)
        };
        s.set(c"timer", timer)?;
        match send(s, key, endpoint, controller) {
            Ok(v) => call(
                resolved(v)?,
                c"then",
                &[
                    function(s, "jevResponse", 1, 1, |s, a| response(s, a[0]))?,
                    function(s, "jevRequestFailed", 1, 1, |s, a| request_failure(s, a[0]))?,
                ],
            ),
            Err(e) => request_failure(s, cause(s, e)?),
        }
    })
}
pub(super) fn create<'a>(owner: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let opts = default_object(args[0])?;
    let fetch = truth_or(opts.get(c"fetchImpl")?, owner.get(c"fetch")?)?;
    if !callable(fetch)? {
        return Err(fetch.type_error("[jev] fetch is required"));
    }
    let resolve = if callable(opts.get(c"resolveApiKey")?)? {
        opts.get(c"resolveApiKey")?
    } else {
        null(opts)?
    };
    let endpoint = string(truth_or(opts.get(c"endpoint")?, owner.get(c"endpoint")?)?)?;
    let model = string(truth_or(opts.get(c"model")?, owner.get(c"model")?)?)?;
    let n = opts.get(c"timeoutMs")?.explicit_number()?;
    let timeout = num(
        opts,
        if n.is_nan() || n == 0. {
            DEFAULT_TIMEOUT
        } else {
            n.max(MIN_TIMEOUT)
        },
    )?;
    let defaults = owner.get(c"escalation")?;
    let escalation = fields(
        opts,
        &[
            (
                "minConfidence",
                threshold(opts.get(c"escalation")?, defaults, c"minConfidence")?,
            ),
            (
                "minTierProbability",
                threshold(opts.get(c"escalation")?, defaults, c"minTierProbability")?,
            ),
        ],
    )?
    .freeze()?;
    let value = opts.get(c"logger")?;
    let logger = if value.truthy()? {
        value
    } else {
        methods(
            opts,
            &[("info", 0, |p, _| undef(p)), ("warn", 0, |p, _| undef(p))],
        )?
    };
    let now = if callable(opts.get(c"now")?)? {
        opts.get(c"now")?
    } else {
        opts.global()?.get(c"Date")?.get(c"now")?
    };
    let client = fields(
        owner,
        &[
            ("owner", owner),
            ("fetch", fetch),
            ("resolve", resolve),
            ("now", now),
            ("logger", logger),
            ("endpoint", endpoint),
            ("model", model),
            ("timeoutMs", timeout),
            ("escalation", escalation),
        ],
    )?;
    fields(
        owner,
        &[
            ("classify", function(client, "classify", 0, 1, classify)?),
            ("endpoint", endpoint),
            ("model", model),
            ("timeoutMs", timeout),
            ("escalation", escalation),
        ],
    )?
    .freeze()
}
