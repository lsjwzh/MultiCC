//! 聊天历史宿主运行时的唯一所有者：可见性缓存、蒸馏缓冲、增量保存定时器
//! 和同步核心规则都在这里。宿主只提供端口（仓库、会话表、广播、蒸馏、时钟、
//! 定时器回调）以及消息对象本身，消息保持引擎身份（getter、原型、引用）。
//!
//! 端口调用前后不持有任何 RefCell 借用，因此端口可以同步重入本所有者。
//! 历史服务（RustChatHistory）仍由 JS 适配层构造一次，这里通过它的 `run`
//! 方法直接派发，不复制服务缓存；只有 postPersist 仍经由 JS 回调，因为
//! RustChatHistory 的外部契约就是读取 `ports.postPersist`。
use crate::{
    js_host_value::{Value, Values},
    js_live::LiveValue as L,
};
use multicc_core::js::{JsString, JsValue as J};
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
    sys, Env, Error, Result,
};
use napi_derive::napi;
use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet, VecDeque},
    ffi::CStr,
    rc::Rc,
};

const DEFAULT_HISTORY_LIMIT: f64 = 10000.0;
const DEFAULT_PAGE_SIZE: f64 = 5.0;
const DEFAULT_MEMORY_DISTILL_BATCH: f64 = 10.0;
const DEFAULT_INCREMENTAL_SAVE_DELAY_MS: f64 = 5000.0;
const MAX_SAFE_INTEGER: f64 = 9007199254740991.0;

fn object<'a>(a: L<'a>, fields: &[(&CStr, L<'a>)]) -> Result<L<'a>> {
    let out = a.from_value(&J::Object(vec![]))?;
    for (key, value) in fields {
        out.set(key, *value)?;
    }
    Ok(out)
}
fn array(a: L<'_>) -> Result<L<'_>> {
    a.from_value(&J::Array(vec![]))
}
fn text<'a>(a: L<'a>, value: &str) -> Result<L<'a>> {
    a.from_value(&J::string(value))
}
fn number(a: L<'_>, value: f64) -> Result<L<'_>> {
    a.from_value(&J::Number(value))
}
fn boolean(a: L<'_>, value: bool) -> Result<L<'_>> {
    a.from_value(&J::Bool(value))
}
fn method<'a>(value: L<'a>, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    value.get(name)?.call(value, args)
}
fn string(value: L<'_>) -> Result<L<'_>> {
    value.global()?.get(c"String")?.call_plain(&[value])
}
fn key(value: L<'_>) -> Result<JsString> {
    string(value)?.coerce_string()
}
fn length(value: L<'_>) -> Result<usize> {
    Ok(value.get(c"length")?.number()? as usize)
}
fn push<'a>(value: L<'a>, entry: L<'a>) -> Result<()> {
    method(value, c"push", &[entry])?;
    Ok(())
}
fn clone_json(value: L<'_>) -> Result<L<'_>> {
    if value.undefined()? {
        return Ok(value);
    }
    let json = value.global()?.get(c"JSON")?;
    method(json, c"parse", &[method(json, c"stringify", &[value])?])
}
fn fallback<'a>(value: L<'a>, other: L<'a>) -> Result<L<'a>> {
    Ok(if value.truthy()? { value } else { other })
}
fn caught<'a>(a: L<'a>, error: Error) -> Result<L<'a>> {
    if let Some(value) = a.exception_value()? {
        return Ok(value);
    }
    a.global()?
        .get(c"Error")?
        .construct(&[text(a, &error.reason)?])
}
fn regexp<'a>(a: L<'a>, pattern: &str) -> Result<L<'a>> {
    a.global()?.get(c"RegExp")?.construct(&[text(a, pattern)?])
}
fn set_of<'a>(a: L<'a>, source: L<'a>) -> Result<L<'a>> {
    a.global()?.get(c"Set")?.construct(&[source])
}
fn spread_copy<'a>(a: L<'a>, source: L<'a>) -> Result<L<'a>> {
    let out = a.from_value(&J::Object(vec![]))?;
    out.spread_from(source)?;
    Ok(out)
}
/// `Number.isSafeInteger(value) && value > 0 ? value : fallback`
fn positive_integer(value: L<'_>, fallback_value: f64) -> Result<f64> {
    match value.number_value()? {
        Some(n) if n.is_finite() && n.fract() == 0.0 && n > 0.0 && n <= MAX_SAFE_INTEGER => Ok(n),
        _ => Ok(fallback_value),
    }
}
fn clip160<'a>(value: L<'a>) -> Result<L<'a>> {
    method(
        value,
        c"slice",
        &[number(value, 0.0)?, number(value, 160.0)?],
    )
}

/// 纯规则：把一条已提交消息投影成客户端可见的最小对象（`undefined` 视为无）。
fn public_committed<'a>(message: L<'a>) -> Result<L<'a>> {
    let null = message.from_value(&J::Null)?;
    if !message.truthy()? || !message.get(c"role")?.is_string("user")? {
        return Ok(null);
    }
    let id = message.get(c"id")?;
    if !id.truthy()? {
        return Ok(null);
    }
    let content = message.get(c"content")?;
    let content = if content.truthy()? {
        content
    } else {
        text(message, "")?
    };
    let raw_ts = message.get(c"ts")?;
    let stamp = raw_ts.explicit_number()?;
    let ts = if stamp.is_finite() {
        raw_ts.explicit_number()?
    } else {
        f64::NAN
    };
    let out = object(
        message,
        &[
            (c"id", clip160(string(id)?)?),
            (c"role", text(message, "user")?),
            (c"content", string(content)?),
            (
                c"ts",
                if ts.is_finite() {
                    number(message, ts)?
                } else {
                    message.from_value(&J::Null)?
                },
            ),
        ],
    )?;
    for field in [c"clientMsgId", c"answeredQuestionId"] {
        let value = message.get(field)?;
        if value.kind()? == sys::ValueType::napi_string && value.truthy()? {
            out.set(field, clip160(value)?)?;
        }
    }
    let tools = message.get(c"bgToolUseIds")?;
    if tools.is_array()? && length(tools)? > 0 {
        let filtered = array(message)?;
        for index in 0..length(tools)? {
            let value = tools.element(index as u32)?;
            if value.kind()? == sys::ValueType::napi_string && value.truthy()? {
                push(filtered, value)?;
            }
        }
        let limited = method(
            filtered,
            c"slice",
            &[number(filtered, 0.0)?, number(filtered, 64.0)?],
        )?;
        let clipped = array(message)?;
        for index in 0..length(limited)? {
            push(clipped, clip160(limited.element(index as u32)?)?)?;
        }
        out.set(c"bgToolUseIds", clipped)?;
    }
    for field in [
        c"turnId",
        c"taskId",
        c"taskName",
        c"taskShortCode",
        c"auxRunId",
    ] {
        let value = message.get(field)?;
        if value.kind()? == sys::ValueType::napi_string && value.truthy()? {
            out.set(field, clip160(value)?)?;
        }
    }
    out.freeze()
}

/// 纯规则：重连页不重复表示一个进行中的轮次。
fn build_replay<'a>(env: &'a Env, page: L<'a>, state: L<'a>, now: L<'a>) -> Result<L<'a>> {
    let copy = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "historyReplayCopy",
        |ctx| {
            let value = if ctx.length() == 0 {
                ().into_unknown(ctx.env)?
            } else {
                ctx.get::<Unknown<'_>>(0)?
            };
            let value = L::new(ctx.env, value);
            let out = value.from_value(&J::Object(vec![]))?;
            out.spread_from(value)?;
            Ok(out.raw())
        },
    )?;
    let copy = L::new(env, copy.into_unknown(env)?);
    let messages = if page.is_array()? {
        method(page, c"map", &[copy])?
    } else {
        array(page)?
    };
    let text_body = if state.truthy()? {
        state.get(c"currentAssistantText")?
    } else {
        page.from_value(&J::Undefined)?
    };
    let body = if text_body.truthy()? {
        string(text_body)?
    } else {
        text(page, "")?
    };
    let raw_tools = if state.truthy()? {
        state.get(c"currentToolCalls")?
    } else {
        page.from_value(&J::Undefined)?
    };
    let tools = if raw_tools.is_array()? {
        raw_tools
    } else {
        array(page)?
    };
    let saved = if state.truthy()? {
        state.get(c"_resultSaved")?
    } else {
        page.from_value(&J::Undefined)?
    };
    let tool_count = length(tools)?;
    if saved.truthy()? || (!body.truthy()? && tool_count == 0) {
        return Ok(messages);
    }
    let streaming = if state.truthy()? {
        state.get(c"isStreaming")?.is_true()?
    } else {
        false
    };
    let live = object(
        page,
        &[
            (c"role", text(page, "assistant")?),
            (c"content", body),
            (
                c"tools",
                if tool_count > 0 {
                    tools
                } else {
                    page.from_value(&J::Undefined)?
                },
            ),
            (c"ts", now.call_plain(&[])?),
            (c"streaming", boolean(page, streaming)?),
        ],
    )?;
    if state.truthy()? {
        let task = state.get(c"_currentTaskId")?;
        if task.truthy()? {
            live.set(c"taskId", task)?;
        }
    }
    let count = length(messages)?;
    let undefined = page.from_value(&J::Undefined)?;
    let last = if count > 0 {
        messages.element((count - 1) as u32)?
    } else {
        undefined
    };
    let last_id = last.optional(c"id")?;
    if last.optional(c"role")?.is_string("assistant")? && last.optional(c"_interim")?.truthy()? {
        let merged = spread_copy(page, last)?;
        merged.spread_from(live)?;
        merged.set(c"id", last_id)?;
        messages.set_element((count - 1) as u32, merged)?;
    } else {
        push(messages, live)?;
    }
    Ok(messages)
}

#[napi]
pub fn chat_history_public_committed_message(
    env: Env,
    message: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(public_committed(L::new(&env, message))?.raw())
}

#[napi]
pub fn chat_history_build_replay_messages(
    env: Env,
    page: Unknown<'_>,
    state: Unknown<'_>,
    now: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(build_replay(
        &env,
        L::new(&env, page),
        L::new(&env, state),
        L::new(&env, now),
    )?
    .raw())
}

