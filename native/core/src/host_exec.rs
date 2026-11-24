//! CLI-agnostic Host-Exec 协议内核（真机执行守护 + 远端 stdio MCP 桥接）。
//!
//! 复用于所有「远端/容器大脑 + 真实开发机手脚」车道（首期 `agy`，后续直接扩展至
//! Claude Code / Codex / Gemini）：
//! - 严格路径映射与工作区越狱防护（`map_remote_to_local_cwd` / `map_remote_to_local_path`）；
//! - 恒定时间 Bearer Token 鉴权（`verify_bearer_token`）；
//! - 输出截断（UTF-8 安全边界）；
//! - 生成零依赖、无密钥落盘的远端 stdio MCP 桥接脚本（从父进程环境变量读取回连 URL 与 Token）。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use subtle::ConstantTimeEq;

pub const MAX_OUTPUT_BYTES: usize = 128 * 1024;
pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;
pub const MAX_TIMEOUT_MS: u64 = 600_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostExecRequest {
    pub command: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostExecResponse {
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub resolved_cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostFsReadRequest {
    pub path: String,
    #[serde(default)]
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostFsWriteRequest {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostFsEditRequest {
    pub path: String,
    pub old_text: String,
    pub new_text: String,
    #[serde(default)]
    pub replace_all: bool,
}

/// 在纯文本内容上执行精确字符串替换（默认要求唯一匹配，防止误改）。
pub fn apply_fs_edit(
    content: &str,
    old_text: &str,
    new_text: &str,
    replace_all: bool,
) -> Result<(String, usize), String> {
    if old_text.is_empty() {
        return Err("old_text 不能为空".to_string());
    }
    let count = content.matches(old_text).count();
    if count == 0 {
        return Err("未在目标文件中找到匹配的 old_text".to_string());
    }
    if !replace_all && count > 1 {
        return Err(format!(
            "在目标文件中匹配到 {count} 处 old_text，请提供更长上下文或设置 replace_all=true"
        ));
    }
    if replace_all {
        Ok((content.replace(old_text, new_text), count))
    } else {
        Ok((content.replacen(old_text, new_text, 1), 1))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostFsListRequest {
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostViewImageRequest {
    pub path: String,
}

/// 恒定时间校验原始密钥头（如 `x-multicc-router-capability`）。
pub fn verify_raw_token(actual: Option<&str>, expected: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    let Some(token) = actual.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    if token.len() != expected.len() {
        return false;
    }
    bool::from(token.as_bytes().ct_eq(expected.as_bytes()))
}

/// 恒定时间校验 `Authorization: Bearer <token>`。
pub fn verify_bearer_token(header: Option<&str>, expected: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    let Some(raw) = header.map(str::trim) else {
        return false;
    };
    let Some(token) = raw
        .strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))
        .map(str::trim)
    else {
        return false;
    };
    verify_raw_token(Some(token), expected)
}

/// 词法规范化路径（不依赖磁盘存在性），禁止 `..` 越过根路径。
pub fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

fn strip_prefix_normalized(path: &str, root: &str) -> Option<String> {
    let norm_p = path.trim_end_matches(['/', '\\']);
    let norm_r = root.trim_end_matches(['/', '\\']);
    if norm_r.is_empty() {
        return None;
    }
    if norm_p == norm_r {
        return Some(String::new());
    }
    let rest = norm_p
        .strip_prefix(norm_r)
        .filter(|tail| tail.starts_with('/') || tail.starts_with('\\'))?;
    Some(rest.trim_start_matches(['/', '\\']).to_string())
}

/// 把远端路径、真机路径或相对路径安全映射到 `local_root` 内部。
/// 拒绝任何企图逃出 `local_root` 的路径（含 `..` 遍历和外部绝对路径）。
pub fn map_remote_to_local_path(
    requested: Option<&str>,
    remote_root: &str,
    local_root: &Path,
) -> Result<PathBuf, String> {
    let base = lexical_normalize(local_root);
    let raw = requested.map(str::trim).filter(|s| !s.is_empty());
    let Some(raw) = raw else {
        return Ok(base);
    };

    let candidate = if let Some(rel) = strip_prefix_normalized(raw, remote_root) {
        if rel.is_empty() {
            base.clone()
        } else {
            base.join(rel)
        }
    } else if let Some(rel) = strip_prefix_normalized(raw, &base.to_string_lossy()) {
        if rel.is_empty() {
            base.clone()
        } else {
            base.join(rel)
        }
    } else if Path::new(raw).is_absolute() {
        return Err(format!("路径越界：不允许访问工作区之外的路径 ({raw})"));
    } else {
        base.join(raw)
    };

    let normalized = lexical_normalize(&candidate);
    if !normalized.starts_with(&base) {
        return Err(format!("路径越界：目标路径超出工作区根目录 ({raw})"));
    }
    Ok(normalized)
}

/// 映射命令执行目录（与路径映射规则一致）。
pub fn map_remote_to_local_cwd(
    requested_cwd: Option<&str>,
    remote_root: &str,
    local_root: &Path,
) -> Result<PathBuf, String> {
    map_remote_to_local_path(requested_cwd, remote_root, local_root)
}

/// 安全截断字节输出到 `max_bytes`，确保 UTF-8 字符边界完整。
pub fn truncate_utf8_bytes(bytes: &[u8], max_bytes: usize) -> String {
    if bytes.len() <= max_bytes {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let slice = &bytes[..max_bytes];
    let text = String::from_utf8_lossy(slice);
    format!(
        "{text}\n...[output truncated: {} total bytes, showing first {} bytes]",
        bytes.len(),
        max_bytes
    )
}

pub fn clamp_timeout_ms(requested: Option<u64>) -> u64 {
    requested
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1_000, MAX_TIMEOUT_MS)
}

/// 生成部署在远端 VPS 上的零依赖 Node.js stdio MCP 桥接脚本（`multicc_host_exec`）。
///
/// 凭据与回连地址全部通过父进程环境变量传入（`MULTICC_HOST_EXEC_URL` /
/// `MULTICC_HOST_EXEC_TOKEN` 等），脚本本身不含任何密钥，支持多台开发机并发共享同一
/// `mcp_config.json` 而零串机、零覆盖。
pub fn render_remote_mcp_script() -> &'static str {
    r#"#!/usr/bin/env node
'use strict';

const readline = require('readline');

const BASE_URL = String(process.env.MULTICC_HOST_EXEC_URL || '').replace(/\/+$/, '');
const TOKEN = String(process.env.MULTICC_HOST_EXEC_TOKEN || '');
const LOCAL_ROOT = String(process.env.MULTICC_HOST_EXEC_LOCAL_ROOT || '');
const REMOTE_ROOT = String(process.env.MULTICC_HOST_EXEC_REMOTE_ROOT || '');
const HOST_OS = String(process.env.MULTICC_HOST_EXEC_OS || 'unknown');
const FILE_MODE = String(process.env.MULTICC_HOST_EXEC_FILE_MODE || 'mutagen');

const TOOLS = [
  {
    name: 'host_run_command',
    description:
      'Execute a shell command on the user\'s REAL local development machine (' + HOST_OS + '). ' +
      'Built-in run_command is disabled because this agent runs remotely; always use this tool for builds, tests, git, package managers, and local probes.',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Shell command to execute on the real host machine.' },
        cwd: { type: 'string', description: 'Optional working directory (relative to workspace root, or mapped workspace path).' },
        timeout_seconds: { type: 'number', description: 'Optional timeout in seconds (1-600, default 120).' },
      },
    },
  },
  {
    name: 'host_info',
    description: 'Return real host machine OS, workspace root mapping, and file sync mode.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'host_view_image',
    description: 'Inspect an image file (png/jpeg/gif/webp) from the user\'s real local machine and return it as a native multimodal image block.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Image path relative to workspace root, absolute workspace path, or $TMPDIR/multicc_* screenshot.' },
      },
    },
  },
];

