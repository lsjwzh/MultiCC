use multicc_core::workspace_release::{Finalization, ReleaseEvidence};
use napi_derive::napi;

#[napi(object)]
pub struct WorkspaceFinalization {
    pub attempt_id: Option<String>,
    pub succeeded: bool,
    pub pending_input: bool,
    pub cancelled: bool,
    pub failed: bool,
    pub result_durable: bool,
    pub usage_durable: bool,
}

#[napi(object)]
pub struct WorkspaceResultFacts {
    pub attempt_id: Option<String>,
    pub outcome: String,
    pub pending_input: bool,
    pub result_durable: bool,
    pub usage_durable: bool,
}

#[napi]
#[derive(Default)]
pub struct RustWorkspaceRelease {
    inner: ReleaseEvidence,
}

#[napi]
impl RustWorkspaceRelease {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    #[napi]
    pub fn finalized(&mut self, input: WorkspaceFinalization) {
        self.inner.finalized(Finalization {
            attempt_id: input.attempt_id,
            succeeded: input.succeeded,
            pending_input: input.pending_input,
            cancelled: input.cancelled,
            failed: input.failed,
            result_durable: input.result_durable,
            usage_durable: input.usage_durable,
        });
    }

    #[napi]
    pub fn terminal(&mut self, status: String, attempt_id: Option<String>, pending_input: bool) {
        self.inner.terminal(&status, attempt_id, pending_input);
    }

    #[napi]
    pub fn result(&self) -> Option<WorkspaceResultFacts> {
        self.inner.result().map(|r| WorkspaceResultFacts {
            attempt_id: r.attempt_id,
            outcome: r.outcome,
            pending_input: r.pending_input,
            result_durable: r.result_durable,
            usage_durable: r.usage_durable,
        })
    }
}
