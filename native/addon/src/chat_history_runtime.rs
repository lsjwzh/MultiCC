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
    collections::HashMap,
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
    page_size: f64,
    distill_batch: f64,
    save_delay: f64,
    stopped: Cell<bool>,
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
    fn hide(&self, session: L<'a>, ids: L<'a>) -> Result<()> {
        let cache_key = key(session)?;
        let current = self.hidden(session)?;
        let next = set_of(self.anchor, self.anchor.from_value(&J::Array(vec![]))?)?;
        let add = next.get(c"add")?;
        current.for_each(|value| add.call(next, &[value]).map(|_| ()))?;
        ids.for_each(|value| add.call(next, &[value]).map(|_| ()))?;
        let history = self.ports.get(c"history")?;
        let write = history.get(c"writeVisibility")?;
        if write.kind()? != sys::ValueType::napi_function {
            return Err(self
                .anchor
                .type_error("history.writeVisibility is required"));
        }
        let session_text = string(session)?;
        self.service("ensurePersistedIds", &[session_text])?;
        let hidden_ids = array(self.anchor)?;
        next.for_each(|value| push(hidden_ids, value))?;
        let state = object(
            self.anchor,
            &[
                (c"version", number(self.anchor, 1.0)?),
                (c"hiddenIds", hidden_ids),
            ],
        )?;
        write.call(history, &[session_text, state])?;
        let captured = self.capture(next)?;
        self.owner
            .visibility
            .borrow_mut()
            .insert(cache_key, captured);
        Ok(())
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
    fn clear_visibility(&self, session: L<'a>, keep: L<'a>) -> Result<L<'a>> {
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
        self.hide(session, ids)?;
        // Legacy counted the whole visible view here, interim tail included;
        // only the completed prefix is ever removed.
        let retained_count = length(visible)? as f64 - removed_count as f64;
        object(
            self.anchor,
            &[
                (c"keep", keep),
                (c"removedCount", number(self.anchor, removed_count as f64)?),
                (c"retainedCount", number(self.anchor, retained_count)?),
            ],
        )
    }
    fn remove_visibility(&self, session: L<'a>, message_id: L<'a>) -> Result<L<'a>> {
        let view = self.service("view", &[session])?;
        for index in 0..length(view)? {
            if view.element(index as u32)?.get(c"id")?.equals(message_id)? {
                let ids = array(self.anchor)?;
                push(ids, message_id)?;
                self.hide(session, ids)?;
                return boolean(self.anchor, true);
            }
        }
        boolean(self.anchor, false)
    }
    fn remove_many(&self, session: L<'a>, ids: L<'a>) -> Result<L<'a>> {
        let view = self.service("view", &[session])?;
        let known = set_of(self.anchor, self.anchor.from_value(&J::Array(vec![]))?)?;
        let add = known.get(c"add")?;
        for index in 0..length(view)? {
            add.call(known, &[view.element(index as u32)?.get(c"id")?])?;
        }
        let already = self.hidden(session)?;
        let unique = set_of(self.anchor, ids)?;
        let fresh = array(self.anchor)?;
        unique.for_each(|id| {
            if known.get(c"has")?.call(known, &[id])?.truthy()?
                && !already.get(c"has")?.call(already, &[id])?.truthy()?
            {
                push(fresh, id)?;
            }
            Ok(())
        })?;
        if length(fresh)? > 0 {
            self.hide(session, fresh)?;
        }
        Ok(fresh)
    }
    fn hide_messages(&self, session: L<'a>, ids: L<'a>, quiet: bool) -> Result<L<'a>> {
        let session_text = string(session)?;
        if quiet {
            let filtered = array(self.anchor)?;
            if ids.is_array()? {
                for index in 0..length(ids)? {
                    let id = ids.element(index as u32)?;
                    if id.kind()? == sys::ValueType::napi_string && id.truthy()? {
                        push(filtered, id)?;
                    }
                }
            }
            let fresh = self.remove_many(session_text, filtered)?;
            return number(self.anchor, length(fresh)? as f64);
        }
        let list = if ids.is_array()? {
            ids
        } else {
            array(self.anchor)?
        };
        let mut hidden = 0usize;
        for index in 0..length(list)? {
            let id = list.element(index as u32)?;
            if id.kind()? != sys::ValueType::napi_string || !id.truthy()? {
                continue;
            }
            match self.remove_visibility(session_text, id) {
                Ok(removed) => {
                    if !removed.truthy()? {
                        continue;
                    }
                }
                Err(error) => {
                    let value = caught(self.anchor, error)?;
                    self.log_failure("chat_history_hide_failed", value, Some(session_text))?;
                    continue;
                }
            }
            hidden += 1;
            let payload = object(
                self.anchor,
                &[
                    (c"type", text(self.anchor, "chat_msg_deleted")?),
                    (c"id", id),
                    (c"displayOnly", boolean(self.anchor, true)?),
                ],
            )?;
            if let Err(error) = self.port(c"chatBroadcast", &[session_text, payload]) {
                let value = caught(self.anchor, error)?;
                self.log_failure("chat_history_hide_failed", value, Some(session_text))?;
            }
        }
        number(self.anchor, hidden as f64)
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
    fn annotate_turn(
        &self,
        session: L<'a>,
        turn_id: L<'a>,
        patch: L<'a>,
        options: L<'a>,
    ) -> Result<L<'a>> {
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
            return array(self.anchor);
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
        let outcome = (|| -> Result<()> {
            self.service(
                "replace",
                &[
                    session,
                    next,
                    object(
                        self.anchor,
                        &[(c"reason", text(self.anchor, "aux-task-attribution")?)],
                    )?,
                ],
            )?;
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
            self.port(c"chatBroadcast", &[string(session)?, payload])?;
            Ok(())
        })();
        match outcome {
            Ok(()) => Ok(changed),
            Err(error) => {
                let value = caught(self.anchor, error)?;
                self.log_failure("chat_history_annotation_failed", value, Some(session))?;
                array(self.anchor)
            }
        }
    }

    // ── 增量保存定时器 ────────────────────────────────────────────────────
    fn schedule_incremental_save(&self, session: L<'a>, state: L<'a>) -> Result<L<'a>> {
        let cache_key = key(session)?;
        if self.owner.stopped.get() || self.timer_position(&cache_key).is_some() {
            return boolean(self.anchor, false);
        }
        let session_text = string(session)?;
        let tick = self.bind(
            self.ports.get(c"runIncrementalSave")?,
            &[session_text, state],
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
    fn incremental_save_tick(&self, session: L<'a>, state: L<'a>) -> Result<()> {
        let cache_key = key(session)?;
        self.timer_remove(&cache_key);
        if self.owner.stopped.get() || !state.truthy()? {
            return Ok(());
        }
        let body = state.get(c"currentAssistantText")?;
        if !body.truthy()? {
            return Ok(());
        }
        if let Some(size) = body.get(c"length")?.number_value()? {
            if size < 20.0 {
                return Ok(());
            }
        }
        let raw_tools = state.get(c"currentToolCalls")?;
        let tool_count = if raw_tools.is_array()? {
            length(raw_tools)?
        } else {
            0
        };
        let session_text = string(session)?;
        // 旧实现把 interim 的构造、任务码标注和 upsert 一起放进 try，任一环节
        // 抛错都记一条 `chat_history_interim_save_failed` 并吞掉；这里保持同样
        // 的边界（早退条件仍在 try 之外）。
        let outcome = (|| -> Result<()> {
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
            self.service("upsertInterim", &[session_text, interim])?;
            Ok(())
        })();
        if let Err(error) = outcome {
            let value = caught(self.anchor, error)?;
            self.log_failure(
                "chat_history_interim_save_failed",
                value,
                Some(session_text),
            )?;
        }
        Ok(())
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
                self.annotate_turn(first, second, patch, options)
            }
            "clearVisibility" => self.clear_visibility(first, second),
            "hideMessages" => {
                let options = args.element(2)?;
                let quiet = if options.truthy()? {
                    options.get(c"quiet")?.truthy()?
                } else {
                    false
                };
                self.hide_messages(first, second, quiet)
            }
            "removeVisibility" => self.remove_visibility(first, second),
            "invalidateVisibility" => {
                self.invalidate(first)?;
                self.undefined()
            }
            "load" => self.load(first),
            "viewHistory" => self.view_history(first),
            "latestAssistantAt" => self.latest_assistant_at(first),
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
                self.incremental_save_tick(first, second)?;
                self.undefined()
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