if (FILE_MODE === 'remote_mcp') {
  TOOLS.push(
    {
      name: 'host_read_file',
      description: 'Read a file directly from the user\'s real local machine workspace (zero-disk mode).',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'File path relative to workspace root or absolute workspace path.' },
          max_bytes: { type: 'integer', description: 'Optional byte limit (default 131072).' },
        },
      },
    },
    {
      name: 'host_write_file',
      description: 'Write or overwrite a file directly on the user\'s real local machine workspace (zero-disk mode).',
      inputSchema: {
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: 'File path relative to workspace root or absolute workspace path.' },
          content: { type: 'string', description: 'Full UTF-8 file content to write.' },
        },
      },
    },
    {
      name: 'host_list_dir',
      description: 'List directory entries directly on the user\'s real local machine workspace (zero-disk mode).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional directory path relative to workspace root.' },
        },
      },
    },
  );
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function postHost(endpoint, payload) {
  if (!BASE_URL || !TOKEN) {
    throw new Error('MULTICC_HOST_EXEC_URL / MULTICC_HOST_EXEC_TOKEN not configured in environment');
  }
  const resp = await fetch(BASE_URL + endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + TOKEN,
    },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { ok: false, error: text || ('HTTP ' + resp.status) }; }
  if (!resp.ok && json.ok !== false) json.ok = false;
  return json;
}

