use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "multicc-claude-models-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&path, bytes).unwrap();
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn ids_of(text: &[u8]) -> Vec<String> {
    extract_bytes(text).ids().to_vec()
}

fn curated(text: &[u8]) -> Vec<(String, String)> {
    curate(&extract_bytes(text))
        .into_iter()
        .map(|model| (model.model, model.label))
        .collect()
}

fn entry(model: &str, label: &str) -> (String, String) {
    (model.to_string(), label.to_string())
}

#[test]
fn matcher_folds_dates_dots_and_brackets() {
    let all = ids_of(
        b"claude-sonnet-4.6 claude-sonnet-4-6 claude-sonnet-4-6-20251114 \
          claude-opus-4-20250514 claude-opus-5[1m] claude-opus-5-1",
    );
    assert_eq!(
        all,
        vec![
            "claude-sonnet-4-6",
            "claude-opus-4",
            "claude-opus-5",
            "claude-opus-5-1"
        ]
    );
    assert!(extract_bytes(b"claude-opus-5[1m]").has_one_m("claude-opus-5"));
    // A dated id keeps the [1m] flag on the undated canonical id.
    assert!(extract_bytes(b"claude-opus-5-20250514[1m]").has_one_m("claude-opus-5"));
    assert!(!extract_bytes(b"claude-opus-5-20250514").has_one_m("claude-opus-5"));
}

#[test]
fn lookbehind_lookahead_and_backtracking_match_v8() {
    // Substrings inside words never match; a leading window edge does.
    assert!(ids_of(b"xclaude-opus-5").is_empty());
    assert!(ids_of(b"-claude-opus-5").is_empty());
    assert!(ids_of(b"_claude-opus-5").is_empty());
    assert!(ids_of(b"claude-opus-5x").is_empty());
    assert!(ids_of(b"claude-opus-5-1x").is_empty());
    assert!(ids_of(b" (claude-opus-5) ").len() == 1);
    // Uppercase [1M] is not the [1m] group; the id still matches without it.
    assert_eq!(
        ids_of(b"claude-opus-5[1M]"),
        vec!["claude-opus-5".to_string()]
    );
    assert!(!extract_bytes(b"claude-opus-5[1M]").has_one_m("claude-opus-5"));
    // A trailing [1m] that fails the lookahead is skipped, not fatal.
    assert_eq!(
        ids_of(b"claude-opus-5[1m]x"),
        vec!["claude-opus-5".to_string()]
    );
    // `minor <= 2 digits`: 3+ digits make the minor group fail, and a dot or
    // dash then blocks the optional groups' lookahead.
    assert_eq!(
        ids_of(b"claude-opus-5.123"),
        vec!["claude-opus-5".to_string()]
    );
    assert!(ids_of(b"claude-opus-5-123").is_empty());
    assert_eq!(
        ids_of(b"claude-opus-5.12"),
        vec!["claude-opus-5-12".to_string()]
    );
    assert_eq!(
        ids_of(b"claude-opus-5.1"),
        vec!["claude-opus-5-1".to_string()]
    );
    // 8 digits after a dash are a date, not a minor.
    assert_eq!(
        ids_of(b"claude-opus-5-12345678"),
        vec!["claude-opus-5".to_string()]
    );
    assert!(ids_of(b"claude-opus-5-123456789").is_empty());
    assert!(ids_of(b"claude-opus-5-12345678-1").is_empty());
    // Unknown families are ignored by curation but not by extraction.
    assert!(ids_of(b"claude-gpt-5").is_empty());
}

#[test]
fn invalid_utf8_bytes_are_boundaries_like_u_fffd() {
    assert_eq!(
        ids_of(b"\xffclaude-opus-5"),
        vec!["claude-opus-5".to_string()]
    );
    assert_eq!(
        ids_of(b"claude-opus-5\xff"),
        vec!["claude-opus-5".to_string()]
    );
    assert_eq!(
        ids_of(b"claude-opus-5[1m]\xff"),
        vec!["claude-opus-5".to_string()]
    );
    assert!(extract_bytes(b"claude-opus-5[1m]\xff").has_one_m("claude-opus-5"));
    // A high byte inside the digits is not a digit.
    assert!(ids_of(b"claude-opus-\xff5").is_empty());
}

