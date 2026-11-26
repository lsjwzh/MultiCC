use super::*;

fn capture<'a>(observe: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let source = observe.call_plain(&[id])?;
    let category = fields(id, &[])?;
    let source = if source.kind()? == sys::ValueType::napi_object && source.truthy()? {
        source
    } else {
        fields(id, &[])?
    };
    for k in [
        c"classifyState".as_ref(),
        c"startedAt",
        c"endedAt",
        c"lastTurnEndedAt",
        c"unattended",
        c"userInputSignalTurnId",
        c"recoveryRecordType",
    ] {
        let value = source.get(k)?;
        if !value.undefined()? {
            category.set(k, value)?;
        }
    }
    if category.get(c"recoveryRecordType")?.undefined()? {
        category.set(c"recoveryRecordType", null(id)?)?;
    }
    let task = source.get(c"taskId")?;
    let active = if task.nullish()? {
        null(id)?
    } else {
        fields(id, &[("_currentTaskId", task)])?
    };
    let initial = fields(
        id,
        &[
            (
                "pendingQuestionJson",
                json(
                    default(source.get(c"pendingUserInput")?, null(id)?)?,
                    c"stringify",
                )?,
            ),
            ("activeTurnJson", json(active, c"stringify")?),
            ("categoryJson", json(category, c"stringify")?),
        ],
    )?;
    fields(id, &[("sessionId", id), ("initial", initial)])
}
pub(super) fn recover(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"owner")?;
    let store = s.get(c"store")?;
    let observe = default(
        f.get(c"opts")?.get(c"stateForSession")?,
        function(s, "stateForSession", 0, 0, |s, _| null(s))?,
    )?;
    f.set(c"observe", observe)?;
    if callable(store.get(c"mutateSync")?)? {
        let at = clock(s)?;
        let input = fields(
            s,
            &[
                ("at", at),
                ("updatedAt", at),
                (
                    "capture",
                    function(f, "capture", 1, 1, |f, a| capture(f.get(c"observe")?, a[0]))?,
                ),
            ],
        )?;
        let p = call(
            store,
            c"mutateSync",
            &[text(s, "scheduleRecoverOwned")?, input],
        )?;
        then(f, p, |f, committed| {
            let json = describe(committed.get(c"resultJson")?)?;
            let result =
                crate::schedule_recovery_live::decode_scheduler_recovery_events(env(f), json)?;
            project_events(f, raw(f, result))
        })
    } else {
        let mutate = function(f, "", 1, 1, |f, a| {
            let draft = a[0];
            let s = f.get(c"owner")?;
            let q = function(draft, "queueForDraft", 2, 2, |_, v| {
                projection::queue(v[0], v[1])
            })?;
            let proj = function(draft, "publicSchedule", 1, 3, |draft, v| {
                projection::project(default(v[2], draft)?, v[0], v[1])
            })?;
            let result = crate::schedule_recovery_live::schedule_recover_live(
                env(draft),
                arg(draft)?,
                arg(f.get(c"observe")?)?,
                arg(s.get(c"now")?)?,
                arg(q)?,
                arg(proj)?,
            )?;
            Ok(raw(draft, result))
        })?;
        then(f, call(store, c"mutate", &[mutate])?, project_events)
    }
}
fn project_events<'a>(f: L<'a>, events: L<'a>) -> Result<L<'a>> {
    let mut ids = Vec::new();
    events.for_each(|e| {
        ids.push(e.get(c"sessionId")?);
        Ok(())
    })?;
    f.set(c"events", events)?;
    let result = operations::run(f.get(c"owner")?, Op::Summaries, &[array(f, &ids)?])?;
    then(f, result, |f, summaries| {
        let owner = f.get(c"owner")?;
        let events = f.get(c"events")?;
        let map = f.global()?.get(c"Map")?.construct(&[])?;
        summaries.for_each(|r| {
            call(map, c"set", &[r.get(c"sessionId")?, r])?;
            Ok(())
        })?;
        events.for_each(|e| {
            let id = e.get(c"sessionId")?;
            let typ = e.get(c"type")?;
            let queued = e.get(c"queued")?;
            let out = fields(
                owner,
                &[
                    ("sessionId", id),
                    ("entryId", fallback(e.get(c"entryId")?, V::Null)?),
                    ("taskId", fallback(e.get(c"taskId")?, V::Null)?),
                    ("queued", if queued.nullish()? { null(e)? } else { queued }),
                    ("queuedItems", or(e.get(c"queuedItems")?, empty_array(e)?)?),
                    (
                        "freezeReason",
                        if typ.is_string("frozen")? {
                            e.get(c"reason")?
                        } else {
                            null(e)?
                        },
                    ),
                    (
                        "classifyState",
                        fallback(e.get(c"classifyState")?, V::Null)?,
                    ),
                    ("turnOutcome", fallback(e.get(c"turnOutcome")?, V::Null)?),
                    (
                        "queueSummary",
                        fallback(call(map, c"get", &[id])?, V::Null)?,
                    ),
                    ("recovered", flag(e, true)?),
                ],
            )?;
            events::emit(owner, &describe(typ)?, out, null(e)?)
        })?;
        fields(
            owner,
            &[
                ("ok", flag(owner, true)?),
                ("changes", events.get(c"length")?),
            ],
        )
    })
}
