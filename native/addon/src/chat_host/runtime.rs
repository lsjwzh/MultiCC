use super::*;
mod effects;
const PORTS: [&CStr; 9] = [
    c"appendMessage",
    c"persistUsage",
    c"afterUsageCommit",
    c"getSessionState",
    c"consumeHandoff",
    c"emitTurnComplete",
    c"emitDispatchComplete",
    c"emitGatewayComplete",
    c"logSuppressed",
];
fn validate(p: L<'_>) -> Result<L<'_>> {
    if !object(p)? {
        return Err(p.type_error("chat host runtime ports are required"));
    }
    for k in PORTS {
        if !callable(p.get(k)?)? {
            return Err(p.type_error(&format!(
                "chat host runtime port missing: {}",
                k.to_string_lossy()
            )));
        }
    }
    Ok(p)
}
fn first<'a>(p: L<'a>, options: &[(L<'a>, &CStr)]) -> Result<L<'a>> {
    let mut last = undef(p)?;
    for (owner, k) in options {
        last = owner.optional(k)?;
        if last.truthy()? {
            break;
        }
    }
    Ok(last)
}
fn attribution<'a>(deps: L<'a>, s: L<'a>, t: L<'a>, r: L<'a>, source: L<'a>) -> Result<L<'a>> {
    let task = object_value(t.optional(c"task")?)?;
    let src = object_value(source)?;
    let runner = r.optional(c"usageAttribution")?;
    let bound = if object(runner)? {
        runner
    } else {
        object_value(t.optional(c"usageAttribution")?)?
    };
    let cli = lower(first(
        deps,
        &[(bound, c"cli"), (src, c"cli"), (r, c"cli"), (s, c"cli")],
    )?)?;
    let id = fallback(
        first(
            deps,
            &[
                (bound, c"providerId"),
                (src, c"providerId"),
                (r, c"providerId"),
                (s, c"providerId"),
                (s, c"provider"),
            ],
        )?
        .clean_text()?,
        "_default_".into(),
    )?;
    let role = fallback(
        lower(first(
            deps,
            &[
                (bound, c"roleKind"),
                (src, c"roleKind"),
                (src, c"role"),
                (r, c"roleKind"),
                (task, c"roleKind"),
                (s, c"roleKind"),
            ],
        )?)?,
        "main".into(),
    )?;
    let name = choose(
        first(
            deps,
            &[
                (bound, c"providerName"),
                (src, c"providerName"),
                (r, c"providerName"),
                (s, c"providerName"),
            ],
        )?
        .clean_text()?,
        id,
    )?;
    let protocol = first(
        deps,
        &[(bound, c"protocol"), (src, c"protocol"), (r, c"protocol")],
    )?
    .clean_text()?;
    let protocol = if protocol.truthy()? {
        protocol
    } else {
        fallback(
            choose(deps.get(c"protocol")?.call_plain(&[cli])?, cli)?,
            "unknown".into(),
        )?
    };
    let model = first(
        deps,
        &[
            (bound, c"model"),
            (src, c"model"),
            (r, c"model"),
            (r, c"modelId"),
            (s, c"model"),
            (s, c"modelId"),
        ],
    )?
    .clean_text()?;
    let route = choose(
        lower(first(
            deps,
            &[
                (bound, c"routeName"),
                (src, c"routeName"),
                (r, c"routeName"),
                (task, c"routeName"),
                (s, c"routeName"),
            ],
        )?)?,
        role,
    )?;
    let status = fallback(lower(src.get(c"status")?)?, "success".into())?;
    let numeric = || -> Result<L<'a>> { num(s, src.get(c"occurredAt")?.explicit_number()?) };
    let time = if is_safe(numeric()?)? && numeric()?.number()? >= 0. {
        numeric()?
    } else {
        call(s.global()?.get(c"Date")?, c"now", &[])?
    };
    let out = fields(
        s,
        &[
            ("providerId", id),
            ("providerName", name),
            ("cli", cli),
            ("protocol", protocol),
            ("model", model),
            ("roleKind", role),
            ("routeName", route),
            ("status", status),
            ("occurredAt", time),
        ],
    )?;
    if bound.get(c"runtimeEpoch")?.truthy()?
        && bound.get(c"decisionId")?.truthy()?
        && bound.get(c"routeAttemptId")?.truthy()?
        && bound.get(c"providerRevision")?.truthy()?
        && is_safe(bound.get(c"routeGeneration")?)?
        && is_safe(bound.get(c"attemptNo")?)?
    {
        out.set(c"runtimeEpoch", bound.get(c"runtimeEpoch")?)?;
        out.set(
            c"turnId",
            first(s, &[(r, c"turnId"), (t, c"turnId")])?.clean_text()?,
        )?;
        for k in [
            c"decisionId",
            c"routeAttemptId",
            c"routeGeneration",
            c"attemptNo",
            c"providerRevision",
        ] {
            out.set(k, bound.get(k)?)?;
        }
        out.set(c"routeAttribution", text(s, "exact")?)?;
    }
    out.freeze()
}
fn model<'a>(deps: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let Some(snapshot) = deps.catch(|| attribution(deps, a[0], a[1], a[2], undef(deps)?))? else {
        return null(deps);
    };
    let out = obj(deps)?;
    let mut any = false;
    for k in [c"cli", c"providerId", c"providerName", c"model"] {
        let v = snapshot.get(k)?.clean_text()?;
        if v.truthy()? && !v.is_string("_default_")? {
            out.set(k, v)?;
            any = true
        }
    }
    if any {
        Ok(out)
    } else {
        null(deps)
    }
}
fn model_field<'a>(deps: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let attr = model(deps, a)?;
    if attr.truthy()? {
        fields(deps, &[("modelAttribution", attr)])
    } else {
        obj(deps)
    }
}
fn role_usage<'a>(snapshot: L<'a>, id: L<'a>) -> Result<L<'a>> {
    if !callable(snapshot)? {
        return null(id);
    }
    let Some(s) = id.catch(|| snapshot.call_plain(&[id]))? else {
        return null(id);
    };
    if !s.truthy()? || !s.get(c"sub")?.truthy()? {
        return null(id);
    }
    let rows = |k: &CStr| -> Result<L<'a>> {
        let v = s.get(k)?;
        if v.is_array()? {
            s.get(k)
        } else {
            array(id)
        }
    };
    fields(
        id,
        &[
            ("main", fallback(s.get(c"main")?, V::Null)?),
            ("mainByProvider", rows(c"mainByProvider")?),
            ("sub", s.get(c"sub")?),
            ("subByProvider", rows(c"subByProvider")?),
        ],
    )
}
fn context<'a>(s: L<'a>, id: L<'a>, state: L<'a>, turn: L<'a>, runner: L<'a>) -> Result<L<'a>> {
    fields(
        s,
        &[
            ("s", s),
            ("id", id),
            ("state", state),
            ("turn", turn),
            ("runner", runner),
        ],
    )
}
fn live(c: L<'_>) -> Result<L<'_>> {
    let state = c.get(c"state")?;
    if call(
        c.get(c"s")?.get(c"ports")?,
        c"getSessionState",
        &[c.get(c"id")?],
    )?
    .equals(state)?
    {
        Ok(state)
    } else {
        null(c)
    }
}
fn owns(c: L<'_>) -> Result<bool> {
    let state = live(c)?;
    Ok(state.truthy()?
        && state.get(c"_activeTurn")?.equals(c.get(c"turn")?)?
        && state.get(c"_activeRunner")?.equals(c.get(c"runner")?)?)
}
fn input(c: L<'_>) -> Result<L<'_>> {
    let i = fields(
        c,
        &[("turn", c.get(c"turn")?), ("runner", c.get(c"runner")?)],
    )?;
    for (key, name) in [
        (c"_activeTurn", "currentTurn"),
        (c"_activeRunner", "currentRunner"),
    ] {
        coordinator::getter(
            i,
            name,
            function(c, name, 0, 0, move |c, _| live(c)?.optional(key))?,
            true,
        )?;
    }
    Ok(i)
}
fn persist<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(s, || {
        let (id, state, turn, runner) = (a[0], a[1], a[2], a[3]);
        let mut message = a[4];
        let opts = default_object(a[5])?;
        let ports = s.get(c"ports")?;
        let roles = role_usage(ports.get(c"roleUsageSnapshot")?, id)?;
        if roles.truthy()? && message.truthy()? && message.get(c"role")?.is_string("assistant")? {
            message = spread(message)?;
            message.set(c"roleUsage", roles)?;
        }
        if message.truthy()? && message.get(c"role")?.is_string("assistant")? {
            let fields = model_field(s.get(c"deps")?, &mut [state, turn, runner])?;
            if fields.get(c"modelAttribution")?.truthy()? {
                message = spread(message)?;
                message.spread_from(fields)?;
            }
            if !message.get(c"timeline")?.truthy()? {
                message = spread(message)?;
                message.spread_from(s.get(c"timelineField")?.call_plain(&[id, state])?)?;
            }
        }
        let c = context(s, id, state, turn, runner)?;
        c.set(c"onVerdict", a[6])?;
        let i = input(c)?;
        i.set(
            c"boundary",
            text(
                s,
                if opts.get(c"resultEvent")?.is_true()? {
                    "result"
                } else {
                    "close"
                },
            )?,
        )?;
        i.set(
            c"facts",
            fields(
                c,
                &[
                    ("normalExit", flag(c, opts.get(c"final")?.is_true()?)?),
                    ("killReason", runner.optional(c"killReason")?),
                    (
                        "apiError",
                        flag(c, runner.optional(c"sawApiError")?.truthy()?)?,
                    ),
                    (
                        "adapterError",
                        flag(c, runner.optional(c"adapterError")?.truthy()?)?,
                    ),
                    (
                        "retryPlanned",
                        flag(c, runner.optional(c"retryPlanned")?.truthy()?)?,
                    ),
                ],
            )?,
        )?;
        i.set(c"checkpointKey", opts.get(c"checkpointKey")?)?;
        i.set(c"message", message)?;
        then(
            call(s.get(c"coordinator")?, c"appendFinal", &[i])?,
            c,
            |c, a| {
                let res = a[0];
                let durable = flag(c, res.get(c"durable")?.is_true()?)?;
                if owns(c)? {
                    c.get(c"state")?.assign(c"_resultSaved", durable)?;
                }
                let f = c.get(c"onVerdict")?;
                if callable(f)? {
                    c.catch(|| {
                        f.call_plain(&[fields(
                            c,
                            &[
                                ("durable", durable),
                                ("persisted", flag(c, res.get(c"persisted")?.is_true()?)?),
                            ],
                        )?])
                    })?;
                }
                Ok(durable)
            },
        )
    })
}
fn usage<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let id = a[0];
    let r = a[1];
    let state = call(s.get(c"ports")?, c"getSessionState", &[id])?;
    let t = if a[4].truthy()? {
        a[4]
    } else {
        state.optional(c"_activeTurn")?
    };
    let identity = !a[4].nullish()?;
    let c = context(s, id, state, t, r)?;
    let i = input(c)?;
    i.set(c"identityOnly", flag(s, identity)?)?;
    i.set(c"usage", a[2])?;
    i.set(
        c"attribution",
        attribution(s.get(c"deps")?, state, t, r, default_object(a[3])?)?,
    )?;
    let result = call(s.get(c"coordinator")?, c"commitUsage", &[i])?;
    flag(
        s,
        result.get(c"committed")?.is_true()?
            && (identity || (!result.get(c"code")?.is_string("stale_runner")? && owns(c)?)),
    )
}
fn create<'a>(deps: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let ports = validate(a[0])?;
    let timeline = ports.get(c"timelineField")?;
    let timeline = if callable(timeline)? {
        ports.get(c"timelineField")?
    } else {
        deps.get(c"turnProgress")?.call_plain(&[])?.get(c"field")?
    };
    let s = fields(
        deps,
        &[
            ("ports", ports),
            ("deps", deps),
            ("timelineField", timeline),
        ],
    )?;
    let history = methods(
        s,
        &[("appendFinal", 1, |s, a| {
            let msg = s
                .get(c"deps")?
                .get(c"redact")?
                .call_plain(&[a[0].get(c"message")?])?;
            call(
                s.get(c"ports")?,
                c"appendMessage",
                &[a[0].get(c"sessionId")?, msg],
            )
        })],
    )?;
    let usage_port = methods(
        ports,
        &[
            ("commit", 1, |p, a| {
                call(
                    p,
                    c"persistUsage",
                    &[
                        a[0].get(c"sessionId")?,
                        a[0].get(c"usage")?,
                        a[0].get(c"attribution")?,
                    ],
                )
            }),
            ("afterCommit", 1, |p, a| {
                call(
                    p,
                    c"afterUsageCommit",
                    &[a[0].get(c"sessionId")?, a[0].get(c"attribution")?],
                )
            }),
        ],
    )?;
    let coordinator = call(
        deps.get(c"coordinator")?,
        c"createChatHostCoordinator",
        &[fields(s, &[("history", history), ("usage", usage_port)])?],
    )?;
    s.set(c"coordinator", coordinator)?;
    let out = pick(
        coordinator,
        &[c"isCurrentTurnRunner", c"assistantCheckpointKey"],
    )?;
    out.set(
        c"persistFinalAssistantResult",
        function(s, "persistFinalAssistantResult", 5, 7, persist)?,
    )?;
    out.set(c"modelAttributionField", deps.get(c"modelField")?)?;
    out.set(
        c"recordDurableTurnUsage",
        function(s, "recordDurableTurnUsage", 3, 5, usage)?,
    )?;
    out.set(
        c"runDurablePostTurn",
        function(s, "runDurablePostTurn", 6, 7, effects::run)?,
    )?;
    out.freeze()
}
pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    let out = methods(
        p,
        &[
            ("assertHostRuntimePorts", 1, |_, a| validate(a[0])),
            ("createChatHostRuntime", 1, create),
            ("modelAttributionFor", 3, model),
            ("modelAttributionField", 3, model_field),
        ],
    )?;
    let ports = array(p)?;
    for (i, k) in PORTS.iter().enumerate() {
        ports.set_element(i as u32, text(p, k.to_str().unwrap())?)?;
    }
    out.set(c"REQUIRED_PORTS", ports.freeze()?)?;
    p.set(c"modelField", out.get(c"modelAttributionField")?)?;
    Ok(out)
}
