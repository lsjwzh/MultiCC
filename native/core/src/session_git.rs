//! Rules kernel for the session/git route cluster (`src/routes/session-git.js`).
//!
//! Everything that is a *rule* over git output lives here: the `--numstat -z` /
//! `--name-status -z` diff parser, the `show --name-status -z` commit parser,
//! the `git log` line parser, the porcelain working-tree parser, path and
//! parameter validation, DTO assembly and key order, the error-text mapping and
//! the status-code decision trees for merge / sync / rebase / cleanup.
//!
//! Everything that needs the process-local world stays in Node behind the host
//! port (`src/routes/session-git-host.js`): spawning `git` (the repo actor owns
//! a runtime-patched `PATH` and the non-interactive git environment), the
//! session/directory `Map` lookups, `isChatStateBusy`, the merge-state cache and
//! the executable `gitMergeBack` / `gitSyncFromBase` / `gitRebaseResolve` flows.
//!
//! Byte-for-byte parity is the contract: every helper mirrors the retired JS,
//! including its quirks (`parseInt(...,10) || 0`, JS `slice` on UTF-16 code
//! units, `undefined` fields omitted from JSON).

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::js::string::{js_trim, utf16_len, utf16_prefix};

/// `maxDiffBytes` default (`deps.maxDiffBytes` is never set by server.js).
pub const MAX_DIFF_BYTES: usize = 1024 * 1024;
/// `patchCap` in the per-file diff routes.
pub const PATCH_CAP: usize = 256 * 1024;
/// `fileCap` in the file-list routes.
pub const FILE_CAP: usize = 500;
/// `errorText` slices stderr to 400 characters.
pub const ERROR_TEXT_CAP: usize = 400;

/// The placeholder a 1 MiB-capped diff body becomes when git's own output
/// exceeded maxBuffer.
pub const DIFF_TOO_LARGE: &str = "(diff exceeds 1MB cap — too large to display in browser)";

/// `LOADING_MERGE_STATE` (merge-status answers it on a cold cache).
pub fn loading_merge_state() -> Value {
    json!({
        "mergeReady": false,
        "dirty": false,
        "ahead": 0,
        "behind": 0,
        "reason": "loading",
    })
}

/// `parseInt(text, 10)` restricted to base 10 and ASCII digits. `None` is NaN.
pub fn parse_int10(text: &str) -> Option<i64> {
    let mut rest = text;
    // parseInt skips leading JS whitespace, then an optional sign, then digits.
    loop {
        let mut chars = rest.chars();
        match chars.next() {
            Some(ch) if crate::js::string::is_js_whitespace_char(ch) => {
                rest = &rest[ch.len_utf8()..];
            }
            _ => break,
        }
    }
    let (negative, digits) = match rest.as_bytes().first() {
        Some(b'-') => (true, &rest[1..]),
        Some(b'+') => (false, &rest[1..]),
        _ => (false, rest),
    };
    let end = digits
        .bytes()
        .position(|byte| !byte.is_ascii_digit())
        .unwrap_or(digits.len());
    if end == 0 {
        return None;
    }
    let magnitude = digits[..end].parse::<i64>().unwrap_or(i64::MAX);
    Some(if negative { -magnitude } else { magnitude })
}

/// `parseInt(text, 10) || 0`.
pub fn parse_int_or_zero(text: &str) -> i64 {
    parse_int10(text).filter(|value| *value != 0).unwrap_or(0)
}

/// `Math.min(parseInt(value, 10) || 30, 100)` for `?limit=`.
pub fn log_limit(value: &str) -> i64 {
    let parsed = parse_int10(value).unwrap_or(30);
    let parsed = if parsed == 0 { 30 } else { parsed };
    parsed.min(100)
}

