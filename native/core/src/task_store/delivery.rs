//! Atomic turn-result persistence, exercised against the existing host before
//! the workspace release chain is switched to this owner.
use super::{err, text, Result, TaskStore};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

fn key(parts: &[Value]) -> Result<String> {
    let encoded = serde_json::to_vec(parts).map_err(err)?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}
fn json_or_null(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}
fn nullable(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(s)) if !s.is_empty() => Value::String(s.clone()),
        Some(Value::Bool(true)) => Value::Bool(true),
        Some(Value::Number(n)) if n.as_f64().is_some_and(|v| v != 0.0) => Value::Number(n.clone()),
        Some(Value::Array(a)) => Value::Array(a.clone()),
        Some(Value::Object(o)) => Value::Object(o.clone()),
        _ => Value::Null,
    }
}
fn valid_fact_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id.bytes().enumerate().all(|(i, c)| {
            c.is_ascii_alphanumeric() || (i > 0 && matches!(c, b'_' | b'.' | b':' | b'-'))
        })
}
impl TaskStore {
    fn ensure_no_writer_leases(&self, workspace: &str) -> Result<()> {
        if workspace.is_empty() {
            return Err("workspace_release_identity_required".into());
        }
        let record = self.get("workspace:writer-leases", workspace)?;
        if record.is_null() {
            return Ok(());
        }
        let writers = record["writers"]
            .as_object()
            .ok_or("writer_lease_invalid")?;
        for item in writers.values() {
            match text(&item["state"]) {
                "active" => return Err("workspace_writer_active".into()),
                "released" => {}
                _ => return Err("writer_lease_invalid".into()),
            }
        }
        Ok(())
    }
    pub fn writer_lease_assert_empty(&self, input: &Value) -> Result<Value> {
        self.ensure_no_writer_leases(text(&input["workspaceId"]))?;
        Ok(Value::Null)
    }
    fn writer_lease_change(&mut self, input: &Value, acquiring: bool) -> Result<Value> {
        let workspace = text(&input["workspaceId"]).to_owned();
        let writer = text(&input["writerId"]).to_owned();
        let kind = text(&input["writerKind"]);
        if !valid_fact_id(&writer) || !["session", "background", "stream"].contains(&kind) {
            return Err("writer_lease_identity_required".into());
        }
        let result = self.atomic(|store| {
            let mut record = store.get("workspace:writer-leases", &workspace)?;
            let same = record["leaseId"] == input["leaseId"] && record["epoch"] == input["epoch"]
                && record["generation"] == input["generation"] && record["sessionId"] == input["sessionId"];
            if !same {
                store.ensure_no_writer_leases(&workspace)?;
                if !acquiring { return Err("writer_lease_stale".into()); }
                record = json!({"leaseId":input["leaseId"], "epoch":input["epoch"],
                    "generation":input["generation"], "sessionId":input["sessionId"], "writers":{}});
            }
            let writers = record["writers"].as_object_mut().ok_or("writer_lease_invalid")?;
            if acquiring {
                if writers.contains_key(&writer) { return Err("writer_lease_id_reused".into()); }
                if writers.len() >= 4096 { return Err("writer_lease_limit".into()); }
                // The pid is unknown at acquire time (the lease precedes the
                // child launch) and is annotated afterwards; a null pid means
                // liveness can never be proved for crash recovery, so the lease
                // stays pinned rather than being reaped on suspicion.
                writers.insert(writer.clone(), json!({"state":"active","kind":kind,"pid":input["pid"]}));
            } else {
                let holder = writers.get_mut(&writer).ok_or("writer_lease_stale")?;
                if text(&holder["kind"]) != kind { return Err("writer_lease_stale".into()); }
                match text(&holder["state"]) {
                    "released" => {},
                    "active" => holder["state"] = json!("released"),
                    _ => return Err("writer_lease_invalid".into()),
                }
            }
            // A recovered lease has a new host epoch, but a previously
            // registered writer must still be able to report its own exit.
            // The immutable lease id, generation and session must all match.
            let mut fence_input = input.clone();
            if !acquiring {
                let current = store.get("workspace:lease", &workspace)?;
                if current["id"] != input["leaseId"] || current["sessionId"] != input["sessionId"]
                    || current["generation"] != input["generation"] {
                    return Err("writer_lease_stale".into());
                }
                fence_input["epoch"] = current["epoch"].clone();
            }
            // Both mutations are savepoints inside the same outer transaction.
            // The version changes even if a writer starts and stops mid-scan.
            store.writer_fence(&fence_input, true)?;
            store.put("workspace:writer-leases", &workspace, &record)?;
            Ok(record["writers"][&writer].clone())
        });
        if !workspace.is_empty() {
            if result.is_err() {
                self.fence_failures.insert(workspace);
            } else {
                self.fence_failures.remove(&workspace);
            }
        }
        result
    }
    pub fn writer_lease_acquire(&mut self, input: &Value) -> Result<Value> {
        self.writer_lease_change(input, true)
    }
    pub fn writer_lease_release(&mut self, input: &Value) -> Result<Value> {
        self.writer_lease_change(input, false)
    }
    /// Read the writer registry of one workspace unchanged. Crash recovery
    /// uses it to find leases whose recorded process is provably gone.
    pub fn writer_lease_list(&self, input: &Value) -> Result<Value> {
        let workspace = text(&input["workspaceId"]);
        if workspace.is_empty() {
            return Err("workspace_release_identity_required".into());
        }
        self.get("workspace:writer-leases", workspace)
    }
    /// Attach the spawned child's pid to its already-registered writer. The
    /// lease is acquired before the child launches, so the pid can only be
    /// filled in afterwards — and only once, so a stale annotation can never
    /// repoint a lease at an unrelated process. Like every writer mutation
    /// this bumps the fence version: a drain racing the annotation must fail.
    pub fn writer_lease_annotate_pid(&mut self, input: &Value) -> Result<Value> {
        let workspace = text(&input["workspaceId"]).to_owned();
        let writer = text(&input["writerId"]).to_owned();
        let kind = text(&input["writerKind"]);
        let pid = input["pid"].as_u64().filter(|pid| *pid > 0);
        if !valid_fact_id(&writer) || !["session", "background", "stream"].contains(&kind) {
            return Err("writer_lease_identity_required".into());
        }
        let Some(pid) = pid else {
            return Err("writer_lease_identity_required".into());
        };
        let result = self.atomic(|store| {
            // Same identity rules as a release: the immutable lease id,
            // generation and session must match the current record, while a
            // recovered host epoch may have advanced.
            let current = store.get("workspace:lease", &workspace)?;
            if current["id"] != input["leaseId"]
                || current["sessionId"] != input["sessionId"]
                || current["generation"] != input["generation"]
            {
                return Err("writer_lease_stale".into());
            }
            let mut record = store.get("workspace:writer-leases", &workspace)?;
            let same = record["leaseId"] == input["leaseId"]
                && record["generation"] == input["generation"]
                && record["sessionId"] == input["sessionId"];
            if !same {
                return Err("writer_lease_stale".into());
            }
            let holder = record["writers"]
                .as_object_mut()
                .ok_or("writer_lease_invalid")?
                .get_mut(&writer)
                .ok_or("writer_lease_stale")?;
            if text(&holder["kind"]) != kind {
                return Err("writer_lease_stale".into());
            }
            if text(&holder["state"]) != "active" {
                return Err("writer_lease_stale".into());
            }
            match holder["pid"].as_u64().filter(|prior| *prior > 0) {
                Some(prior) if prior != pid => return Err("writer_lease_stale".into()),
                Some(_) => {}
                None => holder["pid"] = json!(pid),
            }
            let mut fence_input = input.clone();
            fence_input["epoch"] = current["epoch"].clone();
            store.writer_fence(&fence_input, true)?;
            store.put("workspace:writer-leases", &workspace, &record)?;
            Ok(record["writers"][&writer].clone())
        });
        if !workspace.is_empty() {
            match &result {
                // A lost race against the writer's own release is a normal
                // outcome for a fast-exiting child, not a durability doubt —
                // only genuine write failures pin the workspace.
                Err(code) if code == "writer_lease_stale" => {}
                Err(_) => {
                    self.fence_failures.insert(workspace);
                }
                Ok(_) => {
                    self.fence_failures.remove(&workspace);
                }
            }
        }
        result
    }
    fn writer_fence(&mut self, input: &Value, bump: bool) -> Result<Value> {
        let workspace = text(&input["workspaceId"]);
        let lease_id = text(&input["leaseId"]);
        let session = text(&input["sessionId"]);
        let epoch = text(&input["epoch"]);
        let generation = &input["generation"];
        if workspace.is_empty()
            || lease_id.is_empty()
            || session.is_empty()
            || epoch.is_empty()
            || generation.as_u64().is_none_or(|v| v == 0)
        {
            return Err("workspace_release_identity_required".into());
        }
        self.atomic(|store| {
            let lease = store.get("workspace:lease", workspace)?;
            if text(&lease["id"]) != lease_id
                || text(&lease["epoch"]) != epoch
                || text(&lease["sessionId"]) != session
                || text(&lease["workspaceId"]) != workspace
                || &lease["generation"] != generation
                || ![
                    "reserved",
                    "materializing",
                    "starting",
                    "running",
                    "uncertain",
                ]
                .contains(&text(&lease["state"]))
            {
                return Err("workspace_lease_stale".into());
            }
            let prior = store.get("workspace:writer-fence", workspace)?;
            let same = text(&prior["leaseId"]) == lease_id
                && text(&prior["epoch"]) == epoch
                && prior["generation"] == *generation
                && text(&prior["sessionId"]) == session;
            let version = if same {
                prior["version"].as_u64().ok_or("writer_fence_invalid")?
            } else {
                0
            };
            // The current host bridge carries versions through JSON numbers.
            // Refuse values that JavaScript cannot represent exactly.
            const MAX_SAFE_VERSION: u64 = 9_007_199_254_740_991;
            if version > MAX_SAFE_VERSION || (bump && version == MAX_SAFE_VERSION) {
                return Err("writer_fence_overflow".into());
            }
            let version = if bump {
                version.checked_add(1).ok_or("writer_fence_overflow")?
            } else {
                version
            };
            if bump || !same {
                store.put(
                    "workspace:writer-fence",
                    workspace,
                    &json!({"leaseId":lease_id,"epoch":epoch,
                    "generation":generation,"sessionId":session,"version":version}),
                )?;
            }
            Ok(json!(version))
        })
    }
    pub fn writer_fence_activity(&mut self, input: &Value) -> Result<Value> {
        let workspace = text(&input["workspaceId"]).to_owned();
        let result = if !["session", "background", "stream"].contains(&text(&input["writerKind"])) {
            Err("writer_kind_invalid".into())
        } else {
            self.writer_fence(input, true)
        };
        if !workspace.is_empty() {
            if result.is_err() {
                self.fence_failures.insert(workspace);
            } else {
                self.fence_failures.remove(&workspace);
            }
        }
        result
    }
    pub fn writer_fence_snapshot(&mut self, input: &Value) -> Result<Value> {
        if self.fence_failures.contains(text(&input["workspaceId"])) {
            return Err("writer_fence_write_failed".into());
        }
        self.atomic(|store| {
            store.ensure_no_writer_leases(text(&input["workspaceId"]))?;
            store.writer_fence(input, false)
        })
    }

