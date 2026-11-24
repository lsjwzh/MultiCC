//! 从 CLI 转录的尾部倒查停止证据。任何一条旧回合的回执都不能越过新提示词。
use crate::js::raw_record::{flag, record, string, Record};
use crate::js::{js_to_string, js_trim, json_parse, truthy, JsString};
use serde_json::value::RawValue;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

const TAIL_BYTES: u64 = 256 * 1024;
const INTERRUPT: &str = "[Request interrupted by user";

fn prompt_text(content: &RawValue) -> Option<String> {
    if let Some(text) = string(Some(&content)) {
        return Some(text.to_string_lossy());
    }
    let parts: Vec<&RawValue> = serde_json::from_str(content.get()).ok()?;
    let mut text = Vec::new();
    for part in parts {
        let Some(block) = record(part.get()) else {
            continue;
        };
        if string(block.get("type")) != Some("text".into()) {
            continue;
        }
        let value = block.get("text").and_then(|raw| json_parse(raw.get()).ok());
        text.push(
            value
                .filter(truthy)
                .map(|v| js_to_string(&v).to_string_lossy())
                .unwrap_or_default(),
        );
    }
    (!text.is_empty()).then(|| text.join("\n"))
}

fn claude(entry: &Record<'_>) -> Option<&'static str> {
    if flag(entry.get("isSidechain")) {
        return None;
    }
    match string(entry.get("type"))?.to_string_lossy().as_str() {
        "system" if string(entry.get("subtype")) == Some("stop_hook_summary".into()) => Some(
            if entry
                .get("preventedContinuation")
                .is_some_and(|v| v.get() == "true")
            {
                "continued"
            } else {
                "confirmed"
            },
        ),
        "user" if !flag(entry.get("isMeta")) => {
            let message = record(entry.get("message")?.get())?;
            let text = prompt_text(message.get("content")?)?;
            Some(if js_trim(&text).starts_with(INTERRUPT) {
                "interrupted"
            } else {
                "pending"
            })
        }
        _ => None,
    }
}

fn codex(entry: &Record<'_>, turn: &JsString) -> Option<&'static str> {
    if string(entry.get("type")) != Some("event_msg".into()) {
        return None;
    }
    let payload = record(entry.get("payload")?.get())?;
    if string(payload.get("turn_id")).as_ref() != Some(turn) {
        return None;
    }
    match string(payload.get("type"))?.to_string_lossy().as_str() {
        "task_started" => Some("pending"),
        "task_complete" => Some("confirmed"),
        "turn_aborted" => Some("interrupted"),
        _ => None,
    }
}

fn read_tail(path: &Path) -> io::Result<Vec<u8>> {
    // 只读普通转录，误传管道时不能占住后台线程等写端。
    if !path.is_file() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let start = size.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;
    // 与旧读取一致：只读取初次取样的区间，不把稍后追加的下一回合带入结果。
    let mut bytes = vec![0; (size - start) as usize];
    let _read = file.read(&mut bytes)?;
    if start != 0 {
        let first_full_line = bytes
            .iter()
            .position(|b| *b == b'\n')
            .map_or(bytes.len(), |i| i + 1);
        bytes.drain(..first_full_line);
    }
    Ok(bytes)
}

pub fn confirm(cli: &str, turn: Option<&JsString>, path: &Path) -> &'static str {
    if cli != "claude" && (cli != "codex" || turn.is_none_or(JsString::is_empty)) {
        return "pending";
    }
    let Ok(bytes) = read_tail(path) else {
        return "pending";
    };
    String::from_utf8_lossy(&bytes)
        .rsplit('\n')
        .filter_map(record)
        .find_map(|entry| {
            if cli == "claude" {
                claude(&entry)
            } else {
                turn.and_then(|id| codex(&entry, id))
            }
        })
        .unwrap_or("pending")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_summary_skips_deep_tool_data_and_accepts_js_keys() {
        let nested = format!("{}0{}", "[".repeat(2500), "]".repeat(2500));
        let line = format!(
            r#"{{"toolData":{nested},"\ud800":true,"type":"user","ty\u0070e":"system","subtype":"stop_hook_summary"}}"#
        );
        assert_eq!(claude(&record(&line).unwrap()), Some("confirmed"));
    }

    #[test]
    fn codex_turn_ids_compare_utf16_units() {
        let row =
            record(r#"{"type":"event_msg","payload":{"turn_id":"\ud800","type":"turn_aborted"}}"#)
                .unwrap();
        assert_eq!(
            codex(&row, &JsString::from_units(vec![0xd800])),
            Some("interrupted")
        );
        assert_eq!(codex(&row, &JsString::from_units(vec![0xd801])), None);
    }
}