#[test]
fn extraction_keeps_insertion_order_and_one_m_subset() {
    let text = b"claude-haiku-4-5 claude-opus-5 claude-opus-5[1m] claude-opus-5";
    let found = extract_bytes(text);
    assert_eq!(
        found.ids().to_vec(),
        vec!["claude-haiku-4-5".to_string(), "claude-opus-5".to_string()]
    );
    assert!(found.has_one_m("claude-opus-5"));
    assert!(!found.has_one_m("claude-haiku-4-5"));
}

#[test]
fn five_hundred_distinct_ids_stop_the_scan_immediately() {
    let mut text = String::new();
    for index in 0..500 {
        text.push_str(&format!("claude-opus-{index} "));
    }
    text.push_str("claude-opus-999999");
    let found = extract_bytes(text.as_bytes());
    assert_eq!(found.ids().len(), 500);
    assert_eq!(found.ids()[499], "claude-opus-499");
    assert!(!found.ids().contains(&"claude-opus-999999".to_string()));

    // At 499 the tail is still scanned.
    let mut short = String::new();
    for index in 0..499 {
        short.push_str(&format!("claude-opus-{index} "));
    }
    short.push_str("claude-opus-999999");
    assert_eq!(extract_bytes(short.as_bytes()).ids().len(), 500);
}

#[test]
#[cfg(unix)]
fn versions_dir_mtime_picks_newest_file_and_symlink_wins() {
    let dir = TempDir::new();
    let versions = dir.0.join(".local/share/claude/versions");
    fs::create_dir_all(&versions).unwrap();
    let older = dir.file(".local/share/claude/versions/1.0.0", b"claude-opus-1");
    let newer = dir.file(".local/share/claude/versions/1.1.0", b"claude-opus-2");
    fs::create_dir_all(versions.join("subdir")).unwrap();
    let time = |path: &Path, secs: i64| {
        let when = std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs as u64);
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(when)
            .unwrap();
    };
    time(&older, 1_700_000_000);
    time(&newer, 1_700_000_100);
    assert_eq!(resolve_bundle(&dir.0), newer);

    let shim = dir.0.join(".local/bin/claude");
    fs::create_dir_all(shim.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&older, &shim).unwrap();
    assert_eq!(resolve_bundle(&dir.0), fs::canonicalize(&older).unwrap());

    let empty = TempDir::new();
    assert!(resolve_bundle(&empty.0).as_os_str().is_empty());
}

#[cfg(unix)]
fn set_time(path: &Path, secs: i64, nanos: u32) {
    let when = std::time::UNIX_EPOCH + std::time::Duration::new(secs as u64, nanos);
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(when)
        .unwrap();
}

#[test]
#[cfg(unix)]
fn versions_ties_pick_the_bytewise_earlier_name() {
    // libuv's scandir sorts names with strcmp before readdirSync returns, and
    // the mtime sort is stable, so an exact tie keeps the byte-wise earlier
    // name however the files were created.
    let dir = TempDir::new();
    let versions = dir.0.join(".local/share/claude/versions");
    fs::create_dir_all(&versions).unwrap();
    let later = dir.file(".local/share/claude/versions/1.1.0", b"claude-opus-9");
    let middle = dir.file(".local/share/claude/versions/1.0.0", b"claude-opus-3");
    let earlier = dir.file(".local/share/claude/versions/0.9.0", b"claude-opus-1");
    // Creation order is the reverse of the name order; all mtimes are equal.
    for path in [&later, &middle, &earlier] {
        set_time(path, 1_700_000_000, 123_456_789);
    }
    assert_eq!(resolve_bundle(&dir.0), earlier);

    // The review's other shape: the byte-wise later name created last.
    let dir = TempDir::new();
    let versions = dir.0.join(".local/share/claude/versions");
    fs::create_dir_all(&versions).unwrap();
    let first = dir.file(".local/share/claude/versions/1.0.0", b"claude-opus-1");
    set_time(&first, 1_700_000_000, 500);
    let last = dir.file(".local/share/claude/versions/2.0.0", b"claude-opus-9");
    set_time(&last, 1_700_000_000, 500);
    assert_eq!(resolve_bundle(&dir.0), first);
}

