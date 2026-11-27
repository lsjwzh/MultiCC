pub mod acp_bridge;
pub mod acp_launch;
use multicc_core::{search::SearchIndex, usage};
use napi::{bindgen_prelude::AsyncTask, Env, Result, Task};
use napi_derive::napi;
use std::{sync::Arc, time::Instant};
pub mod agy_accounts;
pub mod agy_stream;
pub mod air_storage_notice;
pub mod air_task_list;
pub mod air_todo_ignore;
mod api_contract;
pub mod api_error_policy;
pub mod api_error_text;
mod ark_quota;
mod artifact_cleanup;
mod account_reader;
mod auth_ticket_projection;
mod global_proxy;
mod gateway_child;
mod migration_gate;
mod provider_defaults_view;
mod provider_error_fields;
mod record_facades;
mod host_env;
mod quota_runtime;
mod refresh_health;
mod runtime_security;
pub mod artifact_reference;
pub mod assist_snapshots;
pub mod auth_security;
pub mod auto_provider_config;
pub mod auto_provider_handoff;
pub mod auto_provider_policy;
pub mod auto_provider_pricing;
pub mod auto_provider_routing;
pub mod auto_provider_runtime;
pub mod aux_verdict_health;
pub mod background_hold;
pub mod code_revision;
pub mod context_excerpt;
pub mod delivery_class;
mod detached_result;
pub mod doctor_host;
pub mod notify_settings;
pub mod orchestration_command;
pub mod workspace_release;
pub mod zcode_engine;
pub mod zcode_session;

mod account_login_routes;
pub mod adapter_host;
mod app_paths;
mod aux_run_routes;
pub mod background_tasks;
mod battery_guard;
pub mod cc_switch;
pub mod chat_connect_frames;
pub mod chat_context_rotation;
mod chat_error_history;
pub mod chat_events;
pub mod chat_finalize;
pub mod chat_finalize_execution;
pub mod chat_history;
pub mod chat_history_repository;
pub mod chat_history_runtime;
pub mod chat_notices;
pub mod chat_turn_effects;
pub mod chat_turn_lifecycle;
pub mod chat_work_admission;
mod chat_ws_control;
pub mod classify_machine;
pub mod classify_vocab;
mod claude_adapter;
pub mod claude_lane;
pub mod claude_settings_override;
mod claude_usage_queue;
mod cli_account_routes;
pub mod cli_capability;
pub mod cli_adapters;
pub mod cli_catalog_views;
pub mod cli_completion;
pub mod cli_provider_registry;
pub mod cli_switch;
pub mod cli_switch_runtime;
pub mod cli_tools_runtime;
mod codex_account_refresh;
pub mod codex_provider_home;
mod commander_startup;
pub mod cpr;
mod directory_layout;
mod directory_module;
pub mod directory_repository;
mod dispatch_busy;
mod dispatch_progress;
pub mod event_host;
pub mod events;
pub mod exact_secret;
mod fcm_transport;
mod git_service;
mod goal_precheck;
pub mod guard;
pub mod handoff_zip;
mod history_host;
mod host_battery;
mod host_composition;
mod host_methods;
mod host_power_services;
pub mod host_prompts;
mod host_read_operations;
mod host_system_relay;
mod hotword_corrector;
pub mod http_entry;
pub mod http_error_map;
mod ios_distribution;
mod journal_records;
pub mod js_bridge;
mod js_iteration;
mod js_live;
mod json_compression;
mod liveness;
pub mod machines;
mod macos_agent_build;
mod macos_power;
mod memo_controller;
mod memo_file_port;
mod memory_distill;
pub mod message_composer;
pub mod missing_resume_recovery;
pub mod model_default;
pub mod model_request_policy;
pub mod model_stream_progress;
pub mod monitor_admission;
pub mod monitor_control;
pub mod native_queue;
mod native_session_guard;
pub mod network_policy;
pub mod node_fs_error;
pub mod opencode_context;
pub mod opencode_error;
pub mod orchestration_json;
pub mod orchestration_owner;
pub mod orchestration_runtime;
pub mod orchestration_store;
mod outbound_proxy_host;
pub mod path_safety;
mod portable_git;
pub mod post_turn_router;
mod power_daemon;
pub mod process_close;
pub mod process_spawn_args;
pub mod provider_attempt_creation;
pub mod provider_attempt_identity;
pub mod provider_attempt_lifecycle;
pub mod provider_attempt_route;
pub mod provider_authorization;
pub mod provider_claude_proxy_policy;
pub mod provider_event_policy;
pub mod provider_invocation;
pub mod provider_outcome;
pub mod provider_producers;
pub mod provider_registry;
pub mod provider_scrub;
pub mod provider_settings_config;
mod provider_shadow_recorder;
pub mod provider_terminal_routes;
pub mod provider_writes;
mod proxy_trace;
pub mod public_session_access;
pub mod publication;
pub mod quota_guard;
pub mod quota_history;
pub mod quota_rejection;
mod release_asset_routes;
mod repo_actor;
pub mod request_timer;
pub mod request_watch;
pub mod resident_pool;
pub mod retry_policy;
mod route_response;
mod runtime_homes;
mod sakura_launcher;
pub mod schedule_recovery_live;
pub mod search_diversity;
mod search_slice;
pub mod search_tokens;
pub mod secret_audit;
pub mod session_create_record;
pub mod session_delivery;
pub mod session_dto;
pub mod session_hibernation_reclaimer;
pub mod session_login_terminal;
pub mod session_pending_configuration;
pub mod session_persistence;
pub mod session_ports;
pub mod session_subagent;
mod session_work_host;
mod session_work_scheduler;
pub mod session_work_selection;
mod skill_sync_routes;
pub mod sqlite;
pub mod state_bootstrap;
pub mod subagent_defaults;
pub mod task_board;
pub mod task_board_classification;
pub mod task_board_followup;
pub mod task_board_groups;
mod task_board_host;
pub mod task_board_planning;
pub mod task_board_queue;
mod board_domain_facade;
mod board_operations;
mod task_search_host;
mod task_planning_handlers;
mod task_board_runtime;
mod task_board_seed;
pub mod task_board_start;
pub mod task_board_transcript;
pub mod task_board_view;
pub mod task_candidates;
pub mod task_context;
pub mod task_display_attribution;
pub mod task_domain;
mod task_facts;
mod task_first_migration;
pub mod task_history_retention;
pub mod task_read_model;
pub mod task_relations;
mod task_relocate;
pub mod task_routing;
pub mod task_run_context;
pub mod task_shell_capacity;
pub mod task_shell_host;
pub mod task_short_code;
mod task_state_store;
pub mod task_store;
pub mod terminal_target;
mod tmux_recovery;
pub mod transcript_prune;
mod tunnel;
pub mod turn_chat_socket;
pub mod turn_end_evidence;
mod turn_engine;
pub mod turn_event_replay;
pub mod turn_ledger_contract;
mod turn_process_close;
pub mod turn_progress;
mod turn_progress_facade;
pub mod turn_request;
pub mod turn_runtime_store;
pub mod turn_state;
pub mod unattended;
mod unattended_host;
mod unattended_routes;
mod unlock_keychain;
mod unlock_probe;
pub mod vendor_login;
pub mod vendor_model_catalog;
pub mod virtual_provider;
pub mod voice_readiness;
mod voice_router;
mod voice_upload;
mod voice_web_proxy;
pub mod windows_tools;
mod workspace_notes;
mod workspace_overview;
mod workspace_residency;
pub mod worktree_sync;
mod ws_queue_install;

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
pub mod codex_adapter;
pub mod codex_app_adapter;
pub mod codex_background;
pub mod codex_models;
pub mod codex_session_file;

