//! Adopt persisted ordinary chats before the standalone gateway accepts traffic.
//! SQLite owns identity and roles. The board projection precedes its SQLite
//! completion marker, so a crash at either file boundary is retryable.
use super::{shell, store};
use multicc_core::{
    durable_state,
    js::{self, JsValue},
    quota_guard, random_id,
    task_domain::{classification, normalize, repository, text, truth},
};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path};

pub(crate) fn index(file: &Path, board: &mut Value, task: &Value) -> Result<(), String> {
    let id = text(&task["id"]);
    let card = &board["tasks"][id];
    if card.is_null() {
        let nonce = random_id::random_uuid_v4().map_err(|err| err.to_string())?;
        let input = json!({"taskId":id,"dirId":task["dirId"],"sessionId":task["sessionId"],
            "taskText":task["title"],"origin":"manual","now":task["createdAt"]});
        let added = classification::pending(board, &input, &json!({"newIds":[nonce]}), &mut 0);
        if added["id"] != id {
            return Err("task_index_failed".into());
        }
    }
    let card = &mut board["tasks"][id];
    let session_origin = truth(&task["ownerShellId"])
        && !truth(&task["forkedFromTaskId"])
        && !truth(&card["routing"]);
    let changed = card.get("chatSessionId") != task.get("sessionId")
        || card.get("ownerShellId") != task.get("ownerShellId")
        || card.get("forkedFromTaskId") != Some(&task["forkedFromTaskId"])
        || (session_origin && card["origin"] != "session");
    if !changed {
        return Ok(());
    }
    card["chatSessionId"] = task["sessionId"].clone();
    if let Some(owner) = task.get("ownerShellId") {
        card["ownerShellId"] = owner.clone();
    }
    card["forkedFromTaskId"] = task["forkedFromTaskId"].clone();
    if session_origin {
        card["origin"] = json!("session");
    }
    let revision = board["revision"].as_f64().unwrap_or(0.0);
    if !(0.0..9_007_199_254_740_991.0).contains(&revision) || revision.fract() != 0.0 {
        return Err("invalid task board revision".into());
    }
    board["revision"] = json!(revision as u64 + 1);
    repository::save_board(file, board, Some(&json!(revision)), false)?;
    Ok(())
}