#[test]
fn version_sort_is_name_first_then_stable_mtime_desc() {
    let entry = |name: &str, mtime: f64| (name.as_bytes().to_vec(), mtime, PathBuf::from(name));
    // Input stands in for readdir order (the reverse of the name order here):
    // equal mtimes must still select the byte-wise first name.
    let mut files = vec![
        entry("2.0.0", 5.0),
        entry("1.0.0", 5.0),
        entry("0.9.0", 5.0),
    ];
    sort_version_files(&mut files);
    assert_eq!(files[0].2, PathBuf::from("0.9.0"));
    // A newer mtime beats the name order wherever it sits.
    let mut files = vec![
        entry("9.0.0", 1.0),
        entry("1.0.0", 7.0),
        entry("5.0.0", 3.0),
    ];
    sort_version_files(&mut files);
    let names: Vec<_> = files.iter().map(|file| file.2.to_str().unwrap()).collect();
    assert_eq!(names, ["1.0.0", "5.0.0", "9.0.0"]);
    // A sub-millisecond mtime difference is not a tie.
    let mut files = vec![entry("1.0.0", 7.0), entry("2.0.0", 7.0001)];
    sort_version_files(&mut files);
    assert_eq!(files[0].2, PathBuf::from("2.0.0"));
}

#[test]
#[cfg(unix)]
fn versions_sub_millisecond_mtime_is_not_truncated() {
    use std::os::unix::fs::MetadataExt;
    // Same whole millisecond, 100 microseconds apart (above the ~244 ns double
    // ULP at this epoch): Node sees different mtimeMs and picks the later file.
    let dir = TempDir::new();
    let versions = dir.0.join(".local/share/claude/versions");
    fs::create_dir_all(&versions).unwrap();
    let older = dir.file(".local/share/claude/versions/2.0.0", b"claude-opus-4");
    set_time(&older, 1_700_000_000, 123_000_000);
    let newer = dir.file(".local/share/claude/versions/1.0.0", b"claude-opus-5");
    set_time(&newer, 1_700_000_000, 123_100_000);
    let older_meta = fs::metadata(&older).unwrap();
    let newer_meta = fs::metadata(&newer).unwrap();
    assert_eq!(older_meta.mtime_nsec(), 123_000_000);
    assert_eq!(newer_meta.mtime_nsec(), 123_100_000);
    assert!(mtime_ms(&newer_meta) > mtime_ms(&older_meta));
    assert_eq!(resolve_bundle(&dir.0), newer);
}

#[test]
#[cfg(unix)]
fn mtime_ms_matches_node_fractional_milliseconds() {
    use std::os::unix::fs::MetadataExt;
    let dir = TempDir::new();
    let cases: &[(u32, f64)] = &[
        // Values printed by Node 26 `statSync().mtimeMs` for the same file.
        (123_456_789, 1700000000123.4568),
        (1_007_216, 1700000000001.0073),
        // Rounds up to the next whole millisecond at this epoch magnitude.
        (999_999_999, 1700000001000.0),
        (123_999_999, 1700000000124.0),
    ];
    for (index, (nanos, expected)) in cases.iter().enumerate() {
        let path = dir.file(&format!("m{index}"), b"x");
        set_time(&path, 1_700_000_000, *nanos);
        let meta = fs::metadata(&path).unwrap();
        assert_eq!(meta.mtime_nsec(), *nanos as i64);
        assert_eq!(mtime_ms(&meta), *expected, "nsec {nanos}");
    }
    let path = dir.file("other", b"x");
    set_time(&path, 1_700_000_123, 456_789);
    assert_eq!(mtime_ms(&fs::metadata(&path).unwrap()), 1700000123000.4568);
}

#[test]
fn window_boundaries_reproduce_the_sliding_scan() {
    let dir = TempDir::new();
    let chunk = 50usize;
    // An id ending exactly at the window end is accepted without seeing the
    // following byte; the next window sees `x` but the id is already in.
    let mut text = vec![b' '; chunk + CHUNK_OVERLAP - 13];
    text.extend_from_slice(b"claude-opus-5");
    text.push(b'x');
    let path = dir.file("edge", &text);
    assert_eq!(
        extract_models_with_chunk(&path, chunk)
            .unwrap()
            .ids()
            .to_vec(),
        vec!["claude-opus-5".to_string()]
    );

    // A word byte immediately before the id rejects it, unless a window starts
    // exactly at the id: start-of-window counts as a boundary.
    let mut text = vec![b'x'; chunk];
    text.extend_from_slice(b"claude-opus-5 ");
    let path = dir.file("start", &text);
    assert_eq!(
        extract_models_with_chunk(&path, chunk)
            .unwrap()
            .ids()
            .to_vec(),
        vec!["claude-opus-5".to_string()]
    );

    let mut text = vec![b' '; chunk];
    text.push(b'x');
    text.extend_from_slice(b"claude-opus-5 ");
    let path = dir.file("inside", &text);
    assert!(extract_models_with_chunk(&path, chunk)
        .unwrap()
        .ids()
        .is_empty());

    // k in 0..=70: with a word byte in front, only k = 0 is rescued by a
    // window starting exactly at the id (base is the second window start).
    for k in 0..=70usize {
        let base = 2 * chunk;
        let start = base - k;
        let mut text = vec![b' '; base + 60];
        text[start - 1] = b'x';
        text[start..start + 13].copy_from_slice(b"claude-opus-5");
        let path = dir.file(&format!("k{k}"), &text);
        let found = extract_models_with_chunk(&path, chunk).unwrap();
        assert_eq!(found.ids().len(), usize::from(k == 0 || k == 50), "k={k}");
    }
}