/// `errorText(error)`: the first 400 characters of `stderr`, else `message`,
/// else `String(error || 'unknown error')` collapsed to its two observable
/// spellings.
pub fn error_text(stderr: Option<&str>, message: Option<&str>) -> String {
    if let Some(stderr) = stderr.filter(|text| !text.is_empty()) {
        return utf16_prefix(stderr, ERROR_TEXT_CAP);
    }
    match message {
        Some(message) if !message.is_empty() => message.to_string(),
        // `String(new Error(''))` is "Error"; a nullish error is the fallback.
        Some(_) => "Error".to_string(),
        None => "unknown error".to_string(),
    }
}

/// `isProbablyBinary`: any NUL byte in the first 8000 bytes.
pub fn is_probably_binary(sample: &[u8]) -> bool {
    sample.iter().take(8000).any(|byte| *byte == 0)
}

/// Line count of a text buffer, matching git's numstat convention (a file
/// without a trailing newline still counts its final line).
pub fn count_text_lines(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let newlines = text.bytes().filter(|byte| *byte == b'\n').count();
    newlines + usize::from(!text.ends_with('\n'))
}

/// `/^[ACDMRTUXB][0-9]*$/`.
fn is_commit_status(status: &str) -> bool {
    let mut bytes = status.bytes();
    match bytes.next() {
        Some(first) if b"ACDMRTUXB".contains(&first) => {}
        _ => return false,
    }
    bytes.all(|byte| byte.is_ascii_digit())
}

/// `parseDiffFiles(numstatZ, nameStatusZ)`: the unified file list.
pub fn parse_diff_files(numstat_z: &str, name_status_z: &str) -> Value {
    let numstat_tokens: Vec<&str> = numstat_z.split('\0').collect();
    let mut files: Vec<(String, i64, i64, bool)> = Vec::new();
    let mut i = 0usize;
    while i < numstat_tokens.len() {
        let token = numstat_tokens[i];
        if token.is_empty() {
            i += 1;
            continue;
        }
        let parts: Vec<&str> = token.split('\t').collect();
        if parts.len() < 2 {
            i += 1;
            continue;
        }
        let additions = parse_int_or_zero(parts[0]);
        let deletions = parse_int_or_zero(parts[1]);
        let path_field = parts[2..].join("\t");
        let binary = parts[0] == "-" || parts[1] == "-";
        if !path_field.is_empty() {
            files.push((path_field, additions, deletions, binary));
            i += 1;
        } else {
            // Rename: the path field is empty, the next two NUL tokens are the
            // old and the new path.
            let new_path = numstat_tokens.get(i + 2).copied().unwrap_or("");
            files.push((new_path.to_string(), additions, deletions, binary));
            i += 3;
        }
    }

    // name-status supplies the status code and oldPath for renames. A JS Map
    // keeps the last write for a repeated key; a HashMap does the same.
    let mut status_map: HashMap<&str, (char, Option<&str>)> = HashMap::new();
    let ns_tokens: Vec<&str> = name_status_z.split('\0').collect();
    let mut j = 0usize;
    while j < ns_tokens.len() {
        let token = ns_tokens[j];
        if token.is_empty() {
            j += 1;
            continue;
        }
        let first = token.chars().next().unwrap_or('\0');
        if first == 'R' || first == 'C' {
            let old_path = ns_tokens.get(j + 1).copied().unwrap_or("");
            let new_path = ns_tokens.get(j + 2).copied().unwrap_or("");
            status_map.insert(new_path, (first, Some(old_path)));
            j += 3;
        } else {
            let file_path = ns_tokens.get(j + 1).copied().unwrap_or("");
            status_map.insert(file_path, (first, None));
            j += 2;
        }
    }

    let rendered: Vec<Value> = files
        .into_iter()
        .map(|(path, additions, deletions, binary)| {
            let info = status_map.get(path.as_str());
            let status = info
                .map(|(first, _)| first.to_string())
                .unwrap_or_else(|| "M".to_string());
            let old_path = info.and_then(|(_, old)| *old).map(str::to_string);
            let old_path = match old_path {
                Some(text) => Value::String(text),
                None => Value::Null,
            };
            json!({
                "path": path,
                "oldPath": old_path,
                "status": status,
                "additions": additions,
                "deletions": deletions,
                "binary": binary,
            })
        })
        .collect();
    Value::Array(rendered)
}

