//! 远程 CLI（Remote CLI）WSS 图片附件透传公共模块。
//!
//! 解决「Client 上传图片在 Client 本机临时目录（`multicc_<ts>_<hex><ext>`）或工作区内，
//! Host 侧远程 CLI 无法直接读取 Client 磁盘」的问题：
//! - Client 侧从 prompt 文本中提取引用的图片路径，严格校验只允许读取：
//!   1. OS 临时目录（`std::env::temp_dir()`）下文件名以 `multicc_` 开头的文件；
//!   2. 严格位于 Client 工作区 `local_root` 内（canonicalize 防符号链接逃逸）的图片文件。
//! - 限制单张 ≤ 5 MiB、总计 ≤ 12 MiB、最多 8 张，仅允许 png/jpeg/gif/webp 四种视觉模型通用格式；
//! - Host 侧：
//!   * Claude Code：经 `--input-format stream-json` 原生多模态 `image` base64 块传入（零落盘）；
//!   * Codex：解包到本回合隔离临时目录并通过 `turn/start` 的 `localImage` 输入项传入（回合结束自动清理）；
//!   * Agy：解包到本回合隔离临时目录并随提示改写路径（回合结束自动清理）。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const MAX_RELAY_IMAGE_COUNT: usize = 8;
pub const MAX_RELAY_IMAGE_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_RELAY_TOTAL_IMAGE_BYTES: usize = 12 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayImageAttachment {
    pub client_path: String,
    pub name: String,
    pub media_type: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedImageAttachment {
    pub client_path: String,
    pub name: String,
    pub media_type: String,
    pub data_base64: String,
    pub bytes: Vec<u8>,
}

/// Host 侧本回合临时落盘的图片附件，离开作用域自动清理整个临时子目录。
pub struct StagedAttachments {
    dir: PathBuf,
    entries: Vec<(String, PathBuf)>,
}

impl StagedAttachments {
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn entries(&self) -> &[(String, PathBuf)] {
        &self.entries
    }
}

impl Drop for StagedAttachments {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub fn image_media_type_for_path(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

pub fn extension_for_media_type(media_type: &str) -> Option<&'static str> {
    match media_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

fn trim_token_delimiters(raw: &str) -> &str {
    raw.trim_matches(|c: char| {
        matches!(
            c,
            '"' | '\'' | '`' | '(' | ')' | '[' | ']' | '<' | '>' | ',' | ';' | '，' | '。'
        )
    })
}

fn extract_candidate_tokens(prompt: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |raw: &str| {
        let cleaned = trim_token_delimiters(raw.trim());
        let cleaned = cleaned.strip_prefix("file://").unwrap_or(cleaned);
        if cleaned.is_empty() || cleaned.contains("://") {
            return;
        }
        if image_media_type_for_path(Path::new(cleaned)).is_none() {
            return;
        }
        if seen.insert(cleaned.to_string()) {
            out.push(cleaned.to_string());
        }
    };

    // 1) Markdown 链接/图片 `![alt](path)` 与 `[label](path)`
    let mut rest = prompt;
    while let Some(open) = rest.find("](") {
        let after = &rest[open + 2..];
        if let Some(close) = after.find(')') {
            let inner = after[..close].trim();
            // 去掉可选标题 `path "title"`
            let target = inner.split_whitespace().next().unwrap_or("");
            push(target);
            rest = &after[close + 1..];
        } else {
            break;
        }
    }

    // 2) 空白分隔的独立路径 token（包括 Web/App `/api/upload` 拼进正文的 `/tmp/multicc_*.png`）
    for token in prompt.split_whitespace() {
        push(token);
        if let Some((_, after_colon)) = token.split_once('：') {
            push(after_colon);
        }
    }

    out
}

fn is_allowed_client_image(
    canonical: &Path,
    canonical_root: Option<&Path>,
    canonical_tmp: Option<&Path>,
) -> bool {
    if let Some(root) = canonical_root {
        if canonical.starts_with(root) {
            return true;
        }
    }
    if let Some(tmp) = canonical_tmp {
        if canonical.starts_with(tmp) {
            if let Some(name) = canonical.file_name().and_then(|s| s.to_str()) {
                if name.starts_with("multicc_") {
                    return true;
                }
            }
        }
    }
    false
}

/// Client 侧扫描 prompt 中引用的安全图片路径，读取并编码为 base64 附件列表。
pub fn collect_prompt_image_attachments(
    prompt: &str,
    local_root: &Path,
) -> Vec<RelayImageAttachment> {
    collect_prompt_image_attachments_with_temp(prompt, local_root, &std::env::temp_dir())
}

pub fn collect_prompt_image_attachments_with_temp(
    prompt: &str,
    local_root: &Path,
    temp_dir: &Path,
) -> Vec<RelayImageAttachment> {
    let canonical_root = std::fs::canonicalize(local_root).ok();
    let canonical_tmp = std::fs::canonicalize(temp_dir).ok();
    let mut attachments = Vec::new();
    let mut seen_canonical = HashSet::new();
    let mut total_bytes: usize = 0;

    for raw in extract_candidate_tokens(prompt) {
        if attachments.len() >= MAX_RELAY_IMAGE_COUNT {
            break;
        }
        let candidate = PathBuf::from(&raw);
        let resolved = if candidate.is_absolute() {
            candidate
        } else {
            local_root.join(&candidate)
        };
        let Ok(canonical) = std::fs::canonicalize(&resolved) else {
            continue;
        };
        if !canonical.is_file() {
            continue;
        }
        if !is_allowed_client_image(
            &canonical,
            canonical_root.as_deref(),
            canonical_tmp.as_deref(),
        ) {
            continue;
        }
        let Some(media_type) = image_media_type_for_path(&canonical) else {
            continue;
        };
        if !seen_canonical.insert(canonical.clone()) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&canonical) else {
            continue;
        };
        let len = meta.len() as usize;
        if len == 0
            || len > MAX_RELAY_IMAGE_BYTES
            || total_bytes.saturating_add(len) > MAX_RELAY_TOTAL_IMAGE_BYTES
        {
            continue;
        }
        let Ok(bytes) = std::fs::read(&canonical) else {
            continue;
        };
        if bytes.is_empty()
            || bytes.len() > MAX_RELAY_IMAGE_BYTES
            || total_bytes.saturating_add(bytes.len()) > MAX_RELAY_TOTAL_IMAGE_BYTES
        {
            continue;
        }
        total_bytes += bytes.len();
        let name = canonical
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("image")
            .to_string();
        attachments.push(RelayImageAttachment {
            client_path: raw,
            name,
            media_type: media_type.to_string(),
            data_base64: BASE64.encode(&bytes),
        });
    }

    attachments
}

/// Host 侧从 WSS `start` 帧解析并严格校验图片附件（白名单 MIME + 解码大小限额）。
pub fn parse_start_attachments(start_val: &Value) -> Vec<DecodedImageAttachment> {
    let Some(items) = start_val.get("attachments").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut total_bytes: usize = 0;

    for item in items.iter().take(MAX_RELAY_IMAGE_COUNT) {
        let Some(media_type) = item.get("mediaType").and_then(Value::as_str) else {
            continue;
        };
        if extension_for_media_type(media_type).is_none() {
            continue;
        }
        let Some(b64) = item.get("dataBase64").and_then(Value::as_str) else {
            continue;
        };
        if b64.is_empty() || b64.len() > (MAX_RELAY_IMAGE_BYTES * 4 / 3 + 64) {
            continue;
        }
        let Ok(bytes) = BASE64.decode(b64) else {
            continue;
        };
        if bytes.is_empty()
            || bytes.len() > MAX_RELAY_IMAGE_BYTES
            || total_bytes.saturating_add(bytes.len()) > MAX_RELAY_TOTAL_IMAGE_BYTES
        {
            continue;
        }
        total_bytes += bytes.len();
        let client_path = item
            .get("clientPath")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("image")
            .to_string();
        out.push(DecodedImageAttachment {
            client_path,
            name,
            media_type: media_type.to_string(),
            data_base64: b64.to_string(),
            bytes,
        });
    }
    out
}

/// 构造 Claude Code `--input-format stream-json` 单条多模态 user 消息 NDJSON 行（零落盘）。
pub fn build_claude_stream_json_user_line(
    prompt: &str,
    attachments: &[DecodedImageAttachment],
) -> String {
    let mut content = Vec::with_capacity(attachments.len() + 1);
    content.push(json!({ "type": "text", "text": prompt }));
    for att in attachments {
        content.push(json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": att.media_type,
                "data": att.data_base64,
            }
        }));
    }
    json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": content,
        }
    })
    .to_string()
}

