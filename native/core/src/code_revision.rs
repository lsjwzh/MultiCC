//! Content observation runs as one native job, not per-file libuv round trips.
//! Every capture reads fresh bytes; no timestamp cache can mint a stale revision.
use ring::digest::{digest, Context, SHA256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, Metadata, OpenOptions},
    io::{self, Read},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub struct FileDigest {
    hash: Context,
}

impl FileDigest {
    pub fn finish(&self, gitlinks: &str) -> String {
        let mut hash = self.hash.clone();
        hash.update(gitlinks.as_bytes());
        hex(hash.finish().as_ref())
    }
}

fn io_error(_: io::Error) -> String {
    "code_observation_failed".into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(unix)]
fn same_file(a: &Metadata, b: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}

#[cfg(not(unix))]
fn same_file(a: &Metadata, b: &Metadata) -> bool {
    a.len() == b.len()
        && a.modified().ok() == b.modified().ok()
        && a.created().ok() == b.created().ok()
        && a.file_type() == b.file_type()
}

pub fn observe_files(
    cwd: &Path,
    files: &[String],
    modes: &[String],
    honor_file_mode: bool,
    max_bytes: u64,
) -> Result<FileDigest, String> {
    if files.len() != modes.len() {
        return Err("code_index_unsupported".into());
    }
    // Canonicalize once so Windows extended-length prefixes match those from
    // parent canonicalization too. The host has already resolved the root.
    let root = fs::canonicalize(cwd).map_err(io_error)?;
    let cwd = root.as_path();
    // ring is already part of the runtime and detects SHA acceleration on ARM
    // as well as x86; the old sha2 default uses software hashing on ARM.
    let mut hash = Context::new(&SHA256);
    let mut total = 0u64;
    for (relative, tracked_mode) in files.iter().zip(modes) {
        if Path::new(relative)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err("code_path_unsupported".into());
        }
        let path = cwd.join(relative);
        let before = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(io_error(error)),
        };
        let parent = path.parent().ok_or("code_path_unsupported")?;
        if parent != cwd && fs::canonicalize(parent).ok().as_deref() != Some(parent) {
            return Err("code_parent_unsupported".into());
        }
        let symlink = before.file_type().is_symlink();
        if !before.is_file() && !symlink {
            return Err("code_file_unsupported".into());
        }
        total = total
            .checked_add(before.len())
            .ok_or("code_observation_limit")?;
        if total > max_bytes {
            return Err("code_observation_limit".into());
        }
        let digest = if symlink {
            // Match Node readlink's UTF-8 string conversion; never follow it.
            digest(
                &SHA256,
                fs::read_link(&path)
                    .map_err(io_error)?
                    .to_string_lossy()
                    .as_bytes(),
            )
        } else {
            let mut options = OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
            }
            let file = options.open(&path).map_err(io_error)?;
            let opened = file.metadata().map_err(io_error)?;
            if !opened.is_file() || !same_file(&before, &opened) {
                return Err("code_changed_during_observation".into());
            }
            let mut file_hash = Context::new(&SHA256);
            let mut limited = file.take(before.len().saturating_add(1));
            let mut buffer = [0u8; 64 * 1024];
            let mut read = 0u64;
            loop {
                let count = limited.read(&mut buffer).map_err(io_error)?;
                if count == 0 {
                    break;
                }
                read += count as u64;
                file_hash.update(&buffer[..count]);
            }
            if read != before.len() {
                return Err("code_changed_during_observation".into());
            }
            file_hash.finish()
        };
        let after = fs::symlink_metadata(&path).map_err(io_error)?;
        if !same_file(&before, &after) {
            return Err("code_changed_during_observation".into());
        }
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            before.permissions().mode() & 0o111 != 0
        };
        #[cfg(not(unix))]
        let executable = false;
        let mode = if symlink {
            "120000"
        } else if !honor_file_mode && !tracked_mode.is_empty() {
            tracked_mode
        } else if executable {
            "100755"
        } else {
            "100644"
        };
        let line = serde_json::to_string(&(relative, mode, hex(digest.as_ref())))
            .map_err(|_| "code_path_unsupported")?;
        hash.update(line.as_bytes());
        hash.update(b"\n");
    }
    Ok(FileDigest { hash })
}

