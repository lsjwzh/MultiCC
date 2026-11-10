//! 历史文件协议与追加账本。文件 IO 已由 Rust 原生完成。
//! 解析仍调用宿主引擎的 JSON.parse/stringify，因为调用方需要 JS 消息对象；
//! 文件字节、行末字节偏移、原子写入与失败清理都由 Rust 唯一拥有。
//! 不跨宿主回调持有借用；消息引用由可追踪 anchor 保存，不克隆正文。
use crate::{
    js_host_value::{Value, Values},
    js_live::LiveValue as L,
    node_fs_error,
};
use multicc_core::{js::JsValue as J, state_file};
use napi::{bindgen_prelude::Unknown, sys, Env, Error, Result};
use napi_derive::napi;
use std::{
    cell::RefCell,
    collections::HashMap,
    ffi::CStr,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

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
fn range_error(a: L<'_>, value: f64) -> Result<Error> {
    let rendered = a
        .global()?
        .get(c"String")?
        .call_plain(&[number(a, value)?])?;
    let rendered = rendered
        .string()?
        .map(|value| value.to_string_lossy())
        .unwrap_or_default();
    let message =
        format!("The value of \"len\" is out of range. It must be an integer. Received {rendered}");
    let error = a
        .global()?
        .get(c"RangeError")?
        .construct(&[text(a, &message)?])?;
    error.set(c"code", text(a, "ERR_OUT_OF_RANGE")?)?;
    Ok(error.throw_error())
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

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> std::io::Result<()> {
    Ok(())
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
    written: RefCell<HashMap<PathBuf, Written>>,
    can_append: bool,
    root: PathBuf,
}
struct Repository<'a> {
    owner: &'a RustChatHistoryRepository,
    env: &'a Env,
    anchor: L<'a>,
}
impl<'a> Repository<'a> {
    fn throw_io(
        &self,
        error: std::io::Error,
        syscall: &str,
        path: Option<&Path>,
        dest: Option<&Path>,
    ) -> Error {
        node_fs_error::throw(self.anchor, &error, syscall, path, dest)
    }
    fn path_for(&self, session: L<'a>, visibility: bool) -> Result<PathBuf> {
        let safe = safe_name(session)?;
        let safe = safe
            .string()?
            .ok_or_else(|| Error::from_reason("history repository session name is not a string"))?
            .to_string_lossy();
        let name = format!("{safe}.json");
        Ok(if visibility {
            self.owner.root.join(".views").join(name)
        } else {
            self.owner.root.join(name)
        })
    }
    fn file(&self, session: L<'a>, visibility: bool) -> Result<L<'a>> {
        let path = self.path_for(session, visibility)?;
        text(self.anchor, &path.to_string_lossy())
    }
    fn ensure_private_dir(&self, dir: &Path) -> Result<()> {
        // Node 的 `mkdirSync(dir, { recursive: true, mode: 0o700 })` 会把 mode
        // 应用到它新建的每一级父目录；`create_dir_all` 只用默认权限建父目录，
        // 所以这里补上新建祖先目录的 chmod（历史根可能由写视图时隐式创建）。
        let mut missing = Vec::new();
        let mut probe = Some(dir);
        while let Some(path) = probe {
            if path.exists() {
                break;
            }
            missing.push(path.to_path_buf());
            probe = path.parent();
        }
        fs::create_dir_all(dir).map_err(|error| self.throw_io(error, "mkdir", Some(dir), None))?;
        for path in missing.iter().rev() {
            set_mode(path, state_file::DIR_MODE)
                .map_err(|error| self.throw_io(error, "chmod", Some(path), None))?;
        }
        set_mode(dir, state_file::DIR_MODE)
            .map_err(|error| self.throw_io(error, "chmod", Some(dir), None))?;
        Ok(())
    }
    fn ensure_root(&self) -> Result<()> {
        self.ensure_private_dir(&self.owner.root)
    }
    /// Split a failed atomic write into the value to throw, the value the host
    /// failure reporter receives, and the reporter's `operation` label. For a
    /// mkdir failure the store reports the raw fs error but throws the
    /// `[state-store] mkdir ...` wrapper, exactly like `writeTextAtomic`; for
    /// the rename/write/fsync steps reporter and thrown error are the same
    /// object.
    fn write_failure_values(
        &self,
        failure: &state_file::WriteFailure,
    ) -> Result<(L<'a>, L<'a>, &'static str)> {
        use state_file::WriteStage;
        let path = Some(failure.path.as_path());
        let reported = match failure.stage {
            WriteStage::Mkdir => {
                node_fs_error::build(self.anchor, &failure.error, "mkdir", path, None)?
            }
            WriteStage::ChmodDir | WriteStage::ChmodTarget => {
                node_fs_error::build(self.anchor, &failure.error, "chmod", path, None)?
            }
            WriteStage::OpenTemporary | WriteStage::OpenDirectory => {
                node_fs_error::build(self.anchor, &failure.error, "open", path, None)?
            }
            WriteStage::Write => {
                node_fs_error::build(self.anchor, &failure.error, "write", None, None)?
            }
            WriteStage::Fsync | WriteStage::FsyncDirectory => {
                node_fs_error::build(self.anchor, &failure.error, "fsync", None, None)?
            }
            // The history repository never installs a before-rename hook, so
            // this arm is unreachable from it; both late steps name `rename`.
            WriteStage::BeforeRename | WriteStage::Rename => node_fs_error::build(
                self.anchor,
                &failure.error,
                "rename",
                path,
                failure.dest.as_deref(),
            )?,
        };
        if failure.stage == WriteStage::Mkdir {
            let inner = node_fs_error::failure_message(&failure.error, "mkdir", path, None);
            let thrown = node_fs_error::build_message(
                self.anchor,
                c"Error",
                &format!(
                    "[state-store] mkdir {}: {inner}",
                    failure.path.to_string_lossy()
                ),
            )?;
            return Ok((thrown, reported, "mkdir"));
        }
        Ok((reported, reported, "atomic_write"))
    }
    /// Best-effort host report. The metric/logger live in Node
    /// (`stateStore.setFailureReporter`), so Rust calls the port with the exact
    /// error it is about to throw. A throwing reporter must not replace that
    /// error, hence the JS try/catch boundary.
    fn report_failure(&self, error: L<'a>, operation: &str, target: &Path) {
        let outcome = self.anchor.catch(|| {
            let reporter = self.anchor.get(c"ports")?.get(c"reportFailure")?;
            if reporter.kind()? != sys::ValueType::napi_function {
                return self.anchor.from_value(&J::Undefined);
            }
            let meta = self.anchor.from_value(&J::object(vec![
                ("operation", J::string(operation)),
                ("target", J::string(&target.to_string_lossy())),
            ]))?;
            reporter.call_plain(&[error, meta])
        });
        let _ = outcome;
    }
    fn write_atomic(&self, target: &Path, bytes: &[u8]) -> Result<()> {
        match state_file::write_bytes_atomic_traced(
            target,
            bytes,
            state_file::FILE_MODE,
            state_file::DIR_MODE,
        ) {
            Ok(()) => Ok(()),
            Err(failure) => {
                let (thrown, reported, operation) = self.write_failure_values(&failure)?;
                self.report_failure(reported, operation, target);
                Err(thrown.throw_error())
            }
        }
    }
    fn read_text(&self, path: &Path) -> Result<String> {
        // Node's readFileSync opens first and only then fails EISDIR on read,
        // and its `read` errors carry no `path` property.
        let mut file =
            File::open(path).map_err(|error| self.throw_io(error, "open", Some(path), None))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|error| self.throw_io(error, "read", None, None))?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
    fn forget(&self, file: &Path) -> Result<()> {
        self.owner.written.borrow_mut().remove(file);
        Ok(())
    }
    fn record(&self, file: &Path, messages: L<'a>, line_ends: Vec<f64>) -> Result<()> {
        // slice 在 IO 成功之后调用，与旧实现相同；允许迭代器重入。
        let snapshot = method(messages, c"slice", &[])?;
        let messages = self.owner.values.capture(self.env, snapshot)?;
        let size = line_ends.last().copied().unwrap_or(0.0);
        self.owner.written.borrow_mut().insert(
            file.to_path_buf(),
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
        out: &mut Vec<u8>,
        offset: &mut f64,
        ends: &mut Vec<f64>,
    ) -> Result<()> {
        let serialized = json(value, c"stringify")?;
        // 模板字符串允许 stringify(undefined) 产生 "undefined\n"；保留旧行为。
        // 字节由 Rust 一次性编码：lone surrogate 变成 U+FFFD，与 Buffer.from 相同。
        let line = method(
            text(value, "")?,
            c"concat",
            &[serialized, text(value, "\n")?],
        )?;
        let line = line
            .string()?
            .ok_or_else(|| Error::from_reason("history line serialization is not a string"))?;
        let bytes = line.utf8_lossy_bytes();
        out.extend_from_slice(&bytes);
        *offset += bytes.len() as f64;
        ends.push(*offset);
        Ok(())
    }
    fn full_rewrite(&self, file: &Path, messages: L<'a>) -> Result<()> {
        let mut bytes = Vec::new();
        let mut ends = vec![];
        let mut offset = 0.0;
        messages.for_each(|message| self.serialize(message, &mut bytes, &mut offset, &mut ends))?;
        self.ensure_root()?;
        self.write_atomic(file, &bytes)?;
        self.record(file, messages, ends)
    }
    fn truncate_to(&self, path: &Path, offset: f64) -> Result<()> {
        if !offset.is_finite() || offset.fract() != 0.0 || offset < 0.0 {
            return Err(range_error(self.anchor, offset)?);
        }
        let file = OpenOptions::new()
            .write(true)
            .open(path)
            .map_err(|error| self.throw_io(error, "open", Some(path), None))?;
        file.set_len(offset as u64)
            .map_err(|error| self.throw_io(error, "ftruncate", None, None))?;
        Ok(())
    }
    fn append_at(&self, path: &Path, offset: Option<f64>, bytes: &[u8]) -> Result<()> {
        if let Some(offset) = offset {
            self.truncate_to(path, offset)?;
        }
        let mut options = OpenOptions::new();
        options.append(true).create(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(state_file::FILE_MODE);
        }
        let mut file = options
            .open(path)
            .map_err(|error| self.throw_io(error, "open", Some(path), None))?;
        file.write_all(bytes)
            .map_err(|error| self.throw_io(error, "write", None, None))?;
        // Match the durability of the atomic rewrite; a filesystem that
        // rejects fsync must not fail the append.
        let _ = file.sync_all();
        Ok(())
    }
    fn incremental(&self, file: &Path, messages: L<'a>) -> Result<bool> {
        let state = self.owner.written.borrow().get(file).cloned();
        let Some(state) = state else {
            return Ok(false);
        };
        let actual = match fs::metadata(file) {
            Ok(metadata) => metadata.len() as f64,
            Err(_) => return Ok(false),
        };
        if actual != state.size {
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
        let mut bytes = Vec::new();
        let mut offset = offset.unwrap_or(f64::NAN);
        let mut index = keep;
        while index < length(messages)? {
            self.serialize(
                messages.element(index as u32)?,
                &mut bytes,
                &mut offset,
                &mut ends,
            )?;
            index += 1;
        }
        if !bytes.is_empty() || truncate.is_some() {
            self.append_at(file, truncate, &bytes)?;
        }
        self.record(file, messages, ends)?;
        Ok(true)
    }
    fn write(&self, session: L<'a>, messages: L<'a>) -> Result<()> {
        if !messages.is_array()? {
            return Err(messages.type_error("[session] chat history write requires an array"));
        }
        let file = self.path_for(session, false)?;
        let result = (|| {
            if self.owner.can_append && self.incremental(&file, messages)? {
                return Ok(());
            }
            self.full_rewrite(&file, messages)
        })();
        if let Err(error) = result {
            let error = caught(self.anchor, error)?;
            self.forget(&file)?;
            return Err(error.throw_error());
        }
        Ok(())
    }
    fn read_strict(&self, session: L<'a>, allow_empty: bool) -> Result<L<'a>> {
        let path = self.path_for(session, false)?;
        let body = self.read_text(&path)?;
        let body = text(self.anchor, &body)?;
        if allow_empty && !method(body, c"trim", &[])?.truthy()? {
            return array(self.anchor);
        }
        parse_transcript(body)
    }
    fn read_visibility(&self, session: L<'a>) -> Result<L<'a>> {
        let path = self.path_for(session, true)?;
        let state = (|| {
            let body = self.read_text(&path)?;
            json(text(self.anchor, &body)?, c"parse")
        })();
        let state = match state {
            Ok(state) => state,
            Err(error) => {
                let error = caught(self.anchor, error)?;
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
        // 旧实现对 visibilityFileFor 调用了两次（dirname 与写入目标）。
        let dir = self.path_for(session, true)?;
        let parent = dir
            .parent()
            .ok_or_else(|| Error::from_reason("history visibility file has no parent"))?;
        self.ensure_private_dir(parent)?;
        let target = self.path_for(session, true)?;
        // `atomicWriteText` 会先 String(value)：JSON.stringify 返回 undefined
        // 时旧实现把 "undefined" 写进文件，这里保持同样的字节。
        let serialized = json(state, c"stringify")?;
        let body = state.global()?.get(c"String")?.call_plain(&[serialized])?;
        let body = body.string()?.ok_or_else(|| {
            Error::from_reason("history visibility serialization is not a string")
        })?;
        self.write_atomic(&target, &body.utf8_lossy_bytes())?;
        Ok(())
    }
    fn unlink(&self, path: &Path) -> Result<()> {
        fs::remove_file(path).map_err(|error| self.throw_io(error, "unlink", Some(path), None))
    }
    fn delete(&self, session: L<'a>) -> Result<bool> {
        let file = self.path_for(session, false)?;
        self.forget(&file)?;
        if let Err(error) = self.unlink(&file) {
            let error = caught(self.anchor, error)?;
            if missing(error, false)? {
                return Ok(false);
            }
            return Err(error.throw_error());
        }
        // 内层 catch：视图路径转换失败与 unlink 的 ENOENT 同属一次忽略。
        let visibility = (|| {
            let file = self.path_for(session, true)?;
            self.unlink(&file)
        })();
        if let Err(error) = visibility {
            let error = caught(self.anchor, error)?;
            if !missing(error, false)? {
                return Err(error.throw_error());
            }
        }
        Ok(true)
    }
    fn rename_session(&self, from: L<'a>, to: L<'a>) -> Result<bool> {
        let source = self.path_for(from, false)?;
        let target = self.path_for(to, false)?;
        if !source.exists() || target.exists() {
            return Ok(false);
        }
        self.ensure_root()?;
        self.forget(&source)?;
        self.forget(&target)?;
        let visibility = self.read_visibility(from)?;
        if visibility.truthy()? {
            self.write_visibility(to, visibility)?;
        }
        fs::rename(&source, &target).map_err(|error| {
            node_fs_error::throw(self.anchor, &error, "rename", Some(&source), Some(&target))
        })?;
        if visibility.truthy()? {
            let file = self.path_for(from, true)?;
            self.unlink(&file)?;
        }
        set_mode(&target, state_file::FILE_MODE)
            .map_err(|error| self.throw_io(error, "chmod", Some(&target), None))?;
        Ok(true)
    }
    fn delivery(&self, session: L<'a>, delivery: L<'a>) -> Result<bool> {
        if !delivery.truthy()? {
            return Ok(false);
        }
        let messages = match self.read_strict(session, false) {
            Ok(messages) => messages,
            Err(error) => {
                let error = caught(self.anchor, error)?;
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
        let mut names: Vec<String> = Vec::new();
        match fs::read_dir(&self.owner.root) {
            Ok(entries) => {
                for entry in entries {
                    let entry = entry.map_err(|error| {
                        self.throw_io(error, "scandir", Some(&self.owner.root), None)
                    })?;
                    names.push(entry.file_name().to_string_lossy().into_owned());
                }
            }
            Err(error) => {
                if error.kind() == std::io::ErrorKind::NotFound {
                    return array(self.anchor);
                }
                return Err(self.throw_io(error, "scandir", Some(&self.owner.root), None));
            }
        }
        let listed = array(self.anchor)?;
        for name in names {
            let name = text(self.anchor, &name)?;
            if method(name, c"endsWith", &[text(self.anchor, ".json")?])?.truthy()? {
                let id = method(
                    name,
                    c"slice",
                    &[number(self.anchor, 0.0)?, number(self.anchor, -5.0)?],
                )?;
                method(listed, c"push", &[id])?;
            }
        }
        method(listed, c"sort", &[])
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
            "renameSession" => {
                session.from_value(&J::Bool(self.rename_session(session, value)?))?
            }
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
        let root = ports
            .get(c"root")?
            .string()?
            .ok_or_else(|| Error::from_reason("history repository root must be a string"))?
            .to_string_lossy();
        let can_append = ports.get(c"appendEnabled")?.truthy()?;
        Ok(Self {
            values: Values::new(anchor)?,
            written: RefCell::default(),
            can_append,
            root: PathBuf::from(root),
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