/// `parseCommitFiles(raw)`.
pub fn parse_commit_files(raw: &str) -> Value {
    let trimmed = raw.trim_start_matches('\0');
    let parts: Vec<&str> = trimmed.split('\0').collect();
    let mut files: Vec<Value> = Vec::new();
    let mut i = 0usize;
    while i + 1 < parts.len() {
        let status = parts[i];
        i += 1;
        if !is_commit_status(status) {
            break;
        }
        let old_path = parts[i];
        i += 1;
        if old_path.is_empty() {
            break;
        }
        let renamed = status.starts_with('R') || status.starts_with('C');
        let path = if renamed {
            let next = parts.get(i).copied().unwrap_or("");
            i += 1;
            next
        } else {
            old_path
        };
        if path.is_empty() {
            break;
        }
        let mut object = Map::new();
        object.insert("status".into(), Value::String(status.to_string()));
        object.insert("path".into(), Value::String(path.to_string()));
        if renamed {
            object.insert("oldPath".into(), Value::String(old_path.to_string()));
        }
        files.push(Value::Object(object));
    }
    Value::Array(files)
}

/// `refs.replace(/^,\s*/, '').trim()`.
fn clean_refs(refs: &str) -> String {
    let stripped = refs.strip_prefix(',').unwrap_or(refs);
    js_trim(stripped).to_string()
}

/// `GET /api/git/log` line parsing.
pub fn parse_log_commits(raw: &str) -> Value {
    let mut commits: Vec<Value> = Vec::new();
    for line in js_trim(raw).split('\n') {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\x00').collect();
        let mut object = Map::new();
        for (index, key) in ["hash", "short", "author", "date", "subject"]
            .iter()
            .enumerate()
        {
            if let Some(value) = parts.get(index) {
                object.insert((*key).to_string(), Value::String((*value).to_string()));
            }
        }
        let refs = parts.get(5).copied().unwrap_or("");
        object.insert(
            "refs".into(),
            Value::String(if refs.is_empty() {
                String::new()
            } else {
                clean_refs(refs)
            }),
        );
        commits.push(Value::Object(object));
    }
    Value::Array(commits)
}

/// One `git status --porcelain` line into a `dirtyFiles` entry, or `None` for
/// an empty or too-short line.
pub fn dirty_file_entry(line: &str) -> Option<Value> {
    if utf16_len(line) < 4 {
        return None;
    }
    // `.slice(3)` then `.replace(/ -> /, ' → ')` (first occurrence only).
    let tail = slice_from(line, 3);
    let path = tail.replacen(" -> ", " → ", 1);
    // Session worktrees are their own git dirs; they must not read as pending
    // changes of the directory checkout.
    if path.starts_with(".multicc-worktrees/") || path.starts_with(".multicc-worktrees → ") {
        return None;
    }
    Some(json!({
        "status": js_trim(&slice_units(line, 0, 2)).to_string(),
        "path": path,
    }))
}

/// `text.slice(start)` for a non-negative code-unit start.
fn slice_from(text: &str, start: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if start >= units.len() {
        return String::new();
    }
    String::from_utf16_lossy(&units[start..])
}

/// `text.slice(start, end)`.
fn slice_units(text: &str, start: usize, end: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let end = end.min(units.len());
    if start >= end {
        return String::new();
    }
    String::from_utf16_lossy(&units[start..end])
}