pub(super) fn migrate(root: &Path) -> Result<(), String> {
    let records = store::records(root)?;
    if records.is_empty() {
        return Ok(());
    }
    let directories = match durable_state::load_or_recover(&root.join("directories.json"))? {
        Some(JsValue::Array(rows)) => rows
            .into_iter()
            .map(|row| (store::text(&row, "id"), js::to_serde(&row)))
            .collect::<HashMap<_, _>>(),
        None => return Ok(()),
        _ => return Err("invalid directory records".into()),
    };
    let eligible = records.iter().filter(|r| {
        store::text(r, "kind") == "chat"
            && !["aux", "gateway"].contains(&store::text(r, "type").as_str())
            && !js::truthy_opt(r.get("taskExecutionSlot"))
            && !js::truthy_opt(r.get("experimentalMode"))
            && directories.contains_key(&store::text(r, "dirId"))
    });
    let mut eligible = eligible.peekable();
    if eligible.peek().is_none() {
        return Ok(());
    }
    let file = root.join("task_board.json");
    let mut board = repository::read_board_snapshot(&file)?;
    if board.is_null() {
        board = normalize::empty();
    }
    // Preserve older board schemas for their existing planning migration.
    if board["schemaVersion"] != 2
        || !board["tasks"].is_object()
        || !(board["modules"].is_null() || board["modules"].is_object())
    {
        return Err("task board requires planning migration".into());
    }
    let mut tasks = shell::task_store(root)?;
    let mut bindings = HashMap::new();
    for record in eligible {
        let session = store::text(record, "id");
        let bound = store::text(record, "taskBoundTaskId");
        let known = tasks.chat_task_for_session(&session)?;
        if board["deletedTaskIds"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|id| id == &bound || id == &known["id"]))
        {
            continue;
        }
        let task_id = if known["taskFirst"] == true
            && tasks.first_task_is_indexed(text(&known["id"]))?
        {
            text(&known["id"]).to_owned()
        } else {
            let facts = shell::adoption_facts(root, &session, record, &board)?;
            let task =
                match tasks.adopt_first_task(&facts, &directories[&store::text(record, "dirId")]) {
                    Ok(task) => task,
                    // An inconsistent identity stays available for repair. Other
                    // sessions can still be adopted on this boot.
                    Err(error) if error.starts_with("TASK_RULE:") => {
                        eprintln!("[multicc-gateway] skipped task adoption for {session}: {error}");
                        continue;
                    }
                    Err(error) => return Err(error),
                };
            index(&file, &mut board, &task)?;
            let id = text(&task["id"]);
            tasks.mark_first_task_indexed(id, &session)?;
            id.to_owned()
        };
        if bound.is_empty() {
            bindings.insert(session, task_id);
        }
    }
    if !bindings.is_empty() {
        // The listener has not accepted any requests yet. Bind all completed
        // projections in one StateStore replacement and one backup rotation.
        let mut latest = store::records(root)?;
        for record in latest.iter_mut().rev() {
            let Some(id) = bindings.remove(&store::text(record, "id")) else {
                continue;
            };
            if !js::truthy_opt(record.get("taskBoundTaskId")) {
                quota_guard::set(record, "taskBoundTaskId", JsValue::from(id));
            }
        }
        durable_state::save(
            &root.join("sessions.json"),
            "sessions",
            &JsValue::Array(latest),
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn first_boot_preserves_owners_and_retries_an_unwritten_session_binding() {
        let root = std::env::temp_dir().join(random_id::prefixed_id("first_tasks").unwrap());
        fs::create_dir(&root).unwrap();
        let write =
            |file: &str, value: Value| fs::write(root.join(file), value.to_string()).unwrap();
        write("directories.json", json!([{"id":"d","rolePrompt":"owner"}]));
        let chat = json!({"id":"chat","kind":"chat","dirId":"d","label":"existing"});
        let records = json!([chat,{"id":"removed","kind":"chat","dirId":"d","taskBoundTaskId":"gone"},
            {"id":"other","kind":"chat","dirId":"d","taskBoundTaskId":"taken"},
            {"id":"worker","kind":"chat","dirId":"d","taskExecutionSlot":true}]);
        write("sessions.json", records.clone());
        write(
            "task_board.json",
            json!({"schemaVersion":2,"revision":4,"tasks":{
            "taken":{"id":"taken","title":"existing","chatSessionId":"original"}},"deletedTaskIds":["gone"]}),
        );
        migrate(&root).unwrap();
        let board = repository::read_board_snapshot(&root.join("task_board.json")).unwrap();
        let adopted = shell::task_store(&root)
            .unwrap()
            .chat_task_for_session("chat")
            .unwrap();
        let id = text(&adopted["id"]);
        assert!(!id.is_empty());
        assert_eq!(board["tasks"][id]["title"], "existing");
        assert_eq!(board["tasks"]["taken"]["chatSessionId"], "original");
        assert!(board["tasks"]["gone"].is_null());
        assert_eq!(board["tasks"].as_object().unwrap().len(), 2);
        let tasks = shell::task_store(&root).unwrap();
        for unsupported in ["other", "removed", "worker"] {
            assert!(tasks.chat_task_for_session(unsupported).unwrap().is_null());
        }
        assert!(tasks.first_task_is_indexed(id).unwrap());
        drop(tasks);
        // Interruption after projection/marker, before the session table was saved.
        write("sessions.json", records);
        migrate(&root).unwrap();
        let rows = store::records(&root).unwrap();
        assert_eq!(
            store::text(store::lookup(&rows, "chat").unwrap(), "taskBoundTaskId"),
            id
        );
        assert_eq!(
            repository::read_board_snapshot(&root.join("task_board.json")).unwrap(),
            board
        );
        fs::remove_dir_all(root).unwrap();
    }
}
