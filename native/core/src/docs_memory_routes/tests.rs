use super::*;
use crate::js::serde::js_json_stringify;
use serde_json::json;

fn text(value: &str) -> Value {
    Value::String(value.to_string())
}

#[test]
fn clean_text_strips_control_units_then_trims_and_slices_utf16() {
    assert_eq!(clean_text(Some(&text(" a\u{0000}b\u{001f} ")), 200), "ab");
    assert_eq!(clean_text(Some(&Value::from(7)), 10), "");
    assert_eq!(clean_text(None, 10), "");
    // String.prototype.slice counts UTF-16 units: one astral character is two.
    // A cut through the surrogate pair is the documented U+FFFD convention of
    // the JS->Rust boundary (a lone surrogate cannot ride a serde string).
    assert_eq!(clean_text(Some(&text("a😀b")), 2), "a\u{fffd}");
    // U+007F is not in /[\u0000-\u001f]/ and survives.
    assert_eq!(clean_text(Some(&text("a\u{007f}")), 10), "a\u{007f}");
}

#[test]
fn normalize_dir_collapses_worktrees_and_trailing_separators() {
    assert_eq!(normalize_dir(Some(&text("/a/b/"))).as_deref(), Some("/a/b"));
    assert_eq!(
        normalize_dir(Some(&text("/a/proj/.multicc-worktrees/task-1/"))).as_deref(),
        Some("/a/proj")
    );
    // A worktree component at index 0 is not a project worktree, and the
    // collapse of everything before it leaves the format's root fallback.
    assert_eq!(
        normalize_dir(Some(&text("/.multicc-worktrees/x"))).as_deref(),
        Some("/")
    );
    assert_eq!(normalize_dir(Some(&text("/"))).as_deref(), Some("/"));
    assert_eq!(normalize_dir(Some(&text("relative/path"))), None);
    assert_eq!(normalize_dir(Some(&text("   "))), None);
    assert_eq!(normalize_dir(Some(&Value::Null)), None);
    assert_eq!(normalize_dir(Some(&Value::from(1))), None);
}

#[test]
fn relative_urls_follow_the_retired_allowlist() {
    assert_eq!(
        clean_relative_url("/artifacts/abc/index.html").as_deref(),
        Some("/artifacts/abc/index.html")
    );
    assert_eq!(
        clean_relative_url("/docs/a?b=1&c=/?x").as_deref(),
        Some("/docs/a?b=1&c=/?x")
    );
    assert_eq!(clean_relative_url("").as_deref(), None);
    assert_eq!(clean_relative_url("/a/../b").as_deref(), None);
    assert_eq!(clean_relative_url("/a/./b").as_deref(), None);
    assert_eq!(clean_relative_url("/a b").as_deref(), None);
    assert_eq!(clean_relative_url("/a#b").as_deref(), None);
    assert_eq!(clean_relative_url("http://x/").as_deref(), None);
}

#[test]
fn absolute_urls_are_the_only_whatwg_delegation() {
    assert_eq!(
        url_needs_host(Some(&text("  http://127.0.0.1:5173/x  "))).as_deref(),
        Some("http://127.0.0.1:5173/x")
    );
    assert_eq!(url_needs_host(Some(&text("/relative"))), None);
    assert_eq!(url_needs_host(Some(&text(""))), None);
    assert!(url_needs_host(Some(&text("javascript:alert(1)"))).is_some());
    assert_eq!(url_needs_host(Some(&Value::from(1))), None);
    // trim() already removed the trailing CRLF, so this URL is accepted; an
    // interior newline is what the retired check rejects.
    assert_eq!(
        url_needs_host(Some(&text("http://x/\r\n"))).as_deref(),
        Some("http://x/")
    );
    assert_eq!(url_needs_host(Some(&text("http://x/a\r\nb"))), None);
    assert_eq!(
        url_needs_host(Some(&text(&format!("http://x/{}", "a".repeat(MAX_URL))))),
        None
    );
}

