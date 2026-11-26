//! 共享的会话历史文件命名与记录扫描协议。
//!
//! 网关和 addon 使用相同的 BOM、行终止与截断恢复规则。扫描回调负责将
//! 记录交给相应的宿主，文件索引、可见性和缓存不由扫描器修改。
use crate::js::{
    is_js_whitespace_char, json_parse, json_project_object, json_stringify_or_undefined, JsValue,
};
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

pub fn safe_stem(units: impl IntoIterator<Item = u16>) -> String {
    let stem: String = units
        .into_iter()
        .map(|unit| match unit {
            0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a | 0x2d | 0x5f => unit as u8 as char,
            _ => '_',
        })
        .collect();
    if stem.is_empty() {
        "_default".into()
    } else {
        stem
    }
}

pub fn transcript_path(root: &Path, session_id: &str) -> PathBuf {
    root.join(format!("{}.json", safe_stem(session_id.encode_utf16())))
}

pub fn visibility_path(root: &Path, session_id: &str) -> PathBuf {
    transcript_path(&root.join(".views"), session_id)
}

/// JSONL bytes and record-end offsets, relative to the start of this snapshot
/// or append batch. Offsets are measured after writing each line separator.
pub fn encode_rows(messages: &[JsValue]) -> (Vec<u8>, Vec<u64>) {
    let mut bytes = Vec::new();
    let mut ends = Vec::with_capacity(messages.len());
    for message in messages {
        bytes.extend_from_slice(json_stringify_or_undefined(message).as_bytes());
        bytes.push(b'\n');
        ends.push(bytes.len() as u64);
    }
    (bytes, ends)
}

pub fn read_transcript(path: &Path) -> io::Result<Vec<JsValue>> {
    let mut messages = Vec::new();
    visit_transcript(path, |value| messages.push(value))?;
    Ok(messages)
}

/// Validate the whole transcript while retaining only the rows the caller needs.
pub fn visit_transcript(path: &Path, mut visit: impl FnMut(JsValue)) -> io::Result<()> {
    use std::convert::Infallible;
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let mut reader = BufReader::new(file);
    if starts_with_array(&mut reader)? {
        scan_legacy_array(&mut reader, |_, value| {
            visit(value);
            Ok::<(), LegacyError<Infallible>>(())
        })
        .map_err(|error| match error {
            LegacyError::Io(error) => error,
            LegacyError::Callback(never) => match never {},
            LegacyError::Invalid => invalid_data("legacy chat history is not valid JSON"),
            LegacyError::TooLarge => invalid_data("legacy history record exceeds the read budget"),
        })?;
    } else {
        let limit = crate::chat_history_index::MAX_INDEX_RECORD_BYTES;
        scan_json_lines(&mut reader, true, Some(limit), |line| {
            Ok::<_, Infallible>(visit_json_object(line, &mut visit))
        })
        .map_err(|error| match error {
            LineError::Io(error) => error,
            LineError::Callback(never) => match never {},
            LineError::TooLarge => invalid_data("history record exceeds the read budget"),
            other => invalid_data(&other.corruption_message().expect("history corruption")),
        })?;
    }
    Ok(())
}

/// 轻量 JSONL 行元数据及其字节区间，用于先配对再按需读取正文。
pub struct JsonlRecordOffset {
    pub index: usize,
    pub start: u64,
    pub end: u64,
    pub value: JsValue,
}