    /// Recheck the writer version and release its exact lease atomically. The
    /// host must still establish quiescence until writer lifecycles are owned
    /// by this fence rather than merely reporting activity to it.
    pub fn writer_fence_release(&mut self, input: &Value) -> Result<Value> {
        let workspace = text(&input["workspaceId"]);
        self.atomic(|store| {
            if store.fence_failures.contains(workspace) {
                return Err("writer_fence_write_failed".into());
            }
            store.ensure_no_writer_leases(workspace)?;
            let mut lease = store.get("workspace:lease", workspace)?;
            let valid = lease["id"] == input["leaseId"]
                && lease["sessionId"] == input["sessionId"]
                && lease["epoch"] == input["epoch"]
                && lease["generation"] == input["generation"]
                && text(&lease["workspaceId"]) == workspace
                && [
                    "reserved",
                    "materializing",
                    "starting",
                    "running",
                    "uncertain",
                ]
                .contains(&text(&lease["state"]));
            if !valid {
                return Err("workspace_lease_stale".into());
            }
            let fence = store.get("workspace:writer-fence", workspace)?;
            if fence["leaseId"] != input["leaseId"]
                || fence["sessionId"] != input["sessionId"]
                || fence["epoch"] != input["epoch"]
                || fence["generation"] != input["generation"]
                || fence["version"] != input["writerFenceVersion"]
                || input["writerFenceVersion"].as_u64().is_none()
            {
                return Err("writer_reactivated".into());
            }
            let operation = text(&lease["operationId"]).to_owned();
            if operation.is_empty() {
                return Err("workspace_lease_stale".into());
            }
            lease["state"] = json!("released");
            lease["reason"] = input["reason"].clone();
            lease["materializing"] = json!(false);
            lease["updatedAt"] = input["now"].clone();
            store.put("workspace:lease", workspace, &lease)?;
            store.put("workspace:operation", &operation, &lease)?;
            Ok(lease)
        })
    }