#[test]
fn curation_orders_by_version_then_length_with_insertion_ties() {
    // Same version and length: insertion order wins (stable sort).
    let found = extract_bytes(b"claude-opus-04-1 claude-opus-4-01");
    assert_eq!(
        found.ids().to_vec(),
        vec![
            "claude-opus-04-1".to_string(),
            "claude-opus-4-01".to_string()
        ]
    );
    assert_eq!(
        curate(&found),
        vec![
            Model::new("claude-opus-04-1", "Opus 4.1"),
            Model::new("claude-opus-4-01", "Opus 4.1"),
        ]
    );
    // Dotted and dashed minors canonicalize to one id.
    assert_eq!(
        extract_bytes(b"claude-opus-5.1 claude-opus-5-1")
            .ids()
            .to_vec(),
        vec!["claude-opus-5-1".to_string()]
    );
    assert_eq!(
        curated(b"claude-opus-5-2 claude-opus-5-1 claude-opus-5"),
        vec![
            entry("claude-opus-5-2", "Opus 5.2"),
            entry("claude-opus-5-1", "Opus 5.1"),
        ]
    );
    // Only the newest two per family, families in canonical order.
    assert_eq!(
        curated(
            b"claude-haiku-4-5-20251001 claude-sonnet-4-6[1m] claude-opus-5[1m] \
              claude-opus-4-8 claude-fable-5 claude-opus-5-1",
        ),
        vec![
            entry("claude-opus-5-1", "Opus 5.1"),
            entry("claude-opus-5[1m]", "Opus 5 (1M context)"),
            entry("claude-opus-5", "Opus 5"),
            entry("claude-sonnet-4-6[1m]", "Sonnet 4.6 (1M context)"),
            entry("claude-sonnet-4-6", "Sonnet 4.6"),
            entry("claude-fable-5", "Fable 5"),
            entry("claude-haiku-4-5", "Haiku 4.5"),
        ]
    );
}

#[test]
fn labels_use_ecmascript_number_formatting() {
    assert_eq!(display_label("opus", "claude-opus-0"), "Opus 0");
    assert_eq!(display_label("sonnet", "claude-sonnet-4-6"), "Sonnet 4.6");
    assert_eq!(display_label("haiku", "claude-haiku-4-0"), "Haiku 4");
    let huge = format!("claude-opus-{}", "9".repeat(21));
    assert_eq!(display_label("opus", &huge), "Opus 1e+21");
    assert_eq!(version_key("claude-opus-5.12").major, 5.0);
    assert_eq!(version_key("claude-opus-5.12").minor, 12.0);
    assert_eq!(version_key("claude-opus-4-20250514").minor, 20.0);
}

#[test]
fn refresh_values_follow_js_string_truthiness() {
    let text = |value: &str| QueryValue::Text(value.to_string());
    assert!(!force_refresh(&QueryValue::Missing));
    for value in ["1", "true", "TRUE", "True", "tRuE"] {
        assert!(force_refresh(&text(value)), "{value}");
    }
    for value in ["0", "yes", "", " true", "true "] {
        assert!(!force_refresh(&text(value)), "{value}");
    }
    assert!(!force_refresh(&QueryValue::List(vec![
        text("1"),
        text("1")
    ])));
    assert!(force_refresh(&QueryValue::List(vec![text("true")])));
    assert!(!force_refresh(&QueryValue::Object));
    assert_eq!(query_string(&QueryValue::Object), "[object Object]");
    assert_eq!(
        query_string(&QueryValue::List(vec![text("1"), text("1")])),
        "1,1"
    );
}

