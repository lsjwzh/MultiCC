use super::*;
use std::fs;

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "page-{}",
            crate::random_id::random_uuid_v4().unwrap()
        ));
        fs::create_dir_all(p.join("chat_history/.views")).unwrap();
        Self(p)
    }
    fn write(&self, id: &str, text: &str) {
        fs::write(
            history::transcript_path(&self.0.join("chat_history"), id),
            text,
        )
        .unwrap();
    }
    fn page(&self, scope: &[&str], detail: Value, q: Query) -> Value {
        let (status, bytes) = read(
            &self.0,
            Scope {
                session_ids: scope.iter().map(|s| (*s).into()).collect(),
                ..Default::default()
            },
            detail,
            q,
        )
        .unwrap();
        assert_eq!(status, 200);
        match bytes {
            Body::Json(bytes) => serde_json::from_slice(&bytes).unwrap(),
            Body::Record(mut record) => {
                use std::io::Read;
                record
                    .file
                    .take(record.length as u64)
                    .read_to_end(&mut record.prefix)
                    .unwrap();
                record.prefix.push(b'}');
                serde_json::from_slice(&record.prefix).unwrap()
            }
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn query(limit: usize) -> Query {
    Query {
        limit,
        ..Default::default()
    }
}

#[test]
fn legacy_array_and_jsonl_share_stable_cursors_and_task_scope() {
    let f = Fixture::new();
    f.write("source","\u{feff}[ { \"role\":\"user\",\"ts\":2,\"content\":\"old\" }, {\"id\":\"m\",\"role\":\"user\",\"ts\":3,\"taskId\":\"other\"} ]");
    f.write("second","\u{feff}{\"role\":\"assistant\",\"id\":\"m\",\"taskId\":\"t\",\"ts\":1}\n{\"role\":\"user\",\"id\":\"private\"}\n{\"role\":");
    let detail = json!({"task":{"id":"t"},"sessionId":"source"});
    let latest = f.page(&["source", "second"], detail.clone(), query(1));
    assert_eq!(latest["messages"][0]["content"], "old");
    assert!(latest["messages"][0]["id"]
        .as_str()
        .unwrap()
        .starts_with("m_legacy_"));
    let before = latest["before"].as_str().unwrap().to_owned();
    let older = f.page(
        &["source", "second"],
        detail.clone(),
        Query {
            before: Some(before),
            ..query(1)
        },
    );
    assert_eq!(older["messages"][0]["messageKey"], "second:m");
    assert_eq!(older["hasMore"], false);
    for before in ["missing", "second:m"] {
        assert_eq!(
            f.page(
                &["source", "second"],
                detail.clone(),
                Query {
                    before: Some(before.into()),
                    ..query(100)
                }
            )["messages"],
            json!([])
        );
    }
}

#[test]
fn archive_visibility_and_usage_baselines_apply_before_slicing() {
    let f = Fixture::new();
    f.write("s",r#"[{"id":"a","role":"assistant","usage":{"input_tokens":10,"cached_input_tokens":0}},{"id":"b","role":"assistant","content":"second","usage":{"input_tokens":16,"cached_input_tokens":0}}]"#);
    fs::write(
        f.0.join("chat_history/.views/s.json"),
        r#"{"version":1,"hiddenIds":["a"]}"#,
    )
    .unwrap();
    let page = f.page(&["s"], json!({}), query(1));
    assert_eq!(page["hasMore"], false);
    assert_eq!(
        page["messages"][0]["usage"]["input_tokens"].as_f64(),
        Some(6.)
    );
    let hidden = f.page(
        &["s"],
        json!({}),
        Query {
            around: Some("a".into()),
            ..query(1)
        },
    );
    assert_eq!(hidden["found"], false);
    let archive = f.page(
        &["s"],
        json!({}),
        Query {
            around: Some("a".into()),
            archive: true,
            ..query(1)
        },
    );
    assert_eq!(archive["found"], true);
    assert_eq!(archive["hasNewer"], true);
}

#[test]
fn byte_bounded_pages_preserve_multibyte_content_and_expand_one_full_row() {
    let f = Fixture::new();
    let output = "文\n".repeat(16000);
    let rows=(0..24).map(|i|json!({"id":format!("m{i}"),"role":"assistant","heldResultId":i,"content":"已完成","tools":[{"output":output}]}).to_string()).collect::<Vec<_>>().join("\n");
    f.write("s", &rows);
    let mut seen = HashSet::new();
    let mut before = None;
    loop {
        let page = f.page(
            &["s"],
            json!({}),
            Query {
                before,
                ..query(100)
            },
        );
        assert!(page.to_string().len() < preview::PAGE_BYTES + 512);
        for row in page["messages"].as_array().unwrap() {
            assert!(row.to_string().len() <= preview::MESSAGE_BYTES);
            assert_eq!(row["truncated"], true);
            assert!(seen.insert(row["id"].as_str().unwrap().to_owned()));
        }
        if page["hasMore"] != true {
            break;
        }
        before = Some(page["before"].as_str().unwrap().to_owned());
    }
    assert_eq!(seen.len(), 24);
    let full = f.page(
        &["s"],
        json!({}),
        Query {
            message_id: Some("m7".into()),
            ..query(1)
        },
    );
    assert_eq!(full["message"]["tools"][0]["output"], output);
    let around = f.page(
        &["s"],
        json!({}),
        Query {
            around: Some("m10".into()),
            ..query(24)
        },
    );
    assert!(around["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["id"] == "m10"));
}

#[test]
fn a_record_over_the_physical_index_limit_cannot_hide_any_page() {
    let f = Fixture::new();
    let output = "a".repeat(crate::chat_history_index::MAX_INDEX_RECORD_BYTES as usize + 8);
    let large =
        json!({"id":"big","role":"assistant","tools":[{"output":output}],"ts":2,"content":"kept"})
            .to_string();
    let small = r#"{"id":"last","role":"user"}"#;
    for file in [
        format!("{large}\n{small}\n"),
        format!("[null,{large},{small}]"),
    ] {
        f.write("s", &file);
        let newest = f.page(&["s"], json!({}), query(1));
        assert_eq!(newest["before"], "last");
        let older = f.page(
            &["s"],
            json!({}),
            Query {
                before: Some("last".into()),
                ..query(1)
            },
        );
        assert_eq!(older["messages"][0]["id"], "big");
        assert_eq!(older["messages"][0]["truncated"], true);
        assert_eq!(older["messages"][0]["content"], "kept");
        assert_eq!(older["messages"][0]["originalLength"], large.len());
        let expanded = f.page(
            &["s"],
            json!({}),
            Query {
                message_id: Some("big".into()),
                ..query(1)
            },
        );
        assert_eq!(
            expanded["message"]["tools"][0]["output"]
                .as_str()
                .unwrap()
                .len(),
            output.len()
        );
    }
}

#[test]
fn interim_and_retry_are_resolved_before_cursor_and_usage() {
    let f = Fixture::new();
    let rows = [
        json!({"id":"a","role":"assistant","content":"a sufficiently long prefix","_interim":null}),
        json!({"id":"b","role":"assistant","content":"a sufficiently long prefix","_interim":true}),
        json!({"id":"n","role":"user","content":" 🔇 keep going"}),
        json!({"id":"c","role":"assistant","content":"a sufficiently long prefix plus result", "usage":{"input_tokens":10,"cached_input_tokens":0}}),
        json!({"id":"u","role":"user","content":"continue"}),
        json!({"id":"i1","role":"assistant","_interim":true,"usage":{"input_tokens":100,"cached_input_tokens":0}}),
        json!({"id":"done","role":"assistant","content":"final","usage":{"input_tokens":16,"cached_input_tokens":0}}),
    ];
    f.write("s", &serde_json::to_string(&rows).unwrap());
    let result = f.page(&["s"], json!({}), query(50));
    let msgs = result["messages"].as_array().unwrap();
    assert_eq!(
        msgs.iter()
            .map(|m| m["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["n", "c", "u", "done"]
    );
    assert_eq!(msgs[3]["usage"]["input_tokens"].as_f64(), Some(6.));
    fs::write(
        f.0.join("task_board.json"),
        r#"{"schemaVersion":2,"tasks":{"t":{"refs":[{"sessionId":"s","assistantMsgId":"a"}]}}}"#,
    )
    .unwrap();
    assert_eq!(
        f.page(&["s"], json!({}), query(50))["messages"][0]["id"],
        "a"
    );
}
