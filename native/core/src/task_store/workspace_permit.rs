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
