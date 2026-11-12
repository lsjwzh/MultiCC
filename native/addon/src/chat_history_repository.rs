//! 历史文件协议与追加账本。文件 IO 已由 Rust 原生完成。
//! 解析仍调用宿主引擎的 JSON.parse/stringify，因为调用方需要 JS 消息对象；
//! 文件字节、行末字节偏移、原子写入与失败清理都由 Rust 唯一拥有。
//! 不跨宿主回调持有借用；消息引用由可追踪 anchor 保存，不克隆正文。
use crate::{
    js_host_value::{Value, Values},
    js_live::LiveValue as L,
    node_fs_error,
};
use multicc_core::{
    js::{
        is_js_whitespace_char, json_parse, json_stringify_or_undefined, JsValue as J,
        JsValue as SemanticValue,
    },
    state_file,
};
use napi::{
    bindgen_prelude::{AsyncTask, Unknown},
    sys, Env, Error, Result, Task,
};
use napi_derive::napi;
use std::{
    cell::RefCell,
    collections::HashMap,
    ffi::CStr,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
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

#[napi(object)]
pub struct HistoryProbeError {
    pub error_type: String,
    pub message: String,
    pub code: String,
    pub errno: Option<i32>,
    pub syscall: Option<String>,
    pub path: Option<String>,
    pub json_source: Option<String>,
}

#[napi(object)]
pub struct HistoryProbeResult {
    pub found: bool,
    pub error: Option<HistoryProbeError>,
}

pub struct DeliveryProbeJob {
    root: PathBuf,
    session_id: String,
    delivery_id: String,
}

fn probe_path(root: &Path, session_id: &str) -> PathBuf {
    let safe: String = session_id
        .encode_utf16()
        .map(|unit| {
            if matches!(unit, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a)
                || unit == u16::from(b'_')
                || unit == u16::from(b'-')
            {
                char::from_u32(u32::from(unit)).unwrap_or('_')
            } else {
                '_'
            }
        })
        .collect();
    let safe = if session_id.is_empty() {
        "_default"
    } else {
        &safe
    };
    root.join(format!("{}.json", safe))
}

fn probe_error(
    error_type: &str,
    message: String,
    code: &str,
    error: Option<&std::io::Error>,
    syscall: Option<&str>,
    path: Option<&Path>,
) -> HistoryProbeError {
    let info = error.map(multicc_core::node_fs_error::classify);
    HistoryProbeError {
        error_type: error_type.to_string(),
        message,
        code: code.to_string(),
        errno: info.map(|value| value.errno),
        syscall: syscall.map(str::to_string),
        path: path.map(|value| value.to_string_lossy().into_owned()),
        json_source: None,
    }
}

fn corrupt_probe(message: &str) -> HistoryProbeError {
    probe_error(
        "TypeError",
        format!("[session] {message}"),
        "CHAT_HISTORY_CORRUPT",
        None,
        None,
        None,
    )
}

#[napi(object)]
pub struct HistoryWriteError {
    pub error_type: String,
    pub message: String,
    pub code: String,
    pub errno: Option<i32>,
    pub syscall: Option<String>,
    pub path: Option<String>,
    pub dest: Option<String>,
    pub operation: Option<String>,
    pub target: Option<String>,
}

#[napi(object)]
pub struct HistoryWriteResult {
    pub error: Option<HistoryWriteError>,
    /// 写完后文件总字节数与最后 64 行的绝对行尾偏移：宿主据此登记增量账本，
    /// 下一笔只写尾巴。错误时为 None。
    pub bytes: Option<f64>,
    pub ends: Option<Vec<f64>>,
}

#[napi(object)]
pub struct HistoryAppendResult {
    pub error: Option<HistoryWriteError>,
    /// false = 文件与账本错位（或文件不存在于非零起点），调用方整份重发。
    pub appended: bool,
    pub bytes: Option<f64>,
    pub ends: Option<Vec<f64>>,
}

fn safe_stem(session_id: &str) -> String {
    let safe: String = session_id
        .encode_utf16()
        .map(|unit| {
            if matches!(unit, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a)
                || unit == u16::from(b'_')
                || unit == u16::from(b'-')
            {
                char::from_u32(u32::from(unit)).unwrap_or('_')
            } else {
                '_'
            }
        })
        .collect();
    if session_id.is_empty() {
        "_default".to_string()
    } else {
        safe
    }
}

fn history_path(root: &Path, session_id: &str) -> PathBuf {
    root.join(format!("{}.json", safe_stem(session_id)))
}

/// `root/.views/<session>.json`, the same file `path_for(session, true)` names.
fn visibility_path(root: &Path, session_id: &str) -> PathBuf {
    root.join(".views")
        .join(format!("{}.json", safe_stem(session_id)))
}

/// `mkdirSync(dir, { recursive: true, mode: 0o700 })` semantics from the sync
/// path, without a JS anchor: newly created ancestors get the private mode too.
// HistoryWriteError is a `#[napi(object)]` crossing the JS boundary; boxing it
// here would force every caller to unbox and still has to build that shape.
#[allow(clippy::result_large_err)]
fn ensure_private_dir_io(dir: &Path) -> std::result::Result<(), HistoryWriteError> {
    let mut missing = Vec::new();
    let mut probe = Some(dir);
    while let Some(path) = probe {
        if path.exists() {
            break;
        }
        missing.push(path.to_path_buf());
        probe = path.parent();
    }
    fs::create_dir_all(dir)
        .map_err(|error| io_write_error(error, "mkdir", Some(dir), None).reported("mkdir", dir))?;
    for path in missing.iter().rev() {
        set_mode(path, state_file::DIR_MODE).map_err(|error| {
            io_write_error(error, "chmod", Some(path), None).reported("atomic_write", dir)
        })?;
    }
    set_mode(dir, state_file::DIR_MODE).map_err(|error| {
        io_write_error(error, "chmod", Some(dir), None).reported("atomic_write", dir)
    })
}

/// Map a failed `write_bytes_atomic_traced` to the wire error, including the
/// `[state-store] mkdir ...` wrapper exactly like `HistoryWriteJob`.
fn atomic_failure_error(failure: state_file::WriteFailure, target: &Path) -> HistoryWriteError {
    use state_file::WriteStage;
    let (syscall, path, dest) = match failure.stage {
        WriteStage::Mkdir => ("mkdir", Some(failure.path.as_path()), None),
        WriteStage::ChmodDir | WriteStage::ChmodTarget => {
            ("chmod", Some(failure.path.as_path()), None)
        }
        WriteStage::OpenTemporary | WriteStage::OpenDirectory => {
            ("open", Some(failure.path.as_path()), None)
        }
        WriteStage::Write => ("write", None, None),
        WriteStage::Fsync | WriteStage::FsyncDirectory => ("fsync", None, None),
        WriteStage::BeforeRename | WriteStage::Rename => (
            "rename",
            Some(failure.path.as_path()),
            failure.dest.as_deref(),
        ),
    };
    let mut error = io_write_error(failure.error, syscall, path, dest);
    error = error.reported(
        if failure.stage == WriteStage::Mkdir {
            "mkdir"
        } else {
            "atomic_write"
        },
        target,
    );
    if failure.stage == WriteStage::Mkdir {
        error.message = format!(
            "[state-store] mkdir {}: {}",
            failure.path.to_string_lossy(),
            error.message
        );
    }
    error
}

/// Visibility state write, used by the mutation queue so a hide/clear/annotate
/// never lands between an async append's snapshot and its commit.
pub struct VisibilityWriteJob {
    root: PathBuf,
    session_id: String,
    state_json: String,
}

impl Task for VisibilityWriteJob {
    type Output = HistoryWriteResult;
    type JsValue = HistoryWriteResult;

    fn compute(&mut self) -> Result<HistoryWriteResult> {
        let failure = |error| -> Result<HistoryWriteResult> {
            Ok(HistoryWriteResult {
                error: Some(error),
                bytes: None,
                ends: None,
            })
        };
        let target = visibility_path(&self.root, &self.session_id);
        let Some(parent) = target.parent() else {
            return failure(
                write_error(
                    "Error",
                    "history visibility file has no parent".to_string(),
                    None,
                    None,
                    None,
                    None,
                )
                .reported("atomic_write", &target),
            );
        };
        if let Err(error) = ensure_private_dir_io(parent) {
            return failure(error);
        }
        match state_file::write_bytes_atomic_traced(
            &target,
            self.state_json.as_bytes(),
            state_file::FILE_MODE,
            state_file::DIR_MODE,
        ) {
            Ok(()) => Ok(HistoryWriteResult {
                error: None,
                bytes: None,
                ends: None,
            }),
            Err(failure_error) => failure(atomic_failure_error(failure_error, &target)),
        }
    }

    fn resolve(&mut self, _: Env, output: HistoryWriteResult) -> Result<HistoryWriteResult> {
        Ok(output)
    }
}

fn write_error(
    error_type: &str,
    message: String,
    error: Option<&std::io::Error>,
    syscall: Option<&str>,
    path: Option<&Path>,
    dest: Option<&Path>,
) -> HistoryWriteError {
    let info = error.map(multicc_core::node_fs_error::classify);
    HistoryWriteError {
        error_type: error_type.to_string(),
        message,
        code: info
            .map(|value| value.code.to_string())
            .unwrap_or_else(|| "CHAT_HISTORY_WRITE".to_string()),
        errno: info.map(|value| value.errno),
        syscall: syscall.map(str::to_string),
        path: path.map(|value| value.to_string_lossy().into_owned()),
        dest: dest.map(|value| value.to_string_lossy().into_owned()),
        operation: None,
        target: None,
    }
}

impl HistoryWriteError {
    fn reported(mut self, operation: &str, target: &Path) -> Self {
        self.operation = Some(operation.to_string());
        self.target = Some(target.to_string_lossy().into_owned());
        self
    }
}

fn io_write_error(
    error: std::io::Error,
    syscall: &str,
    path: Option<&Path>,
    dest: Option<&Path>,
) -> HistoryWriteError {
    let message = node_fs_error::failure_message(&error, syscall, path, dest);
    write_error("Error", message, Some(&error), Some(syscall), path, dest)
}

#[allow(clippy::result_large_err)]
fn transcript_bytes(
    messages_json: &str,
) -> std::result::Result<(Vec<u8>, Vec<u64>), HistoryWriteError> {
    let parsed = json_parse(messages_json).map_err(|error| {
        write_error(
            "SyntaxError",
            format!("Invalid history snapshot: {error}"),
            None,
            None,
            None,
            None,
        )
    })?;
    let SemanticValue::Array(messages) = parsed else {
        return Err(write_error(
            "TypeError",
            "[session] chat history write requires an array".to_string(),
            None,
            None,
            None,
            None,
        ));
    };
    let mut out = Vec::new();
    // 每行的绝对（相对本份字节）行尾偏移：增量账本据此定位截断点。
    let mut ends = Vec::new();
    for message in &messages {
        out.extend_from_slice(json_stringify_or_undefined(message).as_bytes());
        out.push(b'\n');
        ends.push(out.len() as u64);
    }
    Ok((out, ends))
}

pub struct HistoryWriteJob {
    root: PathBuf,
    session_id: String,
    messages_json: String,
    can_append: bool,
}

impl Task for HistoryWriteJob {
    type Output = HistoryWriteResult;
    type JsValue = HistoryWriteResult;

    fn compute(&mut self) -> Result<HistoryWriteResult> {
        let failure = |error| -> Result<HistoryWriteResult> {
            Ok(HistoryWriteResult {
                error: Some(error),
                bytes: None,
                ends: None,
            })
        };
        let target = history_path(&self.root, &self.session_id);
        let (bytes, ends) = match transcript_bytes(&self.messages_json) {
            Ok(parsed) => parsed,
            Err(error) => return failure(error),
        };
        let (existing, target_exists) = match File::open(&target) {
            Ok(mut file) => {
                let mut value = Vec::new();
                if let Err(error) = file.read_to_end(&mut value) {
                    return failure(
                        io_write_error(error, "read", None, None).reported("atomic_write", &target),
                    );
                }
                (value, true)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (Vec::new(), false),
            Err(error) => {
                return failure(
                    io_write_error(error, "open", Some(&target), None)
                        .reported("atomic_write", &target),
                )
            }
        };
        let written = || HistoryWriteResult {
            error: None,
            bytes: Some(bytes.len() as f64),
            ends: Some(
                ends[ends.len().saturating_sub(64)..]
                    .iter()
                    .map(|end| *end as f64)
                    .collect(),
            ),
        };
        // A new or empty target has no shared durable prefix. Appending there
        // could expose a partially-created transcript, so use the atomic rewrite.
        if self.can_append && target_exists && !existing.is_empty() && bytes.starts_with(&existing)
        {
            let suffix = &bytes[existing.len()..];
            let mut options = OpenOptions::new();
            options.append(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(state_file::FILE_MODE);
            }
            let mut file = match options.open(&target) {
                Ok(file) => file,
                Err(error) => {
                    return failure(
                        io_write_error(error, "open", Some(&target), None)
                            .reported("atomic_write", &target),
                    )
                }
            };
            if !suffix.is_empty() {
                if let Err(error) = file.write_all(suffix) {
                    return failure(
                        io_write_error(error, "write", None, None)
                            .reported("atomic_write", &target),
                    );
                }
            }
            if let Err(error) = file.sync_all() {
                return failure(
                    io_write_error(error, "fsync", None, None).reported("atomic_write", &target),
                );
            }
            return Ok(written());
        }
        match state_file::write_bytes_atomic_traced(
            &target,
            &bytes,
            state_file::FILE_MODE,
            state_file::DIR_MODE,
        ) {
            Ok(()) => Ok(written()),
            Err(failure_error) => failure(atomic_failure_error(failure_error, &target)),
        }
    }

    fn resolve(&mut self, _: Env, output: HistoryWriteResult) -> Result<HistoryWriteResult> {
        Ok(output)
    }
}

/// 尾部增量写：宿主已用恒等前缀比较算出共享前缀，这里只做字节级复核
/// （expected_bytes 必须等于文件现状）后追加尾巴；替换现有尾部时回退原子写。
/// 复核失败不报错——回 appended=false 让宿主整份重发，一次自愈。
pub struct HistoryAppendJob {
    root: PathBuf,
    session_id: String,
    tail_json: String,
    keep_bytes: u64,
    expected_bytes: u64,
}

impl Task for HistoryAppendJob {
    type Output = HistoryAppendResult;
    type JsValue = HistoryAppendResult;

    fn compute(&mut self) -> Result<HistoryAppendResult> {
        let failure = |error| -> Result<HistoryAppendResult> {
            Ok(HistoryAppendResult {
                error: Some(error),
                appended: false,
                bytes: None,
                ends: None,
            })
        };
        let refused = || -> Result<HistoryAppendResult> {
            Ok(HistoryAppendResult {
                error: None,
                appended: false,
                bytes: None,
                ends: None,
            })
        };
        let target = history_path(&self.root, &self.session_id);
        let (tail, ends) = match transcript_bytes(&self.tail_json) {
            Ok(parsed) => parsed,
            Err(error) => return failure(error),
        };
        let appended = |bytes: u64, ends: Vec<u64>| -> Result<HistoryAppendResult> {
            Ok(HistoryAppendResult {
                error: None,
                appended: true,
                bytes: Some(bytes as f64),
                ends: Some(ends.iter().map(|end| *end as f64).collect()),
            })
        };
        let absolute_ends: Vec<u64> = ends.iter().map(|end| self.keep_bytes + end).collect();
        let mut options = OpenOptions::new();
        options.read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(state_file::FILE_MODE);
        }
        let mut file = match options.open(&target) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // 还没有转写文件：只有零起点的尾部可以按原子写新建，
                // 与整份写对新文件的策略一致。
                if self.expected_bytes != 0 || self.keep_bytes != 0 {
                    return refused();
                }
                return match state_file::write_bytes_atomic_traced(
                    &target,
                    &tail,
                    state_file::FILE_MODE,
                    state_file::DIR_MODE,
                ) {
                    Ok(()) => appended(tail.len() as u64, absolute_ends),
                    Err(failure_error) => failure(atomic_failure_error(failure_error, &target)),
                };
            }
            Err(error) => {
                return failure(
                    io_write_error(error, "open", Some(&target), None)
                        .reported("atomic_write", &target),
                )
            }
        };
        let len = match file.metadata() {
            Ok(metadata) => metadata.len(),
            Err(error) => {
                return failure(
                    io_write_error(error, "stat", Some(&target), None)
                        .reported("atomic_write", &target),
                )
            }
        };
        if len != self.expected_bytes || self.keep_bytes > len {
            return refused();
        }
        if self.keep_bytes < len {
            // Clone extents and replace the tail in the private sibling, then
            // publish by rename. A filesystem without clone support falls
            // back to the existing full atomic snapshot.
            return match state_file::replace_tail_cow(
                &file,
                &target,
                self.expected_bytes,
                self.keep_bytes,
                &tail,
            ) {
                Ok(true) => appended(self.keep_bytes + tail.len() as u64, absolute_ends),
                Ok(false) => refused(),
                Err(error) => failure(atomic_failure_error(error, &target)),
            };
        }
        if let Err(error) = file.seek(SeekFrom::Start(self.keep_bytes)) {
            return failure(
                io_write_error(error, "seek", Some(&target), None)
                    .reported("atomic_write", &target),
            );
        }
        if !tail.is_empty() {
            if let Err(error) = file.write_all(&tail) {
                return failure(
                    io_write_error(error, "write", None, None).reported("atomic_write", &target),
                );
            }
        }
        if let Err(error) = file.sync_all() {
            return failure(
                io_write_error(error, "fsync", None, None).reported("atomic_write", &target),
            );
        }
        appended(self.keep_bytes + tail.len() as u64, absolute_ends)
    }

    fn resolve(&mut self, _: Env, output: HistoryAppendResult) -> Result<HistoryAppendResult> {
        Ok(output)
    }
}

