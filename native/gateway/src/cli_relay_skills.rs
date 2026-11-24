//! 远程 CLI（Remote CLI）的 Client Skills 发现与只读索引透传模块。
//!
//! 遵循「说明书进大脑，脚本与工具留本机」原则：
//! - Client 在回合启动时扫描项目级（`.claude/skills`、`.agents/skills`、`skills`）与用户级
//!   （`~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills`、`~/.gemini/skills`）下的 `SKILL.md`；
//! - 解析顶部 YAML frontmatter 提取 `name` 与 `description`，生成轻量级索引随 WSS `start` 帧下发；
//! - 远端模型命中某个 Skill 时，按需调用 `multicc_host_exec` 的 `host_read_file` 读取完整 `SKILL.md`
//!   及 `references/*`（Client `host_exec` 已对上述 Skills 根目录开放严格只读白名单），并通过
//!   `host_run_command` 在 Client 真机运行 `scripts/*` 或本机 CLI。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_RELAY_SKILLS: usize = 80;
pub const MAX_SKILL_DESC_CHARS: usize = 260;
const MAX_SKILL_MD_HEAD_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelaySkillSummary {
    pub name: String,
    pub description: String,
    pub skill_md_path: String,
    pub skill_dir: String,
}

pub fn client_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// 返回 Client 侧允许 `host_read_file` / `host_list_dir` 严格只读访问的全局 Skills 目录列表。
pub fn default_readonly_skill_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(extra) = std::env::var("MULTICC_HOST_EXEC_READONLY_DIRS") {
        let sep = if cfg!(windows) { ';' } else { ':' };
        for part in extra.split(sep) {
            let trimmed = part.trim();
            if !trimmed.is_empty() {
                if let Ok(canon) = std::fs::canonicalize(trimmed) {
                    if canon.is_dir() && !roots.contains(&canon) {
                        roots.push(canon);
                    }
                }
            }
        }
    }
    if let Some(home) = client_home_dir() {
        for rel in [
            ".agents/skills",
            ".claude/skills",
            ".codex/skills",
            ".gemini/skills",
        ] {
            let candidate = home.join(rel);
            if let Ok(canon) = std::fs::canonicalize(&candidate) {
                if canon.is_dir() && !roots.contains(&canon) {
                    roots.push(canon);
                }
            }
        }
    }
    roots
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let collapsed: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max_chars {
        return collapsed;
    }
    let prefix: String = collapsed.chars().take(max_chars).collect();
    format!("{prefix}…")
}

fn strip_yaml_quotes(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        return trimmed[1..trimmed.len() - 1].trim().to_string();
    }
    trimmed.to_string()
}

