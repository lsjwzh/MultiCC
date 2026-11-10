//! 历史文件协议与追加账本。同步 IO 暂经旧文件端口，调用方迁为异步后再移除。
//! 不跨宿主回调持有借用；消息引用由可追踪 anchor 保存，不克隆正文。
use crate::{
    js_host_value::{Value, Values},
    js_live::LiveValue as L,
};
use multicc_core::js::{JsString, JsValue as J};
use napi::{bindgen_prelude::Unknown, sys, Env, Error, Result};
use napi_derive::napi;
use std::{cell::RefCell, collections::HashMap, ffi::CStr};

fn text<'a>(a: L<'a>, value: &str) -> Result<L<'a>> {
    a.from_value(&J::string(value))
}
fn number(a: L<'_>, value: f64) -> Result<L<'_>> {
    a.from_value(&J::Number(value))
}
fn array(a: L<'_>) -> Result<L<'_>> {
    a.from_value(&J::Array(vec![]))
}
fn method<'a>(value: L<'a>, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    value.get(name)?.call(value, args)
}
fn length(a: L<'_>) -> Result<usize> {
    Ok(a.get(c"length")?.number()? as usize)
}
fn regexp<'a>(a: L<'a>, pattern: &str, flags: &str) -> Result<L<'a>> {
    a.global()?
        .get(c"RegExp")?
        .construct(&[text(a, pattern)?, text(a, flags)?])
}
fn json<'a>(value: L<'a>, op: &CStr) -> Result<L<'a>> {
    method(value.global()?.get(c"JSON")?, op, &[value])
}
fn safe_name(a: L<'_>) -> Result<L<'_>> {
    let value = if a.truthy()? { a } else { text(a, "")? };
    let value = a.global()?.get(c"String")?.call_plain(&[value])?;
    let value = method(
        value,
        c"replace",
        &[regexp(a, "[^A-Za-z0-9_-]", "g")?, text(a, "_")?],
    )?;
    Ok(if value.truthy()? {
        value
    } else {
        text(a, "_default")?
    })
}
fn corrupt(a: L<'_>, message: &str) -> Result<Error> {
    let error = a
        .global()?
        .get(c"TypeError")?
        .construct(&[text(a, &format!("[session] {message}"))?])?;
    error.set(c"code", text(a, "CHAT_HISTORY_CORRUPT")?)?;
    Ok(error.throw_error())
}
fn caught<'a>(a: L<'a>, error: Error) -> Result<L<'a>> {
    if let Some(value) = a.exception_value()? {
        return Ok(value);
    }
    a.global()?
        .get(c"Error")?
        .construct(&[text(a, &error.reason)?])
}
fn missing(error: L<'_>, guarded: bool) -> Result<bool> {
    if guarded && !error.truthy()? {
        return Ok(false);
    }
    error.get(c"code")?.is_string("ENOENT")
}
fn parse_transcript(input: L<'_>) -> Result<L<'_>> {
    let body = method(
        input,
        c"replace",
        &[regexp(input, "^\u{feff}", "")?, text(input, "")?],
    )?;
    let start = method(body, c"search", &[regexp(input, "\\S", "")?])?.number()?;
    if start < 0.0 {
        return Err(corrupt(input, "chat history file is empty")?);
    }
    if method(body, c"charAt", &[number(input, start)?])?.is_string("[")? {
        let value = json(body, c"parse")?;
        if !value.is_array()? {
            return Err(corrupt(input, "chat history file must contain an array")?);
        }
        return Ok(value);
    }
    let complete = method(body, c"endsWith", &[text(input, "\n")?])?.truthy()?;
    let lines = method(body, c"split", &[text(input, "\n")?])?;
    if complete {
        method(lines, c"pop", &[])?;
    }
    let messages = array(input)?;
    for index in 0..length(lines)? {
        let line = lines.element(index as u32)?;
        if !method(line, c"trim", &[])?.truthy()? {
            continue;
        }
        let torn = !complete && index == length(lines)? - 1 && length(messages)? > 0;
        let parsed = match input.catch(|| json(line, c"parse"))? {
            Some(value) => value,
            None if torn => break,
            None => {
                return Err(corrupt(
                    input,
                    &format!("chat history line {} is not valid JSON", index + 1),
                )?)
            }
        };
        if !parsed.truthy()?
            || parsed.kind()? != sys::ValueType::napi_object
            || parsed.is_array()?
        {
            if torn {
                break;
            }
            return Err(corrupt(
                input,
                &format!("chat history line {} is not a message object", index + 1),
            )?);
        }
        method(messages, c"push", &[parsed])?;
    }
    Ok(messages)
}

#[derive(Clone)]
struct Written {
    messages: Value,
    line_ends: Vec<f64>,
    size: f64,
}
#[napi]
pub struct RustChatHistoryRepository {
    values: Values,
    written: RefCell<HashMap<JsString, Written>>,
    can_append: bool,
}
struct Repository<'a> {
    owner: &'a RustChatHistoryRepository,
    env: &'a Env,
    anchor: L<'a>,
    ports: L<'a>,
}
impl<'a> Repository<'a> {
    fn port(&self, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
        self.ports.get(name)?.call_plain(args)
    }
    fn fs(&self, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
        method(self.ports.get(c"fsImpl")?, name, args)
    }
    fn path(&self, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
        method(self.ports.get(c"path")?, name, args)
    }
    fn file(&self, session: L<'a>, visibility: bool) -> Result<L<'a>> {
        let name = method(safe_name(session)?, c"concat", &[text(session, ".json")?])?;
        let root = self.ports.get(c"root")?;
        if visibility {
            self.path(c"join", &[root, text(root, ".views")?, name])
        } else {
            self.path(c"join", &[root, name])
        }
    }
    fn ensure_root(&self) -> Result<()> {
        self.port(c"ensureDir", &[self.ports.get(c"root")?])?;
        Ok(())
    }
    fn forget(&self, file: L<'a>) -> Result<()> {
        let key = file.coerce_string()?;
        self.owner.written.borrow_mut().remove(&key);
        Ok(())
    }
    fn record(&self, file: L<'a>, messages: L<'a>, line_ends: Vec<f64>) -> Result<()> {
        // slice 在 IO 成功之后调用，与旧实现相同；允许 slice/文件端口重入。
        let snapshot = method(messages, c"slice", &[])?;
        let messages = self.owner.values.capture(self.env, snapshot)?;
        let key = file.coerce_string()?;
        let size = line_ends.last().copied().unwrap_or(0.0);
        self.owner.written.borrow_mut().insert(
            key,
            Written {
                messages,
                line_ends,
                size,
            },
        );
        Ok(())
    }
    fn serialize(
        &self,
        value: L<'a>,
        chunks: L<'a>,
        offset: &mut f64,
        ends: &mut Vec<f64>,
    ) -> Result<()> {
        let serialized = json(value, c"stringify")?;
        // 模板字符串允许 stringify(undefined) 产生 "undefined\n"；保留旧行为。
        // 正文留在引擎内拼接，避免 UTF-16 经 Rust 再复制一遍。
        let line = method(
            text(value, "")?,
            c"concat",
            &[serialized, text(value, "\n")?],
        )?;
        method(chunks, c"push", &[line])?;
        *offset += method(
            line.global()?.get(c"Buffer")?,
            c"byteLength",
            &[line, text(line, "utf8")?],
        )?
        .number()?;
        ends.push(*offset);
        Ok(())
    }
    fn full_rewrite(&self, file: L<'a>, messages: L<'a>) -> Result<()> {
        let chunks = array(file)?;
        let mut ends = vec![];
        let mut offset = 0.0;
        messages.for_each(|message| self.serialize(message, chunks, &mut offset, &mut ends))?;
        let body = method(chunks, c"join", &[text(file, "")?])?;
        self.ensure_root()?;
        self.port(c"writeText", &[file, body])?;
        self.record(file, messages, ends)
    }
    fn append_at(&self, file: L<'a>, offset: Option<f64>, body: L<'a>) -> Result<()> {
        if let Some(offset) = offset {
            self.fs(c"truncateSync", &[file, number(file, offset)?])?;
        }
        let fd = self.fs(
            c"openSync",
            &[file, text(file, "a")?, number(file, 0o600 as f64)?],
        )?;
        let written = (|| {
            self.fs(c"writeSync", &[fd, body])?;
            if self.ports.get(c"fsImpl")?.get(c"fsyncSync")?.kind()?
                == sys::ValueType::napi_function
            {
                file.catch(|| self.fs(c"fsyncSync", &[fd]))?;
            }
            Ok(())
        })();
        // finally 的 close 错误优先；否则必须抛原异常对象（也可能是 null）。
        let failed = match written {
            Ok(()) => None,
            Err(error) => Some(caught(file, error)?),
        };
        self.fs(c"closeSync", &[fd])?;
        if let Some(error) = failed {
            return Err(error.throw_error());
        }
        Ok(())
    }
    fn incremental(&self, file: L<'a>, messages: L<'a>) -> Result<bool> {
        let key = file.coerce_string()?;
        let state = self.owner.written.borrow().get(&key).cloned();
        let Some(state) = state else {
            return Ok(false);
        };
        let actual = file.catch(|| self.fs(c"statSync", &[file])?.get(c"size"))?;
        let Some(actual) = actual else {
            return Ok(false);
        };
        if !actual.equals(number(file, state.size)?)? {
            return Ok(false);
        }
        let previous = self
            .owner
            .values
            .read(self.env, self.anchor, &state.messages)?;
        let limit = length(previous)?.min(length(messages)?);
        let mut keep = 0;
        while keep < limit
            && previous
                .element(keep as u32)?
                .equals(messages.element(keep as u32)?)?
        {
            keep += 1;
        }
        if keep == 0 && length(messages)? != 0 {
            return Ok(false);
        }
        if keep == length(messages)? && keep < length(previous)? {
            return Ok(false);
        }
        // 自定义迭代器可能使记录的行数短于数组长度；旧 JS 会得到 undefined/NaN。
        let offset = if keep == 0 {
            Some(0.0)
        } else {
            state.line_ends.get(keep - 1).copied()
        };
        let truncate = if keep == length(previous)? {
            None
        } else {
            offset
        };
        let mut ends = state.line_ends[..keep.min(state.line_ends.len())].to_vec();
        let chunks = array(file)?;
        let mut offset = offset.unwrap_or(f64::NAN);
        let mut index = keep;
        while index < length(messages)? {
            self.serialize(
                messages.element(index as u32)?,
                chunks,
                &mut offset,
                &mut ends,
            )?;
            index += 1;
        }
        let body = method(chunks, c"join", &[text(file, "")?])?;
        if body.truthy()? || truncate.is_some() {
            self.append_at(file, truncate, body)?;
        }
        self.record(file, messages, ends)?;
        Ok(true)
    }
    fn write(&self, session: L<'a>, messages: L<'a>) -> Result<()> {
        if !messages.is_array()? {
            return Err(messages.type_error("[session] chat history write requires an array"));
        }
        let file = self.file(session, false)?;
        let result = (|| {
            if self.owner.can_append && self.incremental(file, messages)? {
                return Ok(());
            }
            self.full_rewrite(file, messages)
        })();
        if let Err(error) = result {
            let error = caught(file, error)?;
            self.forget(file)?;
            return Err(error.throw_error());
        }
        Ok(())
    }
    fn read_strict(&self, session: L<'a>, allow_empty: bool) -> Result<L<'a>> {
        let body = self.fs(
            c"readFileSync",
            &[self.file(session, false)?, text(session, "utf8")?],
        )?;
        if allow_empty && !method(body, c"trim", &[])?.truthy()? {
            return array(session);
        }
        parse_transcript(body)
    }
    fn read_visibility(&self, session: L<'a>) -> Result<L<'a>> {
        let state = (|| {
            json(
                self.fs(
                    c"readFileSync",
                    &[self.file(session, true)?, text(session, "utf8")?],
                )?,
                c"parse",
            )
        })();
        let state = match state {
            Ok(state) => state,
            Err(error) => {
                let error = caught(session, error)?;
                if missing(error, false)? {
                    return session.from_value(&J::Null);
                }
                return Err(error.throw_error());
            }
        };
        let mut valid = state.optional(c"version")?.is_number(1.0)?;
        if valid {
            valid = state.get(c"hiddenIds")?.is_array()?;
        }
        if valid {
            let ids = state.get(c"hiddenIds")?;
            for i in 0..length(ids)? {
                if ids.element(i as u32)?.kind()? != sys::ValueType::napi_string {
                    valid = false;
                    break;
                }
            }
        }
        if !valid {
            return Err(corrupt(session, "invalid chat visibility state")?);
        }
        Ok(state)
    }
    fn write_visibility(&self, session: L<'a>, state: L<'a>) -> Result<()> {
        let dir = self.path(c"dirname", &[self.file(session, true)?])?;
        self.port(c"ensureDir", &[dir])?;
        self.port(
            c"writeText",
            &[self.file(session, true)?, json(state, c"stringify")?],
        )?;
        Ok(())
    }
    fn delete(&self, session: L<'a>) -> Result<bool> {
        let file = self.file(session, false)?;
        self.forget(file)?;
        let deleted = (|| {
            self.fs(c"unlinkSync", &[file])?;
            let remove_visibility = (|| self.fs(c"unlinkSync", &[self.file(session, true)?]))();
            if let Err(error) = remove_visibility {
                let error = caught(file, error)?;
                if !missing(error, false)? {
                    return Err(error.throw_error());
                }
            }
            Ok(true)
        })();
        match deleted {
            Ok(value) => Ok(value),
            Err(error) => {
                let error = caught(file, error)?;
                if missing(error, true)? {
                    Ok(false)
                } else {
                    Err(error.throw_error())
                }
            }
        }
    }
    fn rename(&self, from: L<'a>, to: L<'a>) -> Result<bool> {
        let source = self.file(from, false)?;
        let target = self.file(to, false)?;
        if !self.fs(c"existsSync", &[source])?.truthy()?
            || self.fs(c"existsSync", &[target])?.truthy()?
        {
            return Ok(false);
        }
        self.ensure_root()?;
        self.forget(source)?;
        self.forget(target)?;
        let visibility = self.read_visibility(from)?;
        if visibility.truthy()? {
            self.write_visibility(to, visibility)?;
        }
        self.fs(c"renameSync", &[source, target])?;
        if visibility.truthy()? {
            self.fs(c"unlinkSync", &[self.file(from, true)?])?;
        }
        if self.ports.get(c"fsImpl")?.get(c"chmodSync")?.kind()? == sys::ValueType::napi_function {
            self.fs(c"chmodSync", &[target, number(target, 0o600 as f64)?])?;
        }
        Ok(true)
    }
    fn delivery(&self, session: L<'a>, delivery: L<'a>) -> Result<bool> {
        if !delivery.truthy()? {
            return Ok(false);
        }
        let messages = match self.read_strict(session, false) {
            Ok(messages) => messages,
            Err(error) => {
                let error = caught(session, error)?;
                if missing(error, true)? {
                    return Ok(false);
                }
                return Err(error.throw_error());
            }
        };
        for i in 0..length(messages)? {
            let message = messages.element(i as u32)?;
            if message.truthy()?
                && (message.get(c"deliveryId")?.equals(delivery)?
                    || message.get(c"clientMsgId")?.equals(delivery)?)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    fn list(&self) -> Result<L<'a>> {
        let names = match self.fs(c"readdirSync", &[self.ports.get(c"root")?]) {
            Ok(names) => names,
            Err(error) => {
                let error = caught(self.anchor, error)?;
                if missing(error, true)? {
                    return array(self.anchor);
                }
                return Err(error.throw_error());
            }
        };
        let ids = array(self.anchor)?;
        for i in 0..length(names)? {
            let name = names.element(i as u32)?;
            if name.kind()? == sys::ValueType::napi_string
                && method(name, c"endsWith", &[text(name, ".json")?])?.truthy()?
            {
                let id = method(name, c"slice", &[number(name, 0.0)?, number(name, -5.0)?])?;
                method(ids, c"push", &[id])?;
            }
        }
        method(ids, c"sort", &[])
    }
    fn run(&self, action: &str, args: L<'a>) -> Result<L<'a>> {
        let session = args.element(0)?;
        let value = args.element(1)?;
        let result = match action {
            "fileFor" => self.file(session, false)?,
            "visibilityFileFor" => self.file(session, true)?,
            "readStrict" => self.read_strict(session, value.truthy()?)?,
            "read" => self
                .anchor
                .catch(|| self.read_strict(session, false))?
                .unwrap_or(array(session)?),
            "readVisibility" => self.read_visibility(session)?,
            "writeVisibility" => {
                self.write_visibility(session, value)?;
                session.from_value(&J::Undefined)?
            }
            "write" => {
                self.write(session, value)?;
                session.from_value(&J::Undefined)?
            }
            "deleteSession" => session.from_value(&J::Bool(self.delete(session)?))?,
            "renameSession" => session.from_value(&J::Bool(self.rename(session, value)?))?,
            "hasPersistedDelivery" => {
                session.from_value(&J::Bool(self.delivery(session, value)?))?
            }
            "listSessionIds" => self.list()?,
            _ => return Err(Error::from_reason("unknown history repository operation")),
        };
        Ok(result)
    }
}
#[napi]
impl RustChatHistoryRepository {
    #[napi(constructor)]
    pub fn new(env: Env, anchor: Unknown<'_>) -> Result<Self> {
        let anchor = L::new(&env, anchor);
        let ports = anchor.get(c"ports")?;
        let mut can_append = ports.get(c"appendEnabled")?.truthy()?;
        if can_append {
            for name in [
                c"openSync",
                c"writeSync",
                c"closeSync",
                c"statSync",
                c"truncateSync",
            ] {
                if ports.get(c"fsImpl")?.get(name)?.kind()? != sys::ValueType::napi_function {
                    can_append = false;
                    break;
                }
            }
        }
        Ok(Self {
            values: Values::new(anchor)?,
            written: RefCell::default(),
            can_append,
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
        let repository = Repository {
            owner: self,
            env: &env,
            anchor,
            ports: anchor.get(c"ports")?,
        };
        let result = repository.run(&action, L::new(&env, args))?;
        self.values.drain(&env)?;
        Ok(result.raw())
    }
}
#[napi]
pub fn chat_history_safe_session_name(env: Env, session: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(safe_name(L::new(&env, session))?.raw())
}
