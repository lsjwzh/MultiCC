//! Synchronous file-backed memories, also used by the session snapshot and retrieval owners.
pub mod retrieval;
pub mod rules;
pub mod snapshot;

use crate::js::{self, JsString, JsValue as V};
use regex::RegexSet;
use std::{
    collections::HashSet,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

pub const DELIMITER: &str = "\n§\n";
pub const FILE: &str = "MEMORY.md";
static EDIT_LOCK: Mutex<()> = Mutex::new(());
const PATTERNS: &[(&str, &str)] = &[
    (
        r"ignore\s+(previous|all|above|prior)\s+instructions",
        "prompt_injection",
    ),
    (r"you\s+are\s+now\s+", "role_hijack"),
    (r"do\s+not\s+tell\s+the\s+user", "deception_hide"),
    (r"system\s+prompt\s+override", "system_prompt_override"),
    (
        r"disregard\s+(your|all|any)\s+(instructions|rules|guidelines)",
        "disregard_rules",
    ),
    (
        r"(curl|wget)\s+[^\n]*\$\{?[a-zA-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)",
        "secret_exfiltration",
    ),
    (r"authorized_keys", "ssh_backdoor"),
    (
        r"忽略(之前|以上|先前|所有)的?(指令|规则|提示)",
        "prompt_injection_zh",
    ),
    (r"你现在是", "role_hijack_zh"),
    (r"不要告诉用户", "deception_hide_zh"),
    (r"(覆盖|改写)(系统)?提示词?", "system_prompt_override_zh"),
];
static FILTER: LazyLock<RegexSet> = LazyLock::new(|| {
    RegexSet::new(PATTERNS.iter().map(|(pattern, _)| {
        pattern
            .to_ascii_lowercase()
            .replace(r"\s", &format!("[{}]", crate::js::regex::SPACE))
    }))
    .expect("memory safety patterns")
});

pub fn scan(content: &str) -> Option<String> {
    for cp in [
        0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
    ] {
        if content.contains(char::from_u32(cp).unwrap()) {
            return Some(format!("content contains invisible unicode U+{cp:04X}"));
        }
    }
    FILTER
        .matches(&content.to_ascii_lowercase())
        .iter()
        .next()
        .map(|i| format!("content matches blocked pattern: {}", PATTERNS[i].1))
}

pub fn read_utf8(path: &Path) -> io::Result<String> {
    fs::read(path).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}
pub fn entries(path: &Path) -> io::Result<Vec<JsString>> {
    let raw = match read_utf8(path) {
        Ok(s) => s,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut seen = HashSet::new();
    Ok(raw
        .split(DELIMITER)
        .map(js::js_trim)
        .filter(|s| !s.is_empty() && seen.insert(*s))
        .map(JsString::from_rust_str)
        .collect())
}

/// A sibling of the destination, owned only after the exclusive create succeeds.
struct TemporaryFile(PathBuf);

impl TemporaryFile {
    fn create(target: &Path, bytes: &[u8]) -> io::Result<Self> {
        let dir = target
            .parent()
            .filter(|d| !d.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        fs::create_dir_all(dir)?;
        let mut random = [0; 6];
        getrandom::fill(&mut random).map_err(|e| io::Error::other(e.to_string()))?;
        let suffix = random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let base = target.file_name().unwrap_or_default().to_string_lossy();
        let path = dir.join(format!(".{base}.{}.{suffix}.tmp", std::process::id()));
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;
        let temporary = Self(path);
        file.write_all(bytes)?;
        Ok(temporary)
    }
}

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub fn write(file: &Path, bytes: &[u8]) -> io::Result<()> {
    let temporary = TemporaryFile::create(file, bytes)?;
    fs::rename(&temporary.0, file)
}
pub fn error(msg: impl Into<String>) -> V {
    V::object(vec![("ok", false.into()), ("error", msg.into().into())])
}
fn join(items: &[JsString]) -> JsString {
    JsString::join(items, &DELIMITER.into())
}
pub fn entry_list(items: Vec<JsString>) -> V {
    V::Array(items.into_iter().map(V::String).collect())
}
fn success(file: &Path, entries: Vec<JsString>, limit: V, msg: &str) -> V {
    let chars = join(&entries).len() as f64;
    let percent = if js::truthy(&limit) {
        (chars / js::js_to_number(&limit) * 100.).floor()
    } else {
        0.
    };
    V::object(vec![
        ("ok", true.into()),
        ("message", msg.into()),
        ("file", file.to_string_lossy().as_ref().into()),
        ("entryCount", (entries.len() as f64).into()),
        ("entries", entry_list(entries)),
        (
            "usage",
            V::object(vec![
                ("chars", chars.into()),
                ("limit", limit),
                ("percent", percent.into()),
            ]),
        ),
        (
            "effective",
            "current tool response; injected snapshot refreshes with the next native session"
                .into(),
        ),
    ])
}
pub fn action(file: &Path, op: &str, value: JsString, needle: JsString, limit: V) -> V {
    let _guard = EDIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let original = match entries(file) {
        Ok(v) => v,
        Err(e) => return error(format!("memory read failed: {e}")),
    };
    let value = value.trim();
    let needle = needle.trim();
    if op != "remove" {
        if value.is_empty() {
            return error("content is required");
        }
        if js::contains_units(
            value.as_units(),
            &DELIMITER.encode_utf16().collect::<Vec<_>>(),
        ) {
            return error("content contains the reserved memory-entry delimiter");
        }
        if let Some(t) = scan(&value.to_string_lossy()) {
            return error(format!("memory write blocked: {t}"));
        }
    }
    let mut next = original.clone();
    let msg = if op == "add" {
        if next.contains(&value) {
            return success(file, next, limit, "entry already exists");
        }
        next.push(value);
        "entry added"
    } else {
        if needle.is_empty() {
            return error("oldText is required");
        }
        let mut matches = next
            .iter()
            .enumerate()
            .filter(|(_, s)| js::contains_units(s.as_units(), needle.as_units()));
        let Some((idx, _)) = matches.next() else {
            return error(format!("no entry matched: {}", needle.to_string_lossy()));
        };
        if matches.next().is_some() {
            return error(format!(
                "multiple entries matched: {}",
                needle.to_string_lossy()
            ));
        }
        if op == "replace" {
            next[idx] = value;
            let mut seen = HashSet::new();
            next.retain(|s| seen.insert(s.clone()));
            "entry replaced"
        } else {
            next.remove(idx);
            "entry removed"
        }
    };
    let body = join(&next);
    if body.len() as f64 > js::js_to_number(&limit) {
        return V::object(vec![
            ("ok", false.into()),
            (
                "error",
                format!(
                    "memory would exceed limit ({}/{} chars); replace or remove entries first",
                    body.len(),
                    js::js_to_string(&limit).to_string_lossy()
                )
                .into(),
            ),
            (
                "usage",
                V::object(vec![
                    ("chars", (join(&original).len() as f64).into()),
                    ("limit", limit),
                ]),
            ),
            ("entries", entry_list(original)),
        ]);
    }
    match write(file, &body.utf8_lossy_bytes()) {
        Ok(()) => success(file, next, limit, msg),
        Err(e) => error(format!("memory write failed: {e}")),
    }
}