#[test]
fn sanitize_incoming_is_idempotent_and_keeps_the_retired_key_order() {
    let body = json!({
        "kind": "service",
        "title": " My page ",
        "url": "/artifacts/abc/index.html",
        "note": "n",
        "sessionId": "s1",
        "relatedArtifactIds": ["abc", "bad!", "abc", "def-1"],
        "taskId": "t1",
        "source": " ",
        "pinned": true,
        "permanent": "yes",
        "dir": "/a/proj/.multicc-worktrees/task-1/",
        "port": "5173",
        "startCmd": "serve",
        "cwd": "/a/proj",
    });
    let first = sanitize_incoming(&body, &json!({}), ResolvedUrl::Inline);
    assert_eq!(
        js_json_stringify(&first),
        r#"{"kind":"service","title":"My page","url":"/artifacts/abc/index.html","note":"n","sessionId":"s1","relatedArtifactIds":["abc","def-1"],"taskId":"t1","source":"agent","pinned":true,"permanent":false,"dir":"/a/proj","port":5173,"startCmd":"serve","cwd":"/a/proj"}"#
    );
    // Sanitizing the built entry again must change nothing (the host may store
    // a front-door entry without re-running the rules).
    let second = sanitize_incoming(&first, &json!({}), ResolvedUrl::Inline);
    assert_eq!(js_json_stringify(&second), js_json_stringify(&first));
}

#[test]
fn sanitize_incoming_only_moves_keys_that_already_existed() {
    let existing = json!({ "id": "doc_1", "title": "old", "url": "/old", "createdAt": "t" });
    let body = json!({ "url": "/new", "title": "new" });
    let merged = sanitize_incoming(&body, &existing, ResolvedUrl::Inline);
    assert_eq!(
        js_json_stringify(&merged),
        r#"{"id":"doc_1","title":"new","url":"/new","createdAt":"t"}"#
    );
}

#[test]
fn sanitize_incoming_uses_the_host_url_verdict() {
    let body = json!({ "url": "http://LOCALHOST:5173/a/../b" });
    let resolved = sanitize_incoming(
        &body,
        &json!({}),
        ResolvedUrl::Host(Some("http://localhost:5173/b".to_string())),
    );
    assert_eq!(resolved.get("url"), Some(&text("http://localhost:5173/b")));
    let rejected = sanitize_incoming(&body, &json!({}), ResolvedUrl::Host(None));
    assert_eq!(rejected.get("url"), None);
    // A relative URL never consults the host verdict.
    let relative = sanitize_incoming(
        &json!({ "url": "/x" }),
        &json!({}),
        ResolvedUrl::Host(Some("http://wrong/".to_string())),
    );
    assert_eq!(relative.get("url"), Some(&text("/x")));
}