// Whole-repository observation: the git orchestration the host used to drive
// through one subprocess per step runs here as a single worker job. Every
// behavior (error codes, -z parsing, UTF-16 sort order, marker checks,
// re-verification) mirrors the frozen Node implementation byte for byte.
pub const DEFAULT_MAX_BYTES: u64 = 256 * 1024 * 1024;
pub const DEFAULT_MAX_FILES: usize = 50000;
const GIT_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_MAX_BUFFER: usize = 32 * 1024 * 1024;
const OPERATION_MARKERS: [&str; 8] = [
    "MERGE_HEAD",
    "REBASE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
    "index.lock",
];

pub struct RevisionObservation {
    pub repo_id: String,
    pub head: String,
    pub revision: String,
    pub dirty: bool,
}

fn observation_failed<T>(_: T) -> String {
    "code_observation_failed".into()
}

// The host spawns git with the same non-interactive environment, a 30s
// SIGKILL timeout and a 32MB stdout cap. stderr only ever decorated the
// error message and was never classified, so it is discarded here.
fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "/usr/bin/false")
        .env("SSH_ASKPASS", "/usr/bin/false")
        .env(
            "GIT_SSH_COMMAND",
            "ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new -oConnectTimeout=10",
        )
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(observation_failed)?;
    let mut stdout = child.stdout.take().ok_or("code_observation_failed")?;
    let reader = std::thread::spawn(move || {
        let mut buffer: Vec<u8> = Vec::new();
        let mut overflow = false;
        let mut chunk = [0u8; 8192];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => {
                    if buffer.len() + count > GIT_MAX_BUFFER {
                        // Keep draining so the child can exit instead of
                        // blocking on a full pipe until the timeout kills it.
                        overflow = true;
                    } else if !overflow {
                        buffer.extend_from_slice(&chunk[..count]);
                    }
                }
                Err(_) => {
                    overflow = true;
                    break;
                }
            }
        }
        (!overflow).then_some(buffer)
    });
    let deadline = Instant::now() + GIT_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(2)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err("code_observation_failed".into());
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err(io_error(error));
            }
        }
    };
    let output = reader
        .join()
        .map_err(observation_failed)?
        .ok_or("code_observation_failed")?;
    if !status.success() {
        return Err("code_observation_failed".into());
    }
    Ok(String::from_utf8_lossy(&output).into_owned())
}

fn git_raw(cwd: &Path, args: &[&str]) -> Result<String, String> {
    run_git(cwd, args)
}

fn git_trimmed(cwd: &Path, args: &[&str]) -> Result<String, String> {
    Ok(run_git(cwd, args)?.trim().to_string())
}

// Node sorts strings by UTF-16 code unit; Rust's default string order is by
// UTF-8 bytes. They diverge exactly for astral characters (😀 sorts before
//  in Node, after it bytewise), and the digest contract froze the Node order.
fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

// /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/ on one NUL-separated ls-files line.
fn parse_stage_line(line: &str) -> Option<(&str, &str, &str, &str)> {
    let (meta, name) = line.split_once('\t')?;
    if name.is_empty() {
        return None;
    }
    let mut parts = meta.split(' ');
    let mode = parts.next()?;
    let oid = parts.next()?;
    let stage = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if mode.is_empty() || !mode.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if oid.is_empty()
        || !oid
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    if stage.len() != 1 || !stage.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((mode, oid, stage, name))
}

// path.resolve(cwd, relative): a lexical join that collapses `.`/`..` without
// touching the filesystem, so the containment check below cannot be escaped.
fn resolve_lexical(cwd: &Path, relative: &str) -> PathBuf {
    let mut resolved = cwd.to_path_buf();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(part) => resolved.push(part),
            Component::CurDir => {}
            // PathBuf::pop at the root is a no-op, matching path.resolve('/','..').
            Component::ParentDir => {
                resolved.pop();
            }
            Component::RootDir => resolved = PathBuf::from(component.as_os_str()),
            Component::Prefix(prefix) => resolved = PathBuf::from(prefix.as_os_str()),
        }
    }
    resolved
}

