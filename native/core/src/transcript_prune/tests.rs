use super::*;

fn js(text: &str) -> JsValue {
    json_parse(text).expect("valid JSON")
}

#[test]
fn project_directory_replaces_every_non_alphanumeric() {
    assert_eq!(
        claude_project_dir("/Users/me/p/.multicc-worktrees/x", "/home/me"),
        "/home/me/.claude/projects/-Users-me-p--multicc-worktrees-x"
    );
    assert_eq!(
        claude_project_dir("C:\\Users\\me", "/home/me"),
        "/home/me/.claude/projects/C--Users-me"
    );
    assert_eq!(
        claude_project_dir("/中文/路径", "/home/me"),
        "/home/me/.claude/projects/------"
    );
    assert_eq!(
        claude_project_dir("", "/home/me"),
        "/home/me/.claude/projects"
    );
}

#[test]
fn real_user_turn_matches_the_documented_shape() {
    assert!(is_real_user_turn(&js(
        r#"{"type":"user","message":{"role":"user","content":"hello"}}"#
    )));
    assert!(!is_real_user_turn(&js(
        r#"{"type":"user","message":{"role":"user","content":"   "}}"#
    )));
    assert!(!is_real_user_turn(&js(
        r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x"}]}}"#
    )));
    assert!(is_real_user_turn(&js(
        r#"{"type":"user","message":{"role":"user","content":[{"type":"image","source":{}}]}}"#
    )));
    assert!(!is_real_user_turn(&js(
        r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"x"}}"#
    )));
    assert!(!is_real_user_turn(&js(
        r#"{"type":"user","isSidechain":true,"message":{"role":"user","content":"x"}}"#
    )));
    assert!(!is_real_user_turn(&JsValue::Null));
    assert!(!is_real_user_turn(&JsValue::Number(3.0)));
}

#[test]
fn user_visible_text_strips_harness_layers() {
    assert_eq!(
        user_visible_text(&JsValue::string("plain words")).to_string_lossy(),
        "plain words"
    );
    assert_eq!(
        user_visible_text(&JsValue::string("[gateway end]\nreal question")).to_string_lossy(),
        "real question"
    );
    assert_eq!(
        user_visible_text(&JsValue::string("前情\n[路由结束]\n真正的提问")).to_string_lossy(),
        "真正的提问"
    );
    assert_eq!(
        user_visible_text(&JsValue::string("[only end]")).to_string_lossy(),
        "[only end]"
    );
    assert_eq!(
        user_visible_text(&JsValue::string(
            "before<system-reminder>noise</system-reminder>after"
        ))
        .to_string_lossy(),
        "beforeafter"
    );
    assert_eq!(
        user_visible_text(&JsValue::string("question\n[Dispatch]\nnoise")).to_string_lossy(),
        "question"
    );
    assert_eq!(
        user_visible_text(&JsValue::Number(1.0)).to_string_lossy(),
        ""
    );
}

#[test]
fn substantive_turns_measure_visible_text() {
    assert!(!is_substantive_turn(&js(
        r#"{"type":"user","message":{"content":"继续"}}"#
    )));
    assert!(!is_substantive_turn(&js(
        r#"{"type":"user","message":{"content":"ok"}}"#
    )));
    assert!(is_substantive_turn(&js(
        r#"{"type":"user","message":{"content":"please refactor the parser"}}"#
    )));
    assert!(is_substantive_turn(&js(
        r#"{"type":"user","message":{"content":[{"type":"image"}]}}"#
    )));
    assert!(!is_substantive_turn(&js(
        r#"{"type":"user","message":{"content":[{"type":"text","text":"ok"}]}}"#
    )));
}

#[test]
fn elision_leaves_thinking_and_signatures_alone() {
    let long = "x".repeat(100);
    let entry = js(&format!(
        r#"{{"type":"assistant","message":{{"content":[{{"type":"thinking","thinking":"{}","signature":"{}"}},{{"type":"text","text":"{}"}}]}}}}"#,
        long, long, long
    ));
    let (elided, stats) = elide_entry(&entry, 40.0);
    assert_eq!(stats.strings, 1);
    let JsValue::Object(top) = &elided else {
        panic!("object")
    };
    let message = top
        .iter()
        .find(|(key, _)| key == "message")
        .map(|(_, value)| value)
        .expect("message");
    let JsValue::Object(fields) = message else {
        panic!("message object")
    };
    let content = fields
        .iter()
        .find(|(key, _)| key == "content")
        .map(|(_, value)| value)
        .expect("content");
    let JsValue::Array(blocks) = content else {
        panic!("content array")
    };
    let JsValue::Object(thinking) = &blocks[0] else {
        panic!("thinking block")
    };
    let JsValue::Object(text) = &blocks[1] else {
        panic!("text block")
    };
    assert_eq!(
        thinking
            .iter()
            .find(|(key, _)| key == "thinking")
            .map(|(_, value)| value),
        Some(&JsValue::string(&long))
    );
    let JsValue::String(short) = text
        .iter()
        .find(|(key, _)| key == "text")
        .map(|(_, value)| value)
        .expect("text")
    else {
        panic!("text string")
    };
    assert!(short.len() < 100);
    assert!(short.to_string_lossy().contains("multicc pruned"));
}

