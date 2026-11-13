use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct TempTree(std::path::PathBuf);

impl TempTree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "multicc-native-session-guard-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).expect("temp tree");
        Self(path)
    }

    fn path(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }

    fn file(&self, relative: &str, contents: &str) -> String {
        let full = self.0.join(relative);
        fs::create_dir_all(full.parent().unwrap()).expect("parent");
        fs::write(&full, contents).expect("write");
        full.to_string_lossy().into_owned()
    }

    fn dir(&self, relative: &str) -> String {
        let full = self.0.join(relative);
        fs::create_dir_all(&full).expect("dir");
        full.to_string_lossy().into_owned()
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn record(cli: JsValue, session_id: JsValue, provider: JsValue, id: JsValue) -> JsValue {
    object(vec![
        ("cli", cli),
        ("cliSessionId", session_id),
        ("provider", provider),
        ("id", id),
    ])
}

fn codex_guard(home: &str) -> CodexRolloutGuard {
    CodexRolloutGuard::new(CodexOptions::from_js(&object(vec![(
        "homeDir",
        text(home),
    )])))
}

fn native_guard(home: &str) -> NativeSessionGuard {
    NativeSessionGuard::new(NativeOptions::from_js(&object(vec![(
        "homeDir",
        text(home),
    )])))
}

fn age_file(path: &str, days: f64) {
    let file = fs::OpenOptions::new()
        .write(true)
        .open(path)
        .expect("open for mtime");
    let when = std::time::SystemTime::now()
        - std::time::Duration::from_secs_f64(days * 24.0 * 60.0 * 60.0);
    file.set_modified(when).expect("set mtime");
}

fn action(outcome: &Outcome) -> String {
    match outcome.value.get("action") {
        Some(JsValue::String(value)) => value.to_string_lossy(),
        other => panic!("missing action: {other:?}"),
    }
}

#[test]
fn node_path_normalization_matches_posix_path_join() {
    assert_eq!(node_join(&["/a", "b"]), "/a/b");
    assert_eq!(node_join(&["/a/", "/b/"]), "/a/b/");
    assert_eq!(node_join(&["/a", "", "b"]), "/a/b");
    assert_eq!(node_join(&["/a", ".", "./b"]), "/a/b");
    assert_eq!(node_join(&["/a", "..", "b"]), "/b");
    assert_eq!(node_join(&["/a", "../..", "b"]), "/b");
    assert_eq!(node_join(&["a", ".."]), ".");
    assert_eq!(node_join(&["a", "../"]), "./");
    assert_eq!(node_join(&["..", "a"]), "../a");
    assert_eq!(node_join(&["/"]), "/");
    assert_eq!(node_join(&["//"]), "/");
    assert_eq!(node_join(&["/a//b//"]), "/a/b/");
    assert_eq!(node_join(&[]), ".");
    assert_eq!(node_join(&["", ""]), ".");
    assert_eq!(node_join(&["a", "b/./c"]), "a/b/c");
    assert_eq!(node_join(&["/a", "../..", "../b"]), "/b");
    assert_eq!(node_join(&["a", "../../..", "b"]), "../../b");
}

#[test]
fn dirname_and_basename_match_posix() {
    assert_eq!(path_dirname_posix("/a/b/c"), "/a/b");
    assert_eq!(path_dirname_posix("/a/b/"), "/a");
    assert_eq!(path_dirname_posix("/a"), "/");
    assert_eq!(path_dirname_posix("a"), ".");
    assert_eq!(path_dirname_posix(""), ".");
    assert_eq!(path_dirname_posix("//a"), "//");
    assert_eq!(path_dirname_posix("/"), "/");
    assert_eq!(path_basename("/a/b/c"), "c");
    assert_eq!(path_basename("/a/b/"), "b");
    assert_eq!(path_basename("/"), "");
    assert_eq!(path_basename("a"), "a");
    assert_eq!(path_basename(""), "");
}

#[test]
fn windows_dirname_preserves_drive_and_unc_roots() {
    // Expected strings are checked against Node path.win32.dirname; this
    // pure lexical regression runs on every CI platform, not only Windows.
    for (input, expected) in [
        (r"C:\Users\runner\sessions", r"C:\Users\runner"),
        (r"C:\sessions", r"C:\"),
        (r"C:\", r"C:\"),
        (r"C:", r"C:"),
        (r"C:sessions", r"C:"),
        (r"C:home\sessions", r"C:home"),
        (r"C:/home\sessions/", r"C:/home"),
        (r"\\server\share\sessions", r"\\server\share\"),
        (r"\\server\share", r"\\server\share"),
        (r"\\?\C:\sessions", r"\\?\C:\"),
        (r"//server/share/sessions", r"//server/share/"),
        (r"\sessions", r"\"),
        (r"home\sessions", r"home"),
        (r"sessions", r"."),
        (r"", r"."),
    ] {
        assert_eq!(windows_path::dirname(input), expected, "{input}");
        #[cfg(windows)]
        assert_eq!(path_dirname(input), expected, "{input}");
    }
}

#[test]
fn unit_normalization_preserves_lone_surrogates() {
    let joined = node_join_units(&[
        JsString::from_rust_str("/a"),
        JsString::from_units(vec![0xD800, 0x0062]),
    ]);
    assert_eq!(joined.as_units(), &[47, 97, 47, 0xD800, 98]);
    let relative = node_join_units(&[JsString::new(), JsString::new()]);
    assert_eq!(relative.to_string_lossy(), ".");
}

#[test]
fn codex_finds_matching_rollouts_in_walk_order() {
    let tree = TempTree::new();
    let sessions = tree.dir("sessions");
    tree.file("sessions/one/sess-abc.jsonl", "{}");
    tree.file("sessions/one/other.jsonl", "{}");
    tree.file("sessions/two/deep/sess-abc.jsonl", "{}");
    tree.file("sessions/two/sess-abc.txt", "{}");
    let id = JsString::from_rust_str("sess-abc");
    let found = find_rollouts(&sessions, &id).expect("walk");
    assert_eq!(found.len(), 2);
    assert!(found.iter().all(|path| path.ends_with(".jsonl")));
    assert!(
        find_rollouts(&tree.0.join("missing").to_string_lossy(), &id)
            .expect("missing")
            .is_empty()
    );
}

#[test]
fn codex_enforce_skips_non_codex_and_empty_session() {
    let tree = TempTree::new();
    let mut guard = codex_guard(&tree.path());
    let cli = record(text("claude"), text("sid"), undefined(), text("t"));
    assert_eq!(
        action(&guard.enforce(&cli, false, &JsValue::Null, 0.0)),
        "skipped"
    );
    let cli = record(text("codex"), text(""), undefined(), text("t"));
    assert_eq!(
        action(&guard.enforce(&cli, false, &JsValue::Null, 0.0)),
        "skipped"
    );
    let exp = record(text("codex-exp"), JsValue::Null, undefined(), text("t"));
    assert_eq!(
        action(&guard.enforce(&exp, false, &JsValue::Null, 0.0)),
        "skipped"
    );
}

#[test]
fn codex_enforce_reports_ok_and_archives_when_forced() {
    let tree = TempTree::new();
    let sessions = tree.dir("sessions");
    tree.file("sessions/sess-1.jsonl", "0123456789");
    let record = record(text("codex"), text("sess-1"), undefined(), text("task-1"));
    let prepared = object(vec![("codexHome", text(&tree.path()))]);
    let mut guard = codex_guard(&tree.path());
    let ok = guard.enforce(&record, false, &prepared, 0.0);
    assert_eq!(action(&ok), "ok");
    assert_eq!(ok.value.get("totalBytes"), Some(&num(10.0)));
    assert_eq!(ok.value.get("files"), Some(&num(1.0)));

    let forced = guard.enforce(&record, true, &prepared, 0.0);
    assert_eq!(action(&forced), "archived");
    let Some(JsValue::Array(archived)) = forced.value.get("archived") else {
        panic!("archived array")
    };
    assert_eq!(archived.len(), 1);
    let target = match archived[0].get("archivedTo") {
        Some(JsValue::String(value)) => value.to_string_lossy(),
        _ => panic!("target"),
    };
    assert!(target.ends_with("multicc-archived-rollouts/sess-1.jsonl"));
    assert!(Path::new(&target).exists());
    assert!(!Path::new(&sessions).join("sess-1.jsonl").exists());
}

#[test]
fn codex_enforce_archives_only_oversized_files() {
    let tree = TempTree::new();
    let sessions = tree.dir("sessions");
    tree.file("sessions/sid-small.jsonl", "x");
    tree.file("sessions/sid-big.jsonl", "yyyy");
    let mut guard = CodexRolloutGuard::new(CodexOptions::from_js(&object(vec![
        ("homeDir", text(&tree.path())),
        ("maxBytes", num(2.0)),
    ])));
    let record = record(text("codex"), text("sid"), undefined(), text("t"));
    let prepared = object(vec![("sessionsDir", text(&sessions))]);
    let outcome = guard.enforce(&record, false, &prepared, 0.0);
    assert_eq!(action(&outcome), "archived", "{outcome:?}");
    let Some(JsValue::Array(archived)) = outcome.value.get("archived") else {
        panic!("archived")
    };
    assert_eq!(archived.len(), 1);
    let Some(JsValue::String(target)) = archived[0].get("archivedTo") else {
        panic!("missing archive target: {outcome:?}")
    };
    let expected = tree.0.join(CODEX_ARCHIVE_DIRNAME).join("sid-big.jsonl");
    assert_eq!(Path::new(&target.to_string_lossy()), expected.as_path());
    assert_eq!(fs::read_to_string(&expected).unwrap(), "yyyy");
    assert!(Path::new(&sessions).join("sid-small.jsonl").exists());
    assert!(!Path::new(&sessions).join("sid-big.jsonl").exists());
}

#[test]
fn codex_prepare_errors_map_to_not_found_blocked_and_error() {
    let tree = TempTree::new();
    let mut guard = codex_guard(&tree.path());
    let record = record(text("codex"), text("sid"), text("p"), text("task"));
    let not_found_prepared = object(vec![("errorCode", text("CODEX_SESSION_ROLLOUT_NOT_FOUND"))]);
    assert_eq!(
        action(&guard.enforce(&record, false, &not_found_prepared, 0.0)),
        "not_found"
    );
    let blocked_prepared = object(vec![
        ("errorCode", text("CODEX_SESSION_ROLLOUT_AMBIGUOUS")),
        ("errorMessage", text("two homes")),
    ]);
    let blocked = guard.enforce(&record, false, &blocked_prepared, 0.0);
    assert_eq!(action(&blocked), "blocked");
    assert_eq!(blocked.logs[0].name, "codex_rollout_guard_blocked");
    assert_eq!(blocked.logs[0].level, "warn");
    assert_eq!(blocked.logs[0].fields.get("sessionId"), Some(&text("task")));
    let plain_prepared = object(vec![
        ("errorCode", text("")),
        ("errorMessage", text("boom")),
    ]);
    let errored = guard.enforce(&record, false, &plain_prepared, 0.0);
    assert_eq!(action(&errored), "error");
    assert_eq!(errored.logs[0].name, "codex_rollout_guard_error");
    assert_eq!(errored.value.get("error"), Some(&text("boom")));
}

#[test]
fn codex_sweep_is_throttled_then_deletes_stale_files_only() {
    let tree = TempTree::new();
    let archive = tree.dir(&format!(".codex/{CODEX_ARCHIVE_DIRNAME}"));
    let stale = tree.file(
        &format!(".codex/{CODEX_ARCHIVE_DIRNAME}/old.jsonl"),
        "12345",
    );
    let fresh = tree.file(&format!(".codex/{CODEX_ARCHIVE_DIRNAME}/new.jsonl"), "12");
    age_file(&stale, 40.0);
    let mut guard = codex_guard(&tree.path());
    let now = system_now_ms();
    let first = guard.sweep(false, now);
    assert_eq!(first.logs.len(), 1);
    assert_eq!(first.logs[0].name, "codex_rollout_archive_cleanup");
    let Some(JsValue::Array(deleted)) = first.value.get("deleted") else {
        panic!("missing deleted array: {first:?}")
    };
    let [JsValue::String(deleted)] = deleted.as_slice() else {
        panic!("expected exactly one deleted path: {first:?}")
    };
    // PathBuf::join and the guard can spell separators differently on
    // Windows; keep exact file identity rather than requiring slash bytes.
    assert_eq!(Path::new(&deleted.to_string_lossy()), Path::new(&stale));
    assert_eq!(first.value.get("freedBytes"), Some(&num(5.0)));
    assert!(Path::new(&fresh).exists());
    assert!(!Path::new(&stale).exists());
    let second = guard.sweep(false, now + 1.0);
    assert_eq!(second.value.get("throttled"), Some(&JsValue::Bool(true)));
    assert!(Path::new(&archive).exists());
}

#[test]
fn codex_sweep_disabled_skips_the_clock() {
    let tree = TempTree::new();
    let mut guard = CodexRolloutGuard::new(CodexOptions::from_js(&object(vec![
        ("homeDir", text(&tree.path())),
        ("archiveTtlDays", num(0.0)),
    ])));
    let outcome = guard.sweep(false, 5.0);
    assert_eq!(outcome.value.get("disabled"), Some(&JsValue::Bool(true)));
    assert_eq!(outcome.value.get("freedBytes"), Some(&num(0.0)));
}

#[test]
fn native_enforce_ok_and_force_archive_uses_home_callbacks() {
    let tree = TempTree::new();
    let zcode_home = tree.dir("zcode-home");
    let sessions = tree.dir("zcode-home/.zcode/projects");
    tree.file("zcode-home/.zcode/projects/sess-9.jsonl", "abc");
    let record = record(text("zcode"), text("sess-9"), text("p"), text("task-9"));
    let homes = object(vec![("zcodeSessionHome", text(&zcode_home))]);
    let mut guard = native_guard(&tree.path());
    let ok = guard.enforce(&record, false, &homes, 0.0);
    assert_eq!(action(&ok), "ok");
    assert_eq!(ok.value.get("totalBytes"), Some(&num(3.0)));
    let forced = guard.enforce(&record, true, &homes, 0.0);
    assert_eq!(action(&forced), "archived");
    let Some(JsValue::Array(archived)) = forced.value.get("archived") else {
        panic!("archived")
    };
    let target = match archived[0].get("archivedTo") {
        Some(JsValue::String(value)) => value.to_string_lossy(),
        _ => panic!("target"),
    };
    assert_eq!(
        target,
        format!("{zcode_home}/.zcode/{NATIVE_ARCHIVE_DIRNAME}/task-9-sess-9.jsonl")
    );
    assert!(Path::new(&target).exists());
    assert!(!Path::new(&sessions).join("sess-9.jsonl").exists());
}

#[test]
fn native_dsh_matches_directories_and_archives_under_dot_dsh() {
    let tree = TempTree::new();
    let sessions = tree.dir(".dsh/sessions");
    tree.file(".dsh/sessions/sess-7/conversation.json", "hello");
    let record = record(text("dsh"), text("sess-7"), undefined(), text("task-7"));
    let mut guard = native_guard(&tree.path());
    let forced = guard.enforce(&record, true, &JsValue::Null, 0.0);
    assert_eq!(action(&forced), "archived");
    let target = match forced.value.get("archived") {
        Some(JsValue::Array(items)) => match items[0].get("archivedTo") {
            Some(JsValue::String(value)) => value.to_string_lossy(),
            _ => panic!("target"),
        },
        _ => panic!("archived"),
    };
    assert!(target.ends_with(".dsh/multicc-archived-sessions/task-7-sess-7"));
    assert!(!Path::new(&sessions).join("sess-7").exists());
}

#[test]
fn native_prototype_names_behave_like_a_truthy_missing_store() {
    let tree = TempTree::new();
    let mut guard = native_guard(&tree.path());
    for name in ["constructor", "toString", "__proto__"] {
        let record = record(text(name), text("sid"), undefined(), text("t"));
        let outcome = guard.enforce(&record, false, &JsValue::Null, 0.0);
        assert_eq!(action(&outcome), "not_found", "{name}");
    }
    let record = record(text("unknown"), text("sid"), undefined(), text("t"));
    assert_eq!(
        action(&guard.enforce(&record, false, &JsValue::Null, 0.0)),
        "skipped"
    );
    assert!(guard.handles(&text("dsh")));
    assert!(!guard.handles(&text("constructor")));
}

#[test]
fn native_archive_name_is_sliced_at_32_code_units() {
    let record_id = "x".repeat(40);
    let name = native_target_name(Some(&text(&record_id)), "/a/b/file.jsonl");
    assert_eq!(
        name.to_string_lossy(),
        format!("{}-file.jsonl", "x".repeat(32))
    );
    let fallback = native_target_name(Some(&text("")), "/a/b/file.jsonl");
    assert_eq!(fallback.to_string_lossy(), "session-file.jsonl");
    let lone = JsString::from_units(vec![0xD800]);
    let name = native_target_name(Some(&JsValue::String(lone)), "/a/file.jsonl");
    // The cut through the lone surrogate keeps it, and the archive path keeps
    // the code unit while the filesystem sees U+FFFD.
    assert_eq!(name.as_units()[0], 0xD800);
}

#[test]
fn native_sweep_removes_dirs_and_files_inside_archive_dirs() {
    let tree = TempTree::new();
    tree.file(".qoder/multicc-archived-sessions/old.jsonl", "1234");
    tree.file(
        ".qoder/multicc-archived-sessions/old-dir/inner.jsonl",
        "123456",
    );
    let mut guard = native_guard(&tree.path());
    let now = system_now_ms() + 31.0 * DAY_MS;
    let outcome = guard.sweep(false, now);
    assert_eq!(outcome.logs.len(), 1);
    assert_eq!(outcome.logs[0].name, "native_session_archive_cleanup");
    assert_eq!(outcome.value.get("freedBytes"), Some(&num(10.0)));
    match outcome.value.get("deleted") {
        Some(JsValue::Array(items)) => assert_eq!(items.len(), 2),
        _ => panic!("deleted"),
    }
    assert!(!Path::new(&tree.0.join(".qoder/multicc-archived-sessions/old.jsonl")).exists());
    assert!(!Path::new(&tree.0.join(".qoder/multicc-archived-sessions/old-dir")).exists());
}

#[test]
fn native_walk_respects_scan_limit_and_skips_archive_dirs() {
    let tree = TempTree::new();
    let root = tree.dir("root");
    for index in 0..5 {
        tree.file(&format!("root/sid-{index}.jsonl"), "x");
    }
    tree.dir(&format!("root/{NATIVE_ARCHIVE_DIRNAME}"));
    tree.file(&format!("root/{NATIVE_ARCHIVE_DIRNAME}/sid-old.jsonl"), "x");
    let id = JsString::from_rust_str("sid");
    let all = walk_matches(&root, &id, StoreKind::Files, 100.0);
    assert_eq!(all.len(), 5);
    let limited = walk_matches(&root, &id, StoreKind::Files, 2.0);
    // The archive directory sorts first and consumes one inspected entry,
    // even though its contents are excluded, just as in the Node guard.
    assert_eq!(limited, vec![node_join(&[&root, "sid-0.jsonl"])]);
}

#[test]
fn native_archive_collision_and_scan_bound_follow_node_filename_order() {
    for order in [["b", "a"], ["a", "b"]] {
        let tree = TempTree::new();
        for name in order {
            tree.file(&format!(".codebuddy/{name}/cb.jsonl"), name);
        }
        let root = node_join(&[&tree.path(), ".codebuddy"]);
        let a = node_join(&[&root, "a/cb.jsonl"]);
        let b = node_join(&[&root, "b/cb.jsonl"]);
        let id = JsString::from_rust_str("cb");
        assert_eq!(
            walk_matches(&root, &id, StoreKind::Files, 100.0),
            vec![b.clone(), a.clone()]
        );
        assert_eq!(
            walk_matches(&root, &id, StoreKind::Files, 3.0),
            vec![b.clone()]
        );
        let mut guard = native_guard(&tree.path());
        let record = record(
            text("codebuddy"),
            text("cb"),
            JsValue::Null,
            text("task-cb"),
        );
        let result = guard.enforce(&record, true, &JsValue::Null, 0.0);
        assert_eq!(action(&result), "archived");
        let target = node_join(&[&root, NATIVE_ARCHIVE_DIRNAME, "task-cb-cb.jsonl"]);
        assert_eq!(fs::read_to_string(target).expect("archive"), "a");
        assert!(!Path::new(&a).exists());
        assert!(!Path::new(&b).exists());
    }
}

#[test]
fn option_decoding_matches_the_js_coercions() {
    let options = CodexOptions::from_js(&object(vec![
        ("homeDir", text("/h")),
        ("maxBytes", num(0.0)),
        ("archiveTtlDays", num(-1.0)),
    ]));
    assert_eq!(options.max_bytes, CODEX_DEFAULT_MAX_BYTES);
    assert_eq!(options.archive_ttl_ms, 0.0);
    assert_eq!(options.codex_homes_dir, "/h/.multicc/codex-homes");

    let options = NativeOptions::from_js(&object(vec![
        ("homeDir", text("/h")),
        ("maxBytes", JsValue::Null),
        ("archiveTtlDays", text("2")),
    ]));
    // Number(null) == 0 -> fallback; Number("2") == 2 days.
    assert_eq!(options.max_bytes, NATIVE_DEFAULT_MAX_BYTES);
    assert_eq!(options.archive_ttl_ms, 2.0 * DAY_MS);
    assert_eq!(options.kimi_code_home, "/h/.kimi-code");
}

#[test]
fn defaults_and_outcome_envelope_keep_the_legacy_shape() {
    let codex = codex_defaults_value();
    assert_eq!(codex.get("maxBytes"), Some(&num(CODEX_DEFAULT_MAX_BYTES)));
    assert_eq!(codex.get("archiveTtlDays"), Some(&num(30.0)));
    assert_eq!(
        codex.get("archiveDirname"),
        Some(&text(CODEX_ARCHIVE_DIRNAME))
    );
    let native = native_defaults_value();
    assert_eq!(
        native.get("archiveDirname"),
        Some(&text(NATIVE_ARCHIVE_DIRNAME))
    );

    let outcome = Outcome {
        value: object(vec![("action", text("ok"))]),
        logs: vec![LogRecord {
            level: "info",
            name: "x",
            fields: object(vec![("deleted", num(1.0))]),
        }],
    };
    let encoded = outcome_value(&outcome);
    assert_eq!(
        encoded.get("result").and_then(|v| v.get("action")),
        Some(&text("ok"))
    );
    let Some(JsValue::Array(logs)) = encoded.get("logs") else {
        panic!("logs")
    };
    assert_eq!(logs[0].get("level"), Some(&text("info")));
    assert_eq!(
        logs[0].get("fields").and_then(|v| v.get("deleted")),
        Some(&num(1.0))
    );
}