fn observe_gitlink(
    cwd: &Path,
    relative: &str,
    max_bytes: u64,
    max_files: usize,
    depth: u32,
) -> Result<String, String> {
    let absolute = resolve_lexical(cwd, relative);
    let inside = absolute
        .strip_prefix(cwd)
        .map(|rest| rest.components().next().is_some())
        .unwrap_or(false);
    if !inside {
        return Err("code_path_unsupported".into());
    }
    let stat = match fs::symlink_metadata(&absolute) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok("absent".into()),
        Err(error) => return Err(io_error(error)),
    };
    if !stat.is_dir() {
        return Err("code_file_unsupported".into());
    }
    if fs::canonicalize(&absolute).map_err(io_error)? != absolute {
        return Err("code_parent_unsupported".into());
    }
    let mut any = false;
    let mut dot_git = false;
    for entry in fs::read_dir(&absolute).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        any = true;
        if entry.file_name() == std::ffi::OsStr::new(".git") {
            dot_git = true;
        }
    }
    if !any {
        return Ok("uninitialized".into());
    }
    if !dot_git || depth >= 4 {
        return Err("code_index_unsupported".into());
    }
    let toplevel = git_trimmed(&absolute, &["rev-parse", "--show-toplevel"])?;
    if fs::canonicalize(Path::new(&toplevel)).map_err(io_error)? != absolute {
        return Err("code_index_unsupported".into());
    }
    let nested = observe_revision(&absolute, max_bytes, max_files, depth + 1)?;
    Ok(format!("{} {}", nested.head, nested.revision))
}

