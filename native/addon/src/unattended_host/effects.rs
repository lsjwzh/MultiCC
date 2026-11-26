use super::*;
pub(super) fn trace<'a>(p: L<'a>, id: L<'a>, msg: L<'a>) -> Result<()> {
    if !callable(p.get(c"appendMessage")?)? {
        return Ok(());
    }
    let entry = fields(
        p,
        &[
            ("role", text(p, "system")?),
            ("kind", text(p, "unattended_trace")?),
            ("content", msg),
            ("ts", now(p)?),
        ],
    )?;
    let f = frame(p, id)?;
    f.set(c"entry", entry)?;
    let saved = match port(p, c"appendMessage", &[id, entry]) {
        Ok(v) => v,
        Err(e) => {
            log_err(f, "trace append failed", caught(p, e)?)?;
            return Ok(());
        }
    };
    fn publish<'a>(f: L<'a>, saved: L<'a>) -> Result<L<'a>> {
        if !saved.is_false()? {
            let e = f.get(c"entry")?;
            let kind = text(f, "unattended_trace")?;
            f.catch(|| {
                port(
                    f.get(c"host")?,
                    c"broadcast",
                    &[
                        f.get(c"id")?,
                        fields(
                            f,
                            &[
                                ("type", kind),
                                ("kind", kind),
                                ("message", e.get(c"content")?),
                                ("entry", e),
                            ],
                        )?,
                    ],
                )
            })?;
        }
        undef(f)
    }
    if callable(saved.optional(c"then")?)? {
        call(
            saved,
            c"then",
            &[
                cont(f, publish)?,
                cont(f, |f, e| {
                    log_err(f, "trace append failed", e)?;
                    undef(f)
                })?,
            ],
        )?;
    } else {
        publish(f, saved)?;
    }
    Ok(())
}
pub(super) fn decision_trace<'a>(p: L<'a>, id: L<'a>, d: L<'a>) -> Result<()> {
    let last = d.get(c"nextState")?.optional(c"lastVerdict")?;
    let reason = clean(p, last.optional(c"reason")?)?;
    let instr = clean(p, last.optional(c"nextInstruction")?)?;
    let msg = clean(p, d.get(c"message")?)?;
    let pick = |v: Vec<String>| v.into_iter().find(|s| !s.is_empty()).unwrap_or_default();
    let s = match js(d.get(c"action")?)?.as_str() {
        "inject" => format!(
            "判定：继续 · {} · 下一步：{}",
            pick(vec![reason, "继续".into()]),
            pick(vec![instr, clean(p, d.get(c"answer")?)?, msg])
        ),
        "achieved" => format!("判定：达成 · {}", pick(vec![reason, "目标已达成".into()])),
        "needs_human" => format!(
            "判定：需要人工 · {}",
            pick(vec![
                clean(p, last.optional(c"humanReason")?)?,
                msg,
                "有只有人才能解决的问题".into()
            ])
        ),
        "stalled" => format!(
            "判定：停滞 · {}",
            pick(vec![reason, msg, "连续给出同一条指令却没有进展".into()])
        ),
        "exhausted" => format!(
            "判定：时长用尽 · {}",
            pick(vec![msg, "已达到最长值守时间".into()])
        ),
        "error" => format!(
            "判定：出错 · {}",
            pick(vec![msg, "辅助模型未能给出可解析的判定".into()])
        ),
        _ => return Ok(()),
    };
    trace(p, id, tagged(p, &s)?)
}
pub(super) fn hold<'a>(p: L<'a>, id: L<'a>, push: L<'a>) -> Result<()> {
    if callable(push)? {
        let mut list = store(p, c"heldPushes", c"get", &[id])?;
        if list.undefined()? {
            list = arr(p)?;
            store(p, c"heldPushes", c"set", &[id, list])?;
        }
        call(list, c"push", &[push])?;
    }
    Ok(())
}
pub(super) fn fire<'a>(p: L<'a>, push: L<'a>) -> Result<()> {
    if callable(push)? {
        if let Err(e) = push.call_plain(&[]) {
            let e = caught(p, e)?;
            log(
                p,
                &format!(
                    "fallback push failed: {}",
                    js(or(e.optional(c"message")?, e)?)?
                ),
            )?;
        }
    }
    Ok(())
}
pub(super) fn release<'a>(p: L<'a>, id: L<'a>) -> Result<()> {
    let list = store(p, c"heldPushes", c"get", &[id])?;
    if list.truthy()? {
        store(p, c"heldPushes", c"delete", &[id])?;
        list.for_each(|push| fire(p, push))?;
    }
    Ok(())
}
fn remove<'a>(p: L<'a>, id: L<'a>, entry: L<'a>) -> Result<()> {
    if !callable(p.get(c"withdrawQueued")?)? {
        return Ok(());
    }
    let f = frame(p, id)?;
    let promise = async_result(f, || port(p, c"withdrawQueued", &[id, entry]))?;
    ignore(f, promise, "queued continuation withdraw failed")
}
pub(super) fn withdraw_ids<'a>(p: L<'a>, id: L<'a>, ids: L<'a>) -> Result<()> {
    if ids.is_array()? {
        ids.for_each(|v| remove(p, id, v))?;
    }
    Ok(())
}
pub(super) fn withdraw<'a>(p: L<'a>, id: L<'a>, only: Option<&str>) -> Result<()> {
    let entries = store(p, c"pendingInjections", c"get", &[id])?;
    if entries.undefined()? {
        return Ok(());
    }
    entries.for_each(|pair| {
        if let Some(kind) = only {
            if !pair.element(1)?.is_string(kind)? {
                return Ok(());
            }
        }
        let k = pair.element(0)?;
        call(entries, c"delete", &[k])?;
        remove(p, id, k)
    })?;
    if !entries.get(c"size")?.truthy()? {
        store(p, c"pendingInjections", c"delete", &[id])?;
    }
    Ok(())
}
pub(super) fn receipt<'a>(f: L<'a>, result: L<'a>, fault: bool) -> Result<()> {
    let p = f.get(c"host")?;
    let id = f.get(c"id")?;
    if !callable(p.get(c"withdrawQueued")?)?
        || !result.truthy()?
        || result.get(c"ok")?.is_false()?
        || result.get(c"duplicate")?.is_true()?
        || (!fault && !result.get(c"queued")?.is_true()?)
    {
        return Ok(());
    }
    let entry = result.get(c"entry")?.optional(c"id")?;
    if !entry.truthy()? {
        return Ok(());
    }
    if !current(f)?
        || !active(state(p, id)?)?
        || (fault
            && !f
                .get(c"faultEpoch")?
                .equals(store(p, c"faultEpoch", c"get", &[id])?)?)
    {
        return remove(p, id, entry);
    }
    let mut m = store(p, c"pendingInjections", c"get", &[id])?;
    if m.undefined()? {
        m = p.global()?.get(c"Map")?.construct(&[])?;
        store(p, c"pendingInjections", c"set", &[id, m])?;
    }
    call(
        m,
        c"set",
        &[entry, text(p, if fault { "fault" } else { "other" })?],
    )?;
    Ok(())
}
pub(super) fn admission<'a>(f: L<'a>, sent: L<'a>, fault: bool, wait: bool) -> Result<L<'a>> {
    if !callable(f.get(c"host")?.get(c"withdrawQueued")?)? && !wait {
        return undef(f);
    }
    if !wait && !callable(sent.optional(c"then")?)? {
        receipt(f, sent, fault)?;
        return undef(f);
    }
    let cb = function(f, "", 1, 1, move |f, a| {
        receipt(f, a[0], fault)?;
        undef(f)
    })?;
    let done = call(resolved(sent)?, c"then", &[cb])?;
    if wait {
        Ok(done)
    } else {
        ignore(f, done, "continuation admission failed")?;
        undef(f)
    }
}
pub(super) fn apply<'a>(f: L<'a>, d: L<'a>) -> Result<L<'a>> {
    let p = f.get(c"host")?;
    let id = f.get(c"id")?;
    let msg = d.get(c"message")?;
    let (status, class) = match js(d.get(c"action")?)?.as_str() {
        "inject" => {
            let ans = d.get(c"answer")?;
            let question = d.get(c"pendingQuestionId")?;
            let yes = flag(p, true)?;
            if ans.truthy()? && question.truthy()? && callable(p.get(c"deliver")?)? {
                let sent = port(
                    p,
                    c"deliver",
                    &[
                        id,
                        tagged(p, &js(ans)?)?,
                        fields(
                            p,
                            &[
                                ("userInputRequestId", question),
                                ("unattendedSystem", yes),
                                ("unattendedRecovery", yes),
                                ("system", yes),
                            ],
                        )?,
                    ],
                )?;
                return admission(f, sent, false, true);
            }
            if callable(p.get(c"inject")?)? {
                let sent = port(
                    p,
                    c"inject",
                    &[
                        id,
                        tagged(p, &js(msg)?)?,
                        fields(
                            p,
                            &[(
                                "unattendedRecovery",
                                flag(p, d.get(c"recovery")?.is_true()?)?,
                            )],
                        )?,
                    ],
                )?;
                return admission(f, sent, false, false);
            }
            return undef(p);
        }
        "achieved" => {
            if callable(p.get(c"setTaskState")?)? {
                if let Err(e) = port(
                    p,
                    c"setTaskState",
                    &[
                        id,
                        fields(
                            p,
                            &[
                                ("goalState", text(p, "achieved")?),
                                ("goalStateManualAt", now(p)?),
                            ],
                        )?,
                    ],
                ) {
                    log_err(f, "goalState write failed", caught(p, e)?)?;
                }
            }
            ("succeeded", "D")
        }
        "needs_human" | "stalled" => ("waiting", "W"),
        "exhausted" | "error" => ("error", "E"),
        _ => return undef(p),
    };
    let st = text(p, status)?;
    let cls = text(p, class)?;
    let extra = fields(p, &[("classifyState", cls)])?;
    let event = fields(
        p,
        &[
            ("type", text(p, "notify")?),
            ("state", st),
            ("classifyState", cls),
            ("message", msg),
        ],
    )?;
    if class == "D" {
        extra.set(c"goalState", text(p, "achieved")?)?;
        event.set(c"goalState", text(p, "achieved")?)?;
    }
    port(p, c"notify", &[id, st, msg, extra])?;
    port(p, c"broadcast", &[id, event])?;
    undef(p)
}