/// 解析 `SKILL.md` 顶部的 YAML frontmatter，提取 `(name, description)`。
pub fn parse_skill_frontmatter(markdown: &str, fallback_name: &str) -> (String, String) {
    let trimmed = markdown.trim_start_matches('\u{feff}').trim_start();
    let Some(after_open) = trimmed
        .strip_prefix("---\n")
        .or_else(|| trimmed.strip_prefix("---\r\n"))
    else {
        let first_line = trimmed
            .lines()
            .find(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
            .unwrap_or("");
        return (
            fallback_name.to_string(),
            truncate_chars(first_line, MAX_SKILL_DESC_CHARS),
        );
    };

    let end_idx = after_open
        .find("\n---")
        .or_else(|| after_open.find("\r\n---"));
    let Some(end) = end_idx else {
        return (fallback_name.to_string(), String::new());
    };
    let block = &after_open[..end];

    let mut name: Option<String> = None;
    let mut desc = String::new();
    let mut in_multiline_desc = false;

    for line in block.lines() {
        if in_multiline_desc {
            if line.starts_with(' ') || line.starts_with('\t') {
                if !desc.is_empty() {
                    desc.push(' ');
                }
                desc.push_str(line.trim());
                continue;
            }
            in_multiline_desc = false;
        }
        let clean = line.trim();
        if clean.is_empty() || clean.starts_with('#') {
            continue;
        }
        if let Some(rest) = clean.strip_prefix("name:") {
            let val = strip_yaml_quotes(rest);
            if !val.is_empty() {
                name = Some(val);
            }
        } else if let Some(rest) = clean.strip_prefix("description:") {
            let val = rest.trim();
            if matches!(val, "|" | "|-" | "|+" | ">" | ">-" | ">+") || val.is_empty() {
                in_multiline_desc = true;
            } else {
                desc = strip_yaml_quotes(val);
            }
        }
    }

    let final_name = name
        .filter(|s| !s.is_empty() && s.len() <= 80 && !s.chars().any(char::is_control))
        .unwrap_or_else(|| fallback_name.to_string());
    (final_name, truncate_chars(&desc, MAX_SKILL_DESC_CHARS))
}

fn read_skill_head(path: &Path) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut buf = Vec::with_capacity(4096);
    file.take(MAX_SKILL_MD_HEAD_BYTES as u64)
        .read_to_end(&mut buf)
        .ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

pub fn collect_client_skills(local_root: &Path) -> Vec<RelaySkillSummary> {
    let mut roots = vec![
        local_root.join(".claude").join("skills"),
        local_root.join(".agents").join("skills"),
        local_root.join("skills"),
    ];
    if let Some(home) = client_home_dir() {
        roots.push(home.join(".agents").join("skills"));
        roots.push(home.join(".claude").join("skills"));
        roots.push(home.join(".codex").join("skills"));
        roots.push(home.join(".gemini").join("skills"));
    }
    collect_skills_from_roots(&roots)
}

pub fn collect_skills_from_roots(roots: &[PathBuf]) -> Vec<RelaySkillSummary> {
    let mut out = Vec::new();
    let mut seen_names = HashSet::new();
    let mut seen_dirs = HashSet::new();

    for root in roots {
        if out.len() >= MAX_RELAY_SKILLS {
            break;
        }
        let Ok(canon_root) = std::fs::canonicalize(root) else {
            continue;
        };
        if !canon_root.is_dir() || !seen_dirs.insert(canon_root.clone()) {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&canon_root) else {
            continue;
        };
        let mut entries: Vec<PathBuf> = rd.filter_map(|e| e.ok().map(|x| x.path())).collect();
        entries.sort();

        for dir in entries {
            if out.len() >= MAX_RELAY_SKILLS {
                break;
            }
            let skill_md = dir.join("SKILL.md");
            let Ok(canon_md) = std::fs::canonicalize(&skill_md) else {
                continue;
            };
            if !canon_md.is_file() {
                continue;
            }
            let Some(fallback_name) = dir
                .file_name()
                .and_then(|s| s.to_str())
                .filter(|s| !s.starts_with('.'))
            else {
                continue;
            };
            let Some(head) = read_skill_head(&canon_md) else {
                continue;
            };
            let (name, description) = parse_skill_frontmatter(&head, fallback_name);
            if !seen_names.insert(name.to_ascii_lowercase()) {
                continue;
            }
            let canon_dir = canon_md.parent().unwrap_or(&dir);
            out.push(RelaySkillSummary {
                name,
                description,
                skill_md_path: canon_md.to_string_lossy().into_owned(),
                skill_dir: canon_dir.to_string_lossy().into_owned(),
            });
        }
    }

    out
}

pub fn parse_start_skills(start_val: &Value) -> Vec<RelaySkillSummary> {
    let Some(arr) = start_val.get("skills").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in arr.iter().take(MAX_RELAY_SKILLS) {
        let clean = |key: &str, max_len: usize| -> Option<String> {
            let s = item.get(key)?.as_str()?.trim();
            if s.is_empty() || s.len() > max_len || s.chars().any(char::is_control) {
                return None;
            }
            Some(s.to_string())
        };
        let Some(name) = clean("name", 80) else {
            continue;
        };
        let Some(skill_md_path) = clean("skillMdPath", 1024) else {
            continue;
        };
        let skill_dir = clean("skillDir", 1024).unwrap_or_default();
        let description = item
            .get("description")
            .and_then(Value::as_str)
            .map(|s| truncate_chars(s, MAX_SKILL_DESC_CHARS))
            .unwrap_or_default();
        out.push(RelaySkillSummary {
            name,
            description,
            skill_md_path,
            skill_dir,
        });
    }
    out
}

pub fn format_skills_guidance(skills: &[RelaySkillSummary]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    let mut lines = Vec::with_capacity(skills.len() + 6);
    lines.push("[Available Client Skills (Read-Only via `host_read_file`, Execute Scripts via `host_run_command`)]".to_string());
    lines.push("- The skills below live on the user's REAL local machine. When a skill is relevant, FIRST call `host_read_file` with its `SKILL.md` path to read its full instructions (and `host_list_dir` / `host_read_file` for any `references/` inside its folder).".to_string());
    lines.push("- When a skill instructs running helper scripts (`scripts/*`) or local CLIs, ALWAYS run them on the user's real machine via `host_run_command`.".to_string());
    for s in skills {
        if s.description.is_empty() {
            lines.push(format!("  * `{}` (`{}`)", s.name, s.skill_md_path));
        } else {
            lines.push(format!(
                "  * `{}` (`{}`): {}",
                s.name, s.skill_md_path, s.description
            ));
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_inline_and_multiline_yaml_frontmatter_and_dedupes_project_over_user() {
        let base = std::env::temp_dir().join(format!(
            "multicc-relay-skills-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let proj = base.join("proj-skills");
        let user = base.join("user-skills");
        std::fs::create_dir_all(proj.join("demo-skill")).unwrap();
        std::fs::create_dir_all(user.join("demo-skill")).unwrap();
        std::fs::create_dir_all(user.join("local-tool")).unwrap();

        std::fs::write(
            proj.join("demo-skill").join("SKILL.md"),
            "---\nname: demo-skill\ndescription: \"Project override description\"\n---\n# Body\n",
        )
        .unwrap();
        std::fs::write(
            user.join("demo-skill").join("SKILL.md"),
            "---\nname: demo-skill\ndescription: User fallback\n---\n",
        )
        .unwrap();
        std::fs::write(
            user.join("local-tool").join("SKILL.md"),
            "---\nname: local-tool\ndescription: >-\n  Runs local helper scripts\n  on the client machine.\n---\n",
        )
        .unwrap();

        let skills = collect_skills_from_roots(&[proj, user]);
        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0].name, "demo-skill");
        assert_eq!(skills[0].description, "Project override description");
        assert_eq!(skills[1].name, "local-tool");
        assert_eq!(
            skills[1].description,
            "Runs local helper scripts on the client machine."
        );

        let parsed = parse_start_skills(&json!({ "skills": skills }));
        assert_eq!(parsed.len(), 2);
        let text = format_skills_guidance(&parsed);
        assert!(text.contains("demo-skill"));
        assert!(text.contains("host_read_file"));
        assert!(text.contains("host_run_command"));

        let _ = std::fs::remove_dir_all(&base);
    }
}
