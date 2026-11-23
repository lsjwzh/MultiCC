//! 从合并任务的历史恢复续发上下文。每一条消息引用优先归属于最具体的来源卡，
//! 靠前的消息保留位置，后遇到的同 ID 消息更新内容。
use crate::{
    js_live::LiveValue as L,
    task_board_host::{concat, js_string, Host, Properties},
    task_board_transcript::{context_messages, legacy_import},
    task_run_context::board_context,
};
use multicc_core::js::{JsString, JsValue as J};
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
    Env, Result,
};
use std::{collections::HashSet, ffi::CStr};

fn order_members<'a>(env: &'a Env, host: Host<'a>, task: L<'a>, ids: L<'a>) -> Result<L<'a>> {
    let members = host.value(J::Array(vec![]))?;
    ids.for_each(|id| {
        let member = host.tasks()?.get_key(id)?;
        if member.truthy()? {
            members.invoke(c"push", &[member])?;
        }
        Ok(())
    })?;
    let compare =
        env.create_function_from_closure::<Unknown<'_>, f64, _>("taskRefOrder", |ctx| {
            let task = L::new(ctx.env, ctx.get(0)?);
            let left = L::new(ctx.env, ctx.get(1)?);
            let right = L::new(ctx.env, ctx.get(2)?);
            if left.get(c"id")?.equals(task.get(c"id")?)? {
                return Ok(1.0);
            }
            if right.get(c"id")?.equals(task.get(c"id")?)? {
                return Ok(-1.0);
            }
            let count = |m: L| {
                m.get(c"refs")?
                    .optional(c"length")?
                    .or(|| m.from_value(&J::Number(0.0)))?
                    .number()
            };
            let delta = count(left)? - count(right)?;
            if delta != 0.0 && !delta.is_nan() {
                return Ok(delta);
            }
            js_string(left.get(c"id")?)?
                .invoke(c"localeCompare", &[js_string(right.get(c"id")?)?])?
                .number()
        })?;
    let cmp = L::new(env, compare.into_unknown(env)?)
        .invoke(c"bind", &[host.value(J::Undefined)?, task])?;
    members.invoke(c"sort", &[cmp])
}

fn key(prefix: &str, pieces: &[L]) -> Result<JsString> {
    let mut out = JsString::from(prefix);
    for piece in pieces {
        out.push_unit(0);
        out.push(&piece.coerce_string()?);
    }
    Ok(out)
}

fn claim_ref<'a>(
    host: Host<'a>,
    reference: L<'a>,
    claimed: &mut HashSet<JsString>,
) -> Result<Option<L<'a>>> {
    let session = js_string(reference.optional(c"sessionId")?.or(|| host.value(""))?)?;
    let msg_key = |field: &CStr, prefix| -> Result<Option<JsString>> {
        if !reference.optional(field)?.truthy()? {
            return Ok(None);
        }
        Ok(Some(key(prefix, &[session, reference.get(field)?])?))
    };
    let user = msg_key(c"userMsgId", "u")?;
    let assistant = msg_key(c"assistantMsgId", "a")?;
    if user.is_none() && assistant.is_none() {
        let ts = reference.optional(c"ts")?.explicit_number()?;
        let ts = host.value(if ts.is_nan() { 0.0 } else { ts })?;
        let excerpt = js_string(reference.optional(c"excerpt")?.or(|| host.value(""))?)?;
        return Ok(claimed
            .insert(key("l", &[session, ts, excerpt])?)
            .then_some(reference));
    }
    let projected = host.object(&[])?;
    projected.spread_from(reference)?;
    let seen_user = user.as_ref().is_some_and(|k| claimed.contains(k));
    projected.set(
        c"userMsgId",
        if user.is_some() && !seen_user {
            reference.get(c"userMsgId")?
        } else {
            host.null()?
        },
    )?;
    projected.set(
        c"assistantMsgId",
        if assistant.as_ref().is_some_and(|k| !claimed.contains(k)) {
            reference.get(c"assistantMsgId")?
        } else {
            host.null()?
        },
    )?;
    projected.set(
        c"excerpt",
        if seen_user {
            host.value("")?
        } else {
            reference.get(c"excerpt")?
        },
    )?;
    claimed.extend(user.into_iter().chain(assistant));
    Ok(
        (projected.get(c"userMsgId")?.truthy()? || projected.get(c"assistantMsgId")?.truthy()?)
            .then_some(projected),
    )
}

fn build_seed<'a>(env: &'a Env, host: Host<'a>, task: L<'a>) -> Result<L<'a>> {
    let ids = host.core(c"taskLineageIds", &[host.board()?, task.get(c"id")?])?;
    let map = host.0.global()?.get(c"Map")?;
    let ownership = map.construct(&[])?;
    let mut claimed = HashSet::new();
    order_members(env, host, task, ids)?.for_each(|member| {
        let owned = host.value(J::Array(vec![]))?;
        let refs = member.get(c"refs")?;
        if refs.truthy()? {
            refs.for_each(|reference| {
                if let Some(projected) = claim_ref(host, reference, &mut claimed)? {
                    owned.invoke(c"push", &[projected])?;
                }
                Ok(())
            })?;
        }
        ownership.invoke(c"set", &[member.get(c"id")?, owned])?;
        Ok(())
    })?;
    let messages = map.construct(&[])?;
    ids.for_each(|id| {
        let member = host.tasks()?.get_key(id)?;
        if !member.truthy()? {
            return Ok(());
        }
        let projected = host.object(&[])?;
        projected.spread_from(member)?;
        projected.set(
            c"refs",
            ownership
                .invoke(c"get", &[id])?
                .or(|| host.value(J::Array(vec![])))?,
        )?;
        let live = host.tasks()?.get_key(id)?;
        let view = if live.truthy()? {
            host.object(&[
                (c"refs", live.get(c"refs")?),
                (c"routing", live.get(c"routing")?),
            ])?
        } else {
            host.null()?
        };
        let views = host.value(J::Array(vec![]))?;
        views.set_element(0, view)?;
        let text = host.0.get(c"core")?.get(c"messageText")?;
        legacy_import(views, &[id], projected, host.0.get(c"loadHistory")?, text)?.for_each(
            |message| {
                messages.invoke(c"set", &[message.get(c"messageId")?, message])?;
                Ok(())
            },
        )
    })?;
    let entries = host
        .0
        .global()?
        .get(c"Array")?
        .invoke(c"from", &[messages.invoke(c"values", &[])?])?;
    let imports = context_messages(entries, host.0.get(c"core")?.get(c"messageText")?)?;
    let input = host.object(&[
        (c"task", task),
        (c"messages", imports),
        (c"includeCurrent", host.value(false)?),
    ])?;
    let render = host.0.get(c"buildTaskRunContext")?;
    let context = if render.truthy()? {
        render.call_plain(&[input])?
    } else {
        board_context(env, input)?
    };
    if context.get(c"text")?.invoke(c"trim", &[])?.truthy()? {
        concat(host, &[context.get(c"text")?, host.value("\n\n")?])
    } else {
        host.value("")
    }
}

pub(crate) fn cold_start<'a>(
    env: &'a Env,
    host: Host<'a>,
    bound: L<'a>,
    task: L<'a>,
) -> Result<L<'a>> {
    if host.record(bound)?.optional(c"cliSessionId")?.truthy()? {
        return host.value("");
    }
    match host.0.catch(|| build_seed(env, host, task))? {
        Some(seed) => Ok(seed),
        None => host.value(""),
    }
}