/// Host 侧将图片解包到本回合临时目录（供 Codex `localImage` 等需要本地文件路径的 CLI 消费）。
pub fn stage_attachments_to_dir(
    scratch_dir: &Path,
    turn_nonce: &str,
    attachments: &[DecodedImageAttachment],
) -> Result<StagedAttachments, String> {
    let safe_nonce: String = turn_nonce
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(16)
        .collect();
    let nonce = if safe_nonce.is_empty() {
        "turn".to_string()
    } else {
        safe_nonce
    };
    let dir = scratch_dir.join(".multicc-relay-attachments").join(nonce);
    std::fs::create_dir_all(&dir).map_err(|err| format!("创建临时附件目录失败: {err}"))?;
    let mut entries = Vec::with_capacity(attachments.len());
    for (idx, att) in attachments.iter().enumerate() {
        let ext = extension_for_media_type(&att.media_type).unwrap_or("bin");
        let target = dir.join(format!("img_{idx}.{ext}"));
        std::fs::write(&target, &att.bytes)
            .map_err(|err| format!("写入临时图片附件失败: {err}"))?;
        entries.push((att.client_path.clone(), target));
    }
    Ok(StagedAttachments { dir, entries })
}

/// 将 prompt 中的 Client 图片路径替换为 Host 临时路径，并附注已附带的视觉图片说明。
pub fn rewrite_prompt_with_staged_paths(prompt: &str, staged: &StagedAttachments) -> String {
    let mut out = prompt.to_string();
    for (client_path, host_path) in staged.entries() {
        if !client_path.is_empty() {
            out = out.replace(client_path, &host_path.to_string_lossy());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "multicc-relay-att-test-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn collects_uploaded_temp_and_workspace_images_while_blocking_outside_files() {
        let base = temp_root("collect");
        let ws = base.join("ws");
        let fake_tmp = base.join("tmp");
        let outside = base.join("outside");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&fake_tmp).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let uploaded = fake_tmp.join("multicc_1700000000_abcd.png");
        let other_tmp = fake_tmp.join("secret.png");
        let ws_img = ws.join("shot.webp");
        let outside_img = outside.join("private.png");
        std::fs::write(&uploaded, PNG_1X1).unwrap();
        std::fs::write(&other_tmp, PNG_1X1).unwrap();
        std::fs::write(&ws_img, PNG_1X1).unwrap();
        std::fs::write(&outside_img, PNG_1X1).unwrap();

        let prompt = format!(
            "看这几张图 {} ![ws](shot.webp) {} {}",
            uploaded.display(),
            other_tmp.display(),
            outside_img.display()
        );
        let collected = collect_prompt_image_attachments_with_temp(&prompt, &ws, &fake_tmp);
        assert_eq!(collected.len(), 2);
        assert_eq!(collected[0].media_type, "image/webp");
        assert_eq!(collected[1].media_type, "image/png");
        assert_eq!(collected[1].name, "multicc_1700000000_abcd.png");

        let start = json!({ "type": "start", "attachments": collected });
        let parsed = parse_start_attachments(&start);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].bytes, PNG_1X1);

        let claude_line = build_claude_stream_json_user_line("分析图片", &parsed);
        let claude_val: Value = serde_json::from_str(&claude_line).unwrap();
        assert_eq!(claude_val["type"], "user");
        assert_eq!(
            claude_val["message"]["content"].as_array().unwrap().len(),
            3
        );
        assert_eq!(claude_val["message"]["content"][1]["type"], "image");
        assert_eq!(
            claude_val["message"]["content"][1]["source"]["type"],
            "base64"
        );

        let staged_dir;
        {
            let staged = stage_attachments_to_dir(&base, "nonce123", &parsed).unwrap();
            staged_dir = staged.dir().to_path_buf();
            assert!(staged.entries()[0].1.is_file());
            let rewritten = rewrite_prompt_with_staged_paths(&prompt, &staged);
            assert!(rewritten.contains(&staged.entries()[1].1.to_string_lossy().to_string()));
        }
        assert!(
            !staged_dir.exists(),
            "RAII Drop must clean up staged images"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn parse_start_attachments_rejects_bad_mime_and_invalid_base64() {
        let start = json!({
            "attachments": [
                { "clientPath": "/a.svg", "name": "a.svg", "mediaType": "image/svg+xml", "dataBase64": BASE64.encode(b"<svg/>") },
                { "clientPath": "/b.png", "name": "b.png", "mediaType": "image/png", "dataBase64": "!!!not-base64!!!" },
                { "clientPath": "/c.png", "name": "c.png", "mediaType": "image/png", "dataBase64": BASE64.encode(PNG_1X1) }
            ]
        });
        let parsed = parse_start_attachments(&start);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "c.png");
    }
}
