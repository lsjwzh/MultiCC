//! Claude startup history sanitation, executed by a blocking worker.
use crate::{
    js::{self, JsString, JsValue as V},
    quota_guard,
};
use std::{fs, io, path::Path};

fn sanitize(line: &str, cleaned: &mut usize) -> Option<String> {
    let mut parsed = js::json_parse(line).ok()?;
    if parsed.is_nullish() {
        return None;
    }
    if let Some(message) = parsed.get("message").filter(|message| js::truthy(message)) {
        if let Some(V::Array(blocks)) = message.get("content") {
            let mut kept = Vec::new();
            for block in blocks {
                if block.is_nullish() {
                    return None;
                }
                let empty = block.get("type") == Some(&V::from("thinking"))
                    && (!js::truthy_opt(block.get("thinking"))
                        || js::js_to_string(block.get("thinking").unwrap())
                            .trim()
                            .is_empty());
                if empty {
                    *cleaned += 1;
                } else {
                    kept.push(block.clone());
                }
            }
            let mut message = message.clone();
            quota_guard::set(&mut message, "content", V::Array(kept));
            quota_guard::set(&mut parsed, "message", message);
        }
    }
    Some(js::json_stringify_or_undefined(&parsed))
}

pub fn sanitize_history(home: &Path, session: &str) -> io::Result<usize> {
    let projects = home.join(".claude/projects");
    if !projects.try_exists()? {
        return Ok(0);
    }
    let mut entries = fs::read_dir(projects)?.collect::<io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let file = entry.path().join(format!("{session}.jsonl"));
        if !file.try_exists()? {
            continue;
        }
        let bytes = fs::read(&file)?;
        let content = String::from_utf8_lossy(&bytes);
        let mut cleaned = 0;
        let output = content
            .split('\n')
            .map(|line| {
                if JsString::from_rust_str(line).trim().is_empty() {
                    line.to_owned()
                } else {
                    sanitize(line, &mut cleaned).unwrap_or_else(|| line.to_owned())
                }
            })
            .collect::<Vec<_>>();
        if cleaned > 0 {
            fs::write(file, output.join("\n"))?;
        }
        return Ok(cleaned);
    }
    Ok(0)
}