pub fn observe_revision(
    cwd: &Path,
    max_bytes: u64,
    max_files: usize,
    depth: u32,
) -> Result<RevisionObservation, String> {
    let cwd = fs::canonicalize(cwd).map_err(io_error)?;
    let common_dir = git_trimmed(&cwd, &["rev-parse", "--git-common-dir"])?;
    let common_dir = fs::canonicalize(cwd.join(&common_dir)).map_err(io_error)?;
    let head = git_trimmed(&cwd, &["rev-parse", "HEAD"])?;
    let status = git_raw(
        &cwd,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let git_dir = resolve_lexical(&cwd, &git_trimmed(&cwd, &["rev-parse", "--git-dir"])?);
    for marker in OPERATION_MARKERS {
        match fs::symlink_metadata(git_dir.join(marker)) {
            Ok(_) => return Err("code_git_operation".into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
    }
    let entries = git_raw(&cwd, &["ls-files", "--stage", "-z"])?;
    let flags = git_raw(&cwd, &["ls-files", "-v", "-z"])?;
    for line in flags.split('\0').filter(|line| !line.is_empty()) {
        let first = line.as_bytes()[0];
        if first == b'S' || first.is_ascii_lowercase() {
            return Err("code_index_unsupported".into());
        }
    }
    let mut tracked: HashMap<String, String> = HashMap::new();
    let mut gitlinks: HashMap<String, String> = HashMap::new();
    for line in entries.split('\0').filter(|line| !line.is_empty()) {
        let (mode, oid, stage, name) = parse_stage_line(line).ok_or("code_index_unsupported")?;
        if stage != "0" {
            return Err("code_index_unsupported".into());
        }
        // Submodules / nested repositories are observed separately, never read as files.
        if mode == "160000" {
            gitlinks.insert(name.to_string(), oid.to_string());
        } else {
            tracked.insert(name.to_string(), mode.to_string());
        }
    }
    let untracked = git_raw(&cwd, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    let mut unique: HashSet<String> = tracked.keys().cloned().collect();
    for name in untracked.split('\0').filter(|line| !line.is_empty()) {
        unique.insert(name.to_string());
    }
    let mut files: Vec<String> = unique.into_iter().collect();
    files.sort_by(|a, b| utf16_cmp(a, b));
    if files.len() > max_files {
        return Err("code_observation_limit".into());
    }
    let honor_file_mode = match git_trimmed(&cwd, &["config", "--bool", "core.filemode"]) {
        Ok(value) => value != "false",
        Err(_) => true,
    };
    let modes: Vec<String> = files
        .iter()
        .map(|file| tracked.get(file).cloned().unwrap_or_default())
        .collect();
    let hash = observe_files(&cwd, &files, &modes, honor_file_mode, max_bytes)?;
    let mut gitlink_list: Vec<(String, String)> = gitlinks.into_iter().collect();
    gitlink_list.sort_by(|a, b| utf16_cmp(&a.0, &b.0));
    let mut gitlink_lines = String::new();
    // Appended after files so repositories without gitlinks keep their existing revisions.
    for (relative, oid) in gitlink_list {
        let state = observe_gitlink(&cwd, &relative, max_bytes, max_files, depth)?;
        let line = serde_json::to_string(&(relative, "160000", oid, state))
            .map_err(|_| "code_path_unsupported")?;
        gitlink_lines.push_str(&line);
        gitlink_lines.push('\n');
    }
    if head != git_trimmed(&cwd, &["rev-parse", "HEAD"])?
        || status
            != git_raw(
                &cwd,
                &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            )?
    {
        return Err("code_changed_during_observation".into());
    }
    let repo_hash = digest(&SHA256, common_dir.to_string_lossy().as_bytes());
    let repo_id = format!("repo_{}", &hex(repo_hash.as_ref())[..32]);
    Ok(RevisionObservation {
        repo_id,
        head,
        revision: format!("code_{}", hash.finish(&gitlink_lines)),
        dirty: !status.is_empty(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_line_parsing_matches_the_frozen_regex() {
        assert_eq!(
            parse_stage_line("100644 ce013625030ba8dba906f756967f9e9ca394464a 0\tsrc/main.rs"),
            Some((
                "100644",
                "ce013625030ba8dba906f756967f9e9ca394464a",
                "0",
                "src/main.rs"
            ))
        );
        // Names may contain spaces, tabs, newlines and non-ASCII bytes.
        assert_eq!(
            parse_stage_line("100755 abcdef0 0\ta b\tc\nd中e"),
            Some(("100755", "abcdef0", "0", "a b\tc\nd中e"))
        );
        for rejected in [
            "",
            "100644 abcdef0 0",        // no tab
            "100644 abcdef0 0\t",      // empty name
            "x00644 abcdef0 0\tname",  // non-digit mode
            "100644 ABCDEF0 0\tname",  // uppercase oid
            "100644 abcdef0 00\tname", // two-digit stage
            "100644  abcdef0 0\tname", // double space
            "100644 abcdef0 0 extra\tname",
        ] {
            assert_eq!(parse_stage_line(rejected), None, "{rejected:?}");
        }
    }

    #[test]
    fn utf16_order_matches_node_string_sort() {
        // Astral characters sort BEFORE U+E000 in Node (lead surrogate 0xD83D
        // < 0xE000) but AFTER it in UTF-8 byte order (0xF0 > 0xEE).
        let astral = "\u{1F600}";
        let bmp = "\u{E000}";
        assert_eq!(utf16_cmp(astral, bmp), std::cmp::Ordering::Less);
        assert!(astral.as_bytes() > bmp.as_bytes());
        let mut names = vec![bmp.to_string(), astral.to_string(), "plain".to_string()];
        names.sort_by(|a, b| utf16_cmp(a, b));
        // Node: "plain"(0x70) < "😀"(0xD83D..) < "\u{E000}"; bytewise "plain" < "\u{E000}" < "😀".
        assert_eq!(names, vec!["plain", astral, bmp]);
        let mut bytewise = names.clone();
        bytewise.sort();
        assert_eq!(bytewise, vec!["plain", bmp, astral]);
    }

    #[test]
    fn lexical_resolution_collapses_dot_segments_without_io() {
        let cwd = Path::new(if cfg!(windows) {
            "C:\\work\\tree"
        } else {
            "/work/tree"
        });
        assert_eq!(resolve_lexical(cwd, "nested"), cwd.join("nested"));
        assert_eq!(resolve_lexical(cwd, "a/../nested"), cwd.join("nested"));
        assert_eq!(resolve_lexical(cwd, "./nested"), cwd.join("nested"));
    }
}
