//! Workspace admission and execution permits use the same records and writer
//! fence as stopped-delivery finalization.
use super::{err, items, text, Result, TaskStore};
use crate::{js::serde::truthy, random_id};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const RECORD: &str = "workspace:record";
const LEASE: &str = "workspace:lease";
const OPERATION: &str = "workspace:operation";
const RECORDS: &str = "rows:workspace:record";
const LEASES: &str = "rows:workspace:lease";

fn active(lease: &Value) -> bool {
    matches!(
        text(&lease["state"]),
        "reserved" | "materializing" | "starting" | "running" | "uncertain"
    )
}

fn budget(input: &Value, key: &str) -> Result<usize> {
    input[key]
        .as_u64()
        .filter(|n| (1..=9_007_199_254_740_991).contains(n))
        .map(|n| usize::try_from(n).unwrap_or(usize::MAX))
        .ok_or_else(|| "positive workspace budgets required".into())
}

impl TaskStore {
    pub fn reserve_chat_materialization(&mut self, input: &Value) -> Result<Value> {
        self.atomic(|store| {
            let session = text(&input["sessionId"]);
            let path = text(&input["path"]);
            if session.is_empty()
                || path.is_empty()
                || text(&input["dirId"]).is_empty()
                || text(&input["branch"]).is_empty()
            {
                return Err("workspace_identity_missing".into());
            }
            let hash = format!("{:x}", Sha256::digest(path.as_bytes()));
            let id = format!("ws_{}", &hash[..32]);
            let bound = store.get("workspace:binding", session)?;
            if !bound.is_null() && bound["workspaceId"] != id {
                return Err("workspace_binding_conflict".into());
            }
            let existing = store.get(RECORD, &id)?;
            if existing.is_null() {
                store.put(
                    RECORD,
                    &id,
                    &json!({"id":id,"ownerId":session,"dirId":input["dirId"],
                    "path":path,"branch":input["branch"],"baseRef":input["baseRef"],
                    "residency":"planned","version":1,"pins":[],"createdAt":input["now"]}),
                )?;
            } else if ["dirId", "path", "branch"]
                .iter()
                .any(|key| existing[key] != input[key])
                || existing["ownerId"] != session
                || !matches!(text(&existing["residency"]), "planned" | "resident")
            {
                return Err("workspace_identity_conflict".into());
            }
            store.put(
                "workspace:binding",
                session,
                &json!({"sessionId":session,"workspaceId":id}),
            )?;
            let mut request = input.clone();
            request["workspaceId"] = json!(id);
            let lease = store.workspace_acquire(&request)?;
            request["leaseId"] = lease["id"].clone();
            request["state"] = json!("materializing");
            store.workspace_transition(&request)?;
            Ok(lease)
        })
    }

    pub fn activate_chat_materialization(&mut self, lease: &Value, input: &Value) -> Result<Value> {
        self.atomic(|store| {
            let id = text(&lease["workspaceId"]);
            let mut workspace = store.get(RECORD, id)?;
            let mut update = lease.clone();
            update["leaseId"] = lease["id"].clone();
            update["state"] = json!("starting");
            update["now"] = input["now"].clone();
            update["fields"] = json!({"materializing":false});
            store.workspace_transition(&update)?;
            workspace["residency"] = json!("resident");
            workspace["head"] = input["head"].clone();
            workspace["commonDir"] = input["commonDir"].clone();
            workspace["version"] =
                json!(workspace["version"].as_u64().unwrap_or(0).saturating_add(1));
            store.put(RECORD, id, &workspace)?;
            store.acquire_chat_writer_for_lease(&workspace, lease)
        })
    }

    pub fn resident_chat_workspace(&self, input: &Value) -> Result<Value> {
        let session = text(&input["sessionId"]);
        let binding = self.get("workspace:binding", session)?;
        let workspace = self.get(RECORD, text(&binding["workspaceId"]))?;
        if workspace.is_null()
            || binding["sessionId"] != session
            || workspace["id"] != binding["workspaceId"]
            || workspace["residency"] != "resident"
            || workspace["path"] != input["path"]
            || workspace["dirId"] != input["dirId"]
        {
            return Err("workspace_admission_required".into());
        }
        Ok(workspace)
    }