/// Build the synthetic patch for an untracked text file (the retired
/// `diff --git ... new file mode ...` template). `text` is the raw file
/// contents decoded as UTF-8 by the host port.
pub fn untracked_patch(file_path: &str, text: &str) -> String {
    let mut lines = split_crlf_lines(text);
    if lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    let mut out: Vec<String> = Vec::with_capacity(lines.len() + 7);
    out.push(format!("diff --git a/{file_path} b/{file_path}"));
    out.push("new file mode 100644".to_string());
    out.push("index 0000000..0000000".to_string());
    out.push("--- /dev/null".to_string());
    out.push(format!("+++ b/{file_path}"));
    out.push(format!("@@ -0,0 +1,{} @@", lines.len()));
    for line in lines {
        out.push(format!("+{line}"));
    }
    out.join("\n")
}

/// `text.split(/\r?\n/)`.
fn split_crlf_lines(text: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = Vec::new();
    let mut start = 0usize;
    let bytes = text.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'\n' {
            let mut end = index;
            if end > start && bytes[end - 1] == b'\r' {
                end -= 1;
            }
            lines.push(&text[start..end]);
            start = index + 1;
        }
        index += 1;
    }
    lines.push(&text[start..]);
    lines
}

/// `binary files ... differ` message for an untracked binary file.
pub fn binary_patch(file_path: &str) -> String {
    format!("Binary files /dev/null and b/{file_path} differ")
}

/// `diff.length > MAX_DIFF_BYTES`, then `.slice(0, MAX_DIFF_BYTES)`.
pub fn cap_diff(diff: String) -> (String, bool) {
    if utf16_len(&diff) > MAX_DIFF_BYTES {
        (utf16_prefix(&diff, MAX_DIFF_BYTES), true)
    } else {
        (diff, false)
    }
}

/// `patch.length > PATCH_CAP`, then `.slice(0, PATCH_CAP)`.
pub fn cap_patch(patch: String) -> (String, bool) {
    if utf16_len(&patch) > PATCH_CAP {
        (utf16_prefix(&patch, PATCH_CAP), true)
    } else {
        (patch, false)
    }
}

/// `result.conflicts && result.conflicts.length`.
pub fn conflicts_len(result: &Value) -> usize {
    result
        .get("conflicts")
        .and_then(Value::as_array)
        .map_or(0, Vec::len)
}

/// `/api/sessions/:id/merge` and the task merge route:
/// `409` with conflicts, `500` for a generic git failure, else `400`.
pub fn merge_failure_status(result: &Value) -> u16 {
    if conflicts_len(result) > 0 {
        409
    } else if result.get("code").and_then(Value::as_str) == Some("git_operation_failed") {
        500
    } else {
        400
    }
}

/// `/api/sessions/:id/sync` and `.../rebase`: `409` with conflicts, else `400`.
pub fn sync_failure_status(result: &Value) -> u16 {
    if conflicts_len(result) > 0 {
        409
    } else {
        400
    }
}

/// `blockedGitResult(error)`.
pub fn blocked_git_result(error: &Value) -> Value {
    let active = error.get("code").and_then(Value::as_str) == Some("SESSION_ACTIVE");
    let mut object = Map::new();
    object.insert("ok".into(), Value::Bool(false));
    object.insert("blocked".into(), Value::Bool(true));
    object.insert(
        "reasons".into(),
        json!([if active { "active" } else { "leased" }]),
    );
    if let Some(value) = error.get("operationId") {
        object.insert("operationId".into(), value.clone());
    }
    if let Some(value) = error.get("queueDepth") {
        object.insert("queueDepth".into(), value.clone());
    }
    object.insert(
        "error".into(),
        json!(error_text(
            error.get("stderr").and_then(Value::as_str),
            error.get("message").and_then(Value::as_str),
        )),
    );
    Value::Object(object)
}

