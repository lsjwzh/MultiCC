//! Pure policy for task-history retention and deletion refusal formatting
//! (former `src/session/task-history-retention.js`).

use std::collections::{HashMap, HashSet};

pub const DEFAULT_REFUSAL_CODE: &str = "history_check_failed";
pub const REFUSAL_REASON: &str = "task_history_referenced";
pub const REFUSAL_HINT: &str = "请先删除这些任务，或在会话内「清空历史」再删。";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRefSummary {
    pub session_id: Option<String>,
    pub user_msg_id: Option<String>,
    pub assistant_msg_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSummary {
    pub id: String,
    pub title: Option<String>,
    pub deleting: bool,
    pub chat_session_id: Option<String>,
    pub worker_session_id: Option<String>,
    pub refs: Vec<TaskRefSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageSummary {
    pub id: Option<String>,
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferencedTask {
    pub id: String,
    pub title: String,
    pub via: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionDeletionFacts {
    pub execution_slot: bool,
    pub session_links: Vec<String>,
    pub routing_links: Vec<String>,
    pub message_links: Vec<String>,
    pub references: Vec<ReferencedTask>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefusalTaskInput {
    pub id: Option<String>,
    pub title: Option<String>,
    pub via: Option<String>,
}

pub fn format_refusal_message(tasks: &[RefusalTaskInput]) -> String {
    let quote = |items: &[&str]| -> String {
        items
            .iter()
            .map(|item| format!("「{item}」"))
            .collect::<Vec<_>>()
            .join("、")
    };
    fn name_of(task: &RefusalTaskInput) -> Option<&str> {
        task.title
            .as_deref()
            .filter(|s| !s.is_empty())
            .or_else(move || task.id.as_deref().filter(|s| !s.is_empty()))
    }
    let external: Vec<&str> = tasks
        .iter()
        .filter(|t| t.via.as_deref() != Some("messages"))
        .filter_map(name_of)
        .collect();
    let colocated: Vec<&str> = tasks
        .iter()
        .filter(|t| t.via.as_deref() == Some("messages"))
        .filter_map(name_of)
        .collect();
    let mut groups = Vec::new();
    if !external.is_empty() {
        groups.push(format!("引用它的任务：{}", quote(&external)));
    }
    if !colocated.is_empty() {
        groups.push(format!("同一对话中的任务：{}", quote(&colocated)));
    }
    if groups.is_empty() {
        format!("会话历史仍被任务引用，无法删除。{REFUSAL_HINT}")
    } else {
        format!(
            "会话历史仍被任务引用，无法删除（{}）。{REFUSAL_HINT}",
            groups.join("；")
        )
    }
}

pub fn active_tasks(tasks: &[TaskSummary]) -> Vec<&TaskSummary> {
    tasks.iter().filter(|t| !t.deleting).collect()
}

pub fn has_session_link(task: &TaskSummary, session_id: &str) -> bool {
    task.chat_session_id.as_deref() == Some(session_id)
        || task.worker_session_id.as_deref() == Some(session_id)
        || task
            .refs
            .iter()
            .any(|r| r.session_id.as_deref() == Some(session_id))
}

pub fn is_message_protected(
    session_id: &str,
    message: &MessageSummary,
    tasks_by_id: &HashMap<String, TaskSummary>,
    all_tasks: &[TaskSummary],
    deleted_task_ids: &[String],
) -> bool {
    if let Some(task_id) = message.task_id.as_deref().filter(|s| !s.is_empty()) {
        let is_deleting = tasks_by_id.get(task_id).is_some_and(|task| task.deleting);
        let in_deleted = deleted_task_ids.iter().any(|id| id == task_id);
        if !is_deleting && !in_deleted {
            return true;
        }
    }
    active_tasks(all_tasks).into_iter().any(|task| {
        task.refs.iter().any(|r| {
            if r.session_id.as_deref() != Some(session_id) {
                return false;
            }
            let no_msg_ids = r.user_msg_id.as_deref().is_none_or(str::is_empty)
                && r.assistant_msg_id.as_deref().is_none_or(str::is_empty);
            if no_msg_ids {
                return true;
            }
            match message.id.as_deref() {
                Some(msg_id) => {
                    r.user_msg_id.as_deref() == Some(msg_id)
                        || r.assistant_msg_id.as_deref() == Some(msg_id)
                }
                None => false,
            }
        })
    })
}

pub fn collect_references(
    session_id: &str,
    all_tasks: &[TaskSummary],
    messages: &[MessageSummary],
) -> Vec<ReferencedTask> {
    let active = active_tasks(all_tasks);
    let by_id: HashMap<&str, &TaskSummary> = active.iter().map(|t| (t.id.as_str(), *t)).collect();
    let mut found = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();

    // A nested fn (not a closure) so the stored id borrows are tied to the
    // `all_tasks` lifetime explicitly; a closure parameter would be HRTB-bound
    // and could not escape into `seen`.
    fn add<'a>(
        task: &'a TaskSummary,
        via: &'static str,
        seen: &mut HashSet<&'a str>,
        found: &mut Vec<ReferencedTask>,
    ) {
        if task.id.is_empty() || !seen.insert(task.id.as_str()) {
            return;
        }
        let title = task
            .title
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(task.id.as_str())
            .to_string();
        found.push(ReferencedTask {
            id: task.id.clone(),
            title,
            via,
        });
    }

    for task in &active {
        if has_session_link(task, session_id) {
            add(task, "session", &mut seen, &mut found);
        }
    }
    for msg in messages {
        if let Some(task_id) = msg.task_id.as_deref().filter(|s| !s.is_empty()) {
            if let Some(task) = by_id.get(task_id) {
                add(task, "messages", &mut seen, &mut found);
            }
        }
    }
    found
}

pub fn compute_session_deletion_facts(
    session_id: &str,
    execution_slot: bool,
    all_tasks: &[TaskSummary],
    messages: &[MessageSummary],
) -> SessionDeletionFacts {
    if execution_slot {
        return SessionDeletionFacts {
            execution_slot: true,
            session_links: Vec::new(),
            routing_links: Vec::new(),
            message_links: Vec::new(),
            references: Vec::new(),
        };
    }
    let active = active_tasks(all_tasks);
    let mut session_links = Vec::new();
    let mut routing_links = Vec::new();
    for task in &active {
        if task.id.is_empty() {
            continue;
        }
        let formal = task.chat_session_id.as_deref() == Some(session_id)
            || task
                .refs
                .iter()
                .any(|r| r.session_id.as_deref() == Some(session_id));
        if formal {
            session_links.push(task.id.clone());
        } else if task.worker_session_id.as_deref() == Some(session_id) {
            routing_links.push(task.id.clone());
        }
    }
    let active_ids: HashSet<&str> = active.iter().map(|t| t.id.as_str()).collect();
    let mut seen_msg_ids: HashSet<&str> = HashSet::new();
    let mut message_links = Vec::new();
    for msg in messages {
        if let Some(task_id) = msg.task_id.as_deref().filter(|s| !s.is_empty()) {
            if active_ids.contains(task_id) && seen_msg_ids.insert(task_id) {
                message_links.push(task_id.to_string());
            }
        }
    }
    SessionDeletionFacts {
        execution_slot: false,
        session_links,
        routing_links,
        message_links,
        references: collect_references(session_id, all_tasks, messages),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusal_message_groups_external_and_colocated_tasks() {
        let grouped = format_refusal_message(&[
            RefusalTaskInput {
                id: Some("a".into()),
                title: Some("外部任务".into()),
                via: Some("session".into()),
            },
            RefusalTaskInput {
                id: Some("b".into()),
                title: Some("同壳任务".into()),
                via: Some("messages".into()),
            },
        ]);
        assert!(grouped.contains("引用它的任务：「外部任务」"));
        assert!(grouped.contains("同一对话中的任务：「同壳任务」"));
        assert!(grouped.contains("；"));

        let bare = format_refusal_message(&[]);
        assert_eq!(
            bare,
            "会话历史仍被任务引用，无法删除。请先删除这些任务，或在会话内「清空历史」再删。"
        );
    }

    #[test]
    fn message_protection_honors_orphan_suppression_and_provisional_stamps() {
        let tasks = vec![TaskSummary {
            id: "t1".into(),
            title: Some("T1".into()),
            deleting: false,
            chat_session_id: None,
            worker_session_id: None,
            refs: vec![TaskRefSummary {
                session_id: Some("s1".into()),
                user_msg_id: Some("u1".into()),
                assistant_msg_id: None,
            }],
        }];
        let by_id: HashMap<String, TaskSummary> =
            tasks.iter().cloned().map(|t| (t.id.clone(), t)).collect();

        // Provisional stamp (not in board, not in deletedTaskIds) stays protected
        assert!(is_message_protected(
            "s1",
            &MessageSummary {
                id: Some("m0".into()),
                task_id: Some("prov".into()),
            },
            &by_id,
            &tasks,
            &[],
        ));
        // Orphan stamp present in deletedTaskIds is NOT protected
        assert!(!is_message_protected(
            "s1",
            &MessageSummary {
                id: Some("m0".into()),
                task_id: Some("gone".into()),
            },
            &by_id,
            &tasks,
            &["gone".to_string()],
        ));
        // Explicit ref match protects message
        assert!(is_message_protected(
            "s1",
            &MessageSummary {
                id: Some("u1".into()),
                task_id: None,
            },
            &by_id,
            &tasks,
            &[],
        ));
    }

    #[test]
    fn deletion_facts_separate_session_routing_and_message_buckets() {
        let tasks = vec![
            TaskSummary {
                id: "bound".into(),
                title: Some("Bound".into()),
                deleting: false,
                chat_session_id: Some("s1".into()),
                worker_session_id: None,
                refs: vec![],
            },
            TaskSummary {
                id: "worker".into(),
                title: Some("Worker".into()),
                deleting: false,
                chat_session_id: None,
                worker_session_id: Some("s1".into()),
                refs: vec![],
            },
            TaskSummary {
                id: "byMsg".into(),
                title: None,
                deleting: false,
                chat_session_id: None,
                worker_session_id: None,
                refs: vec![],
            },
            TaskSummary {
                id: "deleting".into(),
                title: Some("Del".into()),
                deleting: true,
                chat_session_id: Some("s1".into()),
                worker_session_id: None,
                refs: vec![],
            },
        ];
        let msgs = vec![
            MessageSummary {
                id: Some("u1".into()),
                task_id: Some("byMsg".into()),
            },
            MessageSummary {
                id: Some("u2".into()),
                task_id: Some("byMsg".into()),
            },
        ];
        let facts = compute_session_deletion_facts("s1", false, &tasks, &msgs);
        assert!(!facts.execution_slot);
        assert_eq!(facts.session_links, vec!["bound"]);
        assert_eq!(facts.routing_links, vec!["worker"]);
        assert_eq!(facts.message_links, vec!["byMsg"]);
        assert_eq!(facts.references.len(), 3);
        assert_eq!(facts.references[2].title, "byMsg");
        assert_eq!(facts.references[2].via, "messages");

        let slot = compute_session_deletion_facts("s1", true, &tasks, &msgs);
        assert!(slot.execution_slot);
        assert!(slot.references.is_empty());
    }
}
