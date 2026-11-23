//! 首次派发由同一份请求状态驱动。跨 await 的卡片和宿主回执仍保留在 V8，
//! 重放时可读到原卡片的最新路由，发送失败也不会提前写入派发回执。
use crate::{
    js_live::LiveValue as L,
    task_board_host::{concat, js_string, refusal, Host, Properties},
};
use multicc_core::{js::JsValue as J, task_board_transcript::stable_task_id};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;

fn finished<'a>(host: Host<'a>, result: L<'a>) -> Result<L<'a>> {
    host.object(&[(c"result", result)])
}

fn task_id<'a>(host: Host<'a>, source: L<'a>, dir: L<'a>, key: L<'a>) -> Result<L<'a>> {
    let namespace = concat(
        host,
        &[source, host.value(":")?, dir.or(|| host.value(""))?],
    )?;
    host.value(J::String(stable_task_id(
        &namespace.coerce_string()?,
        &key.coerce_string()?,
    )))
}

struct Start<'a> {
    host: Host<'a>,
    input: L<'a>,
    id: L<'a>,
}

impl<'a> Start<'a> {
    fn read(env: &'a Env, input: Unknown<'a>) -> Result<Self> {
        let input = L::new(env, input);
        Ok(Self {
            host: Host(input.get(c"ports")?),
            input,
            id: input.get(c"taskId")?,
        })
    }
    fn context(&self) -> Result<L<'a>> {
        self.host.object(&[
            (c"taskId", self.id),
            (c"taskStart", self.host.value(true)?),
            (c"taskSource", self.input.get(c"source")?),
            (c"taskText", self.input.get(c"text")?),
        ])
    }
    fn write_and_notify(&self, indexed: L<'a>) -> Result<()> {
        let h = self.host;
        h.0.get(c"save")?.call_plain(&[])?;
        let ids = h.value(J::Array(vec![]))?;
        ids.set_element(0, self.id)?;
        let kind = if indexed.get(c"created")?.truthy()? {
            h.value("created")?
        } else {
            h.value(J::Undefined)?
        };
        h.0.get(c"notify")?
            .call_plain(&[self.input.get(c"dirId")?, ids, kind])?;
        Ok(())
    }
    fn index(&self, session: L<'a>, routing: L<'a>, now: L<'a>, origin: L<'a>) -> Result<L<'a>> {
        let h = self.host;
        let fields = h.object(&[
            (c"taskId", self.id),
            (c"dirId", self.input.get(c"dirId")?),
            (c"sessionId", session),
            (c"taskText", self.input.get(c"text")?),
            (c"origin", origin),
            (c"routing", routing),
            (c"now", now),
        ])?;
        h.0.get(c"ensureTaskIndex")?.call_plain(&[fields])
    }

    fn route(&mut self) -> Result<L<'a>> {
        let h = self.host;
        let input = self.input;
        // 操作锁和旧派发各自取一次确定性 ID；沿用原来的目录值转换边界。
        self.id = task_id(
            h,
            input.get(c"source")?,
            input.get(c"dirId")?,
            input.get(c"clientKey")?,
        )?;
        input.set(c"taskId", self.id)?;
        let existing = h.tasks()?.get_key(self.id)?;
        input.set(c"existing", existing)?;
        let routing = || existing.optional(c"routing");
        if routing()?.optional(c"operationId")?.truthy()?
            && !routing()?.get(c"mode")?.is_string("commander")?
        {
            let reply = refusal(h, "idempotency_conflict")?;
            reply.set(
                c"error",
                h.value("idempotency key reused with different routing")?,
            )?;
            return finished(h, reply);
        }
        let mode = routing()?.optional(c"mode")?.or(|| h.value("commander"))?;
        let target = routing()?
            .optional(c"targetSessionId")?
            .or(|| input.get(c"commanderId"))?;
        input.set(c"mode", mode)?;
        input.set(c"target", target)?;
        if mode.is_string("manual")?
            && h.record(target)?
                .optional(c"taskExecutionSlot")?
                .is_true()?
        {
            return finished(h, refusal(h, "no_relevant_target")?);
        }
        let title = h.0.get(c"core")?.get(c"PENDING_TASK_TITLE")?;
        let operation = routing()?.optional(c"operationId")?.or(|| h.null())?;
        if mode.is_string("commander")? && !operation.truthy()? {
            if !h.0.get(c"createSessionRecord")?.truthy()? {
                return finished(h, refusal(h, "chat_session_unavailable")?);
            }
            let task = existing.or(|| {
                h.object(&[
                    (c"id", self.id),
                    (c"title", h.0.get(c"core")?.get(c"PENDING_TASK_TITLE")?),
                    (c"refs", h.value(J::Array(vec![]))?),
                ])
            })?;
            let options = h.object(&[(c"dirId", input.get(c"dirId")?), (c"runtime", h.null()?)])?;
            let pending =
                h.0.get(c"ensureBoundChatSession")?
                    .call_plain(&[task, options])?;
            return h.object(&[(c"kind", h.value("bind")?), (c"pending", pending)]);
        }
        let shape = h.object(&[(c"id", self.id), (c"title", title)])?;
        let method = if mode.is_string("commander")? {
            c"buildCommanderRoutedMessage"
        } else {
            c"buildRoutedMessage"
        };
        let routed = h.core(method, &[shape, input.get(c"text")?])?;
        input.set(c"message", concat(h, &[input.get(c"goalNote")?, routed])?)?;
        let key = if operation.truthy()? && mode.is_string("commander")? {
            concat(h, &[h.value("task-run:")?, operation])?
        } else {
            concat(h, &[h.value("task-start:")?, self.id])?
        };
        input.set(c"idempotencyKey", key)?;
        h.object(&[(c"kind", h.value("worker")?)])
    }

    fn bound(&self, bound: L<'a>) -> Result<L<'a>> {
        let h = self.host;
        if !bound.optional(c"ok")?.truthy()? {
            let reason = bound.optional(c"code")?.or(|| h.value("unknown"))?;
            let message = concat(
                h,
                &[
                    h.value("[multicc/taskboard] bound-session create failed for ")?,
                    self.id,
                    h.value(": ")?,
                    reason,
                ],
            )?;
            h.0.get(c"logger")?.invoke(c"log", &[message])?;
            return finished(h, bound.or(|| refusal(h, "chat_session_create_failed"))?);
        }
        self.input.set(c"bound", bound)?;
        let session = bound.get(c"sessionId")?;
        let text = concat(h, &[self.input.get(c"goalNote")?, self.input.get(c"text")?])?;
        let context = self.context()?;
        context.set(c"clientMsgId", self.input.get(c"clientKey")?)?;
        let pending =
            h.0.get(c"sendSessionMessage")?
                .call_plain(&[session, text, context])?;
        h.object(&[(c"kind", h.value("send")?), (c"pending", pending)])
    }

    fn sent(&self, sent: L<'a>) -> Result<L<'a>> {
        let h = self.host;
        if !sent.truthy()? || sent.get(c"ok")?.is_false()? {
            return sent.or(|| refusal(h, "dispatch_failed"));
        }
        let session = || self.input.get(c"bound")?.get(c"sessionId");
        let provenance = session()?;
        let origin = if self.input.get(c"existing")?.truthy()? {
            h.null()?
        } else {
            h.core(c"taskOriginForSource", &[self.input.get(c"source")?])?
        };
        let indexed = self.index(provenance, h.null()?, h.now()?, origin)?;
        let task = indexed.get(c"task")?;
        if !task.truthy()? {
            return refusal(h, "dispatch_failed");
        }
        if !task.get(c"chatSessionId")?.truthy()? {
            let patch = h.object(&[(c"chatSessionId", session()?)])?;
            h.0.get(c"updateBoardTask")?.call_plain(&[self.id, patch])?;
        }
        let operation = sent
            .get(c"operationId")?
            .or(|| concat(h, &[h.value("task-bound:")?, self.id]))?;
        let route = h.object(&[
            (c"mode", h.value("commander")?),
            (c"targetSessionId", self.input.get(c"target")?),
            (c"workerSessionId", session()?),
            (c"operationId", operation),
            (
                c"status",
                h.value(if sent.get(c"queued")?.is_true()? {
                    "queued"
                } else {
                    "admitted"
                })?,
            ),
            (c"oneWay", h.value(true)?),
            (c"routedAt", h.now()?),
        ])?;
        h.core(c"setTaskRouting", &[task, route])?;
        self.write_and_notify(indexed)?;
        let reply = h.object(&[])?;
        reply.spread_from(sent)?;
        for (key, value) in [
            (c"ok", h.value(true)?),
            (c"taskId", self.id),
            (c"taskBound", h.value(true)?),
            (c"taskStart", h.value(true)?),
            (c"routeMode", h.value("task-bound")?),
            (c"target", session()?),
            (c"targetSessionId", session()?),
            (c"workerSessionId", session()?),
            (c"operationId", operation),
        ] {
            reply.set(key, value)?;
        }
        Ok(reply)
    }

    fn worker(&self) -> Result<L<'a>> {
        let h = self.host;
        let input = self.input;
        let existing = input.get(c"existing")?;
        let routing = || existing.get(c"routing");
        let options = h.object(&[])?;
        let worker = if existing
            .optional(c"routing")?
            .optional(c"operationId")?
            .truthy()?
        {
            let worker = routing()?
                .get(c"workerSessionId")?
                .or(|| routing()?.get(c"targetSessionId"))?;
            if h.record(worker)?
                .optional(c"taskBoundTaskId")?
                .equals(self.id)?
            {
                let duplicate = h.object(&[
                    (c"ok", h.value(true)?),
                    (c"duplicate", h.value(true)?),
                    (c"taskBound", h.value(true)?),
                    (c"targetSessionId", worker),
                    (
                        c"targetLabel",
                        h.record(worker)?.optional(c"label")?.or(|| Ok(worker))?,
                    ),
                    (
                        c"queued",
                        h.value(routing()?.get(c"status")?.is_string("queued")?)?,
                    ),
                    (
                        c"status",
                        routing()?.get(c"status")?.or(|| h.value("admitted"))?,
                    ),
                    (c"operationId", routing()?.get(c"operationId")?),
                ])?;
                return finished(h, duplicate);
            }
            input.set(c"originalWorker", worker)?;
            let owner = if routing()?.get(c"mode")?.is_string("commander")? {
                routing()?.get(c"targetSessionId")?
            } else {
                h.value(J::Undefined)?
            };
            options.set(c"ownerSessionId", owner)?;
            worker
        } else {
            input.get(c"target")?
        };
        options.set(c"idempotencyKey", input.get(c"idempotencyKey")?)?;
        options.set(c"oneWay", h.value(true)?)?;
        options.set(c"requireIdle", h.value(false)?)?;
        options.spread_from(self.context()?)?;
        let pending = h.0.get(c"dispatchToSession")?.call_plain(&[
            worker,
            input.get(c"message")?,
            options,
        ])?;
        h.object(&[(c"kind", h.value("dispatch")?), (c"pending", pending)])
    }

    fn receipt(&self, receipt: L<'a>) -> Result<L<'a>> {
        if !self.input.has(c"originalWorker")? || !receipt.optional(c"ok")?.truthy()? {
            return Ok(receipt);
        }
        let h = self.host;
        let worker = self.input.get(c"originalWorker")?;
        let result = h.object(&[])?;
        result.spread_from(receipt)?;
        result.set(c"duplicate", h.value(true)?)?;
        result.set(c"targetSessionId", worker)?;
        result.set(
            c"targetLabel",
            h.record(worker)?.optional(c"label")?.or(|| Ok(worker))?,
        )?;
        result.set(
            c"queued",
            h.value(
                self.input
                    .get(c"existing")?
                    .get(c"routing")?
                    .get(c"status")?
                    .is_string("queued")?,
            )?,
        )?;
        Ok(result)
    }

    fn complete(&self, result: L<'a>) -> Result<L<'a>> {
        let h = self.host;
        if !result.optional(c"ok")?.truthy()? {
            return result.or(|| {
                h.object(&[
                    (c"ok", h.value(false)?),
                    (c"error", h.value("dispatch_failed")?),
                ])
            });
        }
        let mode = self.input.get(c"mode")?;
        let target = self.input.get(c"target")?;
        let commander = mode.is_string("commander")?;
        let worker = if commander {
            result.get(c"targetSessionId")?
        } else {
            result.get(c"chatId")?.or(|| Ok(target))?
        };
        let now = h.now()?;
        let route = h.object(&[
            (c"mode", mode),
            (c"targetSessionId", target),
            (
                c"workerSessionId",
                if commander { worker } else { h.value("")? },
            ),
            (
                c"operationId",
                result.get(c"operationId")?.or(|| h.value(""))?,
            ),
            (
                c"status",
                result.get(c"status")?.or(|| h.value("admitted"))?,
            ),
            (c"oneWay", h.value(true)?),
            (c"routedAt", now),
        ])?;
        let indexed = self.index(worker, route, now, h.null()?)?;
        let task = indexed.get(c"task")?;
        if task.truthy()? {
            let state = if result.get(c"status")?.is_string("running")? {
                "running"
            } else {
                "queued"
            };
            task.assign(c"runState", h.value(state)?)?;
        }
        self.write_and_notify(indexed)?;
        let reply = h.object(&[])?;
        reply.spread_from(result)?;
        for (key, value) in [
            (c"taskId", self.id),
            (c"target", target),
            (c"routeMode", mode),
            (c"workerSessionId", worker),
        ] {
            reply.set(key, value)?;
        }
        Ok(reply)
    }
}

#[napi]
pub struct TaskBoardStart {}

#[napi]
impl TaskBoardStart {
    #[napi]
    pub fn prepare(
        env: Env,
        ports: Unknown<'_>,
        commander_id: Unknown<'_>,
        text: Unknown<'_>,
        options: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let h = Host(L::new(&env, ports));
        let target = L::new(&env, commander_id);
        let commander = h.record(target)?;
        if !commander.truthy()?
            || !commander.get(c"type")?.is_string("commander")?
            || !commander.get(c"kind")?.is_string("chat")?
        {
            return Ok(refusal(h, "commander_not_found")?.raw());
        }
        let text = js_string(L::new(&env, text).or(|| h.value(""))?)?.invoke(c"trim", &[])?;
        if !text.truthy()? {
            return Ok(refusal(h, "empty_text")?.raw());
        }
        let opts = L::new(&env, options);
        if opts.nullish()? {
            return Err(opts.type_error("Cannot read properties of null (reading 'clientMsgId')"));
        }
        let key = opts
            .get(c"clientMsgId")?
            .or(|| opts.get(c"idempotencyKey"))?
            .or(|| h.value(""))?;
        let key = js_string(key)?
            .invoke(c"trim", &[])?
            .or(|| h.0.get(c"crypto")?.invoke(c"randomUUID", &[]))?;
        let source = h.value(if opts.get(c"source")?.is_string("task-board")? {
            "task-board"
        } else {
            "commander"
        })?;
        let dir = commander.get(c"dirId")?;
        let note = js_string(opts.get(c"goalNote")?.or(|| h.value(""))?)?;
        Ok(h.object(&[
            (c"ports", h.0),
            (c"source", source),
            (c"dirId", dir),
            (c"commanderId", target),
            (c"text", text),
            (c"clientKey", key),
            (c"goalNote", note),
            (c"taskId", task_id(h, source, dir, key)?),
        ])?
        .raw())
    }

    #[napi]
    pub fn route(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
        Ok(Start::read(&env, input)?.route()?.raw())
    }
    #[napi]
    pub fn bound(env: Env, input: Unknown<'_>, bound: Unknown<'_>) -> Result<sys::napi_value> {
        Ok(Start::read(&env, input)?.bound(L::new(&env, bound))?.raw())
    }
    #[napi]
    pub fn sent(env: Env, input: Unknown<'_>, sent: Unknown<'_>) -> Result<sys::napi_value> {
        Ok(Start::read(&env, input)?.sent(L::new(&env, sent))?.raw())
    }
    #[napi]
    pub fn worker(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
        Ok(Start::read(&env, input)?.worker()?.raw())
    }
    #[napi]
    pub fn receipt(env: Env, input: Unknown<'_>, receipt: Unknown<'_>) -> Result<sys::napi_value> {
        Ok(Start::read(&env, input)?
            .receipt(L::new(&env, receipt))?
            .raw())
    }
    #[napi]
    pub fn failure(env: Env, error: Unknown<'_>) -> Result<sys::napi_value> {
        let error = L::new(&env, error);
        let h = Host(error);
        let code = if error.optional(c"code")?.is_string("OPERATION_CONFLICT")? {
            h.value("idempotency_conflict")?
        } else {
            error.optional(c"code")?.or(|| h.null())?
        };
        Ok(h.object(&[
            (c"ok", h.value(false)?),
            (c"code", code),
            (
                c"error",
                error
                    .optional(c"message")?
                    .or(|| h.value("dispatch_failed"))?,
            ),
        ])?
        .raw())
    }
    #[napi]
    pub fn complete(env: Env, input: Unknown<'_>, result: Unknown<'_>) -> Result<sys::napi_value> {
        Ok(Start::read(&env, input)?
            .complete(L::new(&env, result))?
            .raw())
    }
}