    /// Commit the same run-result, attempt and optional integration facts as
    /// the host transaction. The caller must establish stopped-writer ownership
    /// and check liveness immediately before calling; this method alone does
    /// not authorize releasing a workspace.
    pub fn finalize_delivery(&mut self, input: &Value) -> Result<Value> {
        let turn = text(&input["turnId"]);
        let initial = self.get("delivery:run", turn)?;
        if initial.is_null() {
            return Ok(Value::Null);
        }
        if !valid_fact_id(turn) {
            return Err("invalid_record_id".into());
        }
        let prior = self.get("task-first:run-result", turn)?;
        if !prior.is_null() {
            return Ok(prior);
        }
        let result = &input["result"];
        if initial.get("attemptId") != result.get("attemptId") {
            return Err("final_attempt_mismatch".into());
        }
        self.atomic(|store| {
            let current = store.get("delivery:run", turn)?;
            let binding = initial["binding"].as_object().ok_or("run_binding_missing")?;
            let session = text(&initial["binding"]["sessionId"]);
            if current.get("attemptId") != result.get("attemptId") || store.get("delivery:latest", session)?["runId"] != turn {
                return Err("final_attempt_mismatch".into());
            }
            let prior = store.get("task-first:run-result", turn)?;
            if !prior.is_null() { return Ok(prior); }
            if current.get("attemptId").is_none() || input.get("error").is_none() {
                return Err("invalid_record_value".into());
            }
            let raw = text(&result["outcome"]);
            let outcome = if raw == "succeeded" && result["resultDurable"] == true && result["usageDurable"] == true && result["pendingInput"] == false {
                "succeeded"
            } else if ["failed", "cancelled", "waiting"].contains(&raw) { raw } else { "unknown" };
            let code = &input["code"];
            let mut fact = Map::new();
            fact.insert("id".into(), json!(turn));
            fact.extend(binding.clone());
            fact.insert("attemptId".into(), current["attemptId"].clone());
            fact.insert("outcome".into(), json!(outcome));
            fact.insert("attemptOutcome".into(), json!(outcome));
            fact.insert("finalized".into(), json!(true));
            fact.insert("evidencePersisted".into(), json!(true));
            fact.insert("superseded".into(), json!(false));
            fact.insert("pendingInput".into(), json!(result["pendingInput"] != false));
            fact.insert("endCodeRevision".into(), nullable(code.get("revision")));
            fact.insert("endHead".into(), nullable(code.get("head")));
            fact.insert("repoId".into(), nullable(code.get("repoId")));
            fact.insert("endDirty".into(), json_or_null(code.get("dirty")));
            fact.insert("observationError".into(), input["error"].clone());
            fact.insert("finishedAt".into(), input["now"].clone());
            let fact = Value::Object(fact);
            if serde_json::to_vec(&fact).map_err(err)?.len() > 1024 * 1024 { return Err("invalid_record_value".into()); }
            store.put("task-first:run-result", turn, &fact)?;
            let mut next = current.clone(); next["state"] = json!("finalized");
            store.put("delivery:run", turn, &next)?;
            let attempt = current["attemptId"].clone();
            let attempt_key = key(&[json!(turn), attempt.clone()])?;
            store.put("delivery:attempt", &attempt_key, &json!({"runId":turn,"attemptId":attempt,"outcome":outcome}))?;
            let revision = text(&fact["endCodeRevision"]);
            let repo = text(&fact["repoId"]);
            if !revision.is_empty() && !repo.is_empty() {
                let journal = store.rows("delivery:merge", true)?.into_iter().map(|(_,_,v)| v).rfind(|j|
                    j["state"] == "published" && j["sessionId"] == fact["sessionId"] && j["repoId"] == fact["repoId"]
                    && j["baseRef"] == fact["baseRef"] && (j["sourceRevision"] == revision || j["publishedRevision"] == revision));
                if let Some(journal) = journal {
                    // A missing JS property is undefined, and the facts
                    // repository rejects it rather than storing JSON null.
                    // Keep old, incomplete journals from minting a receipt.
                    if ["id", "sourceHead", "integrationHead"].iter().any(|name| journal.get(*name).is_none())
                        || ["attemptId", "workspaceId", "baseRef"].iter().any(|name| fact.get(*name).is_none()) {
                        return Err("invalid_record_value".into());
                    }
                    let id = format!("integration_{}", key(&[json!(turn), fact["attemptId"].clone(), journal["id"].clone()])?);
                    let integration = json!({"id": id, "operationId": journal["id"], "runId": turn,
                        "attemptId": fact["attemptId"], "workspaceId": fact["workspaceId"], "repoId": fact["repoId"],
                        "coveredCodeRevision": fact["endCodeRevision"], "sourceHead": journal["sourceHead"],
                        "integrationHead": journal["integrationHead"], "baseRef": fact["baseRef"],
                        "outcome":"integrated", "verified":true, "revoked":false});
                    if serde_json::to_vec(&integration).map_err(err)?.len() > 1024 * 1024 { return Err("invalid_record_value".into()); }
                    let prior = store.get("task-first:integration", &id)?;
                    if !prior.is_null() && prior != integration { return Err("immutable_fact_conflict".into()); }
                    if prior.is_null() { store.put("task-first:integration", &id, &integration)?; }
                }
            }
            Ok(fact)
        })
    }
}