#[test]
fn cache_ttl_force_and_bundle_key_follow_the_node_machine() {
    let dir = TempDir::new();
    let bundle = dir.file("bundle", b"claude-opus-5 claude-sonnet-4-6");
    let now = 1_800_000_000_000i64;
    let mut cache = None;

    let first = answer(&mut cache, &bundle, false, || now);
    assert_eq!(first.source, Source::Cli);
    assert_eq!(first.models.len(), 2);
    assert!(first.stored.is_some());

    let hit = answer(&mut cache, &bundle, false, || now + CACHE_TTL_MS - 1);
    assert_eq!(hit.source, Source::Cache);
    assert!(hit.stored.is_none());

    let expired = answer(&mut cache, &bundle, false, || now + CACHE_TTL_MS);
    assert_eq!(expired.source, Source::Cli);

    let forced = answer(&mut cache, &bundle, true, || now + 1);
    assert_eq!(forced.source, Source::Cli);

    // A changed bundle invalidates; an empty key never does (but cannot be
    // scanned either).
    let other = dir.file("other", b"claude-opus-6");
    let changed = answer(&mut cache, &other, false, || now + 2);
    assert_eq!(changed.source, Source::Cli);
    assert_eq!(changed.models[0].model, "claude-opus-6");

    let missing = dir.0.join("nope");
    let fallback = answer(&mut cache, &missing, true, || now + 3);
    assert_eq!(fallback.source, Source::Fallback);
    assert_eq!(fallback.models, fallback_models());
    // The fallback was not cached: the old cli entry is still the cache.
    assert!(cache.is_some());
    assert_eq!(cache.as_ref().unwrap().models[0].model, "claude-opus-6");

    // An empty extraction (no ids) is also a fallback.
    let empty = dir.file("empty", b"nothing here");
    assert_eq!(
        answer(&mut cache, &empty, true, || now + 4).source,
        Source::Fallback
    );

    let unreadable = dir.0.join("directory");
    fs::create_dir_all(&unreadable).unwrap();
    assert_eq!(
        answer(&mut cache, &unreadable, true, || now + 5).source,
        Source::Fallback
    );
}

#[test]
fn cache_at_is_stamped_after_the_scan() {
    // Node reads Date.now() once for the expiry test (request start) and again
    // for `at` when the scan resolves; a slow first scan must not age the
    // entry by its own duration.
    let dir = TempDir::new();
    let bundle = dir.file("bundle", b"claude-opus-5");
    let start = 1_800_000_000_000i64;
    let mut cache = None;

    // A single call stamps the fresh scan: the clock is read after it.
    let stored = answer(&mut cache, &bundle, false, || start + 2_000);
    assert_eq!(stored.source, Source::Cli);
    assert_eq!(stored.stored.as_ref().unwrap().at_ms, start + 2_000);

    // Expire it, then let the rescan take 7s: the expiry test reads the start
    // time and `at` reads the finish time.
    let expired_at = start + 2_000 + CACHE_TTL_MS;
    let expired = answer(&mut cache, &bundle, false, || expired_at);
    assert_eq!(expired.source, Source::Cli);
    assert_eq!(expired.stored.as_ref().unwrap().at_ms, expired_at);

    let mut calls = 0;
    let scanning_clock = || {
        calls += 1;
        if calls == 1 {
            expired_at + CACHE_TTL_MS
        } else {
            expired_at + CACHE_TTL_MS + 7_000
        }
    };
    let rescan = answer(&mut cache, &bundle, false, scanning_clock);
    assert_eq!(rescan.source, Source::Cli);
    assert_eq!(calls, 2);
    assert_eq!(
        rescan.stored.as_ref().unwrap().at_ms,
        expired_at + CACHE_TTL_MS + 7_000
    );
    assert_eq!(
        cache.as_ref().unwrap().at_ms,
        expired_at + CACHE_TTL_MS + 7_000
    );

    // The boundary is measured from the scan finish, not the request start.
    let finished = expired_at + CACHE_TTL_MS + 7_000;
    assert_eq!(
        answer(&mut cache, &bundle, false, || finished + CACHE_TTL_MS - 1).source,
        Source::Cache
    );
    assert_eq!(
        answer(&mut cache, &bundle, false, || finished + CACHE_TTL_MS).source,
        Source::Cli
    );
}

#[test]
fn fallback_matches_the_node_constant() {
    let ids = fallback_ids();
    assert_eq!(ids.len(), 9);
    assert_eq!(ids[0], "claude-opus-5[1m]");
    assert_eq!(ids[8], "claude-haiku-4-5");
    assert_eq!(fallback_models()[3].label, "Opus 4.8");
    assert_eq!(
        cache_document(&Cache {
            at_ms: 1,
            models: fallback_models(),
            bundle_key: Some("k".into()),
        })["at"],
        1
    );
}