#[test]
fn invalid_scalars_are_dropped_not_coerced() {
    let body = json!({
        "kind": "nope",
        "title": 5,
        "url": 7,
        "port": "0",
        "cwd": "relative",
        "relatedArtifactIds": "abc",
    });
    let out = sanitize_incoming(&body, &json!({}), ResolvedUrl::Inline);
    assert_eq!(js_json_stringify(&out), r#"{"kind":"page","title":""}"#);
    assert_eq!(out.get("port"), None);
    assert_eq!(out.get("cwd"), None);
    assert_eq!(out.get("relatedArtifactIds"), None);
    let big = sanitize_incoming(&json!({ "port": 65536.5 }), &json!({}), ResolvedUrl::Inline);
    assert_eq!(big.get("port"), None);
}

#[test]
fn validate_uses_the_retired_refusal_strings() {
    assert_eq!(
        validate_entry(&json!({ "kind": "page" })).as_deref(),
        Some("title is required")
    );
    assert_eq!(
        validate_entry(&json!({ "kind": "page", "title": "t" })).as_deref(),
        Some("a valid http(s) or root-relative url is required")
    );
    assert_eq!(
        validate_entry(&json!({ "kind": "x", "title": "t", "url": "/u" })).as_deref(),
        Some("kind must be one of page/file/service")
    );
    assert_eq!(
        validate_entry(&json!({ "kind": "file", "title": "t", "url": "/u" })),
        None
    );
}

#[test]
fn artifact_and_task_derivations_match() {
    assert_eq!(
        artifact_id_from_url(Some("/artifacts/ab_c-1/index.html")).as_deref(),
        Some("ab_c-1")
    );
    assert_eq!(
        artifact_id_from_url(Some("/artifacts/ab_c-1")).as_deref(),
        Some("ab_c-1")
    );
    assert_eq!(artifact_id_from_url(Some("/artifacts/ab c")), None);
    assert_eq!(artifact_id_from_url(Some("/artifacts/")), None);
    assert_eq!(artifact_id_from_url(Some("/other/abc")), None);
    assert_eq!(artifact_id_from_url(None), None);
    assert!(!valid_artifact_id(&"a".repeat(129)));

    let session = format!("task-{}", "a".repeat(32));
    let expected = format!("tsk_{}", "a".repeat(32));
    assert_eq!(
        task_id_for(&json!({ "sessionId": session })),
        Some(Value::String(expected.clone()))
    );
    assert_eq!(
        task_id_for(&json!({ "sessionId": format!("task-{}", "A".repeat(32)) })),
        None
    );
    assert_eq!(task_id_for(&json!({ "sessionId": "task-short" })), None);
    assert_eq!(
        task_id_for(&json!({ "taskId": "explicit", "sessionId": "x" })),
        Some(Value::String("explicit".into()))
    );
    assert_eq!(
        task_id_for(&json!({ "taskId": "", "sessionId": "x" })),
        None
    );
}

#[test]
fn view_keeps_entry_key_positions_and_appends_the_view_fields() {
    let entry = json!({
        "id": "doc_1",
        "url": "/artifacts/abc/index.html",
        "title": "T",
        "createdAt": "2023-01-01T00:00:00.000Z",
    });
    let artifact_view = view(
        &entry,
        &ViewFacts {
            task_title: json!("Task title"),
            exists: Some(false),
            ..ViewFacts::default()
        },
    );
    assert_eq!(
        js_json_stringify(&artifact_view),
        r#"{"id":"doc_1","url":"/artifacts/abc/index.html","title":"T","createdAt":"2023-01-01T00:00:00.000Z","artifactId":"abc","taskId":null,"taskTitle":null,"retained":false,"permanent":false,"dir":null,"dirName":"","expired":true}"#
    );
    // A key the stored entry already had stays where it was.
    let entry = json!({ "id": "d", "artifactId": null, "url": "/x", "dir": "/p/x" });
    let view = view(&entry, &ViewFacts::default());
    assert_eq!(
        js_json_stringify(&view),
        r#"{"id":"d","artifactId":null,"url":"/x","dir":"/p/x","taskId":null,"taskTitle":null,"retained":false,"permanent":false,"dirName":"x"}"#
    );
}

#[test]
fn view_dir_prefers_entry_then_cwd_then_session_and_names_the_basename() {
    let base = json!({ "url": "/x", "taskId": "tsk_1" });
    let with_session = view(
        &base,
        &ViewFacts {
            session_dir: Some("/projects/session".to_string()),
            task_title: json!("T"),
            retained: true,
            ..ViewFacts::default()
        },
    );
    assert_eq!(with_session.get("dir"), Some(&text("/projects/session")));
    assert_eq!(with_session.get("dirName"), Some(&text("session")));
    assert_eq!(with_session.get("taskTitle"), Some(&text("T")));
    assert_eq!(with_session.get("retained"), Some(&Value::Bool(true)));

    let entry = json!({ "url": "/x", "dir": "/projects/entry", "cwd": "/projects/cwd" });
    let entry_view = view(&entry, &ViewFacts::default());
    assert_eq!(entry_view.get("dir"), Some(&text("/projects/entry")));
    let entry = json!({ "url": "/x", "cwd": "/projects/cwd" });
    let cwd_view = view(&entry, &ViewFacts::default());
    assert_eq!(cwd_view.get("dir"), Some(&text("/projects/cwd")));
    // path.basename('/') === ''
    let entry = json!({ "url": "/x", "dir": "/" });
    assert_eq!(
        view(&entry, &ViewFacts::default()).get("dirName"),
        Some(&text(""))
    );
}

#[test]
fn views_sort_by_retention_rank_then_created_at_descending() {
    let mut views = vec![
        json!({ "createdAt": "2023-01-03T00:00:00.000Z", "permanent": false, "pinned": false }),
        json!({ "createdAt": "2023-01-01T00:00:00.000Z", "permanent": false, "pinned": true }),
        json!({ "createdAt": "2023-01-02T00:00:00.000Z", "permanent": true, "pinned": false }),
        json!({ "createdAt": "2023-01-04T00:00:00.000Z", "permanent": false, "pinned": false }),
    ];
    sort_views(&mut views);
    let stamps: Vec<String> = views
        .iter()
        .map(|view| {
            view.get("createdAt")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        })
        .collect();
    assert_eq!(
        stamps,
        vec![
            "2023-01-02T00:00:00.000Z",
            "2023-01-01T00:00:00.000Z",
            "2023-01-04T00:00:00.000Z",
            "2023-01-03T00:00:00.000Z"
        ]
    );
}

#[test]
fn doc_ids_keep_the_retired_shape() {
    let id = doc_id(1_700_000_000_000, 0.5);
    assert!(id.starts_with("doc_"), "{id}");
    assert_eq!(id.len(), 4 + 8 + 4);
    assert!(id[4..12]
        .bytes()
        .all(|byte| (byte as char).is_ascii_alphanumeric()));
    assert_eq!(iso_time(1_700_000_000_000), "2023-11-14T22:13:20.000Z");
}

#[test]
fn token_estimates_follow_the_js_formula() {
    assert_eq!(estimate_mem_tokens(""), 0);
    assert_eq!(estimate_mem_tokens("a"), 1);
    assert_eq!(estimate_mem_tokens("hello"), 1);
    assert_eq!(estimate_mem_tokens("你好"), 3);
    assert_eq!(estimate_mem_tokens("你好ab"), 4); // 3 + 2/4 = 3.5 → round 4
    assert_eq!(estimate_mem_tokens("😀"), 1); // one astral char, two UTF-16 units
}

#[test]
fn memory_rel_rules_reject_every_traversal_shape() {
    for ok in ["a.md", "a/b.md", "_machine/x.md", "a b.MD"] {
        assert!(memory_rel_valid(ok), "{ok}");
    }
    for bad in [
        "",
        "a.txt",
        "../x.md",
        "/etc/x.md",
        "a/../x.md",
        "a/./x.md",
        "a//x.md",
        "a\\x.md",
        "a/",
        "a/x.md\0",
    ] {
        assert!(!memory_rel_valid(bad), "{bad:?}");
    }
    // The query layer decodes %2e%2e before this rule ever sees it.
    assert!(!memory_rel_valid(
        "a/%2e%2e".replace("%2e%2e", "..").as_str()
    ));
}

#[test]
fn inside_and_ancestor_checks_are_the_retired_string_test() {
    assert!(is_inside("/a/b", "/a/b"));
    assert!(is_inside("/a/b", "/a/b/c.md"));
    assert!(!is_inside("/a/b", "/a/bc/c.md"));
    assert!(!is_inside("/", "/a"));
    assert!(ancestor_inside_root(Some("/a/b"), Some("/a/b/c")));
    assert!(!ancestor_inside_root(Some("/a/b"), Some("/a/c")));
    assert!(!ancestor_inside_root(None, Some("/a/b")));
    assert!(!ancestor_inside_root(Some("/a/b"), None));
}

#[test]
fn graph_tree_and_file_envelopes_keep_the_retired_key_order() {
    let graph = graph_envelope(
        "all",
        &json!({ "nodes": [{ "id": "n" }], "edges": [], "projects": [], "truncated": true }),
        12,
        MEM_GRAPH_MAX_NODES,
    );
    assert_eq!(
        js_json_stringify(&graph),
        r#"{"nodes":[{"id":"n"}],"edges":[],"meta":{"dirId":"all","projects":[],"nodeCount":1,"edgeCount":0,"truncated":true,"maxNodes":600,"durationMs":12}}"#
    );
    let tree = tree_with_duration(
        json!({ "root": "/r", "projects": [], "meta": { "projectCount": 0, "maxFiles": 2000 } }),
        7,
    );
    assert_eq!(
        js_json_stringify(&tree),
        r#"{"root":"/r","projects":[],"meta":{"projectCount":0,"maxFiles":2000,"durationMs":7}}"#
    );
    let file = memory_file_dto(
        "a/b.md",
        "/r/a/b.md",
        "你好",
        json!("2023-01-01T00:00:00.000Z"),
    );
    assert_eq!(
        js_json_stringify(&file),
        r#"{"rel":"a/b.md","path":"/r/a/b.md","name":"b.md","content":"你好","size":6,"tokens":3,"mtime":"2023-01-01T00:00:00.000Z"}"#
    );
    let write = memory_write_dto("a/b.md", "/r/a/b.md", "hi", json!(null));
    assert_eq!(
        js_json_stringify(&write),
        r#"{"ok":true,"rel":"a/b.md","path":"/r/a/b.md","size":2,"tokens":1,"mtime":null}"#
    );
}

#[test]
fn memo_text_reads_trim_js_whitespace_only() {
    assert_eq!(trimmed_text(Some(&text("  ship it  "))), "ship it");
    assert_eq!(trimmed_text(Some(&Value::Null)), "");
    assert_eq!(trimmed_text(None), "");
    assert_eq!(trimmed_text(Some(&Value::from(0))), "");
    assert_eq!(body_text(Some(&Value::from(12))), "12");
}

#[test]
fn memory_path_verdict_rejects_every_escape_shape() {
    let facts = |resolved: &str, real_root: Option<&str>, ancestor: Option<&str>| MemoryPathFacts {
        root: "/store".into(),
        resolved: resolved.into(),
        real_root: real_root.map(str::to_string),
        existing_ancestor_real: ancestor.map(str::to_string),
        exists: true,
        parent_exists: true,
        name: "a.md".into(),
    };
    let ok = facts("/store/a.md", Some("/store"), Some("/store"));
    assert!(memory_path_valid("a.md", &ok));
    assert!(memory_path_valid(
        "p/a.md",
        &facts("/store/p/a.md", Some("/store"), Some("/store/p"))
    ));

    // A `..` segment, an absolute path, an empty segment, a backslash, NUL and
    // a non-markdown suffix are all decided before any filesystem fact.
    for rel in [
        "../a.md",
        "p/../../a.md",
        "/etc/a.md",
        "p//a.md",
        "p/./a.md",
        "p\\a.md",
        "a.md\u{0}",
        "a.txt",
        "",
        "p/..",
    ] {
        assert!(!memory_path_valid(rel, &ok), "accepted {rel:?}");
    }
    // A percent-encoded traversal arrives decoded by the query parser; the
    // decoded form (`p/../a.md`, above) is what reaches the verdict.

    // Level escapes and a symlinked ancestor that lands outside the store.
    assert!(!memory_path_valid(
        "a.md",
        &facts("/store2/a.md", Some("/store"), Some("/store2"))
    ));
    assert!(!memory_path_valid(
        "a.md",
        &facts("/store", Some("/store"), Some("/store"))
    ));
    assert!(!memory_path_valid(
        "a.md",
        &facts("/store/a.md", None, Some("/store"))
    ));
    assert!(!memory_path_valid(
        "a.md",
        &facts("/store/a.md", Some("/store"), Some("/elsewhere"))
    ));
    assert!(!memory_path_valid(
        "a.md",
        &facts("/store2/a.md", Some("/store"), Some("/store"))
    ));
}

#[test]
fn is_inside_uses_the_platform_separator_boundary() {
    assert!(is_inside("/store", "/store"));
    assert!(is_inside("/store", "/store/a"));
    assert!(!is_inside("/store", "/storefront/a"));
    // `path.resolve` normalizes `..` away before `isInside` runs, so the
    // string test itself only knows the separator boundary.
    assert!(is_inside("/store", "/store/../a"));
}