pub mod provider_host;
mod provider_host_values;
mod provider_service;

mod provider_binding;
mod responses_history;
mod image_bridge_runtime;
mod role_token_runtime;
mod role_token_tracker;
pub mod selection;
pub mod usage_observed;

pub mod auth_routes;

mod relay_share_facade;
pub mod relay_shares;

pub mod cli_upstream_version;
pub mod homebrew_takeover;
mod js_host_value;
pub mod limit_cache_recorder;
pub mod model_timeout_recovery;
pub mod operation_admit_live;
pub mod outbox_claim_live;
pub mod provider_balance_target;
pub mod provider_limit_store;
pub mod provider_limit_sync;
mod public_safety;
pub mod push_notification_copy;
pub mod quota_bar_view;
pub mod request_locality;
mod request_locality_api;
pub mod schedule_claim_live;
pub mod schedule_insert_queued_live;
pub mod schedule_lifecycle_live;
pub mod schedule_note_queued_live;
pub mod schedule_settle_live;
mod session_meta_routes;
mod record_maps;
mod session_records;
mod session_state;
mod session_state_service;
pub mod usage_limit_poll;
pub mod voice_hotword_list;
pub mod voice_hotword_pairs;
pub mod voice_speech;
pub mod voice_typed_terms;
pub mod wait_cancel_live;
pub mod wait_canonical;
pub mod wait_resolve_live;
pub mod workspace_queues;
pub mod workspace_sharing;
pub mod workspace_sockets;
mod workspace_state;
mod worktree_orphans;
pub mod writer_group;
pub mod ws_admission;
pub mod ws_host;

mod claude_sdk_config;
mod egress_ip_policy;
mod account_cache_host;
mod claude_quota_headers;
mod model_connect_watch;
mod proxy_observer;
mod host_api;
mod usage_limit_wiring;
mod quota_bar_cache;
mod limit_recorder_host;
mod provider_cache_host;
mod quota_history_host;
mod quota_guard_host;
mod official_usage_host;
mod virtual_provider_host;
mod cli_usage_host;