fn io_probe(error: std::io::Error, syscall: &str, path: Option<&Path>) -> HistoryProbeError {
    let info = multicc_core::node_fs_error::classify(&error);
    let message = match path {
        Some(path) => format!(
            "{}: {}, {} '{}'",
            info.code,
            info.description,
            syscall,
            path.display()
        ),
        None => format!("{}: {}, {}", info.code, info.description, syscall),
    };
    probe_error(
        "Error",
        message,
        info.code,
        Some(&error),
        Some(syscall),
        path,
    )
}

fn probe_value(value: &SemanticValue, delivery_id: &str) -> Option<bool> {
    let SemanticValue::Object(entries) = value else {
        return None;
    };
    let matches = |key: &str| {
        entries
            .iter()
            .find(|(name, _)| name.as_str_lossy() == key)
            .is_some_and(|(_, value)| {
                matches!(
                    value,
                    SemanticValue::String(text) if text.as_str_lossy() == delivery_id
                )
            })
    };
    Some(matches("deliveryId") || matches("clientMsgId"))
}

// HistoryProbeError is a `#[napi(object)]` crossing the JS boundary; boxing it
// here would force every caller to unbox and still has to build that shape.
#[allow(clippy::result_large_err)]
fn probe_transcript(body: &str, delivery_id: &str) -> std::result::Result<bool, HistoryProbeError> {
    let body = body.strip_prefix('\u{feff}').unwrap_or(body);
    let Some(first) = body.chars().find(|ch| !is_js_whitespace_char(*ch)) else {
        return Err(corrupt_probe("chat history file is empty"));
    };
    if first == '[' {
        let SemanticValue::Array(values) = json_parse(body).map_err(|_| {
            let mut error = probe_error("SyntaxError", String::new(), "", None, None, None);
            error.json_source = Some(body.to_string());
            error
        })?
        else {
            return Err(corrupt_probe("chat history file must contain an array"));
        };
        return Ok(values
            .iter()
            .any(|value| probe_value(value, delivery_id) == Some(true)));
    }
    let complete = body.ends_with('\n');
    let mut lines: Vec<&str> = body.split('\n').collect();
    if complete {
        lines.pop();
    }
    let line_count = lines.len();
    let mut parsed_count = 0usize;
    for (index, line) in lines.into_iter().enumerate() {
        if line.chars().all(is_js_whitespace_char) {
            continue;
        }
        let torn = !complete && index + 1 == line_count && parsed_count > 0;
        let value = match json_parse(line) {
            Ok(value) => value,
            Err(_) if torn => break,
            Err(_) => {
                return Err(corrupt_probe(&format!(
                    "chat history line {} is not valid JSON",
                    index + 1
                )))
            }
        };
        if !matches!(value, SemanticValue::Object(_)) {
            if torn {
                break;
            }
            return Err(corrupt_probe(&format!(
                "chat history line {} is not a message object",
                index + 1
            )));
        }
        parsed_count += 1;
        if probe_value(&value, delivery_id) == Some(true) {
            return Ok(true);
        }
    }
    Ok(false)
}