/// 流式扫描 JSONL 文件，仅投影出 `fields` 指定的标量字段并记录每行字节范围。
/// 若文件是旧版 JSON 数组格式则返回 `Ok(None)`，由调用方退回流式全数组扫描。
pub fn scan_jsonl_projected_offsets(
    path: &Path,
    fields: &[&str],
) -> io::Result<Option<Vec<JsonlRecordOffset>>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Some(Vec::new())),
        Err(error) => return Err(error),
    };
    let mut reader = BufReader::new(file);
    if starts_with_array(&mut reader)? {
        return Ok(None);
    }
    let limit = crate::chat_history_index::MAX_INDEX_RECORD_BYTES;
    let mut bytes = Vec::new();
    let mut out = Vec::new();
    let mut offset = 0_u64;
    let mut line = 0_usize;
    let mut accepted = false;
    loop {
        bytes.clear();
        let start = offset;
        let count = (&mut reader)
            .take(limit.saturating_add(1))
            .read_until(b'\n', &mut bytes)?;
        if count == 0 {
            break;
        }
        if count as u64 > limit {
            return Err(invalid_data("history record exceeds the read budget"));
        }
        offset = offset
            .checked_add(count as u64)
            .ok_or_else(|| invalid_data("history offset overflow"))?;
        let end = offset;
        line += 1;
        let complete = bytes.last() == Some(&b'\n');
        if complete {
            bytes.pop();
        }
        let text = String::from_utf8_lossy(&bytes);
        let text = if line == 1 {
            text.strip_prefix('\u{feff}').unwrap_or(&text)
        } else {
            &text
        };
        if text.chars().all(is_js_whitespace_char) {
            continue;
        }
        match json_project_object(text, fields) {
            Ok(value @ JsValue::Object(_)) => {
                accepted = true;
                let index = out.len();
                out.push(JsonlRecordOffset {
                    index,
                    start,
                    end,
                    value,
                });
            }
            _ if !complete && accepted => break,
            Ok(_) => {
                return Err(invalid_data(&format!(
                    "chat history line {line} is not a message object"
                )))
            }
            Err(_) => {
                return Err(invalid_data(&format!(
                    "chat history line {line} is not valid JSON"
                )))
            }
        }
    }
    Ok(Some(out))
}

fn read_jsonl_record_raw(file: &mut File, start: u64, end: u64) -> io::Result<String> {
    let len = end
        .checked_sub(start)
        .ok_or_else(|| invalid_data("invalid record byte range"))?;
    if len > crate::chat_history_index::MAX_INDEX_RECORD_BYTES {
        return Err(invalid_data("history record exceeds the read budget"));
    }
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = vec![0_u8; len as usize];
    file.read_exact(&mut bytes)?;
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    let text = String::from_utf8_lossy(&bytes);
    let trimmed = if start == 0 {
        text.strip_prefix('\u{feff}').unwrap_or(&text)
    } else {
        &text
    };
    Ok(trimmed.to_owned())
}

/// 按精确字节区间 `pread` 单条 JSONL 记录，并只解析 `fields` 指定的字段。
pub fn read_jsonl_record_projected(
    file: &mut File,
    start: u64,
    end: u64,
    fields: &[&str],
) -> io::Result<JsValue> {
    let raw = read_jsonl_record_raw(file, start, end)?;
    json_project_object(&raw, fields).map_err(|error| invalid_data(&error.to_string()))
}

/// 按精确字节区间 `pread` 单条完整 JSONL 记录（用于计算 legacy_message_id）。
pub fn read_jsonl_record_full(file: &mut File, start: u64, end: u64) -> io::Result<JsValue> {
    let raw = read_jsonl_record_raw(file, start, end)?;
    json_parse(&raw).map_err(|error| invalid_data(&error.to_string()))
}

