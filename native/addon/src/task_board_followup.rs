//! 已绑定任务的续发。绑定及发送由宿主等待；回执返回时在原任务对象上更新路由，
//! 若落盘失败则还原发送前的卡片，并明确回报消息已经送达。
use crate::{
    js_live::LiveValue as L,
    task_board_host::{concat, js_string, refusal, Host, Properties},
    task_board_seed::cold_start,
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

#[napi]
pub struct TaskBoardFollowup {}

#[napi]
impl TaskBoardFollowup {
    #[napi]
    pub fn prepare(
        env: Env,
        ports: Unknown<'_>,
        commander: Unknown<'_>,
        id: Unknown<'_>,
        text: Unknown<'_>,
        options: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let h = Host(L::new(&env, ports));
        let commander = L::new(&env, commander);
        let record = h.record(commander)?;
        let id = L::new(&env, id);
        let task = h.0.get(c"resolvedTask")?.call_plain(&[id])?;
        if !record.truthy()?
            || !record.get(c"type")?.is_string("commander")?
            || !record.get(c"kind")?.is_string("chat")?
        {
            return Ok(refusal(h, "commander_not_found")?.raw());
        }
        if !task.truthy()? {
            return Ok(refusal(h, "task_not_found")?.raw());
        }
        let text = js_string(L::new(&env, text).or(|| h.value(""))?)?.invoke(c"trim", &[])?;
        if task.get(c"status")?.is_string("archived")?
            || task.get(c"deleting")?.truthy()?
            || h.0
                .get(c"isTaskBusy")?
                .call_plain(&[task.get(c"id")?])?
                .truthy()?
        {
            return Ok(refusal(h, "task_archived")?.raw());
        }
        if !text.truthy()? {
            return Ok(refusal(h, "empty_text")?.raw());
        }
        let options = L::new(&env, options);
        if options.nullish()? {
            return Err(
                options.type_error("Cannot read properties of null (reading 'clientMsgId')")
            );
        }
        let key = js_string(options.get(c"clientMsgId")?.or(|| h.value(""))?)?
            .invoke(c"trim", &[])?
            .or(|| h.0.get(c"crypto")?.invoke(c"randomUUID", &[]))?;
        let source = h.value(if options.get(c"source")?.is_string("commander")? {
            "commander"
        } else {
            "task-board"
        })?;
        let bind = h.object(&[(c"dirId", record.get(c"dirId")?)])?;
        let pending =
            h.0.get(c"ensureBoundChatSession")?
                .call_plain(&[task, bind])?;
        Ok(h.object(&[
            (c"ports", h.0),
            (c"task", task),
            (c"requestedId", id),
            (c"commander", commander),
            (c"text", text),
            (c"clientKey", key),
            (c"source", source),
            (c"options", options),
            (c"pending", pending),
        ])?
        .raw())
    }

    #[napi]
    pub fn bound(env: Env, input: Unknown<'_>, bound: Unknown<'_>) -> Result<sys::napi_value> {
        let input = L::new(&env, input);
        let h = Host(input.get(c"ports")?);
        let bound = L::new(&env, bound);
        if !bound.optional(c"ok")?.truthy()? {
            let reason = bound.optional(c"code")?.or(|| h.value("unknown"))?;
            let message = concat(
                h,
                &[
                    h.value("[multicc/taskboard] follow-up bound-session resolve failed for ")?,
                    input.get(c"requestedId")?,
                    h.value(": ")?,
                    reason,
                ],
            )?;
            h.0.get(c"logger")?.invoke(c"log", &[message])?;
            return Ok(bound.or(|| refusal(h, "chat_session_create_failed"))?.raw());
        }
        input.set(c"boundId", bound.get(c"sessionId")?)?;
        input.set(
            c"goalNote",
            js_string(
                input
                    .get(c"options")?
                    .get(c"goalNote")?
                    .or(|| h.value(""))?,
            )?,
        )?;
        Ok(h.null()?.raw())
    }

    #[napi]
    pub fn send(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
        let input = L::new(&env, input);
        let h = Host(input.get(c"ports")?);
        let task = input.get(c"task")?;
        let bound = input.get(c"boundId")?;
        let json = input.global()?.get(c"JSON")?;
        input.set(
            c"before",
            json.invoke(c"parse", &[json.invoke(c"stringify", &[task])?])?,
        )?;
        let seed = cold_start(&env, h, bound, task)?;
        let text = concat(h, &[input.get(c"goalNote")?, input.get(c"text")?])?;
        let options = h.object(&[
            (c"taskId", task.get(c"id")?),
            (c"taskSource", input.get(c"source")?),
            (c"clientMsgId", input.get(c"clientKey")?),
        ])?;
        if seed.truthy()? {
            options.set(c"taskContextSeed", seed)?;
        }
        Ok(h.0
            .get(c"sendSessionMessage")?
            .call_plain(&[bound, text, options])?
            .raw())
    }

    #[napi]
    pub fn sent(env: Env, input: Unknown<'_>, receipt: Unknown<'_>) -> Result<sys::napi_value> {
        let input = L::new(&env, input);
        let h = Host(input.get(c"ports")?);
        let result = L::new(&env, receipt);
        if !result.truthy()? || result.get(c"ok")?.is_false()? {
            return Ok(result.or(|| refusal(h, "dispatch_failed"))?.raw());
        }
        let task = input.get(c"task")?;
        let bound = input.get(c"boundId")?;
        let route = h.object(&[
            (c"mode", h.value("commander")?),
            (
                c"targetSessionId",
                input.get(c"commander")?.or(|| Ok(bound))?,
            ),
            (c"workerSessionId", bound),
            (
                c"operationId",
                result.get(c"operationId")?.or(|| h.value(""))?,
            ),
            (c"status", h.value("admitted")?),
            (c"oneWay", h.value(true)?),
            (c"routedAt", h.now()?),
        ])?;
        h.core(c"setTaskRouting", &[task, route])?;
        h.0.get(c"planning")?
            .invoke(c"markPlannedTaskStarted", &[task])?;
        if !h.0.get(c"save")?.call_plain(&[])?.truthy()? {
            let object = task.global()?.get(c"Object")?;
            let reflect = task.global()?.get(c"Reflect")?;
            object.invoke(c"keys", &[task])?.for_each(|key| {
                if !reflect.invoke(c"deleteProperty", &[task, key])?.truthy()? {
                    return Err(task.type_error("Cannot delete task property"));
                }
                Ok(())
            })?;
            object.invoke(c"assign", &[task, input.get(c"before")?])?;
            let failure = refusal(h, "persistence_failed")?;
            failure.set(c"delivered", h.value(true)?)?;
            return Ok(failure.raw());
        }
        let dir = h.core(c"taskDirId", &[h.board()?, task])?;
        let ids = h.value(multicc_core::js::JsValue::Array(vec![]))?;
        ids.set_element(0, task.get(c"id")?)?;
        h.0.get(c"notify")?.call_plain(&[dir, ids])?;
        let reply = h.object(&[])?;
        reply.spread_from(result)?;
        reply.set(c"ok", h.value(!result.get(c"ok")?.is_false()?)?)?;
        reply.set(c"taskId", task.get(c"id")?)?;
        reply.set(c"taskBound", h.value(true)?)?;
        reply.set(c"targetSessionId", bound)?;
        reply.set(c"workerSessionId", bound)?;
        reply.set(c"taskStart", h.value(false)?)?;
        Ok(reply.raw())
    }
}
