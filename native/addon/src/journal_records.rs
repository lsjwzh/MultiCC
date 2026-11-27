use crate::route_response::*;
use multicc_core::js::JsString;
use napi_derive::napi;
#[napi]
pub fn journal_file_stem(env: Env, value: Unknown<'_>, dots: bool) -> Result<sys::napi_value> {
    let v = L::new(&env, value);
    let s = v.coerce_string()?;
    let mut name = String::with_capacity(s.len());
    for &c in s.as_units() {
        name.push(
            if c <= 127
                && ((c as u8).is_ascii_alphanumeric() || matches!(c, 45 | 95) || dots && c == 46)
            {
                c as u8 as char
            } else {
                '_'
            },
        );
    }
    if !dots && name.is_empty() {
        name.push_str("_default")
    }
    Ok(text(v, &name)?.raw())
}
#[napi]
pub fn journal_event_line(
    env: Env,
    seq: Unknown<'_>,
    event: Unknown<'_>,
    now: Unknown<'_>,
) -> Result<sys::napi_value> {
    let e = L::new(&env, event);
    let seq = L::new(&env, seq);
    let clock = L::new(&env, now);
    let json = e.global()?.get(c"JSON")?;
    let encode = |ts, ev| {
        call(
            json,
            c"stringify",
            &[fields(e, &[("seq", seq), ("ts", ts), ("event", ev)])?],
        )
    };
    let mut line = encode(clock.call_plain(&[])?, e)?;
    let len = line.get(c"length")?.number()?;
    if len > 16384. {
        let timestamp = clock.call_plain(&[])?;
        let stub = fields(
            e,
            &[
                ("type", e.get(c"type")?),
                ("journaled", text(e, "stub")?),
                ("payloadBytes", num(e, len)?),
            ],
        )?;
        line = encode(timestamp, stub)?;
        if line.get(c"length")?.number()? > 16384. {
            return Ok(null(e)?.raw());
        }
    }
    Ok(line.raw())
}
#[napi]
pub fn journal_decode(env: Env, source: Unknown<'_>, trim_blank: bool) -> Result<sys::napi_value> {
    let p = L::new(&env, source);
    let lines = call(p, c"split", &[text(p, "\n")?])?;
    let rows = p.from_value(&V::Array(vec![]))?;
    let mut corrupt = 0.;
    lines.for_each(|line| {
        if !line.truthy()? || trim_blank && !call(line, c"trim", &[])?.truthy()? {
            return Ok(());
        }
        if p.catch(|| {
            let value = call(p.global()?.get(c"JSON")?, c"parse", &[line])?;
            call(rows, c"push", &[value])
        })?
        .is_none()
        {
            corrupt += 1.;
        }
        Ok(())
    })?;
    Ok(fields(p, &[("rows", rows), ("corrupt", num(p, corrupt)?)])?.raw())
}
#[napi]
pub fn aux_log_record(
    env: Env,
    key: Unknown<'_>,
    run: Unknown<'_>,
    now: Unknown<'_>,
    clip: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, run);
    let clip = L::new(&env, clip);
    let finite = |v: L<'_>| -> Result<bool> { Ok(v.number_value()?.is_some_and(f64::is_finite)) };
    let row = fields(
        p,
        &[
            (
                "runId",
                fallback(crate::js_iteration::read(p, c"runId")?, V::Null)?,
            ),
            (
                "at",
                if finite(p.get(c"at")?)? {
                    p.get(c"at")?
                } else {
                    L::new(&env, now).call_plain(&[])?
                },
            ),
            ("kind", fallback(p.get(c"kind")?, "intent_classify".into())?),
            ("sessionId", L::new(&env, key)),
        ],
    )?;
    for k in [
        c"source",
        c"turnId",
        c"taskId",
        c"priorTaskId",
        c"anchorMessageId",
        c"observedAnchorMessageId",
        c"model",
    ] {
        row.set(k, fallback(p.get(k)?, V::Null)?)?;
    }
    row.set(
        c"latencyMs",
        if finite(p.get(c"latencyMs")?)? {
            p.get(c"latencyMs")?
        } else {
            null(p)?
        },
    )?;
    for k in [c"systemPrompt", c"prompt", c"rawText"] {
        row.set(k, clip.call_plain(&[p.get(k)?])?)?;
    }
    row.set(c"parsed", fallback(p.get(c"parsed")?, V::Null)?)?;
    row.set(
        c"error",
        if p.get(c"error")?.truthy()? {
            string(p.get(c"error")?)?
        } else {
            null(p)?
        },
    )?;
    for k in [c"cancelled", c"superseded"] {
        row.set(k, flag(p, p.get(k)?.is_true()?)?)?;
    }
    row.set(
        c"supersededReason",
        fallback(p.get(c"supersededReason")?, V::Null)?,
    )?;
    Ok(row.raw())
}
#[napi]
pub fn aux_log_clip(
    env: Env,
    value: Unknown<'_>,
    limit: Unknown<'_>,
    arithmetic: Unknown<'_>,
) -> Result<sys::napi_value> {
    let p = L::new(&env, value);
    if p.nullish()? {
        return Ok(null(p)?.raw());
    }
    let s = string(p)?;
    let n = s.get(c"length")?;
    let lim = L::new(&env, limit);
    let ops = L::new(&env, arithmetic);
    if call(ops, c"within", &[n, lim])?.truthy()? {
        return Ok(s.raw());
    }
    let first = call(s, c"slice", &[num(p, 0.)?, lim])?.coerce_string()?;
    let delta = call(ops, c"over", &[n, lim])?.coerce_string()?;
    Ok(p.from_value(&V::String(JsString::concat(&[
        &first,
        &"\n…[truncated ".into(),
        &delta,
        &" chars]".into(),
    ])))?
    .raw())
}