#[test]
fn oversized_images_become_a_marker_and_tool_results_keep_a_stub() {
    let image =
        js(r#"{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}"#);
    let marker = elide_content_block(&image, 3.0, &mut Stats::default());
    assert_eq!(
        stringify(&marker),
        r#"{"type":"text","text":"[multicc pruned 4 chars of an inline image to keep this session inside the model context window]"}"#
    );
    let empty = js(r#"{"type":"tool_result","content":[]}"#);
    let stubbed = elide_content_block(&empty, 100.0, &mut Stats::default());
    assert_eq!(
        stringify(&stubbed),
        r#"{"type":"tool_result","content":[{"type":"text","text":"[multicc pruned 0 chars of tool output to keep this session inside the model context window]"}]}"#
    );
}

#[test]
fn compact_cut_follows_the_last_boundary_and_its_preserved_rows() {
    let lines = vec![
        r#"{"uuid":"a","type":"user"}"#.to_string(),
        r#"{"uuid":"b","type":"user"}"#.to_string(),
        r#"{"uuid":"c","type":"system","subtype":"compact_boundary","compactMetadata":{"preservedSegment":{"headUuid":"b"}}}"#.to_string(),
        r#"{"uuid":"d","type":"user","isCompactSummary":true}"#.to_string(),
        r#"{"uuid":"e","type":"user"}"#.to_string(),
    ];
    let cut = compact_cut_index(&lines);
    assert_eq!(cut.cut, 1);
    assert_eq!(cut.boundary_idx, 2);
    assert_eq!(cut.summary_idx, 3);
    assert_eq!(
        stringify(&cut_value(&cut)),
        r#"{"cut":1,"boundaryIdx":2,"summaryIdx":3}"#
    );
}

#[test]
fn triggers_match_the_documented_thresholds() {
    let thresholds = MeasureThresholds {
        max_bytes: 100.0,
        hard_entry_bytes: 50.0,
        scan_min_bytes: 20.0,
    };
    assert_eq!(triggers_for(10.0, 0.0, &thresholds), Vec::<&str>::new());
    assert_eq!(triggers_for(200.0, 0.0, &thresholds), vec!["file-bytes"]);
    assert_eq!(
        triggers_for(30.0, 60.0, &thresholds),
        vec!["oversized-entry"]
    );
    assert_eq!(
        triggers_for(200.0, 60.0, &thresholds),
        vec!["file-bytes", "oversized-entry"]
    );
}

#[test]
fn api_bytes_only_counts_the_message_payload() {
    let line =
        r#"{"uuid":"x","toolUseResult":{"blob":"yyy"},"message":{"role":"user","content":"hi"}}"#;
    assert_eq!(
        api_bytes_of_line(line),
        r#"{"role":"user","content":"hi"}"#.len() as f64
    );
    assert_eq!(api_bytes_of_line("not json"), 8.0);
    assert_eq!(
        api_bytes_of_line(&format!(
            r#"{{"type":"summary","n":1,"pad":"{}"}}"#,
            "z".repeat(5000)
        )),
        4096.0
    );
}

#[test]
fn defaults_are_the_legacy_exports() {
    let value = defaults_value();
    assert_eq!(
        value.get("maxBytes"),
        Some(&JsValue::Number(DEFAULT_MAX_BYTES))
    );
    assert_eq!(
        value.get("keepTurnsLadder"),
        Some(&JsValue::Array(vec![
            JsValue::Number(20.0),
            JsValue::Number(10.0),
            JsValue::Number(5.0),
            JsValue::Number(3.0),
            JsValue::Number(2.0),
        ]))
    );
}

#[test]
fn report_and_level_encodings_keep_every_field() {
    let mut report = Report {
        file: "f".to_string(),
        strategy: "elide".to_string(),
        triggers: vec!["forced"],
        before_bytes: 10.0,
        after_bytes: 5.0,
        after_tokens: 2.0,
        fits_target: true,
        before_lines: 2,
        after_lines: 1,
        dropped_lines: 1,
        kept_summary: false,
        real_user_turns: 1,
        substantive_turns: 1,
        dropped_turns: 0,
        lost_turns: 0,
        lost_substantive_turns: 0,
        compact_boundary: false,
        elided_entries: 1,
        orphan_blocks: 0,
        rerooted_entries: 0,
        context_affected: true,
        forced: true,
        dry_run: false,
    };
    let value = report_value(&report);
    assert_eq!(value.get("strategy"), Some(&JsValue::string("elide")));
    assert_eq!(value.get("forced"), Some(&JsValue::Bool(true)));
    report.after_tokens = f64::NAN;
    assert!(
        matches!(report_value(&report).get("afterTokens"), Some(JsValue::Number(n)) if n.is_nan())
    );
    assert_eq!(
        stringify(&level_value(&Level::missing())),
        r#"{"found":false}"#
    );
}