#[napi]
pub struct RustChatHistoryRuntime {
    values: Values,
    /// `String(sessionId)` → 已隐藏消息 id 的 JS `Set`（保持身份，避免复制语义）。
    visibility: RefCell<HashMap<JsString, Value>>,
    /// `String(sessionId)` → 因去重被丢弃、等待蒸馏的消息对象。用 `Rc<RefCell>`
    /// 让端口重入时看到与旧实现相同的缓冲区身份；触发蒸馏后再换新缓冲。
    dropped: RefCell<HashMap<JsString, Rc<RefCell<Vec<Value>>>>>,
    /// 未触发的增量保存定时器，按插入顺序保存（clearAll 的调用顺序可观察）。
    timers: RefCell<Vec<(JsString, Value)>>,
    /// 每个会话一条变更 FIFO。所有落盘变更（追加、interim、替换、隐藏、清理）
    /// 都从这里排队；Rust 决定顺序与快照时刻，Node 只执行返回的写入步骤。
    mutations: RefCell<HashMap<JsString, VecDeque<Mutation>>>,
    next_mutation_id: Cell<u64>,
    /// 清理代次：清理会在队首把代次 +1；早于它的 interim 到队首即丢弃，
    /// 避免清理后旧 interim 复活。
    generations: RefCell<HashMap<JsString, u64>>,
    /// 会话代次：`registerSession` 使代次 +1。每个排队 job 记录入队时的代次；
    /// 删除 job 只结算它入队时代次及更早的写入。删除期间会话被重新注册（固定
    /// id 的辅助会话等）时，新代次的 job 必须保留并在删除之后照常执行，删除
    /// 也只能为“当前代次仍等于自己”的会话落墓碑。
    epochs: RefCell<HashMap<JsString, u64>>,
    /// 正在删除但尚未结算的会话（id → (删除 job 的代次, operationId)）。删除
    /// 排在已接受写入之后，只有删除真正成功时才取消旧代次未开始的 job；删除
    /// 被拒（例如任务历史仍被引用）时撤销标记，排队写入照常执行、一条都不能
    /// 丢。标记按代次作用：重新注册后的新代次不继承它，同一代次内的重复删除
    /// 才复用同一个 job。
    deleting: RefCell<HashMap<JsString, (u64, u64)>>,
    /// 已删除的会话。只有删除成功且删除 job 的代次仍是当前代次时才落墓碑，
    /// 后续变更一律拒绝，避免删除后又把文件写回来。会话 id 被重新注册时清除；
    /// 服务端分配的 randomUUID 通常不会复用，辅助会话等固定 id 依赖
    /// `registerSession` 清墓碑。
    removed: RefCell<HashSet<JsString>>,
    page_size: f64,
    distill_batch: f64,
    save_delay: f64,
    stopped: Cell<bool>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MutationKind {
    Append,
    Interim,
    Replace,
    ReplaceAll,
    DropMessages,
    MergeAll,
    Clear,
    Remove,
    RemoveMany,
    Hide,
    Delete,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Start,
    Transcript,
    Visibility,
}

/// One queued history mutation. Everything that must survive between two host
/// calls is captured through `Values`; `NextOutcome` carries only values built
/// during the current call.
struct Mutation {
    id: u64,
    kind: MutationKind,
    generation: u64,
    /// 入队时的会话代次（见 `epochs`）。删除只取消不高于自己代次的 job。
    epoch: u64,
    args: Vec<Value>,
    phase: Phase,
    op: Option<Value>,
    plan: Option<Value>,
    payload: Option<Value>,
    emit: Option<Value>,
    result: Option<Value>,
    cursor: usize,
    hidden: f64,
}

/// What `nextMutationStep` should hand back: either a durable write to perform
/// or a terminal result.
enum NextOutcome<'a> {
    Write(L<'a>),
    Done(L<'a>),
}

struct Runtime<'a> {
    owner: &'a RustChatHistoryRuntime,
    env: &'a Env,
    anchor: L<'a>,
    ports: L<'a>,
}

impl<'a> Runtime<'a> {
    fn undefined(&self) -> Result<L<'a>> {
        self.anchor.from_value(&J::Undefined)
    }
    fn port(&self, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
        self.ports.get(name)?.call_plain(args)
    }
    fn service(&self, action: &str, args: &[L<'a>]) -> Result<L<'a>> {
        let service = self.ports.get(c"service")?;
        let anchor = self.ports.get(c"serviceAnchor")?;
        let list = array(self.anchor)?;
        for (index, value) in args.iter().enumerate() {
            list.set_element(index as u32, *value)?;
        }
        service
            .get(c"run")?
            .call(service, &[anchor, text(self.anchor, action)?, list])
    }
    fn capture(&self, value: L<'a>) -> Result<Value> {
        self.owner.values.capture(self.env, value)
    }
    fn read(&self, value: &Value) -> Result<L<'a>> {
        self.owner.values.read(self.env, self.anchor, value)
    }
    fn timer_position(&self, cache_key: &JsString) -> Option<usize> {
        self.owner
            .timers
            .borrow()
            .iter()
            .position(|(candidate, _)| candidate == cache_key)
    }
    fn timer_get(&self, cache_key: &JsString) -> Option<Value> {
        self.timer_position(cache_key)
            .map(|index| self.owner.timers.borrow()[index].1.clone())
    }
    fn timer_remove(&self, cache_key: &JsString) {
        self.owner
            .timers
            .borrow_mut()
            .retain(|(candidate, _)| candidate != cache_key);
    }
    fn chat_session(&self, session: L<'a>) -> Result<L<'a>> {
        method(self.ports.get(c"chatSessions")?, c"get", &[session])
    }
    /// 部分应用：`fn.bind(null, ...args)`，让零参定时器回调仍然进入本所有者。
    fn bind(&self, function: L<'a>, args: &[L<'a>]) -> Result<L<'a>> {
        let bind = function.get(c"bind")?;
        let mut all = Vec::with_capacity(args.len() + 1);
        all.push(self.anchor.from_value(&J::Null)?);
        all.extend_from_slice(args);
        bind.call(function, &all)
    }

    fn log_failure(&self, event: &str, error: L<'a>, session: Option<L<'a>>) -> Result<()> {
        let message = if error.truthy()? {
            error.get(c"message")?
        } else {
            error
        };
        let sanitize = self.ports.get(c"sanitizePublicText")?;
        let rendered =
            sanitize.call_plain(&[message, text(self.anchor, "chat history operation failed")?])?;
        let payload = object(self.anchor, &[(c"error", rendered)])?;
        if let Some(session) = session {
            if session.truthy()? {
                let id = sanitize
                    .call_plain(&[string(session)?, text(self.anchor, "unknown_session")?])?;
                let id = method(
                    id,
                    c"slice",
                    &[number(self.anchor, 0.0)?, number(self.anchor, 128.0)?],
                )?;
                payload.set(c"sessionId", id)?;
            }
        }
        let logger = self.ports.get(c"logger")?;
        let event = text(self.anchor, event)?;
        self.anchor.catch(|| -> Result<()> {
            let warn = logger.get(c"warn")?;
            if warn.kind()? == sys::ValueType::napi_function {
                warn.call(logger, &[event, payload])?;
                return Ok(());
            }
            let error = logger.get(c"error")?;
            if error.kind()? == sys::ValueType::napi_function {
                error.call(logger, &[event, payload])?;
            }
            Ok(())
        })?;
        Ok(())
    }

