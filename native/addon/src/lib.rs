use multicc_core::{search::SearchIndex, usage};
use napi::{bindgen_prelude::AsyncTask, Env, Result, Task};
use napi_derive::napi;
use std::{sync::Arc, time::Instant};
pub mod api_error_policy;
pub mod api_error_text;
pub mod auth_security;
pub mod auto_provider_config;
pub mod auto_provider_policy;
pub mod auto_provider_pricing;
pub mod auto_provider_routing;
pub mod auto_provider_runtime;
pub mod background_hold;
pub mod code_revision;
pub mod workspace_release;

pub mod background_tasks;
pub mod chat_context_rotation;
pub mod chat_events;
pub mod chat_finalize;
pub mod chat_finalize_execution;
pub mod chat_history;
pub mod chat_history_repository;
pub mod chat_history_runtime;
pub mod chat_turn_effects;
pub mod chat_turn_lifecycle;
pub mod classify_vocab;
pub mod claude_lane;
pub mod cli_capability;
pub mod cli_completion;
pub mod cli_switch;
pub mod cli_switch_runtime;
pub mod cli_tools_runtime;
pub mod cpr;
pub mod events;
pub mod exact_secret;
pub mod guard;
pub mod http_entry;
pub mod js_bridge;
mod js_live;
pub mod machines;
pub mod model_default;
pub mod model_request_policy;
pub mod model_stream_progress;
pub mod native_session_guard;
pub mod network_policy;
pub mod node_fs_error;
pub mod opencode_context;
pub mod opencode_error;
pub mod orchestration_owner;
pub mod orchestration_store;
pub mod provider_attempt_identity;
pub mod provider_attempt_lifecycle;
pub mod provider_authorization;
pub mod provider_event_policy;
pub mod provider_outcome;
pub mod provider_producers;
pub mod provider_scrub;
pub mod publication;
pub mod quota_guard;
pub mod quota_history;
pub mod quota_rejection;
pub mod request_timer;
pub mod request_watch;
pub mod retry_policy;
pub mod search_diversity;
pub mod secret_audit;
pub mod session_work_selection;
pub mod sqlite;
pub mod subagent_defaults;
pub mod task_board;
pub mod task_context;
pub mod task_domain;
pub mod task_read_model;
pub mod task_routing;
pub mod task_run_context;
pub mod task_store;
pub mod transcript_prune;
pub mod turn_progress;
pub mod turn_request;
pub mod turn_state;
pub mod unattended;
pub mod virtual_provider;
pub mod windows_tools;
pub mod worktree_sync;

#[napi(object)]
pub struct NativeResult {
    pub result: String,
    pub compute_ms: f64,
}

fn error(message: String) -> napi::Error {
    napi::Error::from_reason(message)
}

#[napi]
pub fn protocol_version() -> u32 {
    1
}

#[napi]
pub struct RustSearchIndex {
    inner: Arc<SearchIndex>,
    build_ms: f64,
}

pub struct Build {
    input: String,
}
impl Task for Build {
    type Output = (SearchIndex, f64);
    type JsValue = RustSearchIndex;
    fn compute(&mut self) -> Result<Self::Output> {
        let start = Instant::now();
        let index = SearchIndex::build(&self.input).map_err(error)?;
        Ok((index, start.elapsed().as_secs_f64() * 1000.0))
    }
    fn resolve(&mut self, _: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(RustSearchIndex {
            inner: Arc::new(output.0),
            build_ms: output.1,
        })
    }
}
#[napi]
pub fn build_search_index(input: String) -> AsyncTask<Build> {
    AsyncTask::new(Build { input })
}

pub struct Search {
    index: Arc<SearchIndex>,
    input: String,
}
impl Task for Search {
    type Output = NativeResult;
    type JsValue = NativeResult;
    fn compute(&mut self) -> Result<NativeResult> {
        let start = Instant::now();
        let result = self.index.search(&self.input).map_err(error)?;
        Ok(NativeResult {
            result,
            compute_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    }
    fn resolve(&mut self, _: Env, output: NativeResult) -> Result<NativeResult> {
        Ok(output)
    }
}
#[napi]
impl RustSearchIndex {
    #[napi(getter)]
    pub fn build_ms(&self) -> f64 {
        self.build_ms
    }
    #[napi]
    pub fn search(&self, input: String) -> AsyncTask<Search> {
        AsyncTask::new(Search {
            index: self.inner.clone(),
            input,
        })
    }
}

pub struct Usage {
    input: String,
}
impl Task for Usage {
    type Output = NativeResult;
    type JsValue = NativeResult;
    fn compute(&mut self) -> Result<NativeResult> {
        let start = Instant::now();
        let result = usage::compute(&self.input).map_err(error)?;
        Ok(NativeResult {
            result,
            compute_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    }
    fn resolve(&mut self, _: Env, output: NativeResult) -> Result<NativeResult> {
        Ok(output)
    }
}
#[napi]
pub fn compute_usage(input: String) -> AsyncTask<Usage> {
    AsyncTask::new(Usage { input })
}

pub mod claude_refresh;
pub mod codex_models;

pub mod provider_host;

pub mod selection;
pub mod usage_observed;

pub mod auth_routes;

pub mod relay_shares;

pub mod cli_upstream_version;
pub mod homebrew_takeover;
mod js_host_value;
pub mod limit_cache_recorder;
pub mod operation_admit_live;
pub mod outbox_claim_live;
pub mod provider_balance_target;
pub mod provider_limit_store;
pub mod quota_bar_view;
pub mod request_locality;
pub mod schedule_claim_live;
pub mod schedule_insert_queued_live;
pub mod schedule_lifecycle_live;
pub mod schedule_note_queued_live;
pub mod schedule_settle_live;
mod session_records;
mod session_state;
pub mod usage_limit_poll;
pub mod wait_cancel_live;
pub mod wait_canonical;
pub mod wait_resolve_live;
pub mod workspace_queues;
pub mod workspace_sharing;
pub mod workspace_sockets;
mod workspace_state;
