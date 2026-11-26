//! 收尾效果端口。会话对象、持久化、分类器、等待器和 Git 工作均由现有宿主持有。
use super::*;

fn undefined(s: L<'_>) -> Result<L<'_>> {
    s.from_value(&V::Undefined)
}

fn observe_rejection(value: L<'_>) -> Result<()> {
    let promise = call(value.global()?.get(c"Promise")?, c"resolve", &[value])?;
    let env = Env::from_raw(value.env());
    let ignore = method(&env, value, "", 0, 0, |s, _| undefined(s))?;
    call(promise, c"catch", &[ignore])?;
    Ok(())
}

fn persist<'a>(p: L<'a>, c: L<'a>, append: L<'a>) -> Result<L<'a>> {
    let session = prop(c, c"sessionName")?;
    let cs = prop(c, c"cs")?;
    let turn = prop(c, c"turn")?;
    let runner = prop(c, c"runner")?;
    let content = prop(prop(c, c"cs")?, c"currentAssistantText")?;
    let tools = if prop(prop(prop(c, c"cs")?, c"currentToolCalls")?, c"length")?.truthy()? {
        prop(prop(c, c"cs")?, c"currentToolCalls")?
    } else {
        undefined(c)?
    };
    let msg = fields(
        c,
        &[
            ("role", text(c, "assistant")?),
            ("content", content),
            ("tools", tools),
            ("cost", prop(prop(c, c"cs")?, c"currentCost")?),
        ],
    )?;
    if prop(prop(c, c"runner")?, c"pendingUsage")?.truthy()?
        && call(
            p.global()?.get(c"Object")?,
            c"keys",
            &[prop(prop(c, c"runner")?, c"pendingUsage")?],
        )?
        .get(c"length")?
        .truthy()?
    {
        msg.set(c"usage", prop(prop(c, c"runner")?, c"pendingUsage")?)?;
    }
    msg.set(c"ts", call(p.global()?.get(c"Date")?, c"now", &[])?)?;
    msg.set(
        c"turnTimings",
        port(
            p,
            c"turnTimingsField",
            &[
                prop(c, c"sessionName")?,
                prop(prop(c, c"turn")?, c"turnId")?,
            ],
        )?,
    )?;
    if prop(append, c"partial")?.truthy()? {
        msg.set(c"partial", flag(c, true)?)?;
    }
    port(
        p,
        c"persistFinalAssistantResult",
        &[
            session,
            cs,
            turn,
            runner,
            msg,
            fields(c, &[("final", prop(append, c"final")?)])?,
        ],
    )
}

fn complete<'a>(p: L<'a>, s: L<'a>) -> Result<L<'a>> {
    call(port(p, c"getSessionWorkHost", &[])?, c"turnSucceeded", &[s])?;
    let getter = p.get(c"getSessionGitRuntime")?;
    let git = if getter.kind()? == sys::ValueType::napi_function {
        getter.call_plain(&[])?
    } else {
        null(p)?
    };
    if git.truthy()? && prop(git, c"autoCommitTurn")?.kind()? == sys::ValueType::napi_function {
        observe_rejection(call(git, c"autoCommitTurn", &[s])?)?;
    }
    undefined(p)
}
fn post<'a>(p: L<'a>, c: L<'a>, entry: L<'a>) -> Result<L<'a>> {
    port(
        p,
        c"runDurablePostTurn",
        &[
            prop(c, c"sessionName")?,
            prop(c, c"cs")?,
            prop(c, c"persisted")?,
            prop(c, c"turn")?,
            prop(c, c"runner")?,
            fallback(prop(c, c"finalText")?, "".into())?,
            fields(
                p,
                &[
                    ("interrupted", prop(entry, c"interrupted")?),
                    ("apiError", prop(entry, c"apiError")?),
                    ("retryPlanned", prop(entry, c"retryPlanned")?),
                    (
                        "handoffResumeFailure",
                        prop(entry, c"handoffResumeFailure")?,
                    ),
                ],
            )?,
        ],
    )?;
    undefined(p)
}