impl TaskStore {
    /// Persist result and writer barrier in one transaction after the host has
    /// proved the writer stopped. The lease is rechecked inside the transaction.
    /// This does not observe process liveness, so callers must still provide a
    /// valid fence that covers the entire scan and commit.
    pub fn finalize_stopped_delivery(&mut self, input: &Value) -> Result<Value> {
        let turn = text(&input["turnId"]);
        let session = text(&input["sessionId"]);
        let workspace = text(&input["workspaceId"]);
        let lease_id = text(&input["leaseId"]);
        let epoch = text(&input["epoch"]);
        let generation = input["generation"].clone();
        if turn.is_empty()
            || session.is_empty()
            || workspace.is_empty()
            || lease_id.is_empty()
            || epoch.is_empty()
            || generation.as_u64().is_none_or(|value| value == 0)
        {
            return Err("workspace_release_identity_required".into());
        }
        self.atomic(|store| {
            let lease = store.get("workspace:lease", workspace)?;
            if text(&lease["id"]) != lease_id || text(&lease["epoch"]) != epoch || text(&lease["sessionId"]) != session || text(&lease["workspaceId"]) != workspace || lease["generation"] != generation
                || !["reserved", "materializing", "starting", "running", "uncertain"].contains(&text(&lease["state"])) {
                return Err("workspace_lease_stale".into());
            }
            store.ensure_no_writer_leases(workspace)?;
            if let Some(expected) = input.get("writerFenceVersion") {
                if store.fence_failures.contains(workspace) { return Err("writer_fence_write_failed".into()); }
                let fence = store.get("workspace:writer-fence", workspace)?;
                if fence["leaseId"] != lease_id || fence["epoch"] != epoch || fence["sessionId"] != session
                    || fence["generation"] != generation || &fence["version"] != expected || expected.as_u64().is_none() {
                    return Err("writer_reactivated".into());
                }
            }
            let run = if input["result"].is_null() {
                store.get("task-first:run-result", turn)?
            } else {
                store.finalize_delivery(input)?
            };
            if run.is_null() || run["sessionId"] != session || run["workspaceId"] != workspace {
                return Err("barrier_run_mismatch".into());
            }
            let code = &input["code"];
            let revision = text(&code["revision"]);
            let recorded = nullable(run.get("endCodeRevision"));
            if revision.is_empty() {
                return Ok(json!({"run":run,"barrier":null,"barrierError":"barrier_code_changed"}));
            }
            if (!text(&run["repoId"]).is_empty() && run["repoId"] != code["repoId"])
                || (!recorded.is_null() && recorded != code["revision"]) {
                return Ok(json!({"run":run,"barrier":null,"barrierError":"barrier_code_changed"}));
            }
            let hash = key(&[json!(turn), Value::Null, json!(lease_id), generation.clone(), code["revision"].clone()])?;
            let id = format!("barrier_{}", &hash[..48]);
            let mut identity = json!({"id":id,"sessionId":session,"turnId":turn,"separationId":null,
                "taskId":run["taskId"],"attemptId":run["attemptId"],"workspaceId":workspace,"leaseId":lease_id,
                "generation":generation,"codeRevision":code["revision"],"head":code["head"],"repoId":code["repoId"],
                "dirty":code["dirty"],"writersStopped":true,"runEndRevision":recorded,
                "revisionDrifted":if recorded.is_null() { Value::Null } else { json!(recorded != code["revision"]) }});
            let prior = store.get("task-first:writer-barrier", &id)?;
            let barrier = if prior.is_null() {
                identity["verifiedAt"] = input["now"].clone();
                store.put("task-first:writer-barrier", &id, &identity)?;
                identity
            } else {
                for (name, value) in identity.as_object().ok_or("barrier_identity_invalid")? {
                    if prior.get(name) != Some(value) { return Err("immutable_fact_conflict".into()); }
                }
                prior
            };
            Ok(json!({"run":run,"barrier":barrier,"barrierError":null}))
        })
    }
}
