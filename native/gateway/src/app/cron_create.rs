use multicc_core::{
    cli_switch,
    js::serde::{js_string, js_to_number, js_trim, truthy},
};
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};

fn resolved(base: &Path, value: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for c in base.join(value).components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => (),
            _ => out.push(c.as_os_str()),
        }
    }
    out
}

pub(super) fn definition(body: &Value, dirs: &[Value], cwd: &Path) -> Result<Value, &'static str> {
    let mut t = json!({"kind":if body["kind"]=="script" {"script"} else {"agent"},
        "enabled":body.get("enabled").is_none_or(truthy)});
    for (key, trim, max) in [
        ("name", true, 80),
        ("command", true, 4000),
        ("cli", true, 40),
        ("dirId", false, usize::MAX),
        ("prompt", false, usize::MAX),
        ("cron", true, usize::MAX),
        ("createdBy", false, 80),
    ] {
        if let Some(value) = body.get(key) {
            let raw = js_string(value);
            let raw = if trim { js_trim(&raw) } else { &raw };
            let units = raw.encode_utf16().take(max).collect::<Vec<_>>();
            t[key] = String::from_utf16_lossy(&units).into();
        }
    }
    if !truthy(&body["cli"]) || !truthy(&t["cli"]) {
        t["cli"] = "claude".into();
    }
    if !truthy(&t["createdBy"]) {
        t["createdBy"] = "user".into();
    }
    if let Some(value) = body.get("scriptTimeoutMs") {
        let ms = js_to_number(value).floor();
        t["scriptTimeoutMs"] =
            json!((ms.is_finite() && ms > 0.0).then(|| ms.min(3600000.0) as i64));
    }
    if !truthy(&t["dirId"]) && truthy(&body["dirPath"]) {
        let path = resolved(cwd, &js_string(&body["dirPath"]));
        if let Some(dir) = dirs.iter().find(|dir| {
            dir["path"]
                .as_str()
                .is_some_and(|s| resolved(cwd, s) == path)
        }) {
            t["dirId"] = dir["id"].clone();
        }
    }
    if !truthy(&t["name"]) {
        return Err("任务名不能为空");
    }
    if !truthy(&t["dirId"]) || !dirs.iter().any(|dir| dir["id"] == t["dirId"]) {
        return Err("目标目录无效");
    }
    if t["kind"] == "script" {
        if !truthy(&t["command"]) {
            return Err("脚本命令不能为空");
        }
    } else {
        if !cli_switch::SUPPORTED_CHAT_CLIS.contains(&t["cli"].as_str().unwrap_or_default()) {
            return Err("CLI 无效");
        }
        if t["prompt"].as_str().is_none_or(|s| js_trim(s).is_empty()) {
            return Err("prompt 不能为空");
        }
    }
    let mut fields = t["cron"].as_str().unwrap_or_default().split_whitespace();
    let bounds = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)];
    if !bounds.into_iter().all(|(min, max)| {
        fields
            .next()
            .and_then(|s| super::cron_list::field(s, min, max))
            .is_some()
    }) || fields.next().is_some()
    {
        return Err("cron 表达式无效（需 5 段：分 时 日 月 周）");
    }
    Ok(t)
}

pub(super) fn reserve(root: &Path, task: &mut Value) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(task.to_string().as_bytes());
    let pending = root.join(".cron-create").join(format!("{hash:x}.json"));
    let identity = match std::fs::read(&pending) {
        Ok(bytes) => {
            serde_json::from_slice::<Value>(&bytes).map_err(|_| "invalid pending schedule")?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut entropy = [0u8; 8];
            getrandom::fill(&mut entropy).map_err(|e| e.to_string())?;
            let identity = json!({"id":format!("cron_{:012x}",u64::from_ne_bytes(entropy) & 0xffffffffffff),
                "createdAt":multicc_core::session_records::iso_timestamp_now()});
            multicc_core::state_file::write_json_atomic(&pending, &identity)
                .map_err(|e| e.to_string())?;
            identity
        }
        Err(e) => return Err(e.to_string()),
    };
    for k in ["id", "createdAt"] {
        task[k] = json!(identity[k].as_str().ok_or("invalid pending schedule")?);
    }
    Ok(pending)
}