    pub fn acquire_chat_writer(&mut self, input: &Value) -> Result<Value> {
        self.atomic(|store| {
            let workspace = store.resident_chat_workspace(input)?;
            let mut request = input.clone();
            request["workspaceId"] = workspace["id"].clone();
            let lease = store.workspace_acquire(&request)?;
            let writer = store.acquire_chat_writer_for_lease(&workspace, &lease)?;
            request["leaseId"] = lease["id"].clone();
            request["state"] = json!("starting");
            store.workspace_transition(&request)?;
            Ok(writer)
        })
    }

    fn acquire_chat_writer_for_lease(&mut self, workspace: &Value, lease: &Value) -> Result<Value> {
        let writer = json!({
            "workspaceId":workspace["id"],"leaseId":lease["id"],"sessionId":lease["sessionId"],
            "epoch":lease["epoch"],"generation":lease["generation"],
            "writerId":random_id::random_uuid_v4().map_err(err)?,"writerKind":"session"
        });
        self.writer_lease_acquire(&writer)?;
        Ok(writer)
    }

    pub fn finish_chat_writer(
        &mut self,
        writer: &Value,
        stopped: bool,
        now: i64,
        completion: Option<&Value>,
    ) -> Result<()> {
        self.atomic(|store| {
            let mut update = writer.clone();
            update["now"] = json!(now);
            if stopped {
                store.writer_lease_release(writer)?;
                if let Some(completion) = completion {
                    let turn = text(&completion["turnId"]);
                    let run = store.get("delivery:run", turn)?;
                    if !run.is_null() {
                        let mut finalize = completion.clone();
                        for key in ["sessionId", "workspaceId", "leaseId", "epoch", "generation"] {
                            finalize[key] = writer[key].clone();
                        }
                        finalize["writerFenceVersion"] = store.writer_fence_snapshot(writer)?;
                        finalize["now"] = json!(now);
                        store.finalize_stopped_delivery(&finalize)?;
                    }
                }
                update["state"] = json!("released");
                update["fields"] = json!({"materializing":false,"reason":"chat_worker_stopped"});
            } else {
                update["state"] = json!("uncertain");
                update["fields"] = json!({"reason":"writer_stop_unverified"});
            }
            store.workspace_transition(&update)?;
            Ok(())
        })
    }

    pub fn start_chat_writer(
        &mut self,
        writer: &Value,
        pid: i32,
        now: i64,
        run: &Value,
    ) -> Result<()> {
        self.atomic(|store| {
            let mut update = writer.clone();
            update["pid"] = json!(pid);
            store.writer_lease_annotate_pid(&update)?;
            update["state"] = json!("running");
            update["now"] = json!(now);
            update["fields"] = json!({"pid":pid});
            store.workspace_transition(&update)?;
            let turn = text(&run["turnId"]);
            let attempt = text(&run["attemptId"]);
            let session = text(&writer["sessionId"]);
            let receipt_id = text(&run["receiptId"]);
            let receipt = store.get("receipt", receipt_id)?;
            if turn.is_empty() || attempt.is_empty()
                || receipt["status"] != "accepted" || receipt["nativeAdmission"] != true
                || receipt["result"]["sessionId"] != session
                || receipt["taskId"] != run["taskId"]
                || !store.get("delivery:run", turn)?.is_null()
            {
                return Err("run_identity_required".into());
            }
            let workspace = store.get(RECORD, text(&writer["workspaceId"]))?;
            let binding = json!({"sessionId":session,"turnId":turn,"taskId":receipt["taskId"],
                "receiptId":receipt_id,"roleSnapshotId":receipt["roleSnapshotId"],"workspaceId":workspace["id"],
                "workspacePath":workspace["path"],"baseRef":workspace["baseRef"].as_str().unwrap_or("main"),
                "startCodeRevision":null,"startHead":null,"startDirty":null,"startObservationError":null});
            store.put("delivery:run", turn, &json!({"id":turn,"binding":binding,
                "state":"running","attemptId":attempt,"createdAt":now}))?;
            store.put("delivery:latest", session, &json!({"runId":turn}))?;
            Ok(())
        })
    }

