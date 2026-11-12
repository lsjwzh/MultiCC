use super::*;
use crate::orchestration_store::{legacy, query, schema};

fn old_database() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch(schema::SQL).unwrap();
    for (key, value) in [
        ("databaseSchemaVersion", json!(1)),
        ("stateSchemaVersion", json!(3)),
        ("revision", json!(7)),
        ("updatedAt", json!(100)),
        ("nextOutboxSequence", json!(1)),
    ] {
        set_meta(&connection, key, &value).unwrap();
    }
    connection
}

fn database() -> Connection {
    let connection = old_database();
    upgrade(&connection).unwrap();
    connection
}

fn body_count(connection: &Connection) -> usize {
    connection
        .query_row(
            "SELECT count(*) FROM orchestration_record_bodies",
            [],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn terminal_receipts_preserve_utf16_and_unknown_fields_in_one_original() {
    let connection = database();
    let raw = format!(
        r#"{{"id":"task","status":"completed","taskId":"domain-task","result":"{}\ud800","extension":{{"\udc00":"retained"}},"updatedAt":10}}"#,
        "large output ".repeat(5000)
    );
    write_record_json(&connection, "tasks", "task", &raw).unwrap();
    let hot: String = connection
        .query_row(
            "SELECT data_json FROM orchestration_tasks WHERE id='task'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(hot.len() < 200);
    assert!(!hot.contains("result"));
    assert_eq!(body_count(&connection), 1);
    assert_eq!(
        record::parse(
            &record::get_json(&connection, "tasks", "task", &[])
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        record::parse(&raw).unwrap()
    );

    // An unrelated corrupt body cannot interfere with status-only execution.
    connection
        .execute(
            "UPDATE orchestration_record_bodies SET data_json='invalid-json'",
            [],
        )
        .unwrap();
    assert_eq!(
        record::get_json(&connection, "tasks", "task", &[JsValue::string("status")])
            .unwrap()
            .unwrap(),
        "\"completed\""
    );
    let rows = query::select(&connection, &json!({"collection":"tasks","options":{"where":{"status":"completed"},"fields":["id","status"]}}), "select").unwrap();
    assert_eq!(
        record::parse(rows["rowsJson"][0].as_str().unwrap()).unwrap(),
        record::parse(r#"{"id":"task","status":"completed"}"#).unwrap()
    );
}

#[test]
fn body_fields_support_filter_sort_projection_and_dirty_overlays() {
    let connection = database();
    for (id, score) in [("a", 2), ("b", 1), ("c", 3)] {
        write_record_json(&connection, "tasks", id, &json!({"id":id,"status":"completed","custom":{"score":score,"text":format!("body-{id}")}}).to_string()).unwrap();
    }
    let input = json!({"collection":"tasks","options":{"where":{"custom.score":{"$gte":2}},"orderBy":"custom.score","descending":true,"fields":["id","custom.text"],"limit":2},"overrides":[{"key":"a","valueJson":r#"{"id":"a","status":"completed","custom":{"score":4,"text":"changed"}}"#}]});
    let answer = query::select(&connection, &input, "select").unwrap();
    let rows: Vec<Value> = answer["rowsJson"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| serde_json::from_str(value.as_str().unwrap()).unwrap())
        .collect();
    assert_eq!(
        rows,
        vec![
            json!({"id":"a","custom":{"text":"changed"}}),
            json!({"id":"c","custom":{"text":"body-c"}})
        ]
    );
    assert_eq!(query::select(&connection, &input, "count").unwrap(), 2);
}

#[test]
fn body_lifecycle_is_atomic_on_update_rollback_reactivation_and_delete() {
    let connection = database();
    let original = r#"{"id":"a","status":"completed","result":"original"}"#;
    write_record_json(&connection, "tasks", "a", original).unwrap();
    connection.execute_batch("BEGIN IMMEDIATE").unwrap();
    write_record_json(
        &connection,
        "tasks",
        "a",
        r#"{"id":"a","status":"completed","result":"replacement"}"#,
    )
    .unwrap();
    connection.execute_batch("ROLLBACK").unwrap();
    assert_eq!(
        record::parse(
            &record::get_json(&connection, "tasks", "a", &[])
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        record::parse(original).unwrap()
    );
    write_record_json(
        &connection,
        "tasks",
        "a",
        r#"{"id":"a","status":"running","result":"continued"}"#,
    )
    .unwrap();
    assert_eq!(body_count(&connection), 0);
    assert!(record::get_json(&connection, "tasks", "a", &[])
        .unwrap()
        .unwrap()
        .contains("continued"));
    write_record_json(&connection, "tasks", "a", original).unwrap();
    connection
        .execute("DELETE FROM orchestration_tasks WHERE id='a'", [])
        .unwrap();
    assert_eq!(body_count(&connection), 0);
}

#[test]
fn all_terminal_collections_keep_dedupe_and_recovery_edges_hot() {
    let connection = database();
    let examples = [
        (
            "tasks",
            json!({"id":"t","status":"completed","taskId":"domain","completedAt":4,"result":"output"}),
        ),
        (
            "outbox",
            json!({"id":"o","state":"delivered","payloadHash":"hash","source":{"operationId":"op","taskId":"domain"},"payload":{"taskId":"domain","options":{"taskId":"domain"},"activeEntryId":"p","operationId":"op","message":"body"},"turnLineage":{"activeEntryId":"p","taskId":"domain"},"sequence":1}),
        ),
        (
            "operations",
            json!({"id":"op","status":"completed","idempotencyKeyHash":"ih","requestHash":"rh","resultHash":"sh","requestOutboxId":"o","resultOutboxId":"r","spec":{"taskId":"domain","options":{"taskId":"domain"},"message":"body"},"result":{"taskId":"domain","source":"receipt","text":"output"}}),
        ),
        (
            "waits",
            json!({"id":"w","status":"resolved","callbackTokenHash":"ch","resolutionPayloadHash":"ph","outboxId":"o","metadata":{"taskId":"domain","originDispatchId":"op"},"resolution":{"text":"output"}}),
        ),
    ];
    for (collection, value) in examples {
        write_record_json(
            &connection,
            collection,
            value["id"].as_str().unwrap(),
            &value.to_string(),
        )
        .unwrap();
        let (table, _) = table(collection).unwrap();
        let hot: String = connection
            .query_row(&format!("SELECT data_json FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(!hot.contains("body") && !hot.contains("output"), "{hot}");
        let parsed = record::parse(&hot).unwrap();
        for field in FIELDS {
            if let Some(expected) = get(&record::parse(&value.to_string()).unwrap(), field) {
                assert_eq!(get(&parsed, field), Some(expected), "{collection}.{field}");
            }
        }
    }
    assert_eq!(body_count(&connection), 4);
}

#[test]
fn schema_upgrade_and_backfill_are_bounded_resumable_and_revision_neutral() {
    let connection = old_database();
    for id in ["", "b", "c", "d", "e"] {
        let status = if id == "c" { "running" } else { "completed" };
        let raw = json!({"id":id,"status":status,"result":"original"}).to_string();
        connection
            .execute(
                "INSERT INTO orchestration_tasks(id,data_json,status) VALUES(?1,?2,?3)",
                params![id, raw, status],
            )
            .unwrap();
    }
    assert!(upgrade(&connection).unwrap());
    assert!(!upgrade(&connection).unwrap());
    assert_eq!(meta(&connection, "databaseSchemaVersion").unwrap(), 2);
    assert_eq!(body_count(&connection), 0, "upgrade must not scan records");
    let first = compact(&connection, 2).unwrap();
    assert_eq!(first["scannedRecords"], 2);
    assert_eq!(first["compactedRecords"], 2);
    assert_eq!(first["complete"], false);
    let second = compact(&connection, 2).unwrap();
    assert_eq!(second["scannedRecords"], 2);
    assert_eq!(second["compactedRecords"], 1);
    let third = compact(&connection, 2).unwrap();
    assert_eq!(third["complete"], true);
    assert_eq!(body_count(&connection), 4);
    assert_eq!(meta(&connection, "revision").unwrap(), 7);
    assert_eq!(compact(&connection, 2).unwrap()["scannedRecords"], 0);
    let plan: String = connection.query_row("EXPLAIN QUERY PLAN SELECT id FROM orchestration_tasks WHERE id>?1 ORDER BY id LIMIT ?2",params!["b",2],|row|row.get(3)).unwrap();
    assert!(plan.contains("SEARCH"), "{plan}");
}

#[test]
fn schema_validation_rejects_a_replaced_cleanup_trigger() {
    let connection = database();
    validate(&connection).unwrap();
    connection.execute_batch("DROP TRIGGER orchestration_tasks_body_delete; CREATE TRIGGER orchestration_tasks_body_delete AFTER DELETE ON orchestration_tasks BEGIN SELECT 1; END;").unwrap();
    assert!(validate(&connection)
        .unwrap_err()
        .contains("cleanup trigger is invalid"));
}

#[test]
fn missing_original_fails_closed_instead_of_returning_a_partial_record() {
    let connection = database();
    write_record_json(
        &connection,
        "tasks",
        "a",
        r#"{"id":"a","status":"completed","result":"must not vanish"}"#,
    )
    .unwrap();
    connection
        .execute("DELETE FROM orchestration_record_bodies", [])
        .unwrap();
    assert!(record::get_json(&connection, "tasks", "a", &[]).is_err());
    assert!(query::select(
        &connection,
        &json!({"collection":"tasks","options":{}}),
        "select"
    )
    .is_err());
    assert!(compact(&connection, 10)
        .unwrap_err()
        .contains("reference does not match"));
    assert_eq!(
        record::get_json(&connection, "tasks", "a", &[JsValue::string("status")])
            .unwrap()
            .unwrap(),
        "\"completed\""
    );
}

#[test]
fn hot_leaf_projection_preserves_non_object_parents_and_nested_values() {
    let connection = database();
    for (index, spec) in [
        json!(null),
        json!(4),
        json!([{"chatId":"nested-array"}]),
        json!({"chatId":null}),
        json!({"chatId":{"child":"exact"}}),
    ]
    .into_iter()
    .enumerate()
    {
        let key = index.to_string();
        let raw = json!({"id":key,"status":"completed","spec":spec}).to_string();
        write_record_json(&connection, "operations", &key, &raw).unwrap();
        let parent = record::get_json(&connection, "operations", &key, &[JsValue::string("spec")])
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&parent).unwrap(), spec);
        let child = record::get_json(
            &connection,
            "operations",
            &key,
            &[JsValue::string("spec"), JsValue::string("chatId")],
        )
        .unwrap();
        assert_eq!(
            child.map(|raw| serde_json::from_str::<Value>(&raw).unwrap()),
            spec.as_object()
                .and_then(|value| value.get("chatId"))
                .cloned()
        );
    }
}

#[test]
fn failed_compaction_rolls_back_receipts_bodies_and_durable_progress() {
    let connection = old_database();
    for id in ["a", "b"] {
        connection
            .execute(
                "INSERT INTO orchestration_tasks(id,data_json,status) VALUES(?1,?2,'completed')",
                params![
                    id,
                    json!({"id":id,"status":"completed","result":"original"}).to_string()
                ],
            )
            .unwrap();
    }
    upgrade(&connection).unwrap();
    let before = progress(&connection).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_body BEFORE INSERT ON orchestration_record_bodies WHEN NEW.record_key='b' BEGIN SELECT RAISE(ABORT,'injected body failure'); END;").unwrap();
    assert!(compact(&connection, 2)
        .unwrap_err()
        .contains("injected body failure"));
    assert_eq!(body_count(&connection), 0);
    assert_eq!(progress(&connection).unwrap(), before);
    assert_eq!(meta(&connection, "revision").unwrap(), 7);
    assert!(record::get_json(&connection, "tasks", "a", &[])
        .unwrap()
        .unwrap()
        .contains("original"));
    connection.execute_batch("DROP TRIGGER fail_body").unwrap();
    assert_eq!(compact(&connection, 2).unwrap()["compactedRecords"], 2);
}

#[test]
fn schema_one_rollback_export_is_read_only_and_complete() {
    let connection = old_database();
    let raw = r#"{"id":"a","status":"completed","result":"original","extension":{"keep":true}}"#;
    connection
        .execute(
            "INSERT INTO orchestration_tasks(id,data_json,status) VALUES('a',?1,'completed')",
            [raw],
        )
        .unwrap();
    connection.execute_batch("PRAGMA query_only=ON").unwrap();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let target = std::env::temp_dir().join(format!(
        "multicc-receipt-export-{}-{stamp}.json",
        std::process::id()
    ));
    legacy::export(&connection, &target).unwrap();
    let exported: Value = serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
    std::fs::remove_file(target).unwrap();
    assert_eq!(
        exported["tasks"]["a"],
        serde_json::from_str::<Value>(raw).unwrap()
    );
    assert_eq!(meta(&connection, "databaseSchemaVersion").unwrap(), 1);
}