/// 从 JSONL 文件尾部按 64 KiB 分块倒序读取并只解析 `fields` 指定字段。
/// 当 `on_row` 返回 `false` 时立即停止读取；遇到旧版数组或异常格式时返回 `Ok(false)`
/// 以交由严格前向扫描处理或报错。
pub fn visit_jsonl_tail_reverse_projected(
    path: &Path,
    fields: &[&str],
    mut on_row: impl FnMut(JsValue) -> bool,
) -> io::Result<bool> {
    const CHUNK_BYTES: u64 = 64 * 1024;
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error),
    };
    let file_len = file.metadata()?.len();
    if file_len == 0 {
        return Ok(true);
    }
    if starts_with_array(&mut file)? {
        return Ok(false);
    }

    let limit = crate::chat_history_index::MAX_INDEX_RECORD_BYTES;
    let mut pos = file_len;
    let mut rev_line: Vec<u8> = Vec::new();
    let mut at_file_end = true;
    let mut accepted_any = false;
    let mut trailing_invalid = false;
    let mut stopped = false;

    enum LineOutcome {
        Continue,
        Stop,
        Fallback,
    }

    let mut handle_line = |slice: &[u8], is_first_line: bool, is_last_line: bool| -> LineOutcome {
        if slice.len() as u64 > limit {
            return LineOutcome::Fallback;
        }
        let text = String::from_utf8_lossy(slice);
        let text = if is_first_line {
            text.strip_prefix('\u{feff}').unwrap_or(&text)
        } else {
            &text
        };
        if text.chars().all(is_js_whitespace_char) {
            return LineOutcome::Continue;
        }
        match json_project_object(text, fields) {
            Ok(value @ JsValue::Object(_)) => {
                accepted_any = true;
                if on_row(value) {
                    LineOutcome::Continue
                } else {
                    LineOutcome::Stop
                }
            }
            _ if is_last_line => {
                // 仅当存在至少一条更早的有效记录时，才宽容文件末尾未写完的半行。
                trailing_invalid = true;
                LineOutcome::Continue
            }
            _ => LineOutcome::Fallback,
        }
    };

    while pos > 0 && !stopped {
        let read_start = pos.saturating_sub(CHUNK_BYTES);
        let read_len = (pos - read_start) as usize;
        file.seek(SeekFrom::Start(read_start))?;
        let mut chunk = vec![0_u8; read_len];
        file.read_exact(&mut chunk)?;
        pos = read_start;

        let mut end = chunk.len();
        loop {
            if let Some(nl) = memchr::memrchr(b'\n', &chunk[..end]) {
                let tail = &chunk[nl + 1..end];
                if (tail.len() as u64).saturating_add(rev_line.len() as u64) > limit {
                    return Ok(false);
                }
                let outcome = if rev_line.is_empty() {
                    handle_line(tail, false, at_file_end)
                } else {
                    rev_line.extend(tail.iter().rev());
                    rev_line.reverse();
                    let outcome = handle_line(&rev_line, false, at_file_end);
                    rev_line.clear();
                    outcome
                };
                at_file_end = false;
                match outcome {
                    LineOutcome::Continue => {}
                    LineOutcome::Stop => {
                        stopped = true;
                        break;
                    }
                    LineOutcome::Fallback => return Ok(false),
                }
                end = nl;
            } else {
                if (end as u64).saturating_add(rev_line.len() as u64) > limit {
                    return Ok(false);
                }
                rev_line.extend(chunk[..end].iter().rev());
                break;
            }
        }
    }

    if !stopped {
        rev_line.reverse();
        match handle_line(&rev_line, true, at_file_end) {
            LineOutcome::Continue | LineOutcome::Stop => {}
            LineOutcome::Fallback => return Ok(false),
        }
    }

    if trailing_invalid && !accepted_any {
        return Ok(false);
    }
    Ok(true)
}

pub fn read_hidden_ids(path: &Path) -> io::Result<std::collections::HashSet<crate::js::JsString>> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Default::default()),
        Err(error) => return Err(error),
    };
    let state = json_parse(&text).map_err(|error| invalid_data(&error.to_string()))?;
    match (state.get("version"), state.get("hiddenIds")) {
        (Some(JsValue::Number(1.0)), Some(JsValue::Array(ids))) => ids
            .iter()
            .map(|id| match id {
                JsValue::String(id) => Ok(id.clone()),
                _ => Err(invalid_data("invalid chat visibility state")),
            })
            .collect(),
        _ => Err(invalid_data("invalid chat visibility state")),
    }
}

