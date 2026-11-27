//! Sequential relay model probing. Node supplies ChildProcess stream handles;
//! the route, model policy, argument list and result classification stay here.
use super::*;
const CANDIDATES: [&str; 6] = [
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-sonnet-4-5",
    "claude-opus-4-8",
    "claude-haiku-4-5",
    "claude-sonnet-4.5",
];
const STRIP: [&CStr; 6] = [
    c"ANTHROPIC_MODEL",
    c"ANTHROPIC_DEFAULT_OPUS_MODEL",
    c"ANTHROPIC_DEFAULT_SONNET_MODEL",
    c"ANTHROPIC_DEFAULT_HAIKU_MODEL",
    c"ANTHROPIC_DEFAULT_FABLE_MODEL",
    c"ANTHROPIC_SMALL_FAST_MODEL",
];
pub(super) fn log_models<'a>(p: L<'a>, id: L<'a>, plan: L<'a>) -> Result<L<'a>> {
    let o = p.global()?.get(c"Object")?;
    let entries = call(o, c"entries", &[plan.get(c"env")?])?;
    let keep = function(p, "", 1, 1, |p, a| {
        let key = word(a[0].element(0)?)?;
        flag(
            p,
            matches!(
                key.as_str(),
                "ANTHROPIC_BASE_URL" | "ANTHROPIC_MODEL" | "ANTHROPIC_SMALL_FAST_MODEL"
            ) || (key
                .strip_prefix("ANTHROPIC_DEFAULT_")
                .is_some_and(|rest| rest.ends_with("_MODEL"))),
        )
    })?;
    let sort = function(p, "", 2, 2, |_, a| {
        call(a[0].element(0)?, c"localeCompare", &[a[1].element(0)?])
    })?;
    let filtered = call(call(entries, c"filter", &[keep])?, c"sort", &[sort])?;
    let data = call(
        p.global()?.get(c"JSON")?,
        c"stringify",
        &[call(o, c"fromEntries", &[filtered])?],
    )?;
    let msg = format!(
        "[multicc/provider] claude env [{}] provider={} aliasOnly={} modelEnv={}",
        word(id)?,
        word(plan.get(c"providerName")?)?,
        word(plan.get(c"aliasOnly")?)?,
        word(data)?
    );
    call(p.global()?.get(c"console")?, c"log", &[text(p, &msg)?])
}
fn run(s: L<'_>) -> Result<L<'_>> {
    let step = call(s.get(c"iterator")?, c"next", &[])?;
    if step.get(c"done")?.truthy()? {
        return fields(
            s,
            &[
                ("tested", s.get(c"tested")?),
                ("accepted", s.get(c"accepted")?),
            ],
        );
    }
    let model = step.get(c"value")?;
    let p = s.get(c"host")?;
    let route = s.get(c"base")?;
    let env = crate::js_live::spread(p.get(c"environment")?)?;
    let reflect = p.global()?.get(c"Reflect")?;
    p.get(c"claudeKeys")?.for_each(|k| {
        call(reflect, c"deleteProperty", &[env, k])?;
        Ok(())
    })?;
    call(p.global()?.get(c"Object")?, c"assign", &[env, route])?;
    let settings = crate::js_live::spread(route)?;
    for k in STRIP {
        env.delete(k)?;
        settings.delete(k)?;
    }
    let name = call(text(s, "probe-")?, c"concat", &[model])?;
    let file = call(
        p.get(c"settings")?,
        c"settingsOverrideFor",
        &[name, settings],
    )?;
    let args = strings(s, ["-p", "--model"])?;
    call(
        args,
        c"push",
        &[
            model,
            text(s, "--max-turns")?,
            text(s, "1")?,
            text(s, "--dangerously-skip-permissions")?,
        ],
    )?;
    if file.truthy()? {
        call(args, c"push", &[text(s, "--settings")?, file])?;
    }
    call(args, c"push", &[text(s, "hi")?])?;
    s.set(c"model", model)?;
    let promise = port(p, c"runProbeChild", &[s.get(c"command")?, args, env])?;
    call(
        promise,
        c"then",
        &[function(s, "", 1, 1, |s, a| {
            let model = s.get(c"model")?;
            let result = if a[0].nullish()? {
                fields(
                    s,
                    &[
                        ("model", model),
                        ("ok", flag(s, false)?),
                        (
                            "reason",
                            text(s, "spawn failed (is the claude CLI installed?)")?,
                        ),
                    ],
                )?
            } else {
                let re = s.global()?.get(c"RegExp")?.construct(&[
                    text(
                        s,
                        "1211|模型不存在|model.*(not found|不存在)|model_not_found",
                    )?,
                    text(s, "i")?,
                ])?;
                let ok = !call(re, c"test", &[a[0]])?.truthy()?;
                if ok {
                    call(s.get(c"accepted")?, c"push", &[model])?;
                }
                fields(
                    s,
                    &[
                        ("model", model),
                        ("ok", flag(s, ok)?),
                        (
                            "sample",
                            call(a[0], c"slice", &[num(s, 0.)?, num(s, 95.)?])?,
                        ),
                    ],
                )?
            };
            call(s.get(c"tested")?, c"push", &[result])?;
            run(s)
        })?],
    )
}
pub(super) fn install<'a>(p: L<'a>, api: L<'a>) -> Result<()> {
    api.set(
        c"probeRelayModels",
        function(p, "probeRelayModels", 3, 3, |p, a| {
            async_result(p, || {
                let list = if a[1].truthy()? && a[1].get(c"length")?.truthy()? {
                    a[1]
                } else {
                    strings(p, CANDIDATES)?
                };
                let tested = array(p)?;
                let accepted = array(p)?;
                if !a[0].truthy()? || !a[0].get(c"ANTHROPIC_BASE_URL")?.truthy()? {
                    return fields(
                        p,
                        &[
                            ("tested", tested),
                            ("accepted", accepted),
                            ("error", text(p, "no base url")?),
                        ],
                    );
                }
                let (iterator, _) = list.iterator()?;
                run(fields(
                    p,
                    &[
                        ("host", p),
                        ("iterator", iterator),
                        ("base", a[0]),
                        ("command", fallback(a[2], "claude".into())?),
                        ("tested", tested),
                        ("accepted", accepted),
                    ],
                )?)
            })
        })?,
    )?;
    api.set(
        c"claudeProbeRouteEnv",
        function(p, "claudeProbeRouteEnv", 2, 2, |p, a| {
            if !a[0].truthy()? {
                return null(p);
            }
            let Some(row) = p.catch(|| reg(p, c"getProvider", &[text(p, "claude")?, a[0]]))? else {
                return null(p);
            };
            if !row.truthy()? {
                return null(p);
            }
            let facts = raw(
                p,
                service::provider_claude_routing_facts(env(p), arg(row)?)?,
            );
            if !reg(p, c"summarize", &[row])?.get(c"baseUrl")?.truthy()?
                && !facts.get(c"hasToken")?.truthy()?
            {
                return null(p);
            }
            let config = row.get(c"settingsConfig")?;
            let v = if config.kind()? == sys::ValueType::napi_object {
                config
            } else {
                p.catch(|| call(p.global()?.get(c"JSON")?, c"parse", &[config]))?
                    .unwrap_or(fields(p, &[])?)
            };
            let env = crate::js_live::spread(v.get(c"env")?)?;
            reg(
                p,
                c"applyClaudeProxyEnv",
                &[
                    env,
                    fields(
                        p,
                        &[
                            ("providerId", a[0]),
                            ("sessionId", text(p, "probe")?),
                            ("port", a[1]),
                        ],
                    )?,
                ],
            )?;
            Ok(env)
        })?,
    )?;
    Ok(())
}
