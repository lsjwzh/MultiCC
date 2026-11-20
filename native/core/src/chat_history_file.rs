//! 共享的会话历史文件命名与记录扫描协议。
//!
//! 网关和 addon 使用相同的 BOM、行终止与截断恢复规则。扫描回调负责将
//! 记录交给相应的宿主，文件索引、可见性和缓存不由扫描器修改。
use crate::js::{is_js_whitespace_char, json_parse, json_stringify_or_undefined, JsValue};
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
    use std::convert::Infallible;
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut reader = BufReader::new(file);
    let mut messages = Vec::new();
    if starts_with_array(&mut reader)? {
        scan_legacy_array(&mut reader, |_, value| {
            messages.push(value);
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
            Ok::<_, Infallible>(visit_json_object(line, |value| messages.push(value)))
        })
        .map_err(|error| match error {
            LineError::Io(error) => error,
            LineError::Callback(never) => match never {},
            LineError::TooLarge => invalid_data("history record exceeds the read budget"),
            other => invalid_data(&other.corruption_message().expect("history corruption")),
        })?;
    }
    Ok(messages)
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
    loop {
        whitespace(&mut bytes)?;
        if matches!(bytes.peek(), Some(Ok(b']'))) {
            if !first {
                return Err(LegacyError::Invalid);
            }
            bytes.next();
            break;
        }
        let mut entry = Vec::new();
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
        let value = json_parse(&source).map_err(|_| LegacyError::Invalid)?;
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
}