/// `failedGitResult(error)`: the two lease errors become blocked, everything
/// else is the generic git failure.
pub fn failed_git_result(error: &Value) -> Value {
    if matches!(
        error.get("code").and_then(Value::as_str),
        Some("SESSION_ACTIVE") | Some("SESSION_LEASED")
    ) {
        return blocked_git_result(error);
    }
    let mut object = Map::new();
    object.insert("ok".into(), Value::Bool(false));
    object.insert("code".into(), json!("git_operation_failed"));
    if let Some(value) = error.get("operationId") {
        object.insert("operationId".into(), value.clone());
    }
    if let Some(value) = error.get("queueDepth") {
        object.insert("queueDepth".into(), value.clone());
    }
    object.insert("error".into(), json!("Git operation failed"));
    Value::Object(object)
}

/// The 409 body `hasWorktree` answers for a hibernated workspace.
pub fn workspace_hibernated_body() -> Value {
    json!({
        "ok": false,
        "blocked": true,
        "code": "workspace_hibernated",
        "reasons": ["hibernated"],
        "workspaceState": "hibernated",
        "error": "工作区已休眠；发送消息后会自动恢复",
    })
}

/// `classifyDisplay(state).label`: the vocabulary owns the word, so a
/// re-lettered state never leaves a hand-written label behind.
pub fn classify_display_label(state: &str) -> String {
    let catalog = crate::classify_vocab::catalog_value();
    catalog
        .get("classifyDisplay")
        .and_then(|display| display.get(state).or_else(|| display.get("W")))
        .and_then(|entry| entry.get("label"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// `sessionSyncGate(sessionId)` once the two Node-side facts (`isWorktreeActive`
/// and `taskState.classifyState`) are known: `Some((state, message))` refuses
/// the sync, `None` lets it through.
pub fn sync_gate(active: bool, classify_state: Option<&str>) -> Option<(String, String)> {
    if active {
        return Some((
            "running".to_string(),
            "会话正在执行任务（进程运行中），请等待本轮结束后再同步".to_string(),
        ));
    }
    let state = classify_state.unwrap_or("");
    if crate::classify_vocab::is_processing_letter(state) || state == "B" {
        let label = classify_display_label(state);
        return Some((
            state.to_string(),
            format!("会话任务未结束（{label}，状态 {state}），请等待任务完成/暂停后再同步"),
        ));
    }
    None
}

/// `filePath.length === 0 || filePath.length > 500`.
pub fn invalid_diff_file_path(file_path: &str) -> bool {
    let length = utf16_len(file_path);
    length == 0 || length > 500
}

/// `/^[0-9a-f]{4,40}$/i`.
pub fn valid_commit_hash(hash: &str) -> bool {
    (4..=40).contains(&hash.len()) && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// `dirId` query value must be a non-empty string.
pub fn valid_dir_id(value: &str) -> bool {
    !value.is_empty()
}

/// `/api/git/directory-file-diff` path rule.
pub fn valid_directory_file_path(file_path: &str) -> bool {
    if file_path.is_empty() || utf16_len(file_path) > 4096 {
        return false;
    }
    if file_path.starts_with('-') {
        return false;
    }
    if std::path::Path::new(file_path).is_absolute() {
        return false;
    }
    if file_path.split('/').any(|segment| segment == "..") {
        return false;
    }
    true
}

/// `/api/git/commit-diff` `file` query rule: a non-empty string of at most
/// 4096 characters.
pub fn valid_commit_file_path(file_path: &str) -> bool {
    !file_path.is_empty() && utf16_len(file_path) <= 4096
}

/// `/api/sessions/:id/diff/file` path rule: `1..=500` chars, no leading dash.
pub fn diff_file_path_error(file_path: &str) -> Option<&'static str> {
    if invalid_diff_file_path(file_path) {
        Some("path required (1..500 chars)")
    } else if file_path.starts_with('-') {
        Some("path must not start with \"-\"")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diff(json: Value) -> Vec<Value> {
        let text = json.to_string();
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn numstat_and_name_status_cover_the_edges() {
        // Modified, added, deleted and a rename with numstat's empty path field.
        let numstat = "3\t1\tREADME.md\x005\t0\tsrc/new.rs\x000\t7\tsrc/gone.rs\x002\t2\t\0old name.rs\0renamed.rs\0\0";
        let name_status =
            "M\0README.md\0A\0src/new.rs\0D\0src/gone.rs\0R100\0old name.rs\0renamed.rs\0";
        let files = diff(parse_diff_files(numstat, name_status));
        assert_eq!(files.len(), 4);
        assert_eq!(
            files[0],
            json!({"path":"README.md","oldPath":null,"status":"M","additions":3,"deletions":1,"binary":false})
        );
        assert_eq!(
            files[1],
            json!({"path":"src/new.rs","oldPath":null,"status":"A","additions":5,"deletions":0,"binary":false})
        );
        assert_eq!(
            files[2],
            json!({"path":"src/gone.rs","oldPath":null,"status":"D","additions":0,"deletions":7,"binary":false})
        );
        assert_eq!(
            files[3],
            json!({"path":"renamed.rs","oldPath":"old name.rs","status":"R","additions":2,"deletions":2,"binary":false})
        );
    }

    #[test]
    fn binary_and_unicode_and_crlf_names_survive() {
        let numstat = "-\t-\tassets/logo.png\x003\t0\t目录/文件 name.rs\0";
        let name_status = "M\0assets/logo.png\0A\0目录/文件 name.rs\0";
        let files = diff(parse_diff_files(numstat, name_status));
        assert_eq!(files[0]["binary"], json!(true));
        assert_eq!(files[0]["additions"], json!(0));
        assert_eq!(files[0]["deletions"], json!(0));
        assert_eq!(files[1]["path"], json!("目录/文件 name.rs"));
        assert_eq!(files[1]["status"], json!("A"));
    }

    #[test]
    fn non_numeric_and_empty_fields_are_zero_and_path_falls_back_to_m() {
        // No name-status row => status "M"; weird numstat counters => 0.
        let files = diff(parse_diff_files("x\tq\tweird.rs\0", ""));
        assert_eq!(files[0]["additions"], json!(0));
        assert_eq!(files[0]["deletions"], json!(0));
        assert_eq!(files[0]["status"], json!("M"));
    }

    #[test]
    fn empty_diff_is_an_empty_list() {
        assert_eq!(parse_diff_files("", ""), json!([]));
        assert_eq!(parse_diff_files("\0\0", "\0"), json!([]));
    }

    #[test]
    fn paths_with_tabs_are_kept_whole() {
        // parts.slice(2).join('\t') keeps embedded tabs in the path.
        let files = diff(parse_diff_files("1\t2\ta\tb.rs\0", "M\0a\tb.rs\0"));
        assert_eq!(files[0]["path"], json!("a\tb.rs"));
    }

    #[test]
    fn commit_files_cover_rename_copy_and_the_upstream_fallback_name() {
        let raw = "\0M\0src/a.rs\0A\0src/b.rs\0R100\0old.rs\0new.rs\0C75\0src/a.rs\0src/copy.rs\0";
        let files = diff(parse_commit_files(raw));
        assert_eq!(files.len(), 4);
        assert_eq!(files[0], json!({"status":"M","path":"src/a.rs"}));
        assert_eq!(files[1], json!({"status":"A","path":"src/b.rs"}));
        assert_eq!(
            files[2],
            json!({"status":"R100","path":"new.rs","oldPath":"old.rs"})
        );
        assert_eq!(
            files[3],
            json!({"status":"C75","path":"src/copy.rs","oldPath":"src/a.rs"})
        );
    }

    #[test]
    fn commit_files_stop_at_the_first_malformed_status() {
        let files = diff(parse_commit_files("M\0a\0Z\0b\0"));
        assert_eq!(Value::Array(files), json!([{"status":"M","path":"a"}]));
        assert_eq!(parse_commit_files(""), json!([]));
    }

    #[test]
    fn log_lines_split_on_nul_and_clean_refs() {
        let raw =
            "abc123\0abc\0Ada\x002026-01-01T00:00:00+00:00\0Fix it\0, HEAD -> main, origin/main\n";
        let commits = diff(parse_log_commits(raw));
        assert_eq!(commits[0]["hash"], json!("abc123"));
        assert_eq!(commits[0]["short"], json!("abc"));
        assert_eq!(commits[0]["author"], json!("Ada"));
        assert_eq!(commits[0]["date"], json!("2026-01-01T00:00:00+00:00"));
        assert_eq!(commits[0]["subject"], json!("Fix it"));
        assert_eq!(commits[0]["refs"], json!("HEAD -> main, origin/main"));
    }

    #[test]
    fn log_lines_without_refs_keep_an_empty_string() {
        let commits = diff(parse_log_commits("abc\0a\0A\0d\0s\0"));
        assert_eq!(commits[0]["refs"], json!(""));
    }

    #[test]
    fn porcelain_lines_skip_worktrees_and_short_rows() {
        assert!(dirty_file_entry("M ").is_none());
        assert!(dirty_file_entry("?? .multicc-worktrees/x").is_none());
        assert_eq!(
            dirty_file_entry(" M src/a.rs").unwrap(),
            json!({"status":"M","path":"src/a.rs"})
        );
        // A rename gets the pretty arrow.
        assert_eq!(
            dirty_file_entry("R  old.rs -> new.rs").unwrap(),
            json!({"status":"R","path":"old.rs → new.rs"})
        );
    }

    #[test]
    fn untracked_patch_matches_the_js_template() {
        assert_eq!(
            untracked_patch("a.rs", "one\ntwo\n"),
            "diff --git a/a.rs b/a.rs\nnew file mode 100644\nindex 0000000..0000000\n--- /dev/null\n+++ b/a.rs\n@@ -0,0 +1,2 @@\n+one\n+two"
        );
        // CRLF, no trailing newline.
        assert_eq!(
            untracked_patch("a.rs", "one\r\ntwo"),
            "diff --git a/a.rs b/a.rs\nnew file mode 100644\nindex 0000000..0000000\n--- /dev/null\n+++ b/a.rs\n@@ -0,0 +1,2 @@\n+one\n+two"
        );
        // A trailing empty line is dropped; an all-empty file keeps one line.
        assert_eq!(
            untracked_patch("e.rs", "").lines().last().unwrap(),
            "@@ -0,0 +1,0 @@"
        );
    }

    #[test]
    fn status_trees_pick_the_retired_codes() {
        assert_eq!(merge_failure_status(&json!({"ok":false})), 400);
        assert_eq!(
            merge_failure_status(&json!({"ok":false,"conflicts":["a"]})),
            409
        );
        assert_eq!(
            merge_failure_status(&json!({"ok":false,"code":"git_operation_failed"})),
            500
        );
        assert_eq!(
            sync_failure_status(&json!({"ok":false,"conflicts":["a"]})),
            409
        );
        assert_eq!(sync_failure_status(&json!({"ok":false})), 400);
    }

    #[test]
    fn blocked_and_failed_results_keep_the_field_order() {
        let blocked = blocked_git_result(&json!({
            "code":"SESSION_ACTIVE","operationId":"op1","queueDepth":2,"stderr":"boom","message":"m",
        }));
        assert_eq!(
            blocked.to_string(),
            "{\"ok\":false,\"blocked\":true,\"reasons\":[\"active\"],\"operationId\":\"op1\",\"queueDepth\":2,\"error\":\"boom\"}"
        );
        let failed = failed_git_result(&json!({"code":"EOTHER","message":"m"}));
        assert_eq!(
            failed.to_string(),
            "{\"ok\":false,\"code\":\"git_operation_failed\",\"error\":\"Git operation failed\"}"
        );
        assert_eq!(
            failed_git_result(&json!({"code":"SESSION_LEASED"}))["reasons"],
            json!(["leased"])
        );
    }

    #[test]
    fn error_text_slices_stderr_to_400_code_units() {
        let long = "x".repeat(500);
        assert_eq!(error_text(Some(&long), Some("m")).len(), 400);
        assert_eq!(error_text(None, Some("message")), "message");
        assert_eq!(error_text(Some(""), Some("")), "Error");
        assert_eq!(error_text(None, None), "unknown error");
    }

    #[test]
    fn line_count_matches_numstat_convention() {
        assert_eq!(count_text_lines(""), 0);
        assert_eq!(count_text_lines("one"), 1);
        assert_eq!(count_text_lines("one\n"), 1);
        assert_eq!(count_text_lines("one\ntwo"), 2);
        assert_eq!(count_text_lines("\n"), 1);
    }

    #[test]
    fn path_rules_mirror_the_js_guards() {
        assert!(invalid_diff_file_path(""));
        assert!(invalid_diff_file_path(&"a".repeat(501)));
        assert!(!invalid_diff_file_path("src/a.rs"));
        assert_eq!(
            diff_file_path_error("-x"),
            Some("path must not start with \"-\"")
        );
        assert!(valid_commit_hash("abcd"));
        assert!(valid_commit_hash("ABCDEF"));
        assert!(!valid_commit_hash("abc"));
        assert!(!valid_commit_hash("zzzz"));
        assert!(!valid_directory_file_path("../x"));
        assert!(!valid_directory_file_path("/abs"));
        assert!(valid_directory_file_path("src/a.rs"));
        assert!(valid_commit_file_path("src/a.rs"));
        assert!(!valid_commit_file_path(""));
    }

    #[test]
    fn limit_parsing_matches_parse_int() {
        assert_eq!(log_limit("5"), 5);
        assert_eq!(log_limit("0"), 30);
        assert_eq!(log_limit("abc"), 30);
        assert_eq!(log_limit("500"), 100);
        assert_eq!(log_limit(" 12x"), 12);
        assert_eq!(parse_int_or_zero("-3"), -3);
        assert_eq!(parse_int_or_zero("nope"), 0);
    }

    #[test]
    fn cap_diff_and_patch_use_utf16_slices() {
        let (text, truncated) = cap_diff("abc".to_string());
        assert_eq!(text, "abc");
        assert!(!truncated);
        let big = "a".repeat(MAX_DIFF_BYTES + 1);
        let (text, truncated) = cap_diff(big);
        assert!(truncated);
        assert_eq!(text.len(), MAX_DIFF_BYTES);
    }

    #[test]
    fn sync_gate_mirrors_the_retired_js_tree() {
        // A running process always wins, whatever the classify letter says.
        let gate = sync_gate(true, Some("D")).expect("running gate");
        assert_eq!(gate.0, "running");
        assert!(gate.1.contains("请等待本轮结束后再同步"));
        // P/C are in-flight turns; B is a turn parked on a background job.
        for (state, label) in [("P", "处理中"), ("C", "继续中"), ("B", "后台等待")] {
            let gate = sync_gate(false, Some(state)).expect("unfinished gate");
            assert_eq!(gate.0, state);
            assert_eq!(
                gate.1,
                format!("会话任务未结束（{label}，状态 {state}），请等待任务完成/暂停后再同步")
            );
        }
        // W is deliberately allowed (the turn ended, no process runs), as are
        // D/E and a missing classifyState.
        assert!(sync_gate(false, Some("W")).is_none());
        assert!(sync_gate(false, Some("D")).is_none());
        assert!(sync_gate(false, Some("E")).is_none());
        assert!(sync_gate(false, None).is_none());
        assert_eq!(classify_display_label("nope"), "等待用户");
    }
}