impl Task for DeliveryProbeJob {
    type Output = HistoryProbeResult;
    type JsValue = HistoryProbeResult;

    fn compute(&mut self) -> Result<HistoryProbeResult> {
        let path = probe_path(&self.root, &self.session_id);
        let mut file = match File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(HistoryProbeResult {
                    found: false,
                    error: None,
                })
            }
            Err(error) => {
                return Ok(HistoryProbeResult {
                    found: false,
                    error: Some(io_probe(error, "open", Some(&path))),
                })
            }
        };
        let mut bytes = Vec::new();
        if let Err(error) = file.read_to_end(&mut bytes) {
            return Ok(HistoryProbeResult {
                found: false,
                error: Some(io_probe(error, "read", None)),
            });
        }
        let body = String::from_utf8_lossy(&bytes);
        match probe_transcript(&body, &self.delivery_id) {
            Ok(found) => Ok(HistoryProbeResult { found, error: None }),
            Err(error) => Ok(HistoryProbeResult {
                found: false,
                error: Some(error),
            }),
        }
    }

    fn resolve(&mut self, _: Env, output: HistoryProbeResult) -> Result<HistoryProbeResult> {
        Ok(output)
    }
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
            "invalidateWrite" => {
                let file = self.path_for(session, false)?;
                self.forget(&file)?;
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
    pub fn has_persisted_delivery_async(
        &self,
        session_id: String,
        delivery_id: String,
    ) -> AsyncTask<DeliveryProbeJob> {
        AsyncTask::new(DeliveryProbeJob {
            root: self.root.clone(),
            session_id,
            delivery_id,
        })
    }
    #[napi]
    pub fn write_async(
        &self,
        session_id: String,
        messages_json: String,
    ) -> AsyncTask<HistoryWriteJob> {
        AsyncTask::new(HistoryWriteJob {
            root: self.root.clone(),
            session_id,
            messages_json,
            can_append: self.can_append,
        })
    }

    /// 尾部增量写：宿主把恒等前缀比较的结果（尾巴 JSON + 字节账本）交给
    /// worker 一次完成 复核→截断→追加→fsync；错位回 appended=false。
    #[napi]
    pub fn append_async(
        &self,
        session_id: String,
        tail_json: String,
        keep_bytes: f64,
        expected_bytes: f64,
    ) -> AsyncTask<HistoryAppendJob> {
        AsyncTask::new(HistoryAppendJob {
            root: self.root.clone(),
            session_id,
            tail_json,
            keep_bytes: keep_bytes as u64,
            expected_bytes: expected_bytes as u64,
        })
    }

    /// Async counterpart of `writeVisibility`, for the mutation queue. The
    /// caller serializes the state itself (`String(JSON.stringify(state))`);
    /// this only owns the private-dir setup and the atomic file write.
    #[napi]
    pub fn write_visibility_async(
        &self,
        session_id: String,
        state_json: String,
    ) -> AsyncTask<VisibilityWriteJob> {
        AsyncTask::new(VisibilityWriteJob {
            root: self.root.clone(),
            session_id,
            state_json,
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