pub(super) fn executor_ports<'a>(env: &'a Env, p: L<'a>) -> Result<L<'a>> {
    let out = fields(
        p,
        &[
            ("broadcast", p.get(c"chatBroadcast")?),
            ("timelineField", prop(p.get(c"turnTimeline")?, c"field")?),
            ("cancelClassify", p.get(c"cancelClassify")?),
            ("classifyTurnEnd", p.get(c"classifyTurnEnd")?),
            ("emitTurnOutcome", p.get(c"emitTurnOutcome")?),
        ],
    )?;
    type Handler = for<'b> fn(L<'b>, &mut [L<'b>]) -> Result<L<'b>>;
    for (name, n, run) in [
        (
            "withQuestionSnapshot",
            2,
            (|p, a: &mut [L<'_>]| {
                let host = p.get(c"userInputSignalHost")?;
                if host.optional(c"withSnapshotAsync")?.kind()? == sys::ValueType::napi_function {
                    call(host, c"withSnapshotAsync", &a[..2])
                } else {
                    a[1].call_plain(&[])
                }
            }) as Handler,
        ),
        ("syncQuestionTurn", 1, |p, a| {
            let host = p.get(c"userInputSignalHost")?;
            if host.nullish()? {
                undefined(p)
            } else {
                optional_call(host, c"activateTurnAsync", &a[..1])
            }
        }),
        ("recordRunResult", 2, |p, a| {
            call(p.get(c"managedContext")?, c"contextCompleted", &a[..2])?;
            let get = p.get(c"getWorkspaceAdmission")?;
            if get.nullish()? {
                return undefined(p);
            }
            let adm = get.call_plain(&[])?;
            if adm.nullish()? {
                undefined(p)
            } else {
                call(adm, c"finalized", &a[..2])
            }
        }),
        ("persistAssistant", 2, |p, a| persist(p, a[0], a[1])),
        ("commitUsage", 1, |p, a| {
            let c = a[0];
            port(
                p,
                c"recordDurableTurnUsage",
                &[
                    prop(c, c"sessionName")?,
                    prop(c, c"runner")?,
                    prop(prop(c, c"runner")?, c"pendingUsage")?,
                ],
            )
        }),
        ("clearReplay", 1, |p, a| {
            call(p.get(c"replay")?, c"clear", &a[..1])
        }),
        ("clearIncrementalSave", 1, |p, a| {
            call(
                port(p, c"getChatHistoryRuntime", &[])?,
                c"clearIncrementalSave",
                &a[..1],
            )
        }),
        ("setStatus", 2, |p, a| {
            port(
                p,
                c"setSessionStatus",
                &[
                    a[0],
                    fields(p, &[("status", a[1]), ("currentFile", null(p)?)])?,
                ],
            )?;
            undefined(p)
        }),
        ("completeSessionTurn", 1, |p, a| complete(p, a[0])),
        ("resetInterrupted", 1, |p, a| {
            call(p.get(c"waitInjector")?, c"resetInterrupted", &a[..1])
        }),
        ("resumeInterrupted", 1, |p, a| {
            call(p.get(c"waitInjector")?, c"resumeInterrupted", &a[..1])
        }),
        ("freezeInterrupted", 2, |p, a| {
            observe_rejection(call(
                port(p, c"getSessionWorkHost", &[])?,
                c"turnFailed",
                &a[..2],
            )?)?;
            undefined(p)
        }),
        ("runPostTurn", 2, |p, a| post(p, a[0], a[1])),
        ("log", 2, |p, a| {
            if a[0].is_string("interrupted-resume")? {
                let mut message = multicc_core::js::JsString::from("[multicc/chat] [");
                message.push(&prop(a[1], c"sessionName")?.coerce_string()?);
                message.push_str("] (streaming) 非正常中断 (no result event, kill=none) → resume");
                call(
                    p.global()?.get(c"console")?,
                    c"log",
                    &[p.from_value(&V::String(message))?],
                )?;
            }
            undefined(p)
        }),
        ("logError", 2, |p, a| {
            if a[0].is_string("post-turn-failed")? {
                call(
                    p.global()?.get(c"console")?,
                    c"error",
                    &[
                        text(p, "[multicc/dispatch] post-turn hook failed:")?,
                        prop(prop(a[1], c"error")?, c"message")?,
                    ],
                )?;
            }
            undefined(p)
        }),
    ] {
        out.define_key(text(p, name)?, method(env, p, name, n, n, run)?)?;
    }
    Ok(out)
}
