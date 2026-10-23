//! Explicit task reads span projects; ownership still selects the messages.
//! These helpers operate only on metadata supplied by the host, with no I/O.
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

fn id<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field)?.as_str().filter(|value| !value.is_empty())
}

fn parse<T: serde::de::DeserializeOwned>(input: &str) -> Result<T, String> {
    serde_json::from_str(input).map_err(|error| format!("invalid task context input: {error}"))
}

#[derive(Deserialize)]
struct ReadInput {
    target: Value,
    #[serde(default)]
    links: Vec<Value>,
    #[serde(default)]
    shells: Vec<Value>,
    #[serde(default)]
    tasks: Vec<Value>,
}

pub fn plan_read(input: &str) -> Result<String, String> {
    let input: ReadInput = parse(input)?;
    let target_id = id(&input.target, "id").ok_or("task context target id is required")?;
    let owners: HashSet<_> = input
        .links
        .iter()
        .filter(|link| id(link, "taskId") == Some(target_id))
        .filter_map(|link| id(link, "shellId"))
        .collect();
    let scope_tasks: HashSet<_> = input
        .links
        .iter()
        .filter(|link| id(link, "shellId").is_some_and(|shell| owners.contains(shell)))
        .filter_map(|link| id(link, "taskId"))
        .collect();
    let mut seen = HashSet::new();
    let mut sessions = Vec::new();
    let mut append = |session: Option<&str>| {
        if let Some(session) = session.filter(|session| !session.is_empty()) {
            if seen.insert(session.to_owned()) {
                sessions.push(session.to_owned());
            }
        }
    };
    append(id(&input.target, "sessionId"));
    append(id(&input.target, "chatSessionId"));
    if let Some(history) = input
        .target
        .get("historySessionIds")
        .and_then(Value::as_array)
    {
        for session in history {
            append(session.as_str());
        }
    }
    if let Some(refs) = input.target.get("refs").and_then(Value::as_array) {
        for reference in refs {
            append(id(reference, "sessionId"));
        }
    }
    for shell in &input.shells {
        if id(shell, "id").is_some_and(|shell| owners.contains(shell)) {
            append(id(shell, "sourceSessionId"));
        }
    }
    for task in &input.tasks {
        if id(task, "id").is_some_and(|task| scope_tasks.contains(task)) {
            append(id(task, "sessionId"));
        }
    }
    Ok(json!({ "sessionIds": sessions }).to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectInput {
    target_id: String,
    records: Vec<Value>,
    #[serde(default)]
    bindings: Vec<Value>,
}

pub fn select_records(input: &str) -> Result<String, String> {
    let input: SelectInput = parse(input)?;
    if input.target_id.is_empty() {
        return Err("task context target id is required".into());
    }
    let bindings: HashMap<_, _> = input
        .bindings
        .iter()
        .filter_map(|binding| Some((id(binding, "sessionId")?, id(binding, "taskBoundTaskId")?)))
        .collect();
    let records: Vec<_> = input
        .records
        .into_iter()
        .filter_map(|mut record| {
            if id(&record, "taskId") == Some(input.target_id.as_str()) {
                return Some(record);
            }
            let unassigned = match record.get("taskId") {
                None | Some(Value::Null) => true,
                Some(Value::String(task)) => task.is_empty(),
                _ => false,
            };
            if unassigned
                && id(&record, "sourceSessionId").and_then(|session| bindings.get(session).copied())
                    == Some(input.target_id.as_str())
            {
                record
                    .as_object_mut()?
                    .insert("taskId".into(), json!(input.target_id));
                return Some(record);
            }
            None
        })
        .collect();
    Ok(Value::Array(records).to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RankInput {
    #[serde(default)]
    dir_id: Option<String>,
    candidates: Vec<Value>,
}

fn priority(candidate: &Value) -> f64 {
    candidate
        .get("priority")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}

pub fn rank_candidates(input: &str) -> Result<String, String> {
    let mut input: RankInput = parse(input)?;
    if let Some(dir) = input.dir_id.as_deref().filter(|dir| !dir.is_empty()) {
        for candidate in &mut input.candidates {
            if id(candidate, "sourceDirId") == Some(dir) {
                let weighted = priority(candidate) + 100.0;
                candidate
                    .as_object_mut()
                    .unwrap()
                    .insert("priority".into(), json!(weighted));
            }
        }
    }
    input
        .candidates
        .sort_by(|a, b| priority(b).total_cmp(&priority(a)));
    Ok(Value::Array(input.candidates).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(function: fn(&str) -> Result<String, String>, input: Value) -> Value {
        serde_json::from_str(&function(&input.to_string()).unwrap()).unwrap()
    }

    #[test]
    fn task_context_plan_spans_projects_and_shell_executions_without_duplicates() {
        let result = run(
            plan_read,
            json!({
                "target": {"id":"target", "dirId":"other-project", "sessionId":"bound", "chatSessionId":"chat",
                    "historySessionIds":["old", "bound", "", null], "refs":[{"sessionId":"ref"}, {}]},
                "links": [{"taskId":"target", "shellId":"owner"}, {"taskId":"neighbor", "shellId":"owner"},
                    {"taskId":"unrelated", "shellId":"elsewhere"}],
                "shells": [{"id":"owner", "sourceSessionId":"source", "dirId":"another-project"},
                    {"id":"elsewhere", "sourceSessionId":"unrelated"}],
                "tasks": [{"id":"target", "sessionId":"bound"}, {"id":"neighbor", "sessionId":"neighbor-session"},
                    {"id":"unrelated", "sessionId":"unrelated"}]
            }),
        );
        assert_eq!(
            result,
            json!({"sessionIds":["bound","chat","old","ref","source","neighbor-session"]})
        );
    }

    #[test]
    fn task_context_plan_does_not_require_project_or_task_relationship() {
        assert_eq!(
            run(
                plan_read,
                json!({"target":{"id":"target","sessionId":"source"}})
            ),
            json!({"sessionIds":["source"]})
        );
        assert!(plan_read(r#"{"target":{}}"#).is_err());
    }

    #[test]
    fn task_context_select_keeps_ownership_and_preserves_evidence_fields() {
        let tagged = json!({"taskId":"target", "sourceSessionId":"shared", "contextMessageId":"shared:one",
            "partial":true, "error":{"message":"failed"}, "cancelled":true, "inProgress":true,
            "sourceWorkspace":"/old/worktree", "tools":[{"status":"error"}], "custom":{"version":2}});
        let untagged = json!({"sourceSessionId":"bound", "contextMessageId":"bound:two", "content":"legacy", "_interim":true});
        let result = run(
            select_records,
            json!({"targetId":"target", "records":[tagged.clone(), untagged,
            {"sourceSessionId":"bound", "taskId":"", "id":"empty"},
            {"sourceSessionId":"bound", "taskId":null, "id":"null"},
            {"sourceSessionId":"bound", "taskId":"another", "id":"different-owner"},
            {"sourceSessionId":"shared", "id":"ambiguous"}],
            "bindings":[{"sessionId":"bound", "taskBoundTaskId":"target"}]}),
        );
        assert_eq!(result.as_array().unwrap().len(), 4);
        assert_eq!(result[0], tagged);
        assert_eq!(
            result[1],
            json!({"taskId":"target", "sourceSessionId":"bound",
            "contextMessageId":"bound:two", "content":"legacy", "_interim":true})
        );
        assert_eq!(result[2]["taskId"], "target");
        assert_eq!(result[3]["taskId"], "target");
        assert!(select_records(r#"{"targetId":"","records":[]}"#).is_err());
    }

    #[test]
    fn task_context_rank_uses_project_as_soft_weight_and_keeps_external_candidates() {
        let result = run(
            rank_candidates,
            json!({"dirId":"local", "candidates":[
            {"taskId":"external", "sourceDirId":"elsewhere", "priority":50, "kind":"group"},
            {"taskId":"local", "sourceDirId":"local", "priority":1, "kind":"relevant"},
            {"taskId":"strong", "sourceDirId":"elsewhere", "priority":200},
            {"taskId":"tie", "sourceDirId":"elsewhere", "priority":50}]}),
        );
        let ids: Vec<_> = result
            .as_array()
            .unwrap()
            .iter()
            .map(|candidate| candidate["taskId"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["strong", "local", "external", "tie"]);
        assert_eq!(result[1]["priority"], 101.0);
        assert_eq!(result[2]["kind"], "group");
        assert_eq!(result[2]["sourceDirId"], "elsewhere");
    }

    #[test]
    fn task_context_missing_project_receives_no_boost() {
        for dir in [Value::Null, json!("")] {
            let candidates = json!([{"taskId":"first", "priority":1}, {"taskId":"second", "sourceDirId":"", "priority":0}]);
            assert_eq!(
                run(
                    rank_candidates,
                    json!({"dirId":dir,"candidates":candidates})
                ),
                candidates
            );
        }
    }
}