fn invalid_data(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned())
}

pub enum Row {
    Accepted,
    InvalidJson,
    InvalidObject,
}

#[derive(Debug)]
pub enum LineError<E> {
    Io(io::Error),
    Callback(E),
    TooLarge,
    Empty,
    InvalidJson(usize),
    InvalidObject(usize),
}

impl<E> LineError<E> {
    pub fn corruption_message(&self) -> Option<String> {
        match self {
            Self::Empty => Some("chat history file is empty".into()),
            Self::InvalidJson(line) => Some(format!("chat history line {line} is not valid JSON")),
            Self::InvalidObject(line) => {
                Some(format!("chat history line {line} is not a message object"))
            }
            _ => None,
        }
    }
}

pub fn scan_json_lines<E>(
    reader: &mut impl BufRead,
    allow_empty: bool,
    max_record_bytes: Option<u64>,
    mut on_row: impl FnMut(&str) -> Result<Row, E>,
) -> Result<(), LineError<E>> {
    let mut bytes = Vec::new();
    let mut line = 0;
    let mut accepted = false;
    loop {
        bytes.clear();
        let count = match max_record_bytes {
            Some(limit) => (&mut *reader)
                .take(limit.saturating_add(1))
                .read_until(b'\n', &mut bytes),
            None => reader.read_until(b'\n', &mut bytes),
        }
        .map_err(LineError::Io)?;
        if count == 0 {
            break;
        }
        if max_record_bytes.is_some_and(|limit| count as u64 > limit) {
            return Err(LineError::TooLarge);
        }
        line += 1;
        let complete = bytes.last() == Some(&b'\n');
        if complete {
            bytes.pop();
        }
        let text = String::from_utf8_lossy(&bytes);
        let text = if line == 1 {
            text.strip_prefix('\u{feff}').unwrap_or(&text)
        } else {
            &text
        };
        if text.chars().all(is_js_whitespace_char) {
            continue;
        }
        match on_row(text).map_err(LineError::Callback)? {
            Row::Accepted => accepted = true,
            _ if !complete && accepted => break,
            Row::InvalidJson => return Err(LineError::InvalidJson(line)),
            Row::InvalidObject => return Err(LineError::InvalidObject(line)),
        }
    }
    if !accepted && !allow_empty {
        return Err(LineError::Empty);
    }
    Ok(())
}

pub fn visit_json_object(line: &str, on_record: impl FnOnce(JsValue)) -> Row {
    match json_parse(line) {
        Ok(value @ JsValue::Object(_)) => {
            on_record(value);
            Row::Accepted
        }
        Ok(_) => Row::InvalidObject,
        Err(_) => Row::InvalidJson,
    }
}

pub fn starts_with_array(reader: &mut (impl Read + Seek)) -> io::Result<bool> {
    let result = (|| loop {
        let mut first = [0_u8; 1];
        if reader.read(&mut first)? == 0 {
            return Ok(false);
        }
        let byte = first[0];
        if byte.is_ascii() {
            if is_js_whitespace_char(char::from(byte)) {
                continue;
            }
            return Ok(byte == b'[');
        }
        let width = match byte {
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => return Ok(false),
        };
        let mut encoded = [0_u8; 4];
        encoded[0] = byte;
        match reader.read_exact(&mut encoded[1..width]) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(false),
            Err(error) => return Err(error),
        }
        match std::str::from_utf8(&encoded[..width])
            .ok()
            .and_then(|s| s.chars().next())
        {
            Some(ch) if is_js_whitespace_char(ch) => continue,
            _ => return Ok(false),
        }
    })();
    reader.seek(SeekFrom::Start(0))?;
    result
}

#[derive(Debug)]
pub enum LegacyError<E> {
    Io(io::Error),
    Callback(E),
    Invalid,
    TooLarge,
}