    pub fn workspace_available(&mut self, input: &Value) -> Result<Option<&'static str>> {
        let workspace_id = text(&input["workspaceId"]);
        let workspace = self.get(RECORD, workspace_id)?;
        if workspace.is_null() {
            return Ok(Some("workspace_not_found"));
        }
        match self.ensure_no_writer_leases(workspace_id) {
            Err(code) if code == "workspace_writer_active" => return Ok(Some("workspace_busy")),
            result => result?,
        }
        if active(&self.get(LEASE, workspace_id)?) {
            return Ok(Some("workspace_busy"));
        }
        self.refresh_cache(LEASE, "rows", LEASES)?;
        let current = items(&self.cache[LEASES].rows).iter().filter(|v| active(v));
        if current.clone().count() >= budget(input, "executionLimit")? {
            return Ok(Some("workspace_execution_capacity"));
        }
        if workspace["residency"] == "resident" {
            return Ok(None);
        }
        let materializing = current.filter(|lease| truthy(&lease["materializing"]));
        if materializing.clone().count() >= budget(input, "restoreLimit")? {
            return Ok(Some("workspace_restore_capacity"));
        }
        let mut restoring_here = 0;
        for lease in materializing {
            let restoring = self.get(RECORD, text(&lease["workspaceId"]))?;
            if !restoring.is_null() && restoring["dirId"] == workspace["dirId"] {
                restoring_here += 1;
            }
        }
        self.refresh_cache(RECORD, "rows", RECORDS)?;
        let resident_here = items(&self.cache[RECORDS].rows)
            .iter()
            .filter(|row| {
                row["dirId"] == workspace["dirId"]
                    && matches!(text(&row["residency"]), "resident" | "retained")
            })
            .count();
        if resident_here + restoring_here >= budget(input, "residentLimit")? {
            return Ok(Some("workspace_resident_capacity"));
        }
        Ok(None)
    }

    pub fn workspace_acquire(&mut self, input: &Value) -> Result<Value> {
        let workspace = text(&input["workspaceId"]);
        let session = text(&input["sessionId"]);
        let request = text(&input["requestId"]);
        if request.is_empty() {
            return Err("workspace_request_required".into());
        }
        if session.is_empty() || text(&input["epoch"]).is_empty() || !input["now"].is_number() {
            return Err("workspace_identity_missing".into());
        }
        self.atomic(|store| {
            let hash = format!("{:x}", Sha256::digest(format!("{session}\0{request}").as_bytes()));
            let operation_id = &hash[..32];
            let previous = store.get(OPERATION, operation_id)?;
            if !previous.is_null() && previous["state"] != "released" {
                return Err("workspace_launch_unresolved".into());
            }
            if let Some(code) = store.workspace_available(input)? {
                return Err(code.into());
            }
            let generation = previous["generation"]
                .as_u64()
                .unwrap_or(0)
                .checked_add(1)
                .filter(|n| *n <= 9_007_199_254_740_991)
                .ok_or("workspace_generation_exhausted")?;
            let materializing = store.get(RECORD, workspace)?["residency"] != "resident";
            let lease = json!({
                "id":random_id::random_uuid_v4().map_err(err)?,"workspaceId":workspace,
                "sessionId":session,"requestId":request,"operationId":operation_id,"epoch":input["epoch"],
                "state":"reserved","generation":generation,"pid":null,"materializing":materializing,
                "acquiredAt":input["now"]
            });
            store.put(LEASE, workspace, &lease)?;
            store.put(OPERATION, operation_id, &lease)?;
            Ok(lease)
        })
    }

    pub fn workspace_transition(&mut self, input: &Value) -> Result<Value> {
        let workspace = text(&input["workspaceId"]);
        self.atomic(|store| {
            let mut current = store.get(LEASE, workspace)?;
            if current.is_null()
                || current["id"] != input["leaseId"]
                || current["epoch"] != input["epoch"]
            {
                return Err("workspace_lease_stale".into());
            }
            if !active(&current) {
                return Err("workspace_lease_released".into());
            }
            if input["state"] == "released" {
                store.ensure_no_writer_leases(workspace)?;
            }
            if let Some(fields) = input["fields"].as_object() {
                current
                    .as_object_mut()
                    .ok_or("workspace_lease_stale")?
                    .extend(fields.clone());
            }
            current["state"] = input["state"].clone();
            current["updatedAt"] = input["now"].clone();
            store.put(LEASE, workspace, &current)?;
            store.put(OPERATION, text(&current["operationId"]), &current)?;
            Ok(current)
        })
    }
}
