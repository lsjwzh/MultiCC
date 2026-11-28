use super::*;
use crate::delivery_class::RustDeliveryClassifier;
use napi::bindgen_prelude::{External, FromNapiRef, ToNapiValue};

fn classifier<'a>(s: L<'a>, it: L<'a>) -> Result<L<'a>> {
    let mut instance = s.get(c"deliveryClassifier")?;
    if instance.undefined()? {
        let classifier = RustDeliveryClassifier::new(env(s), arg(s)?)?;
        instance = raw(s, unsafe {
            External::to_napi_value(s.env(), External::new(classifier))?
        });
        s.set(c"deliveryClassifier", instance)?;
    }
    let classifier =
        unsafe { External::<RustDeliveryClassifier>::from_napi_ref(s.env(), instance.raw())? };
    Ok(raw(s, classifier.classify(env(s), arg(it)?)?))
}
pub(super) fn typed(p: L<'_>) -> Result<bool> {
    crate::session_work_selection::session_work_is_user_typed(env(p), arg(p)?)
}
fn lineage(it: L<'_>) -> Result<L<'_>> {
    let l = it.optional(c"turnLineage")?;
    if l.truthy()? && l.kind()? == sys::ValueType::napi_object {
        Ok(l)
    } else {
        empty(it)
    }
}
pub(super) fn task(it: L<'_>) -> Result<L<'_>> {
    let direct = lineage(it)?.get(c"taskId")?;
    if direct.truthy()? {
        return Ok(direct);
    }
    let p = it.optional(c"payload")?;
    if p.optional(c"type")?.is_string("dispatch.result")? {
        return null(it);
    }
    let task = p.optional(c"taskId")?;
    if task.truthy()? {
        return Ok(task);
    }
    or(p.optional(c"options")?.optional(c"taskId")?, null(it)?)
}
fn origin(it: L<'_>) -> Result<L<'_>> {
    let direct = lineage(it)?.get(c"originDispatchId")?;
    if direct.truthy()? {
        return Ok(direct);
    }
    let p = it.optional(c"payload")?;
    let id = p.optional(c"originDispatchId")?;
    if id.truthy()? {
        return Ok(id);
    }
    if p.optional(c"type")?.is_string("dispatch.request")? {
        return or(p.get(c"operationId")?, null(it)?);
    }
    null(it)
}
pub(super) fn identity(it: L<'_>) -> Result<L<'_>> {
    let p = it.optional(c"payload")?;
    let client = p.optional(c"options")?.optional(c"clientMsgId")?;
    if client.truthy()? {
        return Ok(client);
    }
    let id = p.optional(c"clientMsgId")?;
    if id.truthy()? {
        Ok(id)
    } else {
        it.get(c"id")
    }
}
fn delivery_text(it: L<'_>) -> Result<L<'_>> {
    let p = or(it.get(c"payload")?, empty(it)?)?;
    let kind = p.get(c"type")?;
    if kind.is_string("session.work")? || kind.is_string("dispatch.request")? {
        return string(or(p.get(c"message")?, text(it, "")?)?);
    }
    let message = p.get(c"deliveryText")?;
    if message.kind()? == sys::ValueType::napi_string && message.truthy()? {
        return Ok(message);
    }
    let mode = p.get(c"mode")?;
    let default = multicc_core::orchestration_store::queue_preview::default_wait_prefix(
        mode.string()?.as_ref(),
    );
    let prefix = or(p.get(c"injectPrefix")?, text(it, default)?)?;
    let data = p.get(c"data")?;
    let rendered = if data.kind()? == sys::ValueType::napi_string {
        data
    } else {
        match it.catch(|| json(data))? {
            Some(v) => v,
            None => string(data)?,
        }
    };
    concat(it, &[prefix, text(it, "\n")?, rendered])
}
fn options<'a>(s: L<'a>, it: L<'a>) -> Result<L<'a>> {
    let p = or(it.get(c"payload")?, empty(it)?)?;
    let kind = p.get(c"type")?;
    let id = it.get(c"id")?;
    let cls = classifier(s, it)?;
    if kind.is_string("session.work")? {
        let l = lineage(it)?;
        let w = l.get(c"workKind")?;
        let w = if w.truthy()? {
            w
        } else {
            or(p.get(c"workKind")?, text(s, "task")?)?
        };
        let out = empty(s)?;
        out.spread_from(p.get(c"options")?)?;
        let active = l.get(c"activeEntryId")?;
        let entry = if active.truthy()? {
            active
        } else {
            or(p.get(c"activeEntryId")?, id)?
        };
        out.spread_from(fields(
            s,
            &[
                ("deliveryClass", cls),
                ("taskId", or(task(it)?, undef(s)?)?),
                ("originDispatchId", or(origin(it)?, undef(s)?)?),
                ("originContinue", flag(s, !w.is_string("task")?)?),
                ("deliveryId", id),
                (
                    "clientMsgId",
                    or(p.get(c"options")?.optional(c"clientMsgId")?, id)?,
                ),
                ("schedulerEntryId", entry),
                ("schedulerWorkKind", w),
                ("directUserInput", flag(s, typed(p)?)?),
                ("userInputRequestId", or(p.get(c"requestId")?, undef(s)?)?),
            ],
        )?)?;
        return Ok(out);
    }
    if kind.is_string("dispatch.request")? {
        return fields(
            s,
            &[
                ("deliveryClass", cls),
                ("originDispatchId", p.get(c"operationId")?),
                ("originContinue", flag(s, false)?),
                ("deliveryId", id),
                ("clientMsgId", or(p.get(c"clientMsgId")?, id)?),
                (
                    "taskShellReceiptId",
                    or(p.get(c"taskShellReceiptId")?, undef(s)?)?,
                ),
                ("receivedAt", p.get(c"receivedAt")?),
                ("taskId", or(p.get(c"taskId")?, undef(s)?)?),
                ("taskStart", flag(s, p.get(c"taskStart")?.is_true()?)?),
                ("taskSource", or(p.get(c"taskSource")?, undef(s)?)?),
                ("taskText", or(p.get(c"taskText")?, undef(s)?)?),
            ],
        );
    }
    fields(
        s,
        &[
            ("deliveryClass", cls),
            ("originContinue", flag(s, true)?),
            ("deliveryId", id),
            ("clientMsgId", id),
            ("taskId", or(task(it)?, undef(s)?)?),
            ("originDispatchId", or(origin(it)?, undef(s)?)?),
        ],
    )
}
pub(super) fn descriptor<'a>(s: L<'a>, it: L<'a>) -> Result<L<'a>> {
    fields(
        s,
        &[
            ("item", it),
            ("sessionId", it.get(c"sessionId")?),
            ("text", delivery_text(it)?),
            ("opts", options(s, it)?),
            ("taskId", task(it)?),
        ],
    )
}
pub(super) fn resolve_lineage(j: L<'_>) -> Result<L<'_>> {
    let it = item(j)?;
    let s = owner(j)?;
    if !it
        .optional(c"payload")?
        .optional(c"type")?
        .is_string("session.work")?
        || origin(it)?.truthy()?
    {
        return Ok(it);
    }
    let task_id = task(it)?;
    if !task_id.truthy()? {
        return Ok(it);
    }
    j.set(c"taskId", task_id)?;
    let query = fields(
        s,
        &[
            ("kind", text(s, "dispatch")?),
            (
                "statuses",
                s.from_value(&V::Array(vec![V::from("running")]))?,
            ),
        ],
    )?;
    then(
        j,
        unit(s, c"operations", c"listReferences", &[query])?,
        |j, live| {
            let s = owner(j)?;
            let it = item(j)?;
            let session = it.get(c"sessionId")?;
            let task = j.get(c"taskId")?;
            let ids = array(s)?;
            live.for_each(|op| {
                let spec = op.get(c"spec")?;
                if spec.optional(c"chatId")?.equals(session)?
                    && spec.optional(c"taskId")?.equals(task)?
                {
                    call(ids, c"push", &[op.get(c"id")?])?;
                }
                Ok(())
            })?;
            let count = ids.get(c"length")?.number()?;
            let report = fields(s, &[("sessionId", session), ("taskId", task)])?;
            if count == 1. {
                let id = ids.element(0)?;
                let l = empty(s)?;
                l.spread_from(lineage(it)?)?;
                l.spread_from(fields(
                    s,
                    &[
                        ("taskId", task),
                        ("originDispatchId", id),
                        ("workKind", text(s, "continuation")?),
                        ("inheritedBy", text(s, "unique_live_task_match")?),
                    ],
                )?)?;
                it.set(c"turnLineage", l)?;
                report.set(c"operationId", id)?;
                log(
                    s,
                    &[
                        text(s, "[orchestration] dispatch_lineage_recovered ")?,
                        json(report)?,
                    ],
                )?;
            } else if count > 1. {
                report.set(c"matches", ids)?;
                log(
                    s,
                    &[
                        text(s, "[orchestration] dispatch_lineage_ambiguous ")?,
                        json(report)?,
                    ],
                )?;
            }
            Ok(it)
        },
    )
}