async function handleToolCall(name, args) {
  const input = (args && typeof args === 'object') ? args : {};
  if (name === 'host_info') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          hostOs: HOST_OS,
          localRoot: LOCAL_ROOT,
          remoteRoot: REMOTE_ROOT,
          fileMode: FILE_MODE,
        }, null, 2),
      }],
    };
  }
  if (name === 'host_run_command') {
    const timeoutMs = Number.isFinite(Number(input.timeout_seconds))
      ? Math.max(1000, Math.min(600000, Math.round(Number(input.timeout_seconds) * 1000)))
      : undefined;
    const res = await postHost('/exec', {
      command: String(input.command || ''),
      cwd: input.cwd ? String(input.cwd) : undefined,
      timeoutMs,
    });
    const header = res.timedOut
      ? 'Command timed out after ' + res.durationMs + 'ms (cwd: ' + (res.resolvedCwd || LOCAL_ROOT) + ')'
      : 'Exit code: ' + (res.exitCode == null ? 'unknown' : res.exitCode) + ' (' + (res.durationMs || 0) + 'ms, cwd: ' + (res.resolvedCwd || LOCAL_ROOT) + ')';
    const parts = [header];
    if (res.error) parts.push('Error: ' + res.error);
    if (res.stdout) parts.push('--- stdout ---\n' + res.stdout);
    if (res.stderr) parts.push('--- stderr ---\n' + res.stderr);
    return {
      isError: !res.ok || (res.exitCode !== 0 && res.exitCode != null) || !!res.timedOut,
      content: [{ type: 'text', text: parts.join('\n') }],
    };
  }
  if (name === 'host_read_file') {
    const res = await postHost('/fs/read', {
      path: String(input.path || ''),
      maxBytes: input.max_bytes ? Number(input.max_bytes) : undefined,
    });
    return {
      isError: !res.ok,
      content: [{ type: 'text', text: res.ok ? String(res.content || '') : ('Error: ' + (res.error || 'read failed')) }],
    };
  }
  if (name === 'host_write_file') {
    const res = await postHost('/fs/write', {
      path: String(input.path || ''),
      content: String(input.content || ''),
    });
    return {
      isError: !res.ok,
      content: [{ type: 'text', text: res.ok ? ('Wrote ' + (res.bytes || 0) + ' bytes to ' + res.path) : ('Error: ' + (res.error || 'write failed')) }],
    };
  }
  if (name === 'host_list_dir') {
    const res = await postHost('/fs/list', {
      path: input.path ? String(input.path) : undefined,
    });
    return {
      isError: !res.ok,
      content: [{ type: 'text', text: res.ok ? JSON.stringify(res.entries || [], null, 2) : ('Error: ' + (res.error || 'list failed')) }],
    };
  }
  if (name === 'host_view_image') {
    const res = await postHost('/fs/view_image', {
      path: String(input.path || ''),
    });
    if (!res.ok) {
      return { isError: true, content: [{ type: 'text', text: 'Error: ' + (res.error || 'view_image failed') }] };
    }
    return {
      content: [
        { type: 'text', text: 'Viewed image ' + (res.path || '') + ' (' + res.mediaType + ', ' + (res.bytes || 0) + ' bytes)' },
        { type: 'image', data: String(res.dataBase64 || ''), mimeType: String(res.mediaType || 'image/png') },
      ],
    };
  }
  return { isError: true, content: [{ type: 'text', text: 'Unknown tool: ' + name }] };
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let chain = Promise.resolve();
async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  if (msg.id === undefined || msg.id === null) return;
  try {
    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'multicc-host-exec', version: '1.0.0' },
        },
      });
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === 'tools/call') {
      const params = msg.params || {};
      const result = await handleToolCall(params.name, params.arguments);
      send({ jsonrpc: '2.0', id: msg.id, result });
    } else if (msg.method === 'ping') {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
    }
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { isError: true, content: [{ type: 'text', text: 'Host exec bridge error: ' + (err && err.message ? err.message : String(err)) }] },
    });
  }
}
rl.on('line', (line) => {
  chain = chain.then(() => handleLine(line));
});
"#
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_verification_is_strict() {
        assert!(verify_bearer_token(Some("Bearer secret123"), "secret123"));
        assert!(verify_bearer_token(Some("bearer secret123"), "secret123"));
        assert!(!verify_bearer_token(Some("Bearer wrong"), "secret123"));
        assert!(!verify_bearer_token(Some("Basic secret123"), "secret123"));
        assert!(!verify_bearer_token(None, "secret123"));
        assert!(!verify_bearer_token(Some("Bearer "), ""));
        assert!(verify_raw_token(Some("cap_tok_abc"), "cap_tok_abc"));
        assert!(!verify_raw_token(Some("cap_tok_xyz"), "cap_tok_abc"));
        assert!(!verify_raw_token(Some(""), "cap_tok_abc"));
        assert!(!verify_raw_token(Some("cap_tok_abc"), ""));
    }

    #[test]
    fn path_mapping_handles_remote_local_relative_and_blocks_escape() {
        let local = Path::new("/Users/dev/project");
        let remote = "/home/ubuntu/.multicc-remote/workspaces/m1/abcd";

        assert_eq!(
            map_remote_to_local_cwd(None, remote, local).unwrap(),
            PathBuf::from("/Users/dev/project")
        );
        assert_eq!(
            map_remote_to_local_cwd(Some(remote), remote, local).unwrap(),
            PathBuf::from("/Users/dev/project")
        );
        assert_eq!(
            map_remote_to_local_cwd(Some(&format!("{remote}/src/app")), remote, local).unwrap(),
            PathBuf::from("/Users/dev/project/src/app")
        );
        assert_eq!(
            map_remote_to_local_cwd(Some("native/core"), remote, local).unwrap(),
            PathBuf::from("/Users/dev/project/native/core")
        );
        assert_eq!(
            map_remote_to_local_cwd(Some("/Users/dev/project/tests"), remote, local).unwrap(),
            PathBuf::from("/Users/dev/project/tests")
        );

        // Escape attempts MUST fail closed
        assert!(map_remote_to_local_cwd(Some("../../etc"), remote, local).is_err());
        assert!(map_remote_to_local_cwd(Some("/etc/passwd"), remote, local).is_err());
        assert!(
            map_remote_to_local_cwd(Some(&format!("{remote}/../../secret")), remote, local)
                .is_err()
        );
    }

    #[test]
    fn utf8_truncation_keeps_valid_string() {
        let s = "你好世界abcdef";
        let truncated = truncate_utf8_bytes(s.as_bytes(), 7);
        assert!(truncated.contains("output truncated"));
        assert_eq!(truncate_utf8_bytes(b"hello", 10), "hello");
    }

    #[test]
    fn apply_fs_edit_enforces_uniqueness_unless_replace_all() {
        assert_eq!(
            apply_fs_edit("foo bar baz", "bar", "BAR", false).unwrap(),
            ("foo BAR baz".to_string(), 1)
        );
        assert!(apply_fs_edit("foo foo", "foo", "bar", false).is_err());
        assert_eq!(
            apply_fs_edit("foo foo", "foo", "bar", true).unwrap(),
            ("bar bar".to_string(), 2)
        );
        assert!(apply_fs_edit("hello", "missing", "x", false).is_err());
        assert!(apply_fs_edit("hello", "", "x", false).is_err());
    }
}
