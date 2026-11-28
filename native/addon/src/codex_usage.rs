//! Codex accounting with live host rows. Pure vector arithmetic is shared in
//! core; V8 handles are borrowed so history content is never cloned/serialized.
use crate::host_api::*;
use multicc_core::codex_usage::{self as model, Vector};
use napi_derive::napi;

fn normalized(v: L<'_>) -> Result<Option<Vector>> {
    if !v.truthy()? || !object(v)? {
        return Ok(None);
    }
    let env = crate::host_methods::env(v);
    let n = crate::usage_observed::codex_cumulative_usage(env, crate::host_methods::arg(v)?)?;
    Ok(Some(Vector {
        fresh: n.fresh,
        cached: n.cached,
        write: n.cache_write,
        output: n.output,
        reasoning: n.reasoning,
    }))
}
fn vector<'a>(p: L<'a>, v: Vector) -> Result<L<'a>> {
    fields(
        p,
        &[
            ("fresh", num(p, v.fresh)?),
            ("cached", num(p, v.cached)?),
            ("cacheWrite", num(p, v.write)?),
            ("output", num(p, v.output)?),
            ("reasoning", num(p, v.reasoning)?),
        ],
    )?
    .freeze()
}
fn usage<'a>(p: L<'a>, v: Vector, source: L<'a>) -> Result<L<'a>> {
    let out = spread(source)?;
    for (key, count) in [
        (c"input_tokens", v.fresh),
        (c"cached_input_tokens", v.cached),
        (c"cache_read_input_tokens", v.cached),
        (c"cache_creation_input_tokens", v.write),
        (c"output_tokens", v.output),
        (c"reasoning_output_tokens", v.reasoning),
        (c"total_tokens", v.total()),
    ] {
        out.set(key, num(p, count)?)?;
    }
    Ok(out)
}
fn own(v: L<'_>, key: &str) -> Result<bool> {
    let method = v
        .global()?
        .get(c"Object")?
        .get(c"prototype")?
        .get(c"hasOwnProperty")?;
    method.call(v, &[text(v, key)?])?.truthy()
}
fn looks(v: L<'_>) -> Result<bool> {
    Ok(v.truthy()?
        && object(v)?
        && (own(v, "cached_input_tokens")? || own(v, "reasoning_output_tokens")?))
}
fn epoch(v: L<'_>) -> Result<L<'_>> {
    let string = string(fallback(v, "".into())?)?;
    let value = string.string()?.expect("String");
    if value.is_empty() {
        null(v)
    } else {
        text(v, &model::epoch(&value.utf8_lossy_bytes()))
    }
}
fn baseline<'a>(history: L<'a>, epoch: L<'a>) -> Result<Option<Vector>> {
    if !history.is_array()? {
        return Ok(None);
    }
    let mut index = history.get(c"length")?.number()? as i64 - 1;
    while index >= 0 {
        let row = history.element(index as u32)?;
        index -= 1;
        if !row.truthy()? || !row.get(c"role")?.is_string("assistant")? {
            continue;
        }
        if row.get(c"usageCumulative")?.truthy()? {
            if epoch.truthy()?
                && row.get(c"usageEpoch")?.truthy()?
                && !row.get(c"usageEpoch")?.equals(epoch)?
            {
                continue;
            }
            if let Some(v) = normalized(row.get(c"usageCumulative")?)? {
                return Ok(Some(v));
            }
            continue;
        }
        if looks(row.get(c"usage")?)? {
            return normalized(row.get(c"usage")?);
        }
    }
    Ok(None)
}
fn turn<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let input = default_object(a[0])?;
    let (raw, history, session, per_turn) = (
        input.get(c"usage")?,
        input.get(c"history")?,
        input.get(c"cliSessionId")?,
        input.get(c"perTurn")?,
    );
    let Some(current) = normalized(raw)? else {
        return fields(
            p,
            &[
                ("usage", fields(p, &[])?),
                ("cumulativeUsage", null(p)?),
                ("usageEpoch", null(p)?),
                ("code", text(p, "invalid")?),
            ],
        )?
        .freeze();
    };
    if per_turn.truthy()? {
        return fields(
            p,
            &[
                ("usage", usage(p, current, raw)?),
                ("cumulativeUsage", null(p)?),
                ("usageEpoch", null(p)?),
                ("code", text(p, "per_turn")?),
            ],
        )?
        .freeze();
    }
    let epoch = epoch(session)?;
    let previous = baseline(history, epoch)?;
    let (delta, cumulative, code) = match previous {
        None => (current, current, "initial"),
        Some(previous) => match current.delta(previous) {
            Some(delta) => (delta, current, "delta"),
            None => (Vector::default(), previous, "regression"),
        },
    };
    fields(
        p,
        &[
            ("usage", usage(p, delta, raw)?),
            ("cumulativeUsage", usage(p, cumulative, undef(p)?)?),
            ("usageEpoch", epoch),
            ("code", text(p, code)?),
        ],
    )?
    .freeze()
}
fn project<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let per_turn = default_object(a[1])?.get(c"perTurn")?;
    let source = if a[0].is_array()? { a[0] } else { array(p)? };
    let out = p
        .global()?
        .get(c"Array")?
        .construct(&[source.get(c"length")?])?;
    let mut baselines: Vec<(L<'a>, Vector)> = Vec::new();
    let mut i = 0;
    while (i as f64) < source.get(c"length")?.number()? {
        let row = source.element(i)?;
        out.set_element(i, row)?;
        let at = i;
        i += 1;
        if !row.truthy()? || !row.get(c"role")?.is_string("assistant")? {
            continue;
        }
        let key = fallback(row.get(c"usageEpoch")?, "legacy".into())?;
        let find = |b: &[(L<'a>, Vector)]| -> Result<Option<usize>> {
            for (i, (k, _)) in b.iter().enumerate() {
                if k.equals(key)? {
                    return Ok(Some(i));
                }
            }
            Ok(None)
        };
        if row.get(c"usageCumulative")?.truthy()? {
            if let Some(current) = normalized(row.get(c"usageCumulative")?)? {
                if let Some(i) = find(&baselines)? {
                    baselines[i].1 = current;
                } else {
                    baselines.push((key, current));
                }
            }
            let copy = spread(row)?;
            copy.delete(c"usageCumulative")?;
            copy.delete(c"usageEpoch")?;
            out.set_element(at, copy)?;
            continue;
        }
        if per_turn.truthy()? || !looks(row.get(c"usage")?)? {
            continue;
        }
        let current = normalized(row.get(c"usage")?)?.expect("object usage");
        let index = find(&baselines)?;
        let delta = index
            .and_then(|i| current.delta(baselines[i].1))
            .unwrap_or(current);
        let copy = spread(row)?;
        copy.set(c"usage", usage(p, delta, row.get(c"usage")?)?)?;
        out.set_element(at, copy)?;
        if let Some(i) = index {
            baselines[i].1 = current;
        } else {
            baselines.push((key, current));
        }
    }
    Ok(out)
}
fn summarize<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let rows = project(p, &mut [a[0], undef(p)?])?;
    let (mut fresh, mut read, mut write, mut output, mut turns) = (0., 0., 0., 0., 0.);
    rows.for_each(|row| {
        if !row.truthy()? || !row.get(c"role")?.is_string("assistant")? {
            return Ok(());
        }
        let raw = row.get(c"usage")?;
        if !raw.truthy()? || !object(raw)? {
            return Ok(());
        }
        let env = crate::host_methods::env(p);
        let input = raw.get(c"input_tokens")?;
        let cached = raw.get(c"cache_read_input_tokens")?;
        let cached = if cached.nullish()? {
            raw.get(c"cached_input_tokens")?
        } else {
            raw.get(c"cache_read_input_tokens")?
        };
        let parts = crate::usage_observed::usage_token_components(
            env,
            crate::host_methods::arg(input)?,
            crate::host_methods::arg(cached)?,
            crate::host_methods::arg(raw.get(c"cache_creation_input_tokens")?)?,
            crate::host_methods::arg(raw.get(c"output_tokens")?)?,
        )?;
        if parts.consumed_input_tokens + parts.output_tokens == 0. {
            return Ok(());
        }
        fresh += parts.fresh_input_tokens;
        read += parts.cache_read_tokens;
        write += parts.cache_write_tokens;
        output += parts.output_tokens;
        turns += 1.;
        Ok(())
    })?;
    fields(
        p,
        &[
            ("inputTokens", num(p, fresh + read + write)?),
            ("consumedInputTokens", num(p, fresh + read + write)?),
            ("freshInputTokens", num(p, fresh)?),
            ("cacheReadTokens", num(p, read)?),
            ("cacheWriteTokens", num(p, write)?),
            ("breakdownKnown", flag(p, true)?),
            ("outputTokens", num(p, output)?),
            ("turnCount", num(p, turns)?),
        ],
    )
}
fn hook<'a>(s: L<'a>, key: &std::ffi::CStr, args: &[L<'a>]) -> Result<L<'a>> {
    s.get(c"deps")?.get(key)?.call_plain(args)
}
fn timestamp(s: L<'_>) -> Result<L<'_>> {
    s.get(c"now")?.call_plain(&[])
}
fn forward<'a>(s: L<'a>) -> Result<L<'a>> {
    let input = s.get(c"input")?;
    let cs = input.get(c"cs")?;
    let session = input.get(c"sessionName")?;
    let deps = s.get(c"deps")?;
    let attribution = if callable(deps.get(c"modelAttributionField")?)? {
        hook(
            s,
            c"modelAttributionField",
            &[cs, input.get(c"turn")?, input.get(c"runner")?],
        )?
    } else {
        fields(s, &[])?
    };
    let cost = cs.get(c"currentCost")?;
    let current_usage = s.get(c"normalized")?.get(c"usage")?;
    let duration = if cs.get(c"turnStartedAt")?.truthy()? {
        num(
            s,
            timestamp(s)?.number()? - cs.get(c"turnStartedAt")?.number()?,
        )?
    } else {
        undef(s)?
    };
    let event = fields(
        s,
        &[
            ("type", text(s, "result")?),
            ("total_cost_usd", cost),
            ("usage", current_usage),
            ("durationMs", duration),
            ("num_turns", cs.get(c"chatTurnCount")?),
        ],
    )?;
    let trace = input.get(c"contextTrace")?;
    if trace.truthy()? {
        event.set(c"contextTrace", trace)?;
    }
    event.spread_from(attribution)?;
    let timeline = s
        .get(c"timelineField")?
        .call_plain(&[session, cs, timestamp(s)?])?;
    event.spread_from(timeline)?;
    input.get(c"forward")?.call_plain(&[event])?;
    s.get(c"normalized")
}
fn persisted<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let input = s.get(c"input")?;
    if a[0].truthy()? {
        hook(
            s,
            c"recordDurableTurnUsage",
            &[
                input.get(c"sessionName")?,
                input.get(c"runner")?,
                s.get(c"normalized")?.get(c"usage")?,
            ],
        )?;
        let cs = input.get(c"cs")?;
        let value = cs.get(c"chatTurnCount")?;
        let next = crate::schedule_note_queued_live::plus_one(value)?;
        cs.assign(c"chatTurnCount", next)?;
    }
    forward(s)
}
fn complete<'a>(host: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(host, || {
        let input = a[0];
        if !callable(input.get(c"forward")?)? {
            return Err(input.type_error("Codex usage host missing: forward"));
        }
        let cs = input.get(c"cs")?;
        let session = input.get(c"sessionName")?;
        let state = fields(
            host,
            &[
                ("deps", host.get(c"deps")?),
                ("now", host.get(c"now")?),
                ("timelineField", host.get(c"timelineField")?),
                ("input", input),
            ],
        )?;
        hook(state, c"clearIncrementalSave", &[session])?;
        let event = input.get(c"evt")?;
        let record = input.get(c"persisted")?;
        let cost = event.get(c"cost")?;
        cs.assign(
            c"currentCost",
            if cost.nullish()? {
                null(state)?
            } else {
                event.get(c"cost")?
            },
        )?;
        let raw = fallback(event.get(c"usage")?, V::Object(vec![]))?;
        let history = hook(state, c"loadHistory", &[session])?;
        let native_id = record.get(c"cliSessionId")?;
        let per_turn =
            record.get(c"cli")?.is_string("codex-exp")? || record.get(c"cli")?.is_string("agy")?;
        let normalized = turn(
            state,
            &mut [fields(
                state,
                &[
                    ("usage", raw),
                    ("history", history),
                    ("cliSessionId", native_id),
                    ("perTurn", flag(state, per_turn)?),
                ],
            )?],
        )?;
        state.set(c"normalized", normalized)?;
        if normalized.get(c"code")?.is_string("regression")? {
            let logger = host.get(c"logger")?;
            if logger.truthy()? && callable(logger.get(c"warn")?)? {
                call(
                    logger,
                    c"warn",
                    &[
                        text(state, "codex_usage_cumulative_regression")?,
                        fields(state, &[("sessionId", session)])?,
                    ],
                )?;
            }
        }
        let usage = normalized.get(c"usage")?;
        let runner = input.get(c"runner")?;
        runner.assign(c"pendingUsage", usage)?;
        hook(
            state,
            c"reconcileRole",
            &[
                session,
                usage,
                fallback(runner.get(c"usageAttribution")?, V::Object(vec![]))?,
            ],
        )?;
        if cs.get(c"currentAssistantText")?.truthy()?
            || cs.get(c"currentToolCalls")?.get(c"length")?.truthy()?
        {
            let tools = cs.get(c"currentToolCalls")?;
            let tools = if tools.get(c"length")?.truthy()? {
                cs.get(c"currentToolCalls")?
            } else {
                undef(state)?
            };
            let message = fields(
                state,
                &[
                    ("role", text(state, "assistant")?),
                    ("content", cs.get(c"currentAssistantText")?),
                    ("tools", tools),
                    ("cost", cs.get(c"currentCost")?),
                    ("usage", usage),
                ],
            )?;
            if normalized.get(c"cumulativeUsage")?.truthy()? {
                message.set(c"usageCumulative", normalized.get(c"cumulativeUsage")?)?;
            }
            if normalized.get(c"usageEpoch")?.truthy()? {
                message.set(c"usageEpoch", normalized.get(c"usageEpoch")?)?;
            }
            if input.get(c"contextTrace")?.truthy()? {
                message.set(c"contextTrace", input.get(c"contextTrace")?)?;
            }
            message.set(c"ts", timestamp(state)?)?;
            let saved = hook(
                state,
                c"persistFinalAssistantResult",
                &[
                    session,
                    cs,
                    input.get(c"turn")?,
                    runner,
                    message,
                    fields(state, &[("resultEvent", flag(state, true)?)])?,
                ],
            )?;
            return crate::host_api::then(saved, state, persisted);
        }
        hook(
            state,
            c"recordResultEvent",
            &[
                input.get(c"turn")?,
                runner,
                fields(
                    state,
                    &[
                        ("current", flag(state, true)?),
                        ("persisted", flag(state, false)?),
                    ],
                )?,
            ],
        )?;
        forward(state)
    })
}
fn create<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let deps = default_object(a[0])?;
    for key in [
        "loadHistory",
        "reconcileRole",
        "clearIncrementalSave",
        "persistFinalAssistantResult",
        "recordDurableTurnUsage",
        "recordResultEvent",
    ] {
        if !callable(deps.get_key(text(p, key)?)?)? {
            return Err(deps.type_error(&format!("Codex usage host missing: {key}")));
        }
    }
    let now = deps.get(c"now")?;
    let now = if callable(now)? {
        deps.get(c"now")?
    } else {
        p.global()?.get(c"Date")?.get(c"now")?
    };
    let timeline = deps.get(c"timelineField")?;
    let timeline = if callable(timeline)? {
        deps.get(c"timelineField")?
    } else {
        p.get(c"timeline")?.call_plain(&[])?
    };
    let host = fields(
        p,
        &[
            ("deps", deps),
            ("now", now),
            ("timelineField", timeline),
            ("logger", fallback(deps.get(c"logger")?, V::Undefined)?),
        ],
    )?;
    if !host.get(c"logger")?.truthy()? {
        host.set(c"logger", p.global()?.get(c"console")?)?;
    }
    fields(
        p,
        &[("complete", function(host, "complete", 1, 1, complete)?)],
    )?
    .freeze()
}
#[napi]
pub fn codex_usage_api(env: Env, timeline: Unknown<'_>) -> Result<sys::napi_value> {
    let timeline = L::new(&env, timeline);
    let p = fields(timeline, &[("timeline", timeline)])?;
    Ok(defaulted_methods(
        p,
        &[
            ("createCodexUsageHost", 0, 1, create),
            ("normalizeCodexTurnUsage", 0, 1, turn),
            ("projectHistoryUsage", 1, 2, project),
            ("summarizeHistoryUsage", 1, 1, summarize),
            ("looksLikeCodexUsage", 1, 1, |p, a| flag(p, looks(a[0])?)),
            ("usageEpochForSessionId", 1, 1, |_, a| epoch(a[0])),
            ("normalizeCodexCumulative", 1, 1, |p, a| {
                match normalized(a[0])? {
                    Some(v) => vector(p, v),
                    None => null(p),
                }
            }),
        ],
    )?
    .raw())
}