    // ── 可见性 ────────────────────────────────────────────────────────────
    fn hidden(&self, session: L<'a>) -> Result<L<'a>> {
        let cache_key = key(session)?;
        if let Some(value) = self.owner.visibility.borrow().get(&cache_key).cloned() {
            return self.read(&value);
        }
        let history = self.ports.get(c"history")?;
        let read = history.get(c"readVisibility")?;
        let state = if read.kind()? == sys::ValueType::napi_function {
            read.call(history, &[string(session)?])?
        } else {
            self.undefined()?
        };
        let ids = if state.truthy()? {
            let ids = state.get(c"hiddenIds")?;
            if ids.truthy()? {
                ids
            } else {
                array(self.anchor)?
            }
        } else {
            array(self.anchor)?
        };
        let set = set_of(self.anchor, ids)?;
        let captured = self.capture(set)?;
        self.owner
            .visibility
            .borrow_mut()
            .insert(cache_key, captured);
        Ok(set)
    }
    fn invalidate(&self, session: L<'a>) -> Result<()> {
        let cache_key = key(session)?;
        self.owner.visibility.borrow_mut().remove(&cache_key);
        Ok(())
    }
    /// `hide` split in two: this computes the next hidden set and its serialized
    /// state without touching the disk. The durable write is a queued step, so
    /// it can never land inside an async append's snapshot window.
    fn visibility_plan(&self, session: L<'a>, ids: L<'a>) -> Result<L<'a>> {
        let current = self.hidden(session)?;
        let next = set_of(self.anchor, self.anchor.from_value(&J::Array(vec![]))?)?;
        let add = next.get(c"add")?;
        current.for_each(|value| add.call(next, &[value]).map(|_| ()))?;
        ids.for_each(|value| add.call(next, &[value]).map(|_| ()))?;
        let hidden_ids = array(self.anchor)?;
        next.for_each(|value| push(hidden_ids, value))?;
        let state = object(
            self.anchor,
            &[
                (c"version", number(self.anchor, 1.0)?),
                (c"hiddenIds", hidden_ids),
            ],
        )?;
        let state_json = string(self.stringify(state)?)?;
        object(
            self.anchor,
            &[
                (c"next", next),
                (c"stateJson", state_json),
                (c"count", number(self.anchor, length(ids)? as f64)?),
            ],
        )
    }
    fn stringify(&self, value: L<'a>) -> Result<L<'a>> {
        let json = self.anchor.global()?.get(c"JSON")?;
        method(json, c"stringify", &[value])
    }
    fn limit_for(&self, session: L<'a>) -> Result<usize> {
        let policy_fn = self.ports.get(c"retentionPolicy")?;
        let policy = if policy_fn.nullish()? {
            self.undefined()?
        } else {
            policy_fn.call_plain(&[string(session)?])?
        };
        let candidate = if policy.nullish()? {
            policy
        } else {
            let limit = policy.get(c"maxMessages")?;
            if limit.nullish()? {
                policy
            } else {
                limit
            }
        };
        let candidate = if candidate.nullish()? {
            self.ports.get(c"maxMessages")?
        } else {
            candidate
        };
        Ok(positive_integer(candidate, DEFAULT_HISTORY_LIMIT)? as usize)
    }
    fn filter(&self, session: L<'a>, messages: L<'a>, bounded: bool) -> Result<L<'a>> {
        let ids = self.hidden(session)?;
        let has = ids.get(c"has")?;
        let visible = array(self.anchor)?;
        for index in 0..length(messages)? {
            let message = messages.element(index as u32)?;
            if !has.call(ids, &[message.get(c"id")?])?.truthy()? {
                push(visible, message)?;
            }
        }
        if !bounded {
            return Ok(visible);
        }
        let limit = self.limit_for(session)?;
        let start = length(visible)?.saturating_sub(limit);
        method(visible, c"slice", &[number(visible, start as f64)?])
    }
    /// `clearVisibility` without the write: returns the legacy result object and
    /// the visibility plan the queue will persist.
    fn clear_visibility_values(&self, session: L<'a>, keep: L<'a>) -> Result<L<'a>> {
        let keep = if keep.undefined()? {
            number(self.anchor, 0.0)?
        } else {
            keep
        };
        let view = self.service("view", &[string(session)?])?;
        let visible = self.filter(session, view, false)?;
        let completed = array(self.anchor)?;
        for index in 0..length(visible)? {
            let message = visible.element(index as u32)?;
            if !message.get(c"_interim")?.truthy()? {
                push(completed, message)?;
            }
        }
        let count = length(completed)?;
        let end = count as f64 - keep.number()?;
        let end = if end.is_nan() { end } else { end.max(0.0) };
        let removed = method(
            completed,
            c"slice",
            &[number(completed, 0.0)?, number(completed, end)?],
        )?;
        let removed_count = length(removed)?;
        let ids = array(self.anchor)?;
        for index in 0..removed_count {
            push(ids, removed.element(index as u32)?.get(c"id")?)?;
        }
        let plan = self.visibility_plan(session, ids)?;
        // Legacy counted the whole visible view here, interim tail included;
        // only the completed prefix is ever removed.
        let retained_count = length(visible)? as f64 - removed_count as f64;
        let result = object(
            self.anchor,
            &[
                (c"keep", keep),
                (c"removedCount", number(self.anchor, removed_count as f64)?),
                (c"retainedCount", number(self.anchor, retained_count)?),
            ],
        )?;
        object(self.anchor, &[(c"result", result), (c"plan", plan)])
    }
    /// `removeVisibility` without the write: `None` when the id is not visible.
    fn remove_visibility_plan(&self, session: L<'a>, message_id: L<'a>) -> Result<Option<L<'a>>> {
        let view = self.service("view", &[session])?;
        for index in 0..length(view)? {
            if view.element(index as u32)?.get(c"id")?.equals(message_id)? {
                let ids = array(self.anchor)?;
                push(ids, message_id)?;
                return Ok(Some(self.visibility_plan(session, ids)?));
            }
        }
        Ok(None)
    }
    /// `removeMany` without the write: (fresh id count, plan for the fresh ids).
    fn remove_many_values(&self, session: L<'a>, ids: L<'a>) -> Result<(usize, Option<L<'a>>)> {
        let view = self.service("view", &[session])?;
        let known = set_of(self.anchor, self.anchor.from_value(&J::Array(vec![]))?)?;
        let add = known.get(c"add")?;
        for index in 0..length(view)? {
            add.call(known, &[view.element(index as u32)?.get(c"id")?])?;
        }
        let already = self.hidden(session)?;
        // Legacy ignored anything that was not a non-empty string (and a
        // non-array `ids` contributed nothing at all); keep that rule here so
        // Node never has to pre-filter the batch.
        let unique = set_of(self.anchor, self.anchor.from_value(&J::Array(vec![]))?)?;
        if ids.is_array()? {
            let add_unique = unique.get(c"add")?;
            for index in 0..length(ids)? {
                let id = ids.element(index as u32)?;
                if id.kind()? == sys::ValueType::napi_string && id.truthy()? {
                    add_unique.call(unique, &[id])?;
                }
            }
        }
        let fresh = array(self.anchor)?;
        unique.for_each(|id| {
            if known.get(c"has")?.call(known, &[id])?.truthy()?
                && !already.get(c"has")?.call(already, &[id])?.truthy()?
            {
                push(fresh, id)?;
            }
            Ok(())
        })?;
        let count = length(fresh)?;
        if count == 0 {
            return Ok((0, None));
        }
        Ok((count, Some(self.visibility_plan(session, fresh)?)))
    }

    // ── 变更队列 ──────────────────────────────────────────────────────────
    // 每个会话一条 FIFO。队首的变更在当前调用里算出快照/计划，返回一个落盘
    // 步骤给 Node 执行；Node 完成后回报成败，Rust 再发布缓存、广播或继续。
    // 因此同一会话的同步写与异步追加不可能交错，顺序由 Rust 单点决定。
    fn generation(&self, cache_key: &JsString) -> u64 {
        *self.owner.generations.borrow().get(cache_key).unwrap_or(&0)
    }
    fn epoch(&self, cache_key: &JsString) -> u64 {
        *self.owner.epochs.borrow().get(cache_key).unwrap_or(&0)
    }
    fn effect(&self, payload: L<'a>, log_event: &str) -> Result<L<'a>> {
        object(
            self.anchor,
            &[
                (c"payload", payload),
                (c"logEvent", text(self.anchor, log_event)?),
            ],
        )
    }
    fn enqueue_mutation(&self, session: L<'a>, kind: L<'a>, args: L<'a>) -> Result<L<'a>> {
        let session = string(session)?;
        let cache_key = key(session)?;
        let kind_text = kind.coerce_string()?.to_string_lossy();
        let kind = match kind_text.as_str() {
            "append" => MutationKind::Append,
            "interim" => MutationKind::Interim,
            "replace" => MutationKind::Replace,
            "replaceAll" => MutationKind::ReplaceAll,
            "dropMessages" => MutationKind::DropMessages,
            "mergeAll" => MutationKind::MergeAll,
            "clear" => MutationKind::Clear,
            "remove" => MutationKind::Remove,
            "removeMany" => MutationKind::RemoveMany,
            "hide" => MutationKind::Hide,
            "removeSession" => MutationKind::Delete,
            _ => return Err(self.anchor.type_error("unknown chat history mutation")),
        };
        let mut captured = Vec::new();
        for index in 0..length(args)? {
            captured.push(self.capture(args.element(index as u32)?)?);
        }
        let generation = match kind {
            MutationKind::Interim if captured.len() > 1 => {
                self.read(&captured[1])?.number()? as u64
            }
            _ => self.generation(&cache_key),
        };
        let epoch = self.epoch(&cache_key);
        if kind != MutationKind::Delete && self.owner.removed.borrow().contains(&cache_key) {
            return Err(Error::from_reason("chat_history_session_deleted"));
        }
        if kind == MutationKind::Delete {
            // 已经删除过：幂等返回，没有新 job，也没有可取消的排队项。
            if self.owner.removed.borrow().contains(&cache_key) {
                return object(
                    self.anchor,
                    &[
                        (c"operationId", self.undefined()?),
                        (c"cancelled", array(self.anchor)?),
                    ],
                );
            }
            // 同一代次内的第二次删除复用在途的删除 job：两个调用方等同一个
            // 结果（成功或拒绝），不会出现一个返回 true、另一个返回失败的
            // 分裂语义。重新注册会推进代次，新代次的删除是独立的一次删除，
            // 不与旧代次在途的删除合并。
            let existing = self.owner.deleting.borrow().get(&cache_key).copied();
            if let Some((marker_epoch, operation)) = existing {
                if marker_epoch == epoch {
                    return object(
                        self.anchor,
                        &[
                            (c"operationId", number(self.anchor, operation as f64)?),
                            (c"cancelled", array(self.anchor)?),
                        ],
                    );
                }
            }
            // 删除绝不在此刻取消排队写入：拒绝只会在队首执行时才知道。删除
            // 插到所有已开始落盘的 job 之后、未开始 job 之前；未开始 job 保留
            // 在队列里，只有删除真正成功后才随删除一起取消（且只取消它自己
            // 代次及更早的写入）。已排队的删除保持入队顺序：新删除不能插到
            // 旧删除前面，否则旧代次的删除会被当成新删除的可取消工作。
            let next = self.next_mutation_id()?;
            let mut queues = self.owner.mutations.borrow_mut();
            let queue = queues.entry(cache_key.clone()).or_default();
            let mut insert_at = 0;
            for (index, job) in queue.iter().enumerate() {
                if job.phase != Phase::Start || job.kind == MutationKind::Delete {
                    insert_at = index + 1;
                }
            }
            queue.insert(
                insert_at,
                Mutation {
                    id: next,
                    kind: MutationKind::Delete,
                    generation,
                    epoch,
                    args: captured,
                    phase: Phase::Start,
                    op: None,
                    plan: None,
                    payload: None,
                    emit: None,
                    result: None,
                    cursor: 0,
                    hidden: 0.0,
                },
            );
            drop(queues);
            self.owner
                .deleting
                .borrow_mut()
                .insert(cache_key, (epoch, next));
            return object(
                self.anchor,
                &[
                    (c"operationId", number(self.anchor, next as f64)?),
                    (c"cancelled", array(self.anchor)?),
                ],
            );
        }
        let next = {
            let mut queues = self.owner.mutations.borrow_mut();
            let queue = queues.entry(cache_key).or_default();
            // interim 是覆盖语义：队列里尚未开始计算快照的 interim 可以被最新的
            // 一次替换，避免上游 debounce 每次都在队列里堆一整份写盘。只合并
            // 同一代次的 interim：重新注册后旧代次的临时态属于旧会话，不能被
            // 新代次的覆盖，也不能阻止新代次入队。
            if kind == MutationKind::Interim {
                if let Some(job) = queue.iter_mut().find(|job| {
                    job.kind == MutationKind::Interim
                        && job.phase == Phase::Start
                        && job.epoch == epoch
                }) {
                    job.generation = generation;
                    job.args = captured;
                    return object(
                        self.anchor,
                        &[(c"operationId", number(self.anchor, job.id as f64)?)],
                    );
                }
            }
            let next = self.next_mutation_id()?;
            queue.push_back(Mutation {
                id: next,
                kind,
                generation,
                epoch,
                args: captured,
                phase: Phase::Start,
                op: None,
                plan: None,
                payload: None,
                emit: None,
                result: None,
                cursor: 0,
                hidden: 0.0,
            });
            next
        };
        object(
            self.anchor,
            &[(c"operationId", number(self.anchor, next as f64)?)],
        )
    }
    fn next_mutation_id(&self) -> Result<u64> {
        let next = self
            .owner
            .next_mutation_id
            .get()
            .checked_add(1)
            .ok_or_else(|| Error::from_reason("prepared history mutation identifiers exhausted"))?;
        self.owner.next_mutation_id.set(next);
        Ok(next)
    }
    fn has_pending_mutations(&self) -> Result<L<'a>> {
        boolean(
            self.anchor,
            self.owner
                .mutations
                .borrow()
                .values()
                .any(|queue| !queue.is_empty()),
        )
    }
    /// 会话被（重新）注册时调用：推进代次并清墓碑。id 通常由服务端分配且不
    /// 复用，但辅助会话等固定 id 删除后重建必须能再次写入。推进代次还让仍在
    /// 队列里的旧删除只结算旧代次的历史：重新注册之后入队的写入保留下来，在
    /// 删除之后照常执行；旧代次的删除标记也不再压制新代次的定时保存。
    fn register_session(&self, session: L<'a>) -> Result<L<'a>> {
        let cache_key = key(session)?;
        let next = self.epoch(&cache_key).wrapping_add(1);
        self.owner
            .epochs
            .borrow_mut()
            .insert(cache_key.clone(), next);
        self.owner.removed.borrow_mut().remove(&cache_key);
        self.undefined()
    }
    /// 删除资格的唯一判据在 Rust（`assertCanDeleteSession` → canDeleteSession
    /// 端口 / 受保护消息）。Node 只问结果：true 可删，false 被任务历史引用，
    /// 其他错误原样抛出。
    fn can_delete_session(&self, session: L<'a>) -> Result<L<'a>> {
        let verdict = self.deletion_verdict(session)?;
        boolean(self.anchor, verdict.get(c"ok")?.truthy()?)
    }
    /// 删除资格的结构化结论：`{ok, reason?}`，reason 区分旧行为的两条路径。
    ///
    /// 判定留在 Rust：Node 只交事实（存活任务以 chatSessionId/refs 正式拥有
    /// 该会话、以 routing.workerSessionId 引用、历史里带着它的受保护消息戳、
    /// 或这是可丢弃的执行槽）。对照旧生命周期实现：
    /// - `shared`（chatSessionId 或 refs）→ 旧 purge 保持会话原样；
    /// - `referenced`（routing 或受保护消息）→ 旧 deleteSession 抛
    ///   TASK_HISTORY_REFERENCED，任务删除可见地中止并可重试；
    /// - `ok` → 删除会话。
    fn deletion_verdict(&self, session: L<'a>) -> Result<L<'a>> {
        let session = string(session)?;
        let facts = self.ports.get(c"sessionDeletionFacts")?;
        if facts.kind()? == sys::ValueType::napi_function {
            return self.verdict_from_facts(facts.call_plain(&[session])?);
        }
        // 没有事实端口的宿主（测试/旧接线）：沿用布尔判据，只能区分可删与
        // 被引用；被引用一律按 referenced 处理，保持旧的中止语义。
        match self.service("assertCanDeleteSession", &[session]) {
            Ok(_) => self.deletion_verdict_object(true, None, None, None),
            Err(error) => {
                let value = caught(self.anchor, error)?;
                if value.get(c"code")?.is_string("TASK_HISTORY_REFERENCED")? {
                    self.deletion_verdict_object(
                        false,
                        Some("referenced"),
                        Some(value.get(c"tasks")?),
                        Some(value.get(c"taskIds")?),
                    )
                } else {
                    Err(value.throw_error())
                }
            }
        }
    }
    fn verdict_from_facts(&self, facts: L<'a>) -> Result<L<'a>> {
        // 执行槽是可丢弃的副本，其宿主在 resetSlot 前已封存运行账本。
        if facts.get(c"executionSlot")?.truthy()? {
            return self.deletion_verdict_object(true, None, None, None);
        }
        if length(facts.get(c"sessionLinks")?)? > 0 {
            return self.deletion_verdict_object(false, Some("shared"), None, None);
        }
        let routing = facts.get(c"routingLinks")?;
        let messages = facts.get(c"messageLinks")?;
        if length(routing)? > 0 || length(messages)? > 0 {
            // 错误正文要能点名引用者，交回 Node 已经算好的任务清单；id 由
            // Rust 从事实里汇总去重。
            let ids = array(self.anchor)?;
            let mut seen: HashSet<JsString> = HashSet::new();
            for list in [routing, messages] {
                for index in 0..length(list)? {
                    let id = list.element(index as u32)?;
                    if id.truthy()? && seen.insert(id.coerce_string()?) {
                        push(ids, id)?;
                    }
                }
            }
            let references = facts.get(c"references")?;
            let references = if references.is_array()? {
                references
            } else {
                array(self.anchor)?
            };
            return self.deletion_verdict_object(
                false,
                Some("referenced"),
                Some(references),
                Some(ids),
            );
        }
        self.deletion_verdict_object(true, None, None, None)
    }
    fn deletion_verdict_object(
        &self,
        ok: bool,
        reason: Option<&str>,
        tasks: Option<L<'a>>,
        task_ids: Option<L<'a>>,
    ) -> Result<L<'a>> {
        let verdict = object(self.anchor, &[(c"ok", boolean(self.anchor, ok)?)])?;
        if let Some(reason) = reason {
            verdict.set(c"reason", text(self.anchor, reason)?)?;
        }
        if let Some(tasks) = tasks {
            verdict.set(c"tasks", tasks)?;
        }
        if let Some(ids) = task_ids {
            verdict.set(c"taskIds", ids)?;
        }
        Ok(verdict)
    }
    /// 有排队变更的会话 id。关停排空要按会话补一个驱动器：有些 job 由定时器
    /// 直接入队，入队路径不一定还握着驱动器的 Promise。
    fn pending_mutation_sessions(&self) -> Result<L<'a>> {
        let list = array(self.anchor)?;
        let busy: Vec<JsString> = self
            .owner
            .mutations
            .borrow()
            .iter()
            .filter(|(_, queue)| !queue.is_empty())
            .map(|(session, _)| session.clone())
            .collect();
        for session in busy {
            push(list, self.anchor.from_value(&J::String(session))?)?;
        }
        Ok(list)
    }
    fn reinsert_mutation(&self, cache_key: &JsString, job: Mutation) {
        self.owner
            .mutations
            .borrow_mut()
            .entry(cache_key.clone())
            .or_default()
            .push_front(job);
    }
    fn next_mutation_step(&self, session: L<'a>) -> Result<L<'a>> {
        let session = string(session)?;
        let cache_key = key(session)?;
        let popped = match self.owner.mutations.borrow_mut().get_mut(&cache_key) {
            Some(queue) => queue.pop_front(),
            None => None,
        };
        let Some(mut job) = popped else {
            return self.mutation_idle();
        };
        match self.advance_mutation(session, &cache_key, &mut job) {
            Ok(NextOutcome::Write(step)) => {
                self.reinsert_mutation(&cache_key, job);
                Ok(step)
            }
            Ok(NextOutcome::Done(step)) => Ok(step),
            Err(error) => {
                let value = caught(self.anchor, error)?;
                self.mutation_failed(job.id, value)
            }
        }
    }
    fn advance_mutation(
        &self,
        session: L<'a>,
        cache_key: &JsString,
        job: &mut Mutation,
    ) -> Result<NextOutcome<'a>> {
        match job.phase {
            Phase::Start => self.start_mutation(session, cache_key, job),
            Phase::Transcript => Ok(NextOutcome::Write(self.mutation_write_step(
                session,
                job,
                "transcript",
            )?)),
            Phase::Visibility => Ok(NextOutcome::Write(self.mutation_write_step(
                session,
                job,
                "visibility",
            )?)),
        }
    }
    fn mutation_write_step(
        &self,
        session: L<'a>,
        job: &Mutation,
        method_name: &str,
    ) -> Result<L<'a>> {
        let payload = match &job.payload {
            Some(value) => self.read(value)?,
            None => self.undefined()?,
        };
        object(
            self.anchor,
            &[
                (c"type", text(self.anchor, "write")?),
                (c"operationId", number(self.anchor, job.id as f64)?),
                (c"method", text(self.anchor, method_name)?),
                (c"sessionId", string(session)?),
                (c"payload", payload),
            ],
        )
    }
    fn mutation_idle(&self) -> Result<L<'a>> {
        object(self.anchor, &[(c"type", text(self.anchor, "idle")?)])
    }
    fn mutation_done(&self, id: u64, result: L<'a>) -> Result<L<'a>> {
        object(
            self.anchor,
            &[
                (c"type", text(self.anchor, "done")?),
                (c"operationId", number(self.anchor, id as f64)?),
                (c"result", result),
            ],
        )
    }
    /// 删除成功时同时交回被取消的排队 job；Node 用这份清单把它们的 waiter
    /// 以“会话已删除”结清。取消只发生在这里，而不是入队时。
    fn mutation_done_cancelled(&self, id: u64, result: L<'a>, cancelled: L<'a>) -> Result<L<'a>> {
        object(
            self.anchor,
            &[
                (c"type", text(self.anchor, "done")?),
                (c"operationId", number(self.anchor, id as f64)?),
                (c"result", result),
                (c"cancelled", cancelled),
            ],
        )
    }
    fn mutation_failed(&self, id: u64, error: L<'a>) -> Result<L<'a>> {
        object(
            self.anchor,
            &[
                (c"type", text(self.anchor, "done")?),
                (c"operationId", number(self.anchor, id as f64)?),
                (c"failed", boolean(self.anchor, true)?),
                (c"error", error),
            ],
        )
    }
    fn mutation_completion(
        &self,
        effects: L<'a>,
        finished: bool,
        failed: bool,
        result: L<'a>,
    ) -> Result<L<'a>> {
        object(
            self.anchor,
            &[
                (c"effects", effects),
                (c"finished", boolean(self.anchor, finished)?),
                (c"failed", boolean(self.anchor, failed)?),
                (c"result", result),
            ],
        )
    }
    fn start_mutation(
        &self,
        session: L<'a>,
        cache_key: &JsString,
        job: &mut Mutation,
    ) -> Result<NextOutcome<'a>> {
        match job.kind {
            MutationKind::Append => {
                let message = self.read(&job.args[0])?;
                let prepared = self.prepare_append_message(session, message)?;
                if !prepared.truthy()? {
                    return Ok(NextOutcome::Done(
                        self.mutation_done(job.id, boolean(self.anchor, false)?)?,
                    ));
                }
                job.op = Some(self.capture(prepared.get(c"operationId")?)?);
                job.payload = Some(self.capture(prepared.get(c"payload")?)?);
                job.result = Some(self.capture(boolean(self.anchor, true)?)?);
                job.phase = Phase::Transcript;
                Ok(NextOutcome::Write(self.mutation_write_step(
                    session,
                    job,
                    "transcript",
                )?))
            }
            MutationKind::Interim => {
                // 清理会推进 generation，重新注册会推进 epoch：两者都让排队
                // 中的临时态失去意义，到队首即丢弃，避免旧会话的文本复活到
                // 新代次里。
                if job.generation != self.generation(cache_key)
                    || job.epoch != self.epoch(cache_key)
                {
                    return Ok(NextOutcome::Done(
                        self.mutation_done(job.id, self.undefined()?)?,
                    ));
                }
                let state = self.read(&job.args[0])?;
                let interim = match self.build_interim(state) {
                    Ok(interim) => interim,
                    Err(error) => {
                        let value = caught(self.anchor, error)?;
                        self.log_failure("chat_history_interim_save_failed", value, Some(session))?;
                        return Ok(NextOutcome::Done(
                            self.mutation_done(job.id, self.undefined()?)?,
                        ));
                    }
                };
                match self.prepare_interim(session, interim) {
                    Ok(prepared) => {
                        let result = prepared.get(c"result")?;
                        if !prepared.get(c"write")?.truthy()? {
                            return Ok(NextOutcome::Done(self.mutation_done(job.id, result)?));
                        }
                        job.op = Some(self.capture(prepared.get(c"operationId")?)?);
                        job.payload = Some(self.capture(prepared.get(c"payload")?)?);
                        job.result = Some(self.capture(result)?);
                        job.phase = Phase::Transcript;
                        Ok(NextOutcome::Write(self.mutation_write_step(
                            session,
                            job,
                            "transcript",
                        )?))
                    }
                    Err(error) => {
                        let value = caught(self.anchor, error)?;
                        self.log_failure("chat_history_interim_save_failed", value, Some(session))?;
                        Ok(NextOutcome::Done(
                            self.mutation_done(job.id, self.undefined()?)?,
                        ))
                    }
                }
            }
            MutationKind::Replace => self.start_replace(session, job),
            MutationKind::ReplaceAll => self.start_replace_all(session, job),
            MutationKind::DropMessages => self.start_drop_messages(session, job),
            MutationKind::MergeAll => self.start_merge_all(session, job),
            MutationKind::Delete => self.start_delete(session, cache_key, job),
            _ => self.start_visibility(session, job),
        }
    }
    /// 整份历史替换。旧调用方（任务删除、上下文包导入、fork）直接同步写盘，
    /// 可能落在一次仍在排队的追加之前，把刚追加的消息覆盖掉。这里把它当成
    /// 队首的原子变更：前面的落盘步骤已经完成，后面的追加排在它之后；仓库写
    /// 仍是同步的，但顺序由同一条 FIFO 决定。
    fn start_replace_all(&self, session: L<'a>, job: &mut Mutation) -> Result<NextOutcome<'a>> {
        let values = self.read(&job.args[0])?;
        let options = self.read(&job.args[1])?;
        let options = if options.undefined()? {
            object(self.anchor, &[])?
        } else {
            options
        };
        match self.service("replace", &[string(session)?, values, options]) {
            Ok(_) => Ok(NextOutcome::Done(
                self.mutation_done(job.id, boolean(self.anchor, true)?)?,
            )),
            Err(error) => {
                let value = caught(self.anchor, error)?;
                self.log_failure("chat_history_replace_failed", value, Some(session))?;
                Ok(NextOutcome::Done(self.mutation_failed(job.id, value)?))
            }
        }
    }
    /// 按 id 删除若干条消息。判据（哪些 id 属于要删的任务）仍由 Node 提供，
    /// 但“当前 transcript 是什么”必须在队首读取：Node 先读后写会漏掉在飞
    /// 追加，这里在队列头基于已提交的最新状态过滤，再整份替换。
    fn start_drop_messages(&self, session: L<'a>, job: &mut Mutation) -> Result<NextOutcome<'a>> {
        let ids = self.read(&job.args[0])?;
        let options = self.read(&job.args[1])?;
        let options = if options.undefined()? {
            object(self.anchor, &[])?
        } else {
            options
        };
        let mut drop: HashSet<JsString> = HashSet::new();
        for index in 0..length(ids)? {
            let id = ids.element(index as u32)?;
            if id.truthy()? {
                drop.insert(id.coerce_string()?);
            }
        }
        let messages = self.service("read", &[string(session)?])?;
        let kept = array(self.anchor)?;
        for index in 0..length(messages)? {
            let message = messages.element(index as u32)?;
            let id = message.get(c"id")?;
            let removable = if id.truthy()? {
                drop.contains(&id.coerce_string()?)
            } else {
                false
            };
            if !removable {
                push(kept, message)?;
            }
        }
        match self.service("replace", &[string(session)?, kept, options]) {
            Ok(_) => Ok(NextOutcome::Done(
                self.mutation_done(job.id, boolean(self.anchor, true)?)?,
            )),
            Err(error) => {
                let value = caught(self.anchor, error)?;
                self.log_failure("chat_history_replace_failed", value, Some(session))?;
                Ok(NextOutcome::Done(self.mutation_failed(job.id, value)?))
            }
        }
    }
    /// 上下文包合并导入：底稿必须在队首读取，再把导入消息接在后面。Node 先
    /// 读再整份替换会漏掉在飞追加；这里让 Rust 基于最新状态做合并。
    fn start_merge_all(&self, session: L<'a>, job: &mut Mutation) -> Result<NextOutcome<'a>> {
        let imported = self.read(&job.args[0])?;
        let options = self.read(&job.args[1])?;
        let options = if options.undefined()? {
            object(self.anchor, &[])?
        } else {
            options
        };
        let current = self.service("read", &[string(session)?])?;
        let merged = array(self.anchor)?;
        for index in 0..length(current)? {
            push(merged, current.element(index as u32)?)?;
        }
        for index in 0..length(imported)? {
            push(merged, imported.element(index as u32)?)?;
        }
        match self.service("replace", &[string(session)?, merged, options]) {
            Ok(_) => Ok(NextOutcome::Done(
                self.mutation_done(job.id, boolean(self.anchor, true)?)?,
            )),
            Err(error) => {
                let value = caught(self.anchor, error)?;
                self.log_failure("chat_history_replace_failed", value, Some(session))?;
                Ok(NextOutcome::Done(self.mutation_failed(job.id, value)?))
            }
        }
    }
    /// 会话删除也是队列里的一项。入队时只标记“正在删除”并把删除插在在飞
    /// 写入之后、未开始写入之前；这里在队首同步调用服务删除（断言、仓库删
    /// 除、缓存清空、delete 事件）。删除成功才落墓碑并取消排在后面的 job；
    /// 删除被拒则撤销标记，排队的写入继续执行。
    fn start_delete(
        &self,
        session: L<'a>,
        cache_key: &JsString,
        job: &mut Mutation,
    ) -> Result<NextOutcome<'a>> {
        self.clear_incremental_save(session)?;
        let delete_epoch = job.epoch;
        match self.service("deleteSession", &[string(session)?]) {
            Ok(_) => {
                self.invalidate(session)?;
                // 删除成功之后，队列里剩下的都是尚未开始的写入（在飞的那一
                // 个一定排在删除之前且已经结算）。只取消入队代次不高于删除
                // 自身的 job：它们属于被删掉的旧历史，并把 operationId 交回
                // Node 结清 waiter。删除期间会话被重新注册（代次已推进）时，
                // 新代次的写入保留在原位，删除之后照常执行。
                let cancelled = array(self.anchor)?;
                {
                    let mut queues = self.owner.mutations.borrow_mut();
                    let mut kept = VecDeque::new();
                    if let Some(queue) = queues.get_mut(cache_key) {
                        while let Some(queued) = queue.pop_front() {
                            if queued.epoch <= delete_epoch {
                                push(cancelled, number(self.anchor, queued.id as f64)?)?;
                            } else {
                                kept.push_back(queued);
                            }
                        }
                        queue.append(&mut kept);
                    }
                    if queues.get(cache_key).is_none_or(|queue| queue.is_empty()) {
                        queues.remove(cache_key);
                    }
                }
                self.release_delete_marker(cache_key, job.id);
                // 只有当前代次仍是删除自己的代次时才落墓碑。重新注册发生在
                // 删除入队之后时，新代次的会话仍有待执行的写入，墓碑必须留给
                // 下一次删除。
                if self.epoch(cache_key) == delete_epoch {
                    self.owner.removed.borrow_mut().insert(cache_key.clone());
                }
                Ok(NextOutcome::Done(self.mutation_done_cancelled(
                    job.id,
                    boolean(self.anchor, true)?,
                    cancelled,
                )?))
            }
            Err(error) => {
                // 删除没成功（例如任务引用保护）：撤销“正在删除”标记，排队
                // 的写入（包括删除期间新接受的那些）保持原位并继续执行。这
                // 里从不落墓碑，所以被接受的写入不会丢，也不会被告知会话已
                // 删除。
                self.release_delete_marker(cache_key, job.id);
                let value = caught(self.anchor, error)?;
                self.log_failure("chat_history_delete_failed", value, Some(session))?;
                Ok(NextOutcome::Done(self.mutation_failed(job.id, value)?))
            }
        }
    }
    /// 只释放属于这个删除 job 的标记。新代次的删除会在同一个槽位写入自己的
    /// operationId；旧 job 结算时不能顺手把它清掉。
    fn release_delete_marker(&self, cache_key: &JsString, operation: u64) {
        let mut markers = self.owner.deleting.borrow_mut();
        if matches!(markers.get(cache_key), Some((_, id)) if *id == operation) {
            markers.remove(cache_key);
        }
    }
    fn start_replace(&self, session: L<'a>, job: &mut Mutation) -> Result<NextOutcome<'a>> {
        let turn_id = self.read(&job.args[0])?;
        let patch = self.read(&job.args[1])?;
        let options = self.read(&job.args[2])?;
        let plan = self.annotate_plan(session, turn_id, patch, options)?;
        let Some(plan) = plan else {
            return Ok(NextOutcome::Done(
                self.mutation_done(job.id, array(self.anchor)?)?,
            ));
        };
        let prepared = self.service(
            "prepareReplace",
            &[
                string(session)?,
                plan.get(c"values")?,
                object(
                    self.anchor,
                    &[
                        (c"reason", text(self.anchor, "aux-task-attribution")?),
                        (c"afterCommit", self.undefined()?),
                    ],
                )?,
            ],
        );
        match prepared {
            Ok(prepared) => {
                job.op = Some(self.capture(prepared.get(c"operationId")?)?);
                job.payload = Some(self.capture(prepared.get(c"payload")?)?);
                job.result = Some(self.capture(plan.get(c"changed")?)?);
                job.emit = Some(self.capture(plan.get(c"event")?)?);
                job.phase = Phase::Transcript;
                Ok(NextOutcome::Write(self.mutation_write_step(
                    session,
                    job,
                    "transcript",
                )?))
            }
            Err(error) => {
                let value = caught(self.anchor, error)?;
                self.log_failure("chat_history_annotation_failed", value, Some(session))?;
                Ok(NextOutcome::Done(
                    self.mutation_done(job.id, array(self.anchor)?)?,
                ))
            }
        }
    }
    fn start_visibility(&self, session: L<'a>, job: &mut Mutation) -> Result<NextOutcome<'a>> {
        match job.kind {
            MutationKind::Clear => {
                let keep = self.read(&job.args[0])?;
                let values = self.clear_visibility_values(session, keep)?;
                job.plan = Some(self.capture(values.get(c"plan")?)?);
                job.result = Some(self.capture(values.get(c"result")?)?);
                self.begin_visibility(session, job)
            }
            MutationKind::Remove => {
                let id = self.read(&job.args[0])?;
                match self.remove_visibility_plan(session, id)? {
                    Some(plan) => {
                        job.plan = Some(self.capture(plan)?);
                        job.result = Some(self.capture(boolean(self.anchor, true)?)?);
                        self.begin_visibility(session, job)
                    }
                    None => Ok(NextOutcome::Done(
                        self.mutation_done(job.id, boolean(self.anchor, false)?)?,
                    )),
                }
            }
            MutationKind::RemoveMany => {
                let ids = self.read(&job.args[0])?;
                let (count, plan) = self.remove_many_values(session, ids)?;
                let Some(plan) = plan else {
                    return Ok(NextOutcome::Done(
                        self.mutation_done(job.id, number(self.anchor, 0.0)?)?,
                    ));
                };
                job.plan = Some(self.capture(plan)?);
                job.result = Some(self.capture(number(self.anchor, count as f64)?)?);
                self.begin_visibility(session, job)
            }
            MutationKind::Hide => self.start_hide(session, job),
            _ => Err(Error::from_reason("invalid visibility mutation")),
        }
    }
    fn start_hide(&self, session: L<'a>, job: &mut Mutation) -> Result<NextOutcome<'a>> {
        let ids = self.read(&job.args[0])?;
        let list = if ids.is_array()? {
            ids
        } else {
            array(self.anchor)?
        };
        loop {
            if job.cursor >= length(list)? {
                return Ok(NextOutcome::Done(
                    self.mutation_done(job.id, number(self.anchor, job.hidden)?)?,
                ));
            }
            let id = list.element(job.cursor as u32)?;
            job.cursor += 1;
            if id.kind()? != sys::ValueType::napi_string || !id.truthy()? {
                continue;
            }
            match self.remove_visibility_plan(session, id)? {
                None => continue,
                Some(plan) => {
                    job.plan = Some(self.capture(plan)?);
                    let payload = object(
                        self.anchor,
                        &[
                            (c"type", text(self.anchor, "chat_msg_deleted")?),
                            (c"id", id),
                            (c"displayOnly", boolean(self.anchor, true)?),
                        ],
                    )?;
                    job.emit =
                        Some(self.capture(self.effect(payload, "chat_history_hide_failed")?)?);
                    return self.begin_visibility(session, job);
                }
            }
        }
    }
    fn persist_plan(&self, session: L<'a>) -> Result<L<'a>> {
        self.service("preparePersist", &[string(session)?])
    }
    fn prepare_interim(&self, session: L<'a>, interim: L<'a>) -> Result<L<'a>> {
        self.service(
            "prepareInterim",
            &[
                string(session)?,
                interim,
                object(self.anchor, &[(c"afterCommit", self.undefined()?)])?,
            ],
        )
    }
    /// Interim message as the legacy tick built it (role, tools, clock, task id
    /// and short code). Kept outside the service because it uses runtime ports.
    fn build_interim(&self, state: L<'a>) -> Result<L<'a>> {
        let body = state.get(c"currentAssistantText")?;
        let raw_tools = state.get(c"currentToolCalls")?;
        let tool_count = if raw_tools.is_array()? {
            length(raw_tools)?
        } else {
            0
        };
        let interim = object(
            self.anchor,
            &[
                (c"role", text(self.anchor, "assistant")?),
                (c"content", body),
                (
                    c"tools",
                    if tool_count > 0 {
                        raw_tools
                    } else {
                        self.undefined()?
                    },
                ),
                (c"ts", self.port(c"clock", &[])?),
                (c"_interim", boolean(self.anchor, true)?),
            ],
        )?;
        let task = state.get(c"_currentTaskId")?;
        if task.truthy()? {
            interim.set(c"taskId", task)?;
        }
        self.stamp_task_code(interim)?;
        Ok(interim)
    }
    fn begin_visibility(&self, session: L<'a>, job: &mut Mutation) -> Result<NextOutcome<'a>> {
        let persist = self.persist_plan(session)?;
        if persist.get(c"write")?.truthy()? {
            job.op = Some(self.capture(persist.get(c"operationId")?)?);
            job.payload = Some(self.capture(persist.get(c"payload")?)?);
            job.phase = Phase::Transcript;
            return Ok(NextOutcome::Write(self.mutation_write_step(
                session,
                job,
                "transcript",
            )?));
        }
        self.prepare_visibility_write(job)?;
        Ok(NextOutcome::Write(self.mutation_write_step(
            session,
            job,
            "visibility",
        )?))
    }
    fn prepare_visibility_write(&self, job: &mut Mutation) -> Result<()> {
        let plan = self.read(
            job.plan
                .as_ref()
                .ok_or_else(|| Error::from_reason("mutation plan missing"))?,
        )?;
        job.payload = Some(self.capture(plan.get(c"stateJson")?)?);
        job.phase = Phase::Visibility;
        Ok(())
    }
    fn commit_pending(&self, job: &Mutation, meta: L<'a>) -> Result<()> {
        let op = match &job.op {
            Some(value) => self.read(value)?,
            None => self.undefined()?,
        };
        // 写字节的回执（bytes/行尾偏移）随 commit 交给历史服务登记账本；
        // 非 transcript 写（visibility 等）没有回执，账本保守失效。
        self.service("commitAppend", &[op, meta])?;
        Ok(())
    }
    fn discard_pending(&self, job: &Mutation) -> Result<()> {
        if let Some(value) = &job.op {
            let op = self.read(value)?;
            let _ = self.service("discardAppend", &[op]);
        }
        Ok(())
    }
    fn complete_mutation_step(
        &self,
        session: L<'a>,
        operation_id: L<'a>,
        ok: L<'a>,
        error: L<'a>,
        write_meta: L<'a>,
    ) -> Result<L<'a>> {
        let session = string(session)?;
        let cache_key = key(session)?;
        let id = operation_id.number()? as u64;
        let popped = match self.owner.mutations.borrow_mut().get_mut(&cache_key) {
            Some(queue) => queue.pop_front(),
            None => None,
        };
        let Some(mut job) = popped else {
            return self.mutation_completion(array(self.anchor)?, false, false, self.undefined()?);
        };
        if job.id != id {
            self.reinsert_mutation(&cache_key, job);
            return Err(Error::from_reason(
                "history mutation completion out of order",
            ));
        }
        let effects = array(self.anchor)?;
        if ok.truthy()? {
            match job.phase {
                Phase::Transcript => {
                    let committed = self.commit_pending(&job, write_meta);
                    match committed {
                        Ok(()) => match job.kind {
                            MutationKind::Append | MutationKind::Interim => {
                                let result = match &job.result {
                                    Some(value) => self.read(value)?,
                                    None => self.undefined()?,
                                };
                                self.mutation_completion(effects, true, false, result)
                            }
                            MutationKind::Replace => {
                                if let Some(emit) = &job.emit {
                                    push(effects, self.read(emit)?)?;
                                }
                                let result = match &job.result {
                                    Some(value) => self.read(value)?,
                                    None => self.undefined()?,
                                };
                                self.mutation_completion(effects, true, false, result)
                            }
                            _ => {
                                self.prepare_visibility_write(&mut job)?;
                                self.reinsert_mutation(&cache_key, job);
                                return self.mutation_completion(
                                    effects,
                                    false,
                                    false,
                                    self.undefined()?,
                                );
                            }
                        },
                        Err(commit_error) => {
                            let value = caught(self.anchor, commit_error)?;
                            let _ = self.discard_pending(&job);
                            self.finish_failed_write(session, &cache_key, job, effects, value)
                        }
                    }
                }
                Phase::Visibility => {
                    let plan = self.read(
                        job.plan
                            .as_ref()
                            .ok_or_else(|| Error::from_reason("mutation plan missing"))?,
                    )?;
                    let captured = self.capture(plan.get(c"next")?)?;
                    self.owner
                        .visibility
                        .borrow_mut()
                        .insert(cache_key.clone(), captured);
                    match job.kind {
                        MutationKind::Clear => {
                            let generation = self.generation(&cache_key).wrapping_add(1);
                            self.owner
                                .generations
                                .borrow_mut()
                                .insert(cache_key, generation);
                        }
                        MutationKind::Hide => {
                            if let Some(emit) = &job.emit {
                                push(effects, self.read(emit)?)?;
                            }
                            job.hidden += 1.0;
                            // One id per round: hand the job back to the start
                            // phase so the next id gets its own plan and write.
                            job.phase = Phase::Start;
                            job.plan = None;
                            job.payload = None;
                            job.emit = None;
                            job.op = None;
                            self.reinsert_mutation(&cache_key, job);
                            return self.mutation_completion(
                                effects,
                                false,
                                false,
                                self.undefined()?,
                            );
                        }
                        _ => {}
                    }
                    let result = match &job.result {
                        Some(value) => self.read(value)?,
                        None => self.undefined()?,
                    };
                    self.mutation_completion(effects, true, false, result)
                }
                Phase::Start => Err(Error::from_reason(
                    "history mutation completed before starting",
                )),
            }
        } else {
            self.handle_mutation_failure(session, &cache_key, job, effects, error)
        }
    }
    fn finish_failed_write(
        &self,
        session: L<'a>,
        cache_key: &JsString,
        job: Mutation,
        effects: L<'a>,
        value: L<'a>,
    ) -> Result<L<'a>> {
        match job.kind {
            MutationKind::Append => {
                self.log_failure("chat_history_append_failed", value, Some(session))?;
                self.mutation_completion(effects, true, false, boolean(self.anchor, false)?)
            }
            MutationKind::Interim => {
                self.log_failure("chat_history_interim_save_failed", value, Some(session))?;
                self.mutation_completion(effects, true, false, self.undefined()?)
            }
            MutationKind::Replace => {
                self.log_failure("chat_history_annotation_failed", value, Some(session))?;
                self.mutation_completion(effects, true, false, array(self.anchor)?)
            }
            MutationKind::Hide => {
                self.log_failure("chat_history_hide_failed", value, Some(session))?;
                // The cursor already advanced past this id; restart the start
                // phase so the next id is attempted (the legacy loop skipped a
                // failed id and kept going).
                let mut job = job;
                job.phase = Phase::Start;
                job.plan = None;
                job.payload = None;
                job.emit = None;
                job.op = None;
                self.reinsert_mutation(cache_key, job);
                self.mutation_completion(effects, false, false, self.undefined()?)
            }
            _ => self.mutation_completion(effects, true, true, self.undefined()?),
        }
    }
    fn handle_mutation_failure(
        &self,
        session: L<'a>,
        cache_key: &JsString,
        job: Mutation,
        effects: L<'a>,
        error: L<'a>,
    ) -> Result<L<'a>> {
        if job.phase == Phase::Transcript {
            let _ = self.discard_pending(&job);
        }
        self.finish_failed_write(session, cache_key, job, effects, error)
    }

    // ── 任务短码 ──────────────────────────────────────────────────────────
    fn task_code(&self, task_id: L<'a>) -> Result<L<'a>> {
        let short_code = self.ports.get(c"taskShortCode")?;
        if !short_code.truthy()? || !task_id.truthy()? {
            return text(self.anchor, "");
        }
        let value = short_code.call_plain(&[task_id])?;
        let value = if value.truthy()? {
            value
        } else {
            text(self.anchor, "")?
        };
        let trimmed = method(string(value)?, c"trim", &[])?;
        let code = method(trimmed, c"toUpperCase", &[])?;
        let pattern = regexp(self.anchor, "^[0-9A-Z]{4}$")?;
        if method(pattern, c"test", &[code])?.truthy()? {
            Ok(code)
        } else {
            text(self.anchor, "")
        }
    }
    fn stamp_task_code(&self, message: L<'a>) -> Result<()> {
        if !message.truthy()? || message.kind()? != sys::ValueType::napi_object {
            return Ok(());
        }
        let code = self.task_code(message.get(c"taskId")?)?;
        if code.truthy()? {
            message.assign(c"taskShortCode", code)?;
        }
        Ok(())
    }
    fn project_task_code(&self, message: L<'a>) -> Result<L<'a>> {
        if !message.truthy()? || message.kind()? != sys::ValueType::napi_object {
            return Ok(message);
        }
        if message.get(c"taskShortCode")?.truthy()? {
            return Ok(message);
        }
        let code = self.task_code(message.get(c"taskId")?)?;
        if !code.truthy()? {
            return Ok(message);
        }
        let out = spread_copy(self.anchor, message)?;
        out.set(c"taskShortCode", code)?;
        Ok(out)
    }
    fn project_codes(&self, messages: L<'a>) -> Result<L<'a>> {
        let out = array(self.anchor)?;
        for index in 0..length(messages)? {
            push(
                out,
                self.project_task_code(messages.element(index as u32)?)?,
            )?;
        }
        Ok(out)
    }

    // ── 蒸馏 ──────────────────────────────────────────────────────────────
    fn start_memory_distill(&self, session: L<'a>, messages: L<'a>) -> Result<L<'a>> {
        let result = match self.port(c"distillHistoryIntoMemory", &[session, messages]) {
            Ok(result) => result,
            Err(error) => {
                let value = caught(self.anchor, error)?;
                self.log_failure("chat_history_memory_distill_failed", value, Some(session))?;
                return self.undefined();
            }
        };
        let promise_ctor = self.anchor.global()?.get(c"Promise")?;
        let promise = promise_ctor
            .get(c"resolve")?
            .call(promise_ctor, &[result])?;
        let failure = self.bind(self.ports.get(c"runDistillFailure")?, &[session])?;
        promise.get(c"catch")?.call(promise, &[failure])?;
        Ok(result)
    }
    fn messages_from(&self, buffer: &[Value]) -> Result<L<'a>> {
        let messages = array(self.anchor)?;
        for (index, value) in buffer.iter().enumerate() {
            messages.set_element(index as u32, self.read(value)?)?;
        }
        Ok(messages)
    }
    fn handle_event(&self, event: L<'a>) -> Result<L<'a>> {
        if !event.truthy()? {
            return self.undefined();
        }
        let session = event.get(c"sessionId")?;
        if !session.truthy()? {
            return self.undefined();
        }
        let kind = event.get(c"type")?;
        if kind.is_string("delete")? {
            self.invalidate(session)?;
        }
        if kind.is_string("append")? {
            let aux = self.ports.get(c"auxSessionId")?;
            let batch = self.owner.distill_batch;
            let dropped = event.optional(c"dropped")?;
            let dropped = if dropped.truthy()? {
                dropped
            } else {
                array(self.anchor)?
            };
            dropped.for_each(|entry| {
                if session.equals(aux)? || !entry.truthy()? {
                    return Ok(());
                }
                let cache_key = key(session)?;
                let buffer = {
                    let mut buffers = self.owner.dropped.borrow_mut();
                    let buffer = buffers
                        .entry(cache_key.clone())
                        .or_insert_with(|| Rc::new(RefCell::new(Vec::new())))
                        .clone();
                    buffer.borrow_mut().push(self.capture(entry)?);
                    buffer
                };
                let snapshot = buffer.borrow().clone();
                if snapshot.len() as f64 >= batch {
                    let messages = self.messages_from(&snapshot)?;
                    self.start_memory_distill(session, messages)?;
                    self.owner
                        .dropped
                        .borrow_mut()
                        .insert(cache_key, Rc::new(RefCell::new(Vec::new())));
                }
                Ok(())
            })?;
            let message = event.get(c"message")?;
            if message.truthy()? {
                let committed = public_committed(message)?;
                let client = fallback(
                    message.get(c"clientMsgId")?,
                    self.anchor.from_value(&J::Null)?,
                )?;
                let payload = object(
                    self.anchor,
                    &[
                        (c"type", text(self.anchor, "chat_msg_meta")?),
                        (c"id", message.get(c"id")?),
                        (c"role", message.get(c"role")?),
                        (c"ts", message.get(c"ts")?),
                        (c"clientMsgId", client),
                        (
                            c"message",
                            if committed.truthy()? {
                                committed
                            } else {
                                self.undefined()?
                            },
                        ),
                    ],
                )?;
                self.port(c"chatBroadcast", &[session, payload])?;
                if !event.get(c"deduplicated")?.truthy()?
                    && message.get(c"role")?.is_string("assistant")?
                    && !message.get(c"_interim")?.truthy()?
                    && !message.get(c"cancelled")?.truthy()?
                    && !message.get(c"partial")?.truthy()?
                    && !message.get(c"error")?.truthy()?
                {
                    let tick = self.bind(self.ports.get(c"runPeriodicReview")?, &[session])?;
                    self.port(c"setImmediate", &[tick])?;
                }
            }
            return self.undefined();
        }
        if kind.is_string("remove")? {
            let message = event.get(c"message")?;
            if message.truthy()? {
                let payload = object(
                    self.anchor,
                    &[
                        (c"type", text(self.anchor, "chat_msg_deleted")?),
                        (c"id", message.get(c"id")?),
                    ],
                )?;
                self.port(c"chatBroadcast", &[session, payload])?;
            }
        }
        self.undefined()
    }

    // ── 同步核心 ──────────────────────────────────────────────────────────
    fn load(&self, session: L<'a>) -> Result<L<'a>> {
        self.service("read", &[session])
    }
    fn view_history(&self, session: L<'a>) -> Result<L<'a>> {
        self.service("view", &[session])
    }
    fn latest_assistant_at(&self, session: L<'a>) -> Result<L<'a>> {
        self.service("latestAssistantAt", &[session])
    }
    fn latest_assistant_conclusion(&self, session: L<'a>, home: L<'a>) -> Result<L<'a>> {
        self.service("latestAssistantConclusion", &[session, home])
    }
    fn projected_messages(&self, session: L<'a>, include_hidden: bool) -> Result<L<'a>> {
        let messages = self.service("view", &[session])?;
        let apply = |values: L<'a>| -> Result<L<'a>> {
            if include_hidden {
                Ok(values)
            } else {
                self.filter(session, values, true)
            }
        };
        let project = self.ports.get(c"projectMessages")?;
        if !project.truthy()? {
            return self.project_codes(apply(messages)?);
        }
        let outcome = (|| -> Result<L<'a>> {
            let projected = project.call_plain(&[string(session)?, messages])?;
            let base = if projected.is_array()? {
                projected
            } else {
                messages
            };
            self.project_codes(apply(base)?)
        })();
        match outcome {
            Ok(value) => Ok(value),
            Err(error) => {
                let value = caught(self.anchor, error)?;
                self.log_failure("chat_history_projection_failed", value, Some(session))?;
                self.project_codes(apply(messages)?)
            }
        }
    }
    fn paginate(&self, session: L<'a>, options: L<'a>) -> Result<L<'a>> {
        let messages =
            self.projected_messages(session, options.get(c"includeHidden")?.truthy()?)?;
        let fallback_size = self.owner.page_size;
        let raw_limit = options.get(c"limit")?;
        let limit = if raw_limit.undefined()? {
            number(self.anchor, fallback_size)?
        } else {
            raw_limit
        };
        let parsed = self
            .anchor
            .global()?
            .get(c"parseInt")?
            .call_plain(&[limit, number(limit, 10.0)?])?
            .number()?;
        let parsed = if parsed.is_nan() || parsed == 0.0 {
            fallback_size
        } else {
            parsed
        };
        let page_size = parsed.clamp(1.0, 100.0) as usize;
        let around = options.get(c"around")?;
        if around.truthy()? {
            let target = clip160(string(around)?)?;
            let mut found = None;
            for index in 0..length(messages)? {
                if messages.element(index as u32)?.get(c"id")?.equals(target)? {
                    found = Some(index);
                    break;
                }
            }
            let Some(target_index) = found else {
                return object(
                    self.anchor,
                    &[
                        (c"messages", array(self.anchor)?),
                        (c"hasMore", boolean(self.anchor, false)?),
                        (c"before", self.anchor.from_value(&J::Null)?),
                        (c"found", boolean(self.anchor, false)?),
                        (c"hasNewer", boolean(self.anchor, false)?),
                    ],
                )?
                .freeze();
            };
            let half = (page_size - 1) / 2;
            let mut start = target_index.saturating_sub(half);
            let end = length(messages)?.min(start + page_size);
            start = end.saturating_sub(page_size);
            let page = method(
                messages,
                c"slice",
                &[
                    number(messages, start as f64)?,
                    number(messages, end as f64)?,
                ],
            )?;
            let before = if start > 0 {
                messages.element(start as u32)?.get(c"id")?
            } else {
                self.anchor.from_value(&J::Null)?
            };
            return object(
                self.anchor,
                &[
                    (c"messages", clone_json(page)?),
                    (c"hasMore", boolean(self.anchor, start > 0)?),
                    (c"before", before),
                    (c"found", boolean(self.anchor, true)?),
                    (c"hasNewer", boolean(self.anchor, end < length(messages)?)?),
                ],
            )?
            .freeze();
        }
        let mut end = length(messages)?;
        let before = options.get(c"before")?;
        if before.truthy()? {
            let mut found = None;
            for index in 0..end {
                if messages.element(index as u32)?.get(c"id")?.equals(before)? {
                    found = Some(index);
                    break;
                }
            }
            match found {
                Some(index) => end = index,
                None => {
                    return object(
                        self.anchor,
                        &[
                            (c"messages", array(self.anchor)?),
                            (c"hasMore", boolean(self.anchor, false)?),
                            (c"before", self.anchor.from_value(&J::Null)?),
                        ],
                    )?
                    .freeze();
                }
            }
        }
        let start = end.saturating_sub(page_size);
        let page = method(
            messages,
            c"slice",
            &[
                number(messages, start as f64)?,
                number(messages, end as f64)?,
            ],
        )?;
        let before = if start > 0 {
            messages.element(start as u32)?.get(c"id")?
        } else {
            self.anchor.from_value(&J::Null)?
        };
        object(
            self.anchor,
            &[
                (c"messages", clone_json(page)?),
                (c"hasMore", boolean(self.anchor, start > 0)?),
                (c"before", before),
            ],
        )?
        .freeze()
    }
    fn last_activity(&self, session: L<'a>, active_chat: L<'a>) -> Result<L<'a>> {
        let saved = self.latest_assistant_at(session)?;
        let raw = if active_chat.truthy()? {
            active_chat.get(c"lastActivity")?
        } else {
            self.undefined()?
        };
        let live = if raw.truthy()? {
            self.anchor.global()?.get(c"Date")?.construct(&[raw])?
        } else {
            self.anchor.from_value(&J::Null)?
        };
        let live_valid = if live.truthy()? {
            live.get(c"getTime")?.call(live, &[])?.number()?.is_finite()
        } else {
            false
        };
        if saved.truthy()? && live_valid {
            let saved_at = saved.get(c"getTime")?.call(saved, &[])?.number()?;
            let live_at = live.get(c"getTime")?.call(live, &[])?.number()?;
            return Ok(if saved_at >= live_at { saved } else { live });
        }
        if saved.truthy()? {
            return Ok(saved);
        }
        Ok(if live_valid {
            live
        } else {
            self.anchor.from_value(&J::Null)?
        })
    }
    fn prepare_append_message(&self, session: L<'a>, message: L<'a>) -> Result<L<'a>> {
        if !message.truthy()? || message.kind()? != sys::ValueType::napi_object {
            return boolean(self.anchor, false);
        }
        if !message.get(c"id")?.truthy()? {
            message.assign(c"id", self.port(c"idFactory", &[])?)?;
        }
        if message.get(c"taskId")?.nullish()? {
            let owner = self.chat_session(session)?;
            let task = if owner.truthy()? {
                owner.get(c"_currentTaskId")?
            } else {
                self.undefined()?
            };
            if task.truthy()? {
                message.assign(c"taskId", task)?;
            }
        }
        self.stamp_task_code(message)?;
        if message.get(c"turnId")?.nullish()? {
            let owner = self.chat_session(session)?;
            let turn = owner.optional(c"_activeTurn")?.optional(c"turnId")?;
            if turn.truthy()? {
                message.assign(c"turnId", turn)?;
            }
        }
        let mut after = self.undefined()?;
        if message.get(c"role")?.is_string("assistant")? {
            let stamp = message.get(c"ts")?.explicit_number()?;
            let at = if stamp.is_finite() && stamp > 0.0 {
                self.anchor
                    .global()?
                    .get(c"Date")?
                    .construct(&[number(message, stamp)?])?
            } else {
                let now = self.port(c"clock", &[])?;
                self.anchor.global()?.get(c"Date")?.construct(&[now])?
            };
            let state = self.chat_session(session)?;
            if message.get(c"durationMs")?.nullish()? && state.truthy()? {
                let started = state.get(c"turnStartedAt")?;
                if started.truthy()? {
                    let at_ms = at.get(c"getTime")?.call(at, &[])?.number()?;
                    let elapsed = at_ms - started.number()?;
                    let value = self
                        .anchor
                        .global()?
                        .get(c"Math")?
                        .get(c"max")?
                        .call_plain(&[number(self.anchor, 0.0)?, number(self.anchor, elapsed)?])?;
                    message.assign(c"durationMs", value)?;
                }
            }
            after = self.bind(self.ports.get(c"afterCommitTick")?, &[state, at])?;
        }
        let options = object(self.anchor, &[(c"afterCommit", after)])?;
        match self.service("prepareAppend", &[session, message, options]) {
            Ok(prepared) => Ok(prepared),
            Err(error) => {
                let value = caught(self.anchor, error)?;
                self.log_failure("chat_history_append_failed", value, Some(session))?;
                boolean(self.anchor, false)
            }
        }
    }
    fn commit_append_message(&self, operation_id: L<'a>) -> Result<L<'a>> {
        self.service("commitAppend", &[operation_id])
    }
    /// 尾部增量写被 worker 拒收（账本与文件错位）时，宿主经这里拿整份快照重写。
    fn resend_pending_write(&self, operation_id: L<'a>) -> Result<L<'a>> {
        self.service("resendPending", &[operation_id])
    }
    fn discard_append_message(
        &self,
        session: L<'a>,
        operation_id: L<'a>,
        error: L<'a>,
    ) -> Result<L<'a>> {
        let _ = self.service("discardAppend", &[operation_id]);
        self.log_failure("chat_history_append_failed", error, Some(session))?;
        boolean(self.anchor, false)
    }
    /// `annotateTurn` split: compute the rewritten history and the broadcast it
    /// owes, but leave the durable replace to the queue step.
    fn annotate_plan(
        &self,
        session: L<'a>,
        turn_id: L<'a>,
        patch: L<'a>,
        options: L<'a>,
    ) -> Result<Option<L<'a>>> {
        let history = self.service("read", &[session])?;
        let selected = set_of(self.anchor, self.anchor.from_value(&J::Array(vec![]))?)?;
        let add = selected.get(c"add")?;
        if turn_id.truthy()? {
            for index in 0..length(history)? {
                let message = history.element(index as u32)?;
                if message.optional(c"turnId")?.equals(turn_id)? {
                    add.call(selected, &[message.get(c"id")?])?;
                }
            }
        }
        let anchor_message_id = options.get(c"anchorMessageId")?;
        if selected.get(c"size")?.number()? == 0.0 && anchor_message_id.truthy()? {
            let mut anchor: Option<usize> = None;
            for index in 0..length(history)? {
                if history
                    .element(index as u32)?
                    .optional(c"id")?
                    .equals(anchor_message_id)?
                {
                    anchor = Some(index);
                    break;
                }
            }
            if let Some(anchor) = anchor {
                let mut start = anchor as i64;
                while start >= 0
                    && !history
                        .element(start as u32)?
                        .optional(c"role")?
                        .is_string("user")?
                {
                    start -= 1;
                }
                for index in (start.max(0) as usize)..=anchor {
                    let id = history.element(index as u32)?.optional(c"id")?;
                    if id.truthy()? {
                        add.call(selected, &[id])?;
                    }
                }
            }
        }
        if selected.get(c"size")?.number()? == 0.0 {
            return Ok(None);
        }
        let changed = array(self.anchor)?;
        let next = array(self.anchor)?;
        for index in 0..length(history)? {
            let message = history.element(index as u32)?;
            if !selected
                .get(c"has")?
                .call(selected, &[message.optional(c"id")?])?
                .truthy()?
            {
                push(next, message)?;
                continue;
            }
            let copy = spread_copy(self.anchor, message)?;
            for field in [c"taskId", c"taskName", c"auxRunId"] {
                let value = patch.get(field)?;
                if !value.undefined()? {
                    copy.assign(field, value)?;
                }
            }
            self.stamp_task_code(copy)?;
            if message.get(c"role")?.is_string("user")? {
                for field in [c"taskStart", c"taskSource", c"taskText"] {
                    let value = patch.get(field)?;
                    if !value.undefined()? {
                        copy.assign(field, value)?;
                    }
                }
            }
            push(changed, copy)?;
            push(next, copy)?;
        }
        let summaries = array(self.anchor)?;
        let null = self.anchor.from_value(&J::Null)?;
        for index in 0..length(changed)? {
            let message = changed.element(index as u32)?;
            let summary = object(
                self.anchor,
                &[
                    (c"id", message.get(c"id")?),
                    (c"turnId", fallback(message.get(c"turnId")?, null)?),
                    (c"taskId", fallback(message.get(c"taskId")?, null)?),
                    (c"taskName", fallback(message.get(c"taskName")?, null)?),
                    (
                        c"taskShortCode",
                        fallback(message.get(c"taskShortCode")?, null)?,
                    ),
                    (c"auxRunId", fallback(message.get(c"auxRunId")?, null)?),
                ],
            )?;
            push(summaries, summary)?;
        }
        let payload = object(
            self.anchor,
            &[
                (c"type", text(self.anchor, "chat_history_annotation")?),
                (c"messages", summaries),
            ],
        )?;
        let event = self.effect(payload, "chat_history_annotation_failed")?;
        Ok(Some(object(
            self.anchor,
            &[(c"values", next), (c"changed", changed), (c"event", event)],
        )?))
    }

    // ── 增量保存定时器 ────────────────────────────────────────────────────
    fn schedule_incremental_save(&self, session: L<'a>, state: L<'a>) -> Result<L<'a>> {
        let cache_key = key(session)?;
        if self.owner.stopped.get() || self.timer_position(&cache_key).is_some() {
            return boolean(self.anchor, false);
        }
        let session_text = string(session)?;
        // The generation travels with the timer: an interim scheduled before a
        // clear must not resurrect old text after the clear commits. The epoch
        // travels too: a timer scheduled before a re-register belongs to the
        // old session and must not write into the new one.
        let generation = self.generation(&cache_key);
        let epoch = self.epoch(&cache_key);
        let tick = self.bind(
            self.ports.get(c"runIncrementalSave")?,
            &[
                session_text,
                state,
                number(self.anchor, generation as f64)?,
                number(self.anchor, epoch as f64)?,
            ],
        )?;
        let delay = self.owner.save_delay;
        let timer = self.port(c"setTimeout", &[tick, number(self.anchor, delay)?])?;
        if timer.truthy()? {
            let unref = timer.get(c"unref")?;
            if unref.kind()? == sys::ValueType::napi_function {
                unref.call(timer, &[])?;
            }
        }
        let captured = self.capture(timer)?;
        self.owner.timers.borrow_mut().push((cache_key, captured));
        boolean(self.anchor, true)
    }
    fn incremental_save_tick(
        &self,
        session: L<'a>,
        state: L<'a>,
        generation: L<'a>,
        epoch: L<'a>,
    ) -> Result<L<'a>> {
        let cache_key = key(session)?;
        self.timer_remove(&cache_key);
        // 定时器带着调度时的代次：会话在它触发前被重新注册时，这份旧代次的
        // 临时态不属于新会话，直接丢弃。
        if let Some(scheduled) = epoch.number_value()? {
            if scheduled as u64 != self.epoch(&cache_key) {
                return self.undefined();
            }
        }
        // 删除待定或已完成都不再入队临时态：待定期间写进去也只会在删除成功
        // 时被取消，删除失败后重来的定时器会重新调度。上一个代次的删除标记
        // 不再压制新代次的定时保存。
        let current_epoch = self.epoch(&cache_key);
        let deleting_current = self
            .owner
            .deleting
            .borrow()
            .get(&cache_key)
            .copied()
            .is_some_and(|(marker_epoch, _)| marker_epoch == current_epoch);
        if self.owner.removed.borrow().contains(&cache_key) || deleting_current {
            return self.undefined();
        }
        if self.owner.stopped.get() || !state.truthy()? {
            return self.undefined();
        }
        let body = state.get(c"currentAssistantText")?;
        if !body.truthy()? {
            return self.undefined();
        }
        if let Some(size) = body.get(c"length")?.number_value()? {
            if size < 20.0 {
                return self.undefined();
            }
        }
        let session_text = string(session)?;
        let args = array(self.anchor)?;
        push(args, state)?;
        push(args, generation)?;
        self.enqueue_mutation(session_text, text(self.anchor, "interim")?, args)
    }
    fn clear_incremental_save(&self, session: L<'a>) -> Result<L<'a>> {
        let cache_key = key(session)?;
        let timer = self.timer_get(&cache_key);
        let Some(timer) = timer else {
            return boolean(self.anchor, false);
        };
        let value = self.read(&timer)?;
        if !value.truthy()? {
            return boolean(self.anchor, false);
        }
        self.port(c"clearTimeout", &[value])?;
        self.timer_remove(&cache_key);
        boolean(self.anchor, true)
    }
    fn clear_all_incremental_saves(&self) -> Result<L<'a>> {
        let timers: Vec<(JsString, Value)> = self.owner.timers.borrow().clone();
        for (_, timer) in &timers {
            let value = self.read(timer)?;
            self.port(c"clearTimeout", &[value])?;
        }
        let count = timers.len();
        self.owner.timers.borrow_mut().clear();
        number(self.anchor, count as f64)
    }
    fn has_incremental_save(&self, session: L<'a>) -> Result<L<'a>> {
        let cache_key = key(session)?;
        boolean(self.anchor, self.timer_position(&cache_key).is_some())
    }
    fn stop(&self) -> Result<L<'a>> {
        if self.owner.stopped.get() {
            return boolean(self.anchor, false);
        }
        self.owner.stopped.set(true);
        self.clear_all_incremental_saves()?;
        self.owner.dropped.borrow_mut().clear();
        boolean(self.anchor, true)
    }

    fn run(&self, action: &str, args: L<'a>) -> Result<L<'a>> {
        let first = args.element(0)?;
        let second = args.element(1)?;
        match action {
            "prepareAppendMessage" => self.prepare_append_message(first, second),
            "commitAppendMessage" => self.commit_append_message(first),
            "discardAppendMessage" => self.discard_append_message(first, second, args.element(2)?),
            "annotateTurn" => {
                let patch = args.element(2)?;
                let patch = if patch.undefined()? {
                    object(self.anchor, &[])?
                } else {
                    patch
                };
                let options = args.element(3)?;
                let options = if options.undefined()? {
                    object(self.anchor, &[])?
                } else {
                    options
                };
                let list = array(self.anchor)?;
                push(list, second)?;
                push(list, patch)?;
                push(list, options)?;
                self.enqueue_mutation(first, text(self.anchor, "replace")?, list)
            }
            "clearVisibility" => {
                let list = array(self.anchor)?;
                push(list, second)?;
                self.enqueue_mutation(first, text(self.anchor, "clear")?, list)
            }
            "hideMessages" => {
                let options = args.element(2)?;
                let quiet = if options.truthy()? {
                    options.get(c"quiet")?.truthy()?
                } else {
                    false
                };
                let list = array(self.anchor)?;
                push(list, second)?;
                self.enqueue_mutation(
                    first,
                    text(self.anchor, if quiet { "removeMany" } else { "hide" })?,
                    list,
                )
            }
            "removeVisibility" => {
                let list = array(self.anchor)?;
                push(list, second)?;
                self.enqueue_mutation(first, text(self.anchor, "remove")?, list)
            }
            "appendMessage" => {
                let list = array(self.anchor)?;
                push(list, second)?;
                self.enqueue_mutation(first, text(self.anchor, "append")?, list)
            }
            "enqueueMutation" => self.enqueue_mutation(first, second, args.element(2)?),
            "nextMutationStep" => self.next_mutation_step(first),
            "completeMutationStep" => self.complete_mutation_step(
                first,
                second,
                args.element(2)?,
                args.element(3)?,
                args.element(4)?,
            ),
            "hasPendingMutations" => self.has_pending_mutations(),
            "resendPendingWrite" => self.resend_pending_write(first),
            "pendingMutationSessions" => self.pending_mutation_sessions(),
            "registerSession" => self.register_session(first),
            "canDeleteSession" => self.can_delete_session(first),
            "deletionVerdict" => self.deletion_verdict(first),
            "invalidateVisibility" => {
                self.invalidate(first)?;
                self.undefined()
            }
            "load" => self.load(first),
            "viewHistory" => self.view_history(first),
            "latestAssistantAt" => self.latest_assistant_at(first),
            "latestAssistantConclusion" => self.latest_assistant_conclusion(first, second),
            "projectedMessages" => self.projected_messages(first, second.truthy()?),
            "paginate" => {
                let options = if second.undefined()? {
                    object(self.anchor, &[])?
                } else {
                    second
                };
                self.paginate(first, options)
            }
            "lastActivity" => self.last_activity(first, second),
            "scheduleIncrementalSave" => self.schedule_incremental_save(first, second),
            "clearIncrementalSave" => self.clear_incremental_save(first),
            "clearAllIncrementalSaves" => self.clear_all_incremental_saves(),
            "hasIncrementalSave" => self.has_incremental_save(first),
            "stop" => self.stop(),
            "handleCommittedHistoryEvent" => self.handle_event(first),
            "postPersistError" => {
                let error = first;
                let event = second;
                let session = if event.truthy()? {
                    event.get(c"sessionId")?
                } else {
                    self.undefined()?
                };
                self.log_failure("chat_history_post_persist_failed", error, Some(session))?;
                self.undefined()
            }
            "logFailure" => {
                let name = first.coerce_string()?.to_string_lossy();
                self.log_failure(&name, second, Some(args.element(2)?))?;
                self.undefined()
            }
            "runPeriodicReview" => {
                if self.owner.stopped.get() {
                    return self.undefined();
                }
                match self.port(c"maybeSchedulePeriodicMemoryReview", &[first]) {
                    Ok(_) => {}
                    Err(error) => {
                        let value = caught(self.anchor, error)?;
                        self.log_failure(
                            "chat_history_memory_review_schedule_failed",
                            value,
                            Some(first),
                        )?;
                    }
                }
                self.undefined()
            }
            "incrementalSaveTick" => {
                self.incremental_save_tick(first, second, args.element(2)?, args.element(3)?)
            }
            "distillFailed" => {
                self.log_failure("chat_history_memory_distill_failed", second, Some(first))?;
                self.undefined()
            }
            "lastActivityCommit" => {
                if first.truthy()? {
                    first.assign(c"lastActivity", second)?;
                }
                self.undefined()
            }
            _ => Err(Error::from_reason("unknown chat history runtime operation")),
        }
    }
}

#[napi]
impl RustChatHistoryRuntime {
    #[napi(constructor)]
    pub fn new(env: Env, anchor: Unknown<'_>) -> Result<Self> {
        let anchor = L::new(&env, anchor);
        let values = Values::new(anchor)?;
        let ports = anchor.get(c"ports")?;
        let page_size = positive_integer(ports.get(c"historyPageSize")?, DEFAULT_PAGE_SIZE)?;
        let distill_batch = positive_integer(
            ports.get(c"memoryDistillBatch")?,
            DEFAULT_MEMORY_DISTILL_BATCH,
        )?;
        let save_delay = match ports.get(c"incrementalSaveDelayMs")?.number_value()? {
            Some(value) if value.is_finite() && value >= 0.0 => value,
            _ => DEFAULT_INCREMENTAL_SAVE_DELAY_MS,
        };
        Ok(Self {
            values,
            visibility: RefCell::default(),
            dropped: RefCell::default(),
            timers: RefCell::default(),
            mutations: RefCell::default(),
            next_mutation_id: Cell::new(0),
            generations: RefCell::default(),
            epochs: RefCell::default(),
            deleting: RefCell::default(),
            removed: RefCell::default(),
            page_size,
            distill_batch,
            save_delay,
            stopped: Cell::new(false),
        })
    }
    #[napi]
    pub fn run(
        &self,
        env: Env,
        anchor: Unknown<'_>,
        action: String,
        args: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let anchor = L::new(&env, anchor);
        self.values.drain(&env)?;
        let host = Runtime {
            owner: self,
            env: &env,
            anchor,
            ports: anchor.get(c"ports")?,
        };
        let result = host.run(&action, L::new(&env, args))?;
        self.values.drain(&env)?;
        Ok(result.raw())
    }
}
