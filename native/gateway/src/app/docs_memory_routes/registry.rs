//! Standalone registry read model. Retention traverses only local publication
//! files, with the same shared scan budget across primary and legacy roots.
use super::super::directory_list::records;
use futures_util::{stream, StreamExt};
use multicc_core::artifact_retention::retained;
use multicc_core::{
    docs_memory_routes::{
        artifact_id_from_url, normalize_dir, sort_views, task_id_for, valid_artifact_id, view,
        ViewFacts,
    },
    task_store::TaskStore,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
    time::Duration,
};
use url::Url;

pub(super) fn views(root: &Path, roots: &[PathBuf]) -> Result<Vec<Value>, String> {
    let mut entries: Vec<Value> = match fs::read(root.join("docs_registry.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    for entry in &mut entries {
        if entry["pinned"] == true && entry.get("permanent").is_none() {
            entry["permanent"] = json!(true);
        }
    }
    let keep = retained(&entries, roots)
        .or_else(|_| retained(&entries, &[]))
        .map_err(|e| e.to_string())?;
    let ids = entries
        .iter()
        .filter_map(task_id_for)
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    let titles = TaskStore::document_task_titles(&root.join("task-shells.sqlite"), &ids)?;
    let mut session_dirs = HashMap::new();
    if entries.iter().any(|e| {
        e["sessionId"].is_string()
            && normalize_dir(e.get("dir")).is_none()
            && normalize_dir(e.get("cwd")).is_none()
    }) {
        let dirs: HashMap<_, _> = records(&root.join("directories.json"))?
            .into_iter()
            .filter_map(|d| Some((d["id"].as_str()?.to_owned(), normalize_dir(d.get("path"))?)))
            .collect();
        for s in records(&root.join("sessions.json"))? {
            if let (Some(id), Some(dir)) = (
                s["id"].as_str(),
                s["dirId"].as_str().and_then(|id| dirs.get(id)),
            ) {
                session_dirs.insert(id.to_owned(), dir.clone());
            }
        }
    }
    let mut views = entries
        .iter()
        .map(|e| {
            let artifact = super::artifact_of(e);
            let id = artifact.as_str().filter(|id| valid_artifact_id(id));
            let facts = ViewFacts {
                session_dir: e["sessionId"]
                    .as_str()
                    .and_then(|id| session_dirs.get(id))
                    .cloned(),
                task_title: task_id_for(e)
                    .as_ref()
                    .and_then(Value::as_str)
                    .and_then(|id| titles.get(id))
                    .cloned()
                    .unwrap_or(Value::Null),
                exists: artifact
                    .as_str()
                    .map(|_| id.is_some_and(|id| roots.iter().any(|r| r.join(id).is_dir()))),
                retained: id.is_some_and(|id| keep.contains(id)),
            };
            view(e, &facts)
        })
        .collect::<Vec<_>>();
    sort_views(&mut views);
    Ok(views)
}

pub(super) async fn probe_services(views: Vec<Value>) -> Vec<Value> {
    stream::iter(views)
        .map(|mut entry| async move {
            if entry["kind"] == "service" {
                let port = entry["port"]
                    .as_u64()
                    .and_then(|n| u16::try_from(n).ok())
                    .or_else(|| Url::parse(entry["url"].as_str()?).ok()?.port())
                    .filter(|n| *n != 0);
                if let Some(port) = port {
                    let up = matches!(
                        tokio::time::timeout(
                            Duration::from_secs(2),
                            tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
                        )
                        .await,
                        Ok(Ok(_))
                    );
                    entry["port"] = json!(port);
                    entry["status"] = json!(if up { "up" } else { "down" });
                    entry["lastCheckAt"] = json!(super::current_iso());
                    if up {
                        entry["lastUpAt"] = entry["lastCheckAt"].clone();
                    }
                } else {
                    entry["status"] = json!("unknown");
                }
            }
            entry
        })
        .buffered(16)
        .collect()
        .await
}
