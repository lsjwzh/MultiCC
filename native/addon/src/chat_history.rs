//! 聊天历史服务的唯一缓存和事务所有者。宿主只提供文件端口、时钟和回调。
//! 消息保持引擎对象身份；跨端口调用前释放 RefCell 借用，允许同步重入。
use crate::chat_events::assistant_same_query as same_query;
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
    collections::{HashMap, HashSet},
    ffi::CStr,
};

fn object<'a>(a: L<'a>, fields: &[(&CStr, L<'a>)]) -> Result<L<'a>> {
    let out = a.from_value(&J::Object(vec![]))?;
    for (key, value) in fields {
        out.set(key, *value)?;
    }
    Ok(out)
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
fn array(a: L<'_>) -> Result<L<'_>> {
    a.from_value(&J::Array(vec![]))
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
fn slice(value: L<'_>) -> Result<L<'_>> {
    method(value, c"slice", &[])
}
fn last(value: L<'_>) -> Result<L<'_>> {
    method(value, c"at", &[number(value, -1.0)?])
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
fn stringify(value: L<'_>) -> Result<L<'_>> {
    method(value.global()?.get(c"JSON")?, c"stringify", &[value])
}
fn fallback<'a>(value: L<'a>, other: L<'a>) -> Result<L<'a>> {
    Ok(if value.truthy()? { value } else { other })
}
fn freeze_event(value: L<'_>) -> Result<L<'_>> {
    if !value.truthy()? || value.kind()? != sys::ValueType::napi_object {
        return Ok(value);
    }
    let obj = value.global()?.get(c"Object")?;
    if method(obj, c"isFrozen", &[value])?.truthy()? {
        return Ok(value);
    }
    method(obj, c"values", &[value])?.for_each(|child| {
        freeze_event(child)?;
        Ok(())
    })?;
    value.freeze()
}
fn caught<'a>(a: L<'a>, error: Error) -> Result<L<'a>> {
    if let Some(value) = a.exception_value()? {
        return Ok(value);
    }
    a.global()?
        .get(c"Error")?
        .construct(&[text(a, &error.reason)?])
}
fn same_tools(left: L<'_>, right: L<'_>) -> Result<bool> {
    let null = left.from_value(&J::Null)?;
    stringify(fallback(left.get(c"tools")?, null)?)?
        .equals(stringify(fallback(right.get(c"tools")?, null)?)?)
}
fn same_payload(left: L<'_>, right: L<'_>) -> Result<bool> {
    Ok(left.truthy()?
        && right.truthy()?
        && left.get(c"role")?.is_string("assistant")?
        && right.get(c"role")?.is_string("assistant")?
        && same_query(left, right)?
        && left.get(c"content")?.equals(right.get(c"content")?)?
        && same_tools(left, right)?)
}
fn is_nudge(value: L<'_>) -> Result<bool> {
    if !value.truthy()? || !value.get(c"role")?.is_string("user")? {
        return Ok(false);
    }
    let content = value.get(c"content")?;
    Ok(content.kind()? == sys::ValueType::napi_string
        && method(
            method(content, c"trimStart", &[])?,
            c"startsWith",
            &[text(value, "🔇")?],
        )?
        .truthy()?)
}
fn contains(left: L<'_>, right: L<'_>) -> Result<bool> {
    if !left.truthy()?
        || !right.truthy()?
        || !left.get(c"role")?.is_string("assistant")?
        || !right.get(c"role")?.is_string("assistant")?
        || left.get(c"_interim")?.truthy()?
        || right.get(c"_interim")?.truthy()?
        || !same_query(left, right)?
        || !same_tools(left, right)?
    {
        return Ok(false);
    }
    let left = left.get(c"content")?;
    let right = right.get(c"content")?;
    if left.equals(right)? {
        return Ok(true);
    }
    let types = (left.kind()?, right.kind()?);
    let (left, right) = if types == (sys::ValueType::napi_string, sys::ValueType::napi_string) {
        (left, right)
    } else if matches!(
        types.0,
        sys::ValueType::napi_object | sys::ValueType::napi_null
    ) && matches!(
        types.1,
        sys::ValueType::napi_object | sys::ValueType::napi_null
    ) {
        let pair = (stringify(left)?, stringify(right)?);
        if pair.0.equals(pair.1)? {
            return Ok(true);
        }
        pair
    } else {
        return Ok(false);
    };
    Ok(length(left)? >= 16 && method(right, c"startsWith", &[left])?.truthy()?)
}
fn previous_assistant(messages: L<'_>) -> Result<Option<(usize, L<'_>)>> {
    for i in (0..length(messages)?).rev() {
        let entry = messages.element(i as u32)?;
        if is_nudge(entry)? {
            continue;
        }
        let assistant = entry.get(c"role")?.is_string("assistant")?;
        let interim = if assistant {
            entry.get(c"_interim")?.truthy()?
        } else {
            false
        };
        if assistant && interim {
            continue;
        }
        if entry.get(c"role")?.is_string("user")? && !is_nudge(entry)? {
            return Ok(None);
        }
        if assistant && !interim {
            return Ok(Some((i, entry)));
        }
    }
    Ok(None)
}
fn clean_thinking<'a>(env: &'a Env, value: L<'a>) -> Result<L<'a>> {
    if !value.truthy()? || !value.get(c"content")?.is_array()? {
        return Ok(value);
    }
    let filter =
        env.create_function_from_closure::<Unknown<'_>, bool, _>("keepThinking", |ctx| {
            let block = L::new(ctx.env, ctx.get::<Unknown<'_>>(0)?);
            if !block.truthy()? || !block.get(c"type")?.is_string("thinking")? {
                return Ok(true);
            }
            let thinking = block.get(c"thinking")?;
            if !thinking.truthy()? {
                return Ok(false);
            }
            // RegExp.test 的隐式字符串转换与 String(Symbol) 不同。
            let pattern = block
                .global()?
                .get(c"RegExp")?
                .construct(&[text(block, "\\S")?])?;
            method(pattern, c"test", &[thinking])?.truthy()
        })?;
    value.assign(
        c"content",
        method(
            value.get(c"content")?,
            c"filter",
            &[L::new(env, filter.into_unknown(env)?)],
        )?,
    )?;
    Ok(value)
}
fn drop_thinking_copies(value: L<'_>) -> Result<L<'_>> {
    if !value.truthy()? || !value.get(c"tools")?.is_array()? {
        return Ok(value);
    }
    value.get(c"tools")?.for_each(|tool| {
        if tool.truthy()?
            && tool.get(c"name")?.is_string("Thinking")?
            && tool.get(c"result")?.kind()? == sys::ValueType::napi_string
            && tool.get(c"input")?.truthy()?
            && tool
                .get(c"result")?
                .equals(tool.get(c"input")?.get(c"text")?)?
        {
            tool.delete(c"result")?;
        }
        Ok(())
    })?;
    Ok(value)
}

#[derive(Clone)]
struct PendingAppend {
    session: Value,
    messages: Value,
    event: Value,
    after: Value,
    /// 队首写步骤与已提交数组的共享前缀（store_pending 时由恒等比较得出）；
    /// None 表示该笔需要整份重写。
    base: Option<PendingBase>,
}
#[derive(Clone, Copy)]
struct PendingBase {
    keep: usize,
    keep_bytes: u64,
}
/// 已提交转写的字节账本：消息条数、文件总字节、最后 64 行的绝对行尾偏移。
/// 只由 commit_append（写盘确认后）更新；任何旁路写/失效都把它清掉，
/// 下一次写退化为整份重写后自愈。
#[derive(Clone)]
struct CommittedState {
    len: usize,
    bytes: u64,
    ends: Vec<u64>,
}
/// 尾部增量账本窗口：截断重写永远发生在末尾的 interim/dedup 区。
const COMMITTED_TAIL_WINDOW: usize = 64;
#[napi]
pub struct RustChatHistory {
    values: Values,
    cache: RefCell<HashMap<JsString, Value>>,
    missing_ids: RefCell<HashSet<JsString>>,
    pending_appends: RefCell<HashMap<u64, PendingAppend>>,
    committed: RefCell<HashMap<JsString, CommittedState>>,
    next_append_id: Cell<u64>,
}
struct History<'a> {
    owner: &'a RustChatHistory,
    env: &'a Env,
    anchor: L<'a>,
    ports: L<'a>,
}
impl<'a> History<'a> {
    fn port(&self, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
        self.ports.get(name)?.call_plain(args)
    }
    fn repository(&self, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
        method(self.ports.get(c"history")?, name, args)
    }
    fn set_cache(&self, key: JsString, messages: L<'a>) -> Result<()> {
        let stored = self.owner.values.capture(self.env, messages)?;
        self.owner.cache.borrow_mut().insert(key, stored);
        Ok(())
    }
    fn protect(&self, session: L<'a>, message: L<'a>) -> Result<bool> {
        self.port(c"isMessageProtected", &[string(session)?, message])?
            .truthy()
    }
    fn normalize(&self, source: L<'a>, session: L<'a>) -> Result<L<'a>> {
        self.normalize_with_ownership(source, session, false)
    }
    fn normalize_with_ownership(
        &self,
        source: L<'a>,
        session: L<'a>,
        owned: bool,
    ) -> Result<L<'a>> {
        let out = array(self.anchor)?;
        if !source.is_array()? {
            return Ok(out);
        }
        // 先过滤后克隆，保持旧 filter().for-of 的观察顺序。
        let filter = self
            .env
            .create_function_from_closure::<Unknown<'_>, bool, _>("historyObjects", |ctx| {
                let value = L::new(ctx.env, ctx.get::<Unknown<'_>>(0)?);
                Ok(value.truthy()? && value.kind()? == sys::ValueType::napi_object)
            })?;
        let selected = method(
            source,
            c"filter",
            &[L::new(self.env, filter.into_unknown(self.env)?)],
        )?;
        selected.for_each(|entry| {
            // Repository-owned reads are fresh JSON objects that have not been
            // exposed to any other caller. Normalizing those in place avoids a
            // second full object graph; generic ports and replace inputs keep
            // the old isolated-clone contract.
            let message = if owned { entry } else { clone_json(entry)? };
            let message = drop_thinking_copies(clean_thinking(self.env, message)?)?;
            if message.get(c"role")?.truthy()? && !message.get(c"id")?.truthy()? {
                message.assign(c"id", string(self.port(c"idFactory", &[])?)?)?;
            }
            if message.get(c"role")?.is_string("assistant")?
                && !message.get(c"_interim")?.truthy()?
            {
                self.pop_interims(out)?;
                if let Some((index, prev)) = previous_assistant(out)? {
                    if !prev.get(c"_handoffArchive")?.truthy()?
                        && contains(prev, message)?
                        && !self.protect(session, prev)?
                    {
                        method(
                            out,
                            c"splice",
                            &[number(out, index as f64)?, number(out, 1.0)?],
                        )?;
                    }
                }
            } else if message.get(c"role")?.is_string("assistant")?
                && message.get(c"_interim")?.truthy()?
            {
                let previous = last(out)?;
                if previous.optional(c"role")?.is_string("assistant")? {
                    if previous.get(c"_interim")?.truthy()? {
                        message
                            .assign(c"id", fallback(previous.get(c"id")?, message.get(c"id")?)?)?;
                        out.set_element((length(out)? - 1) as u32, message)?;
                        return Ok(());
                    }
                    if same_payload(previous, message)? {
                        return Ok(());
                    }
                }
            }
            push(out, message)
        })?;
        Ok(out)
    }
    fn pop_interims(&self, messages: L<'a>) -> Result<()> {
        while length(messages)? > 0 {
            let item = last(messages)?;
            if !item.get(c"role")?.is_string("assistant")? || !item.get(c"_interim")?.truthy()? {
                break;
            }
            method(messages, c"pop", &[])?;
        }
        Ok(())
    }
    fn current(&self, session: L<'a>) -> Result<L<'a>> {
        let session = string(session)?;
        let id = key(session)?;
        let cached = self.owner.cache.borrow().get(&id).cloned();
        if let Some(value) = cached {
            return self.owner.values.read(self.env, self.anchor, &value);
        }
        let history = self.ports.get(c"history")?;
        let read_owned = history.get(c"readOwned")?;
        let owned = read_owned.kind()? == sys::ValueType::napi_function;
        let source = if owned {
            read_owned.call(history, &[session])?
        } else {
            self.repository(c"read", &[session])?
        };
        if source.is_array()? {
            for i in 0..length(source)? {
                let message = source.element(i as u32)?;
                if message.optional(c"role")?.truthy()? && !message.get(c"id")?.truthy()? {
                    self.owner.missing_ids.borrow_mut().insert(id.clone());
                    break;
                }
            }
        }
        let normalized = self.normalize_with_ownership(source, session, owned)?;
        self.set_cache(id, normalized)?;
        Ok(normalized)
    }
    fn emit(&self, event: L<'a>, after: L<'a>) -> Result<()> {
        let committed = freeze_event(clone_json(event)?)?;
        for callback in [self.ports.get(c"postPersist")?, after] {
            if callback.kind()? != sys::ValueType::napi_function {
                continue;
            }
            if let Err(error) = callback.call_plain(&[committed]) {
                let error = caught(self.anchor, error)?;
                self.anchor
                    .catch(|| self.port(c"onPostPersistError", &[error, committed]))?;
            }
        }
        Ok(())
    }
    fn persist(&self, session: L<'a>, messages: L<'a>, event: L<'a>, after: L<'a>) -> Result<()> {
        let session = string(session)?;
        let id = key(session)?;
        let snapshot = slice(messages)?;
        self.repository(c"write", &[session, snapshot])?;
        self.owner.missing_ids.borrow_mut().remove(&id);
        // 同步写不产字节回执：账本失效，下一笔异步写整份重写后重建。
        self.owner.committed.borrow_mut().remove(&id);
        self.set_cache(id, snapshot)?;
        let payload = object(self.anchor, &[(c"sessionId", session)])?;
        payload.spread_from(event)?;
        self.emit(payload, after)
    }
    fn lazy(&self, fields: &[(&CStr, L<'a>)], messages: L<'a>) -> Result<L<'a>> {
        self.port(
            c"withLazyMessages",
            &[object(self.anchor, fields)?, messages],
        )
    }
    fn referenced_error(&self, session: L<'a>, message: &str) -> Result<Error> {
        let error = self
            .anchor
            .global()?
            .get(c"Error")?
            .construct(&[text(self.anchor, message)?])?;
        error.set(c"code", text(self.anchor, "TASK_HISTORY_REFERENCED")?)?;
        let mut tasks = array(self.anchor)?;
        let enrich = self.anchor.catch(|| -> Result<L<'a>> {
            let resolved = self.port(c"referencingTasks", &[string(session)?])?;
            if resolved.is_array()? {
                method(
                    resolved,
                    c"filter",
                    &[self.anchor.global()?.get(c"Boolean")?],
                )
            } else {
                array(self.anchor)
            }
        })?;
        if let Some(resolved) = enrich {
            tasks = resolved;
        }
        error.set(c"tasks", tasks)?;
        let ids = array(self.anchor)?;
        for i in 0..length(tasks)? {
            let id = tasks.element(i as u32)?.get(c"id")?;
            if id.truthy()? {
                push(ids, id)?;
            }
        }
        error.set(c"taskIds", ids)?;
        Ok(error.throw_error())
    }
    fn assert_delete(&self, session: L<'a>) -> Result<()> {
        let session = string(session)?;
        let can_delete = self.ports.get(c"canDeleteSession")?;
        let mut refused = false;
        if can_delete.truthy()? {
            refused = !can_delete.call_plain(&[session])?.truthy()?;
        } else {
            let messages = self.current(session)?;
            for i in 0..length(messages)? {
                if self.protect(session, messages.element(i as u32)?)? {
                    refused = true;
                    break;
                }
            }
        }
        if refused {
            return Err(self.referenced_error(
                session,
                "task-linked history must be retained with its task archive",
            )?);
        }
        Ok(())
    }
    fn append_values(&self, session: L<'a>, value: L<'a>) -> Result<(L<'a>, L<'a>, L<'a>)> {
        if !value.truthy()? || value.kind()? != sys::ValueType::napi_object {
            return Err(value.type_error("[session] chat message must be an object"));
        }
        let messages = slice(self.current(session)?)?;
        let message = clean_thinking(self.env, clone_json(value)?)?;
        if !message.get(c"id")?.truthy()? {
            message.assign(c"id", string(self.port(c"idFactory", &[])?)?)?;
        }
        self.timestamp(message)?;
        let final_assistant =
            message.get(c"role")?.is_string("assistant")? && !message.get(c"_interim")?.truthy()?;
        if final_assistant {
            self.pop_interims(messages)?;
        }
        let mut dedup = false;
        let dropped = array(self.anchor)?;
        if final_assistant && length(messages)? > 0 {
            if let Some((index, prev)) = previous_assistant(messages)? {
                if contains(prev, message)? && !self.protect(session, prev)? {
                    method(
                        messages,
                        c"splice",
                        &[number(messages, index as f64)?, number(messages, 1.0)?],
                    )?;
                    push(dropped, clone_json(prev)?)?;
                    dropped.freeze()?;
                    dedup = true;
                }
            }
        }
        push(messages, message)?;
        let result = self.lazy(
            &[
                (c"deduplicated", boolean(message, dedup)?),
                (c"dropped", dropped),
                (c"message", clone_json(message)?),
            ],
            messages,
        )?;
        let event = object(
            message,
            &[
                (c"type", text(message, "append")?),
                (c"deduplicated", boolean(message, dedup)?),
                (c"dropped", result.get(c"dropped")?),
                (c"message", result.get(c"message")?),
            ],
        )?;
        Ok((messages, result, event))
    }
    fn append(&self, session: L<'a>, value: L<'a>, after: L<'a>) -> Result<L<'a>> {
        let (messages, result, event) = self.append_values(session, value)?;
        self.persist(session, messages, event, after)?;
        Ok(result)
    }
    /// 与已提交数组做恒等前缀比较，只把尾巴留给写步骤序列化。
    /// 返回 (尾部 JSON 数组文本, base, expected_bytes)；账本缺失、窗口覆盖
    /// 不到截断点、或没有尾巴时都返回 None（调用方退化为整份快照）。
    fn tail_plan(
        &self,
        session_key: &JsString,
        messages: L<'a>,
    ) -> Result<Option<(L<'a>, PendingBase, u64)>> {
        let state = self.owner.committed.borrow().get(session_key).cloned();
        let Some(state) = state else {
            return Ok(None);
        };
        let cached = self.owner.cache.borrow().get(session_key).cloned();
        let Some(cached) = cached else {
            return Ok(None);
        };
        let committed = self.owner.values.read(self.env, self.anchor, &cached)?;
        let committed_len = length(committed)?;
        if committed_len != state.len || state.ends.len() > state.len {
            return Ok(None);
        }
        let total = length(messages)?;
        let mut keep = 0usize;
        let limit = committed_len.min(total);
        while keep < limit
            && committed
                .element(keep as u32)?
                .equals(messages.element(keep as u32)?)?
        {
            keep += 1;
        }
        if keep == total {
            return Ok(None);
        }
        // 第 keep 行（0-indexed）的起始字节：keep=0 是整份重写，其余必须在
        // 账本窗口内，否则字节偏移无从谈起。
        let keep_bytes = if keep == 0 {
            0
        } else {
            let start = state.len - state.ends.len();
            if keep > state.len || keep - 1 < start {
                return Ok(None);
            }
            state.ends[keep - 1 - start]
        };
        let tail = array(self.anchor)?;
        for index in keep..total {
            push(tail, messages.element(index as u32)?)?;
        }
        let tail_json = stringify(tail)?
            .string()?
            .ok_or_else(|| Error::from_reason("history tail serialization is not a string"))?
            .to_string_lossy();
        Ok(Some((
            text(self.anchor, &tail_json)?,
            PendingBase { keep, keep_bytes },
            state.bytes,
        )))
    }
    fn store_pending(
        &self,
        session: L<'a>,
        messages: L<'a>,
        event: L<'a>,
        after: L<'a>,
    ) -> Result<L<'a>> {
        let session = string(session)?;
        let session_key = key(session)?;
        let tail = self.tail_plan(&session_key, messages)?;
        let (write_payload, base) = match &tail {
            Some((tail_json, base, expected_bytes)) => (
                object(
                    self.anchor,
                    &[
                        (c"tail", *tail_json),
                        (c"keepBytes", number(self.anchor, base.keep_bytes as f64)?),
                        (
                            c"expectedBytes",
                            number(self.anchor, *expected_bytes as f64)?,
                        ),
                        (c"keepLines", number(self.anchor, base.keep as f64)?),
                    ],
                )?,
                Some(*base),
            ),
            None => (
                text(
                    self.anchor,
                    &stringify(messages)?
                        .string()?
                        .ok_or_else(|| {
                            Error::from_reason("history snapshot serialization is not a string")
                        })?
                        .to_string_lossy(),
                )?,
                None,
            ),
        };
        let payload = object(self.anchor, &[(c"sessionId", session)])?;
        payload.spread_from(event)?;
        let event = payload;
        let next = self
            .owner
            .next_append_id
            .get()
            .checked_add(1)
            .ok_or_else(|| Error::from_reason("prepared history append identifiers exhausted"))?;
        self.owner.next_append_id.set(next);
        self.owner.pending_appends.borrow_mut().insert(
            next,
            PendingAppend {
                session: self.owner.values.capture(self.env, session)?,
                messages: self.owner.values.capture(self.env, messages)?,
                event: self.owner.values.capture(self.env, event)?,
                after: self.owner.values.capture(self.env, after)?,
                base,
            },
        );
        object(
            self.anchor,
            &[
                (c"operationId", number(self.anchor, next as f64)?),
                (c"payload", write_payload),
            ],
        )
    }
    fn prepare_append(&self, session: L<'a>, value: L<'a>, after: L<'a>) -> Result<L<'a>> {
        let (messages, _result, event) = self.append_values(session, value)?;
        self.store_pending(session, messages, event, after)
    }
    /// `ensurePersistedIds` split: the caller writes `messagesJson` durably and
    /// then commits, so the write keeps the queue's order.
    fn prepare_persist(&self, session: L<'a>) -> Result<L<'a>> {
        let id = key(session)?;
        if !self.owner.missing_ids.borrow().contains(&id) {
            return object(self.anchor, &[(c"write", boolean(self.anchor, false)?)]);
        }
        let messages = self.current(session)?;
        let undefined = self.anchor.from_value(&J::Undefined)?;
        let prepared = self.store_pending(session, messages, undefined, undefined)?;
        prepared.set(c"write", boolean(self.anchor, true)?)?;
        Ok(prepared)
    }
    fn prepare_interim(&self, session: L<'a>, value: L<'a>, after: L<'a>) -> Result<L<'a>> {
        let (messages, result, event) = self.interim_values(session, value)?;
        let Some(event) = event else {
            return object(
                self.anchor,
                &[
                    (c"write", boolean(self.anchor, false)?),
                    (c"result", result),
                ],
            );
        };
        let prepared = self.store_pending(session, messages, event, after)?;
        prepared.set(c"write", boolean(self.anchor, true)?)?;
        prepared.set(c"result", result)?;
        Ok(prepared)
    }
    fn prepare_replace(
        &self,
        session: L<'a>,
        values: L<'a>,
        after: L<'a>,
        reason: L<'a>,
    ) -> Result<L<'a>> {
        let (messages, result, event) = self.replace_values(session, values, reason)?;
        let prepared = self.store_pending(session, messages, event, after)?;
        prepared.set(c"result", result)?;
        Ok(prepared)
    }
    /// 写盘确认后登记字节账本：base 前缀行的旧偏移 + 新行偏移合并，窗口之外
    /// 的丢弃。meta 缺失/畸形时保守失效——下一次写退化为整份重写后自愈。
    fn record_committed(
        &self,
        session_key: &JsString,
        messages: L<'a>,
        base: Option<PendingBase>,
        meta: L<'a>,
    ) {
        let recorded = (|| -> Result<Option<CommittedState>> {
            if meta.kind()? != sys::ValueType::napi_object {
                return Ok(None);
            }
            let bytes = meta.optional(c"bytes")?.explicit_number()?;
            let ends_value = meta.optional(c"ends")?;
            if !(bytes.is_finite() && bytes >= 0.0) || !ends_value.is_array()? {
                return Ok(None);
            }
            let mut ends: Vec<u64> = Vec::new();
            for index in 0..length(ends_value)? {
                let end = ends_value.element(index as u32)?.number()?;
                if !(end.is_finite() && end >= 0.0) {
                    return Ok(None);
                }
                ends.push(end as u64);
            }
            let len = length(messages)?;
            // full=true（整份重写，含 needsFull 触发的整份重发）：回执的行尾
            // 覆盖全文，直接替换窗口。full=false（尾部增量）：回执只有新行的
            // 偏移，与旧窗口里 base 前缀行的偏移拼接，保住截断点历史。
            let full = meta.optional(c"full")?.truthy().unwrap_or(false);
            let mut merged = match base {
                Some(base) if !full => {
                    let mut kept: Vec<u64> = Vec::new();
                    let old = self.owner.committed.borrow().get(session_key).cloned();
                    if let Some(old) = old {
                        let start = old.len - old.ends.len();
                        for (index, end) in old.ends.iter().enumerate() {
                            if start + index < base.keep {
                                kept.push(*end);
                            }
                        }
                    }
                    kept.extend(ends);
                    kept
                }
                // 整份重写（或无 base 的整份写）：回执行尾覆盖全文，直接替换。
                _ => ends,
            };
            if merged.len() > COMMITTED_TAIL_WINDOW {
                merged.drain(..merged.len() - COMMITTED_TAIL_WINDOW);
            }
            // 窗口不可能比行数多；畸形回执宁可让账本失效，也不能留错位状态。
            if merged.len() > len {
                return Ok(None);
            }
            Ok(Some(CommittedState {
                len,
                bytes: bytes as u64,
                ends: merged,
            }))
        })();
        match recorded {
            Ok(Some(state)) => {
                self.owner
                    .committed
                    .borrow_mut()
                    .insert(session_key.clone(), state);
            }
            _ => {
                self.owner.committed.borrow_mut().remove(session_key);
            }
        }
    }
    fn commit_append(&self, operation_id: L<'a>, meta: L<'a>) -> Result<L<'a>> {
        let id = operation_id.number()? as u64;
        let pending = self.owner.pending_appends.borrow_mut().remove(&id);
        let Some(pending) = pending else {
            return boolean(self.anchor, false);
        };
        let prepared = (|| -> Result<(L<'a>, L<'a>, L<'a>, JsString)> {
            let session = self
                .owner
                .values
                .read(self.env, self.anchor, &pending.session)?;
            let messages = self
                .owner
                .values
                .read(self.env, self.anchor, &pending.messages)?;
            let event = self
                .owner
                .values
                .read(self.env, self.anchor, &pending.event)?;
            let after = self
                .owner
                .values
                .read(self.env, self.anchor, &pending.after)?;
            let session_key = key(session)?;
            Ok((messages, event, after, session_key))
        })();
        let (messages, event, after, session_key) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                self.owner.pending_appends.borrow_mut().insert(id, pending);
                return Err(error);
            }
        };
        self.owner.missing_ids.borrow_mut().remove(&session_key);
        if let Err(error) = self.set_cache(session_key.clone(), messages) {
            self.owner.pending_appends.borrow_mut().insert(id, pending);
            return Err(error);
        }
        self.record_committed(&session_key, messages, pending.base, meta);
        // The durable write and cache publication are already complete. A
        // notification adapter failure must not turn a committed append into a
        // false verdict that makes the caller write the same row again.
        let _ = self.emit(event, after);
        boolean(self.anchor, true)
    }
    /// needsFull 回退：尾部写的 expected_bytes 与文件对不上时，宿主拿整份
    /// 快照重写一次；pending 条目保持暂存，仍由 commitAppend/discardAppend 结清。
    fn resend_pending(&self, operation_id: L<'a>) -> Result<L<'a>> {
        let id = operation_id.number()? as u64;
        let pending = self.owner.pending_appends.borrow().get(&id).cloned();
        let Some(pending) = pending else {
            return Err(Error::from_reason("history append is no longer pending"));
        };
        let messages = self
            .owner
            .values
            .read(self.env, self.anchor, &pending.messages)?;
        let messages_json = stringify(messages)?
            .string()?
            .ok_or_else(|| Error::from_reason("history snapshot serialization is not a string"))?
            .to_string_lossy();
        object(
            self.anchor,
            &[(c"messagesJson", text(self.anchor, &messages_json)?)],
        )
    }
    fn discard_append(&self, operation_id: L<'a>) -> Result<()> {
        let id = operation_id.number()? as u64;
        self.owner.pending_appends.borrow_mut().remove(&id);
        Ok(())
    }
    fn timestamp(&self, message: L<'a>) -> Result<()> {
        if !message.get(c"ts")?.truthy()? {
            message.assign(
                c"ts",
                number(message, self.port(c"clock", &[])?.explicit_number()?)?,
            )?;
        }
        Ok(())
    }
    fn interim(&self, session: L<'a>, value: L<'a>, after: L<'a>) -> Result<L<'a>> {
        let (messages, result, event) = self.interim_values(session, value)?;
        let Some(event) = event else {
            return Ok(result);
        };
        self.persist(session, messages, event, after)?;
        Ok(result)
    }
    /// Interim computation without the durable write. `event` is `None` when the
    /// payload equals the last committed assistant message (nothing to save).
    fn interim_values(
        &self,
        session: L<'a>,
        value: L<'a>,
    ) -> Result<(L<'a>, L<'a>, Option<L<'a>>)> {
        if !value.truthy()? || value.kind()? != sys::ValueType::napi_object {
            return Err(value.type_error("[session] interim message must be an object"));
        }
        let messages = slice(self.current(session)?)?;
        let message = clean_thinking(self.env, clone_json(value)?)?;
        if !message.get(c"role")?.undefined()? && !message.get(c"role")?.is_string("assistant")? {
            return Err(value.type_error("[session] interim message must have assistant role"));
        }
        message.assign(c"role", text(message, "assistant")?)?;
        message.assign(c"_interim", boolean(message, true)?)?;
        let latest = last(messages)?;
        if latest.optional(c"role")?.is_string("assistant")?
            && !latest.get(c"_interim")?.truthy()?
            && same_payload(latest, message)?
        {
            let result = self.lazy(
                &[
                    (c"ignored", boolean(message, true)?),
                    (c"replaced", boolean(message, false)?),
                    (c"dropped", array(message)?.freeze()?),
                    (c"message", clone_json(latest)?),
                ],
                messages,
            )?;
            return Ok((messages, result, None));
        }
        let end = length(messages)?;
        let mut first = end;
        while first > 0 {
            let prev = messages.element((first - 1) as u32)?;
            if !prev.truthy()?
                || !prev.get(c"role")?.is_string("assistant")?
                || !prev.get(c"_interim")?.truthy()?
            {
                break;
            }
            first -= 1;
        }
        let replaced = first < end;
        let mut id = if replaced {
            messages.element(first as u32)?.get(c"id")?
        } else {
            self.anchor.from_value(&J::Null)?
        };
        if !id.truthy()? {
            id = message.get(c"id")?;
        }
        if !id.truthy()? {
            id = self.port(c"idFactory", &[])?;
        }
        message.assign(c"id", string(id)?)?;
        self.timestamp(message)?;
        if replaced {
            method(
                messages,
                c"splice",
                &[
                    number(messages, first as f64)?,
                    number(messages, (end - first) as f64)?,
                    message,
                ],
            )?;
        } else {
            push(messages, message)?;
        }
        let result = self.lazy(
            &[
                (c"replaced", boolean(message, replaced)?),
                (c"dropped", array(message)?),
                (c"message", clone_json(message)?),
            ],
            messages,
        )?;
        let event = object(
            message,
            &[
                (c"type", text(message, "interim")?),
                (c"replaced", boolean(message, replaced)?),
                (c"dropped", result.get(c"dropped")?),
                (c"message", result.get(c"message")?),
            ],
        )?;
        Ok((messages, result, Some(event)))
    }
    fn replace(&self, session: L<'a>, values: L<'a>, after: L<'a>, reason: L<'a>) -> Result<L<'a>> {
        let (messages, result, event) = self.replace_values(session, values, reason)?;
        self.persist(session, messages, event, after)?;
        Ok(result)
    }
    fn replace_values(
        &self,
        session: L<'a>,
        values: L<'a>,
        reason: L<'a>,
    ) -> Result<(L<'a>, L<'a>, L<'a>)> {
        let messages = self.normalize(values, session)?;
        let ids = self.anchor.global()?.get(c"Set")?.construct(&[])?;
        for i in 0..length(messages)? {
            method(ids, c"add", &[messages.element(i as u32)?.get(c"id")?])?;
        }
        let current = self.current(session)?;
        for i in 0..length(current)? {
            let message = current.element(i as u32)?;
            if !method(ids, c"has", &[message.get(c"id")?])?.truthy()?
                && !message.get(c"_interim")?.truthy()?
                && self.protect(session, message)?
            {
                return Err(self.referenced_error(session, "cannot remove task-linked messages")?);
            }
        }
        let result = self.lazy(&[(c"dropped", array(self.anchor)?)], messages)?;
        let reason = if reason.nullish()? {
            self.anchor.from_value(&J::Null)?
        } else {
            method(
                string(reason)?,
                c"slice",
                &[number(self.anchor, 0.0)?, number(self.anchor, 80.0)?],
            )?
        };
        let event = object(
            self.anchor,
            &[
                (c"type", text(self.anchor, "replace")?),
                (c"reason", reason),
                (c"dropped", result.get(c"dropped")?),
            ],
        )?;
        Ok((messages, result, event))
    }
    fn remove(&self, session: L<'a>, id: L<'a>, after: L<'a>) -> Result<L<'a>> {
        let messages = slice(self.current(session)?)?;
        for i in 0..length(messages)? {
            let message = messages.element(i as u32)?;
            if !message.get(c"id")?.equals(id)? {
                continue;
            }
            if self.protect(session, message)? {
                return Err(self.referenced_error(session, "cannot remove task-linked messages")?);
            }
            method(
                messages,
                c"splice",
                &[number(messages, i as f64)?, number(messages, 1.0)?],
            )?;
            let result = self.lazy(
                &[
                    (c"removed", boolean(message, true)?),
                    (c"message", clone_json(message)?),
                ],
                messages,
            )?;
            self.persist(
                session,
                messages,
                object(
                    message,
                    &[
                        (c"type", text(message, "remove")?),
                        (c"message", result.get(c"message")?),
                    ],
                )?,
                after,
            )?;
            return Ok(result);
        }
        self.lazy(&[(c"removed", boolean(self.anchor, false)?)], messages)
    }
    fn retention(&self, session: L<'a>) -> Result<f64> {
        if !self.ports.get(c"retentionPolicy")?.truthy()? {
            return self.ports.get(c"maxMessages")?.number();
        }
        let policy = self.port(c"retentionPolicy", &[string(session)?])?;
        let limit = if policy.truthy()? && policy.kind()? == sys::ValueType::napi_object {
            policy.get(c"maxMessages")?
        } else {
            policy
        };
        let n = limit.number_value()?.unwrap_or(f64::NAN);
        if !n.is_finite() || n < 1.0 || n > 9007199254740991.0 || n.fract() != 0.0 {
            return Err(limit.type_error(
                "[session] retentionPolicy must return a positive integer or { maxMessages }",
            ));
        }
        Ok(n)
    }
    fn paginate(&self, session: L<'a>, before: L<'a>, limit: L<'a>) -> Result<L<'a>> {
        let current = self.current(session)?;
        let messages = method(
            current,
            c"slice",
            &[number(current, -self.retention(session)?)?],
        )?;
        let parsed = self
            .anchor
            .global()?
            .get(c"parseInt")?
            .call_plain(&[limit, number(limit, 10.0)?])?
            .number()?;
        let size = if parsed.is_nan() || parsed == 0.0 {
            5.0
        } else {
            parsed
        }
        .clamp(1.0, 100.0) as usize;
        let mut end = length(messages)?;
        if before.truthy()? {
            let mut found = None;
            for i in 0..end {
                if messages.element(i as u32)?.get(c"id")?.equals(before)? {
                    found = Some(i);
                    break;
                }
            }
            if let Some(index) = found {
                end = index;
            } else {
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
        let start = end.saturating_sub(size);
        object(
            self.anchor,
            &[
                (
                    c"messages",
                    clone_json(method(
                        messages,
                        c"slice",
                        &[
                            number(messages, start as f64)?,
                            number(messages, end as f64)?,
                        ],
                    )?)?,
                ),
                (c"hasMore", boolean(messages, start > 0)?),
                (
                    c"before",
                    if start > 0 {
                        messages.element(start as u32)?.get(c"id")?
                    } else {
                        self.anchor.from_value(&J::Null)?
                    },
                ),
            ],
        )?
        .freeze()
    }
    fn run(&self, action: &str, args: L<'a>) -> Result<L<'a>> {
        let session = args.element(0)?;
        let value = args.element(1)?;
        let undefined = self.anchor.from_value(&J::Undefined)?;
        match action {
            "read" => clone_json(self.current(session)?),
            "view" => self.current(session),
            "invalidate" => {
                let cache_key = key(session)?;
                self.owner.cache.borrow_mut().remove(&cache_key);
                self.owner.committed.borrow_mut().remove(&cache_key);
                let missing_key = key(session)?;
                self.owner.missing_ids.borrow_mut().remove(&missing_key);
                Ok(undefined)
            }
            "ensurePersistedIds" => {
                let session = string(session)?;
                let id = key(session)?;
                let messages = self.current(session)?;
                let missing = self.owner.missing_ids.borrow().contains(&id);
                if missing {
                    self.repository(c"write", &[session, messages])?;
                    self.owner.missing_ids.borrow_mut().remove(&id);
                    self.owner.committed.borrow_mut().remove(&id);
                }
                Ok(undefined)
            }
            "assertCanDeleteSession" => {
                self.assert_delete(session)?;
                Ok(undefined)
            }
            "deleteSession" => {
                let options = if value.undefined()? {
                    object(self.anchor, &[])?
                } else {
                    value
                };
                let after = options.get(c"afterCommit")?;
                let session = string(session)?;
                self.assert_delete(session)?;
                let deleted = self.repository(c"deleteSession", &[session])?;
                let cache_key = key(session)?;
                self.owner.cache.borrow_mut().remove(&cache_key);
                self.owner.committed.borrow_mut().remove(&cache_key);
                self.emit(
                    object(
                        self.anchor,
                        &[
                            (c"type", text(self.anchor, "delete")?),
                            (c"sessionId", session),
                            (c"deleted", deleted),
                        ],
                    )?,
                    after,
                )?;
                Ok(deleted)
            }
            "containsDelivery" | "hasPersistedDelivery" => {
                let id = string(fallback(value, text(self.anchor, "")?)?)?;
                if !id.truthy()? {
                    return boolean(self.anchor, false);
                }
                if action == "hasPersistedDelivery" {
                    return self.repository(c"hasPersistedDelivery", &[string(session)?, id]);
                }
                let messages = self.current(session)?;
                for i in 0..length(messages)? {
                    let msg = messages.element(i as u32)?;
                    if msg.truthy()?
                        && (msg.get(c"deliveryId")?.equals(id)?
                            || msg.get(c"clientMsgId")?.equals(id)?)
                    {
                        return boolean(msg, true);
                    }
                }
                boolean(self.anchor, false)
            }
            "latestAssistantAt" => {
                let messages = self.current(session)?;
                for i in (0..length(messages)?).rev() {
                    let message = messages.element(i as u32)?;
                    let ts = if message.truthy()? && message.get(c"role")?.is_string("assistant")? {
                        message.get(c"ts")?.explicit_number()?
                    } else {
                        0.0
                    };
                    if ts.is_finite() && ts > 0.0 {
                        return self
                            .anchor
                            .global()?
                            .get(c"Date")?
                            .construct(&[number(message, ts)?]);
                    }
                }
                self.anchor.from_value(&J::Null)
            }
            "paginate" => {
                let options = if value.undefined()? {
                    object(self.anchor, &[])?
                } else {
                    value
                };
                let before = options.get(c"before")?;
                let limit = options.get(c"limit")?;
                self.paginate(
                    session,
                    before,
                    if limit.undefined()? {
                        number(limit, 5.0)?
                    } else {
                        limit
                    },
                )
            }
            "prepareAppend" => {
                let opts = args.element(2)?;
                let after = if opts.undefined()? {
                    self.anchor.from_value(&J::Undefined)?
                } else {
                    opts.get(c"afterCommit")?
                };
                self.prepare_append(session, value, after)
            }
            "commitAppend" => self.commit_append(session, value),
            "resendPending" => self.resend_pending(session),
            "preparePersist" => self.prepare_persist(session),
            "prepareInterim" => {
                let opts = args.element(2)?;
                let after = if opts.undefined()? {
                    self.anchor.from_value(&J::Undefined)?
                } else {
                    opts.get(c"afterCommit")?
                };
                self.prepare_interim(session, value, after)
            }
            "prepareReplace" => {
                let opts = args.element(2)?;
                let opts = if opts.undefined()? {
                    object(self.anchor, &[])?
                } else {
                    opts
                };
                let after = opts.get(c"afterCommit")?;
                self.prepare_replace(session, value, after, opts.get(c"reason")?)
            }
            "discardAppend" => {
                self.discard_append(session)?;
                self.anchor.from_value(&J::Undefined)
            }
            "append" | "upsertInterim" | "replace" | "remove" => {
                let opts = args.element(2)?;
                let opts = if opts.undefined()? {
                    object(self.anchor, &[])?
                } else {
                    opts
                };
                let after = opts.get(c"afterCommit")?;
                match action {
                    "append" => self.append(session, value, after),
                    "upsertInterim" => self.interim(session, value, after),
                    "replace" => self.replace(session, value, after, opts.get(c"reason")?),
                    _ => self.remove(session, value, after),
                }
            }
            _ => Err(Error::from_reason("unknown history operation")),
        }
    }
}
#[napi]
impl RustChatHistory {
    #[napi(constructor)]
    pub fn new(env: Env, anchor: Unknown<'_>) -> Result<Self> {
        Ok(Self {
            values: Values::new(L::new(&env, anchor))?,
            cache: RefCell::default(),
            missing_ids: RefCell::default(),
            pending_appends: RefCell::default(),
            committed: RefCell::default(),
            next_append_id: Cell::new(0),
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
        let host = History {
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
#[napi]
pub fn chat_history_clean_thinking_blocks(
    env: Env,
    message: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(clean_thinking(&env, L::new(&env, message))?.raw())
}