pub fn scan_legacy_array<R: Read, E>(
    reader: &mut BufReader<R>,
    on_value: impl FnMut(&str, JsValue) -> Result<(), LegacyError<E>>,
) -> Result<(), LegacyError<E>> {
    scan_legacy_records(reader, json_parse, on_value)
}

pub fn scan_legacy_records<R: Read, E, P>(
    reader: &mut BufReader<R>,
    parse: impl Fn(&str) -> Result<JsValue, P>,
    mut on_value: impl FnMut(&str, JsValue) -> Result<(), LegacyError<E>>,
) -> Result<(), LegacyError<E>> {
    use std::io::Bytes;
    use std::iter::Peekable;
    fn whitespace<R: Read, E>(
        bytes: &mut Peekable<Bytes<&mut BufReader<R>>>,
    ) -> Result<(), LegacyError<E>> {
        loop {
            match bytes.peek() {
                Some(Ok(b' ' | b'\n' | b'\r' | b'\t')) => {
                    bytes.next();
                }
                Some(Err(_)) => return Err(LegacyError::Io(bytes.next().unwrap().unwrap_err())),
                _ => return Ok(()),
            }
        }
    }
    fn next<R: Read, E>(
        bytes: &mut Peekable<Bytes<&mut BufReader<R>>>,
    ) -> Result<u8, LegacyError<E>> {
        bytes
            .next()
            .ok_or(LegacyError::Invalid)?
            .map_err(LegacyError::Io)
    }
    let mut bytes = reader.bytes().peekable();
    if matches!(bytes.peek(), Some(Ok(0xef)))
        && (next(&mut bytes)? != 0xef || next(&mut bytes)? != 0xbb || next(&mut bytes)? != 0xbf)
    {
        return Err(LegacyError::Invalid);
    }
    whitespace(&mut bytes)?;
    if next(&mut bytes)? != b'[' {
        return Err(LegacyError::Invalid);
    }
    let mut first = true;
    let mut entry = Vec::new();
    loop {
        whitespace(&mut bytes)?;
        if matches!(bytes.peek(), Some(Ok(b']'))) {
            if !first {
                return Err(LegacyError::Invalid);
            }
            bytes.next();
            break;
        }
        entry.clear();
        let mut depth = 0usize;
        let mut quoted = false;
        let mut escaped = false;
        loop {
            let byte = match bytes.peek() {
                Some(Ok(byte)) => *byte,
                Some(Err(_)) => return Err(LegacyError::Io(bytes.next().unwrap().unwrap_err())),
                None => return Err(LegacyError::Invalid),
            };
            if !quoted && depth == 0 && (byte == b',' || byte == b']') {
                break;
            }
            next(&mut bytes)?;
            entry.push(byte);
            if entry.len() as u64 > crate::chat_history_index::MAX_INDEX_RECORD_BYTES {
                return Err(LegacyError::TooLarge);
            }
            if quoted {
                if escaped {
                    escaped = false;
                } else if byte == b'\\' {
                    escaped = true;
                } else if byte == b'"' {
                    quoted = false;
                }
            } else {
                match byte {
                    b'"' => quoted = true,
                    b'[' | b'{' => depth += 1,
                    b']' | b'}' if depth > 0 => depth -= 1,
                    _ => {}
                }
            }
        }
        let source = String::from_utf8_lossy(&entry);
        let value = parse(&source).map_err(|_| LegacyError::Invalid)?;
        on_value(&source, value)?;
        match next(&mut bytes)? {
            b']' => break,
            b',' => first = false,
            _ => return Err(LegacyError::Invalid),
        }
    }
    whitespace(&mut bytes)?;
    match bytes.next() {
        None => Ok(()),
        Some(Err(error)) => Err(LegacyError::Io(error)),
        Some(Ok(_)) => Err(LegacyError::Invalid),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::convert::Infallible;
    use std::io::Cursor;

    fn lines(text: &str, max: Option<u64>) -> Result<Vec<JsValue>, LineError<Infallible>> {
        let mut records = Vec::new();
        scan_json_lines(&mut Cursor::new(text), false, max, |line| {
            Ok(visit_json_object(line, |value| records.push(value)))
        })?;
        Ok(records)
    }

    #[test]
    fn json_lines_only_recovers_a_torn_last_record_after_valid_history() {
        let first = "\u{feff}{\"id\":\"a\"}\n";
        assert_eq!(lines(&format!("{first}{{"), None).unwrap().len(), 1);
        assert!(matches!(
            lines(&format!("{first}{{\n"), None),
            Err(LineError::InvalidJson(2))
        ));
        assert!(matches!(lines("{", None), Err(LineError::InvalidJson(1))));
        assert!(matches!(lines(" \n", None), Err(LineError::Empty)));
        assert!(matches!(lines(first, Some(4)), Err(LineError::TooLarge)));
    }

    #[test]
    fn legacy_array_preserves_scalar_and_nested_values_and_rejects_trailing_data() {
        let mut reader = BufReader::new(Cursor::new("\u{feff} [ { \"id\": [\"]\", {}] }, null ]"));
        assert!(starts_with_array(&mut reader).unwrap());
        assert_eq!(reader.stream_position().unwrap(), 0);
        let mut records = Vec::new();
        scan_legacy_array(&mut reader, |_, value| {
            records.push(value);
            Ok::<(), LegacyError<Infallible>>(())
        })
        .unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[1], JsValue::Null);
        assert!(matches!(
            scan_legacy_array(&mut BufReader::new(Cursor::new("[{}]x")), |_, _| {
                Ok::<(), LegacyError<Infallible>>(())
            }),
            Err(LegacyError::Invalid)
        ));
    }

    #[test]
    fn reverse_tail_and_projected_offsets_handle_multichunk_bom_and_torn_tail() {
        let dir = std::env::temp_dir().join(format!(
            "multicc-history-file-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sess.json");
        let big_tools = "x".repeat(90_000);
        let body = format!(
            "\u{feff}{{\"id\":\"m1\",\"role\":\"user\",\"content\":\"first\",\"tools\":\"{big_tools}\"}}\n\
             {{\"id\":\"m2\",\"role\":\"assistant\",\"content\":\"second\",\"tools\":\"{big_tools}\"}}\n\
             {{\"id\":\"m3\",\"role\":\"user\",\"content\":\"third\"}}\n\
             {{\"torn"
        );
        fs::write(&path, body).unwrap();

        let offsets = scan_jsonl_projected_offsets(&path, &["id", "role"])
            .unwrap()
            .unwrap();
        assert_eq!(offsets.len(), 3);
        assert_eq!(offsets[0].value.get("id"), Some(&JsValue::from("m1")));
        assert!(offsets[0].value.get("tools").is_none());

        let mut file = File::open(&path).unwrap();
        let full = read_jsonl_record_projected(&mut file, offsets[1].start, offsets[1].end, &["id", "content"]).unwrap();
        assert_eq!(full.get("content"), Some(&JsValue::from("second")));

        let mut seen = Vec::new();
        let handled = visit_jsonl_tail_reverse_projected(&path, &["id", "content"], |row| {
            seen.push(row.get("id").cloned().unwrap());
            seen.len() < 2
        })
        .unwrap();
        assert!(handled);
        assert_eq!(seen, vec![JsValue::from("m3"), JsValue::from("m2")]);

        let legacy_path = dir.join("legacy.json");
        fs::write(&legacy_path, "[{\"role\":\"user\",\"content\":\"old\"}]").unwrap();
        assert!(scan_jsonl_projected_offsets(&legacy_path, &["id"]).unwrap().is_none());
        assert!(!visit_jsonl_tail_reverse_projected(&legacy_path, &["role"], |_| true).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }
}
