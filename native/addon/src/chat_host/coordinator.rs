use super::*;
use crate::host_methods::{arg, args_default, env, raw};
pub(super) mod append;
pub(super) mod usage;

pub(super) fn life<'a>(s: L<'a>, k: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    call(s.get(c"deps")?.get(c"lifecycle")?, k, args)
}
pub(super) fn current<'a>(s: L<'a>, i: L<'a>) -> Result<bool> {
    life(
        s,
        c"ownsCurrentRunner",
        &[
            i.get(c"currentTurn")?,
            i.get(c"currentRunner")?,
            i.get(c"turn")?,
            i.get(c"runner")?,
        ],
    )?
    .is_true()
}
fn require_port(p: L<'_>, k: &CStr, label: &str) -> Result<()> {
    if !callable(p.get(k)?)? {
        return Err(p.type_error(&format!("chat host port missing: {label}")));
    }
    Ok(())
}
fn validate(p: L<'_>) -> Result<L<'_>> {
    if !object(p)? {
        return Err(p.type_error("chat host ports are required"));
    }
    for (k, method, label) in [
        (c"history", c"appendFinal", "history.appendFinal"),
        (c"usage", c"commit", "usage.commit"),
        (c"effects", c"deliver", "effects.deliver"),
    ] {
        let port = p.get(k)?;
        if k == c"effects" && port.nullish()? {
            continue;
        }
        if !object(port)? {
            return Err(p.type_error(&format!("chat host port missing: {}", k.to_string_lossy())));
        }
        if k != c"effects" {
            require_port(port, method, label)?;
        }
    }
    for (group, k, label) in [
        (c"usage", c"afterCommit", "usage.afterCommit"),
        (c"effects", c"deliver", "effects.deliver"),
    ] {
        let v = p.get(group)?.optional(k)?;
        if !v.nullish()? && !callable(v)? {
            return Err(p.type_error(&format!("chat host port invalid: {label}")));
        }
    }
    Ok(p)
}
pub(super) fn finality<'a>(p: L<'a>, r: L<'a>, f: L<'a>) -> Result<L<'a>> {
    raw(
        p,
        crate::chat_turn_lifecycle::decide_chat_runner_finality(env(p), arg(r)?, args_default(f)?)?,
    )
    .freeze()
}
fn is_current<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let h = a[0];
    let get = |k: &CStr, active: &CStr| -> Result<L<'a>> {
        if !h.truthy()? {
            return Ok(h);
        }
        let v = h.get(k)?;
        if v.truthy()? {
            Ok(v)
        } else {
            h.get(active)
        }
    };
    flag(
        p,
        crate::chat_turn_effects::chat_owns_current_runner(
            env(p),
            arg(get(c"currentTurn", c"_activeTurn")?)?,
            arg(get(c"currentRunner", c"_activeRunner")?)?,
            arg(a[1])?,
            arg(a[2])?,
        )?,
    )
}
fn checkpoint<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let v = default_object(a[0])?;
    let value = |k: &CStr, alt: &CStr| -> Result<L<'a>> {
        if !v.get(k)?.nullish()? {
            v.get(k)
        } else {
            v.get(alt)
        }
    };
    let txt = value(c"text", c"currentAssistantText")?;
    let tools = value(c"tools", c"currentToolCalls")?;
    let cost = value(c"cost", c"currentCost")?;
    let payload = fields(
        p,
        &[
            ("text", fallback(txt, "".into())?),
            ("tools", if tools.is_array()? { tools } else { array(p)? }),
            ("cost", if cost.nullish()? { null(p)? } else { cost }),
        ],
    )?;
    let json = json_call(p, c"stringify", payload)?;
    text(
        p,
        &multicc_core::chat_turn_lifecycle::checkpoint_digest(&fold_string(json)?),
    )
}
pub(super) fn getter<'a>(
    obj: L<'a>,
    name: &'static str,
    cb: L<'a>,
    enumerable: bool,
) -> Result<()> {
    define(
        obj,
        text(obj, name)?,
        fields(
            obj,
            &[
                ("get", cb),
                ("enumerable", flag(obj, enumerable)?),
                ("configurable", flag(obj, true)?),
            ],
        )?,
    )
}
pub(super) fn live_input<'a>(from: L<'a>, target: L<'a>) -> Result<()> {
    for (k, name) in [
        (c"currentTurn", "currentTurn"),
        (c"currentRunner", "currentRunner"),
    ] {
        getter(
            target,
            name,
            function(from, name, 0, 0, move |i, _| i.get(k))?,
            true,
        )?;
    }
    Ok(())
}
pub(super) fn decision_facts<'a>(i: L<'a>, facts: L<'a>, strict: bool) -> Result<L<'a>> {
    let v = fields(
        i,
        &[
            ("currentTurn", i.get(c"currentTurn")?),
            ("currentRunner", i.get(c"currentRunner")?),
        ],
    )?;
    for k in [
        c"interrupted",
        c"apiError",
        c"retryPlanned",
        c"handoffResumeFailure",
    ] {
        let f = facts.optional(k)?;
        v.set(k, flag(i, if strict { f.is_true()? } else { f.truthy()? })?)?;
    }
    Ok(v)
}
fn finalize<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(s, || {
        let i = default_object(a[0])?;
        if !current(s, i)? {
            return frozen(
                s,
                &[
                    ("ok", flag(s, false)?),
                    ("code", text(s, "stale_runner")?),
                    (
                        "append",
                        append::result(
                            s,
                            false,
                            false,
                            false,
                            false,
                            text(s, "stale_runner")?,
                            null(s)?,
                        )?,
                    ),
                    (
                        "usage",
                        usage::result(
                            s,
                            false,
                            false,
                            text(s, "stale_runner")?,
                            null(s)?,
                            null(s)?,
                        )?,
                    ),
                ],
            );
        }
        let r = i.get(c"runner")?;
        let f = i.get(c"facts")?;
        if f.optional(c"killReason")?.truthy()? {
            life(s, c"assignKillReason", &[r, f.get(c"killReason")?])?;
        }
        if f.optional(c"retryPlanned")?.is_true()? {
            r.assign(c"retryPlanned", flag(s, true)?)?;
        }
        let ctx = fields(s, &[("s", s), ("i", i), ("r", r)])?;
        then(append::run(s, &mut [i])?, ctx, |ctx, a| {
            let s = ctx.get(c"s")?;
            let i = ctx.get(c"i")?;
            let r = ctx.get(c"r")?;
            let append = a[0];
            let args = spread(i)?;
            live_input(i, args)?;
            args.set(c"usage", i.get(c"usage")?)?;
            let u = usage::run(s, &mut [args])?;
            let t = i.get(c"turn")?;
            let post = life(
                s,
                c"evaluatePostTurn",
                &[t, r, decision_facts(i, i.get(c"facts")?, false)?],
            )?;
            let durable = append.get(c"durable")?.is_true()?;
            frozen(
                s,
                &[
                    ("ok", flag(s, durable && post.get(c"ok")?.is_true()?)?),
                    (
                        "code",
                        if durable {
                            post.get(c"code")?
                        } else {
                            choose(append.get(c"code")?, post.get(c"code")?)?
                        },
                    ),
                    ("append", append),
                    ("usage", u),
                    ("postTurn", post),
                    ("lineage", t.get(c"lineage")?),
                ],
            )
        })
    })
}
pub(super) fn create<'a>(deps: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let ports = validate(a[0])?;
    let opts = default_object(a[1])?;
    let s = fields(
        deps,
        &[
            ("deps", deps),
            ("ports", ports),
            ("sequence", num(deps, 0.)?),
            ("nextId", opts.get(c"nextReservationId")?),
        ],
    )?;
    let out = defaulted_methods(
        s,
        &[
            ("isCurrentTurnRunner", 3, 3, is_current),
            ("assistantCheckpointKey", 0, 1, checkpoint),
            ("appendResult", 0, 1, append::run),
            ("commitUsage", 0, 1, usage::run),
            ("finalize", 0, 1, finalize),
            ("claimPostTurnPlan", 0, 1, delivery::claim),
            ("reservePostTurn", 0, 1, delivery::reserve),
            ("deliverPostTurn", 1, 2, delivery::deliver),
            ("abortPostTurn", 2, 2, delivery::abort),
        ],
    )?;
    out.set(c"appendFinal", out.get(c"appendResult")?)?;
    out.freeze()
}
pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    let out = defaulted_methods(
        p,
        &[
            ("assertChatHostPorts", 1, 1, |_, a| validate(a[0])),
            ("isCurrentTurnRunner", 3, 3, is_current),
            ("assistantCheckpointKey", 0, 1, checkpoint),
            ("decideRunnerFinality", 1, 2, |p, a| finality(p, a[0], a[1])),
            ("createChatHostCoordinator", 1, 2, create),
            ("buildAdapterUserInputSignal", 0, 1, questions::signal),
            ("recordAdapterUserInput", 0, 1, questions::record),
            ("recordAdapterQuestion", 1, 1, questions::question),
            ("prepareQuestionReplay", 1, 1, questions::replay),
        ],
    )?;
    let names = |v: &str| -> Result<L<'_>> {
        let a = array(p)?;
        a.set_element(0, text(p, v)?)?;
        a.freeze()
    };
    out.set(
        c"CHAT_HOST_PORTS",
        frozen(
            p,
            &[
                ("history", names("appendFinal")?),
                ("usage", names("commit")?),
                ("effects", array(p)?.freeze()?),
            ],
        )?,
    )?;
    Ok(out)
}
